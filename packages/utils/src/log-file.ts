/**
 * 统一日志文件写入器（utils 层，无 Cordis 依赖）。
 *
 * 设计目标：
 * - **单一文件**：内核/插件日志与诊断日志都写 `<dataDir>/logs/cordclean.log`；
 * - **有界**：超过 maxBytes 轮转为 `.1`、`.2`，超出保留份数自动删除；
 * - **可迁移**：清理历史 `app-*.log`（旧版 Cordis 每日日志）避免目录越积越乱；
 * - **可读**：只负责按行追加，格式由调用方统一（ISO + [level] + [scope] + message）；
 * - **安全**：提供统一的脱敏函数，所有调用方共用一个规则。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import path from 'node:path'

export interface LogFileOptions {
  /** 日志目录（通常是 <dataDir>/logs） */
  dir: string
  /** 当前日志文件名，默认 cordclean.log */
  file?: string
  /** 单文件上限，默认 5 MB */
  maxBytes?: number
  /** 保留的轮转份数（.1、.2……），默认 2 */
  keep?: number
  /** 旧 app-*.log / diagnostics-*.txt 的保留天数，默认 14；0 表示不清理 */
  retainDays?: number
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_KEEP = 2
const DEFAULT_RETAIN_DAYS = 14

let configured:
  | { dir: string; file: string; maxBytes: number; keep: number }
  | undefined

/** 写入缓冲：日志是高频热路径，避免每行一次同步写盘；按大小/时间 flush */
const FLUSH_BYTES = 64 * 1024
const FLUSH_INTERVAL_MS = 100
let buffer: string[] = []
let bufferBytes = 0
let flushTimer: ReturnType<typeof setTimeout> | undefined
let exitHooked = false

/** 配置日志文件（重复调用会切换到新目录，测试/多实例可用） */
export function configureLogFile(options: LogFileOptions): void {
  flushLogFile()
  const dir = path.resolve(options.dir)
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, options.file ?? 'cordclean.log')
  const maxBytes = Math.max(4 * 1024, Math.trunc(options.maxBytes ?? DEFAULT_MAX_BYTES))
  const keep = Math.max(1, Math.trunc(options.keep ?? DEFAULT_KEEP))
  configured = { dir, file, maxBytes, keep }
  rotateIfNeeded()
  cleanupLegacyLogs(dir, options.retainDays ?? DEFAULT_RETAIN_DAYS, file)
  if (!exitHooked) {
    exitHooked = true
    // 进程退出前把缓冲区落盘（exit 回调里只能做同步操作）
    process.once('exit', () => flushLogFile())
  }
}

export function logFilePath(): string | undefined {
  return configured?.file
}

export function logDirPath(): string | undefined {
  return configured?.dir
}

/** 追加一行日志；未配置时静默忽略（日志失败不影响主流程） */
export function appendLogLine(line: string): void {
  if (!configured) return
  const text = line.endsWith('\n') ? line : line + '\n'
  buffer.push(text)
  bufferBytes += Buffer.byteLength(text, 'utf8')
  if (bufferBytes >= FLUSH_BYTES) {
    flushLogFile()
    return
  }
  if (!flushTimer) {
    flushTimer = setTimeout(() => flushLogFile(), FLUSH_INTERVAL_MS)
    // 不要因为日志定时器阻止进程退出
    ;(flushTimer as any).unref?.()
  }
}

/** 立即把缓冲区写入文件（轮转/读取/退出前调用） */
export function flushLogFile(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = undefined
  }
  if (!configured || !buffer.length) return
  const payload = buffer.join('')
  buffer = []
  bufferBytes = 0
  try {
    rotateIfNeeded()
    appendFileSync(configured.file, payload, 'utf8')
  } catch {
    /* 日志写入失败不影响主流程 */
  }
}

/** 读取末尾 N 行（界面/诊断报告用） */
export function readLogLines(limit = 200): string[] {
  flushLogFile()
  if (!configured) return []
  try {
    if (!existsSync(configured.file)) return []
    const count = Math.max(1, Math.min(5000, Math.trunc(limit)))
    const text = readFileSync(configured.file, 'utf8')
    return text.trimEnd().split(/\r?\n/).slice(-count)
  } catch {
    return []
  }
}

/** 日志文件大小（字节） */
export function logFileSize(): number {
  flushLogFile()
  if (!configured) return 0
  try {
    return existsSync(configured.file) ? statSync(configured.file).size : 0
  } catch {
    return 0
  }
}

/** 统一脱敏：API Key、Bearer Token、常见敏感字段 */
export function redactLogText(text: string): string {
  return String(text)
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, 'sk-<redacted>')
    .replace(/("?(?:apiKey|api_key|x-api-key|token|authorization|password|secret)"?\s*[:=]\s*)("[^"]*"|[^,\s}]+)/gi, '$1<redacted>')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer <redacted>')
}

function rotateIfNeeded(): void {
  if (!configured) return
  const { file, maxBytes, keep } = configured
  try {
    if (!existsSync(file) || statSync(file).size <= maxBytes) return
    // 删除最老的一份
    const oldest = `${file}.${keep}`
    if (existsSync(oldest)) rmSync(oldest, { force: true })
    // .n-1 → .n
    for (let index = keep - 1; index >= 1; index -= 1) {
      const from = `${file}.${index}`
      const to = `${file}.${index + 1}`
      if (existsSync(from)) {
        try {
          renameSync(from, to)
        } catch {
          /* 忽略单次轮转失败 */
        }
      }
    }
    renameSync(file, `${file}.1`)
  } catch {
    /* 轮转失败不影响主流程 */
  }
}

/** 清理旧版 app-*.log 与过期 diagnostics-*.txt；保留最近 retainDays 天 */
function cleanupLegacyLogs(dir: string, retainDays: number, currentFile: string): void {
  if (!retainDays || retainDays <= 0) return
  const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000
  try {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      if (full === currentFile) continue
      const legacyApp = /^app-\d{4}-\d{2}-\d{2}\.log(\.\d+)?$/.test(entry)
      const legacyDiagnostics = /^diagnostics-.+\.txt$/i.test(entry)
      const rotated = entry.startsWith(path.basename(currentFile) + '.')
      if (!legacyApp && !legacyDiagnostics && !rotated) continue
      try {
        if (statSync(full).mtimeMs < cutoff) rmSync(full, { force: true })
      } catch {
        /* 单个文件失败忽略 */
      }
    }
  } catch {
    /* 目录不可读忽略 */
  }
}
