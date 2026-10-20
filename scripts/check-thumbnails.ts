/**
 * [LEGACY 2026-10] thumbnails 插件已随 commit 43cc831 退役（缩略图规则并入 rule-pack 的
 * extra_windows 分类），本脚本仅作历史归档保留：检测到任务不存在时会打印提示并正常退出。
 *
 * thumbnails 插件自测脚本（**只扫描，不执行真实清理**）。
 *
 * 验证五件事：
 *   1. 任务注册成功，路径辖区（pathPolicy）声明正确；
 *   2. `cleaner.scan({ taskIds: ['thumbnails'] })` 能列出本机真实缓存文件；
 *   3. 上报的每一项都真实存在、大小与磁盘一致、命中 thumbcache/iconcache/其它 .db 三类目标；
 *   4. 关闭 `includeIconCache` 后不再上报 iconcache_*.db（配置项生效）；
 *   5. 在受控临时目录（临时改写 LOCALAPPDATA）里验证目标分类、不递归子目录，
 *      以及「缓存目录不存在时返回 0 项且不报错」。
 *
 * 用法：pnpm exec tsx scripts/check-thumbnails.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { formatBytes } from '@cordclean/shared'
import type { ScanReport } from '@cordclean/shared'
import { createApp } from '@cordclean/core'
// 说明：tsconfig 的 paths 未映射 @cordclean/utils，脚本里用相对路径导入（只读工具函数）
import { exists, safeLstat } from '../packages/utils/src/index.ts'

const failures: string[] = []
function expect(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' —— ' + detail : ''}`)
  if (!ok) failures.push(name)
}

/** 打印一份扫描报告的关键信息 */
function printReport(title: string, report: ScanReport): void {
  console.log(`\n${title}`)
  console.log('扫描统计：', {
    items: report.items.length,
    bytes: formatBytes(report.stats.bytes),
    files: report.stats.files,
    errors: report.errors.length,
    truncated: report.stats.truncated,
    elapsed: `${report.elapsedMs} ms`,
  })
  console.log('任务结果：', report.tasks)
  if (report.errors.length) console.log('错误（前 5 条）：', report.errors.slice(0, 5))
  for (const item of report.items.slice(0, 8)) {
    console.log('  ', formatBytes(item.size), item.path, '|', item.note)
  }
  if (report.items.length > 8) console.log(`   ... 其余 ${report.items.length - 8} 项省略`)
}

/* ------------------------------------------------------------------ */
/* 一、默认配置扫描                                                    */
/* ------------------------------------------------------------------ */

const dataDir = path.join(os.tmpdir(), 'cordclean-check-thumbnails-' + Date.now())
const app = await createApp({ dataDir, logLevel: 'warn' })
// [LEGACY] 对应插件已退役：任务缺失时直接提示退出，避免误导性断言失败。
if (!app.ctx.cleaner.list().some((task) => task.id === 'thumbnails')) {
  console.log('LEGACY：thumbnails 插件已退役（43cc831），本自检脚本不再适用；仅作历史归档保留。')
  await app.dispose()
  process.exit(0)
}
const env = app.ctx.system.env
const cacheDir = `${env.localAppData}\\Microsoft\\Windows\\Explorer`

console.log('== 环境 ==')
console.log('dataDir =', dataDir)
console.log('缓存目录 =', cacheDir, '| 存在 =', await exists(cacheDir))
console.log('pathPolicy 辖区 =', app.ctx.pathPolicy.roots().filter((root) => root.includes('$recycle.bin') || root.includes('\\explorer')))

console.log('\n== 1. 任务注册检查 ==')
const descriptor = app.ctx.cleaner.list().find((item) => item.id === 'thumbnails')
console.log('任务描述：', descriptor)
expect('任务已注册', !!descriptor)
expect('名称为「缩略图缓存」', descriptor?.name === '缩略图缓存', descriptor?.name ?? '<missing>')
expect('分类为 system', descriptor?.category === 'system', descriptor?.category ?? '<missing>')
expect('风险为 caution', descriptor?.risk === 'caution', descriptor?.risk ?? '<missing>')
expect('图标为 🖼️', descriptor?.icon === '🖼️', descriptor?.icon ?? '<missing>')
expect('默认勾选', descriptor?.defaultSelected === true, String(descriptor?.defaultSelected))
expect('目标目录为 Explorer 缓存目录', descriptor?.targets.includes(cacheDir) === true, (descriptor?.targets ?? []).join(', '))
expect('已声明路径辖区', app.ctx.pathPolicy.roots().some((root) => root === cacheDir.toLowerCase()))

