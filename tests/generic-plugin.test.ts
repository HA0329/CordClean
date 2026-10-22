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
}

export function apply(ctx) {
  ctx.effect(() => ctx.ui.resolve('native-widget', 'hello', () => ({ value: 42 })))
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
      await expect(app.ctx.ui.resolveValue(result.id, 'hello')).resolves.toEqual({ value: 42 })
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



