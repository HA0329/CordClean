/**
 * 插件页展示模型（纯函数，可单测）。
 *
 * 插件多起来以后，用户最需要的是「快速找到有问题的插件、看清权限与风险、
 * 批量恢复正常状态」；这些判断抽出来单测，模板只负责渲染。
 */

export type PluginStatusKey = 'active' | 'suspended' | 'error' | 'loading' | 'stopped'
export type PluginFilterStatus = 'all' | 'active' | 'stopped' | 'error' | 'external'
export type PluginBatchAction = 'enable' | 'disable' | 'reload'

export interface PluginCapabilitiesLike {
  fsRoots?: string[]
  network?: boolean
  childProcess?: boolean
  customClean?: boolean
}

export interface PluginPermissionsLike {
  services?: string[]
  network?: boolean
  subprocess?: boolean
}

export interface PluginLike {
  id: string
  name: string
  description?: string
  version?: string
  enabled: boolean
  status?: string
  source?: string
  category?: string
  taskCount?: number
  tasks?: Array<{ id: string; name?: string; risk?: string }>
  error?: string
  errorStack?: string
  configurable?: boolean
  capabilities?: PluginCapabilitiesLike
  permissions?: PluginPermissionsLike
  manifest?: { version?: string; client?: { mode?: string } }
}

const STATUS_KEYS: readonly PluginStatusKey[] = ['active', 'suspended', 'error', 'loading', 'stopped']

export function pluginStatusKey(status: unknown): PluginStatusKey {
  const value = typeof status === 'string' ? status.toLowerCase() : ''
  return (STATUS_KEYS as readonly string[]).includes(value) ? (value as PluginStatusKey) : 'stopped'
}

export function pluginStatusLabel(status: unknown): string {
  const key = pluginStatusKey(status)
  if (key === 'active') return '运行中'
  if (key === 'suspended') return '等待依赖'
  if (key === 'error') return '异常'
  if (key === 'loading') return '加载中'
  return '已停止'
}

export interface PluginStats {
  total: number
  enabled: number
  running: number
  errors: number
  external: number
  configurable: number
  tasks: number
}

export function summarizePlugins(plugins: readonly PluginLike[]): PluginStats {
  const stats: PluginStats = { total: 0, enabled: 0, running: 0, errors: 0, external: 0, configurable: 0, tasks: 0 }
  for (const plugin of plugins) {
    stats.total++
    if (plugin.enabled) stats.enabled++
    if (pluginStatusKey(plugin.status) === 'active') stats.running++
    if (plugin.error) stats.errors++
    if (plugin.source === 'external') stats.external++
    if (plugin.configurable) stats.configurable++
    stats.tasks += Number(plugin.taskCount) || 0
  }
  return stats
}

/**
 * 插件过滤：搜索命中 id/名称/描述/任务名；状态筛选支持「异常」「外部」。
 * 空查询 + all 原样返回（保持稳定顺序，便于 e2e 断言卡片数量）。
 */
export function filterPlugins<T extends PluginLike>(
  plugins: readonly T[],
  query: string | null | undefined,
  status: PluginFilterStatus = 'all',
): T[] {
  const needle = String(query ?? '').trim().toLowerCase()
  return plugins.filter((plugin) => {
    if (status === 'active' && pluginStatusKey(plugin.status) !== 'active') return false
    if (status === 'stopped' && pluginStatusKey(plugin.status) === 'active') return false
    if (status === 'error' && !plugin.error && pluginStatusKey(plugin.status) !== 'error') return false
    if (status === 'external' && plugin.source !== 'external') return false
    if (!needle) return true
    const haystack = [
      plugin.id,
      plugin.name,
      plugin.description ?? '',
      plugin.category ?? '',
      ...(plugin.tasks ?? []).map((task) => task.name ?? task.id),
    ]
      .join(' ')
      .toLowerCase()
    return haystack.includes(needle)
  })
}

