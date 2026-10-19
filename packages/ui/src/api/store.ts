import { ElMessage, ElNotification } from 'element-plus'
/**
 * 全局状态与动作（轻量级响应式 store，不引入额外状态库）。
 *
 * 所有数据都来自 RPC；界面不直接接触 Node / 文件系统。
 */
import { computed, reactive } from 'vue'
import type {
  AiAnalysis,
  AiModelInfo,
  AiProbeResult,
  AiRuntimeStatus,
  AppInfo,
  CleanProgressEvent,
  CleanReport,
  HistoryEntry,
  PluginRuntime,
  QuarantineRecord,
  ScanProgressEvent,
  ScanReport,
  Settings,
  SystemInfo,
  TaskDescriptor,
} from '@cordclean/shared'
import { createTransport, type ApiTransport } from './client.ts'

export interface UiState {
  aiStream: string
  aiStreamReasoning: string
  ready: boolean
  busy: boolean
  error?: string
  transport?: ApiTransport
  app?: AppInfo
  system?: SystemInfo
  tasks: TaskDescriptor[]
  scan?: ScanReport | null
  scanProgress?: ScanProgressEvent
  scanning: boolean
  cleanProgress?: CleanProgressEvent
  cleaning: boolean
  lastClean?: CleanReport | null
  plugins: PluginRuntime[]
  settings?: Settings
  history: HistoryEntry[]
  totals: { sessions: number; freedBytes: number; cleaned: number }
  quarantine: QuarantineRecord[]
  quarantineStats: { count: number; bytes: number }
  ai?: AiAnalysis | null
  aiStatus: AiRuntimeStatus
  /** 模型列表（来自 /models 或内置兜底） */
  aiModels: AiModelInfo[]
  aiModelsSource?: 'remote' | 'fallback'
  /** 最近一次连通性探测结果 */
  aiProbe?: AiProbeResult
  logs: Array<{ level: string; message: string; time: number }>
  page: string
}

export const state = reactive<UiState>({
  aiStream: '',
  aiStreamReasoning: '',
  ready: false,
  busy: false,
  tasks: [],
  scanning: false,
  cleaning: false,
  plugins: [],
  history: [],
  totals: { sessions: 0, freedBytes: 0, cleaned: 0 },
  quarantine: [],
  quarantineStats: { count: 0, bytes: 0 },
  aiStatus: { available: false, configured: false, shape: 'chat', baseUrl: '', model: '', effort: 'auto', jsonMode: 'auto', models: [] },
  aiModels: [],
  logs: [],
  page: 'overview',
})

function requireTransport(): ApiTransport {
  if (!state.transport) throw new Error('内核连接尚未建立')
  return state.transport
}

