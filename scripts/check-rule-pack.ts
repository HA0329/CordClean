/** 规则包自测：注册任务、扫描若干分类、打印结果（只读，不清理） */
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '@cordclean/core'
import { formatBytes, formatDuration } from '@cordclean/shared'

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cordclean-rulepack-'))
const app = await createApp({ dataDir, logLevel: 'warn' })

const tasks = app.ctx.cleaner.list()
const ruleTasks = tasks.filter((task) => task.id.startsWith('rule:'))
console.log(`任务总数 ${tasks.length}，其中规则包任务 ${ruleTasks.length}`)
console.log(`规则数：${app.ctx.rules.list().length}，分类：${app.ctx.rules.categories().length}`)
console.log('规则统计：', JSON.stringify(app.ctx.rules.stats()))

for (const task of ruleTasks.slice(0, 40)) {
  console.log(`  ${task.id.padEnd(34)} ${task.risk.padEnd(8)} ${task.name}`)
}

// 只扫描前 8 个安全分类，避免全量扫描太慢
const sample = ruleTasks.filter((task) => task.risk === 'safe').slice(0, 8).map((task) => task.id)
console.log(`\n扫描样本：${sample.join(', ')}`)
const report = await app.ctx.cleaner.scan({ taskIds: sample })
console.log(`扫描：${report.items.length} 项，${formatBytes(report.stats.bytes)}，耗时 ${formatDuration(report.elapsedMs)}，错误 ${report.errors.length}`)
for (const item of report.items.slice(0, 12)) {
  console.log(`  ${formatBytes(item.size).padStart(9)}  ${item.risk.padEnd(8)} ${item.path}`)
}
for (const task of report.tasks) {
  console.log(`  [task] ${task.taskId.padEnd(24)} ${task.status.padEnd(9)} items=${task.items} ${formatDuration(task.elapsedMs)}`)
}

// 校验"评估器给出建议"是否生效
const suggested = report.items.filter((item) => item.defaultSelected).length
console.log(`默认勾选（评估器建议）: ${suggested}/${report.items.length}`)

await app.dispose()
rmSync(dataDir, { recursive: true, force: true })
