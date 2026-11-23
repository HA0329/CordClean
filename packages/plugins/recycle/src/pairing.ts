/**
 * 回收站 `$I`/`$R` 配对分析。
 *
 * 内核清理项模型里只有「文件路径」，而回收站的真实语义是**一对**内部维护文件：
 * `$I` 记录原始路径/大小/删除时间，`$R` 才是数据本身。正常项按对处理；
 * 但上次清理中断、第三方工具或磁盘异常会留下三类配对异常：
 *
 * 1. 只有 `$I` 没有 `$R`：数据已丢失，元数据成为孤儿（无法恢复任何数据）；
 * 2. 只有 `$R` 没有 `$I`：数据文件还在，但原始路径/删除时间已不可知；
 * 3. `$I` 损坏：配对仍在，但原始路径或大小解析不出来（仍按 `$R` 清理，但上报为
 *    caution 且默认不勾选——用户看不到原始路径，无法确认内容）。
 *
 * 三类异常一律 risk=caution、defaultSelected=false；孤立残留清理只删孤立
 * 元数据/数据本身，损坏配对的清理成对删除 `$R` 与损坏的 `$I`。
 *
 * 本模块把「名字配对（纯字符串）」「SID 目录读取（少量 lstat/read）」
 * 「按盘统计（纯函数）」和「清理项草稿构造（纯函数）」全部抽出来，
 * 这样可以在临时目录里完整单测，完全不触碰真实回收站
 * （见 `tests/recycle-orphans.test.ts`）。
 */
import { promises as fs } from 'node:fs'
import type { Stats } from 'node:fs'
import { basename, formatBytes, formatTime } from '@cordclean/shared'
import type { CleanItemDraft, TaskLogger } from '@cordclean/shared'
import {
  driveOf,
  errorCode,
  errorMessage,
  folderSize,
  isSubPath,
  mapLimit,
  normalizePath,
  parentPath,
  safeLstat,
  toLongPath,
} from '@cordclean/utils'
import { parseRecycleInfo } from './recycle-info.ts'
import type { RecycleInfo } from './recycle-info.ts'

/** SID 目录名，如 `S-1-5-21-3656000344-499852391-737741175-500` */
const SID_DIR = /^S-1-5(?:-\d+)+$/i

/** 读取 `$I` 的并发度（回收站里通常是一大批小文件） */
export const READ_CONCURRENCY = 8

/** 统计 `$R` 目录大小时最多遍历的条目数（避免单个超大目录拖垮扫描） */
const MAX_DIRECTORY_ENTRIES = 50_000

/* ------------------------------------------------------------------ */
/* 1. 名字配对（纯函数）                                                */
/* ------------------------------------------------------------------ */

/** 是否为 `$I` 元数据文件名（Windows 上实际总是大写，这里不区分大小写） */
export function isRecycleInfoName(name: string): boolean {
  return /^\$I/i.test(name)
}

/** 是否为 `$R` 数据文件名 */
export function isRecycleDataName(name: string): boolean {
  return /^\$R/i.test(name)
}

/** 由 `$I` 名推导配对的 `$R` 名（保留后缀原本的大小写） */
export function dataNameOf(infoName: string): string {
  return `$R${infoName.slice(2)}`
}

/** 由 `$R` 名推导配对的 `$I` 名 */
export function infoNameOf(dataName: string): string {
  return `$I${dataName.slice(2)}`
}

/** 是否为回收站根目录下的 SID 子目录名 */
export function isSidDirectoryName(name: string): boolean {
  return SID_DIR.test(name)
}

/** 一次目录列举的名字分类结果（纯函数产物，不含文件系统信息） */
export interface RecycleNamePairing {
  /** 同时存在 `$I` 与 `$R` 的配对（按 `$I` 名排序，顺序即列举顺序） */
  pairs: Array<{ infoName: string; dataName: string }>
  /** 只有 `$I`、缺 `$R` 的孤立元数据 */
  orphanInfoNames: string[]
  /** 只有 `$R`、缺 `$I` 的孤立数据 */
  orphanDataNames: string[]
  /** 既不是 `$I` 也不是 `$R` 的其它文件（如 desktop.ini），必须忽略 */
  ignoredNames: string[]
}

