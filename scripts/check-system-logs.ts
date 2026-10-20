/**
 * [LEGACY 2026-10] system-logs 插件已随 commit 43cc831 退役（相关规则并入 rule-pack 的
 * system_logs 分类），本脚本仅作历史归档保留：检测到任务不存在时会打印提示并正常退出。
 *
 * system-logs 插件自检脚本。
 *
 * 只做扫描验证（scan），**不执行任何真实清理**。
 * 为了证明「解析与统计链路真的在工作」，脚本会先在
 * `%LOCALAPPDATA%\CrashDumps` 与 `%LOCALAPPDATA%\Microsoft\Windows\WER\ReportQueue`
 * 写入少量测试夹具（含 510 个 WER 小文件，用于触发「超过 500 条按目录聚合」分支），
 * 扫描完成后立即删除夹具，并再扫描一次展示本机真实结果。
 *
 * 用法：
 *   pnpm exec tsx scripts/check-system-logs.ts             # 含夹具
 *   pnpm exec tsx scripts/check-system-logs.ts --no-fixture # 只扫描真实环境
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { formatBytes, formatDuration } from '@cordclean/shared'
import type { CleanItem, ScanReport } from '@cordclean/shared'
import { createApp } from '@cordclean/core'

const USER_DATA = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
const CRASH_DUMPS_DIR = path.join(USER_DATA, 'CrashDumps')
const WER_QUEUE_DIR = path.join(USER_DATA, 'Microsoft', 'Windows', 'WER', 'ReportQueue')

const useFixture = !process.argv.includes('--no-fixture')
const tag = Math.random().toString(36).slice(2, 8)

/** 本次自检创建的夹具路径（收尾时逐个删除） */
const fixtures: string[] = []
/** 本次自检新建的目录（收尾时按深度倒序尝试删除） */
const createdDirs: string[] = []

/** 断言：不成立时抛错，让脚本以非 0 退出码结束 */
function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`自检失败：${message}`)
  console.log(`  ✓ ${message}`)
}

