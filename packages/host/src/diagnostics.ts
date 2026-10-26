/**
 * 运行日志：统一写入 `<dataDir>/logs/cordclean.log`。
 *
 * - 内容：启动信息、RPC（仅失败/慢请求/非高频方法）、扫描/清理汇总、插件装卸、
 *   AI 请求结果、未捕获异常等；
 * - 内核/插件 `ctx.logger` 日志由 core/logger.ts 写同一个文件，因此「查看最近日志」
 *   能看到插件日志；
 * - 轮转/保留/旧日志清理由 utils/log-file.ts 统一负责；
 * - 脱敏：统一 redactLogText，Key/Token 不落盘。
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  appendLogLine,
  configureLogFile,
  logDirPath as getLogDirPath,
  logFilePath as getLogFilePath,
  logFileSize,
  readLogLines,
  redactLogText,
} from '@cordclean/utils'

const PREVIEW_LIMIT = 600

export function initDiagnostics(dataDir: string): void {
  configureLogFile({ dir: path.join(dataDir, 'logs') })
  dlog('info', 'app', '日志已启动', { file: getLogFilePath() })
}

export function logDirPath(): string {
  return getLogDirPath() ?? ''
}

/** 兼容导出：所有日志共用的脱敏规则 */
export const redact = redactLogText

/** 写一行结构化日志（统一文件） */
export function dlog(level: 'debug' | 'info' | 'warn' | 'error', scope: string, message: string, extra?: unknown): void {
  let suffix = ''
  if (extra !== undefined) {
    try {
      const text = typeof extra === 'string' ? extra : JSON.stringify(extra)
      suffix = ' ' + redactLogText(text).slice(0, PREVIEW_LIMIT)
    } catch {
      suffix = ' [extra 无法序列化]'
    }
  }
  const line = `${new Date().toISOString()} [${level}] [${scope}] ${redactLogText(message)}${suffix}`
  appendLogLine(line)
}

/** 读最近 N 行（给界面「查看日志」用） */
export function recentLogs(limit = 200): string[] {
  return readLogLines(limit)
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
  writeFileSync(target, head + '\n' + readLogLines(1000).join('\n') + '\n', 'utf8')
  return target
}
