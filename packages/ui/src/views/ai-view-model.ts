/**
 * AI 清理顾问页展示模型（纯函数，可单测）。
 *
 * 对应 docs/ui-navigation.md §8 第 5 区的待完成项：
 * - 未配置 / 未启用 / 隐私关闭 / 模型不可用时的**引导态**：给原因和出口，不静默失败；
 * - 分析失败的**结构化错误**：缺 Key、鉴权、超时、截断、非法 JSON、隐私拦截、网络、取消都可分类，
 *   文案脱敏（绝不回显 Key / 带 token 的 URL）并给出可重试动作；
 * - 建议结果的**聚合摘要**：按风险 / 任务统计，支持风险 / 任务筛选；
 * - **清理项批量选择**：可重新勾选、全选 / 全不选 / 只选安全项，应用前给出确认摘要，
 *   失效项与受保护项一律不可选（安全边界只收紧不放松）；
 * - **扫描根建议分级**：宽目录默认不勾选、盘符根不允许添加、已在范围内不重复添加；
 * - 页面阶段判断与流式输出兜底文案。
 *
 * 这里只做纯数据计算，不碰 DOM / 网络 / localStorage，方便脱离界面单测。
 */
import type { RiskLevel } from '@cordclean/shared'

export const RISK_LEVELS: readonly RiskLevel[] = ['safe', 'caution', 'risky']

/** 没有关联清理任务的建议 / 清理项的统一分组 key（避免和真实 taskId 冲突） */
export const UNASSIGNED_TASK_KEY = '__none__'

/* ------------------------------------------------------------------ */
/* 小工具：容错与格式化                                                */
/* ------------------------------------------------------------------ */

function asText(value: unknown, max = 200): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function asNonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}

