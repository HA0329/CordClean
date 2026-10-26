/**
 * 统一日志：Cordis Logger 导出器 → 控制台 + JSONL 日志文件 + 实时事件总线。
 *
 * Phase 2 起：
 * - 文件为 JSONL（utils/log-file.ts），每行一条 LogEntry；
 * - 日志级别/大小/保留份数可在运行时通过设置调整（applyLoggingConfig）；
 * - 文件写入后由 utils 的事件总线广播，Web/Electron 外壳负责推送给界面；
 * - 日志文本先脱敏再写入/广播。
 */
import path from 'node:path'
import { appendLogEvent, configureLogFile } from '@cordclean/utils'
import type { LogLevel, LoggingSettings } from '@cordclean/shared'
import { Logger, type Context, type Exporter, type Message } from 'cordis'

const LEVELS: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 }

export interface LoggerSetupOptions {
  dataDir: string
  /** 控制台/文件输出等级 */
  level?: LogLevel
  /** 是否把日志转发到界面（Phase 2 由外壳订阅事件总线，此参数保留兼容） */
  forward?: boolean
}

let dataDir = ''
let threshold = 2
let pluginLevels: Record<string, LogLevel> = {}

/** 运行时应用日志设置：级别 + 轮转大小/份数 + 保留天数 */
export function applyLoggingConfig(settings: Partial<LoggingSettings> & { level?: LogLevel }): void {
  if (settings.level && settings.level in LEVELS) threshold = LEVELS[settings.level]
  if (settings.pluginLevels) pluginLevels = { ...settings.pluginLevels }
  if (!dataDir) return
  configureLogFile({
    dir: path.join(dataDir, 'logs'),
    maxBytes: settings.maxBytes,
    keep: settings.keep,
    retainDays: settings.retainDays,
    dedupeWindowMs: settings.dedupeWindowMs,
  })
}

/** 当前 scope（插件名）是否允许输出该级别（供导出器/单测使用） */
export function isLevelEnabled(scope: string, level: LogLevel): boolean {
  const scopeLevel = pluginLevels[scope]
  const limit = scopeLevel ? LEVELS[scopeLevel] : threshold
  return LEVELS[level] <= limit
}

export function setupLogger(ctx: Context, options: LoggerSetupOptions): void {
  dataDir = options.dataDir
  applyLoggingConfig({ level: options.level ?? 'info' })

  const exporter: Exporter = {
    colors: 256,
    export(message: Message) {
      const scope = message.name || 'kernel'
      const level = (message.type ?? 'info') as LogLevel
      if (!isLevelEnabled(scope, level)) return
      const text = Logger.format(this, message)
      if (level === 'error') console.error(text)
      else if (level === 'warn') console.warn(text)
      else console.log(text)
      appendLogEvent({
        level,
        scope,
        message: text,
        pluginId: message.name || undefined,
      })
    },
  }
  ctx.logger.exporter(exporter)
}

export type { Message }