/** 逐级创建目录，并记录本次真正新建的层级，便于精确回收 */
async function ensureDir(dir: string): Promise<void> {
  const missing: string[] = []
  let current = path.resolve(dir)
  for (;;) {
    try {
      await fs.lstat(current)
      break
    } catch {
      missing.push(current)
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  await fs.mkdir(dir, { recursive: true })
  createdDirs.push(...missing)
}

/** 路径是否位于某个根目录之内（大小写不敏感） */
function inside(root: string, target: string): boolean {
  const normalize = (value: string) => value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  const base = normalize(root)
  const full = normalize(target)
  return full === base || full.startsWith(`${base}\\`)
}

/** 写入测试夹具 */
async function createFixtures(): Promise<void> {
  console.log(`\n[夹具] 在 ${CRASH_DUMPS_DIR} 与 ${WER_QUEUE_DIR} 写入测试文件`)
  await ensureDir(CRASH_DUMPS_DIR)
  const dumps: Array<[string, number]> = [
    ['-1.dmp', 64 * 1024],
    ['-2.dmp', 16 * 1024],
    ['-3.dmp', 4 * 1024],
  ]
  for (const [suffix, size] of dumps) {
    const file = path.join(CRASH_DUMPS_DIR, `cordclean-check-${tag}${suffix}`)
    await fs.writeFile(file, Buffer.alloc(size, 0x41))
    fixtures.push(file)
  }
  // 非 .dmp 文件不应被上报（验证 CrashDumps\*.dmp 过滤）
  const ignored = path.join(CRASH_DUMPS_DIR, `cordclean-check-${tag}.txt`)
  await fs.writeFile(ignored, 'not a dump')
  fixtures.push(ignored)

  await ensureDir(WER_QUEUE_DIR)
  for (const [suffix, size] of [['A', 4096], ['B', 8192]] as const) {
    const dir = path.join(WER_QUEUE_DIR, `CCCheck-${tag}-${suffix}`)
    await fs.mkdir(dir, { recursive: true })
    fixtures.push(dir)
    await fs.writeFile(path.join(dir, 'Report.wer'), Buffer.alloc(size, 0x42))
  }
  // 510 个 WER 文件 → 触发「条目超过 500 则按目录聚合」
  const bigRoot = path.join(WER_QUEUE_DIR, `CCBig-${tag}`)
  await fs.mkdir(bigRoot, { recursive: true })
  fixtures.push(bigRoot)
  for (const part of ['d1', 'd2', 'd3']) {
    const dir = path.join(bigRoot, part)
    await fs.mkdir(dir, { recursive: true })
    await Promise.all(
      Array.from({ length: 170 }, (_, index) =>
        fs.writeFile(path.join(dir, `he_${index}.wer`), Buffer.alloc(100, 0x43)),
      ),
    )
  }
  console.log(`  已写入 ${fixtures.length} 个夹具条目`)
}

/** 回收测试夹具 */
async function cleanupFixtures(): Promise<void> {
  for (const target of [...fixtures].sort((a, b) => b.length - a.length)) {
    await fs.rm(target, { recursive: true, force: true }).catch(() => {})
  }
  for (const dir of [...createdDirs].sort((a, b) => b.length - a.length)) {
    await fs.rmdir(dir).catch(() => {})
  }
  fixtures.length = 0
  createdDirs.length = 0
}

/** 打印一次扫描的关键信息 */
function printReport(label: string, report: ScanReport): void {
  console.log(`\n=== ${label} ===`)
  for (const task of report.tasks) {
    console.log(
      `  ${task.taskId}: status=${task.status} items=${task.items} bytes=${formatBytes(task.bytes)} 耗时=${formatDuration(task.elapsedMs)}`,
    )
  }
  console.log(
    `  合计: items=${report.items.length} files=${report.stats.files} dirs=${report.stats.dirs} bytes=${formatBytes(report.stats.bytes)} errors=${report.errors.length} 耗时=${formatDuration(report.elapsedMs)}`,
  )
  const top = [...report.items].sort((a, b) => b.size - a.size).slice(0, 8)
  for (const item of top) {
    const flags = [item.kind, item.risk, item.defaultSelected ? '默认勾选' : '默认不勾选', item.protected ? 'protected' : '']
      .filter(Boolean)
      .join(' / ')
    console.log(`    - [${flags}] ${formatBytes(item.size)}  ${item.path}`)
    if (item.note) console.log(`        note: ${item.note}`)
  }
  if (report.errors.length) {
    console.log('  前 5 条错误:')
    for (const error of report.errors.slice(0, 5)) {
      console.log(`    ! ${error.path} → ${error.message}`)
    }
  }
}

const allItems = (report: ScanReport, taskId: string): CleanItem[] =>
  report.items.filter((item) => item.taskId === taskId)

const dataDir = path.join(os.tmpdir(), `cordclean-check-system-logs-${Date.now()}`)
const app = await createApp({ dataDir, logLevel: 'warn' })
// [LEGACY] 对应插件已退役：任务缺失时直接提示退出（不写夹具、不产生真实副作用）。
if (!app.ctx.cleaner.list().some((task) => task.id === 'crash-dumps')) {
  console.log('LEGACY：system-logs 插件（crash-dumps/update-cache）已退役（43cc831），本自检脚本不再适用；仅作历史归档保留。')
  await app.dispose()
  process.exit(0)
}
console.log('=== CordClean 自检：system-logs ===')
console.log('dataDir =', dataDir)

const tasks = app.ctx.cleaner.list()
const crashTask = tasks.find((task) => task.id === 'crash-dumps')
const updateTask = tasks.find((task) => task.id === 'update-cache')

try {
  console.log('\n[任务注册]')
  check(!!crashTask, '任务 crash-dumps 已注册')
  check(!!updateTask, '任务 update-cache 已注册')
  check(crashTask?.name === '崩溃转储与错误报告', 'crash-dumps 名称正确')
  check(crashTask?.category === 'system' && crashTask?.risk === 'safe' && crashTask?.icon === '💥', 'crash-dumps 分类/风险/图标正确')
  check(crashTask?.defaultSelected === true, 'crash-dumps 默认勾选')
  check(updateTask?.name === '系统更新缓存与日志', 'update-cache 名称正确')
  check(updateTask?.category === 'system' && updateTask?.risk === 'caution' && updateTask?.icon === '🪵', 'update-cache 分类/风险/图标正确')
  check(updateTask?.defaultSelected === false, 'update-cache 默认不勾选')
  check((crashTask?.targets.length ?? 0) >= 4, 'crash-dumps 已声明 4 个以上扫描目标')
  check((updateTask?.targets.length ?? 0) >= 5, 'update-cache 已声明 5 个以上扫描目标')

  if (useFixture) await createFixtures()
  else console.log('\n[夹具] 已跳过（--no-fixture）')

  const first = await app.ctx.cleaner.scan({ taskIds: ['crash-dumps', 'update-cache'] })
  printReport(useFixture ? '阶段 1：扫描（含测试夹具）' : '阶段 1：扫描（真实环境）', first)

  console.log('\n[断言]')
  check(first.cancelled === false, '扫描未被取消')
  check(first.tasks.every((task) => task.status === 'ok'), '两个任务状态均为 ok（无异常终止）')
  check(!first.errors.some((error) => error.path.startsWith('task:')), '没有任务级错误')

  const crashItems = allItems(first, 'crash-dumps')
  const updateItems = allItems(first, 'update-cache')

  if (useFixture) {
    const dmpFixtures = fixtures.filter((file) => file.endsWith('.dmp'))
    const reported = new Set(crashItems.map((item) => item.path.toLowerCase()))
    check(dmpFixtures.length === 3 && dmpFixtures.every((file) => reported.has(file.toLowerCase())), '3 个测试 .dmp 文件全部被上报')
    check(![...reported].some((item) => item.endsWith('.txt')), '非 .dmp 文件未被上报（扩展名过滤生效）')
    check(
      crashItems.some((item) => item.kind === 'directory' && (item.note ?? '').includes('目录内')),
      'WER 文件超过 500 条后按目录聚合上报',
    )
    check(
      crashItems.filter((item) => item.kind === 'directory').every((item) => item.size > 0),
      '聚合后的目录项 size 为实际占用（folderSize/walk 统计生效）',
    )
    check(
      crashItems.every((item) => item.size > 0),
      '崩溃转储类清理项的 size 均为实际大小',
    )
  }
  check(crashItems.every((item) => item.risk === 'safe'), 'crash-dumps 项风险等级为 safe')
  check(crashItems.every((item) => ['file', 'directory'].includes(item.kind)), 'crash-dumps 只上报 file/directory 项')

  check(updateItems.every((item) => item.risk === 'caution' && item.defaultSelected === false), 'update-cache 项均为 caution 且默认不勾选')
  check(updateItems.every((item) => ['file', 'directory'].includes(item.kind)), 'update-cache 只上报 file/directory 项')
  check(updateItems.length <= 300, 'update-cache 条目数不超过 300')
  check(
    ![...crashItems, ...updateItems].some((item) => item.path.toLowerCase().includes('\\prefetch\\')),
    '未重复上报 %windir%\\Prefetch（由 temp 插件负责）',
  )
  const roots = [...(crashTask?.targets ?? []), ...(updateTask?.targets ?? [])]
  check(
    [...crashItems, ...updateItems].every((item) => roots.some((root) => inside(root, item.path))),
    '所有清理项都位于已声明的扫描目标之内',
  )
  check(
    [...crashItems, ...updateItems].every((item) => !roots.some((root) => item.path.toLowerCase() === root.toLowerCase())),
    '没有把来源根目录本身作为清理项（避免整目录误删）',
  )

  if (useFixture) {
    await cleanupFixtures()
    console.log('\n[夹具] 已清理')
    const second = await app.ctx.cleaner.scan({ taskIds: ['crash-dumps', 'update-cache'] })
    printReport('阶段 2：扫描（恢复真实环境）', second)
    console.log('\n[真实环境结果]')
    console.log(`  crash-dumps : items=${allItems(second, 'crash-dumps').length} bytes=${formatBytes(second.tasks.find((task) => task.taskId === 'crash-dumps')?.bytes ?? 0)}`)
    console.log(`  update-cache: items=${allItems(second, 'update-cache').length} bytes=${formatBytes(second.tasks.find((task) => task.taskId === 'update-cache')?.bytes ?? 0)}`)
    check(second.tasks.every((task) => task.status === 'ok'), '真实环境扫描同样无异常')
  }

  console.log('\n全部自检通过（未执行任何真实清理）')
} finally {
  // 无论断言是否失败，夹具都必须被清理
  if (fixtures.length) await cleanupFixtures()
  await app.dispose()
}
