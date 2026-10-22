/**
 * AI 插件异常路径测试：接口报错、非法 JSON、字段缺失、超时、环境变量凭据。
 */
import { createServer, type Server } from 'node:http'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '@cordclean/core'
import aiPlugin from '@cordclean/plugin-ai'
import { createSandbox, manifestOf } from './helpers.ts'

const sandbox = createSandbox()
let server: Server
let port = 0
let mode: 'ok' | 'http500' | 'invalid-json' | 'bad-shape' | 'slow' = 'ok'
let lastRequest: { url?: string; body?: any } = {}

const OK_BODY = {
  summary: '一切正常',
  observations: ['观察 A'],
  suggestions: [
    {
      title: '清理临时文件',
      reason: '占用较大',
      taskId: 'temp',
      targets: ['temp'],
      estimatedBytes: 1024,
      confidence: 0.8,
      risk: 'safe',
    },
  ],
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      try {
        lastRequest = { url: req.url, body: JSON.parse(raw) }
      } catch {
        lastRequest = { url: req.url, body: raw }
      }
      if (mode === 'http500') {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'internal boom' } }))
        return
      }
      if (mode === 'invalid-json') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: '抱歉，我无法回答。' } }] }))
        return
      }
      if (mode === 'bad-shape') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: 42, suggestions: 'nope' }) } }] }))
        return
      }
      if (mode === 'slow') {
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(OK_BODY) } }] }))
        }, 7000)
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(OK_BODY) } }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  port = typeof address === 'object' && address ? address.port : 0
})

beforeEach(() => {
  mode = 'ok'
  lastRequest = {}
  delete process.env.DEEPSEEK_API_KEY
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(sandbox.root, { recursive: true, force: true })
})

async function boot(config: Record<string, unknown>, name: string) {
  return createApp({
    dataDir: path.join(sandbox.dataDir, name),
    logger: false,
    manifest: manifestOf([{ id: 'ai', plugin: aiPlugin }]),
    settingsOverrides: { plugins: { ai: { enabled: true, config } } },
  })
}

const baseConfig = () => ({
  apiKey: 'k',
  baseUrl: `http://127.0.0.1:${port}`,
  model: 'mock',
  timeoutMs: 10_000,
  retries: 0,
})

describe('AI 接口异常', () => {
  it('接口返回 500 时给出状态码与错误摘要', async () => {
    mode = 'http500'
    const app = await boot(baseConfig(), 'http500')
    try {
      await expect(app.ctx.ai!.analyze()).rejects.toThrow(/HTTP 500/)
    } finally {
      await app.dispose()
    }
  })

  it('模型返回非 JSON 文本时报「不是合法 JSON」', async () => {
    mode = 'invalid-json'
    const app = await boot(baseConfig(), 'invalid')
    try {
      await expect(app.ctx.ai!.analyze()).rejects.toThrow(/不是合法 JSON/)
    } finally {
      await app.dispose()
    }
  })

  it('字段类型异常时做兜底，不抛错', async () => {
    mode = 'bad-shape'
    const app = await boot(baseConfig(), 'shape')
    try {
      const analysis = await app.ctx.ai!.analyze()
      expect(typeof analysis.summary).toBe('string')
      expect(analysis.summary).toBe('42')
      expect(analysis.suggestions).toEqual([])
      expect(analysis.observations).toEqual([])
    } finally {
      await app.dispose()
    }
  })

  it('请求超时后返回可读错误', async () => {
    mode = 'slow'
    // 服务端延迟 7s，客户端 3s 超时，验证超时错误可读且不会无限等待
    const app = await boot({ ...baseConfig(), timeoutMs: 3000 }, 'timeout')
    try {
      await expect(app.ctx.ai!.analyze()).rejects.toThrow(/超时/)
    } finally {
      await app.dispose()
    }
  }, 30_000)

  it('baseUrl 末尾带斜杠也能正确拼接 /chat/completions', async () => {
    const app = await boot({ ...baseConfig(), baseUrl: `http://127.0.0.1:${port}/` }, 'slash')
    try {
      await app.ctx.ai!.analyze()
      expect(lastRequest.url).toBe('/chat/completions')
    } finally {
      await app.dispose()
    }
  })

  it('请求体包含 JSON 输出约束且不含本机路径', async () => {
    const app = await boot(baseConfig(), 'body')
    try {
      await app.ctx.ai!.analyze({ extraContext: '用于论文写作' })
      const body = lastRequest.body
      expect(body.response_format).toEqual({ type: 'json_object' })
      expect(body.messages[0].role).toBe('system')
      expect(body.messages[1].content).not.toContain('C:\\Users')
      expect(body.messages[1].content).not.toContain('C:\\\\Users')
      expect(body.messages[1].content).toContain('用于论文写作')
    } finally {
      await app.dispose()
    }
  })

  it('配置里没有 Key 时回退到环境变量 DEEPSEEK_API_KEY', async () => {
    process.env.DEEPSEEK_API_KEY = 'env-key'
    const app = await boot({ ...baseConfig(), apiKey: '' }, 'env')
    try {
      expect(app.ctx.ai!.configured()).toBe(true)
      const analysis = await app.ctx.ai!.analyze()
      expect(analysis.suggestions).toHaveLength(1)
    } finally {
      await app.dispose()
    }
  })
})
