/**
 * 插件扫描审计（只读）。
 *
 * 对全部内置插件执行一次真实扫描，并校验「清理项」的契约不变量：
 * - id 全局唯一、path 非空、size 为非负整数、risk/category/kind 合法；
 * - 受保护项必须 defaultSelected=false，且与路径策略的判定一致；
 * - 文件类项的路径必须是绝对路径，虚拟对象（注册表/计划任务）不受此限。
 *
 * **本脚本不执行任何清理动作**，也不会修改文件。
 *
 *   pnpm exec tsx scripts/audit-plugins.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '@cordclean/core'
import { CATEGORIES, RISK_META, formatBytes, formatDuration } from '@cordclean/shared'
import type { CleanItem } from '@cordclean/shared'

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cordclean-audit-'))
const violations: string[] = []
const seen = new Map<string, CleanItem>()

function check(condition: boolean, message: string) {
  if (!condition) violations.push(message)
}

const app = await createApp({ dataDir, logLevel: 'error' })
console.log(`内核启动 ${app.bootMs} ms，共 ${app.ctx.cleaner.list().length} 个任务，插件 ${app.ctx.plugins.list().length} 个\n`)

const KIND_SET = new Set(['file', 'directory', 'registry', 'command', 'entry'])

console.log('任务'.padEnd(16), '状态'.padEnd(10), '项数'.padStart(6), '体积'.padStart(10), '耗时'.padStart(9), '保护'.padStart(5))
console.log('-'.repeat(70))

for (const task of app.ctx.cleaner.list()) {
  // 逐任务扫描：避免单任务异常影响其它任务
  let report
  try {
    report = await app.ctx.cleaner.scan({ taskIds: [task.id] })
  } catch (error) {
    violations.push(`任务 ${task.id} 扫描抛错：${String(error)}`)
    continue
  }
  const result = report.tasks[0]
  if (!result || result.status !== 'ok') {
    violations.push(`任务 ${task.id} 状态异常：${result?.status} ${result?.error ?? ''}`)
  }

  const taskItems = report.items
  const protectedCount = taskItems.filter((item) => item.protected).length
  console.log(
    task.id.padEnd(16),
    (result?.status ?? 'error').padEnd(10),
    String(taskItems.length).padStart(6),
    formatBytes(report.stats.bytes).padStart(10),
    formatDuration(report.elapsedMs).padStart(9),
    String(protectedCount).padStart(5),
  )

  for (const item of taskItems) {
    const where = `${task.id}/${item.id}`
    check(!!item.id, `${where} 缺少 id`)
    check(!!item.path, `${where} 缺少 path`)
    check(KIND_SET.has(item.kind), `${where} 非法 kind=${item.kind}`)
    check(item.risk in RISK_META, `${where} 非法 risk=${item.risk}`)
    check(item.category in CATEGORIES, `${where} 非法 category=${item.category}`)
    check(item.taskId === task.id, `${where} taskId 不一致：${item.taskId}`)
    check(Number.isInteger(item.size) && item.size >= 0, `${where} 非法 size=${item.size}`)
    check(item.category === task.category, `${where} category 与任务不一致`)
    if (item.protected) {
      check(item.defaultSelected === false, `${where} 受保护项不应默认勾选`)
    }
    if (item.kind === 'file' || item.kind === 'directory') {
      check(/^[a-zA-Z]:\\/.test(item.path) || item.path.startsWith('\\\\'), `${where} 文件类路径不是绝对路径：${item.path}`)
      // 与路径策略二次核对：受保护标记必须与策略一致
      const policy = app.ctx.pathPolicy.check(item.path)
      check(policy.allowed === !item.protected, `${where} protected=${item.protected} 与策略判定(${policy.allowed}) 不一致`)
    }
    if (item.kind === 'directory') {
      check(!app.ctx.pathPolicy.containsProtected(item.path), `${where} 目录清理项包含受保护子目录`)
    }
    const existing = seen.get(item.id)
    if (existing) violations.push(`${where} id 重复：${existing.path} 与 ${item.path}`)
    else seen.set(item.id, item)
  }

  if (report.stats.truncated) console.log(`  ⚠ ${task.id} 结果被截断（达到 maxItemsPerTask 上限）`)
  if (report.errors.length) console.log(`  ⚠ ${task.id} 扫描错误 ${report.errors.length} 条，示例：${report.errors[0].message}`)
}

/* 全局去重检查（跨任务） */
const global = await app.ctx.cleaner.scan({})
const idCount = new Map<string, number>()
for (const item of global.items) idCount.set(item.id, (idCount.get(item.id) ?? 0) + 1)
for (const [id, count] of idCount) {
  if (count > 1) violations.push(`全局重复 id：${id} 出现 ${count} 次`)
}
check(global.items.length <= 200_000, `全量扫描项数异常：${global.items.length}`)

/* 结果汇总 */
console.log('-'.repeat(70))
console.log(`全量扫描：${global.items.length} 项，${formatBytes(global.stats.bytes)}，耗时 ${formatDuration(global.elapsedMs)}`)
console.log(`可清理（非保护）：${global.items.filter((item) => !item.protected).length} 项`)
console.log(`按风险分布：安全 ${global.items.filter((i) => i.risk === 'safe').length} / 谨慎 ${global.items.filter((i) => i.risk === 'caution').length} / 高风险 ${global.items.filter((i) => i.risk === 'risky').length}`)

if (violations.length) {
  console.log(`\n❌ 发现 ${violations.length} 个契约违规：`)
  for (const violation of violations.slice(0, 40)) console.log('  -', violation)
} else {
  console.log('\n✅ 全部清理项通过契约校验（未执行任何清理动作）')
}

await app.dispose()
rmSync(dataDir, { recursive: true, force: true })
process.exit(violations.length ? 1 : 0)
