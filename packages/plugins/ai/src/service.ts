/**
 * AI 服务实现：把「本机画像」变成「清理建议」。
 *
 * 与具体接口解耦的层次：
 *   service（业务流程：取画像 → 发请求 → 解析建议）
 *     ├─ adapters（三种接口形态的请求/响应适配）
 *     ├─ http（超时/重试/错误归类）
 *     ├─ models（模型列表，动态获取 + 兜底）
 *     └─ config（可配置项与参数映射）
 */
import { Service, type Context } from 'cordis'
import type {
  AiAnalysis,
  AiLike,
  AiModelInfo,
  AiProbeResult,
  AiRuntimeStatus,
  AiSuggestion,
  RiskLevel,
  TaskDescriptor,
} from '@cordclean/shared'
import { buildRequest, parseResponse } from './adapters.ts'
import { normalizeConfig, wantsJson, type AiConfig } from './config.ts'
import { AiError, requestJson } from './http.ts'
import { fetchModelList, FALLBACK_MODELS } from './models.ts'
import { buildSystemPrompt, buildUserPrompt, type SystemProfile } from './profile.ts'
import { errorMessage } from '@cordclean/utils'

/** 思维链截断长度（界面展示用） */
const REASONING_LIMIT = 20_000
/** 模型列表缓存时间 */
const MODEL_CACHE_MS = 5 * 60_000

/** 从模型输出中提取 JSON（容忍代码块围栏与前后缀文字） */
export function extractJsonObject(text: string): any {
  const trimmed = (text ?? '').trim()
  if (!trimmed) throw new Error('模型返回内容为空')
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  const candidate = (fenced ? fenced[1] : trimmed).trim()
  try {
    return JSON.parse(candidate)
  } catch {
    /* 继续用括号扫描兜底 */
  }
  const start = candidate.indexOf('{')
  if (start < 0) throw new Error('模型输出中没有 JSON 对象')
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1))
        } catch {
          break
        }
      }
    }
  }
  throw new Error('模型输出不是合法 JSON')
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}

function normalizeRisk(value: unknown): RiskLevel {
  return value === 'safe' || value === 'caution' || value === 'risky' ? value : 'caution'
}

/** 把模型输出规范化为 AiSuggestion[]（任何字段异常都不抛错） */
export function normalizeSuggestions(raw: unknown): AiSuggestion[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, 6).map((item: any, index: number) => ({
    id: `ai-${Date.now().toString(36)}-${index}`,
    title: String(item?.title ?? '清理建议').slice(0, 40),
    reason: String(item?.reason ?? '').slice(0, 400),
    taskId: typeof item?.taskId === 'string' && item.taskId ? item.taskId : undefined,
    targets: Array.isArray(item?.targets)
      ? item.targets.slice(0, 6).map((target: unknown) => String(target).slice(0, 60))
      : [],
    estimatedBytes: Math.max(0, Math.trunc(Number(item?.estimatedBytes) || 0)),
    confidence: clampNumber(item?.confidence, 0, 1, 0.5),
    risk: normalizeRisk(item?.risk),
  }))
}

export interface RuleEvalInput {
  ruleId: string
  name: string
  category: string
  risk: RiskLevel
  count: number
  bytes: number
}

export interface RuleEvalResult {
  suggest: boolean
  risk: RiskLevel
  reason: string
}

export class AiService extends Service implements AiLike {
  private cache?: AiAnalysis
  private modelCache?: { at: number; models: AiModelInfo[]; source: 'remote' | 'fallback' }
  private lastProbe?: AiProbeResult
  /** 规则评估结果缓存（同一批规则的重复评估直接复用） */
  private evalCache = new Map<string, { at: number; result: Map<string, RuleEvalResult> }>()

  constructor(ctx: Context, private readonly rawConfig: AiConfig) {
    super(ctx, 'ai')
  }

  get config(): AiConfig {
    return this.rawConfig
  }

  get model(): string {
    return this.rawConfig.model
  }

  /** 是否已配置凭据（配置或环境变量） */
  configured(): boolean {
    return !!this.resolveKey()
  }