/**
 * 把目录里的文件名分成「配对 / 孤立 $I / 孤立 $R / 其它」。
 *
 * 配对只用名字后缀比较且不区分大小写：`$Iabc.TXT` 与 `$Rabc.txt` 也是一对
 * （Windows 文件系统不区分大小写，历史工具可能留下大小写不一致的名字）。
 */
export function analyzeRecycleNames(names: readonly string[]): RecycleNamePairing {
  const infoNames: string[] = []
  const dataNames: string[] = []
  const ignoredNames: string[] = []
  for (const raw of names) {
    const name = raw ?? ''
    if (isRecycleInfoName(name)) infoNames.push(name)
    else if (isRecycleDataName(name)) dataNames.push(name)
    else ignoredNames.push(name)
  }

  const dataBySuffix = new Map<string, string>()
  for (const dataName of dataNames) dataBySuffix.set(dataName.slice(2).toUpperCase(), dataName)

  const pairs: RecycleNamePairing['pairs'] = []
  const orphanInfoNames: string[] = []
  const matchedData = new Set<string>()
  for (const infoName of infoNames) {
    const dataName = dataBySuffix.get(infoName.slice(2).toUpperCase())
    if (dataName === undefined) {
      orphanInfoNames.push(infoName)
      continue
    }
    matchedData.add(dataName)
    pairs.push({ infoName, dataName })
  }
  const orphanDataNames = dataNames.filter((dataName) => !matchedData.has(dataName))
  return { pairs, orphanInfoNames, orphanDataNames, ignoredNames }
}

/* ------------------------------------------------------------------ */
/* 2. 文件系统读取：一条 SID 目录                                       */
/* ------------------------------------------------------------------ */

/** 分析上下文：与 `TaskScanContext` 结构兼容，测试可传最小实现 */
export interface RecycleAnalyzeContext {
  signal?: AbortSignal
  logger?: Pick<TaskLogger, 'debug'>
  /** 非致命错误回调（与 `TaskScanContext.addError` 同形） */
  addError?: (error: { path: string; message: string; code?: string }) => void
}

/** 一条正常的 `$I`/`$R` 配对记录（上报给内核的 path 是 `$R`） */
export interface RecycleRecord {
  /** `$I` 元数据路径 */
  infoPath: string
  /** `$R` 数据路径（清理项 path） */
  dataPath: string
  /** 展示用体积：目录按 `$R` 实际占用统计，文件优先取 `$I` 记录 */
  size: number
  /** 原始路径；`$I` 损坏时退化为 `$R` 路径 */
  original: string
  /** 删除时间（Unix 毫秒）；0 表示未知 */
  deletedAt: number
  /**
   * `$I` 是否损坏：读取失败，或文件在但原始路径解析不出来。
   * 损坏的配对仍能按 `$R` 清理，但属于「配对异常」，上报时降为 caution、默认不勾选。
   */
  broken: boolean
  drive: string
  sid: string
}

/** 孤立 `$I` 元数据：有元数据、没有 `$R` 数据文件 */
export interface RecycleOrphanInfo {
  infoPath: string
  /** 原始路径；`$I` 损坏时为空串 */
  original: string
  deletedAt: number
  /** `$I` 读取或解析失败（原始路径/删除时间可能未知） */
  broken: boolean
  drive: string
  sid: string
}

/** 孤立 `$R` 数据文件：有数据、没有 `$I` 元数据（原始路径不可知） */
export interface RecycleOrphanData {
  dataPath: string
  /** 实际占用（目录递归统计） */
  size: number
  isDirectory: boolean
  drive: string
  sid: string
}

export type RecycleOrphan = RecycleOrphanInfo | RecycleOrphanData

