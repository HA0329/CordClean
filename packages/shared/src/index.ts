import type { RuleTarget } from './rules.ts'
/**
 * @cordclean/shared —— 与宿主环境无关的公共契约层。
 *
 * 本包只包含「类型」与「纯函数」，不得依赖 node 内置模块或 DOM，
 * 因此 Cordis 内核插件、Electron 主进程、Web 服务端与浏览器前端
 * 可以共享同一份类型定义与工具函数（这是本课题「内核与界面解耦」的基础）。
 */

/** 清理风险等级：safe 可放心清理，caution 需确认，risky 高风险需显式授权 */
export type RiskLevel = 'safe' | 'caution' | 'risky'

/** 功能分类，用于界面分组与配色 */
export type CategoryId =
  | 'system'
  | 'browser'
  | 'privacy'
  | 'disk'
  | 'apps'
  | 'startup'
  | 'dev'
  | 'ai'

/** 清理项的类型 */
export type ItemKind = 'file' | 'directory' | 'registry' | 'command' | 'entry'

/** 分类元信息（前端展示用） */
export interface CategoryMeta {
  id: CategoryId
  name: string
  color: string
}

export const CATEGORIES: Record<CategoryId, CategoryMeta> = {
  system: { id: 'system', name: '系统垃圾', color: '#4f8cff' },
  browser: { id: 'browser', name: '浏览器', color: '#29c196' },
  privacy: { id: 'privacy', name: '隐私痕迹', color: '#a06bff' },
  disk: { id: 'disk', name: '磁盘空间', color: '#ff9f43' },
  apps: { id: 'apps', name: '应用残留', color: '#f06b8b' },
  startup: { id: 'startup', name: '启动项', color: '#f5c542' },
  dev: { id: 'dev', name: '开发缓存', color: '#3dd6d0' },
  ai: { id: 'ai', name: 'AI 建议', color: '#6c7cff' },
}

/** 风险等级展示元信息 */
export const RISK_META: Record<RiskLevel, { name: string; color: string; weight: number }> = {
  safe: { name: '安全', color: '#29c196', weight: 0 },
  caution: { name: '谨慎', color: '#ff9f43', weight: 1 },
  risky: { name: '高风险', color: '#f0506e', weight: 2 },
}

/**
 * 扫描到的单个可清理项。
 *
 * `id` 由引擎根据 `taskId + path` 生成并保证全局唯一；
 * `protected` 由路径策略服务标记，受保护的项永远不允许被删除。
 */
export interface CleanItem {
  id: string
  taskId: string
  /** 展示标题，默认取 path 的末段 */
  title: string
  /** 绝对路径 / 注册表键 / 命令标识 */
  path: string
  kind: ItemKind
  /** 字节数，未知为 0 */
  size: number
  /** 扫描时的修改时间（毫秒），用于预览一致性比对 */
  mtimeMs?: number
  risk: RiskLevel
  category: CategoryId
  /** 默认是否被勾选 */
  defaultSelected: boolean
  /** 是否被路径策略保护（保护项不可清理） */
  protected?: boolean
  /** 插件附加的元数据（如文件修改时间、分组标签） */
  meta?: Record<string, unknown>
  /** 面向用户的一句话说明 */
  note?: string
}

/** 插件在扫描过程中上报的「清理项草稿」，由引擎补全 id/risk/category 等字段 */
export interface CleanItemDraft {
  path: string
  /** 扫描时的 mtime（毫秒），用于执行前预览一致性比对 */
  mtimeMs?: number
  title?: string
  kind?: ItemKind
  size?: number
  risk?: RiskLevel
  defaultSelected?: boolean
  meta?: Record<string, unknown>
  note?: string
}

/** 扫描过程中收集到的错误（权限不足、文件被占用等） */
export interface ScanError {
  path: string
  message: string
  /** 错误码，如 EPERM / EBUSY */
  code?: string
}

/** 单个任务的扫描结果 */
export interface TaskScanResult {
  taskId: string
  status: 'ok' | 'error' | 'skipped' | 'cancelled'
  items: number
  bytes: number
  elapsedMs: number
  error?: string
}

/** 一次扫描的汇总报告 */
export interface ScanReport {
  scanId: string
  startedAt: number
  elapsedMs: number
  items: CleanItem[]
  stats: {
    files: number
    dirs: number
    bytes: number
    errors: number
    /** 因超过上限被截断（如超大文件夹） */
    truncated: boolean
  }
  errors: ScanError[]
  tasks: TaskScanResult[]
  cancelled: boolean
}

