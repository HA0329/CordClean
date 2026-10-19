/**
 * AI 请求传输层：超时、重试、错误归类。
 *
 * 之所以单独一层：接口地址与参数会变，但「怎么发一个可靠的 HTTP 请求」是稳定的。
 * 上层适配器只负责组装 URL/headers/body，这一层保证：
 * - 超时可控（AbortSignal.timeout）；
 * - 429/5xx/网络抖动自动退避重试；
 * - 401/403、参数错误等不重试，并把厂商返回的错误信息原样带给用户。
 */

export type AiErrorCode =
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'SERVER'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'HTTP'
  | 'INVALID_RESPONSE'
  | 'BAD_REQUEST'

/** 带分类与 HTTP 状态的 AI 错误 */
export class AiError extends Error {
  constructor(
    message: string,
    public code: AiErrorCode,
    public status = 0,
    public detail?: unknown,
  ) {
    super(message)
    this.name = 'AiError'
  }
}

export interface RequestOptions {
  /** 外部取消信号（与超时合并） */
  signal?: AbortSignal
  method?: 'GET' | 'POST'
  headers: Record<string, string>
  body?: unknown
  timeoutMs: number
  retries: number
}

export interface RequestResult {
  payload: any
  status: number
  latencyMs: number
  attempts: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 从厂商错误体里提取可读信息（兼容 OpenAI / Anthropic 两种风格） */
export function extractErrorMessage(payload: any, fallback: string): string {
  if (!payload) return fallback
  const error = payload.error
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const code = typeof error.code === 'string' ? error.code : ''
    const message = typeof error.message === 'string' ? error.message : ''
    if (code && message) return `${code}: ${message}`
    if (message) return message
  }
  if (typeof payload.message === 'string') return payload.message
  return fallback
}

function classify(status: number): { code: AiErrorCode; retryable: boolean } {
  if (status === 401 || status === 403) return { code: 'AUTH', retryable: false }
  if (status === 429) return { code: 'RATE_LIMIT', retryable: true }
  if (status === 408) return { code: 'TIMEOUT', retryable: true }
  if (status >= 500) return { code: 'SERVER', retryable: true }
  if (status === 400 || status === 422) return { code: 'BAD_REQUEST', retryable: false }
  return { code: 'HTTP', retryable: false }
}

/** 发起一次 JSON 请求（带重试与错误归类） */
export async function requestJson(url: string, options: RequestOptions): Promise<RequestResult> {
  const attempts = Math.max(1, Math.min(6, options.retries + 1))
  let lastError: AiError | undefined

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const startedAt = Date.now()
    try {
      const response = await fetch(url, {
        method: options.method ?? 'POST',
        headers: options.headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal ? AbortSignal.any([AbortSignal.timeout(options.timeoutMs), options.signal]) : AbortSignal.timeout(options.timeoutMs),
      })
      const text = await response.text()
      // 注意：要在读完响应体之后再计时。非流式补全的响应头可能先到，
      // 只计到响应头会把 8 秒的生成过程显示成 0.2 秒。
      const latencyMs = Date.now() - startedAt

      if (!response.ok) {
        let payload: any
        try {
          payload = text ? JSON.parse(text) : undefined
        } catch {
          payload = undefined
        }
        const { code, retryable } = classify(response.status)
        const detail = extractErrorMessage(payload, text.slice(0, 300) || response.statusText)
        // 带上 HTTP 状态码，方便用户区分「Key 错」「模型名错」「服务端故障」
        const error = new AiError(`HTTP ${response.status}：${detail}`, code, response.status, payload)
        if (retryable && attempt < attempts) {
          lastError = error
          await sleep(Math.min(4000, 400 * 2 ** (attempt - 1)) + Math.random() * 200)
          continue
        }
        throw error
      }

      let payload: any
      try {
        payload = text ? JSON.parse(text) : {}
      } catch {
        throw new AiError(`接口返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`, 'INVALID_RESPONSE', response.status)
      }
      return { payload, status: response.status, latencyMs, attempts: attempt }
    } catch (error) {
      if (error instanceof AiError) {
        lastError = error
        const retryable = error.code === 'TIMEOUT' || error.code === 'NETWORK' || error.code === 'SERVER' || error.code === 'RATE_LIMIT'
        if (retryable && attempt < attempts) {
          await sleep(Math.min(4000, 400 * 2 ** (attempt - 1)) + Math.random() * 200)
          continue
        }
        throw error
      }
      const err = error as Error & { name?: string }
      const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      const wrapped = new AiError(
        isTimeout ? `请求超时（超过 ${options.timeoutMs} ms）` : `网络请求失败：${err?.message ?? String(error)}`,
        isTimeout ? 'TIMEOUT' : 'NETWORK',
      )
      lastError = wrapped
      if (attempt < attempts) {
        await sleep(Math.min(4000, 400 * 2 ** (attempt - 1)) + Math.random() * 200)
        continue
      }
      throw wrapped
    }
  }

  throw lastError ?? new AiError('请求失败', 'NETWORK')
}

/** SSE 流式读取（chat/messages/responses 共用）：逐条回调 data JSON */
export async function requestSse(
  url: string,
  options: { headers: Record<string, string>; body: string; timeoutMs?: number; signal?: AbortSignal },
  onData: (payload: any) => void,
): Promise<void> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...options.headers, Accept: 'text/event-stream' },
      body: options.body,
      signal: controller.signal,
    })
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '')
      throw new Error(`SSE 请求失败：HTTP ${response.status} ${text.slice(0, 200)}`)
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const events = buffer.split('\n\n')
      buffer = events.pop() ?? ''
      for (const event of events) {
        for (const line of event.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (!data || data === '[DONE]') continue
          try { onData(JSON.parse(data)) } catch { /* 忽略非 JSON 心跳 */ }
        }
      }
    }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}
