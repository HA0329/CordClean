/**
 * AI 清理顾问插件。
 *
 * 设计目标：演示「清理内核 + 大模型」的结合方式 ——
 * 插件把本机的**脱敏系统画像**（仅容量、占用、任务统计，不含文件名与路径）
 * 发送给 OpenAI 兼容接口（默认 DeepSeek），由模型返回结构化的清理建议。
 *
 * 工程要点：
 * - 以 Cordis Service 的形式提供 `ctx.ai`，其它插件/界面可依赖该能力；
 * - 配置（apiKey / baseUrl / model）通过 Schemastery 声明，可在界面中修改并热重载；
 * - 对模型输出做严格校验与兜底，避免非法 JSON 导致界面崩溃。
 */
import Schema from 'schemastery'
import { Service, type Context } from 'cordis'
import { defineCleanerPlugin } from '@cordclean/shared'
import type { AiAnalysis, AiLike, AiSuggestion, RiskLevel, TaskDescriptor } from '@cordclean/shared'
import { errorMessage } from '@cordclean/utils'

export interface AiConfig {
  apiKey: string
  baseUrl: string
  model: string
  temperature: number
  maxTokens: number
  /** 是否让模型补充其它观察 */
  includeObservations: boolean
  /** 请求超时（毫秒） */
  timeout: number
}

const Config = Schema.object({
  apiKey: Schema.string().default('').description('API Key（留空则读取环境变量 DEEPSEEK_API_KEY）'),
  baseUrl: Schema.string().default('https://api.deepseek.com').description('OpenAI 兼容接口地址'),
  model: Schema.string().default('deepseek-chat').description('模型名称，如 deepseek-chat / deepseek-reasoner'),
  temperature: Schema.number().default(0.3).min(0).max(2).description('采样温度'),
  maxTokens: Schema.number().default(1200).min(256).max(8192).description('最大输出 token'),
  includeObservations: Schema.boolean().default(true).description('是否附带其它观察'),
  timeout: Schema.number().default(60_000).min(5000).max(180_000).description('请求超时（毫秒）'),
})

/** 系统画像（脱敏后发送给模型） */
interface SystemProfile {
  os: { release: string; arch: string; elevated: boolean }
  cpu: { model: string; cores: number }
  memory: { totalGb: number; freeGb: number }
  disks: Array<{ mount: string; totalGb: number; freeGb: number; usedPercent: number }>
  hotspots: Array<{ label: string; gb: number }>
  tasks: Array<{ id: string; name: string; category: string; risk: string; items: number; mb: number; elapsedMs: number }>
  topItems: Array<{ category: string; count: number; mb: number }>
  userNote?: string
}

const SYSTEM_PROMPT = `你是一名 Windows 系统清理专家，服务于一款名为 CordClean 的清理工具。
用户会给你一份**脱敏**的本机画像（只有容量、占用、任务统计，没有文件名和个人路径）。
请基于画像给出可执行的清理建议。

严格要求：
1. 只输出一个 JSON 对象，不要输出 Markdown 代码块或解释文字。
2. JSON 结构：
{
  "summary": "一段 60~120 字的中文总结，指出最值得处理的空间占用来源",
  "observations": ["其它观察，最多 4 条"],
  "suggestions": [
    {
      "title": "建议标题（不超过 16 字）",
      "reason": "为什么建议这么做（不超过 80 字，结合画像中的具体数字）",
      "taskId": "关联的内置任务 id，可为空字符串",
      "targets": ["建议的处理对象，只能是任务 id、分类名或目录类别，例如 temp / 浏览器缓存 / 开发缓存"],
      "estimatedBytes": 估算可释放字节数（整数，没有依据时填 0）,
      "confidence": 0 到 1 之间的小数,
      "risk": "safe" | "caution" | "risky"
    }
  ]
}
3. suggestions 给出 3~5 条，按可释放空间从大到小排序。
4. 不要在 targets 中出现任何真实路径、文件名或用户名。
5. 风险判断要保守：涉及系统组件、注册表、启动项的，risk 至少为 caution。`

/** 从模型输出中提取 JSON（容忍 ```json 包裹） */
function extractJson(text: string): any {
  const trimmed = text.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  const candidate = fenced ? fenced[1] : trimmed
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型未返回 JSON')
  return JSON.parse(candidate.slice(start, end + 1))
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}

