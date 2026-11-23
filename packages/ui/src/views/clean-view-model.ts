/**
 * 清理页展示模型（纯函数，可单测）。
 *
 * 解决「用户没有固定使用顺序」造成的上下文丢失：
 * - 同一份扫描结果下，离开页面再回来要恢复筛选与选择；
 * - 换了新扫描结果则重新应用推荐策略（不能把旧结果的选中项套到新结果上）；
 * - 空结果要区分「真的没有可清理项」「被筛选藏掉了」「只有受保护项」。
 */

export type CleanViewMode = 'groups' | 'items' | 'protected'
export type CleanRiskFilter = 'all' | 'safe' | 'caution' | 'risky'
export type CleanSizeFilter = 'all' | '1mb' | '10mb' | '100mb'

export const CLEAN_VIEW_MODES: readonly CleanViewMode[] = ['groups', 'items', 'protected']
export const CLEAN_RISK_FILTERS: readonly CleanRiskFilter[] = ['all', 'safe', 'caution', 'risky']
export const CLEAN_SIZE_FILTERS: readonly CleanSizeFilter[] = ['all', '1mb', '10mb', '100mb']

export interface CleanFilters {
  search: string
  risk: CleanRiskFilter
  size: CleanSizeFilter
  task: string
  onlyRecommended: boolean
}

export const DEFAULT_CLEAN_FILTERS: CleanFilters = {
  search: '',
  risk: 'all',
  size: 'all',
  task: 'all',
  onlyRecommended: false,
}

export interface CleanSession {
  scanId: string
  savedAt: number
  filters: CleanFilters
  selectedIds: string[]
  /** 推荐策略快照：恢复时一并恢复，避免「选择了推荐项但策略显示不同步」 */
  recommend: { minSize: number; includeCaution: boolean }
}

/** 最多持久化多少条选中 id（防止极端大结果集把 localStorage 写爆） */
export const MAX_PERSISTED_SELECTION = 20_000

/** 容错解析筛选：非法值回默认，搜索词限长，避免坏数据把界面卡住 */
export function sanitizeFilters(input: unknown): CleanFilters {
  const raw = (input ?? {}) as Record<string, unknown>
  const risk = CLEAN_RISK_FILTERS.includes(raw.risk as CleanRiskFilter) ? (raw.risk as CleanRiskFilter) : 'all'
  const size = CLEAN_SIZE_FILTERS.includes(raw.size as CleanSizeFilter) ? (raw.size as CleanSizeFilter) : 'all'
  const task = typeof raw.task === 'string' && raw.task.trim() ? raw.task.trim().slice(0, 120) : 'all'
  const search = typeof raw.search === 'string' ? raw.search.slice(0, 200) : ''
  return { search, risk, size, task, onlyRecommended: raw.onlyRecommended === true }
}

/** 容错解析一次页面会话：结构不全/类型不对直接丢弃（返回 undefined） */
export function parseCleanSession(rawText: string | null | undefined): CleanSession | undefined {
  if (!rawText) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object') return undefined
  const raw = parsed as Record<string, unknown>
  if (typeof raw.scanId !== 'string' || !raw.scanId) return undefined
  const selectedIds = Array.isArray(raw.selectedIds)
    ? raw.selectedIds.filter((id): id is string => typeof id === 'string').slice(0, MAX_PERSISTED_SELECTION)
    : []
  const recommendRaw = (raw.recommend ?? {}) as Record<string, unknown>
  const minSize = typeof recommendRaw.minSize === 'number' && Number.isFinite(recommendRaw.minSize) ? Math.max(0, recommendRaw.minSize) : 0
  return {
    scanId: raw.scanId,
    savedAt: typeof raw.savedAt === 'number' && Number.isFinite(raw.savedAt) ? raw.savedAt : 0,
    filters: sanitizeFilters(raw.filters),
    selectedIds,
    recommend: { minSize, includeCaution: recommendRaw.includeCaution === true },
  }
}

/**
 * 是否恢复上一次会话：
 * - 同一 scanId 才恢复（不同结果集的选择没有意义）；
 * - 超过 24 小时视为过期，避免展示很久以前的选中态。
 */
export function shouldRestoreSession(session: CleanSession | undefined, scanId: string | undefined, now: number): boolean {
  if (!session || !scanId || session.scanId !== scanId) return false
  const maxAge = 24 * 60 * 60 * 1000
  return now - session.savedAt <= maxAge
}

/** 只保留确实还存在于当前结果里、且非受保护的选中 id（结果可能被截断/去重） */
export function restoreSelection(session: CleanSession, validIds: ReadonlySet<string>, protectedIds: ReadonlySet<string>): string[] {
  return session.selectedIds.filter((id) => validIds.has(id) && !protectedIds.has(id))
}

export interface EmptyResultInput {
  hasScan: boolean
  scanning: boolean
  cleanableCount: number
  protectedCount: number
  filteredCount: number
  filtersActive: boolean
}

export type EmptyResultKind = 'none' | 'protected-only' | 'filtered' | 'scanning'

/**
 * 空状态分类：
 * - scanning：扫描还没结束，不提示「没有结果」；
 * - none：真的没有可清理项（连受保护项也没有）；
 * - protected-only：只有受保护项，引导去「受保护」视图看原因；
 * - filtered：有可清理项，但被当前筛选藏掉了。
 * 其它情况返回 undefined（不需要空状态卡片）。
 */
export function emptyResultKind(input: EmptyResultInput): EmptyResultKind | undefined {
  if (input.scanning) return 'scanning'
  if (!input.hasScan) return undefined
  if (input.cleanableCount === 0) return input.protectedCount > 0 ? 'protected-only' : 'none'
  if (input.filteredCount === 0 && input.filtersActive) return 'filtered'
  return undefined
}

/** 结果概要一句话（结果头部/横幅复用，避免模板里拼字符串） */
export function resultSummary(input: { cleanableCount: number; cleanableBytes: number; taskCount: number; recommendedCount: number; recommendedBytes: number }): string {
  if (!input.cleanableCount) return '本次扫描没有可自动清理的内容'
  return `可清理 ${input.cleanableCount.toLocaleString('zh-CN')} 项（${formatBytesText(input.cleanableBytes)}）· ${input.taskCount} 个任务 · 推荐 ${input.recommendedCount} 项（${formatBytesText(input.recommendedBytes)}）`
}

function formatBytesText(bytes: number): string {
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
