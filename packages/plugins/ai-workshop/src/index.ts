/**
 * AI 插件工坊插件（独立插件，独立 AI 接口配置）。
 *
 * 与「AI 清理顾问」完全拆开：
 *   - AI 清理顾问：清理建议/规则评估，自己的 API 配置；
 *   - AI 插件工坊：生成 v2 插件包草稿，自己的 API Key / baseUrl / 接口形态 / 模型 / token / 重试 / 提示词。
 *
 * 两者互不依赖：只启用工坊也能用，只启用顾问也能用；工坊生成结果走宿主安装事务。
 */
import Schema from 'schemastery'
import { Service, type Context } from 'cordis'
import { defineCleanerPlugin } from '@cordclean/shared'
import type { AiModelInfo, AiPluginDraft, AiWorkshopStatus } from '@cordclean/shared'
import {
  AiError,
  FALLBACK_MODELS,
  PLUGIN_SYSTEM_PROMPT,
  PLUGIN_TOOL,
  PLUGIN_USER_PREFIX,
  buildRequest,
  checkPluginSyntax,
  extractPluginCode,
  extractToolArgsFromText,
  fetchModelList,
  normalizeConfig,
  normalizeDependencies,
  normalizePluginFiles,
  normalizePluginManifest,
  parseResponse,
  pickPluginKind,
  requestJson,
  requestSse,
  type AiConfig,
} from '@cordclean/plugin-ai'
import { WORKSHOP_PACKAGE_CONTRACT, prepareWorkshopDraft } from './contract.ts'

export const Config = Schema.object({
  apiKey: Schema.string().default('').description('工坊独立 API Key（留空则读取环境变量 DEEPSEEK_API_KEY / OPENAI_API_KEY）'),
  baseUrl: Schema.string().default('https://api.deepseek.com').description('接口根地址，例如 https://api.deepseek.com'),
  apiShape: Schema.union(['chat', 'messages', 'responses']).default('chat').description('接口形态：chat=OpenAI 兼容，messages=Anthropic 兼容，responses=OpenAI Responses'),
  chatPath: Schema.string().default('').description('聊天路径；留空按接口形态取默认值'),
  modelsPath: Schema.string().default('/models').description('模型列表路径（相对 baseUrl）'),
  modelsUrl: Schema.string().default('').description('模型列表完整 URL（优先于 modelsPath）'),
  model: Schema.string().default('deepseek-flash').description('工坊生成插件使用的模型；建议 deepseek-flash（1M 上下文，适合长代码）'),
  maxTokens: Schema.number().default(65_536).min(0).max(1_000_000).description('单次生成最大输出 token；0 表示使用默认值 131072 内收敛；小于等于 2048 的值会被自动提升为 65536，避免代码输出被截断'),
  temperature: Schema.number().default(-1).min(-1).max(2).description('温度；-1 表示不发送'),
  timeoutMs: Schema.number().default(180_000).min(0).max(600_000).description('单次请求超时（毫秒）；0=默认 180 秒'),
  retries: Schema.number().default(1).min(0).max(5).description('失败重试次数（截断/契约不通过会额外重试）'),
  reasoningEffort: Schema.union(['auto', 'off', 'low', 'medium', 'high', 'max']).default('auto').description('思考等级：auto=不干预，off=关闭思考，low/medium/high/max=开启并指定强度'),
  jsonMode: Schema.union(['auto', 'on', 'off']).default('auto').description('JSON 输出模式：auto=接口支持时启用'),
  systemPrompt: Schema.string().default('').description('追加到工坊 system prompt 的额外要求（例如团队编码规范）'),
  extraBodyText: Schema.string().default('').description('额外请求体（JSON 文本，深合并，优先级最高）'),
  extraHeadersText: Schema.string().default('').description('额外请求头（JSON 文本）'),
})

/** 供宿主/界面调用的工坊服务（命名空间 aiWorkshop） */
export class AiWorkshopService extends Service {
  private readonly config: AiConfig
  private modelCache?: { at: number; models: AiModelInfo[]; source: 'remote' | 'fallback' }
  /** 当前正在进行的生成：宿主 cancel 接口用它真正中断 HTTP 请求 */
  private draftController?: AbortController
  /** 生成序号：取消/新生成都会 +1，迟到的结果据此判断是否还属于当前请求 */
  private draftSeq = 0

