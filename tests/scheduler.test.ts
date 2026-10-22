import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from '@cordclean/core'
import schedulerPlugin from '@cordclean/plugin-scheduler'
import { createSandbox, manifestOf } from './helpers.ts'

const sandbox = createSandbox()
afterAll(() => rmSync(sandbox.root, { recursive: true, force: true }))

describe('定时任务：授权与自动清理', () => {
  it('授权写入规则指纹；立即运行会清理 safe 项', async () => {
    const app = await createApp({
      dataDir: path.join(sandbox.dataDir, 'scheduler'),
      logger: false,
      loadPlugins: true,
      manifest: manifestOf([{ id: 'scheduler', plugin: schedulerPlugin }]),
      settingsOverrides: { plugins: { scheduler: { enabled: true, config: { enabled: true, everyMinutes: 15, mode: 'scan', taskIds: [] } } } },
    })
    try {
      const dir = path.join(sandbox.root, 'cache')
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, 'a.tmp'), Buffer.alloc(2048, 1))
      app.ctx.pathPolicy.addRoot(dir)
      app.ctx.recycleBin.setRunnerForTests(async (items) => ({ ok: items.map((item) => item.path), failed: [] }))
      app.ctx.cleaner.define({
        id: 'scheduler-task',
        name: '定时任务测试',
        category: 'system',
        risk: 'safe',
        icon: '🧪',
        defaultSelected: true,
        targets: [dir],
        scan(scan) {
          scan.emit({ path: path.join(dir, 'a.tmp'), kind: 'file', size: 2048 })
        },
      })

      let next: any
      ;(app.ctx as any).emit('scheduler/authorize', { taskIds: ['scheduler-task'] }, (config: any) => { next = config })
      expect(next?.plans?.[0]?.authorizedHash).toMatch(/^[0-9a-f]{16}$/)
      expect(next?.plans?.[0]?.mode).toBe('clean')
      await app.ctx.plugins.updateConfig('scheduler', next)

      const events: any[] = []
      ;(app.ctx as any).on('scheduler/scan', (payload: any) => events.push(payload))
      ;(app.ctx as any).emit('scheduler/run')
      for (let i = 0; i < 40; i++) {
        if (!existsSync(path.join(dir, 'a.tmp'))) break
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      expect(events.some((event: any) => event.autoCleaned)).toBe(true)
      const history = await app.ctx.history.list()
      expect(history[0]?.cleaned).toBe(1)
      expect(history[0]?.recycledBytes).toBe(2048)
    } finally {
      await app.dispose()
    }
  })

  it('规则变化后授权失效，不再自动清理', async () => {
    const app = await createApp({
      dataDir: path.join(sandbox.dataDir, 'scheduler-hash'),
      logger: false,
      loadPlugins: true,
      manifest: manifestOf([{ id: 'scheduler', plugin: schedulerPlugin }]),
      settingsOverrides: { plugins: { scheduler: { enabled: true, config: { enabled: true, everyMinutes: 15, mode: 'scan', taskIds: [] } } } },
    })
    try {
      const dir = path.join(sandbox.root, 'cache-hash')
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, 'b.tmp'), Buffer.alloc(1024, 1))
      app.ctx.pathPolicy.addRoot(dir)
      app.ctx.recycleBin.setRunnerForTests(async (items) => ({ ok: items.map((item) => item.path), failed: [] }))
      app.ctx.cleaner.define({
        id: 'scheduler-hash-task',
        name: '授权失效测试',
        category: 'system',
        risk: 'safe',
        icon: '🧪',
        defaultSelected: true,
        targets: [dir],
        scan(scan) {
          scan.emit({ path: path.join(dir, 'b.tmp'), kind: 'file', size: 1024 })
        },
      })

      let next: any
      ;(app.ctx as any).emit('scheduler/authorize', { taskIds: ['scheduler-hash-task'] }, (config: any) => { next = config })
      await app.ctx.plugins.updateConfig('scheduler', next)

      // 改变规则开关 → 指纹变化
      app.ctx.settings.patch({ rules: { includeRisky: true } } as any)

      const events: any[] = []
      ;(app.ctx as any).on('scheduler/scan', (payload: any) => events.push(payload))
      ;(app.ctx as any).emit('scheduler/run')
      for (let i = 0; i < 20; i++) {
        if (events.some((event) => event.blocked)) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(events.some((event) => event.blocked)).toBe(true)
      const history = await app.ctx.history.list()
      expect(history).toHaveLength(0)
    } finally {
      await app.dispose()
    }
  })

  it('授权指纹绑定计划范围：taskIds 变化会生成不同 hash', async () => {
    const app = await createApp({
      dataDir: path.join(sandbox.dataDir, 'scheduler-scope'),
      logger: false,
      loadPlugins: true,
      manifest: manifestOf([{ id: 'scheduler', plugin: schedulerPlugin }]),
      settingsOverrides: { plugins: { scheduler: { enabled: true, config: { enabled: true, everyMinutes: 15, mode: 'scan', taskIds: [] } } } },
    })
    try {
      let first: any
      let second: any
      ;(app.ctx as any).emit('scheduler/authorize', { taskIds: ['task-a'] }, (config: any) => { first = config })
      ;(app.ctx as any).emit('scheduler/authorize', { taskIds: ['task-b'] }, (config: any) => { second = config })
      expect(first?.plans?.[0]?.authorizedHash).toMatch(/^[0-9a-f]{16}$/)
      expect(second?.plans?.[0]?.taskIds).toEqual(['task-b'])
      expect(second?.plans?.[0]?.authorizedHash).not.toBe(first?.plans?.[0]?.authorizedHash)
    } finally {
      await app.dispose()
    }
  })

  it('撤销会清空所有计划的授权（多计划也不会漏）', async () => {
    const app = await createApp({
      dataDir: path.join(sandbox.dataDir, 'scheduler-revoke'),
      logger: false,
      loadPlugins: true,
      manifest: manifestOf([{ id: 'scheduler', plugin: schedulerPlugin }]),
      settingsOverrides: {
        plugins: {
          scheduler: {
            enabled: true,
            config: {
              enabled: true,
              plans: [
                { id: 'p1', name: '计划1', enabled: true, taskIds: ['a'], mode: 'clean', authorizedHash: 'deadbeef' },
                { id: 'p2', name: '计划2', enabled: true, taskIds: ['b'], mode: 'clean', authorizedHash: 'feedface' },
              ],
            },
          },
        },
      },
    })
    try {
      let next: any
      ;(app.ctx as any).emit('scheduler/revoke', undefined, (config: any) => { next = config })
      expect(next?.plans?.map((plan: any) => plan.authorizedHash)).toEqual(['', ''])
      expect(next?.plans?.map((plan: any) => plan.mode)).toEqual(['scan', 'scan'])
      expect(next?.mode).toBe('scan')
      expect(next?.authorizedHash).toBe('')
    } finally {
      await app.dispose()
    }
  })
})