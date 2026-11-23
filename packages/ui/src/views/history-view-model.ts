/**
 * 历史与隔离区页展示模型（纯函数，可单测）。
 *
 * 这页同时承载「只读的历史记录」和「可破坏的隔离区操作」，最容易出问题的是：
 * - 历史条目来自可被中断/损坏的 JSONL 文件，字段可能缺失或时间无效；
 * - 隔离区记录可能已过期、被手动删除、原路径已不在允许清理范围，恢复会部分失败；
 * - 危险操作（彻底删除）与可逆操作（恢复）必须给出不同的确认文案与结果反馈；
 * - 历史与隔离区通过 sessionId 关联，「本次清理写入隔离区的项在哪里恢复」要能直达。
 *
 * 这里把规范化、筛选排序、摘要、确认文案、禁用原因、结果文案全部抽成纯函数，
 * 页面只负责渲染和调用 store 既有 API（不在这里发请求、不碰 DOM）。
 */
import { formatBytes } from '@cordclean/shared'

/* ------------------------------------------------------------------ */
/* 通用                                                                */
/* ------------------------------------------------------------------ */

/** 操作可用性：ok=false 时 reason 直接用于按钮 tooltip / 点击提示 */
export interface ActionGate {
  ok: boolean
  reason?: string
}

/** 非负数值容错：非法/负数统一回 0；integer=true 时取整（字节/条数/耗时） */
function nonNegative(value: unknown, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return integer ? Math.round(value) : value
}

/** 字符串容错：非字符串回 ''，去空白并限长，避免坏数据把界面撑坏 */
function textOf(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, maxLength)
}

/** 字符串数组容错：剔除空值/非字符串并去重（保留首次出现顺序） */
function stringListOf(value: unknown, maxLength: number): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const text = textOf(item, 120)
    if (!text || seen.has(text)) continue
    seen.add(text)
    result.push(text)
    if (result.length >= maxLength) break
  }
  return result
}

/** 确定性的字符串比较（不依赖 locale，保证排序结果稳定可测） */
function compareText(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/* ------------------------------------------------------------------ */
/* 历史记录：规范化                                                     */
/* ------------------------------------------------------------------ */

export interface HistoryRow {
  sessionId: string
  /** 无效时间统一为 0，通过 startedAtValid 区分「0」与「时间无效」 */
  startedAt: number
  startedAtValid: boolean
  elapsedMs: number
  taskIds: string[]
  freedBytes: number
  recycledBytes: number
  quarantinedBytes: number
  cleaned: number
  quarantined: number
  vanished: number
  skipped: number
  failed: number
  dryRun: boolean
}

/** 规范化单条历史：结构完整可辨认才保留，字段缺失回安全默认值 */
export function normalizeHistoryRow(raw: unknown): HistoryRow | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const sessionId = textOf(value.sessionId, 120)
  const startedAt =
    typeof value.startedAt === 'number' && Number.isFinite(value.startedAt) && value.startedAt > 0
      ? value.startedAt
      : 0
  // 既没有会话 id 也没有可用时间的记录无法定位，直接丢弃（例如损坏行残留）
  if (!sessionId && !startedAt) return undefined
  return {
    sessionId,
    startedAt,
    startedAtValid: startedAt > 0,
    elapsedMs: nonNegative(value.elapsedMs, true),
    taskIds: stringListOf(value.taskIds, 64),
    freedBytes: nonNegative(value.freedBytes, true),
    recycledBytes: nonNegative(value.recycledBytes, true),
    quarantinedBytes: nonNegative(value.quarantinedBytes, true),
    cleaned: nonNegative(value.cleaned, true),
    quarantined: nonNegative(value.quarantined, true),
    vanished: nonNegative(value.vanished, true),
    skipped: nonNegative(value.skipped, true),
    failed: nonNegative(value.failed, true),
    dryRun: value.dryRun === true,
  }
}

/** 规范化历史列表：丢弃不可辨认项，不改变原有顺序（宿主已按时间倒序返回） */
export function normalizeHistoryEntries(raw: readonly unknown[]): HistoryRow[] {
  const rows: HistoryRow[] = []
  for (const item of raw) {
    const row = normalizeHistoryRow(item)
    if (row) rows.push(row)
  }
  return rows
}

