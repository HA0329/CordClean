/**
 * AI 插件工坊插件（独立于「AI 清理顾问」）。
 *
 * 职责：按用户需求生成 v2 插件包草稿（清单 + 入口 + 可选 client 页面）。
 * 与 AI 清理顾问的分工：
 *   - AI 清理顾问：清理建议分析、规则评估，自己的 API 配置；
 *   - AI 插件工坊：插件生成，自己的生成参数（模型覆盖 / maxTokens / 重试 / 追加提示），
 *     复用 AI 顾问的 API 连接与 Key（不需要重复填写 Key）。
 *
 * 依赖关系：启用本插件前需要先启用「AI 清理顾问」插件（`inject: ['ai']`）。
 * 拆开后可以在插件页单独启停工坊，不影响分析功能，也不影响 AI 顾问的配置。
 */
import Schema from 'schemastery'
import { Service, type Context } from 'cordis'
import { defineCleanerPlugin } from '@cordclean/shared'
import type { AiLike, AiPluginDraft, AiWorkshopStatus } from '@cordclean/shared'

export interface AiWorkshopConfig {
  /** 模型覆盖；留空表示跟随 AI 清理顾问的模型 */
  model: string
  /** 单次生成的最大输出 token（截断时本次生成内自动翻倍） */
  maxTokens: number
  /** 生成失败/截断/契约不通过时额外重试次数 */
  retries: number
  /** 追加到工坊 system prompt 的额外说明 */
  systemPromptExtra: string
}

export const Config = Schema.object({
  model: Schema.string()
    .default('')
    .description('模型覆盖：留空表示跟随「AI 清理顾问」的模型；工坊可单独指定其他模型'),
  maxTokens: Schema.number()
    .default(32_768)
    .min(4_096)
    .max(131_072)
    .description('单次生成的最大输出 token；输出被截断时会在本次生成内自动翻倍'),
  retries: Schema.number()
    .default(2)
    .min(0)
    .max(5)
    .description('生成失败 / 被截断 / 静态契约不通过时的自动重试次数'),
  systemPromptExtra: Schema.string()
    .default('')
    .description('追加到工坊 system prompt 的额外要求（例如团队编码约定），留空则不追加'),
})

export function normalizeWorkshopConfig(raw: Partial<AiWorkshopConfig> | undefined): AiWorkshopConfig {
  const maxTokens = Number(raw?.maxTokens)
  const retries = Number(raw?.retries)
  return {
    model: String(raw?.model ?? '').trim(),
    maxTokens: Number.isFinite(maxTokens) ? Math.min(131_072, Math.max(4_096, Math.trunc(maxTokens))) : 32_768,
    retries: Number.isFinite(retries) ? Math.min(5, Math.max(0, Math.trunc(retries))) : 2,
    systemPromptExtra: String(raw?.systemPromptExtra ?? '').trim(),
  }
}

/** 供界面/宿主调用的工坊服务（命名空间 aiWorkshop） */
export class AiWorkshopService extends Service {
  constructor(
    ctx: Context,
    private readonly options: AiWorkshopConfig,
  ) {
    super(ctx, 'aiWorkshop')
  }

  private aiService(): AiLike | undefined {
    return (this.ctx as unknown as { ai?: AiLike }).ai
  }

  configured(): boolean {
    return this.aiService()?.configured() === true
  }

  status(): AiWorkshopStatus {
    const ai = this.aiService()
    const aiModel = ai?.status?.().model ?? ''
    return {
      available: typeof ai?.draftPlugin === 'function',
      configured: this.configured(),
      model: this.options.model || aiModel,
      aiModel,
      inheritsModel: !this.options.model,
      maxTokens: this.options.maxTokens,
      retries: this.options.retries,
      systemPromptExtra: this.options.systemPromptExtra,
    }
  }

  async draftPlugin(requirement: string): Promise<AiPluginDraft> {
    const text = String(requirement ?? '').trim()
    if (!text) throw new Error('请先描述你想要的插件')
    const ai = this.aiService()
    if (!ai?.draftPlugin) {
      throw new Error('AI 插件工坊需要先启用「AI 清理顾问」插件（工坊复用它的 API 连接与 Key）')
    }
    if (!this.configured()) {
      throw new Error('「AI 清理顾问」还没有配置 API Key：请先在 AI 建议页填写 Key，再回来生成插件包')
    }
    return ai.draftPlugin(text, {
      ...(this.options.model ? { model: this.options.model } : {}),
      maxTokens: this.options.maxTokens,
      retries: this.options.retries,
      ...(this.options.systemPromptExtra ? { systemPromptExtra: this.options.systemPromptExtra } : {}),
    })
  }
}

export default defineCleanerPlugin<Partial<AiWorkshopConfig>>({
  name: 'ai-workshop',
  version: '1.0.0',
  description: '独立插件：按需求生成 v2 插件包草稿；生成参数与 AI 清理顾问分开，复用其 API 连接',
  inject: ['ai'],
  Config,
  setup(ctx, config) {
    const normalized = normalizeWorkshopConfig(config)
    const service = new AiWorkshopService(ctx, normalized)
    void service
    ctx.logger.info(
      'AI 插件工坊已就绪：模型 %s，maxTokens %d，重试 %d',
      normalized.model || '跟随 AI 清理顾问',
      normalized.maxTokens,
      normalized.retries,
    )
  },
})
