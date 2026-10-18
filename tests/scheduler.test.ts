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
      expect(next?.authorizedHash).toMatch(/^[0-9a-f]{16}$/)
      expect(next?.mode).toBe('clean')
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
})
