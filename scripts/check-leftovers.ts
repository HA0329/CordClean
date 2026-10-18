/**
 * leftovers 插件自测脚本。
 *
 * 只做「扫描」验证：所有清理逻辑只允许以 `dryRun: true` 预演，
 * 绝不执行真实清理（不删注册表、不删文件）。
 *
 * 用法：pnpm exec tsx scripts/check-leftovers.ts
 */
import os from 'node:os'
import path from 'node:path'
import { createApp } from '@cordclean/core'
import { formatBytes } from '@cordclean/shared'
import { collectUninstallEntries, detectResidual, findSuspectDirectories, UNINSTALL_ROOTS } from '@cordclean/plugin-leftovers'

const dataDir = path.join(os.tmpdir(), 'cordclean-check-leftovers-' + Date.now())
const app = await createApp({ dataDir, logLevel: 'warn' })
const env = app.ctx.system.env

console.log('=== leftovers 插件自测 ===')
console.log('数据目录 =', dataDir)
console.log('管理员权限 =', env.elevated, '| 系统盘 =', env.systemDrive)
console.log('卸载项注册表位置 =', UNINSTALL_ROOTS.length, '个')

/* 1. 直接验证注册表解析（不经过内核） */
const collection = await collectUninstallEntries()
console.log(`\n[1] 注册表卸载项：${collection.entries.length} 个（读取方式：${collection.source}）`)
for (const warning of collection.warnings) console.log('    警告：', warning)
const withChinese = collection.entries.filter((entry) => /[\u4e00-\u9fa5]/.test(entry.displayName + entry.publisher))
console.log(`    含中文的条目：${withChinese.length} 个`)
for (const entry of withChinese.slice(0, 5)) {
  console.log('      ·', entry.displayName, '|', entry.publisher, '|', entry.installLocation)
}
for (const entry of collection.entries.slice(0, 3)) {
  console.log('      ·样本:', entry.key, '|', entry.displayName || '(无 DisplayName)')
}

/* 2. 逐项判定残留（只读，仅做 lstat） */
let installDirMissing = 0
let uninstallerMissing = 0
const hints: Array<{ name: string; kind: string; detail: string; key: string }> = []
for (const entry of collection.entries) {
  const residual = await detectResidual(entry, env)
  if (!residual) continue
  if (residual.kind === 'install-dir') installDirMissing++
  else uninstallerMissing++
  hints.push({ name: entry.displayName || entry.key, kind: residual.kind, detail: residual.detail, key: entry.key })
}
console.log(`\n[2] 残留判定：A 类（安装目录缺失）${installDirMissing} 个 / B 类（卸载程序缺失）${uninstallerMissing} 个`)
for (const hint of hints.slice(0, 8)) {
  console.log(`      · [${hint.kind}] ${hint.name} → ${hint.detail}`)
}

/* 3. 疑似残留目录（只读；额外用「不限年龄」做一次诊断，验证过滤链路） */
const suspects = await findSuspectDirectories({ env, entries: collection.entries, maxItems: 10 })
const relaxed = await findSuspectDirectories({ env, entries: collection.entries, minAgeDays: 0, maxItems: 5 })
console.log(`\n[3] 疑似残留目录：${suspects.length} 个（≥180 天规则）`)
for (const item of suspects.slice(0, 5)) console.log(`      · ${item.path}（${item.ageDays} 天前修改，root=${item.root}）`)
console.log(`    诊断（不限年龄，仅验证过滤规则）命中 ${relaxed.length} 个：`)
for (const item of relaxed) console.log(`      · ${item.path}（${item.ageDays} 天前修改）`)

/* 4. 内核扫描 */
const startedAt = Date.now()
const report = await app.ctx.cleaner.scan({ taskIds: ['leftovers'] })
const scanMs = Date.now() - startedAt
console.log(`\n[4] 内核扫描：items=${report.items.length}，耗时 ${scanMs} ms（report.elapsedMs=${report.elapsedMs}），errors=${report.errors.length}`)
for (const task of report.tasks) {
  console.log(`    task=${task.taskId} status=${task.status} items=${task.items} elapsed=${task.elapsedMs}ms ${task.error ?? ''}`)
}
for (const error of report.errors.slice(0, 3)) console.log('    扫描错误：', error.path, '→', error.message)

const registryItems = report.items.filter((item) => item.kind === 'registry')
const directoryItems = report.items.filter((item) => item.kind === 'directory')
const protectedItems = report.items.filter((item) => item.protected)
console.log(`    其中注册表残留 ${registryItems.length} 个，目录提示 ${directoryItems.length} 个，受保护 ${protectedItems.length} 个`)
for (const item of report.items.slice(0, 10)) {
  console.log(`      · [${item.risk}] ${item.kind} 《${item.title}》 ${item.path} | ${item.note ?? ''} | protected=${item.protected ?? false}`)
}

/* 5. dryRun 预演（严禁真实清理） */
if (report.items.length) {
  const preview = await app.ctx.cleaner.clean({ items: report.items, dryRun: true })
  console.log(
    `\n[5] dryRun 预演：dryRun=${preview.dryRun} cleaned=${preview.cleaned} failed=${preview.failed} ` +
      `freed=${formatBytes(preview.freedBytes)} 耗时=${preview.elapsedMs}ms`,
  )
  for (const failure of preview.failures.slice(0, 3)) console.log('      预演失败：', failure.path, '→', failure.message)
  for (const task of preview.perTask) console.log(`      perTask ${task.taskId}: cleaned=${task.cleaned} failed=${task.failed}`)
} else {
  console.log('\n[5] dryRun 预演：本次没有扫描到清理项，跳过（扫描本身已真实执行）')
}

await app.dispose()
console.log('\n完成：已释放内核（未执行任何真实清理）')
