import { describe, expect, it } from 'vitest'
import { parseReceipt } from '../packages/core/src/domains/safety/recycle-bin.ts'

describe('回收站回执解析', () => {
  it('解析带中文错误信息的 UTF-8 回执', () => {
    const receipt = {
      ok: ['C:\\Temp\\a.tmp'],
      failed: [{ path: 'C:\\Temp\\b.tmp', message: '文件正被占用（EBUSY）' }],
    }
    expect(parseReceipt(JSON.stringify(receipt))).toEqual(receipt)
  })

  it('容忍 stdout 前的额外输出与消息中的花括号', () => {
    const receipt = {
      ok: [],
      failed: [{ path: 'C:\\Temp\\x.tmp', message: '访问被拒绝 {code: 5}' }],
    }
    const stdout = 'Add-Type warning\n' + JSON.stringify(receipt)
    expect(parseReceipt(stdout)).toEqual(receipt)
  })

  it('空内容或非 JSON 返回 undefined', () => {
    expect(parseReceipt('')).toBeUndefined()
    expect(parseReceipt('not a receipt')).toBeUndefined()
  })
})
