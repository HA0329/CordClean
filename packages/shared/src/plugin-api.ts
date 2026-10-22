/**
 * 通用插件扩展契约（P1）。
 *
 * 清理插件仍然使用 `ctx.cleaner.define()`；通用插件可以在 Cordis `apply(ctx)`
 * 里注册 UI 贡献、事件/RPC，并使用宿主服务。外部插件与内置插件使用同一套契约。
 */

export type PluginKind = 'cleaner' | 'widget' | 'active' | 'desktop' | 'integration'

/** 概览卡片：声明式组件，由宿主固定渲染，不让插件直接注入 DOM */
export interface UiCardContribution {
  id: string
  title: string
  description?: string
  /** metric/text/list/progress 由宿主渲染；未知类型会被忽略 */
  type: 'metric' | 'text' | 'list' | 'progress'
  /** 数据来源：插件通过 ctx.ui.resolve 注册的取值函数 ID */
  resolve?: string
  /** 建议刷新间隔（毫秒），宿主会限制最小值 */
  refreshMs?: number
  /** 静态数据 fallback */
  fallback?: unknown
  /** 可选单位/最大值，用于 metric/progress */
  unit?: string
  max?: number
}

/** 插件页面：声明式或 iframe 沙箱 */
export interface UiPageContribution {
  id: string
  title: string
  icon?: string
  /** declarative=宿主固定组件；iframe=插件资源页面 */
  mode: 'declarative' | 'iframe'
  /** iframe 模式下由宿主从插件目录安全解析的入口文件 */
  entry?: string
}

export interface UiStatusItemContribution {
  id: string
  label: string
  resolve?: string
  tone?: 'neutral' | 'success' | 'warning' | 'danger'
}

export interface UiCommandContribution {
  id: string
  title: string
  /** 插件自定义 RPC 方法名（宿主校验白名单/参数） */
  rpc?: string
}

/** 一个插件贡献的 UI 集合 */
export interface PluginUiContributions {
  overviewCards?: UiCardContribution[]
  pages?: UiPageContribution[]
  statusItems?: UiStatusItemContribution[]
  commands?: UiCommandContribution[]
}

/** UI 服务中登记的贡献（带来源插件） */
export interface UiContributionEntry {
  pluginId: string
  pluginName: string
  kind: PluginKind
  contributions: PluginUiContributions
}

/** 插件数据解析函数：返回声明式 UI 需要的数据 */
export type UiResolveHandler = (params?: Record<string, unknown>) => unknown | Promise<unknown>

/** 由内核提供的 ctx.ui 服务 */
export interface UiContributionApi {
  /** 注册本插件的 UI 贡献；返回注销函数（建议放在 ctx.effect 中） */
  register(pluginId: string, contributions: PluginUiContributions, kind?: PluginKind): () => void
  /** 注册一个数据解析函数，供声明式卡片/状态项使用 */
  resolve(pluginId: string, id: string, handler: UiResolveHandler): () => void
  /** 列出全部贡献 */
  list(): UiContributionEntry[]
  /** 读取一个 resolve 的数据（供宿主 RPC 调用） */
  resolveValue(pluginId: string, id: string, params?: Record<string, unknown>): Promise<unknown>
  /** 清空某个插件的贡献（禁用/卸载时调用） */
  clear(pluginId: string): void
}
