/**
 * 测试辅助：构造临时沙箱与「假插件」。
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defineCleanerPlugin } from '@cordclean/shared'
import { walk } from '@cordclean/utils'
import type { PluginManifestEntry } from '@cordclean/core'

export interface Sandbox {
  root: string
  dataDir: string
  dir(name: string): string
  file(relative: string, content: string): string
}

/** 创建临时目录沙箱 */
export function createSandbox(): Sandbox {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cc-test-'))
  const dataDir = path.join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  return {
    root,
    dataDir,
    dir(name: string) {
      const target = path.join(root, name)
      mkdirSync(target, { recursive: true })
      return target
    },
    file(relative: string, content: string) {
      const target = path.join(root, relative)
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, content)
      return target
    },
  }
}

export interface FakePluginOptions {
  id?: string
  /** 声明为清理辖区的目录 */
  roots: string[]
  /** 实际扫描的目录（可以与 roots 不同，用于测试「越权」场景） */
  scanDirs?: string[]
  risk?: 'safe' | 'caution' | 'risky'
  defaultSelected?: boolean
}

/** 构造一个「扫描目录下所有文件」的假清理插件 */
export function fakeFilesPlugin(options: FakePluginOptions) {
  return defineCleanerPlugin({
    name: options.id ?? 'fake',
    description: '测试用插件',
    inject: ['cleaner', 'pathPolicy', 'system'],
    setup(ctx) {
      ctx.effect(() => {
        const disposers = options.roots.map((root) => ctx.pathPolicy.addRoot(root, 'fake'))
        return () => disposers.forEach((dispose) => dispose())
      })
      ctx.effect(() =>
        ctx.cleaner.define({
          id: `${options.id ?? 'fake'}-files`,
          name: '测试文件',
          category: 'disk',
          risk: options.risk ?? 'safe',
          defaultSelected: options.defaultSelected ?? true,
          async scan(scan) {
            for (const dir of options.scanDirs ?? options.roots) {
              for await (const entry of walk(dir, { signal: scan.signal })) {
                if (entry.isDirectory) continue
                scan.emit({ path: entry.path, size: entry.size })
              }
            }
          },
        }),
      )
    },
  })
}

/** 构造清单项 */
export function manifestOf(entries: Array<{ id: string; plugin: any; defaultEnabled?: boolean }>): PluginManifestEntry[] {
  return entries.map((entry) => ({
    id: entry.id,
    name: entry.id,
    description: `${entry.id} 测试插件`,
    category: 'system' as const,
    defaultEnabled: entry.defaultEnabled ?? true,
    async load() {
      return { default: entry.plugin }
    },
  }))
}
