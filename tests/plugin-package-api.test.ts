import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp, type App } from '@cordclean/core'
import { createHandlers, type HandlerMap, type ShellAdapter } from '@cordclean/host'

const root = mkdtempSync(path.join(os.tmpdir(), 'cordclean-pkg-api-'))

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const shell: ShellAdapter = { electron: false, async openPath() {}, async openDataDir() {} }

const CODE = `export const name = 'pkg-api-demo'
export const inject = ['cleaner']
export function apply(ctx) {
  ctx.effect(() => ctx.cleaner.define({
    id: 'pkg-api-task',
    name: 'API 包任务',
    category: 'system',
    risk: 'safe',
    targets: [],
    async scan(scanCtx) { scanCtx.emit({ path: 'C:/cordclean-test/api.log', size: 2 }) },
  }))
}
`

function makePackage(id: string, overrides: Record<string, unknown> = {}, code = CODE): string {
  const dir = path.join(root, 'sources', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify(
      {
        id,
        name: `API 插件包 ${id}`,
        version: '1.0.0',
        apiVersion: 2,
        engines: { cordclean: '>=0.5.0 <1.0.0' },
        kind: 'cleaner',
        entry: 'index.mjs',
        client: { mode: 'declarative' },
        permissions: { services: ['cleaner', 'ui'], fsRoots: [], network: false, subprocess: false },
        ...overrides,
      },
      null,
      2,
    ),
    'utf8',
  )
  writeFileSync(path.join(dir, 'index.mjs'), code, 'utf8')
  return dir
}

async function boot(name: string): Promise<{ app: App; handlers: HandlerMap }> {
  const dataDir = path.join(root, 'data', name)
  mkdirSync(dataDir, { recursive: true })
  const app = await createApp({ dataDir, manifest: [], logger: false })
  const handlers = createHandlers({ ctx: app.ctx, dataDir, version: app.version, bootMs: app.bootMs, shell })
  return { app, handlers }
}

describe('v2 插件包 RPC', () => {
  it('inspect-package 返回清单、权限与空错误列表', async () => {
    const { app, handlers } = await boot('inspect')
    try {
      const review = await handlers['plugins/inspect-package']({ path: makePackage('pkg-api-demo') })
      expect(review.manifest?.id).toBe('pkg-api-demo')
      expect(review.manifest?.permissions.services).toEqual(['cleaner', 'ui'])
      expect(review.errors).toEqual([])
      expect(review.warnings).toEqual([])
      expect(review.installedVersion).toBeUndefined()
    } finally {
      await app.dispose()
    }
  })

  it('inspect-package 对非法清单返回错误而不是抛异常', async () => {
    const { app, handlers } = await boot('inspect-bad')
    try {
      const review = await handlers['plugins/inspect-package']({ path: makePackage('pkg-bad', { apiVersion: 1 }) })
      expect(review.errors.map((item) => item.code)).toContain('unsupported-api-version')
      expect(review.manifest).toBeUndefined()
    } finally {
      await app.dispose()
    }
  })

  it('inspect-package 对不兼容 engines 返回错误', async () => {
    const { app, handlers } = await boot('inspect-compat')
    try {
      const review = await handlers['plugins/inspect-package']({
        path: makePackage('pkg-future', { engines: { cordclean: '>=9.0.0 <10.0.0' } }),
      })
      expect(review.errors.map((item) => item.code)).toContain('engines-mismatch')
      expect(review.manifest?.id).toBe('pkg-future')
    } finally {
      await app.dispose()
    }
  })

  it('install-package 安装后可在 plugins/list 中看到', async () => {
    const { app, handlers } = await boot('install')
    try {
      const result = await handlers['plugins/install-package']({ path: makePackage('pkg-install') })
      expect(result.id).toBe('external:pkg-install')
      const list = await handlers['plugins/list'](undefined as never)
      const plugin = list.find((item) => item.id === 'external:pkg-install')
      expect(plugin).toBeDefined()
      expect(plugin!.manifest?.id).toBe('pkg-install')
      expect(plugin!.enabled).toBe(true)
    } finally {
      await app.dispose()
    }
  })

  it('install-package 拒绝不兼容插件与重复安装', async () => {
    const { app, handlers } = await boot('install-reject')
    try {
      await expect(
        handlers['plugins/install-package']({
          path: makePackage('pkg-incompatible', { engines: { cordclean: '>=9.0.0' } }),
        }),
      ).rejects.toBeDefined()

      const source = makePackage('pkg-twice')
      await handlers['plugins/install-package']({ path: source })
      await expect(handlers['plugins/install-package']({ path: source })).rejects.toBeDefined()
    } finally {
      await app.dispose()
    }
  })

  it('uninstall-package 卸载后列表消失，package-problems 可查询', async () => {
    const { app, handlers } = await boot('uninstall')
    try {
      expect(await handlers['plugins/package-problems'](undefined as never)).toEqual([])
      await handlers['plugins/install-package']({ path: makePackage('pkg-uninstall') })
      await handlers['plugins/uninstall-package']({ id: 'external:pkg-uninstall' })
      const list = await handlers['plugins/list'](undefined as never)
      expect(list.some((item) => item.id === 'external:pkg-uninstall')).toBe(false)
    } finally {
      await app.dispose()
    }
  })
})
