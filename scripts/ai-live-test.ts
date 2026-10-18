/**
 * AI 插件「真实接口」联调脚本（不会把 API Key 写入任何文件）。
 *
 *   $env:DEEPSEEK_API_KEY='sk-...'; pnpm exec tsx scripts/ai-live-test.ts
 *
 * 覆盖：
 * 1. 三种接口形态（chat / messages / responses）各跑一次完整分析；
 * 2. 推理等级 high 与 off 的行为差异（是否返回思维链、耗时）；
 * 3. 模型列表拉取；
 * 4. 错误路径（不存在的模型）时的报错信息；
 * 5. 断言：建议数量、摘要、usage、思维链等字段齐全。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '@cordclean/core'
import aiPlugin from '@cordclean/plugin-ai'

const key = process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY
if (!key) {
  console.error('请先设置环境变量 DEEPSEEK_API_KEY')
  process.exit(2)
}

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cordclean-ai-live-'))
const failures: string[] = []
const rows: Array<Record<string, unknown>> = []

async function boot(config: Record<string, unknown>) {
  const app = await createApp({
    dataDir: path.join(dataDir, `case-${Math.random().toString(36).slice(2, 8)}`),
    logger: false,
    manifest: [
      {
        id: 'ai',
        name: 'ai',
        description: 'AI 插件',
        category: 'ai',
        defaultEnabled: true,
        async load() {
          return { default: aiPlugin }
        },
      },
    ],
    settingsOverrides: {
      plugins: { ai: { enabled: true, config } },
    },
  })
  // 造一点扫描数据，让画像有内容
  await app.ctx.cleaner.scan({ taskIds: app.ctx.cleaner.list().length ? undefined : undefined })
  return app
}

function check(condition: boolean, message: string) {
  if (!condition) failures.push(message)
}

const cases = [
  { name: 'chat + effort=high', apiShape: 'chat', reasoningEffort: 'high', baseUrl: 'https://api.deepseek.com' },
  { name: 'chat + effort=off', apiShape: 'chat', reasoningEffort: 'off', baseUrl: 'https://api.deepseek.com' },
  { name: 'messages + effort=high', apiShape: 'messages', reasoningEffort: 'high', baseUrl: 'https://api.deepseek.com/anthropic' },
  { name: 'responses + effort=high', apiShape: 'responses', reasoningEffort: 'high', baseUrl: 'https://api.deepseek.com' },
  { name: 'responses + effort=off', apiShape: 'responses', reasoningEffort: 'off', baseUrl: 'https://api.deepseek.com' },
]

console.log('模型列表：')
{
  const app = await boot({ apiShape: 'chat', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' })
  try {
    const result = await app.ctx.ai!.models({ refresh: true })
    console.log(`  source=${result.source} count=${result.models.length}`)
    for (const model of result.models) {
      console.log(`  - ${model.id} (${model.name ?? '-'}) context=${model.contextWindow ?? '-'} effort=[${(model.effortLevels ?? []).join(',')}]`)
    }
    check(result.models.length > 0, '模型列表为空')
  } finally {
    await app.dispose()
  }
}

for (const item of cases) {
  const app = await boot({
    apiShape: item.apiShape,
    reasoningEffort: item.reasoningEffort,
    baseUrl: item.baseUrl,
    model: 'deepseek-flash',
    maxTokens: 4096,
    timeoutMs: 120_000,
    retries: 1,
  })
  try {
    const probe = await app.ctx.ai!.probe()
    const started = Date.now()
    let analysis
    let error: string | undefined
    try {
      analysis = await app.ctx.ai!.analyze({ extraContext: '这台机器主要用于写论文和开发' })
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    const elapsed = Date.now() - started
    if (!analysis) {
      failures.push(`${item.name} 分析失败：${error}`)
      console.log(`\n✗ ${item.name}\n  probe=${probe.ok ? 'ok' : probe.error}\n  analyze 失败：${error}`)
      continue
    }
    rows.push({
      scene: item.name,
      probeMs: probe.latencyMs,
      analyzeMs: elapsed,
      suggestions: analysis.suggestions.length,
      summaryLen: analysis.summary.length,
      reasoningChars: analysis.reasoning?.length ?? 0,
      usage: analysis.usage,
    })
    console.log(`\n✓ ${item.name}`)
    console.log(`  probe: ${probe.ok ? 'ok' : '失败'} / ${probe.latencyMs} ms / HTTP ${probe.status}`)
    console.log(`  analyze: ${elapsed} ms，建议 ${analysis.suggestions.length} 条，思维链 ${analysis.reasoning?.length ?? 0} 字`)
    console.log(`  usage: 输入 ${analysis.usage?.inputTokens ?? '-'} / 输出 ${analysis.usage?.outputTokens ?? '-'} / 思维链 ${analysis.usage?.reasoningTokens ?? '-'}`)
    console.log(`  摘要: ${analysis.summary.slice(0, 70)}…`)
    console.log(`  首条建议: ${analysis.suggestions[0]?.title}（${analysis.suggestions[0]?.risk}，${analysis.suggestions[0]?.reason?.slice(0, 40)}…）`)

    check(probe.ok, `${item.name} probe 失败：${probe.error}`)
    check(analysis.suggestions.length > 0, `${item.name} 没有解析出建议`)
    check(analysis.summary.length > 10, `${item.name} 摘要为空`)
    if (item.reasoningEffort === 'off') {
      check((analysis.usage?.reasoningTokens ?? 0) === 0, `${item.name} 关闭思考后仍有 reasoning token`)
    } else {
      check((analysis.reasoning?.length ?? 0) > 0 || (analysis.usage?.reasoningTokens ?? 0) > 0, `${item.name} 未返回思维链`)
    }
  } finally {
    await app.dispose()
  }
}

/* 错误路径：不存在的模型 */
{
  const app = await boot({ apiShape: 'chat', model: 'deepseek-not-exist', baseUrl: 'https://api.deepseek.com', maxTokens: 128, retries: 0 })
  try {
    let message = ''
    try {
      await app.ctx.ai!.analyze()
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    console.log(`\n错误路径（不存在的模型）：${message.slice(0, 160)}`)
    check(/model|模型|400|invalid/i.test(message), '错误信息没有体现出模型名问题')
  } finally {
    await app.dispose()
  }
}

console.log('\n=== 汇总 ===')
console.table(rows)
if (failures.length) {
  console.log(`\n❌ ${failures.length} 项失败：`)
  for (const failure of failures) console.log('  -', failure)
  process.exitCode = 1
} else {
  console.log('\n✅ 真实接口联调全部通过（三种形态 / 推理等级 / 模型列表 / 错误路径）')
}
rmSync(dataDir, { recursive: true, force: true })