/** 单个 SID 目录的分析结果 */
export interface RecycleSidScan {
  pairs: RecycleRecord[]
  /** 只有 `$I` 的孤立残留（含扫描期间 `$R` 消失的项） */
  orphanInfos: RecycleOrphanInfo[]
  /** 只有 `$R` 的孤立残留 */
  orphanDatas: RecycleOrphanData[]
  /** 被忽略的其它文件数量 */
  ignored: number
  /** 限流前该目录的候选总数（配对 + 两类孤立残留） */
  total: number
  /** 是否因为 `limit` 截断 */
  truncated: boolean
}

export interface RecycleSidAnalyzeOptions extends RecycleAnalyzeContext {
  /** 最多产出多少条记录（配对优先，其次孤立 `$I`、最后孤立 `$R`） */
  limit?: number
}

/** 读取 `$I` 并解析；失败时通过 addError 上报并返回 null */
async function readInfoMetadata(
  ctx: RecycleAnalyzeContext,
  infoPath: string,
  failureMessage: (detail: string) => string,
): Promise<RecycleInfo | null> {
  try {
    return parseRecycleInfo(await fs.readFile(toLongPath(infoPath)))
  } catch (error) {
    ctx.addError?.({ path: infoPath, message: failureMessage(errorMessage(error)), code: errorCode(error) })
    return null
  }
}

/** 统计一个 `$R` 目标（文件或目录）的展示体积 */
async function measureDataSize(
  dataPath: string,
  dataStat: Stats,
  recordedSize: number,
  ctx: RecycleAnalyzeContext,
): Promise<number> {
  if (dataStat.isDirectory()) {
    const measured = await folderSize(dataPath, {
      signal: ctx.signal,
      maxEntries: MAX_DIRECTORY_ENTRIES,
      onError: (target, error) => ctx.logger?.debug('统计目录大小时跳过 %s：%s', target, errorMessage(error)),
    })
    return measured.bytes
  }
  return recordedSize > 0 ? recordedSize : dataStat.size
}

function emptySidScan(total = 0, truncated = false): RecycleSidScan {
  return { pairs: [], orphanInfos: [], orphanDatas: [], ignored: 0, total, truncated }
}

/**
 * 读取一个 SID 目录下的全部 `$I`/`$R`，分类成正常配对与两类孤立残留。
 *
 * @param names `fs.readdir` 的结果；由调用方提供，便于统一处理权限错误，
 *              也让单测可以精确控制「目录里有哪些名字」。
 */
