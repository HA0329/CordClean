/**
 * 架构边界测试（路线 3B 第一步）。
 * 不做目录搬迁，先用测试把依赖方向钉住：core 不得依赖外壳/UI，插件不得依赖内核实现。
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (/\.(ts|vue)$/.test(entry.name)) out.push(full)
  }
  return out
}

function findImports(files: string[], forbidden: RegExp): string[] {
  const hits: string[] = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const lines = text.split(/\r?\n/)
    lines.forEach((line, index) => {
      if (/^\s*(\/\/|\*)/.test(line)) return
      if (/from\s+['"]/.test(line) && forbidden.test(line)) hits.push(`${path.relative(process.cwd(), file)}:${index + 1}`)
    })
  }
  return hits
}

const coreFiles = walk(path.join(process.cwd(), 'packages/core/src')).filter((file) => !file.endsWith('manifest.ts'))
const pluginFiles = walk(path.join(process.cwd(), 'packages/plugins'))

describe('架构依赖边界', () => {
  it('内核不依赖外壳、UI 或具体插件包', () => {
    expect(findImports(coreFiles, /@cordclean\/(host|ui|plugin-)/)).toEqual([])
  })

  it('插件不直接依赖内核实现，只依赖 shared/utils', () => {
    expect(findImports(pluginFiles, /@cordclean\/core/)).toEqual([])
  })
})
