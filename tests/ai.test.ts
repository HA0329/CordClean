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

const MOCK_REPLY = {
  summary: '测试摘要：临时文件与浏览器缓存是当前可释放空间的主要来源。',
  observations: ['内存占用正常', 'D 盘剩余空间充足'],
  suggestions: [
    {
      title: '清理临时文件',
      reason: '临时目录占用约 55 MB，可以安全清理。',
      taskId: 'temp',
      targets: ['temp'],
      estimatedBytes: 57_000_000,
      confidence: 0.9,
      risk: 'safe',
    },
    {
      title: '清理浏览器缓存',
      reason: '浏览器缓存可自动重建。',
      taskId: 'browser-cache',
      targets: ['浏览器缓存'],
      estimatedBytes: 12_000_000,
      confidence: 0.7,
      risk: 'safe',
    },
  ],
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => {
      capturedBody = Buffer.concat(chunks).toString('utf8')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '```json\n' + JSON.stringify(MOCK_REPLY) + '\n```' } }],
        }),
      )
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

describe('AI 清理顾问', () => {
  it('未配置 Key 时给出明确错误', async () => {
    const app = await boot({ apiKey: '', baseUrl: `http://127.0.0.1:${port}`, model: 'mock' })
    try {
      expect(app.ctx.ai).toBeTruthy()
      expect(app.ctx.ai!.configured()).toBe(false)
      await expect(app.ctx.ai!.analyze()).rejects.toThrow(/API Key/)
    } finally {
      await app.dispose()
    }
  })

  it('解析模型返回的 JSON 并生成结构化建议', async () => {
    const app = await boot({ apiKey: 'test-key', baseUrl: `http://127.0.0.1:${port}`, model: 'mock-model' })
    try {
      expect(app.ctx.ai!.configured()).toBe(true)
      const analysis = await app.ctx.ai!.analyze({ extraContext: '这台机器用于写论文' })
      expect(analysis.model).toBe('mock-model')
      expect(analysis.summary).toContain('测试摘要')
      expect(analysis.observations).toHaveLength(2)
      expect(analysis.suggestions).toHaveLength(2)
      expect(analysis.suggestions[0]).toMatchObject({
        title: '清理临时文件',
        taskId: 'temp',
        risk: 'safe',
        estimatedBytes: 57_000_000,
      })
      expect(app.ctx.ai!.last()?.suggestions).toHaveLength(2)
    } finally {
      await app.dispose()
    }
  })

  it('发送给模型的画像不包含任何真实路径或文件名（隐私约束）', async () => {
    const app = await boot({ apiKey: 'test-key', baseUrl: `http://127.0.0.1:${port}`, model: 'mock-model' })
    try {
      await app.ctx.ai!.analyze()
      expect(capturedBody).not.toContain(sandbox.root.replace(/\\/g, '\\\\'))
      expect(capturedBody).not.toContain('C:\\\\Users')
      expect(capturedBody).not.toContain('a.txt')
      expect(capturedBody).toContain('mock-model')
      expect(capturedBody).toContain('disks')
    } finally {
      await app.dispose()
    }
  })
})
