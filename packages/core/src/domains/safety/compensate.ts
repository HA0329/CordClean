/**
 * 补偿链服务（`ctx.compensate`）。
 *
 * 删除是「不可回滚的外部事实」，所以框架的 effect 帮不上忙；
 * 能做的是把删除前的七道检查显式化，并让唯一删除入口只接受"过链"的令牌：
 *
 *   ① 路径规范化  ② 黑名单  ③ 白名单  ④ 条件评估
 *   ⑤ 预览一致性  ⑥ 预算上限  ⑦ 回收站可用性
 *
 * 任何一步失败都返回结构化拒绝原因，由执行器与界面如实呈现（论文 5.3 / 表 5-2）。
 */
import { randomUUID } from 'node:crypto'
import { lstat, open, stat } from 'node:fs/promises'
import path from 'node:path'
import { Service, type Context } from 'cordis'
import type { CleanItem, CleanMode } from '@cordclean/shared'
import { canonicalizePath, findLinkAncestor, normalizePath } from '@cordclean/utils'
import type { PathPolicyLike } from '@cordclean/shared'

export type RejectReason =
  | 'normalize'
  | 'protected'
  | 'outside'
  | 'unsupported-kind'
  | 'in-use'
  | 'vanished'
  | 'changed'
  | 'changed-ratio'
  | 'budget'
  | 'recycle-unavailable'

export interface CompensateRejection {
  itemId: string
  path: string
  reason: RejectReason
  message: string
}

export interface CompensateRequest {
  items: CleanItem[]
  mode: CleanMode
  /** 覆盖默认预算（测试/特殊场景使用） */
  budget?: { maxFiles: number; maxBytes: number }
  signal?: AbortSignal
}

export interface CompensateStats {
  checked: number
  accepted: number
  rejected: number
  changed: number
  vanished: number
  /** 是否因为预算/一致性比例整批中止 */
  aborted: boolean
}

export interface CompensateOutcome {
  ticket?: CleanTicket
  rejections: CompensateRejection[]
  stats: CompensateStats
}

const TICKET_BRAND = Symbol('cordclean.clean-ticket')

/** 通过补偿链的删除令牌：只有本模块能构造，执行器只认这个身份 */
export class CleanTicket {
  readonly [TICKET_BRAND] = true
  constructor(
    readonly id: string,
    readonly mode: CleanMode,
    readonly items: CleanTicketItem[],
    readonly issuedAt: number,
    /** 一次性身份：执行器消费后同一令牌不能再次执行 */
    readonly nonce: string,
    /** 有效期截止时间：过期令牌一律拒绝（防签发后长时间休眠再执行） */
    readonly expiresAt: number,
  ) {}
}

export interface CleanTicketItem {
  itemId: string
  path: string
  kind: 'file' | 'directory'
  size: number
  /** 签发时的 mtime：执行前复核同路径内容是否被替换 */
  mtimeMs: number
  /** clear = 清空目录内容、保留目录 */
  action: 'delete' | 'clear' | 'compact'
  /** 该项实际采用的删除方式（回收站不可用时逐项回落隔离区） */
  mode: CleanMode
  taskId: string
}

/** 运行期身份校验：类型标注挡不住 any，必须用私有 brand */
export function isCleanTicket(value: unknown): value is CleanTicket {
  return !!value && typeof value === 'object' && (value as any)[TICKET_BRAND] === true
}

/** 预览一致性阈值：不一致比例超过 5% 整批中止 */
export const CHANGE_RATIO_LIMIT = 0.05

/** 令牌有效期：签发后超过该时间未执行，一律拒绝（防“签发后休眠再执行”） */
export const TICKET_TTL_MS = 5 * 60_000

/** 执行前复核允许的 mtime 偏差（文件系统时间精度与快速写入） */
const RECHECK_MTIME_TOLERANCE_MS = 2000

export class CompensateService extends Service {
  static inject = ['pathPolicy', 'settings', 'recycleBin']

  constructor(ctx: Context) {
    super(ctx, 'compensate')
  }

