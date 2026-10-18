/**
 * 真实 Key 冒烟：AI 分析 → 选择/规则建议 → 插件草稿 → 静态校验。
 * 只读取环境变量，绝不把 Key 写入磁盘。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '@cordclean/core'
import aiPlugin from '@cordclean/plugin-ai'
import { validatePluginCode } from '../packages/host/src/plugin-workshop.ts'

const key = process.env.DEEPSEEK_API_KEY
if (!key) {
  console.error('缺少 DEEPSEEK_API_KEY')
  process.exit(1)
}
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cordclean-ai-smoke-'))
const manifest = [{ id: 'ai', name: 'AI', load: async () => ({ default: aiPlugin }) }]
const app = await createApp({
  dataDir,
  logger: false,
  loadPlugins: true,
  manifest,
  settingsOverrides: {
    plugins: { ai: { enabled: true, config: { apiKey: key, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', contextProviders: [], maxOutputTokens: 8192, reasoningEffort: 'low' } } },
  },
})

try {
  const status = app.ctx.ai?.status()
  console.log('model=', status?.model, 'shape=', status?.shape, 'providers=', status?.contextAvailable?.length)

  const started = Date.now()
  const analysis = await app.ctx.ai.analyze({ extraContext: '这是一次自动冒烟测试，只分析不建议真实删除。' })
  console.log('analyze ok', Date.now() - started, 'ms')
  console.log('summary:', analysis.summary.slice(0, 120))
  console.log('suggestions:', analysis.suggestions.length, 'rules:', analysis.ruleSuggestions?.length, 'selection:', analysis.selection?.length ?? 0, 'roots:', analysis.rootSuggestions?.length ?? 0)
  if (analysis.ruleSuggestions?.length) {
    const rule = analysis.ruleSuggestions[0]
    console.log('rule sample:', rule.name, rule.target.type, rule.target.path ?? rule.target.base)
  }

  let draft
  try {
    draft = await app.ctx.ai.draftPlugin('写一个最小插件：注册一个空任务 demo-empty，scan 不 emit 任何项')
  } catch (error) {
    console.log('draft failed:', error instanceof Error ? error.message : String(error))
  }
  console.log('draft:', draft.name, 'code chars:', draft.code.length)
  const validation = validatePluginCode(draft.code)
  console.log('validation ok=', validation.ok, 'errors=', validation.errors.join(' | '))
  console.log('code head:', draft.code.split('\n').slice(0, 6).join('\n'))
} finally {
  await app.dispose()
  rmSync(dataDir, { recursive: true, force: true })
}
