import { describe, expect, it } from 'vitest'
import { validatePluginCode } from '../packages/host/src/plugin-workshop.ts'

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
  it('接受符合契约、语法正确的插件', () => {
    const result = validatePluginCode(GOOD)
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('拒绝直接删除文件与子进程', () => {
    const bad = GOOD.replace("ctx.cleaner.define({", "import fs from 'node:fs'\nfs.rmSync('C:/x')\nctx.cleaner.define({")
    const result = validatePluginCode(bad)
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toContain('禁止直接删除文件')
  })

  it('拒绝语法错误', () => {
    const result = validatePluginCode('export default {')
    expect(result.ok).toBe(false)
    expect(result.errors.some((item) => item.includes('语法错误'))).toBe(true)
  })
})
