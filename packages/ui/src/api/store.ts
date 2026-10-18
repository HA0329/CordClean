/**
 * 全局状态与动作（轻量级响应式 store，不引入额外状态库）。
 *
 * 所有数据都来自 RPC；界面不直接接触 Node / 文件系统。
 */
import { computed, reactive } from 'vue'
import type {
  AiAnalysis,
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
  aiStatus: { available: boolean; configured: boolean; model?: string }
  logs: Array<{ level: string; message: string; time: number }>
  page: string
}

export const state = reactive<UiState>({
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
  aiStatus: { available: false, configured: false },
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
      requireTransport().request('ai/status', undefined).catch(() => ({ available: false, configured: false })),
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

export async function clearHistory(): Promise<void> {
  await requireTransport().request('history/clear', undefined)
  await refreshHistory()
}

/* ---------------------------------- AI / 系统交互 ---------------------------------- */

export async function analyzeAi(taskIds?: string[]): Promise<void> {
  state.busy = true
  try {
    state.ai = await requireTransport().request('ai/analyze', { taskIds })
    const status = await requireTransport().request('ai/status', undefined).catch(() => state.aiStatus)
    state.aiStatus = status
  } finally {
    state.busy = false
  }
}

export async function openPath(target: string): Promise<void> {
  await requireTransport().request('app/open-path', { path: target })
}

export async function openDataDir(): Promise<void> {
  await requireTransport().request('app/open-data-dir', undefined)
}

/* ---------------------------------- 派生数据 ---------------------------------- */

export const selectedByDefault = computed(() => (state.scan?.items ?? []).filter((item) => item.defaultSelected && !item.protected))

export const scanBytes = computed(() => state.scan?.stats.bytes ?? 0)
