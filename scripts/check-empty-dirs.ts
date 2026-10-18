/**
 * empty-dirs 插件自测脚本（只做扫描验证，不执行任何真实删除）。
 *
 * 验证内容：
 *  1. 用临时目录搭一棵「已知答案」的目录树，断言空目录判定完全正确：
 *     - 嵌套全空目录只上报最外层；
 *     - 含文件的目录不上报，但其下的空子目录要上报；
 *     - node_modules / .git 里的空目录不上报；
 *     - 符号链接 / NTFS 联接点不进入、不上报；
 *     - 超过 maxDepth 的空目录链默认不上报，调大 maxDepth 后上报最外层；
 *  2. limit 截断：超过上限时只上报 limit 项，并通过 addError 给出说明；
 *  3. 扫描本机真实默认范围（%LOCALAPPDATA% + Downloads），验证性能、健壮性与路径策略交互。
 *
 * 用法：pnpm exec tsx scripts/check-empty-dirs.ts
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '@cordclean/core'
import type { App } from '@cordclean/core'
import { formatBytes } from '@cordclean/shared'

let failures = 0

function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`)
  } else {
    failures++
    console.log(`  ✗ ${message}`)
  }
}

/** 路径不区分大小写比较（Windows 语义） */
function samePath(a: string, b: string): boolean {
  return a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase()
}

interface ScanItem {
  path: string
  depth?: number
  protected?: boolean
}

interface ScanOutcome {
  items: ScanItem[]
  errors: Array<{ path: string; message: string }>
  elapsedMs: number
  stats: { dirs: number; bytes: number; files: number }
  app: App
}