/** 单个清理项的清理结果 */
export interface CleanItemResult {
  itemId: string
  path: string
  ok: boolean
  /** 实际释放的字节数 */
  bytes: number
  /** 是否放入隔离区 */
  quarantined?: boolean
  error?: string
}

/** 一次清理动作的汇总报告 */
export type CleanMode = 'recycle' | 'quarantine' | 'delete'

export interface CleanReport {
  sessionId: string
  /** 本次清理采用的删除方式（回收站 / 隔离区 / 永久删除） */
  mode: CleanMode
  taskIds: string[]
  dryRun: boolean
  startedAt: number
  elapsedMs: number
  freedBytes: number
  /** 进入回收站的字节数（不释放空间，需清空回收站） */
  recycledBytes: number
  /** 进入隔离区的字节数（可恢复） */
  quarantinedBytes: number
  cleaned: number
  quarantined: number
  /** 扫描后被外部删除、未计入任何统计的项 */
  vanished: number
  /** 因条件不满足/预览不一致被跳过的项 */
  skipped: number
  failed: number
  cancelled: boolean
  perTask: Array<{ taskId: string; cleaned: number; bytes: number; failed: number }>
  failures: Array<{ itemId: string; path: string; message: string }>
  /** 可回滚清单（仅成功项；用于「撤销上次清理」） */
  undo?: Array<{ path: string; mode: string; action?: string }>
}

/** 隔离区记录（可恢复） */
export interface QuarantineRecord {
  id: string
  sessionId: string
  taskId: string
  /** 原始绝对路径 */
  originalPath: string
  /** 隔离区中的文件名 */
  storedName: string
  bytes: number
  createdAt: number
  restoredAt?: number
}

/** 历史记录条目（用于「清理历史」「累计释放空间」统计） */
export interface HistoryEntry {
  sessionId: string
  startedAt: number
  elapsedMs: number
  taskIds: string[]
  freedBytes: number
  /** 进入回收站的字节数（不释放空间，需清空回收站） */
  recycledBytes: number
  /** 进入隔离区的字节数（可恢复） */
  quarantinedBytes: number
  cleaned: number
  quarantined: number
  /** 扫描后被外部删除、未计入任何统计的项 */
  vanished: number
  /** 因条件不满足/预览不一致被跳过的项 */
  skipped: number
  failed: number
  dryRun: boolean
}

/** 插件在用户界面中的静态描述 */
export interface PluginInfo {
  id: string
  name: string
  description: string
  category: CategoryId
  /** 内置插件 / 来自外部目录的第三方插件 */
  source: 'builtin' | 'external'
  /** 插件版本 */
  version: string
  /** 插件对外提供的清理任务数 */
  taskCount: number
  /** 运行时状态 */
  status: 'active' | 'stopped' | 'error' | 'loading'
  error?: string
  /** 是否启用 */
  enabled: boolean
  /** 该插件声明的清理任务列表 */
  tasks: Array<{ id: string; name: string; risk: RiskLevel; description?: string }>
}

/** 磁盘信息 */
export interface DiskInfo {
  /** 如 C: */
  mount: string
  label?: string
  filesystem?: string
  total: number
  free: number
  used: number
}

/** 系统概览信息（供概览页与 AI 插件分析使用） */
export interface SystemInfo {
  platform: string
  release: string
  arch: string
  hostname: string
  cpuModel: string
  cpuCores: number
  memoryTotal: number
  memoryFree: number
  uptimeSeconds: number
  nodeVersion: string
  /** 当前进程是否具备管理员权限 */
  elevated: boolean
  username: string
  disks: DiskInfo[]
  /** 关键目录占用（用户目录 / 临时目录等） */
  hotspots: Array<{ label: string; path: string; bytes: number }>
  collectedAt: number
}

/** 轻量系统采样（概览自动刷新用，避免每次都枚举磁盘） */
export interface SystemLiveInfo {
  memoryTotal: number
  memoryFree: number
  uptimeSeconds: number
  collectedAt: number
}

/** AI 插件产出的一条建议 */
export interface AiSuggestion {
  id: string
  title: string
  /** 面向用户的推理说明 */
  reason: string
  /** 关联的清理任务（可选） */
  taskId?: string
  /** 建议清理的目标路径/分类 */
  targets: string[]
  /** 预估可释放空间（字节，模型估算，可能为 0） */
  estimatedBytes: number
  /** 置信度 0-1 */
  confidence: number
  /** 风险提示 */
  risk: RiskLevel
}

/** AI 分析结果 */
export interface AiRuleSuggestion {
  name: string
  category: string
  categoryLabel?: string
  risk: RiskLevel
  target: RuleTarget
  reason?: string
}