  constructor(ctx: Context, raw: Partial<AiConfig> & { extraBodyText?: string; extraHeadersText?: string }) {
    super(ctx, 'aiWorkshop')
    const { extraBodyText, extraHeadersText, ...rest } = raw
    this.config = normalizeConfig({
      ...rest,
      stream: false,
      ...(parseJsonRecord(extraBodyText) ? { extraBody: parseJsonRecord(extraBodyText) } : {}),
      ...(parseJsonRecord(extraHeadersText) ? { extraHeaders: parseJsonRecord(extraHeadersText) } : {}),
    } as Partial<AiConfig>)
  }

  private resolveKey(): string {
    return String(
      this.config.apiKey?.trim() || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || '',
    ).trim()
  }

  configured(): boolean {
    return Boolean(this.resolveKey())
  }

  status(): AiWorkshopStatus {
    return {
      available: true,
      configured: this.configured(),
      model: this.config.model,
      aiModel: '',
      inheritsModel: false,
      shape: this.config.apiShape,
      baseUrl: this.config.baseUrl,
      maxTokens: this.config.maxTokens || 65_536,
      retries: this.config.retries,
      timeoutMs: this.config.timeoutMs || 180_000,
      systemPromptExtra: this.config.systemPrompt,
      effort: this.config.reasoningEffort,
      jsonMode: this.config.jsonMode,
      apiKeySource: this.config.apiKey?.trim()
        ? 'config'
        : String(process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || '').trim()
          ? 'env'
          : 'none',
    }
  }

  /** 工坊自己的模型列表（用于界面下拉；失败用内置兜底） */
  async models(refresh = false): Promise<{ source: 'remote' | 'fallback'; models: AiModelInfo[] }> {
    if (!refresh && this.modelCache && Date.now() - this.modelCache.at < 60_000) {
      return { source: this.modelCache.source, models: this.modelCache.models }
    }
    const key = this.resolveKey()
    if (!key) return { source: 'fallback', models: FALLBACK_MODELS }
    try {
      const result = await fetchModelList(this.config, key)
      this.modelCache = { at: Date.now(), source: result.source, models: result.models }
      return { source: result.source, models: result.models }
    } catch {
      return { source: 'fallback', models: FALLBACK_MODELS }
    }
  }

  private projectBrief(): string {
    try {
      const tasks = this.ctx.cleaner
        .list()
        .slice(0, 80)
        .map((task) => `${task.id}（${task.name}，${task.category}/${task.risk}）`)
      return tasks.length ? `当前内置清理任务如下，生成的插件不要重复定义这些任务：${tasks.join('；')}` : ''
    } catch {
      return ''
    }
  }

  /**
   * 取消正在进行的生成：中断宿主 HTTP 请求（SSE / JSON）。
   * 返回 false 表示当前没有进行中的生成（界面可提示「没有可取消的生成」）。
   */
  cancelDraft(): boolean {
    const controller = this.draftController
    this.draftSeq++
    this.draftController = undefined
    if (!controller) return false
    controller.abort()
    try {
      ;(this.ctx.emit as any)('ai/workshop/progress', { phase: 'cancelled', textLength: 0, toolCalls: 0, elapsedMs: 0 })
    } catch {
      /* UI 未连接忽略 */
    }
    return true
  }

  /** 向界面推送生成阶段（request/streaming/received/validating/retry/done/cancelled） */
  private emitProgress(phase: string, extra: { textLength?: number; toolCalls?: number } = {}): void {
    try {
      ;(this.ctx.emit as any)('ai/workshop/progress', {
        phase,
        textLength: Math.max(0, Math.floor(Number(extra.textLength) || 0)),
        toolCalls: Math.max(0, Math.floor(Number(extra.toolCalls) || 0)),
        elapsedMs: 0,
      })
    } catch {
      /* UI 未连接忽略 */
    }
  }

