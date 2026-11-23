/**
 * AI 插件工坊：生成输出契约 + 安装前自检（workshop contract）单测。
 *
 * 覆盖：
 * - 提示词/输出契约覆盖安装前关键约束（manifest / files / permissions / client / 禁止 API）；
 * - prepareWorkshopDraft：无清单自动合成、非法清单自动修复、inject 自动补全；
 * - 危险 API / 框架内部包 import / 未声明依赖 / 路径越界 / 页面 bridge 协议错误 → 可读错误；
 * - 修复后的草稿与宿主「安装前校验」同源：validateAiPluginPackage 零错误；
 * - 服务层：第一次生成契约不通过时带错误反馈自动重试，最终草稿可直接安装；
 *   持续不通过时给出可读错误 + BAD_REQUEST（界面归类为校验失败，可重试）。
 */
import { createServer, type Server } from 'node:http'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type App } from '@cordclean/core'
import { validateAiPluginPackage } from '@cordclean/host'
import {
  checkPluginSource,
  validatePluginManifest,
  type AiPluginDraft,
} from '@cordclean/shared'
import { AiError } from '@cordclean/plugin-ai'
import aiWorkshopPlugin from '@cordclean/plugin-ai-workshop'
import {
  WORKSHOP_PACKAGE_CONTRACT,
  normalizeWorkshopPluginId,
  prepareWorkshopDraft,
  repairInjectDeclarations,
} from '../packages/plugins/ai-workshop/src/contract.ts'
import { createSandbox, manifestOf } from './helpers.ts'

const sandbox = createSandbox()

afterAll(() => {
  rmSync(sandbox.root, { recursive: true, force: true })
})

const GOOD_CODE = `export const name = 'contract-demo'
export const kind = 'cleaner'
export const inject = ['cleaner']
export function apply(ctx) {
  ctx.effect(() => ctx.cleaner.define({
    id: 'contract-demo-task',
    name: '契约演示任务',
    category: 'apps',
    risk: 'safe',
    defaultSelected: false,
    targets: [],
    scan(scan) { scan.emit({ path: 'C:/tmp/contract-demo.log', size: 1 }) },
  }))
}
`

/** 同样的插件，但故意漏写 inject（模型常见错误） */
const NO_INJECT_CODE = GOOD_CODE.replace("export const inject = ['cleaner']\n", '')

function assertInstallable(draft: AiPluginDraft, appVersion = '0.6.11'): void {
  const source = checkPluginSource(draft.code, {
    dependencies: draft.dependencies,
    mode: 'native',
    allowRelativeImports: true,
  })
  expect(source.errors).toEqual([])
  const manifestValidation = validatePluginManifest(draft.manifest)
  expect(manifestValidation.errors).toEqual([])
}

describe('输出契约（提示词）', () => {
  it('覆盖安装前关键约束，提醒模型输出可安装的 v2 包', () => {
    for (const keyword of [
      'emit_plugin',
      'manifest',
      'files',
      'index.mjs',
      'apiVersion: 2',
      'engines.cordclean',
      'permissions.services',
      'inject',
      'dependencies',
      'client/index.html',
      'cordclean/plugin-page',
      '禁止',
    ]) {
      expect(WORKSHOP_PACKAGE_CONTRACT).toContain(keyword)
    }
    expect(WORKSHOP_PACKAGE_CONTRACT).toContain('安装前校验')
  })
})

