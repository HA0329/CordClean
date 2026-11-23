/**
 * 目录预检与部分清理：
 * - 预检只做顶层可读性检查（旧实现递归 r+ 试探，超 5000 项/只读文件会整目录跳过）；
 * - 只读子项不再阻塞整目录删除（deletePath 会去只读后重试）。
 */
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

describe('删除保护：目录预检与只读子项', () => {
  it('预检只检查顶层可读性：可读目录通过，缺失目录返回不可读', async () => {
    const dir = path.join(sandbox.root, 'preflight-ok')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'a.txt'), 'a')

    const ok = await preflightDirectory(dir)
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.entries).toBe(1)

    const missing = await preflightDirectory(path.join(sandbox.root, 'preflight-missing'))
    expect(missing.ok).toBe(false)
    expect(missing.ok ? '' : missing.message).toContain('无法读取目录')
  })

  it('目录里的只读文件不再阻塞整目录删除', async () => {
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

      app.ctx.pathPolicy.addRoot(dir)
      app.ctx.cleaner.define({
        id: 'locked-task',
        name: '只读子项测试',
        category: 'system',
        risk: 'safe',
        icon: '🧪',
        defaultSelected: true,
        targets: [dir],
        scan(scan) {
          scan.emit({ path: dir, kind: 'directory', size: 11 })
        },
      })
      const report = await app.ctx.cleaner.scan({ taskIds: ['locked-task'] })
      expect(report.items).toHaveLength(1)
      const cleaned = await app.ctx.cleaner.clean({ items: report.items })
      expect(cleaned.cleaned).toBe(1)
      expect(cleaned.failed).toBe(0)
      expect(existsSync(dir)).toBe(false)
    } finally {
      await app.dispose()
    }
  })
})
