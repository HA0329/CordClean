import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { folderSize } from '@cordclean/utils'
import { RULE_TARGET_TYPES, SUPPORTED_RULE_TYPES } from '@cordclean/shared'
import type { AiRuleSuggestion } from '@cordclean/shared'
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
import { buildRequest, parseResponse, parseSseDelta } from './adapters.ts'
import { normalizeConfig, wantsJson, type AiConfig } from './config.ts'
import { requestSse } from './http.ts'
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

export function estimateTokens(text: string): number {
  return Math.ceil(String(text).length / 3.5)
}

export class AiService extends Service implements AiLike {
  private cache?: AiAnalysis
  private modelCache?: { at: number; models: AiModelInfo[]; source: 'remote' | 'fallback' }
  private lastProbe?: AiProbeResult
  /** 规则评估结果缓存（同一批规则的重复评估直接复用） */
  private evalCache = new Map<string, { at: number; result: Map<string, RuleEvalResult> }>()
  private rootCache?: { at: number; items: Array<{ id: string; path: string; size: number }> }

  /** 用户目录下的一级目录（用于建议新增扫描根；只取名字与体积） */
  private async collectRootCandidates(): Promise<Array<{ id: string; path: string; size: number }>> {
    const now = Date.now()
    if (this.rootCache && now - this.rootCache.at < 10 * 60_000) return this.rootCache.items
    const home = os.homedir()
    let names: string[] = []
    try {
      names = (await readdir(home, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
      return []
    }
    const items: Array<{ id: string; path: string; size: number }> = []
    for (const name of names.slice(0, 20)) {
      const dir = path.join(home, name)
      try {
        const stat = await folderSize(dir, { maxEntries: 3000 })
        if (stat.bytes > 200 * 1024 * 1024) items.push({ id: name, path: dir, size: stat.bytes })
      } catch {
        /* 忽略不可读目录 */
      }
    }
    items.sort((a, b) => b.size - a.size)
    this.rootCache = { at: now, items }
    return items
  }

  /** 本次分析实际用到的上下文采集器 */
  private lastContextUsed: string[] = []
  private analyzeController?: AbortController

  /** 取消当前分析（界面「取消生成」） */
  cancelAnalyze(): void {
    this.analyzeController?.abort()
  }

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

  /** AI 插件工坊：生成单文件 Cordis 插件草稿 */
  /** AI 插件工坊：生成单文件 Cordis 插件草稿（代码优先，失败自动重试一次） */
  async draftPlugin(requirement: string): Promise<{ name: string; code: string; notes: string }> {
    const key = this.requireKey()
    const base = this.rawConfig
    let lastError = '生成失败'

    for (let attempt = 0; attempt < 2; attempt++) {
      const maxTokens = Math.min(131_072, Math.max(32_768, base.maxTokens) * (attempt ? 2 : 1))
      const config = { ...base, maxTokens }
      const suffix = attempt ? '\n\n上一次输出为空或被截断。请直接输出完整、可运行的 ```js 代码块，不要省略、不要 JSON 包装。' : ''
      const request = buildRequest(config, key, PLUGIN_SYSTEM_PROMPT, PLUGIN_USER_PREFIX + requirement + suffix, [PLUGIN_TOOL])
      this.gate('plugin-draft', request.url, request.body)
      const result = await requestJson(request.url, {
        headers: request.headers,
        body: request.body,
        timeoutMs: config.timeoutMs,
        retries: config.retries,
      })
      const parsed = parseResponse(config, result.payload)
      if (parsed.truncated) {
        lastError = `输出被截断（${parsed.finish ?? 'length'}）`
        this.ctx.logger.info('插件草稿被截断，自动扩容重试')
        continue
      }
      const toolArgs = parsed.toolCalls?.find((call) => call.name === 'emit_plugin')?.arguments
      const code = toolArgs && typeof toolArgs.code === 'string' ? toolArgs.code.trim() : extractPluginCode(parsed.text)
      if (code && /defineCleanerPlugin/.test(code)) {
        const matched = code.match(/name:\s*['"]([a-zA-Z0-9_-]+)['"]/)
        return { name: matched?.[1] ?? 'ai-plugin', code, notes: parsed.text.slice(0, 200) }
      }
      lastError = '模型没有返回有效的插件代码'
    }
    throw new AiError(lastError, 'INVALID_RESPONSE')
  }
  /** 当前模型的能力上限（来自 /models 缓存或内置目录） */
  private modelLimits(): { contextWindow: number; maxOutputTokens: number } {
    const model = this.modelCache?.models?.find((item) => item.id === this.rawConfig.model)
    return {
      contextWindow: model?.contextWindow ?? 128_000,
      maxOutputTokens: model?.maxOutputTokens ?? 393_216,
    }
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
      contextAvailable: this.ctx.aiContext.list(),
      contextUsed: this.lastContextUsed,
      contextWindow: this.modelLimits().contextWindow,
      maxOutputTokens: this.modelLimits().maxOutputTokens,
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
    const limits = this.modelLimits()
    const config = { ...this.rawConfig, maxTokens: Math.min(limits.maxOutputTokens, Math.max(32_768, this.rawConfig.maxTokens)) }
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

  async analyze(options: { taskIds?: string[]; extraContext?: string; contextProviders?: string[]; image?: { mime: string; data: string } } = {}): Promise<AiAnalysis> {
    this.analyzeController = new AbortController()
    const signal = this.analyzeController.signal
    const key = this.requireKey()
    if (options.image) {
      const model = this.modelCache?.models?.find((item) => item.id === this.rawConfig.model)
      const supports = model ? (model.inputModalities ?? []).includes('image') : this.rawConfig.model.startsWith('deepseek-flash')
      if (!supports) throw new Error('当前模型不支持图片输入（deepseek-flash 支持，v4-pro 不支持）')
      if (options.image.data.length > 4_000_000) throw new Error('图片过大（base64 超过 4MB），请压缩后再试')
    }
    const limits = this.modelLimits()
    const config = { ...this.rawConfig, maxTokens: Math.min(limits.maxOutputTokens, Math.max(32_768, this.rawConfig.maxTokens)) }
    const profile = await this.buildProfile(options.extraContext)
    const scan = this.ctx.cleaner.lastScan()
    const candidates = scan
      ? [...scan.items]
          .filter((item) => !item.protected)
          .sort((a, b) => b.size - a.size)
          .slice(0, 40)
          .map((item) => ({ id: item.id, mb: Math.round(item.size / 1024 / 1024), risk: item.risk, task: item.taskId }))
      : []
    const rootCandidates = await this.collectRootCandidates()
    const rootHint = rootCandidates.length
      ? '\n\n可选的新增扫描根（来自用户目录下的一级目录，只能选这些 rootId）：\n' + JSON.stringify(rootCandidates.map((item) => ({ rootId: item.id, mb: Math.round(item.size / 1024 / 1024) })))
      : ''
    const candidateHint = candidates.length
      ? '\n\n以下是本次扫描得到的候选清理项（只能从这些 id 中选择，不得虚构）：\n' + JSON.stringify(candidates)
      : '\n\n当前没有可用的扫描结果，selection 必须为空数组。'
    const contextSections = await this.ctx.aiContext.collect(options.contextProviders ?? config.contextProviders)
    this.lastContextUsed = contextSections.map((section) => section.id)
    const contextText = contextSections.length
      ? '\n\n补充上下文（脱敏摘要）：\n' +
        contextSections.map((section) => `【${section.title}】\n` + section.lines.join('\n')).join('\n\n')
      : ''
    const request = buildRequest(config, key, buildSystemPrompt(config), buildUserPrompt(profile, options.extraContext) + contextText + candidateHint + rootHint + SELECTION_HINT + ROOT_HINT + RULE_HINT)
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

    const rootMap = new Map(rootCandidates.map((item) => [item.id, item]))
    const configuredRoots = new Set((this.ctx.settings.get().analysis.roots ?? []).map((item) => String(item).toLowerCase()))
    const rootSuggestions = (Array.isArray(data?.roots) ? data.roots : [])
      .map((entry: any) => ({ rootId: String(entry?.rootId ?? ''), reason: String(entry?.reason ?? '').slice(0, 160) }))
      .map((entry: any) => ({ ...entry, candidate: rootMap.get(entry.rootId) }))
      .filter((entry: any) => entry.candidate && entry.reason && !configuredRoots.has(entry.candidate.path.toLowerCase()))
      .slice(0, 3)
      .map((entry: any) => ({ path: entry.candidate.path, reason: entry.reason, sizeBytes: entry.candidate.size }))
    const allowed = new Map(candidates.map((item) => [item.id, item]))
    const rawSelection: unknown[] = Array.isArray(data?.selection) ? data.selection : []
    const selection = rawSelection
      .map((entry: any) => ({ itemId: String(entry?.itemId ?? ''), reason: String(entry?.reason ?? '').slice(0, 160) }))
      .filter((entry) => allowed.has(entry.itemId) && entry.reason)
      .slice(0, 50)
    const selectionBytes = selection.reduce((sum, entry) => {
      const item = scan?.items.find((candidate) => candidate.id === entry.itemId)
      return sum + (item?.size ?? 0)
    }, 0)
    const suggestions = normalizeSuggestions(data?.suggestions)
    const ruleSuggestions = normalizeRuleSuggestions(data?.rules)
    const analysis: AiAnalysis = {
      model: config.model,
      createdAt: Date.now(),
      summary: String(data?.summary ?? '').slice(0, 800),
      observations: config.includeObservations && Array.isArray(data?.observations)
        ? data.observations.slice(0, 5).map((item: unknown) => String(item).slice(0, 200))
        : [],
      suggestions,
      selection,
      rootSuggestions,
      selectionSummary: { count: selection.length, bytes: selectionBytes },
      ruleSuggestions,
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

/** 提示模型额外给出新规则建议（可选字段） */
/** 让模型在候选列表内挑选清理项 */
/** 让模型建议新增扫描根（只能从候选 rootId 中选） */
export function extractPluginCode(text: string): string {
  const fenced = text.match(/```(?:js|javascript|mjs)?\s*([\s\S]*?)```/i)
  const raw = (fenced ? fenced[1] : text).trim()
  if (raw.startsWith('{')) {
    try {
      const data = JSON.parse(raw)
      if (typeof data?.code === 'string') return data.code.trim()
    } catch {}
  }
  return raw
}
const PLUGIN_TOOL = {
  name: 'emit_plugin',
  description: '输出一个完整可运行的单文件 Cordis 插件源码',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'kebab-case 插件名' },
      code: { type: 'string', description: '完整 ESM 源码，必须包含 defineCleanerPlugin 与 export default' },
      notes: { type: 'string', description: '简要说明' },
    },
    required: ['name', 'code'],
  },
}

const PLUGIN_SYSTEM_PROMPT = [
  '你是 Cordis 插件工程师。只输出一个 JSON 对象：{ "name": "kebab-case", "code": "完整 ESM 源码", "notes": "简要说明" }。',
  'code 必须是单文件 .mjs，默认导出 defineCleanerPlugin({ name, version, description, inject: ["cleaner"], setup(ctx, config) {...} })。',
  '插件用 ctx.cleaner.define({ id, name, category, risk, icon, defaultSelected, targets, scan(scan){ scan.emit({path,kind,size}) } }) 注册清理任务。',
  '禁止：child_process、process.exit、fs.rm/rmSync/unlink/rmdir、直接删除文件、网络请求、读取环境变量中的密钥。删除一律交给内核（只 emit 候选）。',
  '路径必须来自 config 或已知的 %ENV% 模板；不要硬编码 C:\\Users 下的用户名；用 ctx.logger 记录关键日志。',
].join('\n')
const PLUGIN_USER_PREFIX = '需求：'

const ROOT_HINT =
  '\n\n如果发现「用户目录下某一级目录体积很大、但不在当前扫描根里」，请输出 roots 数组（最多 3 条）：' +
  '[{"rootId":"候选里的 rootId","reason":"为什么建议加入扫描范围（中文，30 字内）"}]。' +
  'rootId 必须逐字来自候选列表；没有把握就输出空数组。新增扫描根需要用户确认后才会生效。'

const SELECTION_HINT =
  '\n\n另外，请从上面「候选清理项」中挑选你认为值得清理的项，输出 selection 数组（最多 30 条）：' +
  '[{"itemId":"候选里的 id","reason":"为什么建议清理（中文，30 字内）"}]。' +
  'itemId 必须逐字来自候选列表；不确定就少选或不选。只依据体积、风险等级与任务归类判断，不要臆造路径。'

const RULE_HINT =
  '\n\n如果发现有价值、但当前规则库未覆盖的可重建缓存，请另外输出 rules 数组（最多 5 条）：' +
  '[{"name":"名称","category":"分类key","risk":"safe|caution|risky","target":{"type":"clear_dir","path":"%LOCALAPPDATA%/某软件/Cache"},"reason":"依据"}]；没有则输出 "rules": []。' +
  '只建议可重建的缓存，不得建议删除用户数据。'

/** 把 AI 给出的 rules 规范化成可校验的建议（最多 5 条） */
function normalizeRuleSuggestions(input: unknown): AiRuleSuggestion[] {
  if (!Array.isArray(input)) return []
  const output: AiRuleSuggestion[] = []
  for (const item of input.slice(0, 5)) {
    if (!item || typeof item !== 'object') continue
    const target = (item as any).target
    if (!target || typeof target !== 'object') continue
    if (!RULE_TARGET_TYPES.includes(target.type) || !SUPPORTED_RULE_TYPES.includes(target.type)) continue
    if (!target.path && !target.paths?.length && !target.base && !target.bases?.length) continue
    const risk = (item as any).risk === 'risky' || (item as any).risk === 'caution' ? (item as any).risk : 'safe'
    output.push({
      name: String((item as any).name ?? 'AI 建议规则').slice(0, 60),
      category: String((item as any).category ?? 'ai-custom').slice(0, 40),
      categoryLabel: String((item as any).categoryLabel ?? (item as any).category ?? 'AI 建议').slice(0, 40),
      risk,
      target: {
        type: target.type,
        ...(target.path ? { path: String(target.path) } : {}),
        ...(Array.isArray(target.paths) ? { paths: target.paths.map(String) } : {}),
        ...(target.base ? { base: String(target.base) } : {}),
        ...(Array.isArray(target.bases) ? { bases: target.bases.map(String) } : {}),
        ...(target.pattern ? { pattern: String(target.pattern) } : {}),
        ...(Array.isArray(target.names) ? { names: target.names.map(String) } : {}),
        ...(target.action === 'clear' || target.action === 'delete' ? { action: target.action } : {}),
        ...(target.olderThanDays ? { olderThanDays: Number(target.olderThanDays) } : {}),
        ...(target.minSizeMb ? { minSizeMb: Number(target.minSizeMb) } : {}),
        ...(target.maxDepth ? { maxDepth: Number(target.maxDepth) } : {}),
      },
      reason: String((item as any).reason ?? '').slice(0, 160),
    })
  }
  return output
}