  /** 真实流式生成（chat 形态）：边收 token / tool_calls 边上报进度，失败回退非流式 */
  private async streamChatDraft(
    request: ReturnType<typeof buildRequest>,
    config: AiConfig,
    signal?: AbortSignal,
  ): Promise<{ text: string; toolCalls: Array<{ name: string; arguments: any }>; finish?: string } | null> {
    if (config.apiShape !== 'chat') return null
    let text = ''
    let finish: string | undefined
    const calls = new Map<number, { name: string; args: string }>()
    let lastEmit = 0
    const emit = (phase: string) => {
      const now = Date.now()
      if (now - lastEmit < 120 && phase === 'streaming') return
      lastEmit = now
      try {
        ;(this.ctx.emit as any)('ai/workshop/progress', {
          phase,
          textLength: text.length,
          toolCalls: calls.size,
          elapsedMs: now,
        })
      } catch {
        /* UI 未连接忽略 */
      }
    }
    try {
      await requestSse(
        request.url,
        {
          headers: request.headers,
          body: JSON.stringify({ ...(request.body as Record<string, unknown>), stream: true }),
          timeoutMs: config.timeoutMs || 180_000,
          signal,
        },
        (payload: any) => {
          const choice = payload?.choices?.[0]
          const delta = choice?.delta
          if (typeof delta?.content === 'string' && delta.content) text += delta.content
          if (Array.isArray(delta?.tool_calls)) {
            for (const call of delta.tool_calls) {
              const index = Number(call?.index ?? 0)
              const current = calls.get(index) ?? { name: '', args: '' }
              if (typeof call?.function?.name === 'string') current.name += call.function.name
              if (typeof call?.function?.arguments === 'string') current.args += call.function.arguments
              calls.set(index, current)
            }
          }
          if (typeof choice?.finish_reason === 'string') finish = choice.finish_reason
          emit('streaming')
        },
      )
    } catch (error) {
      // 用户取消：不要吞掉后回退到非流式，直接把 CANCELLED 抛给上层
      if (signal?.aborted) throw new AiError('生成已取消', 'CANCELLED')
      this.ctx.logger.warn('工坊流式请求失败，回退非流式：%s', error instanceof Error ? error.message : String(error))
      return null
    }
    const toolCalls: Array<{ name: string; arguments: any }> = []
    for (const call of [...calls.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!call.name || !call.args.trim()) continue
      try {
        toolCalls.push({ name: call.name, arguments: JSON.parse(call.args) })
      } catch {
        /* 参数未完整/损坏；交给文本解析兜底 */
      }
    }
    if (!text.trim() && !toolCalls.length) return null
    emit('received')
    return { text, toolCalls, finish }
  }

  /** 对外入口：同一时间只允许一个生成；新生成会先取消上一次请求 */
  async draftPlugin(requirement: string): Promise<AiPluginDraft> {
    this.cancelDraft()
    this.draftSeq += 1
    const seq = this.draftSeq
    const controller = new AbortController()
    this.draftController = controller
    try {
      return await this.runDraft(requirement, controller.signal)
    } finally {
      if (this.draftSeq === seq && this.draftController === controller) this.draftController = undefined
    }
  }

