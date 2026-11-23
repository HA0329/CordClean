/**
 * AI 清理顾问的「不可用即明确失败」与生成质量/稳定性回归测试。
 *
 * 覆盖四类改进（不引入离线分析：未配置 Key 仍然必须是明确错误）：
 * 1. 提示词输出契约：taskId/体积不许虚构、JSON 必须可解析、生成插件必须完整可安装；
 * 2. 可安装草稿前置检查：files/manifest 修复、路径/依赖/占位符/相对 import 校验、重试反馈；
 * 3. 错误分类与重试稳定：稳定错误码、Retry-After、可取消退避、流式取消/截断边界；
 * 4. 引导文案准确性：未启用/未配置 Key/无模型时明确「不可用 + 如何配置」，不得暗示可离线用。
 */
import { createServer, type Server } from 'node:http'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '@cordclean/core'
import aiPlugin from '@cordclean/plugin-ai'
import {
  isRetryableAiCode,
  normalizePluginFiles,
  normalizePluginManifest,
  normalizeSuggestions,
  preparePluginDraft,
  requestJson,
  retryAfterMs,
  sanitizeSuggestionTasks,
  toPackagePath,
  PLUGIN_SYSTEM_PROMPT,
} from '@cordclean/plugin-ai'
import { buildUserPrompt, DEFAULT_SYSTEM_PROMPT } from '../packages/plugins/ai/src/profile.ts'
import { isTruncatedFinish, sseFinishReason } from '../packages/plugins/ai/src/adapters.ts'
import { aiSetupGuide } from '../packages/ui/src/views/ai-view-model.ts'
import { createSandbox, manifestOf } from './helpers.ts'

/* ------------------------------------------------------------------ */
/* 1. 提示词输出契约（纯函数）                                          */
/* ------------------------------------------------------------------ */

