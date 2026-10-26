import { createServer, type Server } from 'node:http'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type App } from '@cordclean/core'
import aiPlugin from '@cordclean/plugin-ai'
import aiWorkshopPlugin from '@cordclean/plugin-ai-workshop'
import { createSandbox, manifestOf } from './helpers.ts'

const sandbox = createSandbox()
let server: Server
let port = 0
let captured = ''

const GOOD_CODE = `export const name = 'workshop-plugin-demo'
export const kind = 'cleaner'
export const inject = ['cleaner']
export function apply(ctx) {
  ctx.effect(() => ctx.cleaner.define({
    id: 'workshop-demo-task',
    name: '工坊演示任务',
    category: 'apps',
    risk: 'safe',
    targets: [],
    scan(scan) { scan.emit({ path: 'C:/tmp/workshop-demo.log', size: 4 }) },
  }))
}
`

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (req.url?.includes('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'mock-model', context_window: 1_000_000, max_output_tokens: 384_000 }] }))
        return
      }
      captured = raw
      const content = JSON.stringify({ name: 'workshop-plugin-demo', kind: 'cleaner', code: GOOD_CODE, notes: 'ok' })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
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

function boot(workshopConfig: Record<string, unknown> = {}): Promise<App> {
  return createApp({
    dataDir: path.join(sandbox.dataDir, 'data'),
    logger: false,
    loadPlugins: true,
    manifest: manifestOf([
      { id: 'ai', plugin: aiPlugin },
      { id: 'ai-workshop', plugin: aiWorkshopPlugin },
    ]),
    settingsOverrides: {
      plugins: {
        ai: {
          enabled: true,
          config: { apiKey: 'test-key', baseUrl: `http://127.0.0.1:${port}`, model: 'mock-model', stream: false, maxTokens: 65_536 },
        },
        'ai-workshop': { enabled: true, config: workshopConfig },
      },
    },
  })
}

describe('AI 插件工坊独立插件', () => {
  it('作为独立插件加载，未覆盖模型时跟随 AI 清理顾问', async () => {
    const app = await boot()
    try {
      const workshop = app.ctx.plugins.list().find((plugin) => plugin.id === 'ai-workshop')
      expect(workshop?.enabled).toBe(true)
      expect(workshop?.status).toBe('active')

      const service = (app.ctx as any).aiWorkshop
      expect(service).toBeTruthy()
      const status = service.status()
      expect(status.available).toBe(true)
      expect(status.configured).toBe(true)
      expect(status.inheritsModel).toBe(true)
      expect(status.model).toBe('mock-model')

      captured = ''
      const draft = await service.draftPlugin('写一个清理临时文件的插件')
      expect(draft.code).toContain('export function apply(')
      expect(draft.format).toBe('package')
      expect(captured).toContain('"model":"mock-model"')
    } finally {
      await app.dispose()
    }
  })

  it('工坊配置独立生效：模型覆盖、maxTokens、重试与追加提示都进入请求', async () => {
    const app = await boot({
      model: 'mock-override-model',
      maxTokens: 65_536,
      retries: 1,
      systemPromptExtra: '遵循团队插件规范：必须显式声明 inject',
    })
    try {
      const service = (app.ctx as any).aiWorkshop
      const status = service.status()
      expect(status.inheritsModel).toBe(false)
      expect(status.model).toBe('mock-override-model')
      expect(status.maxTokens).toBe(65_536)
      expect(status.retries).toBe(1)

      captured = ''
      const draft = await service.draftPlugin('写一个清理临时文件的插件')
      expect(draft.name).toBe('workshop-plugin-demo')
      expect(captured).toContain('"model":"mock-override-model"')
      expect(captured).toContain('遵循团队插件规范')
      expect(captured).toContain('"max_tokens":65536')
    } finally {
      await app.dispose()
    }
  })

  it('独立插件的 RPC：status / draft 走 ai-workshop 插件', async () => {
    const { createHandlers } = await import('@cordclean/host')
    const app = await boot()
    try {
      const handlers = createHandlers({
        ctx: app.ctx,
        dataDir: app.dataDir,
        version: app.version,
        bootMs: app.bootMs,
        shell: { electron: false, async openPath() {}, async openDataDir() {} } as any,
      })
      const status = await handlers['ai/workshop/status'](undefined)
      expect(status.available).toBe(true)
      const draft = await handlers['ai/workshop/draft']({ requirement: '写一个清理临时文件的插件' })
      expect(draft.format).toBe('package')
      expect(draft.code).toContain('export function apply(')
    } finally {
      await app.dispose()
    }
  })
})
