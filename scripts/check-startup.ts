/**
 * startup 插件自检脚本。
 *
 * 只做两件事：
 * 1. `scan` —— 验证注册表 / 启动文件夹 / 计划任务的扫描与上报格式；
 * 2. `clean({ dryRun: true })` —— 验证自定义清理逻辑在预演模式下「只返回 ok」，
 *    并用 reg.exe 直查证明注册表值没有被删除、backups 目录没有被创建。
 *
 * **绝不执行真实清理**（真实清理会删除本机启动项）。
 *
 * 用法：pnpm exec tsx scripts/check-startup.ts
 */
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { formatBytes, formatDuration } from '@cordclean/shared'
import type { CleanItem, ScanReport } from '@cordclean/shared'
import { createApp } from '@cordclean/core'

const execFileAsync = promisify(execFile)

/** 断言：不成立时抛错，让脚本以非 0 退出码结束 */
function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`自检失败：${message}`)
  console.log(`  ✓ ${message}`)
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target)
    return true
  } catch {
    return false
  }
}

/** 被检查的注册表启动项键（与插件声明的来源保持一致） */
const REGISTRY_KEYS = [
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\RunOnce',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\RunOnce',
]

/**
 * 直接用 reg.exe 列出某个键下的值名，用于和插件的解析结果交叉验证。
 * 这里独立实现（不复用插件内部函数），才能证明「真实解析成功」而不是自证。
 */
async function directValueNames(key: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('reg.exe', ['query', key], {
      windowsHide: true,
      timeout: 15_000,
      encoding: 'utf8',
    })
    const names: string[] = []
    for (const rawLine of String(stdout).split(/\r?\n/)) {
      const line = rawLine.trim()
      const match = /^(.+?)\s{2,}REG_[A-Z_]+\s{2,}/.exec(line)
      if (!match) continue
      const name = match[1].trim()
      // reg.exe 无法按值名删除默认值，插件会跳过这类条目
      if (!name || name === '(Default)' || name === '(默认)') continue
      names.push(name)
    }
    return names
  } catch {
    return []
  }
}

const countsByKey = async (): Promise<Map<string, number>> => {
  const entries = await Promise.all(
    REGISTRY_KEYS.map(async (key) => [key, (await directValueNames(key)).length] as const),
  )
  return new Map(entries)
}

/** 直接调用 reg.exe（不复用插件内部实现，用于独立验证备份/清理命令的语义） */
async function runReg(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('reg.exe', args, {
      windowsHide: true,
      timeout: 20_000,
      encoding: 'utf8',
    })
    return { ok: true, stdout: String(stdout), stderr: String(stderr) }
  } catch (error) {
    return { ok: false, stdout: '', stderr: String(error) }
  }
}

/** 与插件一致的时间戳格式：20250101-120000 */
function formatStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return [
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
  ].join('-')
}

function printReport(report: ScanReport): void {
  const groups: Array<[string, CleanItem[]]> = [
    ['registry（注册表启动项）', report.items.filter((item) => item.kind === 'registry')],
    ['file（启动文件夹）', report.items.filter((item) => item.kind === 'file')],
    ['entry（计划任务）', report.items.filter((item) => item.kind === 'entry')],
  ]
  for (const [label, items] of groups) {
    console.log(`  ${label}: ${items.length} 项，合计 ${formatBytes(items.reduce((sum, item) => sum + item.size, 0))}`)
  }
  const registryItems = groups[0][1]
  if (registryItems.length) {
    console.log('  注册表项明细：')
    for (const item of registryItems.slice(0, 10)) {
      console.log(`    - ${item.meta?.hive} / ${item.meta?.keyPath}`)
      console.log(`      值名=${item.meta?.valueName}  meta.command=${item.meta?.command}`)
      console.log(`      path=${item.path}`)
      console.log(`      risk=${item.risk} defaultSelected=${item.defaultSelected} note=${JSON.stringify(item.note)}`)
    }
  }
  const taskItems = groups[2][1]
  if (taskItems.length) {
    console.log('  计划任务样例：')
    for (const item of taskItems.slice(0, 3)) {
      console.log(`    - ${item.path}  (${String(item.meta?.state)}) note=${JSON.stringify(item.note)}`)
    }
  }
}

const dataDir = path.join(os.tmpdir(), `cordclean-check-startup-${Date.now()}`)
const app = await createApp({ dataDir, logLevel: 'warn' })
console.log('=== CordClean 自检：startup ===')
console.log('dataDir =', dataDir)

