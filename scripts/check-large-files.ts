/**
 * large-files 插件自测脚本 —— **只执行 scan，绝不执行 clean**。
 *
 * 为什么不直接扫本机用户目录：全量遍历几十万文件耗时不可控，不适合作为自测。
 * 这里用 `createApp({ settingsOverrides })` 把扫描根限定到工作区的 `packages` 目录，
 * 再用插件配置把阈值降到 4 KB，好让这个小仓库里也能产生「大文件」结果。
 *
 * 两轮验证：
 *   ① `thresholdMb > 0`：覆盖全局阈值，验证 Top-N（最小堆替换）、体积排序、字段契约与目录排除；
 *   ② `thresholdMb = 0`：跟随全局设置（100 MB），验证小仓库下结果为空。
 *
 * 运行：pnpm exec tsx scripts/check-large-files.ts
 */
import { readFile, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from '@cordclean/core'
import { formatBytes, formatDuration } from '@cordclean/shared'

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** 自测扫描根：工作区的 packages 目录（小范围，秒级完成） */
const scanRoot = path.join(workspace, 'packages')
const dataDir = path.join(os.tmpdir(), `cordclean-check-large-files-${Date.now()}`)
/** 自测阈值：0.004 MB ≈ 4 KB，让仓库里的源码文件也能被判定为「大文件」 */
const THRESHOLD_MB = 0.004
const THRESHOLD_BYTES = Math.round(THRESHOLD_MB * 1024 * 1024)
const LIMIT = 20

const problems: string[] = []
function check(condition: boolean, message: string): void {
  if (!condition) problems.push(message)
}

/** 读取插件写入日志文件的行（日志同时会转发到界面「运行日志」） */
async function readPluginLogLines(pluginId: string): Promise<string[]> {
  try {
    const dir = path.join(dataDir, 'logs')
    const lines: string[] = []
    const names = (await readdir(dir)).filter((name) => name.endsWith('.log')).sort()
    for (const name of names) {
      const text = await readFile(path.join(dir, name), 'utf8')
      for (const line of text.split(/\r?\n/)) {
        if (line.includes(`[${pluginId}]`)) lines.push(line.trim())
      }
    }
    return lines
  } catch {
    return []
  }
}

/** 按「自上次调用以来新增」的方式取日志行，便于区分多轮扫描 */
let logCursor = 0
async function takePluginLogs(pluginId: string): Promise<string[]> {
  const all = await readPluginLogLines(pluginId)
  const fresh = all.slice(logCursor)
  logCursor = all.length
  return fresh
}

const app = await createApp({
  dataDir,
  logLevel: 'info',
  logForward: false,
  settingsOverrides: {
    analysis: { roots: [scanRoot] },
    plugins: { 'large-files': { config: { thresholdMb: THRESHOLD_MB, limit: LIMIT } } },
  },
})

try {
  const plugin = app.ctx.plugins.list().find((item) => item.id === 'large-files')
  console.log('已注册任务：', app.ctx.cleaner.list().map((task) => `${task.id}(${task.name})`).join('，'))
  console.log('插件状态：', plugin?.status, '当前配置：', JSON.stringify(plugin?.config))

  /* ---------------------------------------------------------------- */
  /* ① 插件配置覆盖阈值                                                */
  /* ---------------------------------------------------------------- */
  const report = await app.ctx.cleaner.scan({ taskIds: ['large-files'] })
  const task = report.tasks.find((item) => item.taskId === 'large-files')
  const logs = await takePluginLogs('large-files')
  const summary = logs.find((line) => line.includes('大文件扫描统计')) ?? ''
  console.log(`\n=== ① 覆盖阈值（thresholdMb=${THRESHOLD_MB}）===`)
  console.log(`扫描根：${scanRoot}`)
  console.log(`结果：${report.items.length} 项，合计 ${formatBytes(report.stats.bytes)}，扫描耗时 ${formatDuration(report.elapsedMs)}`)
  console.log(
    `统计：上报文件 ${report.stats.files} 个 / 遍历目录 ${report.stats.dirs} 个 / 错误 ${report.errors.length} 条 / 截断 ${report.stats.truncated}`,
  )
  console.log(`任务状态：${task ? `${task.taskId}=${task.status}，${task.items} 项，${task.elapsedMs} ms` : '缺失'}`)
  console.log('Top 10：')
  for (const item of report.items.slice(0, 10)) {
    console.log(`  ${formatBytes(item.size).padStart(9)}  ${item.note ?? ''}  ${item.path}`)
  }
  console.log('首项 meta：', JSON.stringify(report.items[0]?.meta))
  console.log('插件日志：')
  for (const line of logs) console.log('  ' + line)

  const hitMatch = /遍历 (\d+) 个条目.*?以上 (\d+) 个文件，上报 (\d+) 个/.exec(summary)

  check(!!plugin && plugin.status === 'active', `插件未处于 active 状态：${plugin?.status} ${plugin?.error ?? ''}`)
  check(!!task && task.status === 'ok', `任务状态异常：${task?.status} ${task?.error ?? ''}`)
  check(!report.cancelled, '扫描被意外取消')
  check(report.items.length > 0, '没有找到任何大文件（阈值可能仍然过高）')
  check(report.items.length <= LIMIT, `上报数量 ${report.items.length} 超过 limit=${LIMIT}`)
  check(report.stats.files === report.items.length, `引擎按项计数，stats.files 应等于上报项数：${report.stats.files} vs ${report.items.length}`)
  check(report.stats.dirs > 0, '没有遍历到任何子目录，扫描根可能选错了')
  check(!!hitMatch, '未能从日志读到「大文件扫描统计」行')
  if (hitMatch) {
    const traversed = Number(hitMatch[1])
    const hits = Number(hitMatch[2])
    const reported = Number(hitMatch[3])
    check(traversed > report.stats.dirs, `遍历条目数（${traversed}）应大于目录数（${report.stats.dirs}）`)
    check(reported === report.items.length, `日志上报数（${reported}）与结果数（${report.items.length}）不一致`)
    check(
      report.items.length === Math.min(hits, LIMIT),
      `Top-N 数量不符：命中 ${hits} 个、limit ${LIMIT}、实际上报 ${report.items.length}`,
    )
  }
  for (let i = 1; i < report.items.length; i++) {
    if (report.items[i - 1].size < report.items[i].size) problems.push('结果没有按体积从大到小排序')
  }
  for (const item of report.items) {
    check(item.risk === 'caution', `风险等级应为 caution：${item.path}`)
    check(item.defaultSelected === false, `大文件不应默认勾选：${item.path}`)
    check(item.kind === 'file', `kind 应为 file：${item.path}`)
    check(typeof item.note === 'string' && item.note.startsWith('修改于'), `note 缺少修改时间：${item.path}`)
    check(
      !!item.meta && typeof item.meta.mtime === 'number' && typeof item.meta.dir === 'string',
      `meta 字段不完整（需 mtime + dir）：${item.path}`,
    )
    check(item.size >= THRESHOLD_BYTES, `文件体积低于阈值：${item.path}`)
    check(item.path.toLowerCase().startsWith(scanRoot.toLowerCase()), `结果超出扫描根：${item.path}`)
    check(!/\\node_modules\\/i.test(item.path), `结果包含 node_modules 文件：${item.path}`)
    check(!/\\(\.git|\$Recycle\.Bin|System Volume Information)\\/i.test(item.path), `结果包含被排除目录：${item.path}`)
  }

  /* ---------------------------------------------------------------- */
  /* ② thresholdMb = 0 → 跟随全局设置（默认 100 MB）                    */
  /* ---------------------------------------------------------------- */
  await app.ctx.plugins.updateConfig('large-files', { thresholdMb: 0, limit: LIMIT })
  const followReport = await app.ctx.cleaner.scan({ taskIds: ['large-files'] })
  const followLogs = await takePluginLogs('large-files')
  const globalThreshold = app.ctx.settings.get().scan.largeFileThreshold
  console.log(`\n=== ② 跟随全局阈值（thresholdMb=0 → ${formatBytes(globalThreshold)}）===`)
  console.log(`结果：${followReport.items.length} 项，扫描耗时 ${formatDuration(followReport.elapsedMs)}`)
  console.log(`任务状态：${followReport.tasks.map((item) => `${item.taskId}=${item.status}`).join('，')}`)
  console.log('插件日志：')
  for (const line of followLogs) console.log('  ' + line)
  check(
    followReport.tasks.every((item) => item.status === 'ok'),
    '跟随全局阈值时任务状态异常',
  )
  check(
    followReport.items.length === 0,
    `本仓库不应出现 ${formatBytes(globalThreshold)} 以上的文件，实际 ${followReport.items.length} 项`,
  )
  check(
    followLogs.some((line) => line.includes(formatBytes(globalThreshold))),
    `跟随全局阈值时日志里应出现 ${formatBytes(globalThreshold)}`,
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
  console.log('✅ 全部断言通过（仅扫描，未执行任何删除）')
}