/** 启动内核并只扫描 empty-dirs 任务（扫描完由调用方负责 dispose） */
async function scanEmptyDirs(roots: string[], pluginConfig?: Record<string, unknown>): Promise<ScanOutcome> {
  const dataDir = path.join(os.tmpdir(), `cordclean-check-empty-dirs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const app = await createApp({
    dataDir,
    logLevel: 'warn',
    settingsOverrides: {
      analysis: { roots },
      ...(pluginConfig ? { plugins: { 'empty-dirs': { config: pluginConfig } } } : {}),
    },
  })
  const plugin = app.ctx.plugins.list().find((item) => item.id === 'empty-dirs')
  check(plugin?.status === 'active', `empty-dirs 插件加载成功（status=${plugin?.status}）`)

  const startedAt = Date.now()
  const report = await app.ctx.cleaner.scan({ taskIds: ['empty-dirs'] })
  const elapsedMs = Date.now() - startedAt
  const items = report.items
    .filter((item) => item.taskId === 'empty-dirs')
    .map((item) => ({ path: item.path, depth: item.meta?.depth as number | undefined, protected: item.protected }))
  return { items, errors: report.errors, elapsedMs, stats: report.stats, app }
}

/**
 * 搭建「已知答案」的测试目录树。
 *
 * 默认配置（maxDepth=8、limit=3000）下的期望：
 *   a-empty                → 上报
 *   b-nested               → 上报（c-empty / d-empty 也空，但只上报最外层）
 *   e-with-file/f-empty    → 上报（父目录含 keep.txt，所以 f-empty 是「独立」空目录）
 *   g-skip/node_modules/** → 不上报（跳过的目录名）
 *   h-git/.git/**          → 不上报（跳过的目录名）
 *   i-deep/level1..level10 → 不上报（深度超过 8）
 *   j-junction             → 不上报（NTFS 联接点）
 *   k-target-empty         → 上报
 */
async function buildFixture(root: string): Promise<{ expected: ScanItem[]; junctionCreated: boolean }> {
  await fs.mkdir(path.join(root, 'a-empty'), { recursive: true })
  await fs.mkdir(path.join(root, 'b-nested', 'c-empty', 'd-empty'), { recursive: true })

  await fs.mkdir(path.join(root, 'e-with-file', 'f-empty'), { recursive: true })
  await fs.writeFile(path.join(root, 'e-with-file', 'keep.txt'), 'hello', 'utf8')

  await fs.mkdir(path.join(root, 'g-skip', 'node_modules', 'pkg-empty'), { recursive: true })
  await fs.mkdir(path.join(root, 'h-git', '.git', 'objects'), { recursive: true })

  let deep = path.join(root, 'i-deep')
  for (let index = 1; index <= 10; index++) deep = path.join(deep, `level${index}`)
  await fs.mkdir(deep, { recursive: true })

  await fs.mkdir(path.join(root, 'k-target-empty'), { recursive: true })
  let junctionCreated = false
  try {
    // 联接点（junction）在 Windows 上不需要管理员权限，用来验证「绝不跟随链接」
    await fs.symlink(path.join(root, 'k-target-empty'), path.join(root, 'j-junction'), 'junction')
    junctionCreated = (await fs.lstat(path.join(root, 'j-junction'))).isSymbolicLink()
  } catch {
    junctionCreated = false
  }

  return {
    expected: [
      { path: path.join(root, 'a-empty'), depth: 1 },
      { path: path.join(root, 'b-nested'), depth: 1 },
      { path: path.join(root, 'e-with-file', 'f-empty'), depth: 2 },
      { path: path.join(root, 'k-target-empty'), depth: 1 },
    ],
    junctionCreated,
  }
}

/** 断言扫描结果与期望集合完全一致 */
function checkSet(items: ScanItem[], expected: ScanItem[], label: string): void {
  const actualKeys = items.map((item) => item.path.toLowerCase()).sort()
  const expectedKeys = expected.map((item) => item.path.toLowerCase()).sort()
  const ok = actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index])
  check(ok, `${label}：上报集合与期望完全一致（实际 ${items.length} 项 / 期望 ${expected.length} 项）`)
  if (!ok) {
    console.log('    实际：')
    for (const item of items) console.log(`      [depth=${item.depth}] ${item.path}`)
    console.log('    期望：')
    for (const item of expected) console.log(`      [depth=${item.depth}] ${item.path}`)
  }
}

const fixtureRoot = path.join(os.tmpdir(), `cordclean-empty-dirs-fixture-${Date.now()}`)
const manyRoot = path.join(os.tmpdir(), `cordclean-empty-dirs-many-${Date.now()}`)

try {
  /* ------------------------------------------------------------------ */
  /* 1. 夹具树：默认配置（maxDepth=8）                                    */
  /* ------------------------------------------------------------------ */
  console.log('\n=== 用例 1：夹具树 + 默认配置（maxDepth=8） ===')
  const fixture = await buildFixture(fixtureRoot)
  console.log(`  夹具根 = ${fixtureRoot}`)
  console.log(`  联接点创建结果 = ${fixture.junctionCreated ? '成功（参与断言）' : '失败/非链接（跳过相关断言）'}`)
  const case1 = await scanEmptyDirs([fixtureRoot])
  console.log(`  项数=${case1.items.length}  目录统计=${case1.stats.dirs}  错误=${case1.errors.length}  耗时=${case1.elapsedMs}ms`)
  for (const item of case1.items) console.log(`    [depth=${item.depth}] ${item.path}`)
  for (const error of case1.errors) console.log(`    ! ${error.path}  ${error.message}`)
  checkSet(case1.items, fixture.expected, '默认配置')
  check(case1.items.every((item) => !samePath(item.path, fixtureRoot)), '扫描根自身不会被上报')
  check(case1.items.every((item) => (item.depth ?? 0) >= 1), '上报的目录深度均 ≥ 1')
  check(!case1.items.some((item) => item.path.toLowerCase().includes('node_modules')), 'node_modules 下的空目录被跳过')
  check(!case1.items.some((item) => item.path.toLowerCase().includes('\\.git')), '.git 下的空目录被跳过')
  check(!case1.items.some((item) => item.path.toLowerCase().includes('level1')), '超过 maxDepth 的空目录链未被上报')
  check(!case1.items.some((item) => item.path.toLowerCase().includes('j-junction')), '联接点本身未被上报（未跟随链接）')
  check(
    !case1.items.some((item) => item.path.toLowerCase().includes('k-target-empty\\')),
    '联接点目标没有被「穿过链接」重复计入',
  )
  const allAreRealDirs = (
    await Promise.all(
      case1.items.map(async (item) => {
        try {
          return (await fs.lstat(item.path)).isDirectory()
        } catch {
          return false
        }
      }),
    )
  ).every(Boolean)
  check(allAreRealDirs, '上报的每一项都是真实存在的目录')
  await case1.app.dispose()

  /* ------------------------------------------------------------------ */
  /* 2. 夹具树：调大 maxDepth，深链应上报最外层                           */
  /* ------------------------------------------------------------------ */
  console.log('\n=== 用例 2：夹具树 + maxDepth=20（深链应上报最外层） ===')
  const case2 = await scanEmptyDirs([fixtureRoot], { maxDepth: 20 })
  console.log(`  项数=${case2.items.length}  错误=${case2.errors.length}  耗时=${case2.elapsedMs}ms`)
  for (const item of case2.items) console.log(`    [depth=${item.depth}] ${item.path}`)
  const expected2 = [...fixture.expected, { path: path.join(fixtureRoot, 'i-deep'), depth: 1 }]
  checkSet(case2.items, expected2, 'maxDepth=20')
  check(
    !case2.items.some((item) => item.path.toLowerCase().includes('\\level1')),
    '深链只上报最外层的 i-deep，不重复上报中间层',
  )
  await case2.app.dispose()

  /* ------------------------------------------------------------------ */
  /* 3. limit 截断                                                       */
  /* ------------------------------------------------------------------ */
  console.log('\n=== 用例 3：limit=5 截断 ===')
  for (let index = 0; index < 20; index++) {
    await fs.mkdir(path.join(manyRoot, `empty-${String(index).padStart(2, '0')}`), { recursive: true })
  }
  const case3 = await scanEmptyDirs([manyRoot], { limit: 5 })
  console.log(`  项数=${case3.items.length}  错误=${case3.errors.length}`)
  for (const item of case3.items) console.log(`    ${item.path}`)
  for (const error of case3.errors) console.log(`    ! ${error.path}  ${error.message}`)
  check(case3.items.length === 5, '超过 limit 时只上报 limit 项')
  check(
    case3.errors.some((error) => error.message.includes('上限')),
    '截断时通过 addError 给出了说明',
  )
  await case3.app.dispose()

  /* ------------------------------------------------------------------ */
  /* 4. 真实目录：默认扫描范围（%LOCALAPPDATA% + Downloads）              */
  /* ------------------------------------------------------------------ */
  console.log('\n=== 用例 4：本机真实默认范围（只扫描，不删除） ===')
  const realDataDir = path.join(os.tmpdir(), `cordclean-check-empty-dirs-real-${Date.now()}`)
  const realApp = await createApp({ dataDir: realDataDir, logLevel: 'warn' })
  const realPlugin = realApp.ctx.plugins.list().find((item) => item.id === 'empty-dirs')
  const emptyDirsTask = realApp.ctx.cleaner.list().find((task) => task.id === 'empty-dirs')
  console.log(`  插件状态=${realPlugin?.status}`)
  console.log('  任务描述 =', JSON.stringify({ id: emptyDirsTask?.id, name: emptyDirsTask?.name, risk: emptyDirsTask?.risk, targets: emptyDirsTask?.targets }))
  const realStartedAt = Date.now()
  const realReport = await realApp.ctx.cleaner.scan({ taskIds: ['empty-dirs'] })
  const realElapsed = Date.now() - realStartedAt
  const realItems = realReport.items
  const protectedItems = realItems.filter((item) => item.protected)
  console.log(
    `  项数=${realItems.length}  目录统计=${realReport.stats.dirs}  体积=${formatBytes(realReport.stats.bytes)}  错误=${realReport.errors.length}  耗时=${realElapsed}ms`,
  )
  console.log(`  其中被内核路径策略标记为 protected 的项 = ${protectedItems.length}（默认范围含受保护的「下载」目录）`)
  console.log('  前 5 项：')
  for (const item of realItems.slice(0, 5)) console.log(`    ${formatBytes(item.size)}  ${item.path}${item.protected ? '  [受保护]' : ''}`)
  for (const error of realReport.errors.slice(0, 5)) console.log(`    ! ${error.path}  ${error.message}`)
  check(realElapsed < 60_000, `真实目录扫描在 60 秒内完成（实际 ${realElapsed}ms）`)
  check(realItems.length <= 3000, `真实目录扫描结果不超过默认上限 3000（实际 ${realItems.length}）`)
  check(realItems.every((item) => item.kind === 'directory'), '真实目录扫描的所有项 kind 均为 directory')
  check(realItems.every((item) => item.size === 0), '空目录项体积均为 0')
  check(realItems.every((item) => item.risk === 'safe'), '空目录项 risk 均为 safe')
  check(
    realItems.every((item) => item.protected === true || item.defaultSelected === true),
    '空目录项默认勾选（被内核标记为受保护的项除外，它们不可勾选）',
  )
  await realApp.dispose()
} finally {
  // 清理自建的临时测试目录（与插件清理逻辑无关，仅保持环境整洁）
  for (const dir of [fixtureRoot, manyRoot]) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

console.log(`\n结论：${failures === 0 ? '全部检查通过 ✅' : `${failures} 项检查未通过 ❌`}`)
if (failures > 0) process.exitCode = 1
