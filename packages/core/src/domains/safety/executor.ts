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
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { Service, type Context } from 'cordis'
import type { CleanItemResult } from '@cordclean/shared'
import { clearDirectory, compactSqlite, deletePath, describeDeleteError, isSubPath, mapLimit, normalizePath, pathKey } from '@cordclean/utils'
import type { QuarantineSession } from './quarantine.ts'
import { isCleanTicket, type CleanTicket, type CleanTicketItem } from './compensate.ts'
import { protectedComponentName } from './path-policy.ts'

export interface ExecuteOptions {
  signal?: AbortSignal
  session?: QuarantineSession
  dryRun?: boolean
  onItem?(result: CleanItemResult): void
}

/**
 * 内部维护路径的删除理由（受控通道，非用户数据辖区）。
 *
 * 这些路径被路径策略保护或不属于清理辖区，不能走补偿链；但也不允许插件
 * 直接 `fs.unlink`：统一经 `ExecutorService.deleteInternal()` 按 reason 校验前缀后删除。
 */
export type InternalDeleteReason =
  | 'recycle-bin'
  | 'startup-entry'
  | 'quarantine'
  | 'logs'
  | 'plugin-staging'
  | 'generated-plugins'

export interface InternalDeleteResult {
  ok: boolean
  bytes: number
  error?: string
}

export interface ExecuteOutcome {
  results: CleanItemResult[]
  freedBytes: number
  recycledBytes: number
  quarantinedBytes: number
  vanished: number
  skipped: number
  failed: number
  /** 用户在执行中取消；已执行的部分仍会如实返回 */
  cancelled: boolean
}

/** 目录预检结果：只拦“连顶层目录都读不了”的情况 */
export type PreflightResult = { ok: true; entries: number } | { ok: false; path: string; message: string }

/**
 * 目录预检：只做「顶层目录能否读取」的快速检查，不递归、不逐文件试探。
 *
 * 早期实现递归 `open(file, 'r+')`：超过 5000 项或遇到只读/占用文件就整目录跳过，
 * 浏览器缓存、`%TEMP%` 这类大目录会永远清不掉。现在大目录/占用子项交给逐项删除
 * （`clearDirectory`）并如实返回部分结果，预检只负责拦住"连目录都读不了"的情况。
 */
export async function preflightDirectory(root: string): Promise<PreflightResult> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return { ok: true, entries: entries.length }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN'
    return { ok: false, path: root, message: '无法读取目录（' + code + '），已跳过' }
  }
}

/**
 * 递归扫描目录子树，返回第一个命中的受保护目录（`.git` / `.venv` / 微信数据等）。
 *
 * `PathPolicyService.containsProtected()` 只覆盖「系统保护目录前缀树」，
 * 不会检查普通目录里嵌着 `.git` 这类受保护名目录；递归删除前必须单独扫一遍，
 * 否则删除 `D:\Projects\foo` 会把 `foo\.git` 一起删掉（defect-log D-72）。
 */
async function findProtectedDescendant(root: string): Promise<string | undefined> {
  const stack: string[] = [root]
  while (stack.length) {
    const dir = stack.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      // 符号链接/联接点不跟进去（删除时也只删链接本身）
      if (!entry.isDirectory()) continue
      const full = dir + (dir.endsWith('\\') ? '' : '\\') + entry.name
      if (protectedComponentName(entry.name)) return full
      stack.push(full)
    }
  }
  return undefined
}

export class ExecutorService extends Service {
  static inject = ['compensate', 'recycleBin', 'settings', 'system']

  constructor(ctx: Context) {
    super(ctx, 'executor')
  }

