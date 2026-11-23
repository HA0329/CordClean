/**
 * AI 错误的稳定错误码（跨 WebSocket / Electron IPC 两个外壳一致）。
 *
 * 背景：之前界面靠正则匹配错误文案来分类（"超时"/"截断"/"鉴权"…），
 * 厂商或插件改一句文案就会掉进「未知错误」。现在宿主把 `AiError.code` 原样带出：
 * - WebSocket：JSON-RPC error.data.aiCode；
 * - Electron IPC：Error 自定义属性会丢失，因此把 `[CODE]` 前缀写进 message；
 * 界面先读码，读不到才退回文案匹配（兼容旧内核/第三方插件）。
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

/** 从任意错误对象里取稳定 AI 错误码（data.aiCode 优先，其次 message 的 [CODE] 前缀） */
export function aiErrorCodeOfRaw(raw: unknown): AiErrorCodeName | undefined {
  if (!raw || typeof raw !== 'object') {
    // 字符串类型也支持 "[TIMEOUT] xxx" 形式（IPC 或日志透传）
    return typeof raw === 'string' ? codeFromMessage(raw) : undefined
  }
  const data = (raw as { data?: unknown }).data
  if (data && typeof data === 'object') {
    const code = (data as { aiCode?: unknown }).aiCode
    if (typeof code === 'string' && AI_ERROR_CODES.has(code)) return code as AiErrorCodeName
  }
  const message = (raw as { message?: unknown }).message
  if (typeof message === 'string') return codeFromMessage(message)
  return undefined
}

/** message 前缀形如 "[TIMEOUT] 请求超时"；只匹配稳定码集合，避免误吞普通方括号文本 */
export function codeFromMessage(message: string): AiErrorCodeName | undefined {
  const match = /^\[([A-Z_]+)\]\s+/.exec(message.trim())
  if (!match) return undefined
  return AI_ERROR_CODES.has(match[1]) ? (match[1] as AiErrorCodeName) : undefined
}

/** 去掉展示用 message 里的 [CODE] 前缀（错误详情仍显示原始说明） */
export function stripAiErrorCodePrefix(message: string): string {
  return message.replace(/^\[([A-Z_]+)\]\s+/, (whole, code: string) => (AI_ERROR_CODES.has(code) ? '' : whole))
}
