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

export { Config, normalizeConfig, applyEffort, resolveChatUrl, resolveModelsUrl, DEFAULT_PATHS, DEFAULT_BASE_URLS, API_SHAPES, EFFORT_LEVELS } from './config.ts'
export { buildRequest, parseResponse, authHeaders, mergeHeaders } from './adapters.ts'
export { FALLBACK_MODELS, fetchModelList } from './models.ts'
export { AiService, createAiService, extractJsonObject, normalizeSuggestions } from './service.ts'
export { AiError, requestJson } from './http.ts'
export type { AiConfig } from './config.ts'

export default defineCleanerPlugin<Partial<AiConfig>>({
  name: 'ai',
  version: '2.0.0',
  description: '支持 chat / messages / responses 三种接口形态，模型与推理等级可配置、可扩展',
  inject: ['cleaner', 'system', 'settings'],
  Config,
  setup(ctx, config) {
    const normalized = normalizeConfig(config as Partial<AiConfig>)
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

  },
})