/* ------------------------------------------------------------------ */
/* 历史记录：筛选 / 排序 / 摘要                                          */
/* ------------------------------------------------------------------ */

export const HISTORY_RANGE_OPTIONS = [
  { value: 'all', label: '全部时间' },
  { value: 'today', label: '今天' },
  { value: '7d', label: '最近 7 天' },
  { value: '30d', label: '最近 30 天' },
] as const
export type HistoryRange = (typeof HISTORY_RANGE_OPTIONS)[number]['value']

export const HISTORY_OUTCOME_OPTIONS = [
  { value: 'all', label: '全部结果' },
  { value: 'failed', label: '仅有失败' },
  { value: 'quarantined', label: '写入隔离区' },
  { value: 'recycled', label: '进入回收站' },
  { value: 'dry-run', label: '仅预演' },
] as const
export type HistoryOutcome = (typeof HISTORY_OUTCOME_OPTIONS)[number]['value']

export const HISTORY_SORT_OPTIONS = [
  { value: 'time', label: '按时间' },
  { value: 'freed', label: '按释放量' },
  { value: 'failed', label: '按失败数' },
] as const
export type HistorySortKey = (typeof HISTORY_SORT_OPTIONS)[number]['value']
export type HistorySortDir = 'desc' | 'asc'

export interface HistoryFilters {
  query: string
  /** 'all' 或具体任务 id */
  taskId: string
  range: HistoryRange
  outcome: HistoryOutcome
}

export const DEFAULT_HISTORY_FILTERS: HistoryFilters = {
  query: '',
  taskId: 'all',
  range: 'all',
  outcome: 'all',
}

export interface HistorySort {
  key: HistorySortKey
  dir: HistorySortDir
}

export const DEFAULT_HISTORY_SORT: HistorySort = { key: 'time', dir: 'desc' }

/** 是否设置了任何有效筛选（用于「重置筛选」与空状态分型） */
export function hasHistoryFilters(filters: HistoryFilters): boolean {
  return filters.taskId !== 'all' || filters.range !== 'all' || filters.outcome !== 'all' || filters.query.trim() !== ''
}

/** 时间范围起点；'all' 或 now 非法时返回 undefined（不过滤时间） */
function historyRangeStart(range: HistoryRange, now: number): number | undefined {
  if (range === 'all') return undefined
  if (!Number.isFinite(now)) return undefined
  if (range === 'today') {
    const date = new Date(now)
    date.setHours(0, 0, 0, 0)
    return date.getTime()
  }
  const days = range === '7d' ? 7 : 30
  return now - days * 24 * 60 * 60 * 1000
}

function matchesHistoryOutcome(row: HistoryRow, outcome: HistoryOutcome): boolean {
  switch (outcome) {
    case 'failed':
      return row.failed > 0
    case 'quarantined':
      return row.quarantined > 0
    case 'recycled':
      return row.recycledBytes > 0
    case 'dry-run':
      return row.dryRun
    default:
      return true
  }
}

export interface HistoryFilterContext {
  /** 时间范围筛选的「现在」，不传则取 Date.now()（测试传固定值） */
  now?: number
  /** 任务 id → 名称，用于搜索任务名（历史条目只存 id） */
  taskNames?: Readonly<Record<string, string>>
}

/**
 * 过滤历史：
 * - query 同时匹配会话 id、任务 id、任务名；
 * - 时间范围对「时间无效」的记录一律视为不匹配（无法判断它属于哪段区间）；
 * - taskId 为 'all' 时不过滤任务。
 */
export function filterHistoryRows(
  rows: readonly HistoryRow[],
  filters: HistoryFilters,
  context: HistoryFilterContext = {},
): HistoryRow[] {
  const now = typeof context.now === 'number' && Number.isFinite(context.now) ? context.now : Date.now()
  const start = historyRangeStart(filters.range, now)
  const taskNames = context.taskNames ?? {}
  const query = filters.query.trim().toLowerCase()
  return rows.filter((row) => {
    if (filters.taskId !== 'all' && !row.taskIds.includes(filters.taskId)) return false
    if (!matchesHistoryOutcome(row, filters.outcome)) return false
    if (start !== undefined) {
      if (!row.startedAtValid || row.startedAt < start) return false
    }
    if (query) {
      const haystack = [row.sessionId, ...row.taskIds, ...row.taskIds.map((id) => taskNames[id] ?? '')]
      if (!haystack.some((item) => item.toLowerCase().includes(query))) return false
    }
    return true
  })
}

