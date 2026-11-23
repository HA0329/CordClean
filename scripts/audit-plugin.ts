/**
 * 单插件审计：给「插件区逐个插件独立验证」用的最小工具。
 *
 *   pnpm exec tsx scripts/audit-plugin.ts <plugin-id>            # 只读扫描审计
 *   pnpm exec tsx scripts/audit-plugin.ts <plugin-id> --clean    # 额外做沙箱内真实清理验证
 *
 * 做四件事：
 * 1. 加载内核与全部内置插件，找到该插件注册的清理任务；
 * 2. 逐任务真实扫描（不写用户数据，临时数据目录用完即删）；
 * 3. 校验清理项契约不变量（id 唯一 / path 非空 / size 合法 / risk·category·kind 合法 /
 *    受保护项不得默认勾选），有违例时退出码 1；
 * 4. `--clean`：把扫描结果里**落在审计沙箱内**的文件/目录强制走隔离区真实清理，
 *    复核清理后确实消失——破坏性链路验证，但绝不碰沙箱外的用户数据与回收站。
 *
 * 输出可直接作为「该插件真实可用」的证据行。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '@cordclean/core'
import { CATEGORIES, RISK_META } from '@cordclean/shared'
import type { CleanItem } from '@cordclean/shared'

const args = process.argv.slice(2)
const cleanMode = args.includes('--clean')
const pluginId = (args.find((arg) => !arg.startsWith('--')) ?? '').trim()
if (!pluginId) {
  console.error('用法：pnpm exec tsx scripts/audit-plugin.ts <plugin-id> [--clean]')
  process.exit(2)
}

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cordclean-plugin-audit-'))
// 受控扫描根：把 large-files/duplicates/empty-dirs 这类按分析范围扫描的插件限制在临时沙箱，
// 避免审计时全盘遍历用户目录；沙箱里故意准备空目录/大文件/重复文件供插件命中。
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'cordclean-plugin-fixture-'))
writeFileSync(path.join(sandbox, 'big-2m.bin'), Buffer.alloc(2 * 1024 * 1024, 7))
writeFileSync(path.join(sandbox, 'dup-a.bin'), Buffer.alloc(2 * 1024 * 1024, 3))
mkdirSync(path.join(sandbox, 'nested'), { recursive: true })
writeFileSync(path.join(sandbox, 'nested', 'dup-b.bin'), Buffer.alloc(2 * 1024 * 1024, 3))
mkdirSync(path.join(sandbox, 'empty-dir'), { recursive: true })
const violations: string[] = []
const seen = new Map<string, CleanItem>()
const KIND_SET = new Set(['file', 'directory', 'registry', 'command', 'entry'])
const RISK_SET = new Set(['safe', 'caution', 'risky'])
const CATEGORY_SET = new Set(Object.keys(CATEGORIES))

let exitCode = 0
const app = await createApp({
  dataDir,
  logLevel: 'error',
  settingsOverrides: { analysis: { roots: [sandbox] }, scan: { largeFileThreshold: 1024 * 1024 } },
})
try {
  const plugins = app.ctx.plugins.list()
  let plugin = plugins.find((item) => item.id === pluginId)
  if (!plugin) {
    console.error(`找不到插件：${pluginId}（可用：${plugins.map((item) => item.id).join(', ')}）`)
    exitCode = 2
  } else {
    // 默认禁用的插件（scheduler/shortcuts/ai/ai-workshop）先临时启用，既验证启用路径，也让它注册任务
    if (!plugin.enabled) {
      try {
        await app.ctx.plugins.enable(pluginId)
        console.log('（该插件默认禁用；审计时临时启用成功）')
        await new Promise((resolve) => setTimeout(resolve, 50))
      } catch (error) {
        violations.push(`启用插件失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    plugin = app.ctx.plugins.list().find((item) => item.id === pluginId) ?? plugin
    // 内置清理任务的 `pluginId` 统一是 builtin，无法按任务归属反查插件；
    // 插件运行时信息里带有它注册的任务清单（plugin.tasks），按这个交集取。
    const pluginTaskIds = new Set((plugin.tasks ?? []).map((task) => task.id))
    const tasks = app.ctx.cleaner.list().filter((task) => pluginTaskIds.has(task.id))
    console.log(`插件 ${plugin.id}（${plugin.name} v${plugin.version}）：状态=${plugin.status}，任务=${tasks.length}，可配置=${plugin.configurable}`)
    if (!tasks.length) {
      console.log('（该插件不注册清理任务，可能只提供界面/服务贡献；审计看插件状态即可）')
    }
    let totalItems = 0
    let totalBytes = 0
    let totalErrors = 0
    for (const task of tasks) {
      const startedAt = Date.now()
      let report: Awaited<ReturnType<typeof app.ctx.cleaner.scan>>
      try {
        report = await app.ctx.cleaner.scan({ taskIds: [task.id] })
      } catch (error) {
        violations.push(`任务 ${task.id} 扫描抛错：${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      const result = report.tasks[0]
      const items = report.items
      totalItems += items.length
      totalBytes += items.reduce((sum, item) => sum + (Number(item.size) || 0), 0)
      totalErrors += report.errors.length
      for (const item of items) {
        if (seen.has(item.id)) violations.push(`重复 id：${item.id}（任务 ${task.id}）`)
        seen.set(item.id, item)
        if (!item.path) violations.push(`空 path：${item.id}（任务 ${task.id}）`)
        if (!Number.isInteger(item.size) || item.size < 0) violations.push(`非法 size：${item.id}=${item.size}（任务 ${task.id}）`)
        if (!RISK_SET.has(item.risk)) violations.push(`非法 risk：${item.id}=${item.risk}`)
        if (!CATEGORY_SET.has(item.category as string)) violations.push(`非法 category：${item.id}=${item.category}`)
        if (!KIND_SET.has(item.kind)) violations.push(`非法 kind：${item.id}=${item.kind}`)
        if (item.protected && item.defaultSelected) violations.push(`受保护项默认勾选：${item.path}`)
        if ((item.kind === 'file' || item.kind === 'directory') && !/^[a-zA-Z]:[\\/]/.test(item.path)) {
          violations.push(`文件类路径不是绝对路径：${item.path}`)
        }
      }
      const status = result?.status ?? 'ok'
      console.log(
        `  ✓ ${task.id.padEnd(22)} ${status.padEnd(8)} 项=${String(items.length).padStart(6)} 错=${String(report.errors.length).padStart(3)} 耗时=${Date.now() - startedAt}ms`,
      )
    }
    console.log(
      `汇总：任务 ${tasks.length}，清理项 ${totalItems}，体积 ${(totalBytes / 1024 / 1024).toFixed(1)} MB，扫描错误 ${totalErrors}，契约违例 ${violations.length}`,
    )

    /* ---------------- 破坏性验证（仅限审计沙箱，强制隔离区） ---------------- */
    if (cleanMode) {
      if (!tasks.length) {
        console.log('清理验证：该插件不注册清理任务（跳过破坏性验证）')
      } else {
        // clean(itemIds) 只认「最近一次扫描结果」，因此对所有任务重扫一次再取沙箱项
        let fullScan: Awaited<ReturnType<typeof app.ctx.cleaner.scan>>
        try {
          fullScan = await app.ctx.cleaner.scan({ taskIds: tasks.map((task) => task.id) })
        } catch (error) {
          violations.push(`清理验证前的汇总扫描失败：${error instanceof Error ? error.message : String(error)}`)
          fullScan = { items: [] } as unknown as typeof fullScan
        }
        const sandboxRoot = path.resolve(sandbox)
        const sandboxPrefix = sandboxRoot + path.sep
        const targets = fullScan.items
          .filter((item) => {
            if (item.kind !== 'file' && item.kind !== 'directory') return false
            if (item.protected) return false
            const resolved = path.resolve(item.path)
            return resolved === sandboxRoot || resolved.startsWith(sandboxPrefix)
          })
          .slice(0, 200)
        if (!targets.length) {
          console.log('清理验证：本次扫描没有落入审计沙箱且可清理的文件/目录（跳过破坏性验证）')
        } else {
          const report = await app.ctx.cleaner.clean({
            itemIds: targets.map((item) => item.id),
            dryRun: false,
            // 强制隔离区：文件最终落在临时 dataDir（审计结束删除），不污染用户回收站
            forceQuarantine: true,
          })
          const remaining = targets.filter((item) => existsSync(item.path))
          console.log(
            `清理验证：提交 ${targets.length} 项 → cleaned=${report.cleaned} quarantined=${report.quarantined} failed=${report.failed} skipped=${report.skipped} mode=${report.mode} dryRun=${report.dryRun}`,
          )
          if (report.dryRun) violations.push('清理验证请求了真实清理（dryRun=false），但报告仍是预演')
          if (report.failed > 0) {
            violations.push(
              `真实清理失败 ${report.failed} 项：${report.failures
                .slice(0, 3)
                .map((failure) => `${failure.path}（${failure.message}）`)
                .join('；')}`,
            )
          }
          if (!report.cleaned && !report.quarantined) violations.push('提交了沙箱清理项，但没有任何成功清理/隔离')
          if (remaining.length) {
            violations.push(`真实清理后沙箱内仍有 ${remaining.length} 项存在：${remaining.slice(0, 3).map((item) => item.path).join('；')}`)
          }
          console.log(`清理后复核：沙箱内目标剩余 ${remaining.length} 项（应为 0）`)
        }
      }
    }
  }
} finally {
  await app.dispose()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

if (violations.length) {
  console.error('\n契约违例：')
  for (const violation of violations.slice(0, 30)) console.error('  - ' + violation)
  exitCode = 1
}
process.exit(exitCode)