export async function init(): Promise<void> {
  try {
    state.transport = createTransport()
    state.transport.on('ai/stream', (event) => {
    if (event.kind === 'delta') {
      state.aiStream += event.text ?? ''
      state.aiStreamReasoning += event.reasoning ?? ''
    }
  })

  state.transport.on('scheduler/scan', (event) => {
      if (event.error) {
        ElNotification({ title: '定时扫描失败', message: event.error, type: 'error' })
        return
      }
      if (event.blocked) {
        ElNotification({ title: '自动清理已跳过', message: event.reason ?? '规则已变化，请重新授权', type: 'warning', duration: 8000 })
        return
      }
      if (event.autoCleaned) {
        ElNotification({
          title: '定时清理完成',
          message: '清理 ' + (event.cleaned ?? 0) + ' 项，释放 ' + ((event.freedBytes ?? 0) / 1024 / 1024).toFixed(1) + ' MB（回收站 ' + ((event.recycledBytes ?? 0) / 1024 / 1024).toFixed(1) + ' MB）',
          type: 'success',
          duration: 8000,
        })
        void refreshHistory()
        return
      }
      const mb = ((event.bytes ?? 0) / 1024 / 1024).toFixed(1)
      const count = event.items ?? 0
      ElNotification({
        title: '定时扫描完成',
        message: '发现 ' + count + ' 项可清理，约 ' + mb + ' MB。点「清理」页查看。',
        type: count > 0 ? 'warning' : 'success',
        duration: 8000,
      })
    })

  state.transport.on('scan/progress', (event) => {
      state.scanProgress = event
      state.scanning = !event.done
    })
    state.transport.on('scan/done', (report) => {
      state.scan = report
      state.scanning = false
      state.scanProgress = undefined
    })
    state.transport.on('clean/progress', (event) => {
      state.cleanProgress = event
      state.cleaning = !event.finished
    })
    state.transport.on('clean/done', (report) => {
      state.lastClean = report
      state.cleaning = false
      state.cleanProgress = undefined
      void refreshHistory()
      void refreshSystem()
    })
    state.transport.on('plugins/changed', () => {
      void refreshPlugins()
      void refreshTasks()
    })
    state.transport.on('history/changed', () => void refreshHistory())
    state.transport.on('log', (entry) => {
      state.logs.unshift(entry)
      if (state.logs.length > 300) state.logs.pop()
    })

    const [app, system, tasks, plugins, settings, totals, aiStatus, lastScan, lastAi] = await Promise.all([
      requireTransport().request('app/info', undefined),
      requireTransport().request('system/info', undefined),
      requireTransport().request('tasks/list', undefined),
      requireTransport().request('plugins/list', undefined),
      requireTransport().request('settings/get', undefined),
      requireTransport().request('history/totals', undefined),
      requireTransport().request('ai/status', undefined).catch(() => state.aiStatus),
      requireTransport().request('scan/last', undefined).catch(() => null),
      requireTransport().request('ai/last', undefined).catch(() => null),
    ])
    state.app = app
    state.system = system
    state.tasks = tasks
    state.plugins = plugins as PluginRuntime[]
    state.settings = settings
    state.totals = totals
    state.aiStatus = aiStatus
    state.aiModels = aiStatus.models ?? []
    // 已配置凭据时后台预取模型列表（失败静默，界面仍可用内置目录）
    if (aiStatus.configured && !state.aiModels.length) {
      void requireTransport()
        .request('ai/models', { refresh: false })
        .then((result) => {
          state.aiModels = result.models
          state.aiModelsSource = result.source
        })
        .catch(() => {})
    }
    if (lastScan) state.scan = lastScan
    if (lastAi) state.ai = lastAi
    state.ready = true
    await Promise.all([refreshHistory(), refreshQuarantine()])
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error)
    throw error
  }
}

export async function refreshSystem(): Promise<void> {
  state.system = await requireTransport().request('system/info', undefined)
}

export async function refreshTasks(): Promise<void> {
  state.tasks = await requireTransport().request('tasks/list', undefined)
}

export async function refreshPlugins(): Promise<void> {
  state.plugins = (await requireTransport().request('plugins/list', undefined)) as PluginRuntime[]
}

export async function refreshHistory(): Promise<void> {
  const [history, totals] = await Promise.all([
    requireTransport().request('history/list', { limit: 50 }),
    requireTransport().request('history/totals', undefined),
  ])
  state.history = history
  state.totals = totals
}

export async function refreshQuarantine(): Promise<void> {
  const [list, stats] = await Promise.all([
    requireTransport().request('quarantine/list', undefined),
    requireTransport().request('quarantine/stats', undefined),
  ])
  state.quarantine = list
  state.quarantineStats = stats
}

export async function refreshSettings(): Promise<void> {
  state.settings = await requireTransport().request('settings/get', undefined)
}

/* ---------------------------------- 扫描 / 清理 ---------------------------------- */

export async function startScan(taskIds?: string[]): Promise<void> {
  if (state.scanning) return
  state.scanning = true
  state.error = undefined
  try {
    const report = await requireTransport().request('scan/start', { taskIds })
    state.scan = report
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    state.scanning = false
  }
}

export async function cancelScan(): Promise<void> {
  await requireTransport().request('scan/cancel', {})
}

export async function startClean(itemIds: string[], options: { dryRun?: boolean; forceQuarantine?: boolean } = {}): Promise<CleanReport> {
  state.cleaning = true
  state.error = undefined
  try {
    const report = await requireTransport().request('clean/start', {
      itemIds,
      dryRun: options.dryRun,
      forceQuarantine: options.forceQuarantine,
    })
    state.lastClean = report
    return report
  } finally {
    state.cleaning = false
  }
}