/** 时间有效值参与排序；无效时间排最后，不因升序/降序跳回最前 */
function timeRank(row: HistoryRow): number {
  return row.startedAtValid ? row.startedAt : -1
}

/** 排序：主键按 key/dir；并列时「时间新在前」，再按会话 id 稳定兜底 */
export function sortHistoryRows(rows: readonly HistoryRow[], sort: HistorySort): HistoryRow[] {
  const factor = sort.dir === 'asc' ? 1 : -1
  const list = [...rows]
  list.sort((a, b) => {
    if (sort.key === 'time' && a.startedAtValid !== b.startedAtValid) {
      return a.startedAtValid ? -1 : 1
    }
    let primary = 0
    if (sort.key === 'time') primary = (a.startedAt - b.startedAt) * factor
    else if (sort.key === 'freed') primary = (a.freedBytes - b.freedBytes) * factor
    else primary = (a.failed - b.failed) * factor
    if (primary !== 0) return primary
    const timeTie = timeRank(b) - timeRank(a)
    if (timeTie !== 0) return timeTie
    return compareText(a.sessionId, b.sessionId)
  })
  return list
}

export interface HistoryRowSummary {
  count: number
  cleaned: number
  freedBytes: number
  recycledBytes: number
  quarantined: number
  quarantinedBytes: number
  failed: number
  dryRunCount: number
  /** 最新一条可用时间；全部无效时为 undefined */
  latestAt?: number
}

/** 汇总（用于筛选结果一句话摘要/顶部统计），不改变入参 */
export function summarizeHistoryRows(rows: readonly HistoryRow[]): HistoryRowSummary {
  const summary: HistoryRowSummary = {
    count: rows.length,
    cleaned: 0,
    freedBytes: 0,
    recycledBytes: 0,
    quarantined: 0,
    quarantinedBytes: 0,
    failed: 0,
    dryRunCount: 0,
  }
  for (const row of rows) {
    summary.cleaned += row.cleaned
    summary.freedBytes += row.freedBytes
    summary.recycledBytes += row.recycledBytes
    summary.quarantined += row.quarantined
    summary.quarantinedBytes += row.quarantinedBytes
    summary.failed += row.failed
    if (row.dryRun) summary.dryRunCount += 1
    if (row.startedAtValid && (summary.latestAt === undefined || row.startedAt > summary.latestAt)) {
      summary.latestAt = row.startedAt
    }
  }
  return summary
}

/** 历史里出现过的任务 id（首次出现顺序，用于任务筛选下拉） */
export function collectHistoryTaskIds(rows: readonly HistoryRow[]): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const row of rows) {
    for (const id of row.taskIds) {
      if (seen.has(id)) continue
      seen.add(id)
      ids.push(id)
    }
  }
  return ids
}

/** 任务 id 列表 → 可读标签；未知 id 回落成 id 本身（插件卸载后历史仍可读） */
export function historyTaskLabels(taskIds: readonly string[], taskNames?: Readonly<Record<string, string>>): string {
  if (!taskIds.length) return '—'
  const labels = [...new Set(taskIds)].map((id) => taskNames?.[id] ?? id)
  return labels.join('、')
}

/* ------------------------------------------------------------------ */
/* 隔离区：规范化 / 筛选 / 摘要 / 会话关联                               */
/* ------------------------------------------------------------------ */

export interface QuarantineRow {
  id: string
  sessionId: string
  taskId: string
  originalPath: string
  bytes: number
  createdAt: number
  createdAtValid: boolean
}

/** 规范化隔离记录：没有 id 的记录无法操作（恢复/删除都按 id），直接丢弃 */
export function normalizeQuarantineRecords(raw: readonly unknown[]): QuarantineRow[] {
  const rows: QuarantineRow[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const value = item as Record<string, unknown>
    const id = textOf(value.id, 500)
    if (!id) continue
    const createdAt =
      typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) && value.createdAt > 0 ? value.createdAt : 0
    rows.push({
      id,
      sessionId: textOf(value.sessionId, 120),
      taskId: textOf(value.taskId, 120),
      originalPath: textOf(value.originalPath, 4096),
      bytes: nonNegative(value.bytes, true),
      createdAt,
      createdAtValid: createdAt > 0,
    })
  }
  return rows
}