/** 字节格式化（展示模型内部用于摘要文案，与 shared 的 formatBytes 输出风格一致） */
export function formatBytesText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index++
  }
  const digits = value >= 100 || index === 0 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[index]}`
}

function formatDurationText(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  if (total < 60) return `${total} 秒`
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  if (minutes < 60) return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes ? `${hours} 小时 ${restMinutes} 分` : `${hours} 小时`
}

/* ------------------------------------------------------------------ */
/* 1. 引导态：未启用 / 隐私关闭 / 缺 Key / 缺模型 / 探测失败 / 自定义模型 */
/* ------------------------------------------------------------------ */

export type AiSetupState =
  | 'ready'
  | 'plugin-disabled'
  | 'privacy-blocked'
  | 'missing-key'
  | 'missing-model'
  | 'probe-failed'
  | 'model-custom'

export type AiSetupActionId =
  | 'enable-plugin'
  | 'fill-key'
  | 'open-settings'
  | 'open-plugins'
  | 'open-egress'
  | 'refresh-models'
  | 'change-model'
  | 'probe'

export interface AiSetupAction {
  id: AiSetupActionId
  label: string
  primary?: boolean
}

export interface AiSetupGuide {
  state: AiSetupState
  /** 是否阻止发起分析（引导态需要用户先处理某个前置条件） */
  blocking: boolean
  tone: 'success' | 'info' | 'warning' | 'error'
  title: string
  message: string
  actions: AiSetupAction[]
}

export interface AiSetupProbeLike {
  ok: boolean
  error?: string
}

export interface AiSetupInput {
  /** AI 插件是否可用（启用且被内核加载） */
  available: boolean
  /** 是否有可用凭据：已保存的配置 / 环境变量，或界面里已填写但还没保存的 Key */
  configured: boolean
  /** 设置里「允许在线 AI」总开关 */
  onlineAi: boolean
  /** 当前表单里的模型名 */
  model: string
  /** 候选模型 id 列表；为空表示还没拉取过（此时不判定为自定义模型） */
  modelIds: readonly string[]
  /** 最近一次「测试连接」结果 */
  probe?: AiSetupProbeLike
}

/**
 * 生成引导态。
 *
 * 判定顺序即用户需要处理的顺序：插件未启用 → 隐私开关关闭 → 没 Key → 没模型 →
 * 上次探测失败（只提示，不阻断）→ 自定义模型名（只提示）→ 就绪。
 */
export function aiSetupGuide(input: AiSetupInput): AiSetupGuide {
  if (!input.available) {
    return {
      state: 'plugin-disabled',
      blocking: true,
      tone: 'warning',
      title: 'AI 插件未启用',
      message:
        '启用「AI 清理顾问」插件后才会读取环境变量 DEEPSEEK_API_KEY，或使用下方填写的 Key；未启用时不会发出任何网络请求。',
      actions: [
        { id: 'enable-plugin', label: '立即启用', primary: true },
        { id: 'open-plugins', label: '去插件页' },
      ],
    }
  }
  if (!input.onlineAi) {
    return {
      state: 'privacy-blocked',
      blocking: true,
      tone: 'error',
      title: '在线 AI 已被隐私设置关闭',
      message:
        '分析会把脱敏后的系统摘要发送给模型服务；「设置 → 隐私与在线 AI → 允许在线 AI」已关闭，请求会被外发出口拦截。',
      actions: [
        { id: 'open-settings', label: '去设置开启', primary: true },
        { id: 'open-egress', label: '查看外发记录' },
      ],
    }
  }
  if (!input.configured) {
    return {
      state: 'missing-key',
      blocking: true,
      tone: 'warning',
      title: '还没有可用的 API Key',
      message:
        '在下方「接口设置 → API Key」填写，或设置环境变量 DEEPSEEK_API_KEY / OPENAI_API_KEY 后保存；Key 只保存在本机 config.json。',
      actions: [
        { id: 'fill-key', label: '填写 API Key', primary: true },
        { id: 'open-plugins', label: '去插件页检查' },
      ],
    }
  }
  const model = asText(input.model, 120)
  if (!model) {
    return {
      state: 'missing-model',
      blocking: true,
      tone: 'warning',
      title: '还没有选择模型',
      message: '请从候选里选择或手动输入模型名（默认 deepseek-flash）；空模型名无法发起分析。',
      actions: [
        { id: 'change-model', label: '去选择模型', primary: true },
        { id: 'refresh-models', label: '获取模型列表' },
      ],
    }
  }
  if (input.probe && input.probe.ok === false) {
    const info = classifyAiError(input.probe.error ?? '连通测试失败')
    const keyFirst = info.kind === 'missing-key' || info.kind === 'auth'
    return {
      state: 'probe-failed',
      blocking: false,
      tone: 'warning',
      title: '最近一次「测试连接」失败',
      message: `${info.detail || info.title}。${info.hint}`,
      actions: keyFirst
        ? [
            { id: 'fill-key', label: '检查 API Key', primary: true },
            { id: 'probe', label: '重新测试连接' },
          ]
        : [
            { id: 'probe', label: '重新测试连接', primary: true },
            { id: 'refresh-models', label: '重新获取模型' },
          ],
    }
  }
  const modelIds = (input.modelIds ?? []).map((id) => asText(id, 120)).filter(Boolean)
  if (modelIds.length && !modelIds.includes(model)) {
    return {
      state: 'model-custom',
      blocking: false,
      tone: 'info',
      title: '当前模型名不在候选列表中',
      message: `「${model}」不在接口返回的候选模型里，会原样发送给接口；若接口不识别会返回 400/404。`,
      actions: [
        { id: 'change-model', label: '从候选选择', primary: true },
        { id: 'refresh-models', label: '重新获取模型' },
      ],
    }
  }
  return {
    state: 'ready',
    blocking: false,
    tone: 'success',
    title: '可以开始分析',
    message: '接口与凭据已就绪。',
    actions: [],
  }
}

/* ------------------------------------------------------------------ */
/* 2. 开始分析按钮门禁：不可用时给可读原因                             */
/* ------------------------------------------------------------------ */

export interface AnalyzeGateInput {
  available: boolean
  configured: boolean
  onlineAi: boolean
  running: boolean
  saving?: boolean
}

export function analyzeGate(input: AnalyzeGateInput): { ok: boolean; reason?: string } {
  if (!input.available) return { ok: false, reason: 'AI 插件未启用，请先启用' }
  if (!input.onlineAi) return { ok: false, reason: '在线 AI 已在设置中关闭，请先开启隐私开关' }
  if (!input.configured) return { ok: false, reason: '请先填写 API Key（或设置环境变量 DEEPSEEK_API_KEY）' }
  if (input.running) return { ok: false, reason: '正在分析中，可先取消生成' }
  if (input.saving) return { ok: false, reason: '正在保存接口配置，请稍候' }
  return { ok: true }
}

/* ------------------------------------------------------------------ */
/* 3. 分析失败的结构化分类与脱敏                                       */
/* ------------------------------------------------------------------ */

export type AiErrorKind =
  | 'cancelled'
  | 'missing-key'
  | 'auth'
  | 'privacy'
  | 'timeout'
  | 'truncated'
  | 'invalid-json'
  | 'no-answer'
  | 'vision-unsupported'
  | 'image-too-large'
  | 'rate-limit'
  | 'server'
  | 'bad-request'
  | 'network'
  | 'unknown'

export type AiErrorActionId =
  | 'retry'
  | 'fill-key'
  | 'open-settings'
  | 'open-plugins'
  | 'open-egress'
  | 'increase-tokens'
  | 'focus-timeout'
  | 'change-model'
  | 'remove-image'
  | 'refresh-models'

export interface AiErrorAction {
  id: AiErrorActionId
  label: string
  primary?: boolean
}

export interface AiErrorInfo {
  kind: AiErrorKind
  title: string
  hint: string
  /** 已脱敏、截断后的原始错误信息（用于折叠的「技术详情」） */
  detail: string
  retryable: boolean
  actions: AiErrorAction[]
}

const ERROR_TITLES: Record<AiErrorKind, string> = {
  cancelled: '本次生成已取消',
  'missing-key': '还没有可用的 API Key',
  auth: '接口鉴权失败',
  privacy: '请求被隐私开关拦截',
  timeout: '分析请求超时',
  truncated: '模型输出被截断',
  'invalid-json': '模型返回的内容不是合法 JSON',
  'no-answer': '模型没有返回最终答案',
  'vision-unsupported': '当前模型不支持图片输入',
  'image-too-large': '截图文件过大',
  'rate-limit': '接口触发限流',
  server: '模型服务端异常',
  'bad-request': '接口拒绝了请求参数',
  network: '网络或内核连接失败',
  unknown: '分析失败',
}

const ERROR_HINTS: Record<AiErrorKind, string> = {
  cancelled: '你已取消本次生成，不会写入不完整的分析结果；可随时重新分析。',
  'missing-key': '在下方「接口设置 → API Key」填写，或设置环境变量 DEEPSEEK_API_KEY / OPENAI_API_KEY 后重试；Key 只保存在本机。',
  auth: '检查 API Key 是否有效、是否与接口地址/形态匹配；401/403 通常是凭据或权限问题。',
  privacy: '「设置 → 隐私与在线 AI → 允许在线 AI」已关闭；打开后才会放行外发请求，被拦截的请求会记录在「外发记录」。',
  timeout: '网络慢或模型思考过久：可调大「超时（毫秒）」、调小「最大输出 token」，或稍后重试。',
  truncated: '模型输出没写完，JSON 不完整：调大「最大输出 token」后重试；持续发生可缩小分析范围。',
  'invalid-json': '模型没有按要求输出 JSON（或被额外文字包裹）：可重试；持续失败可切换接口形态，或检查额外参数是否覆盖了 response_format。',
  'no-answer': '模型只输出了思维链或空内容：可重试，或调大最大输出 token。',
  'vision-unsupported': '当前模型不支持图片输入：移除截图后重试，或切换到支持视觉的模型（官方 deepseek-flash）。',
  'image-too-large': '截图过大：压缩到 3MB 以内后重新选择。',
  'rate-limit': '接口限流：等待几秒后重试，不要连续快速点击。',
  server: '模型服务端异常：稍后重试；若持续发生可切换接口形态或检查 baseUrl。',
  'bad-request': '接口拒绝了请求：检查接口形态、baseUrl、模型名是否匹配，以及额外参数 JSON 是否合法。',
  network: '网络或与内核的连接失败：检查网络/代理后重试；浏览器版需确认内核仍在运行。',
  unknown: '可先重试；持续失败请打开「外发记录」查看脱敏后的请求预览，或到插件页查看日志。',
}

const ERROR_ACTIONS: Record<AiErrorKind, AiErrorAction[]> = {
  cancelled: [{ id: 'retry', label: '重新分析', primary: true }],
  'missing-key': [
    { id: 'fill-key', label: '填写 API Key', primary: true },
    { id: 'retry', label: '重试' },
  ],
  auth: [
    { id: 'fill-key', label: '检查/更换 API Key', primary: true },
    { id: 'open-plugins', label: '去插件页' },
  ],
  privacy: [
    { id: 'open-settings', label: '去设置开启在线 AI', primary: true },
    { id: 'open-egress', label: '查看外发记录' },
  ],
  timeout: [
    { id: 'retry', label: '重试', primary: true },
    { id: 'focus-timeout', label: '检查超时设置' },
  ],
  truncated: [
    { id: 'increase-tokens', label: '调大最大输出 token', primary: true },
    { id: 'retry', label: '重试' },
  ],
  'invalid-json': [
    { id: 'retry', label: '重试', primary: true },
    { id: 'open-plugins', label: '检查接口配置' },
  ],
  'no-answer': [
    { id: 'retry', label: '重试', primary: true },
    { id: 'increase-tokens', label: '调大最大输出 token' },
  ],
  'vision-unsupported': [
    { id: 'remove-image', label: '移除截图', primary: true },
    { id: 'change-model', label: '更换模型' },
  ],
  'image-too-large': [{ id: 'remove-image', label: '移除截图', primary: true }],
  'rate-limit': [{ id: 'retry', label: '稍后重试', primary: true }],
  server: [{ id: 'retry', label: '重试', primary: true }],
  'bad-request': [
    { id: 'open-plugins', label: '检查接口配置', primary: true },
    { id: 'refresh-models', label: '重新获取模型' },
  ],
  network: [
    { id: 'retry', label: '重试', primary: true },
    { id: 'open-plugins', label: '检查插件状态' },
  ],
  unknown: [
    { id: 'retry', label: '重试', primary: true },
    { id: 'open-egress', label: '查看外发记录' },
  ],
}

/** 错误分类规则：从上到下匹配，第一个命中即采用（顺序即优先级） */
const ERROR_RULES: Array<{ kind: AiErrorKind; pattern: RegExp }> = [
  { kind: 'privacy', pattern: /在线 AI 已在设置中关闭|在线 AI 已被关闭|隐私开关|外发被拦截|被外发出口|egress/i },
  { kind: 'missing-key', pattern: /未配置\s*api\s*key|api\s*key\s*未配置|no\s*api\s*key|missing\s*api\s*key|deepseek_api_key|openai_api_key|dashscope_api_key/i },
  { kind: 'auth', pattern: /http\s*401|http\s*403|unauthori[sz]ed|invalid\s*api\s*key|incorrect\s*api\s*key|authentication|鉴权|认证失败|api key 无效|权限不足/i },
  { kind: 'truncated', pattern: /输出被截断|被截断|truncat|max[_\s-]?tokens|finish.*(?:length|max)/i },
  { kind: 'invalid-json', pattern: /不是合法\s*json|没有\s*json\s*对象|json\s*解析|invalid\s*json|json\s*object|无法解析.*json|模型输出.*json/i },
  { kind: 'no-answer', pattern: /没有返回最终答案|只输出了思维链|返回内容为空|空内容/i },
  { kind: 'image-too-large', pattern: /图片过大|图片.*(?:过大|太大)|base64.*4mb|截图.*(?:3mb|过大)/i },
  { kind: 'vision-unsupported', pattern: /不支持图片输入|不支持视觉|图片输入|vision/i },
  { kind: 'timeout', pattern: /请求超时|超时|timeout|timed\s*out/i },
  { kind: 'rate-limit', pattern: /http\s*429|rate\s*limit|限流|too\s*many\s*requests|请求过于频繁/i },
  { kind: 'server', pattern: /http\s*5\d\d|服务器错误|服务端|server\s*error|bad\s*gateway|service\s*unavailable|overloaded/i },
  { kind: 'bad-request', pattern: /http\s*400|http\s*404|http\s*422|bad\s*request|参数错误|请求参数/i },
  { kind: 'network', pattern: /网络请求失败|network|fetch\s*failed|econn|enotfound|eai_again|连接已断开|内核未连接|内核连接未建立/i },
  { kind: 'cancelled', pattern: /取消|cancel/i },
]

/**
 * 脱敏：错误信息里可能带厂商回显的 Key、Authorization、带 token 的 URL。
 * 这些只能出现在「技术详情」里，且必须先脱敏再展示——界面不泄露任何凭据。
 */
export function redactSensitiveText(input: unknown): string {
  const raw =
    typeof input === 'string'
      ? input
      : input instanceof Error
        ? input.message
        : input === null || input === undefined
          ? ''
          : String(input)
  const text = raw
    // OpenAI 风格 Key：sk-xxxx
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    // Authorization: Bearer xxx
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
    // apiKey / api_key / authorization / access_token / secret = value
    .replace(/((?:api[-_ ]?key|authorization|access[-_ ]?token|secret)\s*[:=]\s*["']?)([^\s,;"'&}]+)/gi, '$1***')
    // 环境变量赋值
    .replace(/\b(DEEPSEEK_API_KEY|OPENAI_API_KEY|DASHSCOPE_API_KEY)\s*=\s*["']?[^\s"']+/g, '$1=***')
    // URL 查询参数里的 key/token
    .replace(/([?&](?:key|token|api_key|api-key|access_token)=)[^&\s]+/gi, '$1***')
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length > 400 ? compact.slice(0, 400) + '…' : compact
}

/**
 * 把一次分析失败归类成用户可读的结构化错误。
 * - 取消优先：用户点过「取消生成」时，底层可能抛超时/AbortError，不能误报成故障；
 * - 匹配不到的错误按 unknown 处理，但默认认为可重试。
 */
export function classifyAiError(raw: unknown, options: { cancelled?: boolean } = {}): AiErrorInfo {
  const detail = redactSensitiveText(raw)
  let kind: AiErrorKind = 'unknown'
  if (options.cancelled) {
    kind = 'cancelled'
  } else {
    const haystack = detail || (typeof raw === 'string' ? raw : '')
    for (const rule of ERROR_RULES) {
      if (rule.pattern.test(haystack)) {
        kind = rule.kind
        break
      }
    }
  }
  return {
    kind,
    title: ERROR_TITLES[kind],
    hint: ERROR_HINTS[kind],
    detail,
    retryable: kind !== 'image-too-large' && kind !== 'vision-unsupported',
    actions: ERROR_ACTIONS[kind].map((action) => ({ ...action })),
  }
}

/* ------------------------------------------------------------------ */
/* 4. 建议结果：按风险 / 任务聚合与筛选                                 */
/* ------------------------------------------------------------------ */

export interface AiSuggestionLike {
  id?: string
  title?: string
  risk?: string
  taskId?: string
  estimatedBytes?: number
  confidence?: number
}

export interface SuggestionGroup {
  /** taskId，或 UNASSIGNED_TASK_KEY */
  key: string
  count: number
  bytes: number
  riskyCount: number
}

export interface SuggestionSummary {
  total: number
  bytes: number
  /** 有建议的任务数（含「未关联任务」分组） */
  taskCount: number
  riskCounts: Record<RiskLevel, number>
  riskBytes: Record<RiskLevel, number>
  riskyCount: number
  /** 置信度低于 60% 的条数（没给置信度的不计） */
  lowConfidenceCount: number
  /** 按预估可释放字节降序；未关联任务的排在最后 */
  byTask: SuggestionGroup[]
}

/** 风险值容错：未知风险按「谨慎」处理，绝不悄悄当成安全 */
export function normalizeSuggestionRisk(value: unknown): RiskLevel {
  return value === 'safe' || value === 'risky' || value === 'caution' ? value : 'caution'
}

export function summarizeSuggestions(items: readonly AiSuggestionLike[]): SuggestionSummary {
  const riskCounts: Record<RiskLevel, number> = { safe: 0, caution: 0, risky: 0 }
  const riskBytes: Record<RiskLevel, number> = { safe: 0, caution: 0, risky: 0 }
  const tasks = new Map<string, SuggestionGroup>()
  let bytes = 0
  let lowConfidenceCount = 0
  for (const item of items ?? []) {
    const risk = normalizeSuggestionRisk(item?.risk)
    const itemBytes = asNonNegativeNumber(item?.estimatedBytes)
    riskCounts[risk] += 1
    riskBytes[risk] += itemBytes
    bytes += itemBytes
    if (typeof item?.confidence === 'number' && Number.isFinite(item.confidence) && item.confidence < 0.6) {
      lowConfidenceCount += 1
    }
    const taskKey = asText(item?.taskId, 120) || UNASSIGNED_TASK_KEY
    const group = tasks.get(taskKey) ?? { key: taskKey, count: 0, bytes: 0, riskyCount: 0 }
    group.count += 1
    group.bytes += itemBytes
    if (risk === 'risky') group.riskyCount += 1
    tasks.set(taskKey, group)
  }
  const byTask = [...tasks.values()].sort((left, right) => {
    if (left.key === UNASSIGNED_TASK_KEY) return 1
    if (right.key === UNASSIGNED_TASK_KEY) return -1
    return right.bytes - left.bytes || right.count - left.count || left.key.localeCompare(right.key)
  })
  return {
    total: items?.length ?? 0,
    bytes,
    taskCount: byTask.length,
    riskCounts,
    riskBytes,
    riskyCount: riskCounts.risky,
    lowConfidenceCount,
    byTask,
  }
}

export type SuggestionRiskFilter = 'all' | RiskLevel

export interface SuggestionFilter {
  risk: SuggestionRiskFilter
  /** 'all' 表示不筛任务；UNASSIGNED_TASK_KEY 表示只看未关联任务的建议 */
  task: string
}

export function filterSuggestions<T extends AiSuggestionLike>(items: readonly T[], filter: SuggestionFilter): T[] {
  return (items ?? []).filter((item) => {
    if (filter.risk !== 'all' && normalizeSuggestionRisk(item?.risk) !== filter.risk) return false
    if (filter.task && filter.task !== 'all') {
      const taskKey = asText(item?.taskId, 120) || UNASSIGNED_TASK_KEY
      if (taskKey !== filter.task) return false
    }
    return true
  })
}

/* ------------------------------------------------------------------ */
/* 5. AI 推荐的清理项：行模型 / 批量选择 / 确认摘要                     */
/* ------------------------------------------------------------------ */

export interface AiSelectionEntryLike {
  itemId?: unknown
  reason?: unknown
}

export interface ScanItemLike {
  id?: unknown
  path?: unknown
  size?: unknown
  taskId?: unknown
  risk?: unknown
  protected?: unknown
}

export interface SelectionRow {
  id: string
  path: string
  size: number
  taskId: string
  reason: string
  risk: RiskLevel
  protected: boolean
  /** 已不在当前扫描结果里 */
  missing: boolean
  /** 可勾选：存在、未受保护、且大小 > 0 */
  selectable: boolean
}

/**
 * 把 AI 的 selection 与当前扫描结果做连接。
 *
 * 防御性设计：即使 AI（或伪造的结果）返回了受保护项 / 不存在的项，这里也标记为不可选，
 * 不会把扩大删除范围的入口交给模板层。
 */
export function buildSelectionRows(
  entries: readonly AiSelectionEntryLike[],
  items: readonly ScanItemLike[],
): SelectionRow[] {
  const byId = new Map<string, ScanItemLike>()
  for (const item of items ?? []) {
    const id = asText(item?.id, 200)
    if (id) byId.set(id, item)
  }
  const seen = new Set<string>()
  const rows: SelectionRow[] = []
  for (const entry of entries ?? []) {
    const id = asText(entry?.itemId, 200)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const item = byId.get(id)
    const missing = !item
    const protectedItem = item?.protected === true
    const size = asNonNegativeNumber(item?.size)
    rows.push({
      id,
      path: asText(item?.path, 400) || '(不在当前扫描结果中，已失效)',
      size,
      taskId: asText(item?.taskId, 120),
      reason: asText(entry?.reason, 160),
      risk: normalizeSuggestionRisk(item?.risk),
      protected: protectedItem,
      missing,
      selectable: !missing && !protectedItem && size > 0,
    })
  }
  return rows
}

export function selectableSelectionIds(rows: readonly SelectionRow[]): string[] {
  return (rows ?? []).filter((row) => row.selectable).map((row) => row.id)
}

/** 勾选 / 取消勾选一项（返回新数组，方便直接赋给 ref） */
export function toggleSelectionIds(current: readonly string[], id: string, checked: boolean): string[] {
  const next = new Set(current ?? [])
  if (checked) next.add(id)
  else next.delete(id)
  return [...next]
}

export interface SelectionPlan {
  /** 真正会被提交清理的 id（已剔除失效/受保护/未勾选） */
  selectedIds: string[]
  selectedCount: number
  selectedBytes: number
  /** 仍可用但没有勾选的项 */
  unselectedAvailableCount: number
  missingCount: number
  protectedCount: number
  riskCounts: Record<RiskLevel, number>
  byTask: SuggestionGroup[]
  /** 对话框/提示直接可用的一句话摘要 */
  summary: string
}

export function buildSelectionPlan(rows: readonly SelectionRow[], selectedIds: readonly string[]): SelectionPlan {
  const wanted = new Set(selectedIds ?? [])
  const selected = (rows ?? []).filter((row) => row.selectable && wanted.has(row.id))
  const riskCounts: Record<RiskLevel, number> = { safe: 0, caution: 0, risky: 0 }
  const tasks = new Map<string, SuggestionGroup>()
  for (const row of selected) {
    riskCounts[row.risk] += 1
    const taskKey = row.taskId || UNASSIGNED_TASK_KEY
    const group = tasks.get(taskKey) ?? { key: taskKey, count: 0, bytes: 0, riskyCount: 0 }
    group.count += 1
    group.bytes += row.size
    if (row.risk === 'risky') group.riskyCount += 1
    tasks.set(taskKey, group)
  }
  const plan: SelectionPlan = {
    selectedIds: selected.map((row) => row.id),
    selectedCount: selected.length,
    selectedBytes: selected.reduce((sum, row) => sum + row.size, 0),
    unselectedAvailableCount: (rows ?? []).filter((row) => row.selectable && !wanted.has(row.id)).length,
    missingCount: (rows ?? []).filter((row) => row.missing).length,
    protectedCount: (rows ?? []).filter((row) => row.protected).length,
    riskCounts,
    byTask: [...tasks.values()].sort((left, right) => right.bytes - left.bytes || right.count - left.count),
    summary: '',
  }
  plan.summary = selectionConfirmSummary(plan)
  return plan
}

/** 应用前的确认摘要：数量/体积、未勾选、风险、失效与受保护项都要说清楚 */
export function selectionConfirmSummary(plan: Omit<SelectionPlan, 'summary'> | SelectionPlan): string {
  if (!plan.selectedCount) {
    if (plan.missingCount || plan.protectedCount) {
      return '当前没有可清理的选中项：推荐项可能已失效或被路径策略保护，请重新扫描后再试。'
    }
    return '尚未勾选任何清理项。'
  }
  const parts = [`已选 ${plan.selectedCount} 项，合计 ${formatBytesText(plan.selectedBytes)}`]
  if (plan.unselectedAvailableCount) parts.push(`另有 ${plan.unselectedAvailableCount} 项未勾选，不会被清理`)
  if (plan.riskCounts.risky) parts.push(`其中 ${plan.riskCounts.risky} 项为高风险（仍会走隔离区/回收站）`)
  if (plan.missingCount) parts.push(`${plan.missingCount} 项已不在当前扫描结果中，不会处理`)
  if (plan.protectedCount) parts.push(`${plan.protectedCount} 项受保护，已自动跳过`)
  return parts.join('；') + '。'
}

/* ------------------------------------------------------------------ */
/* 6. 扫描根建议：宽目录 / 盘符根 / 已在范围                            */
/* ------------------------------------------------------------------ */

export type RootSuggestionLevel = 'recommended' | 'broad' | 'drive-root' | 'configured'

export interface RootClassification {
  level: RootSuggestionLevel
  broad: boolean
  driveRoot: boolean
  configured: boolean
  selectable: boolean
  defaultSelected: boolean
  hint: string
}

export interface RootSuggestionLike {
  path?: unknown
  reason?: unknown
  sizeBytes?: unknown
}

export interface RootSuggestionInfo {
  path: string
  reason: string
  sizeBytes: number
  level: RootSuggestionLevel
  selectable: boolean
  defaultSelected: boolean
  hint: string
}

export interface RootSuggestionSummary {
  total: number
  recommendedCount: number
  broadCount: number
  driveRootCount: number
  configuredCount: number
  selectableCount: number
  /** 默认勾选的路径（只含推荐目录，盘符根/宽目录/已在范围内永不默认勾选） */
  defaultSelectedPaths: string[]
}

export interface RootSuggestionPlan {
  items: RootSuggestionInfo[]
  summary: RootSuggestionSummary
}

/** 宽目录名单：与旧界面判定保持一致（只用于提示 + 默认不勾选，不阻止用户手动选择） */
const BROAD_ROOT_NAMES = new Set([
  'appdata',
  'desktop',
  'documents',
  'downloads',
  'onedrive',
  'music',
  'pictures',
  'videos',
  'windows',
  'programdata',
  'program files',
  'program files (x86)',
])

/** 路径归一化：统一反斜杠、去掉末尾分隔符、盘符根归一成 `C:`；保留 UNC 前缀 */
export function normalizeRootPath(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return ''
  const unc = raw.startsWith('\\\\')
  let text = raw.replace(/\//g, '\\')
  if (unc) {
    text = '\\\\' + text.slice(2).replace(/\\{2,}/g, '\\')
  } else {
    text = text.replace(/\\{2,}/g, '\\')
  }
  const driveRoot = /^([a-zA-Z]):\\*$/.exec(text)
  if (driveRoot) return `${driveRoot[1].toUpperCase()}:`
  text = text.replace(/\\+$/, '')
  return text
}

/** 盘符根（C: / C:\）永远不允许写入分析范围 */
export function isDriveRoot(value: string): boolean {
  return /^[a-zA-Z]:$/.test(normalizeRootPath(value))
}

/** 宽目录（AppData/Desktop/Downloads/Windows 等）只提示范围较大，默认不勾选 */
export function isBroadRoot(value: string): boolean {
  const normalized = normalizeRootPath(value).toLowerCase()
  if (!normalized) return true
  const last = normalized.split('\\').filter(Boolean).pop() ?? ''
  if (BROAD_ROOT_NAMES.has(last)) return true
  return last.startsWith('onedrive')
}

export function classifyRootSuggestion(path: unknown, configuredRoots: readonly unknown[] = []): RootClassification {
  const normalized = normalizeRootPath(path)
  const lower = normalized.toLowerCase()
  const configured = (configuredRoots ?? []).some((root) => normalizeRootPath(root).toLowerCase() === lower)
  const driveRoot = isDriveRoot(lower)
  const broad = !driveRoot && isBroadRoot(lower)
  let level: RootSuggestionLevel = 'recommended'
  if (driveRoot) level = 'drive-root'
  else if (configured) level = 'configured'
  else if (broad) level = 'broad'
  const selectable = Boolean(normalized) && !driveRoot && !configured
  const defaultSelected = level === 'recommended'
  let hint = '用户目录下的一级目录，按需勾选后才会加入分析范围'
  if (level === 'drive-root') hint = '盘符根会扩大清理辖区到整个磁盘，不允许加入分析范围'
  else if (level === 'configured') hint = '已在当前分析范围内，不会重复添加'
  else if (level === 'broad') hint = '范围较大（整个用户目录/系统目录），默认不勾选；确认确实需要再手动选择'
  return { level, broad, driveRoot, configured, selectable, defaultSelected, hint }
}

/**
 * 生成扫描根建议计划：去重、归类、算默认勾选。
 * 安全默认：只有「推荐目录」默认勾选；宽目录默认不勾，盘符根不可勾。
 */
export function buildRootSuggestionPlan(
  items: readonly RootSuggestionLike[],
  configuredRoots: readonly unknown[] = [],
): RootSuggestionPlan {
  const seen = new Set<string>()
  const planItems: RootSuggestionInfo[] = []
  for (const raw of items ?? []) {
    const path = normalizeRootPath(raw?.path)
    if (!path) continue
    const key = path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const classification = classifyRootSuggestion(path, configuredRoots)
    planItems.push({
      path,
      reason: asText(raw?.reason, 160),
      sizeBytes: asNonNegativeNumber(raw?.sizeBytes),
      ...classification,
    })
  }
  const summary: RootSuggestionSummary = {
    total: planItems.length,
    recommendedCount: planItems.filter((item) => item.level === 'recommended').length,
    broadCount: planItems.filter((item) => item.level === 'broad').length,
    driveRootCount: planItems.filter((item) => item.level === 'drive-root').length,
    configuredCount: planItems.filter((item) => item.level === 'configured').length,
    selectableCount: planItems.filter((item) => item.selectable).length,
    defaultSelectedPaths: planItems.filter((item) => item.defaultSelected).map((item) => item.path),
  }
  return { items: planItems, summary }
}

/** 真正要写入设置的目标：只接受可选项、去重，盘符根/已在范围内一律剔除 */
export function selectedRootTargets(
  items: readonly RootSuggestionInfo[],
  selectedPaths: readonly unknown[],
): RootSuggestionInfo[] {
  const wanted = new Set((selectedPaths ?? []).map((path) => normalizeRootPath(path).toLowerCase()))
  const seen = new Set<string>()
  const targets: RootSuggestionInfo[] = []
  for (const item of items ?? []) {
    const key = item.path.toLowerCase()
    if (!item.selectable || !wanted.has(key) || seen.has(key)) continue
    seen.add(key)
    targets.push(item)
  }
  return targets
}

/* ------------------------------------------------------------------ */
/* 7. 页面阶段与流式活动                                               */
/* ------------------------------------------------------------------ */

export type AiViewPhase = 'plugin-disabled' | 'needs-setup' | 'idle' | 'analyzing' | 'failed' | 'ready'

export interface AiViewPhaseInput {
  available: boolean
  configured: boolean
  onlineAi: boolean
  busy: boolean
  hasAnalysis: boolean
  hasError: boolean
}

/**
 * 页面阶段（决定空状态 / 加载 / 错误 / 结果）：
 * - 有旧分析结果时始终展示结果，错误只做页内提示（不白屏）；
 * - 分析中优先展示进度卡片；
 * - 没有结果时区分「需要先配置」「失败」「还没开始」。
 */
export function aiViewPhase(input: AiViewPhaseInput): AiViewPhase {
  if (!input.available) return 'plugin-disabled'
  if (input.busy) return 'analyzing'
  if (input.hasAnalysis) return 'ready'
  if (!input.onlineAi || !input.configured) return 'needs-setup'
  if (input.hasError) return 'failed'
  return 'idle'
}

export interface StreamActivityInput {
  textChars: number
  reasoningChars?: number
  elapsedSeconds?: number
}

/** 分析进行中的一行状态文案：已接收字符 / 思维链字符 / 已用时 */
export function describeStreamActivity(input: StreamActivityInput): string {
  const chars = asNonNegativeNumber(input.textChars)
  const reasoning = asNonNegativeNumber(input.reasoningChars ?? 0)
  const seconds = Math.floor(asNonNegativeNumber(input.elapsedSeconds ?? 0))
  const parts = [`已接收 ${chars} 字符`]
  if (reasoning > 0) parts.push(`思维链 ${reasoning} 字符`)
  if (seconds > 0) parts.push(`已用时 ${formatDurationText(seconds)}`)
  return parts.join(' · ')
}
