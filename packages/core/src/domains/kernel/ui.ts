/**
 * 通用插件 UI 贡献注册表（P1）。
 *
 * 插件通过 `ctx.ui.register(...)` 贡献声明式卡片/页面/状态项；
 * 宿主通过 `ctx.ui.list()` 读取并用固定组件渲染，避免插件直接注入渲染进程 DOM。
 */
import { Service, type Context } from 'cordis'
import type {
  PluginKind,
  PluginUiContributions,
  UiContributionEntry,
  UiContributionApi,
  UiResolveHandler,
} from '@cordclean/shared'

interface RegisteredContribution extends UiContributionEntry {
  owner: symbol
}

export class UiContributionService extends Service implements UiContributionApi {
  private contributions = new Map<string, RegisteredContribution>()
  private resolvers = new Map<string, Map<string, UiResolveHandler>>()
  private commands = new Map<string, Map<string, UiResolveHandler>>()

  constructor(ctx: Context) {
    super(ctx, 'ui')
  }

  register(pluginId: string, contributions: PluginUiContributions, kind: PluginKind = 'cleaner'): () => void {
    const owner = Symbol(pluginId)
    const entry: RegisteredContribution = {
      owner,
      pluginId,
      pluginName: pluginId.replace(/^external:/, ''),
      kind,
      contributions,
    }
    this.contributions.set(pluginId, entry)
    return () => {
      const current = this.contributions.get(pluginId)
      if (current?.owner === owner) this.contributions.delete(pluginId)
    }
  }

  resolve(pluginId: string, id: string, handler: UiResolveHandler): () => void {
    let map = this.resolvers.get(pluginId)
    if (!map) {
      map = new Map()
      this.resolvers.set(pluginId, map)
    }
    map.set(id, handler)
    return () => {
      const current = this.resolvers.get(pluginId)
      if (current?.get(id) === handler) current.delete(id)
    }
  }

  command(pluginId: string, id: string, handler: UiResolveHandler): () => void {
    let map = this.commands.get(pluginId)
    if (!map) {
      map = new Map()
      this.commands.set(pluginId, map)
    }
    map.set(id, handler)
    return () => {
      const current = this.commands.get(pluginId)
      if (current?.get(id) === handler) current.delete(id)
    }
  }

  async runCommand(pluginId: string, id: string, params?: Record<string, unknown>): Promise<unknown> {
    const aliases = [...new Set([pluginId, pluginId.replace(/^external:/, ''), `external:${pluginId}`])]
    let handler: UiResolveHandler | undefined
    for (const alias of aliases) {
      handler = this.commands.get(alias)?.get(id)
      if (handler) break
    }
    if (!handler) throw new Error(`没有找到插件命令：${pluginId}/${id}`)
    return handler(params)
  }

  list(): UiContributionEntry[] {
    return [...this.contributions.values()].map(({ owner: _owner, ...entry }) => entry)
  }

  async resolveValue(pluginId: string, id: string, params?: Record<string, unknown>): Promise<unknown> {
    // 插件代码只知道自己的 name（如 native-widget），宿主使用 external:native-widget；
    // 这里同时兼容两种键，避免插件必须知道宿主命名前缀。
    const aliases = [...new Set([pluginId, pluginId.replace(/^external:/, ''), `external:${pluginId}`])]
    let handler: UiResolveHandler | undefined
    for (const alias of aliases) {
      handler = this.resolvers.get(alias)?.get(id)
      if (handler) break
    }
    if (!handler) throw new Error(`没有找到 UI 数据解析器：${pluginId}/${id}`)
    const value = await handler(params)
    // 简单限制返回体积，避免插件把主进程内存/界面拖垮
    const serialized = JSON.stringify(value)
    if (serialized && serialized.length > 256_000) throw new Error('UI 数据超过 256KB 限制')
    return value
  }

  clear(pluginId: string): void {
    this.contributions.delete(pluginId)
    this.resolvers.delete(pluginId)
    this.commands.delete(pluginId)
  }

  /** 插件主动推送事件：主进程事件桥会转发给客户端 */
  emit(pluginId: string, event: string, payload?: unknown): void {
    const id = this.normalizeId(pluginId)
    this.ctx.emit('plugin/ui-event', {
      pluginId: id,
      event: String(event).slice(0, 80),
      payload,
      at: Date.now(),
    })
  }

  /** 插件主动通知：宿主统一展示，限制标题/正文长度 */
  notify(
    pluginId: string,
    notification: { title: string; message?: string; level?: 'info' | 'success' | 'warning' | 'error' },
  ): void {
    const title = String(notification.title ?? '').trim().slice(0, 80)
    if (!title) return
    this.ctx.emit('plugin/notify', {
      pluginId: this.normalizeId(pluginId),
      title,
      message: String(notification.message ?? '').slice(0, 500),
      level: notification.level ?? 'info',
      at: Date.now(),
    })
  }

  private normalizeId(pluginId: string): string {
    if (this.contributions.has(pluginId)) return pluginId
    const external = `external:${pluginId}`
    return this.contributions.has(external) ? external : pluginId
  }
}
