/**
 * Electron 主进程（桌面外壳）。
 *
 * 与 Web 外壳共享同一个内核与同一套 RPC 方法，区别只有两点：
 * 1. 传输层从 WebSocket 换成 Electron IPC（preload 暴露 `window.cordclean`）；
 * 2. 界面由 BrowserWindow 直接加载本地构建产物，无需 HTTP 服务器。
 */
import path from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain, Menu, protocol, shell } from 'electron'
import { createApp, defaultDataDir, resolvePluginClientAsset } from '@cordclean/core'
import { createHandlers, type ShellAdapter } from '@cordclean/host'
import { createElectronWindowBackend } from './window-backend.ts'

/**
 * v2 插件包客户端页面使用的自定义协议。
 * 必须在 app ready 之前声明；standard+secure 让它拥有正常的 URL 语义，
 * 才能被渲染进程的 iframe 以 `cordclean-plugin://<pluginId>/<client 相对路径>` 加载。
 */
const PLUGIN_PROTOCOL = 'cordclean-plugin'
protocol.registerSchemesAsPrivileged([
  {
    scheme: PLUGIN_PROTOCOL,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
])

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')
const uiEntry = process.env.CORDCLEAN_UI_DIR
  ? path.join(process.env.CORDCLEAN_UI_DIR, 'index.html')
  : path.join(repoRoot, 'packages', 'ui', 'dist', 'index.html')

let window: BrowserWindow | null = null
let disposeApp: (() => Promise<void>) | undefined
let quitting = false

/**
 * 是否允许页面导航。
 *
 * 安全策略：
 * - 本地构建产物通过 `file://` 加载，正常页面跳转（含 hash 路由）都放行；
 * - 开发/截图模式允许停留在 `CORDCLEAN_DEV_URL` / `CORDCLEAN_SHOT_URL` 所属源；
 * - 其余（如 `https://` 外链、`javascript:`、`data:`）一律拦截。
 */
function isAllowedNavigation(rawUrl: string): boolean {
  try {
    const target = new URL(rawUrl)
    if (target.protocol === 'file:') return true
    const allowed = [process.env.CORDCLEAN_DEV_URL, process.env.CORDCLEAN_SHOT_URL].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    )
    return allowed.some((entry) => {
      try {
        return target.origin === new URL(entry).origin
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}

/** Electron 外壳的系统交互实现 */
const shellAdapter: ShellAdapter = {
  electron: true,
  async openPath(target: string) {
    const info = await stat(target).catch(() => undefined)
    if (!info) throw new Error('路径不存在：' + target)
    // 文件用「在资源管理器中定位」，目录直接用资源管理器打开；错误必须回传给界面
    if (info.isFile()) {
      shell.showItemInFolder(target)
      return
    }
    const error = await shell.openPath(target)
    if (error) throw new Error(error)
  },
  async openDataDir(target: string) {
    await shell.openPath(target)
  },
}

/**
 * 注册 v2 插件包客户端资源协议。
 *
 * 只从 `<dataDir>/plugins/<pluginId>/client/` 提供文件（由 core 的
 * `resolvePluginClientAsset` 做 id/清单/realpath 越界校验），并附带 CSP：
 * 清单未声明 network 时 connect-src 'none'，避免客户端页面绕过权限外联。
 */
let pluginProtocolRegistered = false

function registerPluginProtocol(dataDir: string): void {
  if (pluginProtocolRegistered) return
  pluginProtocolRegistered = true
  protocol.handle(PLUGIN_PROTOCOL, async (request) => {
    try {
      const url = new URL(request.url)
      const pluginId = url.hostname
      const requestPath = url.pathname.replace(/^\/+/, '')
      const resolved = await resolvePluginClientAsset({ dataDir, pluginId, requestPath })
      if (!resolved.asset) {
        return new Response(resolved.error?.message ?? 'Not Found', {
          status: resolved.error?.status ?? 404,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        })
      }
      const asset = resolved.asset
      const content = await readFile(asset.file)
      return new Response(new Uint8Array(content), {
        status: 200,
        headers: {
          'content-type': asset.contentType,
          'content-security-policy': asset.csp,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-cache',
          'access-control-allow-origin': '*',
        },
      })
    } catch (error) {
      return new Response('Not Found', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    }
  })
}

async function createKernel() {
  const dataDir = process.env.CORDCLEAN_DATA ?? defaultDataDir()
  const instance = await createApp({
    dataDir,
    logLevel: (process.env.CORDCLEAN_LOG as any) ?? 'info',
    logForward: true,
    windowBackend: createElectronWindowBackend(),
  })
  disposeApp = () => instance.dispose()

  // 崩溃/未处理拒绝也写入统一日志，避免主进程退出后没有诊断线索
  process.on('uncaughtException', (error) => {
    instance.ctx.logger.error('未捕获异常：' + (error?.stack ?? String(error)))
  })
  process.on('unhandledRejection', (reason) => {
    const text = reason instanceof Error ? reason.stack ?? reason.message : String(reason)
    instance.ctx.logger.error('未处理的 Promise 拒绝：' + text)
  })

  registerPluginProtocol(instance.dataDir)

  const handlers = createHandlers({
    ctx: instance.ctx,
    dataDir: instance.dataDir,
    version: instance.version,
    bootMs: instance.bootMs,
    shell: shellAdapter,
  })

  // IPC：请求/响应
  ipcMain.handle('cordclean:invoke', async (_event, method: string, params: unknown) => {
    const handler = (handlers as Record<string, (input: any) => any>)[method]
    if (!handler) throw new Error(`未知方法：${method}`)
    try {
      return await handler(params ?? {})
    } catch (error: any) {
      throw new Error(error?.message ?? String(error))
    }
  })

  // IPC：内核事件转发
  const events: Array<[string, string]> = [
    ['cleaner/scan-progress', 'scan/progress'],
    ['cleaner/scan-done', 'scan/done'],
    ['cleaner/clean-progress', 'clean/progress'],
    ['cleaner/clean-done', 'clean/done'],
    ['plugins/changed', 'plugins/changed'],
    ['plugin/ui-event', 'plugin/ui-event'],
    ['plugin/notify', 'plugin/notify'],
    ['history/changed', 'history/changed'],
    // AI 流式增量必须转发，否则桌面外壳要等分析结束才有输出（看起来“不是流式”）
    ['ai/stream', 'ai/stream'],
    ['scheduler/scan', 'scheduler/scan'],
    ['system/log', 'log'],
  ]
  for (const [internal, external] of events) {
    instance.ctx.on(internal as any, (payload: unknown) => {
      window?.webContents.send('cordclean:event', external, payload)
    })
  }

  return instance
}

async function createWindow() {
  window = new BrowserWindow({
    width: 1320,
    height: Number(process.env.CORDCLEAN_SHOT_HEIGHT ?? 880),
    minWidth: 1080,
    minHeight: 720,
    show: false,
    backgroundColor: '#0b0f16',
    title: 'CordClean · 模块化电脑清理工具',
    autoHideMenuBar: true,
    webPreferences: {
      // 截图模式下不注入 preload：让界面走 WebSocket，连接已运行的外部内核
      preload: process.env.CORDCLEAN_SHOT ? undefined : path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // 渲染进程启用 Chromium 沙箱：preload 只能用 electron / 受限 Node API，
      // 已在 sandbox 下验证 preload.cjs（CJS 打包）可正常加载（见 scripts/build-desktop.mjs）
      sandbox: true,
    },
  })

  // 安全加固：禁止页面打开新窗口；只允许 file:// 与当前 dev/shot 源的页面导航
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault()
      console.warn('[cordclean] 已拦截非白名单导航:', url)
    }
  })

  window.once('ready-to-show', () => window?.show())
  window.on('closed', () => {
    window = null
  })

  const target = process.env.CORDCLEAN_SHOT_URL ?? process.env.CORDCLEAN_DEV_URL
  if (target) {
    await window.loadURL(target)
  } else {
    await window.loadFile(uiEntry)
  }
}

/** 截图模式：仅用于开发期界面核验（加载已有服务地址并截图后退出） */
async function runScreenshot() {
  const target = process.env.CORDCLEAN_SHOT_URL
  const output = process.env.CORDCLEAN_SHOT
  if (!target || !output) return
  await createWindow()
  await new Promise((resolve) => setTimeout(resolve, 3500))
  const image = await window!.webContents.capturePage()
  const { writeFileSync } = await import('node:fs')
  writeFileSync(output, image.toPNG())
  console.log('screenshot saved:', output)
  app.quit()
}

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore()
      window.focus()
    }
  })

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: '文件',
          submenu: [{ label: '退出', role: 'quit' }],
        },
        {
          label: '帮助',
          submenu: [{ label: '关于 CordClean', role: 'about' }],
        },
      ]),
    )

    if (process.env.CORDCLEAN_SHOT) {
      await runScreenshot()
      return
    }

    await createKernel()
    await createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow()
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', (event) => {
    if (quitting || !disposeApp) return
    event.preventDefault()
    quitting = true
    void disposeApp()
      .catch(() => {})
      .finally(() => app.quit())
  })
}
