/**
 * 诊断日志：与内核/插件日志统一写入 `<dataDir>/logs/cordclean.log`（JSONL）。
 *
 * - dlog 只负责构造结构化字段；脱敏/截断/轮转由 utils/log-file.ts 统一处理；
 * - `app/logs/recent` 返回可读文本（兼容旧界面/诊断报告），`app/logs/entries`
 *   返回结构化条目（新日志查看器/实时 tail 使用）。
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  appendLogEvent,
  configureLogFile,
  formatLogEntry,
  logDirPath as getLogDirPath,
  logFilePath as getLogFilePath,
  logFileSize,
  readLogEntries,
  redactLogText,
} from '@cordclean/utils'
import type { LogEntry } from '@cordclean/shared'

export function initDiagnostics(dataDir: string): void {
  configureLogFile({ dir: path.join(dataDir, 'logs') })
  dlog('info', 'app', '日志已启动', { file: getLogFilePath() })
}

export function logDirPath(): string {
  return getLogDirPath() ?? ''
}

/** 兼容导出：所有日志共用的脱敏规则 */
export const redact = redactLogText

/**
 * 写一行结构化日志。
 * @param fields 结构化附加字段（已脱敏/截断）
 * @param meta 关联信息：RPC requestId / 插件 id
 */
export function dlog(
  level: 'debug' | 'info' | 'warn' | 'error',
  scope: string,
  message: string,
  fields?: unknown,
  meta?: { requestId?: string; pluginId?: string },
): void {
  const normalizedFields =
    fields === undefined
      ? undefined
      : typeof fields === 'string'
        ? { detail: fields }
        : typeof fields === 'object' && fields !== null
          ? (fields as Record<string, unknown>)
          : { detail: String(fields) }
  appendLogEvent({
    level,
    scope,
    message,
    ...(normalizedFields ? { fields: normalizedFields } : {}),
    ...(meta?.requestId ? { requestId: meta.requestId } : {}),
    ...(meta?.pluginId ? { pluginId: meta.pluginId } : {}),
  })
}

/** 读最近 N 条结构化日志（界面/实时 tail 用） */
export function recentLogEntries(limit = 200): LogEntry[] {
  return readLogEntries(limit)
}

/** 读最近 N 行可读文本（兼容旧 RPC/诊断报告） */
export function recentLogs(limit = 200): string[] {
  return readLogEntries(limit).map(formatLogEntry)
}

/** 日志文件信息（界面展示/诊断报告） */
export function logFileStats(): { file: string; bytes: number } {
  return { file: getLogFilePath() ?? '', bytes: logFileSize() }
}

/** 导出诊断包：系统信息 + 设置摘要 + 最近日志，写成一个 txt */
export function exportDiagnostics(extra: Record<string, unknown>): string {
  const targetDir = getLogDirPath() ?? path.dirname(getLogFilePath() ?? '.')
  const target = path.join(targetDir, `diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`)
  const head = [
    'CordClean 诊断报告',
    `导出时间：${new Date().toISOString()}`,
    `日志文件：${getLogFilePath() ?? '(未初始化)'}（${logFileSize()} 字节）`,
    '',
    '--- 环境 ---',
    JSON.stringify(extra, null, 2),
    '',
    '--- 最近日志（末尾 1000 行）---',
  ].join('\n')
  writeFileSync(target, head + '\n' + recentLogs(1000).join('\n') + '\n', 'utf8')
  return target
}