  private async runDraft(requirement: string, signal: AbortSignal): Promise<AiPluginDraft> {
    const demand = String(requirement ?? '').trim()
    if (!demand) throw new AiError('请先描述你想要的插件', 'BAD_REQUEST')
    const key = this.resolveKey()
    if (!key) {
      throw new AiError(
        'AI 插件工坊还没有配置 API Key：请在「AI 插件工坊」页面的接口设置里填写，或设置环境变量 DEEPSEEK_API_KEY。未配置 Key 时工坊不可用（这是预期行为），也不会提供离线生成/模板等绕过方式。',
        'AUTH',
      )
    }
    const base = this.config
    const brief = this.projectBrief()
    const extra = String(base.systemPrompt ?? '').trim()
    const attempts = Math.max(1, Math.min(5, Math.trunc(base.retries ?? 1) + 1))
    const baseMaxTokens = Math.max(32_768, base.maxTokens || 65_536)
    /** 只有「输出被截断」才扩容 token；契约/语法失败扩容只会让输出更啰嗦 */
    let boostTokens = false
    let lastError = '生成失败'
    let lastFailure: 'unknown' | 'truncated' | 'contract' | 'syntax' | 'empty' = 'unknown'
    let feedback = ''

    for (let attempt = 0; attempt < attempts; attempt++) {
      // 每轮尝试前检查取消：用户放弃后不再发起重试/下一次请求
      if (signal.aborted) throw new AiError('生成已取消', 'CANCELLED')
      const maxTokens = boostTokens ? Math.min(131_072, baseMaxTokens * 2) : baseMaxTokens
      const systemPrompt =
        PLUGIN_SYSTEM_PROMPT +
        '\n\n' +
        WORKSHOP_PACKAGE_CONTRACT +
        (brief ? '\n\n' + brief : '') +
        (extra ? '\n\n【工坊额外要求】\n' + extra : '')
      const request = buildRequest(
        { ...base, maxTokens },
        key,
        systemPrompt,
        PLUGIN_USER_PREFIX + demand + feedback,
        [PLUGIN_TOOL],
      )
      this.emitProgress('request')
      let parsed: any
      let streamedToolArgs: any
      const streamed = await this.streamChatDraft(request, base, signal)
      if (streamed) {
        parsed = {
          text: streamed.text,
          reasoning: undefined,
          finish: streamed.finish,
          truncated: streamed.finish === 'length',
          usage: undefined,
          raw: {},
          toolCalls: streamed.toolCalls,
        }
        streamedToolArgs = streamed.toolCalls.find((call: any) => call.name === 'emit_plugin')?.arguments
      } else {
        const result = await requestJson(request.url, {
          headers: request.headers,
          body: request.body,
          timeoutMs: base.timeoutMs || 180_000,
          retries: base.retries ?? 1,
          signal,
        })
        parsed = parseResponse(base, result.payload)
      }
      if (parsed.truncated) {
        lastFailure = 'truncated'
        lastError = `输出被截断（${parsed.finish ?? 'length'}）`
        boostTokens = true
        feedback = '\n\n上一次输出被截断。请直接输出完整、可运行的代码，不要省略、不要 JSON 包装；优先给精简实现，避免重复代码。'
        this.emitProgress('retry')
        continue
      }
      const toolArgs = streamedToolArgs ?? parsed.toolCalls?.find((call: any) => call.name === 'emit_plugin')?.arguments ?? extractToolArgsFromText(parsed.text)
      const packageFiles = normalizePluginFiles(toolArgs?.files)
      const packageManifest = normalizePluginManifest(toolArgs?.manifest)
      const entryName = packageManifest?.entry || 'index.mjs'
      // code 在工具契约里是可选的（推荐直接放 files）；按「manifest.entry → index.mjs → 第一个文件」兜底，
      // 避免模型只给 files 时被误判为“没有返回有效代码”。
      const fileCode =
        packageFiles.find((file) => file.path === entryName)?.content ??
        packageFiles.find((file) => file.path === 'index.mjs')?.content ??
        packageFiles[0]?.content
      const code =
        toolArgs && typeof toolArgs.code === 'string' && toolArgs.code.trim()
          ? toolArgs.code.trim()
          : fileCode || extractPluginCode(parsed.text)
      const dependencies = normalizeDependencies(toolArgs?.dependencies ?? extractDependenciesFromText(parsed.text))
      const kind = pickPluginKind(toolArgs?.kind ?? extractKindFromCode(code))
      if (!code && packageFiles.length === 0) {
        lastFailure = 'empty'
        lastError = '模型没有返回有效的插件代码'
        feedback = '\n\n上一次没有返回有效代码。请输出 files 数组（至少包含入口文件 index.mjs），或输出单文件 code。'
        this.emitProgress('retry')
        continue
      }
      this.emitProgress('validating', { textLength: parsed.text.length, toolCalls: 1 })
      // 安装前自检：与宿主安装事务共用同一套共享校验器（清单 / 文件 / 入口源码 / client bridge）。
      // 能自动修的字段直接修；修不了的把可读错误回喂给模型重试，避免「生成成功但装不上」。
      const prep = prepareWorkshopDraft({
        name: toolArgs?.name,
        code,
        files: packageFiles,
        manifest: packageManifest,
        dependencies,
        kind,
        notes: parsed.text.slice(0, 200),
      })
      if (prep.errors.length) {
        lastFailure = 'contract'
        lastError = prep.errors.slice(0, 3).join('；')
        feedback =
          '\n\n上一次生成的插件包未通过安装前校验（宿主安装时会再次执行同一套校验）：\n- ' +
          prep.errors.join('\n- ') +
          '\n请逐条修正后重新输出完整插件包（manifest 与 files 必须一致；不要 import 未声明包；不要使用禁止 API）。'
        this.ctx.logger.info('工坊插件包未通过安装前校验，自动重试：%s', prep.errors[0])
        this.emitProgress('retry', { textLength: parsed.text.length, toolCalls: 1 })
        continue
      }
      const syntaxError = await checkPluginSyntax(prep.draft.code)
      if (syntaxError) {
        lastFailure = 'syntax'
        lastError = '语法错误：' + syntaxError
        feedback = '\n\n上一次生成的插件代码有语法错误：\n' + syntaxError + '\n请输出语法完整、括号配对的代码，不要省略结尾。'
        this.ctx.logger.info('工坊插件代码语法错误，自动重试：%s', syntaxError.slice(0, 200))
        this.emitProgress('retry', { textLength: parsed.text.length, toolCalls: 1 })
        continue
      }
      // 校验期间用户可能点了「放弃生成」：迟到的结果不再返回给界面
      if (signal.aborted) throw new AiError('生成已取消', 'CANCELLED')
      this.emitProgress('done', { textLength: parsed.text.length, toolCalls: 1 })
      return prep.draft
    }
    throw finalDraftError(lastFailure, lastError)
  }
}

