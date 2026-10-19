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
})
