import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from '@cordclean/core'

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'cc-native-plugin-'))
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }))

const PLUGIN = `
export const name = 'native-widget'
export const inject = ['ui']
export const kind = 'widget'
export const description = 'P1 通用插件测试'
export const contributes = {
  overviewCards: [{ id: 'hello', title: 'Hello P1', type: 'text', fallback: 'fallback' }],
  pages: [{ id: 'page', title: 'P1 页面', mode: 'iframe', html: '<h1>ok</h1>' }],
  statusItems: [{ id: 'mode', label: '模式', resolve: 'mode' }],
  commands: [{ id: 'say-hi', title: '打招呼', rpc: 'say-hi' }],
}

export function apply(ctx) {
  ctx.effect(() => ctx.ui.resolve('native-widget', 'hello', () => ({ value: 42 })))
  ctx.effect(() => ctx.ui.resolve('native-widget', 'mode', () => 'demo'))
  ctx.effect(() => ctx.ui.command('native-widget', 'say-hi', () => ({ ok: true })))
  ctx.ui.emit('native-widget', 'refreshed', { value: 7 })
  ctx.ui.notify('native-widget', { title: 'P1 通知', message: 'ok', level: 'success' })
}
`

async function makePluginFile(dir: string): Promise<string> {
  const file = path.join(dir, 'native-widget.mjs')
  writeFileSync(file, PLUGIN, 'utf8')
  return file
}

describe('P1 通用插件：原生 Cordis 插件与 UI 贡献', () => {
  it('原生外部插件安装后可注册 UI 贡献并解析数据', async () => {
    const dataDir = path.join(tempRoot, 'app1')
    const file = await makePluginFile(tempRoot)
    const app = await createApp({ dataDir, logger: false, manifest: [] as any })
    const events: any[] = []
    const notices: any[] = []
    app.ctx.on('plugin/ui-event', (event) => events.push(event))
    app.ctx.on('plugin/notify', (event) => notices.push(event))
    try {
      const result = await app.ctx.plugins.installNativePlugin!(file)
      expect(result.id).toBe('external:native-widget')
      const plugin = app.ctx.plugins.list().find((item) => item.id === result.id)
      expect(plugin?.source).toBe('external')
      expect(plugin?.enabled).toBe(true)
      const contributions = app.ctx.ui.list()
      const entry = contributions.find((item) => item.pluginId === result.id)
      expect(entry?.kind).toBe('widget')
      expect(entry?.contributions.overviewCards?.[0]).toMatchObject({ id: 'hello', title: 'Hello P1' })
      expect(entry?.contributions.pages?.[0]?.title).toBe('P1 页面')
      expect(entry?.contributions.statusItems?.[0]?.label).toBe('模式')
      expect(entry?.contributions.commands?.[0]?.title).toBe('打招呼')
      await expect(app.ctx.ui.runCommand(result.id, 'say-hi')).resolves.toEqual({ ok: true })
      await expect(app.ctx.ui.resolveValue(result.id, 'hello')).resolves.toEqual({ value: 42 })
      expect(events.some((event) => event.event === 'refreshed' && event.payload?.value === 7)).toBe(true)
      expect(notices.some((event) => event.title === 'P1 通知' && event.level === 'success')).toBe(true)
    } finally {
      await app.dispose()
    }
  })

  it('旧工坊插件漏写 inject 时按源码自动补齐并成功加载', async () => {
    const dataDir = path.join(tempRoot, 'auto-inject')
    const file = path.join(tempRoot, 'native-no-inject.mjs')
    writeFileSync(
      file,
      `export const name = 'native-no-inject'
export const kind = 'widget'
export function apply(ctx) {
  ctx.effect(() => ctx.ui.resolve('native-no-inject', 'x', () => ({ text: 'ok' })))
}
`,
      'utf8',
    )
    const app = await createApp({ dataDir, logger: false, manifest: [] as any })
    try {
      await app.ctx.plugins.installNativePlugin!(file)
      const plugin = app.ctx.plugins.list().find((item) => item.id === 'external:native-no-inject')
      expect(plugin?.enabled).toBe(true)
      expect(plugin?.status).toBe('active')
      await expect(app.ctx.ui.resolveValue('external:native-no-inject', 'x')).resolves.toEqual({ text: 'ok' })
    } finally {
      await app.dispose()
    }
  })

  it('原生插件持久化后重启自动加载，禁用后移除 UI 贡献', async () => {
    const dataDir = path.join(tempRoot, 'app2')
    const file = await makePluginFile(tempRoot)
    const app = await createApp({ dataDir, logger: false, manifest: [] as any })
    try {
      await app.ctx.plugins.installNativePlugin!(file)
      expect(app.ctx.ui.list().some((item) => item.pluginId === 'external:native-widget')).toBe(true)
      await app.ctx.plugins.disable('external:native-widget')
      expect(app.ctx.ui.list().some((item) => item.pluginId === 'external:native-widget')).toBe(false)
    } finally {
      await app.dispose()
    }

    const app2 = await createApp({ dataDir, logger: false, manifest: [] as any })
    try {
      const plugin = app2.ctx.plugins.list().find((item) => item.id === 'external:native-widget')
      expect(plugin?.enabled).toBe(false)
      expect(app2.ctx.ui.list().some((item) => item.pluginId === 'external:native-widget')).toBe(false)
      await app2.ctx.plugins.enable('external:native-widget')
      expect(app2.ctx.ui.list().some((item) => item.pluginId === 'external:native-widget')).toBe(true)
    } finally {
      await app2.dispose()
    }
  })
})



