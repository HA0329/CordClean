/**
 * 历史与隔离区展示模型单测：
 * 坏数据规范化、筛选/排序、隔离区摘要与会话关联、空状态分型、危险操作文案、
 * 按钮禁用原因、恢复/删除结果反馈。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HISTORY_FILTERS,
  DEFAULT_QUARANTINE_FILTERS,
  clearHistoryConfirmCopy,
  clearHistoryGate,
  collectHistoryTaskIds,
  describePurgeResult,
  describeRestoreResult,
  filterHistoryRows,
  filterQuarantineRows,
  groupQuarantineSessions,
  hasHistoryFilters,
  hasQuarantineFilters,
  historyEmptyKind,
  historyQuarantineLink,
  historyTaskLabels,
  normalizeHistoryEntries,
  normalizeQuarantineRecords,
  purgeConfirmCopy,
  purgeGate,
  quarantineCountForSession,
  quarantineEmptyKind,
  restoreConfirmCopy,
  restoreGate,
  sortHistoryRows,
  summarizeHistoryRows,
  summarizeQuarantineRows,
  undoConfirmCopy,
  undoGate,
  type HistoryRow,
  type QuarantineRow,
} from '../packages/ui/src/views/history-view-model.ts'

/** 2026-11-23 20:00（本地时区），时间范围测试都相对它计算，避免依赖机器时区 */
const NOW = new Date(2026, 10, 23, 20, 0, 0).getTime()
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function historyRow(overrides: Partial<HistoryRow> = {}): HistoryRow {
  return {
    sessionId: 'session-1',
    startedAt: NOW - HOUR,
    startedAtValid: true,
    elapsedMs: 1200,
    taskIds: ['task-a'],
    freedBytes: 1024,
    recycledBytes: 0,
    quarantinedBytes: 0,
    cleaned: 10,
    quarantined: 0,
    vanished: 0,
    skipped: 0,
    failed: 0,
    dryRun: false,
    ...overrides,
  }
}

function quarantineRow(overrides: Partial<QuarantineRow> = {}): QuarantineRow {
  return {
    id: 'session-1/0001_a.tmp',
    sessionId: 'session-1',
    taskId: 'task-a',
    originalPath: 'C:\\Users\\me\\AppData\\Local\\Temp\\a.tmp',
    bytes: 1024,
    createdAt: NOW - HOUR,
    createdAtValid: true,
    ...overrides,
  }
}

describe('历史行规范化', () => {
  it('丢弃非对象/无法辨认的记录，非法字段回安全默认值', () => {
    const rows = normalizeHistoryEntries([
      null,
      'not-a-record',
      42,
      {},
      { startedAt: Number.NaN },
      {
        sessionId: ' s1 ',
        startedAt: NOW,
        taskIds: ['a', 7, 'a', ' b '],
        freedBytes: -5,
        elapsedMs: 12.4,
        failed: 2.6,
        dryRun: 'yes',
      },
      { sessionId: 's2', startedAt: Number.NaN, recycledBytes: 10 },
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      sessionId: 's1',
      startedAt: NOW,
      startedAtValid: true,
      taskIds: ['a', 'b'],
      freedBytes: 0,
      elapsedMs: 12,
      failed: 3,
      dryRun: false,
    })
    expect(rows[1]).toMatchObject({ sessionId: 's2', startedAt: 0, startedAtValid: false, recycledBytes: 10 })
  })
})

