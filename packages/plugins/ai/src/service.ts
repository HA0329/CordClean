import { existsSync } from 'node:fs'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { folderSize } from '@cordclean/utils'
import { RULE_TARGET_TYPES, SUPPORTED_RULE_TYPES } from '@cordclean/shared'
import { checkPluginSource } from '@cordclean/shared'
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
  AiPluginDraft,
  AiPluginFile,
  AiProbeResult,
  AiRuntimeStatus,
  AiSuggestion,
  PluginKind,
  PluginManifest,
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

  /** 给插件生成器的项目能力上下文（不发送源码/用户数据，只发送契约与任务清单） */
  private pluginProjectBrief(): string {
    let tasks: string[] = []
    try {
      tasks = this.ctx.cleaner
        .list()
        .slice(0, 80)
        .map((task) => `${task.id}（${task.name}，${task.category}/${task.risk}）`)
    } catch {
      /* 插件管理器未就绪时只给静态契约 */
    }
    return [
      '【CordClean 项目上下文】',
      '定位：Windows 模块化清理工具的 Cordis 插件系统；插件只能生成一个自包含 ESM 文件。',
      '目录结构（仅用于理解分层，不要 import 这些包）：',
      '  apps/web、apps/desktop：Web/Electron 外壳',
      '  packages/core/domains：cleaner/engine、safety（path-policy/quarantine/executor）、kernel（plugins/settings/ui/window）',
      '  packages/shared：PluginKind、UI 贡献、RPC、清理任务契约',
      '  packages/ui：Vue 页面与插件卡片/状态/命令渲染',
      '宿主服务契约：',
      '  ctx.cleaner.define({ id,name,category,risk,defaultSelected,targets,scan(scan) })；scan 只 emit 候选',
      '  ctx.ui.resolve(pluginName,id,fn) / ctx.ui.command(pluginName,id,fn) / ctx.ui.emit / ctx.ui.notify',
      '  ctx.system.env.get(name)、ctx.pathPolicy.check(path)、ctx.settings.get()',
      '  ctx.window.open/createTray 仅 Electron 桌面壳',
      'UI 数据：metric={value,unit?}；text={text}；list=string[] 或 {items:string[]}；progress={value,max}',
      '插件页只渲染 contributes.overviewCards/statusItems/commands/pages；widget/active/desktop 至少提供一个 commands 手动入口。',
      '内置清理任务（不要重复定义；可以按需组合/补充）：' + (tasks.length ? tasks.join('、') : '暂无'),
    ].join('\n')
  }

  /** AI 插件工坊：生成原生 Cordis 通用插件草稿（生成后先过静态契约，失败自动带错误重试） */
  async draftPlugin(requirement: string): Promise<AiPluginDraft> {
    const key = this.requireKey()
    const base = this.rawConfig
    let lastError = '生成失败'
    let feedback = ''

    for (let attempt = 0; attempt < 3; attempt++) {
      const maxTokens = Math.min(131_072, Math.max(32_768, base.maxTokens) * (attempt ? 2 : 1))
      const config = { ...base, maxTokens }
      const request = buildRequest(
        config,
        key,
        PLUGIN_SYSTEM_PROMPT + '\n\n' + this.pluginProjectBrief(),
        PLUGIN_USER_PREFIX + requirement + feedback,
        [PLUGIN_TOOL],
      )
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
        feedback = '\n\n上一次输出被截断。请直接输出完整、可运行的代码，不要省略、不要 JSON 包装。'
        this.ctx.logger.info('插件草稿被截断，自动扩容重试')
        continue
      }
      const toolArgs = parsed.toolCalls?.find((call) => call.name === 'emit_plugin')?.arguments
      // 多文件插件包：模型可额外输出 manifest（v2 清单）与 files（入口/页面/资源）
      const packageFiles = normalizePluginFiles(toolArgs?.files)
      const packageManifest = normalizePluginManifest(toolArgs?.manifest)
      const entryName = packageManifest?.entry || 'index.mjs'
      const fileCode = packageFiles.find((file) => file.path === entryName)?.content
      const code =
        toolArgs && typeof toolArgs.code === 'string' && toolArgs.code.trim()
          ? toolArgs.code.trim()
          : fileCode || extractPluginCode(parsed.text)
      const dependencies = normalizeDependencies(
        toolArgs?.dependencies ?? extractDependenciesFromText(parsed.text),
      )
      const kind = pickPluginKind(toolArgs?.kind ?? extractKindFromText(parsed.text) ?? extractKindFromCode(code))
      if (!code) {
        lastError = '模型没有返回有效的插件代码'
        feedback = '\n\n上一次没有返回有效代码。请输出单文件 ESM 源码，或提供 files 数组并包含入口文件。'
        continue
      }
      // 与安装端共用同一套契约检查：错误的 import / defineCleanerPlugin / 危险 API
      // 在这里就拦下来，不把“能生成但装不上”的草稿交给用户。
      const check = checkPluginSource(code, {
        dependencies,
        mode: 'native',
        allowRelativeImports: packageFiles.length > 0,
      })
      if (!check.ok) {
        lastError = check.errors.slice(0, 2).join('；')
        feedback =
          '\n\n上一次生成的插件代码未通过静态契约检查：\n- ' +
          check.errors.join('\n- ') +
          '\n请修正后重新输出完整代码：原生 Cordis 插件用 export function apply(ctx)；不要 import 框架包；第三方包必须在 dependencies 中声明。'
        this.ctx.logger.info('插件草稿未通过契约检查，自动重试：%s', check.errors[0])
        continue
      }
      const syntaxError = await checkPluginSyntax(code)
      if (syntaxError) {
        lastError = '语法错误：' + syntaxError
        feedback = '\n\n上一次生成的插件代码有语法错误：\n' + syntaxError + '\n请输出语法完整、括号配对的代码，不要省略结尾。'
        this.ctx.logger.info('插件草稿语法错误，自动重试：%s', syntaxError.slice(0, 200))
        continue
      }
      const matched = code.match(/(?:export\s+const\s+name\s*=|name\s*:)\s*['"]([a-zA-Z0-9_-]+)['"]/)
      // 原生草稿统一走 v2 插件包安装事务；第三方依赖在 staging 里安装 node_modules（用户确认后）
      const format = 'package' as const
      return {
        name: matched?.[1] ?? packageManifest?.id ?? 'ai-plugin',
        code,
        notes: parsed.text.slice(0, 200),
        dependencies,
        mode: 'native',
        kind,
        format,
        ...(packageManifest ? { manifest: packageManifest } : {}),
        ...(packageFiles.length ? { files: packageFiles } : {}),
      }
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
    // 尊重用户配置的 max_tokens：只按模型能力上限收敛，不再偷偷抬到 32768
    const requestedTokens = Number(this.rawConfig.maxTokens)
    const config = {
      ...this.rawConfig,
      maxTokens: Math.min(limits.maxOutputTokens, Math.max(1, Number.isFinite(requestedTokens) ? requestedTokens : 3000)),
    }
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


    let result: any
    let parsed: any
    if (config.stream !== false) {
      try {
        let text = ''
        let reasoning = ''
        await requestSse(request.url, {
          headers: request.headers,
          body: JSON.stringify({ ...request.body, stream: true }),
          timeoutMs: config.timeoutMs,
          signal,
        }, (payload) => {
          const delta = parseSseDelta(config.apiShape, payload)
          if (delta.text) {
            text += delta.text
            ;(this.ctx.emit as any)('ai/stream', { kind: 'delta', text: delta.text })
          }
          if (delta.reasoning) {
            reasoning += delta.reasoning
            ;(this.ctx.emit as any)('ai/stream', { kind: 'delta', reasoning: delta.reasoning })
          }
        })
        if (text.trim()) {
          ;(this.ctx.emit as any)('ai/stream', { kind: 'done', text })
          result = { status: 200, latencyMs: 0, payload: {} }
          parsed = { text, reasoning: reasoning || undefined, finish: 'stop', truncated: false, usage: undefined, raw: {} }
        }
      } catch (error) {
        this.ctx.logger.info('流式请求失败，回退非流式：%s', errorMessage(error))
      }
    }
    if (!parsed) {
      result = await requestJson(request.url, {
        headers: request.headers,
        body: request.body,
        timeoutMs: config.timeoutMs,
        retries: config.retries,
        signal,
      })
      parsed = parseResponse(config, result.payload)
    }
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

/** 把模型输出的 dependencies 统一整理成 { 包名: 版本 }，非字符串项直接丢弃 */
export function normalizeDependencies(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const deps: Record<string, string> = {}
  for (const [name, version] of Object.entries(input as Record<string, unknown>)) {
    if (typeof version !== 'string') continue
    const key = String(name).trim()
    if (key) deps[key] = version.trim()
  }
  return deps
}

/** 把模型输出的多文件插件包内容整理成 [{path, content}]（最多 30 个，丢弃空路径/非字符串） */
export function normalizePluginFiles(input: unknown): AiPluginFile[] {
  if (!Array.isArray(input)) return []
  const files: AiPluginFile[] = []
  for (const item of input.slice(0, 30)) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const filePath = typeof record.path === 'string' ? record.path.trim() : ''
    const content = typeof record.content === 'string' ? record.content : ''
    if (!filePath || !content) continue
    files.push({ path: filePath, content })
  }
  return files
}

/** 把模型输出的 manifest 原样收下（深度校验交给宿主 validatePluginManifest） */
export function normalizePluginManifest(input: unknown): PluginManifest | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  return input as PluginManifest
}

function extractDependenciesFromText(text: string): Record<string, string> {
  const fenced = text.match(/```(?:json|js|javascript|mjs)?\s*([\s\S]*?)```/i)
  const raw = (fenced ? fenced[1] : text).trim()
  if (!raw.startsWith('{')) return {}
  try {
    const data = JSON.parse(raw)
    return normalizeDependencies(data?.dependencies)
  } catch {
    return {}
  }
}

const PLUGIN_KINDS: PluginKind[] = ['cleaner', 'widget', 'active', 'desktop', 'integration']

function pickPluginKind(value: unknown): PluginKind {
  return PLUGIN_KINDS.includes(value as PluginKind) ? (value as PluginKind) : 'cleaner'
}

function extractKindFromText(text: string): string {
  const fenced = text.match(/```(?:json|js|javascript|mjs)?\s*([\s\S]*?)```/i)
  const raw = (fenced ? fenced[1] : text).trim()
  if (!raw.startsWith('{')) return ''
  try {
    const data = JSON.parse(raw)
    return typeof data?.kind === 'string' ? data.kind : ''
  } catch {
    return ''
  }
}

function extractKindFromCode(code: string): string {
  const matched = code.match(/export\s+const\s+kind\s*=\s*['"]([a-zA-Z-]+)['"]/)
  return matched?.[1] ?? ''
}

/** 与运行时同一个解析器做语法检查（异步，不阻塞主线程） */
function checkPluginSyntax(text: string): Promise<string | null> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cordclean-ai-plugin-'))
  const file = path.join(dir, 'check.mjs')
  writeFileSync(file, text, 'utf8')
  return new Promise((resolve) => {
    let stderr = ''
    let stdout = ''
    let settled = false
    const child = spawn(process.execPath, ['--check', file], {
      windowsHide: true,
      // Electron 主进程里 process.execPath 是 electron.exe；不设这个变量会启动
      // Electron 窗口而不是 Node 语法检查，表现为一直超时。
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {}
      resolve('语法检查超时（10 秒）')
    }, 10_000)
    child.stderr?.on('data', (chunk) => (stderr += String(chunk)))
    child.stdout?.on('data', (chunk) => (stdout += String(chunk)))
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve('语法检查无法执行：' + error.message)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {}
      if (code === 0) return resolve(null)
      const raw = (stderr || stdout || 'node --check 返回非零退出码').trim()
      resolve(raw.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 4).join(' ') || 'node --check 返回非零退出码')
    })
  })
}
const PLUGIN_TOOL = {
  name: 'emit_plugin',
  description: '输出一个完整可运行的原生 Cordis 通用插件源码与 npm 依赖声明；可选输出多文件插件包（manifest + files）',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'kebab-case 插件名' },
      description: { type: 'string', description: '一句话说明插件功能，会显示在插件页' },
      kind: {
        type: 'string',
        enum: ['cleaner', 'widget', 'active', 'desktop'],
        description: '插件类型：cleaner 清理任务 / widget 声明式 UI 卡片 / active 后台生命周期',
      },
      code: {
        type: 'string',
        description: '完整单文件 ESM 源码；必须 export function apply(ctx)，用 Cordis 上下文注册能力',
      },
      notes: { type: 'string', description: '简要说明' },
      dependencies: {
        type: 'object',
        description: 'npm 依赖（包名 → semver），无依赖时输出 {}；最多 8 个',
        additionalProperties: { type: 'string' },
      },
      manifest: {
        type: 'object',
        description:
          '可选：v2 插件包清单（apiVersion:2、engines.cordclean、kind、entry、permissions、client）。不输出时由宿主自动合成',
      },
      files: {
        type: 'array',
        description: '可选：多文件插件包内容（不含 plugin.json），path 相对包目录；entry 必须出现在其中',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对包目录的路径，例如 index.mjs / client/index.html' },
            content: { type: 'string' },
          },
          required: ['path', 'content'],
        },
      },
    },
    required: ['name', 'code'],
  },
}

