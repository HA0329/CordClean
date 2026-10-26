import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp, resolvePluginClientAsset } from '@cordclean/core'
import { createHandlers, startHostServer } from '@cordclean/host'

const root = mkdtempSync(path.join(os.tmpdir(), 'cordclean-client-asset-'))

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function writePackage(dataDir: string, id: string, client: Record<string, unknown> | undefined, files: Record<string, string> = {}): void {
  const dir = path.join(dataDir, 'plugins', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify(
      {
        id,
        name: `页面插件 ${id}`,
        version: '1.0.0',
        apiVersion: 2,
        engines: { cordclean: '>=0.5.0 <1.0.0' },
        kind: 'widget',
        entry: 'index.mjs',
        ...(client ? { client } : {}),
        permissions: { services: ['ui'], network: false, subprocess: false },
      },
      null,
      2,
    ),
    'utf8',
  )
  writeFileSync(path.join(dir, 'index.mjs'), "export const name = 'x'\nexport function apply() {}\n", 'utf8')
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
}

function shell(electron: boolean) {
  return { electron, async openPath() {}, async openDataDir() {} }
}

async function boot(name: string, electron = false) {
  const dataDir = path.join(root, name, 'data')
  mkdirSync(dataDir, { recursive: true })
  writePackage(dataDir, 'page-demo', { mode: 'page', entry: 'client/index.html' }, {
    'client/index.html': '<!doctype html><title>page</title><script src="./app.js"></script>',
    'client/app.js': 'console.log("plugin page")',
    'client/assets/logo.svg': '<svg/>',
  })
  writePackage(dataDir, 'plain-demo', { mode: 'declarative' })
  const app = await createApp({ dataDir, manifest: [], logger: false })
  const handlers = createHandlers({
    ctx: app.ctx,
    dataDir,
    version: app.version,
    bootMs: app.bootMs,
    shell: shell(electron),
  })
  return { app, dataDir, handlers }
}

describe('v2 插件包 client 资源解析', () => {
  it('解析 HTML/JS/嵌套资源并给出 Content-Type 与 CSP', async () => {
    const dataDir = path.join(root, 'resolve', 'data')
    mkdirSync(dataDir, { recursive: true })
    writePackage(dataDir, 'page-demo', { mode: 'page', entry: 'client/index.html' }, {
      'client/index.html': '<!doctype html><title>x</title>',
      'client/app.js': 'console.log(1)',
      'client/assets/logo.svg': '<svg/>',
    })
    const html = await resolvePluginClientAsset({ dataDir, pluginId: 'page-demo' })
    expect(html.asset?.contentType).toContain('text/html')
    expect(html.asset?.csp).toContain("connect-src 'none'")
    expect(html.asset?.file.endsWith(path.join('client', 'index.html'))).toBe(true)

    const js = await resolvePluginClientAsset({ dataDir, pluginId: 'page-demo', requestPath: 'app.js' })
    expect(js.asset?.contentType).toContain('text/javascript')

    const svg = await resolvePluginClientAsset({ dataDir, pluginId: 'page-demo', requestPath: 'assets/logo.svg' })
    expect(svg.asset?.contentType).toBe('image/svg+xml')
  })

  it('拒绝越界路径、非 page 插件与不存在的资源', async () => {
    const dataDir = path.join(root, 'security', 'data')
    mkdirSync(dataDir, { recursive: true })
    writePackage(dataDir, 'page-demo', { mode: 'page', entry: 'client/index.html' }, {
      'client/index.html': '<!doctype html>',
    })
    writePackage(dataDir, 'plain-demo', { mode: 'declarative' })

    const escape = await resolvePluginClientAsset({ dataDir, pluginId: 'page-demo', requestPath: '../plugin.json' })
    expect(escape.error?.status).toBe(403)
    const encodedEscape = await resolvePluginClientAsset({ dataDir, pluginId: 'page-demo', requestPath: '%2e%2e/plugin.json' })
    expect(encodedEscape.error?.status).toBe(403)
    const missing = await resolvePluginClientAsset({ dataDir, pluginId: 'page-demo', requestPath: 'missing.js' })
    expect(missing.error?.status).toBe(404)
    const noPage = await resolvePluginClientAsset({ dataDir, pluginId: 'plain-demo' })
    expect(noPage.error?.status).toBe(404)
    const badId = await resolvePluginClientAsset({ dataDir, pluginId: '../evil' })
    expect(badId.error?.status).toBe(400)
  })
})

describe('插件页 URL 与 Web 静态路由', () => {
  it('client-url：Web 返回同源静态路由，Electron 返回自定义协议', async () => {
    const web = await boot('web')
    try {
      const page = await web.handlers['plugins/client-url']({ id: 'external:page-demo' })
      expect(page.url).toBe('/plugin-assets/page-demo/index.html')
      expect(page.entry).toBe('index.html')
    } finally {
      await web.app.dispose()
    }

    const desktop = await boot('desktop', true)
    try {
      const page = await desktop.handlers['plugins/client-url']({ id: 'external:page-demo' })
      expect(page.url).toBe('cordclean-plugin://page-demo/index.html')
    } finally {
      await desktop.app.dispose()
    }
  })

  it('声明式插件没有客户端页面 URL', async () => {
    const { app, handlers } = await boot('plain-url')
    try {
      expect(app.ctx.plugins.clientPage?.('external:plain-demo')).toBeUndefined()
      expect(() => handlers['plugins/client-url']({ id: 'external:plain-demo' })).toThrow()
    } finally {
      await app.dispose()
    }
  })

  it('HTTP 静态路由按路径提供 client 资源并带 CSP', async () => {
    const { app, dataDir, handlers } = await boot('http')
    const server = await startHostServer({ ctx: app.ctx, handlers, dataDir, port: 0 })
    try {
      const base = `http://127.0.0.1:${server.port}`
      const html = await fetch(`${base}/plugin-assets/page-demo/index.html`)
      expect(html.status).toBe(200)
      expect(html.headers.get('content-type')).toContain('text/html')
      expect(html.headers.get('content-security-policy')).toContain("connect-src 'none'")
      expect(await html.text()).toContain('page')
      const js = await fetch(`${base}/plugin-assets/page-demo/app.js`)
      expect(js.status).toBe(200)
      expect(js.headers.get('content-type')).toContain('javascript')
      const missing = await fetch(`${base}/plugin-assets/page-demo/nope.js`)
      expect(missing.status).toBe(404)
      const traversal = await fetch(`${base}/plugin-assets/page-demo/%252e%252e%252fplugin.json`)
      expect([400, 403, 404]).toContain(traversal.status)
    } finally {
      await server.close()
      await app.dispose()
    }
  })
})
