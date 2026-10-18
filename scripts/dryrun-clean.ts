/**
 * 真实环境「预演清理」验证（绝对不删除文件）。
 *
 * 做三件事：
 * 1. 全量扫描真实系统；
 * 2. 用默认勾选执行一次 `dryRun` 清理（只统计，不落盘、不写历史）；
 * 3. 抽查被预演涉及的路径是否仍然存在，证明预演没有副作用。
 *
 *   pnpm exec tsx scripts/dryrun-clean.ts
 */
import { existsSync, lstatSync } from 'node:fs'
import { createApp } from '@cordclean/core'
import { formatBytes, formatDuration } from '@cordclean/shared'
import { deletePath } from '@cordclean/utils'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync } from 'node:fs'

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cordclean-dryrun-'))
const app = await createApp({ dataDir, logLevel: 'error' })

const scan = await app.ctx.cleaner.scan({})
const selectable = scan.items.filter((item) => item.defaultSelected && !item.protected)
console.log(`扫描：${scan.items.length} 项，${formatBytes(scan.stats.bytes)}，耗时 ${formatDuration(scan.elapsedMs)}`)
console.log(`默认勾选（可预演清理）：${selectable.length} 项，${formatBytes(selectable.reduce((sum, item) => sum + item.size, 0))}`)

// 记录抽查点
const samples = selectable.filter((item) => item.kind === 'file').slice(0, 30)
const before = samples.map((item) => ({ path: item.path, exists: existsSync(item.path), size: safeSize(item.path) }))

const historyBefore = app.ctx.history.totals().sessions
const report = await app.ctx.cleaner.clean({ dryRun: true })
const historyAfter = app.ctx.history.totals().sessions

const changed = before.filter((item) => existsSync(item.path) !== item.exists || safeSize(item.path) !== item.size)

console.log('')
console.log(`预演结果：dryRun=${report.dryRun}，可清理 ${report.cleaned} 项，预计释放 ${formatBytes(report.freedBytes)}，失败 ${report.failed}`)
console.log(`历史记录：预演前 ${historyBefore} 条 → 预演后 ${historyAfter} 条（预演不应写入历史）`)
console.log(`抽查 ${before.length} 个文件，发生变化的：${changed.length} 个`)
if (changed.length) {
  for (const item of changed) console.log('  ✗', item.path)
}

const ok = report.dryRun && changed.length === 0 && historyBefore === historyAfter
console.log(ok ? '\n✅ 预演无任何副作用（未删除文件、未写历史）' : '\n❌ 预演存在副作用，请检查')

await app.dispose()
await deletePath(dataDir, { recursive: true }).catch(() => {})
process.exit(ok ? 0 : 1)

function safeSize(target: string): number {
  try {
    const stat = lstatSync(target)
    return stat.isFile() ? stat.size : -1
  } catch {
    return -1
  }
}
