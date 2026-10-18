/**
 * AI 插件「多接口形态 + 可扩展配置」测试。
 *
 * 用本地 Mock 服务模拟三种接口形态，验证：
 * - chat / messages / responses 的请求组装与响应解析；
 * - 推理等级映射（off/high）在三种形态下的具体字段；
 * - extraBody / extraHeaders 逃生舱；
 * - 模型列表动态获取与兜底；
 * - 连通性探测（成功/鉴权失败）；
 * - 500 自动重试与形态不匹配的报错。
 */
import { createServer, type Server } from 'node:http'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type App } from '@cordclean/core'
import aiPlugin from '@cordclean/plugin-ai'
import { createSandbox, manifestOf } from './helpers.ts'

const sandbox = createSandbox()
let server: Server
let port = 0

/** 服务端行为开关 */
type Mode = 'ok' | 'models-fail' | 'retry-then-ok' | 'unauthorized' | 'wrong-shape-for-chat' | 'rule-eval'
let mode: Mode = 'ok'
let retryBudget = 0
let callCount = 0
/** 只统计 LLM 请求（不含 /models 预取） */
let llmCalls = 0
let lastRequest: { url?: string; method?: string; headers: Record<string, any>; body: any } = { headers: {}, body: undefined }

const ANSWER = {
  summary: '空间充足，可清理缓存与临时文件',
  observations: ['C 盘剩余较多'],
  suggestions: [
    {
      title: '清理缓存',
      reason: '缓存可重建',
      taskId: 'temp',
      targets: ['temp'],
      estimatedBytes: 1234,
      confidence: 0.8,
      risk: 'safe',
    },
  ],
}

const CHAT_PAYLOAD = {
  choices: [
    {
      message: { role: 'assistant', content: JSON.stringify(ANSWER), reasoning_content: '这是 chat 的思维链' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 5 }, total_tokens: 30 },
}

const MESSAGES_PAYLOAD = {
  content: [
    { type: 'thinking', thinking: '这是 messages 的思维链' },
    { type: 'text', text: JSON.stringify(ANSWER) },
  ],
  stop_reason: 'end_turn',
  usage: { input_tokens: 11, output_tokens: 22 },
}

const RESPONSES_PAYLOAD = {
  status: 'completed',
  output: [
    { type: 'reasoning', content: [{ type: 'reasoning_text', text: '这是 responses 的思维链' }] },
    { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(ANSWER) }] },
  ],
  usage: { input_tokens: 12, output_tokens: 24, output_tokens_details: { reasoning_tokens: 6 }, total_tokens: 36 },
}

const MODELS_PAYLOAD = {
  object: 'list',
  data: [
    {
      id: 'deepseek-flash',
      object: 'model',
      name: 'DeepSeek-V4.1-Flash',
      context_window: 1048576,
      max_output_tokens: 393216,
      input_modalities: ['text', 'image'],
      effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' },
    },
    { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
  ],
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => {
      callCount++
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: any
      try {
        body = raw ? JSON.parse(raw) : undefined
      } catch {
        body = raw
      }
      lastRequest = { url: req.url, method: req.method, headers: req.headers, body }

      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(payload))
      }

      const isLlm = !!req.url && (req.url.includes('/chat/completions') || req.url.includes('/anthropic/v1/messages') || req.url.endsWith('/responses'))
      if (isLlm) llmCalls++

      if (req.url?.startsWith('/models')) {
        if (mode === 'models-fail') return send(500, { error: { message: 'models down' } })
        return send(200, MODELS_PAYLOAD)
      }
      if (mode === 'unauthorized') return send(401, { error: { message: 'invalid api key', code: 'invalid_api_key' } })
      if (mode === 'retry-then-ok' && retryBudget-- > 0) return send(500, { error: { message: 'temporary boom' } })

      if (mode === 'rule-eval' && req.url?.includes('/chat/completions')) {
        return send(200, {
          choices: [{
            message: {
              content: JSON.stringify({
                items: [{ ruleId: 'system_temp-1', suggest: true, risk: 'safe', reason: '可安全清理' }],
              }),
            },
          }],
        })
      }
      if (req.url?.includes('/chat/completions')) {
        if (mode === 'wrong-shape-for-chat') return send(200, MESSAGES_PAYLOAD)
        return send(200, CHAT_PAYLOAD)
      }
      if (req.url?.includes('/anthropic/v1/messages')) return send(200, MESSAGES_PAYLOAD)
      if (req.url?.endsWith('/responses')) return send(200, RESPONSES_PAYLOAD)
      send(404, { error: { message: 'not found' } })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  port = typeof address === 'object' && address ? address.port : 0
})

