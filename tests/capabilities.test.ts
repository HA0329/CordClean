import { describe, expect, it } from 'vitest'
import { validateCapabilities } from '../packages/core/src/services/plugins.ts'

describe('外部插件能力声明校验', () => {
  it('接受带合法 fsRoots 且无越权代码的插件', () => {
    const result = validateCapabilities({ capabilities: { fsRoots: ['C:\\Temp\\demo'] } }, 'export default {}')
    expect(result.fsRoots).toEqual(['C:\\Temp\\demo'])
    expect(result.network).toBe(false)
  })

  it('拒绝缺少能力声明的插件', () => {
    expect(() => validateCapabilities({}, 'export default {}')).toThrow(/声明能力/)
  })

  it('拒绝盘符根与未声明的网络/子进程代码', () => {
    expect(() => validateCapabilities({ capabilities: { fsRoots: ['C:\\'] } }, '')).toThrow(/盘符根/)
    expect(() => validateCapabilities({ capabilities: { fsRoots: [] } }, "fetch('https://x')")).toThrow(/network/)
    expect(() => validateCapabilities({ capabilities: { fsRoots: [] } }, "import('node:child_process')")).toThrow(/childProcess/)
  })
})
