/**
 * Electron 主进程（桌面外壳）。
 *
 * 与 Web 外壳共享同一个内核与同一套 RPC 方法，区别只有两点：
 * 1. 传输层从 WebSocket 换成 Electron IPC（preload 暴露 `window.cordclean`）；
 * 2. 界面由 BrowserWindow 直接加载本地构建产物，无需 HTTP 服务器。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron'
import { createApp, defaultDataDir } from '@cordclean/core'
import { createHandlers, type ShellAdapter } from '@cordclean/host'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')
const uiEntry = process.env.CORDCLEAN_UI_DIR
  ? path.join(process.env.CORDCLEAN_UI_DIR, 'index.html')
  : path.join(repoRoot, 'packages', 'ui', 'dist', 'index.html')

let window: BrowserWindow | null = null
let disposeApp: (() => Promise<void>) | undefined
let quitting = false

/** Electron 外壳的系统交互实现 */
const shellAdapter: ShellAdapter = {
  electron: true,
  async openPath(target: string) {
    await shell.openPath(target)
  },
  async openDataDir(target: string) {
    await shell.openPath(target)
  },
}

async function createKernel() {
  const dataDir = process.env.CORDCLEAN_DATA ?? defaultDataDir()
  const instance = await createApp({
    dataDir,
    logLevel: (process.env.CORDCLEAN_LOG as any) ?? 'info',
    logForward: true,
  })
  disposeApp = () => instance.dispose()

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
    ['history/changed', 'history/changed'],
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
    height: 880,
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
      sandbox: false,
    },
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
