import { createServer, type Server } from 'node:http'
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type App } from '@cordclean/core'
import aiPlugin from '@cordclean/plugin-ai'
import { createSandbox, manifestOf } from './helpers.ts'

const sandbox = createSandbox()
let server: Server
let port = 0
let capturedBody = ''
let modelRequests = 0

const MOCK_REPLY = {
  summary: '模型元数据测试摘要',
  observations: [],
  suggestions: [],
  ruleSuggestions: [],
  selection: [],
  rootSuggestions: [],
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      if (req.url?.includes('/models')) {
        modelRequests++
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            object: 'list',
            data: [
              {
                id: 'deepseek-flash',
                object: 'model',
                owned_by: 'deepseek',
                name: 'DeepSeek-V4.1-Flash-1017',
                context_window: 1_048_576,
                max_output_tokens: 2000,
                input_modalities: ['text', 'image'],
              },
            ],
          }),
        )
        return
      }
      capturedBody = body
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(MOCK_REPLY) } }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  port = typeof address === 'object' && address ? address.port : 0
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(sandbox.root, { recursive: true, force: true })
})

async function boot(config: Record<string, unknown>): Promise<App> {
  return createApp({
    dataDir: sandbox.dataDir,
    logger: false,
    loadPlugins: true,
    manifest: manifestOf([{ id: 'ai', plugin: aiPlugin }]),
    settingsOverrides: { plugins: { ai: { enabled: true, config } } },
  })
}

describe('模型元数据与未来变化兼容', () => {
  it('/models 的显示名与能力信息会成为界面/请求依据', async () => {
    const app = await boot({
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${port}`,
      model: 'deepseek-flash',
      stream: false,
      maxTokens: 3000,
    })
    try {
      const models = await app.ctx.ai!.models({ refresh: true })
      expect(modelRequests).toBeGreaterThan(0)
      expect(models.models[0]).toMatchObject({
        id: 'deepseek-flash',
        name: 'DeepSeek-V4.1-Flash-1017',
        contextWindow: 1_048_576,
        maxOutputTokens: 2000,
      })
      await app.ctx.ai!.analyze()
      // 用户配置 3000，但 /models 声明该模型上限 2000：请求必须收敛到能力上限，
      // 而不是像旧实现那样偷偷抬到 32768
      expect(JSON.parse(capturedBody).max_tokens).toBe(2000)
    } finally {
      await app.dispose()
    }
  })

  it('未在 /models 中的自定义模型名原样保留', async () => {
    const app = await boot({
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${port}`,
      model: 'my-custom-model',
      stream: false,
      maxTokens: 3000,
    })
    try {
      await app.ctx.ai!.analyze()
      expect(JSON.parse(capturedBody).model).toBe('my-custom-model')
    } finally {
      await app.dispose()
    }
  })
})