const PLUGIN_SYSTEM_PROMPT = [
  '你是 Cordis 通用插件工程师。只输出一个 JSON 对象：{ "name": "kebab-case", "description": "一句话说明插件功能", "kind": "cleaner|widget|active|desktop", "code": "完整 ESM 源码", "notes": "简要说明", "dependencies": {"包名":"版本"} }。',
  'code 是原生 Cordis 插件，必须是完整单文件 ESM：export const name = "kebab-case"; export const description = "一句话"; export const kind = "cleaner|widget|active|desktop"; 按需 export const inject = ["ui"] / ["cleaner"] / ["window"]; export function apply(ctx) { ... }。不要使用 export default 普通对象，也不要使用 setup()。',
  'widget/active/desktop 必须提供至少一个 commands 项（例如“刷新数据”“运行自检”），并在 apply 中用 ctx.ui.command(name, rpcID, handler) 注册；插件页没有手动命令时用户无法触发插件功能。cleaner 可不提供命令。',
  '插件按需声明 inject：用 ctx.ui 必须 inject 包含 "ui"；注册清理任务必须 inject 包含 "cleaner"；桌面窗口/托盘必须 inject 包含 "window"；使用 ctx.settings/system/pathPolicy 也必须分别 inject。Cordis 在未声明 inject 时读取 ctx 属性会直接抛错，禁止用 if (ctx.cleaner) / if (ctx.system) 这种方式探测能力；只使用 inject 中声明的服务。',
  'cleaner 类型：在 apply 中 ctx.cleaner.define({ id, name, category, risk, defaultSelected:false, targets:[...], scan(scan){ ... } })。scan 只读取目录并 scan.emit({ path, kind:"file"|"folder", size })，不要删除/修改文件。',
  'widget 类型：export const contributes = { overviewCards: [{ id, title, type:"metric|text|list|progress", resolve:"数据ID", refreshMs }] }；在 apply 中用 ctx.effect(() => ctx.ui.resolve(name, "数据ID", async () => ({ value: ... }))) 提供数据。宿主只渲染声明式卡片，禁止操作 DOM。',
  'overviewCards 的数据返回格式必须匹配类型：metric → { value: string|number, unit? }；text → { text } 或字符串；list → string[] 或 { items: string[] }；progress → { value: number, max: number }。不要用 { value: string[] } 表示列表，否则卡片会空白。',
  '也可以贡献 statusItems（状态栏）与 commands（插件页按钮）：statusItems 项使用 { id, label, resolve, tone }（label 是显示文字，不要用 title）；commands 项必须使用 { id, title, rpc }，title 是按钮文字，不要用 label。',
  '如确实需要自定义页面，可在 contributes.pages 中提供 mode:"iframe" 的自包含 HTML；页面内不能访问宿主 DOM，只能通过 postMessage 的 cordclean/plugin-page 协议请求 resolve 数据。',
  '多文件插件包（可选，推荐用于带独立客户端页面的插件）：额外输出 manifest（v2 清单，必须 apiVersion:2、engines.cordclean、kind、entry、permissions{services,network,subprocess}、client）与 files（[{path,content}]；path 用 / 分隔且必须在包内；入口文件必须出现在 files 中；客户端页面放 client/index.html，并在 manifest.client 写 { "mode":"page","entry":"client/index.html" }）。不输出 manifest/files 时，宿主会把单文件 code 自动包成 v2 插件包安装。',
  'active 类型：在 apply 中用 ctx.effect(() => { const timer = setInterval(...); return () => clearInterval(timer) }) 注册后台逻辑，并用 ctx.ui.emit(name, 事件名, 数据) 主动刷新界面、ctx.ui.notify(name, { title, message, level }) 弹通知；通过 ctx.on/ctx.emit 订阅事件。',
  'desktop 类型：用 ctx.window.open(name, { id, html, width, height, transparent, alwaysOnTop, clickThrough }) 打开独立悬浮窗口（仅 Electron 桌面壳可用）；用 ctx.window.createTray(name, { tooltip, items, onSelect }) 创建托盘。窗口 HTML 是自包含的，不能用 Node/宿主 DOM。',
  'dependencies 为空对象 {} 表示零依赖；需要第三方能力时声明 npm 包（最多 8 个），版本必须是 semver（如 "^3.3.2"），安装时由用户确认并下载。禁止 file:/git/URL/路径规格；优先纯 JS 包，避免需要本地编译的原生模块。',
  '代码可以 import 已声明的第三方包；也允许 import node:fs / node:fs/promises / node:path / node:os / node:url / node:util / node:crypto。禁止 import @cordisjs/*、@cordclean/* 或未在 dependencies 声明的包，也不要使用 defineCleanerPlugin。',
  '禁止：child_process、process.exit、fs.rm / rmSync / unlink / rmdir、直接删除文件、网络请求、在插件里执行 npm install、process.env 读取密钥。删除一律交给内核（只 emit 候选）。',
  '清理目标的路径模板：%TEMP%、%USERPROFILE%、%LOCALAPPDATA%、%APPDATA%、%WINDIR%；代码里用 ctx.system.env.get("TEMP") 等取实际路径，不要硬编码用户名。',
  '用 ctx.logger 记录关键日志；除了 JSON 外不要输出解释性文字。',
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
