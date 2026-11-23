/**
 * 删除安全链加固回归测试：
 * - 一次性令牌：重放/过期拒绝，dryRun 不消费；
 * - 执行前复核：签发后同路径内容被替换时拒绝；
 * - 大目录/只读子项不再让整目录跳过，降级为逐项删除并如实计量。
 */
import { chmodSync, existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CleanTicket, TICKET_TTL_MS, createApp, type App } from '@cordclean/core'
import type { CleanItem } from '@cordclean/shared'
import { createSandbox, manifestOf } from './helpers.ts'

const sandbox = createSandbox()
const apps: App[] = []

afterAll(async () => {
  for (const app of apps) await app.dispose()
  rmSync(sandbox.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

async function boot(name: string): Promise<App> {
  const app = await createApp({
    dataDir: path.join(sandbox.dataDir, name),
    logger: false,
    manifest: manifestOf([]),
  })
  apps.push(app)
  return app
}

let seq = 0
function makeItem(target: string, size: number, patch: Partial<CleanItem> = {}): CleanItem {
  seq++
  return {
    id: `item-${seq}`,
    taskId: 'test-task',
    path: target,
    title: path.basename(target),
    kind: 'file',
    size,
    risk: 'safe',
    category: 'system',
    defaultSelected: true,
    ...patch,
  }
}

function writeFile(relative: string, content: string): string {
  const target = path.join(sandbox.root, relative)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content)
  return target
}

interface IssueSummary {
  ticket?: unknown
  rejections: Array<{ reason: string; message?: string }>
  stats: { aborted: boolean }
}

describe('一次性令牌', () => {
  it('同一票据第二次执行被拒绝（重放）', async () => {
    const app = await boot('ticket-replay')
    app.ctx.pathPolicy.addRoot(sandbox.root)
    const target = writeFile('replay/a.bin', 'AAAA')
    const issued: IssueSummary = await app.ctx.compensate.issue({ mode: 'delete', items: [makeItem(target, 4)] })
    expect(issued.ticket).toBeDefined()

    const first = await app.ctx.executor.execute(issued.ticket)
    expect(first.freedBytes).toBe(4)
    expect(existsSync(target)).toBe(false)

    // 同路径重新放一个不同内容的文件：票据已消费，不能再次执行
    writeFileSync(target, 'BBBBBBBBBBBB')
    await expect(app.ctx.executor.execute(issued.ticket)).rejects.toThrow(/重放/)
    expect(existsSync(target)).toBe(true)
  })

  it('过期令牌被拒绝', async () => {
    const app = await boot('ticket-expired')
    app.ctx.pathPolicy.addRoot(sandbox.root)
    const target = writeFile('expired/a.bin', 'AAAA')
    const issued: IssueSummary = await app.ctx.compensate.issue({ mode: 'delete', items: [makeItem(target, 4)] })
    const now = Date.now()
    const issuedAt = now - TICKET_TTL_MS - 5000
    const expiredTicket = new CleanTicket('t-expired', 'delete', (issued.ticket as any).items, issuedAt, 'nonce-expired', issuedAt + TICKET_TTL_MS)
    await expect(app.ctx.executor.execute(expiredTicket)).rejects.toThrow(/过期/)
    expect(existsSync(target)).toBe(true)
  })

  it('dryRun 预览不消费票据，之后仍可真正执行', async () => {
    const app = await boot('ticket-dry-run')
    app.ctx.pathPolicy.addRoot(sandbox.root)
    const target = writeFile('dry-run/a.bin', 'AAAA')
    const issued: IssueSummary = await app.ctx.compensate.issue({ mode: 'delete', items: [makeItem(target, 4)] })
    const preview = await app.ctx.executor.execute(issued.ticket, { dryRun: true })
    expect(preview.results[0]).toMatchObject({ ok: true, bytes: 4 })
    expect(existsSync(target)).toBe(true)

    const real = await app.ctx.executor.execute(issued.ticket)
    expect(real.freedBytes).toBe(4)
    expect(existsSync(target)).toBe(false)
  })
})

describe('执行前复核（签发后内容变化）', () => {
  it('签发后同路径文件被替换（大小变化）→ 拒绝执行', async () => {
    const app = await boot('recheck-size')
    app.ctx.pathPolicy.addRoot(sandbox.root)
    const target = writeFile('recheck-size/a.bin', 'AAAA')
    const issued: IssueSummary = await app.ctx.compensate.issue({ mode: 'delete', items: [makeItem(target, 4)] })

    writeFileSync(target, 'REPLACED-AFTER-ISSUE')
    const outcome = await app.ctx.executor.execute(issued.ticket)
    expect(outcome.failed).toBe(1)
    expect(outcome.freedBytes).toBe(0)
    expect(outcome.results[0]).toMatchObject({ ok: false })
    expect(outcome.results[0].error).toContain('复核')
    expect(existsSync(target)).toBe(true)
  })

  it('签发后文件大小不变但 mtime 变化 → 拒绝执行', async () => {
    const app = await boot('recheck-mtime')
    app.ctx.pathPolicy.addRoot(sandbox.root)
    const target = writeFile('recheck-mtime/a.bin', 'AAAA')
    const issued: IssueSummary = await app.ctx.compensate.issue({ mode: 'delete', items: [makeItem(target, 4)] })

    const future = new Date(Date.now() + 30_000)
    utimesSync(target, future, future)
    const outcome = await app.ctx.executor.execute(issued.ticket)
    expect(outcome.failed).toBe(1)
    expect(outcome.results[0].error).toContain('修改时间')
    expect(existsSync(target)).toBe(true)
  })
})

describe('清理辖区安全闸门', () => {
  it('驱动器根目录不能被登记为清理辖区或用户扫描根', async () => {
    const app = await boot('drive-root-guard')
    app.ctx.pathPolicy.addRoot('C:\\')
    app.ctx.pathPolicy.addRoot('c:/', 'probe')
    app.ctx.pathPolicy.addUserRoot('C:\\')
    expect(app.ctx.pathPolicy.roots()).toEqual([])
    expect(app.ctx.pathPolicy.rootOf('C:\\Users\\Public\\x.txt')).toBeUndefined()
  })
})

describe('父目录递归删除不能带走受保护目录名', () => {
  it('父目录里有 .git → 整项拒绝，版本库与文件都不动', async () => {
    const app = await boot('protected-descendant')
    const dir = path.join(sandbox.root, 'proj')
    mkdirSync(path.join(dir, '.git', 'objects'), { recursive: true })
    writeFileSync(path.join(dir, '.git', 'config'), 'git')
    writeFileSync(path.join(dir, 'a.txt'), 'a')
    app.ctx.pathPolicy.addRoot(dir)

    const issued: IssueSummary = await app.ctx.compensate.issue({
      mode: 'delete',
      items: [makeItem(dir, 0, { kind: 'directory' })],
    })
    expect(issued.ticket).toBeDefined()
    const outcome = await app.ctx.executor.execute(issued.ticket)
    expect(outcome.failed).toBe(1)
    expect(outcome.results[0].error).toContain('受保护目录')
    expect(existsSync(path.join(dir, '.git', 'config'))).toBe(true)
    expect(existsSync(path.join(dir, 'a.txt'))).toBe(true)
  })

  it('clear 语义同样拒绝包含 .venv 的目录', async () => {
    const app = await boot('protected-clear')
    const dir = path.join(sandbox.root, 'venv-parent')
    mkdirSync(path.join(dir, '.venv', 'bin'), { recursive: true })
    writeFileSync(path.join(dir, '.venv', 'pyvenv.cfg'), 'home')
    app.ctx.pathPolicy.addRoot(dir)
    app.ctx.pathPolicy.addClearRoot(dir, 'probe')

    const issued: IssueSummary = await app.ctx.compensate.issue({
      mode: 'delete',
      items: [makeItem(dir, 0, { kind: 'directory', meta: { action: 'clear' } })],
    })
    expect(issued.ticket).toBeDefined()
    const outcome = await app.ctx.executor.execute(issued.ticket)
    expect(outcome.failed).toBe(1)
    expect(outcome.results[0].error).toContain('受保护目录')
    expect(existsSync(path.join(dir, '.venv', 'pyvenv.cfg'))).toBe(true)
  })
})

describe('大目录与只读子项不再整目录跳过', () => {
  it('超过 5000 项的目录降级为逐项删除（不再整体跳过）', async () => {
    const app = await boot('big-dir')
    const dir = path.join(sandbox.root, 'big-dir')
    mkdirSync(dir, { recursive: true })
    for (let index = 0; index < 5001; index++) writeFileSync(path.join(dir, `f${index}.tmp`), 'x')
    app.ctx.pathPolicy.addRoot(dir)

    const issued: IssueSummary = await app.ctx.compensate.issue({
      mode: 'delete',
      items: [makeItem(dir, 0, { kind: 'directory' })],
    })
    expect(issued.ticket).toBeDefined()
    const outcome = await app.ctx.executor.execute(issued.ticket)
    expect(outcome.failed).toBe(0)
    expect(outcome.freedBytes).toBeGreaterThanOrEqual(5001)
    expect(existsSync(dir)).toBe(false)
  })

  it('目录里的只读文件不再阻塞整目录删除', async () => {
    const app = await boot('readonly-dir')
    const dir = path.join(sandbox.root, 'readonly-dir')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'normal.txt'), 'normal')
    const readonly = path.join(dir, 'readonly.txt')
    writeFileSync(readonly, 'locked')
    chmodSync(readonly, 0o444)
    app.ctx.pathPolicy.addRoot(dir)

    const issued: IssueSummary = await app.ctx.compensate.issue({
      mode: 'delete',
      items: [makeItem(dir, 0, { kind: 'directory' })],
    })
    const outcome = await app.ctx.executor.execute(issued.ticket)
    expect(outcome.failed).toBe(0)
    expect(existsSync(dir)).toBe(false)
  })
})
