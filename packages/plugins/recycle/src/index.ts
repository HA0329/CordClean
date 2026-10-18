/**
 * 回收站清理插件（recycle）。
 *
 * 为什么不用 `Clear-RecycleBin` 之类的系统命令？
 * 因为本产品的流程是「扫描 → 用户勾选 → 清理」，需要先把回收站里的内容
 * 还原成用户能看懂的原始文件名与大小；而系统命令只能一次性清空，无法与内核的
 * 清理项模型对接。
 *
 * 因此本插件直接解析每个盘符下的 `X:\$Recycle.Bin`：
 *
 *   SID 目录（每个用户账户一个，如 S-1-5-21-...-500）
 *     ├── $Ixxxxxx.ext   元数据：原始路径 / 原始大小 / 删除时间
 *     └── $Rxxxxxx.ext   真正的数据文件（与 $I 同名，仅前缀不同）
 *
 * 扫描时只上报「`$R` 真实存在」的项（`$I` 可能因为上次清理中断而成为孤儿）；
 * 清理时成对删除：**先删 `$R` 再删 `$I`** —— 这样任何一步失败都还能靠 `$I`
 * 在下次扫描中把这一项重新识别出来，保证操作幂等、可重试。
 */
import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import Schema from 'schemastery'
import { basename, defineCleanerPlugin, formatTime } from '@cordclean/shared'
import type {
  CleanItem,
  CleanItemDraft,
  CleanItemResult,
  TaskCleanContext,
  TaskScanContext,
} from '@cordclean/shared'
import {
  deletePath,
  describeDeleteError,
  driveOf,
  errorCode,
  errorMessage,
  exists,
  folderSize,
  isAbsolutePath,
  isSubPath,
  mapLimit,
  normalizePath,
  parentPath,
  runCommand,
  safeLstat,
  toLongPath,
} from '@cordclean/utils'

export interface RecycleConfig {
  /** 是否扫描其它用户账户的回收站（需要管理员权限才能读取） */
  includeOtherUsers: boolean
}

const Config = Schema.object({
  includeOtherUsers: Schema.boolean()
    .default(false)
    .description('同时扫描其它用户账户的回收站（需要管理员权限，否则这些目录会被自动跳过）'),
})

/* ------------------------------------------------------------------ */
/* $I 元数据解析                                                       */
/* ------------------------------------------------------------------ */

/** 1601-01-01 到 1970-01-01 之间的毫秒数（FILETIME 与 Unix 时间的纪元差） */
const FILETIME_EPOCH_DIFF_MS = 11_644_473_600_000

/** SID 目录名，如 `S-1-5-21-3656000344-499852391-737741175-500` */
const SID_DIR = /^S-1-5(?:-\d+)+$/i

/** 单次扫描最多上报的项目数（与内核 settings.scan.maxItemsPerTask 的默认值一致） */
const MAX_ITEMS = 20_000

/** 读取 `$I` 的并发度（回收站里通常是一大批小文件） */
const READ_CONCURRENCY = 8

/** 从 `$I` 中解析出的元数据 */
export interface RecycleInfo {
  /** `$I` 头部版本号：1 = Vista~8.1，2 = Windows 10/11 */
  version: number
  /** 被删除项的原始字节数；0 表示 `$I` 没有记录，需要回退到文件实际大小 */
  size: number
  /** 删除时间（Unix 毫秒）；0 表示无法解析 */
  deletedAt: number
  /** 原始绝对路径；空串表示名字字段损坏，调用方应回退到 `$R` 路径 */
  original: string
}

/** FILETIME（自 1601 起的 100ns 计数）→ Unix 毫秒 */
export function filetimeToUnix(filetime: bigint): number {
  if (filetime <= 0n) return 0
  return Number(filetime / 10_000n) - FILETIME_EPOCH_DIFF_MS
}

/** 从指定偏移解码 UTF-16LE 名字（`$I` 的名字以 `\0\0` 结尾） */
function decodeOriginal(buffer: Buffer, offset: number, declaredLength: number): string {
  if (offset >= buffer.length) return ''
  const available = Math.floor((buffer.length - offset) / 2)
  if (available <= 0) return ''
  // 声明的长度可能超过真实剩余字节（`$I` 被截断），因此以两者较小值为准
  const chars = declaredLength > 0 && declaredLength <= available ? declaredLength : available
  const raw = buffer.toString('utf16le', offset, offset + chars * 2)
  const end = raw.indexOf('\u0000')
  return (end >= 0 ? raw.slice(0, end) : raw).trimEnd()
}

/** 判断解析出的名字是否像一条合法的 Windows 绝对路径（用于丢弃垃圾数据） */
function isPlausibleOriginal(value: string): boolean {
  if (!value) return false
  // 控制字符通常意味着名字长度字段误读，解出来的是二进制垃圾
  return isAbsolutePath(value) && !/[\u0000-\u001f]/.test(value)
}

