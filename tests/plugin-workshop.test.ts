import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  cleanupGeneratedPlugin,
  generatedPluginPath,
  saveGeneratedPlugin,
  validatePluginCode,
} from '../packages/host/src/plugin-workshop.ts'

const GOOD = `
export default {
  name: 'demo-plugin',
  version: '1.0.0',
  description: '演示插件',
  capabilities: { fsRoots: ['%TEMP%'] },
  Config(raw) {
    return { dir: String(raw.dir ?? '') }
  },
  setup(ctx, config) {
    const base = String(config.dir || ctx.system.env.get('TEMP') || '')
    ctx.cleaner.define({
      id: 'demo', name: 'Demo', category: 'system', risk: 'safe', icon: 'x',
      defaultSelected: true, targets: [base], scan(scan) {
        scan.emit({ path: base, kind: 'folder', size: 0 })
      },
    })
  },
}
`

describe('AI 插件工坊校验', () => {
  it('接受符合契约、语法正确的插件', async () => {
    const result = await validatePluginCode(GOOD)
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('拒绝直接删除文件与子进程', async () => {
    const bad = GOOD.replace("ctx.cleaner.define({", "import fs from 'node:fs'\nfs.rmSync('C:/x')\nctx.cleaner.define({")
    const result = await validatePluginCode(bad)
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toContain('禁止直接删除文件')
  })

  it('拒绝语法错误', async () => {
    const result = await validatePluginCode('export default {')
    expect(result.ok).toBe(false)
    expect(result.errors.some((item) => item.includes('语法错误'))).toBe(true)
  })

  it('有依赖时写入独立插件目录与 package.json', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cc-workshop-pkg-'))
    try {
      const file = saveGeneratedPlugin(dir, 'dep-plugin', 'export default { name: "dep-plugin", setup() {} }', { 'fast-glob': '^3.3.2' })
      expect(file.endsWith(path.join('dep-plugin', 'plugin.mjs'))).toBe(true)
      const pkg = JSON.parse(
        readFileSync(path.join(dir, 'generated-plugins', 'dep-plugin', 'package.json'), 'utf8'),
      )
      expect(pkg.dependencies).toEqual({ 'fast-glob': '^3.3.2' })
      expect(pkg.type).toBe('module')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('失败回滚/卸载可以清理生成的插件文件或依赖目录', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cc-workshop-clean-'))
    try {
      const single = saveGeneratedPlugin(dir, 'one', 'export default { name: "one", setup() {} }')
      expect(generatedPluginPath(dir, 'one')).toBe(single)
      cleanupGeneratedPlugin(dir, 'one')
      expect(() => readFileSync(single, 'utf8')).toThrow()

      const depFile = saveGeneratedPlugin(dir, 'two', 'export default { name: "two", setup() {} }', { 'is-number': '^7.0.0' })
      cleanupGeneratedPlugin(dir, 'two', { 'is-number': '^7.0.0' })
      expect(() => readFileSync(depFile, 'utf8')).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

