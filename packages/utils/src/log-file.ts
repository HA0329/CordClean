/**
 * 统一日志写入器（utils 层，无 Cordis 依赖）。
 *
 * Phase 2 起文件为 **JSONL**：每行一个 `LogEntry`，同时通过 `onLogEvent`
 * 广播给 Web 服务端/Electron 主进程，供界面做实时 tail。
 *
 * 设计目标：
 * - 单一文件：内核/插件日志与诊断日志统一写 `<dataDir>/logs/cordclean.log`；
 * - 结构化：ts / level / scope / message / fields / requestId / pluginId；
 * - 有界：超过 maxBytes 轮转为 `.1`、`.2`，保留份数可配置；
 * - 低开销：64KB / 100ms 缓冲写盘，进程退出前 flush；
 * - 安全：message 与 fields 统一脱敏后再落盘/广播；
 * - 兼容：旧版纯文本日志行在读取时会被包装成 legacy 条目，不会报错。
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
import type { LogEntry, LogLevel } from '@cordclean/shared'

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
  /** 相同 level/scope/message 的日志合并窗口（毫秒）；0 表示关闭 */
  dedupeWindowMs?: number
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_KEEP = 2
const DEFAULT_RETAIN_DAYS = 14
const DEFAULT_DEDUPE_WINDOW_MS = 3000

/** 写入缓冲：日志是高频热路径，避免每行一次同步写盘；按大小/时间 flush */
const FLUSH_BYTES = 64 * 1024
const FLUSH_INTERVAL_MS = 100

let configured:
  | { dir: string; file: string; maxBytes: number; keep: number }
  | undefined
let buffer: string[] = []
let bufferBytes = 0
let flushTimer: ReturnType<typeof setTimeout> | undefined
let exitHooked = false
let dedupeWindowMs = 0
const dedupePending = new Map<
  string,
  { count: number; last: LogEntry; timer: ReturnType<typeof setTimeout> }
>()
const listeners = new Set<(entry: LogEntry) => void>()

/** 配置日志文件（重复调用会切换到新目录，测试/多实例/运行时调整可复用） */
export function configureLogFile(options: LogFileOptions): void {
  flushLogDedupe()
  flushLogFile()
  const dir = path.resolve(options.dir)
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, options.file ?? 'cordclean.log')
  const maxBytes = Math.max(4 * 1024, Math.trunc(options.maxBytes ?? DEFAULT_MAX_BYTES))
  const keep = Math.max(1, Math.trunc(options.keep ?? DEFAULT_KEEP))
  configured = { dir, file, maxBytes, keep }
  dedupeWindowMs = Math.max(0, Math.trunc(options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS))
  rotateIfNeeded()
  cleanupLegacyLogs(dir, options.retainDays ?? DEFAULT_RETAIN_DAYS, file)
  if (!exitHooked) {
    exitHooked = true
    // 进程退出前把缓冲区落盘（exit 回调里只能做同步操作）
    process.once('exit', () => { flushLogDedupe(); flushLogFile() })
  }
}

export function logFilePath(): string | undefined {
  return configured?.file
}

export function logDirPath(): string | undefined {
  return configured?.dir
}