/** 能力/权限风险提示（用于卡片上的黄色提示，不阻止操作，但必须让用户知道） */
export function capabilityWarnings(plugin: PluginLike): string[] {
  const warnings: string[] = []
  const capabilities = plugin.capabilities
  if (capabilities) {
    const roots = capabilities.fsRoots?.length ?? 0
    if (roots > 0) warnings.push(`可访问 ${roots} 个声明目录`)
    if (capabilities.network) warnings.push('可发起网络请求')
    if (capabilities.childProcess) warnings.push('可启动子进程')
    if (capabilities.customClean) warnings.push('含自定义清理逻辑（不受统一清理引擎约束）')
  }
  if (plugin.permissions) {
    const services = plugin.permissions.services?.length ?? 0
    if (services > 0) warnings.push(`申请 ${services} 个内核服务`)
    if (plugin.permissions.network) warnings.push('权限声明含网络')
    if (plugin.permissions.subprocess) warnings.push('权限声明含子进程')
  }
  return warnings
}

export interface PluginDiagnostics {
  message: string
  stack?: string
  /** 给出可执行的下一步，而不是只显示堆栈 */
  hint: string
}

export function pluginDiagnostics(plugin: PluginLike): PluginDiagnostics | undefined {
  const status = pluginStatusKey(plugin.status)
  if (!plugin.error && status !== 'error') return undefined
  const message = String(plugin.error ?? '').trim() || '插件状态为异常，但没有返回错误信息'
  return {
    message,
    stack: plugin.errorStack?.trim() ? plugin.errorStack : undefined,
    hint: '可先尝试「热重载」；仍失败时检查插件配置、依赖是否已启用，或停用该插件避免影响其它能力。',
  }
}

export interface BatchPlan {
  action: PluginBatchAction
  ids: string[]
  skipped: string[]
  /** 给确认框看的摘要（含数量与示例名称） */
  summary: string
  /** 额外风险提示（批量停用可能影响清理能力） */
  warning?: string
}

/**
 * 批量操作计划：
 * - enable 只启用未启用的；
 * - disable 只停用已启用的；
 * - reload 只重载已启用的（停用插件没有运行实例，重载没有意义）。
 * 没有任何可操作项时返回空 ids，UI 据此禁用按钮并提示。
 */
export function planBatch(plugins: readonly PluginLike[], action: PluginBatchAction): BatchPlan {
  const ids: string[] = []
  const skipped: string[] = []
  for (const plugin of plugins) {
    const eligible = action === 'enable' ? !plugin.enabled : plugin.enabled
    if (eligible) ids.push(plugin.id)
    else skipped.push(plugin.id)
  }
  const names = plugins.filter((plugin) => ids.includes(plugin.id)).map((plugin) => plugin.name)
  const sample = names.slice(0, 5).join('、')
  const more = names.length > 5 ? ` 等 ${names.length} 个` : ''
  const summary =
    action === 'enable'
      ? `将启用 ${ids.length} 个插件${ids.length ? `（${sample}${more}）` : ''}`
      : action === 'disable'
        ? `将停用 ${ids.length} 个插件${ids.length ? `（${sample}${more}）` : ''}`
        : `将热重载 ${ids.length} 个已启用插件${ids.length ? `（${sample}${more}）` : ''}`
  const warning =
    action === 'disable' && ids.length
      ? '停用插件会同时移除它注册的清理任务与界面贡献；重新启用后恢复。'
      : action === 'reload' && ids.length
        ? '热重载会短暂重启这些插件，正在使用其功能的操作可能被中断。'
        : undefined
  return { action, ids, skipped, summary, warning }
}

/** 过滤结果为空时的说明（区分搜索/状态筛选） */
export function emptyFilterHint(query: string | null | undefined, status: PluginFilterStatus): string {
  const trimmed = String(query ?? '').trim()
  if (trimmed && status !== 'all') return `没有同时匹配「${trimmed}」且状态为「${status}」的插件`
  if (trimmed) return `没有匹配「${trimmed}」的插件`
  if (status === 'error') return '当前没有异常插件，状态良好'
  if (status === 'external') return '当前没有外部/工坊插件'
  if (status === 'active') return '当前没有运行中的插件'
  if (status === 'stopped') return '所有插件都在运行中'
  return '没有插件'
}
