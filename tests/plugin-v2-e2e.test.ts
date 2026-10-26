/**
 * 插件系统 v2 端到端验收：
 * 真实 host server + HTTP RPC + 静态资源路由，覆盖
 * 检查 → 安装 → 启用 → 客户端页面 → 禁用/启用/重载 → 重复安装拒绝 → 卸载 → 旧版单文件插件重启自动加载。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp, type App } from '@cordclean/core'
import { createHandlers, startHostServer, type ShellAdapter } from '@cordclean/host'

const root = mkdtempSync(path.join(os.tmpdir(), 'cordclean-plugin-v2-e2e-'))

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const shell: ShellAdapter = { electron: false, async openPath() {}, async openDataDir() {} }

const PACKAGE_CODE = `export const name = 'e2e-demo'
export const kind = 'cleaner'
export const inject = ['cleaner']
export function apply(ctx) {
  ctx.effect(() => ctx.cleaner.define({
    id: 'e2e-demo-task',
    name: 'E2E 包任务',
    category: 'system',
    risk: 'safe',
    targets: [],
    scan(scan) { scan.emit({ path: 'C:/cordclean-e2e/demo.log', size: 8 }) },
  }))
}
`

const LEGACY_CODE = `export const name = 'legacy-demo'
export const kind = 'cleaner'
export const inject = ['cleaner']
export function apply(ctx) {
  ctx.effect(() => ctx.cleaner.define({
    id: 'legacy-demo-task',
    name: '旧版单文件任务',
    category: 'system',
    risk: 'safe',
    targets: [],
    scan(scan) { scan.emit({ path: 'C:/cordclean-e2e/legacy.log', size: 4 }) },
  }))
}
`

function writePackage(dir: string): string {
  mkdirSync(path.join(dir, 'client'), { recursive: true })
  writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify(
      {
        id: 'e2e-demo',
        name: 'E2E 插件包',
        version: '1.2.3',
        description: '端到端验收插件',
        apiVersion: 2,
        engines: { cordclean: '>=0.5.0 <1.0.0' },
        kind: 'cleaner',
        entry: 'index.mjs',
        client: { mode: 'page', entry: 'client/index.html' },
        configSchema: 'config.schema.json',
        permissions: {
          services: ['cleaner'],
          fsRoots: ['%TEMP%'],
          network: false,
          subprocess: false,
        },
      },
      null,
      2,
    ),
    'utf8',
  )
  writeFileSync(path.join(dir, 'index.mjs'), PACKAGE_CODE, 'utf8')
  writeFileSync(path.join(dir, 'client', 'index.html'), '<!doctype html><title>e2e</title><script src="./app.js"></script>', 'utf8')
  writeFileSync(path.join(dir, 'client', 'app.js'), 'window.__E2E__ = true', 'utf8')
  writeFileSync(path.join(dir, 'config.schema.json'), '{"type":"object","properties":{}}', 'utf8')
  return dir
}

async function boot(name: string): Promise<{ app: App; server: Awaited<ReturnType<typeof startHostServer>>; dataDir: string }> {
  const dataDir = path.join(root, name, 'data')
  mkdirSync(dataDir, { recursive: true })
  const app = await createApp({ dataDir, manifest: [], logger: false })
  const handlers = createHandlers({ ctx: app.ctx, dataDir, version: app.version, bootMs: app.bootMs, shell })
  const server = await startHostServer({ ctx: app.ctx, handlers, dataDir, port: 0 })
  return { app, server, dataDir }
}

describe('插件系统 v2 端到端', () => {
  it('完整生命周期：检查 → 安装 → client 资源 → 启停/重载 → 卸载', async () => {
    const source = writePackage(path.join(root, 'source-package'))
    const { app, server } = await boot('lifecycle')
    const base = `http://127.0.0.1:${server.port}`
    const rpc = async (method: string, params: unknown = {}) => {
      const response = await fetch(`${base}/api/rpc?token=${server.token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
      return response.json() as Promise<any>
    }
    try {
      const review = await rpc('plugins/inspect-package', { path: source })
      expect(review.error).toBeUndefined()
      expect(review.result.manifest.id).toBe('e2e-demo')
      expect(review.result.errors).toEqual([])

      const installed = await rpc('plugins/install-package', { path: source })
      expect(installed.result.id).toBe('external:e2e-demo')
      expect(installed.result.manifest.apiVersion).toBe(2)
      const list = await rpc('plugins/list')
      const plugin = list.result.find((item: any) => item.id === 'external:e2e-demo')
      expect(plugin.enabled).toBe(true)
      expect(plugin.manifest.id).toBe('e2e-demo')
      expect(app.ctx.cleaner.list().some((task) => task.id === 'e2e-demo-task')).toBe(true)

      // 客户端页面：静态路由 + CSP；穿越被拒
      // 源码按钮必须拿到可打开的文件，而不是包目录
      const sourceInfo = await rpc('plugins/source', { id: 'external:e2e-demo' })
      expect(sourceInfo.result.path.endsWith('index.mjs')).toBe(true)
      const sourceContent = await rpc('plugins/source-content', { id: 'external:e2e-demo' })
      expect(sourceContent.result.path).toBe(sourceInfo.result.path)
      expect(sourceContent.result.content).toContain('e2e-demo-task')
      expect(sourceContent.result.truncated).toBe(false)

      const pageUrl = await rpc('plugins/client-url', { id: 'external:e2e-demo' })
      expect(pageUrl.result.url).toBe('/plugin-assets/e2e-demo/index.html')
      const page = await fetch(base + pageUrl.result.url)
      expect(page.status).toBe(200)
      expect(page.headers.get('content-type')).toContain('text/html')
      expect(page.headers.get('content-security-policy')).toContain("connect-src 'none'")
      expect(await page.text()).toContain('<title>e2e</title>')
      const asset = await fetch(`${base}/plugin-assets/e2e-demo/app.js`)
      expect(asset.status).toBe(200)
      expect(asset.headers.get('content-type')).toContain('javascript')
      const traversal = await fetch(`${base}/plugin-assets/e2e-demo/%252e%252e%252fplugin.json`)
      expect([400, 403, 404]).toContain(traversal.status)

      await rpc('plugins/disable', { id: 'external:e2e-demo' })
      expect(app.ctx.cleaner.list().some((task) => task.id === 'e2e-demo-task')).toBe(false)
      await rpc('plugins/enable', { id: 'external:e2e-demo' })
      expect(app.ctx.cleaner.list().some((task) => task.id === 'e2e-demo-task')).toBe(true)
      await rpc('plugins/reload', { id: 'external:e2e-demo' })
      expect(
        (await rpc('plugins/list')).result.find((item: any) => item.id === 'external:e2e-demo').status,
      ).toBe('active')

      const duplicate = await rpc('plugins/install-package', { path: source })
      expect(duplicate.error).toBeDefined()
      expect(duplicate.error.message).toMatch(/已安装|already-installed/)

      await rpc('plugins/uninstall-package', { id: 'external:e2e-demo' })
      expect(
        (await rpc('plugins/list')).result.some((item: any) => item.id === 'external:e2e-demo'),
      ).toBe(false)
      expect(existsSync(path.join(app.dataDir, 'plugins', 'e2e-demo'))).toBe(false)
      expect(existsSync(path.join(app.dataDir, 'plugins', '.trash'))).toBe(true)
    } finally {
      await server.close()
      await app.dispose()
    }
  })

  it('旧版单文件插件：安装 → 重启后自动加载（兼容验证）', async () => {
    const dataDir = path.join(root, 'legacy', 'data')
    mkdirSync(dataDir, { recursive: true })
    const legacyFile = path.join(root, 'legacy', 'legacy-demo.mjs')
    writeFileSync(legacyFile, LEGACY_CODE, 'utf8')

    const app = await createApp({ dataDir, manifest: [], logger: false })
    try {
      const result = await app.ctx.plugins.installNativePlugin!(legacyFile)
      expect(result.id).toBe('external:legacy-demo')
      expect(app.ctx.plugins.list().find((item) => item.id === 'external:legacy-demo')?.enabled).toBe(true)
      expect(app.ctx.cleaner.list().some((task) => task.id === 'legacy-demo-task')).toBe(true)
    } finally {
      await app.dispose()
    }

    // 模拟重启：同一 dataDir 重新 createApp，旧版插件应从 settings 的 externalPath 自动恢复
    const app2 = await createApp({ dataDir, manifest: [], logger: false })
    try {
      const plugin = app2.ctx.plugins.list().find((item) => item.id === 'external:legacy-demo')
      expect(plugin).toBeDefined()
      expect(plugin?.enabled).toBe(true)
      expect(app2.ctx.cleaner.list().some((task) => task.id === 'legacy-demo-task')).toBe(true)
    } finally {
      await app2.dispose()
    }
  })

  it('AI 工坊草稿（单文件代码）通过 v2 插件包事务安装并启用', async () => {
    const { app, server } = await boot('ai')
    const base = `http://127.0.0.1:${server.port}`
    const rpc = async (method: string, params: unknown = {}) => {
      const response = await fetch(`${base}/api/rpc?token=${server.token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
      return response.json() as Promise<any>
    }
    try {
      const validation = await rpc('ai/plugin/validate', {
        code: PACKAGE_CODE.replaceAll('e2e-demo', 'ai-e2e'),
        format: 'package',
        native: true,
      })
      expect(validation.result.ok).toBe(true)

      const rejected = await rpc('ai/plugin/install', {
        name: 'ai-e2e',
        code: PACKAGE_CODE.replaceAll('e2e-demo', 'ai-e2e'),
        format: 'package',
        native: true,
      })
      expect(rejected.error).toBeDefined()

      const installed = await rpc('ai/plugin/install', {
        name: 'ai-e2e',
        code: PACKAGE_CODE.replaceAll('e2e-demo', 'ai-e2e'),
        format: 'package',
        native: true,
        acknowledgePermissions: true,
      })
      expect(installed.result.id).toBe('external:ai-e2e')
      expect(installed.result.manifest.apiVersion).toBe(2)
      expect(app.ctx.plugins.list().some((item) => item.id === 'external:ai-e2e' && item.enabled)).toBe(true)
      expect(app.ctx.cleaner.list().some((task) => task.id === 'ai-e2e-task')).toBe(true)
    } finally {
      await server.close()
      await app.dispose()
    }
  })

  it('内置 12 个插件正常加载（升级不破坏内置插件）', async () => {
    const dataDir = path.join(root, 'builtin', 'data')
    mkdirSync(dataDir, { recursive: true })
    const app = await createApp({ dataDir, logger: false })
    try {
      const plugins = app.ctx.plugins.list()
      expect(plugins.length).toBe(12)
      const builtinSource = app.ctx.plugins.sourcePath('rule-pack')
      expect(builtinSource?.endsWith('rule-pack')).toBe(true)
      expect(plugins.filter((item) => item.status === 'error')).toEqual([])
      expect(app.ctx.cleaner.list().length).toBeGreaterThanOrEqual(30)
    } finally {
      await app.dispose()
    }
  })
})