  /** 执行七步链，通过则签发令牌 */
  async issue(request: CompensateRequest): Promise<CompensateOutcome> {
    const rejections: CompensateRejection[] = []
    const stats: CompensateStats = { checked: 0, accepted: 0, rejected: 0, changed: 0, vanished: 0, aborted: false }
    const settings = this.ctx.settings.get()
    const budget = request.budget ?? settings.clean.budget
    const policy = this.ctx.pathPolicy
    const candidates: CleanTicketItem[] = []
    const linkCache = new Map<string, string | undefined>()
    // 允许根本身若被替换成联接点，删除会落到辖区外；每个���只检查一次
    const rootLinkCache = new Map<string, string | undefined>()

    const reject = (item: CleanItem, reason: RejectReason, message: string) => {
      rejections.push({ itemId: item.id, path: item.path, reason, message })
      stats.rejected++
    }

    // ⑥ 预算：先看规模，超了直接整批拒绝，不做任何删除
    const totalBytes = request.items.reduce((sum, item) => sum + Math.max(0, item.size), 0)
    if (request.items.length > budget.maxFiles || totalBytes > budget.maxBytes) {
      stats.aborted = true
      for (const item of request.items) {
        reject(item, 'budget', `超出单次清理预算（${request.items.length} 项 / ${totalBytes} 字节）`)
      }
      return { rejections, stats }
    }

    for (const item of request.items) {
      stats.checked++
      if (request.signal?.aborted) break
      // ④ 条件：只处理文件与目录，其余类型必须由插件自定义清理
      if (item.kind !== 'file' && item.kind !== 'directory') {
        reject(item, 'unsupported-kind', '该类型需要插件自定义清理逻辑')
        continue
      }
      // ① 规范化：相对路径、空路径、盘符根一律拒绝
      const normalized = normalizePath(item.path)
      if (!normalized || !/^[a-zA-Z]:\\/.test(normalized)) {
        reject(item, 'normalize', '路径不是绝对路径')
        continue
      }
      const canonical = canonicalizePath(normalized)
      if (/^[a-zA-Z]:\\?$/.test(canonical)) {
        reject(item, 'normalize', '拒绝处理驱动器根目录')
        continue
      }

      const clear = item.kind === 'directory' && (item.meta as any)?.action === 'clear'
      // ② 黑名单 / ③ 白名单：受保护路径拒绝；清空语义走清空白名单
      // 清空语义优先走清空白名单；白名单未命中时回落到普通辖区（受保护目录仍会被拒绝）
      const clearCheck = clear ? policy.checkClear(canonical) : undefined
      const check = clearCheck?.allowed ? clearCheck : policy.check(canonical)
      if (!check.allowed) {
        const reason: RejectReason = check.reason === 'protected' ? 'protected' : check.reason === 'name-denied' ? 'protected' : 'outside'
        reject(item, reason, `路径被策略拒绝（${check.reason ?? 'unknown'}${check.detail ? `：${check.detail}` : ''}）`)
        continue
      }
      if (!clear && item.kind === 'directory' && policy.containsProtected(canonical)) {
        reject(item, 'protected', '目标目录包含受保护的系统目录')
        continue
      }
      // ③ 白名单：必须命中某个允许根（clear 走清空白名单）
      if (!clear) {
        const root = policy.rootOf(canonical)
        if (!root) {
          reject(item, 'outside', '不在任何已声明的清理辖区内')
          continue
        }
      }

      // ④ 条件：链接祖先检查（防止经 junction 穿透到辖区外）
      if (clear) {
        if (await isLink(canonical)) {
          reject(item, 'protected', '清空目标本身是符号链接/联接点，已拒绝')
          continue
        }
      } else {
        const stopAt = policy.rootOf(canonical) ?? path.parse(canonical).root
        const stopKey = stopAt.toLowerCase()
        let rootLink = rootLinkCache.get(stopKey)
        if (rootLink === undefined && !rootLinkCache.has(stopKey)) {
          rootLink = (await isLinkPath(stopAt)) ? stopAt : undefined
          rootLinkCache.set(stopKey, rootLink)
        }
        if (rootLink) {
          reject(item, 'protected', `允许根本身是联接点/符号链接，已拒绝：${rootLink}`)
          continue
        }
        const link = await linkAncestorOf(canonical, stopAt, linkCache)
        if (link) {
          reject(item, 'protected', `路径包含联接点或符号链接，已拒绝：${link}`)
          continue
        }
      }

      // ④ 条件：文件被占用时跳过（尽力探测，删除失败仍会单独归类）
      if (item.kind === 'file' && (await isFileBusy(canonical))) {
        reject(item, 'in-use', '文件正被其它程序占用')
        continue
      }

      // ⑤ 预览一致性：扫描后文件被改过/删掉，不按旧预览删除
      let currentSize = item.size
      let currentMtime = 0
      try {
        const info = await stat(canonical)
        currentSize = info.size
        currentMtime = info.mtimeMs
        // 目录的 stat.size 只是目录项大小（通常为 0），不能和聚合体积比较
        if (item.mtimeMs && item.mtimeMs > 0 && Math.abs(info.mtimeMs - item.mtimeMs) > 2000) {
          stats.changed++
          reject(item, 'changed', `文件修改时间已变化（预览 ${item.mtimeMs} → 现在 ${info.mtimeMs}）`)
          continue
        }
        if (item.kind === 'file' && item.size > 0 && info.size !== item.size) {
          stats.changed++
          reject(item, 'changed', `文件大小已变化（预览 ${item.size} → 现在 ${info.size}）`)
          continue
        }
      } catch {
        stats.vanished++
        reject(item, 'vanished', '目标已不存在（可能在扫描后被删除/移动）')
        continue
      }

      // ⑦ 回收站可用性：不可用且允许回落时改用隔离区，否则拒绝
      const compact = item.kind === 'file' && (item.meta as any)?.action === 'compact'
      // clear 语义是"删内容、留目录"，不能整目录进回收站，统一按永久删除处理
      let mode: CleanMode = clear || compact ? 'delete' : request.mode
      if (mode === 'recycle' && !(await this.ctx.recycleBin.available(canonical))) {
        if (settings.clean.quarantineFallback) mode = 'quarantine'
        else {
          reject(item, 'recycle-unavailable', '该卷回收站不可用')
          continue
        }
      }

      const action: 'delete' | 'clear' | 'compact' = clear ? 'clear' : (item.meta as any)?.action === 'compact' ? 'compact' : 'delete'
      candidates.push({
        itemId: item.id,
        path: canonical,
        kind: item.kind,
        size: currentSize,
        mtimeMs: currentMtime,
        action,
        mode,
        taskId: item.taskId,
      })
      stats.accepted++
    }

    // ⑤ 预览一致性：不一致比例过高说明扫描结果已整体过期，整批中止
    const ratio = stats.checked ? stats.changed / stats.checked : 0
    if (ratio > CHANGE_RATIO_LIMIT) {
      stats.aborted = true
      for (const candidate of candidates) {
        rejections.push({
          itemId: candidate.itemId,
          path: candidate.path,
          reason: 'changed-ratio',
          message: `预览不一致比例 ${(ratio * 100).toFixed(1)}% 超过阈值，整批中止`,
        })
      }
      stats.accepted = 0
      stats.rejected += candidates.length
      return { rejections, stats }
    }

    if (!candidates.length) return { rejections, stats }
    const issuedAt = Date.now()
    const ticket = new CleanTicket(
      `t${issuedAt.toString(36)}-${randomUUID().slice(0, 8)}`,
      request.mode,
      candidates,
      issuedAt,
      randomUUID(),
      issuedAt + TICKET_TTL_MS,
    )
    return { ticket, rejections, stats }
  }

