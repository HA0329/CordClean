import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp, type App } from '@cordclean/core'
import type { AiPluginDraft } from '@cordclean/shared'
import {
  createHandlers,
  normalizePluginId,
  synthesizePluginManifest,
  validateAiPluginPackage,
  type HandlerMap,
  type ShellAdapter,
} from '@cordclean/host'
import { normalizePluginFiles, normalizePluginManifest } from '@cordclean/plugin-ai'

const root = mkdtempSync(path.join(os.tmpdir(), 'cordclean-ai-plugin-package-'))

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const shell: ShellAdapter = { electron: false, async openPath() {}, async openDataDir() {} }

const CODE = `export const name = 'ai-pkg-demo'
export const kind = 'cleaner'
export const inject = ['cleaner', 'system']
export function apply(ctx) {
  ctx.cleaner.define({
    id: 'ai-pkg-task',
    name: 'AI 包任务',
    category: 'apps',
    risk: 'safe',
    targets: [],
    scan(scan) { scan.emit({ path: 'C:/tmp/ai-pkg.log', size: 2 }) },
  })
}
`

function draft(overrides: Partial<AiPluginDraft> = {}): AiPluginDraft {
  return {
    name: 'ai-pkg-demo',
    code: CODE,
    notes: '',
    dependencies: {},
    mode: 'native',
    kind: 'cleaner',
    format: 'package',
    ...overrides,
  }
}

async function boot(name: string): Promise<{ app: App; handlers: HandlerMap; dataDir: string }> {
  const dataDir = path.join(root, name)
  const app = await createApp({ dataDir, manifest: [], logger: false })
  const handlers = createHandlers({ ctx: app.ctx, dataDir, version: app.version, bootMs: app.bootMs, shell })
  return { app, handlers, dataDir }
}

describe('AI 工坊 → v2 插件包', () => {
  it('单文件草稿合成合法 v2 清单（服务从 inject 提取）', () => {
    const files = { 'index.mjs': CODE }
    const manifest = synthesizePluginManifest(draft(), '0.5.18', files)
    expect(manifest.id).toBe('ai-pkg-demo')
    expect(manifest.apiVersion).toBe(2)
    expect(manifest.engines.cordclean).toBe('^0.5.18')
    expect(manifest.permissions.services).toEqual(['cleaner', 'system'])
    expect(manifest.client?.mode).toBe('declarative')
  })

  it('files 含 client/index.html 时自动声明 page 客户端', () => {
    const files = { 'index.mjs': CODE, 'client/index.html': '<!doctype html><title>x</title>' }
    const manifest = synthesizePluginManifest(draft(), '0.5.18', files)
    expect(manifest.client?.mode).toBe('page')
    expect(manifest.client?.entry).toBe('client/index.html')
  })

  it('非法插件名被规范化为合法 id', () => {
    expect(normalizePluginId('AI 插件！')).toBe('ai')
    expect(normalizePluginId('')).toBe('ai-plugin')
    expect(normalizePluginId('X'.repeat(100))).toBe('x'.repeat(40))
  })

  it('校验：合法单文件/多文件通过，依赖、越界路径、坏清单被拒绝', async () => {
    const single = await validateAiPluginPackage(draft(), '0.5.18')
    expect(single.errors).toEqual([])
    expect(single.ok).toBe(true)
    expect(single.manifest?.id).toBe('ai-pkg-demo')

    const multi = await validateAiPluginPackage(
      draft({ files: [{ path: 'index.mjs', content: CODE }, { path: 'client/index.html', content: '<html></html>' }] }),
      '0.5.18',
    )
    expect(multi.errors).toEqual([])
    expect(multi.manifest?.client?.mode).toBe('page')

    expect((await validateAiPluginPackage(draft({ dependencies: { 'is-number': '^7.0.0' } }), '0.5.18')).ok).toBe(false)
    expect((await validateAiPluginPackage(draft({ files: [{ path: '../evil.mjs', content: CODE }] }), '0.5.18')).ok).toBe(false)
    expect(
      (await validateAiPluginPackage(draft({ manifest: { apiVersion: 1 } as any }), '0.5.18')).errors.length,
    ).toBeGreaterThan(0)
  })

  it('解析模型输出的 files / manifest', () => {
    expect(
      normalizePluginFiles([
        { path: 'index.mjs', content: 'x' },
        { path: '', content: 'y' },
        'bad',
      ]),
    ).toEqual([{ path: 'index.mjs', content: 'x' }])
    expect(normalizePluginManifest({ id: 'x' })).toEqual({ id: 'x' })
    expect(normalizePluginManifest('bad')).toBeUndefined()
  })

  it('RPC：校验 → 安装（要求权限确认）→ 插件出现在列表', async () => {
    const { app, handlers } = await boot('rpc')
    try {
      const validation = await handlers['ai/plugin/validate']({
        code: CODE,
        native: true,
        format: 'package',
      })
      expect(validation.ok).toBe(true)

      await expect(
        handlers['ai/plugin/install']({ name: 'ai-pkg-demo', code: CODE, format: 'package', native: true }),
      ).rejects.toThrow(/权限/)

      const result = await handlers['ai/plugin/install']({
        name: 'ai-pkg-demo',
        code: CODE,
        format: 'package',
        native: true,
        acknowledgePermissions: true,
      })
      expect(result.id).toBe('external:ai-pkg-demo')
      expect(result.manifest?.apiVersion).toBe(2)
      expect(existsSync(result.path)).toBe(true)
      const listed = app.ctx.plugins.list().find((item) => item.id === 'external:ai-pkg-demo')
      expect(listed?.manifest?.id).toBe('ai-pkg-demo')
      expect(app.ctx.cleaner.list().some((task) => task.id === 'ai-pkg-task')).toBe(true)

      await handlers['plugins/uninstall-package']({ id: 'external:ai-pkg-demo' })
      expect(app.ctx.plugins.list().some((item) => item.id === 'external:ai-pkg-demo')).toBe(false)
    } finally {
      await app.dispose()
    }
  })

  it('RPC：多文件包（含客户端页面）校验通过', async () => {
    const { app, handlers } = await boot('rpc-multi')
    try {
      const validation = await handlers['ai/plugin/validate']({
        code: CODE,
        native: true,
        format: 'package',
        files: [
          { path: 'index.mjs', content: CODE },
          { path: 'client/index.html', content: '<!doctype html><title>multi</title>' },
        ],
      })
      expect(validation.ok).toBe(true)
      expect(validation.errors).toEqual([])
    } finally {
      await app.dispose()
    }
  })
})