describe('历史筛选', () => {
  it('按任务与结果类型筛选', () => {
    const rows = [
      historyRow({ sessionId: 'ok', taskIds: ['task-a'] }),
      historyRow({ sessionId: 'bad', taskIds: ['task-b'], failed: 2 }),
      historyRow({ sessionId: 'quarantine', quarantined: 3 }),
      historyRow({ sessionId: 'recycle', recycledBytes: 2048 }),
      historyRow({ sessionId: 'dry', dryRun: true }),
    ]
    expect(filterHistoryRows(rows, { ...DEFAULT_HISTORY_FILTERS, taskId: 'task-b' }).map((row) => row.sessionId)).toEqual(['bad'])
    const ids = (outcome: (typeof DEFAULT_HISTORY_FILTERS)['outcome']) =>
      filterHistoryRows(rows, { ...DEFAULT_HISTORY_FILTERS, outcome }).map((row) => row.sessionId)
    expect(ids('all')).toHaveLength(5)
    expect(ids('failed')).toEqual(['bad'])
    expect(ids('quarantined')).toEqual(['quarantine'])
    expect(ids('recycled')).toEqual(['recycle'])
    expect(ids('dry-run')).toEqual(['dry'])
  })

  it('按时间范围与任务名搜索，时间无效项排除在范围外', () => {
    const rows = [
      historyRow({ sessionId: 'today', startedAt: NOW - HOUR }),
      historyRow({ sessionId: 'week', startedAt: NOW - 3 * DAY }),
      historyRow({ sessionId: 'month', startedAt: NOW - 10 * DAY }),
      historyRow({ sessionId: 'old', startedAt: NOW - 40 * DAY }),
      historyRow({ sessionId: 'unknown', startedAt: 0, startedAtValid: false }),
    ]
    const ids = (range: (typeof DEFAULT_HISTORY_FILTERS)['range']) =>
      filterHistoryRows(rows, { ...DEFAULT_HISTORY_FILTERS, range }, { now: NOW }).map((row) => row.sessionId)
    expect(ids('all')).toHaveLength(5)
    expect(ids('today')).toEqual(['today'])
    expect(ids('7d')).toEqual(['today', 'week'])
    expect(ids('30d')).toEqual(['today', 'week', 'month'])
    const searched = filterHistoryRows(
      rows,
      { ...DEFAULT_HISTORY_FILTERS, query: '浏览器' },
      { now: NOW, taskNames: { 'task-a': '浏览器缓存' } },
    )
    expect(searched).toHaveLength(5)
    expect(filterHistoryRows(rows, { ...DEFAULT_HISTORY_FILTERS, query: '不存在' }, { now: NOW })).toHaveLength(0)
    expect(hasHistoryFilters(DEFAULT_HISTORY_FILTERS)).toBe(false)
    expect(hasHistoryFilters({ ...DEFAULT_HISTORY_FILTERS, range: '7d' })).toBe(true)
    expect(hasHistoryFilters({ ...DEFAULT_HISTORY_FILTERS, query: '  ' })).toBe(false)
  })
})

describe('历史排序与摘要', () => {
  it('排序：无效时间始终最后，并列时新记录在前且结果稳定', () => {
    const timeRows = [
      historyRow({ sessionId: 'old', startedAt: NOW - 2 * HOUR }),
      historyRow({ sessionId: 'new', startedAt: NOW }),
      historyRow({ sessionId: 'unknown', startedAt: 0, startedAtValid: false }),
    ]
    expect(sortHistoryRows(timeRows, { key: 'time', dir: 'desc' }).map((row) => row.sessionId)).toEqual(['new', 'old', 'unknown'])
    expect(sortHistoryRows(timeRows, { key: 'time', dir: 'asc' }).map((row) => row.sessionId)).toEqual(['old', 'new', 'unknown'])
    const rows = [
      historyRow({ sessionId: 'a', startedAt: NOW - 3 * HOUR, freedBytes: 10, failed: 0 }),
      historyRow({ sessionId: 'b', startedAt: NOW - 2 * HOUR, freedBytes: 30, failed: 5 }),
      historyRow({ sessionId: 'c', startedAt: NOW - HOUR, freedBytes: 30, failed: 1 }),
    ]
    expect(sortHistoryRows(rows, { key: 'freed', dir: 'desc' }).map((row) => row.sessionId)).toEqual(['c', 'b', 'a'])
    expect(sortHistoryRows(rows, { key: 'failed', dir: 'desc' }).map((row) => row.sessionId)).toEqual(['b', 'c', 'a'])
  })

  it('汇总筛选结果并收集任务 id/标签', () => {
    const rows = [
      historyRow({ sessionId: 'a', startedAt: NOW, cleaned: 10, freedBytes: 100, failed: 1, quarantined: 2 }),
      historyRow({ sessionId: 'b', startedAt: NOW - DAY, cleaned: 5, freedBytes: 200, dryRun: true, taskIds: ['task-b', 'task-a'] }),
    ]
    expect(summarizeHistoryRows(rows)).toMatchObject({
      count: 2,
      cleaned: 15,
      freedBytes: 300,
      failed: 1,
      quarantined: 2,
      dryRunCount: 1,
      latestAt: NOW,
    })
    expect(collectHistoryTaskIds(rows)).toEqual(['task-a', 'task-b'])
    expect(historyTaskLabels(['task-a', 'task-unknown'], { 'task-a': '临时文件' })).toBe('临时文件、task-unknown')
    expect(historyTaskLabels([])).toBe('—')
  })
})