  /**
   * 消费令牌（同步、原子）：执行器在真正删除前调用。
   *
   * - 过期令牌拒绝（签发后超过 `TICKET_TTL_MS` 未执行）；
   * - 已消费令牌拒绝（同一张票不能执行第二次，防重放）。
   *
   * 进程内单线程执行，`has` + `set` 之间没有 await，天然原子。
   */
  consume(ticket: CleanTicket): { ok: true } | { ok: false; reason: 'replay' | 'expired'; message: string } {
    const now = Date.now()
    if (now > ticket.expiresAt) {
      return { ok: false, reason: 'expired', message: `令牌已过期（有效期 ${Math.round(TICKET_TTL_MS / 1000)} 秒），拒绝执行` }
    }
    if (this.consumed.has(ticket.nonce)) {
      return { ok: false, reason: 'replay', message: '令牌已被使用过（重放），拒绝执行' }
    }
    this.consumed.set(ticket.nonce, ticket.expiresAt)
    // 顺手清理过期记录，避免长时间运行内存增长
    if (this.consumed.size > 64) {
      for (const [nonce, expiry] of this.consumed) {
        if (expiry < now) this.consumed.delete(nonce)
      }
    }
    return { ok: true }
  }

  /** 已消费令牌：nonce → 过期时间（只用于防重放，进程内存储） */
  private readonly consumed = new Map<string, number>()

