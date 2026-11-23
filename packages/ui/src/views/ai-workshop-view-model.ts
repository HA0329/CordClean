/**
 * AI 插件工坊展示模型（纯函数，可单测）。
 *
 * 工坊页面天然没有固定操作顺序：用户可能先点生成、后去配置接口；可能生成一半
 * 离开页面再回来；也可能生成成功后过几小时才回来安装。因此这里把「可操作的判断」
 * 从模板里抽出来，独立测试：
 *
 * - 准备状态：插件未启用 / 未配置 Key / 没有模型时给明确原因与一键入口；
 * - 生成阶段：把宿主推送的 phase 映射成阶段条，未知 phase 不崩；
 * - 失败归因：截断 / JSON 非法 / 校验失败 / 凭据 / 超时 / 网络分别提示；
 * - 草稿历史：本地持久化 + 容错解析（坏 JSON、超长内容、无效字段一律安全丢弃）；
 * - 校验摘要：安装前把错误按闸门归类，并标出危险 API 命中；
 * - 按钮门禁：不可用时给出可读原因，而不是静默失败。
 *
 * 本模块不触碰 DOM / localStorage / 网络，只做数据变换。
 */
import type { AiPluginDraft, AiPluginFile, PluginManifest } from '@cordclean/shared'

/** 需求最大长度（超出部分截断，避免把超大文本塞进请求/存储） */
export const MAX_REQUIREMENT_LENGTH = 4_000

/** 本地草稿历史最多保留条数 */
export const MAX_DRAFT_HISTORY = 6

/** 单个草稿快照的 JSON 字符上限（约等于字符数，用于防止 localStorage 被写爆） */
export const MAX_SNAPSHOT_CHARS = 640_000

/** 整个历史序列化后的字符上限 */
export const MAX_HISTORY_CHARS = 1_400_000

/** 本地草稿历史的 localStorage key */
export const WORKSHOP_DRAFTS_KEY = 'cordclean.workshop.drafts'

/** 单个草稿文件数量上限（与宿主安装校验保持一致） */
export const MAX_DRAFT_FILES = 50

/** 单个草稿文件内容字符上限（与宿主安装校验的 256KB 接近） */
export const MAX_DRAFT_FILE_CHARS = 300_000

/** 危险 API 扫描的最大字符数，避免超大草稿拖慢界面 */
const MAX_RISK_SCAN_CHARS = 1_000_000

/** 错误信息展示前的最大长度 */
const MAX_SAFE_ERROR_LENGTH = 280

/* ------------------------------------------------------------------ */
/* 通用小工具                                                          */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