describe('安装前自检：清单归一化与自动修复', () => {
  it('单文件草稿：自动合成合法 v2 清单，源码通过共享静态契约', () => {
    const prep = prepareWorkshopDraft({ name: 'Contract Demo!!', code: GOOD_CODE })
    expect(prep.errors).toEqual([])
    expect(prep.draft.format).toBe('package')
    expect(prep.draft.mode).toBe('native')
    expect(prep.draft.files?.map((file) => file.path)).toEqual(['index.mjs'])
    const manifest = prep.draft.manifest!
    expect(manifest.id).toBe(normalizeWorkshopPluginId('Contract Demo!!'))
    expect(manifest.apiVersion).toBe(2)
    expect(manifest.entry).toBe('index.mjs')
    expect(manifest.kind).toBe('cleaner')
    expect(manifest.engines.cordclean).toBe('>=0.6.0 <1.0.0')
    expect(manifest.permissions.services).toContain('cleaner')
    expect(manifest.permissions.network).toBe(false)
    expect(manifest.client?.mode).toBe('declarative')
    expect(prep.repairs.length).toBeGreaterThan(0)
    assertInstallable(prep.draft)
  })

  it('只有 files 没有 code 时也能归一化为可安装草稿', () => {
    const prep = prepareWorkshopDraft({ name: 'files-only', files: [{ path: 'index.mjs', content: GOOD_CODE }] })
    expect(prep.errors).toEqual([])
    expect(prep.draft.code).toContain('export function apply')
    expect(prep.draft.files?.map((file) => file.path)).toEqual(['index.mjs'])
  })

  it('非法/不完整清单：字段自动修正，页面声明缺文件时降级，仍能通过安装前校验', () => {
    const prep = prepareWorkshopDraft({
      name: 'Bad Name 插件',
      code: NO_INJECT_CODE,
      manifest: {
        id: 'Bad ID',
        apiVersion: 1,
        engines: { cordclean: '不是 semver range' },
        kind: 'unknown-kind',
        entry: 'missing.mjs',
        client: { mode: 'page', entry: 'client/index.html' },
        permissions: { services: ['cleaner', 'hack-service'], network: 'yes', subprocess: true },
      },
      files: [{ path: 'index.mjs', content: NO_INJECT_CODE }],
    })
    expect(prep.errors).toEqual([])
    expect(prep.repairs.length).toBeGreaterThan(3)
    const manifest = prep.draft.manifest!
    expect(manifest.id).toBe('bad-id')
    expect(manifest.apiVersion).toBe(2)
    expect(manifest.engines.cordclean).toBe('>=0.6.0 <1.0.0')
    expect(manifest.kind).toBe('cleaner')
    expect(manifest.entry).toBe('index.mjs')
    expect(manifest.client?.mode).toBe('declarative')
    expect(manifest.permissions.services).toEqual(['cleaner'])
    expect(manifest.permissions.network).toBe(false)
    // 漏写的 inject 已自动补全，源码契约通过
    expect(prep.draft.code).toContain('export const inject')
    assertInstallable(prep.draft)
  })

  it('清单声明独立页面 + bridge 协议正确时保留 page 模式并补齐 files', () => {
    const page = `<!doctype html><html><body><script>
      window.addEventListener('message', (event) => {
        if (event.data?.type === 'cordclean/plugin-page-result') return
      })
      window.parent.postMessage({ type: 'cordclean/plugin-page', method: 'resolve', id: 1, resolverId: 'card', params: {} }, '*')
    </script></body></html>`
    const prep = prepareWorkshopDraft({
      name: 'page-demo',
      code: GOOD_CODE,
      manifest: { id: 'page-demo', kind: 'cleaner', apiVersion: 2, client: { mode: 'page', entry: 'client/index.html' } },
      files: [
        { path: 'index.mjs', content: GOOD_CODE },
        { path: 'client/index.html', content: page },
      ],
    })
    expect(prep.errors).toEqual([])
    expect(prep.draft.manifest?.client).toEqual({ mode: 'page', entry: 'client/index.html' })
    expect(prep.draft.files?.some((file) => file.path === 'client/index.html')).toBe(true)
  })

  it('inject 自动补全是幂等的，不重复声明', () => {
    const repaired = repairInjectDeclarations('export function apply(ctx) { void ctx.cleaner }')
    expect(repaired.added).toEqual(['cleaner'])
    expect(repaired.code).toContain('export const inject = ["cleaner"]')
    expect(repairInjectDeclarations(repaired.code).added).toEqual([])
  })

  it('依赖只写在 manifest.dependencies 时也能识别，并参与静态契约检查', () => {
    const code = `import isNumber from 'is-number'
export const name = 'dep-demo'
export function apply(ctx) { void isNumber(1) }
`
    const prep = prepareWorkshopDraft({
      name: 'dep-demo',
      code,
      manifest: { id: 'dep-demo', dependencies: { 'is-number': '^7.0.0' } },
    })
    expect(prep.errors).toEqual([])
    expect(prep.draft.dependencies).toEqual({ 'is-number': '^7.0.0' })
    expect(prep.draft.manifest?.dependencies).toEqual({ 'is-number': '^7.0.0' })
  })

  it('注册了 ctx.ui.command 但忘记导出 contributes 时自动补全（UI 贡献对象形状）', () => {
    const code = `export const name = 'cmd-demo'
export const kind = 'active'
export const inject = ['ui']
export function apply(ctx) {
  ctx.effect(() => ctx.ui.command(name, 'run-selfcheck', async () => ({ ok: true })))
}
`
    const prep = prepareWorkshopDraft({ name: 'cmd-demo', code })
    expect(prep.errors).toEqual([])
    expect(prep.draft.code).toContain('export const contributes')
    expect(prep.draft.code).toContain('"run-selfcheck"')
    expect(prep.draft.manifest?.kind).toBe('active')
    expect(prep.draft.manifest?.contributes?.commands).toEqual(['run-selfcheck'])
    assertInstallable(prep.draft)
  })
})

