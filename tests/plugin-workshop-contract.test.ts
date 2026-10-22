import { describe, expect, it } from 'vitest'
import { checkPluginSource } from '@cordclean/shared'
import { validatePluginCode } from '../packages/host/src/plugin-workshop.ts'

const GOOD = `import fs from 'node:fs'
import path from 'node:path'

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
      id: 'demo-task',
      name: '演示清理任务',
      category: 'apps',
      risk: 'safe',
      defaultSelected: false,
      targets: [base],
      scan(scan) {
        for (const name of fs.readdirSync(base)) {
          const full = path.join(base, name)
          try {
            const stat = fs.statSync(full)
            if (stat.isFile()) scan.emit({ path: full, kind: 'file', size: stat.size })
          } catch {}
        }
      },
    })
  },
}
`

describe('外部插件源码契约（AI 工坊生成/安装共用）', () => {
  it('接受零依赖、普通对象、带 scan 的插件', () => {
    const result = checkPluginSource(GOOD)
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
    expect(validatePluginCode(GOOD).ok).toBe(true)
  })

  it('拒绝 AI 常见的 @cordisjs/plugin-cleaner 幻觉 import', () => {
    const bad = `import { defineCleanerPlugin } from '@cordisjs/plugin-cleaner'

export default defineCleanerPlugin({
  name: 'bad-plugin',
  setup() {},
})
`
    const result = checkPluginSource(bad)
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toContain('@cordisjs')
    expect(result.errors.join(' ')).toContain('defineCleanerPlugin')
    const host = validatePluginCode(bad)
    expect(host.ok).toBe(false)
    expect(host.errors.join(' ')).toContain('外部插件')
  })

  it('拒绝项目内部包与相对路径 import', () => {
    const badShared = `import { formatBytes } from '@cordclean/shared'
export default { name: 'bad', setup() {} }
`
    expect(checkPluginSource(badShared).ok).toBe(false)
    expect(checkPluginSource(badShared).errors.join(' ')).toContain('@cordclean')

    const badRelative = `import helper from './helper.mjs'
export default { name: 'bad', setup() {} }
`
    expect(checkPluginSource(badRelative).ok).toBe(false)
    expect(checkPluginSource(badRelative).errors.join(' ')).toContain('相对路径')
  })

  it('拒绝删除/子进程等危险 API', () => {
    const bad = `import fs from 'node:fs'
export default { name: 'bad', setup() { fs.rmSync('C:/tmp') } }
`
    const result = checkPluginSource(bad)
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/删除|rmSync/)
  })
})
