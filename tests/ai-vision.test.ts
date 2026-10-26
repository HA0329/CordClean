import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '@cordclean/core'
import aiPlugin from '@cordclean/plugin-ai'
import { buildRequest } from '../packages/plugins/ai/src/adapters.ts'
import { normalizeConfig } from '../packages/plugins/ai/src/config.ts'
import { manifestOf } from './helpers.ts'

const image = { mime: 'image/png', data: 'AAAA' }
const root = mkdtempSync(path.join(os.tmpdir(), 'cordclean-ai-vision-'))
let server: Server
let port = 0
let capturedBody = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => {
      capturedBody = Buffer.concat(chunks).toString('utf8')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: JSON.stringify({ summary: '看到了截图', observations: [], suggestions: [], rules: [] }),
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

describe('Vision 图片输入', () => {
  it('chat 形态使用 image_url 内容块', () => {
    const req = buildRequest(normalizeConfig({ apiKey: 'k', apiShape: 'chat' }), 'k', 's', 'u', undefined, image)
    const content = (req.body as any).messages.at(-1).content
    expect(content[1]).toMatchObject({ type: 'image_url' })
    expect(content[1].image_url.url).toContain('data:image/png;base64,')
  })

  it('messages 形态使用 image 内容块', () => {
    const req = buildRequest(normalizeConfig({ apiKey: 'k', apiShape: 'messages' }), 'k', 's', 'u', undefined, image)
    const content = (req.body as any).messages.at(-1).content
    expect(content[1]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png' } })
  })

  it('responses 形态使用 input_image 内容块（官方文档支持）', () => {
    const req = buildRequest(normalizeConfig({ apiKey: 'k', apiShape: 'responses' }), 'k', 's', 'u', undefined, image)
    const input = (req.body as any).input
    expect(Array.isArray(input)).toBe(true)
    expect(input[0].content[1]).toMatchObject({ type: 'input_image', detail: 'auto' })
    expect(input[0].content[1].image_url).toContain('data:image/png;base64,')
  })

  it('analyze() 真正把截图与补充说明发给模型（服务层回归）', async () => {
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
              apiKey: 'k',
              model: 'deepseek-flash',
              baseUrl: `http://127.0.0.1:${port}`,
              stream: false,
            },
          },
        },
      },
    })
    try {
      capturedBody = ''
      const analysis = await app.ctx.ai!.analyze({
        image: { mime: 'image/png', data: 'iVBORw0KGgo=' },
        extraContext: '我的补充说明：保留剪辑素材缓存',
      })
      expect(analysis.summary).toContain('看到了截图')
      expect(capturedBody).toContain('data:image/png;base64,iVBORw0KGgo=')
      expect(capturedBody).toContain('image_url')
      expect(capturedBody).toContain('我的补充说明：保留剪辑素材缓存')
      expect(capturedBody).toContain('附件截图')
    } finally {
      await app.dispose()
    }
  })
})