describe('安装前自检：可读错误', () => {
  it('危险 API（网络请求）被拦截且错误可读', () => {
    const prep = prepareWorkshopDraft({
      name: 'danger-demo',
      code: `export const name = 'danger-demo'\nexport function apply(ctx) { void fetch('https://example.com') }`,
    })
    expect(prep.errors.length).toBeGreaterThan(0)
    expect(prep.errors.join(' ')).toMatch(/禁止插件内发起网络请求|fetch/)
  })

  it('框架内部包 / 未声明第三方包 import 被拦截且提示 dependencies', () => {
    const framework = prepareWorkshopDraft({
      name: 'framework-demo',
      code: `import { Context } from '@cordisjs/core'\nexport const name = 'framework-demo'\nexport function apply(ctx) { void Context }`,
    })
    expect(framework.errors.join(' ')).toContain('@cordisjs')
    expect(framework.errors.join(' ')).toContain('框架内部包')

    const undeclared = prepareWorkshopDraft({
      name: 'undeclared-demo',
      code: `import lodash from 'lodash'\nexport const name = 'undeclared-demo'\nexport function apply(ctx) { void lodash }`,
    })
    expect(undeclared.errors.join(' ')).toContain('dependencies')
    expect(undeclared.errors.join(' ')).toContain('lodash')
  })

  it('路径越界 / plugin.json / 空内容都被拦截', () => {
    const traversal = prepareWorkshopDraft({
      name: 'paths-demo',
      code: GOOD_CODE,
      files: [
        { path: '../evil.mjs', content: 'export const name = "evil"' },
        { path: 'index.mjs', content: GOOD_CODE },
      ],
    })
    expect(traversal.errors.join(' ')).toContain('非法文件路径')

    const withManifestFile = prepareWorkshopDraft({
      name: 'manifest-demo',
      code: GOOD_CODE,
      files: [
        { path: 'plugin.json', content: '{}' },
        { path: 'index.mjs', content: GOOD_CODE },
      ],
    })
    expect(withManifestFile.errors.join(' ')).toContain('plugin.json')

    const emptyFile = prepareWorkshopDraft({
      name: 'empty-demo',
      code: '',
      files: [{ path: 'index.mjs', content: '   ' }],
    })
    expect(emptyFile.errors.length).toBeGreaterThan(0)
  })

  it('client 页面 bridge 协议不匹配时给出宿主同源错误', () => {
    const badPage = `<script>postMessage({ type: 'cordclean/plugin-page', action: 'resolve', requestId: '1' }, '*')</script>`
    const prep = prepareWorkshopDraft({
      name: 'bridge-demo',
      code: GOOD_CODE,
      files: [
        { path: 'index.mjs', content: GOOD_CODE },
        { path: 'client/index.html', content: badPage },
      ],
    })
    expect(prep.errors.join(' ')).toContain('bridge')
    expect(prep.errors.join(' ')).toContain('resolverId')
  })

  it('坏 Windows 路径分隔符自动修正为 /（模型常见输出）', () => {
    const prep = prepareWorkshopDraft({
      name: 'slash-demo',
      code: GOOD_CODE,
      files: [
        { path: 'index.mjs', content: GOOD_CODE },
        { path: 'client\\index.html', content: '<html><body>static</body></html>' },
      ],
    })
    expect(prep.errors).toEqual([])
    expect(prep.draft.files?.map((file) => file.path)).toContain('client/index.html')
    expect(prep.repairs.join(' ')).toContain('文件路径分隔符')
  })
})

