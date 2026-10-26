/**
 * Web 外壳入口：
 *   pnpm dev:web        # 启动内核 + 本地 HTTP/WS 服务，浏览器访问提示的地址
 *
 * 与 Electron 外壳共享同一套内核、RPC 方法与前端界面，
 * 差异仅在于「系统交互适配器」与「进程模型」。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from '@cordclean/core'
import { createHandlers, startHostServer, type ShellAdapter } from '@cordclean/host'
import { runCommand } from '@cordclean/utils'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')
const staticDir = process.env.CORDCLEAN_UI_DIR ?? path.join(repoRoot, 'packages', 'ui', 'dist')

/** 浏览器外壳的系统交互实现（Windows） */
const shell: ShellAdapter = {
  electron: false,
  async openPath(target: string) {
    // 在资源管理器中「定位」目标（/select, 语义）；execFile 参数数组不经 shell，
    // 路径里的 & | ^ 等字符不会被 cmd 二次解析，避免命令注入
    await runCommand('explorer.exe', ['/select,', target], { timeout: 15_000 })
  },
  async openDataDir(target: string) {
    await runCommand('explorer.exe', [target], { timeout: 15_000 })
  },
}

const app = await createApp({
  dataDir: process.env.CORDCLEAN_DATA,
  logLevel: (process.env.CORDCLEAN_LOG as any) ?? 'info',
  logForward: true,
})

// 崩溃/未处理拒绝也写入统一日志（避免进程“悄悄”退出后没有线索）
process.on('uncaughtException', (error) => {
  app.ctx.logger.error('未捕获异常：' + (error?.stack ?? String(error)))
})
process.on('unhandledRejection', (reason) => {
  const text = reason instanceof Error ? reason.stack ?? reason.message : String(reason)
  app.ctx.logger.error('未处理的 Promise 拒绝：' + text)
})

const handlers = createHandlers({
  ctx: app.ctx,
  dataDir: app.dataDir,
  version: app.version,
  bootMs: app.bootMs,
  shell,
})

const server = await startHostServer({
  ctx: app.ctx,
  handlers,
  staticDir,
  dataDir: app.dataDir,
  port: process.env.CORDCLEAN_PORT ? Number(process.env.CORDCLEAN_PORT) : 7801,
})

console.log('')
console.log('  ╭──────────────────────────────────────────────╮')
console.log('  │  CordClean 已启动                             │')
console.log('  ╰──────────────────────────────────────────────╯')
console.log(`  界面地址: ${server.url}`)
console.log(`  RPC 地址: ${server.wsUrl}`)
console.log(`  数据目录: ${app.dataDir}`)
console.log('')

if (process.env.CORDCLEAN_NO_OPEN !== '1') {
  // 启动时用默认浏览器打开界面：openPath 现在是 explorer /select 的定位语义，
  // 不能用来开页面；explorer 收到 http(s) URL 会交给默认浏览器。
  void shell.openDataDir(server.url)
}

let closing = false
const shutdown = async () => {
  if (closing) return
  closing = true
  console.log('\n正在关闭 CordClean ...')
  await server.close()
  await app.dispose()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
