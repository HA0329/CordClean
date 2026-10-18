/**
 * 运行日志：给用户排查问题用的「详细使用日志」。
 *
 * - 位置：<dataDir>/logs/cordclean.log，超过 5MB 自动轮转（保留 .1/.2）
 * - 内容：启动信息、每条 RPC（方法/耗时/结果/错误）、扫描与清理汇总、插件装卸、
 *   AI 请求结果、未捕获异常
 * - 脱敏：`sk-…`、apiKey/token/authorization 字段一律替换为 <redacted>
 *
 * 设计原则：日志是给人看的，宁可少记参数，也不要把 Key 写进文件。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

let logDir = ''
let logFile = ''

const MAX_BYTES = 5 * 1024 * 1024
const PREVIEW_LIMIT = 600

export function initDiagnostics(dataDir: string): void {
  if (logDir) return
  logDir = path.join(dataDir, 'logs')
  mkdirSync(logDir, { recursive: true })
  logFile = path.join(logDir, 'cordclean.log')
  // 简单轮转：超过上限就把当前文件挪到 .1，旧 .1 挪到 .2
  try {
    if (existsSync(logFile) && statSync(logFile).size > MAX_BYTES) {
      const old = `${logFile}.1`
      if (existsSync(old)) {
        try { renameSync(old, `${logFile}.2`) } catch {}
      }
      try { renameSync(logFile, old) } catch {}
    }
  } catch {}
  dlog('info', 'app', '日志已启动', { file: logFile })
}

export function logDirPath(): string {
  return logDir
}

/** 把可能含密钥的内容替换掉 */
export function redact(text: string): string {
  return String(text)
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, 'sk-<redacted>')
    .replace(/("?(?:apiKey|api_key|x-api-key|token|authorization|password)"?\s*[:=]\s*)("[^"]*"|[^,\s}]+)/gi, '$1<redacted>')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer <redacted>')
}

/** 写一行结构化日志 */
export function dlog(level: 'debug' | 'info' | 'warn' | 'error', scope: string, message: string, extra?: unknown): void {
  if (!logFile) return
  let suffix = ''
  if (extra !== undefined) {
    try {
      const text = typeof extra === 'string' ? extra : JSON.stringify(extra)
      suffix = ' ' + redact(text).slice(0, PREVIEW_LIMIT)
    } catch {
      suffix = ' [extra 无法序列化]'
    }
  }
  const line = `${new Date().toISOString()} [${level}] [${scope}] ${redact(message)}${suffix}\n`
  try {
    appendFileSync(logFile, line, 'utf8')
  } catch {
    /* 日志失败不能影响主流程 */
  }
}

/** 读最近 N 行（给界面「查看日志」用） */
export function recentLogs(limit = 200): string[] {
  try {
    if (!existsSync(logFile)) return []
    const text = readFileSync(logFile, 'utf8')
    return text.trimEnd().split(/\r?\n/).slice(-Math.max(1, Math.min(2000, limit)))
  } catch {
    return []
  }
}

/** 导出诊断包：系统信息 + 设置摘要 + 最近日志，写成一个 txt */
export function exportDiagnostics(extra: Record<string, unknown>): string {
  const target = path.join(logDir, `diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`)
  const head = [
    'CordClean 诊断报告',
    `导出时间：${new Date().toISOString()}`,
    '',
    '--- 环境 ---',
    JSON.stringify(extra, null, 2),
    '',
    '--- 最近日志（末尾 1000 行）---',
  ].join('\n')
  writeFileSync(target, head + '\n' + recentLogs(1000).join('\n') + '\n', 'utf8')
  return target
}
