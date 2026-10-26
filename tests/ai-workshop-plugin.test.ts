import { createServer, type Server } from 'node:http'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type App } from '@cordclean/core'
import aiWorkshopPlugin from '@cordclean/plugin-ai-workshop'
import { createSandbox, manifestOf } from './helpers.ts'

const sandbox = createSandbox()
let server: Server
let port = 0
let captured = ''

const MULTI_ENTRY = `export const name = 'multi-demo'
export const kind = 'cleaner'
export const inject = ['cleaner']
export function apply(ctx) {
  ctx.effect(() => ctx.cleaner.define({
    id: 'multi-demo-task',
    name: '多文件演示任务',
    category: 'apps',
    risk: 'safe',
    targets: [],
    scan(scan) { scan.emit({ path: 'C:/tmp/multi-demo.log', size: 2 }) },
  }))
}
`

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
      if (raw.includes('多文件插件')) {
        const args = {
          name: 'multi-demo',
          kind: 'cleaner',
          code: MULTI_ENTRY,
          notes: '多文件插件包',
          dependencies: {},
          manifest: {
            id: 'multi-demo',
            name: '多文件演示',
            version: '1.0.0',
            description: '多文件插件包演示',
            apiVersion: 2,
            engines: { cordclean: '>=0.5.0 <1.0.0' },
            kind: 'cleaner',
            entry: 'index.mjs',
            client: { mode: 'page', entry: 'client/index.html' },
            permissions: { services: ['cleaner'], fsRoots: [], network: false, subprocess: false },
          },
          files: [
            { path: 'index.mjs', content: MULTI_ENTRY },
            { path: 'client/index.html', content: '<!doctype html><title>multi</title>' },
          ],
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    { id: 'call_1', type: 'function', function: { name: 'emit_plugin', arguments: JSON.stringify(args) } },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        )
        return
      }
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

function boot(configOverrides: Record<string, unknown> = {}): Promise<App> {
  return createApp({
    dataDir: path.join(sandbox.dataDir, 'data'),
    logger: false,
    loadPlugins: true,
    manifest: manifestOf([{ id: 'ai-workshop', plugin: aiWorkshopPlugin }]),
    settingsOverrides: {
      plugins: {
        'ai-workshop': {
          enabled: true,
          config: {
            apiKey: 'workshop-key',
            baseUrl: `http://127.0.0.1:${port}`,
            apiShape: 'chat',
            model: 'mock-model',
            stream: false,
            maxTokens: 65_536,
            retries: 1,
            timeoutMs: 10_000,
            systemPrompt: '遵循团队插件规范：必须显式声明 inject',
            ...configOverrides,
          },
        },
      },
    },
  })
}

describe('AI 插件工坊独立插件 + 独立接口配置', () => {
  it('独立加载，不依赖 AI 清理顾问；status 反映自己的接口配置', async () => {
    const app = await boot()
    try {
      const plugin = app.ctx.plugins.list().find((item) => item.id === 'ai-workshop')
      expect(plugin?.enabled).toBe(true)
      expect(plugin?.status).toBe('active')

      const service = (app.ctx as any).aiWorkshop
      expect(service).toBeTruthy()
      const status = service.status()
      expect(status.available).toBe(true)
      expect(status.configured).toBe(true)
      expect(status.model).toBe('mock-model')
      expect(status.shape).toBe('chat')
      expect(status.baseUrl).toContain(`127.0.0.1:${port}`)
      expect(status.systemPromptExtra).toContain('团队插件规范')
      expect(status.apiKeySource).toBe('config')
    } finally {
      await app.dispose()
    }
  })

  it('使用工坊自己的 API Key / baseUrl / 模型 / 追加提示生成插件包', async () => {
    const app = await boot()
    try {
      captured = ''
      const draft = await (app.ctx as any).aiWorkshop.draftPlugin('写一个清理临时文件的插件')
      expect(draft.code).toContain('export function apply(')
      expect(draft.format).toBe('package')
      expect(captured).toContain('"model":"mock-model"')
      expect(captured).toContain('遵循团队插件规范')
      expect(captured).toContain('"max_tokens":65536')
    } finally {
      await app.dispose()
    }
  })

  it('生成多文件 v2 插件包（manifest + files + client 页面）', async () => {
    const app = await boot()
    try {
      const draft = await (app.ctx as any).aiWorkshop.draftPlugin('生成多文件插件，带 client 页面')
      expect(draft.format).toBe('package')
      expect(draft.files?.length).toBe(2)
      expect(draft.files?.some((file: any) => file.path === 'client/index.html')).toBe(true)
      expect(draft.manifest?.client?.mode).toBe('page')
      expect(draft.manifest?.apiVersion).toBe(2)
      expect(draft.code).toContain('multi-demo-task')
    } finally {
      await app.dispose()
    }
  })

  it('未配置 Key 时 status.configured=false，生成给出明确错误', async () => {
    const previous = process.env.DEEPSEEK_API_KEY
    const previousOpenai = process.env.OPENAI_API_KEY
    delete process.env.DEEPSEEK_API_KEY
    delete process.env.OPENAI_API_KEY
    const app = await boot({ apiKey: '' })
    try {
      const service = (app.ctx as any).aiWorkshop
      expect(service.status().configured).toBe(false)
      expect(service.status().apiKeySource).toBe('none')
      await expect(service.draftPlugin('写一个插件')).rejects.toThrow(/API Key/)
    } finally {
      await app.dispose()
      if (previous !== undefined) process.env.DEEPSEEK_API_KEY = previous
      if (previousOpenai !== undefined) process.env.OPENAI_API_KEY = previousOpenai
    }
  })

  it('RPC：status / models / draft 都走独立插件', async () => {
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
      expect(status.model).toBe('mock-model')
      const models = await handlers['ai/workshop/models']({ refresh: true })
      expect(models.source).toBe('remote')
      expect(models.models.some((item: any) => item.id === 'mock-model')).toBe(true)
      const draft = await handlers['ai/workshop/draft']({ requirement: '写一个清理临时文件的插件' })
      expect(draft.format).toBe('package')
      expect(draft.code).toContain('export function apply(')
    } finally {
      await app.dispose()
    }
  })
})