afterEach(() => {
  mode = 'ok'
  retryBudget = 0
  callCount = 0
  llmCalls = 0
  lastRequest = { headers: {}, body: undefined }
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(sandbox.root, { recursive: true, force: true })
})

async function boot(config: Record<string, unknown>, name: string): Promise<App> {
  return createApp({
    dataDir: path.join(sandbox.dataDir, name),
    logger: false,
    manifest: manifestOf([{ id: 'ai', plugin: aiPlugin }]),
    settingsOverrides: {
      plugins: {
        ai: {
          enabled: true,
          config: { apiKey: 'test-key', baseUrl: `http://127.0.0.1:${port}`, model: 'deepseek-flash', retries: 0, ...config },
        },
      },
    },
  })
}

describe('三种接口形态', () => {
  it('chat 形态：解析 content + reasoning_content + usage', async () => {
    const app = await boot({ apiShape: 'chat' }, 'shape-chat')
    try {
      const analysis = await app.ctx.ai!.analyze()
      expect(lastRequest.url).toBe('/chat/completions')
      expect(analysis.suggestions).toHaveLength(1)
      expect(analysis.reasoning).toContain('chat 的思维链')
      expect(analysis.usage).toMatchObject({ inputTokens: 10, outputTokens: 20, reasoningTokens: 5 })
      expect(analysis.shape).toBe('chat')
    } finally {
      await app.dispose()
    }
  })

  it('messages 形态：baseUrl 不带 /anthropic 时自动补全路径', async () => {
    const app = await boot({ apiShape: 'messages' }, 'shape-messages')
    try {
      const analysis = await app.ctx.ai!.analyze()
      expect(lastRequest.url).toBe('/anthropic/v1/messages')
      expect(lastRequest.headers['x-api-key']).toBe('test-key')
      expect(analysis.reasoning).toContain('messages 的思维链')
      expect(analysis.usage).toMatchObject({ inputTokens: 11, outputTokens: 22 })
      expect(analysis.shape).toBe('messages')
    } finally {
      await app.dispose()
    }
  })

  it('responses 形态：解析 output 数组中的 reasoning 与 message', async () => {
    const app = await boot({ apiShape: 'responses' }, 'shape-responses')
    try {
      const analysis = await app.ctx.ai!.analyze()
      expect(lastRequest.url).toBe('/responses')
      expect(analysis.reasoning).toContain('responses 的思维链')
      expect(analysis.usage).toMatchObject({ inputTokens: 12, outputTokens: 24, reasoningTokens: 6 })
      expect(lastRequest.body.max_output_tokens).toBeGreaterThan(0)
      expect(lastRequest.body.text).toEqual({ format: { type: 'json_object' } })
    } finally {
      await app.dispose()
    }
  })
})

