/**
 * 补偿链与执行器测试：七步链、令牌、诚实计量、回收站回落。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp, type App } from '@cordclean/core'
import { isCleanTicket } from '@cordclean/core'
import type { CleanItem } from '@cordclean/shared'
import { createSandbox, manifestOf } from './helpers.ts'

const sandbox = createSandbox()
const apps: App[] = []

afterAll(async () => {
  for (const app of apps) await app.dispose()
  rmSync(sandbox.root, { recursive: true, force: true })
})

async function boot(name: string, overrides: Record<string, unknown> = {}): Promise<App> {
  const app = await createApp({
    dataDir: path.join(sandbox.dataDir, name),
    logger: false,
    manifest: manifestOf([]),
    settingsOverrides: overrides,
  })
  apps.push(app)
  return app
}

function makeItem(target: string, size: number, patch: Partial<CleanItem> = {}): CleanItem {
  return {
    id: `item-${Math.random().toString(36).slice(2, 8)}`,
    taskId: 'test-task',
    path: target,
    title: path.basename(target),
    kind: 'file',
    size,
    risk: 'safe',
    category: 'system',
    defaultSelected: true,
    protected: false,
    ...patch,
  }
}

function file(name: string, bytes: number): string {
  const target = path.join(sandbox.root, name)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, Buffer.alloc(bytes, 7))
  return target
}

describe('补偿链七步', () => {
  it('拒绝受保护路径与相对路径', async () => {
    const app = await boot('compensate-policy')
    const result = await app.ctx.compensate.issue({
      mode: 'delete',
      items: [
        makeItem('C:\\Windows\\System32\\kernel32.dll', 10),
        makeItem('relative\\path.txt', 10),
      ],
    })
    expect(result.ticket).toBeUndefined()
    expect(result.rejections.map((item) => item.reason).sort()).toEqual(['normalize', 'protected'])
  })

  it('超出预算整批中止，不做任何删除', async () => {
    const app = await boot('compensate-budget', { clean: { budget: { maxFiles: 2, maxBytes: 1024 } } })
    const target = file('budget/a.bin', 10)
    app.ctx.pathPolicy.addRoot(sandbox.root)
    const result = await app.ctx.compensate.issue({
      mode: 'delete',
      items: [makeItem(target, 10), makeItem(target, 10), makeItem(target, 10)],
    })
    expect(result.ticket).toBeUndefined()
    expect(result.stats.aborted).toBe(true)
    expect(result.rejections.every((item) => item.reason === 'budget')).toBe(true)
  })

  it('预览不一致的项被跳过；比例超阈值整批中止', async () => {
    const app = await boot('compensate-preview')
    app.ctx.pathPolicy.addRoot(sandbox.root)
    const target = file('preview/a.bin', 100)

    // 单条体积变化 → 该项被跳过，其余仍可执行
    const single = await app.ctx.compensate.issue({ mode: 'delete', items: [makeItem(target, 999)] })
    expect(single.ticket).toBeUndefined()
    expect(single.rejections[0].reason).toBe('changed')

    // 10 项里 2 项变化 → 20% > 5%，整批中止
    const items = Array.from({ length: 10 }, (_, index) => makeItem(target, index < 2 ? 999 : 100))
    const aborted = await app.ctx.compensate.issue({ mode: 'delete', items })
    expect(aborted.ticket).toBeUndefined()
    expect(aborted.stats.aborted).toBe(true)
    expect(aborted.rejections.some((item) => item.reason === 'changed-ratio')).toBe(true)

    // 每一项都是真实体积 → 通过
    const ok = await app.ctx.compensate.issue({ mode: 'delete', items: Array.from({ length: 10 }, () => makeItem(target, 100)) })
    expect(ok.ticket).toBeDefined()
    expect(isCleanTicket(ok.ticket)).toBe(true)
  })

  it('扫描后被删除的目标标记为 vanished', async () => {
    const app = await boot('compensate-vanish')
    app.ctx.pathPolicy.addRoot(sandbox.root)
    const target = file('vanished/a.bin', 10)
    rmSync(target)
    const result = await app.ctx.compensate.issue({ mode: 'delete', items: [makeItem(target, 10)] })
    expect(result.rejections[0].reason).toBe('vanished')
    expect(result.stats.vanished).toBe(1)
  })
})

describe('执行器与诚实计量', () => {
  it('伪造令牌被拒绝', async () => {
    const app = await boot('executor-token')
    await expect(app.ctx.executor.execute({ items: [] } as any)).rejects.toThrow(/令牌/)
  })

  it('回收站：计入 recycledBytes，不计入 freedBytes', async () => {
    const app = await boot('executor-recycle')
    app.ctx.pathPolicy.addRoot(sandbox.root)
    const target = file('recycle/a.bin', 4096)
    app.ctx.recycleBin.setRunnerForTests(async (items) => ({ ok: items.map((item) => item.path), failed: [] }))

    const issued = await app.ctx.compensate.issue({ mode: 'recycle', items: [makeItem(target, 4096)] })
    const outcome = await app.ctx.executor.execute(issued.ticket)
    expect(outcome.results[0].ok).toBe(true)
    expect(outcome.recycledBytes).toBe(4096)
    expect(outcome.freedBytes).toBe(0)
    expect(existsSync(target)).toBe(true) // 假执行器不真的删
  })

  it('回收站失败项进入失败清单，不虚报释放量', async () => {
    const app = await boot('executor-recycle-fail')
    app.ctx.pathPolicy.addRoot(sandbox.root)
    const target = file('recycle-fail/a.bin', 2048)
    app.ctx.recycleBin.setRunnerForTests(async (items) => ({
      ok: [],
      failed: items.map((item) => ({ path: item.path, message: '拒绝访问' })),
    }))
    const issued = await app.ctx.compensate.issue({ mode: 'recycle', items: [makeItem(target, 2048)] })
    const outcome = await app.ctx.executor.execute(issued.ticket)
    expect(outcome.recycledBytes).toBe(0)
    expect(outcome.failed).toBe(1)
    expect(outcome.results[0].error).toContain('拒绝访问')
  })

  it('永久删除：freedBytes 按实际体积计量', async () => {
    const app = await boot('executor-delete')
    app.ctx.pathPolicy.addRoot(sandbox.root)
    const target = file('delete/a.bin', 8192)
    const issued = await app.ctx.compensate.issue({ mode: 'delete', items: [makeItem(target, 8192)] })
    const outcome = await app.ctx.executor.execute(issued.ticket)
    expect(outcome.freedBytes).toBe(8192)
    expect(outcome.recycledBytes).toBe(0)
    expect(existsSync(target)).toBe(false)
  })

  it('隔离区：计入 quarantinedBytes 且可恢复', async () => {
    const app = await boot('executor-quarantine')
    app.ctx.pathPolicy.addRoot(sandbox.root)
    const target = file('quarantine/a.bin', 1024)
    const issued = await app.ctx.compensate.issue({ mode: 'quarantine', items: [makeItem(target, 1024)] })
    const session = app.ctx.quarantine.beginSession('test-session')
    const outcome = await app.ctx.executor.execute(issued.ticket, { session })
    await session.close()
    expect(outcome.quarantinedBytes).toBe(1024)
    expect(outcome.freedBytes).toBe(0)
    expect(existsSync(target)).toBe(false)
    const records = await app.ctx.quarantine.list()
    expect(records.length).toBeGreaterThan(0)
  })
})

describe('清理引擎接入', () => {
  it('默认回收站模式：报告区分 recycled / freed，并写入历史', async () => {
    const app = await boot('clean-recycle')
    const dir = path.join(sandbox.root, 'clean-recycle')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'a.bin'), Buffer.alloc(3000, 3))
    writeFileSync(path.join(dir, 'b.bin'), Buffer.alloc(2000, 4))
    app.ctx.pathPolicy.addRoot(dir)
    app.ctx.recycleBin.setRunnerForTests(async (items) => ({ ok: items.map((item) => item.path), failed: [] }))

    app.ctx.cleaner.define({
      id: 'recycle-task',
      name: '回收站测试',
      category: 'system',
      risk: 'safe',
      icon: '🧪',
      defaultSelected: true,
      targets: [dir],
      async scan(scan) {
        scan.emit({ path: path.join(dir, 'a.bin'), kind: 'file', size: 3000 })
        scan.emit({ path: path.join(dir, 'b.bin'), kind: 'file', size: 2000 })
      },
    })

    const report = await app.ctx.cleaner.scan({ taskIds: ['recycle-task'] })
    expect(report.items).toHaveLength(2)
    const cleaned = await app.ctx.cleaner.clean({ items: report.items })
    expect(cleaned.mode).toBe('recycle')
    expect(cleaned.recycledBytes).toBe(5000)
    expect(cleaned.freedBytes).toBe(0)
    expect(cleaned.cleaned).toBe(2)

    const history = await app.ctx.history.list()
    expect(history[0]).toMatchObject({ recycledBytes: 5000, freedBytes: 0 })
  })

  it('永久删除模式：freed 计入，文件消失', async () => {
    const app = await boot('clean-delete', { clean: { mode: 'delete' } })
    const dir = path.join(sandbox.root, 'clean-delete')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'a.bin'), Buffer.alloc(1234, 5))
    app.ctx.pathPolicy.addRoot(dir)
    app.ctx.cleaner.define({
      id: 'delete-task',
      name: '永久删除测试',
      category: 'system',
      risk: 'safe',
      icon: '🧪',
      defaultSelected: true,
      targets: [dir],
      async scan(scan) {
        scan.emit({ path: path.join(dir, 'a.bin'), kind: 'file', size: 1234 })
      },
    })
    const report = await app.ctx.cleaner.scan({ taskIds: ['delete-task'] })
    const cleaned = await app.ctx.cleaner.clean({ items: report.items })
    expect(cleaned.mode).toBe('delete')
    expect(cleaned.freedBytes).toBe(1234)
    expect(cleaned.recycledBytes).toBe(0)
    expect(existsSync(path.join(dir, 'a.bin'))).toBe(false)
  })
})

describe('S5 预览一致性（mtime）与 S7 回收站拒绝', () => {
  it('mtime 变化超过 2 秒的项被跳过', async () => {
    const app = await boot('compensate-mtime')
    app.ctx.pathPolicy.addRoot(sandbox.root)
    const target = file('mtime/a.bin', 128)
    const item = makeItem(target, 128)
    item.mtimeMs = Date.now() - 60_000
    const result = await app.ctx.compensate.issue({ mode: 'delete', items: [item] })
    expect(result.ticket).toBeUndefined()
    expect(result.rejections[0].reason).toBe('changed')
  })

  it('回收站不可用且未允许回落时明确拒绝，不静默永久删除', async () => {
    const app = await boot('compensate-recycle-unavailable')
    app.ctx.pathPolicy.addRoot(sandbox.root)
    app.ctx.recycleBin.setAvailableForTests(false)
    const target = file('unavailable/a.bin', 64)
    const result = await app.ctx.compensate.issue({ mode: 'recycle', items: [makeItem(target, 64)] })
    expect(result.ticket).toBeUndefined()
    expect(result.rejections[0].reason).toBe('recycle-unavailable')
    expect(existsSync(target)).toBe(true)
  })
})
