/**
 * 清理引擎（内核核心服务）。
 *
 * 职责边界：
 * - **插件**只负责「找出可清理项」与（可选）「如何清理」；
 * - **引擎**负责扫描调度、并发控制、去重、进度事件、路径策略复检、
 *   隔离区、失败归因、历史记录与取消。
 *
 * 这样新增一个清理能力 = 新增一个插件，内核零改动，
 * 同时也保证了「所有删除动作都必须经过同一道安全阀」。
 */
import { Service, type Context } from 'cordis'
import { basename, formatBytes, itemId } from '@cordclean/shared'
import type {
  CleanItem,
  CleanItemDraft,
  CleanItemResult,
  CleanOptions,
  CleanProgressEvent,
  CleanReport,
  CleanerLike,
  HistoryEntry,
  ScanError,
  ScanOptions,
  ScanProgressEvent,
  ScanReport,
  TaskCleanContext,
  TaskDefinition,
  TaskDescriptor,
  TaskScanContext,
  TaskScanResult,
} from '@cordclean/shared'
import { clearDirectory, deletePath, describeDeleteError, errorMessage, findLinkAncestor, isAbortError, mapLimit, normalizePath, pathKey, Pool } from '@cordclean/utils'
import type { QuarantineSession } from './quarantine.ts'
import type { PathPolicyLike } from '@cordclean/shared'

interface RegisteredTask {
  task: TaskDefinition
  pluginId: string
}

/** 进度事件节流间隔 */
const PROGRESS_INTERVAL = 120
/** 扫描结果最多保留的错误条数 */
const MAX_ERRORS = 200
/** 文件删除并发度 */
const DELETE_CONCURRENCY = 6

export class CleanerService extends Service implements CleanerLike {
  static inject = ['settings', 'pathPolicy', 'quarantine', 'history', 'system']

  private tasks = new Map<string, RegisteredTask>()
  private scanController?: AbortController
  private cleanController?: AbortController
  private lastScanReport?: ScanReport
  private lastItems = new Map<string, CleanItem>()
  private currentScanId?: string
  private currentSessionId?: string
  /**
   * 「祖先目录链接检查」缓存：同一目录下的文件共享祖先，无需重复 lstat。
   * key = 父目录键 + 辖区键，value = 命中的链接路径（空串表示无链接）。
   */
  private linkSafe = new Map<string, string>()

  constructor(ctx: Context) {
    super(ctx, 'cleaner')
  }

  /* ------------------------------------------------------------------ */
  /* 任务注册                                                            */
  /* ------------------------------------------------------------------ */

  define(task: TaskDefinition, pluginId = 'builtin'): () => void {
    if (!task?.id) throw new Error('清理任务必须声明 id')
    if (this.tasks.has(task.id)) throw new Error(`清理任务 id 重复：${task.id}`)
    this.tasks.set(task.id, { task, pluginId })
    return () => {
      const current = this.tasks.get(task.id)
      if (current?.task === task) this.tasks.delete(task.id)
    }
  }

  /** 已注册任务的可序列化描述 */
  list(): TaskDescriptor[] {
    return [...this.tasks.values()]
      .map(({ task, pluginId }) => ({
        id: task.id,
        pluginId,
        name: task.name,
        description: task.description,
        category: task.category,
        risk: task.risk,
        icon: task.icon,
        requiresAdmin: task.requiresAdmin,
        defaultSelected: task.defaultSelected ?? task.risk === 'safe',
        targets: task.targets ?? [],
        tips: task.tips ?? [],
        estimatedMs: task.estimatedMs,
      }))
      .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
  }

  /** 是否存在某个任务 */
  has(taskId: string): boolean {
    return this.tasks.has(taskId)
  }

  lastScan(): ScanReport | undefined {
    return this.lastScanReport
  }

  /* ------------------------------------------------------------------ */
  /* 扫描                                                                */
  /* ------------------------------------------------------------------ */

