import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from '@cordclean/core'
import { preflightDirectory } from '../packages/core/src/domains/safety/executor.ts'
import { createSandbox, manifestOf } from './helpers.ts'

const sandbox = createSandbox()
afterAll(() => chmodRecursive(sandbox.root))

function chmodRecursive(dir: string) {
  try {
    chmodSync(dir, 0o755)
    for (const entry of require('node:fs').readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) chmodRecursive(path.join(dir, entry.name))
      else chmodSync(path.join(dir, entry.name), 0o644)
    }
  } catch {}
}

describe('删除保护：占用感知与目录预检', () => {
  it('预检发现只读/被占用文件时整目录跳过，不半删', async () => {
    const app = await createApp({
      dataDir: path.join(sandbox.dataDir, 'in-use'),
      logger: false,
      manifest: manifestOf([]),
      settingsOverrides: { clean: { mode: 'delete' } },
    })
    try {
      const dir = path.join(sandbox.root, 'locked-dir')
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, 'normal.txt'), 'normal')
      writeFileSync(path.join(dir, 'readonly.txt'), 'locked')
      chmodSync(path.join(dir, 'readonly.txt'), 0o444)

      const preflight = await preflightDirectory(dir)
      expect(preflight.ok).toBe(false)
      expect(preflight.message).toContain('已跳过')

      app.ctx.pathPolicy.addRoot(dir)
      app.ctx.cleaner.define({
        id: 'locked-task',
        name: '占用预检测试',
        category: 'system',
        risk: 'safe',
        icon: '🧪',
        defaultSelected: true,
        targets: [dir],
        scan(scan) {
          scan.emit({ path: dir, kind: 'directory', size: 12 })
        },
      })
      const report = await app.ctx.cleaner.scan({ taskIds: ['locked-task'] })
      const cleaned = await app.ctx.cleaner.clean({ items: report.items })
      expect(cleaned.cleaned).toBe(0)
      expect(existsSync(path.join(dir, 'normal.txt'))).toBe(true)
      expect(existsSync(path.join(dir, 'readonly.txt'))).toBe(true)
    } finally {
      await app.dispose()
    }
  })
})
