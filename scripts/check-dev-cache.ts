/**
 * [LEGACY 2026-10] dev-cache 插件已随 commit 43cc831 退役（并入 rule-pack 开发缓存分类），
 * 本脚本仅作历史归档保留：检测到任务不存在时会打印提示并正常退出。
 *
 * dev-cache 插件自测脚本（只做扫描验证，不执行任何真实删除）。
 *
 * 验证内容：
 *  1. 插件能否被内核正常加载、两个任务（dev-cache / ide-cache）是否注册成功；
 *  2. 扫描能否产出结构正确的清理项（kind=directory、不被路径策略标记为 protected）；
 *  3. 配置开关是否生效（关闭某个来源后不再出现该来源的项）；
 *  4. 用 dryRun 预演一次清理，确认项 id 能被内核解析（不会删除任何文件）。
 *
 * 用法：pnpm exec tsx scripts/check-dev-cache.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '@cordclean/core'
import { formatBytes } from '@cordclean/shared'

/** 断言失败计数：全部跑完后以退出码体现结果 */
let failures = 0

function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`)
  } else {
    failures++
    console.log(`  ✗ ${message}`)
  }
}

/** 按 meta.source 分组统计 */
function groupBySource(items: Array<{ meta?: Record<string, unknown> }>): Map<string, number> {
  const groups = new Map<string, number>()
  for (const item of items) {
    const source = String(item.meta?.source ?? 'unknown')
    groups.set(source, (groups.get(source) ?? 0) + 1)
  }
  return groups
}

async function scanTask(
  app: Awaited<ReturnType<typeof createApp>>,
  taskId: string,
  label: string,
): Promise<Awaited<ReturnType<typeof app.ctx.cleaner.scan>>> {
  const startedAt = Date.now()
  const report = await app.ctx.cleaner.scan({ taskIds: [taskId] })
  const elapsed = Date.now() - startedAt
  const items = report.items.filter((item) => item.taskId === taskId)
  const taskResult = report.tasks.find((task) => task.taskId === taskId)

  console.log(`\n=== ${label}：${taskId} ===`)
  console.log(`  状态=${taskResult?.status ?? 'missing'}  项数=${items.length}  体积=${formatBytes(report.stats.bytes)}  目录统计=${report.stats.dirs}  错误=${report.errors.length}  耗时=${elapsed}ms`)
  console.log(`  来源分布：${[...groupBySource(items)].map(([source, count]) => `${source}=${count}`).join(', ') || '（无）'}`)
  console.log('  体积最大的 8 项：')
  for (const item of items.slice(0, 8)) {
    console.log(`    ${formatBytes(item.size).padStart(9)}  ${item.title}  (${item.path})  默认勾选=${item.defaultSelected}`)
  }
  for (const error of report.errors.slice(0, 5)) {
    console.log(`    ! ${error.path}  ${error.message}`)
  }

  // 结构性断言
  check(!!taskResult, `${taskId} 任务出现在扫描结果中`)
  if (taskResult) {
    check(taskResult.status === 'ok', `${taskId} 扫描状态为 ok（实际 ${taskResult.status}${taskResult.error ? '：' + taskResult.error : ''}）`)
  }
  check(items.length > 0, `${taskId} 扫描到清理项（本机若没有对应缓存目录则为 0）`)
  check(items.every((item) => item.kind === 'directory'), `${taskId} 所有清理项 kind 均为 directory`)
  check(items.every((item) => item.size >= 0), `${taskId} 所有清理项体积非负`)
  check(items.every((item) => !!item.title && !!item.path), `${taskId} 清理项均带 title 与 path`)
  const protectedItems = items.filter((item) => item.protected)
  check(protectedItems.length === 0, `${taskId} 没有被路径策略标记为 protected 的项（实际 ${protectedItems.length}）`)
  check(items.every((item) => item.defaultSelected === false), `${taskId} caution 风险项默认不勾选`)
  check(items.every((item) => typeof item.note === 'string' && item.note.length > 0), `${taskId} 清理项均带删除提示（note）`)
  if (taskId === 'dev-cache') {
    check(items.every((item) => item.note === '删除后下次安装依赖会重新下载'), `${taskId} 提示文案为「删除后下次安装依赖会重新下载」`)
  }

  return report
}

const dataDir = path.join(os.tmpdir(), 'cordclean-check-dev-cache-' + Date.now())
const app = await createApp({ dataDir, logLevel: 'warn' })
// [LEGACY] 对应插件已退役：任务缺失时直接提示退出，避免后续断言产生误导性失败。
if (!app.ctx.cleaner.list().some((task) => task.id === 'dev-cache')) {
  console.log('LEGACY：dev-cache/ide-cache 插件已退役（43cc831），本自检脚本不再适用；仅作历史归档保留。')
  await app.dispose()
  process.exit(0)
}
console.log('数据目录 =', dataDir)
console.log('内置任务 =', app.ctx.cleaner.list().map((task) => task.id).join(', '))

const plugin = app.ctx.plugins.list().find((item) => item.id === 'dev-cache')
console.log('dev-cache 插件状态 =', plugin ? `${plugin.status} tasks=${plugin.tasks.map((task) => task.id).join(',')}` : '未注册，查询失败')
check(!!plugin && plugin.status === 'active', 'dev-cache 插件状态为 active')
check(!!plugin && plugin.tasks.length === 2, 'dev-cache 插件注册了 2 个任务')
console.log('插件默认配置 =', JSON.stringify(plugin?.config ?? {}))

// 任务元信息（界面展示依赖这些字段）
const descriptors = app.ctx.cleaner.list()
const devTask = descriptors.find((task) => task.id === 'dev-cache')
const ideTask = descriptors.find((task) => task.id === 'ide-cache')
check(
  devTask?.name === '包管理器缓存' && devTask.category === 'dev' && devTask.risk === 'caution' && devTask.icon === '📦' && devTask.defaultSelected === true,
  'dev-cache 任务元信息符合规范（包管理器缓存 / dev / caution / 📦 / 默认选中）',
)
check(
  ideTask?.name === 'IDE 与构建缓存' && ideTask.category === 'dev' && ideTask.risk === 'caution' && ideTask.icon === '🧰' && ideTask.defaultSelected === true,
  'ide-cache 任务元信息符合规范（IDE 与构建缓存 / dev / caution / 🧰 / 默认选中）',
)

// ---------- 1. 默认配置下扫描两个任务 ----------
const packageReport = await scanTask(app, 'dev-cache', '包管理器缓存')

// 造一个假的 VS Code 扩展宿主临时目录，验证 %LOCALAPPDATA%\Temp\vscode-* 的 glob 来源与 self 上报模式
const vscodeFixture = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Temp', `vscode-cordclean-check-${Date.now()}`)
await fs.mkdir(path.join(vscodeFixture, 'logs'), { recursive: true })
await fs.writeFile(path.join(vscodeFixture, 'logs', 'exthost.log'), 'fixture', 'utf8')
console.log(`\n已创建临时夹具（用于验证 vscode-* 来源）：${vscodeFixture}`)
const ideReport = await scanTask(app, 'ide-cache', 'IDE 与构建缓存')
const vscodeItems = ideReport.items.filter((item) => item.meta?.source === 'vscodeTemp')
console.log(`  其中 vscode-* 来源项 = ${vscodeItems.length}`)
for (const item of vscodeItems) console.log(`    ${formatBytes(item.size)}  ${item.title}  ${item.path}`)
check(vscodeItems.length === 1, 'vscode-* glob 来源被正确识别（1 个夹具目录）')
check(
  vscodeItems.length === 0 || (vscodeItems[0].path.toLowerCase() === vscodeFixture.toLowerCase() && vscodeItems[0].size > 0),
  'vscode-* 来源以「目录本身」为清理项（self 模式），体积统计正确',
)
await fs.rm(vscodeFixture, { recursive: true, force: true }).catch(() => {})
console.log('  已删除临时夹具')

const packageSources = new Set(['npm', 'pnpm', 'yarn', 'pip', 'gradle', 'maven', 'go', 'cargo', 'conda'])
check(
  packageReport.items.every((item) => packageSources.has(String(item.meta?.source))),
  'dev-cache 任务的来源均在包管理器范围内',
)
check(
  packageReport.items.length <= 200 * packageSources.size,
  'dev-cache 任务没有超过「每个来源 200 项」的上限',
)
check(ideReport.items.length <= 100 * 6, 'ide-cache 任务没有超过「每个来源 100 项」的上限')

// ---------- 2. dryRun 预演：只验证清理项能被内核默认引擎受理，不会删除任何文件 ----------
const sample = packageReport.items.slice(0, 3)
if (sample.length) {
  const dryReport = await app.ctx.cleaner.clean({ items: sample, dryRun: true })
  console.log(`\n=== dryRun 预演（不会删除文件） ===`)
  console.log(`  dryRun=${dryReport.dryRun}  项数=${sample.length}  预计释放=${formatBytes(dryReport.freedBytes)}  失败=${dryReport.failed}`)
  check(dryReport.dryRun === true, 'dryRun 预演返回 dryRun=true')
  check(dryReport.failed === 0, 'dryRun 预演没有任何失败项')
}

await app.dispose()

// ---------- 3. 配置开关验证：关闭全部包管理器来源后，dev-cache 不应再产出项 ----------
const offConfig = {
  npm: false,
  pnpm: false,
  yarn: false,
  pip: false,
  gradle: false,
  maven: false,
  go: false,
  cargo: false,
  conda: false,
}
const dataDir2 = path.join(os.tmpdir(), 'cordclean-check-dev-cache-off-' + Date.now())
const appOff = await createApp({
  dataDir: dataDir2,
  logLevel: 'warn',
  settingsOverrides: { plugins: { 'dev-cache': { config: offConfig } } },
})
const offPlugin = appOff.ctx.plugins.list().find((item) => item.id === 'dev-cache')
check(offPlugin?.status === 'active', '关闭全部来源后插件仍能正常加载')
const offReport = await appOff.ctx.cleaner.scan({ taskIds: ['dev-cache'] })
console.log(`\n=== 配置开关验证（全部来源关闭） ===`)
console.log(`  项数=${offReport.items.length}  错误=${offReport.errors.length}`)
check(offReport.items.length === 0, '关闭全部来源后 dev-cache 不再产出清理项（配置开关生效）')
await appOff.dispose()

console.log(`\n结论：${failures === 0 ? '全部检查通过 ✅' : `${failures} 项检查未通过 ❌`}`)
if (failures > 0) process.exitCode = 1
