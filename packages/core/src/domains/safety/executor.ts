/**
 * 执行器（`ctx.executor`）：系统里**唯一的删除入口**。
 *
 * 只接受 `CleanTicket`（补偿链签发），执行前逐项复核；按令牌里的模式
 * 分别走回收站 / 隔离区 / 永久删除，并做**诚实计量**：
 * - `freedBytes`：真正从磁盘上消失的字节（永久删除、清空）；
 * - `recycledBytes`：进了回收站的字节（占着空间，需清空回收站才释放）；
 * - `quarantinedBytes`：进了隔离区的字节（可恢复）；
 * - `vanished`：执行前发现目标已不存在（不虚报释放量）。
 */
import { open, readdir, stat } from 'node:fs/promises'
import { Service, type Context } from 'cordis'
import type { CleanItemResult } from '@cordclean/shared'
import { clearDirectory, compactSqlite, deletePath, describeDeleteError, mapLimit, pathKey } from '@cordclean/utils'
import type { QuarantineSession } from './quarantine.ts'
import { isCleanTicket, type CleanTicket, type CleanTicketItem } from './compensate.ts'

export interface ExecuteOptions {
  signal?: AbortSignal
  session?: QuarantineSession
  dryRun?: boolean
  onItem?(result: CleanItemResult): void
}

export interface ExecuteOutcome {
  results: CleanItemResult[]
  freedBytes: number
  recycledBytes: number
  quarantinedBytes: number
  vanished: number
  skipped: number
  failed: number
}

/** 删除前预检：递归尝试以读写方式打开每个文件；被占用/无权限即判整目录不可删 */
export async function preflightDirectory(root: string, limit = 5000): Promise<{ ok: boolean; path?: string; message: string }> {
  let visited = 0
  const walk = async (dir: string): Promise<{ ok: boolean; path?: string; message: string }> => {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return { ok: false, path: dir, message: '无法读取目录（' + (code ?? '未知错误') + '），已跳过' }
    }
    for (const entry of entries) {
      if (++visited > limit) return { ok: false, path: dir, message: '目录项过多（超过 ' + limit + '），已跳过' }
      const full = dir + (dir.endsWith('\\\\') ? '' : '\\\\') + entry.name
      if (entry.isDirectory()) {
        const nested = await walk(full)
        if (!nested.ok) return nested
        continue
      }
      if (!entry.isFile()) continue
      try {
        const handle = await open(full, 'r+')
        await handle.close()
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN'
        return { ok: false, path: full, message: '文件可能正被占用或不可写（' + code + '），已跳过整目录' }
      }
    }
    return { ok: true, message: '' }
  }
  return walk(root)
}

export class ExecutorService extends Service {
  static inject = ['compensate', 'recycleBin', 'settings']

  constructor(ctx: Context) {
    super(ctx, 'executor')
  }

