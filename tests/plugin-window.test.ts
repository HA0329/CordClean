import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp, type PluginWindowBackend } from '@cordclean/core'

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'cc-plugin-window-'))
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }))

describe('P1 插件窗口/托盘能力', () => {
  it('没有后端时 ctx.window 不可用，open 明确报错', async () => {
    const app = await createApp({ dataDir: path.join(tempRoot, 'nobackend'), logger: false, manifest: [] as any })
    try {
      expect(app.ctx.window.available).toBe(false)
      await expect(
        app.ctx.window.open('external:demo', { id: 'pet', html: '<h1>x</h1>' }),
      ).rejects.toThrow('Electron')
    } finally {
      await app.dispose()
    }
  })

  it('后端注入后可以开关窗口、托盘，并清理插件窗口', async () => {
    const opened: any[] = []
    const closedAll: string[] = []
    const backend: PluginWindowBackend = {
      async open(pluginId, options) {
        opened.push({ pluginId, options })
        return { id: options.id }
      },
      close() {},
      closeAll(pluginId) {
        closedAll.push(pluginId)
      },
      createTray(pluginId, options) {
        options.onSelect?.(options.items[0]?.id ?? '')
        return () => {}
      },
    }
    const app = await createApp({
      dataDir: path.join(tempRoot, 'backend'),
      logger: false,
      manifest: [] as any,
      windowBackend: backend,
    })
    try {
      expect(app.ctx.window.available).toBe(true)
      const result = await app.ctx.window.open('external:demo', {
        id: 'pet',
        html: '<h1>pet</h1>',
        width: 200,
        height: 120,
        transparent: true,
        alwaysOnTop: true,
        clickThrough: true,
      })
      expect(result.id).toBe('pet')
      expect(opened[0].options).toMatchObject({ width: 200, height: 120, transparent: true, alwaysOnTop: true, clickThrough: true })
      let trayClicked = ''
      const disposeTray = app.ctx.window.createTray('external:demo', {
        items: [{ id: 'show', label: '显示' }],
        onSelect: (id) => (trayClicked = id),
      })
      expect(trayClicked).toBe('show')
      disposeTray()
      app.ctx.window.closeAll('external:demo')
      expect(closedAll).toContain('external:demo')
    } finally {
      await app.dispose()
    }
  })

  it('停用原生插件会关闭它的窗口', async () => {
    const closedAll: string[] = []
    const file = path.join(tempRoot, 'window-plugin.mjs')
    writeFileSync(
      file,
      `export const name = 'window-plugin'\nexport function apply() {}\n`,
      'utf8',
    )
    const app = await createApp({
      dataDir: path.join(tempRoot, 'disable'),
      logger: false,
      manifest: [] as any,
      windowBackend: {
        async open(_pluginId, options) {
          return { id: options.id }
        },
        close() {},
        closeAll(pluginId) {
          closedAll.push(pluginId)
        },
        createTray() {
          return () => {}
        },
      },
    })
    try {
      await app.ctx.plugins.installNativePlugin!(file)
      await app.ctx.plugins.disable('external:window-plugin')
      expect(closedAll).toContain('external:window-plugin')
    } finally {
      await app.dispose()
    }
  })
})
