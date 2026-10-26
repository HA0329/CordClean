import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  PluginInstallError,
  installPluginPackage,
  removePluginPackage,
  stagePluginPackage,
} from '@cordclean/core'

const root = mkdtempSync(path.join(os.tmpdir(), 'cordclean-installer-'))

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const APP_VERSION = '0.5.18'

function makeSource(name: string, overrides: Record<string, unknown> = {}, files: Record<string, string> = {}): string {
  const dir = path.join(root, 'sources', name)
  mkdirSync(dir, { recursive: true })
  const manifest = {
    id: name,
    name: `安装测试 ${name}`,
    version: '1.0.0',
    apiVersion: 2,
    engines: { cordclean: '>=0.5.0 <1.0.0' },
    kind: 'widget',
    entry: 'index.mjs',
    permissions: { services: ['ui'], network: false, subprocess: false },
    ...overrides,
  }
  writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8')
  const defaultFiles: Record<string, string> = {
    'index.mjs': "export const name = 'x'\nexport function apply() {}\n",
  }
  for (const [relative, content] of Object.entries({ ...defaultFiles, ...files })) {
    const target = path.join(dir, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  return dir
}

function pluginsDir(name: string): string {
  return path.join(root, name, 'plugins')
}

const CODE_WITH_TASK = `export const name = 'pkg-demo'
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

describe('v2 插件包安装事务', () => {
  it('stage + commit 安装成功，暂存目录被清理', async () => {
    const source = makeSource('ok')
    const dir = pluginsDir('ok')
    const result = await installPluginPackage({ pluginsDir: dir, sourceDir: source, appVersion: APP_VERSION })
    expect(result.id).toBe('ok')
    expect(result.dir).toBe(path.join(dir, 'ok'))
    expect(existsSync(result.dir)).toBe(true)
    expect(existsSync(path.join(dir, '.staging'))).toBe(false)
    const loaded = await import(pathToFileURL(path.join(result.dir, 'index.mjs')).href + '?t=' + Date.now())
    expect(loaded.name).toBe('x')
  })

  it('重复安装返回 already-installed，且不破坏已安装版本', async () => {
    const source = makeSource('dup')
    const dir = pluginsDir('dup')
    await installPluginPackage({ pluginsDir: dir, sourceDir: source, appVersion: APP_VERSION })
    await expect(
      installPluginPackage({ pluginsDir: dir, sourceDir: source, appVersion: APP_VERSION }),
    ).rejects.toMatchObject({ code: 'already-installed' })
    expect(existsSync(path.join(dir, 'dup', 'plugin.json'))).toBe(true)
  })

  it('upgrade=true 替换旧版本并把旧目录移入 .trash', async () => {
    const dir = pluginsDir('upgrade')
    const v1 = makeSource('upgrade', { version: '1.0.0' })
    await installPluginPackage({ pluginsDir: dir, sourceDir: v1, appVersion: APP_VERSION })
    const v2 = makeSource('upgrade-v2', { id: 'upgrade', version: '2.0.0' })
    const result = await installPluginPackage({ pluginsDir: dir, sourceDir: v2, appVersion: APP_VERSION, upgrade: true })
    expect(result.version).toBe('2.0.0')
    const upgraded = JSON.parse(await readFile(path.join(dir, 'upgrade', 'plugin.json'), 'utf8'))
    expect(upgraded.version).toBe('2.0.0')
    expect(result.backupDir).toBeDefined()
    expect(existsSync(result.backupDir!)).toBe(true)
  })

  it('不兼容的 engines 在落盘前拒绝', async () => {
    const source = makeSource('future', { engines: { cordclean: '>=9.0.0 <10.0.0' } })
    await expect(
      installPluginPackage({ pluginsDir: pluginsDir('future'), sourceDir: source, appVersion: APP_VERSION }),
    ).rejects.toMatchObject({ code: 'incompatible-plugin' })
    expect(existsSync(path.join(pluginsDir('future'), 'future'))).toBe(false)
  })

  it('入口静态契约失败时拒绝并清理暂存', async () => {
    const source = makeSource('danger', {}, {
      'index.mjs': "import { execSync } from 'node:child_process'\nexport const name = 'x'\nexport function apply() { execSync('whoami') }\n",
    })
    await expect(
      installPluginPackage({ pluginsDir: pluginsDir('danger'), sourceDir: source, appVersion: APP_VERSION }),
    ).rejects.toBeInstanceOf(PluginInstallError)
    const staging = path.join(pluginsDir('danger'), '.staging')
    expect(existsSync(staging) ? readdirSync(staging).length : 0).toBe(0)
  })

  it('允许包内相对 import', async () => {
    const source = makeSource('relative', {}, {
      'index.mjs': "import { answer } from './helper.mjs'\nexport const name = 'rel'\nexport function apply() { return answer }\n",
      'helper.mjs': 'export const answer = 42\n',
    })
    const result = await installPluginPackage({
      pluginsDir: pluginsDir('relative'),
      sourceDir: source,
      appVersion: APP_VERSION,
    })
    expect(existsSync(path.join(result.dir, 'helper.mjs'))).toBe(true)
  })

  it('文件数超过上限时拒绝并清理', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 5; i++) files[`assets/${i}.txt`] = 'x'
    const source = makeSource('many', {}, files)
    await expect(
      installPluginPackage({
        pluginsDir: pluginsDir('many'),
        sourceDir: source,
        appVersion: APP_VERSION,
        limits: { maxFiles: 3 },
      }),
    ).rejects.toMatchObject({ code: 'package-too-many-files' })
  })

  it('拒绝包内符号链接（无权限创建时跳过）', async () => {
    const source = makeSource('symlink')
    try {
      symlinkSync(path.join(source, 'index.mjs'), path.join(source, 'link.mjs'))
    } catch {
      return // Windows 非管理员无法创建符号链接，跳过
    }
    await expect(
      installPluginPackage({ pluginsDir: pluginsDir('symlink'), sourceDir: source, appVersion: APP_VERSION }),
    ).rejects.toMatchObject({ code: 'symlink-not-allowed' })
  })

  it('remove 默认移入 .trash，backup=false 直接删除', async () => {
    const dir = pluginsDir('remove')
    await installPluginPackage({ pluginsDir: dir, sourceDir: makeSource('remove'), appVersion: APP_VERSION })
    const removed = await removePluginPackage(dir, 'remove')
    expect(existsSync(path.join(dir, 'remove'))).toBe(false)
    expect(existsSync(removed.backupDir!)).toBe(true)

    await installPluginPackage({ pluginsDir: dir, sourceDir: makeSource('remove2'), appVersion: APP_VERSION })
    await removePluginPackage(dir, 'remove2', { backup: false })
    expect(existsSync(path.join(dir, 'remove2'))).toBe(false)
  })

  it('stage 单独调用返回暂存目录，不落盘', async () => {
    const dir = pluginsDir('stage-only')
    const staged = await stagePluginPackage({ pluginsDir: dir, sourceDir: makeSource('stage'), appVersion: APP_VERSION })
    expect(existsSync(staged.stagingDir)).toBe(true)
    expect(existsSync(path.join(dir, 'stage'))).toBe(false)
    await removePluginPackage(dir, 'stage').catch(() => {})
    rmSync(staged.stagingDir, { recursive: true, force: true })
  })

  it('非法清单直接拒绝', async () => {
    const dir = path.join(root, 'sources', 'bad-manifest')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'x' }), 'utf8')
    await expect(
      installPluginPackage({ pluginsDir: pluginsDir('bad'), sourceDir: dir, appVersion: APP_VERSION }),
    ).rejects.toMatchObject({ code: 'invalid-manifest' })
  })
})