export interface QuarantineFilters {
  query: string
  /** 'all' 或具体任务 id */
  taskId: string
  /** '' 表示不按会话过滤；从历史「查看隔离项」进入时会带上会话 id */
  sessionId: string
}

export const DEFAULT_QUARANTINE_FILTERS: QuarantineFilters = {
  query: '',
  taskId: 'all',
  sessionId: '',
}

export function hasQuarantineFilters(filters: QuarantineFilters): boolean {
  return filters.taskId !== 'all' || filters.sessionId !== '' || filters.query.trim() !== ''
}

function compareQuarantineNewestFirst(a: QuarantineRow, b: QuarantineRow): number {
  if (a.createdAtValid !== b.createdAtValid) return a.createdAtValid ? -1 : 1
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt
  return compareText(a.id, b.id)
}

/** 过滤隔离区：搜索匹配原始路径/任务 id/任务名/会话 id；结果按隔离时间倒序 */
export function filterQuarantineRows(
  rows: readonly QuarantineRow[],
  filters: QuarantineFilters,
  context: { taskNames?: Readonly<Record<string, string>> } = {},
): QuarantineRow[] {
  const taskNames = context.taskNames ?? {}
  const query = filters.query.trim().toLowerCase()
  const result = rows.filter((row) => {
    if (filters.sessionId && row.sessionId !== filters.sessionId) return false
    if (filters.taskId !== 'all' && row.taskId !== filters.taskId) return false
    if (query) {
      const haystack = [row.originalPath, row.taskId, row.sessionId, taskNames[row.taskId] ?? '']
      if (!haystack.some((item) => item.toLowerCase().includes(query))) return false
    }
    return true
  })
  result.sort(compareQuarantineNewestFirst)
  return result
}

/** 隔离区出现过的任务 id（首次出现顺序，用于任务筛选下拉） */
export function collectQuarantineTaskIds(rows: readonly QuarantineRow[]): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const row of rows) {
    if (!row.taskId || seen.has(row.taskId)) continue
    seen.add(row.taskId)
    ids.push(row.taskId)
  }
  return ids
}

export interface QuarantineRowSummary {
  count: number
  bytes: number
  sessionCount: number
  taskCount: number
  oldestAt?: number
  newestAt?: number
}

/** 隔离区摘要：项数/体积/涉及会话与任务数/最早最晚隔离时间 */
export function summarizeQuarantineRows(rows: readonly QuarantineRow[]): QuarantineRowSummary {
  const sessions = new Set<string>()
  const tasks = new Set<string>()
  const summary: QuarantineRowSummary = { count: rows.length, bytes: 0, sessionCount: 0, taskCount: 0 }
  for (const row of rows) {
    summary.bytes += row.bytes
    if (row.sessionId) sessions.add(row.sessionId)
    if (row.taskId) tasks.add(row.taskId)
    if (row.createdAtValid) {
      if (summary.oldestAt === undefined || row.createdAt < summary.oldestAt) summary.oldestAt = row.createdAt
      if (summary.newestAt === undefined || row.createdAt > summary.newestAt) summary.newestAt = row.createdAt
    }
  }
  summary.sessionCount = sessions.size
  summary.taskCount = tasks.size
  return summary
}

export interface QuarantineSessionGroup {
  sessionId: string
  count: number
  bytes: number
  newestAt?: number
}

/** 按清理会话分组（用于「本次清理的隔离项」入口），最近会话在前 */
export function groupQuarantineSessions(rows: readonly QuarantineRow[]): QuarantineSessionGroup[] {
  const map = new Map<string, QuarantineSessionGroup>()
  for (const row of rows) {
    const group = map.get(row.sessionId) ?? { sessionId: row.sessionId, count: 0, bytes: 0 }
    group.count += 1
    group.bytes += row.bytes
    if (row.createdAtValid && (group.newestAt === undefined || row.createdAt > group.newestAt)) group.newestAt = row.createdAt
    map.set(row.sessionId, group)
  }
  const groups = [...map.values()]
  groups.sort((a, b) => {
    if (a.newestAt !== b.newestAt) return (b.newestAt ?? -1) - (a.newestAt ?? -1)
    return compareText(a.sessionId, b.sessionId)
  })
  return groups
}

