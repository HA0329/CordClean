/**
 * 批次 1 安全/正确性修复的回归测试：
 * - settings 原型污染与异常配置段自愈
 * - addClearRoot 不允许登记保护根本身/祖先
 * - 多任务清理只登记一次历史会话；纯自定义清理也要有会话
 * - 旧扫描不得覆盖新扫描结果
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createApp } from '@cordclean/core'
import { defineCleanerPlugin } from '@cordclean/shared'
import { createSandbox, manifestOf } from './helpers.ts'

const sandbox = createSandbox()

async function boot(name: string, extraManifest: Parameters<typeof manifestOf>[0] = []) {
  return createApp({
    dataDir: path.join(sandbox.dataDir, name),
    logger: false,
    manifest: manifestOf(extraManifest),
  })
}

const fileTask = (id: string, file: string) =>
  defineCleanerPlugin({
    name: `${id}-plugin`,
    inject: ['cleaner', 'pathPolicy'],
    setup(ctx) {
      ctx.cleaner.define({
        id,
        name: id,
        category: 'disk',
        risk: 'safe',
        defaultSelected: true,
        targets: [path.dirname(file)],
        scan(scan) {
          scan.emit({ path: file, kind: 'file', size: 16 })
        },
      })
    },
  })

describe('批次1：settings 输入加固', () => {
  it('拒绝 __proto__ 路径且不污染 Object.prototype', async () => {
    const app = await boot('hardening-settings')
    try {
      expect(() => app.ctx.settings.set('__proto__.polluted', 'yes')).toThrow(/非法设置路径/)
      expect(() => app.ctx.settings.set('constructor.prototype.polluted', 'yes')).toThrow(/非法设置路径/)
      expect(({} as any).polluted).toBeUndefined()
      const bad = JSON.parse('{"__proto__":{"polluted":true}}')
      expect(() => app.ctx.settings.patch(bad)).toThrow(/非法设置键/)
      expect(({} as any).polluted).toBeUndefined()
    } finally {
      await app.dispose()
    }
  })

  it('patch {scan:null} 会恢复默认段而不是抛 TypeError', async () => {
    const app = await boot('hardening-settings-null')
    try {
      app.ctx.settings.patch({ scan: null } as any)
      const scan = app.ctx.settings.get().scan
      expect(scan).toBeTruthy()
      expect(scan.concurrency).toBeGreaterThan(0)
      expect(scan.maxItemsPerTask).toBeGreaterThan(0)
    } finally {
      await app.dispose()
    }
  })

  it('settings/set 只允许已知配置段', async () => {
    const app = await boot('hardening-settings-path')
    try {
      expect(() => app.ctx.settings.set('unknownSection.x', 1)).toThrow(/未知设置项/)
    } finally {
      await app.dispose()
    }
  })
})

describe('批次1：清空白名单不允许放大保护范围', () => {
  it('保护根本身/盘符根不能登记为 clearRoot', async () => {
    const app = await boot('hardening-clear')
    try {
      app.ctx.pathPolicy.addClearRoot('C:\\Windows')
      app.ctx.pathPolicy.addClearRoot('C:\\')
      expect(app.ctx.pathPolicy.checkClear('C:\\Windows\\System32\\drivers\\etc').allowed).toBe(false)
      expect(app.ctx.pathPolicy.checkClear('C:\\Windows\\Temp').allowed).toBe(false)
    } finally {
      await app.dispose()
    }
  })
})

describe('批次1：历史会话收尾', () => {
  it('一次清理多个任务只登记一条会话且状态为 done', async () => {
    const dir = sandbox.dir('hardening-history')
    const a = path.join(dir, 'a.tmp')
    const b = path.join(dir, 'b.tmp')
    writeFileSync(a, 'a'.repeat(16))
    writeFileSync(b, 'b'.repeat(16))
    const app = await boot('hardening-history', [
      { id: 'h1', plugin: fileTask('history-task-a', a) },
      { id: 'h2', plugin: fileTask('history-task-b', b) },
    ])
    try {
      app.ctx.pathPolicy.addRoot(dir)
      app.ctx.recycleBin.setRunnerForTests(async (items) => ({ ok: items.map((item) => item.path), failed: [] }))
      const scan = await app.ctx.cleaner.scan({ taskIds: ['history-task-a', 'history-task-b'] })
      const report = await app.ctx.cleaner.clean({ items: scan.items })
      const sessions = app.ctx.history.sessions().filter((session) => session.sessionId === report.sessionId)
      expect(sessions).toHaveLength(1)
      expect(sessions[0].status).toBe('done')
      expect(sessions[0].cleaned).toBe(2)
    } finally {
      await app.dispose()
    }
  })

  it('只有插件自定义清理（注册表类）时也登记会话', async () => {
    const app = await boot('hardening-history-custom')
    try {
      app.ctx.cleaner.define({
        id: 'custom-only',
        name: '自定义清理',
        category: 'startup',
        risk: 'caution',
        targets: [],
        scan(scan) {
          scan.emit({ path: 'HKCU\\Software\\CordCleanTest', kind: 'registry', size: 0 })
        },
        async clean(items) {
          return items.map((item) => ({ itemId: item.id, path: item.path, ok: true, bytes: 0 }))
        },
      })
      const scan = await app.ctx.cleaner.scan({ taskIds: ['custom-only'] })
      const report = await app.ctx.cleaner.clean({ items: scan.items })
      const sessions = app.ctx.history.sessions().filter((session) => session.sessionId === report.sessionId)
      expect(sessions).toHaveLength(1)
      expect(sessions[0].status).toBe('done')
      expect(sessions[0].cleaned).toBe(1)
    } finally {
      await app.dispose()
    }
  })
})

describe('批次1：扫描结果不得被旧扫描覆盖', () => {
  it('取消/替换后的旧扫描不覆盖新扫描的 lastScan', async () => {
    const dir = sandbox.dir('hardening-race')
    const fastFile = path.join(dir, 'fast.tmp')
    writeFileSync(fastFile, 'f'.repeat(16))
    const app = await boot('hardening-race')
    try {
      app.ctx.pathPolicy.addRoot(dir)
      app.ctx.cleaner.define({
        id: 'slow-task',
        name: '慢任务',
        category: 'disk',
        risk: 'safe',
        targets: [dir],
        async scan(scan) {
          await new Promise((resolve) => setTimeout(resolve, 300))
          scan.throwIfAborted()
          scan.emit({ path: path.join(dir, 'slow.tmp'), kind: 'file', size: 16 })
        },
      })
      app.ctx.cleaner.define({
        id: 'fast-task',
        name: '快任务',
        category: 'disk',
        risk: 'safe',
        targets: [dir],
        async scan(scan) {
          scan.emit({ path: fastFile, kind: 'file', size: 16 })
        },
      })
      const slow = app.ctx.cleaner.scan({ taskIds: ['slow-task'] })
      await new Promise((resolve) => setTimeout(resolve, 20))
      const fast = app.ctx.cleaner.scan({ taskIds: ['fast-task'] })
      const [slowReport, fastReport] = await Promise.all([slow, fast])
      expect(slowReport.cancelled).toBe(true)
      expect(fastReport.items.map((item) => item.path)).toContain(fastFile)
      const last = app.ctx.cleaner.lastScan()
      expect(last?.tasks.map((task) => task.taskId)).toEqual(['fast-task'])
      expect(last?.items.map((item) => item.path)).not.toContain(path.join(dir, 'slow.tmp'))
    } finally {
      await app.dispose()
    }
  })
})
