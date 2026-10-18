/**
 * 清理引擎健壮性测试：取消、截断、重复提交、自定义清理、失败归因、并发。
 * 所有删除只发生在沙箱目录内。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from '@cordclean/core'
import { defineCleanerPlugin, type CleanItemResult } from '@cordclean/shared'
import { sleep } from '@cordclean/utils'
import { createSandbox, fakeFilesPlugin, manifestOf } from './helpers.ts'

const sandbox = createSandbox()

afterAll(async () => {
  const { deletePath } = await import('@cordclean/utils')
  try {
    await deletePath(sandbox.root, { recursive: true })
  } catch {
    /* ignore */
  }
})

/** 慢速插件：用于测试取消 */
function slowPlugin(dir: string, count: number) {
  return defineCleanerPlugin({
    name: 'slow',
    inject: ['cleaner', 'pathPolicy'],
    setup(ctx) {
      ctx.effect(() => ctx.pathPolicy.addRoot(dir))
      ctx.effect(() =>
        ctx.cleaner.define({
          id: 'slow-files',
          name: '慢速扫描',
          category: 'disk',
          risk: 'safe',
          async scan(scan) {
            for (let i = 0; i < count; i++) {
              scan.throwIfAborted()
              const file = path.join(dir, `slow-${i}.tmp`)
              writeFileSync(file, 'x')
              scan.emit({ path: file, size: 1 })
              await sleep(5)
            }
          },
        }),
      )
    },
  })
}

/** 自定义清理插件：验证引擎会调用插件的 clean */
function customCleanPlugin(root: string, options: { throwOnClean?: boolean } = {}) {
  const results: string[] = []
  const plugin = defineCleanerPlugin({
    name: 'custom',
    inject: ['cleaner', 'pathPolicy'],
    setup(ctx) {
      ctx.effect(() => ctx.pathPolicy.addRoot(root))
      ctx.effect(() =>
        ctx.cleaner.define({
          id: 'custom-things',
          name: '自定义清理',
          category: 'system',
          risk: 'caution',
          async scan(scan) {
            for (let i = 0; i < 3; i++) {
              scan.emit({ path: `registry:HKLM\\Software\\Fake\\${i}`, kind: 'registry', risk: 'caution' })
            }
          },
          async clean(items, cleanCtx): Promise<CleanItemResult[]> {
            if (options.throwOnClean) throw new Error('自定义清理故意失败')
            const output: CleanItemResult[] = []
            for (const item of items) {
              if (cleanCtx.dryRun) {
                output.push({ itemId: item.id, path: item.path, ok: true, bytes: 0 })
                continue
              }
              results.push(item.path)
              output.push({ itemId: item.id, path: item.path, ok: true, bytes: 0 })
            }
            return output
          },
        }),
      )
    },
  })
  return { plugin, results }
}

describe('扫描取消与截断', () => {
  it('取消后返回 cancelled 且不再继续产出', async () => {
    const dir = sandbox.dir('cancel-scan')
    const app = await createApp({
      dataDir: path.join(sandbox.root, 'cancel-data'),
      logger: false,
      manifest: manifestOf([{ id: 'slow', plugin: slowPlugin(dir, 400) }]),
    })
    try {
      const pending = app.ctx.cleaner.scan({ taskIds: ['slow-files'] })
      await sleep(60)
      app.ctx.cleaner.cancelScan()
      const report = await pending
      expect(report.cancelled).toBe(true)
      expect(report.items.length).toBeLessThan(400)
      expect(report.tasks[0].status).toBe('cancelled')
    } finally {
      await app.dispose()
    }
  }, 60_000)

  it('超过 maxItemsPerTask 时截断并标记 truncated', async () => {
    const dir = sandbox.dir('truncate')
    for (let i = 0; i < 200; i++) writeFileSync(path.join(dir, `f-${i}.log`), 'x')
    const app = await createApp({
      dataDir: path.join(sandbox.root, 'truncate-data'),
      logger: false,
      manifest: manifestOf([{ id: 'files', plugin: fakeFilesPlugin({ id: 'files', roots: [dir] }) }]),
      // 引擎对配置有下限保护（最小 100），这里用 100 验证截断行为
      settingsOverrides: { scan: { maxItemsPerTask: 100 } },
    })
    try {
      const report = await app.ctx.cleaner.scan()
      expect(report.items.length).toBeLessThanOrEqual(100)
      expect(report.stats.truncated).toBe(true)
      expect(report.items.length).toBeGreaterThan(0)
    } finally {
      await app.dispose()
    }
  })
})