/** 某个清理会话当前仍在隔离区的项数 */
export function quarantineCountForSession(rows: readonly QuarantineRow[], sessionId: string): number {
  if (!sessionId) return 0
  return rows.filter((row) => row.sessionId === sessionId).length
}

export interface HistoryQuarantineLink {
  /** 当前仍在隔离区、可恢复的项数 */
  available: number
  /** 历史记录显示写入过隔离区、但现在已不在隔离区的项数 */
  gone: number
  text: string
}

/**
 * 历史条目 → 隔离区入口：
 * - 本次清理写入隔离区的项还有剩余 → 提示数量并给出「去隔离区」入口；
 * - 已全部恢复/删除 → 明确告知不再可还原（不能让用户误以为还能恢复）；
 * - 本次没有隔离项 → undefined（不显示）。
 */
export function historyQuarantineLink(row: HistoryRow, currentCount: number): HistoryQuarantineLink | undefined {
  const recorded = Math.max(0, Math.round(row.quarantined))
  const current = Math.max(0, Math.round(currentCount))
  if (current > 0) {
    return {
      available: current,
      gone: Math.max(0, recorded - current),
      text: `本次清理写入隔离区的项仍有 ${current} 个在隔离区，可恢复`,
    }
  }
  if (recorded > 0) {
    return {
      available: 0,
      gone: recorded,
      text: `本次清理写入隔离区的 ${recorded} 项已全部恢复或删除，原文件不再可还原`,
    }
  }
  return undefined
}

/* ------------------------------------------------------------------ */
/* 空状态分型                                                           */
/* ------------------------------------------------------------------ */

export type HistoryEmptyKind = 'loading' | 'error' | 'no-history' | 'no-match'

export interface HistoryEmptyInput {
  /** 内核连接是否就绪 */
  ready: boolean
  /** 是否正在读取历史 */
  loading: boolean
  /** 最近一次读取失败原因 */
  error?: string
  /** 历史总条数（不受筛选影响） */
  totalCount: number
  /** 筛选后可见条数 */
  visibleCount: number
  filtersActive: boolean
}

/**
 * 历史空状态：加载 → 错误 → 真没有记录 → 被筛选藏掉。
 * 返回 undefined 表示表格里有内容，不需要空状态。
 */
export function historyEmptyKind(input: HistoryEmptyInput): HistoryEmptyKind | undefined {
  if (input.loading) return 'loading'
  if (!input.ready) return 'loading'
  if (input.totalCount === 0) return input.error ? 'error' : 'no-history'
  if (input.visibleCount === 0 && input.filtersActive) return 'no-match'
  return undefined
}

export type QuarantineEmptyKind = 'loading' | 'error' | 'empty' | 'no-match'

export interface QuarantineEmptyInput {
  ready: boolean
  loading: boolean
  error?: string
  totalCount: number
  visibleCount: number
  filtersActive: boolean
}

/** 隔离区空状态：加载 → 错误 → 真为空 → 被筛选藏掉 */
export function quarantineEmptyKind(input: QuarantineEmptyInput): QuarantineEmptyKind | undefined {
  if (input.loading) return 'loading'
  if (!input.ready) return 'loading'
  if (input.totalCount === 0) return input.error ? 'error' : 'empty'
  if (input.visibleCount === 0 && input.filtersActive) return 'no-match'
  return undefined
}

/* ------------------------------------------------------------------ */
/* 危险操作确认文案                                                     */
/* ------------------------------------------------------------------ */

export interface ConfirmCopy {
  title: string
  message: string
  confirmText: string
  cancelText: string
}

function totalBytesOf(rows: readonly { bytes: number }[]): number {
  return rows.reduce((sum, row) => sum + Math.max(0, Math.round(row.bytes)), 0)
}