try {
  const task = app.ctx.cleaner.list().find((item) => item.id === 'startup')
  console.log('\n[任务注册]')
  check(!!task, '任务 startup 已注册')
  check(task?.name === '启动项', '任务名称为「启动项」')
  check(task?.category === 'startup', '分类为 startup')
  check(task?.risk === 'caution', '风险等级为 caution')
  check(task?.icon === '🚀', '图标为 🚀')
  check(task?.defaultSelected === false, '默认不勾选')
  check(task?.requiresAdmin === true, '声明需要管理员权限')
  check(
    JSON.stringify(task?.tips) ===
      JSON.stringify(['禁用前会自动导出注册表备份到数据目录 backups 文件夹', '误删可从 .reg 备份恢复']),
    'tips 文案与规范一致',
  )

  const defaults = await app.ctx.plugins.defaults('startup')
  console.log('  配置默认值 =', JSON.stringify(defaults))
  check(defaults.includeHklm === true, '配置 includeHklm 默认 true')
  check(defaults.includeScheduledTasks === true, '配置 includeScheduledTasks 默认 true')
  check(defaults.backupDir === '', '配置 backupDir 默认空字符串')

  console.log('\n[扫描]')
  const report = await app.ctx.cleaner.scan({ taskIds: ['startup'] })
  printReport(report)
  console.log(
    `  合计 ${report.items.length} 项 · ${formatBytes(report.stats.bytes)} · 耗时 ${formatDuration(report.elapsedMs)} · 错误 ${report.errors.length} 条`,
  )
  if (report.errors.length) {
    for (const error of report.errors.slice(0, 5)) console.log(`    ! ${error.path} → ${error.message}`)
  }

  console.log('\n[断言：扫描]')
  check(report.cancelled === false, '扫描未被取消')
  const taskResult = report.tasks.find((item) => item.taskId === 'startup')
  check(taskResult?.status === 'ok', '任务状态为 ok（真实解析而非异常终止）')
  check(!report.errors.some((error) => error.path === 'task:startup'), '没有任务级错误')

  const registryItems = report.items.filter((item) => item.kind === 'registry')
  const fileItems = report.items.filter((item) => item.kind === 'file')
  const entryItems = report.items.filter((item) => item.kind === 'entry')

  console.log('\n[断言：注册表启动项格式]')
  const metaOf = (item: CleanItem) => (item.meta ?? {}) as Record<string, unknown>
  check(registryItems.every((item) => item.size === 0), '注册表项 size 均为 0')
  check(registryItems.every((item) => item.risk === 'caution' && item.defaultSelected === false), '注册表项为 caution 且默认不勾选')
  check(
    registryItems.every((item) => item.path === `${String(metaOf(item).keyPath)}\\${String(metaOf(item).valueName)}`),
    '注册表项 path 形如 HKEY_...\\Run\\<值名>',
  )
  check(
    registryItems.every((item) => {
      const meta = metaOf(item)
      return (
        typeof meta.command === 'string' &&
        typeof meta.hive === 'string' &&
        meta.hive.startsWith('HKEY_') &&
        typeof meta.keyPath === 'string' &&
        meta.keyPath.startsWith('HKEY_') &&
        typeof meta.valueName === 'string'
      )
    }),
    '注册表项 meta 包含 command / hive / keyPath / valueName',
  )
  check(registryItems.every((item) => (item.note ?? '').length <= 120), '注册表项 note 截断到 120 字符以内')

  // 与 reg.exe 直查结果交叉验证：数量与值名必须一致
  console.log('\n[断言：注册表解析与 reg.exe 直查一致]')
  // 注册表键路径大小写不敏感，比较时统一转小写
  const keyOf = (value: unknown) => String(value ?? '').toLowerCase()
  const expected = await countsByKey()
  let expectedTotal = 0
  for (const [key, count] of expected) {
    const actual = registryItems.filter((item) => keyOf(metaOf(item).keyPath) === keyOf(key)).length
    expectedTotal += count
    check(actual === count, `${key.replace('HKEY_LOCAL_MACHINE', 'HKLM').replace('HKEY_CURRENT_USER', 'HKCU')}：插件 ${actual} 项 / reg.exe ${count} 项`)
    const directNames = (await directValueNames(key)).map((name) => name.toLowerCase()).sort()
    const parsedNames = registryItems
      .filter((item) => keyOf(metaOf(item).keyPath) === keyOf(key))
      .map((item) => String(metaOf(item).valueName).toLowerCase())
      .sort()
    check(
      directNames.length === parsedNames.length && directNames.every((name, index) => name === parsedNames[index]),
      `值名与 reg.exe 输出一致（${directNames.join(', ') || '该键为空'}）`,
    )
  }
  console.log(`  本机注册表启动项合计 ${expectedTotal} 项（0 项表示本机确实没有配置）`)

  console.log('\n[断言：启动文件夹与计划任务格式]')
  check(fileItems.every((item) => path.isAbsolute(item.path)), '启动文件夹项 path 为真实绝对路径')
  check(fileItems.every((item) => item.risk === 'caution' && item.defaultSelected === false), '启动文件夹项为 caution 且默认不勾选')
  check(fileItems.every((item) => item.size >= 0), '启动文件夹项 size 为实际大小（>= 0）')
  if (!fileItems.length) console.log('  （本机启动文件夹没有快捷方式，0 项属于正常结果）')
  check(entryItems.every((item) => item.path.startsWith('task:\\')), '计划任务 path 以 task:\\ 开头')
  check(entryItems.every((item) => item.risk === 'risky' && item.defaultSelected === false), '计划任务为 risky 且默认不勾选')
  check(entryItems.every((item) => item.note === '计划任务请在系统工具中管理'), '计划任务 note 为提示文案')
  if (!entryItems.length) console.log('  （Get-ScheduledTask 未返回可读取的任务）')

  // dryRun 清理验证：只返回 ok，不产生任何副作用
  console.log('\n[备份能力探测：只导出 .reg 备份，不修改注册表]')
  const backupDir = path.join(dataDir, 'backups')
  const hklmRunKey = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run'
  const probeFile = path.join(backupDir, `startup-${formatStamp(new Date())}-HKLM-Run.reg`)
  await fs.mkdir(backupDir, { recursive: true })
  const exported = await runReg(['export', hklmRunKey, probeFile, '/y'])
  check(exported.ok, `reg export 备份命令可用（${path.basename(probeFile)}）`)
  if (exported.ok) {
    // .reg 文件为 UTF-16LE，解码后应包含每个值名与命令行
    const content = await fs.readFile(probeFile, 'utf16le')
    const hklmItems = registryItems.filter((item) => keyOf(metaOf(item).keyPath) === hklmRunKey.toLowerCase())
    check(
      hklmItems.every((item) => content.includes(String(metaOf(item).valueName))),
      `备份文件包含全部 ${hklmItems.length} 个 HKLM 启动项值`,
    )
    check(content.includes('Windows Registry Editor Version 5.00'), '备份文件是标准 .reg 格式（可直接双击恢复）')
  }
  await fs.rm(backupDir, { recursive: true, force: true })
  check(!(await exists(backupDir)), '备份探测文件已清理')

  console.log('\n[预演清理 dryRun: true（唯一的清理相关验证，不会真正删除）]')
  const beforeCounts = await countsByKey()
  check(!(await exists(backupDir)), '清理前 backups 目录不存在')
  const targets = report.items.filter((item) => !item.protected)
  if (targets.length) {
    const dry = await app.ctx.cleaner.clean({ items: report.items, dryRun: true })
    console.log(
      `  dryRun 结果：cleaned=${dry.cleaned} failed=${dry.failed} freedBytes=${dry.freedBytes} 耗时=${formatDuration(dry.elapsedMs)}`,
    )
    check(dry.dryRun === true, '清理报告标记 dryRun=true')
    check(dry.cleaned === targets.length && dry.failed === 0, '所有项在预演中返回 ok（含计划任务项）')
    check(dry.freedBytes === 0, '预演未统计任何释放字节')
    check(!(await exists(backupDir)), '预演未创建 backups 目录（未执行 regExport）')
    const afterCounts = await countsByKey()
    check(
      [...beforeCounts].every(([key, count]) => afterCounts.get(key) === count),
      '预演后注册表值数量不变（未执行 regDeleteValue）',
    )
  } else {
    console.log('  没有可清理项，跳过 dryRun 验证')
  }

  console.log('\n自检通过：启动项扫描与预演清理均正常，未执行真实清理')
} finally {
  await app.dispose()
}
