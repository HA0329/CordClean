/**
 * 状态层测试：设置持久化与边界、历史记录健壮性、反复启停不泄漏。
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from '@cordclean/core'
import { defineCleanerPlugin, type HistoryEntry } from '@cordclean/shared'
import { createSandbox, manifestOf } from './helpers.ts'

const sandbox = createSandbox()

afterAll(async () => {
  const { deletePath } = await import('@cordclean/utils')
  try {
    await deletePath(sandbox.root, { recursive: true })
  } catch {
    /* ignore */
  }
})

function makeEntry(index: number, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    sessionId: `s${index}`,
    startedAt: Date.now() + index,
    elapsedMs: 10,
    taskIds: ['temp'],
    freedBytes: 100 * (index + 1),
    cleaned: index + 1,
    quarantined: 0,
    failed: 0,
    dryRun: false,
    ...overrides,
  }
}

describe('设置服务', () => {
  it('写入会被范围校正（防止手改配置越界）', async () => {
    const app = await createApp({ dataDir: path.join(sandbox.root, 'settings-1'), logger: false, loadPlugins: false })
    try {
      app.ctx.settings.set('scan.concurrency', 999)
      expect(app.ctx.settings.get().scan.concurrency).toBe(8)
      app.ctx.settings.set('scan.concurrency', -5)
      expect(app.ctx.settings.get().scan.concurrency).toBe(1)
      app.ctx.settings.set('scan.maxDepth', 100000)
      expect(app.ctx.settings.get().scan.maxDepth).toBe(128)
    } finally {
      await app.dispose()
    }
  })

  it('点号路径可写入新字段，深合并保留其它配置', async () => {
    const app = await createApp({ dataDir: path.join(sandbox.root, 'settings-2'), logger: false, loadPlugins: false })
    try {
      app.ctx.settings.set('plugins.custom.config.threshold', 42)
      const settings = app.ctx.settings.get()
      expect(settings.plugins.custom?.config).toMatchObject({ threshold: 42 })
      expect(settings.scan.concurrency).toBeGreaterThan(0)
    } finally {
      await app.dispose()
    }
  })

  it('配置落盘后重启仍生效', async () => {
    const dataDir = path.join(sandbox.root, 'settings-3')
    const first = await createApp({ dataDir, logger: false, loadPlugins: false })
    first.ctx.settings.patch({ scan: { maxItemsPerTask: 300 }, ui: { theme: 'dark', lastPage: 'clean' } })
    first.ctx.settings.flush()
    await first.dispose()

    const second = await createApp({ dataDir, logger: false, loadPlugins: false })
    try {
      expect(second.ctx.settings.get().scan.maxItemsPerTask).toBe(300)
      expect(second.ctx.settings.get().ui.lastPage).toBe('clean')
    } finally {
      await second.dispose()
    }
  })

  it('配置文件损坏时自动备份并回退默认值', async () => {
    const dataDir = path.join(sandbox.root, 'settings-4')
    const app = await createApp({ dataDir, logger: false, loadPlugins: false })
    app.ctx.settings.flush()
    await app.dispose()
    writeFileSync(path.join(dataDir, 'config.json'), '{ 坏掉的 JSON', 'utf8')

    const recovered = await createApp({ dataDir, logger: false, loadPlugins: false })
    try {
      expect(recovered.ctx.settings.get().scan.concurrency).toBe(3)
      const { readdirSync } = await import('node:fs')
      const broken = readdirSync(dataDir).filter((name) => name.includes('.broken-'))
      expect(broken.length).toBe(1)
    } finally {
      await recovered.dispose()
    }
  })
})

describe('历史记录', () => {
  it('按容量裁剪并统计（预演不计入）', async () => {
    const dataDir = path.join(sandbox.root, 'history-1')
    const app = await createApp({ dataDir, logger: false, loadPlugins: false })
    try {
      for (let i = 0; i < 8; i++) app.ctx.history.append(makeEntry(i))
      app.ctx.history.append(makeEntry(99, { dryRun: true, freedBytes: 999_999 }))
      const list = app.ctx.history.list(100)
      expect(list.length).toBe(9)
      // 列表按时间倒序，最新一条是预演
      expect(list[0].dryRun).toBe(true)
      const totals = app.ctx.history.totals()
      expect(totals.sessions).toBe(8)
      expect(totals.freedBytes).toBe(100 * (1 + 2 + 3 + 4 + 5 + 6 + 7 + 8))
      expect(totals.cleaned).toBe(1 + 2 + 3 + 4 + 5 + 6 + 7 + 8)
    } finally {
      await app.dispose()
    }
  })

  it('历史文件中的损坏行被忽略，不影响其余记录', async () => {
    const dataDir = path.join(sandbox.root, 'history-2')
    const first = await createApp({ dataDir, logger: false, loadPlugins: false })
    first.ctx.history.append(makeEntry(0))
    first.ctx.history.append(makeEntry(1))
    await first.dispose()

    appendFileSync(path.join(dataDir, 'history.jsonl'), '{ 这不是合法 JSON\n', 'utf8')

    const second = await createApp({ dataDir, logger: false, loadPlugins: false })
    try {
      const list = second.ctx.history.list(10)
      expect(list.length).toBe(2)
      expect(list.map((item) => item.sessionId).sort()).toEqual(['s0', 's1'])
    } finally {
      await second.dispose()
    }
  })

  it('清空历史后文件为空且统计归零', async () => {
    const dataDir = path.join(sandbox.root, 'history-3')
    const app = await createApp({ dataDir, logger: false, loadPlugins: false })
    try {
      app.ctx.history.append(makeEntry(0))
      app.ctx.history.clear()
      expect(app.ctx.history.list()).toHaveLength(0)
      expect(app.ctx.history.totals()).toEqual({ sessions: 0, freedBytes: 0, cleaned: 0 })
      expect(readFileSync(path.join(dataDir, 'history.jsonl'), 'utf8')).toBe('')
    } finally {
      await app.dispose()
    }
  })
})

describe('反复启停不泄漏', () => {
  it('连续热重载 20 次后任务数量、监听器数量稳定', async () => {
    const plugin = defineCleanerPlugin({
      name: 'leak',
      inject: ['cleaner'],
      setup(ctx) {
        ctx.effect(() =>
          ctx.cleaner.define({
            id: 'leak-task',
            name: '泄漏测试',
            category: 'system',
            risk: 'safe',
            scan() {},
          }),
        )
        // 每次都注册一个事件监听，验证卸载时被回收
        ctx.on('cleaner/scan-progress', () => {})
      },
    })
    const app = await createApp({
      dataDir: path.join(sandbox.root, 'leak-data'),
      logger: false,
      manifest: manifestOf([{ id: 'leak', plugin }]),
    })
    try {
      const hooksOf = () => ((app.ctx as any).events._hooks['cleaner/scan-progress'] ?? []).length
      const baselineHooks = hooksOf()
      const baselineRuntimes = app.ctx.registry.size

      for (let i = 0; i < 20; i++) await app.ctx.plugins.reload('leak')

      expect(app.ctx.cleaner.list()).toHaveLength(1)
      expect(app.ctx.plugins.list()).toHaveLength(1)
      expect(hooksOf()).toBe(baselineHooks)
      expect(app.ctx.registry.size).toBe(baselineRuntimes)
      // 反复扫描也不应堆积任务或监听
      for (let i = 0; i < 5; i++) await app.ctx.cleaner.scan()
      expect(hooksOf()).toBe(baselineHooks)
    } finally {
      await app.dispose()
    }
  }, 60_000)
})
