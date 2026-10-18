/**
 * registry 插件自测脚本。
 *
 * 只做「扫描」验证：清理逻辑只允许以 `dryRun: true` 预演，
 * 绝不执行真实清理（不导出/不删除任何注册表键）。
 *
 * 用法：pnpm exec tsx scripts/check-registry.ts
 */
import os from 'node:os'
import path from 'node:path'
import { createApp } from '@cordclean/core'
import { formatBytes } from '@cordclean/shared'
import { APP_PATH_ROOTS, probeRegistryProblems, UNINSTALL_ROOTS } from '@cordclean/plugin-registry'

const dataDir = path.join(os.tmpdir(), 'cordclean-check-registry-' + Date.now())
const app = await createApp({ dataDir, logLevel: 'warn' })
const env = app.ctx.system.env

console.log('=== registry 插件自测 ===')
console.log('数据目录 =', dataDir)
console.log('管理员权限 =', env.elevated, '（非管理员时插件只检查 HKCU）')
console.log('卸载项注册表位置 =', UNINSTALL_ROOTS.length, '个，App Paths 位置 =', APP_PATH_ROOTS.length, '个')

/* 1. 全量只读探测（含 HKLM；自测允许，因为完全只读） */
const full = await probeRegistryProblems(env, { includeHklm: true })
console.log(
  `\n[1] 全量只读探测（HKLM + HKCU）：检查卸载项 ${full.checkedUninstall} 个 → 无效 ${full.junkUninstall.length} 个；` +
    `检查 App Paths ${full.checkedAppPaths} 个 → 失效 ${full.brokenAppPaths.length} 个`,
)
for (const warning of full.warnings) console.log('    警告：', warning)
for (const junk of full.junkUninstall.slice(0, 8)) console.log(`      · 无效卸载项：${junk.key}（值数量 ${junk.valueCount}）`)
for (const broken of full.brokenAppPaths.slice(0, 8)) console.log(`      · 失效 App Paths：${broken.key} → ${broken.exe}`)

/* 2. 与插件实际扫描范围一致（非管理员自动降级为 HKCU） */
const scoped = await probeRegistryProblems(env)
console.log(
  `\n[2] 插件实际范围（${env.elevated ? 'HKLM + HKCU' : '仅 HKCU'}）：检查卸载项 ${scoped.checkedUninstall} 个 → 无效 ` +
    `${scoped.junkUninstall.length} 个；检查 App Paths ${scoped.checkedAppPaths} 个 → 失效 ${scoped.brokenAppPaths.length} 个`,
)

/* 3. 内核扫描 */
const startedAt = Date.now()
const report = await app.ctx.cleaner.scan({ taskIds: ['registry'] })
const scanMs = Date.now() - startedAt
console.log(`\n[3] 内核扫描：items=${report.items.length}，耗时 ${scanMs} ms（report.elapsedMs=${report.elapsedMs}），errors=${report.errors.length}`)
for (const task of report.tasks) {
  console.log(`    task=${task.taskId} status=${task.status} items=${task.items} elapsed=${task.elapsedMs}ms ${task.error ?? ''}`)
}
for (const error of report.errors.slice(0, 5)) console.log('    扫描错误：', error.path, '→', error.message)
for (const item of report.items.slice(0, 10)) {
  console.log(`      · [${item.risk}] ${item.kind} 《${item.title}》 ${item.path}`)
  console.log(`        note=${item.note ?? ''} | meta=${JSON.stringify(item.meta)} | defaultSelected=${item.defaultSelected}`)
}

/* 4. dryRun 预演（严禁真实清理） */
if (report.items.length) {
  const preview = await app.ctx.cleaner.clean({ items: report.items, dryRun: true })
  console.log(
    `\n[4] dryRun 预演：dryRun=${preview.dryRun} cleaned=${preview.cleaned} failed=${preview.failed} ` +
      `freed=${formatBytes(preview.freedBytes)} 耗时=${preview.elapsedMs}ms`,
  )
  for (const failure of preview.failures.slice(0, 3)) console.log('      预演失败：', failure.path, '→', failure.message)
  for (const task of preview.perTask) console.log(`      perTask ${task.taskId}: cleaned=${task.cleaned} failed=${task.failed}`)
} else {
  console.log('\n[4] dryRun 预演：本次扫描范围内没有可上报项（扫描本身已真实执行，见 [1][2] 的检查数量）')
}

await app.dispose()
console.log('\n完成：已释放内核（未导出、未删除任何注册表键）')
