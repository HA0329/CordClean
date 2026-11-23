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
  /** 外部主动取消（例如工坊「放弃生成」真正中断了 HTTP 请求） */
  | 'CANCELLED'

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

/**
 * 稳定错误码 → 是否值得重试。
 *
 * 单独抽成纯函数，是因为「重试判定」必须和「错误分类」同源：
 * 上层（工坊/顾问）与传输层都用同一张表，厂商改文案时不会出现
 * 「界面说可重试、底层却一次就放弃」这类不一致。
 */
const RETRYABLE_CODES: ReadonlySet<AiErrorCode> = new Set<AiErrorCode>(['TIMEOUT', 'NETWORK', 'SERVER', 'RATE_LIMIT'])

export function isRetryableAiCode(code: AiErrorCode): boolean {
  return RETRYABLE_CODES.has(code)
}

/** 429/503 可能带 Retry-After（秒数或 HTTP 日期）；解析失败返回 0，超过 10 秒不再傻等 */
export function retryAfterMs(header: string | null | undefined): number {
  const raw = String(header ?? '').trim()
  if (!raw) return 0
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(10_000, Math.round(seconds * 1000))
  const at = Date.parse(raw)
  if (Number.isFinite(at)) return Math.min(10_000, Math.max(0, at - Date.now()))
  return 0
}

/** 指数退避 + 抖动；服务端给了 Retry-After（含 0）就优先遵守，上限 10 秒 */
export function retryDelayMs(attempt: number, retryAfter?: string | null): number {
  const raw = String(retryAfter ?? '').trim()
  if (raw) {
    const seconds = Number(raw)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(10_000, Math.round(seconds * 1000))
    const at = Date.parse(raw)
    if (Number.isFinite(at)) return Math.min(10_000, Math.max(0, at - Date.now()))
  }
  return Math.min(4000, 400 * 2 ** Math.max(0, attempt - 1)) + Math.round(Math.random() * 200)
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

/**
 * 可取消的等待：用户点「取消」后不必等完退避时间才抛出取消错误，
 * 也不会在退避结束后继续偷偷发下一次请求。
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AiError('请求已取消', 'CANCELLED'))
      return
    }
    const finish = () => {
      cleanup()
      resolve()
    }
    const timer = setTimeout(finish, Math.max(0, ms))
    const onAbort = () => {
      cleanup()
      reject(new AiError('请求已取消', 'CANCELLED'))
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
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
    // 用户已取消时不再发起（含重试）请求
    if (options.signal?.aborted) throw new AiError('请求已取消', 'CANCELLED')
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
          // 429/503 优先遵守服务端 Retry-After，避免立刻重试又被限流
          await sleep(retryDelayMs(attempt, response.headers.get('retry-after')), options.signal)
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
        if (isRetryableAiCode(error.code) && attempt < attempts) {
          await sleep(retryDelayMs(attempt), options.signal)
          continue
        }
        throw error
      }
      const err = error as Error & { name?: string }
      // 外部主动取消：不重试、不包装成超时，让上层能区分「用户放弃」和「真的超时」
      if (options.signal?.aborted) throw new AiError('请求已取消', 'CANCELLED')
      const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      const wrapped = new AiError(
        isTimeout ? `请求超时（超过 ${options.timeoutMs} ms）` : `网络请求失败：${err?.message ?? String(error)}`,
        isTimeout ? 'TIMEOUT' : 'NETWORK',
      )
      lastError = wrapped
      if (isRetryableAiCode(wrapped.code) && attempt < attempts) {
        await sleep(retryDelayMs(attempt), options.signal)
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
  options: {
    headers: Record<string, string>
    body: string
    timeoutMs?: number
    signal?: AbortSignal
    /** 每收完一个 chunk 后询问是否提前停止（例如已识别到 finish_reason=length） */
    stopWhen?: () => boolean
  },
  onData: (payload: any) => void,
): Promise<void> {
  if (options.signal?.aborted) throw new AiError('请求已取消', 'CANCELLED')
  const controller = new AbortController()
  let timedOut = false
  const onAbort = () => controller.abort()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs ?? 120_000)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...options.headers, Accept: 'text/event-stream' },
      body: options.body,
      signal: controller.signal,
    })
    if (options.signal?.aborted) throw new AiError('请求已取消', 'CANCELLED')
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '')
      // 带上稳定错误码：上层据此决定「回退非流式」还是「直接报错」，不再只靠文案猜
      const { code } = classify(response.status)
      throw new AiError(`SSE 请求失败：HTTP ${response.status} ${text.slice(0, 200)}`, code, response.status)
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
      // 已识别到截断等终止信号时主动取消剩余流：不依赖服务端是否及时结束响应，
      // 避免「服务端保持连接」把测试/真实请求拖到超时。
      if (options.stopWhen?.()) {
        await reader.cancel().catch(() => undefined)
        break
      }
    }
  } catch (error) {
    if (options.signal?.aborted) throw new AiError('请求已取消', 'CANCELLED')
    if (error instanceof AiError) throw error
    if (timedOut) throw new AiError(`流式请求超时（超过 ${options.timeoutMs ?? 120_000} ms）`, 'TIMEOUT')
    const message = error instanceof Error ? error.message : String(error)
    throw new AiError(`流式请求失败：${message}`, 'NETWORK')
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}