export async function analyzeRecycleSidDirectory(
  sidDir: string,
  drive: string,
  sid: string,
  names: readonly string[],
  options: RecycleSidAnalyzeOptions = {},
): Promise<RecycleSidScan> {
  const pairing = analyzeRecycleNames(names)
  const total = pairing.pairs.length + pairing.orphanInfoNames.length + pairing.orphanDataNames.length

  let pairsToRead = pairing.pairs
  let orphanInfosToRead = pairing.orphanInfoNames
  let orphanDatasToRead = pairing.orphanDataNames
  let truncated = false
  if (typeof options.limit === 'number' && total > options.limit) {
    truncated = true
    const limit = Math.max(0, Math.trunc(options.limit))
    pairsToRead = pairing.pairs.slice(0, limit)
    const afterPairs = limit - pairsToRead.length
    orphanInfosToRead = pairing.orphanInfoNames.slice(0, afterPairs)
    const afterInfos = afterPairs - orphanInfosToRead.length
    orphanDatasToRead = pairing.orphanDataNames.slice(0, afterInfos)
  }

  // ① 正常配对：读 $I 元数据 + 统计 $R 体积；$R 在列举与读取之间消失时降级为孤立 $I
  const pairResults = await mapLimit(pairsToRead, READ_CONCURRENCY, async (pair) => {
    const infoPath = `${sidDir}\\${pair.infoName}`
    const dataPath = `${sidDir}\\${pair.dataName}`
    const info = await readInfoMetadata(
      options,
      infoPath,
      (detail) => `读取 $I 元数据失败，将使用文件实际大小：${detail}`,
    )
    const dataStat = await safeLstat(dataPath)
    // 原始路径解析失败（parseRecycleInfo 返回空串）同样视为 $I 损坏：没有原始路径就无法展示/核对
    const broken = info === null || !info.original
    if (!dataStat) {
      return {
        orphanInfo: {
          infoPath,
          original: info?.original ?? '',
          deletedAt: info?.deletedAt ?? 0,
          broken,
          drive,
          sid,
        } satisfies RecycleOrphanInfo,
      }
    }
    const size = await measureDataSize(dataPath, dataStat, info?.size ?? 0, options)
    return {
      pair: {
        infoPath,
        dataPath,
        size,
        original: info?.original || dataPath,
        deletedAt: info?.deletedAt ?? 0,
        broken,
        drive,
        sid,
      } satisfies RecycleRecord,
    }
  })

  // ② 孤立 $I：只需要读元数据用于展示，体积记为 0（没有数据可释放）
  const orphanInfoResults = await mapLimit(orphanInfosToRead, READ_CONCURRENCY, async (infoName) => {
    const infoPath = `${sidDir}\\${infoName}`
    const info = await readInfoMetadata(
      options,
      infoPath,
      (detail) => `读取孤立 $I 元数据失败，原始路径与删除时间未知：${detail}`,
    )
    return {
      infoPath,
      original: info?.original ?? '',
      deletedAt: info?.deletedAt ?? 0,
      broken: info === null || !info.original,
      drive,
      sid,
    } satisfies RecycleOrphanInfo
  })

  // ③ 孤立 $R：直接按实际体积上报，原始路径不可知
  const orphanDataResults = await mapLimit(orphanDatasToRead, READ_CONCURRENCY, async (dataName) => {
    const dataPath = `${sidDir}\\${dataName}`
    const dataStat = await safeLstat(dataPath)
    if (!dataStat) return undefined // 列举之后被外部删除：本次忽略
    const size = await measureDataSize(dataPath, dataStat, 0, options)
    return {
      dataPath,
      size,
      isDirectory: dataStat.isDirectory(),
      drive,
      sid,
    } satisfies RecycleOrphanData
  })

  const scan = emptySidScan(total, truncated)
  scan.ignored = pairing.ignoredNames.length
  for (const result of pairResults) {
    if (result.pair) scan.pairs.push(result.pair)
    if (result.orphanInfo) scan.orphanInfos.push(result.orphanInfo)
  }
  scan.orphanInfos.push(...orphanInfoResults)
  for (const result of orphanDataResults) if (result) scan.orphanDatas.push(result)
  return scan
}

/**
 * 读取一对 `$I`/`$R`；`$R` 不存在时返回 null。
 *
 * 保留这个入口是为了兼容 `scripts/check-recycle.ts` 的历史自测（它只关心正常配对）。
 * 需要同时发现孤立残留时请用 {@link analyzeRecycleSidDirectory}。
 */
export async function readRecyclePair(
  ctx: RecycleAnalyzeContext,
  sidDir: string,
  infoName: string,
  drive: string,
  sid: string,
): Promise<RecycleRecord | null> {
  const infoPath = `${sidDir}\\${infoName}`
  const dataPath = `${sidDir}\\${dataNameOf(infoName)}`
  const dataStat = await safeLstat(dataPath)
  if (!dataStat) return null
  const info = await readInfoMetadata(
    ctx,
    infoPath,
    (detail) => `读取 $I 元数据失败，将使用文件实际大小：${detail}`,
  )
  const size = await measureDataSize(dataPath, dataStat, info?.size ?? 0, ctx)
  return {
    infoPath,
    dataPath,
    size,
    original: info?.original || dataPath,
    deletedAt: info?.deletedAt ?? 0,
    broken: info === null || !info.original,
    drive,
    sid,
  }
}

/* ------------------------------------------------------------------ */
/* 3. 清理辖区定位（安全阀）：只认 $Recycle.Bin\<SID>\$I* / $R*          */
/* ------------------------------------------------------------------ */

/** 一个 `$Recycle.Bin` 内的维护文件位置 */
export interface RecycleEntryLocation {
  /** 规范化后的目标路径 */
  path: string
  /** 目标文件名（$I* / $R*） */
  name: string
  /** 所在 SID 目录 */
  parent: string
  drive: string
  /** `info` = $I 元数据，`data` = $R 数据 */
  role: 'info' | 'data'
  /** 配对文件路径（$I ↔ $R） */
  pairPath: string
}