/** 批量恢复确认：说明目标路径、失败条件与「不覆盖现有文件」的安全边界 */
export function restoreConfirmCopy(rows: readonly Pick<QuarantineRow, 'id' | 'originalPath' | 'bytes'>[]): ConfirmCopy {
  const count = rows.length
  if (!count) {
    return { title: '恢复隔离项', message: '没有选择要恢复的隔离项。', confirmText: '确定', cancelText: '取消' }
  }
  return {
    title: '恢复隔离项',
    message: [
      `将恢复 ${count} 项（合计 ${formatBytes(totalBytesOf(rows))}）到清理前的原始路径。`,
      '原路径已有同名文件、原目录不可用、原路径已不在允许清理范围时，该项会恢复失败并继续留在隔离区。',
      '恢复不会覆盖或删除任何现有文件。',
    ].join('\n'),
    confirmText: `恢复 ${count} 项`,
    cancelText: '取消',
  }
}

/**
 * 彻底删除确认：必须讲清「这些副本就是唯一副本」「不可撤销」「历史统计不受影响」。
 * options.all=true 时用于「清空整个隔离区」。
 */
export function purgeConfirmCopy(
  rows: readonly Pick<QuarantineRow, 'id' | 'originalPath' | 'bytes'>[],
  options: { all?: boolean } = {},
): ConfirmCopy {
  const count = rows.length
  const scope = options.all ? '隔离区中的全部' : '选中的'
  return {
    title: options.all ? '清空隔离区' : '彻底删除隔离项',
    message: [
      `将彻底删除${scope} ${count} 项（合计 ${formatBytes(totalBytesOf(rows))}）。`,
      '这些文件在清理时已被移入隔离区，原位置不再有副本；删除后 CordClean 无法恢复它们，此操作不可撤销。',
      options.all ? '其它清理历史与累计统计不受影响。' : '其它隔离项与清理历史不受影响。',
    ].join('\n'),
    confirmText: options.all ? `彻底删除全部 ${count} 项` : `彻底删除 ${count} 项`,
    cancelText: '取消',
  }
}

/** 清空历史确认：说明只删记录、不影响隔离区，但累计统计会归零 */
export function clearHistoryConfirmCopy(count: number): ConfirmCopy {
  const safeCount = Math.max(0, Math.round(count))
  return {
    title: '清空清理历史',
    message: [
      `将清空全部 ${safeCount} 条清理历史记录，此操作不可撤销。`,
      '清空历史只删除记录，不会删除隔离区中的文件；隔离区恢复能力不受影响。',
      '「累计释放空间」「清理次数」等累计统计会一并归零。',
    ].join('\n'),
    confirmText: '清空历史',
    cancelText: '取消',
  }
}

export interface UndoStateLike {
  available: boolean
  quarantine: number
  recycle: number
  permanent: number
}

/** 撤销上次清理确认：明确只有隔离项能恢复，回收站/永久删除的边界 */
export function undoConfirmCopy(state: UndoStateLike): ConfirmCopy {
  const quarantine = Math.max(0, Math.round(state.quarantine))
  const recycle = Math.max(0, Math.round(state.recycle))
  const permanent = Math.max(0, Math.round(state.permanent))
  return {
    title: '撤销上次清理',
    message: [
      `上次实际清理：隔离区 ${quarantine} 项可恢复到原位置；回收站 ${recycle} 项需在 Windows 回收站中手动还原（CordClean 无法一键还原）；永久删除 ${permanent} 项不可恢复。`,
      '本次撤销只会恢复隔离区中的文件；恢复失败的项目会继续留在隔离区，可稍后重试。',
    ].join('\n'),
    confirmText: quarantine > 0 ? `恢复 ${quarantine} 项` : '确定',
    cancelText: '取消',
  }
}

/* ------------------------------------------------------------------ */
/* 按钮可用性与禁用原因                                                 */
/* ------------------------------------------------------------------ */

/** 恢复按钮：未连接/其它操作进行中/未勾选都要给出具体原因 */
export function restoreGate(input: { ready: boolean; busy: boolean; selectedCount: number }): ActionGate {
  if (!input.ready) return { ok: false, reason: '内核尚未连接，请稍候' }
  if (input.busy) return { ok: false, reason: '正在执行隔离区操作，请稍候' }
  if (input.selectedCount <= 0) return { ok: false, reason: '先勾选要恢复的隔离项' }
  return { ok: true }
}

