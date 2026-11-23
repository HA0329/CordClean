/**
 * 真实模型 + 真实插件全链路验证（临时数据目录；Key 只从环境变量读取，绝不落盘）。
 * 运行：$env:AI_KEY=... ; pnpm exec tsx .run/ai-real-e2e.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '@cordclean/core'

const KEY = String(process.env.AI_KEY ?? '').trim()
if (!KEY) {
  console.error('缺少环境变量 AI_KEY')
  process.exit(2)
}
const BASE_URL = 'https://api.deepseek.com'
const MODEL = String(process.env.AI_MODEL ?? 'deepseek-flash')
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cc-ai-real-'))
const fixture = mkdtempSync(path.join(os.tmpdir(), 'cc-ai-fixture-'))
const results: Array<Record<string, unknown>> = []
const record = (name: string, ok: boolean, detail: unknown) => {
  results.push({ name, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}: ${JSON.stringify(detail).slice(0, 600)}`)
}
const now = () => Date.now()
const codeOf = (error: unknown): string => {
  const e = error as { code?: unknown; message?: unknown; name?: unknown }
  return String(e?.code ?? e?.name ?? 'unknown')
}

// 真实扫描上下文：3 个 2MB 文件 + 空目录
for (const name of ['a.bin', 'b.bin', 'c.bin']) writeFileSync(path.join(fixture, name), Buffer.alloc(2 * 1024 * 1024, 7))
mkdirSync(path.join(fixture, 'empty'), { recursive: true })

const app = await createApp({
  dataDir,
  logLevel: 'error',
  settingsOverrides: { analysis: { roots: [fixture] }, scan: { largeFileThreshold: 1024 * 1024 } },
})
const ctx = app.ctx as any
const aiConfig = (patch: Record<string, unknown>) => ({
  apiKey: KEY,
  baseUrl: BASE_URL,
  apiShape: 'chat',
  model: MODEL,
  maxTokens: 4096,
  timeoutMs: 120_000,
  retries: 0,
  ...patch,
})

try {
  // 自定义任务 + 真实扫描，作为 AI 分析上下文
  ctx.cleaner.define({
    id: 'sim-fixture',
    name: '模拟大文件',
    description: 'fixture',
    category: 'temp',
    risk: 'safe',
    targets: [fixture],
    async scan(scan: any) {
      for (const file of await fsp.readdir(fixture)) {
        const full = path.join(fixture, file)
        const stat = await fsp.stat(full).catch(() => undefined)
        if (stat?.isFile()) scan.emit({ path: full, kind: 'file', size: stat.size, risk: 'safe', defaultSelected: false, title: file })
      }
    },
  })
  const scan = await ctx.cleaner.scan({ taskIds: ['sim-fixture'] })
  console.log(`fixture scan: items=${scan.items.length} bytes=${scan.stats.bytes}`)

  // 1) 配置真实 Key → probe 连通
  await ctx.plugins.enable('ai')
  await ctx.plugins.updateConfig('ai', aiConfig({}))
  await new Promise((r) => setTimeout(r, 300))
  let ai = ctx.ai
  const t0 = now()
  const probe = await ai.probe()
  record('AI advisor probe (真实 Key)', probe.ok === true, { ok: probe.ok, status: probe.status, elapsedMs: now() - t0, model: probe.model })

  // 2) 真实分析
  const t1 = now()
  const analysis = await ai.analyze({ extraContext: '本次为真实模型验收，请给出最多 2 条建议。' })
  record('AI advisor analyze (真实模型)', Boolean(analysis?.summary), {
    elapsedMs: now() - t1,
    summary: String(analysis?.summary ?? '').slice(0, 160),
    suggestions: analysis?.suggestions?.length ?? 0,
    incomplete: analysis?.incomplete ?? false,
  })

  // 3) 失败态：错误 Key
  await ctx.plugins.updateConfig('ai', aiConfig({ apiKey: 'sk-invalid-key-for-test', retries: 0 }))
  await new Promise((r) => setTimeout(r, 300))
  ai = ctx.ai
  const t2 = now()
  const badKey = await ai.analyze({}).then(
    () => ({ rejected: false, code: 'unexpected-success' }),
    (error: unknown) => ({ rejected: true, code: codeOf(error), message: String((error as any)?.message ?? '').slice(0, 120) }),
  )
  record('AI 错误 Key → AUTH', badKey.rejected && badKey.code === 'AUTH', { ...badKey, elapsedMs: now() - t2 })

  // 4) 失败态：断网/坏地址
  await ctx.plugins.updateConfig('ai', aiConfig({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 8000 }))
  await new Promise((r) => setTimeout(r, 300))
  ai = ctx.ai
  const t3 = now()
  const offline = await ai.analyze({}).then(
    () => ({ rejected: false, code: 'unexpected-success' }),
    (error: unknown) => ({ rejected: true, code: codeOf(error), message: String((error as any)?.message ?? '').slice(0, 120) }),
  )
  record('AI 断网/坏 baseUrl → NETWORK/TIMEOUT', offline.rejected && ['NETWORK', 'TIMEOUT'].includes(offline.code), { ...offline, elapsedMs: now() - t3 })

  // 5) 失败态：取消
  await ctx.plugins.updateConfig('ai', aiConfig({}))
  await new Promise((r) => setTimeout(r, 300))
  ai = ctx.ai
  const cancelPromise = ai.analyze({ extraContext: '请不要分析，先逐条列出你能看到的所有清理任务，再给出建议。' }).then(
    () => ({ rejected: false, code: 'unexpected-success' }),
    (error: unknown) => ({ rejected: true, code: codeOf(error), message: String((error as any)?.message ?? '').slice(0, 120) }),
  )
  await new Promise((r) => setTimeout(r, 800))
  ai.cancelAnalyze?.()
  const cancelled = await cancelPromise
  record('AI 分析取消 → CANCELLED', cancelled.rejected && cancelled.code === 'CANCELLED', cancelled)

  // 6a) 真实模型请求级截断（绕过 normalizeConfig 的 <=2048 自动抬升，直接发 max_tokens=4）
  const pluginAi: any = await import('../packages/plugins/ai/src/index.ts')
  const rawBase = pluginAi.normalizeConfig({ apiKey: KEY, baseUrl: BASE_URL, apiShape: 'chat', model: MODEL, stream: false, timeoutMs: 30_000, retries: 0 })
  const rawReq = pluginAi.buildRequest({ ...rawBase, maxTokens: 4 }, KEY, '只输出 JSON：{"a":1}', '请输出一个 JSON 对象，字段 a 的值必须是一段至少 200 字的说明。')
  const tRaw = now()
  const rawRes = await pluginAi.requestJson(rawReq.url, { headers: rawReq.headers, body: rawReq.body, timeoutMs: 30_000, retries: 0 })
  const rawParsed = pluginAi.parseResponse({ ...rawBase, maxTokens: 4 }, rawRes.payload)
  record('真实模型截断（max_tokens=4）→ finish_reason=length', rawParsed.truncated === true, {
    elapsedMs: now() - tRaw,
    finish: rawParsed.finish,
    truncated: rawParsed.truncated,
    textLength: String(rawParsed.text ?? '').length,
    status: rawRes.status,
  })

  // 6b) 应用层：maxTokens=2049（高于自动抬升阈值）真实分析，允许成功或明确截断错误
  await ctx.plugins.updateConfig('ai', aiConfig({ maxTokens: 2049 }))
  await new Promise((r) => setTimeout(r, 300))
  ai = ctx.ai
  const lowBudget = await ai.analyze({ extraContext: '请给最多 2 条建议。' }).then(
    (r: any) => ({ rejected: false, code: 'success', suggestions: r?.suggestions?.length ?? 0, incomplete: r?.incomplete ?? false }),
    (error: unknown) => ({ rejected: true, code: codeOf(error), message: String((error as any)?.message ?? '').slice(0, 160) }),
  )
  record('AI 低 maxTokens(2049) 边界：成功或明确截断错误', lowBudget.rejected ? ['INVALID_RESPONSE', 'TIMEOUT', 'NETWORK'].includes(lowBudget.code) : true, lowBudget)

  // 6c) 真实边界：deepseek-v4-pro 不支持图片 → 明确错误（不产生网络结果）
  await ctx.plugins.updateConfig('ai', aiConfig({ model: 'deepseek-v4-pro', maxTokens: 4096 }))
  await new Promise((r) => setTimeout(r, 300))
  ai = ctx.ai
  const vision = await ai.analyze({ image: { mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' } }).then(
    () => ({ rejected: false, code: 'unexpected-success' }),
    (error: unknown) => ({ rejected: true, code: codeOf(error), message: String((error as any)?.message ?? '').slice(0, 160) }),
  )
  record('AI 不支持视觉的模型 + 图片 → 明确错误', vision.rejected === true, vision)

  // 7) AI 插件工坊：真实生成 v2 插件包草稿
  await ctx.plugins.enable('ai-workshop')
  await ctx.plugins.updateConfig('ai-workshop', {
    apiKey: KEY,
    baseUrl: BASE_URL,
    apiShape: 'chat',
    model: MODEL,
    maxTokens: 32_768,
    timeoutMs: 300_000,
    retries: 1,
  })
  await new Promise((r) => setTimeout(r, 300))
  const workshop = ctx.aiWorkshop
  const t4 = now()
  const draft = await workshop.draftPlugin(
    '写一个只扫描、不删除的 v2 插件包：扫描用户临时目录（TEMP）中大于 1MB 的文件并报告；必须零依赖、入口 index.mjs、导出名为 temp-large-files 的 task，用 ctx.cleaner.define 注册，不要子进程/网络/自定义删除。',
  )
  record('工坊真实生成 v2 草稿', Boolean(draft?.code || draft?.files?.length), {
    elapsedMs: now() - t4,
    name: draft?.name,
    format: draft?.format,
    files: (draft?.files ?? []).map((f: any) => f.path),
    codeLength: String(draft?.code ?? '').length,
    notes: String(draft?.notes ?? '').slice(0, 120),
  })

  // 8) 草稿落盘 → inspectPackage → installPackage → enable → scan → uninstall
  const pkgDir = path.join(dataDir, 'generated-plugin-source')
  mkdirSync(pkgDir, { recursive: true })
  const files = Array.isArray(draft?.files) && draft.files.length ? draft.files : [{ path: 'index.mjs', content: String(draft?.code ?? '') }]
  for (const file of files) {
    const target = path.join(pkgDir, String(file.path).replace(/^[/\\]+/, ''))
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, String(file.content ?? ''), 'utf8')
  }
  if (draft?.manifest) {
    if (!files.some((f: any) => String(f.path).replace(/\\/g, '/') === 'plugin.json')) {
      writeFileSync(path.join(pkgDir, 'plugin.json'), JSON.stringify(draft.manifest, null, 2), 'utf8')
    }
  }
  let installedId = ''
  try {
    const review = await ctx.plugins.inspectPackage?.(pkgDir)
    record('工坊草稿 inspectPackage 通过', Boolean(review && (review.errors?.length ?? 0) === 0), {
      errors: (review?.errors ?? []).map((e: any) => e.message),
      warnings: (review?.warnings ?? []).length,
    })
    const installed = await ctx.plugins.installPackage?.(pkgDir, { enable: false })
    installedId = String(installed?.id ?? '')
    record('工坊草稿 installPackage 成功', Boolean(installedId), { installedId, warnings: installed?.warnings?.length ?? 0 })
    await ctx.plugins.enable(installedId)
    await new Promise((r) => setTimeout(r, 300))
    const plugin = ctx.plugins.list().find((p: any) => p.id === installedId)
    record('生成插件 enable/active + 任务注册', Boolean(plugin && plugin.enabled), {
      status: plugin?.status,
      tasks: (plugin?.tasks ?? []).map((t: any) => t.id),
      configurable: plugin?.configurable,
    })
    const taskIds = (plugin?.tasks ?? []).map((t: any) => t.id)
    if (taskIds.length) {
      const run = await ctx.cleaner.scan({ taskIds })
      record('生成插件真实运行扫描', true, {
        taskIds,
        items: run.items.length,
        errors: run.errors.length,
        elapsedMs: run.elapsedMs,
      })
    } else {
      record('生成插件真实运行扫描', false, { reason: '生成插件未注册清理任务' })
    }
  } catch (error) {
    record('工坊草稿安装/运行链路', false, { code: codeOf(error), message: String((error as any)?.message ?? '').slice(0, 240) })
  } finally {
    if (installedId) {
      await ctx.plugins.uninstallPackage?.(installedId).catch(() => undefined)
      const gone = !ctx.plugins.list().some((p: any) => p.id === installedId)
      record('生成插件卸载并消失', gone, { installedId })
    }
  }

  // 9) 工坊失败态：空需求 / 非法模型
  const emptyReq = await workshop.draftPlugin('   ').then(
    () => ({ rejected: false, code: 'unexpected-success' }),
    (error: unknown) => ({ rejected: true, code: codeOf(error), message: String((error as any)?.message ?? '').slice(0, 120) }),
  )
  record('工坊空需求 → BAD_REQUEST', emptyReq.rejected && emptyReq.code === 'BAD_REQUEST', emptyReq)

  await ctx.plugins.updateConfig('ai-workshop', {
    apiKey: KEY,
    baseUrl: BASE_URL,
    apiShape: 'chat',
    model: 'no-such-model-xyz',
    maxTokens: 1024,
    timeoutMs: 30_000,
    retries: 0,
  })
  await new Promise((r) => setTimeout(r, 300))
  const badModel = await ctx.aiWorkshop.draftPlugin('写一个只扫描空目录的插件').then(
    () => ({ rejected: false, code: 'unexpected-success' }),
    (error: unknown) => ({ rejected: true, code: codeOf(error), message: String((error as any)?.message ?? '').slice(0, 160) }),
  )
  record('工坊非法模型 → 可读错误', badModel.rejected && ['BAD_REQUEST', 'AUTH', 'INVALID_RESPONSE', 'HTTP', 'NETWORK', 'SERVER'].includes(badModel.code), badModel)
} catch (error) {
  record('未捕获异常', false, { code: codeOf(error), message: String((error as any)?.message ?? '').slice(0, 300) })
} finally {
  await app.dispose()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

const summary = {
  total: results.length,
  passed: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).map((r) => r.name),
  results,
}
writeFileSync(path.join(process.cwd(), '.run', 'ai-real-result.json'), JSON.stringify(summary, null, 2), 'utf8')
console.log(`\n===== 真实模型验证汇总：${summary.passed}/${summary.total} 通过 =====`)
if (summary.failed.length) console.log('FAILED:', summary.failed.join(' | '))
process.exit(summary.failed.length ? 1 : 0)
