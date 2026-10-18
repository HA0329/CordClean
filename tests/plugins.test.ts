import { rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from '@cordclean/core'
import { defineCleanerPlugin } from '@cordclean/shared'
import { createSandbox, fakeFilesPlugin, manifestOf } from './helpers.ts'

const sandbox = createSandbox()
const dir = sandbox.dir('plugin-files')
sandbox.file('plugin-files/a.log', 'a'.repeat(8))

const okPlugin = fakeFilesPlugin({ id: 'ok', roots: [dir] })
const brokenPlugin = defineCleanerPlugin({
  name: 'broken',
  setup() {
    throw new Error('故意抛出的启动错误')
  },
})

const app = await createApp({
  dataDir: sandbox.dataDir,
  logger: false,
  manifest: manifestOf([
    { id: 'ok', plugin: okPlugin },
    { id: 'broken', plugin: brokenPlugin },
  ]),
})

afterAll(async () => {
  await app.dispose()
  rmSync(sandbox.root, { recursive: true, force: true })
})

describe('插件管理器', () => {
  it('插件启动失败时被隔离，不影响其它插件与内核', () => {
    const plugins = app.ctx.plugins.list()
    const ok = plugins.find((plugin) => plugin.id === 'ok')!
    const broken = plugins.find((plugin) => plugin.id === 'broken')!
    expect(ok.status).toBe('active')
    expect(ok.taskCount).toBe(1)
    expect(broken.status).toBe('error')
    expect(broken.error).toContain('故意抛出')
    // 内核仍然可用
    expect(app.ctx.cleaner.list().map((task) => task.id)).toEqual(['ok-files'])
  })

  it('停用插件会注销其注册的清理任务', async () => {
    await app.ctx.plugins.disable('ok')
    expect(app.ctx.cleaner.list()).toHaveLength(0)
    expect(app.ctx.plugins.list().find((plugin) => plugin.id === 'ok')!.status).toBe('stopped')

    await app.ctx.plugins.enable('ok')
    expect(app.ctx.cleaner.list().map((task) => task.id)).toEqual(['ok-files'])
  })

  it('热重载不会产生重复任务 id（说明旧任务已随 fiber 卸载）', async () => {
    await app.ctx.plugins.reload('ok')
    await app.ctx.plugins.reload('ok')
    expect(app.ctx.cleaner.list().filter((task) => task.id === 'ok-files')).toHaveLength(1)
  })

  it('启用状态与配置被持久化到设置', async () => {
    const settings = app.ctx.settings.get()
    expect(settings.plugins.ok?.enabled).toBe(true)
    await app.ctx.plugins.updateConfig('ok', { hello: 'world' })
    expect(app.ctx.settings.get().plugins.ok?.config).toEqual({ hello: 'world' })
  })

  it('配置文件损坏时能回退到默认设置', async () => {
    const { writeFileSync } = await import('node:fs')
    const path = await import('node:path')
    const file = path.join(sandbox.dataDir, 'config.json')
    writeFileSync(file, '{ 这不是合法 JSON', 'utf8')
    const broken = await createApp({ dataDir: sandbox.dataDir, logger: false, loadPlugins: false })
    expect(broken.ctx.settings.get().scan.concurrency).toBeGreaterThanOrEqual(1)
    await broken.dispose()
  })
})