/**
 * 定位清理目标：只接受 `X:\$Recycle.Bin\<SID>\$I*` 或 `$R*` 直接子项。
 *
 * 任何更深层级（SID 目录的孙级）、回收站根目录、其它盘符路径都会被拒绝，
 * 避免插件在「自定义 clean」里被构造路径带偏。
 */
export function locateRecycleEntry(target: string): RecycleEntryLocation | undefined {
  const path = normalizePath(target)
  const drive = driveOf(path)
  if (!drive) return undefined
  if (!isSubPath(`${drive}\\$Recycle.Bin`, path)) return undefined
  const name = basename(path)
  const isInfo = isRecycleInfoName(name)
  const isData = isRecycleDataName(name)
  if (!isInfo && !isData) return undefined
  const parent = parentPath(path)
  if (!isSidDirectoryName(basename(parent))) return undefined
  return {
    path,
    name,
    parent,
    drive,
    role: isInfo ? 'info' : 'data',
    pairPath: `${parent}\\${isInfo ? dataNameOf(name) : infoNameOf(name)}`,
  }
}

/** 兼容旧入口：只接受 `$R`（正常配对项），返回配对的 `$I` 路径 */
export function locateRecyclePair(target: string): { infoPath: string } | undefined {
  const entry = locateRecycleEntry(target)
  if (!entry || entry.role !== 'data') return undefined
  return { infoPath: entry.pairPath }
}

/* ------------------------------------------------------------------ */
/* 4. 清理项草稿构造（纯函数）                                          */
/* ------------------------------------------------------------------ */

/**
 * 正常配对项：安全、体积来自 `$I`/`$R` 实际统计。
 *
 * `$I` 损坏（读取失败或原始路径解析失败）的配对属于「配对异常」：虽然 `$R` 数据
 * 还在、仍能清理，但用户看不到原始路径/删除时间，无法确认这是不是自己要删的文件，
 * 因此降为 **caution 且默认不勾选**；清理时成对删除 `$R`（数据）与 `$I`（元数据）。
 */
export function recyclePairToDraft(record: RecycleRecord): CleanItemDraft {
  if (record.broken) {
    return {
      path: record.dataPath,
      title: `配对异常（$I 损坏）：${basename(record.dataPath)}`,
      kind: 'file',
      size: record.size,
      risk: 'caution',
      defaultSelected: false,
      meta: {
        original: record.original,
        deletedAt: record.deletedAt || null,
        drive: record.drive,
        sid: record.sid,
        broken: true,
      },
      note: '回收站配对异常：$I 元数据损坏/无法解析，原始路径不可用（删除时间可能不可靠），清理会删除该 $R 数据文件及其 $I 元数据',
    }
  }
  return {
    path: record.dataPath,
    title: record.original,
    kind: 'file',
    size: record.size,
    risk: 'safe',
    meta: {
      original: record.original,
      deletedAt: record.deletedAt || null,
      drive: record.drive,
      sid: record.sid,
      broken: false,
    },
    note: record.deletedAt
      ? `回收站删除时间：${formatTime(record.deletedAt)}`
      : '回收站删除时间未知（$I 元数据损坏）',
  }
}

/** 判断孤立残留记录是否为「孤立 $I 元数据」 */
export function isOrphanInfo(record: RecycleOrphan): record is RecycleOrphanInfo {
  return 'infoPath' in record
}

/**
 * 孤立残留项：**谨慎（caution）且绝不默认勾选**。
 *
 * 孤立残留没有可恢复的用户数据（$I 没有数据、$R 没有原始路径），清理只释放
 * 极少量内部维护空间，属于「回收站配对异常」的修复动作。风险等级保守定为
 * caution，并且必须由用户显式勾选，避免「一键清理」在用户不知情时动内部结构。
 */
