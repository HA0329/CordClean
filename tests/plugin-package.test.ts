import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PLUGIN_PACKAGES_DIR, scanPluginPackages } from '@cordclean/core'

const root = mkdtempSync(path.join(os.tmpdir(), 'cordclean-plugin-package-'))

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function createPluginsDir(name: string): string {
  const dir = path.join(root, name, PLUGIN_PACKAGES_DIR)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writePackage(
  pluginsDir: string,
  id: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = { 'index.mjs': "export const name = 'x'\nexport function apply() {}\n" },
): void {
  const dir = path.join(pluginsDir, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8')
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
}

function validManifest(id: string): Record<string, unknown> {
  return {
    id,
    name: `演示插件 ${id}`,
    version: '1.0.0',
    apiVersion: 2,
    engines: { cordclean: '>=0.5.0 <1.0.0' },
    kind: 'widget',
    entry: 'index.mjs',
    permissions: { services: ['ui'], network: false, subprocess: false },
  }
}

describe('插件包目录扫描', () => {
  it('目录不存在时返回空结果', async () => {
    const result = await scanPluginPackages(path.join(root, 'not-exist', 'plugins'))
    expect(result.packages).toEqual([])
    expect(result.problems).toEqual([])
    expect(result.legacy).toEqual([])
  })

  it('读取合法插件包（含客户端页面与配置 schema）', async () => {
    const pluginsDir = createPluginsDir('valid')
    writePackage(
      pluginsDir,
      'demo',
      {
        ...validManifest('demo'),
        client: { mode: 'page', entry: 'client/index.html' },
        configSchema: 'config.schema.json',
      },
      {
        'index.mjs': "export const name = 'demo'\nexport function apply() {}\n",
        'client/index.html': '<!doctype html><title>demo</title>',
        'config.schema.json': '{"type":"object"}',
      },
    )

    const result = await scanPluginPackages(pluginsDir)
    expect(result.problems).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.packages).toHaveLength(1)
    const plugin = result.packages[0]!
    expect(plugin.manifest.id).toBe('demo')
    expect(plugin.entryPath.endsWith('index.mjs')).toBe(true)
    expect(plugin.clientEntryPath?.endsWith(path.join('client', 'index.html'))).toBe(true)
    expect(plugin.configSchemaPath?.endsWith('config.schema.json')).toBe(true)
  })

  it('缺少入口文件时记为 problem', async () => {
    const pluginsDir = createPluginsDir('missing-entry')
    writePackage(pluginsDir, 'broken', validManifest('broken'), {})
    const result = await scanPluginPackages(pluginsDir)
    expect(result.packages).toHaveLength(0)
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]!.errors.map((item) => item.code)).toContain('missing-file')
  })

  it('非法 JSON 与缺少清单都会输出 problem', async () => {
    const pluginsDir = createPluginsDir('bad')
    mkdirSync(path.join(pluginsDir, 'no-manifest'), { recursive: true })
    mkdirSync(path.join(pluginsDir, 'bad-json'), { recursive: true })
    writeFileSync(path.join(pluginsDir, 'bad-json', 'plugin.json'), '{ not json', 'utf8')

    const result = await scanPluginPackages(pluginsDir)
    expect(result.problems).toHaveLength(2)
    const codes = result.problems.flatMap((problem) => problem.errors.map((item) => item.code))
    expect(codes).toContain('missing-manifest')
    expect(codes).toContain('invalid-json')
  })

  it('传入 appVersion 时执行兼容检查', async () => {
    const pluginsDir = createPluginsDir('compat')
    writePackage(pluginsDir, 'future', {
      ...validManifest('future'),
      engines: { cordclean: '>=0.9.0 <1.0.0' },
    })
    const result = await scanPluginPackages(pluginsDir, { appVersion: '0.5.18' })
    expect(result.packages).toHaveLength(0)
    expect(result.problems[0]!.errors.map((item) => item.code)).toContain('engines-mismatch')
  })

  it('同名 id 只保留第一个，后续记为 duplicate-id', async () => {
    const pluginsDir = createPluginsDir('duplicate')
    writePackage(pluginsDir, 'one', validManifest('same'))
    writePackage(pluginsDir, 'two', validManifest('same'))
    const result = await scanPluginPackages(pluginsDir)
    expect(result.packages).toHaveLength(1)
    expect(result.problems[0]!.errors.map((item) => item.code)).toContain('duplicate-id')
  })

  it('顶层单文件插件作为 legacy 候选', async () => {
    const pluginsDir = createPluginsDir('legacy')
    writeFileSync(path.join(pluginsDir, 'old-plugin.mjs'), 'export default {}\n', 'utf8')
    const result = await scanPluginPackages(pluginsDir)
    expect(result.packages).toEqual([])
    expect(result.legacy).toHaveLength(1)
    expect(result.legacy[0]!.name).toBe('old-plugin')
  })

  it('id 与目录名不一致只产生警告', async () => {
    const pluginsDir = createPluginsDir('mismatch')
    writePackage(pluginsDir, 'folder-name', validManifest('actual-id'))
    const result = await scanPluginPackages(pluginsDir)
    expect(result.packages).toHaveLength(1)
    expect(result.warnings.map((item) => item.code)).toContain('id-directory-mismatch')
  })
})