/**
 * 解析一个 `$I` 文件。
 *
 * 规范布局（由课题文档约定，v1 与绝大多数 v2 文件都适用）：
 * ```
 * 偏移 0   8   头部版本号（uint64 LE）
 * 偏移 8   8   文件大小（uint64 LE）
 * 偏移 16  8   删除时间（FILETIME，uint64 LE，100ns）
 * 偏移 24  4   名字长度（uint32 LE，UTF-16 码元数，含结尾 \0）
 * 偏移 28  ..  原始路径（UTF-16LE，以 \0\0 结尾）
 * ```
 * 另外兼容 Windows 10 上「目录型」`$I` 的变体：名字长度字段后移 8 字节
 * （偏移 24 变成 8 字节目录大小，名字长度在 32，名字从 36 开始）。
 *
 * 解析失败时返回 `null`；元数据部分损坏时仍尽量返回大小与删除时间，
 * 并把 `original` 置空，让调用方回退到 `$R` 路径。
 */
export function parseRecycleInfo(buffer: Buffer): RecycleInfo | null {
  if (!buffer || buffer.length < 28) return null
  const version = Number(buffer.readBigUInt64LE(0))
  if (!Number.isSafeInteger(version) || version < 0) return null
  const rawSize = Number(buffer.readBigUInt64LE(8))
  const size = Number.isFinite(rawSize) && rawSize > 0 ? rawSize : 0
  const deletedAt = filetimeToUnix(buffer.readBigUInt64LE(16))

  // ① 规范布局
  const primary = decodeOriginal(buffer, 28, buffer.readUInt32LE(24))
  if (isPlausibleOriginal(primary)) return { version, size, deletedAt, original: primary }

  // ② Windows 10 目录型变体
  if (buffer.length >= 36) {
    const shifted = decodeOriginal(buffer, 36, buffer.readUInt32LE(32))
    if (isPlausibleOriginal(shifted)) {
      const directorySize = Number(buffer.readBigUInt64LE(24))
      const realSize = size || (Number.isFinite(directorySize) && directorySize > 0 ? directorySize : 0)
      return { version, size: realSize, deletedAt, original: shifted }
    }
  }

  // ③ 名字字段损坏：保留能解析出来的部分
  return { version, size, deletedAt, original: '' }
}

/* ------------------------------------------------------------------ */
/* 当前用户 SID                                                        */
/* ------------------------------------------------------------------ */

/** `whoami` 结果缓存：一次进程生命周期内 SID 不会变化 */
let currentSidCache: Promise<string | undefined> | undefined

/**
 * 查询当前账户的 SID，用于在 `includeOtherUsers=false` 时只扫描自己的回收站。
 * 查询失败时返回 `undefined`，此时不做过滤（非管理员本来也读不到别人的回收站）。
 */