export function recycleOrphanToDraft(record: RecycleOrphan): CleanItemDraft {
  if (isOrphanInfo(record)) {
    return {
      path: record.infoPath,
      title: record.original
        ? `孤立元数据：${record.original}`
        : `孤立元数据：${basename(record.infoPath)}（$I 损坏）`,
      kind: 'file',
      size: 0,
      risk: 'caution',
      defaultSelected: false,
      meta: {
        original: record.original || record.infoPath,
        deletedAt: record.deletedAt || null,
        drive: record.drive,
        sid: record.sid,
        orphan: 'info',
        broken: record.broken,
      },
      note: record.broken
        ? '回收站配对异常：只有 $I 元数据且已损坏（没有对应的 $R 数据文件），可安全删除'
        : '回收站配对异常：只有 $I 元数据、没有对应的 $R 数据文件（多为上次清理中断残留），可安全删除',
    }
  }
  return {
    path: record.dataPath,
    title: `孤立数据：${basename(record.dataPath)}`,
    kind: record.isDirectory ? 'directory' : 'file',
    size: record.size,
    risk: 'caution',
    defaultSelected: false,
    meta: {
      original: record.dataPath,
      deletedAt: null,
      drive: record.drive,
      sid: record.sid,
      orphan: 'data',
      broken: false,
    },
    note: '回收站配对异常：只有 $R 数据文件、没有对应的 $I 元数据，无法还原原始路径（孤立残留），可安全删除',
  }
}

/* ------------------------------------------------------------------ */
/* 5. 按盘统计（纯函数）                                                */
/* ------------------------------------------------------------------ */

/** 参与按盘统计的单条记录 */
export interface RecycleStatItem {
  drive: string
  size: number
  /** 是否为孤立残留项（配对正常项为 false/省略） */
  orphan?: boolean
}

/** 单块磁盘的回收站统计 */
export interface RecycleDriveStat {
  drive: string
  /** 可清理项数（含孤立残留） */
  items: number
  /** 可清理体积（含孤立残留） */
  bytes: number
  /** 其中正常配对项数 */
  pairs: number
  /** 其中孤立残留项数 */
  orphans: number
  /** 孤立残留体积（$I 孤儿的体积恒为 0） */
  orphanBytes: number
}

/**
 * 按盘汇总可清理项数与体积。
 *
 * `drives` 用来补齐「回收站存在但没有任何可清理项」的磁盘，让日志能如实显示
 * `C: 0 项 / 0 B`，而不是让用户误以为该盘没被扫描。
 */
export function summarizeRecycleByDrive(
  items: readonly RecycleStatItem[],
  drives: readonly string[] = [],
): RecycleDriveStat[] {
  const stats = new Map<string, RecycleDriveStat>()
  const ensure = (drive: string): RecycleDriveStat => {
    const key = (drive || '?').toUpperCase()
    let stat = stats.get(key)
    if (!stat) {
      stat = { drive: key, items: 0, bytes: 0, pairs: 0, orphans: 0, orphanBytes: 0 }
      stats.set(key, stat)
    }
    return stat
  }
  for (const drive of drives) ensure(drive)
  for (const item of items) {
    const stat = ensure(item.drive)
    const size = Math.max(0, Number(item.size) || 0)
    stat.items++
    stat.bytes += size
    if (item.orphan) {
      stat.orphans++
      stat.orphanBytes += size
    } else {
      stat.pairs++
    }
  }
  return [...stats.values()].sort((left, right) => left.drive.localeCompare(right.drive))
}

/** 把按盘统计格式化成一行日志：`C: 3 项 / 1.2 MB（其中孤立残留 1 项 / 0 B）；D: 0 项 / 0 B` */
export function formatRecycleDriveStats(stats: readonly RecycleDriveStat[]): string {
  if (!stats.length) return '无'
  return stats
    .map((stat) => {
      const orphan = stat.orphans > 0 ? `（其中孤立残留 ${stat.orphans} 项 / ${formatBytes(stat.orphanBytes)}）` : ''
      return `${stat.drive} ${stat.items} 项 / ${formatBytes(stat.bytes)}${orphan}`
    })
    .join('；')
}
