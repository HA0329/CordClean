/**
 * 清理页展示模型单测：筛选容错、会话恢复、空状态分类、结果概要。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CLEAN_FILTERS,
  MAX_PERSISTED_SELECTION,
  emptyResultKind,
  parseCleanSession,
  restoreSelection,
  resultSummary,
  sanitizeFilters,
  shouldRestoreSession,
} from '../packages/ui/src/views/clean-view-model.ts'

describe('筛选容错', () => {
  it('空/非法值回默认，不抛错', () => {
    expect(sanitizeFilters(undefined)).toEqual(DEFAULT_CLEAN_FILTERS)
    expect(sanitizeFilters({ risk: 'nope', size: 'x', task: 42, search: 7, onlyRecommended: 'yes' })).toEqual({
      search: '',
      risk: 'all',
      size: 'all',
      task: 'all',
      onlyRecommended: false,
    })
  })

  it('合法值保留，搜索词与任务 id 限长', () => {
    const long = 'x'.repeat(500)
    const filters = sanitizeFilters({ search: long, risk: 'risky', size: '100mb', task: long, onlyRecommended: true })
    expect(filters.search).toHaveLength(200)
    expect(filters.task).toHaveLength(120)
    expect(filters.risk).toBe('risky')
    expect(filters.size).toBe('100mb')
    expect(filters.onlyRecommended).toBe(true)
  })
})

describe('页面会话解析', () => {
  it('坏 JSON / 缺 scanId / 非对象全部丢弃', () => {
    expect(parseCleanSession(null)).toBeUndefined()
    expect(parseCleanSession('not-json')).toBeUndefined()
    expect(parseCleanSession('[]')).toBeUndefined()
    expect(parseCleanSession('{"selectedIds":["a"]}')).toBeUndefined()
  })

  it('解析合法会话并过滤非法 id / 截断超大选择集', () => {
    const many = Array.from({ length: MAX_PERSISTED_SELECTION + 20 }, (_, index) => `id-${index}`)
    const session = parseCleanSession(
      JSON.stringify({ scanId: 'scan-1', savedAt: 1000, filters: { risk: 'safe' }, selectedIds: [...many, 42], recommend: { minSize: 1024 } }),
    )
    expect(session?.scanId).toBe('scan-1')
    expect(session?.filters.risk).toBe('safe')
    expect(session?.selectedIds).toHaveLength(MAX_PERSISTED_SELECTION)
    expect(session?.selectedIds.every((id) => typeof id === 'string')).toBe(true)
    expect(session?.recommend).toEqual({ minSize: 1024, includeCaution: false })
  })
})

describe('会话恢复条件', () => {
  const session = { scanId: 'scan-1', savedAt: 5_000, filters: DEFAULT_CLEAN_FILTERS, selectedIds: ['a'], recommend: { minSize: 0, includeCaution: false } }

  it('同 scanId 且 24 小时内才恢复', () => {
    expect(shouldRestoreSession(session, 'scan-1', 6_000)).toBe(true)
    expect(shouldRestoreSession(session, 'scan-2', 6_000)).toBe(false)
    expect(shouldRestoreSession(session, undefined, 6_000)).toBe(false)
    expect(shouldRestoreSession(session, 'scan-1', 5_000 + 24 * 3600 * 1000 + 1)).toBe(false)
  })

  it('恢复选择时剔除已不存在/受保护的 id', () => {
    const restored = restoreSelection(
      { ...session, selectedIds: ['a', 'gone', 'protected'] },
      new Set(['a', 'protected']),
      new Set(['protected']),
    )
    expect(restored).toEqual(['a'])
  })
})

describe('空状态分类', () => {
  const base = { hasScan: true, scanning: false, cleanableCount: 0, protectedCount: 0, filteredCount: 0, filtersActive: false }

  it('扫描中不显示空结果', () => {
    expect(emptyResultKind({ ...base, scanning: true })).toBe('scanning')
  })

  it('没有扫描结果时不显示空状态卡片', () => {
    expect(emptyResultKind({ ...base, hasScan: false })).toBeUndefined()
  })

  it('真的没有可清理项 / 只有受保护项', () => {
    expect(emptyResultKind(base)).toBe('none')
    expect(emptyResultKind({ ...base, protectedCount: 3 })).toBe('protected-only')
  })

  it('有结果但被筛选藏掉', () => {
    expect(emptyResultKind({ ...base, cleanableCount: 10, filteredCount: 0, filtersActive: true })).toBe('filtered')
    expect(emptyResultKind({ ...base, cleanableCount: 10, filteredCount: 4, filtersActive: true })).toBeUndefined()
  })
})

describe('结果概要', () => {
  it('没有可清理项时给明确文案', () => {
    expect(resultSummary({ cleanableCount: 0, cleanableBytes: 0, taskCount: 0, recommendedCount: 0, recommendedBytes: 0 })).toContain('没有可自动清理')
  })

  it('正常结果包含数量/体积/任务/推荐', () => {
    const text = resultSummary({ cleanableCount: 1234, cleanableBytes: 5 * 1024 ** 3, taskCount: 7, recommendedCount: 19, recommendedBytes: 768 * 1024 ** 2 })
    expect(text).toContain('1,234')
    expect(text).toContain('5.00 GB')
    expect(text).toContain('7 个任务')
    expect(text).toContain('768 MB')
  })
})
