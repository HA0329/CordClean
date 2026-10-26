/**
 * 统一日志：Cordis Logger 导出器 → 控制台 + 单一日志文件 + 界面实时事件。
 *
 * 与旧实现的差别：
 * - 不再自己维护 `app-YYYY-MM-DD.log`，内核/插件日志与诊断日志统一写
 *   `<dataDir>/logs/cordclean.log`（utils/log-file.ts 负责轮转/保留/脱敏）；
 * - 日志文本先脱敏再落盘/转发，避免插件把 Key 写进文件；
 * - 每条日志带 `[level] [scope]`，插件日志用插件名作为 scope；
 * - 实时事件仍然发 `system/log`，供界面 tail。
 */
import path from 'node:path'
import { appendLogLine, configureLogFile, logDirPath as getLogDir, logFilePath as getLogFile, redactLogText } from '@cordclean/utils'
import { Logger, type Context, type Exporter, type Message } from 'cordis'

const LEVELS: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3 }

export interface LoggerSetupOptions {
  dataDir: string
  /** 控制台输出等级 */
  level?: 'debug' | 'info' | 'warn' | 'error'
  /** 是否把日志转发为 `system/log` 事件（界面展示） */
  forward?: boolean
}

export function setupLogger(ctx: Context, options: LoggerSetupOptions): void {
  const threshold = LEVELS[options.level ?? 'info'] ?? 2
  configureLogFile({ dir: path.join(options.dataDir, 'logs') })

  const exporter: Exporter = {
    colors: 256,
    export(message: Message) {
      if (message.level > threshold) return
      const text = redactLogText(Logger.format(this, message))
      const level = message.type ?? 'info'
      const scope = message.name || 'kernel'
      const line = `${new Date(message.ts).toISOString()} [${level}] [${scope}] ${text}`
      if (message.type === 'error') console.error(text)
      else if (message.type === 'warn') console.warn(text)
      else console.log(text)
      appendLogLine(line)
      if (options.forward !== false) {
        try {
          ctx.emit('system/log', {
            level,
            message: text,
            time: message.ts,
            name: message.name,
          } as any)
        } catch {
          /* 界面未连接等情况忽略 */
        }
      }
    },
  }
  ctx.logger.exporter(exporter)
}

/** 当前统一日志文件/目录（界面与诊断报告使用） */
export function currentLogFile(): string | undefined {
  return getLogFile()
}

export function currentLogDir(): string | undefined {
  return getLogDir()
}

export type { Message }
