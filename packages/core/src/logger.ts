/**
 * 日志：控制台输出 + 文件落盘 + 转发给界面。
 *
 * 使用 Cordis 内置的 Logger 体系（`ctx.logger.exporter()`），
 * 因此插件里调用 `ctx.logger.warn(...)` 的日志会自动出现在
 * 控制台、日志文件与界面「运行日志」中。
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'
import { Logger, type Context, type Exporter, type Message } from 'cordis'

const LEVELS: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3 }
const MAX_LOG_BYTES = 4 * 1024 * 1024

export interface LoggerSetupOptions {
  dataDir: string
  /** 控制台输出等级 */
  level?: 'debug' | 'info' | 'warn' | 'error'
  /** 是否把日志转发为 `system/log` 事件（界面展示） */
  forward?: boolean
}

export function setupLogger(ctx: Context, options: LoggerSetupOptions): void {
  const threshold = LEVELS[options.level ?? 'info'] ?? 2
  mkdirSync(options.dataDir, { recursive: true })
  const logDir = path.join(options.dataDir, 'logs')
  mkdirSync(logDir, { recursive: true })
  const today = () => path.join(logDir, `app-${new Date().toISOString().slice(0, 10)}.log`)
  let writes = 0

  const exporter: Exporter = {
    colors: 256,
    export(message: Message) {
      if (message.level > threshold) return
      const text = Logger.format(this, message)
      const line = `${new Date(message.ts).toISOString()} ${text}`
      // 控制台
      if (message.type === 'error') console.error(text)
      else if (message.type === 'warn') console.warn(text)
      else console.log(text)
      // 文件
      try {
        const file = today()
        if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) {
          renameSync(file, file.replace(/\.log$/, '.1.log'))
        }
        appendFileSync(file, line + '\n', 'utf8')
      } catch {
        /* 日志写入失败不应影响主流程 */
      }
      // 转发到界面
      if (options.forward !== false && (++writes % 1 === 0)) {
        try {
          ctx.emit('system/log', { level: message.type, message: text, time: message.ts, name: message.name })
        } catch {
          /* ignore */
        }
      }
    },
  }
  ctx.logger.exporter(exporter)
}

export type { Message }