  /**
   * 执行前的逐项复核（不信任令牌内容，论文 5.3 "令牌化入口"）。
   * 检查：路径策略 + 清空链接 + 存在性 + 签发后的 size/mtime 一致性。
   * 只做便宜且必须的检查；真正的删除仍由执行器完成。
   */
  async recheck(item: CleanTicketItem): Promise<CompensateRejection | undefined> {
    const policy: PathPolicyLike = this.ctx.pathPolicy
    const clearCheck = item.action === 'clear' ? policy.checkClear(item.path) : undefined
    const check = clearCheck?.allowed ? clearCheck : policy.check(item.path)
    if (!check.allowed) {
      return { itemId: item.itemId, path: item.path, reason: 'protected', message: `执行前复核失败：${check.reason ?? 'policy'}` }
    }
    // 清空目标在执行前被替换成链接：clearDirectory 会顺着链接删除，必须复核
    if (item.action === 'clear' && (await isLinkPath(item.path))) {
      return { itemId: item.itemId, path: item.path, reason: 'protected', message: '执行前复核：清空目标已变成联接点/符号链接' }
    }
    let info
    try {
      info = await stat(item.path)
    } catch {
      return { itemId: item.itemId, path: item.path, reason: 'vanished', message: '执行前复核：目标已不存在' }
    }
    // 签发后同路径内容被替换：按签发时的 size/mtime 复核，不能只看“还在不在”
    if (item.kind === 'file') {
      if (item.size > 0 && info.size !== item.size) {
        return {
          itemId: item.itemId,
          path: item.path,
          reason: 'changed',
          message: `执行前复核：文件大小已变化（签发 ${item.size} → 现在 ${info.size}）`,
        }
      }
    }
    if (item.mtimeMs > 0 && Math.abs(info.mtimeMs - item.mtimeMs) > RECHECK_MTIME_TOLERANCE_MS) {
      return {
        itemId: item.itemId,
        path: item.path,
        reason: 'changed',
        message: `执行前复核：修改时间已变化（签发 ${item.mtimeMs} → 现在 ${info.mtimeMs}）`,
      }
    }
    return undefined
  }
}

/** 路径本身是否为符号链接/联接点（不存在或权限不足时返回 false） */
async function isLinkPath(target: string): Promise<boolean> {
  try {
    return (await lstat(target)).isSymbolicLink()
  } catch {
    return false
  }
}

/** 尽力探测文件是否被独占（EBUSY/EAGAIN）；权限不足不当作占用 */
async function isFileBusy(target: string): Promise<boolean> {
  try {
    const handle = await open(target, 'r+')
    await handle.close()
    return false
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EBUSY' || code === 'EAGAIN') return true
    return false
  }
}

/** 链接祖先检查（同一目录只查一次） */
async function linkAncestorOf(target: string, stopAt: string, cache: Map<string, string | undefined>): Promise<string | undefined> {
  const dir = target.replace(/[\\/][^\\/]*$/, '')
  if (cache.has(dir)) return cache.get(dir)
  let found: string | undefined
  try {
    found = await findLinkAncestor(target, stopAt)
  } catch {
    found = undefined
  }
  cache.set(dir, found)
  return found
}

/** 目标本身是否为符号链接/联接点 */
async function isLink(target: string): Promise<boolean> {
  try {
    const info = await lstat(target)
    return info.isSymbolicLink()
  } catch {
    return false
  }
}