export async function cancelClean(): Promise<void> {
  await requireTransport().request('clean/cancel', {})
}

/* ---------------------------------- 插件 / 设置 ---------------------------------- */

export async function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
  await requireTransport().request(enabled ? 'plugins/enable' : 'plugins/disable', { id })
  await refreshPlugins()
  await refreshTasks()
}

export async function installPlugin(filePath: string): Promise<void> {
  await requireTransport().request('plugins/install', { path: filePath })
  await refreshPlugins()
}

export async function uninstallPlugin(id: string): Promise<void> {
  await requireTransport().request('plugins/uninstall', { id })
  await refreshPlugins()
}

export async function reloadPlugin(id: string): Promise<void> {
  await requireTransport().request('plugins/reload', { id })
  await refreshPlugins()
  await refreshTasks()
}

export async function savePluginConfig(id: string, config: Record<string, unknown>): Promise<void> {
  await requireTransport().request('plugins/config', { id, config })
  await refreshPlugins()
}

export async function loadPluginDefaults(id: string): Promise<Record<string, unknown>> {
  return requireTransport().request('plugins/defaults', { id })
}

export async function patchSettings(patch: Record<string, unknown>): Promise<void> {
  state.settings = await requireTransport().request('settings/patch', { patch })
}

export async function setSetting(path: string, value: unknown): Promise<void> {
  state.settings = await requireTransport().request('settings/set', { path, value })
}

/* ---------------------------------- 隔离区 / 历史 ---------------------------------- */

export async function restoreQuarantine(ids: string[]): Promise<void> {
  await requireTransport().request('quarantine/restore', { ids })
  await refreshQuarantine()
}

export async function purgeQuarantine(ids?: string[]): Promise<void> {
  await requireTransport().request('quarantine/purge', { ids })
  await refreshQuarantine()
}

export async function clearEgress(): Promise<void> {
  await requireTransport().request('ai/egress/clear', undefined)
}

export async function fetchUndoState(): Promise<{ available: boolean; at?: number; quarantine: number; recycle: number; permanent: number }> {
  return requireTransport().request('clean/undo-state', undefined)
}

export async function undoLastClean(): Promise<{ restored: number; recyclePending: number; permanent: number; failed: number }> {
  const result = await requireTransport().request('clean/undo', undefined)
  await Promise.all([refreshHistory(), refreshQuarantine()])
  return result
}

export async function fetchSessions(): Promise<Array<{ sessionId: string; startedAt: number; status: string; taskIds: string[] }>> {
  return requireTransport().request('history/sessions', undefined)
}

export async function clearHistory(): Promise<void> {
  await requireTransport().request('history/clear', undefined)
  await refreshHistory()
}

/* ---------------------------------- AI / 系统交互 ---------------------------------- */

export async function analyzeAi(taskIds?: string[], contextProviders?: string[], image?: { mime: string; data: string }): Promise<void> {
  state.busy = true
  try {
    state.ai = await requireTransport().request('ai/analyze', { taskIds, contextProviders, image })
    const status = await requireTransport().request('ai/status', undefined).catch(() => state.aiStatus)
    state.aiStatus = status
    state.aiModels = status.models?.length ? status.models : state.aiModels
  } finally {
    state.busy = false
  }
}

/** 刷新 AI 运行时状态（形态/模型/推理等级/是否配置） */
export async function refreshAiStatus(): Promise<void> {
  const status = await requireTransport().request('ai/status', undefined)
  state.aiStatus = status
  if (status.models?.length) state.aiModels = status.models
}

/** 拉取模型列表（refresh=true 强制绕过缓存） */
export async function fetchAiModels(refresh = true): Promise<{ source: string; count: number; error?: string }> {
  const result = await requireTransport().request('ai/models', { refresh })
  state.aiModels = result.models
  state.aiModelsSource = result.source
  await refreshAiStatus()
  return { source: result.source, count: result.models.length }
}

