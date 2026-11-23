/**
 * recycle 插件「$I/$R 配对异常」单测（临时目录构造，完全不触碰真实回收站）。
 *
 * 覆盖：
 * 1. `$I` 二进制解析（v1 / v2 / Win10 目录变体 / 截断 / 名字损坏 / FILETIME）；
 * 2. 纯字符串配对：正常对、孤立 `$I`、孤立 `$R`、大小写不一致、忽略其它文件；
 * 3. 临时目录里的 `$Recycle.Bin\<SID>`：正常对 / 孤立 `$I` / 孤立 `$R`（文件与目录）/
 *    `$I` 损坏（含读取失败）/ 多 SID / 多盘 / 限流截断 / 列举后消失；
 * 4. 清理项草稿：三类配对异常一律 risk=caution、defaultSelected=false；
 * 5. `cleanRecycleItems`：只经 `deleteInternal(..., 'recycle-bin')` 删除、失败带原因、
 *    安全阀（缺扫描标记 / 标记类型不一致 / 越界路径 / 路径策略拒绝）与 dryRun。
 *
 * 说明：清理用例里用不存在的假盘符 `R:` 构造路径（不会真实落盘），
 * 仅通过 mock `safeLstat` 注入「文件存在」的假 stat 来走完删除分支；
 * 其余情况下真实 `safeLstat` 对假盘符返回 null，不产生任何文件系统副作用。
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CleanItem,
  CleanItemDraft,
  CleanItemResult,
  PathPolicyLike,
  TaskCleanContext,
  TaskLogger,
} from '@cordclean/shared'
import {
  analyzeRecycleNames,
  analyzeRecycleSidDirectory,
  cleanRecycleItems,
  dataNameOf,
  formatRecycleDriveStats,
  infoNameOf,
  isRecycleDataName,
  isRecycleInfoName,
  isSidDirectoryName,
  locateRecycleEntry,
  locateRecyclePair,
  parseRecycleInfo,
  readRecyclePair,
  recycleOrphanToDraft,
  recyclePairToDraft,
  summarizeRecycleByDrive,
} from '@cordclean/plugin-recycle'
import type { RecycleOrphanData, RecycleOrphanInfo, RecycleRecord } from '@cordclean/plugin-recycle'

/* ------------------------------------------------------------------ */
/* mock：只给指定假路径返回「文件存在」的 stat，其余委托真实实现        */
/* ------------------------------------------------------------------ */

const fakeStatPaths = vi.hoisted(() => new Set<string>())
vi.mock('@cordclean/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cordclean/utils')>()
  return {
    ...actual,
    safeLstat: async (target: string) => {
      if (fakeStatPaths.has(target.toLowerCase())) {
        // 清理分支只关心「是否存在 / 是否目录」，这里给最小 Stats 替身
        return { size: 4096, isDirectory: () => false, isFile: () => true } as unknown as Awaited<
          ReturnType<typeof actual.safeLstat>
        >
      }
      return actual.safeLstat(target)
    },
  }
})

/* ------------------------------------------------------------------ */
/* 测试常量与 `$I` 构造器                                              */
/* ------------------------------------------------------------------ */

const SID_CURRENT = 'S-1-5-21-3656000344-499852391-737741175-500'
const SID_OTHER = 'S-1-5-21-3656000344-499852391-737741175-1001'
const DELETED_AT = Date.UTC(2026, 2, 15, 2, 30, 0)

/** Unix 毫秒 → FILETIME（100ns，自 1601 起） */
function toFiletime(ms: number): bigint {
  return BigInt(ms + 11_644_473_600_000) * 10_000n
}

interface InfoOptions {
  version?: number
  size?: number
  deletedAt?: number
  /** 覆盖偏移 24 的名字长度字段（用于制造损坏） */
  nameLength?: number
}

/** 构造一个规范布局的 `$I` 缓冲区（名字长度在偏移 24，名字从 28 开始） */
function buildInfo(original: string, options: InfoOptions = {}): Buffer {
  const chars = original.length + 1 // 含结尾 \0
  const buffer = Buffer.alloc(28 + chars * 2)
  buffer.writeBigUInt64LE(BigInt(options.version ?? 2), 0)
  buffer.writeBigUInt64LE(BigInt(options.size ?? 1024), 8)
  buffer.writeBigUInt64LE(toFiletime(options.deletedAt ?? DELETED_AT), 16)
  buffer.writeUInt32LE(options.nameLength ?? chars, 24)
  buffer.write(original + '\u0000', 28, 'utf16le')
  return buffer
}

/** 构造 Windows 10「目录型」`$I`：偏移 24 为 8 字节目录大小，名字长度在 32，名字从 36 开始 */
function buildDirectoryInfo(original: string, directorySize: number, deletedAt = DELETED_AT): Buffer {
  const chars = original.length + 1
  const buffer = Buffer.alloc(36 + chars * 2)
  buffer.writeBigUInt64LE(2n, 0)
  buffer.writeBigUInt64LE(0n, 8)
  buffer.writeBigUInt64LE(toFiletime(deletedAt), 16)
  buffer.writeBigUInt64LE(BigInt(directorySize), 24)
  buffer.writeUInt32LE(chars, 32)
  buffer.write(original + '\u0000', 36, 'utf16le')
  return buffer
}

/** 构造一个「名字区损坏」的 `$I`：头部字段仍可读，但原始路径解析不出来 */
function buildDamagedInfo(options: { size?: number; deletedAt?: number } = {}): Buffer {
  const buffer = Buffer.from(buildInfo('C:\\Temp\\原始路径.tmp', options))
  // 用控制字符 + 非绝对路径垃圾覆盖名字区：isPlausibleOriginal 必须判 false
  buffer.write('\u0001\u0002NOT-A-PATH', 28, 'utf16le')
  return buffer
}