describe('隔离区筛选与摘要', () => {
  it('规范化时丢弃无 id 记录，并按路径/任务名/任务/会话过滤', () => {
    const normalized = normalizeQuarantineRecords([
      null,
      { originalPath: 'C:\\x' },
      { id: 'q1', bytes: -3, createdAt: Number.NaN, originalPath: 'C:\\a', taskId: 'task-a', sessionId: 's1' },
    ])
    expect(normalized).toHaveLength(1)
    expect(normalized[0]).toMatchObject({ id: 'q1', bytes: 0, createdAt: 0, createdAtValid: false, originalPath: 'C:\\a' })

    const rows = [
      quarantineRow({ id: 'q-old', createdAt: NOW - DAY, bytes: 1 }),
      quarantineRow({ id: 'q-new', createdAt: NOW, bytes: 2 }),
      quarantineRow({ id: 'q-other', sessionId: 'session-2', taskId: 'task-b', createdAt: NOW - 2 * DAY }),
    ]
    expect(filterQuarantineRows(rows, DEFAULT_QUARANTINE_FILTERS).map((row) => row.id)).toEqual(['q-new', 'q-old', 'q-other'])
    expect(filterQuarantineRows(rows, { ...DEFAULT_QUARANTINE_FILTERS, sessionId: 'session-2' }).map((row) => row.id)).toEqual(['q-other'])
    expect(filterQuarantineRows(rows, { ...DEFAULT_QUARANTINE_FILTERS, taskId: 'task-b' }).map((row) => row.id)).toEqual(['q-other'])
    expect(
      filterQuarantineRows(rows, { ...DEFAULT_QUARANTINE_FILTERS, query: '临时文件' }, { taskNames: { 'task-a': '临时文件' } }),
    ).toHaveLength(2)
    expect(hasQuarantineFilters(DEFAULT_QUARANTINE_FILTERS)).toBe(false)
    expect(hasQuarantineFilters({ ...DEFAULT_QUARANTINE_FILTERS, sessionId: 'session-1' })).toBe(true)
  })

  it('摘要与会话分组：项数/体积/会话数/任务数/最早最晚时间', () => {
    const rows = [
      quarantineRow({ id: 'q1', sessionId: 's1', taskId: 'task-a', bytes: 100, createdAt: NOW - DAY }),
      quarantineRow({ id: 'q2', sessionId: 's1', taskId: 'task-b', bytes: 200, createdAt: NOW }),
      quarantineRow({ id: 'q3', sessionId: 's2', taskId: 'task-a', bytes: 300, createdAt: NOW - 2 * DAY }),
    ]
    expect(summarizeQuarantineRows(rows)).toEqual({
      count: 3,
      bytes: 600,
      sessionCount: 2,
      taskCount: 2,
      oldestAt: NOW - 2 * DAY,
      newestAt: NOW,
    })
    expect(groupQuarantineSessions(rows).map((group) => [group.sessionId, group.count, group.bytes])).toEqual([
      ['s1', 2, 300],
      ['s2', 1, 300],
    ])
    expect(quarantineCountForSession(rows, 's1')).toBe(2)
    expect(quarantineCountForSession(rows, '')).toBe(0)
  })
})

