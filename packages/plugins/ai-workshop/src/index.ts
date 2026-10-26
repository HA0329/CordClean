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
import { checkPluginSource } from '@cordclean/shared'
import type { AiModelInfo, AiPluginDraft, AiPluginFile, AiWorkshopStatus, PluginManifest } from '@cordclean/shared'
import {
  AiError,
  FALLBACK_MODELS,
  PLUGIN_SYSTEM_PROMPT,
  PLUGIN_TOOL,
  PLUGIN_USER_PREFIX,
  buildRequest,
  checkPluginSyntax,
  extractPluginCode,
  fetchModelList,
  normalizeConfig,
  normalizeDependencies,
  normalizePluginFiles,
  normalizePluginManifest,
  parseResponse,
  pickPluginKind,
  requestJson,
  type AiConfig,
} from '@cordclean/plugin-ai'

export const Config = Schema.object({
  apiKey: Schema.string().default('').description('工坊独立 API Key（留空则读取环境变量 DEEPSEEK_API_KEY / OPENAI_API_KEY）'),
  baseUrl: Schema.string().default('https://api.deepseek.com').description('接口根地址，例如 https://api.deepseek.com'),
  apiShape: Schema.union(['chat', 'messages', 'responses']).default('chat').description('接口形态：chat=OpenAI 兼容，messages=Anthropic 兼容，responses=OpenAI Responses'),
  chatPath: Schema.string().default('').description('聊天路径；留空按接口形态取默认值'),
  modelsPath: Schema.string().default('/models').description('模型列表路径（相对 baseUrl）'),
  modelsUrl: Schema.string().default('').description('模型列表完整 URL（优先于 modelsPath）'),
  model: Schema.string().default('deepseek-flash').description('工坊生成插件使用的模型；建议 deepseek-flash（1M 上下文，适合长代码）'),
  maxTokens: Schema.number().default(65_536).min(0).max(1_000_000).description('单次生成最大输出 token；0 表示使用默认值 131072 内收敛'),
  temperature: Schema.number().default(-1).min(-1).max(2).description('温度；-1 表示不发送'),
  timeoutMs: Schema.number().default(180_000).min(0).max(600_000).description('单次请求超时（毫秒）；0=默认 180 秒'),
  retries: Schema.number().default(1).min(0).max(5).description('失败重试次数（截断/契约不通过会额外重试）'),
  systemPrompt: Schema.string().default('').description('追加到工坊 system prompt 的额外要求（例如团队编码规范）'),
})

/** 供宿主/界面调用的工坊服务（命名空间 aiWorkshop） */
export class AiWorkshopService extends Service {
  private readonly config: AiConfig
  private modelCache?: { at: number; models: AiModelInfo[]; source: 'remote' | 'fallback' }

  constructor(ctx: Context, raw: Partial<AiConfig>) {
    super(ctx, 'aiWorkshop')
    this.config = normalizeConfig({ ...raw, stream: false })
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

  async draftPlugin(requirement: string): Promise<AiPluginDraft> {
    const demand = String(requirement ?? '').trim()
    if (!demand) throw new AiError('请先描述你想要的插件', 'BAD_REQUEST')
    const key = this.resolveKey()
    if (!key) {
      throw new AiError(
        'AI 插件工坊还没有配置 API Key：请在「AI 插件工坊」页面的接口设置里填写，或设置环境变量 DEEPSEEK_API_KEY',
        'AUTH',
      )
    }
    const base = this.config
    const brief = this.projectBrief()
    const extra = String(base.systemPrompt ?? '').trim()
    const attempts = Math.max(1, Math.min(5, Math.trunc(base.retries ?? 1) + 1))
    let lastError = '生成失败'
    let feedback = ''

    for (let attempt = 0; attempt < attempts; attempt++) {
      const maxTokens = Math.min(131_072, Math.max(32_768, base.maxTokens || 65_536) * (attempt ? 2 : 1))
      const systemPrompt =
        PLUGIN_SYSTEM_PROMPT +
        (brief ? '\n\n' + brief : '') +
        (extra ? '\n\n【工坊额外要求】\n' + extra : '')
      const request = buildRequest(
        { ...base, maxTokens },
        key,
        systemPrompt,
        PLUGIN_USER_PREFIX + demand + feedback,
        [PLUGIN_TOOL],
      )
      const result = await requestJson(request.url, {
        headers: request.headers,
        body: request.body,
        timeoutMs: base.timeoutMs || 180_000,
        retries: base.retries ?? 1,
      })
      const parsed = parseResponse(base, result.payload)
      if (parsed.truncated) {
        lastError = `输出被截断（${parsed.finish ?? 'length'}）`
        feedback = '\n\n上一次输出被截断。请直接输出完整、可运行的代码，不要省略、不要 JSON 包装。'
        continue
      }
      const toolArgs = parsed.toolCalls?.find((call) => call.name === 'emit_plugin')?.arguments
      const packageFiles = normalizePluginFiles(toolArgs?.files) as AiPluginFile[]
      const packageManifest = normalizePluginManifest(toolArgs?.manifest) as PluginManifest | undefined
      const entryName = packageManifest?.entry || 'index.mjs'
      const fileCode = packageFiles.find((file) => file.path === entryName)?.content
      const code =
        toolArgs && typeof toolArgs.code === 'string' && toolArgs.code.trim()
          ? toolArgs.code.trim()
          : fileCode || extractPluginCode(parsed.text)
      const dependencies = normalizeDependencies(toolArgs?.dependencies ?? extractDependenciesFromText(parsed.text))
      const kind = pickPluginKind(toolArgs?.kind ?? extractKindFromCode(code))
      if (!code) {
        lastError = '模型没有返回有效的插件代码'
        feedback = '\n\n上一次没有返回有效代码。请输出 files 数组（至少包含入口文件），或输出单文件 code。'
        continue
      }
      const allowRelativeImports = packageFiles.length > 0
      const check = checkPluginSource(code, { dependencies, mode: 'native', allowRelativeImports })
      if (!check.ok) {
        lastError = check.errors.slice(0, 2).join('；')
        feedback =
          '\n\n上一次生成的插件代码未通过静态契约检查：\n- ' +
          check.errors.join('\n- ') +
          '\n请修正后重新输出完整插件包：原生 Cordis 插件用 export function apply(ctx)；不要 import 框架包；第三方包必须在 dependencies 中声明。'
        continue
      }
      const syntaxError = await checkPluginSyntax(code)
      if (syntaxError) {
        lastError = '语法错误：' + syntaxError
        feedback = '\n\n上一次生成的插件代码有语法错误：\n' + syntaxError + '\n请输出语法完整、括号配对的代码。'
        continue
      }
      const matched = code.match(/(?:export\s+const\s+name\s*=|name\s*:)\s*['"]([a-zA-Z0-9_-]+)['"]/)
      return {
        name: matched?.[1] ?? packageManifest?.id ?? 'ai-plugin',
        code,
        notes: parsed.text.slice(0, 200),
        dependencies,
        mode: 'native',
        kind,
        format: 'package',
        ...(packageManifest ? { manifest: packageManifest } : {}),
        ...(packageFiles.length ? { files: packageFiles } : {}),
      }
    }
    throw new AiError(lastError, 'INVALID_RESPONSE')
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

export default defineCleanerPlugin<Partial<AiConfig>>({
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
