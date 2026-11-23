/**
 * RPC 错误序列化：把内核抛出的错误转成 JSON-RPC error 对象。
 *
 * 为什么需要单独一层：
 * - 普通错误只有 message；AI 错误还有稳定的 `AiError.code`（AUTH/TIMEOUT/CANCELLED…），
 *   界面之前靠正则匹配文案来分类，厂商改文案就会失效；
 * - WebSocket 外壳可以把 code 放进 `error.data.aiCode`；
 * - Electron IPC 的 Error 自定义属性在跨进程时可能丢失，因此同时把 `[CODE]` 前缀
 *   写进 message，作为两个外壳都能读到的稳定载体。
 */
import type { AiErrorCodeName } from '@cordclean/shared'

export const AI_ERROR_CODES: ReadonlySet<string> = new Set<AiErrorCodeName>([
  'AUTH',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'NETWORK',
  'HTTP',
  'INVALID_RESPONSE',
  'BAD_REQUEST',
  'CANCELLED',
])

export interface SerializedRpcError {
  code: number
  message: string
  data?: Record<string, unknown>
}

/** 取错误上的稳定 AI 错误码；不是 AI 错误返回 undefined */
export function aiErrorCodeOf(error: unknown): AiErrorCodeName | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && AI_ERROR_CODES.has(code) ? (code as AiErrorCodeName) : undefined
}

/**
 * 序列化 RPC 错误。
 * @param error 内核抛出的错误（AiError / 普通 Error / 任意值）
 * @param fallbackCode 没有数字 code 时使用的 JSON-RPC 错误码（默认 -32603 Internal error）
 */
export function serializeRpcError(error: unknown, fallbackCode = -32603): SerializedRpcError {
  const err = error as { code?: unknown; message?: unknown; status?: unknown } | null | undefined
  const numericCode = typeof err?.code === 'number' ? err.code : fallbackCode
  const baseMessage = typeof err?.message === 'string' && err.message ? err.message : String(error)
  const aiCode = aiErrorCodeOf(error)
  if (!aiCode) return { code: numericCode, message: baseMessage }
  return {
    code: numericCode,
    // IPC 下 Error 自定义属性会丢，message 前缀是两个外壳都可靠的载体
    message: `[${aiCode}] ${baseMessage}`,
    data: { aiCode, aiStatus: typeof err?.status === 'number' ? err.status : 0 },
  }
}
