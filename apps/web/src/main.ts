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
    // 用 cmd 的 start 命令交给 shell 处理，避免中文路径与空格问题
    await runCommand('cmd.exe', ['/c', 'start', '', target], { timeout: 15_000 })
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
  port: process.env.CORDCLEAN_PORT ? Number(process.env.CORDCLEAN_PORT) : 7801,
})

console.log('')
console.log('  ╭──────────────────────────────────────────────╮')
console.log('  │  CordClean 已启动                             │')
console.log('  ╰──────────────────────────────────────────────╯')
console.log(`  界面地址: ${server.url}`)
console.log(`  RPC 地址: ${server.wsUrl}`)
console.log(`  访问令牌: ${server.token}`)
console.log(`  数据目录: ${app.dataDir}`)
console.log('')

if (process.env.CORDCLEAN_NO_OPEN !== '1') {
  void shell.openPath(server.url)
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
