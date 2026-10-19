/**
 * AI 插件配置模型。
 *
 * 设计原则：**接口是会被厂商改的，配置不能不跟着变**。
 * 因此所有与具体接口相关的部分（地址、路径、形态、模型名、推理等级、
 * 以及未来可能新增的任何请求参数）都做成可配置项，而不是写死在代码里：
 *
 * - `apiShape`：chat（OpenAI 兼容）/ messages（Anthropic 兼容）/ responses（OpenAI Responses 兼容）；
 * - `baseUrl` + `chatPath` + `modelsPath`：地址与路径都可改；
 * - `model`：自由文本，配合 `/models` 动态列表；
 * - `reasoningEffort`：抽象为 auto/off/low/medium/high/max，按形态映射成各自的字段；
 * - `extraBody` / `extraHeaders`：任意新增参数与请求头的逃生舱，深合并进最终请求。
 */
import Schema from 'schemastery'

/** 三种接口形态 */
export type ApiShape = 'chat' | 'messages' | 'responses'
/** 推理等级（与具体厂商解耦） */
export type EffortLevel = 'auto' | 'off' | 'low' | 'medium' | 'high' | 'max'
/** JSON 输出模式：auto=该形态支持就启用 */
export type JsonMode = 'auto' | 'on' | 'off'

export const API_SHAPES: ApiShape[] = ['chat', 'messages', 'responses']
export const EFFORT_LEVELS: EffortLevel[] = ['auto', 'off', 'low', 'medium', 'high', 'max']

/** 各形态的默认聊天路径（用户可覆盖） */
export const DEFAULT_PATHS: Record<ApiShape, string> = {
  chat: '/chat/completions',
  messages: '/v1/messages',
  responses: '/responses',
}

/** 各形态的默认 baseUrl（仅作为初始值，用户可改） */
export const DEFAULT_BASE_URLS: Record<ApiShape, string> = {
  chat: 'https://api.deepseek.com',
  messages: 'https://api.deepseek.com/anthropic',
  responses: 'https://api.deepseek.com',
}

export interface AiConfig {
  /** API Key；留空则读取环境变量 DEEPSEEK_API_KEY / OPENAI_API_KEY */
  apiKey: string
  /** 是否使用 SSE 流式输出（默认 true，失败自动回退） */
  stream: boolean
  baseUrl: string
  apiShape: ApiShape
  /** 聊天接口路径；留空按形态取默认值 */
  chatPath: string
  /** 模型列表路径（相对 baseUrl） */
  modelsPath: string
  /** 模型列表完整 URL（优先于 modelsPath，便于代理/反代场景） */
  modelsUrl: string
  model: string
  reasoningEffort: EffortLevel
  jsonMode: JsonMode
  maxTokens: number
  /** 温度；-1 表示不发送该字段 */
  temperature: number
  timeoutMs: number
  /** 失败重试次数（仅对超时/429/5xx 生效） */
  retries: number
  includeObservations: boolean
  /** 启用哪些上下文采集器（空=采集器默认集合） */
  contextProviders: string[]
  /** 是否作为规则评估器（替换内置启发式） */
  asEvaluator: boolean
  /** 覆盖默认 system prompt（留空使用内置） */
  systemPrompt: string
  /** 额外请求体字段（深合并，优先级最高） */
  extraBody: Record<string, any>
  /** 额外请求头（覆盖同名默认头） */
  extraHeaders: Record<string, string>
  /** 兼容旧配置：保留字段 */
  timeout?: number
  max_tokens?: number
}

/** 默认 system prompt 之外的输出约束提示（用于 JSON 模式不可用的接口形态） */
export const JSON_HINT_ZH = '\n\n只输出一个 JSON 对象，不要输出 Markdown 代码块、解释或前后缀文字。'

