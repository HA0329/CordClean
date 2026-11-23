/**
 * 统一删除入口的「内部通道」：
 * 回收站 $I/$R、启动文件夹快捷方式、隔离区、日志、插件 staging 等内部维护路径
 * 不再由插件直接 fs.unlink，统一交给执行器按 reason 校验前缀后删除。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp, type App } from '@cordclean/core'
import { cleanRecycleItems } from '@cordclean/plugin-recycle'
import startupPlugin from '@cordclean/plugin-startup'
import { createSandbox, manifestOf } from './helpers.ts'

const sandbox = createSandbox()
const apps: App[] = []

afterAll(async () => {
  for (const app of apps) await app.dispose()
  rmSync(sandbox.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

async function boot(name: string, manifest = manifestOf([])): Promise<App> {
  const app = await createApp({
    dataDir: path.join(sandbox.dataDir, name),
    logger: false,
    manifest,
    settingsOverrides: { clean: { mode: 'delete' } },
  })
  apps.push(app)
  return app
}

const silence = { debug() {}, info() {}, warn() {}, error() {} }

describe('执行器内部删除通道', () => {
  it('拒绝删除内部维护目录之外的普通文件（所有 reason）', async () => {
    const app = await boot('internal-deny')
    const victim = sandbox.file('internal/victim.txt', 'must-survive')
    const reasons = ['quarantine', 'logs', 'plugin-staging', 'generated-plugins', 'recycle-bin', 'startup-entry'] as const
    for (const reason of reasons) {
      const result = await app.ctx.executor.deleteInternal(victim, reason)
      expect(result.ok, reason).toBe(false)
    }
    expect(existsSync(victim)).toBe(true)
  })

  it('quarantine 通道只允许删除隔离区内部文件', async () => {
    const app = await boot('internal-quarantine')
    const sessionDir = path.join(app.ctx.quarantine.directory, 'session-probe')
    mkdirSync(sessionDir, { recursive: true })
    const target = path.join(sessionDir, '0001_probe.txt')
    writeFileSync(target, 'abc')
    const result = await app.ctx.executor.deleteInternal(target, 'quarantine')
    expect(result.ok).toBe(true)
    expect(result.bytes).toBe(3)
    expect(existsSync(target)).toBe(false)
  })

  it('startup-entry 通道只接受启动文件夹内的 .lnk/.url', async () => {
    const app = await boot('internal-startup')
    const env = app.ctx.system.env
    const startupDir = path.join(env.appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
    // 不存在路径：校验通过后删除为幂等（bytes=0），不会碰真实文件
    const missing = path.join(startupDir, `__cordclean_probe_${Date.now()}__.lnk`)
    expect((await app.ctx.executor.deleteInternal(missing, 'startup-entry')).ok).toBe(true)
    // 扩展名不对、或不在启动文件夹内 → 拒绝
    expect((await app.ctx.executor.deleteInternal(path.join(startupDir, 'probe.txt'), 'startup-entry')).ok).toBe(false)
    expect((await app.ctx.executor.deleteInternal(path.join(sandbox.root, 'probe.lnk'), 'startup-entry')).ok).toBe(false)
  })
  it('plugin-package / plugin-staging 只允许删除插件目录内部（支持递归目录）', async () => {
    const app = await boot('internal-package')
    const dataDir = app.ctx.system.env.dataDir
    const pkg = path.join(dataDir, 'plugins', 'probe-pkg')
    mkdirSync(path.join(pkg, 'sub'), { recursive: true })
    writeFileSync(path.join(pkg, 'sub', 'a.js'), 'x')
    const removed = await app.ctx.executor.deleteInternal(pkg, 'plugin-package')
    expect(removed.ok).toBe(true)
    expect(existsSync(pkg)).toBe(false)
    // 插件包根目录本身不允许删除
    expect((await app.ctx.executor.deleteInternal(path.join(dataDir, 'plugins'), 'plugin-package')).ok).toBe(false)

    const staging = path.join(dataDir, 'plugins', '.staging', 'probe-stage')
    mkdirSync(staging, { recursive: true })
    writeFileSync(path.join(staging, 'a.js'), 'x')
    expect((await app.ctx.executor.deleteInternal(staging, 'plugin-staging')).ok).toBe(true)
    expect(existsSync(staging)).toBe(false)
  })

  it('mover-source 通道要求源路径在当前允许清理范围内', async () => {
    const app = await boot('internal-mover')
    const file = sandbox.file('mover/source.txt', 'data')
    // 未登记辖区：拒绝
    expect((await app.ctx.executor.deleteInternal(file, 'mover-source')).ok).toBe(false)
    expect(existsSync(file)).toBe(true)
    // 登记辖区后允许
    app.ctx.pathPolicy.addRoot(sandbox.root)
    const removed = await app.ctx.executor.deleteInternal(file, 'mover-source')
    expect(removed.ok).toBe(true)
    expect(existsSync(file)).toBe(false)
  })
})

describe('recycle / startup 走执行器', () => {
  it('recycle 插件通过内部通道删除 $R 与 $I（不再直接 unlink）', async () => {
    const app = await boot('recycle-channel')
    const calls: Array<{ path: string; reason: string }> = []
    const target = 'C:\\$Recycle.Bin\\S-1-5-21-1000-1001-1002-1003\\$RABCDEF.lnk'
    const item = {
      id: 'r1',
      taskId: 'recycle',
      title: '$RABCDEF.lnk',
      path: target,
      kind: 'file' as const,
      size: 123,
      risk: 'safe' as const,
      category: 'system' as const,
      defaultSelected: true,
    }
    const cleanCtx: any = {
      signal: new AbortController().signal,
      logger: silence,
      env: app.ctx.system.env,
      pathPolicy: { check: () => ({ allowed: true }) },
      dryRun: false,
      mode: 'delete',
      deleteInternal: async (value: string, reason: string) => {
        calls.push({ path: value, reason })
        return { ok: true, bytes: 123 }
      },
    }
    const results = await cleanRecycleItems([item], cleanCtx)
    // $R 在临时环境里不存在：走「数据文件已不存在，顺手清 $I」分支，仍经内部通道
    expect(results[0]).toMatchObject({ ok: true, bytes: 0 })
    expect(calls.map((call) => call.reason)).toEqual(['recycle-bin'])
    expect(calls[0].path).toContain('$I')
  })

  it('startup 插件的启动文件夹删除由执行器校验：非启动目录被拒绝', async () => {
    const app = await boot('startup-channel', manifestOf([{ id: 'startup', plugin: startupPlugin }]))
    const victim = sandbox.file('startup/fake-startup.txt', 'must-survive')
    const item = {
      id: 's1',
      taskId: 'startup',
      title: 'fake-startup.txt',
      path: victim,
      kind: 'file' as const,
      size: 1,
      risk: 'caution' as const,
      category: 'startup' as const,
      defaultSelected: true,
    }
    const report = await app.ctx.cleaner.clean({ items: [item] })
    expect(report.cleaned).toBe(0)
    expect(report.failures.length).toBeGreaterThan(0)
    expect(report.failures[0].message).toContain('启动文件夹')
    expect(existsSync(victim)).toBe(true)
  })
})