describe('推理等级映射', () => {
  it('chat + high：thinking=enabled + reasoning_effort=high', async () => {
    const app = await boot({ apiShape: 'chat', reasoningEffort: 'high' }, 'effort-chat-high')
    try {
      await app.ctx.ai!.analyze()
      expect(lastRequest.body.thinking).toEqual({ type: 'enabled' })
      expect(lastRequest.body.reasoning_effort).toBe('high')
    } finally {
      await app.dispose()
    }
  })

  it('chat + off：thinking=disabled 且不发送 reasoning_effort', async () => {
    const app = await boot({ apiShape: 'chat', reasoningEffort: 'off' }, 'effort-chat-off')
    try {
      await app.ctx.ai!.analyze()
      expect(lastRequest.body.thinking).toEqual({ type: 'disabled' })
      expect(lastRequest.body.reasoning_effort).toBeUndefined()
    } finally {
      await app.dispose()
    }
  })

  it('messages + high：output_config.effort=high', async () => {
    const app = await boot({ apiShape: 'messages', reasoningEffort: 'high' }, 'effort-messages')
    try {
      await app.ctx.ai!.analyze()
      expect(lastRequest.body.thinking).toEqual({ type: 'enabled' })
      expect(lastRequest.body.output_config).toEqual({ effort: 'high' })
    } finally {
      await app.dispose()
    }
  })

  it('responses + off：reasoning.effort=none', async () => {
    const app = await boot({ apiShape: 'responses', reasoningEffort: 'off' }, 'effort-responses-off')
    try {
      await app.ctx.ai!.analyze()
      expect(lastRequest.body.reasoning).toEqual({ effort: 'none' })
    } finally {
      await app.dispose()
    }
  })

  it('medium 映射为 high', async () => {
    const app = await boot({ apiShape: 'chat', reasoningEffort: 'medium' }, 'effort-medium')
    try {
      await app.ctx.ai!.analyze()
      expect(lastRequest.body.reasoning_effort).toBe('high')
    } finally {
      await app.dispose()
    }
  })
})

describe('扩展配置逃生舱', () => {
  it('extraBody 可以覆盖默认字段并追加新参数', async () => {
    const app = await boot(
      {
        apiShape: 'chat',
        reasoningEffort: 'high',
        extraBody: { max_tokens: 64, thinking: { type: 'disabled' }, top_p: 0.95, future_field: 'x' },
      },
      'extra-body',
    )
    try {
      await app.ctx.ai!.analyze()
      expect(lastRequest.body.max_tokens).toBe(64)
      expect(lastRequest.body.thinking).toEqual({ type: 'disabled' })
      expect(lastRequest.body.top_p).toBe(0.95)
      expect(lastRequest.body.future_field).toBe('x')
    } finally {
      await app.dispose()
    }
  })

  it('extraHeaders 会随请求发送', async () => {
    const app = await boot({ apiShape: 'chat', extraHeaders: { 'x-trace-id': 'abc-123' } }, 'extra-headers')
    try {
      await app.ctx.ai!.analyze()
      expect(lastRequest.headers['x-trace-id']).toBe('abc-123')
    } finally {
      await app.dispose()
    }
  })

  it('自定义 chatPath 生效（适配代理/反代）', async () => {
    const app = await boot({ apiShape: 'chat', chatPath: '/chat/completions' }, 'custom-path')
    try {
      await app.ctx.ai!.analyze()
      expect(lastRequest.url).toBe('/chat/completions')
    } finally {
      await app.dispose()
    }
  })

  it('自定义 systemPrompt 会替换内置提示词', async () => {
    const app = await boot({ apiShape: 'chat', systemPrompt: '你是自定义提示词' }, 'custom-prompt')
    try {
      await app.ctx.ai!.analyze()
      expect(lastRequest.body.messages[0].content).toContain('你是自定义提示词')
    } finally {
      await app.dispose()
    }
  })
})

