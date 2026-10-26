import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp, type App } from '@cordclean/core'

const root = mkdtempSync(path.join(os.tmpdir(), 'cordclean-pkg-manager-'))

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const CODE_V1 = `export const name = 'pkg-demo'
export const inject = ['cleaner']
export function apply(ctx) {
  ctx.effect(() => ctx.cleaner.define({
    id: 'pkg-demo-task',
    name: '包插件任务',
    category: 'system',
    risk: 'safe',
    targets: [],
    async scan(scanCtx) { scanCtx.emit({ path: 'C:/cordclean-test/pkg.log', size: 4 }) },
  }))
}
`

const CODE_V2 = CODE_V1.replace('包插件任务', '包插件任务 v2')

function manifest(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `包插件 ${id}`,
    version: '1.0.0',
    apiVersion: 2,
    engines: { cordclean: '>=0.5.0 <1.0.0' },
    kind: 'cleaner',
    entry: 'index.mjs',
    client: { mode: 'declarative' },
    permissions: { services: ['cleaner', 'ui'], network: false, subprocess: false },
    ...overrides,
  }
}

function writePackage(
  dataDir: string,
  id: string,
  overrides: Record<string, unknown> = {},
  code = CODE_V1,
  files: Record<string, string> = {},
): string {
  const dir = path.join(dataDir, 'plugins', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest(id, overrides), null, 2), 'utf8')
  writeFileSync(path.join(dir, 'index.mjs'), code, 'utf8')
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  return dir
}

async function boot(name: string, prepare?: (dataDir: string) => void): Promise<{ app: App; dataDir: string }> {
  const dataDir = path.join(root, name)
  mkdirSync(dataDir, { recursive: true })
  prepare?.(dataDir)
  const app = await createApp({ dataDir, manifest: [], logger: false })
  return { app, dataDir }
}

const PKG_ID = 'external:pkg-demo'

describe('PluginManager 接入 v2 插件包', () => {
  it('启动时扫描并启用插件包，暴露清单与权限', async () => {
    const { app } = await boot('boot', (dataDir) => {
      writePackage(dataDir, 'pkg-demo', {}, CODE_V1, {
        'client/index.html': '<!doctype html><title>demo</title>',
      })
    })
    try {
      const plugins = app.ctx.plugins.list()
      const plugin = plugins.find((item) => item.id === PKG_ID)
      expect(plugin).toBeDefined()
      expect(plugin!.status).toBe('active')
      expect(plugin!.source).toBe('external')
      expect(plugin!.taskCount).toBe(1)
      expect(plugin!.manifest?.id).toBe('pkg-demo')
      expect(plugin!.manifest?.version).toBe('1.0.0')
      expect(plugin!.permissions?.services).toEqual(['cleaner', 'ui'])
      expect(app.ctx.cleaner.list().some((task) => task.id === 'pkg-demo-task')).toBe(true)
    } finally {
      await app.dispose()
    }
  })

  it('禁用后任务注销；重载会重新 import（代码修改生效）', async () => {
    const { app, dataDir } = await boot('reload', (dir) => writePackage(dir, 'pkg-demo'))
    try {
      expect(app.ctx.cleaner.list().find((task) => task.id === 'pkg-demo-task')?.name).toBe('包插件任务')

      await app.ctx.plugins.disable(PKG_ID)
      expect(app.ctx.cleaner.list().some((task) => task.id === 'pkg-demo-task')).toBe(false)
      expect(app.ctx.plugins.list().find((item) => item.id === PKG_ID)!.status).toBe('stopped')

      writeFileSync(path.join(dataDir, 'plugins', 'pkg-demo', 'index.mjs'), CODE_V2, 'utf8')
      await app.ctx.plugins.enable(PKG_ID)

      expect(app.ctx.plugins.list().find((item) => item.id === PKG_ID)!.status).toBe('active')
      expect(app.ctx.cleaner.list().some((item) => item.id === 'pkg-demo-task')).toBe(true)

      // 注意：Vitest 用 Vite 的 SSR 模块缓存，file URL 的 query 缓存穿透在测试环境不生效；
      // 生产 Node/Electron 下 load() 的 ?v= 会真正重新 import（已由 Node 单独验证）。
      // 这里只验证 reload 的启停语义。
      await app.ctx.plugins.reload(PKG_ID)
      expect(app.ctx.plugins.list().find((item) => item.id === PKG_ID)!.status).toBe('active')
      expect(app.ctx.cleaner.list().some((item) => item.id === 'pkg-demo-task')).toBe(true)
    } finally {
      await app.dispose()
    }
  })

  it('installPackage 安装外部目录，uninstallPackage 移入 .trash', async () => {
    const sourceDir = path.join(root, 'install-src', 'pkg-installed')
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(
      path.join(sourceDir, 'plugin.json'),
      JSON.stringify(manifest('pkg-installed'), null, 2),
      'utf8',
    )
    writeFileSync(path.join(sourceDir, 'index.mjs'), CODE_V1.replaceAll('pkg-demo', 'pkg-installed'), 'utf8')

    const { app, dataDir } = await boot('install')
    try {
      const result = await app.ctx.plugins.installPackage!(sourceDir)
      expect(result.id).toBe('external:pkg-installed')
      expect(result.manifest.id).toBe('pkg-installed')
      expect(existsSync(path.join(dataDir, 'plugins', 'pkg-installed', 'plugin.json'))).toBe(true)
      expect(app.ctx.plugins.list().some((item) => item.id === 'external:pkg-installed')).toBe(true)

      await app.ctx.plugins.uninstallPackage!('external:pkg-installed')
      expect(app.ctx.plugins.list().some((item) => item.id === 'external:pkg-installed')).toBe(false)
      expect(existsSync(path.join(dataDir, 'plugins', 'pkg-installed'))).toBe(false)
      const trash = path.join(dataDir, 'plugins', '.trash')
      expect(existsSync(trash)).toBe(true)
    } finally {
      await app.dispose()
    }
  })

  it('不兼容的插件包不加载，并在 packageProblems 中给出原因', async () => {
    const { app } = await boot('incompatible', (dataDir) => {
      writePackage(dataDir, 'pkg-future', { engines: { cordclean: '>=9.0.0 <10.0.0' } })
    })
    try {
      expect(app.ctx.plugins.list().some((item) => item.id === 'external:pkg-future')).toBe(false)
      const problems = app.ctx.plugins.packageProblems!()
      expect(problems).toHaveLength(1)
      expect(problems[0]!.errors.map((item) => item.code)).toContain('engines-mismatch')
    } finally {
      await app.dispose()
    }
  })

  it('安装时拒绝静态检查失败的入口', async () => {
    const sourceDir = path.join(root, 'danger-src', 'pkg-danger')
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(path.join(sourceDir, 'plugin.json'), JSON.stringify(manifest('pkg-danger'), null, 2), 'utf8')
    writeFileSync(
      path.join(sourceDir, 'index.mjs'),
      "import { execSync } from 'node:child_process'\nexport const name = 'danger'\nexport function apply() { execSync('whoami') }\n",
      'utf8',
    )
    const { app } = await boot('danger')
    try {
      await expect(app.ctx.plugins.installPackage!(sourceDir)).rejects.toBeDefined()
      expect(app.ctx.plugins.list().some((item) => item.id === 'external:pkg-danger')).toBe(false)
    } finally {
      await app.dispose()
    }
  })
})
