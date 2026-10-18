import path from 'node:path'
import { rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp, type App } from '@cordclean/core'
import { createSandbox, manifestOf } from './helpers.ts'

const sandbox = createSandbox()
const apps: App[] = []

afterAll(async () => {
  for (const app of apps) await app.dispose()
  rmSync(sandbox.root, { recursive: true, force: true })
})

async function boot(name: string, privacy?: { onlineAi: boolean }): Promise<App> {
  const app = await createApp({
    dataDir: path.join(sandbox.dataDir, name),
    logger: false,
    manifest: manifestOf([]),
    settingsOverrides: privacy ? { privacy } : {},
  })
  apps.push(app)
  return app
}

describe('外发出口（不变量 8）', () => {
  it('默认放行并记录请求、脱敏预览、统计用量', async () => {
    const app = await boot('egress-open')
    const gate = app.ctx.egress.check({ purpose: 'analyze', url: 'https://api.deepseek.com/chat/completions', body: { apiKey: 'sk-secret', messages: [] } })
    expect(gate.allowed).toBe(true)
    expect(app.ctx.egress.stats()).toMatchObject({ requests: 1 })
    const [record] = app.ctx.egress.preview()
    expect(record.purpose).toBe('analyze')
    expect(record.preview).not.toContain('sk-secret')
    expect(record.preview).toContain('<redacted>')

    app.ctx.egress.recordUsage({ input: 10, output: 20 })
    expect(app.ctx.egress.stats().tokens).toBe(30)
    app.ctx.egress.reset()
    expect(app.ctx.egress.stats()).toMatchObject({ requests: 0, bytes: 0, tokens: 0 })
  })

  it('隐私开关关闭时拒绝外发并留痕', async () => {
    const app = await boot('egress-closed', { onlineAi: false })
    const gate = app.ctx.egress.check({ purpose: 'analyze', url: 'https://api.deepseek.com/chat/completions', body: {} })
    expect(gate.allowed).toBe(false)
    expect(gate.reason).toContain('在线 AI')
    expect(app.ctx.egress.stats().requests).toBe(0)
    expect(app.ctx.egress.preview()[0].blocked).toContain('在线 AI')
  })
})
