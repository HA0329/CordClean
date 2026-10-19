import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from '@cordclean/core'
import { createSandbox, manifestOf } from './helpers.ts'

const sandbox = createSandbox()
afterAll(() => {})

describe('外部插件 worker 安装', () => {
  it('安装后注册任务，扫描经 worker 返回候选', async () => {
    const dir = path.join(sandbox.root, 'ext')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'x.tmp'), 'hello')
    const pluginFile = path.join(sandbox.root, 'plugin.mjs')
    writeFileSync(pluginFile, `
export default {
  name: 'ext-demo',
  Config(raw) { return { size: Number(raw.size ?? 5) } },
  version: '1.0.0',
  capabilities: { fsRoots: [${JSON.stringify(dir).replace(/\\/g, '\\\\')}] },
  setup(ctx, config) {
    ctx.cleaner.define({
      id: 'ext-task', name: '外部任务', category: 'system', risk: 'safe',
      targets: [${JSON.stringify(dir).replace(/\\/g, '\\\\')}],
      scan(scan) { scan.emit({ path: ${JSON.stringify(path.join(dir, 'x.tmp')).replace(/\\/g, '\\\\')}, kind: 'file', size: config.size }) },
    })
  },
}
`, 'utf8')

    const app = await createApp({ dataDir: path.join(sandbox.dataDir, 'ext-install'), logger: false, manifest: manifestOf([]) })
    try {
      await app.ctx.plugins.installExternal(pluginFile)
      const info = app.ctx.plugins.list().find((item) => item.id === 'external:ext-demo')
      if (!info?.enabled) console.log('ERR', info?.error, info?.errorStack?.slice(0, 500))
      expect(info?.enabled).toBe(true)
      const report = await app.ctx.cleaner.scan({ taskIds: ['ext-task'] })
      expect(report.items.length).toBe(1)
      expect(report.items[0].path).toContain('x.tmp')
      expect(report.items[0].size).toBe(5)
      await app.ctx.plugins.updateConfig('external:ext-demo', { size: 9 })
      const updated = await app.ctx.cleaner.scan({ taskIds: ['ext-task'] })
      expect(updated.items[0].size).toBe(9)
      await app.ctx.plugins.disable('external:ext-demo')
      await app.ctx.plugins.enable('external:ext-demo')
      const again = await app.ctx.cleaner.scan({ taskIds: ['ext-task'] })
      expect(again.items.length).toBe(1)
      await app.ctx.plugins.uninstallExternal('external:ext-demo')
    } finally {
      await app.dispose()
    }
  })
})
