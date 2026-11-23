<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { LogEntry } from '@cordclean/shared'
import {
  authorizeScheduler,
  clearEgress,
  revokeScheduler,
  runSchedulerNow,
  refreshPlugins,
  savePluginConfig,
  setPluginEnabled,
  exportDiagnostics,
  exportDiagnosticsJson,
  fetchLogEntries,
  fetchLogInfo,
  openLogDir,
  clearHistory,
  openDataDir,
  openPath,
  patchSettings,
  purgeQuarantine,
  state,
} from '../api/store.ts'
import SectionIcon from '../components/SectionIcon.vue'
import {
  SETTINGS_FIELDS,
  SETTINGS_GROUPS,
  assessSettingRisks,
  buildFieldStatuses,
  describeEmptyFilter,
  describeRiskConfirm,
  describeSaveFailure,
  diffFormValues,
  filterSettingsGroups,
  previewResetDefaults,
  riskEscalations,
  saveGate,
  saveSuccessMessage,
  settingsFormSnapshot,
  settingsPagePhase,
  summarizeSettingsStatus,
  type SaveFailureInfo,
  type SettingsGroupId,
} from './settings-view-model.ts'

const form = reactive({
  cleanMode: 'recycle' as 'recycle' | 'quarantine' | 'delete',
  highRiskQuarantine: true,
  quarantineFallback: false,
  dryRunDefault: false,
  confirmRisky: true,
  retries: 2,
  budgetFiles: 50_000,
  budgetGb: 20,
  concurrency: 4,
  maxItemsPerTask: 20_000,
  maxEntriesPerTask: 200_000,
  maxDepth: 32,
  largeFileThresholdMb: 100,
  duplicateMinSizeMb: 1,
  roots: [] as string[],
  excludes: [] as string[],
  includeSystem: true,
  includeRisky: false,
  includeDeep: false,
  includeCustom: true,
  quarantineEnabled: true,
  quarantineMaxMb: 2048,
  quarantineMaxFiles: 20_000,
  retentionDays: 0,
  onlineAi: true,
  editorCommand: '',
})

const newRoot = ref('')
const newExclude = ref('')
const saving = ref(false)
const importText = ref('')
const importOpen = ref(false)

/* -------------------- 设置页升级：搜索 / 未保存提示 / 风险说明 -------------------- */
const searchQuery = ref('')
const onlyDirty = ref(false)
const searchFocused = ref(false)
const searchInput = ref<HTMLInputElement>()
const saveFailure = ref<SaveFailureInfo>()
const savedSnapshot = computed(() => (state.settings ? settingsFormSnapshot(state.settings) : undefined))
/** 当前表单 vs 内核已保存设置：脏状态与修改摘要的唯一来源 */
const changes = computed(() => (state.settings ? diffFormValues(form, savedSnapshot.value) : []))
const risks = computed(() => assessSettingRisks(form))
const fieldStatusesForSummary = computed(() => buildFieldStatuses(form, savedSnapshot.value))
const statusSummary = computed(() => summarizeSettingsStatus(fieldStatusesForSummary.value, risks.value))

/** 非默认字段的来源角标（默认 / 已自定义 / 未保存），来自模型层 buildFieldStatuses */
const fieldLabelOf = new Map(SETTINGS_FIELDS.map((field) => [field.key, field.label]))
const nonDefaultFieldChips = computed(() =>
  Object.values(fieldStatusesForSummary.value)
    .filter((status) => status.origin !== 'default')
    .map((status) => ({
      key: status.key,
      label: fieldLabelOf.get(status.key) ?? status.key,
      text: status.text,
      title: status.title,
      origin: status.origin,
    })),
)
const dirtyGroupIds = computed(() =>
  SETTINGS_GROUPS.filter((group) => changes.value.some((change) => change.group === group.id)).map((group) => group.id),
)
const filterResult = computed(() =>
  filterSettingsGroups({ query: searchQuery.value, onlyDirty: onlyDirty.value, dirtyGroups: dirtyGroupIds.value }),
)
const visibleGroups = computed(() => new Set<string>(filterResult.value.visible))
const visibleGroupMeta = computed(() => SETTINGS_GROUPS.filter((group) => visibleGroups.value.has(group.id)))
const emptyFilter = computed(() => describeEmptyFilter(filterResult.value))
const pagePhase = computed(() =>
  settingsPagePhase({ ready: state.ready, hasSettings: Boolean(state.settings), loadError: state.error }),
)
const saveState = computed(() => saveGate({ phase: pagePhase.value, saving: saving.value, changeCount: changes.value.length }))

function clearSearch(): void {
  searchQuery.value = ''
  onlyDirty.value = false
}

function onSearchEsc(): void {
  if (searchQuery.value || onlyDirty.value) clearSearch()
  else searchInput.value?.blur()
}