/** 连通性探测 */
/** 外发记录（不变量 8）：统计 + 脱敏预览 */
export async function fetchEgress(limit = 10) {
  return requireTransport().request('ai/egress', { limit })
}

/** 采纳 AI 建议的规则：经统一入库管线写入并热重载规则包 */
export async function draftAiPlugin(requirement: string): Promise<{ name: string; code: string; notes: string }> {
  return requireTransport().request('ai/plugin/draft', { requirement })
}

export async function validateAiPlugin(code: string): Promise<{ ok: boolean; errors: string[]; warnings: string[] }> {
  return requireTransport().request('ai/plugin/validate', { code })
}

export async function installAiPlugin(name: string, code: string): Promise<{ path: string; id: string }> {
  const result = await requireTransport().request('ai/plugin/install', { name, code })
  await refreshPlugins()
  return result
}

export async function dryRunAiRule(suggestion: Record<string, unknown>): Promise<any> {
  return requireTransport().request('ai/rules/dry-run', { suggestion: suggestion as any })
}

export async function applyAiRule(suggestion: unknown): Promise<{ applied: boolean; ruleId?: string; reason?: string }> {
  const result = await requireTransport().request('ai/apply-rule', { suggestion: suggestion as any })
  if (result.applied) await refreshPlugins()
  return result
}

export async function probeAi(): Promise<AiProbeResult> {
  const probe = await requireTransport().request('ai/probe', undefined)
  state.aiProbe = probe
  await refreshAiStatus()
  return probe
}

/** 保存 AI 插件配置（与旧配置合并后写回，然后热重载插件） */
export async function saveAiConfig(patch: Record<string, unknown>): Promise<Record<string, any>> {
  const plugin = state.plugins.find((item) => item.id === 'ai')
  const current = (plugin?.config ?? {}) as Record<string, any>
  const merged = { ...current, ...patch }
  await requireTransport().request('plugins/config', { id: 'ai', config: merged })
  await refreshPlugins()
  await refreshAiStatus()
  return merged
}

/** 读取 AI 插件当前配置 */
export function aiPluginConfig(): Record<string, any> {
  const plugin = state.plugins.find((item) => item.id === 'ai')
  return (plugin?.config ?? {}) as Record<string, any>
}

/** 启用 AI 插件并预热模型列表 */
export async function enableAiPlugin(): Promise<void> {
  await setPluginEnabled('ai', true)
  await refreshAiStatus()
  await fetchAiModels(true).catch(() => undefined)
}

export async function openPath(target: string): Promise<void> {
  await requireTransport().request('app/open-path', { path: target })
}

export async function authorizeScheduler(patch: Record<string, unknown> = {}): Promise<string> {
  const result = await requireTransport().request('scheduler/authorize', patch)
  await refreshPlugins()
  return result.hash
}

export async function revokeScheduler(planId?: string): Promise<void> {
  await requireTransport().request('scheduler/revoke', { planId })
  await refreshPlugins()
}

export async function runSchedulerNow(planId?: string): Promise<void> {
  await requireTransport().request('scheduler/run', { planId })
}

export async function pluginSource(id: string): Promise<string> {
  const result = await requireTransport().request('plugins/source', { id })
  return result.path
}

export async function openEditor(target: string): Promise<void> {
  await requireTransport().request('app/open-editor', { path: target })
}

export async function fetchLogs(limit = 200): Promise<string[]> {
  const result = await requireTransport().request('app/logs/recent', { limit })
  return result.lines
}

export async function openLogDir(): Promise<void> {
  await requireTransport().request('app/logs/open', undefined)
}

export async function exportDiagnostics(): Promise<string> {
  const result = await requireTransport().request('app/logs/export', undefined)
  return result.path
}

export async function quitApp(): Promise<void> {
  await requireTransport().request('app/quit', undefined)
}

export async function openDataDir(): Promise<string> {
  return requireTransport().request('app/open-data-dir', undefined)
}

/* ---------------------------------- 派生数据 ---------------------------------- */

export const selectedByDefault = computed(() => (state.scan?.items ?? []).filter((item) => item.defaultSelected && !item.protected))

export const scanBytes = computed(() => state.scan?.stats.bytes ?? 0)
