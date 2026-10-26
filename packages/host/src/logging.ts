/**
 * RPC 日志降噪策略（与 server.ts 解耦，便于单测）。
 *
 * 设计：
 * - 高频只读方法默认不记成功日志（例如 system/live、app/info）；
 * - 任何失败都记；慢请求（>= SLOW_RPC_MS）都记；
 * - 参数先摘要/脱敏：Key、Token 一律 `<redacted>`，代码/文件/大型配置只记形状。
 */
import { redactLogText } from '@cordclean/utils'

/** 高频只读 RPC：成功时不写入日志 */
export const QUIET_RPC_METHODS = new Set([
  'app/info',
  'app/logs/recent',
  'app/logs/info',
  'system/info',
  'system/live',
  'system/hotspots',
  'tasks/list',
  'plugins/list',
  'plugins/defaults',
  'plugins/package-problems',
  'plugins/client-url',
  'settings/get',
  'history/totals',
  'history/list',
  'quarantine/list',
  'quarantine/stats',
  'ai/status',
  'ai/last',
  'ai/models',
  'ai/workshop/status',
  'ai/workshop/models',
  'scan/last',
  'app/logs/export',
  'ui/contributions',
])

export const SLOW_RPC_MS = 500

const SENSITIVE_KEY = /(api[-_]?key|token|authorization|password|secret)/i
const LARGE_KEYS = /^(code|files|manifest|config|patch|extraBody|image|content|preview|suggestion|settings)$/

/** 成功请求是否需要写日志 */
export function shouldLogRpc(method: string, durationMs: number, ok: boolean): boolean {
  if (!ok) return true
  if (durationMs >= SLOW_RPC_MS) return true
  return !QUIET_RPC_METHODS.has(method)
}

/** 参数摘要：控制日志体积并脱敏 */
export function summarizeRpcParams(params: unknown): unknown {
  if (params === undefined || params === null) return undefined
  if (typeof params !== 'object') {
    return typeof params === 'string' ? truncateText(params) : params
  }
  if (Array.isArray(params)) return `<array:${params.length}>`
  const summary: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) {
      summary[key] = '<redacted>'
      continue
    }
    if (LARGE_KEYS.test(key)) {
      summary[key] = describeLarge(value)
      continue
    }
    if (typeof value === 'string') {
      summary[key] = truncateText(value)
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      summary[key] = value
    } else if (Array.isArray(value)) {
      summary[key] = `<array:${value.length}>`
    } else if (value === undefined) {
      summary[key] = undefined
    } else {
      summary[key] = '<object>'
    }
  }
  return Object.keys(summary).length ? summary : undefined
}

function truncateText(text: string): string {
  const redacted = redactLogText(text)
  return redacted.length > 120 ? `<${redacted.length} chars>` : redacted
}

function describeLarge(value: unknown): string {
  if (Array.isArray(value)) return `<array:${value.length}>`
  if (typeof value === 'string') return `<${value.length} chars>`
  if (value && typeof value === 'object') return '<object>'
  return String(value)
}