describe('历史与隔离区关联', () => {
  it('仍有隔离项 / 已全部消失 / 本来没有隔离项', () => {
    expect(historyQuarantineLink(historyRow({ quarantined: 3 }), 2)).toMatchObject({ available: 2, gone: 1 })
    const gone = historyQuarantineLink(historyRow({ quarantined: 3 }), 0)
    expect(gone).toMatchObject({ available: 0, gone: 3 })
    expect(gone?.text).toContain('不再可还原')
    expect(historyQuarantineLink(historyRow({ quarantined: 0 }), 0)).toBeUndefined()
  })
})

describe('空状态分型', () => {
  it('历史与隔离区：加载/错误/为空/被筛选藏掉', () => {
    const base = { ready: true, loading: false, totalCount: 0, visibleCount: 0, filtersActive: false }
    expect(historyEmptyKind({ ...base, loading: true })).toBe('loading')
    expect(historyEmptyKind({ ...base, ready: false })).toBe('loading')
    expect(historyEmptyKind({ ...base, error: 'boom' })).toBe('error')
    expect(historyEmptyKind(base)).toBe('no-history')
    expect(historyEmptyKind({ ...base, totalCount: 5, visibleCount: 0, filtersActive: true })).toBe('no-match')
    expect(historyEmptyKind({ ...base, totalCount: 5, visibleCount: 2, filtersActive: true })).toBeUndefined()
    expect(quarantineEmptyKind({ ...base, loading: true })).toBe('loading')
    expect(quarantineEmptyKind({ ...base, error: 'boom' })).toBe('error')
    expect(quarantineEmptyKind(base)).toBe('empty')
    expect(quarantineEmptyKind({ ...base, totalCount: 3, visibleCount: 0, filtersActive: true })).toBe('no-match')
    expect(quarantineEmptyKind({ ...base, totalCount: 3, visibleCount: 3, filtersActive: false })).toBeUndefined()
  })
})

describe('危险操作确认文案与可恢复性边界', () => {
  it('恢复确认：数量/体积/失败条件/不覆盖现有文件', () => {
    const copy = restoreConfirmCopy([
      { id: 'q1', originalPath: 'C:\\a', bytes: 1024 },
      { id: 'q2', originalPath: 'C:\\b', bytes: 512 },
    ])
    expect(copy.title).toBe('恢复隔离项')
    expect(copy.message).toContain('2 项')
    expect(copy.message).toContain('1.5 KB')
    expect(copy.message).toContain('不会覆盖或删除任何现有文件')
    expect(copy.message).toContain('继续留在隔离区')
    expect(copy.confirmText).toBe('恢复 2 项')
  })

  it('彻底删除确认：明确不可撤销与「副本即唯一副本」', () => {
    const single = purgeConfirmCopy([{ id: 'q1', originalPath: 'C:\\a', bytes: 1024 }])
    expect(single.title).toBe('彻底删除隔离项')
    expect(single.message).toContain('无法恢复')
    expect(single.message).toContain('不可撤销')
    expect(single.confirmText).toBe('彻底删除 1 项')
    const all = purgeConfirmCopy([{ id: 'q1', originalPath: 'C:\\a', bytes: 2048 }], { all: true })
    expect(all.title).toBe('清空隔离区')
    expect(all.message).toContain('全部 1 项')
    expect(all.confirmText).toContain('彻底删除全部')
  })

  it('清空历史不影响隔离区；撤销只恢复隔离项，回收站需手动、永久删除不可恢复', () => {
    const historyCopy = clearHistoryConfirmCopy(12)
    expect(historyCopy.message).toContain('12 条清理历史记录')
    expect(historyCopy.message).toContain('隔离区恢复能力不受影响')
    expect(historyCopy.message).toContain('归零')
    const undoCopy = undoConfirmCopy({ available: true, quarantine: 2, recycle: 3, permanent: 4 })
    expect(undoCopy.message).toContain('隔离区 2 项可恢复')
    expect(undoCopy.message).toContain('Windows 回收站')
    expect(undoCopy.message).toContain('永久删除 4 项不可恢复')
    expect(undoCopy.confirmText).toBe('恢复 2 项')
  })
})