  async scan(options: ScanOptions = {}): Promise<ScanReport> {
    const settings = this.ctx.settings.get()
    const selected = (options.taskIds ?? []).filter((id) => this.tasks.has(id))
    const targets: RegisteredTask[] = (selected.length ? selected : [...this.tasks.keys()])
      .map((id) => this.tasks.get(id))
      .filter((task): task is RegisteredTask => !!task)

    const scanId = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const controller = new AbortController()
    this.scanController?.abort()
    this.scanController = controller
    this.currentScanId = scanId
    if (options.signal) {
      if (options.signal.aborted) controller.abort()
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true })
    }

    const startedAt = Date.now()
    const items: CleanItem[] = []
    const seen = new Map<string, number>()
    const errors: ScanError[] = []
    const taskResults: TaskScanResult[] = []
    const truncated = { value: false }
    const extraBytes = { value: 0 }
    let fileCount = 0
    let dirCount = 0
    let totalBytes = 0
    let duplicateCount = 0
    // 服务引用只取一次：每次 `ctx.pathPolicy` 访问都会经过 Cordis 代理
    const policyRef = this.ctx.pathPolicy

    const pushItem = (registered: RegisteredTask, draft: CleanItemDraft): boolean => {
      const { task } = registered
      const kind = draft.kind ?? 'file'
      const rawPath = draft.path
      if (!rawPath) return false
      const path = kind === 'file' || kind === 'directory' ? normalizePath(rawPath) : rawPath
      const dedupeKey = kind === 'file' || kind === 'directory' ? pathKey(path) : `v:${path}`
      // 服务引用在扫描开始时取一次：避免每个清理项都经过 Cordis 上下文代理
      // `action: clear` 的目标走清空白名单（目录本身受保护，但允许清空内容）
      const isClear = kind === 'directory' && (draft.meta as any)?.action === 'clear'
      const policy = kind === 'file' || kind === 'directory'
        ? (isClear ? policyRef.checkClear(path) : policyRef.check(path))
        : { allowed: true }
      const risk = draft.risk ?? task.risk
      const size = Math.max(0, Math.trunc(draft.size ?? 0))
      const item: CleanItem = {
        id: itemId(task.id, path),
        taskId: task.id,
        path,
        title: draft.title ?? basename(path),
        kind,
        size,
        risk,
        category: task.category,
        defaultSelected: draft.defaultSelected ?? (!policy.allowed ? false : risk === 'safe' && (task.defaultSelected ?? true)),
        protected: !policy.allowed,
        meta: draft.meta,
        note: draft.note,
      }
      const existing = seen.get(dedupeKey)
      if (existing !== undefined) {
        // 同一路径被多个任务发现：保留体积更大的记录，避免「重复计数」
        duplicateCount++
        if (items[existing].size < size) items[existing].size = size
        return false
      }
      seen.set(dedupeKey, items.length)
      items.push(item)
      if (kind === 'directory') dirCount++
      else if (kind === 'file') fileCount++
      totalBytes += size
      return true
    }

    const runTask = async (registered: RegisteredTask): Promise<void> => {
      const task = registered.task
      const taskStarted = Date.now()
      let produced = 0
      let emitted = 0
      let lastEmit = 0

      const emitProgress = (current: string | undefined, force: boolean) => {
        const now = Date.now()
        if (!force && now - lastEmit < PROGRESS_INTERVAL) return
        lastEmit = now
        const event: ScanProgressEvent = {
          scanId,
          taskId: task.id,
          items: emitted,
          files: fileCount,
          dirs: dirCount,
          bytes: totalBytes + extraBytes.value,
          current,
          done: false,
        }
        this.ctx.emit('cleaner/scan-progress', event)
        try {
          options.onProgress?.(event)
        } catch {
          /* 忽略订阅者异常 */
        }
      }

      const scanCtx: TaskScanContext = {
        signal: controller.signal,
        config: {},
        logger: this.taskLogger(task.id),
        pathPolicy: policyRef,
        env: this.ctx.system.env,
        emit: (draft) => {
          if (produced >= settings.scan.maxItemsPerTask) {
            truncated.value = true
            return
          }
          produced++
          if (pushItem(registered, draft)) emitted++
          emitProgress(draft.path, false)
        },
        count: (kind, bytes = 0) => {
          if (kind === 'file') fileCount++
          else dirCount++
          extraBytes.value += bytes
        },
        addError: (error) => {
          if (errors.length < MAX_ERRORS) errors.push(error)
        },
        throwIfAborted: () => {
          if (controller.signal.aborted) {
            const error = new Error('扫描已取消')
            error.name = 'AbortError'
            throw error
          }
        },
      }

      try {
        const returned = await task.scan(scanCtx)
        if (Array.isArray(returned)) {
          for (const draft of returned) {
            if (produced >= settings.scan.maxItemsPerTask) {
              truncated.value = true
              break
            }
            produced++
            if (pushItem(registered, draft)) emitted++
          }
        }
        emitProgress(undefined, true)
        const result: TaskScanResult = {
          taskId: task.id,
          status: controller.signal.aborted ? 'cancelled' : 'ok',
          items: emitted,
          bytes: items.filter((item) => item.taskId === task.id).reduce((sum, item) => sum + item.size, 0),
          elapsedMs: Date.now() - taskStarted,
        }
        taskResults.push(result)
      } catch (error) {
        const aborted = controller.signal.aborted || isAbortError(error)
        if (!aborted) {
          this.ctx.logger?.warn?.(`扫描任务 ${task.id} 失败：%s`, errorMessage(error))
          if (errors.length < MAX_ERRORS) {
            errors.push({ path: `task:${task.id}`, message: errorMessage(error) })
          }
        }
        taskResults.push({
          taskId: task.id,
          status: aborted ? 'cancelled' : 'error',
          items: emitted,
          bytes: 0,
          elapsedMs: Date.now() - taskStarted,
          error: aborted ? undefined : errorMessage(error),
        })
      }
    }

    await mapLimit(targets, Math.max(1, settings.scan.concurrency), runTask)

    items.sort((a, b) => b.size - a.size)
    this.lastItems = new Map(items.map((item) => [item.id, item]))

    const report: ScanReport = {
      scanId,
      startedAt,
      elapsedMs: Date.now() - startedAt,
      items,
      stats: {
        files: fileCount,
        dirs: dirCount,
        bytes: totalBytes + extraBytes.value,
        errors: errors.length,
        truncated: truncated.value,
      },
      errors,
      tasks: taskResults,
      cancelled: controller.signal.aborted,
    }
    this.lastScanReport = report
    if (this.scanController === controller) this.scanController = undefined
    this.ctx.emit('cleaner/scan-done', report)
    void duplicateCount
    return report
  }

  /** 取消当前扫描 */
  cancelScan(): void {
    this.scanController?.abort()
  }

  /** 取消当前清理 */
  cancelClean(): void {
    this.cleanController?.abort()
  }

  /* ------------------------------------------------------------------ */
  /* 清理                                                                */
  /* ------------------------------------------------------------------ */

  async clean(options: CleanOptions = {}): Promise<CleanReport> {
    const settings = this.ctx.settings.get()
    const dryRun = options.dryRun ?? settings.clean.dryRunDefault
    // 去重：同一清理项被重复提交时只清理一次，避免重复计数
    const unique = new Map<string, CleanItem>()
    for (const item of this.resolveItems(options)) {
      if (!unique.has(item.id)) unique.set(item.id, item)
    }
    const items = [...unique.values()]
    if (!items.length) throw new Error('没有选中任何可清理的项')

    const controller = new AbortController()
    if (options.signal) {
      if (options.signal.aborted) controller.abort()
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    this.cleanController?.abort()
    this.cleanController = controller
    // 每次清理会话重新验证祖先目录（目录结构可能已变化）
    this.linkSafe.clear()
    // 服务引用只取一次：避免每个清理项都经过 Cordis 上下文代理
    const policyRef = this.ctx.pathPolicy
    const sessionId = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    this.currentSessionId = sessionId
    const startedAt = Date.now()
    const quarantineSession = dryRun ? undefined : this.ctx.quarantine.beginSession(sessionId)
    const forceQuarantine = options.forceQuarantine ?? false

    // 按任务分组：支持插件自定义清理逻辑
    const groups = new Map<string, CleanItem[]>()
    for (const item of items) {
      const list = groups.get(item.taskId)
      if (list) list.push(item)
      else groups.set(item.taskId, [item])
    }

    const failures: CleanReport['failures'] = []
    const perTask: CleanReport['perTask'] = []
    let cleaned = 0
    let quarantined = 0
    let freedBytes = 0

    for (const [taskId, groupItems] of groups) {
      if (controller.signal.aborted) break
      const registered = this.tasks.get(taskId)
      if (!registered) {
        for (const item of groupItems) failures.push({ itemId: item.id, path: item.path, message: '任务未加载' })
        perTask.push({ taskId, cleaned: 0, bytes: 0, failed: groupItems.length })
        continue
      }
      const total = groupItems.length
      let done = 0
      let lastEmit = 0
      const reportProgress = (current: string | undefined, finished = false) => {
        const now = Date.now()
        if (!finished && now - lastEmit < PROGRESS_INTERVAL) return
        lastEmit = now
        const event: CleanProgressEvent = {
          sessionId,
          taskId,
          total,
          done,
          bytes: freedBytes,
          failed: failures.length,
          current,
          finished,
        }
        this.ctx.emit('cleaner/clean-progress', event)
        try {
          options.onProgress?.(event)
        } catch {
          /* 忽略订阅者异常 */
        }
      }

      const results: CleanItemResult[] = []
      if (registered.task.clean) {
        // 插件自定义清理（注册表、命令行等非文件对象）
        const cleanCtx: TaskCleanContext = {
          signal: controller.signal,
          logger: this.taskLogger(taskId),
          env: this.ctx.system.env,
          pathPolicy: policyRef,
          dryRun,
          mode: forceQuarantine ? 'quarantine' : 'delete',
          quarantineDir: quarantineSession?.dir,
          throwIfAborted: () => {
            if (controller.signal.aborted) {
              const error = new Error('清理已取消')
              error.name = 'AbortError'
              throw error
            }
          },
        }
        try {
          const output = await registered.task.clean(groupItems, cleanCtx)
          results.push(...output)
          done = groupItems.length
          reportProgress(undefined, true)
        } catch (error) {
          for (const item of groupItems) {
            results.push({ itemId: item.id, path: item.path, ok: false, bytes: 0, error: errorMessage(error) })
          }
          done = groupItems.length
          reportProgress(undefined, true)
        }
      } else {
        const pool = new Pool(DELETE_CONCURRENCY)
        const settled = await Promise.all(
          groupItems.map((item) =>
            pool.run(async () => {
              const result = await this.cleanOne(item, {
                dryRun,
                signal: controller.signal,
                quarantineSession,
                forceQuarantine,
                policy: policyRef,
              })
              done++
              reportProgress(item.path, done === total)
              return result
            }),
          ),
        )
        results.push(...settled)
      }

      let taskCleaned = 0
      let taskBytes = 0
      let taskFailed = 0
      for (const result of results) {
        if (!result.ok) {
          taskFailed++
          failures.push({ itemId: result.itemId, path: result.path, message: result.error ?? '未知错误' })
          continue
        }
        taskCleaned++
        taskBytes += result.bytes
        freedBytes += result.bytes
        if (result.quarantined) quarantined++
        cleaned++
      }
      perTask.push({ taskId, cleaned: taskCleaned, bytes: taskBytes, failed: taskFailed })
    }

    await quarantineSession?.close()

    const report: CleanReport = {
      sessionId,
      taskIds: [...groups.keys()],
      dryRun,
      startedAt,
      elapsedMs: Date.now() - startedAt,
      freedBytes,
      cleaned,
      quarantined,
      failed: failures.length,
      cancelled: controller.signal.aborted,
      perTask,
      failures: failures.slice(0, 200),
    }

    if (!dryRun && cleaned > 0) {
      const entry: HistoryEntry = {
        sessionId,
        startedAt,
        elapsedMs: report.elapsedMs,
        taskIds: report.taskIds,
        freedBytes,
        cleaned,
        quarantined,
        failed: failures.length,
        dryRun: false,
      }
      this.ctx.history.append(entry)
    }

    if (this.cleanController === controller) this.cleanController = undefined
    this.currentSessionId = undefined
    this.ctx.emit('cleaner/clean-done', report)
    this.ctx.logger?.info?.(
      `清理完成：释放 %s，清理 ${cleaned} 项，失败 ${failures.length} 项`,
      formatBytes(freedBytes),
    )
    return report
  }

  /**
   * 带缓存的「祖先目录是否含链接」检查。
   * 同一目录下的文件共享祖先链，按父目录缓存可把每个文件的多次 lstat 降到接近一次。
   */
  private async checkLinkAncestors(target: string, policy: PathPolicyLike): Promise<string | undefined> {
    const normalized = normalizePath(target)
    const parent = normalized.slice(0, normalized.lastIndexOf('\\'))
    const root = policy.rootOf(target)
    const cacheKey = `${parent.toLowerCase()}|${(root ?? '').toLowerCase()}`
    const cached = this.linkSafe.get(cacheKey)
    if (cached !== undefined) return cached || undefined
    const found = (await findLinkAncestor(target, root)) ?? ''
    this.linkSafe.set(cacheKey, found)
    return found || undefined
  }

  /** 单个文件/目录的清理（通用引擎） */
  private async cleanOne(
    item: CleanItem,
    options: {
      dryRun: boolean
      signal: AbortSignal
      quarantineSession?: QuarantineSession
      forceQuarantine: boolean
      policy: PathPolicyLike
    },
  ): Promise<CleanItemResult> {
    const fail = (message: string): CleanItemResult => ({ itemId: item.id, path: item.path, ok: false, bytes: 0, error: message })
    if (options.signal.aborted) return fail('已取消')
    if (options.dryRun) return { itemId: item.id, path: item.path, ok: true, bytes: item.size }

    // 注册表 / 命令行等非文件对象必须由插件自定义清理，走不到通用删除引擎
    if (item.kind !== 'file' && item.kind !== 'directory') {
      return fail('该类型需要插件自定义清理逻辑')
    }
    // 规则里的 `action: clear`：清空目录内容、保留目录本身（走清空白名单）
    const isClear = item.kind === 'directory' && (item.meta as any)?.action === 'clear'
    // 二次校验：扫描后到清理前，路径策略或文件系统状态可能已变化
    const check = isClear ? options.policy.checkClear(item.path) : options.policy.check(item.path)
    if (!check.allowed) {
      return fail(`路径被策略保护（${check.reason ?? 'unknown'}）`)
    }
    if (!isClear && item.kind === 'directory' && options.policy.containsProtected(item.path)) {
      return fail('目标目录包含受保护的系统目录，已跳过')
    }
    // 第二道防线：祖先目录若是链接/联接点，删除会穿透到链接目标
    const linkAncestor = isClear ? undefined : await this.checkLinkAncestors(item.path, options.policy)
    if (linkAncestor) {
      return fail(`路径包含联接点或符号链接，已拒绝：${linkAncestor}`)
    }

    const settings = this.ctx.settings.get()
    // 清空语义：只删子项，不删目录本身
    if (isClear) {
      try {
        const result = await clearDirectory(item.path, { retries: settings.clean.retries })
        if (result.failed.length) {
          return {
            itemId: item.id,
            path: item.path,
            ok: true,
            bytes: result.bytes || item.size,
            error: undefined,
          }
        }
        return { itemId: item.id, path: item.path, ok: true, bytes: result.bytes || item.size }
      } catch (error) {
        return fail(describeDeleteError(error))
      }
    }
    const useQuarantine = !!options.quarantineSession
      && settings.quarantine.enabled
      && item.kind === 'file'
      && (options.forceQuarantine || item.risk !== 'safe')

    try {
      if (useQuarantine) {
        await options.quarantineSession!.move(item.path, item.taskId, item.size)
        return { itemId: item.id, path: item.path, ok: true, bytes: item.size, quarantined: true }
      }
      const result = await deletePath(item.path, { recursive: true, retries: settings.clean.retries })
      return { itemId: item.id, path: item.path, ok: true, bytes: result.bytes || item.size }
    } catch (error) {
      return fail(describeDeleteError(error))
    }
  }

  /** 解析清理项：支持直接传入 items 或通过 id 从上次扫描结果解析 */
  private resolveItems(options: CleanOptions): CleanItem[] {
    if (options.items?.length) {
      return options.items.filter((item) => !item.protected)
    }
    const ids = options.itemIds
    if (!ids?.length) {
      // 未指定时默认取上次扫描中「已默认勾选」的项
      const scan = this.lastScanReport
      if (!scan) return []
      return scan.items.filter((item) => item.defaultSelected && !item.protected)
    }
    const result: CleanItem[] = []
    for (const id of ids) {
      const item = this.lastItems.get(id)
      if (item && !item.protected) result.push(item)
    }
    return result
  }

  /** 把内核 logger 适配成插件可用的最小接口 */
  private taskLogger(taskId: string) {
    const logger = this.ctx.logger
    const prefix = `[${taskId}]`
    return {
      debug: (message: string, ...args: unknown[]) => logger.debug(`${prefix} ${message}`, ...args),
      info: (message: string, ...args: unknown[]) => logger.info(`${prefix} ${message}`, ...args),
      warn: (message: string, ...args: unknown[]) => logger.warn(`${prefix} ${message}`, ...args),
      error: (message: string, ...args: unknown[]) => logger.error(`${prefix} ${message}`, ...args),
    }
  }

  /** 当前扫描 id（供 RPC 取消） */
  get scanning(): string | undefined {
    return this.currentScanId
  }

  /** 当前清理会话 id */
  get cleaning(): string | undefined {
    return this.currentSessionId
  }
}
