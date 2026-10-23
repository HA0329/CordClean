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
  it('接受零依赖、普通对象、带 scan 的插件', async () => {
    const result = checkPluginSource(GOOD)
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
    expect((await validatePluginCode(GOOD)).ok).toBe(true)
  })

  it('拒绝 AI 常见的 @cordisjs/plugin-cleaner 幻觉 import', async () => {
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
    const host = await validatePluginCode(bad)
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

  it('声明依赖后允许 import 对应 npm 包，未声明则拒绝', () => {
    const code = `import fg from 'fast-glob'
export default {
  name: 'glob-plugin',
  capabilities: { fsRoots: ['%TEMP%'] },
  setup(ctx) {
    ctx.cleaner.define({ id: 'glob-task', name: 'Glob', category: 'apps', risk: 'safe', scan(scan) { scan.emit({ path: 'C:/Temp/a', kind: 'file', size: 1 }) } })
  },
}
`
    const declared = checkPluginSource(code, { dependencies: { 'fast-glob': '^3.3.2' } })
    expect(declared.ok).toBe(true)
    expect(declared.errors).toEqual([])

    const undeclared = checkPluginSource(code)
    expect(undeclared.ok).toBe(false)
    expect(undeclared.errors.join(' ')).toContain('fast-glob')
    expect(undeclared.errors.join(' ')).toContain('dependencies')
  })

  it('拒绝 file/git/URL 依赖规格、未锁定版本与超量依赖', () => {
    expect(checkPluginSource('export default { name: "x", setup() {} }', { dependencies: { evil: 'file:../evil' } }).ok).toBe(false)
    expect(checkPluginSource('export default { name: "x", setup() {} }', { dependencies: { evil: 'latest' } }).ok).toBe(false)
    const tooMany = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`pkg-${index}`, '^1.0.0']))
    expect(checkPluginSource('export default { name: "x", setup() {} }', { dependencies: tooMany }).ok).toBe(false)
  })

  it('原生 Cordis 模式接受 apply(ctx) + inject + 声明式 UI 贡献', async () => {
    const native = `export const name = 'native-demo'
export const kind = 'widget'
export const inject = ['ui']
export const contributes = { overviewCards: [{ id: 'demo', title: '演示', type: 'text' }] }
export function apply(ctx) {
  ctx.effect(() => ctx.ui.resolve('native-demo', 'demo', () => ({ text: 'ok' })))
}
`
    const result = checkPluginSource(native, { mode: 'native' })
    expect(result.ok).toBe(true)
    expect(result.warnings.join(' ')).not.toContain('注入')
    expect((await validatePluginCode(native, {}, 'native')).ok).toBe(true)
  })

  it('原生模式拒绝缺少 apply 的旧式对象插件', async () => {
    const old = `export default {
  name: 'old-style',
  setup(ctx) { ctx.cleaner.define({ id: 'x', name: 'X', category: 'apps', risk: 'safe', scan() {} }) },
}
`
    const result = checkPluginSource(old, { mode: 'native' })
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toContain('apply')
    expect((await validatePluginCode(old, {}, 'native')).ok).toBe(false)
  })

  it('原生模式把“使用 ctx 服务但未 inject”判为错误，而不是警告', () => {
    const bad = `export const name = 'missing-inject'
export function apply(ctx) {
  if (ctx.cleaner) ctx.logger.info('has cleaner')
}
`
    const result = checkPluginSource(bad, { mode: 'native' })
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toContain('inject')
    expect(result.errors.join(' ')).toContain('cleaner')
  })
})

