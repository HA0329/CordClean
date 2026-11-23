<script setup lang="ts">
/**
 * 历史与隔离区（已按「独立完成」标准升级）。
 *
 * 交互原则：
 * - 三态齐全：读取中 / 失败重试 / 空状态分型（真没有记录 vs 被筛选藏掉），空历史引导去扫描；
 * - 历史可筛选可排序：任务 / 时间范围 / 结果类型 + 时间、释放量、失败数排序；
 * - 历史与隔离区通过 sessionId 关联：展开历史即可看到「本次清理写入隔离区的项」还剩多少并可直达；
 * - 隔离区操作安全：批量恢复/彻底删除都要二次确认，确认文案写清失败条件与不可恢复边界；
 * - 失败不丢反馈：恢复逐条列出原始路径与失败原因；彻底删除少于请求数时提示剩余项仍在隔离区；
 * - 操作进行中禁用重复点击，不可用按钮用 tooltip 说明具体原因（未勾选/为空/正在执行/回收站边界）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { formatBytes, formatDuration, formatTime } from '@cordclean/shared'
import {
  clearHistory,
  fetchSessions,
  fetchUndoState,
  openPath,
  purgeQuarantine,
  refreshHistory,
  refreshQuarantine,
  restoreQuarantine,
  state,
  undoLastClean,
} from '../api/store.ts'
import {
  DEFAULT_HISTORY_FILTERS,
  DEFAULT_QUARANTINE_FILTERS,
  HISTORY_OUTCOME_OPTIONS,
  HISTORY_RANGE_OPTIONS,
  HISTORY_SORT_OPTIONS,
  clearHistoryConfirmCopy,
  clearHistoryGate,
  collectHistoryTaskIds,
  collectQuarantineTaskIds,
  describePurgeResult,
  describeRestoreResult,
  filterHistoryRows,
  filterQuarantineRows,
  hasHistoryFilters,
  hasQuarantineFilters,
  historyEmptyKind,
  historyQuarantineLink,
  historyTaskLabels,
  normalizeHistoryEntries,
  normalizeQuarantineRecords,
  purgeConfirmCopy,
  purgeGate,
  quarantineEmptyKind,
  restoreConfirmCopy,
  restoreGate,
  sortHistoryRows,
  summarizeHistoryRows,
  summarizeQuarantineRows,
  undoConfirmCopy,
  undoGate,
  type ConfirmCopy,
  type HistoryFilters,
  type HistoryOutcome,
  type HistoryQuarantineLink,
  type HistoryRange,
  type HistoryRow,
  type HistorySortDir,
  type HistorySortKey,
  type QuarantineFilters,
  type QuarantineRow,
  type UndoStateLike,
} from './history-view-model.ts'

type TabName = 'history' | 'quarantine'
type BusyAction = 'refresh' | 'undo' | 'restore' | 'purge' | 'clear' | null

interface Feedback {
  tone: 'success' | 'warning' | 'error'
  title: string
  message?: string
  details?: string[]
}

interface HistoryDisplayRow extends HistoryRow {
  labels: string
  quarantine?: HistoryQuarantineLink
}

interface QuarantineDisplayRow extends QuarantineRow {
  taskLabel: string
  timeText: string
}

interface EmptyView {
  icon: string
  title: string
  description: string
  showRetry?: boolean
  showReset?: boolean
  showScan?: boolean
  showClean?: boolean
  showHistory?: boolean
}

interface InterruptedSession {
  sessionId: string
  startedAt: number
  status: string
  taskIds: string[]
}

/* ------------------------------------------------------------------ */
/* 页面级状态                                                           */
/* ------------------------------------------------------------------ */

const tab = ref<TabName>('history')
const busyAction = ref<BusyAction>(null)
const refreshing = computed(() => busyAction.value === 'refresh')
const loadError = ref<string>()
const nowTick = ref(Date.now())
const quarantineTableRef = ref<any>()