function parseJsonRecord(text: string | undefined): Record<string, unknown> | undefined {
  const raw = String(text ?? '').trim()
  if (!raw) return undefined
  try {
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
    return data as Record<string, unknown>
  } catch {
    return undefined
  }
}

function extractDependenciesFromText(text: string): Record<string, string> {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const raw = (match ? match[1] : text).trim()
  if (!raw.startsWith('{')) return {}
  try {
    const data = JSON.parse(raw)
    return typeof data === 'object' && data?.dependencies ? data.dependencies : {}
  } catch {
    return {}
  }
}

function extractKindFromCode(code: string): string {
  const matched = code.match(/export\s+const\s+kind\s*=\s*['"]([a-zA-Z-]+)['"]/)
  return matched?.[1] ?? ''
}

/**
 * 多次重试后的最终失败：按最后一次失败的阶段给准确错误码与可读文案。
 * - 安装前校验 / 语法问题属于「生成物不合契约」→ BAD_REQUEST（界面归类为校验失败，可重试）；
 * - 截断 / 空输出属于「模型没有给出完整内容」→ INVALID_RESPONSE；
 * - 传输层错误（AUTH/TIMEOUT/NETWORK/CANCELLED）在请求阶段就抛出，不经过这里。
 */
function finalDraftError(kind: 'unknown' | 'truncated' | 'contract' | 'syntax' | 'empty', detail: string): AiError {
  const reason = String(detail ?? '').trim() || '生成失败（未知原因）'
  if (kind === 'truncated') {
    return new AiError(
      `模型输出被截断：多次重试仍未完整输出（可把需求拆小，或在接口设置里调大最大输出 token）。最后一次：${reason}`,
      'INVALID_RESPONSE',
    )
  }
  if (kind === 'contract') {
    return new AiError(
      `生成的插件包未通过安装前校验：${reason}。可以重试生成，或把需求拆小/补充约束后再试。`,
      'BAD_REQUEST',
    )
  }
  if (kind === 'syntax') {
    return new AiError(`生成的插件代码有语法错误：${reason}。可以重试生成，或补充“输出完整代码”的要求。`, 'BAD_REQUEST')
  }
  if (kind === 'empty') {
    return new AiError('模型没有返回有效的插件代码：请补充入口文件/插件包要求后重试。', 'INVALID_RESPONSE')
  }
  return new AiError(reason, 'INVALID_RESPONSE')
}

export default defineCleanerPlugin<Partial<AiConfig> & { extraBodyText?: string; extraHeadersText?: string }>({
  name: 'ai-workshop',
  version: '2.0.0',
  description: '独立插件：按需求生成 v2 插件包草稿；拥有独立的 API Key / 接口形态 / 模型 / 提示词配置',
  inject: ['cleaner'],
  Config,
  setup(ctx, config) {
    const service = new AiWorkshopService(ctx, config)
    const status = service.status()
    ctx.logger.info(
      'AI 插件工坊已就绪：%s · 模型 %s · %s',
      status.shape,
      status.model,
      status.configured ? '已配置 API Key' : '未配置 API Key（可在工坊页面填写）',
    )
  },
})