describe('提示词输出契约', () => {
  it('分析提示词要求 taskId/体积来自画像且禁止虚构', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('JSON.parse')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('taskId 只能填画像 tasks[].id')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('绝不能虚构')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('estimatedBytes')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('不得建议删除用户文档')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('caution')
    // 提示词自身不能包含真实路径/用户名占位（隐私约束）
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/C:\\\\Users/i)
  })

  it('用户消息显式列出可引用任务 id；无任务时要求 taskId 为空', () => {
    const profile = {
      os: { release: '10.0', arch: 'x64', elevated: false },
      cpu: { model: 'CPU', cores: 8 },
      memory: { totalGb: 16, freeGb: 8 },
      disks: [{ mount: 'C:', totalGb: 100, freeGb: 50, usedPercent: 50 }],
      hotspots: [{ label: '临时目录', gb: 1 }],
      tasks: [
        { id: 'system-temp', name: '临时文件', category: 'system', risk: 'safe', items: 3, mb: 120, elapsedMs: 5 },
      ],
      topItems: [{ category: 'system', count: 3, mb: 120 }],
    }
    const prompt = buildUserPrompt(profile, '补充说明')
    expect(prompt).toContain('本机画像如下')
    expect(prompt).toContain('"system-temp"')
    expect(prompt).toContain('补充说明')
    expect(buildUserPrompt({ ...profile, tasks: [] })).toContain('taskId 必须为空字符串')
  })

  it('插件生成提示词要求 JSON 可解析、禁止占位符、示例本身是合法 JSON', () => {
    expect(PLUGIN_SYSTEM_PROMPT).toContain('JSON 必须能被严格解析')
    expect(PLUGIN_SYSTEM_PROMPT).toContain('禁止 TODO、省略号')
    expect(PLUGIN_SYSTEM_PROMPT).toContain('manifest.entry 必须出现在 files 中')
    expect(PLUGIN_SYSTEM_PROMPT).toContain('client/index.html')
    const exampleLine = PLUGIN_SYSTEM_PROMPT.split('\n').find((line) => line.includes('示例骨架'))
    expect(exampleLine).toBeTruthy()
    const jsonText = exampleLine!.slice(exampleLine!.indexOf('{'))
    expect(() => JSON.parse(jsonText)).not.toThrow()
    const parsed = JSON.parse(jsonText)
    expect(parsed.files?.[0]?.path).toBe('index.mjs')
    expect(parsed.manifest?.entry).toBe('index.mjs')
  })

  it('流式结束原因可识别并映射成截断', () => {
    expect(sseFinishReason('chat', { choices: [{ delta: {}, finish_reason: 'length' }] })).toBe('length')
    expect(sseFinishReason('messages', { type: 'message_delta', delta: { stop_reason: 'max_tokens' } })).toBe('max_tokens')
    expect(sseFinishReason('responses', { type: 'response.incomplete' })).toBe('incomplete')
    expect(sseFinishReason('chat', { choices: [{ delta: { content: 'x' } }] })).toBeUndefined()
    expect(isTruncatedFinish('length')).toBe(true)
    expect(isTruncatedFinish('max_tokens')).toBe(true)
    expect(isTruncatedFinish('incomplete')).toBe(true)
    expect(isTruncatedFinish('stop')).toBe(false)
    expect(isTruncatedFinish(undefined)).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* 2. 可安装草稿前置检查                                                */
/* ------------------------------------------------------------------ */

const GOOD_CODE = `export const name = 'prep-demo'
export const description = '演示插件'
export const kind = 'cleaner'
export const inject = ['cleaner', 'system']
export function apply(ctx) {
  const base = String(ctx.system.env.get('TEMP') || '')
  ctx.cleaner.define({
    id: 'prep-demo-task',
    name: '演示清理',
    category: 'apps',
    risk: 'safe',
    defaultSelected: false,
    targets: [base],
    scan(scan) { scan.emit({ path: base, kind: 'file', size: 1 }) },
  })
}
`

describe('可安装草稿前置检查', () => {
  it('虚构的 taskId 被降级为未关联，建议本身保留', () => {
    const suggestions = normalizeSuggestions([
      { title: 'A', reason: 'r', taskId: 'real-task' },
      { title: 'B', reason: 'r', taskId: 'ghost-task' },
    ])
    const cleaned = sanitizeSuggestionTasks(suggestions, ['real-task'])
    expect(cleaned[0]!.taskId).toBe('real-task')
    expect(cleaned[1]!.taskId).toBeUndefined()
    expect(cleaned[1]!.title).toBe('B')
  })

  it('路径归一：反斜杠/./ 统一，非法路径与 plugin.json 被丢弃', () => {
    expect(toPackagePath('client\\index.html')).toBe('client/index.html')
    expect(toPackagePath('./index.mjs')).toBe('index.mjs')
    expect(
      normalizePluginFiles([
        { path: 'index.mjs', content: 'x' },
        { path: 'client\\index.html', content: '<html></html>' },
        { path: '../evil.mjs', content: 'x' },
        { path: 'C:\\evil.mjs', content: 'x' },
        { path: 'plugin.json', content: '{}' },
        { path: '', content: 'y' },
        { path: 'index.mjs', content: 'duplicate' },
        'bad',
      ]).map((file) => file.path),
    ).toEqual(['index.mjs', 'client/index.html'])
    expect(normalizePluginManifest('bad')).toBeUndefined()
    // 不合法的 entry 会被清掉（交给后续按实际文件修复）
    expect(normalizePluginManifest({ id: 'x', entry: '../evil.mjs' })).toEqual({ id: 'x' })
  })

  it('单文件 code 会被包装成入口文件，且通过静态契约检查', () => {
    const result = preparePluginDraft({ code: GOOD_CODE })
    expect(result.ok).toBe(true)
    expect(result.files).toEqual([{ path: 'index.mjs', content: GOOD_CODE.trim() }])
    expect(result.code).toBe(GOOD_CODE.trim())
    expect(result.entry).toBe('index.mjs')
    expect(result.warnings.join('；')).toContain('index.mjs')
  })

  it('files 优先于 code；manifest.entry/client 缺失时按实际文件修复', () => {
    const files = [
      { path: 'entry.mjs', content: GOOD_CODE },
      { path: 'client/index.html', content: '<html><body>demo</body></html>' },
    ]
    const result = preparePluginDraft({
      code: '不存在的旧代码',
      files,
      manifest: { entry: 'missing.mjs', client: { mode: 'page', entry: 'client/not-found.html' } },
    })
    expect(result.ok).toBe(true)
    expect(result.entry).toBe('entry.mjs')
    expect(result.code).toBe(GOOD_CODE)
    expect(result.files).toHaveLength(2)
    expect(result.manifest?.entry).toBe('entry.mjs')
    expect(result.manifest?.client).toEqual({ mode: 'page', entry: 'client/index.html' })
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('缺清单页面时把 client 修正为 declarative，不阻断安装', () => {
    const result = preparePluginDraft({
      files: [{ path: 'index.mjs', content: GOOD_CODE }],
      manifest: { entry: 'index.mjs', client: { mode: 'page', entry: 'client/index.html' } },
    })
    expect(result.ok).toBe(true)
    expect(result.manifest?.client).toEqual({ mode: 'declarative' })
  })

  it('非法依赖、未声明包 import、缺失相对模块、占位符都会被拦下并给出可读原因', () => {
    const invalidDeps = preparePluginDraft({ code: GOOD_CODE, dependencies: { 'evil-pkg': 'file:../evil' } })
    expect(invalidDeps.ok).toBe(false)
    expect(invalidDeps.errors.join('；')).toMatch(/semver|依赖/)

    const undeclaredImport = preparePluginDraft({
      files: [
        { path: 'index.mjs', content: GOOD_CODE.replace("import", "//") },
        { path: 'helper.mjs', content: "import fs from 'node:fs'\nimport evil from 'left-pad'\nexport const x = 1\n" },
      ],
    })
    // helper.mjs 里 import 了未声明依赖 → 拦下（index.mjs 本身仍合法）
    expect(undeclaredImport.ok).toBe(false)
    expect(undeclaredImport.errors.join('；')).toContain('left-pad')

    const missingRelative = preparePluginDraft({
      files: [
        { path: 'index.mjs', content: GOOD_CODE },
        { path: 'helper.mjs', content: "import { x } from './not-exist.mjs'\nexport const y = x\n" },
      ],
    })
    expect(missingRelative.ok).toBe(false)
    expect(missingRelative.errors.join('；')).toContain('not-exist.mjs')

    const placeholder = preparePluginDraft({ code: GOOD_CODE.replace('scan(scan) {', '// TODO: 待补充\n    scan(scan) {') })
    expect(placeholder.ok).toBe(false)
    expect(placeholder.errors.join('；')).toContain('省略/占位')
  })

  it('声明且被 import 的第三方依赖可通过；相对模块存在时允许', () => {
    const result = preparePluginDraft({
      dependencies: { 'left-pad': '^1.3.0' },
      files: [
        { path: 'index.mjs', content: GOOD_CODE.replace("import", "//") },
        { path: 'helper.mjs', content: "import leftPad from 'left-pad'\nexport const padded = leftPad('x', 2)\n" },
        { path: 'sub/other.mjs', content: "import { padded } from '../helper.mjs'\nexport const value = padded\n" },
      ],
    })
    expect(result.ok).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* 3. 稳定错误码、重试与取消                                            */
/* ------------------------------------------------------------------ */

const sandbox = createSandbox()
let server: Server
let port = 0
/** 只统计 LLM 请求（不含插件启动时的 /models 预取），避免预取影响重试/取消断言 */
let calls = 0
/** /draft-retry/ 的第几次生成请求（第一次故意给坏依赖触发重试） */
let draftAttempts = 0

function sendJson(res: any, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify(payload))
}

function chatReply(content: unknown): unknown {
  return { choices: [{ message: { role: 'assistant', content: JSON.stringify(content) } }] }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const url = String(req.url ?? '')
      if (url.includes('/models')) return sendJson(res, 200, { data: [] })
      calls++
      if (url.startsWith('/auth/')) return sendJson(res, 401, { error: { message: 'invalid api key' } })
      if (url.startsWith('/bad-json/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('not-json-at-all')
        return
      }
      if (url.startsWith('/retry500/')) {
        if (calls < 3) return sendJson(res, 500, { error: { message: 'temporary boom' } })
        return sendJson(res, 200, { ok: true })
      }
      if (url.startsWith('/ratelimit/')) {
        if (calls === 1) return sendJson(res, 429, { error: { message: 'too many' } }, { 'Retry-After': '0' })
        return sendJson(res, 200, { ok: true })
      }
      if (url.startsWith('/slow500/')) {
        if (calls === 1) return sendJson(res, 500, { error: { message: 'boom' } })
        return sendJson(res, 200, { ok: true })
      }
      if (url.startsWith('/sse-cancel/')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('data: {"choices":[{"delta":{"content":"{\\"summary\\":\\"x\\""}}]}\n\n')
        // 故意不结束：验证用户取消能立刻中断而不是等超时
        return
      }
      if (url.startsWith('/sse-truncated/')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('data: {"choices":[{"delta":{"content":"{\\"summary\\":\\"被截断"}}]}\n\n')
        res.write('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n')
        res.end('data: [DONE]\n\n')
        return
      }
      if (url.startsWith('/sse-auth/')) return sendJson(res, 401, { error: { message: 'invalid api key' } })
      if (url.startsWith('/analysis/')) {
        return sendJson(
          res,
          200,
          chatReply({
            summary: '分析摘要',
            suggestions: [
              { title: '真实任务建议', reason: '体积可回收', taskId: 'real-task', targets: ['临时文件'], estimatedBytes: 1024, confidence: 0.8, risk: 'safe' },
              { title: '虚构任务建议', reason: '模型把任务名当成了 id', taskId: 'ghost-task', targets: [], estimatedBytes: 0, confidence: 0.5, risk: 'safe' },
            ],
            selection: [],
          }),
        )
      }
      if (url.startsWith('/analysis-nosummary/')) {
        return sendJson(res, 200, chatReply({ suggestions: [{ title: '建议', reason: '原因', risk: 'safe' }] }))
      }
      if (url.startsWith('/draft-retry/')) {
        draftAttempts++
        if (draftAttempts === 1) {
          return sendJson(res, 200, chatReply({ name: 'retry-demo', kind: 'cleaner', code: GOOD_CODE, dependencies: { 'left-pad': 'file:../x' } }))
        }
        return sendJson(res, 200, chatReply({ name: 'retry-demo', kind: 'cleaner', code: GOOD_CODE, dependencies: {} }))
      }
      if (url.includes('/chat/completions')) return sendJson(res, 200, { choices: [{ message: { content: '{}' } }] })
      sendJson(res, 404, { error: { message: 'not found' } })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  port = typeof address === 'object' && address ? address.port : 0
})

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
    // 取消测试会留下被客户端中断的 SSE 连接，主动清掉避免 close 等待
    server.closeAllConnections?.()
  })
  rmSync(sandbox.root, { recursive: true, force: true })
})

beforeEach(() => {
  calls = 0
  draftAttempts = 0
})

describe('请求层错误分类与重试', () => {
  it('重试判定是稳定错误码的纯函数映射', () => {
    for (const code of ['TIMEOUT', 'NETWORK', 'SERVER', 'RATE_LIMIT'] as const) expect(isRetryableAiCode(code)).toBe(true)
    for (const code of ['AUTH', 'BAD_REQUEST', 'INVALID_RESPONSE', 'HTTP', 'CANCELLED'] as const) expect(isRetryableAiCode(code)).toBe(false)
    expect(retryAfterMs('2')).toBe(2000)
    expect(retryAfterMs('garbage')).toBe(0)
    expect(retryAfterMs(null)).toBe(0)
  })

  it('401 不重试，抛出稳定 AUTH 码与 HTTP 状态', async () => {
    await expect(
      requestJson(`http://127.0.0.1:${port}/auth/chat`, {
        headers: {},
        body: {},
        timeoutMs: 3000,
        retries: 3,
      }),
    ).rejects.toMatchObject({ name: 'AiError', code: 'AUTH', status: 401 })
    expect(calls).toBe(1)
  })

  it('5xx 按 retries 重试后可成功', async () => {
    const result = await requestJson(`http://127.0.0.1:${port}/retry500/chat`, {
      headers: {},
      body: {},
      timeoutMs: 3000,
      retries: 2,
    })
    expect(result.payload).toEqual({ ok: true })
    expect(calls).toBe(3)
  }, 30_000)

  it('429 遵守 Retry-After 并重试成功', async () => {
    const startedAt = Date.now()
    const result = await requestJson(`http://127.0.0.1:${port}/ratelimit/chat`, {
      headers: {},
      body: {},
      timeoutMs: 3000,
      retries: 1,
    })
    expect(result.payload).toEqual({ ok: true })
    expect(calls).toBe(2)
    // Retry-After: 0 → 不应走 400ms+ 的默认退避
    expect(Date.now() - startedAt).toBeLessThan(350)
  })

  it('退避等待期间用户取消，立即以 CANCELLED 结束且不再发请求', async () => {
    const controller = new AbortController()
    const startedAt = Date.now()
    const pending = requestJson(`http://127.0.0.1:${port}/slow500/chat`, {
      headers: {},
      body: {},
      timeoutMs: 3000,
      retries: 3,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 50)
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(calls).toBe(1)
    expect(Date.now() - startedAt).toBeLessThan(1000)
  })

  it('200 但不是 JSON 时报 INVALID_RESPONSE；连接失败报 NETWORK', async () => {
    await expect(
      requestJson(`http://127.0.0.1:${port}/bad-json/chat`, { headers: {}, body: {}, timeoutMs: 3000, retries: 0 }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await expect(
      requestJson('http://127.0.0.1:1/chat', { headers: {}, body: {}, timeoutMs: 3000, retries: 0 }),
    ).rejects.toMatchObject({ code: 'NETWORK' })
  })
})

/* ------------------------------------------------------------------ */
/* 4. 服务层：未配置 Key 明确失败 + 流式取消/截断边界                   */
/* ------------------------------------------------------------------ */

async function boot(config: Record<string, unknown>, name: string) {
  return createApp({
    dataDir: path.join(sandbox.dataDir, name),
    logger: false,
    loadPlugins: true,
    manifest: manifestOf([{ id: 'ai', plugin: aiPlugin }]),
    settingsOverrides: { plugins: { ai: { enabled: true, config } } },
  })
}

const baseConfig = (prefix: string, extra: Record<string, unknown> = {}) => ({
  apiKey: 'test-key',
  baseUrl: `http://127.0.0.1:${port}/${prefix}`,
  model: 'mock-model',
  timeoutMs: 20_000,
  retries: 0,
  ...extra,
})

describe('服务层边界', () => {
  it('未配置 Key 时 analyze/draftPlugin 都抛稳定 AUTH 错误，不产生任何分析结果', async () => {
    const previous = { deepseek: process.env.DEEPSEEK_API_KEY, openai: process.env.OPENAI_API_KEY, dashscope: process.env.DASHSCOPE_API_KEY }
    delete process.env.DEEPSEEK_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.DASHSCOPE_API_KEY
    const app = await boot({ apiKey: '', baseUrl: `http://127.0.0.1:${port}`, model: 'mock-model', stream: false }, 'no-key')
    try {
      expect(app.ctx.ai!.configured()).toBe(false)
      await expect(app.ctx.ai!.analyze()).rejects.toMatchObject({ code: 'AUTH' })
      await expect(app.ctx.ai!.analyze()).rejects.toThrow(/API Key/)
      expect(app.ctx.ai!.last()).toBeUndefined()
      // 引导必须让用户去配置，而不是暗示离线可用
      const guide = aiSetupGuide({ available: true, configured: false, onlineAi: true, model: 'deepseek-flash', modelIds: [] })
      expect(guide.state).toBe('missing-key')
      expect(guide.blocking).toBe(true)
      expect(guide.message).toContain('API Key')
      expect(guide.message).toContain('环境变量')
      expect(guide.message).not.toContain('离线')
      await expect(app.ctx.ai!.draftPlugin!('写一个插件')).rejects.toMatchObject({ code: 'AUTH' })
    } finally {
      await app.dispose()
      if (previous.deepseek !== undefined) process.env.DEEPSEEK_API_KEY = previous.deepseek
      if (previous.openai !== undefined) process.env.OPENAI_API_KEY = previous.openai
      if (previous.dashscope !== undefined) process.env.DASHSCOPE_API_KEY = previous.dashscope
    }
  })

  it('流式请求中取消：立刻以 CANCELLED 结束，不回退非流式再打一次请求', async () => {
    const app = await boot(baseConfig('sse-cancel'), 'sse-cancel')
    try {
      let cancelled = false
      app.ctx.on('ai/stream' as any, (event: any) => {
        if (!cancelled && event?.kind === 'delta') {
          cancelled = true
          app.ctx.ai!.cancelAnalyze!()
        }
      })
      await expect(app.ctx.ai!.analyze()).rejects.toMatchObject({ code: 'CANCELLED' })
      expect(cancelled).toBe(true)
      expect(calls).toBe(1)
    } finally {
      await app.dispose()
    }
  }, 30_000)

  it('流式被 max_tokens 截断时报「输出被截断」而不是「JSON 不合法」', async () => {
    const app = await boot(baseConfig('sse-truncated'), 'sse-truncated')
    try {
      await expect(app.ctx.ai!.analyze()).rejects.toThrow(/输出被截断/)
      await expect(app.ctx.ai!.analyze()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    } finally {
      await app.dispose()
    }
  }, 30_000)

  it('流式接口 401 时不回退非流式（只请求一次，保留 AUTH 码）', async () => {
    const app = await boot(baseConfig('sse-auth'), 'sse-auth')
    try {
      await expect(app.ctx.ai!.analyze()).rejects.toMatchObject({ code: 'AUTH', status: 401 })
      expect(calls).toBe(1)
    } finally {
      await app.dispose()
    }
  })

  it('分析结果里的虚构 taskId 不会出现在建议里，真实任务则保留', async () => {
    const app = await boot(baseConfig('analysis', { stream: false }), 'analysis-taskid')
    try {
      app.ctx.cleaner.define({
        id: 'real-task',
        name: '真实任务',
        category: 'system',
        risk: 'safe',
        defaultSelected: false,
        targets: [],
        scan() {},
      })
      const analysis = await app.ctx.ai!.analyze()
      expect(analysis.summary).toBe('分析摘要')
      expect(analysis.suggestions).toHaveLength(2)
      expect(analysis.suggestions[0]!.taskId).toBe('real-task')
      expect(analysis.suggestions[1]!.taskId).toBeUndefined()
    } finally {
      await app.dispose()
    }
  })

  it('模型漏写 summary 时给中性说明，不出现空白摘要', async () => {
    const app = await boot(baseConfig('analysis-nosummary', { stream: false }), 'analysis-nosummary')
    try {
      const analysis = await app.ctx.ai!.analyze()
      expect(analysis.summary).toContain('模型未返回摘要')
      expect(analysis.summary).toContain('1 条')
    } finally {
      await app.dispose()
    }
  })

  it('生成草稿未通过安装前置检查时带错误自动重试，第二次返回可安装包', async () => {
    const app = await boot(baseConfig('draft-retry', { stream: false, retries: 1 }), 'draft-retry')
    try {
      const draft = await app.ctx.ai!.draftPlugin!('生成一个演示插件')
      expect(draftAttempts).toBe(2)
      expect(draft.code).toContain('export function apply(')
      expect(draft.files?.map((file) => file.path)).toEqual(['index.mjs'])
      expect(draft.format).toBe('package')
      expect(draft.mode).toBe('native')
    } finally {
      await app.dispose()
    }
  })
})

/* ------------------------------------------------------------------ */
/* 5. 引导文案准确性（未启用 / 未配置 Key / 无模型 = 不可用 + 如何配置） */
/* ------------------------------------------------------------------ */

describe('引导文案准确性', () => {
  const base = { available: true, configured: true, onlineAi: true, model: 'deepseek-flash', modelIds: [] as string[] }
  const noOfflineHint = (text: string) => !/离线|无需\s*Key|不使用\s*Key|本地规则|内置规则分析/.test(text)

  it('插件未启用：阻止分析并引导启用', () => {
    const guide = aiSetupGuide({ ...base, available: false })
    expect(guide.state).toBe('plugin-disabled')
    expect(guide.blocking).toBe(true)
    expect(guide.title).toContain('未启用')
    expect(guide.actions.map((action) => action.id)).toContain('enable-plugin')
    expect(noOfflineHint(`${guide.title}${guide.message}`)).toBe(true)
  })

  it('未配置 Key：阻止分析并给出填写/环境变量两种配置路径', () => {
    const guide = aiSetupGuide({ ...base, configured: false })
    expect(guide.state).toBe('missing-key')
    expect(guide.blocking).toBe(true)
    expect(guide.message).toContain('DEEPSEEK_API_KEY')
    expect(guide.actions.some((action) => action.id === 'fill-key')).toBe(true)
    expect(noOfflineHint(`${guide.title}${guide.message}`)).toBe(true)
  })

  it('无模型：阻止分析并给出选择/刷新入口', () => {
    const guide = aiSetupGuide({ ...base, model: '' })
    expect(guide.state).toBe('missing-model')
    expect(guide.blocking).toBe(true)
    expect(guidanceHasActions(guide, ['change-model', 'refresh-models'])).toBe(true)
    expect(noOfflineHint(`${guide.title}${guide.message}`)).toBe(true)
  })

  it('就绪：不阻止分析', () => {
    expect(aiSetupGuide(base)).toMatchObject({ state: 'ready', blocking: false })
  })
})

function guidanceHasActions(guide: { actions: Array<{ id: string }> }, ids: string[]): boolean {
  return ids.every((id) => guide.actions.some((action) => action.id === id))
}
