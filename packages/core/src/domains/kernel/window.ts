/**
 * 插件窗口/托盘服务（P1 最后一块）。
 *
 * 内核不直接依赖 Electron：桌面壳启动后通过 `attachBackend()` 注入
 * BrowserWindow/Tray 实现；浏览器壳没有后端，`available === false`。
 * 插件通过 `ctx.window` 使用；窗口 HTML 在独立 BrowserWindow 中运行，
 * 默认 nodeIntegration=false / contextIsolation=true。
 */
import { Service, type Context } from 'cordis'
import type {
  PluginTrayOptions,
  PluginWindowApi,
  PluginWindowOptions,
} from '@cordclean/shared'

export interface PluginWindowBackend {
  open(pluginId: string, options: Required<Omit<PluginWindowOptions, 'x' | 'y' | 'title'>> & { x?: number; y?: number; title?: string }): Promise<{ id: string }>
  close(pluginId: string, windowId: string): void
  closeAll(pluginId: string): void
  createTray(pluginId: string, options: PluginTrayOptions): () => void
}

const MAX_HTML = 512_000

export class PluginWindowService extends Service implements PluginWindowApi {
  private backend?: PluginWindowBackend

  constructor(ctx: Context) {
    super(ctx, 'window')
  }

  get available(): boolean {
    return Boolean(this.backend)
  }

  attachBackend(backend: PluginWindowBackend): void {
    this.backend = backend
  }

  detachBackend(): void {
    this.backend = undefined
  }

  async open(pluginId: string, options: PluginWindowOptions): Promise<{ id: string }> {
    if (!this.backend) throw new Error('窗口能力仅在 Electron 桌面壳可用')
    const id = String(options.id ?? '').trim()
    if (!id || id.length > 80) throw new Error('窗口 id 无效')
    const html = String(options.html ?? '')
    if (!html.trim()) throw new Error('窗口 html 不能为空')
    if (html.length > MAX_HTML) throw new Error('窗口 html 超过 512KB 限制')
    const width = Math.min(1600, Math.max(50, Number(options.width ?? 320)))
    const height = Math.min(1200, Math.max(50, Number(options.height ?? 240)))
    return this.backend.open(pluginId, {
      id,
      html,
      title: String(options.title ?? 'CordClean 插件窗口').slice(0, 80),
      width,
      height,
      x: options.x,
      y: options.y,
      transparent: options.transparent === true,
      alwaysOnTop: options.alwaysOnTop === true,
      resizable: options.resizable === true,
      skipTaskbar: options.skipTaskbar === true,
      clickThrough: options.clickThrough === true,
    })
  }

  close(pluginId: string, windowId: string): void {
    this.backend?.close(pluginId, windowId)
  }

  closeAll(pluginId: string): void {
    this.backend?.closeAll(pluginId)
  }

  createTray(pluginId: string, options: PluginTrayOptions): () => void {
    if (!this.backend) throw new Error('托盘能力仅在 Electron 桌面壳可用')
    const items = (options.items ?? []).slice(0, 20).map((item) => ({
      id: String(item.id).slice(0, 80),
      label: String(item.label).slice(0, 80),
    }))
    if (!items.length) throw new Error('托盘菜单至少需要一个菜单项')
    return this.backend.createTray(pluginId, {
      tooltip: String(options.tooltip ?? '').slice(0, 120),
      iconDataUrl: options.iconDataUrl,
      items,
      onSelect: options.onSelect,
    })
  }
}
