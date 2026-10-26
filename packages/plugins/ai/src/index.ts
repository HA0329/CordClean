/**
 * AI 清理顾问插件（v2）。
 *
 * 与 v1 的差别：接口不再写死。模型名、接口形态、地址路径、推理等级、
 * JSON 模式都可以配置，且预留 `extraBody` / `extraHeaders` 两个逃生舱，
 * 厂商新增参数或调整字段时，用户改配置即可，不需要重新发布插件。
 *
 * 三种接口形态均实测可用（2026-10）：
 *   chat      → POST {baseUrl}/chat/completions
 *   messages  → POST {baseUrl}/anthropic/v1/messages
 *   responses → POST {baseUrl}/responses
 */
import { defineCleanerPlugin } from '@cordclean/shared'
import { Config, normalizeConfig, type AiConfig } from './config.ts'
import { AiService } from './service.ts'

export { Config, normalizeConfig, resolveModelAlias, LEGACY_MODEL_ALIASES, applyEffort, resolveChatUrl, resolveModelsUrl, DEFAULT_PATHS, DEFAULT_BASE_URLS, API_SHAPES, EFFORT_LEVELS } from './config.ts'
export { buildRequest, parseResponse, authHeaders, mergeHeaders } from './adapters.ts'
export { FALLBACK_MODELS, fetchModelList } from './models.ts'
export { AiService, createAiService, extractJsonObject, extractPluginCode, normalizeSuggestions, normalizePluginFiles, normalizePluginManifest, PLUGIN_TOOL, PLUGIN_SYSTEM_PROMPT, PLUGIN_USER_PREFIX, PLUGIN_KINDS, pickPluginKind, normalizeDependencies, checkPluginSyntax } from './service.ts'
export { AiError, requestJson } from './http.ts'
export type { AiConfig } from './config.ts'

export default defineCleanerPlugin<Partial<AiConfig>>({
  name: 'ai',
  version: '2.0.0',
  description: '支持 chat / messages / responses 三种接口形态，模型与推理等级可配置、可扩展',
  inject: ['cleaner', 'system', 'settings', 'evaluator', 'egress', 'aiContext'],
  Config,
  setup(ctx, config) {
    const normalized = normalizeConfig(config as Partial<AiConfig>)
    const legacyModel = String((config as any)?.model ?? '')
    if (legacyModel && legacyModel !== normalized.model) {
      ctx.logger.info('模型名 %s 已下线，自动迁移为 %s', legacyModel, normalized.model)
    }
    const service = new AiService(ctx, normalized)

    const credential = service.configured() ? '使用已配置/环境变量中的 API Key' : '未配置 API Key（可在界面填写或设置 DEEPSEEK_API_KEY）'
    ctx.logger.info(
      'AI 顾问已就绪：形态 %s，模型 %s，推理等级 %s，%s',
      normalized.apiShape,
      normalized.model,
      normalized.reasoningEffort,
      credential,
    )

    // 预取模型列表（不阻塞插件加载）：用户打开界面时就能看到候选模型
    if (service.configured()) {
      void service
        .models()
        .then((result) => {
          if (result.source === 'remote') {
            ctx.logger.info('已从接口获取 %d 个可用模型', result.models.length)
          }
        })
        .catch(() => {})
    }

    // 作为「可替换评估器」接入：规则包扫描时由 AI 给出 建议/风险/理由。
    // 默认不接管（asEvaluator=false），只有用户显式开启才 use('ai')。
    ctx.effect(() =>
      ctx.evaluator.register({
        id: 'ai',
        name: `AI 评估器（${normalized.model}）`,
        async evaluate(inputs) {
          // 按规则聚合，避免把同一个规则的多条候选重复送给模型
          const groups = new Map<string, { rule: (typeof inputs)[number]['rule']; count: number; bytes: number }>()
          for (const input of inputs) {
            const group = groups.get(input.rule.id)
            if (group) {
              group.count++
              group.bytes += input.size
            } else {
              groups.set(input.rule.id, { rule: input.rule, count: 1, bytes: input.size })
            }
          }
          const results = await service.evaluateRules(
            [...groups.values()].map((group) => ({
              ruleId: group.rule.id,
              name: group.rule.name,
              category: group.rule.categoryLabel ?? group.rule.category,
              risk: group.rule.risk,
              count: group.count,
              bytes: group.bytes,
            })),
          )
          return inputs.map((input) => {
            const hit = results.get(input.rule.id)
            if (!hit) {
              // 模型漏掉的规则：保守回落到启发式结果，不让整批失败
              return {
                suggest: input.rule.risk === 'safe' && !input.protected,
                risk: input.rule.risk,
                reason: 'AI 未给出该规则的结论，已回落到默认判断',
                strategy: 'ai',
              }
            }
            return { ...hit, strategy: 'ai' }
          })
        },
      }),
    )
    if (normalized.asEvaluator) {
      try {
        ctx.evaluator.use('ai')
        ctx.logger.info('AI 已接管规则评估（可在界面关闭）')
      } catch (error) {
        ctx.logger.warn('切换到 AI 评估器失败：%s', error instanceof Error ? error.message : String(error))
      }
    }
  },
})
