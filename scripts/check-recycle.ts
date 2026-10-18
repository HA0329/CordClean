/**
 * recycle 插件自测脚本（**只扫描，不执行真实清理**）。
 *
 * 分五段验证：
 *   1. `$I` 解析函数（`parseRecycleInfo`）：用构造的 v1 / v2 / 目录变体 / 损坏数据做单元自测；
 *   2. 假回收站目录：在临时目录里搭 `$Recycle.Bin\<SID>\` 结构，验证 `$I`/`$R` 配对读取、
 *      大小回退与目录大小统计（完全不触碰系统回收站）；
 *   3. 本机真实 `$I` 文件抽样解析（只读，验证真实数据上的正确性）；
 *   4. 通过内核执行一次 `cleaner.scan({ taskIds: ['recycle'] })`，打印项目数 / 字节数 / 耗时 / 错误；
 *   5. 用 `dryRun: true` 验证自定义 clean 的安全阀（dryRun 不落盘，且被测路径本身不存在）。
 *
 * 用法：pnpm exec tsx scripts/check-recycle.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { formatBytes, formatTime } from '@cordclean/shared'
import type { CleanItem, TaskCleanContext, TaskScanContext } from '@cordclean/shared'
import { createApp } from '@cordclean/core'
// 说明：tsconfig 的 paths 未映射 @cordclean/utils，脚本里用相对路径导入（只读工具函数）
import { exists, runCommand, toLongPath } from '../packages/utils/src/index.ts'
import { cleanRecycleItems, filetimeToUnix, parseRecycleInfo, readRecyclePair } from '@cordclean/plugin-recycle'

/** 简单断言 */
function check(name: string, ok: boolean, detail = ''): boolean {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' —— ' + detail : ''}`)
  return ok
}

const failures: string[] = []
function expect(name: string, ok: boolean, detail = ''): void {
  if (!check(name, ok, detail)) failures.push(name)
}

/* ------------------------------------------------------------------ */
/* 一、$I 解析函数单元自测                                              */
/* ------------------------------------------------------------------ */

/** Unix 毫秒 → FILETIME（100ns，自 1601 起） */
function toFiletime(ms: number): bigint {
  return BigInt(ms + 11_644_473_600_000) * 10_000n
}

/** 构造一个规范的 `$I` 缓冲区（偏移 24 = 名字长度，名字从 28 开始） */
function buildInfo(version: number, original: string, size: number, deletedAtMs: number): Buffer {
  const chars = original.length + 1 // 含结尾 \0
  const buffer = Buffer.alloc(28 + chars * 2)
  buffer.writeBigUInt64LE(BigInt(version), 0)
  buffer.writeBigUInt64LE(BigInt(size), 8)
  buffer.writeBigUInt64LE(toFiletime(deletedAtMs), 16)
  buffer.writeUInt32LE(chars, 24)
  buffer.write(original + '\u0000', 28, 'utf16le')
  return buffer
}

/** 构造 Windows 10「目录型」变体：偏移 24 为 8 字节目录大小，名字长度在 32，名字从 36 开始 */
function buildDirectoryInfo(original: string, directorySize: number, deletedAtMs: number): Buffer {
  const chars = original.length + 1
  const buffer = Buffer.alloc(36 + chars * 2)
  buffer.writeBigUInt64LE(2n, 0)
  buffer.writeBigUInt64LE(0n, 8) // 目录项在偏移 8 处通常记为 0
  buffer.writeBigUInt64LE(toFiletime(deletedAtMs), 16)
  buffer.writeBigUInt64LE(BigInt(directorySize), 24)
  buffer.writeUInt32LE(chars, 32)
  buffer.write(original + '\u0000', 36, 'utf16le')
  return buffer
}

console.log('== 1. $I 解析函数单元自测 ==')
const sampleTime = Date.UTC(2025, 4, 1, 8, 30, 0) // 2025-05-01 08:30:00 UTC

const infoV1 = parseRecycleInfo(buildInfo(1, 'C:\\Users\\小明\\Documents\\毕业论文.docx', 2_457_600, sampleTime))
expect('v1 版本号', infoV1?.version === 1, String(infoV1?.version))
expect('v1 原始路径（含中文与反斜杠）', infoV1?.original === 'C:\\Users\\小明\\Documents\\毕业论文.docx', infoV1?.original ?? '<null>')
expect('v1 原始大小', infoV1?.size === 2_457_600, String(infoV1?.size))
expect('v1 删除时间换算', infoV1?.deletedAt === sampleTime, `${infoV1?.deletedAt} vs ${sampleTime}`)

const infoV2 = parseRecycleInfo(buildInfo(2, 'D:\\桌面\\2324030577-作业.sql', 417_227, sampleTime))
expect('v2 版本号', infoV2?.version === 2, String(infoV2?.version))
expect('v2 原始路径', infoV2?.original === 'D:\\桌面\\2324030577-作业.sql', infoV2?.original ?? '<null>')
expect('v2 原始大小', infoV2?.size === 417_227, String(infoV2?.size))

const dirInfo = parseRecycleInfo(buildDirectoryInfo('D:\\桌面\\旧项目', 8_388_608, sampleTime))
expect('目录型变体：原始路径后移 8 字节可解析', dirInfo?.original === 'D:\\桌面\\旧项目', dirInfo?.original ?? '<null>')
expect('目录型变体：大小取自偏移 24', dirInfo?.size === 8_388_608, String(dirInfo?.size))

expect('过短缓冲区返回 null', parseRecycleInfo(Buffer.alloc(10)) === null)
const garbage = Buffer.alloc(40)
garbage.writeBigUInt64LE(2n, 0)
garbage.writeBigUInt64LE(1024n, 8)
garbage.writeBigUInt64LE(toFiletime(sampleTime), 16)
garbage.writeUInt32LE(0xffffffff, 24) // 名字长度字段被写坏
garbage.write('乱码', 28, 'utf16le')
const damaged = parseRecycleInfo(garbage)
expect('名字损坏时仍返回大小与删除时间', damaged?.size === 1024 && damaged?.deletedAt === sampleTime && damaged?.original === '', JSON.stringify(damaged))

expect('FILETIME 0 → 0', filetimeToUnix(0n) === 0)
expect(
  'FILETIME 往返换算一致',
  filetimeToUnix(toFiletime(sampleTime)) === sampleTime,
  `${filetimeToUnix(toFiletime(sampleTime))}`,
)
expect(
  '真实 FILETIME 示例换算（2026-10-15T06:55:49.165Z）',
  filetimeToUnix(134_365_209_491_650_000n) === Date.UTC(2026, 9, 15, 6, 55, 49, 165),
  String(filetimeToUnix(134_365_209_491_650_000n)),
)

/* ------------------------------------------------------------------ */
/* 二、假回收站目录：验证 $I/$R 配对读取（完全不触碰系统回收站）        */
/* ------------------------------------------------------------------ */

console.log('\n== 2. 假回收站目录：$I/$R 配对读取自测 ==')

/** 一个只用于自测的最小 TaskScanContext（不产生真实清理项） */
function createFakeScanContext(): { ctx: TaskScanContext; errors: Array<{ path: string; message: string }> } {
  const errors: Array<{ path: string; message: string }> = []
  const ctx: TaskScanContext = {
    signal: new AbortController().signal,
    config: {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    pathPolicy: {} as TaskScanContext['pathPolicy'],
    env: {} as TaskScanContext['env'],
    emit() {},
    count() {},
    addError(error) {
      errors.push({ path: error.path, message: error.message })
    },
    throwIfAborted() {},
  }
  return { ctx, errors }
}

const fakeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cordclean-recycle-fake-'))
const fakeBin = path.join(fakeRoot, '$Recycle.Bin')
const fakeSidDir = path.join(fakeBin, 'S-1-5-21-1-2-3-500')
await fs.mkdir(fakeSidDir, { recursive: true })
const fake = (name: string): string => path.join(fakeSidDir, name)

// ① 正常文件对：大小取自 $I
await fs.writeFile(fake('$IAAAAAA.docx'), buildInfo(2, 'C:\\Users\\测试\\文档.docx', 4096, sampleTime))
await fs.writeFile(fake('$RAAAAAA.docx'), Buffer.alloc(3000, 1))
// ② $I 损坏：大小回退到 $R 实际大小
await fs.writeFile(fake('$IBBBBBB.log'), Buffer.alloc(10))
await fs.writeFile(fake('$RBBBBBB.log'), Buffer.alloc(700, 2))
// ③ 目录对：$I 记录目录大小时名字后移 8 字节，$R 是目录 → 递归统计实际占用
await fs.writeFile(fake('$ICCCCCC'), buildDirectoryInfo('D:\\桌面\\旧目录', 0, sampleTime))
await fs.mkdir(fake('$RCCCCCC'), { recursive: true })
await fs.writeFile(path.join(fake('$RCCCCCC'), 'a.txt'), Buffer.alloc(100, 3))
await fs.writeFile(path.join(fake('$RCCCCCC'), 'b.txt'), Buffer.alloc(250, 4))
// ④ 孤儿 $I：$R 不存在 → 不上报
await fs.writeFile(fake('$IDDDDDD.tmp'), buildInfo(2, 'C:\\Temp\\orphan.tmp', 512, sampleTime))

const { ctx: fakeScan, errors: fakeErrors } = createFakeScanContext()
const pairA = await readRecyclePair(fakeScan, fakeSidDir, '$IAAAAAA.docx', 'C:', 'S-1-5-21-1-2-3-500')
const pairB = await readRecyclePair(fakeScan, fakeSidDir, '$IBBBBBB.log', 'C:', 'S-1-5-21-1-2-3-500')
const pairC = await readRecyclePair(fakeScan, fakeSidDir, '$ICCCCCC', 'C:', 'S-1-5-21-1-2-3-500')
const pairD = await readRecyclePair(fakeScan, fakeSidDir, '$IDDDDDD.tmp', 'C:', 'S-1-5-21-1-2-3-500')

expect('文件对：原始路径来自 $I', pairA?.original === 'C:\\Users\\测试\\文档.docx', pairA?.original ?? '<null>')
expect('文件对：大小取自 $I（4096，而非 $R 的 3000）', pairA?.size === 4096, String(pairA?.size))
expect('文件对：删除时间来自 $I', pairA?.deletedAt === sampleTime, String(pairA?.deletedAt))
expect('文件对：$R 路径推导正确', pairA?.dataPath === fake('$RAAAAAA.docx'), pairA?.dataPath ?? '<null>')
expect('损坏 $I：大小回退到 $R 实际大小（700）', pairB?.size === 700, String(pairB?.size))
expect('损坏 $I：原始路径回退为 $R 路径', pairB?.original === fake('$RBBBBBB.log'), pairB?.original ?? '<null>')
expect('目录对：原始路径可解析', pairC?.original === 'D:\\桌面\\旧目录', pairC?.original ?? '<null>')
expect('目录对：大小递归统计 $R 目录（100 + 250）', pairC?.size === 350, String(pairC?.size))
expect('孤儿 $I（缺少 $R）不上报', pairD === null)
expect('读取过程中没有错误', fakeErrors.length === 0, JSON.stringify(fakeErrors.slice(0, 3)))
await fs.rm(fakeRoot, { recursive: true, force: true })
expect('临时假回收站已清理', !(await exists(fakeRoot)))

/* ------------------------------------------------------------------ */
/* 三、启动内核（后续步骤共用）                                        */
/* ------------------------------------------------------------------ */

const dataDir = path.join(os.tmpdir(), 'cordclean-check-recycle-' + Date.now())
const app = await createApp({ dataDir, logLevel: 'warn' })
const env = app.ctx.system.env
const sid = /S-1-5-\d+(?:-\d+)+/i.exec(await runCommand('whoami.exe', ['/user', '/fo', 'csv', '/nh']).then((r) => r.stdout))?.[0] ?? ''
console.log('\n== 环境 ==')
console.log('dataDir =', dataDir)
console.log('drives =', env.drives.join(', '), '| elevated =', env.elevated)
console.log('当前用户 SID =', sid || '<未解析>')

/* ------------------------------------------------------------------ */
/* 四、真实 $I 文件抽样解析（只读）                                     */
/* ------------------------------------------------------------------ */

console.log('\n== 3. 本机真实 $I 文件抽样解析（只读） ==')
let totalInfo = 0
let orphanInfo = 0
let realSamples = 0
let sampleSidDir = ''
for (const drive of env.drives) {
  const bin = `${drive}\\$Recycle.Bin`
  if (!(await exists(bin))) {
    console.log(`- ${bin} 不存在，跳过`)
    continue
  }
  let sids: string[] = []
  try {
    sids = (await fs.readdir(toLongPath(bin), { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => item.name)
  } catch (error) {
    console.log(`- ${bin} 读取失败：${String(error)}`)
    continue
  }
  for (const name of sids) {
    const dir = `${bin}\\${name}`
    let names: string[] = []
    try {
      names = await fs.readdir(toLongPath(dir))
    } catch (error) {
      console.log(`- ${dir} 读取失败（权限不足？）：${String(error)}`)
      continue
    }
    const infoNames = names.filter((item) => /^\$I/i.test(item))
    const orphan = infoNames.filter((item) => !names.some((other) => other.toUpperCase() === `$R${item.slice(2)}`.toUpperCase()))
    totalInfo += infoNames.length
    orphanInfo += orphan.length
    console.log(`- ${dir}：$I=${infoNames.length}，其中缺少 $R 的孤儿项=${orphan.length}`)
    if (infoNames.length && !sampleSidDir) sampleSidDir = dir
    for (const infoName of infoNames.slice(0, 3)) {
      if (realSamples >= 3) break
      try {
        const buffer = await fs.readFile(toLongPath(`${dir}\\${infoName}`))
        const parsed = parseRecycleInfo(buffer)
        if (!parsed) {
          console.log(`    ${infoName}: 解析失败（缓冲区 ${buffer.length} 字节）`)
          continue
        }
        realSamples++
        console.log(
          `    ${infoName}: version=${parsed.version} size=${formatBytes(parsed.size)}`,
          `deletedAt=${parsed.deletedAt ? formatTime(parsed.deletedAt) : '未知'}`,
          `original=${parsed.original || '<解析失败>'}`,
        )
      } catch (error) {
        console.log(`    ${infoName}: 读取失败 ${String(error)}`)
      }
    }
  }
}
console.log(`汇总：$I 共 ${totalInfo} 个，孤儿项（无 $R）${orphanInfo} 个，抽样解析 ${realSamples} 个`)

/* ------------------------------------------------------------------ */
/* 五、内核扫描验证                                                    */
/* ------------------------------------------------------------------ */

console.log('\n== 4. 内核扫描验证（不执行 clean） ==')
const descriptor = app.ctx.cleaner.list().find((item) => item.id === 'recycle')
console.log('任务描述：', descriptor)
if (!descriptor) failures.push('任务未注册')

const report = await app.ctx.cleaner.scan({ taskIds: ['recycle'] })
console.log('扫描统计：', {
  items: report.items.length,
  bytes: formatBytes(report.stats.bytes),
  files: report.stats.files,
  dirs: report.stats.dirs,
  errors: report.errors.length,
  truncated: report.stats.truncated,
  elapsed: `${report.elapsedMs} ms`,
})
console.log('任务结果：', report.tasks)
if (report.errors.length) console.log('错误（前 5 条）：', report.errors.slice(0, 5))

const taskResult = report.tasks.find((item) => item.taskId === 'recycle')
expect('任务状态为 ok（不是 error/cancelled）', taskResult?.status === 'ok', taskResult?.status ?? '<missing>')
expect('扫描未抛异常（错误数为 0）', report.errors.length === 0, `${report.errors.length} 条错误`)
expect('上报项数与任务结果一致', taskResult?.items === report.items.length, `${taskResult?.items} vs ${report.items.length}`)
expect('所有上报项的路径都在 $Recycle.Bin 下', report.items.every((item) => /\$Recycle\.Bin\\S-1-5-/i.test(item.path)))
expect('所有上报项的标题都是原始路径', report.items.every((item) => !/^\$R/i.test(item.title)))
expect('所有上报项都带 $I 解析出的 meta', report.items.every((item) => 'original' in (item.meta ?? {}) && 'deletedAt' in (item.meta ?? {})))
expect('空回收站/孤儿 $I 时正常返回 0 项且无错误', report.tasks[0]?.status === 'ok')

for (const item of report.items.slice(0, 5)) {
  console.log('  ', formatBytes(item.size), item.title, '→', item.path, '|', item.note)
  console.log('     meta =', item.meta)
}

/* ------------------------------------------------------------------ */
/* 六、自定义 clean 的安全阀自测（dryRun，不落盘）                      */
/* ------------------------------------------------------------------ */

console.log('\n== 5. 自定义 clean 安全阀自测（dryRun: true） ==')
const cleanCtx: TaskCleanContext = {
  signal: new AbortController().signal,
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  env,
  pathPolicy: app.ctx.pathPolicy,
  dryRun: true,
  mode: 'delete',
  throwIfAborted() {},
}

const makeItem = (target: string): CleanItem => ({
  id: `recycle:test:${target}`,
  taskId: 'recycle',
  title: target,
  path: target,
  kind: 'file',
  size: 1234,
  risk: 'safe',
  category: 'system',
  defaultSelected: true,
})

// ① 合法路径（位于真实回收站的 SID 目录下）+ dryRun：应返回 ok，且不会真的创建/删除任何文件
const dryPath = sampleSidDir
  ? `${sampleSidDir}\\$Rcordclean-dryrun-${Date.now()}.tmp`
  : `${env.drives[0] ?? 'C:'}\\$Recycle.Bin\\S-1-5-21-1-2-3-500\\$Rcordclean-dryrun.tmp`
const existedBefore = await exists(dryPath)
const dryResults = await cleanRecycleItems([makeItem(dryPath)], cleanCtx)
expect('dryRun 下合法项返回 ok', dryResults[0]?.ok === true, JSON.stringify(dryResults[0]))
expect('dryRun 下按扫描大小统计释放空间', dryResults[0]?.bytes === 1234, String(dryResults[0]?.bytes))
expect('dryRun 不产生任何文件', !existedBefore && !(await exists(dryPath)))

// ② 非回收站路径：安全阀必须拒绝
const guarded = await cleanRecycleItems(
  [
    makeItem('C:\\Windows\\System32\\drivers\\etc\\hosts'),
    makeItem(`${env.drives[0] ?? 'C:'}\\$Recycle.Bin\\$Rfake.db`),
    makeItem(`${env.drives[0] ?? 'C:'}\\$Recycle.Bin\\S-1-5-21-1-2-3-500\\nested\\$Rfake.db`),
    makeItem(`${env.drives[0] ?? 'C:'}\\$Recycle.Bin\\S-1-5-21-1-2-3-500\\$Ifake.db`),
  ],
  cleanCtx,
)
expect('拒绝回收站之外的路径', guarded[0]?.ok === false, guarded[0]?.error ?? '')
expect('拒绝 $Recycle.Bin 根目录下的文件（缺少 SID 目录）', guarded[1]?.ok === false, guarded[1]?.error ?? '')
expect('拒绝 SID 目录的孙级路径', guarded[2]?.ok === false, guarded[2]?.error ?? '')
expect('拒绝 $I 文件（只能以 $R 为入口）', guarded[3]?.ok === false, guarded[3]?.error ?? '')
for (const item of guarded) console.log('  ', item.ok ? 'ok' : 'refused', '→', item.path, '|', item.error)

await app.dispose()

/* ------------------------------------------------------------------ */

console.log('\n== 结论 ==')
if (failures.length) {
  console.log(`✗ 失败 ${failures.length} 项：${failures.join('、')}`)
  process.exitCode = 1
} else {
  console.log(`✓ recycle 自测全部通过（扫描 ${report.items.length} 项 / ${formatBytes(report.stats.bytes)} / ${report.elapsedMs} ms）`)
}