/** 彻底删除按钮：all=true 表示清空整个隔离区 */
export function purgeGate(input: {
  ready: boolean
  busy: boolean
  selectedCount: number
  totalCount: number
  all: boolean
}): ActionGate {
  if (!input.ready) return { ok: false, reason: '内核尚未连接，请稍候' }
  if (input.busy) return { ok: false, reason: '正在执行隔离区操作，请稍候' }
  if (input.all) {
    if (input.totalCount <= 0) return { ok: false, reason: '隔离区为空，没有可删除的内容' }
    return { ok: true }
  }
  if (input.selectedCount <= 0) return { ok: false, reason: '先勾选要彻底删除的隔离项' }
  return { ok: true }
}

/** 撤销按钮：区分「没有凭据」「只有回收站」「只有永久删除」「状态读取失败」 */
export function undoGate(input: {
  ready: boolean
  busy: boolean
  state?: UndoStateLike
  loading?: boolean
  error?: string
}): ActionGate {
  if (!input.ready) return { ok: false, reason: '内核尚未连接，请稍候' }
  if (input.busy) return { ok: false, reason: '正在执行操作，请稍候' }
  if (input.error) return { ok: false, reason: `读取撤销状态失败：${input.error}` }
  if (input.loading || !input.state) return { ok: false, reason: '正在读取撤销状态…' }
  if (input.state.available && input.state.quarantine > 0) return { ok: true }
  if (input.state.recycle > 0) {
    return { ok: false, reason: '本次记录进入了回收站，CordClean 不提供一键还原；请在 Windows 回收站中手动还原' }
  }
  if (input.state.permanent > 0) return { ok: false, reason: '本次记录是永久删除，无法恢复' }
  return { ok: false, reason: '没有可恢复的隔离项（只保留最近一次实际清理的凭据）' }
}

/** 清空历史按钮 */
export function clearHistoryGate(input: { ready: boolean; busy: boolean; count: number }): ActionGate {
  if (!input.ready) return { ok: false, reason: '内核尚未连接，请稍候' }
  if (input.busy) return { ok: false, reason: '正在执行操作，请稍候' }
  if (input.count <= 0) return { ok: false, reason: '暂无历史记录可清空' }
  return { ok: true }
}

/* ------------------------------------------------------------------ */
/* 操作结果文案（失败逐条原因）                                          */
/* ------------------------------------------------------------------ */

export interface RestoreFailureView {
  id: string
  /** 原始路径（查不到时给可读占位，而不是空白） */
  path: string
  message: string
}

export interface RestoreResultView {
  requested: number
  restored: number
  failed: RestoreFailureView[]
  hasFailures: boolean
  tone: 'success' | 'warning' | 'error'
  title: string
  message: string
}

/**
 * 恢复结果：把后端 `{ restored, failed:[{id,message}] }` 转成可展示结构。
 * 失败项尽量映射回原始路径（恢复后记录可能已从列表消失，所以调用前先建好 map）。
 */
export function describeRestoreResult(
  result: { restored: number; failed: Array<{ id: string; message: string }> },
  requestedIds: readonly string[],
  paths: ReadonlyMap<string, string>,
): RestoreResultView {
  const requested = new Set(requestedIds).size
  const restoredRaw = nonNegative(result?.restored, true)
  const restored = requested > 0 ? Math.min(restoredRaw, requested) : restoredRaw
  const failedRaw = Array.isArray(result?.failed) ? result.failed : []
  const failed: RestoreFailureView[] = failedRaw.map((item) => ({
    id: textOf(item?.id, 500),
    path: paths.get(textOf(item?.id, 500)) || '未知原始路径',
    message: textOf(item?.message, 500) || '未知原因',
  }))
  if (!failed.length) {
    if (restored > 0) {
      return {
        requested,
        restored,
        failed,
        hasFailures: false,
        tone: 'success',
        title: '恢复完成',
        message: `已恢复 ${restored} 项到清理前的原始位置。`,
      }
    }
    return {
      requested,
      restored,
      failed,
      hasFailures: false,
      tone: 'warning',
      title: '没有恢复任何项目',
      message: '没有项目被恢复，可能它们已不在隔离区（被恢复或删除），请刷新后重试。',
    }
  }
  const partial = restored > 0
  return {
    requested,
    restored,
    failed,
    hasFailures: true,
    tone: partial ? 'warning' : 'error',
    title: partial ? `部分恢复失败（${failed.length} 项）` : '恢复失败',
    message: partial
      ? `已恢复 ${restored} 项；${failed.length} 项失败并继续留在隔离区，请按下方原因处理后重试。`
      : `没有项目被恢复，${failed.length} 项失败并继续留在隔离区，请按下方原因处理后重试。`,
  }
}