const SchemaConfig = Schema.object({
  stream: Schema.boolean().default(true).description('SSE 流式输出（失败自动回退非流式）'),
  apiKey: Schema.string().default('').description('API Key（留空则读取环境变量 DEEPSEEK_API_KEY / OPENAI_API_KEY）'),
  baseUrl: Schema.string().default('https://api.deepseek.com').description('接口根地址，例如 https://api.deepseek.com/anthropic'),
  apiShape: Schema.union(API_SHAPES).default('chat').description('接口形态：chat=OpenAI 兼容，messages=Anthropic 兼容，responses=OpenAI Responses'),
  chatPath: Schema.string().default('').description('聊天接口路径，留空按形态取默认值（/chat/completions、/anthropic/v1/messages、/responses）'),
  modelsPath: Schema.string().default('/models').description('模型列表路径（相对 baseUrl）'),
  modelsUrl: Schema.string().default('').description('模型列表完整 URL（优先于 modelsPath）'),
  model: Schema.string().default('deepseek-flash').description('模型名，可任意填写；界面可从 /models 拉取候选'),
  reasoningEffort: Schema.union(EFFORT_LEVELS).default('auto').description('推理等级：auto=不干预，off=关闭思考，low/medium/high/max=开启并指定强度'),
  jsonMode: Schema.union(['auto', 'on', 'off']).default('auto').description('JSON 输出：auto=接口支持时启用'),
  maxTokens: Schema.number().default(0).min(0).max(1000000).description('最大输出 token（含思维链）；0=使用默认值 393216（按模型上限收敛）'),
  temperature: Schema.number().default(-1).min(-1).max(2).description('温度，-1 表示不发送（思考模式下该参数不生效）'),
  timeoutMs: Schema.number().default(0).min(0).max(600_000).description('单次请求超时（毫秒）；0=使用默认值 90000'),
  /** 以下两个字段仅为兼容 v1 配置，新配置请使用 timeoutMs / maxTokens */
  timeout: Schema.number().default(0).description('[已废弃] 旧字段，等价于 timeoutMs'),
  max_tokens: Schema.number().default(0).description('[已废弃] 旧字段，等价于 maxTokens'),
  retries: Schema.number().default(1).min(0).max(5).description('失败重试次数（超时/429/5xx）'),
  contextProviders: Schema.array(Schema.string()).default([]).description('启用的 AI 上下文采集器 id（空=默认集合）'),
  includeObservations: Schema.boolean().default(true).description('是否让模型附带其它观察'),
  asEvaluator: Schema.boolean().default(false).description('作为规则评估器：扫描时用 AI 决定每类规则的风险与是否默认勾选（默认关闭，走内置启发式）'),
  systemPrompt: Schema.string().default('').description('自定义 system prompt（留空使用内置的清理专家提示词）'),
  extraBody: Schema.dict(Schema.any()).default({}).description('追加到请求体的任意字段（深合并、优先级最高），例如 {"top_p":0.95,"tools":[]}'),
  extraHeaders: Schema.dict(Schema.string()).default({}).description('追加/覆盖请求头，例如 {"x-api-key":"..."}'),
})

export const Config = SchemaConfig

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function pickShape(value: unknown): ApiShape {
  return API_SHAPES.includes(value as ApiShape) ? (value as ApiShape) : 'chat'
}

function pickEffort(value: unknown): EffortLevel {
  return EFFORT_LEVELS.includes(value as EffortLevel) ? (value as EffortLevel) : 'auto'
}

/**
 * 规范化配置：补齐默认值、兼容旧字段、修正非法枚举。
 * 允许用户手改 config.json，因此这里必须对任何输入都给出可用结果。
 */
export function normalizeConfig(raw: Partial<AiConfig> | undefined): AiConfig {
  const input = (raw ?? {}) as Partial<AiConfig>
  const shape = pickShape(input.apiShape)
  const baseUrl = String(input.baseUrl ?? '').trim() || DEFAULT_BASE_URLS[shape]
  const chatPath = String(input.chatPath ?? '').trim() || DEFAULT_PATHS[shape]
  // timeoutMs/maxTokens 的 schema 默认值是 0（未设置），这里再回落到旧字段与内置默认值
  const timeoutMs = Number(input.timeoutMs ?? 0) || Number(input.timeout ?? 0) || 90_000
  let maxTokens = Number(input.maxTokens ?? 0) || Number((input as any).max_tokens ?? 0) || 393216
  if (maxTokens <= 2048) maxTokens = 65536

  return {
    stream: input.stream !== false,
    apiKey: String(input.apiKey ?? '').trim(),
    baseUrl,
    apiShape: shape,
    chatPath,
    modelsPath: String(input.modelsPath ?? '/models').trim() || '/models',
    modelsUrl: String(input.modelsUrl ?? '').trim(),
    model: String(input.model ?? '').trim() || 'deepseek-flash',
    reasoningEffort: pickEffort(input.reasoningEffort),
    jsonMode: (['auto', 'on', 'off'] as const).includes(input.jsonMode as any) ? (input.jsonMode as JsonMode) : 'auto',
  maxTokens: Number.isFinite(maxTokens) ? Math.min(1000000, Math.max(128, Math.trunc(maxTokens))) : 393216,
    temperature: Number.isFinite(Number(input.temperature)) ? Number(input.temperature) : -1,
    timeoutMs: Number.isFinite(timeoutMs) ? Math.min(600_000, Math.max(3_000, Math.trunc(timeoutMs))) : 90_000,
    retries: Number.isFinite(Number(input.retries)) ? Math.min(5, Math.max(0, Math.trunc(Number(input.retries)))) : 1,
    includeObservations: input.includeObservations !== false,
    contextProviders: Array.isArray(input.contextProviders) ? input.contextProviders.map(String) : [],
    asEvaluator: input.asEvaluator === true,
    systemPrompt: String(input.systemPrompt ?? ''),
    extraBody: isPlainObject(input.extraBody) ? input.extraBody : {},
    extraHeaders: isPlainObject(input.extraHeaders) ? (input.extraHeaders as Record<string, string>) : {},
    timeout: input.timeout,
    max_tokens: input.max_tokens,
  }
}

