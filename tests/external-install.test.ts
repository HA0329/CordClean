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
      // 外部插件 target 只允许注册为清理根（addRoot），不得进入清空白名单（addClearRoot）
      expect(app.ctx.pathPolicy.check(path.join(dir, 'x.tmp')).allowed).toBe(true)
      expect(app.ctx.pathPolicy.checkClear(dir).allowed).toBe(false)
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

  it('target 不在 capabilities.fsRoots 内时跳过任务，且不注册清空白名单', async () => {
    const inside = sandbox.dir('boundary-inside')
    const outside = sandbox.dir('boundary-outside')
    const pluginFile = path.join(sandbox.root, 'boundary-plugin.mjs')
    writeFileSync(pluginFile, `
export default {
  name: 'ext-boundary',
  version: '1.0.0',
  capabilities: { fsRoots: [${JSON.stringify(inside)}] },
  setup(ctx) {
    ctx.cleaner.define({ id: 'valid-task', name: '合法任务', category: 'system', risk: 'safe', targets: [${JSON.stringify(inside)}], scan() {} })
    ctx.cleaner.define({ id: 'outside-task', name: '越界任务', category: 'system', risk: 'safe', targets: [${JSON.stringify(outside)}], scan() {} })
    ctx.cleaner.define({ id: 'mixed-task', name: '混合任务', category: 'system', risk: 'safe', targets: [${JSON.stringify(inside)}, ${JSON.stringify(outside)}], scan() {} })
    ctx.cleaner.define({ id: 'empty-task', name: '无目标任务', category: 'system', risk: 'safe', targets: [], scan() {} })
  },
}
`, 'utf8')

    const app = await createApp({ dataDir: path.join(sandbox.dataDir, 'ext-boundary'), logger: false, manifest: manifestOf([]) })
    try {
      // 不应因某个任务越界而整体安装失败，也不应阻塞同插件的合法任务
      await app.ctx.plugins.installExternal(pluginFile)
      const info = app.ctx.plugins.list().find((item) => item.id === 'external:ext-boundary')
      expect(info?.enabled).toBe(true)

      const taskIds = app.ctx.cleaner.list().map((task) => task.id)
      expect(taskIds).toContain('valid-task')
      expect(taskIds).toContain('empty-task')
      expect(taskIds).not.toContain('outside-task')
      expect(taskIds).not.toContain('mixed-task')

      // 合法 target 已 addRoot
      expect(app.ctx.pathPolicy.check(path.join(inside, 'a.tmp')).allowed).toBe(true)
      // 越界 target 没有注册为允许根
      expect(app.ctx.pathPolicy.check(path.join(outside, 'a.tmp')).allowed).toBe(false)
      // 外部插件不得获得清空白名单：无论合法还是越界 target，checkClear 都应拒绝
      expect(app.ctx.pathPolicy.checkClear(inside).allowed).toBe(false)
      expect(app.ctx.pathPolicy.checkClear(outside).allowed).toBe(false)

      await app.ctx.plugins.uninstallExternal('external:ext-boundary')
    } finally {
      await app.dispose()
    }
  })
})