function normalizeRisk(value: unknown): RiskLevel {
  return value === 'safe' || value === 'caution' || value === 'risky' ? value : 'caution'
}

/** AI 服务：以 Cordis Service 形式挂在 ctx 上 */
export class AiService extends Service implements AiLike {
  private cache?: AiAnalysis

  constructor(ctx: Context, private readonly config: AiConfig) {
    super(ctx, 'ai')
  }

  get model(): string {
    return this.config.model
  }

  /** 是否已配置 API Key */
  configured(): boolean {
    return !!this.resolveKey()
  }

  private resolveKey(): string {
    const fromConfig = (this.config.apiKey ?? '').trim()
    if (fromConfig) return fromConfig
    return (this.ctx.system.env.get('DEEPSEEK_API_KEY') ?? '').trim()
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
      // 没有扫描结果时，只跑「安全级」任务，避免动辄数分钟的深度扫描
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

  async analyze(options: { taskIds?: string[]; extraContext?: string } = {}): Promise<AiAnalysis> {
    const key = this.resolveKey()
    if (!key) throw new Error('未配置 API Key：请在插件配置中填写 apiKey，或设置环境变量 DEEPSEEK_API_KEY')

    const profile = await this.buildProfile(options.extraContext)
    const url = this.config.baseUrl.replace(/\/+$/, '') + '/chat/completions'
    const body = {
      model: this.config.model,
      temperature: this.config.temperature,
      max_tokens: this.config.maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: '本机画像如下（JSON）：\n' + JSON.stringify(profile, null, 2) },
      ],
    }

    const started = Date.now()
    let text: string
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeout),
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`接口返回 ${response.status}：${detail.slice(0, 200)}`)
      }
      const payload = (await response.json()) as any
      text = payload?.choices?.[0]?.message?.content ?? ''
      if (!text) throw new Error('模型返回内容为空')
    } catch (error) {
      this.ctx.logger.warn('AI 分析失败：%s', errorMessage(error))
      throw new Error('AI 分析失败：' + errorMessage(error))
    }

    let parsed: any
    try {
      parsed = extractJson(text)
    } catch (error) {
      throw new Error('模型输出不是合法 JSON：' + errorMessage(error))
    }

    const suggestions: AiSuggestion[] = Array.isArray(parsed.suggestions)
      ? parsed.suggestions.slice(0, 6).map((item: any, index: number) => ({
          id: `ai-${Date.now().toString(36)}-${index}`,
          title: String(item?.title ?? '清理建议').slice(0, 40),
          reason: String(item?.reason ?? '').slice(0, 400),
          taskId: typeof item?.taskId === 'string' && item.taskId ? item.taskId : undefined,
          targets: Array.isArray(item?.targets) ? item.targets.slice(0, 6).map((target: unknown) => String(target).slice(0, 60)) : [],
          estimatedBytes: Math.max(0, Math.trunc(Number(item?.estimatedBytes) || 0)),
          confidence: clampNumber(item?.confidence, 0, 1, 0.5),
          risk: normalizeRisk(item?.risk),
        }))
      : []

    const analysis: AiAnalysis = {
      model: this.config.model,
      createdAt: Date.now(),
      summary: String(parsed.summary ?? '').slice(0, 600),
      observations:
        this.config.includeObservations && Array.isArray(parsed.observations)
          ? parsed.observations.slice(0, 5).map((item: unknown) => String(item).slice(0, 200))
          : [],
      suggestions,
    }
    this.cache = analysis
    this.ctx.logger.info('AI 分析完成：%d 条建议，耗时 %d ms', suggestions.length, Date.now() - started)
    return analysis
  }
}

export default defineCleanerPlugin<AiConfig>({
  name: 'ai',
  version: '1.0.0',
  description: '调用 DeepSeek 等大模型 API，结合本机磁盘画像给出清理建议',
  inject: ['cleaner', 'system', 'settings'],
  Config,
  setup(ctx, config) {
    // 以 Service 形式注册 ctx.ai，供界面与其它插件使用
    const service = new AiService(ctx, config)
    ctx.logger.info('AI 顾问已就绪：模型 %s，%s', config.model, service.configured() ? '已配置凭据' : '尚未配置 API Key')
  },
})