/** 拼接 URL（路径可以是完整 URL） */
export function joinUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  const base = baseUrl.replace(/\/+$/, '')
  const suffix = path.startsWith('/') ? path : `/${path}`
  return base + suffix
}

/**
 * 聊天接口完整地址。
 *
 * Anthropic 兼容形态有个坑：其 baseUrl 必须是 `.../anthropic`，
 * 但用户很可能只填 `https://api.deepseek.com`。这里在路径以 `/v1/messages`
 * 开头、而 baseUrl 又没有 `/anthropic` 后缀时自动补上，
 * 避免拼出 `.../anthropic/anthropic/v1/messages` 这种 404 地址。
 */
export function resolveChatUrl(config: AiConfig): string {
  const path = config.chatPath || DEFAULT_PATHS[config.apiShape]
  if (config.apiShape === 'messages' && /^\/?v1\/messages/i.test(path)) {
    const base = config.baseUrl.replace(/\/+$/, '')
    const withPrefix = /\/anthropic$/i.test(base) ? base : `${base}/anthropic`
    return joinUrl(withPrefix, path)
  }
  return joinUrl(config.baseUrl, path)
}

/**
 * 模型列表地址。
 *
 * DeepSeek 的模型列表挂在根域 `/models`，而 Anthropic 兼容形态的 baseUrl 是
 * `https://api.deepseek.com/anthropic`，因此这里对 `/anthropic` 后缀做了特判。
 */
export function resolveModelsUrl(config: AiConfig): string {
  if (config.modelsUrl) return joinUrl(config.baseUrl, config.modelsUrl)
  try {
    const url = new URL(config.baseUrl)
    if (/\/anthropic\/?$/i.test(url.pathname)) {
      return `${url.origin}${config.modelsPath || '/models'}`
    }
  } catch {
    /* baseUrl 不是合法 URL 时按普通拼接处理 */
  }
  return joinUrl(config.baseUrl, config.modelsPath || '/models')
}

/**
 * 把抽象推理等级翻译成具体接口字段。
 *
 * 映射关系参考 DeepSeek 官方文档（2026-10）：
 * - chat：`thinking: {type}` + `reasoning_effort: low|high|max`；
 * - messages：`thinking: {type}` + `output_config: {effort}`；
 * - responses：`reasoning: {effort}`，`none` 表示关闭。
 * 若厂商以后调整字段，用 `extraBody` 覆盖即可，无需改代码。
 */
export function applyEffort(body: Record<string, any>, shape: ApiShape, effort: EffortLevel): void {
  if (effort === 'auto') return
  const level = effort === 'medium' ? 'high' : effort
  if (shape === 'chat') {
    body.thinking = { type: effort === 'off' ? 'disabled' : 'enabled' }
    if (effort !== 'off') body.reasoning_effort = level
    return
  }
  if (shape === 'messages') {
    body.thinking = { type: effort === 'off' ? 'disabled' : 'enabled' }
    if (effort !== 'off') body.output_config = { effort: level }
    return
  }
  body.reasoning = { effort: effort === 'off' ? 'none' : level }
}

/** 是否启用 JSON 输出（auto 视为启用） */
export function wantsJson(config: AiConfig): boolean {
  return config.jsonMode !== 'off'
}

/** 深合并（数组与标量直接覆盖） */
export function deepMerge<T extends Record<string, any>>(base: T, patch: Record<string, any> | undefined): T {
  if (!isPlainObject(patch)) return base
  const result: Record<string, any> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(result[key])) result[key] = deepMerge(result[key], value)
    else if (value !== undefined) result[key] = value
  }
  return result as T
}