describe('按钮禁用原因', () => {
  it('恢复/删除需要先勾选，撤销/清空历史区分具体原因', () => {
    expect(restoreGate({ ready: true, busy: false, selectedCount: 0 })).toMatchObject({ ok: false })
    expect(restoreGate({ ready: true, busy: false, selectedCount: 0 }).reason).toContain('勾选')
    expect(restoreGate({ ready: true, busy: false, selectedCount: 2 }).ok).toBe(true)
    expect(restoreGate({ ready: true, busy: true, selectedCount: 2 }).ok).toBe(false)
    expect(purgeGate({ ready: true, busy: false, selectedCount: 0, totalCount: 0, all: true }).reason).toContain('隔离区为空')
    expect(purgeGate({ ready: true, busy: false, selectedCount: 1, totalCount: 3, all: false }).ok).toBe(true)

    expect(undoGate({ ready: true, busy: false, state: { available: true, quarantine: 2, recycle: 0, permanent: 0 } }).ok).toBe(true)
    expect(
      undoGate({ ready: true, busy: false, state: { available: false, quarantine: 0, recycle: 2, permanent: 0 } }).reason,
    ).toContain('回收站')
    expect(
      undoGate({ ready: true, busy: false, state: { available: false, quarantine: 0, recycle: 0, permanent: 1 } }).reason,
    ).toContain('永久删除')
    expect(
      undoGate({ ready: true, busy: false, state: { available: false, quarantine: 0, recycle: 0, permanent: 0 } }).reason,
    ).toContain('没有可恢复')
    expect(undoGate({ ready: true, busy: false, error: 'ipc down' }).reason).toContain('ipc down')
    expect(clearHistoryGate({ ready: true, busy: false, count: 0 }).reason).toContain('暂无历史')
    expect(clearHistoryGate({ ready: true, busy: false, count: 3 }).ok).toBe(true)
  })
})

describe('操作结果反馈', () => {
  it('恢复失败逐条给出原始路径与原因', () => {
    const paths = new Map([
      ['q1', 'C:\\Users\\me\\Temp\\a.tmp'],
      ['q2', 'C:\\Users\\me\\Temp\\b.tmp'],
    ])
    const partial = describeRestoreResult(
      { restored: 1, failed: [{ id: 'q2', message: '原路径已存在同名文件' }] },
      ['q1', 'q2'],
      paths,
    )
    expect(partial).toMatchObject({ requested: 2, restored: 1, hasFailures: true, tone: 'warning' })
    expect(partial.failed).toEqual([{ id: 'q2', path: 'C:\\Users\\me\\Temp\\b.tmp', message: '原路径已存在同名文件' }])
    expect(partial.message).toContain('1 项失败')
    const success = describeRestoreResult({ restored: 2, failed: [] }, ['q1', 'q2'], paths)
    expect(success).toMatchObject({ tone: 'success', hasFailures: false })
    expect(success.message).toContain('2 项')
    const unknown = describeRestoreResult({ restored: 0, failed: [{ id: 'gone', message: '无效的隔离项 id' }] }, ['gone'], paths)
    expect(unknown.failed[0].path).toBe('未知原始路径')
    expect(unknown.tone).toBe('error')
  })

  it('删除少于请求数时提示剩余项仍在隔离区', () => {
    expect(describePurgeResult(2, 3)).toMatchObject({ removed: 2, requested: 3, remaining: 1, shortfall: true, tone: 'warning' })
    expect(describePurgeResult(2, 3).message).toContain('未能删除')
    expect(describePurgeResult(3, 3)).toMatchObject({ removed: 3, remaining: 0, shortfall: false, tone: 'success' })
    expect(describePurgeResult(-1, 3)).toMatchObject({ removed: 0, remaining: 3 })
    expect(describePurgeResult(5, 0).title).toContain('没有可删除')
  })
})