/** 订阅每一条日志（Web/Electron 实时通道），返回取消订阅函数 */
export function onLogEvent(listener: (entry: LogEntry) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * 追加一条结构化日志：脱敏 → 缓冲写盘 → 广播给实时订阅者。
 * 即使日志文件尚未配置也会广播（例如早期启动日志仍可进界面）。
 */
export function appendLogEvent(input: {
  level: LogLevel
  scope: string
  message: string
  fields?: Record<string, unknown>
  requestId?: string
  pluginId?: string
  ts?: string
}): LogEntry {
  const entry: LogEntry = {
    ts: input.ts ?? new Date().toISOString(),
    level: input.level,
    scope: input.scope || 'app',
    message: redactLogText(input.message ?? ''),
    ...(input.fields ? { fields: sanitizeFields(input.fields) } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.pluginId ? { pluginId: input.pluginId } : {}),
  }

  // Phase 3：短窗口内相同 level/scope/message 合并，只保留首条 + 汇总重复次数
  if (dedupeWindowMs > 0) {
    const key = `${entry.level}\u0000${entry.scope}\u0000${entry.message}`
    const pending = dedupePending.get(key)
    if (pending) {
      pending.count += 1
      pending.last = entry
      return entry
    }
    const timer = setTimeout(() => flushDedupeKey(key), dedupeWindowMs)
    ;(timer as any).unref?.()
    dedupePending.set(key, { count: 1, last: entry, timer })
  }

  writeAndEmit(entry)
  return entry
}

/** 立即输出所有待合并的重复日志（读取/退出/切换配置前调用） */
export function flushLogDedupe(): void {
  for (const key of [...dedupePending.keys()]) flushDedupeKey(key)
}

function flushDedupeKey(key: string): void {
  const pending = dedupePending.get(key)
  if (!pending) return
  dedupePending.delete(key)
  clearTimeout(pending.timer)
  if (pending.count <= 1) return
  const summary: LogEntry = {
    ...pending.last,
    ts: new Date().toISOString(),
    fields: { ...(pending.last.fields ?? {}), repeat: pending.count },
  }
  writeAndEmit(summary)
}

function writeAndEmit(entry: LogEntry): void {
  if (configured) {
    const line = JSON.stringify(entry) + '\n'
    buffer.push(line)
    bufferBytes += Buffer.byteLength(line, 'utf8')
    if (bufferBytes >= FLUSH_BYTES) {
      flushLogFile()
    } else if (!flushTimer) {
      flushTimer = setTimeout(() => flushLogFile(), FLUSH_INTERVAL_MS)
      ;(flushTimer as any).unref?.()
    }
  }
  for (const listener of listeners) {
    try {
      listener(entry)
    } catch {
      /* 单个订阅者异常不能影响日志主流程 */
    }
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

/** 读取末尾 N 条日志（自动将旧版纯文本行包装为 legacy 条目） */
export function readLogEntries(limit = 200): LogEntry[] {
  flushLogDedupe()
  flushLogFile()
  if (!configured) return []
  try {
    if (!existsSync(configured.file)) return []
    const count = Math.max(1, Math.min(5000, Math.trunc(limit)))
    const text = readFileSync(configured.file, 'utf8')
    const lines = text.trimEnd().split(/\r?\n/).filter(Boolean).slice(-count)
    const entries: LogEntry[] = []
    for (const line of lines) {
      const parsed = parseLegacyLine(line)
      if (parsed) entries.push(parsed)
    }
    return entries
  } catch {
    return []
  }
}

/** 把一条日志格式化为人类可读文本（诊断报告/兼容接口使用） */
export function formatLogEntry(entry: LogEntry): string {
  const fields = entry.fields ? ' ' + JSON.stringify(entry.fields) : ''
  return `${entry.ts} [${entry.level}] [${entry.scope}] ${entry.message}${fields}`
}

/** 读取末尾 N 条的纯文本形式（诊断报告/旧 RPC 兼容） */
export function readLogLines(limit = 200): string[] {
  return readLogEntries(limit).map(formatLogEntry)
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

const SENSITIVE_KEY = /(api[-_]?key|token|authorization|password|secret)/i

function sanitizeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields).slice(0, 60)) {
    if (SENSITIVE_KEY.test(key)) {
      result[key] = '<redacted>'
      continue
    }
    result[key] = sanitizeValue(value, 0)
  }
  return result
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    const redacted = redactLogText(value)
    return redacted.length > 500 ? redacted.slice(0, 500) + '…' : redacted
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (depth >= 3) return '<object>'
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeValue(item, depth + 1))
  }
  if (typeof value === 'object') {
    return sanitizeFields(value as Record<string, unknown>)
  }
  return String(value)
}

function parseLegacyLine(line: string): LogEntry | undefined {
  if (line.startsWith('{')) {
    try {
      const data = JSON.parse(line) as Partial<LogEntry>
      if (data && typeof data === 'object' && typeof data.message === 'string') {
        return {
          ts: typeof data.ts === 'string' ? data.ts : new Date().toISOString(),
          level: isLogLevel(data.level) ? data.level : 'info',
          scope: String(data.scope ?? 'app'),
          message: String(data.message),
          ...(data.fields && typeof data.fields === 'object' ? { fields: data.fields } : {}),
          ...(data.requestId ? { requestId: String(data.requestId) } : {}),
          ...(data.pluginId ? { pluginId: String(data.pluginId) } : {}),
        }
      }
    } catch {
      /* 交给旧格式兜底 */
    }
  }
  const timeMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\S+?)\s/)
  const levelMatch = line.match(/\[(error|warn|info|debug)\]/i)
  return {
    ts: timeMatch?.[1] ?? new Date().toISOString(),
    level: isLogLevel(levelMatch?.[1].toLowerCase()) ? (levelMatch![1].toLowerCase() as LogLevel) : 'info',
    scope: 'legacy',
    message: line,
  }
}

function isLogLevel(value: unknown): value is LogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error'
}

function rotateIfNeeded(): void {
  if (!configured) return
  const { file, maxBytes, keep } = configured
  try {
    if (!existsSync(file) || statSync(file).size <= maxBytes) return
    const oldest = `${file}.${keep}`
    if (existsSync(oldest)) rmSync(oldest, { force: true })
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
