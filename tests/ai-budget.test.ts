import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createApp } from '@cordclean/core'
import aiPlugin from '@cordclean/plugin-ai'
import { estimateTokens } from '../packages/plugins/ai/src/service.ts'
import { createSandbox, manifestOf } from './helpers.ts'

const sandbox = createSandbox()

describe('AI token 预算', () => {
  it('估算 token 并暴露模型上限', async () => {
    expect(estimateTokens('abcdefg')).toBe(2)
    const app = await createApp({
      dataDir: path.join(sandbox.dataDir, 'budget'),
      logger: false,
      loadPlugins: true,
      manifest: manifestOf([{ id: 'ai', plugin: aiPlugin }]),
      settingsOverrides: { plugins: { ai: { enabled: true, config: { apiKey: 'test', model: 'deepseek-flash', baseUrl: 'http://127.0.0.1:1' } } } },
    })
    try {
      const status = app.ctx.ai!.status()
      expect(status.contextWindow).toBe(1_048_576)
      expect(status.maxOutputTokens).toBe(393_216)
    } finally {
      await app.dispose()
    }
  })
})