async function resolveCurrentSid(): Promise<string | undefined> {
  if (!currentSidCache) {
    currentSidCache = (async () => {
      const result = await runCommand('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { timeout: 5_000 })
      if (!result.ok) return undefined
      const match = /S-1-5-\d+(?:-\d+)+/i.exec(result.stdout)
      return match ? match[0].toUpperCase() : undefined
    })()
  }
  const sid = await currentSidCache
  // 解析失败不缓存，下次扫描时重试
  if (!sid) currentSidCache = undefined
  return sid
}

/* ------------------------------------------------------------------ */
/* 清理辖区与文件对定位                                                */
/* ------------------------------------------------------------------ */

/** 判断路径是否位于「某盘符的回收站」内，并推导出配对的 `$I` 路径 */
export function locateRecyclePair(target: string): { infoPath: string } | undefined {
  const path = normalizePath(target)
  const drive = driveOf(path)
  if (!drive) return undefined
  // 只允许操作 X:\$Recycle.Bin\ 下的文件
  if (!isSubPath(`${drive}\\$Recycle.Bin`, path)) return undefined
  const name = basename(path)
  // $R 是数据文件，$I 才是元数据；这里只接受 $R
  if (!/^\$R/i.test(name)) return undefined
  const parent = parentPath(path)
  // 必须是「SID 目录」的直接子项，避免误删更深层的用户数据
  if (!SID_DIR.test(basename(parent))) return undefined
  return { infoPath: `${parent}\\$I${name.slice(2)}` }
}

/** 静默删除 `$I`：失败只记警告（数据已经删掉了，元数据残留不影响空间统计） */
async function unlinkQuietly(target: string, cleanCtx: TaskCleanContext): Promise<void> {
  try {
    await fs.unlink(toLongPath(target))
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return
    cleanCtx.logger.warn('删除 $I 元数据失败：%s（%s）', target, describeDeleteError(error))
  }
}

/**
 * 自定义清理：成对删除 `$R`（数据）与 `$I`（元数据）。
 * 导出出来便于自测脚本用 dryRun 检查安全阀。
 */
export async function cleanRecycleItems(items: CleanItem[], cleanCtx: TaskCleanContext): Promise<CleanItemResult[]> {
  const results: CleanItemResult[] = []
  for (const item of items) {
    if (cleanCtx.signal.aborted) {
      results.push({ itemId: item.id, path: item.path, ok: false, bytes: 0, error: '清理已取消' })
      continue
    }

    // 安全阀 ①：只碰回收站内的 $R/$I 文件对
    const pair = locateRecyclePair(item.path)
    if (!pair) {
      results.push({ itemId: item.id, path: item.path, ok: false, bytes: 0, error: '不是回收站目录内的 $R 文件，已跳过' })
      continue
    }

    // 安全阀 ②：再走一遍内核路径策略（扫描后用户可能改过设置）
    const policy = cleanCtx.pathPolicy.check(item.path)
    if (!policy.allowed) {
      results.push({
        itemId: item.id,
        path: item.path,
        ok: false,
        bytes: 0,
        error: `路径被安全策略拒绝（${policy.reason ?? 'unknown'}）`,
      })
      continue
    }

    // 预演：只统计，不落盘
    if (cleanCtx.dryRun) {
      results.push({ itemId: item.id, path: item.path, ok: true, bytes: item.size })
      continue
    }

    try {
      const stat = await safeLstat(item.path)
      if (!stat) {
        // 数据文件已不存在（例如上次清理被打断）：顺手清掉残留的 $I，按 0 字节计
        await unlinkQuietly(pair.infoPath, cleanCtx)
        results.push({ itemId: item.id, path: item.path, ok: true, bytes: 0 })
        continue
      }
      // 先删 $R：真正的数据；deletePath 内部会处理只读文件并拒绝跟随链接
      const removed = await deletePath(item.path, { retries: 1 })
      await unlinkQuietly(pair.infoPath, cleanCtx)
      results.push({ itemId: item.id, path: item.path, ok: true, bytes: removed.bytes })
    } catch (error) {
      // 单条失败不影响整批：把中文原因交给内核展示
      results.push({
        itemId: item.id,
        path: item.path,
        ok: false,
        bytes: 0,
        error: `删除失败：${describeDeleteError(error)}（文件可能正被占用，或需要管理员权限）`,
      })
    }
  }
  return results
}

/* ------------------------------------------------------------------ */
/* 扫描用到的中间结构                                                  */
/* ------------------------------------------------------------------ */

export interface RecycleRecord {
  /** `$R` 的真实路径（上报给内核的 path） */
  dataPath: string
  size: number
  /** 原始路径（$I 解析失败时退化为 $R 路径） */
  original: string
  deletedAt: number
  drive: string
  sid: string
}

/**
 * 读取一对 `$I`/`$R`；`$R` 不存在时返回 null（孤儿 `$I` 不上报）。
 *
 * 导出这个内部实现是为了让 `scripts/check-recycle.ts` 能在临时目录里
 * 搭一棵假回收站做单元自测，从而完全不触碰系统回收站。
 */
export async function readRecyclePair(
  scan: TaskScanContext,
  sidDir: string,
  infoName: string,
  drive: string,
  sid: string,
): Promise<RecycleRecord | null> {
  const infoPath = `${sidDir}\\${infoName}`
  const dataPath = `${sidDir}\\$R${infoName.slice(2)}`
  const dataStat = await safeLstat(dataPath)
  if (!dataStat) return null

  let info: RecycleInfo | null = null
  try {
    info = parseRecycleInfo(await fs.readFile(toLongPath(infoPath)))
  } catch (error) {
    scan.addError({ path: infoPath, message: `读取 $I 元数据失败，将使用文件实际大小：${errorMessage(error)}` })
  }

  let size = Math.max(0, info?.size ?? 0)
  if (dataStat.isDirectory()) {
    // 目录项：$I 里通常记为 0，递归统计 $R 目录的实际占用
    const measured = await folderSize(dataPath, {
      signal: scan.signal,
      maxEntries: 50_000,
      onError: (target, error) => scan.logger.debug('统计目录大小时跳过 %s：%s', target, errorMessage(error)),
    })
    size = measured.bytes
  } else if (!size) {
    // $I 解析失败或未记录大小：回退到实际文件大小
    size = dataStat.size
  }

  return { dataPath, size, original: info?.original || dataPath, deletedAt: info?.deletedAt ?? 0, drive, sid }
}

/* ------------------------------------------------------------------ */
/* 插件定义                                                            */
/* ------------------------------------------------------------------ */

export default defineCleanerPlugin<RecycleConfig>({
  name: 'recycle',
  version: '1.0.0',
  description: '解析各磁盘回收站（$Recycle.Bin）中的 $I/$R 文件对，还原原始路径后清理',
  inject: ['cleaner', 'pathPolicy', 'system'],
  Config,
  setup(ctx, config) {
    const env = ctx.system.env

    /** 本次要处理的回收站目录（每个固定磁盘一个） */
    const bins = () => env.drives.map((drive) => ({ drive, bin: `${drive}\\$Recycle.Bin` }))

    // 声明清理辖区：只有这些回收站目录下的文件才允许被本插件删除
    ctx.effect(() => {
      const disposers = bins().map((entry) => ctx.pathPolicy.addRoot(entry.bin, 'recycle'))
      return () => disposers.forEach((dispose) => dispose())
    })

    ctx.effect(() =>
      ctx.cleaner.define({
        id: 'recycle',
        name: '回收站',
        description: '清空各磁盘回收站中等待删除的文件，可按原始路径逐项选择',
        category: 'system',
        risk: 'safe',
        icon: '🗑️',
        requiresAdmin: false,
        defaultSelected: true,
        estimatedMs: 1500,
        targets: bins().map((entry) => entry.bin),
        tips: [
          '回收站中的文件删除后无法恢复，请确认勾选项确实不再需要',
          '默认只扫描当前账户的回收站；其它账户的回收站需要管理员权限（可在插件配置中开启 includeOtherUsers）',
        ],
        async scan(scan) {
          // 当前用户 SID：用于在 includeOtherUsers=false 时过滤掉别人的回收站
          const sid = await resolveCurrentSid()
          let emitted = 0

          for (const { drive, bin } of bins()) {
            scan.throwIfAborted()
            if (!(await exists(bin))) continue

            let children: Dirent[]
            try {
              children = await fs.readdir(toLongPath(bin), { withFileTypes: true })
            } catch (error) {
              scan.addError({ path: bin, message: `无法读取回收站目录：${errorMessage(error)}` })
              continue
            }

            for (const child of children) {
              scan.throwIfAborted()
              // 只处理 SID 子目录；回收站根目录下的 desktop.ini 等文件直接忽略
              if (!child.isDirectory() || child.isSymbolicLink() || !SID_DIR.test(child.name)) continue
              if (!config.includeOtherUsers && sid && child.name.toUpperCase() !== sid) continue

              const sidDir = `${bin}\\${child.name}`
              let names: string[]
              try {
                names = await fs.readdir(toLongPath(sidDir))
              } catch (error) {
                const code = errorCode(error)
                // 别人的回收站默认只有管理员可读：非管理员时静默跳过，避免给用户刷错误
                if (config.includeOtherUsers || (code !== 'EPERM' && code !== 'EACCES')) {
                  scan.addError({ path: sidDir, message: `无法读取回收站目录：${errorMessage(error)}`, code })
                }
                continue
              }

              const infoNames = names.filter((name) => /^\$I/i.test(name))
              if (!infoNames.length) continue
              scan.logger.debug('扫描 %s，发现 %d 个 $I 元数据文件', sidDir, infoNames.length)

              // 先按剩余配额截断，避免超大回收站把时间都花在读 $I 上
              const remaining = MAX_ITEMS - emitted
              if (remaining <= 0) {
                scan.addError({ path: bin, message: `回收站项目超过 ${MAX_ITEMS} 项，本次仅上报前 ${MAX_ITEMS} 项` })
                return
              }
              const batch = infoNames.length > remaining ? infoNames.slice(0, remaining) : infoNames
              const records = await mapLimit(batch, READ_CONCURRENCY, (name) =>
                readRecyclePair(scan, sidDir, name, drive, child.name),
              )

              for (const record of records) {
                if (!record) continue
                emitted++
                const draft: CleanItemDraft = {
                  path: record.dataPath,
                  // 标题用原始路径：$Rxxxxxx.bin 对用户没有任何信息量
                  title: record.original,
                  kind: 'file',
                  size: record.size,
                  risk: 'safe',
                  meta: {
                    original: record.original,
                    deletedAt: record.deletedAt || null,
                    drive: record.drive,
                    sid: record.sid,
                  },
                  note: record.deletedAt
                    ? `回收站删除时间：${formatTime(record.deletedAt)}`
                    : '回收站删除时间未知（$I 元数据损坏）',
                }
                scan.emit(draft)
              }
              if (batch.length < infoNames.length) {
                scan.addError({ path: bin, message: `回收站项目超过 ${MAX_ITEMS} 项，本次仅上报前 ${MAX_ITEMS} 项` })
                return
              }
            }
          }
        },
        clean: cleanRecycleItems,
      }),
    )
  },
})