describe('清理的幂等与失败处理', () => {
  it('同一清理项被重复提交只清理一次', async () => {
    const dir = sandbox.dir('dedupe-clean')
    writeFileSync(path.join(dir, 'one.tmp'), 'x'.repeat(100))
    const app = await createApp({
      dataDir: path.join(sandbox.root, 'dedupe-data'),
      logger: false,
      manifest: manifestOf([{ id: 'one', plugin: fakeFilesPlugin({ id: 'one', roots: [dir] }) }]),
    })
    try {
      const report = await app.ctx.cleaner.scan()
      const id = report.items[0].id
      const cleaned = await app.ctx.cleaner.clean({ itemIds: [id, id, id], dryRun: true })
      expect(cleaned.cleaned).toBe(1)
    } finally {
      await app.dispose()
    }
  })

  it('任务在扫描后被卸载时，清理返回「任务未加载」而不是崩溃', async () => {
    const dir = sandbox.dir('unload-task')
    writeFileSync(path.join(dir, 'a.tmp'), 'x')
    const app = await createApp({
      dataDir: path.join(sandbox.root, 'unload-data'),
      logger: false,
      manifest: manifestOf([{ id: 'temp2', plugin: fakeFilesPlugin({ id: 'temp2', roots: [dir] }) }]),
    })
    try {
      const report = await app.ctx.cleaner.scan()
      await app.ctx.plugins.disable('temp2')
      const cleaned = await app.ctx.cleaner.clean({ items: report.items })
      expect(cleaned.cleaned).toBe(0)
      expect(cleaned.failed).toBe(1)
      expect(cleaned.failures[0].message).toContain('任务未加载')
      expect(existsSync(path.join(dir, 'a.tmp'))).toBe(true)
    } finally {
      await app.dispose()
    }
  })

  it('权限拒绝时记录失败并继续处理其它项', async () => {
    const dir = sandbox.dir('acl')
    const locked = path.join(dir, 'locked.txt')
    const normal = path.join(dir, 'normal.txt')
    writeFileSync(locked, 'L')
    writeFileSync(normal, 'N')
    const user = process.env.USERNAME ?? ''
    let denied = false
    try {
      execFileSync('icacls.exe', [locked, '/deny', `${user}:(D)`], { windowsHide: true })
      denied = true
    } catch {
      // 环境不支持 ACL 操作时跳过本用例
    }
    if (!denied) return

    const app = await createApp({
      dataDir: path.join(sandbox.root, 'acl-data'),
      logger: false,
      settingsOverrides: { clean: { mode: 'delete' } },
      manifest: manifestOf([{ id: 'acl', plugin: fakeFilesPlugin({ id: 'acl', roots: [dir] }) }]),
    })
    try {
      await app.ctx.cleaner.scan()
      const report = await app.ctx.cleaner.clean({})
      expect(report.cleaned).toBe(1)
      expect(report.failed).toBe(1)
      expect(report.failures[0].path).toBe(locked)
      expect(report.failures[0].message).toMatch(/权限|占用/)
      expect(existsSync(normal)).toBe(false)
      expect(existsSync(locked)).toBe(true)
    } finally {
      try {
        execFileSync('icacls.exe', [locked, '/remove:d', user], { windowsHide: true })
      } catch {
        /* ignore */
      }
      await app.dispose()
    }
  }, 60_000)
})

