/**
 * duplicates 插件自测脚本 —— **只执行 scan，绝不执行 clean**。
 *
 * 三轮验证（全部是小范围，秒级完成）：
 *   ① 临时夹具目录：验证「体积 → 头部 4096 字节 SHA-256 → 全量 SHA-256」三级策略、
 *      「保留修改时间最早者」的保留策略、上报字段契约；
 *   ② 工作区 `packages` 目录：真实小范围扫描，输出耗时与实际哈希文件数（论文性能数据）；
 *   ③ 夹具目录 + 候选上限 3：验证超出上限的候选只计数、不参与哈希。
 *
 * 运行：pnpm exec tsx scripts/check-duplicates.ts
 */
import { mkdir, readFile, readdir, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from '@cordclean/core'
import { formatBytes, formatDuration } from '@cordclean/shared'

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** 真实小范围扫描根：工作区的 packages 目录 */
const packagesRoot = path.join(workspace, 'packages')
const dataDir = path.join(os.tmpdir(), `cordclean-check-duplicates-${Date.now()}`)

const KB = 1024
/** 夹具里 3 份完全相同内容的大小 */
const GROUP_SIZE = 600 * KB
/** 第二级筛选读取的头部字节数（与插件实现保持一致） */
const SAMPLE_BYTES = 4096
/** 自测最小体积：1 KB（全局设置 sanitize 的下限） */
const MIN_SIZE = KB

const problems: string[] = []
function check(condition: boolean, message: string): void {
  if (!condition) problems.push(message)
}

/** 路径比较键（Windows 大小写不敏感） */
const key = (value: string): string => path.resolve(value).toLowerCase()

/** 从日志文件里收集插件打出的统计行 */
async function readSummaryLines(marker: string): Promise<string[]> {
  try {
    const dir = path.join(dataDir, 'logs')
    const lines: string[] = []
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.log')) continue
      const text = await readFile(path.join(dir, name), 'utf8')
      for (const line of text.split(/\r?\n/)) {
        if (line.includes(marker)) lines.push(line.trim())
      }
    }
    return lines
  } catch {
    return []
  }
}

interface Fixture {
  root: string
  /** 修改时间最早 → 应被保留的文件 */
  keep: string
  /** 应被作为「重复项」上报的两个副本 */
  duplicates: [string, string]
  /** 同体积但内容不同 → 第二级哈希后应被排除 */
  different: string
  /** 头部相同、尾部不同 → 第三级全量哈希后应被排除 */
  sameHead: [string, string]
  /** 低于最小体积 → 不应参与扫描 */
  small: [string, string]
}

/** 构造一个可精确预期结果的小夹具 */
async function buildFixture(): Promise<Fixture> {
  const root = path.join(os.tmpdir(), `cordclean-dup-fixture-${Date.now()}`)
  const nested = path.join(root, 'sub', 'deep')
  await mkdir(nested, { recursive: true })

  // ① 三份完全相同的内容，其中一份放在两层子目录里，顺便验证递归遍历
  const content = Buffer.alloc(GROUP_SIZE, 0x41)
  const a = path.join(root, 'a.bin')
  const b = path.join(root, 'sub', 'b.bin')
  const c = path.join(nested, 'c.bin')
  await writeFile(a, content)
  await writeFile(b, content)
  await writeFile(c, content)

  // ② 与上面同体积但内容不同：第一级放行、第二级（头部哈希）必须筛掉
  const different = path.join(root, 'different.bin')
  await writeFile(different, Buffer.alloc(GROUP_SIZE, 0x42))

  // ③ 前 4096 字节相同、尾部不同：第二级放行、第三级（全量哈希）必须排除
  const prefix = Buffer.alloc(SAMPLE_BYTES, 0x11)
  const head1 = path.join(root, 'head-1.bin')
  const head2 = path.join(root, 'head-2.bin')
  await writeFile(head1, Buffer.concat([prefix, Buffer.alloc(15_000, 0x21)]))
  await writeFile(head2, Buffer.concat([prefix, Buffer.alloc(15_000, 0x22)]))

  // ④ 低于最小体积的重复文件：不应参与扫描
  const small1 = path.join(root, 'small-1.bin')
  const small2 = path.join(root, 'small-2.bin')
  await writeFile(small1, Buffer.alloc(100, 0x7a))
  await writeFile(small2, Buffer.alloc(100, 0x7a))

  // ⑤ 修改时间：b 最早（保留项），a 居中，c 最晚（两人都应被上报为重复项）
  const base = Date.now() - 3_600_000
  await utimes(a, new Date(base + 30_000), new Date(base + 30_000))
  await utimes(b, new Date(base), new Date(base))
  await utimes(c, new Date(base + 60_000), new Date(base + 60_000))

  return { root, keep: b, duplicates: [a, c], different, sameHead: [head1, head2], small: [small1, small2] }
}