/* ------------------------------------------------------------------ */
/* 临时目录夹具                                                        */
/* ------------------------------------------------------------------ */

let root: string
let sidC: string
let sidOther: string
let sidD: string
const VOL_C = 'vol-c'
const VOL_D = 'vol-d'

async function writeFileAt(target: string, content: Buffer | string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content)
}

/** 在临时目录里搭 `<vol>/$Recycle.Bin/<sid>`，返回 SID 目录绝对路径 */
async function makeSidDir(volume: string, sid: string): Promise<string> {
  const dir = path.join(root, volume, '$Recycle.Bin', sid)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/** 读取 SID 目录里的名字（与插件 scan 里 `fs.readdir` 的输入一致） */
async function namesOf(sidDir: string): Promise<string[]> {
  return (await fs.readdir(sidDir)).sort()
}

function infoNameOfPath(recordPath: string): string {
  return path.basename(recordPath).toUpperCase()
}

const byInfoName = (scan: { pairs: RecycleRecord[] }, name: string): RecycleRecord => {
  const record = scan.pairs.find((pair) => infoNameOfPath(pair.infoPath) === name.toUpperCase())
  expect(record, `缺少配对记录：${name}`).toBeTruthy()
  return record!
}

const byDataName = (scan: { orphanDatas: RecycleOrphanData[] }, name: string): RecycleOrphanData => {
  const record = scan.orphanDatas.find((orphan) => infoNameOfPath(orphan.dataPath) === name.toUpperCase())
  expect(record, `缺少孤立数据记录：${name}`).toBeTruthy()
  return record!
}

/* ------------------------------------------------------------------ */
/* 一、`$I` 二进制解析（纯函数）                                        */
/* ------------------------------------------------------------------ */

describe('parseRecycleInfo：$I 元数据解析', () => {
  it('解析 v2 规范布局：版本 / 原始大小 / 删除时间 / 原始路径', () => {
    const parsed = parseRecycleInfo(buildInfo('C:\\Users\\小明\\Documents\\毕业论文.docx', { size: 2_457_600 }))
    expect(parsed).toEqual({
      version: 2,
      size: 2_457_600,
      deletedAt: DELETED_AT,
      original: 'C:\\Users\\小明\\Documents\\毕业论文.docx',
    })
  })

  it('解析 v1 版本（Vista~8.1）布局', () => {
    const parsed = parseRecycleInfo(buildInfo('D:\\桌面\\作业.sql', { version: 1, size: 417_227 }))
    expect(parsed).toMatchObject({ version: 1, size: 417_227, original: 'D:\\桌面\\作业.sql' })
  })

  it('解析 Windows 10 目录型变体（名字后移 8 字节，大小取偏移 24）', () => {
    const parsed = parseRecycleInfo(buildDirectoryInfo('D:\\桌面\\旧项目', 8_388_608))
    expect(parsed).toMatchObject({
      original: 'D:\\桌面\\旧项目',
      size: 8_388_608,
      deletedAt: DELETED_AT,
    })
  })

  it('过短缓冲区返回 null；FILETIME 0 表示删除时间未知', () => {
    expect(parseRecycleInfo(Buffer.alloc(10))).toBeNull()
    expect(parseRecycleInfo(buildInfo('C:\\a.txt', { deletedAt: 0 }))?.deletedAt).toBe(0)
  })

  it('名字区损坏时仍返回大小/删除时间，但 original 为空串（调用方回退到 $R）', () => {
    const parsed = parseRecycleInfo(buildDamagedInfo({ size: 1024 }))
    expect(parsed).not.toBeNull()
    expect(parsed).toMatchObject({ size: 1024, deletedAt: DELETED_AT, original: '' })
  })

  it('名字长度字段声明超过剩余字节时不越界读取，按可用字符降级', () => {
    const parsed = parseRecycleInfo(buildInfo('C:\\短路径.txt', { nameLength: 0xffff_ffff }))
    // 声明的长度不可信，但完整名字仍在缓冲区里：仍能解析出来
    expect(parsed?.original).toBe('C:\\短路径.txt')
  })
})

/* ------------------------------------------------------------------ */
/* 二、名字配对与辖区定位（纯函数）                                    */
/* ------------------------------------------------------------------ */

describe('analyzeRecycleNames：名字分类', () => {
  it('区分正常对 / 孤立 $I / 孤立 $R / 其它文件', () => {
    expect(analyzeRecycleNames(['$Iabc.txt', '$Rabc.txt', '$Idef.tmp', '$Rghi.bin', 'desktop.ini'])).toEqual({
      pairs: [{ infoName: '$Iabc.txt', dataName: '$Rabc.txt' }],
      orphanInfoNames: ['$Idef.tmp'],
      orphanDataNames: ['$Rghi.bin'],
      ignoredNames: ['desktop.ini'],
    })
  })

  it('配对不区分大小写，但保留原文件名用于后续读取', () => {
    const pairing = analyzeRecycleNames(['$Igggggg.LOG', '$RGGGGGG.log'])
    expect(pairing.pairs).toEqual([{ infoName: '$Igggggg.LOG', dataName: '$RGGGGGG.log' }])
    expect(pairing.orphanInfoNames).toEqual([])
    expect(pairing.orphanDataNames).toEqual([])
  })

  it('前缀判断 / 名字互换 / SID 目录名判定', () => {
    expect(isRecycleInfoName('$IAAAAAA.TXT')).toBe(true)
    expect(isRecycleInfoName('$RAAAAAA.TXT')).toBe(false)
    expect(isRecycleDataName('$rAAAAAA.TXT')).toBe(true)
    expect(dataNameOf('$IAAAAAA.TXT')).toBe('$RAAAAAA.TXT')
    expect(infoNameOf('$RAAAAAA.TXT')).toBe('$IAAAAAA.TXT')
    expect(isSidDirectoryName(SID_CURRENT)).toBe(true)
    expect(isSidDirectoryName(SID_OTHER)).toBe(true)
    expect(isSidDirectoryName('desktop.ini')).toBe(false)
    expect(isSidDirectoryName('S-1-5')).toBe(false)
  })
})

describe('locateRecycleEntry：清理辖区安全阀', () => {
  it('只接受 X:\\$Recycle.Bin\\<SID>\\$I* / $R* 直接子项', () => {
    expect(locateRecycleEntry('C:\\$Recycle.Bin\\S-1-5-21-1-2-3-500\\$Rabc.txt')).toEqual({
      path: 'C:\\$Recycle.Bin\\S-1-5-21-1-2-3-500\\$Rabc.txt',
      name: '$Rabc.txt',
      parent: 'C:\\$Recycle.Bin\\S-1-5-21-1-2-3-500',
      drive: 'C:',
      role: 'data',
      pairPath: 'C:\\$Recycle.Bin\\S-1-5-21-1-2-3-500\\$Iabc.txt',
    })
    expect(locateRecycleEntry('D:\\$Recycle.Bin\\S-1-5-21-1-2-3-1001\\$Iabc')).toMatchObject({
      role: 'info',
      pairPath: 'D:\\$Recycle.Bin\\S-1-5-21-1-2-3-1001\\$Rabc',
    })
    expect(locateRecyclePair('C:\\$Recycle.Bin\\S-1-5-21-1-2-3-500\\$Rabc.txt')).toEqual({
      infoPath: 'C:\\$Recycle.Bin\\S-1-5-21-1-2-3-500\\$Iabc.txt',
    })
  })

  it('拒绝回收站外的路径、缺少 SID 目录、孙级路径与非 $I/$R 文件', () => {
    expect(locateRecycleEntry('C:\\Windows\\System32\\drivers\\etc\\hosts')).toBeUndefined()
    expect(locateRecycleEntry('C:\\$Recycle.Bin\\$Rabc.txt')).toBeUndefined()
    expect(locateRecycleEntry('C:\\$Recycle.Bin\\S-1-5-21-1-2-3-500\\nested\\$Rabc.txt')).toBeUndefined()
    expect(locateRecycleEntry('C:\\$Recycle.Bin\\S-1-5-21-1-2-3-500\\desktop.ini')).toBeUndefined()
    expect(locateRecycleEntry('C:\\Temp\\$Rabc.txt')).toBeUndefined()
    expect(locateRecyclePair('C:\\$Recycle.Bin\\S-1-5-21-1-2-3-500\\$Iabc.txt')).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ */
/* 三、临时目录：配对 / 孤立检测                                       */
/* ------------------------------------------------------------------ */

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cordclean-recycle-orphans-'))
  sidC = await makeSidDir(VOL_C, SID_CURRENT)
  sidOther = await makeSidDir(VOL_C, SID_OTHER)
  sidD = await makeSidDir(VOL_D, SID_CURRENT)

  // ① 正常对：$I 记录 4096，$R 实际只有 3000 → 展示大小以 $I 为准
  await writeFileAt(path.join(sidC, '$IAAAAAA.txt'), buildInfo('C:\\Users\\测试\\文档.txt', { size: 4096 }))
  await writeFileAt(path.join(sidC, '$RAAAAAA.txt'), Buffer.alloc(3000, 1))
  // ② $I 损坏（名字区坏掉）但 $R 还在 → 配对异常（caution），仍可清理
  await writeFileAt(path.join(sidC, '$IBBBBBB.log'), buildDamagedInfo({ size: 512 }))
  await writeFileAt(path.join(sidC, '$RBBBBBB.log'), Buffer.alloc(700, 2))
  // ③ 孤立 $I：有元数据、没有 $R（数据已不可恢复）
  await writeFileAt(path.join(sidC, '$ICCCCCC.tmp'), buildInfo('C:\\Temp\\孤立元数据.tmp', { size: 512 }))
  // ④ 孤立 $R 文件：有数据、没有 $I
  await writeFileAt(path.join(sidC, '$RDDDDDD.bin'), Buffer.alloc(1234, 3))
  // ⑤ 孤立 $R 目录：体积按目录递归统计
  await writeFileAt(path.join(sidC, '$REEEEEE', 'a.txt'), Buffer.alloc(100, 4))
  await writeFileAt(path.join(sidC, '$REEEEEE', 'b.txt'), Buffer.alloc(250, 5))
  // ⑥ 孤立且损坏的 $I：缓冲区过短，parseRecycleInfo 返回 null
  await writeFileAt(path.join(sidC, '$IFFFFFF.old'), Buffer.alloc(20, 6))
  // ⑦ 大小写不一致的配对（Windows 文件系统不区分大小写）
  await writeFileAt(path.join(sidC, '$Igggggg.LOG'), buildInfo('C:\\Temp\\大小写.log', { size: 256 }))
  await writeFileAt(path.join(sidC, '$RGGGGGG.log'), Buffer.alloc(128, 7))
  // ⑧ 必须忽略的其它文件
  await writeFileAt(path.join(sidC, 'desktop.ini'), '[.ShellClassInfo]\r\n')
  // ⑨ 另一个 SID 下只有一个孤立 $R
  await writeFileAt(path.join(sidOther, '$Rhhhhhh.dat'), Buffer.alloc(64, 8))
  // ⑩ 另一个盘（D:）上的正常对
  await writeFileAt(path.join(sidD, '$Iiiiiii.iso'), buildInfo('D:\\镜像\\安装.iso', { size: 2048 }))
  await writeFileAt(path.join(sidD, '$Riiiiii.iso'), Buffer.alloc(4096, 9))
})

describe('analyzeRecycleSidDirectory：临时目录构造的 $Recycle.Bin 结构', () => {
  it('回收站根目录只认 SID 子目录（其它文件直接忽略）', async () => {
    // 回收站根目录下只认 SID 目录（desktop.ini 之类直接忽略）
    const binChildren = await fs.readdir(path.join(root, VOL_C, '$Recycle.Bin'), { withFileTypes: true })
    const sidDirs = binChildren
      .filter((entry) => entry.isDirectory() && isSidDirectoryName(entry.name))
      .map((entry) => entry.name)
      .sort()
    expect(sidDirs).toEqual([SID_CURRENT, SID_OTHER].sort())
  })

  it('正常对 / 孤立 $I / 孤立 $R / 损坏 $I / 忽略文件 分类正确', async () => {
    const scan = await analyzeRecycleSidDirectory(sidC, 'C:', SID_CURRENT, await namesOf(sidC))
    expect(scan.pairs).toHaveLength(3)
    expect(scan.orphanInfos).toHaveLength(2)
    expect(scan.orphanDatas).toHaveLength(2)
    expect(scan.ignored).toBe(1) // desktop.ini
    expect(scan.total).toBe(7)
    expect(scan.truncated).toBe(false)

    // 正常对：大小优先取 $I 记录，路径/时间/SID 齐全
    const pairA = byInfoName(scan, '$IAAAAAA.txt')
    expect(pairA).toMatchObject({
      infoPath: path.join(sidC, '$IAAAAAA.txt'),
      dataPath: path.join(sidC, '$RAAAAAA.txt'),
      size: 4096,
      original: 'C:\\Users\\测试\\文档.txt',
      deletedAt: DELETED_AT,
      broken: false,
      drive: 'C:',
      sid: SID_CURRENT,
    })

    // $I 损坏的配对：broken=true，仍按 $R 找到数据；草稿降为 caution 且默认不勾选
    const pairB = byInfoName(scan, '$IBBBBBB.log')
    expect(pairB.broken).toBe(true)
    expect(pairB.original).toBe(pairB.dataPath) // 原始路径不可知，回退到 $R 路径
    expect(pairB.size).toBe(512) // $I 的 size 字段仍可读
    const brokenDraft = recyclePairToDraft(pairB)
    expect(brokenDraft).toMatchObject({ path: pairB.dataPath, risk: 'caution', defaultSelected: false })
    expect(brokenDraft.title).toContain('$I 损坏')
    expect(brokenDraft.note).toContain('$I 元数据损坏')
    expect(brokenDraft.meta).toMatchObject({ broken: true })

    // 正常配对的草稿仍是 safe（默认勾选由内核按任务默认值决定）
    const normalDraft = recyclePairToDraft(pairA)
    expect(normalDraft.risk).toBe('safe')
    expect(normalDraft.defaultSelected).not.toBe(false)
    expect(normalDraft.meta).toMatchObject({ original: 'C:\\Users\\测试\\文档.txt', broken: false })

    // 大小写不一致的名字也能配对成功
    expect(byInfoName(scan, '$Igggggg.LOG').dataPath).toBe(path.join(sidC, '$RGGGGGG.log'))

    // 孤立 $I（正常元数据）：original 可读，broken=false
    const orphanInfo = scan.orphanInfos.find((record) => record.infoPath.endsWith('$ICCCCCC.tmp'))
    expect(orphanInfo).toMatchObject({
      original: 'C:\\Temp\\孤立元数据.tmp',
      deletedAt: DELETED_AT,
      broken: false,
      drive: 'C:',
      sid: SID_CURRENT,
    })
    // 孤立 $I（损坏）：文件名/元数据不可解析，broken=true
    const brokenOrphan = scan.orphanInfos.find((record) => record.infoPath.endsWith('$IFFFFFF.old'))
    expect(brokenOrphan).toMatchObject({ original: '', broken: true })

    // 孤立 $R 文件：按实际大小上报
    expect(byDataName(scan, '$RDDDDDD.bin')).toMatchObject({ size: 1234, isDirectory: false })
    // 孤立 $R 目录：递归统计，isDirectory=true
    expect(byDataName(scan, '$REEEEEE')).toMatchObject({ size: 350, isDirectory: true })
  })

  it('孤立残留草稿：risk=caution、defaultSelected=false、带 orphan/broken 标记', async () => {
    const scan = await analyzeRecycleSidDirectory(sidC, 'C:', SID_CURRENT, await namesOf(sidC))
    const orphanInfo = scan.orphanInfos.find((record) => record.infoPath.endsWith('$ICCCCCC.tmp'))!
    const brokenOrphan = scan.orphanInfos.find((record) => record.infoPath.endsWith('$IFFFFFF.old'))!
    const orphanData = byDataName(scan, '$RDDDDDD.bin')
    const orphanDir = byDataName(scan, '$REEEEEE')

    expect(recycleOrphanToDraft(orphanInfo)).toMatchObject({
      path: orphanInfo.infoPath,
      risk: 'caution',
      defaultSelected: false,
      size: 0,
      meta: { orphan: 'info', broken: false },
    })
    expect(recycleOrphanToDraft(brokenOrphan)).toMatchObject({
      path: brokenOrphan.infoPath,
      risk: 'caution',
      defaultSelected: false,
      meta: { orphan: 'info', broken: true },
    })
    expect(recycleOrphanToDraft(brokenOrphan).title).toContain('损坏')
    expect(recycleOrphanToDraft(brokenOrphan).note).toContain('损坏')

    expect(recycleOrphanToDraft(orphanData)).toMatchObject({
      path: orphanData.dataPath,
      kind: 'file',
      size: 1234,
      risk: 'caution',
      defaultSelected: false,
      meta: { orphan: 'data' },
    })
    expect(recycleOrphanToDraft(orphanDir)).toMatchObject({
      path: orphanDir.dataPath,
      kind: 'directory',
      size: 350,
      risk: 'caution',
      defaultSelected: false,
    })
  })

  it('多 SID / 多盘：按盘统计汇总可清理项数与体积', async () => {
    const current = await analyzeRecycleSidDirectory(sidC, 'C:', SID_CURRENT, await namesOf(sidC))
    const otherSid = await analyzeRecycleSidDirectory(sidOther, 'C:', SID_OTHER, await namesOf(sidOther))
    const driveD = await analyzeRecycleSidDirectory(sidD, 'D:', SID_CURRENT, await namesOf(sidD))
    expect(otherSid.orphanDatas).toHaveLength(1)
    expect(driveD.pairs).toHaveLength(1)

    const stats = summarizeRecycleByDrive(
      [
        ...current.pairs.map((record) => ({ drive: 'C:', size: record.size })),
        ...current.orphanInfos.map(() => ({ drive: 'C:', size: 0, orphan: true })),
        ...current.orphanDatas.map((record) => ({ drive: 'C:', size: record.size, orphan: true })),
        ...otherSid.orphanDatas.map((record) => ({ drive: 'C:', size: record.size, orphan: true })),
        ...driveD.pairs.map((record) => ({ drive: 'D:', size: record.size })),
      ],
      ['C:', 'D:', 'E:'],
    )
    expect(stats.map((stat) => stat.drive)).toEqual(['C:', 'D:', 'E:'])
    expect(stats[0]).toEqual({
      drive: 'C:',
      items: 8,
      bytes: 4096 + 512 + 256 + 1234 + 350 + 64,
      pairs: 3,
      orphans: 5,
      orphanBytes: 1234 + 350 + 64,
    })
    expect(stats[1]).toEqual({ drive: 'D:', items: 1, bytes: 2048, pairs: 1, orphans: 0, orphanBytes: 0 })
    expect(stats[2]).toEqual({ drive: 'E:', items: 0, bytes: 0, pairs: 0, orphans: 0, orphanBytes: 0 })

    expect(formatRecycleDriveStats(stats)).toBe(
      'C: 8 项 / 6.4 KB（其中孤立残留 5 项 / 1.6 KB）；D: 1 项 / 2 KB；E: 0 项 / 0 B',
    )
    expect(formatRecycleDriveStats([])).toBe('无')
  })

  it('limit 限流：配对优先、孤立残留补位，超出时标记 truncated', async () => {
    const names = await namesOf(sidC)
    const limited = await analyzeRecycleSidDirectory(sidC, 'C:', SID_CURRENT, names, { limit: 2 })
    expect(limited.truncated).toBe(true)
    expect(limited.total).toBe(7)
    expect(limited.pairs).toHaveLength(2)
    expect(limited.orphanInfos).toHaveLength(0)
    expect(limited.orphanDatas).toHaveLength(0)

    const mixed = await analyzeRecycleSidDirectory(sidC, 'C:', SID_CURRENT, names, { limit: 4 })
    expect(mixed.truncated).toBe(true)
    expect(mixed.pairs).toHaveLength(3)
    expect(mixed.orphanInfos).toHaveLength(1)
    expect(mixed.orphanDatas).toHaveLength(0)

    const notLimited = await analyzeRecycleSidDirectory(sidC, 'C:', SID_CURRENT, names, { limit: 100 })
    expect(notLimited.truncated).toBe(false)
    expect(notLimited.pairs).toHaveLength(3)
  })

  it('列举之后 $R 被外部删除：本次忽略，不会产出孤立数据', async () => {
    const names = [...(await namesOf(sidC)), '$RZZZZZZ.dat']
    const scan = await analyzeRecycleSidDirectory(sidC, 'C:', SID_CURRENT, names)
    expect(scan.total).toBe(8) // 候选计数包含它
    expect(scan.orphanDatas).toHaveLength(2) // 但实际不存在，不产出
  })

  it('$I 读取失败（列举后被删）：配对保留但 broken=true，并通过 addError 上报', async () => {
    const sidE = await makeSidDir('vol-e', SID_CURRENT)
    await writeFileAt(path.join(sidE, '$IQQQQQQ.log'), buildInfo('C:\\Temp\\会被删掉.log', { size: 512 }))
    await writeFileAt(path.join(sidE, '$RQQQQQQ.log'), Buffer.alloc(777, 10))
    const names = await namesOf(sidE)
    await fs.unlink(path.join(sidE, '$IQQQQQQ.log'))

    const errors: Array<{ path: string; message: string }> = []
    const scan = await analyzeRecycleSidDirectory(sidE, 'E:', SID_CURRENT, names, {
      addError: (error) => errors.push({ path: error.path, message: error.message }),
    })
    const pair = byInfoName(scan, '$IQQQQQQ.log')
    expect(pair.broken).toBe(true)
    expect(pair.original).toBe(path.join(sidE, '$RQQQQQQ.log')) // 回退到 $R 路径
    expect(pair.size).toBe(777) // $I 读不到大小 → 用 $R 实际大小
    expect(errors).toHaveLength(1)
    expect(errors[0].path).toBe(path.join(sidE, '$IQQQQQQ.log'))
    expect(errors[0].message).toContain('读取 $I 元数据失败')
    expect(recyclePairToDraft(pair).risk).toBe('caution')
    expect(recyclePairToDraft(pair).defaultSelected).toBe(false)
  })

  it('readRecyclePair（兼容入口）：正常对返回记录、孤立 $I 返回 null、损坏 $I 标记 broken', async () => {
    const pair = await readRecyclePair({}, sidC, '$IAAAAAA.txt', 'C:', SID_CURRENT)
    expect(pair).toMatchObject({ size: 4096, original: 'C:\\Users\\测试\\文档.txt', broken: false })
    expect(await readRecyclePair({}, sidC, '$ICCCCCC.tmp', 'C:', SID_CURRENT)).toBeNull()
    expect(await readRecyclePair({}, sidC, '$IBBBBBB.log', 'C:', SID_CURRENT)).toMatchObject({
      broken: true,
      dataPath: path.join(sidC, '$RBBBBBB.log'),
    })
  })
})

afterAll(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ */
/* 四、清理：只删孤立元数据/数据，且必须走 deleteInternal               */
/* ------------------------------------------------------------------ */

interface CleanHarness {
  ctx: TaskCleanContext
  calls: Array<{ path: string; reason: string }>
  warnings: string[]
}

interface CleanHarnessOptions {
  dryRun?: boolean
  aborted?: boolean
  allow?: (target: string) => boolean
  /** 覆盖 deleteInternal 的返回值（默认成功、释放 42 字节） */
  remove?: (target: string, reason: string) => Promise<{ ok: boolean; bytes: number; error?: string }>
  /** 模拟内核未提供统一删除入口 */
  noDeleteInternal?: boolean
}

function createCleanHarness(options: CleanHarnessOptions = {}): CleanHarness {
  const calls: CleanHarness['calls'] = []
  const warnings: string[] = []
  const controller = new AbortController()
  if (options.aborted) controller.abort()
  const allow = options.allow ?? (() => true)
  const remove = options.remove ?? (async () => ({ ok: true, bytes: 42 }))
  const logger: TaskLogger = {
    debug: () => {},
    info: () => {},
    warn: (message, ...args) => warnings.push([message, ...args].join(' ')),
    error: () => {},
  }
  const pathPolicy: PathPolicyLike = {
    check: (target) => ({ allowed: allow(target) }),
    isProtected: () => false,
    roots: () => [],
    containsProtected: () => false,
    rootOf: () => undefined,
    checkClear: (target) => ({ allowed: allow(target) }),
  }
  const ctx: TaskCleanContext = {
    signal: controller.signal,
    logger,
    env: {} as TaskCleanContext['env'],
    pathPolicy,
    dryRun: options.dryRun ?? false,
    mode: 'delete',
    deleteInternal: options.noDeleteInternal
      ? undefined
      : async (target, reason) => {
          calls.push({ path: target, reason })
          return remove(target, reason)
        },
    throwIfAborted: () => {
      if (controller.signal.aborted) throw new Error('清理已取消')
    },
  }
  return { ctx, calls, warnings }
}

const ORPHAN_INFO_PATH = 'R:\\$Recycle.Bin\\S-1-5-21-1-2-3-500\\$IAAAAAA.tmp'
const ORPHAN_DATA_PATH = 'R:\\$Recycle.Bin\\S-1-5-21-1-2-3-500\\$RAAAAAA.tmp'
const BROKEN_ORPHAN_INFO_PATH = 'R:\\$Recycle.Bin\\S-1-5-21-1-2-3-500\\$IBBBBBB.old'
const ORPHAN_DATA_DIR_PATH = 'R:\\$Recycle.Bin\\S-1-5-21-1-2-3-500\\$RCCCCCC'
const SID = 'S-1-5-21-1-2-3-500'

const orphanInfoRecord: RecycleOrphanInfo = {
  infoPath: ORPHAN_INFO_PATH,
  original: 'C:\\Temp\\丢失的文件.tmp',
  deletedAt: DELETED_AT,
  broken: false,
  drive: 'R:',
  sid: SID,
}
const brokenOrphanInfoRecord: RecycleOrphanInfo = {
  ...orphanInfoRecord,
  infoPath: BROKEN_ORPHAN_INFO_PATH,
  original: '',
  broken: true,
}
const orphanDataRecord: RecycleOrphanData = {
  dataPath: ORPHAN_DATA_PATH,
  size: 1024,
  isDirectory: false,
  drive: 'R:',
  sid: SID,
}
const orphanDataDirRecord: RecycleOrphanData = {
  ...orphanDataRecord,
  dataPath: ORPHAN_DATA_DIR_PATH,
  size: 2048,
  isDirectory: true,
}

let itemSeq = 0
/** 把扫描草稿模拟成内核补全后的 CleanItem */
function itemOf(draft: CleanItemDraft, overrides: Partial<CleanItem> = {}): CleanItem {
  itemSeq += 1
  return {
    id: `recycle:test:${itemSeq}`,
    taskId: 'recycle',
    title: draft.title ?? draft.path,
    path: draft.path,
    kind: draft.kind ?? 'file',
    size: draft.size ?? 0,
    risk: draft.risk ?? 'caution',
    category: 'system',
    defaultSelected: draft.defaultSelected ?? false,
    meta: draft.meta,
    note: draft.note,
    ...overrides,
  }
}

/** 用 fake drive 路径 + 假 stat 打开「数据文件存在」的删除分支 */
function markExisting(...targets: string[]): void {
  for (const target of targets) fakeStatPaths.add(target.toLowerCase())
}

beforeEach(() => {
  fakeStatPaths.clear()
})

describe('cleanRecycleItems：孤立残留清理', () => {
  it('dryRun：孤立 $I / 孤立 $R 都只统计、不调用 deleteInternal', async () => {
    const harness = createCleanHarness({ dryRun: true })
    const results = await cleanRecycleItems(
      [
        itemOf(recycleOrphanToDraft(orphanInfoRecord)),
        itemOf(recycleOrphanToDraft(orphanDataRecord)),
        itemOf(recycleOrphanToDraft(orphanDataDirRecord)),
      ],
      harness.ctx,
    )
    expect(results.every((result) => result.ok)).toBe(true)
    expect(results.map((result) => result.bytes)).toEqual([0, 1024, 2048])
    expect(harness.calls).toHaveLength(0)
  })

  it('孤立 $I：确认配对 $R 不存在后，只经 deleteInternal 删除该 $I', async () => {
    const harness = createCleanHarness({ remove: async () => ({ ok: true, bytes: 33 }) })
    const results = await cleanRecycleItems([itemOf(recycleOrphanToDraft(orphanInfoRecord))], harness.ctx)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ ok: true, path: ORPHAN_INFO_PATH, bytes: 33 })
    expect(harness.calls).toEqual([{ path: ORPHAN_INFO_PATH, reason: 'recycle-bin' }])
  })

  it('孤立 $I 删除失败：把执行器返回的具体原因带回结果', async () => {
    const harness = createCleanHarness({
      remove: async () => ({ ok: false, bytes: 0, error: '文件正被其它程序占用（EBUSY）' }),
    })
    const results = await cleanRecycleItems([itemOf(recycleOrphanToDraft(orphanInfoRecord))], harness.ctx)
    expect(results[0].ok).toBe(false)
    expect(results[0].error).toContain('删除孤立 $I 元数据失败')
    expect(results[0].error).toContain('EBUSY')
  })

  it('孤立 $I：扫描后配对的 $R 已出现 → 拒绝清理，避免打散正常配对', async () => {
    markExisting(ORPHAN_DATA_PATH) // 配对数据文件“已出现”
    const harness = createCleanHarness()
    const results = await cleanRecycleItems([itemOf(recycleOrphanToDraft(orphanInfoRecord))], harness.ctx)
    expect(results[0].ok).toBe(false)
    expect(results[0].error).toContain('已出现')
    expect(harness.calls).toHaveLength(0)
  })

  it('孤立 $R（文件）：先经 deleteInternal 删数据，再回收 $I 元数据', async () => {
    markExisting(ORPHAN_DATA_PATH)
    const harness = createCleanHarness({ remove: async () => ({ ok: true, bytes: 1234 }) })
    const results = await cleanRecycleItems([itemOf(recycleOrphanToDraft(orphanDataRecord))], harness.ctx)
    expect(results[0]).toMatchObject({ ok: true, path: ORPHAN_DATA_PATH, bytes: 1234 })
    expect(harness.calls).toEqual([
      { path: ORPHAN_DATA_PATH, reason: 'recycle-bin' },
      { path: ORPHAN_INFO_PATH, reason: 'recycle-bin' },
    ])
  })

  it('孤立 $R（目录）：同样走 deleteInternal，kind=directory 不影响内部通道', async () => {
    markExisting(ORPHAN_DATA_DIR_PATH)
    const harness = createCleanHarness({ remove: async () => ({ ok: true, bytes: 2048 }) })
    const results = await cleanRecycleItems([itemOf(recycleOrphanToDraft(orphanDataDirRecord))], harness.ctx)
    expect(results[0]).toMatchObject({ ok: true, path: ORPHAN_DATA_DIR_PATH, bytes: 2048 })
    expect(harness.calls[0]).toEqual({ path: ORPHAN_DATA_DIR_PATH, reason: 'recycle-bin' })
  })

  it('孤立 $R 删除失败：结果里带「删除孤立 $R 数据失败」与具体原因，且不再删 $I', async () => {
    markExisting(ORPHAN_DATA_PATH)
    const harness = createCleanHarness({
      remove: async (target) =>
        target === ORPHAN_DATA_PATH
          ? { ok: false, bytes: 0, error: '权限不足或文件被占用（EPERM）' }
          : { ok: true, bytes: 0 },
    })
    const results = await cleanRecycleItems([itemOf(recycleOrphanToDraft(orphanDataRecord))], harness.ctx)
    expect(results[0].ok).toBe(false)
    expect(results[0].error).toContain('删除孤立 $R 数据失败')
    expect(results[0].error).toContain('EPERM')
    expect(harness.calls).toEqual([{ path: ORPHAN_DATA_PATH, reason: 'recycle-bin' }])
  })

  it('孤立 $R 的数据在扫描后消失：按 0 字节成功，并顺手回收 $I', async () => {
    const harness = createCleanHarness()
    const results = await cleanRecycleItems([itemOf(recycleOrphanToDraft(orphanDataRecord))], harness.ctx)
    expect(results[0]).toMatchObject({ ok: true, bytes: 0 })
    expect(harness.calls).toEqual([{ path: ORPHAN_INFO_PATH, reason: 'recycle-bin' }])
  })

  it('正常配对：先删 $R 数据、再删 $I 元数据（任何一步失败都还能靠 $I 重试）', async () => {
    markExisting(ORPHAN_DATA_PATH)
    const pair: RecycleRecord = {
      infoPath: ORPHAN_INFO_PATH,
      dataPath: ORPHAN_DATA_PATH,
      size: 4096,
      original: 'C:\\Users\\测试\\文档.txt',
      deletedAt: DELETED_AT,
      broken: false,
      drive: 'R:',
      sid: SID,
    }
    const harness = createCleanHarness({ remove: async () => ({ ok: true, bytes: 4096 }) })
    const results = await cleanRecycleItems([itemOf(recyclePairToDraft(pair))], harness.ctx)
    expect(results[0]).toMatchObject({ ok: true, bytes: 4096 })
    expect(harness.calls.map((call) => call.path)).toEqual([ORPHAN_DATA_PATH, ORPHAN_INFO_PATH])
    expect(harness.calls.every((call) => call.reason === 'recycle-bin')).toBe(true)
  })

  it('配对 $I 回收失败只记警告：数据已删除时主结果仍成功', async () => {
    markExisting(ORPHAN_DATA_PATH)
    const harness = createCleanHarness({
      remove: async (target) =>
        target === ORPHAN_INFO_PATH ? { ok: false, bytes: 0, error: '路径已不存在' } : { ok: true, bytes: 4096 },
    })
    const pair: RecycleRecord = {
      infoPath: ORPHAN_INFO_PATH,
      dataPath: ORPHAN_DATA_PATH,
      size: 4096,
      original: 'C:\\Users\\测试\\文档.txt',
      deletedAt: DELETED_AT,
      broken: false,
      drive: 'R:',
      sid: SID,
    }
    const results = await cleanRecycleItems([itemOf(recyclePairToDraft(pair))], harness.ctx)
    expect(results[0].ok).toBe(true)
    expect(harness.warnings.some((warning) => warning.includes('删除配对文件失败'))).toBe(true)
  })
})

describe('cleanRecycleItems：安全阀与失败路径', () => {
  it('$I 缺少扫描标记（meta.orphan=info）：拒绝删除，防止打散仍在的配对', async () => {
    const harness = createCleanHarness()
    const item = itemOf(recycleOrphanToDraft(orphanInfoRecord), { meta: undefined })
    const results = await cleanRecycleItems([item], harness.ctx)
    expect(results[0].ok).toBe(false)
    expect(results[0].error).toContain('缺少扫描标记')
    expect(harness.calls).toHaveLength(0)
  })

  it('扫描标记与目标类型不一致（orphan=info 但目标是 $R）：拒绝', async () => {
    const harness = createCleanHarness()
    const item = itemOf(recycleOrphanToDraft(orphanInfoRecord), {
      path: ORPHAN_DATA_PATH,
      meta: { orphan: 'info' },
    })
    const results = await cleanRecycleItems([item], harness.ctx)
    expect(results[0].ok).toBe(false)
    expect(results[0].error).toContain('不一致')
    expect(harness.calls).toHaveLength(0)
  })

  it('拒绝回收站之外 / 缺少 SID 目录的路径', async () => {
    const harness = createCleanHarness()
    const results = await cleanRecycleItems(
      [
        itemOf(recycleOrphanToDraft(orphanInfoRecord), { path: 'C:\\Windows\\System32\\drivers\\etc\\hosts' }),
        itemOf(recycleOrphanToDraft(orphanInfoRecord), {
          path: 'R:\\$Recycle.Bin\\$IAAAAAA.tmp',
        }),
      ],
      harness.ctx,
    )
    expect(results.every((result) => !result.ok)).toBe(true)
    expect(results[0].error).toContain('不是回收站目录内的 $I/$R 维护文件')
    expect(harness.calls).toHaveLength(0)
  })

  it('路径策略二次校验拒绝时不删除', async () => {
    markExisting(ORPHAN_DATA_PATH)
    const harness = createCleanHarness({
      allow: (target) => target !== ORPHAN_DATA_PATH,
    })
    const results = await cleanRecycleItems([itemOf(recycleOrphanToDraft(orphanDataRecord))], harness.ctx)
    expect(results[0].ok).toBe(false)
    expect(results[0].error).toContain('路径被安全策略拒绝')
    expect(harness.calls).toHaveLength(0)
  })

  it('内核未提供 deleteInternal 时给出可读失败原因，不直接 fs 删除', async () => {
    markExisting(ORPHAN_DATA_PATH)
    const harness = createCleanHarness({ noDeleteInternal: true })
    const results = await cleanRecycleItems([itemOf(recycleOrphanToDraft(orphanDataRecord))], harness.ctx)
    expect(results[0].ok).toBe(false)
    expect(results[0].error).toContain('内核未提供统一删除入口')
  })

  it('已取消的清理会话：直接返回「清理已取消」，不产生任何删除调用', async () => {
    const harness = createCleanHarness({ aborted: true })
    const results = await cleanRecycleItems([itemOf(recycleOrphanToDraft(orphanDataRecord))], harness.ctx)
    expect(results[0].ok).toBe(false)
    expect(results[0].error).toBe('清理已取消')
    expect(harness.calls).toHaveLength(0)
  })

  it('一条失败不影响整批：其余项继续清理', async () => {
    markExisting(ORPHAN_DATA_PATH)
    const harness = createCleanHarness({
      remove: async (target) =>
        target === BROKEN_ORPHAN_INFO_PATH
          ? { ok: false, bytes: 0, error: '权限不足（EPERM）' }
          : { ok: true, bytes: 10 },
    })
    const results: CleanItemResult[] = await cleanRecycleItems(
      [
        itemOf(recycleOrphanToDraft(orphanDataRecord)),
        itemOf(recycleOrphanToDraft(brokenOrphanInfoRecord)),
      ],
      harness.ctx,
    )
    expect(results[0].ok).toBe(true)
    expect(results[1].ok).toBe(false)
    expect(results[1].error).toContain('EPERM')
    // 第一项删数据 + 元数据，第二项只尝试删自己的 $I（失败）
    expect(harness.calls.map((call) => call.path)).toEqual([
      ORPHAN_DATA_PATH,
      ORPHAN_INFO_PATH,
      BROKEN_ORPHAN_INFO_PATH,
    ])
  })
})