  async execute(ticket: unknown, options: ExecuteOptions = {}): Promise<ExecuteOutcome> {
    if (!isCleanTicket(ticket)) throw new Error('执行器拒绝：缺少补偿链令牌')
    if (options.signal?.aborted) throw Object.assign(new Error('清理已取消'), { name: 'AbortError' })

    const outcome: ExecuteOutcome = {
      results: [],
      freedBytes: 0,
      recycledBytes: 0,
      quarantinedBytes: 0,
      vanished: 0,
      skipped: 0,
      failed: 0,
    }
    if (options.dryRun) {
      for (const item of ticket.items) {
        outcome.results.push({ itemId: item.itemId, path: item.path, ok: true, bytes: item.size })
      }
      return outcome
    }

    const settings = this.ctx.settings.get()
    const recycleQueue: CleanTicketItem[] = []
    const plainQueue: CleanTicketItem[] = []
    const pending = new Map<string, CleanTicketItem>()

    // 第一遍：复核 + 分类（回收站批量处理效率最高）
    for (const item of ticket.items) {
      if (options.signal?.aborted) break
      const rejection = await this.ctx.compensate.recheck(item)
      if (rejection) {
        if (rejection.reason === 'vanished') outcome.vanished++
        else outcome.skipped++
        const result: CleanItemResult = { itemId: item.itemId, path: item.path, ok: false, bytes: 0, error: rejection.message }
        outcome.results.push(result)
        options.onItem?.(result)
        continue
      }
      if (item.mode === 'recycle') {
        recycleQueue.push(item)
        pending.set(item.itemId, item)
        continue
      }
      plainQueue.push(item)
    }

    // 第二遍：批量进回收站
    if (recycleQueue.length && !options.signal?.aborted) {
      const receipt = await this.ctx.recycleBin.recycle(
        recycleQueue.map((item) => ({ path: item.path, isDirectory: item.kind === 'directory' })),
      )
      const okSet = new Set(receipt.ok.map((value) => pathKey(value)))
      const failedMap = new Map(receipt.failed.map((item) => [pathKey(item.path), item.message]))
      for (const item of recycleQueue) {
        const key = pathKey(item.path)
        let result: CleanItemResult
        if (okSet.has(key)) {
          outcome.recycledBytes += item.size
          result = { itemId: item.itemId, path: item.path, ok: true, bytes: item.size }
        } else {
          const message = failedMap.get(key) ?? '回收站调用失败'
          outcome.skipped++
          result = { itemId: item.itemId, path: item.path, ok: false, bytes: 0, error: message }
        }
        outcome.results.push(result)
        options.onItem?.(result)
        pending.delete(item.itemId)
      }
    }

    // 非回收站项并发执行（补偿链已在前置阶段完成逐项校验）
    const settled = await mapLimit(plainQueue, 16, (item) => this.runOne(item, options, settings.clean.retries))
    for (const result of settled) {
      this.absorb(outcome, result)
      options.onItem?.(result)
    }
    outcome.failed = outcome.results.filter((result) => !result.ok).length
    return outcome
  }

  /** 单条执行：删除 / 清空 / 隔离 */
  private async runOne(item: CleanTicketItem, options: ExecuteOptions, retries: number): Promise<CleanItemResult> {
    const fail = (message: string): CleanItemResult => ({ itemId: item.itemId, path: item.path, ok: false, bytes: 0, error: message })
    try {
      // 隔离区：可恢复，按"移动前的体积"计量
      if (item.mode === 'quarantine') {
        if (!options.session) return fail('隔离区未初始化')
        await options.session.move(item.path, item.taskId, item.size)
        return { itemId: item.itemId, path: item.path, ok: true, bytes: item.size, quarantined: true }
      }
      // 数据库压缩：不删除数据，只回收空闲页
      if (item.action === 'compact') {
        const result = await compactSqlite(item.path)
        return { itemId: item.itemId, path: item.path, ok: true, bytes: result.freed }
      }
      // 目录预检：任一子项被占用/无权限就整目录跳过，避免"删了一半"
      if (item.kind === 'directory' || item.action === 'clear') {
        const preflight = await preflightDirectory(item.path)
        if (!preflight.ok) return fail(preflight.message)
      }
      // 清空语义：只删子项，保留目录
      if (item.action === 'clear') {
        const result = await clearDirectory(item.path, { retries })
        return { itemId: item.itemId, path: item.path, ok: true, bytes: result.bytes || item.size }
      }
      const before = await stat(item.path).then((info) => info.size).catch(() => item.size)
      const result = await deletePath(item.path, { recursive: true, retries })
      const freed = result.bytes || before
      return { itemId: item.itemId, path: item.path, ok: true, bytes: freed }
    } catch (error) {
      return fail(describeDeleteError(error))
    }
  }

  /** 汇总单个结果（隔离区与永久删除分开计量） */
  private absorb(outcome: ExecuteOutcome, result: CleanItemResult): void {
    outcome.results.push(result)
    if (!result.ok) {
      outcome.failed++
      return
    }
    if (result.quarantined) outcome.quarantinedBytes += result.bytes
    else outcome.freedBytes += result.bytes
  }
}
