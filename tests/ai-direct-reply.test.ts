import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '@cordclean/core'
import aiPlugin from '@cordclean/plugin-ai'
import { manifestOf } from './helpers.ts'

const root = mkdtempSync(path.join(os.tmpdir(), 'cordclean-ai-direct-'))
let server: Server
let port = 0
let captured = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => {
      captured = Buffer.concat(chunks).toString('utf8')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: '确认收到：已看到补充说明，本次不输出清理分析。',
              },
            },
          ],
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
  rmSync(root, { recursive: true, force: true })
})

describe('补充说明中的明确指令', () => {
  it('用户要求「不要分析，看到补充说明回复」时走直答路径，不再输出清理建议', async () => {
    const app = await createApp({
      dataDir: path.join(root, 'data'),
      logger: false,
      loadPlugins: true,
      manifest: manifestOf([{ id: 'ai', plugin: aiPlugin }]),
      settingsOverrides: {
        plugins: {
          ai: {
            enabled: true,
            config: {
              apiKey: 'test-key',
              baseUrl: `http://127.0.0.1:${port}`,
              model: 'mock-model',
              stream: false,
            },
          },
        },
      },
    })
    try {
      const analysis = await app.ctx.ai!.analyze({
        extraContext: '此次分析不要分析，看到补充说明回复',
      })
      expect(analysis.summary).toContain('确认收到')
      expect(analysis.summary).toContain('不输出清理分析')
      expect(analysis.suggestions).toEqual([])
      expect(analysis.observations).toEqual([])
      // 直答路径不应该再拼接本机画像/清理 JSON 约束
      expect(captured).toContain('唯一指令')
      expect(captured).not.toContain('本机画像如下')
    } finally {
      await app.dispose()
    }
  })
})