/** 稳定短哈希（FNV-1a）：只用于生成本地草稿 id，不用于安全用途 */
function stableHash(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 压缩空白并截断，用于列表展示 */
export function shortText(input: unknown, max = 72): string {
  const text = String(input ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= max) return text
  return text.slice(0, Math.max(1, max - 1)) + '…'
}

function utf8Bytes(text: string): number {
  try {
    return new TextEncoder().encode(text).length
  } catch {
    return text.length
  }
}

/** 需求归一化：只接受字符串，去首尾空白、截断超长内容；空串表示未填写 */
export function normalizeRequirement(input: unknown): string {
  if (typeof input !== 'string') return ''
  return input.replace(/\r\n/g, '\n').trim().slice(0, MAX_REQUIREMENT_LENGTH)
}

/**
 * 错误信息脱敏：不把 Key / 本地绝对路径带进界面提示。
 * 同时压缩空白并截断，避免超长厂商错误把页面撑爆。
 */
export function sanitizeErrorMessage(input: unknown): string {
  const source =
    input instanceof Error
      ? input.message
      : typeof input === 'string'
        ? input
        : isRecord(input) && typeof input.message === 'string'
          ? input.message
          : ''
  if (!source) return ''
  let text = source
    // API Key / Bearer / 查询参数里的凭据
    .replace(/\bsk-[A-Za-z0-9_-]{4,}\b/g, 'sk-***')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1***')
    .replace(/\b((?:api[_-]?key|authorization|token)["'\s:=]+)[^\s"',;]{4,}/gi, '$1***')
    .replace(/([?&](?:api[_-]?key|key|token)=)[^&\s]+/gi, '$1***')
    // 本地绝对路径（Windows 盘符 / UNC / Unix）
    .replace(/\b[A-Za-z]:\\[^\s"'，。；、）)\]]+/g, '<本地路径>')
    .replace(/\\\\[^\s"'，。；、]+/g, '<本地路径>')
    .replace(/(?<![\w:/])\/(?:[^\s/]+\/)+[^\s"',;）)]*/g, '<本地路径>')
  text = text.replace(/\s+/g, ' ').trim()
  if (text.length > MAX_SAFE_ERROR_LENGTH) text = text.slice(0, MAX_SAFE_ERROR_LENGTH) + '…'
  return text
}

/** 从任意错误值里取出可读信息（不脱敏，供分类内部使用） */
function rawErrorMessage(input: unknown): string {
  if (typeof input === 'string') return input
  if (input instanceof Error) return input.message
  if (isRecord(input)) {
    if (typeof input.message === 'string') return input.message
    if (typeof input.data === 'string') return input.data
  }
  return ''
}

/* ------------------------------------------------------------------ */
/* 生成阶段                                                            */
/* ------------------------------------------------------------------ */

export type WorkshopStageId = 'understand' | 'generate' | 'validate' | 'done'
export type WorkshopStageState = 'done' | 'active' | 'todo'

export interface WorkshopStage {
  id: WorkshopStageId
  label: string
  state: WorkshopStageState
}

export interface WorkshopGenerationView {
  stages: WorkshopStage[]
  /** 当前阶段下标（0-3）；未开始为 -1 */
  activeIndex: number
  headline: string
  detail: string
  /** 阶段式粗粒度进度（0/15/55/85/100），不是真实 token 百分比 */
  percent: number
  textLength: number
  toolCalls: number
  elapsedSeconds: number
  finished: boolean
}

const STAGE_IDS: readonly WorkshopStageId[] = ['understand', 'generate', 'validate', 'done']
const STAGE_LABELS: readonly string[] = ['理解需求', '生成清单与代码', '解析与静态校验', '完成']
const STAGE_PERCENTS: readonly number[] = [15, 55, 85, 100]

export interface GenerationStageInput {
  busy: boolean
  /** 宿主推送的 phase（request/streaming/received/validating/retry/done），未知值按耗时兜底 */
  phase?: string | null
  textLength?: number
  toolCalls?: number
  elapsedSeconds?: number
}

/**
 * 生成阶段视图：
 * - 有宿主 phase 时以 phase 为准（真实状态），不再靠耗时瞎猜；
 * - phase 未知/缺失时退回「按耗时估算」，保证旧宿主也能显示；
 * - 超过 75 秒附加「可放弃后重试」的提示，不让用户对着转圈干等。
 */
export function generationStageView(input: GenerationStageInput): WorkshopGenerationView {
  const elapsedSeconds = Math.max(0, Math.floor(Number(input.elapsedSeconds) || 0))
  const textLength = Math.max(0, Math.floor(Number(input.textLength) || 0))
  const toolCalls = Math.max(0, Math.floor(Number(input.toolCalls) || 0))
  const base = {
    stages: STAGE_IDS.map((id, index) => ({
      id,
      label: `${index + 1} ${STAGE_LABELS[index]}`,
      state: 'todo' as WorkshopStageState,
    })),
    activeIndex: -1,
    headline: '尚未开始生成',
    detail: '',
    percent: 0,
    textLength,
    toolCalls,
    elapsedSeconds,
    finished: false,
  }
  if (!input.busy) return base

  const phase = typeof input.phase === 'string' ? input.phase : ''
  let index = -1
  let headline = ''
  let detail = ''
  if (phase === 'request') {
    index = 0
    headline = '正在连接模型并理解需求…'
  } else if (phase === 'streaming') {
    index = 1
    headline = `模型流式输出中：已接收 ${textLength.toLocaleString('zh-CN')} 字符 · ${toolCalls} 个工具调用`
  } else if (phase === 'received') {
    index = 2
    headline = '模型已返回，正在解析插件包…'
  } else if (phase === 'validating') {
    index = 2
    headline = '正在静态校验清单、代码与 bridge 契约…'
  } else if (phase === 'retry') {
    index = 1
    headline = '上一次生成未通过，正在重新生成…'
  } else if (phase === 'done') {
    index = 3
    headline = '生成与校验完成'
  } else {
    // 未知 phase：兼容旧宿主，按耗时估算（不因未知值崩溃或停在 0%）
    if (elapsedSeconds < 5) {
      index = 0
      headline = '正在连接模型并理解需求…'
    } else if (elapsedSeconds < 45) {
      index = 1
      headline = '正在生成插件入口与清单…'
    } else {
      index = 2
      headline = '正在解析并校验插件包…'
    }
  }

  if (index < 3 && elapsedSeconds >= 75) {
    headline += '（已等待较久，可放弃本次生成后重试）'
    detail = '多文件/客户端页面通常需要 20~90 秒；超时可以到接口设置里调大超时时间。'
  } else if (index === 1 && textLength > 0) {
    detail = '已收到的片段会持续累积；完成后自动做静态契约、语法与清单校验。'
  }

  return {
    ...base,
    activeIndex: index,
    headline,
    detail,
    percent: STAGE_PERCENTS[Math.min(index, 3)] ?? 0,
    stages: base.stages.map((stage, stageIndex) => ({
      ...stage,
      state: index === 3 || index > stageIndex ? 'done' : index === stageIndex ? 'active' : 'todo',
    })),
    finished: index === 3,
  }
}

/* ------------------------------------------------------------------ */
/* 生成失败归因                                                        */
/* ------------------------------------------------------------------ */

export type WorkshopFailureKind =
  | 'cancelled'
  | 'truncated'
  | 'invalid-json'
  | 'validation'
  | 'empty-output'
  | 'auth'
  | 'plugin-disabled'
  | 'model'
  | 'timeout'
  | 'network'
  | 'unknown'

export type WorkshopFailureAction = 'retry' | 'settings' | 'enable' | 'plugins' | 'refresh'

export interface WorkshopFailure {
  kind: WorkshopFailureKind
  title: string
  /** 已脱敏的原始信息（可能为空） */
  detail: string
  hint: string
  retryable: boolean
  actions: WorkshopFailureAction[]
}

const FAILURE_RULES: ReadonlyArray<{ kind: WorkshopFailureKind; test: RegExp }> = [
  { kind: 'plugin-disabled', test: /插件未启用|未启用.{0,6}插件|请先启用|在插件页启用|版本过旧/ },
  { kind: 'truncated', test: /截断|输出过长|输出达到.{0,8}(上限|token)|max.?tokens?|finish_reason|length/i },
  { kind: 'invalid-json', test: /json|不是合法|格式错误|无法解析|解析失败/i },
  { kind: 'validation', test: /校验|未通过|静态契约|语法错误|syntax|禁止使用|缺少\s*(apply|name|inject)/i },
  { kind: 'empty-output', test: /没有返回|未返回|为空|空输出|no content/i },
  { kind: 'timeout', test: /超时|timeout|timed out|etimedout/i },
  { kind: 'network', test: /网络|连接|断开|econn|enotfound|fetch failed|socket|proxy|代理/i },
  { kind: 'auth', test: /api.?key|401|403|认证|鉴权|凭据|权限不足|未配置/i },
  { kind: 'model', test: /模型|model/i },
]

interface FailureTemplate {
  title: string
  hint: string
  retryable: boolean
  actions: WorkshopFailureAction[]
}

const FAILURE_TEMPLATES: Record<WorkshopFailureKind, FailureTemplate> = {
  cancelled: {
    title: '已放弃本次生成',
    hint: '当前草稿保持不变；可以调整需求后重试。',
    retryable: true,
    actions: ['retry'],
  },
  truncated: {
    title: '模型输出被截断',
    hint: '输出达到 token 上限。可打开接口设置调大「最大输出 token」，或把需求拆小后重试。',
    retryable: true,
    actions: ['retry', 'settings'],
  },
  'invalid-json': {
    title: '模型返回的内容无法解析',
    hint: '模型返回的不是合法的插件包结构/JSON。重试通常可恢复；也可在设置里把 JSON 输出改为「on」或更换模型。',
    retryable: true,
    actions: ['retry', 'settings'],
  },
  validation: {
    title: '生成的代码未通过静态校验',
    hint: '生成的代码违反插件静态契约（如缺少 apply/name、inject 未声明、使用禁止 API）。重试会重新生成；也可在审阅区手动修正后重新校验。',
    retryable: true,
    actions: ['retry', 'settings'],
  },
  'empty-output': {
    title: '模型没有返回有效代码',
    hint: '请补充更明确的入口文件/页面要求后重试，例如说明「入口 index.mjs，需要 client/index.html」。',
    retryable: true,
    actions: ['retry'],
  },
  auth: {
    title: '工坊 API 凭据不可用',
    hint: 'Key 可能无效或已过期。打开接口设置检查 Key / baseUrl / 接口形态，或设置环境变量 DEEPSEEK_API_KEY。',
    retryable: false,
    actions: ['settings', 'enable'],
  },
  'plugin-disabled': {
    title: '「AI 插件工坊」插件未启用',
    hint: '工坊是独立插件，启用后才会注册生成服务；启用后可直接重试。',
    retryable: false,
    actions: ['enable', 'plugins', 'refresh'],
  },
  model: {
    title: '模型不可用',
    hint: '当前模型名称不被接口支持或模型已下线。打开接口设置重新拉取模型列表后选择可用模型。',
    retryable: true,
    actions: ['settings', 'retry'],
  },
  timeout: {
    title: '请求超时',
    hint: '请求超过配置的超时时间。可在接口设置调大超时时间，或稍后重试。',
    retryable: true,
    actions: ['retry', 'settings'],
  },
  network: {
    title: '网络或接口连接失败',
    hint: '检查网络、代理与 baseUrl；如果是内核断连，刷新状态可重连后再试。',
    retryable: true,
    actions: ['retry', 'refresh', 'settings'],
  },
  unknown: {
    title: '生成失败（未知原因）',
    hint: '可以重试；若持续失败，请检查接口设置或把需求拆小。',
    retryable: true,
    actions: ['retry', 'settings'],
  },
}

/**
 * 把生成失败归类成结构化提示。
 *
 * 宿主只把错误 message 传回界面（没有稳定的错误码），所以用关键字归因；
 * 归因失败时保留脱敏后的原始信息，绝不把 Key / 本地路径展示给用户。
 */
export function classifyWorkshopFailure(
  input: unknown,
  options: { cancelled?: boolean } = {},
): WorkshopFailure {
  const raw = rawErrorMessage(input)
  const sanitized = sanitizeErrorMessage(raw)
  const kind: WorkshopFailureKind = options.cancelled
    ? 'cancelled'
    : (FAILURE_RULES.find((rule) => rule.test.test(raw))?.kind ?? 'unknown')
  const template = FAILURE_TEMPLATES[kind]
  return {
    kind,
    title: template.title,
    detail: kind === 'cancelled' ? '' : sanitized,
    hint: template.hint,
    retryable: template.retryable,
    actions: [...template.actions],
  }
}

/* ------------------------------------------------------------------ */
/* 准备状态（配置引导）                                                */
/* ------------------------------------------------------------------ */

export type WorkshopBlockerId = 'status' | 'plugin' | 'api-key' | 'model'
export type WorkshopGuideAction = 'refresh' | 'enable' | 'settings' | 'plugins'

export interface WorkshopBlocker {
  id: WorkshopBlockerId
  title: string
  detail: string
  action: WorkshopGuideAction
  actionLabel: string
}

export interface WorkshopReadiness {
  ready: boolean
  headline: string
  blockers: WorkshopBlocker[]
}

export interface WorkshopReadinessInput {
  statusLoading: boolean
  statusKnown: boolean
  statusError?: string
  available: boolean
  configured: boolean
  /** Key 来源（config/env/none 的人类可读文本） */
  keySource?: string
  model?: string
}

/**
 * 准备状态：返回还缺什么、点哪里能补齐。
 * 一条 blocker 只给一个主行动，避免用户面对一堆按钮不知先点哪个。
 */
export function workshopReadiness(input: WorkshopReadinessInput): WorkshopReadiness {
  if (!input.statusKnown) {
    if (input.statusLoading) {
      return { ready: false, headline: '正在读取工坊状态…', blockers: [] }
    }
    const error = sanitizeErrorMessage(input.statusError)
    return {
      ready: false,
      headline: '暂时无法读取工坊状态',
      blockers: [
        {
          id: 'status',
          title: '读取工坊状态失败',
          detail: error ? `原因：${error}` : '请检查内核/插件是否正常，然后重新读取。',
          action: 'refresh',
          actionLabel: '重新读取',
        },
      ],
    }
  }
  const blockers: WorkshopBlocker[] = []
  if (!input.available) {
    blockers.push({
      id: 'plugin',
      title: '「AI 插件工坊」插件还没有启用',
      detail: '工坊是独立插件，拥有自己的 API 接口配置；启用后才能生成插件包。',
      action: 'enable',
      actionLabel: '启用插件',
    })
  } else if (!input.configured) {
    blockers.push({
      id: 'api-key',
      title: '工坊还没有可用的 API Key',
      detail: '在工坊的接口设置里填写 Key（与「AI 清理顾问」互相独立），或设置环境变量 DEEPSEEK_API_KEY / OPENAI_API_KEY。',
      action: 'settings',
      actionLabel: '打开接口设置',
    })
  } else if (!String(input.model ?? '').trim()) {
    blockers.push({
      id: 'model',
      title: '工坊还没有可用模型',
      detail: '打开接口设置拉取模型列表，或手动填写模型名（例如 deepseek-flash）。',
      action: 'settings',
      actionLabel: '选择模型',
    })
  }
  if (!blockers.length) {
    const source = input.keySource ? `（Key 来源：${input.keySource}）` : ''
    return { ready: true, headline: `准备就绪：可以直接生成插件包${source}`, blockers: [] }
  }
  return { ready: false, headline: `还有 ${blockers.length} 项准备未完成`, blockers }
}

/* ------------------------------------------------------------------ */
/* 按钮门禁                                                           */
/* ------------------------------------------------------------------ */

export interface Gate {
  ok: boolean
  /** 不可用原因（用于 title/tooltip 与页内提示） */
  reason?: string
}

export interface GenerateGateInput {
  busy: boolean
  installing: boolean
  requirement: string
  available: boolean
  configured: boolean
}

/** 生成按钮门禁：按优先级返回第一个真实原因，避免「点了没反应」 */
export function generateGate(input: GenerateGateInput): Gate {
  if (input.installing) return { ok: false, reason: '正在安装插件包，完成后再生成' }
  if (input.busy) return { ok: false, reason: '正在生成中：可查看进度或放弃本次生成' }
  if (!normalizeRequirement(input.requirement)) return { ok: false, reason: '请先描述你想要的插件' }
  if (!input.available) return { ok: false, reason: '工坊插件未启用：先启用「AI 插件工坊」插件' }
  if (!input.configured) return { ok: false, reason: '工坊 API 未配置：打开接口设置填写 Key，或设置环境变量 DEEPSEEK_API_KEY' }
  return { ok: true }
}

export type ValidationStatus = 'idle' | 'pending' | 'passed' | 'failed'

export interface InstallGateInput {
  hasDraft: boolean
  validationStatus: ValidationStatus
  /** 校验结果是否对应当前代码/清单（编辑后为 false） */
  validationFresh: boolean
  manifestError: string
  reviewed: boolean
  installing: boolean
  dependencyCount: number
  dependenciesAccepted: boolean
}

/** 安装按钮门禁：校验未通过、未勾选确认、依赖未确认时都不允许静默点击 */
export function installGate(input: InstallGateInput): Gate {
  if (!input.hasDraft) return { ok: false, reason: '先生成一份插件包草稿' }
  if (input.installing) return { ok: false, reason: '正在安装插件包…' }
  if (input.manifestError) return { ok: false, reason: '清单 JSON 不合法：先修正清单错误' }
  if (input.validationStatus === 'pending' || input.validationStatus === 'idle') {
    return { ok: false, reason: '静态校验尚未完成：请稍候' }
  }
  if (input.validationStatus === 'failed') return { ok: false, reason: '静态校验未通过：请先修正校验错误' }
  if (!input.validationFresh) return { ok: false, reason: '代码或清单有改动：正在重新校验，请稍候' }
  if (!input.reviewed) return { ok: false, reason: '请先勾选「我已阅读清单与代码」' }
  if (input.dependencyCount > 0 && !input.dependenciesAccepted) {
    return { ok: false, reason: '请先确认插件包声明的第三方依赖' }
  }
  return { ok: true }
}

/* ------------------------------------------------------------------ */
/* 校验摘要（安装前）                                                  */
/* ------------------------------------------------------------------ */

export type ValidationGateId = 'client' | 'manifest' | 'files' | 'entry' | 'dependencies' | 'other'

export interface ValidationGate {
  id: ValidationGateId
  label: string
  ok: boolean
  errors: string[]
}

export type RiskyApiLevel = 'danger' | 'warn'

export interface RiskyApiHit {
  id: string
  label: string
  level: RiskyApiLevel
  hint: string
}

export interface ValidationSummary {
  status: ValidationStatus
  headline: string
  gates: ValidationGate[]
  errors: string[]
  warnings: string[]
  warningCount: number
  failedGates: number
  risky: RiskyApiHit[]
}

/** 错误归类顺序：先匹配更具体的，再匹配通用的 */
const VALIDATION_GATE_DEFS: ReadonlyArray<{ id: Exclude<ValidationGateId, 'other'>; label: string; test: RegExp }> = [
  { id: 'client', label: '客户端页面 / bridge', test: /客户端|client|bridge/i },
  { id: 'manifest', label: '清单结构', test: /清单|manifest/i },
  { id: 'files', label: '文件与路径', test: /文件|路径|plugin\.json|体积/i },
  { id: 'entry', label: '入口源码契约', test: /入口源码|代码|apply|inject|import|语法/i },
  { id: 'dependencies', label: '依赖声明', test: /依赖/i },
]

const RISK_RULES: ReadonlyArray<{ id: string; level: RiskyApiLevel; label: string; hint: string; test: RegExp }> = [
  {
    id: 'child-process',
    level: 'danger',
    label: '子进程 / shell',
    hint: '静态校验会拦截；需要执行命令时应改为调用内核服务。',
    test: /child_process|\b(execSync|spawnSync)\b|\bspawn\s*\(|\bexec\s*\(/,
  },
  {
    id: 'process-exit',
    level: 'danger',
    label: 'process.exit',
    hint: '插件不能结束宿主进程，请改为向 ctx 报告错误。',
    test: /\bprocess\.exit\b/,
  },
  {
    id: 'direct-delete',
    level: 'danger',
    label: '直接删除文件',
    hint: '删除必须交给内核（可恢复），禁止在插件里直接 unlink/rm。',
    test: /\.(?:unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync)\s*\(/,
  },
  {
    id: 'network',
    level: 'danger',
    label: '网络请求',
    hint: '插件内禁止发起网络请求；外发由内核统一管理。',
    test: /(?:\bfetch\s*\(|\baxios\b|\bXMLHttpRequest\b|from\s+['"]node:https?['"]|from\s+['"]https?['"])/,
  },
  {
    id: 'process-env',
    level: 'warn',
    label: 'process.env',
    hint: '建议用 ctx.system.env.get(...) 读取环境变量，便于统一审计。',
    test: /\bprocess\.env\b/,
  },
]

/**
 * 扫描草稿源码里的危险/敏感 API 命中。
 * 只做静态文本提示，真正的拦截由宿主静态校验负责；命中项在安装前让用户看清楚。
 */
export function scanRiskyApis(sources: string | readonly string[]): RiskyApiHit[] {
  const text = (Array.isArray(sources) ? sources.join('\n') : String(sources ?? '')).slice(0, MAX_RISK_SCAN_CHARS)
  if (!text.trim()) return []
  const hits: RiskyApiHit[] = []
  for (const rule of RISK_RULES) {
    if (rule.test.test(text)) {
      hits.push({ id: rule.id, level: rule.level, label: rule.label, hint: rule.hint })
    }
  }
  return hits
}

function truncateError(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > 400 ? normalized.slice(0, 400) + '…' : normalized
}

export interface ValidationSummaryInput {
  validation?: { ok: boolean; errors?: readonly string[]; warnings?: readonly string[] } | null
  validating?: boolean
  risky?: readonly RiskyApiHit[]
}

/**
 * 安装前校验摘要：把一条条错误归到「清单 / 文件 / 入口 / client / 依赖」闸门，
 * 让用户一眼看到哪一关没过；危险 API 命中和 warnings 单独展示。
 */
export function summarizeValidation(input: ValidationSummaryInput): ValidationSummary {
  const validation = input.validation ?? null
  const errors = (validation?.errors ?? []).map((item) => truncateError(String(item ?? ''))).filter(Boolean)
  const warnings = (validation?.warnings ?? []).map((item) => truncateError(String(item ?? ''))).filter(Boolean)
  const risky = [...(input.risky ?? [])]
  const grouped = new Map<ValidationGateId, string[]>()
  for (const definition of VALIDATION_GATE_DEFS) grouped.set(definition.id, [])
  const other: string[] = []
  for (const error of errors) {
    const matched = VALIDATION_GATE_DEFS.find((definition) => definition.test.test(error))
    if (matched) grouped.get(matched.id)!.push(error)
    else other.push(error)
  }
  const gates: ValidationGate[] = VALIDATION_GATE_DEFS.map((definition) => {
    const gateErrors = grouped.get(definition.id)!
    return { id: definition.id, label: definition.label, ok: gateErrors.length === 0, errors: gateErrors }
  })
  if (other.length) gates.push({ id: 'other', label: '其它问题', ok: false, errors: other })
  const status: ValidationStatus = validation
    ? validation.ok
      ? 'passed'
      : 'failed'
    : input.validating
      ? 'pending'
      : 'idle'
  const failedGates = gates.filter((gate) => !gate.ok).length
  let headline: string
  if (status === 'idle') {
    headline = '尚未校验：生成草稿或修改代码/清单后会自动校验'
  } else if (status === 'pending') {
    headline = '正在重新校验清单、代码与静态契约…'
  } else if (status === 'passed') {
    headline =
      warnings.length > 0
        ? `校验通过：${gates.length} 项闸门全部通过，另有 ${warnings.length} 条提示`
        : `校验通过：${gates.length} 项闸门全部通过`
  } else {
    headline = `校验未通过：${failedGates} 项闸门有问题（${errors.length} 个错误）`
  }
  return {
    status,
    headline,
    gates,
    errors,
    warnings,
    warningCount: warnings.length,
    failedGates,
    risky,
  }
}

/* ------------------------------------------------------------------ */
/* 草稿历史（本地持久化）                                              */
/* ------------------------------------------------------------------ */

export interface WorkshopDraftSnapshot {
  id: string
  savedAt: number
  requirement: string
  draft: AiPluginDraft
}

export interface DraftHistoryItem {
  id: string
  savedAt: number
  requirement: string
  name: string
  kind: string
  fileCount: number
  totalBytes: number
  dependencyCount: number
}

function isSafeDraftPath(path: string): boolean {
  if (!path || path.length > 240 || path.startsWith('/') || path.includes('\\')) return false
  if (!/^[A-Za-z0-9._/-]+$/.test(path)) return false
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

function normalizeDependencies(value: unknown): Record<string, string> {
  const result: Record<string, string> = {}
  if (!isRecord(value)) return result
  for (const [name, version] of Object.entries(value).slice(0, 20)) {
    if (!name || name.length > 120) continue
    if (typeof version !== 'string') continue
    const trimmed = version.trim()
    if (!trimmed || trimmed.length > 120) continue
    result[name] = trimmed
  }
  return result
}

function normalizeDraftFiles(value: unknown): AiPluginFile[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return undefined
  const files: AiPluginFile[] = []
  for (const item of value.slice(0, MAX_DRAFT_FILES * 2)) {
    const raw = asRecord(item)
    if (!raw) continue
    const path = typeof raw.path === 'string' ? raw.path.trim() : ''
    const content = typeof raw.content === 'string' ? raw.content : ''
    if (!isSafeDraftPath(path) || content.length > MAX_DRAFT_FILE_CHARS) continue
    if (files.some((file) => file.path === path)) continue
    files.push({ path, content })
    if (files.length >= MAX_DRAFT_FILES) break
  }
  return files
}

function normalizeManifest(value: unknown): PluginManifest | undefined {
  if (!isRecord(value)) return undefined
  try {
    return JSON.parse(JSON.stringify(value)) as PluginManifest
  } catch {
    return undefined
  }
}

/**
 * 把任意输入归一成可持久化的草稿：
 * - 必须有可用代码（code 或文件里有内容），否则丢弃；
 * - 文件路径必须是包内相对路径；非法项跳过，数量/单文件大小受限；
 * - 超大草稿（序列化超过 MAX_SNAPSHOT_CHARS）由上层直接放弃持久化，不做静默截断。
 */
export function normalizeDraft(input: unknown): AiPluginDraft | undefined {
  const raw = asRecord(input)
  if (!raw) return undefined
  const manifest = normalizeManifest(raw.manifest)
  const files = normalizeDraftFiles(raw.files)
  let code = typeof raw.code === 'string' ? raw.code : ''
  const entryPath = typeof manifest?.entry === 'string' ? manifest.entry : 'index.mjs'
  if (!code.trim() && files?.length) {
    code = files.find((file) => file.path === entryPath)?.content ?? files[0]!.content
  }
  if (!code.trim() || code.length > MAX_DRAFT_FILE_CHARS) return undefined
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 120) : 'ai-plugin'
  const notes = typeof raw.notes === 'string' ? raw.notes.slice(0, 2_000) : ''
  const kind = typeof raw.kind === 'string' && raw.kind.trim() ? raw.kind.trim().slice(0, 40) : undefined
  const mode = raw.mode === 'worker' ? 'worker' : 'native'
  const format =
    raw.format === 'package' || raw.format === 'single-file'
      ? raw.format
      : manifest || files?.length
        ? 'package'
        : 'single-file'
  return {
    name,
    code,
    notes,
    dependencies: normalizeDependencies(raw.dependencies),
    mode,
    ...(kind ? { kind: kind as AiPluginDraft['kind'] } : {}),
    format,
    ...(manifest ? { manifest } : {}),
    ...(files ? { files } : {}),
  }
}

function normalizeSnapshot(value: unknown): WorkshopDraftSnapshot | undefined {
  const raw = asRecord(value)
  if (!raw) return undefined
  const requirement = normalizeRequirement(raw.requirement)
  if (!requirement) return undefined
  const draft = normalizeDraft(raw.draft)
  if (!draft) return undefined
  const savedAt =
    typeof raw.savedAt === 'number' && Number.isFinite(raw.savedAt) && raw.savedAt > 0 ? Math.floor(raw.savedAt) : 0
  const fallbackId = `draft-${stableHash(requirement + '|' + savedAt)}`
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 80) : fallbackId
  const payload = JSON.stringify({ id, savedAt, requirement, draft })
  if (payload.length > MAX_SNAPSHOT_CHARS) return undefined
  return { id, savedAt, requirement, draft }
}

/** 去重（同一需求只保留最新一份）→ 按时间倒序 → 限制条数与总字符数 */
function limitSnapshots(items: readonly WorkshopDraftSnapshot[]): WorkshopDraftSnapshot[] {
  const byRequirement = new Map<string, WorkshopDraftSnapshot>()
  for (const item of items) {
    const existing = byRequirement.get(item.requirement)
    if (!existing || item.savedAt >= existing.savedAt) byRequirement.set(item.requirement, item)
  }
  const sorted = [...byRequirement.values()].sort((left, right) => right.savedAt - left.savedAt)
  const limited = sorted.slice(0, MAX_DRAFT_HISTORY)
  while (limited.length > 0 && JSON.stringify({ version: 1, items: limited }).length > MAX_HISTORY_CHARS) {
    limited.pop()
  }
  return limited
}

/** 生成一份草稿快照；草稿无效或超出本地存储预算时返回 undefined（不影响内存里的草稿） */
export function draftToSnapshot(requirement: unknown, draft: unknown, savedAt: number): WorkshopDraftSnapshot | undefined {
  const text = normalizeRequirement(requirement)
  if (!text) return undefined
  const normalized = normalizeDraft(draft)
  if (!normalized) return undefined
  const at = Number.isFinite(savedAt) && savedAt > 0 ? Math.floor(savedAt) : 0
  const payload = JSON.stringify({ requirement: text, draft: normalized })
  if (payload.length > MAX_SNAPSHOT_CHARS) return undefined
  return {
    id: `draft-${stableHash(text + '|' + at)}`,
    savedAt: at,
    requirement: text,
    draft: normalized,
  }
}

/** 追加草稿到历史头部（同需求覆盖旧条目），自动去重/限条数/限总字符数 */
export function appendDraftHistory(
  existing: readonly WorkshopDraftSnapshot[],
  next: WorkshopDraftSnapshot,
): WorkshopDraftSnapshot[] {
  const normalizedNext = normalizeSnapshot(next)
  if (!normalizedNext) return limitSnapshots(existing.filter(isSnapshotLike))
  const rest = existing.filter(
    (item) => item.requirement !== normalizedNext.requirement && item.id !== normalizedNext.id,
  )
  return limitSnapshots([normalizedNext, ...rest.filter(isSnapshotLike)])
}

function isSnapshotLike(value: unknown): value is WorkshopDraftSnapshot {
  const raw = asRecord(value)
  return Boolean(raw && typeof raw.id === 'string' && typeof raw.requirement === 'string' && raw.draft)
}

/** 序列化历史（写入 localStorage 前）；即使输入里混入坏数据也能安全产出合法 JSON */
export function serializeDraftHistory(items: readonly WorkshopDraftSnapshot[]): string {
  const normalized: WorkshopDraftSnapshot[] = []
  for (const item of Array.isArray(items) ? items : []) {
    const snapshot = normalizeSnapshot(item)
    if (snapshot) normalized.push(snapshot)
  }
  const trimmed = limitSnapshots(normalized)
  if (!trimmed.length) return JSON.stringify({ version: 1, items: [] })
  return JSON.stringify({ version: 1, items: trimmed })
}

/**
 * 容错解析历史：
 * - 坏 JSON / 非对象 / 缺字段 → 返回 []；
 * - 单条坏数据只跳过该条，不连带清空整个历史；
 * - 兼容早期直接存数组的格式。
 */
export function parseDraftHistory(rawText: string | null | undefined): WorkshopDraftSnapshot[] {
  if (typeof rawText !== 'string' || !rawText.trim()) return []
  if (rawText.length > MAX_HISTORY_CHARS * 1.2) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch {
    return []
  }
  const items = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.items)
      ? parsed.items
      : undefined
  if (!items) return []
  const normalized: WorkshopDraftSnapshot[] = []
  for (const item of items) {
    const snapshot = normalizeSnapshot(item)
    if (snapshot) normalized.push(snapshot)
  }
  return limitSnapshots(normalized)
}

/** 恢复草稿时给页面一份独立副本，避免编辑历史记录本身 */
export function materializeSnapshot(
  snapshot: WorkshopDraftSnapshot,
): { requirement: string; draft: AiPluginDraft } | undefined {
  const normalized = normalizeSnapshot(snapshot)
  if (!normalized) return undefined
  const clone = normalizeDraft(JSON.parse(JSON.stringify(normalized.draft)))
  if (!clone) return undefined
  return { requirement: normalized.requirement, draft: clone }
}

function draftFileCount(draft: AiPluginDraft): number {
  if (draft.files?.length) return draft.files.length
  return draft.code.trim() ? 1 : 0
}

function draftByteSize(draft: AiPluginDraft): number {
  if (draft.files?.length) {
    return draft.files.reduce((sum, file) => sum + utf8Bytes(file.content), 0)
  }
  return utf8Bytes(draft.code)
}

/** 历史列表展示数据（需求摘要 / 文件数 / 体积 / 依赖数） */
export function draftHistoryItems(items: readonly WorkshopDraftSnapshot[]): DraftHistoryItem[] {
  const result: DraftHistoryItem[] = []
  for (const item of Array.isArray(items) ? items : []) {
    const snapshot = normalizeSnapshot(item)
    if (!snapshot) continue
    result.push({
      id: snapshot.id,
      savedAt: snapshot.savedAt,
      requirement: shortText(snapshot.requirement, 64),
      name: snapshot.draft.name,
      kind: snapshot.draft.kind ?? 'cleaner',
      fileCount: draftFileCount(snapshot.draft),
      totalBytes: draftByteSize(snapshot.draft),
      dependencyCount: Object.keys(snapshot.draft.dependencies ?? {}).length,
    })
  }
  return result
}
