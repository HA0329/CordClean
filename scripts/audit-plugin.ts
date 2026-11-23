/**
 * 单插件审计（只读）：给「插件区逐个插件独立验证」用的最小工具。
 *
 *   pnpm exec tsx scripts/audit-plugin.ts <plugin-id>
 *
 * 做三件事：
 * 1. 加载内核与全部内置插件，找到该插件注册的清理任务；
 * 2. 逐任务真实扫描（不清理、不写用户数据，临时数据目录用完即删）；
 * 3. 校验清理项契约不变量（id 唯一 / path 非空 / size 合法 / risk·category·kind 合法 /
 *    受保护项不得默认勾选），有违例时退出码 1。
 *
 * 输出可直接作为「该插件真实可用」的证据行。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '@cordclean/core'
import { CATEGORIES, RISK_META } from '@cordclean/shared'
import type { CleanItem } from '@cordclean/shared'

const pluginId = (process.argv[2] ?? '').trim()
if (!pluginId) {
  console.error('用法：pnpm exec tsx scripts/audit-plugin.ts <plugin-id>')
  process.exit(2)
}

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cordclean-plugin-audit-'))
// 受控扫描根：把 large-files/duplicates/empty-dirs 这类按分析范围扫描的插件限制在临时沙箱，
// 避免审计时全盘遍历用户目录；沙箱里故意准备空目录/大文件/重复文件供插件命中。
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'cordclean-plugin-fixture-'))
writeFileSync(path.join(sandbox, 'big-1m.bin'), Buffer.alloc(1024 * 1024, 7))
writeFileSync(path.join(sandbox, 'dup-a.bin'), Buffer.alloc(256 * 1024, 3))
mkdirSync(path.join(sandbox, 'nested'), { recursive: true })
writeFileSync(path.join(sandbox, 'nested', 'dup-b.bin'), Buffer.alloc(256 * 1024, 3))
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
  settingsOverrides: { analysis: { roots: [sandbox] } },
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
