import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from '@cordclean/core'
import { createSandbox, manifestOf } from './helpers.ts'

const sandbox = createSandbox()
afterAll(() => {})

describe('撤销上次清理：隔离区可还原', () => {
  it('清理报告带 undo 清单；隔离项可按路径恢复', async () => {
    const app = await createApp({
      dataDir: path.join(sandbox.dataDir, 'undo'),
      logger: false,
      manifest: manifestOf([]),
      settingsOverrides: { clean: { mode: 'quarantine' }, quarantine: { enabled: true } },
    })
    try {
      const dir = path.join(sandbox.root, 'undo-src')
      mkdirSync(dir, { recursive: true })
      const file = path.join(dir, 'keep.txt')
      writeFileSync(file, 'hello')
      app.ctx.pathPolicy.addRoot(dir)
      app.ctx.cleaner.define({
        id: 'undo-task',
        name: '撤销测试',
        category: 'system',
        risk: 'safe',
        icon: '🧪',
        defaultSelected: true,
        targets: [dir],
        scan(scan) {
          scan.emit({ path: file, kind: 'file', size: 5 })
        },
      })
      const report = await app.ctx.cleaner.scan({ taskIds: ['undo-task'] })
      const cleaned = await app.ctx.cleaner.clean({ items: report.items })
      expect(cleaned.quarantined).toBe(1)
      expect(cleaned.undo?.length).toBe(1)
      expect(cleaned.undo?.[0]).toMatchObject({ path: file, mode: 'quarantine' })
      expect(existsSync(file)).toBe(false)

      const entries = (await app.ctx.quarantine.list()).filter((entry) => entry.originalPath === file)
      expect(entries.length).toBe(1)
      const restored = await app.ctx.quarantine.restore(entries.map((entry) => entry.id))
      expect(restored.restored).toBe(1)
      expect(existsSync(file)).toBe(true)
    } finally {
      await app.dispose()
    }
  })
})
