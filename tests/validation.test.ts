import { describe, expect, it } from 'vitest'
import { validateParams } from '../packages/host/src/validation.ts'

describe('RPC 入参校验', () => {
  it('拒绝缺少必填字段的请求', () => {
    expect(validateParams('plugins/enable', {}).ok).toBe(false)
    expect(validateParams('clean/start', {}).ok).toBe(false)
    expect(validateParams('settings/patch', { patch: [] }).ok).toBe(false)
  })

  it('接受合法参数与非对象空参', () => {
    expect(validateParams('plugins/enable', { id: 'ai' }).ok).toBe(true)
    expect(validateParams('clean/start', { itemIds: ['a'] }).ok).toBe(true)
    expect(validateParams('app/quit', undefined).ok).toBe(true)
  })
})
