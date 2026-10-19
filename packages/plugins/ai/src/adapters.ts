/**
 * 接口形态适配器。
 *
 * 同一份「系统画像 → 清理建议」的能力，需要能跑在三种兼容接口上：
 * - `chat`：OpenAI Chat Completions（DeepSeek 默认形态）；
 * - `messages`：Anthropic Messages（`/anthropic/v1/messages`）；
 * - `responses`：OpenAI Responses（`/responses`）。
 *
 * 每个适配器只做两件事：把 `{systemPrompt, userPrompt}` 组装成该形态的请求；
 * 把该形态的响应还原成统一的 `{text, reasoning, usage}`。
 * 新版接口/新参数通过 `config.extraBody` 注入，不需要改这里。
 */
import type { AiUsage } from '@cordclean/shared'
import {
  applyEffort,
  deepMerge,
  JSON_HINT_ZH,
  resolveChatUrl,
  wantsJson,
  type AiConfig,
} from './config.ts'
import { AiError } from './http.ts'

export interface BuiltRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, any>
}

export interface ParsedResponse {
  /** 模型通过函数调用返回的结构化参数 */
  toolCalls?: Array<{ name: string; arguments: any }>
  text: string
  reasoning?: string
  /** 结束原因（length / max_tokens / incomplete 视为截断） */
  finish?: string
  usage?: AiUsage
  truncated: boolean
  raw: any
}

/** 按形态生成鉴权头 */
export function authHeaders(config: AiConfig, apiKey: string): Record<string, string> {
  if (config.apiShape === 'messages') {
    return {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      // DeepSeek 会忽略该头，但标准 Anthropic 客户端要求，保留以兼容其它厂商
      'anthropic-version': '2023-06-01',
    }
  }
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
  }
}

/** 大小写不敏感地合并请求头（用户配置优先） */
export function mergeHeaders(base: Record<string, string>, extra: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = { ...base }
  const lowerKeys = new Map(Object.keys(result).map((key) => [key.toLowerCase(), key]))
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (typeof value !== 'string' || !key) continue
    const existing = lowerKeys.get(key.toLowerCase())
    if (existing) delete result[existing]
    result[key] = value
    lowerKeys.set(key.toLowerCase(), key)
  }
  return result
}

/**
 * 组装请求。
 * @param config 插件配置
 * @param apiKey 已解析的 API Key（配置或环境变量）
 * @param systemPrompt system 提示词
 * @param userPrompt 用户消息（含本机画像）
 */
export function buildRequest(config: AiConfig, apiKey: string, systemPrompt: string, userPrompt: string, tools?: any[], image?: { mime: string; data: string }): BuiltRequest {
  const url = resolveChatUrl(config)
  const headers = mergeHeaders(authHeaders(config, apiKey), config.extraHeaders)
  const jsonHint = wantsJson(config) && config.apiShape === 'messages' ? JSON_HINT_ZH : ''
  let body: Record<string, any>

  if (config.apiShape === 'messages') {
    body = {
      model: config.model,
      max_tokens: config.maxTokens,
      system: systemPrompt + jsonHint,
      messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt }] }],
    }
    if (config.temperature >= 0) body.temperature = config.temperature
    applyEffort(body, 'messages', config.reasoningEffort)
  } else if (config.apiShape === 'responses') {
    body = {
      model: config.model,
      instructions: systemPrompt + jsonHint,
      input: userPrompt,
      max_output_tokens: config.maxTokens,
      stream: false,
    }
    if (config.temperature >= 0) body.temperature = config.temperature
    applyEffort(body, 'responses', config.reasoningEffort)
    if (wantsJson(config)) body.text = { format: { type: 'json_object' } }
  } else {
    body = {
      model: config.model,
      messages: [
        { role: 'system', content: systemPrompt + jsonHint },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: config.maxTokens,
      stream: false,
    }
    if (config.temperature >= 0) body.temperature = config.temperature
    applyEffort(body, 'chat', config.reasoningEffort)
    if (wantsJson(config)) body.response_format = { type: 'json_object' }
  }

  if (image) {
    if (config.apiShape === 'responses') throw new Error('当前接口形态暂不支持图片输入，请切换到 chat 或 messages')
    const messages = (body as any).messages
    const last = messages?.[messages.length - 1]
    if (!last) throw new Error('请求体缺少 messages')
    if (config.apiShape === 'chat') {
      last.content = [
        { type: 'text', text: String(last.content ?? '') },
        { type: 'image_url', image_url: { url: 'data:' + image.mime + ';base64,' + image.data } },
      ]
    } else {
      const blocks = Array.isArray(last.content) ? last.content : [{ type: 'text', text: String(last.content ?? '') }]
      blocks.push({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.data } })
      last.content = blocks
    }
  }

  // 逃生舱：用户可以通过 extraBody 覆盖/新增任意字段（含上面所有字段）
  return { url, headers, body: deepMerge(body, config.extraBody) }
}

function textFromParts(parts: unknown): string {
  if (typeof parts === 'string') return parts
  if (!Array.isArray(parts)) return ''
  return parts
    .map((part: any) => {
      if (typeof part === 'string') return part
      if (!part || typeof part !== 'object') return ''
      if (typeof part.text === 'string') return part.text
      if (typeof part.content === 'string') return part.content
      return ''
    })
    .join('')
}

function normalizeUsage(input: unknown, output: unknown, reasoning: unknown, total?: unknown): AiUsage | undefined {
  const inputTokens = Number(input)
  const outputTokens = Number(output)
  if (!Number.isFinite(inputTokens) && !Number.isFinite(outputTokens)) return undefined
  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    reasoningTokens: Number.isFinite(Number(reasoning)) ? Number(reasoning) : 0,
    totalTokens: Number.isFinite(Number(total)) ? Number(total) : undefined,
  }
}

