/**
 * Electron 侧插件窗口/托盘后端。
 *
 * 仅桌面壳加载；窗口使用独立 BrowserWindow + data URL 自包含 HTML，
 * nodeIntegration=false / contextIsolation=true / sandbox=true。
 */
import { BrowserWindow, Menu, Tray, nativeImage } from 'electron'
import type { PluginWindowBackend } from '@cordclean/core'

export function createElectronWindowBackend(): PluginWindowBackend {
  const windows = new Map<string, BrowserWindow>()
  const trays = new Map<string, Tray>()
  const keyOf = (pluginId: string, windowId: string) => `${pluginId}\u0000${windowId}`

  return {
    async open(pluginId, options) {
      const key = keyOf(pluginId, options.id)
      const existing = windows.get(key)
      if (existing && !existing.isDestroyed()) {
        existing.show()
        existing.focus()
        return { id: options.id }
      }
      const win = new BrowserWindow({
        width: options.width,
        height: options.height,
        x: options.x,
        y: options.y,
        title: options.title,
        frame: false,
        transparent: options.transparent,
        backgroundColor: options.transparent ? '#00000000' : '#ffffff',
        alwaysOnTop: options.alwaysOnTop,
        resizable: options.resizable,
        skipTaskbar: options.skipTaskbar,
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          devTools: false,
        },
      })
      win.setMenuBarVisibility(false)
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      win.webContents.on('will-navigate', (event) => event.preventDefault())
      if (options.clickThrough) win.setIgnoreMouseEvents(true, { forward: true })
      win.once('ready-to-show', () => win.show())
      win.on('closed', () => windows.delete(key))
      windows.set(key, win)
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(options.html))
      return { id: options.id }
    },

    close(pluginId, windowId) {
      const key = keyOf(pluginId, windowId)
      const win = windows.get(key)
      if (win && !win.isDestroyed()) win.close()
      windows.delete(key)
    },

    closeAll(pluginId) {
      const prefix = `${pluginId}\u0000`
      for (const [key, win] of windows) {
        if (!key.startsWith(prefix)) continue
        if (!win.isDestroyed()) win.close()
        windows.delete(key)
      }
      for (const [key, tray] of trays) {
        if (!key.startsWith(prefix)) continue
        tray.destroy()
        trays.delete(key)
      }
    },

    createTray(pluginId, options) {
      const key = keyOf(pluginId, 'tray')
      trays.get(key)?.destroy()
      const image = options.iconDataUrl
        ? nativeImage.createFromDataURL(options.iconDataUrl)
        : nativeImage.createEmpty()
      const tray = new Tray(image)
      if (options.tooltip) tray.setToolTip(options.tooltip)
      const menu = Menu.buildFromTemplate(
        options.items.map((item) => ({
          label: item.label,
          click: () => {
            try {
              options.onSelect?.(item.id)
            } catch {
              /* 插件回调异常不能拖垮托盘 */
            }
          },
        })),
      )
      tray.setContextMenu(menu)
      trays.set(key, tray)
      return () => {
        const current = trays.get(key)
        if (current === tray) {
          tray.destroy()
          trays.delete(key)
        }
      }
    },
  }
}