export interface UndoResultLike {
  restored: number
  recyclePending?: number
  permanent?: number
  failed?: number
  /** 逐条失败原因；旧内核没有该字段时按 failed 数量兜底 */
  failures?: Array<{ id?: string; path?: string; reason?: string }>
}

export interface UndoResultView {
  restored: number
  failedCount: number
  recyclePending: number
  permanent: number
  /** 「原始路径 — 失败原因」列表（最多 50 条） */
  details: string[]
  tone: 'success' | 'warning' | 'error'
  title: string
  message: string
}

/**
 * 撤销上次清理的结果：把后端逐条失败原因转成可展示结构。
 * 旧内核只给 failed 数量时仍能工作（details 为空，文案按数量提示）。
 */
export function describeUndoResult(result: UndoResultLike): UndoResultView {
  const restored = nonNegative(result?.restored, true)
  const failures = Array.isArray(result?.failures) ? result.failures : []
  const failedCount = Math.max(nonNegative(result?.failed, true), failures.length)
  const recyclePending = nonNegative(result?.recyclePending, true)
  const permanent = nonNegative(result?.permanent, true)
  const details = failures
    .slice(0, 50)
    .map((item) => `${textOf(item?.path, 500) || '未知原始路径'} — ${textOf(item?.reason, 500) || '未知原因'}`)
  const boundaryParts: string[] = []
  if (recyclePending > 0) boundaryParts.push(`回收站 ${recyclePending} 项需在 Windows 回收站中手动还原`)
  if (permanent > 0) boundaryParts.push(`永久删除 ${permanent} 项不可恢复`)
  const boundary = boundaryParts.length ? `${boundaryParts.join('；')}。` : ''
  if (failedCount > 0) {
    return {
      restored,
      failedCount,
      recyclePending,
      permanent,
      details,
      tone: 'warning',
      title: `部分隔离项恢复失败（${failedCount} 项）`,
      message: `已恢复 ${restored} 项；${failedCount} 项仍留在隔离区，可稍后重试。${boundary}`,
    }
  }
  if (restored > 0) {
    return {
      restored,
      failedCount: 0,
      recyclePending,
      permanent,
      details,
      tone: 'success',
      title: '撤销完成',
      message: `已恢复 ${restored} 项到清理前的原始位置。${boundary}`,
    }
  }
  return {
    restored: 0,
    failedCount: 0,
    recyclePending,
    permanent,
    details,
    tone: 'warning',
    title: '没有恢复任何项目',
    message: `撤销凭据已失效或对应隔离项已不存在（只保留最近一次）。${boundary}`,
  }
}

export interface PurgeResultView {
  removed: number
  requested: number
  remaining: number
  shortfall: boolean
  tone: 'success' | 'warning'
  title: string
  message: string
}

/**
 * 彻底删除结果：后端返回「实际删除数」，可能少于请求数（被占用/权限不足）。
 * 旧实现只报删除数，用户会以为全删了；这里显式提示剩余项仍在隔离区。
 */
export function describePurgeResult(removed: unknown, requested: number): PurgeResultView {
  const total = Math.max(0, Math.round(nonNegative(requested, true)))
  if (total === 0) {
    return {
      removed: 0,
      requested: 0,
      remaining: 0,
      shortfall: false,
      tone: 'success',
      title: '没有可删除的隔离项',
      message: '隔离区当前为空。',
    }
  }
  const cleaned = Math.min(total, nonNegative(removed, true))
  const remaining = Math.max(0, total - cleaned)
  if (remaining > 0) {
    return {
      removed: cleaned,
      requested: total,
      remaining,
      shortfall: true,
      tone: 'warning',
      title: `部分删除失败（${remaining} 项仍在隔离区）`,
      message: `已彻底删除 ${cleaned} 项；${remaining} 项未能删除（可能被占用或权限不足），仍在隔离区，可稍后重试。`,
    }
  }
  return {
    removed: cleaned,
    requested: total,
    remaining: 0,
    shortfall: false,
    tone: 'success',
    title: '已彻底删除',
    message: `已彻底删除 ${cleaned} 项，CordClean 无法再恢复这些文件。`,
  }
}