  async execute(ticket: unknown, options: ExecuteOptions = {}): Promise<ExecuteOutcome> {
    if (!isCleanTicket(ticket)) throw new Error('执行器拒绝：缺少补偿链令牌')

    const outcome: ExecuteOutcome = {
      results: [],
      freedBytes: 0,
      recycledBytes: 0,
      quarantinedBytes: 0,
      vanished: 0,
      skipped: 0,
      failed: 0,
      cancelled: false,
    }
    if (options.signal?.aborted) {
      outcome.cancelled = true
      return outcome
    }
    if (options.dryRun) {
      for (const item of ticket.items) {
        outcome.results.push({ itemId: item.itemId, path: item.path, ok: true, bytes: item.size })
      }
      return outcome
    }
    // 一次性令牌：真正执行前先消费（dryRun 只是预览，不烧票）。
    // 过期或重放都在这里拒绝，且消费在第一个 await 之前完成，天然原子。
    const consumed = this.ctx.compensate.consume(ticket)
    if (!consumed.ok) throw new Error(`执行器拒绝：${consumed.message}`)

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
      if (!result) continue
      this.absorb(outcome, result)
      options.onItem?.(result)
    }
    outcome.cancelled = Boolean(options.signal?.aborted)
    outcome.failed = outcome.results.filter((result) => !result.ok).length
    return outcome
  }

  /**
   * 内部维护路径的受控删除（唯一删除入口的「内部通道」）。
   *
   * 回收站 `$I/$R`、启动文件夹快捷方式、隔离区、日志、插件 staging 等路径
   * 被路径策略保护或不属于用户清理辖区，不能走补偿链；插件也不再直接
   * `fs.unlink`，而是按 reason 交给执行器校验前缀后删除，保证所有删除
   * 都从执行器这一个出口走，并留下日志。
   */
  async deleteInternal(target: string, reason: InternalDeleteReason): Promise<InternalDeleteResult> {
    const env = this.ctx.system.env
    const normalized = normalizePath(target)
    const deny = (message: string): InternalDeleteResult => {
      this.ctx.logger?.warn?.('内部删除被拒绝（%s）：%s — %s', reason, target, message)
      return { ok: false, bytes: 0, error: message }
    }
    if (!normalized) return deny('路径为空')
    const dataDir = env.dataDir
    const dataRoots: Record<Exclude<InternalDeleteReason, 'recycle-bin' | 'startup-entry'>, string[]> = {
      quarantine: [path.join(dataDir, 'quarantine')],
      logs: [path.join(dataDir, 'logs')],
      'plugin-staging': [path.join(dataDir, 'plugins', '.staging')],
      'generated-plugins': [path.join(dataDir, 'generated-plugins')],
    }
    if (reason === 'recycle-bin') {
      // 只允许 X:\$Recycle.Bin\<SID>\$I* / $R*
      const drive = path.parse(normalized).root
      if (!drive) return deny('不是绝对路径')
      if (!isSubPath(`${drive}\\$Recycle.Bin`, normalized)) return deny('不在 $Recycle.Bin 目录内')
      if (!/^\$[IR]/i.test(path.basename(normalized))) return deny('不是 $I/$R 回收站文件')
    } else if (reason === 'startup-entry') {
      // 只允许启动文件夹的直接子项，且必须是快捷方式（startup 插件只上报 .lnk/.url）
      const startupDirs = [
        path.join(env.appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
        path.join(env.programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
      ]
      const parent = path.dirname(normalized)
      if (!startupDirs.some((dir) => isSubPath(dir, normalized)) || !startupDirs.some((dir) => pathKey(dir) === pathKey(parent))) {
        return deny('不在启动文件夹内')
      }
      if (!/\.(lnk|url)$/i.test(normalized)) return deny('不是快捷方式文件')
    } else if (!dataRoots[reason].some((root) => isSubPath(root, normalized))) {
      return deny('不在允许的内部维护目录内')
    }
    try {
      const result = await deletePath(normalized, { recursive: false, retries: 1 })
      this.ctx.logger?.debug?.('内部删除（%s）：%s', reason, target)
      return { ok: true, bytes: result.bytes }
    } catch (error) {
      return { ok: false, bytes: 0, error: describeDeleteError(error) }
    }
  }

  /** 单条执行：删除 / 清空 / 隔离 */
  private async runOne(item: CleanTicketItem, options: ExecuteOptions, retries: number): Promise<CleanItemResult | undefined> {
    if (options.signal?.aborted) return undefined
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
      // 目录预检：只拦“连顶层目录都读不了”的情况；大目录/占用子项降级为逐项删除
      if (item.kind === 'directory' || item.action === 'clear') {
        const preflight = await preflightDirectory(item.path)
        if (!preflight.ok) return fail(preflight.message)
        // 子树里嵌着受保护目录名（.git/.venv/微信数据等）时整项拒绝：
        // 策略层的 containsProtected 只覆盖系统保护目录，不覆盖这类名字。
        const protectedDescendant = await findProtectedDescendant(item.path)
        if (protectedDescendant) {
          return fail(`目录包含受保护目录（${protectedDescendant}），已拒绝整项删除`)
        }
      }
      if (options.signal?.aborted) return undefined
      // 清空语义：只删子项，保留目录；部分失败时如实返回已释放字节
      if (item.action === 'clear') {
        const result = await clearDirectory(item.path, { retries, signal: options.signal })
        if (result.cancelled) {
          return { itemId: item.itemId, path: item.path, ok: false, bytes: result.bytes, error: '清理已取消，当前目录可能已部分清空' }
        }
        if (result.failed.length) {
          return {
            itemId: item.itemId,
            path: item.path,
            ok: false,
            bytes: result.bytes,
            error: `清空目录时有 ${result.failed.length} 个子项失败（可能被占用或无权限），其余已删除`,
          }
        }
        return { itemId: item.itemId, path: item.path, ok: true, bytes: result.bytes || item.size }
      }
      if (item.kind === 'directory') return await this.deleteDirectory(item, options, retries)
      if (options.signal?.aborted) return undefined
      const before = await stat(item.path).then((info) => info.size).catch(() => item.size)
      const result = await deletePath(item.path, { recursive: true, retries })
      const freed = result.bytes || before
      return { itemId: item.itemId, path: item.path, ok: true, bytes: freed }
    } catch (error) {
      return fail(describeDeleteError(error))
    }
  }

  /**
   * 删除目录：先清空子项、再删空目录。
   *
   * 不再因为「子项过多/某个子项被占用」整目录跳过；能删多少删多少，
   * 并如实返回已释放字节与失败子项数（部分结果不虚报成功）。
   */
  private async deleteDirectory(item: CleanTicketItem, options: ExecuteOptions, retries: number): Promise<CleanItemResult> {
    const cleared = await clearDirectory(item.path, { retries, signal: options.signal })
    const bytes = cleared.bytes
    if (cleared.cancelled) {
      return { itemId: item.itemId, path: item.path, ok: false, bytes, error: '清理已取消，当前目录可能已部分清空' }
    }
    if (cleared.failed.length) {
      return {
        itemId: item.itemId,
        path: item.path,
        ok: false,
        bytes,
        error: `目录已部分清理：${cleared.failed.length} 个子项失败（可能被占用或无权限），其余已删除`,
      }
    }
    try {
      const removed = await deletePath(item.path)
      return { itemId: item.itemId, path: item.path, ok: true, bytes: bytes + removed.bytes }
    } catch (error) {
      return {
        itemId: item.itemId,
        path: item.path,
        ok: false,
        bytes,
        error: `目录内容已清空，但目录本身删除失败：${describeDeleteError(error)}`,
      }
    }
  }

  /** 汇总单个结果（隔离区与永久删除分开计量；部分清理也如实计入已释放字节） */
  private absorb(outcome: ExecuteOutcome, result: CleanItemResult): void {
    outcome.results.push(result)
    if (result.quarantined) {
      outcome.quarantinedBytes += result.bytes
      return
    }
    if (result.ok) {
      outcome.freedBytes += result.bytes
      return
    }
    outcome.failed++
    if (result.bytes > 0) outcome.freedBytes += result.bytes
  }
}
