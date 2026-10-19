import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ExternalPluginProxy } from '../packages/core/src/domains/kernel/external-proxy.ts'
import { createSandbox } from './helpers.ts'

const sandbox = createSandbox()
const write = (name: string, code: string) => {
  const file = path.join(sandbox.root, name)
  writeFileSync(file, code, 'utf8')
  return file
}

const GOOD = `
export default {
  name: 'fixture-plugin',
  version: '1.0.0',
  capabilities: { fsRoots: ['C:\\\\Temp'] },
  async setup(ctx) {
    ctx.cleaner.define({
      id: 'fixture-task', name: 'Fixture', category: 'system', risk: 'safe',
      targets: [], scan(scan) { scan.emit({ path: 'C:\\\\Temp\\\\a.tmp', kind: 'file', size: 3 }) },
    })
  },
}
`

describe('外部插件跨线程代理', () => {
  it('describe 返回任务元数据，scan 在 worker 中执行', async () => {
    const { proxy, info } = await ExternalPluginProxy.create(write('good.mjs', GOOD))
    try {
      expect(info.name).toBe('fixture-plugin')
      expect(info.tasks).toHaveLength(1)
      expect(info.tasks[0]).toMatchObject({ id: 'fixture-task', risk: 'safe' })
      const items = await proxy.scan('fixture-task')
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({ path: 'C:\\Temp\\a.tmp', size: 3 })
    } finally {
      await proxy.dispose()
    }
  })

  it('setup 抛错时 create 直接失败，不影响主进程', async () => {
    const bad = write('bad.mjs', "export default { name: 'bad', async setup(){ throw new Error('bad setup') } }")
    await expect(ExternalPluginProxy.create(bad, { timeoutMs: 2000 })).rejects.toThrow(/bad setup/)
  })
it('configure 在同一个 worker 内重新校验配置并生效', async () => {
    const file = write('configurable.mjs', `
export default {
  name: 'cfg-plugin',
  capabilities: { fsRoots: ['C:\\\\Temp'] },
  Config(raw) { const size = Number(raw.size ?? 1); if (size < 0) throw new Error('size 不能为负'); return { size } },
  async setup(ctx, config) {
    ctx.cleaner.define({
      id: 'cfg-task', name: 'Cfg', category: 'system', risk: 'safe', targets: [],
      scan(scan) { scan.emit({ path: 'C:\\\\Temp\\\\x.tmp', kind: 'file', size: config.size }) },
    })
  },
}
`)
    const { proxy } = await ExternalPluginProxy.create(file)
    try {
      const before = await proxy.scan('cfg-task')
      expect(before[0]).toMatchObject({ size: 1 })
      const info = await proxy.configure({ size: 7 })
      expect(info.tasks).toHaveLength(1)
      const after = await proxy.scan('cfg-task')
      expect(after[0]).toMatchObject({ size: 7 })
      await expect(proxy.configure({ size: -1 })).rejects.toThrow(/size/)
    } finally {
      await proxy.dispose()
    }
  })
})