/**
 * 冒烟测试：启动内核、加载插件、执行一次扫描（不分发清理）。
 * 用法：pnpm tsx scripts/smoke.ts
 */
import os from 'node:os'
import path from 'node:path'
import { formatBytes } from '@cordclean/shared'
import { createApp } from '@cordclean/core'

const dataDir = path.join(os.tmpdir(), 'cordclean-smoke-' + Date.now())

const app = await createApp({ dataDir, logLevel: 'warn' })
console.log('dataDir =', dataDir)
console.log('boot ms =', app.bootMs)
console.log('tasks =', app.ctx.cleaner.list().map((task) => `${task.id}(${task.name})`).join(', '))
console.log('plugins =')
for (const plugin of app.ctx.plugins.list()) {
  console.log(`  - ${plugin.id} [${plugin.status}] tasks=${plugin.tasks.length} ${plugin.error ?? ''}`)
}

const report = await app.ctx.cleaner.scan({ taskIds: ['temp'] })
console.log('scan:', {
  items: report.items.length,
  bytes: formatBytes(report.stats.bytes),
  files: report.stats.files,
  errors: report.errors.length,
  elapsed: report.elapsedMs,
})
console.log('top 5:')
for (const item of report.items.slice(0, 5)) {
  console.log('  ', formatBytes(item.size), item.path)
}

await app.dispose()
console.log('disposed ok')