describe('模型列表与连通性探测', () => {
  it('从 /models 解析模型能力信息', async () => {
    const app = await boot({ apiShape: 'chat' }, 'models-ok')
    try {
      const result = await app.ctx.ai!.models({ refresh: true })
      expect(result.source).toBe('remote')
      expect(result.models.map((model) => model.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
      expect(result.models[0]).toMatchObject({
        contextWindow: 1048576,
        effortLevels: ['low', 'high', 'max'],
        defaultEffort: 'high',
      })
      expect(app.ctx.ai!.status().models).toHaveLength(2)
    } finally {
      await app.dispose()
    }
  })

  it('模型接口故障时回落到内置目录而不是报错', async () => {
    mode = 'models-fail'
    const app = await boot({ apiShape: 'chat' }, 'models-fallback')
    try {
      const result = await app.ctx.ai!.models({ refresh: true })
      expect(result.source).toBe('fallback')
      expect(result.models.length).toBeGreaterThan(0)
    } finally {
      await app.dispose()
    }
  })

  it('探测成功返回耗时与文本', async () => {
    const app = await boot({ apiShape: 'chat' }, 'probe-ok')
    try {
      const probe = await app.ctx.ai!.probe()
      expect(probe.ok).toBe(true)
      expect(probe.status).toBe(200)
      expect(probe.latencyMs).toBeGreaterThanOrEqual(0)
      expect(probe.text.length).toBeGreaterThan(0)
    } finally {
      await app.dispose()
    }
  })

  it('探测失败时返回可读错误（含 HTTP 状态码）', async () => {
    mode = 'unauthorized'
    const app = await boot({ apiShape: 'chat' }, 'probe-auth')
    try {
      const probe = await app.ctx.ai!.probe()
      expect(probe.ok).toBe(false)
      expect(probe.status).toBe(401)
      expect(probe.error).toMatch(/HTTP 401/)
    } finally {
      await app.dispose()
    }
  })
})

describe('错误处理', () => {
  it('500 会自动重试（retries=2 时第三次成功）', async () => {
    mode = 'retry-then-ok'
    retryBudget = 2
    const app = await boot({ apiShape: 'chat', retries: 2 }, 'retry')
    try {
      const analysis = await app.ctx.ai!.analyze()
      expect(analysis.suggestions).toHaveLength(1)
      expect(llmCalls).toBe(3)
    } finally {
      await app.dispose()
    }
  }, 30_000)

  it('形态不匹配时给出带字段名的错误', async () => {
    mode = 'wrong-shape-for-chat'
    const app = await boot({ apiShape: 'chat' }, 'wrong-shape')
    try {
      await expect(app.ctx.ai!.analyze()).rejects.toThrow(/无法识别的响应结构/)
    } finally {
      await app.dispose()
    }
  })
})

describe('作为可替换评估器', () => {
  it('规则统计 → AI 结论映射（不含路径）', async () => {
    mode = 'rule-eval'
    const app = await boot({ apiShape: 'chat' }, 'ai-eval-rules')
    try {
      const map = await (app.ctx.ai as any).evaluateRules([
        { ruleId: 'system_temp-1', name: '用户临时文件', category: '系统临时文件', risk: 'safe', count: 3, bytes: 3072 },
      ])
      expect(map.get('system_temp-1')).toMatchObject({ suggest: true, risk: 'safe' })
      // 请求体只包含规则统计，不含本机路径
      expect(JSON.stringify(lastRequest.body)).not.toContain('C:\\')
    } finally {
      await app.dispose()
    }
  })

  it('asEvaluator=true 时接管规则评估', async () => {
    const app = await boot({ apiShape: 'chat', asEvaluator: true }, 'ai-eval-use')
    try {
      expect(app.ctx.evaluator.current()).toBe('ai')
      expect(app.ctx.evaluator.strategies()).toContain('ai')
    } finally {
      await app.dispose()
    }
  })

  it('asEvaluator=false 时保持内置启发式', async () => {
    const app = await boot({ apiShape: 'chat' }, 'ai-eval-off')
    try {
      expect(app.ctx.evaluator.current()).toBe('heuristic')
    } finally {
      await app.dispose()
    }
  })
})
