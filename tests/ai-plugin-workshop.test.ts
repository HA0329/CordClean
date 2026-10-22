import { createServer, type Server } from 'node:http'
import { writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type App } from '@cordclean/core'
import aiPlugin from '@cordclean/plugin-ai'
import { createSandbox, manifestOf } from './helpers.ts'

const sandbox = createSandbox()
let server: Server
let port = 0
let chatRequests = 0

const GOOD_CODE = `import fs from 'node:fs'
import path from 'node:path'

export default {
  name: 'workshop-demo',
  version: '1.0.0',
  description: '演示：清理 %TEMP% 下的临时文件',
  capabilities: { fsRoots: ['%TEMP%'] },
  Config(raw) {
    return { maxFiles: Number(raw.maxFiles ?? 20) }
  },
  setup(ctx, config) {
    const base = String(ctx.system.env.get('TEMP') || '')
    ctx.cleaner.define({
      id: 'workshop-demo-task',
      name: '演示清理任务',
      category: 'apps',
      risk: 'safe',
      defaultSelected: false,
      targets: [base],
      scan(scan) {
        for (const name of fs.readdirSync(base)) {
          const full = path.join(base, name)
          try {
            const stat = fs.statSync(full)
            if (stat.isFile()) scan.emit({ path: full, kind: 'file', size: stat.size })
          } catch {}
        }
      },
    })
  },
}
`

const BAD_CODE = `import { defineCleanerPlugin } from '@cordisjs/plugin-cleaner'

export default defineCleanerPlugin({
  name: 'bad-draft',
  setup() {},
})
`

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      if (req.url?.includes('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'mock-model', context_window: 1_000_000, max_output_tokens: 384_000 }] }))
        return
      }
      chatRequests++
      // 第一次故意返回 AI 常见的错误草稿，第二次返回合规草稿，验证工坊会自动带错误重试
      const content = chatRequests === 1
        ? JSON.stringify({ name: 'bad-draft', code: BAD_CODE, notes: 'bad' })
        : JSON.stringify({ name: 'workshop-demo', code: GOOD_CODE, notes: 'ok' })
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

async function boot(): Promise<App> {
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

describe('AI 插件工坊生成链路', () => {
  it('第一次生成幻觉 import 时自动带错误重试，最终返回可安装代码', async () => {
    const app = await boot()
    try {
      const ai = app.ctx.ai
      if (!ai?.draftPlugin) throw new Error('AI 插件未就绪')
      const draft = await ai.draftPlugin('写一个清理临时文件的插件')
      expect(chatRequests).toBeGreaterThanOrEqual(2)
      expect(draft.code).toContain('export default {')
      expect(draft.code).not.toContain('@cordisjs')
      expect(draft.code).not.toContain('defineCleanerPlugin')
      expect(draft.code).toContain('capabilities')
      expect(draft.code).toContain('scan(scan)')
      expect(draft.name).toBe('workshop-demo')

      // 真实性验证：草稿不只“看起来对”，而是能被外部插件加载器真正安装
      const file = path.join(sandbox.root, 'workshop-demo.mjs')
      writeFileSync(file, draft.code, 'utf8')
      await app.ctx.plugins.installExternal(file)
      const installed = app.ctx.plugins.list().find((item) => item.id === 'external:workshop-demo')
      expect(installed?.enabled).toBe(true)
      expect(app.ctx.cleaner.list().some((task) => task.id === 'workshop-demo-task')).toBe(true)
      await app.ctx.plugins.uninstallExternal('external:workshop-demo')
    } finally {
      await app.dispose()
    }
  })
})