/** 解析响应；形态不匹配时给出明确提示而不是静默返回空字符串 */
export function parseResponse(config: AiConfig, payload: any): ParsedResponse {
  if (!payload || typeof payload !== 'object') {
    throw new AiError('接口返回内容为空或不是对象', 'INVALID_RESPONSE')
  }

  const toolCalls: Array<{ name: string; arguments: any }> = []
  const pushArgs = (name: string, raw: any) => {
    if (!name) return
    let parsed = raw
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw) } catch { return }
    }
    toolCalls.push({ name, arguments: parsed })
  }
  if (Array.isArray(payload.choices?.[0]?.message?.tool_calls)) {
    for (const call of payload.choices[0].message.tool_calls) pushArgs(call?.function?.name, call?.function?.arguments)
  }
  if (Array.isArray(payload.content)) {
    for (const block of payload.content) if (block?.type === 'tool_use') pushArgs(block.name, block.input)
  }
  if (Array.isArray(payload.output)) {
    for (const item of payload.output) if (item?.type === 'function_call') pushArgs(item.name, item.arguments)
  }
  if (config.apiShape === 'messages' && Array.isArray(payload.content)) {
    const text = payload.content
      .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
      .map((block: any) => block.text)
      .join('')
    const reasoning = payload.content
      .filter((block: any) => block?.type === 'thinking' && typeof block.thinking === 'string')
      .map((block: any) => block.thinking)
      .join('\n')
    if (!text && !reasoning && toolCalls.length === 0) {
      throw new AiError('Anthropic 响应里没有文本内容，请检查 apiShape 是否与接口匹配', 'INVALID_RESPONSE', 200, payload)
    }
    return {
      text,
      reasoning: reasoning || undefined,
      finish: payload.stop_reason,
      usage: normalizeUsage(payload.usage?.input_tokens, payload.usage?.output_tokens, 0),
      truncated: payload.stop_reason === 'max_tokens',
      toolCalls: toolCalls.length ? toolCalls : undefined,
      raw: payload,
    }
  }

  if (config.apiShape === 'responses' && Array.isArray(payload.output)) {
    const messages = payload.output.filter((item: any) => item?.type === 'message')
    const reasoningItems = payload.output.filter((item: any) => item?.type === 'reasoning')
    const text = messages
      .map((item: any) => textFromParts(item.content))
      .join('')
    const reasoning = reasoningItems
      .map((item: any) => textFromParts(item.content))
      .join('\n')
    if (!text && !reasoning && toolCalls.length === 0) {
      throw new AiError('Responses 响应里没有文本内容，请检查 apiShape 是否与接口匹配', 'INVALID_RESPONSE', 200, payload)
    }
    const usage = payload.usage ?? {}
    return {
      text: text || payload.output_text || '',
      reasoning: reasoning || undefined,
      finish: payload.status,
      usage: normalizeUsage(
        usage.input_tokens,
        usage.output_tokens,
        usage.output_tokens_details?.reasoning_tokens,
        usage.total_tokens,
      ),
      truncated: payload.status === 'incomplete',
      toolCalls: toolCalls.length ? toolCalls : undefined,
      raw: payload,
    }
  }

  const choice = payload.choices?.[0]
  if (choice && (choice.message || choice.text)) {
    const message = choice.message ?? { content: choice.text }
    const text = textFromParts(message.content)
    const reasoning = typeof message.reasoning_content === 'string'
      ? message.reasoning_content
      : typeof message.reasoning === 'string'
        ? message.reasoning
        : ''
    if (!text && !reasoning && toolCalls.length === 0) {
      throw new AiError('对话响应里没有文本内容，请检查接口返回格式', 'INVALID_RESPONSE', 200, payload)
    }
    const usage = payload.usage ?? {}
    return {
      text,
      reasoning: reasoning || undefined,
      finish: choice.finish_reason,
      usage: normalizeUsage(
        usage.prompt_tokens ?? usage.input_tokens,
        usage.completion_tokens ?? usage.output_tokens,
        usage.completion_tokens_details?.reasoning_tokens,
        usage.total_tokens,
      ),
      truncated: choice.finish_reason === 'length' || choice.finish_reason === 'max_tokens',
      toolCalls: toolCalls.length ? toolCalls : undefined,
      raw: payload,
    }
  }

  // 形态不匹配：把实际字段名列出来，方便用户判断该选哪种 apiShape
  const keys = Object.keys(payload).slice(0, 12).join(', ')
  throw new AiError(
    `无法识别的响应结构（当前 apiShape=${config.apiShape}）。返回字段：${keys}`,
    'INVALID_RESPONSE',
    200,
    payload,
  )
}

/** 解析一条 SSE 增量（三种形态），返回文本与思维链增量 */
export function parseSseDelta(shape: string, payload: any): { text?: string; reasoning?: string } {
  if (!payload || typeof payload !== 'object') return {}
  if (shape === 'messages') {
    if (payload.type === 'content_block_delta') {
      const delta = payload.delta ?? {}
      if (typeof delta.text === 'string') return { text: delta.text }
      if (typeof delta.thinking === 'string') return { reasoning: delta.thinking }
    }
    return {}
  }
  if (shape === 'responses') {
    if (payload.type === 'response.output_text.delta' && typeof payload.delta === 'string') return { text: payload.delta }
    if (payload.type === 'response.reasoning_summary_text.delta' && typeof payload.delta === 'string') return { reasoning: payload.delta }
    return {}
  }
  const delta = payload.choices?.[0]?.delta
  if (!delta) return {}
  return {
    text: typeof delta.content === 'string' ? delta.content : undefined,
    reasoning: typeof delta.reasoning_content === 'string' ? delta.reasoning_content : undefined,
  }
}
