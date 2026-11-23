/**
 * 撤销上次清理：逐条失败原因（不再只报数量）。
 *
 * 覆盖：
 * - 后端返回 failures[{path,reason}] 时生成「原始路径 — 失败原因」列表；
 * - 旧内核只有 failed 数量时仍可展示（details 为空）；
 * - 路径/原因缺失、超长、超量时的兜底与截断；
 * - 回收站/永久删除边界提示。
 */
import { describe, expect, it } from 'vitest'
import { describeUndoResult } from '../packages/ui/src/views/history-view-model.ts'

describe('撤销结果逐条原因', () => {
  it('部分失败：给出逐条「路径 — 原因」+ 边界提示', () => {
    const view = describeUndoResult({
      restored: 2,
      recyclePending: 3,
      permanent: 1,
      failed: 2,
      failures: [
        { id: 'q1', path: 'C:\\Users\\me\\AppData\\Local\\Temp\\a.log', reason: '原路径已存在同名文件' },
        { id: 'q2', path: 'C:\\Users\\me\\AppData\\Local\\Temp\\b.log', reason: '隔离文件已不存在' },
      ],
    })
    expect(view.failedCount).toBe(2)
    expect(view.details).toHaveLength(2)
    expect(view.details[0]).toBe('C:\\Users\\me\\AppData\\Local\\Temp\\a.log — 原路径已存在同名文件')
    expect(view.title).toContain('2 项')
    expect(view.message).toContain('回收站 3 项')
    expect(view.message).toContain('永久删除 1 项')
    expect(view.tone).toBe('warning')
  })

  it('全部成功不再显示失败详情', () => {
    const view = describeUndoResult({ restored: 5, recyclePending: 0, permanent: 0, failed: 0, failures: [] })
    expect(view.failedCount).toBe(0)
    expect(view.details).toEqual([])
    expect(view.tone).toBe('success')
    expect(view.title).toBe('撤销完成')
  })

  it('旧内核只给 failed 数量：仍提示失败但无逐条详情', () => {
    const view = describeUndoResult({ restored: 1, recyclePending: 0, permanent: 0, failed: 2 })
    expect(view.failedCount).toBe(2)
    expect(view.details).toEqual([])
    expect(view.title).toContain('2 项')
  })

  it('路径/原因缺失时给可读占位，不出现空白行', () => {
    const view = describeUndoResult({ restored: 0, failed: 2, failures: [{}, { path: 'D:\\x', reason: '' }] })
    expect(view.details[0]).toBe('未知原始路径 — 未知原因')
    expect(view.details[1]).toBe('D:\\x — 未知原因')
    expect(view.details.every((line) => line.includes(' — '))).toBe(true)
  })

  it('超长内容截断、最多展示 50 条', () => {
    const longPath = 'C:\\' + 'a'.repeat(800)
    const view = describeUndoResult({
      restored: 0,
      failed: 120,
      failures: Array.from({ length: 120 }, (_, index) => ({ path: longPath + index, reason: '原因'.repeat(500) })),
    })
    expect(view.failedCount).toBe(120)
    expect(view.details).toHaveLength(50)
    expect(view.details[0].length).toBeLessThan(1200)
  })
})