console.log('\n== 2. 内核扫描验证（不执行 clean） ==')
const report = await app.ctx.cleaner.scan({ taskIds: ['thumbnails'] })
printReport('扫描结果：', report)

const taskResult = report.tasks.find((item) => item.taskId === 'thumbnails')
expect('任务状态为 ok（不是 error/cancelled）', taskResult?.status === 'ok', taskResult?.status ?? '<missing>')
expect('扫描无错误', report.errors.length === 0, `${report.errors.length} 条错误`)
expect('无重复路径', new Set(report.items.map((item) => item.path.toLowerCase())).size === report.items.length)
expect('所有项都在 Explorer 缓存目录下', report.items.every((item) => item.path.toLowerCase().startsWith(cacheDir.toLowerCase() + '\\')))
expect('所有项都是 .db 缓存文件', report.items.every((item) => /\.db$/i.test(item.path)))
expect(
  '所有项要么是 thumbcache_ / iconcache_，要么是兜底 *.db',
  report.items.every((item) => /(?:^|\\)(?:thumbcache_|iconcache_[^\\]*\.db$)/i.test(item.path) || /\.db$/i.test(item.path)),
)
expect('所有项风险为 caution', report.items.every((item) => item.risk === 'caution'))
expect('所有项都带「重启资源管理器」提示', report.items.every((item) => item.note === '资源管理器正在使用该文件，删除失败时请重启资源管理器'))
expect('caution 项默认不勾选', report.items.every((item) => item.defaultSelected === false))

// 逐项核对磁盘上的真实文件：存在 + 大小一致
let verified = 0
for (const item of report.items) {
  const stat = await safeLstat(item.path)
  const ok = !!stat && stat.size === item.size
  if (!ok) failures.push(`文件核对失败：${item.path}`)
  if (ok) verified++
}
expect('所有项在磁盘上存在且大小一致', verified === report.items.length, `${verified}/${report.items.length}`)

// 如果本机存在缩略图缓存，则应上报；缓存目录为空时允许 0 项
const thumbCount = report.items.filter((item) => /\\thumbcache_/i.test(item.path)).length
const iconCount = report.items.filter((item) => /\\iconcache_/i.test(item.path)).length
const otherCount = report.items.length - thumbCount - iconCount
console.log(`分组：thumbcache=${thumbCount}，iconcache=${iconCount}，其它 .db=${otherCount}`)
expect('分组数量之和等于总项数', thumbCount + iconCount + otherCount === report.items.length)

/* ------------------------------------------------------------------ */
/* 二、配置项 includeIconCache=false 的扫描                            */
/* ------------------------------------------------------------------ */

console.log('\n== 3. 配置项验证：includeIconCache = false ==')
await app.dispose()

const app2 = await createApp({
  dataDir: path.join(os.tmpdir(), 'cordclean-check-thumbnails-nocicon-' + Date.now()),
  logLevel: 'warn',
  settingsOverrides: { plugins: { thumbnails: { config: { includeIconCache: false } } } },
})
const report2 = await app2.ctx.cleaner.scan({ taskIds: ['thumbnails'] })
printReport('扫描结果（关闭图标缓存清理）：', report2)
expect(
  '关闭 includeIconCache 后不再上报 iconcache_*.db',
  report2.items.every((item) => !/\\iconcache_/i.test(item.path)),
  report2.items.filter((item) => /\\iconcache_/i.test(item.path)).map((item) => item.path).join(', '),
)
expect('关闭 includeIconCache 后仍有缩略图缓存被上报或本机无缓存', report2.tasks[0]?.status === 'ok')
expect('关闭 iconcache 后项数不增加', report2.items.length <= report.items.length, `${report2.items.length} vs ${report.items.length}`)
await app2.dispose()

/* ------------------------------------------------------------------ */
/* 三、受控临时目录：三种目标分类 + 目录不存在时的空结果               */
/* ------------------------------------------------------------------ */

console.log('\n== 4. 受控临时目录自测（不触碰真实缓存） ==')
const originalLocalAppData = process.env.LOCALAPPDATA
const fakeLocal = await fs.mkdtemp(path.join(os.tmpdir(), 'cordclean-thumbnails-fake-'))
const fakeExplorer = path.join(fakeLocal, 'Microsoft', 'Windows', 'Explorer')
await fs.mkdir(fakeExplorer, { recursive: true })
// 三类目标各一个 + 一个非目标文件（用于验证 readdir 过滤）
await fs.writeFile(path.join(fakeExplorer, 'thumbcache_fake.db'), Buffer.alloc(1024, 1))
await fs.writeFile(path.join(fakeExplorer, 'iconcache_fake.db'), Buffer.alloc(2048, 2))
await fs.writeFile(path.join(fakeExplorer, 'other_cache.db'), Buffer.alloc(512, 3))
await fs.writeFile(path.join(fakeExplorer, 'notes.txt'), Buffer.alloc(100, 4))
await fs.mkdir(path.join(fakeExplorer, 'subdir'), { recursive: true })
await fs.writeFile(path.join(fakeExplorer, 'subdir', 'thumbcache_nested.db'), Buffer.alloc(999, 5))

