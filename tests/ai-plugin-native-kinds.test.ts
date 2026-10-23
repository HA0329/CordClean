import { createServer, type Server } from 'node:http'
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '@cordclean/core'
import aiPlugin from '@cordclean/plugin-ai'
import { createSandbox, manifestOf } from './helpers.ts'

const sandbox = createSandbox()
let server: Server
let port = 0
const requests: string[] = []
let responseIndex = 0

const WIDGET = `export const name = 'ai-widget'
export const kind = 'widget'
export const inject = ['ui']
export const contributes = { overviewCards: [{ id: 'x', title: 'X', type: 'text' }] }
export function apply(ctx) {
  ctx.effect(() => ctx.ui.resolve('ai-widget', 'x', () => ({ text: 'ok' })))
}
`

const DESKTOP = `export const name = 'ai-desktop'
export const kind = 'desktop'
export const inject = ['ui', 'window']
export const contributes = { commands: [{ id: 'open', title: '打开', rpc: 'open' }] }
export function apply(ctx) {
  ctx.effect(() => ctx.ui.command('ai-desktop', 'open', () =>
    ctx.window.open('ai-desktop', { id: 'p', html: '<h1>p</h1>', width: 200, height: 120 })
  ))
}
`

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      if (req.url?.includes('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }))
        return
      }
      requests.push(body)
      const code = responseIndex++ === 0 ? WIDGET : DESKTOP
      const name = responseIndex === 1 ? 'ai-widget' : 'ai-desktop'
      const kind = responseIndex === 1 ? 'widget' : 'desktop'
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ name, kind, code, notes: 'native', dependencies: {} }) } }] }))
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

async function boot() {
  return createApp({
    dataDir: sandbox.dataDir,
    logger: false,
    loadPlugins: true,
    manifest: manifestOf([{ id: 'ai', plugin: aiPlugin }]),
    settingsOverrides: {
      plugins: {
        ai: {
          enabled: true,
          config: { apiKey: 'test-key', baseUrl: `http://127.0.0.1:${port}`, model: 'mock-model', stream: false, maxTokens: 65_536 },
        },
      },
    },
  })
}

describe('AI 插件工坊原生通用插件生成', () => {
  it('提示词包含原生契约与 desktop/window 能力，并保留 kind', async () => {
    const app = await boot()
    try {
      const widget = await app.ctx.ai!.draftPlugin!('写一个通用 widget')
      expect(widget.mode).toBe('native')
      expect(widget.kind).toBe('widget')
      expect(widget.code).toContain('export function apply(')
      expect(widget.code).not.toContain('export default {')

      const firstRequest = requests[0]
      expect(firstRequest).toContain('原生 Cordis')
      expect(firstRequest).toContain('ctx.ui.emit')
      expect(firstRequest).toContain('ctx.window')
      expect(firstRequest).toContain('desktop')
      expect(firstRequest).toContain('overviewCards')
      expect(firstRequest).toContain('CordClean 项目上下文')
      expect(firstRequest).toContain('packages/core')
      expect(firstRequest).toContain('内置清理任务')

      const desktop = await app.ctx.ai!.draftPlugin!('写一个桌宠插件')
      expect(desktop.mode).toBe('native')
      expect(desktop.kind).toBe('desktop')
      expect(desktop.code).toContain('ctx.window.open')
      expect(requests.length).toBeGreaterThanOrEqual(2)
    } finally {
      await app.dispose()
    }
  })
})