export interface AiAnalysis {
  model: string
  createdAt: number
  summary: string
  suggestions: AiSuggestion[]
  /** AI 提出的新清理规则（必须经入库管线与用户确认） */
  ruleSuggestions?: AiRuleSuggestion[]
  /** AI 从本次扫描结果中挑选的清理项（只能来自候选列表） */
  selection?: Array<{ itemId: string; reason: string }>
  /** AI 建议新增的扫描根（必须经用户确认才写入设置） */
  rootSuggestions?: Array<{ path: string; reason: string; sizeBytes: number }>
  /** 选中项的合计大小 */
  selectionSummary?: { count: number; bytes: number }
  /** 模型附带的其他观察 */
  observations: string[]
  /** 思维链（若模型返回 reasoning_content / thinking_block） */
  reasoning?: string
  /** token 用量（若接口返回） */
  usage?: AiUsage
  /** 端到端耗时（毫秒） */
  latencyMs?: number
  /** 实际使用的接口形态：chat / messages / responses */
  shape?: string
}

/** 模型能力信息（来自 /models 接口或内置兜底列表） */
export interface AiModelInfo {
  id: string
  name?: string
  description?: string
  contextWindow?: number
  maxOutputTokens?: number
  inputModalities?: string[]
  /** 支持的推理等级：low / high / max */
  effortLevels?: string[]
  defaultEffort?: string
}

/** token 用量（统一三种接口形态） */
export interface AiUsage {
  inputTokens: number
  outputTokens: number
  /** 其中思维链消耗的 token */
  reasoningTokens: number
  totalTokens?: number
}

/** 一次连通性探测的结果 */
export interface AiProbeResult {
  ok: boolean
  latencyMs: number
  model: string
  shape: string
  /** HTTP 状态码（网络失败时为 0） */
  status: number
  /** 模型返回的文本（截断） */
  text: string
  usage?: AiUsage
  error?: string
}

/** AI 插件运行时状态（供界面展示与配置） */
export interface AiRuntimeStatus {
  /** 可用的上下文采集器（界面渲染开关） */
  contextAvailable?: Array<{ id: string; name: string; description?: string; defaultEnabled: boolean }>
  /** 本次分析实际使用的采集器 */
  contextUsed?: string[]
  contextWindow?: number
  maxOutputTokens?: number
  available: boolean
  configured: boolean
  /** 接口形态：chat / messages / responses */
  shape: string
  baseUrl: string
  model: string
  /** 推理等级：auto / off / low / medium / high / max */
  effort: string
  /** JSON 输出模式：auto / on / off */
  jsonMode: string
  /** 已拉取到的模型列表（可能为空，界面可主动刷新） */
  models: AiModelInfo[]
  lastProbe?: AiProbeResult
}

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/** 字节数格式化：1536 → "1.5 KB" */
export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  const fixed = unit === 0 ? String(Math.round(value)) : value.toFixed(digits)
  return `${Number(fixed)} ${UNITS[unit]}`
}

/** 毫秒格式化：1234 → "1.2 s" */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0 ms'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes} m ${seconds} s`
}

/** 时间戳格式化：2025-01-01 12:00 */
export function formatTime(timestamp: number): string {
  const d = new Date(timestamp)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 取路径末段作为标题（同时兼容 Windows 反斜杠） */
export function basename(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  const index = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'))
  return index >= 0 ? normalized.slice(index + 1) : normalized
}

/**
 * FNV-1a 32 位哈希，作为清理项 id 的生成器。
 * 纯 JS 实现，保证在浏览器与 Node 下结果一致（不使用 node:crypto）。
 */
export function hashString(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 生成清理项 id */
export function itemId(taskId: string, path: string): string {
  return `${taskId}:${hashString(path)}`
}

/** 风险等级比较，用于取一组项中的最高风险 */
export function maxRisk(risks: RiskLevel[]): RiskLevel {
  let result: RiskLevel = 'safe'
  for (const risk of risks) {
    if (RISK_META[risk].weight > RISK_META[result].weight) result = risk
  }
  return result
}

/** 空扫描报告 */
export function emptyReport(scanId: string): ScanReport {
  return {
    scanId,
    startedAt: Date.now(),
    elapsedMs: 0,
    items: [],
    stats: { files: 0, dirs: 0, bytes: 0, errors: 0, truncated: false },
    errors: [],
    tasks: [],
    cancelled: false,
  }
}

/* 任务契约 / 规则契约 / 服务契约 / RPC 协议 */
export * from './rules.ts'
export * from './plugin-code.ts'
export * from './plugin-manifest.ts'
export * from './plugin-api.ts'
export type * from './task.ts'
export * from './services.ts'
export * from './rpc.ts'
export * from './selection.ts'
