import { describe, expect, it } from 'vitest'
import { toCloneable } from '../packages/ui/src/api/client.ts'

describe('IPC 参数可克隆化', () => {
  it('代理对象/数组转成纯数据，可被 structuredClone', () => {
    const source = new Proxy({ list: [1, 2], nested: { ok: true }, skip: undefined }, {})
    const plain = toCloneable(source)
    expect(plain).toEqual({ list: [1, 2], nested: { ok: true } })
    expect(() => structuredClone(plain)).not.toThrow()
  })
})