const taskNames = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {}
  for (const task of state.tasks) map[task.id] = task.name
  return map
})

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 统一二次确认：返回 false = 用户取消/关闭（不当作错误） */
async function askConfirm(copy: ConfirmCopy): Promise<boolean> {
  try {
    await ElMessageBox.confirm(copy.message, copy.title, {
      type: 'warning',
      confirmButtonText: copy.confirmText,
      cancelButtonText: copy.cancelText,
      distinguishCancelAndClose: true,
    })
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* 撤销上次清理                                                         */
/* ------------------------------------------------------------------ */

const undoTarget = ref<UndoStateLike>({ available: false, quarantine: 0, recycle: 0, permanent: 0 })
const undoLoading = ref(false)
const undoError = ref<string>()
const undoFeedback = ref<Feedback>()

const undoAvailability = computed(() =>
  undoGate({
    ready: state.ready,
    busy: busyAction.value !== null,
    state: undoTarget.value,
    loading: undoLoading.value,
    error: undoError.value,
  }),
)

/** 可恢复性边界：只保留最近一次实际清理的撤销凭据 */
const undoBoundaryText = computed(() => {
  const target = undoTarget.value
  if (!target.available && !target.quarantine && !target.recycle && !target.permanent) return undefined
  const parts: string[] = []
  if (target.quarantine > 0) parts.push(`隔离区 ${target.quarantine} 项可由 CordClean 一键恢复`)
  if (target.recycle > 0) parts.push(`回收站 ${target.recycle} 项需在 Windows 回收站中手动还原`)
  if (target.permanent > 0) parts.push(`永久删除 ${target.permanent} 项不可恢复`)
  return `只保留最近一次实际清理的凭据：${parts.join('；')}。`
})

async function loadUndoState(): Promise<void> {
  undoLoading.value = true
  try {
    undoTarget.value = await fetchUndoState()
    undoError.value = undefined
  } catch (error) {
    // 读取失败时保持保守：按钮会被禁用并显示原因，不做任何乐观假设
    undoError.value = errorText(error)
  } finally {
    undoLoading.value = false
  }
}

async function undoLast(): Promise<void> {
  const gate = undoAvailability.value
  if (!gate.ok) {
    ElMessage.info(gate.reason ?? '当前不可撤销')
    return
  }
  if (!(await askConfirm(undoConfirmCopy(undoTarget.value)))) return
  busyAction.value = 'undo'
  try {
    const result = await undoLastClean()
    const failed = Math.max(0, Math.round(result.failed))
    const boundary = `回收站 ${result.recyclePending} 项需在 Windows 回收站中手动还原；永久删除 ${result.permanent} 项不可恢复。`
    if (failed > 0) {
      undoFeedback.value = {
        tone: 'warning',
        title: `部分隔离项恢复失败（${failed} 项）`,
        message: `已恢复 ${result.restored} 项；${failed} 项仍留在隔离区，可稍后重试。${boundary}`,
      }
      ElMessage.warning('部分隔离项恢复失败，详见页面提示')
    } else if (result.restored > 0) {
      undoFeedback.value = { tone: 'success', title: '撤销完成', message: `已恢复 ${result.restored} 项到清理前的原始位置。${boundary}` }
      ElMessage.success(`已恢复 ${result.restored} 项`)
    } else {
      undoFeedback.value = {
        tone: 'warning',
        title: '没有恢复任何项目',
        message: `撤销凭据已失效或对应隔离项已不存在（只保留最近一次）。${boundary}`,
      }
      ElMessage.warning('没有可恢复的隔离项')
    }
  } catch (error) {
    const message = errorText(error)
    undoFeedback.value = { tone: 'error', title: '撤销失败', message }
    ElMessage.error('撤销失败：' + message)
  } finally {
    busyAction.value = null
    await loadUndoState()
  }
}

/* ------------------------------------------------------------------ */
/* 中断会话提示                                                         */
/* ------------------------------------------------------------------ */

const interrupted = ref<InterruptedSession[]>([])
const interruptedError = ref<string>()

const interruptedSummary = computed(() => {
  if (!interrupted.value.length) return undefined
  const latest = interrupted.value.reduce((current, item) => (item.startedAt > current.startedAt ? item : current))
  return {
    count: interrupted.value.length,
    latestAt: latest.startedAt,
    labels: historyTaskLabels(latest.taskIds, taskNames.value),
  }
})

const interruptedDescription = computed(() => {
  const summary = interruptedSummary.value
  if (!summary) return undefined
  return `最近一次中断于 ${formatTime(summary.latestAt)}（任务：${summary.labels}）。中断的会话不会自动继续；若担心误删，可到隔离区恢复或在上方历史记录中查看。`
})

async function loadInterrupted(): Promise<void> {
  try {
    const sessions = await fetchSessions()
    interrupted.value = sessions.filter((item) => item.status === 'interrupted')
    interruptedError.value = undefined
  } catch (error) {
    interruptedError.value = errorText(error)
  }
}

function viewInterruptedQuarantine(): void {
  const sessionId = interrupted.value[0]?.sessionId
  if (sessionId) openQuarantineForSession(sessionId)
  else tab.value = 'quarantine'
}

/* ------------------------------------------------------------------ */
/* 隔离区                                                               */
/* ------------------------------------------------------------------ */

const quarantineRows = computed(() => normalizeQuarantineRecords(state.quarantine))
const quarantineQuery = ref('')
const quarantineTaskId = ref('all')
const quarantineSessionId = ref('')
const quarantineFilters = computed<QuarantineFilters>(() => ({
  query: quarantineQuery.value,
  taskId: quarantineTaskId.value,
  sessionId: quarantineSessionId.value,
}))
const quarantineFiltersActive = computed(() => hasQuarantineFilters(quarantineFilters.value))
const filteredQuarantineRows = computed(() =>
  filterQuarantineRows(quarantineRows.value, quarantineFilters.value, { taskNames: taskNames.value }),
)
const quarantineSummary = computed(() => summarizeQuarantineRows(quarantineRows.value))
const quarantineTaskOptions = computed(() =>
  collectQuarantineTaskIds(quarantineRows.value).map((id) => ({ value: id, label: taskNames.value[id] ?? id })),
)
const quarantineDisplayRows = computed<QuarantineDisplayRow[]>(() =>
  filteredQuarantineRows.value.map((row) => ({
    ...row,
    taskLabel: taskNames.value[row.taskId] ?? (row.taskId || '未知任务'),
    timeText: row.createdAtValid ? formatTime(row.createdAt) : '时间未知',
  })),
)

const selectedQuarantine = ref<string[]>([])
const selectedQuarantineRows = computed(() =>
  filteredQuarantineRows.value.filter((row) => selectedQuarantine.value.includes(row.id)),
)
const selectedQuarantineSummary = computed(() => summarizeQuarantineRows(selectedQuarantineRows.value))

const restoreAvailability = computed(() =>
  restoreGate({ ready: state.ready, busy: busyAction.value !== null, selectedCount: selectedQuarantineRows.value.length }),
)
const purgeSelectedAvailability = computed(() =>
  purgeGate({
    ready: state.ready,
    busy: busyAction.value !== null,
    selectedCount: selectedQuarantineRows.value.length,
    totalCount: quarantineRows.value.length,
    all: false,
  }),
)
const purgeAllAvailability = computed(() =>
  purgeGate({
    ready: state.ready,
    busy: busyAction.value !== null,
    selectedCount: 0,
    totalCount: quarantineRows.value.length,
    all: true,
  }),
)

/** 隔离区保留/容量边界（来自设置，不在此页修改设置） */
const quarantineSettings = computed(() => state.settings?.quarantine)
const quarantineLimitsText = computed(() => {
  const settings = quarantineSettings.value
  if (!settings) return ''
  const parts: string[] = []
  parts.push(settings.retentionDays > 0 ? `超过 ${settings.retentionDays} 天的隔离项会被自动清理` : '隔离项不会自动过期')
  if (settings.maxBytes > 0) parts.push(`容量上限 ${formatBytes(settings.maxBytes)}`)
  if (settings.maxFiles > 0) parts.push(`单次会话最多 ${settings.maxFiles} 个文件`)
  return parts.join(' · ')
})
const quarantineBoundaryText = computed(() =>
  quarantineLimitsText.value
    ? `恢复边界：${quarantineLimitsText.value}；恢复要求原路径仍在允许清理范围内、且原路径不存在同名文件。`
    : '',
)

const quarantineLoading = computed(() => refreshing.value && quarantineRows.value.length === 0)
const quarantineEmpty = computed(() =>
  quarantineEmptyKind({
    ready: state.ready,
    loading: quarantineLoading.value,
    error: loadError.value,
    totalCount: quarantineRows.value.length,
    visibleCount: filteredQuarantineRows.value.length,
    filtersActive: quarantineFiltersActive.value,
  }),
)
const quarantineEmptyView = computed<EmptyView>(() => {
  switch (quarantineEmpty.value) {
    case 'loading':
      return { icon: '⏳', title: '正在读取隔离区…', description: '正在确认隔离区里有没有可恢复的文件。' }
    case 'error':
      return { icon: '⚠️', title: '读取隔离区失败', description: loadError.value ?? '内核没有返回隔离区数据', showRetry: true }
    case 'no-match':
      return { icon: '🔍', title: '没有符合筛选条件的隔离项', description: '当前筛选条件较窄，重置后可看到全部隔离项。', showReset: true }
    default: {
      const recorded = historyRows.value.some((row) => row.quarantined > 0)
      return recorded
        ? {
            icon: '🛡️',
            title: '隔离区是空的',
            description: '历史记录显示最近清理曾写入隔离项，可能已被恢复、彻底删除或超过保留期自动清理。',
            showHistory: true,
          }
        : {
            icon: '🛡️',
            title: '隔离区是空的',
            description: '清理高风险项时，文件会先移到这里而不是直接删除；当前没有待恢复的文件。',
            showClean: true,
          }
    }
  }
})

const feedback = ref<Feedback>()

function dismissFeedback(): void {
  feedback.value = undefined
}

function dismissUndoFeedback(): void {
  undoFeedback.value = undefined
}

function goHistoryTab(): void {
  tab.value = 'history'
}

function dismissQuarantineSessionFilter(): void {
  quarantineSessionId.value = ''
}

function onQuarantineSelectionChange(rows: any[]): void {
  selectedQuarantine.value = rows.map((row) => String(row?.id ?? '')).filter(Boolean)
}

function runRestore(ids: string[]): void {
  void restore(ids)
}

function runPurgeSelected(): void {
  void purge(selectedQuarantine.value)
}

function runPurgeAll(): void {
  void purge(undefined, { all: true })
}

function runRefresh(): void {
  void refreshAll()
}

function clearSelection(): void {
  selectedQuarantine.value = []
  quarantineTableRef.value?.clearSelection?.()
}

function resetQuarantineFilters(): void {
  quarantineQuery.value = ''
  quarantineTaskId.value = 'all'
  quarantineSessionId.value = ''
  clearSelection()
}

/** 从历史展开区直达「本次清理写入隔离区的项」 */
function openQuarantineForSession(sessionId: string): void {
  if (!sessionId) {
    tab.value = 'quarantine'
    return
  }
  quarantineQuery.value = ''
  quarantineTaskId.value = 'all'
  quarantineSessionId.value = sessionId
  clearSelection()
  tab.value = 'quarantine'
}

async function openQuarantinePath(row: QuarantineRow): Promise<void> {
  if (!row.originalPath) {
    ElMessage.info('这条隔离记录缺少原始路径，无法定位')
    return
  }
  try {
    await openPath(row.originalPath)
  } catch (error) {
    ElMessage.error('打开位置失败：' + errorText(error))
  }
}

/** 恢复：单项直接执行，批量先确认；逐条失败原因写进页内反馈 */
async function restore(ids: string[]): Promise<void> {
  if (!ids.length || busyAction.value) return
  const targets = quarantineRows.value.filter((row) => ids.includes(row.id))
  if (!targets.length) {
    ElMessage.info('选中的隔离项已不在列表中，请刷新后重试')
    return
  }
  const skipped = ids.length - targets.length
  if (skipped > 0) ElMessage.info(`有 ${skipped} 项已不在隔离区，已跳过`)
  const targetIds = targets.map((row) => row.id)
  if (targetIds.length > 1 && !(await askConfirm(restoreConfirmCopy(targets)))) return
  const paths = new Map(targets.map((row) => [row.id, row.originalPath]))
  busyAction.value = 'restore'
  try {
    const result = await restoreQuarantine(targetIds)
    const view = describeRestoreResult(result, targetIds, paths)
    feedback.value = {
      tone: view.tone,
      title: view.title,
      message: view.message,
      details: view.failed.map((item) => `${item.path} — ${item.message}`),
    }
    if (view.hasFailures) ElMessage.warning(`${view.title}，详情见页面提示`)
    else ElMessage.success(view.message)
    clearSelection()
  } catch (error) {
    const message = errorText(error)
    feedback.value = { tone: 'error', title: '恢复失败', message }
    ElMessage.error('恢复失败：' + message)
  } finally {
    busyAction.value = null
    // 手动恢复可能清空「撤销上次清理」的凭据，重新读取避免按钮状态过期
    await loadUndoState()
  }
}

/** 彻底删除：options.all=true 表示清空整个隔离区；结果少于请求数时明确提示剩余项 */
async function purge(ids?: string[], options: { all?: boolean } = {}): Promise<void> {
  if (busyAction.value) return
  const all = options.all === true
  const gate = all ? purgeAllAvailability.value : purgeSelectedAvailability.value
  if (!gate.ok) {
    ElMessage.info(gate.reason ?? '当前不可删除')
    return
  }
  const targets = all ? quarantineRows.value : quarantineRows.value.filter((row) => (ids ?? []).includes(row.id))
  if (!targets.length) {
    ElMessage.info(all ? '隔离区为空' : '选中的隔离项已不在列表中，请刷新后重试')
    return
  }
  if (!(await askConfirm(purgeConfirmCopy(targets, { all })))) return
  busyAction.value = 'purge'
  try {
    const removed = await purgeQuarantine(all ? undefined : targets.map((row) => row.id))
    const view = describePurgeResult(removed, targets.length)
    feedback.value = { tone: view.tone, title: view.title, message: view.message }
    if (view.shortfall) ElMessage.warning(view.message)
    else ElMessage.success(view.message)
    clearSelection()
  } catch (error) {
    const message = errorText(error)
    feedback.value = { tone: 'error', title: '彻底删除失败', message }
    ElMessage.error('彻底删除失败：' + message)
  } finally {
    busyAction.value = null
    await loadUndoState()
  }
}

/* ------------------------------------------------------------------ */
/* 清理历史                                                             */
/* ------------------------------------------------------------------ */

const historyRows = computed(() => normalizeHistoryEntries(state.history))
const historyQuery = ref('')
const historyTaskId = ref('all')
const historyRange = ref<HistoryRange>('all')
const historyOutcome = ref<HistoryOutcome>('all')
const historySortKey = ref<HistorySortKey>('time')
const historySortDir = ref<HistorySortDir>('desc')
const historyFilters = computed<HistoryFilters>(() => ({
  query: historyQuery.value,
  taskId: historyTaskId.value,
  range: historyRange.value,
  outcome: historyOutcome.value,
}))
const historyFiltersActive = computed(() => hasHistoryFilters(historyFilters.value))
const filteredHistoryRows = computed(() =>
  sortHistoryRows(
    filterHistoryRows(historyRows.value, historyFilters.value, { now: nowTick.value, taskNames: taskNames.value }),
    { key: historySortKey.value, dir: historySortDir.value },
  ),
)
const historySummary = computed(() => summarizeHistoryRows(filteredHistoryRows.value))
const historyTaskOptions = computed(() =>
  collectHistoryTaskIds(historyRows.value).map((id) => ({ value: id, label: taskNames.value[id] ?? id })),
)
const historyDryRunCount = computed(() => historyRows.value.filter((row) => row.dryRun).length)
const quarantineCountBySession = computed(() => {
  const map = new Map<string, number>()
  for (const row of quarantineRows.value) {
    if (!row.sessionId) continue
    map.set(row.sessionId, (map.get(row.sessionId) ?? 0) + 1)
  }
  return map
})
const historyDisplayRows = computed<HistoryDisplayRow[]>(() =>
  filteredHistoryRows.value.map((row) => ({
    ...row,
    labels: historyTaskLabels(row.taskIds, taskNames.value),
    quarantine: historyQuarantineLink(row, quarantineCountBySession.value.get(row.sessionId) ?? 0),
  })),
)

const clearHistoryAvailability = computed(() =>
  clearHistoryGate({ ready: state.ready, busy: busyAction.value !== null, count: historyRows.value.length }),
)

const historyLoading = computed(() => refreshing.value && historyRows.value.length === 0)
const historyEmpty = computed(() =>
  historyEmptyKind({
    ready: state.ready,
    loading: historyLoading.value,
    error: loadError.value,
    totalCount: historyRows.value.length,
    visibleCount: filteredHistoryRows.value.length,
    filtersActive: historyFiltersActive.value,
  }),
)
const historyEmptyView = computed<EmptyView>(() => {
  switch (historyEmpty.value) {
    case 'loading':
      return { icon: '⏳', title: '正在读取清理历史…', description: '正在从内核读取最近的清理记录。' }
    case 'error':
      return { icon: '⚠️', title: '读取清理历史失败', description: loadError.value ?? '内核没有返回历史数据', showRetry: true }
    case 'no-history':
      return {
        icon: '🧹',
        title: '还没有清理记录',
        description: '先扫描一次，看看本机能清出多少空间。清理结果会记录在这里；高风险项会先进入隔离区，可随时恢复。',
        showScan: true,
      }
    default:
      return {
        icon: '🔍',
        title: '没有符合筛选条件的记录',
        description: '当前筛选条件较窄，重置后可看到全部历史。',
        showReset: true,
      }
  }
})

function toggleHistorySortDir(): void {
  historySortDir.value = historySortDir.value === 'desc' ? 'asc' : 'desc'
}

function resetHistoryFilters(): void {
  historyQuery.value = ''
  historyTaskId.value = 'all'
  historyRange.value = 'all'
  historyOutcome.value = 'all'
  historySortKey.value = 'time'
  historySortDir.value = 'desc'
}

async function clearAll(): Promise<void> {
  const gate = clearHistoryAvailability.value
  if (!gate.ok) {
    ElMessage.info(gate.reason ?? '当前不可清空历史')
    return
  }
  if (!(await askConfirm(clearHistoryConfirmCopy(historyRows.value.length)))) return
  busyAction.value = 'clear'
  try {
    await clearHistory()
    resetHistoryFilters()
    ElMessage.success('历史已清空')
  } catch (error) {
    ElMessage.error('清空历史失败：' + errorText(error))
  } finally {
    busyAction.value = null
  }
}

function goClean(): void {
  state.page = 'clean'
}

/* ------------------------------------------------------------------ */
/* 加载与生命周期                                                       */
/* ------------------------------------------------------------------ */

const hasAnyData = computed(() => historyRows.value.length > 0 || quarantineRows.value.length > 0)
/** 完全没有缓存且读取失败时用整页错误态；有缓存时只在页内提示，不清空用户已看到的内容 */
const pageLoadError = computed(() => (!hasAnyData.value && loadError.value ? loadError.value : undefined))

async function refreshAll(options: { silent?: boolean } = {}): Promise<void> {
  if (busyAction.value) return
  busyAction.value = 'refresh'
  try {
    await Promise.all([refreshHistory(), refreshQuarantine()])
    nowTick.value = Date.now()
    loadError.value = undefined
    if (!options.silent) ElMessage.success('已刷新')
  } catch (error) {
    loadError.value = errorText(error)
    if (!options.silent) ElMessage.error('刷新失败：' + loadError.value)
  } finally {
    busyAction.value = null
  }
  // 撤销状态/中断会话属于辅助信息，读取失败只影响各自提示，不阻塞主数据
  await Promise.all([loadUndoState(), loadInterrupted()])
}

watch([quarantineQuery, quarantineTaskId, quarantineSessionId], () => clearSelection())
watch(historyRange, () => {
  // 「今天 / 最近 N 天」依赖当前时间，切筛选时刷新基准，避免长时间停留后按旧时间过滤
  nowTick.value = Date.now()
})

onMounted(() => {
  nowTick.value = Date.now()
  // 进入页面即静默刷新一次：历史可能是清理后才写入的，避免展示旧列表
  void refreshAll({ silent: true })
})
</script>

<template>
  <div class="cc-page">
    <div class="cc-page-title">
      <div>
        <h1>历史与隔离区</h1>
        <p>修复误删的最后一道防线：高风险的清理项会先进入隔离区，可随时恢复；历史记录可用于核对每次清理。</p>
      </div>
      <div class="cc-actions">
        <el-button :loading="refreshing" :disabled="busyAction !== null && !refreshing" @click="runRefresh">刷新</el-button>
        <el-tooltip :disabled="undoAvailability.ok" :content="undoAvailability.reason ?? '恢复最近一次实际清理写入隔离区的文件'" placement="bottom">
          <span>
            <el-button type="warning" plain :disabled="!undoAvailability.ok" :loading="busyAction === 'undo'" @click="undoLast">
              撤销上次清理
            </el-button>
          </span>
        </el-tooltip>
      </div>
    </div>

    <p v-if="undoBoundaryText" class="cc-hint undo-boundary">撤销边界：{{ undoBoundaryText }}</p>

    <el-alert
      v-if="undoFeedback"
      class="history-alert"
      :type="undoFeedback.tone"
      show-icon
      aria-live="polite"
      @close="dismissUndoFeedback"
    >
      <template #title>{{ undoFeedback.title }}</template>
      <p v-if="undoFeedback.message" class="report-message">{{ undoFeedback.message }}</p>
    </el-alert>

    <el-alert
      v-if="interruptedError && !interrupted.length"
      class="history-alert"
      type="error"
      show-icon
      :closable="false"
      title="读取未完成会话失败"
      :description="interruptedError"
    >
      <div class="alert-actions">
        <el-button size="small" @click="loadInterrupted">重试读取</el-button>
      </div>
    </el-alert>
    <el-alert
      v-else-if="interrupted.length"
      class="history-alert"
      type="warning"
      show-icon
      :closable="false"
      :title="`检测到 ${interrupted.length} 个上次未完成的清理会话（已标记中断，不会自动继续）`"
      :description="interruptedDescription"
    >
      <div class="alert-actions">
        <el-button size="small" @click="viewInterruptedQuarantine">查看隔离区</el-button>
      </div>
    </el-alert>

    <!-- 整页错误态：没有任何缓存数据且刷新失败 -->
    <div v-if="pageLoadError" class="cc-card history-error" role="alert">
      <div class="history-error-icon" aria-hidden="true">⚠️</div>
      <h3>暂时拿不到历史与隔离区数据</h3>
      <p class="cc-muted">{{ pageLoadError }}</p>
      <div class="cc-actions">
        <el-button type="primary" :loading="refreshing" @click="runRefresh">重试</el-button>
      </div>
    </div>

    <template v-else>
      <!-- 有缓存时刷新失败：页内提示，不白屏 -->
      <el-alert
        v-if="loadError"
        class="history-alert"
        type="warning"
        show-icon
        :closable="false"
        :title="'刷新失败：' + loadError"
        description="当前展示的是上一次成功读取的数据；可点右上角「刷新」重试。"
      />

      <div class="cc-grid cc-grid-3">
        <div class="cc-card cc-stat">
          <div class="cc-stat-label">累计释放空间</div>
          <div class="cc-stat-value">{{ formatBytes(state.totals.freedBytes) }}</div>
          <div class="cc-stat-sub">{{ state.totals.sessions }} 次实际清理 · {{ state.totals.cleaned }} 个清理项</div>
        </div>
        <div class="cc-card cc-stat">
          <div class="cc-stat-label">隔离区文件</div>
          <div class="cc-stat-value">{{ quarantineSummary.count }}</div>
          <div class="cc-stat-sub">
            占用 {{ formatBytes(quarantineSummary.bytes) }} · {{ quarantineSummary.sessionCount }} 个清理会话 · {{ quarantineSummary.taskCount }} 个任务
          </div>
        </div>
        <div class="cc-card cc-stat">
          <div class="cc-stat-label">历史记录</div>
          <div class="cc-stat-value">{{ state.totals.sessions }}</div>
          <div class="cc-stat-sub" title="历史列表由内核返回最近 50 条；累计统计来自全部实际清理记录">
            累计实际清理次数 · 列表最近 {{ historyRows.length }} 条（含预演 {{ historyDryRunCount }} 条）
          </div>
        </div>
      </div>

      <div class="cc-card">
        <el-tabs v-model="tab">
          <el-tab-pane name="history">
            <template #label>
              清理历史<span class="tab-count">{{ historyRows.length }}</span>
            </template>
            <div class="cc-card-title">
              <h3>🕘 清理记录</h3>
              <div class="cc-actions">
                <span class="cc-faint">列表最多显示最近 50 条，累计统计来自全部记录</span>
                <el-tooltip :disabled="clearHistoryAvailability.ok" :content="clearHistoryAvailability.reason ?? ''" placement="bottom">
                  <span>
                    <el-button size="small" text type="danger" :disabled="!clearHistoryAvailability.ok" :loading="busyAction === 'clear'" @click="clearAll">
                      清空历史
                    </el-button>
                  </span>
                </el-tooltip>
              </div>
            </div>

            <div class="history-toolbar" role="search" aria-label="筛选清理历史">
              <el-input v-model="historyQuery" size="small" clearable placeholder="搜索任务 / 会话 ID" style="width: 190px" aria-label="搜索清理历史" />
              <el-select v-model="historyTaskId" size="small" style="width: 150px" aria-label="按任务筛选清理历史">
                <el-option label="全部任务" value="all" />
                <el-option v-for="option in historyTaskOptions" :key="option.value" :label="option.label" :value="option.value" />
              </el-select>
              <el-select v-model="historyRange" size="small" style="width: 120px" aria-label="按时间范围筛选清理历史">
                <el-option v-for="option in HISTORY_RANGE_OPTIONS" :key="option.value" :label="option.label" :value="option.value" />
              </el-select>
              <el-select v-model="historyOutcome" size="small" style="width: 120px" aria-label="按结果类型筛选清理历史">
                <el-option v-for="option in HISTORY_OUTCOME_OPTIONS" :key="option.value" :label="option.label" :value="option.value" />
              </el-select>
              <el-select v-model="historySortKey" size="small" style="width: 112px" aria-label="选择历史排序字段">
                <el-option v-for="option in HISTORY_SORT_OPTIONS" :key="option.value" :label="option.label" :value="option.value" />
              </el-select>
              <el-button
                size="small"
                :aria-label="historySortDir === 'desc' ? '当前降序，点击切换为升序' : '当前升序，点击切换为降序'"
                @click="toggleHistorySortDir"
              >
                {{ historySortDir === 'desc' ? '↓ 降序' : '↑ 升序' }}
              </el-button>
              <el-button size="small" text :disabled="!historyFiltersActive" @click="resetHistoryFilters">重置筛选</el-button>
            </div>

            <p class="cc-faint history-filter-summary" aria-live="polite">
              显示 {{ filteredHistoryRows.length }} / {{ historyRows.length }} 条
              · 合计释放 {{ formatBytes(historySummary.freedBytes) }} · 清理 {{ historySummary.cleaned }} 项 · 失败 {{ historySummary.failed }} 项
              <template v-if="historySummary.quarantined"> · 隔离 {{ historySummary.quarantined }} 项</template>
            </p>

            <el-table :data="historyDisplayRows" size="small" :aria-busy="historyEmpty === 'loading'">
              <template #empty>
                <div class="empty-state" :aria-busy="historyEmpty === 'loading'">
                  <div class="empty-icon" aria-hidden="true">{{ historyEmptyView.icon }}</div>
                  <h4>{{ historyEmptyView.title }}</h4>
                  <p class="cc-muted">{{ historyEmptyView.description }}</p>
                  <div class="cc-actions empty-actions">
                    <el-button v-if="historyEmptyView.showScan" type="primary" size="small" @click="goClean">去扫描与清理</el-button>
                    <el-button v-if="historyEmptyView.showReset" size="small" @click="resetHistoryFilters">重置筛选</el-button>
                    <el-button v-if="historyEmptyView.showRetry" size="small" :loading="refreshing" @click="runRefresh">重试</el-button>
                  </div>
                </div>
              </template>
              <el-table-column type="expand" width="40">
                <template #default="{ row }">
                  <div class="history-detail">
                    <span><b>会话</b><span class="cc-mono">{{ row.sessionId || '未知' }}</span></span>
                    <span><b>模式</b>{{ row.dryRun ? '预演（未实际清理）' : '实际清理' }}</span>
                    <span><b>清理项</b>{{ row.cleaned }} 项</span>
                    <span><b>释放</b>{{ formatBytes(row.freedBytes) }}</span>
                    <span><b>回收站</b>{{ formatBytes(row.recycledBytes) }}</span>
                    <span><b>隔离区</b>{{ formatBytes(row.quarantinedBytes) }}（{{ row.quarantined }} 项）</span>
                    <span><b>外部消失</b>{{ row.vanished }} 项</span>
                    <span><b>条件跳过</b>{{ row.skipped }} 项</span>
                    <span><b>失败</b><span :class="{ 'text-danger': row.failed > 0 }">{{ row.failed }} 项</span></span>
                    <span><b>耗时</b>{{ formatDuration(row.elapsedMs) }}</span>
                    <span class="history-detail-wide"><b>任务</b>{{ row.labels }}</span>
                  </div>
                  <div v-if="row.quarantine" class="history-quarantine-link">
                    <span :class="{ 'text-warning': row.quarantine.available > 0 }">{{ row.quarantine.text }}</span>
                    <el-button
                      v-if="row.quarantine.available > 0"
                      size="small"
                      text
                      type="primary"
                      @click="openQuarantineForSession(row.sessionId)"
                    >
                      去隔离区查看（{{ row.quarantine.available }}）
                    </el-button>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="时间" width="150">
                <template #default="{ row }">
                  <span v-if="row.startedAtValid">{{ formatTime(row.startedAt) }}</span>
                  <span v-else class="cc-faint" title="该记录的时间戳无效或缺失">时间未知</span>
                </template>
              </el-table-column>
              <el-table-column label="模式" width="82">
                <template #default="{ row }">
                  <span class="cc-pill" :class="row.dryRun ? 'status-suspended' : 'status-active'">{{ row.dryRun ? '预演' : '实际' }}</span>
                </template>
              </el-table-column>
              <el-table-column label="释放空间" width="110" align="right">
                <template #default="{ row }"><span class="cc-mono">{{ formatBytes(row.freedBytes) }}</span></template>
              </el-table-column>
              <el-table-column label="清理项" width="90" align="right" prop="cleaned" />
              <el-table-column label="隔离" width="80" align="right">
                <template #default="{ row }"><span :class="{ 'text-warning': row.quarantined > 0 }">{{ row.quarantined }}</span></template>
              </el-table-column>
              <el-table-column label="失败" width="80" align="right">
                <template #default="{ row }"><span :class="{ 'text-danger': row.failed > 0 }">{{ row.failed }}</span></template>
              </el-table-column>
              <el-table-column label="耗时" width="100" align="right">
                <template #default="{ row }">{{ formatDuration(row.elapsedMs) }}</template>
              </el-table-column>
              <el-table-column label="任务" min-width="160">
                <template #default="{ row }"><span class="cc-faint task-labels" :title="row.labels">{{ row.labels }}</span></template>
              </el-table-column>
            </el-table>
          </el-tab-pane>

          <el-tab-pane name="quarantine">
            <template #label>
              隔离区<span class="tab-count">{{ quarantineRows.length }}</span>
            </template>
            <div class="cc-card-title">
              <h3>🛡️ 隔离区（可恢复）</h3>
              <div class="cc-actions">
                <span v-if="selectedQuarantineRows.length" class="cc-faint selected-hint">
                  已选 {{ selectedQuarantineRows.length }} 项（{{ formatBytes(selectedQuarantineSummary.bytes) }}）
                </span>
                <el-tooltip :disabled="restoreAvailability.ok" :content="restoreAvailability.reason ?? ''" placement="bottom">
                  <span>
                    <el-button size="small" :disabled="!restoreAvailability.ok" :loading="busyAction === 'restore'" @click="runRestore(selectedQuarantine)">
                      恢复选中
                    </el-button>
                  </span>
                </el-tooltip>
                <el-tooltip :disabled="purgeSelectedAvailability.ok" :content="purgeSelectedAvailability.reason ?? ''" placement="bottom">
                  <span>
                    <el-button size="small" type="danger" plain :disabled="!purgeSelectedAvailability.ok" :loading="busyAction === 'purge'" @click="runPurgeSelected">
                      彻底删除选中
                    </el-button>
                  </span>
                </el-tooltip>
                <el-tooltip :disabled="purgeAllAvailability.ok" :content="purgeAllAvailability.reason ?? ''" placement="bottom">
                  <span>
                    <el-button size="small" type="danger" text :disabled="!purgeAllAvailability.ok" :loading="busyAction === 'purge'" @click="runPurgeAll">
                      清空隔离区
                    </el-button>
                  </span>
                </el-tooltip>
              </div>
            </div>

            <p v-if="quarantineBoundaryText" class="cc-hint quarantine-boundary">{{ quarantineBoundaryText }}</p>

            <div class="history-toolbar" role="search" aria-label="筛选隔离区">
              <el-input v-model="quarantineQuery" size="small" clearable placeholder="搜索原始路径 / 任务" style="width: 200px" aria-label="搜索隔离项" />
              <el-select v-model="quarantineTaskId" size="small" style="width: 150px" aria-label="按任务筛选隔离项">
                <el-option label="全部任务" value="all" />
                <el-option v-for="option in quarantineTaskOptions" :key="option.value" :label="option.label" :value="option.value" />
              </el-select>
              <el-tag v-if="quarantineSessionId" type="info" closable class="session-filter" @close="dismissQuarantineSessionFilter">
                仅看会话 {{ quarantineSessionId }}
              </el-tag>
              <el-button size="small" text :disabled="!quarantineFiltersActive" @click="resetQuarantineFilters">重置筛选</el-button>
              <span class="cc-faint">显示 {{ filteredQuarantineRows.length }} / {{ quarantineRows.length }} 项</span>
            </div>

            <el-alert v-if="feedback" class="history-alert" :type="feedback.tone" show-icon aria-live="polite" @close="dismissFeedback">
              <template #title>{{ feedback.title }}</template>
              <p v-if="feedback.message" class="report-message">{{ feedback.message }}</p>
              <ul v-if="feedback.details && feedback.details.length" class="report-list">
                <li v-for="(line, index) in feedback.details" :key="index">{{ line }}</li>
              </ul>
            </el-alert>

            <el-table
              ref="quarantineTableRef"
              :data="quarantineDisplayRows"
              size="small"
              :aria-busy="quarantineEmpty === 'loading'"
              @selection-change="onQuarantineSelectionChange"
            >
              <template #empty>
                <div class="empty-state" :aria-busy="quarantineEmpty === 'loading'">
                  <div class="empty-icon" aria-hidden="true">{{ quarantineEmptyView.icon }}</div>
                  <h4>{{ quarantineEmptyView.title }}</h4>
                  <p class="cc-muted">{{ quarantineEmptyView.description }}</p>
                  <div class="cc-actions empty-actions">
                    <el-button v-if="quarantineEmptyView.showClean" type="primary" size="small" @click="goClean">去扫描与清理</el-button>
                    <el-button v-if="quarantineEmptyView.showHistory" size="small" @click="goHistoryTab">查看清理历史</el-button>
                    <el-button v-if="quarantineEmptyView.showReset" size="small" @click="resetQuarantineFilters">重置筛选</el-button>
                    <el-button v-if="quarantineEmptyView.showRetry" size="small" :loading="refreshing" @click="runRefresh">重试</el-button>
                  </div>
                </div>
              </template>
              <el-table-column type="selection" width="44" />
              <el-table-column label="原始路径" min-width="300">
                <template #default="{ row }">
                  <div class="cc-path" :title="row.originalPath">{{ row.originalPath || '（原始路径缺失）' }}</div>
                  <div class="cc-faint quarantine-meta">
                    {{ row.taskLabel }}<span v-if="row.sessionId"> · 会话 {{ row.sessionId }}</span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="大小" width="100" align="right">
                <template #default="{ row }"><span class="cc-mono">{{ formatBytes(row.bytes) }}</span></template>
              </el-table-column>
              <el-table-column label="隔离时间" width="150">
                <template #default="{ row }">
                  <span v-if="row.createdAtValid">{{ row.timeText }}</span>
                  <span v-else class="cc-faint" title="该记录的时间戳无效或缺失">时间未知</span>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="150">
                <template #default="{ row }">
                  <el-button
                    size="small"
                    text
                    :disabled="busyAction !== null"
                    :aria-label="'恢复隔离项：' + (row.originalPath || row.id)"
                    @click="runRestore([row.id])"
                  >
                    恢复
                  </el-button>
                  <el-button
                    size="small"
                    text
                    :disabled="!row.originalPath"
                    :aria-label="'在资源管理器中打开原始位置：' + (row.originalPath || row.id)"
                    @click="openQuarantinePath(row)"
                  >
                    位置
                  </el-button>
                </template>
              </el-table-column>
            </el-table>
          </el-tab-pane>
        </el-tabs>
      </div>
    </template>
  </div>
</template>

<style scoped>
.history-alert {
  margin-bottom: 2px;
}

.undo-boundary {
  margin: -8px 0 0;
}

.alert-actions {
  margin-top: 8px;
}

.history-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.history-filter-summary {
  margin: 0 0 10px;
}

.tab-count {
  margin-left: 5px;
  font-size: 11.5px;
  color: var(--cc-text-faint);
}

.selected-hint {
  white-space: nowrap;
}

.task-labels {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}

.text-danger {
  color: var(--cc-danger);
}

.text-warning {
  color: var(--cc-warning);
}

.history-detail {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 22px;
  padding: 6px 18px;
  color: var(--cc-text-dim);
  font-size: 12px;
}

.history-detail b {
  color: var(--cc-text);
  margin-right: 6px;
  font-weight: 500;
}

.history-detail-wide {
  flex-basis: 100%;
}

.history-quarantine-link {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 6px 18px 2px;
  font-size: 12.5px;
  color: var(--cc-text-dim);
}

.quarantine-boundary {
  margin: 0 0 10px;
}

.quarantine-meta {
  margin-top: 2px;
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-filter {
  max-width: 280px;
}

.report-message {
  margin: 4px 0 0;
}

.report-list {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--cc-text-dim);
  word-break: break-all;
}

/* 空状态 */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 26px 16px;
  text-align: center;
}

.empty-icon {
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  font-size: 24px;
  border-radius: 16px;
  background: var(--cc-primary-soft);
}

.empty-state h4 {
  margin: 4px 0 0;
}

.empty-state p {
  margin: 0;
  max-width: 560px;
}

.empty-actions {
  justify-content: center;
  margin-top: 4px;
}

/* 整页错误态 */
.history-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 42px 24px;
  text-align: center;
}

.history-error h3 {
  margin: 0;
}

.history-error p {
  margin: 0;
  max-width: 520px;
}

.history-error-icon {
  font-size: 34px;
}

@media (max-width: 900px) {
  .history-toolbar {
    align-items: stretch;
  }

  .history-toolbar :deep(.el-input),
  .history-toolbar :deep(.el-select) {
    width: 100% !important;
  }
}
</style>