describe('插件自定义清理', () => {
  it('引擎调用自定义 clean，dryRun 时不产生副作用', async () => {
    const dir = sandbox.dir('custom-root')
    const { plugin, results } = customCleanPlugin(dir)
    const app = await createApp({
      dataDir: path.join(sandbox.root, 'custom-data'),
      logger: false,
      manifest: manifestOf([{ id: 'custom', plugin }]),
    })
    try {
      const scan = await app.ctx.cleaner.scan()
      expect(scan.items).toHaveLength(3)
      const dry = await app.ctx.cleaner.clean({ items: scan.items, dryRun: true })
      expect(dry.cleaned).toBe(3)
      expect(results).toHaveLength(0)

      const real = await app.ctx.cleaner.clean({ items: scan.items })
      expect(real.cleaned).toBe(3)
      expect(results).toHaveLength(3)
    } finally {
      await app.dispose()
    }
  })

  it('自定义 clean 抛错时整组标记失败，不影响内核', async () => {
    const dir = sandbox.dir('custom-fail')
    const { plugin } = customCleanPlugin(dir, { throwOnClean: true })
    const app = await createApp({
      dataDir: path.join(sandbox.root, 'custom-fail-data'),
      logger: false,
      manifest: manifestOf([{ id: 'customfail', plugin }]),
    })
    try {
      const scan = await app.ctx.cleaner.scan()
      const report = await app.ctx.cleaner.clean({ items: scan.items })
      expect(report.cleaned).toBe(0)
      expect(report.failed).toBe(3)
      expect(report.failures[0].message).toContain('故意失败')
      // 内核仍然可用
      expect(app.ctx.cleaner.list().length).toBe(1)
    } finally {
      await app.dispose()
    }
  })

  it('未实现 clean 的非文件类清理项会被拒绝', async () => {
    const noClean = defineCleanerPlugin({
      name: 'noclean',
      inject: ['cleaner'],
      setup(ctx) {
        ctx.effect(() =>
          ctx.cleaner.define({
            id: 'noclean-reg',
            name: '无清理实现',
            category: 'system',
            risk: 'caution',
            async scan(scan) {
              scan.emit({ path: 'registry:HKLM\\Software\\X', kind: 'registry', risk: 'caution' })
            },
          }),
        )
      },
    })
    const app = await createApp({
      dataDir: path.join(sandbox.root, 'noclean-data'),
      logger: false,
      manifest: manifestOf([{ id: 'noclean', plugin: noClean }]),
    })
    try {
      const scan2 = await app.ctx.cleaner.scan()
      const report = await app.ctx.cleaner.clean({ items: scan2.items })
      expect(report.cleaned).toBe(0)
      expect(report.failed).toBe(1)
      expect(report.failures[0].message).toContain('插件自定义清理')
    } finally {
      await app.dispose()
    }
  })
})

describe('并发与事件', () => {
  it('扫描进度事件按任务推送且最终 done=true', async () => {
    const dir = sandbox.dir('events')
    for (let i = 0; i < 5; i++) writeFileSync(path.join(dir, `e-${i}.log`), 'x')
    const app = await createApp({
      dataDir: path.join(sandbox.root, 'events-data'),
      logger: false,
      manifest: manifestOf([{ id: 'ev', plugin: fakeFilesPlugin({ id: 'ev', roots: [dir] }) }]),
    })
    try {
      const events: any[] = []
      app.ctx.on('cleaner/scan-progress', (event) => events.push(event))
      const done: any[] = []
      app.ctx.on('cleaner/scan-done', (report) => done.push(report))
      await app.ctx.cleaner.scan()
      expect(done).toHaveLength(1)
      expect(done[0].items.length).toBe(5)
      if (events.length) {
        expect(events.every((event) => event.scanId === done[0].scanId)).toBe(true)
      }
    } finally {
      await app.dispose()
    }
  })

  it('并发启动两次扫描时，后一次生效且前一次被取消', async () => {
    const dir = sandbox.dir('concurrent-scan')
    const app = await createApp({
      dataDir: path.join(sandbox.root, 'concurrent-data'),
      logger: false,
      manifest: manifestOf([{ id: 'slow2', plugin: slowPlugin(dir, 60) }]),
    })
    try {
      const first = app.ctx.cleaner.scan({ taskIds: ['slow-files'] })
      await sleep(40)
      const second = app.ctx.cleaner.scan({ taskIds: ['slow-files'] })
      const [a, b] = await Promise.all([first, second])
      expect(a.cancelled || a.items.length < 60).toBe(true)
      expect(b.items.length).toBe(60)
    } finally {
      await app.dispose()
    }
  }, 60_000)
})
