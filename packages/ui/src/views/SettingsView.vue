<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  authorizeScheduler,
  clearEgress,
  revokeScheduler,
  runSchedulerNow,
  refreshPlugins,
  savePluginConfig,
  setPluginEnabled,
  exportDiagnostics,
  fetchLogs,
  openLogDir,
  clearHistory,
  openDataDir,
  openPath,
  patchSettings,
  purgeQuarantine,
  state,
} from '../api/store.ts'

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
const logLines = ref<string[]>([])
const loadingLogs = ref(false)

function syncFromSettings() {
  const s = state.settings
  if (!s) return
  form.cleanMode = s.clean.mode
  form.highRiskQuarantine = s.clean.highRiskQuarantine
  form.quarantineFallback = s.clean.quarantineFallback
  form.dryRunDefault = s.clean.dryRunDefault
  form.confirmRisky = s.clean.confirmRisky
  form.retries = s.clean.retries
  form.budgetFiles = s.clean.budget.maxFiles
  form.budgetGb = Math.round((s.clean.budget.maxBytes / 1024 / 1024 / 1024) * 10) / 10

  form.concurrency = s.scan.concurrency
  form.maxItemsPerTask = s.scan.maxItemsPerTask
  form.maxEntriesPerTask = s.scan.maxEntriesPerTask
  form.maxDepth = s.scan.maxDepth
  form.largeFileThresholdMb = Math.round(s.scan.largeFileThreshold / 1024 / 1024)
  form.duplicateMinSizeMb = Math.round(s.scan.duplicateMinSize / 1024 / 1024)
  form.roots = [...s.analysis.roots]
  form.excludes = [...s.analysis.excludes]
  form.includeSystem = s.analysis.includeSystem

  form.includeRisky = s.rules.includeRisky
  form.includeDeep = s.rules.includeDeep
  form.includeCustom = s.rules.includeCustom

  form.quarantineEnabled = s.quarantine.enabled
  form.quarantineMaxMb = Math.round(s.quarantine.maxBytes / 1024 / 1024)
  form.quarantineMaxFiles = s.quarantine.maxFiles
  form.retentionDays = s.quarantine.retentionDays

  form.onlineAi = s.privacy.onlineAi
  form.editorCommand = s.ui.editorCommand
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
  saving.value = true
  try {
    await patchSettings(buildPatch())
    ElMessage.success('设置已保存')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    saving.value = false
  }
}

async function resetDefaults() {
  try {
    await ElMessageBox.confirm('恢复默认设置不会删除历史、隔离区或规则文件，只重置本页参数。', '恢复默认设置', { type: 'warning' })
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
  try {
    logLines.value = await fetchLogs(300)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    loadingLogs.value = false
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
        <el-button type="primary" :loading="saving" @click="save">保存设置</el-button>
      </div>
    </div>

    <div class="settings-grid">
      <div class="cc-card schedule-card">
        <div class="cc-card-title">
          <h3>⏰ 定时任务</h3>
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

      <div class="cc-card">
        <div class="cc-card-title"><h3>🧹 清理行为</h3><span class="cc-faint">删除方式与安全边界</span></div>
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

      <div class="cc-card">
        <div class="cc-card-title"><h3>⚡ 扫描与性能</h3><span class="cc-faint">并发与上限影响速度与内存</span></div>
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

      <div class="cc-card">
        <div class="cc-card-title"><h3>📚 规则库</h3><span class="cc-faint">修改后需在插件页热重载规则库</span></div>
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

      <div class="cc-card">
        <div class="cc-card-title"><h3>🗃️ 隔离区</h3><span class="cc-faint">高风险项的回收站</span></div>
        <el-form label-position="left" label-width="150px" size="small">
          <el-form-item label="启用隔离区"><el-switch v-model="form.quarantineEnabled" /></el-form-item>
          <el-form-item label="容量上限（MB）"><el-input-number v-model="form.quarantineMaxMb" :min="0" :step="256" /></el-form-item>
          <el-form-item label="文件数上限"><el-input-number v-model="form.quarantineMaxFiles" :min="0" :step="1000" /></el-form-item>
          <el-form-item label="保留天数（0=永久）"><el-input-number v-model="form.retentionDays" :min="0" :max="365" /></el-form-item>
        </el-form>
      </div>

      <div class="cc-card">
        <div class="cc-card-title"><h3>🔒 隐私与在线 AI</h3><span class="cc-faint">出网开关</span></div>
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

      <div class="cc-card">
        <div class="cc-card-title"><h3>🗂️ 扫描范围</h3><span class="cc-faint">额外纳入或排除的目录</span></div>
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

      <div class="cc-card">
        <div class="cc-card-title"><h3>🧩 插件系统与扩展目录</h3><span class="cc-faint">v2 插件包 / 外部插件</span></div>
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

      <div class="cc-card">
        <div class="cc-card-title"><h3>🧰 数据维护</h3><span class="cc-faint">不会删除你的文件</span></div>
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

      <div class="cc-card">
        <div class="cc-card-title"><h3>🩺 诊断与日志</h3><span class="cc-faint">出问题时先看这里</span></div>
        <div class="data-actions">
          <div class="data-row">
            <div><div class="data-title">运行日志</div><div class="cc-faint">记录启动、扫描、清理、插件与 AI 请求</div></div>
            <el-button size="small" @click="viewLogs">查看最近日志</el-button>
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

      <div class="cc-card">
        <div class="cc-card-title"><h3>ℹ️ 版本与运行环境</h3><span class="cc-faint">反馈问题时可直接复制</span></div>
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

    <el-dialog v-model="logsOpen" title="最近日志（末尾 300 行）" width="860px">
      <pre class="log-view">{{ loadingLogs ? '正在读取…' : (logLines.join('\n') || '(暂无日志)') }}</pre>
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

