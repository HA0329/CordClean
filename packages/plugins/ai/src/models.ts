/**
 * 模型列表：优先从 `/models` 动态获取，失败时退回内置目录。
 *
 * 「模型名会被换掉」是这类 API 最常见的破坏性变更：DeepSeek 就把
 * `deepseek-chat`/`deepseek-reasoner` 下线改成了 `deepseek-flash`/`deepseek-v4-pro`。
 * 因此插件不把模型名写死，而是运行时拉取；内置列表只作为离线兜底与提示。
 */
import type { AiModelInfo } from '@cordclean/shared'
import { resolveModelsUrl, type AiConfig } from './config.ts'
import { authHeaders, mergeHeaders } from './adapters.ts'
import { requestJson } from './http.ts'

/** 内置兜底目录（2026-10 实际 `/models` 返回的能力信息） */
export const FALLBACK_MODELS: AiModelInfo[] = [
  {
    id: 'deepseek-flash',
    name: 'DeepSeek-V4.1-Flash',
    description: '快速、经济，支持文本与图片输入',
    contextWindow: 1_048_576,
    maxOutputTokens: 393_216,
    inputModalities: ['text', 'image'],
    effortLevels: ['low', 'high', 'max'],
    defaultEffort: 'high',
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek-V4-Pro',
    description: '更强的复杂推理与智能体能力，成本更高',
    contextWindow: 1_048_576,
    maxOutputTokens: 393_216,
    inputModalities: ['text'],
    effortLevels: ['low', 'high', 'max'],
    defaultEffort: 'high',
  },
]

export interface ModelListResult {
  source: 'remote' | 'fallback'
  models: AiModelInfo[]
  /** 拉取失败时的原因（仅用于界面提示） */
  error?: string
}

function toNumber(value: unknown): number | undefined {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? num : undefined
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const list = value.filter((item): item is string => typeof item === 'string' && !!item)
  return list.length ? list : undefined
}

/** 把一条厂商返回的模型记录归一化为 AiModelInfo */
function normalizeModel(raw: any): AiModelInfo | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const id = String(raw.id ?? raw.model ?? raw.name ?? '').trim()
  if (!id) return undefined
  const effort = raw.effort ?? raw.capabilities?.effort ?? raw.reasoning ?? {}
  const efforts = toStringArray(effort.supported_levels ?? effort.supportedLevels ?? raw.reasoning_efforts)
  const defaultEffort = typeof effort.default_level === 'string'
    ? effort.default_level
    : typeof effort.defaultEffort === 'string'
      ? effort.defaultEffort
      : undefined
  return {
    id,
    name: typeof raw.name === 'string' && raw.name !== id ? raw.name : typeof raw.display_name === 'string' ? raw.display_name : undefined,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    contextWindow: toNumber(raw.context_window ?? raw.context_length ?? raw.max_context_window ?? raw.contextWindow),
    maxOutputTokens: toNumber(raw.max_output_tokens ?? raw.max_tokens ?? raw.maxOutputTokens),
    inputModalities: toStringArray(raw.input_modalities ?? raw.inputModalities ?? raw.modalities),
    effortLevels: efforts,
    defaultEffort,
  }
}

/** 从任意兼容形态里提取模型数组 */
function extractModels(payload: any): AiModelInfo[] {
  const candidates: any[] = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : []
  const models: AiModelInfo[] = []
  const seen = new Set<string>()
  for (const item of candidates) {
    const model = normalizeModel(item)
    if (!model || seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
  }
  return models
}

/** 拉取模型列表（失败不抛错，回落内置目录） */
export async function fetchModelList(config: AiConfig, apiKey: string): Promise<ModelListResult> {
  try {
    const url = resolveModelsUrl(config)
    const headers = mergeHeaders(authHeaders(config, apiKey), config.extraHeaders)
    const result = await requestJson(url, {
      method: 'GET',
      headers,
      timeoutMs: Math.min(config.timeoutMs, 20_000),
      retries: 0,
    })
    const models = extractModels(result.payload)
    if (!models.length) {
      return { source: 'fallback', models: FALLBACK_MODELS, error: '接口没有返回可用模型' }
    }
    return { source: 'remote', models }
  } catch (error) {
    return {
      source: 'fallback',
      models: FALLBACK_MODELS,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
