/**
 * 概览页展示模型单测：磁盘/内存/运行时长/阶段判断/扫描门禁/历史摘要/系统摘要。
 */
import { describe, expect, it } from 'vitest'
import {
  buildSystemSummary,
  diskUsagePercent,
  diskUsedBytes,
  liveUptimeSeconds,
  memoryPercent,
  overviewPhase,
  scanGate,
  summarizeDisks,
  summarizeHistory,
  usageTone,
} from '../packages/ui/src/views/overview-model.ts'

const GB = 1024 ** 3

describe('磁盘占用', () => {
  it('优先使用宿主给的 used，非法时按 total-free 兜底并夹在 [0,total]', () => {
    expect(diskUsedBytes({ mount: 'C:', total: 100, free: 30 })).toBe(70)
    expect(diskUsedBytes({ mount: 'C:', total: 100, free: 30, used: 65 })).toBe(65)
    expect(diskUsedBytes({ mount: 'C:', total: 100, free: 300 })).toBe(0)
  })

  it('使用率四舍五入并夹在 0-100', () => {
    expect(diskUsagePercent({ mount: 'C:', total: 200, free: 50 })).toBe(75)
    expect(diskUsagePercent({ mount: 'C:', total: 200, free: 200 })).toBe(0)
    expect(diskUsagePercent({ mount: 'C:', total: 0, free: 0 })).toBe(0)
    expect(diskUsagePercent({ mount: 'C:', total: Number.NaN, free: 0 })).toBe(0)
  })

  it('阈值分档：75% 注意、90% 危险', () => {
    expect(usageTone(10)).toBe('ok')
    expect(usageTone(74)).toBe('ok')
    expect(usageTone(75)).toBe('warn')
    expect(usageTone(89)).toBe('warn')
    expect(usageTone(90)).toBe('danger')
    expect(usageTone(Number.NaN)).toBe('ok')
  })
})

describe('磁盘汇总与提醒', () => {
  it('统计有效磁盘的总量/可用，并找出紧张盘与最紧盘', () => {
    const summary = summarizeDisks([
      { mount: 'C:', total: 100 * GB, free: 5 * GB },
      { mount: 'D:', total: 300 * GB, free: 200 * GB },
      { mount: 'X:', total: 0, free: 0 },
    ])
    expect(summary.count).toBe(2)
    expect(summary.totalBytes).toBe(400 * GB)
    expect(summary.freeBytes).toBe(205 * GB)
    expect(summary.lowDisks.map((disk) => disk.mount)).toEqual(['C:'])
    expect(summary.tightest?.mount).toBe('C:')
    expect(summary.warning).toContain('C:')
    expect(summary.warning).toContain('剩余空间不足')
  })

  it('没有紧张盘时不提示；空列表返回空汇总', () => {
    expect(summarizeDisks([{ mount: 'D:', total: 100, free: 90 }]).warning).toBeUndefined()
    const empty = summarizeDisks([])
    expect(empty).toEqual({ count: 0, totalBytes: 0, freeBytes: 0, lowDisks: [], tightest: undefined, warning: undefined })
  })
})

describe('内存与运行时长', () => {
  it('内存使用率夹在 0-100', () => {
    expect(memoryPercent(100, 40)).toBe(60)
    expect(memoryPercent(100, -10)).toBe(100)
    expect(memoryPercent(0, 0)).toBe(0)
    expect(memoryPercent(Number.NaN, 0)).toBe(0)
  })

  it('运行时长 = 采集 uptime + 本地走时，时钟回拨不为负', () => {
    expect(liveUptimeSeconds(100, 1_000_000, 1_005_000)).toBe(105)
    expect(liveUptimeSeconds(100, 1_000_000, 900_000)).toBe(100)
    expect(liveUptimeSeconds(Number.NaN, 0, 0)).toBe(0)
  })
})

describe('页面阶段（骨架/错误/正常，有缓存不白屏）', () => {
  it('无数据：未就绪→骨架，出错→错误，就绪→正常', () => {
    expect(overviewPhase({ ready: false, hasSystem: false })).toBe('loading')
    expect(overviewPhase({ ready: false, hasSystem: false, error: '连不上' })).toBe('error')
    expect(overviewPhase({ ready: true, hasSystem: false })).toBe('ready')
  })

  it('有缓存数据时即使刷新失败也继续渲染（错误用页内提示）', () => {
    expect(overviewPhase({ ready: true, hasSystem: true, error: '刷新失败' })).toBe('ready')
  })
})

describe('一键扫描门禁', () => {
  it('就绪且空闲才允许；其余给出可读原因', () => {
    expect(scanGate({ ready: true, scanning: false, cleaning: false })).toEqual({ ok: true })
    expect(scanGate({ ready: false, scanning: false, cleaning: false }).reason).toContain('内核')
    expect(scanGate({ ready: true, scanning: true, cleaning: false }).reason).toContain('扫描')
    expect(scanGate({ ready: true, scanning: false, cleaning: true }).reason).toContain('清理')
  })
})

describe('最近清理摘要', () => {
  it('空历史给出明确空状态', () => {
    expect(summarizeHistory([])).toEqual({ count: 0, hasHistory: false, lastFreedBytes: 0, lastCleaned: 0, lastTaskIds: [] })
  })

  it('取时间最新的一条（不假设数组已排序）', () => {
    const summary = summarizeHistory([
      { startedAt: 100, freedBytes: 1, cleaned: 1, taskIds: ['a'] },
      { startedAt: 900, freedBytes: 2048, cleaned: 5, taskIds: ['b', 'c'] },
      { startedAt: 500, freedBytes: 2, cleaned: 2, taskIds: ['d'] },
    ])
    expect(summary.count).toBe(3)
    expect(summary.hasHistory).toBe(true)
    expect(summary.lastAt).toBe(900)
    expect(summary.lastFreedBytes).toBe(2048)
    expect(summary.lastCleaned).toBe(5)
    expect(summary.lastTaskIds).toEqual(['b', 'c'])
  })
})

describe('系统摘要文本（复制用）', () => {
  it('包含系统/处理器/内存/运行时长/磁盘，且不含空行噪声', () => {
    const text = buildSystemSummary({
      platformLabel: 'Windows 11',
      release: '10.0.26100',
      cpuModel: 'AMD Ryzen 5 5600',
      cpuCores: 12,
      hostname: 'PC',
      username: 'Administrator',
      memoryTotal: 16 * GB,
      memoryFree: 8 * GB,
      uptimeSeconds: 3725,
      disks: [{ mount: 'C:', total: 100 * GB, free: 20 * GB }],
      version: '0.6.11',
    })
    expect(text).toContain('CordClean 系统摘要')
    expect(text).toContain('Windows 11 10.0.26100')
    expect(text).toContain('AMD Ryzen 5 5600（12 核）')
    expect(text).toContain('内存：已用 8.0 GB / 共 16.0 GB（50%）')
    expect(text).toContain('运行时长：1 小时 2 分')
    expect(text).toContain('磁盘 C:：可用 20.0 GB / 共 100.0 GB（已用 80%）')
    expect(text).not.toContain('\n\n')
  })
})