const fixture = await buildFixture()
console.log('夹具目录：', fixture.root)
console.log('保留项（修改时间最早）：', fixture.keep)

const app = await createApp({
  dataDir,
  logLevel: 'info',
  logForward: false,
  settingsOverrides: {
    analysis: { roots: [fixture.root] },
    scan: { duplicateMinSize: MIN_SIZE, duplicateMaxCandidates: 1000 },
  },
})

try {
  const plugin = app.ctx.plugins.list().find((item) => item.id === 'duplicates')
  console.log('已注册任务：', app.ctx.cleaner.list().map((task) => `${task.id}(${task.name})`).join('，'))
  console.log('插件状态：', plugin?.status, '当前配置：', JSON.stringify(plugin?.config))

  /* ---------------------------------------------------------------- */
  /* ① 夹具：三级策略 + 保留策略 + 字段契约                            */
  /* ---------------------------------------------------------------- */
  const report = await app.ctx.cleaner.scan({ taskIds: ['duplicates'] })
  const task = report.tasks.find((item) => item.taskId === 'duplicates')
  console.log(`\n=== ① 夹具目录（${formatBytes(GROUP_SIZE)} 三副本 + 同体积异内容 + 同头部异尾部）===`)
  console.log(`结果：${report.items.length} 项，合计 ${formatBytes(report.stats.bytes)}，扫描耗时 ${formatDuration(report.elapsedMs)}`)
  console.log(
    `遍历统计：文件 ${report.stats.files} 个 / 目录 ${report.stats.dirs} 个 / 错误 ${report.errors.length} 条 / 截断 ${report.stats.truncated}`,
  )
  console.log(`任务状态：${task ? `${task.taskId}=${task.status}，${task.items} 项，${task.elapsedMs} ms` : '缺失'}`)
  for (const item of report.items) {
    console.log(`  ${formatBytes(item.size).padStart(9)}  ${item.title}`)
    console.log(`  ${' '.repeat(9)}  ${item.path}`)
    console.log(`  ${' '.repeat(9)}  ${item.note} | meta=${JSON.stringify(item.meta)}`)
  }

  const summaries = await readSummaryLines('重复文件扫描统计')
  console.log('插件日志统计：')
  for (const line of summaries) console.log('  ' + line)
  const fixtureSummary = summaries[0] ?? ''
  const hashMatch = /短哈希 (\d+) 个，全量哈希 (\d+) 个/.exec(fixtureSummary)

  check(!!plugin && plugin.status === 'active', `插件未处于 active 状态：${plugin?.status} ${plugin?.error ?? ''}`)
  check(!!task && task.status === 'ok', `任务状态异常：${task?.status} ${task?.error ?? ''}`)
  check(!report.cancelled, '扫描被意外取消')
  check(report.items.length === 2, `期望恰好 2 个重复项（a.bin、c.bin），实际 ${report.items.length}`)
  const reportedPaths = new Set(report.items.map((item) => key(item.path)))
  check(reportedPaths.has(key(fixture.duplicates[0])), `缺少重复项：${fixture.duplicates[0]}`)
  check(reportedPaths.has(key(fixture.duplicates[1])), `缺少重复项：${fixture.duplicates[1]}`)
  check(!reportedPaths.has(key(fixture.keep)), '保留项（修改时间最早）不应被上报')
  check(!reportedPaths.has(key(fixture.different)), '同体积但内容不同的文件不应被误判为重复')
  check(!reportedPaths.has(key(fixture.sameHead[0])) && !reportedPaths.has(key(fixture.sameHead[1])), '头部相同但内容不同的文件不应被误判为重复')
  check(!reportedPaths.has(key(fixture.small[0])) && !reportedPaths.has(key(fixture.small[1])), '低于最小体积的文件不应参与重复检测')
  // 注意：内核 stats.files 统计的是「上报的清理项」，而不是遍历到的文件数
  check(report.items.length === 2, `重复项数量应为 2，实际 ${report.items.length}`)
  for (const item of report.items) {
    check(item.risk === 'caution', `风险等级应为 caution：${item.path}`)
    check(item.defaultSelected === false, `重复文件不应默认勾选：${item.path}`)
    check(item.kind === 'file', `kind 应为 file：${item.path}`)
    check(item.size === GROUP_SIZE, `体积应为 ${GROUP_SIZE}：${item.path}`)
    check(item.title === path.basename(item.path), `title 应为文件名：${item.title}`)
    check(key(String(item.meta?.original ?? '')) === key(fixture.keep), `meta.original 应为保留项：${String(item.meta?.original)}`)
    check(item.meta?.hashAlgorithm === 'sha256', `meta.hashAlgorithm 应为 sha256：${String(item.meta?.hashAlgorithm)}`)
    check(item.meta?.sizeGroup === GROUP_SIZE, `meta.sizeGroup 应为 ${GROUP_SIZE}：${String(item.meta?.sizeGroup)}`)
    check(typeof item.meta?.group === 'string' && item.meta.group.length > 0, `meta.group 缺失：${item.path}`)
    check((item.note ?? '').toLowerCase().includes(fixture.keep.toLowerCase()), `note 应写明与保留项重复：${String(item.note)}`)
    check((item.note ?? '').startsWith('与 '), `note 格式应为「与 <保留项路径> 重复」：${String(item.note)}`)
  }
  check(!!hashMatch, '未能从日志读到哈希统计（短哈希 / 全量哈希）')
  if (hashMatch) {
    check(Number(hashMatch[1]) === 6, `短哈希文件数应为 6（4 个 600KB + 2 个同头部文件），实际 ${hashMatch[1]}`)
    check(Number(hashMatch[2]) === 5, `全量哈希文件数应为 5（3 + 2，其中 2 个尾部不同被排除），实际 ${hashMatch[2]}`)
  }

  /* ---------------------------------------------------------------- */
  /* ② 工作区 packages 目录：真实小范围扫描，采集耗时/哈希量            */
  /* ---------------------------------------------------------------- */
  app.ctx.settings.patch({ analysis: { roots: [packagesRoot] }, scan: { duplicateMinSize: MIN_SIZE } })
  const realStartedAt = Date.now()
  const realReport = await app.ctx.cleaner.scan({ taskIds: ['duplicates'] })
  const realWallMs = Date.now() - realStartedAt
  const realSummary = (await readSummaryLines('重复文件扫描统计'))[1] ?? '（未读到统计行）'
  console.log(`\n=== ② 真实小范围扫描：${packagesRoot}（最小体积 ${formatBytes(MIN_SIZE)}）===`)
  console.log(`结果：${realReport.items.length} 项，合计 ${formatBytes(realReport.stats.bytes)}`)
  console.log(`扫描耗时：${formatDuration(realReport.elapsedMs)}（含启动/收尾的墙钟耗时 ${formatDuration(realWallMs)}）`)
  console.log(`遍历统计：文件 ${realReport.stats.files} 个 / 目录 ${realReport.stats.dirs} 个 / 错误 ${realReport.errors.length} 条`)
  console.log(`插件日志统计：${realSummary}`)
  for (const item of realReport.items.slice(0, 5)) console.log(`  ${formatBytes(item.size).padStart(9)}  ${item.path}`)
  check(!realReport.cancelled, '真实范围扫描被意外取消')
  check(
    realReport.tasks.every((item) => item.status === 'ok'),
    '真实范围扫描任务状态异常',
  )
  check(/短哈希 \d+ 个/.test(realSummary), '真实范围扫描未输出哈希统计行')

  /* ---------------------------------------------------------------- */
  /* ③ 候选上限：超出的候选只计数、不参与哈希                          */
  /* ---------------------------------------------------------------- */
  app.ctx.settings.patch({ analysis: { roots: [fixture.root] }, scan: { duplicateMaxCandidates: 3 } })
  const cappedReport = await app.ctx.cleaner.scan({ taskIds: ['duplicates'] })
  const cappedSummary = (await readSummaryLines('重复文件扫描统计'))[2] ?? ''
  console.log('\n=== ③ 候选上限（duplicateMaxCandidates=3）===')
  console.log(`结果：${cappedReport.items.length} 项，扫描耗时 ${formatDuration(cappedReport.elapsedMs)}`)
  console.log(`插件日志统计：${cappedSummary || '（未读到统计行）'}`)
  console.log(`错误/提示：${cappedReport.errors.map((item) => item.message).join(' | ') || '（无）'}`)
  check(cappedReport.items.length === 1, `上限=3 时应只剩 1 个重复项（a.bin），实际 ${cappedReport.items.length}`)
  check(
    cappedReport.errors.some((item) => item.message.includes('候选超过上限')),
    '未记录「候选超过上限」的提示',
  )
} finally {
  await app.dispose()
}

console.log('\n=== 自测结论 ===')
if (problems.length) {
  console.log(`❌ 发现 ${problems.length} 个问题：`)
  for (const problem of problems) console.log('  - ' + problem)
  process.exitCode = 1
} else {
  console.log('✅ 全部断言通过（仅扫描，未执行任何删除；夹具位于系统临时目录）')
}