/** 搜索命中/风险定位：必要时先清空过滤，再滚动到分组并把焦点移过去（键盘可达） */
function jumpToGroup(groupId: SettingsGroupId): void {
  if (!visibleGroups.value.has(groupId)) clearSearch()
  void nextTick(() => {
    const el = document.getElementById(`settings-group-${groupId}`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    el.focus({ preventScroll: true })
  })
}

async function discardChanges(): Promise<void> {
  if (!changes.value.length) return
  try {
    await ElMessageBox.confirm(`放弃 ${changes.value.length} 项未保存的修改？页面会恢复为内核中已保存的值。`, '放弃修改', {
      type: 'warning',
      confirmButtonText: '放弃修改',
    })
  } catch {
    return
  }
  syncFromSettings()
  saveFailure.value = undefined
  ElMessage.success('已放弃未保存的修改')
}
const schedulerPlugin = computed(() => state.plugins.find((plugin) => plugin.id === 'scheduler'))

/** 插件目录 = 数据目录/plugins */
const pluginsDir = computed(() => {
  const dir = state.app?.dataDir
  if (!dir) return ''
  return dir.replace(/[\\/]+$/, '') + '\\plugins'
})
const enabledPluginCount = computed(() => state.plugins.filter((plugin) => plugin.enabled).length)
const packagePluginCount = computed(
  () => state.plugins.filter((plugin) => plugin.manifest && plugin.id.startsWith('external:')).length,
)

/** 定时计划（新格式为 settings.plugins.scheduler.config.plans；旧配置回退为单计划） */
interface SchedulerPlan {
  id: string
  name: string
  enabled: boolean
  daily: boolean
  everyMinutes: number
  atHour: number
  atMinute: number
  taskIds: string[]
  mode: 'scan' | 'clean'
  authorizedHash: string
}

const plans = computed<SchedulerPlan[]>(() => {
  const config = (schedulerPlugin.value?.config ?? {}) as Record<string, any>
  if (Array.isArray(config.plans) && config.plans.length) return config.plans as SchedulerPlan[]
  return [{
    id: 'default',
    name: '默认计划',
    enabled: config.enabled === true,
    daily: config.daily === true,
    everyMinutes: config.everyMinutes ?? 120,
    atHour: config.atHour ?? 3,
    atMinute: config.atMinute ?? 0,
    taskIds: config.taskIds ?? [],
    mode: config.mode === 'clean' ? 'clean' : 'scan',
    authorizedHash: config.authorizedHash ?? '',
  }]
})
const selectedPlanId = ref('default')
const selectedPlan = computed(() => plans.value.find((plan) => plan.id === selectedPlanId.value) ?? plans.value[0])

const schedule = reactive({
  name: '',
  enabled: false,
  daily: false,
  everyMinutes: 120,
  atHour: 3,
  atMinute: 0,
  taskIds: [] as string[],
  mode: 'scan' as 'scan' | 'clean',
  authorizedHash: '',
})

// 选中计划变化或插件配置刷新时，把该计划回填到编辑表单
watch(
  () => selectedPlan.value,
  (plan) => {
    if (!plan) return
    Object.assign(schedule, {
      name: String(plan.name ?? ''),
      enabled: plan.enabled === true,
      daily: plan.daily === true,
      everyMinutes: Number(plan.everyMinutes ?? 120),
      atHour: Number(plan.atHour ?? 3),
      atMinute: Number(plan.atMinute ?? 0),
      taskIds: Array.isArray(plan.taskIds) ? [...plan.taskIds] : [],
      mode: plan.mode === 'clean' ? 'clean' : 'scan',
      authorizedHash: String(plan.authorizedHash ?? ''),
    })
  },
  { deep: true, immediate: true },
)

// 从插件页“加入定时任务”跳转过来时，把该插件的任务预选进当前计划
function applyPendingSchedulerTasks() {
  try {
    const raw = localStorage.getItem('cordclean.scheduler.pendingTasks')
    if (!raw) return
    localStorage.removeItem('cordclean.scheduler.pendingTasks')
    const ids = JSON.parse(raw)
    if (!Array.isArray(ids)) return
    const valid = ids.filter((id): id is string => typeof id === 'string' && state.tasks.some((task) => task.id === id))
    if (!valid.length) return
    schedule.taskIds = [...new Set([...schedule.taskIds, ...valid])]
    ElMessage.success(`已加入 ${valid.length} 个插件任务，点「保存」后生效`)
  } catch {
    /* 忽略损坏的本地草稿 */
  }
}
onMounted(() => {
  void nextTick(applyPendingSchedulerTasks)
})

async function saveSchedule() {
  if (!schedulerPlugin.value) {
    ElMessage.warning('插件页没有找到「定时扫描」插件')
    return
  }
  const planName = schedule.name.trim()
  if (!planName) {
    ElMessage.warning('请先填写任务名称')
    return
  }
  try {
    if (!schedulerPlugin.value.enabled) await setPluginEnabled('scheduler', true)
    const current = (schedulerPlugin.value.config ?? {}) as any
    const nextPlans = plans.value.map((plan) =>
      plan.id === selectedPlanId.value
        ? {
            ...plan,
            name: planName,
            enabled: schedule.enabled,
            daily: schedule.daily,
            everyMinutes: schedule.everyMinutes,
            atHour: schedule.atHour,
            atMinute: schedule.atMinute,
            taskIds: schedule.taskIds,
            mode: schedule.mode,
          }
        : plan,
    )
    await savePluginConfig('scheduler', { ...current, plans: nextPlans })
    await refreshPlugins()
    ElMessage.success('定时任务已保存')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function createPlan() {
  const config = (schedulerPlugin.value?.config ?? {}) as any
  // 默认给一个可读的候选名，用户可改成任意自定义名称；不再固定叫「新计划」
  const defaultName = `定时任务 ${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`
  let name = ''
  try {
    const result = await ElMessageBox.prompt('给这个定时任务起个名字（之后也能在表单里改）', '新建定时任务', {
      confirmButtonText: '创建',
      cancelButtonText: '取消',
      inputValue: defaultName,
      inputPlaceholder: '例如：每周清理开发缓存',
      inputValidator: (value: string) => {
        const trimmed = String(value ?? '').trim()
        if (!trimmed) return '名称不能为空'
        if (trimmed.length > 40) return '名称最多 40 个字符'
        return true
      },
    } as any)
    name = String(result.value ?? '').trim()
  } catch {
    return
  }
  if (!name) return
  const id = 'plan-' + Date.now().toString(36)
  const plan = { id, name, enabled: false, daily: false, everyMinutes: 120, atHour: 3, atMinute: 0, taskIds: [], mode: 'scan', authorizedHash: '' }
  await savePluginConfig('scheduler', { ...config, plans: [...plans.value, plan] })
  await refreshPlugins()
  selectedPlanId.value = id
  ElMessage.success(`已创建定时任务「${name}」`)
}

async function removePlan() {
  if (plans.value.length <= 1) return
  try {
    await ElMessageBox.confirm('删除任务「' + (selectedPlan.value?.name ?? '') + '」？', '删除任务', { type: 'warning' })
    const remaining = plans.value.filter((plan) => plan.id !== selectedPlanId.value)
    await savePluginConfig('scheduler', { ...(schedulerPlugin.value?.config ?? {}), plans: remaining })
    await refreshPlugins()
    selectedPlanId.value = remaining[0]?.id ?? 'default'
  } catch {}
}

async function authorizeSchedule() {
  try {
    await authorizeScheduler({ ...schedule, planId: selectedPlanId.value })
    await refreshPlugins()
    ElMessage.success('已授权自动清理（规则变化后需重新授权）')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function revokeSchedule() {
  try {
    await revokeScheduler(selectedPlanId.value)
    await refreshPlugins()
    ElMessage.success('已清除授权，改为仅通知')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function runScheduleNow() {
  try {
    await runSchedulerNow(selectedPlanId.value)
    ElMessage.success('已触发一次，完成后会弹通知')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

const logsOpen = ref(false)
const logEntries = ref<LogEntry[]>([])
const loadingLogs = ref(false)
const logLevelFilter = ref<'all' | 'error' | 'warn' | 'info' | 'debug'>('all')
const logScopeFilter = ref('all')
const logSearch = ref('')
const logPaused = ref(false)
const logLive = ref(false)
const logAutoRefresh = ref(false)
const logInfo = ref<{ file: string; bytes: number } | null>(null)
let logTimer: ReturnType<typeof setInterval> | undefined

const logScopes = computed(() => {
  const scopes = new Set<string>()
  for (const entry of logEntries.value) scopes.add(entry.scope)
  return [...scopes].sort()
})

const displayEntries = computed<LogEntry[]>(() => (logLive.value ? state.logs.slice(0, 1000) : logEntries.value))

const filteredEntries = computed(() => {
  const keyword = logSearch.value.trim().toLowerCase()
  const level = logLevelFilter.value
  const scope = logScopeFilter.value
  return displayEntries.value
    .filter((entry) => (level === 'all' ? true : entry.level === level))
    .filter((entry) => (scope === 'all' ? true : entry.scope === scope))
    .filter((entry) => {
      if (!keyword) return true
      const haystack = `${entry.message} ${entry.scope} ${JSON.stringify(entry.fields ?? {})}`.toLowerCase()
      return haystack.includes(keyword)
    })
    .slice(-1000)
})

const logBytesText = computed(() => {
  const bytes = logInfo.value?.bytes ?? 0
  if (!bytes) return '—'
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`
})

function levelClass(level: LogEntry['level']): string {
  return level === 'error' ? 'log-error' : level === 'warn' ? 'log-warn' : level === 'debug' ? 'log-debug' : 'log-info'
}

function formatLogTime(ts: string): string {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ts
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function formatFields(entry: LogEntry): string {
  if (!entry.fields || !Object.keys(entry.fields).length) return ''
  const text = JSON.stringify(entry.fields)
  return text.length > 180 ? text.slice(0, 180) + '…' : text
}

function formatEntry(entry: LogEntry): string {
  const fields = entry.fields && Object.keys(entry.fields).length ? ' ' + JSON.stringify(entry.fields) : ''
  return `${entry.ts} [${entry.level}] [${entry.scope}]${entry.requestId ? ` [${entry.requestId}]` : ''} ${entry.message}${fields}`
}

async function refreshLogs(): Promise<void> {
  if (logPaused.value) return
  try {
    const [entries, info] = await Promise.all([fetchLogEntries(1000), fetchLogInfo()])
    logEntries.value = entries
    logInfo.value = info
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

function stopLogTimer(): void {
  if (logTimer) clearInterval(logTimer)
  logTimer = undefined
  logAutoRefresh.value = false
}

function toggleLogAutoRefresh(): void {
  if (logAutoRefresh.value) {
    stopLogTimer()
    return
  }
  logAutoRefresh.value = true
  logLive.value = false
  logTimer = setInterval(() => {
    if (document.visibilityState !== 'hidden' && !logPaused.value) void refreshLogs()
  }, 3000)
}

function toggleLogLive(): void {
  if (logLive.value) {
    stopLogTimer()
    logEntries.value = state.logs.slice(0, 1000)
  } else {
    void refreshLogs()
  }
}

async function copyLogs(): Promise<void> {
  try {
    await navigator.clipboard.writeText(filteredEntries.value.map(formatEntry).join('\n'))
    ElMessage.success(`已复制 ${filteredEntries.value.length} 条日志`)
  } catch (error) {
    ElMessage.error('复制失败：' + (error instanceof Error ? error.message : String(error)))
  }
}

/* 日志设置（运行时生效） */
const logConfig = reactive({
  level: 'info' as 'debug' | 'info' | 'warn' | 'error',
  maxBytesMb: 5,
  keep: 2,
  retainDays: 14,
  dedupeWindowMs: 3000,
  pluginLevels: {} as Record<string, 'debug' | 'info' | 'warn' | 'error' | ''>,
})
const savingLogConfig = ref(false)

function syncLogConfig(): void {
  const settings = state.settings?.logging
  if (!settings) return
  logConfig.level = settings.level
  logConfig.maxBytesMb = Math.round((settings.maxBytes / 1024 / 1024) * 10) / 10
  logConfig.keep = settings.keep
  logConfig.retainDays = settings.retainDays
  logConfig.dedupeWindowMs = settings.dedupeWindowMs ?? 3000
  const nextLevels: Record<string, 'debug' | 'info' | 'warn' | 'error' | ''> = {}
  for (const plugin of state.plugins) {
    nextLevels[plugin.id] = (settings.pluginLevels?.[plugin.id] as any) ?? ''
  }
  logConfig.pluginLevels = nextLevels
}

async function applyLogSettings(): Promise<void> {
  savingLogConfig.value = true
  try {
    const pluginLevels = Object.fromEntries(
      Object.entries(logConfig.pluginLevels).filter(([, value]) => value !== ''),
    )
    await patchSettings({
      logging: {
        level: logConfig.level,
        maxBytes: Math.round(logConfig.maxBytesMb * 1024 * 1024),
        keep: logConfig.keep,
        retainDays: logConfig.retainDays,
        dedupeWindowMs: logConfig.dedupeWindowMs,
        pluginLevels,
      },
    })
    ElMessage.success('日志设置已应用（立即生效）')
    syncLogConfig()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    savingLogConfig.value = false
  }
}

onUnmounted(stopLogTimer)

function syncFromSettings() {
  const s = state.settings
  if (!s) return
  syncLogConfig()
  // 与展示模型共用同一套映射，避免「表单值 vs 已保存值」因为换算精度出现假脏状态
  Object.assign(form, settingsFormSnapshot(s))
  saveFailure.value = undefined
}

watch(() => state.settings, syncFromSettings, { immediate: true })

function addRoot() {
  const value = newRoot.value.trim()
  if (!value) return
  if (!/^[a-zA-Z]:[\\/]/.test(value) && !value.startsWith('\\\\')) {
    ElMessage.warning('请输入绝对路径，例如 D:\\Videos')
    return
  }
  if (!form.roots.includes(value)) form.roots.push(value)
  newRoot.value = ''
}

function addExclude() {
  const value = newExclude.value.trim()
  if (!value) return
  if (!form.excludes.includes(value)) form.excludes.push(value)
  newExclude.value = ''
}

function buildPatch() {
  return {
    scan: {
      concurrency: form.concurrency,
      maxItemsPerTask: form.maxItemsPerTask,
      maxEntriesPerTask: form.maxEntriesPerTask,
      maxDepth: form.maxDepth,
      largeFileThreshold: form.largeFileThresholdMb * 1024 * 1024,
      duplicateMinSize: form.duplicateMinSizeMb * 1024 * 1024,
    },
    clean: {
      mode: form.cleanMode,
      highRiskQuarantine: form.highRiskQuarantine,
      quarantineFallback: form.quarantineFallback,
      dryRunDefault: form.dryRunDefault,
      confirmRisky: form.confirmRisky,
      retries: form.retries,
      budget: {
        maxFiles: form.budgetFiles,
        maxBytes: Math.round(form.budgetGb * 1024 * 1024 * 1024),
      },
    },
    rules: {
      includeRisky: form.includeRisky,
      includeDeep: form.includeDeep,
      includeCustom: form.includeCustom,
    },
    quarantine: {
      enabled: form.quarantineEnabled,
      maxBytes: form.quarantineMaxMb * 1024 * 1024,
      maxFiles: form.quarantineMaxFiles,
      retentionDays: form.retentionDays,
    },
    analysis: {
      roots: form.roots,
      excludes: form.excludes,
      includeSystem: form.includeSystem,
    },
    privacy: { onlineAi: form.onlineAi },
    ui: { editorCommand: form.editorCommand },
  }
}

async function save() {
  if (!saveState.value.ok) {
    if (saveState.value.reason && changes.value.length === 0) ElMessage.info(saveState.value.reason)
    return
  }
  // 危险变更（放宽安全限制）保存前二次确认：只提示本次新增的风险，不阻断用户
  const escalations = riskEscalations(buildPatch(), state.settings)
  const riskConfirm = describeRiskConfirm(escalations)
  if (riskConfirm) {
    try {
      await ElMessageBox.confirm(riskConfirm, '确认放宽安全限制', {
        type: 'warning',
        confirmButtonText: '仍要保存',
        cancelButtonText: '取消',
      })
    } catch {
      return
    }
  }
  const pendingCount = changes.value.length
  saving.value = true
  saveFailure.value = undefined
  try {
    await patchSettings(buildPatch())
    ElMessage.success(saveSuccessMessage(pendingCount))
  } catch (error) {
    // 结构化失败原因：保留本页修改，给建议与重试入口
    saveFailure.value = describeSaveFailure(error)
    ElMessage.error(saveFailure.value.title)
  } finally {
    saving.value = false
  }
}

async function resetDefaults() {
  // 恢复默认前先预览：明确会改哪些项、哪些项不会被重置
  const preview = previewResetDefaults(buildPatch())
  if (!preview.changes.length) {
    ElMessage.info(`当前设置已经是默认值（${preview.alreadyDefault} 项），无需重置`)
    return
  }
  const sample = preview.changes.slice(0, 8).map((change) => `${change.label} ${change.from} → ${change.to}`)
  const more = preview.changes.length > sample.length ? ` 等 ${preview.changes.length} 项` : ''
  try {
    await ElMessageBox.confirm(
      `将重置 ${preview.changes.length} 项：${sample.join('；')}${more}。` +
        `已是默认值的 ${preview.alreadyDefault} 项不变；扫描范围、排除项、编辑器命令等不会被重置。` +
        '历史、隔离区、规则文件不受影响。',
      '恢复默认设置',
      { type: 'warning', confirmButtonText: '恢复默认' },
    )
  } catch {
    return
  }
  form.concurrency = 4
  form.maxItemsPerTask = 20_000
  form.maxEntriesPerTask = 200_000
  form.maxDepth = 32
  form.largeFileThresholdMb = 100
  form.duplicateMinSizeMb = 1
  form.cleanMode = 'recycle'
  form.highRiskQuarantine = true
  form.quarantineFallback = false
  form.dryRunDefault = false
  form.confirmRisky = true
  form.retries = 2
  form.budgetFiles = 50_000
  form.budgetGb = 20
  form.includeRisky = false
  form.includeDeep = false
  form.includeCustom = true
  form.quarantineEnabled = true
  form.quarantineMaxMb = 2048
  form.quarantineMaxFiles = 20_000
  form.retentionDays = 0
  form.includeSystem = true
  form.onlineAi = true
  await save()
}

function exportSettings() {
  const blob = new Blob([JSON.stringify(state.settings, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'cordclean-settings.json'
  link.click()
  URL.revokeObjectURL(url)
  ElMessage.success('设置已导出为 cordclean-settings.json')
}

function openImport() {
  importText.value = ''
  importOpen.value = true
}

async function doImport() {
  try {
    const parsed = JSON.parse(importText.value)
    if (!parsed || typeof parsed !== 'object') throw new Error('不是合法的设置 JSON')
    await patchSettings(parsed)
    importOpen.value = false
    ElMessage.success('设置已导入并生效')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function pickImportFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  importText.value = await file.text()
}

async function openPluginsDirectory() {
  try {
    await openPath(pluginsDir.value)
    ElMessage.success('已打开插件目录')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function copyEnvInfo() {
  const app = state.app
  const lines = [
    `CordClean ${app?.version ?? 'unknown'}`,
    `shell=${app?.shell ?? (state.transport?.kind === 'electron' ? 'desktop' : 'web')}`,
    `platform=${app?.platformLabel ?? app?.platform ?? 'unknown'} ${app?.osVersion ?? ''} ${app?.arch ?? ''}`.trim(),
    `node=${app?.node ?? 'unknown'}${app?.systemNode ? ` (system ${app.systemNode})` : ''}`,
    app?.electron ? `electron=${app.electron}` : '',
    `protocol=${app?.protocolVersion ?? 'unknown'}`,
    `bootMs=${app?.bootMs ?? 'unknown'}`,
    `dataDir=${app?.dataDir ?? 'unknown'}`,
    `plugins=${state.plugins.length} (enabled ${enabledPluginCount.value}, packages ${packagePluginCount.value})`,
  ].filter(Boolean)
  try {
    await navigator.clipboard.writeText(lines.join('\n'))
    ElMessage.success('环境信息已复制到剪贴板')
  } catch (error) {
    ElMessage.error('复制失败：' + (error instanceof Error ? error.message : String(error)))
  }
}

async function revealDataDir() {
  try {
    const dir = await openDataDir()
    ElMessage.success(`已打开数据目录：${dir}`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function doClearHistory() {
  try {
    await ElMessageBox.confirm('清空历史记录不会删除回收站/隔离区里的文件。', '清空历史', { type: 'warning' })
    await clearHistory()
    ElMessage.success('历史已清空')
  } catch (error) {
    if (error !== 'cancel') ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function doPurgeQuarantine() {
  try {
    await ElMessageBox.confirm('将永久删除隔离区里的所有文件，且不可恢复。', '清空隔离区', { type: 'error' })
    await purgeQuarantine()
    ElMessage.success('隔离区已清空')
  } catch (error) {
    if (error !== 'cancel') ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function viewLogs() {
  logsOpen.value = true
  loadingLogs.value = true
  logPaused.value = false
  syncLogConfig()
  try {
    const [entries, info] = await Promise.all([fetchLogEntries(1000), fetchLogInfo()])
    logEntries.value = entries
    logInfo.value = info
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    loadingLogs.value = false
  }
}

async function exportJsonDiagnostics() {
  try {
    const file = await exportDiagnosticsJson()
    ElMessage.success('结构化诊断已导出：' + file)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function openLogDirectory() {
  try {
    await openLogDir()
    ElMessage.success('已打开日志目录')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function exportDiag() {
  try {
    const file = await exportDiagnostics()
    ElMessage.success('诊断报告已导出：' + file)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function doClearEgress() {
  try {
    await clearEgress()
    ElMessage.success('外发记录已清空')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}
</script>

<template>
  <div class="cc-page">
    <div class="cc-page-title">
      <div>
        <h1>设置</h1>
        <p>清理行为、扫描性能、规则库、隔离区与隐私开关都在这里集中管理。</p>
      </div>
      <div class="cc-actions">
        <el-button @click="resetDefaults">恢复默认</el-button>
        <el-button @click="exportSettings">导出</el-button>
        <el-button @click="openImport">导入</el-button>
        <el-button type="primary" :loading="saving" :disabled="!saveState.ok" :title="saveState.reason" @click="save">保存设置</el-button>
      </div>
    </div>

    <!-- 搜索/改动概览：长页面里先定位再修改 -->
    <div class="cc-card settings-toolbar">
      <div class="settings-toolbar-row">
        <div class="settings-search" :class="{ focused: searchFocused }">
          <span aria-hidden="true">🔍</span>
          <input
            ref="searchInput"
            v-model="searchQuery"
            type="search"
            class="settings-search-input"
            placeholder="搜索设置项，例如：隔离区、并发、回收站"
            aria-label="搜索设置项"
            autocomplete="off"
            spellcheck="false"
            @focus="searchFocused = true"
            @blur="searchFocused = false"
            @keydown.esc.prevent="onSearchEsc"
          />
          <button v-if="searchQuery" type="button" class="settings-search-clear" aria-label="清除搜索" @click="clearSearch">×</button>
        </div>
        <label class="settings-only-dirty">
          <input v-model="onlyDirty" type="checkbox" />
          只看未保存修改的分组
        </label>
        <span class="cc-faint" role="status">
          {{
            filterResult.active
              ? `显示 ${filterResult.visible.length} / ${filterResult.totalGroups} 个分组`
              : `共 ${filterResult.totalGroups} 个分组 · ${statusSummary.nonDefaultCount} 项非默认（${statusSummary.unsavedCount} 项未保存）`
          }}
        </span>
      </div>
      <div v-if="filterResult.active && visibleGroupMeta.length" class="settings-search-hits">
        <span class="cc-faint">跳到：</span>
        <button v-for="group in visibleGroupMeta" :key="group.id" type="button" class="settings-hit" @click="jumpToGroup(group.id)">
          <SectionIcon :name="group.icon" :size="14" /> {{ group.title
          }}<span v-if="filterResult.matches[group.id]?.length" class="settings-hit-count">{{ filterResult.matches[group.id]?.length }}</span>
        </button>
      </div>
    </div>

    <!-- 未保存修改：明确旧值仍在生效，并提供保存/放弃 -->
    <div v-if="statusSummary.unsavedCount > 0" class="cc-card settings-dirty" role="status">
      <div class="settings-dirty-main">
        <strong>有 {{ statusSummary.unsavedCount }} 项修改尚未保存</strong>
        <p class="cc-faint">未保存的修改只在本页生效；扫描/清理仍使用上次保存的值，离开本页会丢失这些修改。</p>
        <div class="settings-dirty-list">
          <span v-for="change in changes" :key="change.key" class="settings-change-chip">{{ change.label }}：{{ change.from }} → {{ change.to }}</span>
        </div>
      </div>
      <div class="cc-actions">
        <el-button size="small" @click="discardChanges">放弃修改</el-button>
        <el-button size="small" type="primary" :loading="saving" @click="save">保存修改</el-button>
      </div>
    </div>

    <!-- 字段来源角标：默认 / 已自定义 / 未保存（模型层 buildFieldStatuses），避免用户忘了改过什么 -->
    <div v-if="nonDefaultFieldChips.length" class="cc-card settings-origins" role="status" aria-live="polite">
      <div class="settings-origins-head">
        <strong>字段来源</strong>
        <span class="cc-faint">
          默认 {{ statusSummary.defaultCount }} 项 · 已自定义 {{ statusSummary.customCount }} 项 · 未保存 {{ statusSummary.unsavedCount }} 项
        </span>
        <span class="cc-faint">指到角标可看完整说明；未保存的项不会影响扫描/清理，直到保存。</span>
      </div>
      <div class="settings-origin-list">
        <span
          v-for="chip in nonDefaultFieldChips"
          :key="chip.key"
          class="settings-origin-chip"
          :class="'origin-' + chip.origin"
          :title="chip.title"
        >{{ chip.label }} · {{ chip.text }}</span>
      </div>
    </div>

    <!-- 危险设置说明：按当前表单值评估，保存后生效 -->
    <div v-if="risks.length" class="cc-card settings-risk" role="status" aria-live="polite">
      <div class="settings-risk-head">
        <h3><SectionIcon name="alert" /> 当前配置有 {{ risks.length }} 项风险提示</h3>
        <span class="cc-faint">按本页当前值评估，点「保存设置」后生效</span>
      </div>
      <ul class="settings-risk-list">
        <li v-for="risk in risks" :key="risk.id" class="settings-risk-item" :class="'risk-' + risk.level">
          <div class="settings-risk-line">
            <span class="cc-pill" :class="risk.level === 'danger' ? 'risk-risky' : 'risk-caution'">{{ risk.level === 'danger' ? '高风险' : '注意' }}</span>
            <strong>{{ risk.title }}</strong>
            <button type="button" class="link-button" @click="jumpToGroup(risk.group)">定位</button>
          </div>
          <p class="cc-muted">{{ risk.detail }}</p>
          <p class="cc-faint">建议：{{ risk.suggestion }}</p>
        </li>
      </ul>
    </div>

    <!-- 保存失败：结构化原因 + 建议 + 重试，不清空本页修改 -->
    <div v-if="saveFailure" class="cc-card settings-save-error" role="alert">
      <div class="settings-save-error-head">
        <div>
          <strong>⚠️ {{ saveFailure.title }}</strong>
          <p class="cc-muted">{{ saveFailure.reason }}</p>
          <p class="cc-faint">{{ saveFailure.hint }}</p>
        </div>
        <div class="cc-actions">
          <el-button v-if="saveFailure.retriable" size="small" type="primary" :loading="saving" @click="save">重试保存</el-button>
          <el-button size="small" @click="saveFailure = undefined">关闭</el-button>
        </div>
      </div>
    </div>

    <!-- 搜索/只看未保存后为空：区分两种空状态并给出口 -->
    <div v-if="filterResult.emptyReason" class="cc-card cc-empty settings-empty" role="status">
      <p>{{ emptyFilter.title }}</p>
      <p class="cc-faint">{{ emptyFilter.hint }}</p>
      <el-button size="small" type="primary" @click="clearSearch">清空筛选</el-button>
    </div>

    <div class="settings-grid">
      <div v-if="visibleGroups.has('schedule')" id="settings-group-schedule" tabindex="-1" class="cc-card schedule-card">
        <div class="cc-card-title">
          <h3><SectionIcon name="alarm" /> 定时任务</h3>
          <span class="cc-faint">按间隔或每天固定时间扫描；自动清理需授权，规则一变授权失效</span>
        </div>
        <p v-if="!schedulerPlugin" class="cc-hint">没有找到「定时扫描」插件：请到插件页启用它。</p>
        <template v-else>
          <div class="plan-row">
            <el-select v-model="selectedPlanId" size="small" style="width: 220px">
              <el-option v-for="plan in plans" :key="plan.id" :label="plan.name" :value="plan.id" />
            </el-select>
            <el-button size="small" @click="createPlan">新建任务</el-button>
            <el-button size="small" type="danger" plain :disabled="plans.length <= 1" @click="removePlan">删除任务</el-button>
            <span class="cc-faint">{{ plans.length }} 个任务</span>
          </div>
          <el-form label-position="left" label-width="120px" size="small" class="schedule-form">
            <el-form-item label="任务名称">
              <el-input v-model="schedule.name" maxlength="40" show-word-limit placeholder="例如：每周清理开发缓存" />
            </el-form-item>
            <el-form-item label="启用"><el-switch v-model="schedule.enabled" /></el-form-item>
            <el-form-item label="执行方式">
              <el-radio-group v-model="schedule.daily">
                <el-radio-button :value="false">按间隔</el-radio-button>
                <el-radio-button :value="true">每天固定时间</el-radio-button>
              </el-radio-group>
            </el-form-item>
            <el-form-item v-if="!schedule.daily" label="间隔（分钟）">
              <el-input-number v-model="schedule.everyMinutes" :min="15" :max="1440" :step="15" />
            </el-form-item>
            <el-form-item v-else label="每天时间">
              <el-input-number v-model="schedule.atHour" :min="0" :max="23" />
              <span class="time-sep">:</span>
              <el-input-number v-model="schedule.atMinute" :min="0" :max="59" />
            </el-form-item>
            <el-form-item label="任务范围">
              <el-select v-model="schedule.taskIds" multiple collapse-tags clearable placeholder="留空 = 全部任务" style="width: 100%">
                <el-option v-for="task in state.tasks" :key="task.id" :label="task.name" :value="task.id" />
              </el-select>
            </el-form-item>
            <el-form-item label="模式">
              <el-radio-group v-model="schedule.mode">
                <el-radio value="scan">只扫描并通知</el-radio>
                <el-radio value="clean">自动清理安全项（需授权）</el-radio>
              </el-radio-group>
            </el-form-item>
            <el-form-item label="授权状态">
              <span v-if="schedule.authorizedHash">已授权 · 指纹 {{ schedule.authorizedHash }}</span>
              <span v-else class="cc-faint">未授权（自动清理会被跳过）</span>
            </el-form-item>
          </el-form>
          <div class="schedule-actions">
            <el-button type="primary" @click="saveSchedule">保存</el-button>
            <el-button @click="runScheduleNow">立即运行</el-button>
            <el-button type="warning" plain @click="authorizeSchedule">授权自动清理</el-button>
            <el-button @click="revokeSchedule">清除授权</el-button>
          </div>
        </template>
      </div>

      <div v-if="visibleGroups.has('clean')" id="settings-group-clean" tabindex="-1" class="cc-card">
        <div class="cc-card-title"><h3><SectionIcon name="broom" /> 清理行为</h3><span class="cc-faint">删除方式与安全边界</span></div>
        <el-form label-position="left" label-width="170px" size="small">
          <el-form-item label="默认删除方式">
            <el-select v-model="form.cleanMode" style="width: 220px">
              <el-option label="回收站（可还原）" value="recycle" />
              <el-option label="隔离区（可恢复）" value="quarantine" />
              <el-option label="永久删除" value="delete" />
            </el-select>
          </el-form-item>
          <el-form-item label="高风险项进隔离区"><el-switch v-model="form.highRiskQuarantine" /></el-form-item>
          <el-form-item label="回收站不可用时回落隔离区"><el-switch v-model="form.quarantineFallback" /></el-form-item>
          <el-form-item label="默认仅预演"><el-switch v-model="form.dryRunDefault" /></el-form-item>
          <el-form-item label="高风险需确认"><el-switch v-model="form.confirmRisky" /></el-form-item>
          <el-form-item label="失败重试次数"><el-input-number v-model="form.retries" :min="0" :max="5" /></el-form-item>
          <el-form-item label="单次清理项上限"><el-input-number v-model="form.budgetFiles" :min="100" :step="1000" /></el-form-item>
          <el-form-item label="单次容量上限（GB）"><el-input-number v-model="form.budgetGb" :min="1" :max="500" :step="1" /></el-form-item>
        </el-form>
      </div>

      <div v-if="visibleGroups.has('scan')" id="settings-group-scan" tabindex="-1" class="cc-card">
        <div class="cc-card-title"><h3><SectionIcon name="bolt" /> 扫描与性能</h3><span class="cc-faint">并发与上限影响速度与内存</span></div>
        <el-form label-position="left" label-width="170px" size="small">
          <el-form-item label="任务并发度"><el-input-number v-model="form.concurrency" :min="1" :max="8" /></el-form-item>
          <el-form-item label="单任务最多清理项"><el-input-number v-model="form.maxItemsPerTask" :min="100" :step="1000" /></el-form-item>
          <el-form-item label="单任务遍历条目上限"><el-input-number v-model="form.maxEntriesPerTask" :min="1000" :step="10000" /></el-form-item>
          <el-form-item label="最大递归深度"><el-input-number v-model="form.maxDepth" :min="1" :max="128" /></el-form-item>
          <el-form-item label="大文件阈值（MB）"><el-input-number v-model="form.largeFileThresholdMb" :min="1" :step="10" /></el-form-item>
          <el-form-item label="重复文件最小体积（MB）"><el-input-number v-model="form.duplicateMinSizeMb" :min="0" :step="1" /></el-form-item>
          <el-form-item label="包含系统级目录"><el-switch v-model="form.includeSystem" /></el-form-item>
        </el-form>
      </div>

      <div v-if="visibleGroups.has('rules')" id="settings-group-rules" tabindex="-1" class="cc-card">
        <div class="cc-card-title"><h3><SectionIcon name="book" /> 规则库</h3><span class="cc-faint">修改后需在插件页热重载规则库</span></div>
        <el-form label-position="left" label-width="170px" size="small">
          <el-form-item label="启用高风险分类">
            <el-switch v-model="form.includeRisky" />
            <span class="row-hint">密码/Cookie、Windows.old 等，默认关闭</span>
          </el-form-item>
          <el-form-item label="启用深度规则">
            <el-switch v-model="form.includeDeep" />
            <span class="row-hint">更彻底但更慢的 deep_only 规则</span>
          </el-form-item>
          <el-form-item label="加载自定义规则">
            <el-switch v-model="form.includeCustom" />
            <span class="row-hint">用户手写与 AI 采纳的规则</span>
          </el-form-item>
        </el-form>
      </div>

      <div v-if="visibleGroups.has('quarantine')" id="settings-group-quarantine" tabindex="-1" class="cc-card">
        <div class="cc-card-title"><h3><SectionIcon name="archive" /> 隔离区</h3><span class="cc-faint">高风险项的回收站</span></div>
        <el-form label-position="left" label-width="150px" size="small">
          <el-form-item label="启用隔离区"><el-switch v-model="form.quarantineEnabled" /></el-form-item>
          <el-form-item label="容量上限（MB）"><el-input-number v-model="form.quarantineMaxMb" :min="0" :step="256" /></el-form-item>
          <el-form-item label="文件数上限"><el-input-number v-model="form.quarantineMaxFiles" :min="0" :step="1000" /></el-form-item>
          <el-form-item label="保留天数（0=永久）"><el-input-number v-model="form.retentionDays" :min="0" :max="365" /></el-form-item>
        </el-form>
      </div>

      <div v-if="visibleGroups.has('privacy')" id="settings-group-privacy" tabindex="-1" class="cc-card">
        <div class="cc-card-title"><h3><SectionIcon name="lock" /> 隐私与在线 AI</h3><span class="cc-faint">出网开关</span></div>
        <el-form label-position="left" label-width="150px" size="small">
          <el-form-item label="允许在线 AI">
            <el-switch v-model="form.onlineAi" />
            <span class="row-hint">关闭后完全离线，AI 请求一律拒绝</span>
          </el-form-item>
          <el-form-item label="编辑器命令">
            <el-input v-model="form.editorCommand" placeholder="例如 code / notepad（留空用系统默认）" size="small" style="width: 240px" />
          </el-form-item>
          <el-form-item label="外发记录">
            <el-button size="small" @click="doClearEgress">清空外发记录</el-button>
          </el-form-item>
        </el-form>
      </div>

      <div v-if="visibleGroups.has('scope')" id="settings-group-scope" tabindex="-1" class="cc-card">
        <div class="cc-card-title"><h3><SectionIcon name="folders" /> 扫描范围</h3><span class="cc-faint">额外纳入或排除的目录</span></div>
        <div class="roots">
          <div class="roots-title">额外扫描根</div>
          <div class="chips">
            <span v-for="(root, index) in form.roots" :key="root" class="cc-pill">
              {{ root }}
              <button class="chip-x" @click="form.roots.splice(index, 1)">×</button>
            </span>
            <span v-if="!form.roots.length" class="cc-faint">未添加</span>
          </div>
          <div class="add-row">
            <el-input v-model="newRoot" placeholder="例如 D:\\Videos" size="small" @keyup.enter="addRoot" />
            <el-button size="small" @click="addRoot">添加</el-button>
          </div>
        </div>
        <div class="roots" style="margin-top: 14px">
          <div class="roots-title">始终排除</div>
          <div class="chips">
            <span v-for="(item, index) in form.excludes" :key="item" class="cc-pill">
              {{ item }}
              <button class="chip-x" @click="form.excludes.splice(index, 1)">×</button>
            </span>
            <span v-if="!form.excludes.length" class="cc-faint">未添加</span>
          </div>
          <div class="add-row">
            <el-input v-model="newExclude" placeholder="例如 D:\\Projects" size="small" @keyup.enter="addExclude" />
            <el-button size="small" @click="addExclude">添加</el-button>
          </div>
        </div>
      </div>

      <div v-if="visibleGroups.has('plugins')" id="settings-group-plugins" tabindex="-1" class="cc-card">
        <div class="cc-card-title"><h3><SectionIcon name="puzzle" /> 插件系统与扩展目录</h3><span class="cc-faint">v2 插件包 / 外部插件</span></div>
        <div class="data-actions">
          <div class="data-row">
            <div>
              <div class="data-title">插件目录</div>
              <div class="cc-faint" style="word-break: break-all">{{ pluginsDir || '（未获取）' }}</div>
            </div>
            <el-button size="small" @click="openPluginsDirectory">打开</el-button>
          </div>
          <div class="data-row">
            <div>
              <div class="data-title">插件状态</div>
              <div class="cc-faint">
                已启用 {{ enabledPluginCount }} / {{ state.plugins.length }} 个 ·
                v2 插件包 {{ packagePluginCount }} 个 · 清理任务 {{ state.tasks.length }} 个
              </div>
            </div>
            <el-button size="small" @click="state.page = 'plugins'">插件页</el-button>
          </div>
          <div class="data-row">
            <div>
              <div class="data-title">AI 插件工坊</div>
              <div class="cc-faint">生成 v2 插件包（清单 / 权限 / 安装事务）并审阅安装</div>
            </div>
            <el-button size="small" @click="state.page = 'workshop'">打开工坊</el-button>
          </div>
        </div>
        <p class="cc-hint">
          v2 插件包安装会先写入 <code>plugins/.staging</code>，校验通过后原子落盘；升级/卸载的旧目录保留在
          <code>plugins/.trash</code>。权限清单用于审阅与展示，不是运行时沙箱 —— 插件仍以当前用户权限运行。
        </p>
      </div>

      <div v-if="visibleGroups.has('data')" id="settings-group-data" tabindex="-1" class="cc-card">
        <div class="cc-card-title"><h3><SectionIcon name="toolbox" /> 数据维护</h3><span class="cc-faint">不会删除你的文件</span></div>
        <div class="data-actions">
          <div class="data-row">
            <div>
              <div class="data-title">数据目录</div>
              <div class="cc-faint">{{ state.app?.dataDir ?? '（未获取）' }}</div>
            </div>
            <el-button size="small" @click="revealDataDir">打开</el-button>
          </div>
          <div class="data-row">
            <div><div class="data-title">历史记录</div><div class="cc-faint">清理历史与统计</div></div>
            <el-button size="small" type="warning" plain @click="doClearHistory">清空历史</el-button>
          </div>
          <div class="data-row">
            <div><div class="data-title">隔离区</div><div class="cc-faint">永久删除隔离文件（不可恢复）</div></div>
            <el-button size="small" type="danger" plain @click="doPurgeQuarantine">清空隔离区</el-button>
          </div>
        </div>
      </div>

      <div v-if="visibleGroups.has('diagnostics')" id="settings-group-diagnostics" tabindex="-1" class="cc-card">
        <div class="cc-card-title"><h3><SectionIcon name="health" /> 诊断与日志</h3><span class="cc-faint">出问题时先看这里</span></div>
        <div class="data-actions">
          <div class="data-row">
            <div><div class="data-title">运行日志</div><div class="cc-faint">记录启动、扫描、清理、插件与 AI 请求</div></div>
            <el-button size="small" @click="viewLogs">查看最近日志</el-button>
          </div>
          <div class="data-row">
            <div><div class="data-title">结构化诊断（JSON）</div><div class="cc-faint">环境 + 最近 2000 条结构化日志，便于机器分析</div></div>
            <el-button size="small" @click="exportJsonDiagnostics">导出 JSON</el-button>
          </div>
          <div class="data-row">
            <div><div class="data-title">日志目录</div><div class="cc-faint">资源管理器打开 logs 目录</div></div>
            <el-button size="small" @click="openLogDirectory">打开</el-button>
          </div>
          <div class="data-row">
            <div><div class="data-title">诊断报告</div><div class="cc-faint">环境 + 设置摘要 + 最近日志</div></div>
            <el-button size="small" type="primary" plain @click="exportDiag">导出</el-button>
          </div>
        </div>
      </div>

      <div v-if="visibleGroups.has('logging')" id="settings-group-logging" tabindex="-1" class="cc-card">
        <div class="cc-card-title"><h3><SectionIcon name="receipt" /> 日志设置</h3><span class="cc-faint">运行时生效，无需重启</span></div>
        <div class="log-settings">
          <label>
            <span>日志级别</span>
            <el-select v-model="logConfig.level" size="small" style="width: 150px">
              <el-option label="debug（最详细）" value="debug" />
              <el-option label="info（默认）" value="info" />
              <el-option label="warn（安静）" value="warn" />
              <el-option label="error（只记错误）" value="error" />
            </el-select>
          </label>
          <label>
            <span>单文件上限（MB）</span>
            <el-input-number v-model="logConfig.maxBytesMb" size="small" :min="1" :max="100" :step="1" />
          </label>
          <label>
            <span>轮转保留份数</span>
            <el-input-number v-model="logConfig.keep" size="small" :min="1" :max="10" />
          </label>
          <label>
            <span>旧日志保留天数</span>
            <el-input-number v-model="logConfig.retainDays" size="small" :min="0" :max="365" />
          </label>
          <label>
            <span>重复日志合并窗口（ms）</span>
            <el-input-number v-model="logConfig.dedupeWindowMs" size="small" :min="0" :max="60000" :step="1000" />
          </label>
          <el-button size="small" type="primary" :loading="savingLogConfig" @click="applyLogSettings">应用日志设置</el-button>
        </div>
        <div class="log-plugin-levels">
          <span class="cc-faint">插件级别覆盖（留空表示跟随全局）</span>
          <div v-for="plugin in state.plugins" :key="plugin.id" class="log-plugin-row">
            <span>{{ plugin.name || plugin.id }}</span>
            <el-select v-model="logConfig.pluginLevels[plugin.id]" size="small" placeholder="跟随全局" clearable style="width: 140px">
              <el-option label="debug" value="debug" />
              <el-option label="info" value="info" />
              <el-option label="warn" value="warn" />
              <el-option label="error" value="error" />
            </el-select>
          </div>
        </div>
        <p class="cc-hint">日志级别/轮转/保留会立即应用到统一日志；旧版 app-*.log 会在启动时按保留天数清理。</p>
      </div>

      <div v-if="visibleGroups.has('env')" id="settings-group-env" tabindex="-1" class="cc-card">
        <div class="cc-card-title"><h3><SectionIcon name="info" /> 版本与运行环境</h3><span class="cc-faint">反馈问题时可直接复制</span></div>
        <div class="data-actions">
          <div class="data-row">
            <div><div class="data-title">版本</div><div class="cc-faint">CordClean v{{ state.app?.version ?? '0.1.0' }} · 协议版本 {{ state.app?.protocolVersion ?? '—' }}</div></div>
            <el-button size="small" @click="copyEnvInfo">复制环境信息</el-button>
          </div>
          <div class="data-row">
            <div><div class="data-title">运行外壳</div><div class="cc-faint">{{ state.app?.shell === 'desktop' || state.transport?.kind === 'electron' ? '桌面外壳（Electron）' : '浏览器外壳（HTTP + WebSocket）' }}</div></div>
            <div class="cc-faint">启动耗时 {{ state.app?.bootMs ?? '—' }} ms</div>
          </div>
          <div class="data-row">
            <div><div class="data-title">运行时</div><div class="cc-faint">Node {{ state.app?.node ?? '—' }}{{ state.app?.electron ? ' · Electron ' + state.app.electron : '' }}</div></div>
            <div class="cc-faint">{{ state.app?.arch ?? 'x64' }}</div>
          </div>
          <div class="data-row">
            <div><div class="data-title">系统</div><div class="cc-faint">{{ state.app?.platformLabel ?? 'Windows' }} {{ state.app?.osVersion ?? '' }} · {{ state.app?.elevated ? '管理员权限' : '普通用户权限' }}</div></div>
            <div class="cc-faint">数据目录已在上方</div>
          </div>
        </div>
        <p class="cc-hint">内核基于 Cordis 4 插件框架；清理规则来自内置规则库（PC-Cleaner 迁移 + 自定义）。</p>
      </div>
    </div>

    <el-dialog v-model="logsOpen" title="运行日志" width="1080px" @closed="stopLogTimer">
      <div class="log-toolbar">
        <el-select v-model="logLevelFilter" size="small" style="width: 112px">
          <el-option label="全部级别" value="all" />
          <el-option label="error" value="error" />
          <el-option label="warn" value="warn" />
          <el-option label="info" value="info" />
          <el-option label="debug" value="debug" />
        </el-select>
        <el-select v-model="logScopeFilter" size="small" style="width: 132px">
          <el-option label="全部来源" value="all" />
          <el-option v-for="scope in logScopes" :key="scope" :label="scope" :value="scope" />
        </el-select>
        <el-input v-model="logSearch" size="small" placeholder="搜索日志（消息/来源/字段）…" clearable style="width: 230px" />
        <el-button size="small" :loading="loadingLogs" @click="refreshLogs">刷新</el-button>
        <el-button size="small" :type="logPaused ? 'warning' : 'default'" @click="logPaused = !logPaused">
          {{ logPaused ? '已暂停' : '暂停' }}
        </el-button>
        <el-button size="small" :type="logAutoRefresh ? 'primary' : 'default'" @click="toggleLogAutoRefresh">
          {{ logAutoRefresh ? '自动刷新中' : '自动刷新' }}
        </el-button>
        <span class="cc-faint">实时</span>
        <el-switch v-model="logLive" size="small" @change="toggleLogLive" />
        <el-button size="small" @click="copyLogs">复制</el-button>
        <el-button size="small" @click="openLogDirectory">打开日志目录</el-button>
        <span class="cc-faint">{{ filteredEntries.length }} 条 · {{ logBytesText }}</span>
      </div>
      <div class="log-view">
        <p v-if="!filteredEntries.length" class="cc-faint">{{ loadingLogs ? '正在读取…' : '（暂无匹配日志）' }}</p>
        <div v-for="(entry, index) in filteredEntries" :key="`${entry.ts}-${index}`" class="log-entry">
          <span class="log-time">{{ formatLogTime(entry.ts) }}</span>
          <span class="log-level" :class="levelClass(entry.level)">{{ entry.level.toUpperCase() }}</span>
          <span class="log-scope">{{ entry.scope }}</span>
          <span v-if="entry.requestId" class="log-request">{{ entry.requestId }}</span>
          <span class="log-message">{{ entry.message }}</span>
          <span v-if="formatFields(entry)" class="log-fields">{{ formatFields(entry) }}</span>
        </div>
      </div>
      <p class="cc-faint log-path">{{ logInfo?.file || '日志文件尚未初始化' }}</p>
      <template #footer>
        <el-button @click="logsOpen = false">关闭</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="importOpen" title="导入设置（JSON）" width="620px">
      <p class="cc-hint">粘贴导出的 JSON，或选择一个 cordclean-settings.json 文件。</p>
      <input type="file" accept="application/json" @change="pickImportFile" />
      <el-input v-model="importText" type="textarea" :rows="10" style="margin-top: 10px" />
      <template #footer>
        <el-button @click="importOpen = false">取消</el-button>
        <el-button type="primary" @click="doImport">导入并生效</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
@media (max-width: 1200px) {
  .settings-grid {
    grid-template-columns: 1fr;
  }
}
.row-hint {
  margin-left: 10px;
  color: var(--cc-text-faint);
  font-size: 11.5px;
}
.roots-title {
  font-size: 12.5px;
  color: var(--cc-text-dim);
  margin-bottom: 6px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 24px;
}
.chip-x {
  border: none;
  background: transparent;
  color: var(--cc-text-faint);
  cursor: pointer;
  padding: 0 0 0 2px;
  font-size: 13px;
  line-height: 1;
}
.chip-x:hover {
  color: var(--cc-danger);
}
.add-row {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.data-actions {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.data-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.data-title {
  font-size: 13px;
  font-weight: 550;
}
.log-view { max-height: 520px; overflow: auto; font-family: Consolas, monospace; font-size: 11.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-all; background: var(--cc-primary-soft); padding: 12px; border-radius: 10px; }
</style>

<style scoped>
.schedule-card { grid-column: 1 / -1; }
.schedule-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 24px; }
.schedule-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
.time-sep { margin: 0 6px; }
</style>

<style scoped>
.plan-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
</style>
<style scoped>
/* ---- 设置页升级：搜索 / 未保存提示 / 风险说明 ---- */
.settings-toolbar {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.settings-toolbar-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.settings-search {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 300px;
  padding: 5px 10px;
  border: 1px solid var(--cc-border-strong);
  border-radius: 9px;
  background: var(--cc-bg-soft);
  transition: border-color 0.16s ease, box-shadow 0.16s ease;
}
.settings-search.focused {
  border-color: var(--cc-primary);
  box-shadow: 0 0 0 3px var(--cc-primary-soft);
}
.settings-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--cc-text);
  font-size: 12.5px;
}
.settings-search-input::placeholder {
  color: var(--cc-text-faint);
}
.settings-search-input::-webkit-search-cancel-button {
  display: none;
}
.settings-search-clear {
  border: none;
  background: transparent;
  color: var(--cc-text-faint);
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
  padding: 0 2px;
}
.settings-search-clear:hover {
  color: var(--cc-text);
}
.settings-only-dirty {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--cc-text-dim);
  cursor: pointer;
  user-select: none;
}
.settings-search-hits {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  border-top: 1px dashed var(--cc-border);
  padding-top: 9px;
}
.settings-hit {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border: 1px solid var(--cc-border-strong);
  border-radius: 999px;
  background: transparent;
  color: var(--cc-text-dim);
  font-size: 11.5px;
  cursor: pointer;
}
.settings-hit:hover,
.settings-hit:focus-visible {
  border-color: var(--cc-primary);
  color: var(--cc-primary);
}
.settings-hit-count {
  padding: 0 5px;
  border-radius: 999px;
  background: var(--cc-primary-soft);
  color: var(--cc-primary);
  font-size: 10.5px;
}
.settings-dirty {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  border-color: rgba(217, 154, 43, 0.4);
}
.settings-dirty-main > p {
  margin: 5px 0 0;
}
.settings-dirty-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 9px;
  max-height: 96px;
  overflow: auto;
}
.settings-change-chip {
  font-size: 11.5px;
  color: var(--cc-text-dim);
  background: var(--cc-primary-soft);
  border-radius: 6px;
  padding: 2px 8px;
}

.settings-origins {
  border-color: var(--cc-border);
}

.settings-origins-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 14px;
  margin-bottom: 8px;
}

.settings-origin-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.settings-origin-chip {
  font-size: 11.5px;
  border-radius: 6px;
  padding: 2px 8px;
  border: 1px solid var(--cc-border);
  background: var(--cc-panel-2, rgba(0, 0, 0, 0.02));
}

.settings-origin-chip.origin-custom {
  color: var(--cc-primary);
  border-color: color-mix(in srgb, var(--cc-primary) 40%, transparent);
}

.settings-origin-chip.origin-unsaved {
  color: var(--cc-warning);
  border-color: color-mix(in srgb, var(--cc-warning) 40%, transparent);
  background: color-mix(in srgb, var(--cc-warning) 10%, transparent);
}
.settings-risk {
  border-color: rgba(240, 80, 110, 0.35);
}
.settings-risk-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.settings-risk-head h3 {
  margin: 0;
  font-size: 14.5px;
}
.settings-risk-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.settings-risk-item {
  border-left: 3px solid var(--cc-warning);
  padding: 2px 0 2px 12px;
}
.settings-risk-item.risk-danger {
  border-left-color: var(--cc-danger);
}
.settings-risk-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.settings-risk-item p {
  margin: 4px 0 0;
}
.link-button {
  border: none;
  background: transparent;
  padding: 0;
  color: var(--cc-primary);
  font-size: 11.5px;
  cursor: pointer;
}
.link-button:hover {
  text-decoration: underline;
}
.settings-save-error {
  border-color: rgba(240, 80, 110, 0.5);
}
.settings-save-error-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.settings-save-error-head p {
  margin: 5px 0 0;
}
.settings-empty p {
  margin: 4px 0;
}
.settings-grid [tabindex='-1']:focus-visible {
  outline: 2px solid var(--cc-primary);
  outline-offset: 2px;
}
@media (prefers-reduced-motion: reduce) {
  .settings-search {
    transition: none;
  }
}
</style>
