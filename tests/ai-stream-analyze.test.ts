import { createServer } from 'node:http'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '@cordclean/core'
import aiPlugin from '@cordclean/plugin-ai'
import { createSandbox, manifestOf } from './helpers.ts'

const sandbox = createSandbox()
let server: any
let port = 0
let captured = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      captured = Buffer.concat(chunks).toString('utf8')
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const json = JSON.stringify({ summary: '流式摘要', observations: [], suggestions: [], rules: [] })
      for (let i = 0; i < json.length; i += 20) {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: json.slice(i, i + 20) } }] }) + '\n\n')
      }
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  port = server.address().port
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

describe('analyze 流式路径', () => {
  it('SSE 增量拼接后产出完整分析，请求带 stream:true', async () => {
    const app = await createApp({
      dataDir: path.join(sandbox.dataDir, 'stream-analyze'),
      logger: false,
      loadPlugins: true,
      manifest: manifestOf([{ id: 'ai', plugin: aiPlugin }]),
      settingsOverrides: { plugins: { ai: { enabled: true, config: { apiKey: 'k', model: 'mock', baseUrl: `http://127.0.0.1:${port}`, stream: true } } } },
    })
    try {
      const analysis = await app.ctx.ai!.analyze()
      expect(analysis.summary).toContain('流式摘要')
      expect(captured).toContain('"stream":true')
    } finally {
      await app.dispose()
    }
  })
})
