import { createServer, type Server } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '@cordclean/core'
import aiPlugin from '@cordclean/plugin-ai'
import { createSandbox, manifestOf } from './helpers.ts'

const sandbox = createSandbox()
let server: Server
let port = 0
let capturedBody = ''
let reply: unknown = { summary: '无候选', suggestions: [], selection: [] }

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => {
      capturedBody = Buffer.concat(chunks).toString('utf8')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: '```json\n' + JSON.stringify(reply) + '\n```' } }] }))
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

describe('AI 选择清理项', () => {
  it('只接受候选列表内的 itemId，并统计选中字节', async () => {
    const app = await createApp({
      dataDir: path.join(sandbox.dataDir, 'ai-selection'),
      logger: false,
      loadPlugins: true,
      manifest: manifestOf([{ id: 'ai', plugin: aiPlugin }]),
      settingsOverrides: { plugins: { ai: { enabled: true, config: { apiKey: 'test-key', baseUrl: `http://127.0.0.1:${port}`, model: 'mock' } } } },
    })
    try {
      const dir = path.join(sandbox.root, 'big')
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, 'a.bin'), Buffer.alloc(3_000_000, 1))
      writeFileSync(path.join(dir, 'b.bin'), Buffer.alloc(1_000_000, 2))
      app.ctx.pathPolicy.addRoot(dir)
      app.ctx.cleaner.define({
        id: 'big-task',
        name: '大文件测试',
        category: 'system',
        risk: 'safe',
        icon: '🧪',
        defaultSelected: true,
        targets: [dir],
        scan(scan) {
          scan.emit({ path: path.join(dir, 'a.bin'), kind: 'file', size: 3_000_000 })
          scan.emit({ path: path.join(dir, 'b.bin'), kind: 'file', size: 1_000_000 })
        },
      })
      const report = await app.ctx.cleaner.scan({ taskIds: ['big-task'] })
      const valid = report.items[0]!

      reply = {
        summary: '测试选择',
        suggestions: [],
        selection: [
          { itemId: valid.id, reason: '体积最大且可重建' },
          { itemId: 'item-does-not-exist', reason: '虚构的 id' },
          { itemId: valid.id, reason: '' },
        ],
      }

      const analysis = await app.ctx.ai!.analyze({ taskIds: ['big-task'] })
      expect(analysis.selection).toHaveLength(1)
      expect(analysis.selection![0]).toMatchObject({ itemId: valid.id, reason: '体积最大且可重建' })
      expect(analysis.selectionSummary?.count).toBe(1)
      expect(analysis.selectionSummary?.bytes).toBe(3_000_000)

      expect(capturedBody).toContain(valid.id)
      expect(capturedBody).not.toContain(sandbox.root.replace(/\\/g, '\\\\'))
      expect(capturedBody).not.toContain('a.bin')
    } finally {
      await app.dispose()
    }
  })
})