process.env.LOCALAPPDATA = fakeLocal
const app3 = await createApp({ dataDir: path.join(os.tmpdir(), 'cordclean-check-thumbnails-fake-' + Date.now()), logLevel: 'warn' })
const report3 = await app3.ctx.cleaner.scan({ taskIds: ['thumbnails'] })
printReport('扫描结果（受控临时目录）：', report3)
const names3 = report3.items.map((item) => item.path.slice(fakeExplorer.length + 1)).sort()
expect('受控目录：上报 thumbcache_fake.db / iconcache_fake.db / other_cache.db 三项', names3.join(',') === 'iconcache_fake.db,other_cache.db,thumbcache_fake.db', names3.join(','))
expect('受控目录：非 .db 文件不被上报', !names3.includes('notes.txt'))
expect('受控目录：不递归进入子目录', !report3.items.some((item) => /subdir/i.test(item.path)))
expect(
  '受控目录：大小与磁盘一致',
  report3.items.find((item) => item.title === 'thumbcache_fake.db')?.size === 1024 &&
    report3.items.find((item) => item.title === 'iconcache_fake.db')?.size === 2048 &&
    report3.items.find((item) => item.title === 'other_cache.db')?.size === 512,
  report3.items.map((item) => `${item.title}=${item.size}`).join(', '),
)
expect('受控目录：扫描无错误', report3.errors.length === 0, JSON.stringify(report3.errors.slice(0, 3)))

// 关闭 iconcache 配置：只应剩 thumbcache_fake.db 与 other_cache.db
const app3b = await createApp({
  dataDir: path.join(os.tmpdir(), 'cordclean-check-thumbnails-fake-noicon-' + Date.now()),
  logLevel: 'warn',
  settingsOverrides: { plugins: { thumbnails: { config: { includeIconCache: false } } } },
})
const report3b = await app3b.ctx.cleaner.scan({ taskIds: ['thumbnails'] })
const names3b = report3b.items.map((item) => item.path.slice(fakeExplorer.length + 1)).sort()
expect('受控目录 + 关闭 iconcache：只剩 thumbcache 与兜底项', names3b.join(',') === 'other_cache.db,thumbcache_fake.db', names3b.join(','))

// 缓存目录不存在：应正常返回 0 项，而不是报错
const emptyLocal = await fs.mkdtemp(path.join(os.tmpdir(), 'cordclean-thumbnails-empty-'))
process.env.LOCALAPPDATA = emptyLocal
const app4 = await createApp({ dataDir: path.join(os.tmpdir(), 'cordclean-check-thumbnails-empty-' + Date.now()), logLevel: 'warn' })
const report4 = await app4.ctx.cleaner.scan({ taskIds: ['thumbnails'] })
printReport('扫描结果（缓存目录不存在）：', report4)
expect('缓存目录不存在时返回 0 项', report4.items.length === 0, String(report4.items.length))
expect('缓存目录不存在时任务状态仍为 ok', report4.tasks[0]?.status === 'ok', report4.tasks[0]?.status ?? '<missing>')
expect('缓存目录不存在时无错误', report4.errors.length === 0, String(report4.errors.length))

process.env.LOCALAPPDATA = originalLocalAppData
await app3.dispose()
await app3b.dispose()
await app4.dispose()
await fs.rm(fakeLocal, { recursive: true, force: true })
await fs.rm(emptyLocal, { recursive: true, force: true })
expect('临时目录已清理', !(await exists(fakeLocal)) && !(await exists(emptyLocal)))

/* ------------------------------------------------------------------ */

console.log('\n== 结论 ==')
if (failures.length) {
  console.log(`✗ 失败 ${failures.length} 项：${failures.join('、')}`)
  process.exitCode = 1
} else {
  console.log(
    `✓ thumbnails 自测全部通过（默认 ${report.items.length} 项 / ${formatBytes(report.stats.bytes)} / ${report.elapsedMs} ms；` +
      `关闭 iconcache 后 ${report2.items.length} 项；受控目录 ${report3.items.length} 项；目录不存在 ${report4.items.length} 项）`,
  )
}