describe('安装前自检：与宿主安装校验同源', () => {
  it('自动修复后的草稿通过 validateAiPluginPackage（安装前校验零错误）', async () => {
    const prep = prepareWorkshopDraft({
      name: 'Ready Cleaner',
      code: NO_INJECT_CODE,
      files: [{ path: 'index.mjs', content: NO_INJECT_CODE }],
    })
    expect(prep.errors).toEqual([])
    const validation = await validateAiPluginPackage(prep.draft, '0.6.11')
    expect(validation.errors).toEqual([])
    expect(validation.ok).toBe(true)
    expect(validation.manifest?.id).toBe('ready-cleaner')
    expect(validation.manifest?.apiVersion).toBe(2)
  })
})

/* ------------------------------------------------------------------ */
/* 服务层：带错误反馈的自动重试 + 最终错误可读                          */
/* ------------------------------------------------------------------ */

const BAD_CONTRACT_CODE = `export const name = 'retry-demo'
export function apply(ctx) {
  void fetch('https://example.com/leak')
}
`

interface MockState {
  scenario: 'bad-then-good' | 'always-bad'
  jsonRequests: string[]
}

const mock: MockState = { scenario: 'bad-then-good', jsonRequests: [] }
let server: Server
let port = 0
let dataSeq = 0

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      // 流式探测请求：立即回一个空的 SSE 结束帧，让服务层回退到非流式请求
      if (raw.includes('"stream":true')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.end('data: [DONE]\n\n')
        return
      }
      const attempt = mock.jsonRequests.length
      mock.jsonRequests.push(raw)
      const useBad = mock.scenario === 'always-bad' || attempt === 0
      const code = useBad ? BAD_CONTRACT_CODE : GOOD_CODE
      const content = JSON.stringify({ name: 'retry-demo', kind: 'cleaner', code, notes: '契约重试演示' })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: {} }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  port = (server.address() as { port: number }).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function boot(retries = 1): Promise<App> {
  dataSeq += 1
  return createApp({
    dataDir: path.join(sandbox.root, `data-${dataSeq}`),
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
            retries,
            timeoutMs: 10_000,
          },
        },
      },
    },
  })
}

describe('服务层：契约失败自动重试，最终草稿可安装', () => {
  it('第一次输出危险 API → 带可读错误反馈重试 → 第二次草稿通过宿主安装前校验', async () => {
    mock.scenario = 'bad-then-good'
    mock.jsonRequests = []
    const app = await boot(1)
    try {
      const draft: AiPluginDraft = await (app.ctx as any).aiWorkshop.draftPlugin('写一个清理临时文件的插件')
      expect(mock.jsonRequests).toHaveLength(2)
      // 系统提示词包含工坊追加的安装前契约
      expect(mock.jsonRequests[0]).toContain('工坊追加要求')
      // 第二次请求携带了上一次的可读错误反馈
      expect(mock.jsonRequests[1]).toContain('安装前校验')
      expect(mock.jsonRequests[1]).toContain('禁止插件内发起网络请求')
      expect(draft.format).toBe('package')
      expect(draft.mode).toBe('native')
      const validation = await validateAiPluginPackage(draft, app.version)
      expect(validation.errors).toEqual([])
      expect(validation.ok).toBe(true)
      expect(validation.manifest?.id).toBe('retry-demo')
    } finally {
      await app.dispose()
    }
  }, 60_000)

  it('持续输出不合契约的代码 → 最终错误可读且为 BAD_REQUEST（界面归类校验失败）', async () => {
    mock.scenario = 'always-bad'
    mock.jsonRequests = []
    const app = await boot(1)
    try {
      const error = await (app.ctx as any).aiWorkshop
        .draftPlugin('写一个清理临时文件的插件')
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(AiError)
      expect((error as AiError).code).toBe('BAD_REQUEST')
      expect((error as AiError).message).toContain('未通过安装前校验')
      expect((error as AiError).message).toContain('网络请求')
      expect(mock.jsonRequests).toHaveLength(2)
    } finally {
      await app.dispose()
    }
  }, 60_000)
})