  private resolveKey(): string {
    const fromConfig = (this.rawConfig.apiKey ?? '').trim()
    if (fromConfig) return fromConfig
    const env = ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'DASHSCOPE_API_KEY']
    for (const name of env) {
      const value = this.ctx.system.env.get(name)?.trim()
      if (value) return value
    }
    return ''
  }

  private requireKey(): string {
    const key = this.resolveKey()
    if (!key) {
      throw new AiError(
        '未配置 API Key：请在「接口设置」中填写，或设置环境变量 DEEPSEEK_API_KEY / OPENAI_API_KEY',
        'AUTH',
      )
    }
    return key
  }

  /** 拉取模型列表（默认使用 5 分钟缓存） */
  async models(options: { refresh?: boolean } = {}): Promise<{ source: 'remote' | 'fallback'; models: AiModelInfo[]; error?: string }> {
    if (!options.refresh && this.modelCache && Date.now() - this.modelCache.at < MODEL_CACHE_MS) {
      return { source: this.modelCache.source, models: this.modelCache.models }
    }
    const key = this.resolveKey()
    if (!key) {
      this.modelCache = { at: Date.now(), models: FALLBACK_MODELS, source: 'fallback' }
      return { source: 'fallback', models: FALLBACK_MODELS, error: '未配置 API Key，展示内置模型目录' }
    }
    this.gate('models', this.rawConfig.baseUrl.replace(/\/+$/, '') + '/models', undefined)
    const result = await fetchModelList(this.rawConfig, key)
    this.modelCache = { at: Date.now(), models: result.models, source: result.source }
    if (result.error) this.ctx.logger.info('拉取模型列表失败，使用内置目录：%s', result.error)
    return result
  }

  status(): AiRuntimeStatus {
    return {
      available: true,
      configured: this.configured(),
      shape: this.rawConfig.apiShape,
      baseUrl: this.rawConfig.baseUrl,
      model: this.rawConfig.model,
      effort: this.rawConfig.reasoningEffort,
      jsonMode: this.rawConfig.jsonMode,
      models: this.modelCache?.models ?? [],
      lastProbe: this.lastProbe,
    }
  }

  /** 连通性探测：最小请求，验证 Key / 地址 / 模型 / 参数组合 */
  async probe(): Promise<AiProbeResult> {
    const shape = this.rawConfig.apiShape
    const model = this.rawConfig.model
    const startedAt = Date.now()
    try {
      const key = this.requireKey()
      const request = buildRequest(
        { ...this.rawConfig, maxTokens: 128, temperature: -1, jsonMode: 'off', includeObservations: false },
        key,
        '你是接口连通性探测器。收到消息后只回复一个词：OK。',
        '连通性测试：请回复 OK。',
      )
      const result = await requestJson(request.url, {
        headers: request.headers,
        body: request.body,
        timeoutMs: Math.min(this.rawConfig.timeoutMs, 60_000),
        retries: 0,
      })
      const parsed = parseResponse(this.rawConfig, result.payload)
      const probe: AiProbeResult = {
        ok: true,
        latencyMs: result.latencyMs,
        model,
        shape,
        status: result.status,
        text: (parsed.text || parsed.reasoning || '').slice(0, 200),
        usage: parsed.usage,
      }
      this.lastProbe = probe
      return probe
    } catch (error) {
      const latencyMs = Date.now() - startedAt
      const probe: AiProbeResult = {
        ok: false,
        latencyMs,
        model,
        shape,
        status: (error as AiError)?.status ?? 0,
        text: '',
        error: errorMessage(error),
      }
      this.lastProbe = probe
      return probe
    }
  }

  last(): AiAnalysis | undefined {
    return this.cache
  }

  /** 采集脱敏画像 */
  private async buildProfile(userNote?: string): Promise<SystemProfile> {
    const info = await this.ctx.system.info()
    const hotspots = await this.ctx.system.hotspots()
    let scan = this.ctx.cleaner.lastScan()
    if (!scan) {
      // 没有扫描结果时只跑「安全级」任务，避免动辄数分钟的深度扫描
      const safeTasks = this.ctx.cleaner
        .list()
        .filter((task: TaskDescriptor) => task.risk === 'safe')
        .map((task: TaskDescriptor) => task.id)
      if (safeTasks.length) scan = await this.ctx.cleaner.scan({ taskIds: safeTasks })
    }

    const toGb = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10
    const byTask = new Map<string, { items: number; bytes: number }>()
    const byCategory = new Map<string, { count: number; bytes: number }>()
    for (const item of scan?.items ?? []) {
      const taskStat = byTask.get(item.taskId) ?? { items: 0, bytes: 0 }
      taskStat.items++
      taskStat.bytes += item.size
      byTask.set(item.taskId, taskStat)
      const categoryStat = byCategory.get(item.category) ?? { count: 0, bytes: 0 }
      categoryStat.count++
      categoryStat.bytes += item.size
      byCategory.set(item.category, categoryStat)
    }

    return {
      os: { release: info.release, arch: info.arch, elevated: info.elevated },
      cpu: { model: info.cpuModel.replace(/\s+/g, ' ').trim(), cores: info.cpuCores },
      memory: { totalGb: toGb(info.memoryTotal), freeGb: toGb(info.memoryFree) },
      disks: info.disks.map((disk) => ({
        mount: disk.mount,
        totalGb: toGb(disk.total),
        freeGb: toGb(disk.free),
        usedPercent: disk.total ? Math.round((disk.used / disk.total) * 100) : 0,
      })),
      // 只发送标签与体积，不发送绝对路径
      hotspots: hotspots.slice(0, 8).map((spot) => ({ label: spot.label, gb: toGb(spot.bytes) })),
      tasks: this.ctx.cleaner.list().map((task: TaskDescriptor) => {
        const stat = byTask.get(task.id) ?? { items: 0, bytes: 0 }
        const result = scan?.tasks.find((entry) => entry.taskId === task.id)
        return {
          id: task.id,
          name: task.name,
          category: task.category,
          risk: task.risk,
          items: stat.items,
          mb: Math.round(stat.bytes / 1024 / 1024),
          elapsedMs: result?.elapsedMs ?? 0,
        }
      }),
      topItems: [...byCategory.entries()]
        .map(([category, stat]) => ({ category, count: stat.count, mb: Math.round(stat.bytes / 1024 / 1024) }))
        .sort((a, b) => b.mb - a.mb),
      userNote: userNote?.slice(0, 500),
    }
  }

  /**
   * 作为「可替换评估器」使用：对一批规则给出 建议/风险/理由。
   *
   * 与 analyze() 的区别：输入是**按规则聚合的脱敏统计**（规则名、类别、项数、体积），
   * 不含任何路径；输出是逐条规则的结构化评估。结果按输入签名缓存，避免同一扫描内重复调用。
   */
  async evaluateRules(inputs: RuleEvalInput[]): Promise<Map<string, RuleEvalResult>> {
    const key = this.requireKey()
    const config = this.rawConfig
    const signature = JSON.stringify(inputs.map((item) => [item.ruleId, item.count, Math.round(item.bytes / 1024), item.risk]))
    const cached = this.evalCache.get(signature)
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.result

    const system = [
      '你是电脑清理工具的规则评估器。',
      '输入是若干条清理规则的脱敏统计（规则名、类别、命中项数、合计体积），不包含任何文件路径。',
      '请评估每条规则是否适合「默认勾选清理」，并给出风险等级。',
      '只能输出 JSON 对象，不要输出解释性文字或 Markdown。',
    ].join('\n')
    const user = [
      '规则列表（JSON）：',
      JSON.stringify(inputs.map((item) => ({
        ruleId: item.ruleId,
        name: item.name,
        category: item.category,
        risk: item.risk,
        count: item.count,
        mb: Math.round((item.bytes / 1024 / 1024) * 10) / 10,
      }))),
      '',
      '输出格式：{"items":[{"ruleId":"...","suggest":true,"risk":"safe|caution|risky","reason":"不超过60字"}]}',
      '要求：每个 ruleId 必须出现一次；risk 只能是 safe/caution/risky；不确定时 suggest=false。',
    ].join('\n')

    const request = buildRequest(config, key, system, user)
    this.gate('evaluate', request.url, request.body)
    const result = await requestJson(request.url, {
      headers: request.headers,
      body: request.body,
      timeoutMs: config.timeoutMs,
      retries: config.retries,
    })
    const parsed = parseResponse(config, result.payload)
    let data: any
    try {
      data = extractJsonObject(parsed.text)
    } catch (error) {
      throw new AiError('评估器输出不是合法 JSON：' + errorMessage(error), 'INVALID_RESPONSE', result.status, {
        text: parsed.text.slice(0, 300),
      })
    }
    const items = Array.isArray(data?.items) ? data.items : []
    const map = new Map<string, RuleEvalResult>()
    for (const item of items) {
      const ruleId = String(item?.ruleId ?? '')
      if (!ruleId) continue
      const risk = item?.risk === 'risky' || item?.risk === 'caution' ? item.risk : 'safe'
      map.set(ruleId, {
        suggest: item?.suggest === true,
        risk,
        reason: String(item?.reason ?? '').slice(0, 120),
      })
    }
    if (!map.size) throw new AiError('评估器没有返回任何规则结论', 'INVALID_RESPONSE', result.status, data)
    this.evalCache.set(signature, { at: Date.now(), result: map })
    return map
  }

  /** 外发出口（不变量 8）：在线 AI 被关闭时直接拒绝 */
  private gate(purpose: string, url: string, body: unknown): void {
    const gate = this.ctx.egress.check({ purpose, url, body })
    if (!gate.allowed) throw new AiError(gate.reason ?? '在线 AI 已被关闭', 'NETWORK')
  }

  async analyze(options: { taskIds?: string[]; extraContext?: string } = {}): Promise<AiAnalysis> {
    const key = this.requireKey()
    const config = this.rawConfig
    const profile = await this.buildProfile(options.extraContext)
    const request = buildRequest(config, key, buildSystemPrompt(config), buildUserPrompt(profile, options.extraContext))
    this.gate('analyze', request.url, request.body)

    const result = await requestJson(request.url, {
      headers: request.headers,
      body: request.body,
      timeoutMs: config.timeoutMs,
      retries: config.retries,
    })

    const parsed = parseResponse(config, result.payload)
    if (!parsed.text.trim()) {
      throw new AiError('模型没有返回最终答案（可能只输出了思维链）', 'INVALID_RESPONSE', result.status, parsed.raw)
    }
    if (parsed.truncated && wantsJson(config)) {
      // JSON 被截断时给出明确提示，而不是让用户看到解析失败
      throw new AiError(
        `输出被截断（${parsed.finish ?? 'unknown'}），请调大「最大输出 token」后重试`,
        'INVALID_RESPONSE',
        result.status,
        parsed.raw,
      )
    }

    let data: any
    try {
      data = extractJsonObject(parsed.text)
    } catch (error) {
      throw new AiError('模型输出不是合法 JSON：' + errorMessage(error), 'INVALID_RESPONSE', result.status, {
        text: parsed.text.slice(0, 500),
      })
    }

    const suggestions = normalizeSuggestions(data?.suggestions)
    const analysis: AiAnalysis = {
      model: config.model,
      createdAt: Date.now(),
      summary: String(data?.summary ?? '').slice(0, 800),
      observations: config.includeObservations && Array.isArray(data?.observations)
        ? data.observations.slice(0, 5).map((item: unknown) => String(item).slice(0, 200))
        : [],
      suggestions,
      reasoning: parsed.reasoning ? parsed.reasoning.slice(0, REASONING_LIMIT) : undefined,
      usage: parsed.usage,
      latencyMs: result.latencyMs,
      shape: config.apiShape,
    }
    this.cache = analysis
    this.ctx.logger.info(
      'AI 分析完成：模型 %s（%s），%d 条建议，耗时 %d ms，token 输入 %d / 输出 %d（思维链 %d）',
      config.model,
      config.apiShape,
      suggestions.length,
      result.latencyMs,
      parsed.usage?.inputTokens ?? 0,
      parsed.usage?.outputTokens ?? 0,
      parsed.usage?.reasoningTokens ?? 0,
    )
    return analysis
  }
}

/** 从插件配置构造服务（便于测试与热重载） */
export function createAiService(ctx: Context, raw: Partial<AiConfig> | undefined): AiService {
  return new AiService(ctx, normalizeConfig(raw))
}
