import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from '@cordclean/core'
import { createHandlers } from '../packages/host/src/api.ts'

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'cc-workshop-api-'))
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }))

const NO_DEPS_CODE = `export default {
  name: 'workshop-e2e',
  version: '1.0.0',
  description: '工坊安装链路测试',
  capabilities: { fsRoots: ['%TEMP%'] },
  setup(ctx) {
    const base = String(ctx.system.env.get('TEMP') || '')
    ctx.cleaner.define({
      id: 'workshop-e2e-task',
      name: '工坊测试任务',
      category: 'apps',
      risk: 'safe',
      targets: [base],
      scan(scan) { scan.emit({ path: base, kind: 'folder', size: 0 }) },
    })
  },
}
`

const DEP_CODE = NO_DEPS_CODE.replace('workshop-e2e', 'workshop-dep').replace(
  "setup(ctx) {",
  "setup(ctx) {\n    const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)\n    if (!isNumber(1)) throw new Error('demo')",
)

async function makeHandlers(name: string) {
  const dataDir = path.join(tempRoot, name)
  mkdirSync(dataDir, { recursive: true })
  const app = await createApp({ dataDir, logger: false, manifest: [] as any })
  const handlers = createHandlers({
    ctx: app.ctx,
    dataDir,
    version: 'test',
    bootMs: 0,
    shell: {
      electron: false,
      async openPath() {},
      async openDataDir() {},
    },
  })
  return { app, dataDir, handlers }
}

describe('插件工坊安装 API 与残留清理', () => {
  it('零依赖插件：安装成功 → 卸载删除生成文件', async () => {
    const { app, dataDir, handlers } = await makeHandlers('no-deps')
    try {
      const result = await handlers['ai/plugin/install']({ name: 'workshop-e2e', code: NO_DEPS_CODE })
      expect(result.id).toBe('external:workshop-e2e')
      expect(existsSync(result.path)).toBe(true)
      const plugin = app.ctx.plugins.list().find((item) => item.id === 'external:workshop-e2e')
      expect(plugin?.enabled).toBe(true)
      expect(app.ctx.cleaner.list().some((task) => task.id === 'workshop-e2e-task')).toBe(true)

      await handlers['plugins/uninstall']({ id: 'external:workshop-e2e' })
      expect(existsSync(result.path)).toBe(false)
      expect(app.ctx.plugins.list().some((item) => item.id === 'external:workshop-e2e')).toBe(false)
    } finally {
      await app.dispose()
    }
    expect(existsSync(dataDir)).toBe(true)
  })

  it('声明依赖但未确认时拒绝安装，不落文件', async () => {
    const { app, dataDir, handlers } = await makeHandlers('need-ack')
    try {
      await expect(
        handlers['ai/plugin/install']({
          name: 'workshop-dep',
          code: DEP_CODE,
          dependencies: { 'is-number': '^7.0.0' },
        }),
      ).rejects.toThrow(/确认/)
      expect(existsSync(path.join(dataDir, 'generated-plugins', 'workshop-dep'))).toBe(false)
    } finally {
      await app.dispose()
    }
  })

  it('依赖安装失败：报错并清理插件目录（模拟 npm/pnpm 不可用）', async () => {
    const { app, dataDir, handlers } = await makeHandlers('dep-fail')
    const originalPath = process.env.PATH
    process.env.PATH = ''
    try {
      await expect(
        handlers['ai/plugin/install']({
          name: 'workshop-dep',
          code: DEP_CODE,
          dependencies: { 'is-number': '^7.0.0' },
          acknowledgeDependencies: true,
        }),
      ).rejects.toThrow(/安装失败/)
      expect(existsSync(path.join(dataDir, 'generated-plugins', 'workshop-dep'))).toBe(false)
      expect(app.ctx.plugins.list().some((item) => item.id === 'external:workshop-dep')).toBe(false)
    } finally {
      process.env.PATH = originalPath
      await app.dispose()
    }
  })

  it('安装后重启仍能自动加载（持久化 externalPath）', async () => {
    const { app, dataDir, handlers } = await makeHandlers('persist')
    let file = ''
    try {
      const installed = await handlers['ai/plugin/install']({ name: 'workshop-e2e', code: NO_DEPS_CODE })
      file = installed.path
      expect(existsSync(file)).toBe(true)
    } finally {
      await app.dispose()
    }
    const app2 = await createApp({ dataDir, logger: false, manifest: [] as any })
    try {
      const plugin = app2.ctx.plugins.list().find((item) => item.id === 'external:workshop-e2e')
      expect(plugin?.enabled).toBe(true)
      expect(app2.ctx.cleaner.list().some((task) => task.id === 'workshop-e2e-task')).toBe(true)
      // 启动清理不能把已持久化的插件文件删掉
      createHandlers({
        ctx: app2.ctx,
        dataDir,
        version: 'test',
        bootMs: 0,
        shell: { electron: false, async openPath() {}, async openDataDir() {} },
      })
      expect(existsSync(file)).toBe(true)
    } finally {
      await app2.dispose()
    }
  })

  it('启动时清理上一次运行留下的 generated-plugins', async () => {
    const { app, dataDir } = await makeHandlers('startup-clean')
    await app.dispose()
    const stale = path.join(dataDir, 'generated-plugins', 'stale-plugin')
    mkdirSync(path.join(stale, 'node_modules'), { recursive: true })
    writeFileSync(path.join(stale, 'plugin.mjs'), 'export default { name: "stale" }')
    const app2 = await createApp({ dataDir, logger: false, manifest: [] as any })
    try {
      createHandlers({
        ctx: app2.ctx,
        dataDir,
        version: 'test',
        bootMs: 0,
        shell: { electron: false, async openPath() {}, async openDataDir() {} },
      })
      expect(existsSync(path.join(dataDir, 'generated-plugins'))).toBe(false)
    } finally {
      await app2.dispose()
    }
  })
})
