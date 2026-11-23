/**
 * 定时任务：启动补跑 + nextRunAt 纯函数单测（含真实内核的补跑集成验证）。
 *
 * 纯函数部分覆盖：
 * - daily：跨天 / 未到点 / 已过点 / 当天已跑不重复 / 时间点越界收敛；
 * - interval：首次（从未运行）/ 到期 / 未到期 / 非法 lastRun 容错；
 * - 补跑：错过才补、从未运行不算补跑、补跑写回 lastRuns 后不重复；
 * - nextRunAt：daily（今天点/明天点/到期立即）与 interval（首次/周期）；
 * - 配置损坏容错：plans / lastRuns / 数值字段全都被安全归一。
 *
 * 集成部分（真实 createApp + 插件）验证：启动补跑真的执行一次、写 lastRuns、
 * 事件 payload 带 `nextAt` 与 `appRunningOnly: true`、补跑仍走同一授权与 safe-only 清理。
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp, type App } from '@cordclean/core'
import schedulerPlugin, {
  collectDuePlans,
  isDailyDue,
  isDue,
  isIntervalDue,
  missedOnStartup,
  nextRunAt,
  normalizePlans,
  rulesHash,
  sanitizeLastRuns,
  startupCatchupPlans,
  type SchedulePlan,
} from '@cordclean/plugin-scheduler'
import { createSandbox, manifestOf } from './helpers.ts'

/* ------------------------------------------------------------------ */
/* 测试工具                                                            */
/* ------------------------------------------------------------------ */

const sandbox = createSandbox()
afterAll(() => {
  rmSync(sandbox.root, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, timeoutMs = 6_000, stepMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(stepMs)
  }
  return predicate()
}

/** 用本地时区构造时间戳（与调度判定一致）；month 从 1 开始，便于阅读 */
const at = (month: number, day: number, hour: number, minute = 0): number =>
  new Date(2026, month - 1, day, hour, minute, 0, 0).getTime()

const plan = (overrides: Partial<SchedulePlan> = {}): SchedulePlan => ({
  id: 'plan-1',
  name: '测试计划',
  enabled: true,
  daily: false,
  everyMinutes: 60,
  atHour: 3,
  atMinute: 0,
  taskIds: [],
  mode: 'scan',
  authorizedHash: '',
  ...overrides,
})

const dailyPlan = (overrides: Partial<SchedulePlan> = {}): SchedulePlan => plan({ daily: true, ...overrides })
const intervalPlan = (overrides: Partial<SchedulePlan> = {}): SchedulePlan => plan({ daily: false, ...overrides })

/* ------------------------------------------------------------------ */
/* 一、daily 到期判定                                                  */
/* ------------------------------------------------------------------ */

describe('daily 到期判定', () => {
  it('未到当天时间点：不触发，nextRunAt 指向今天的时间点', () => {
    const now = at(5, 20, 2, 0) // 2026-05-20 02:00
    const last = at(5, 19, 3, 0) // 昨天 03:00
    const target = dailyPlan()
    expect(isDailyDue(target, last, now)).toBe(false)
    expect(isDue(target, last, now)).toBe(false)
    expect(nextRunAt(target, last, now)).toBe(at(5, 20, 3, 0))
  })

  it('已过当天时间点且没跑：到期，nextRunAt 为 now（下个 tick 立即触发/补跑）', () => {
    const now = at(5, 20, 9, 0)
    const last = at(5, 19, 3, 0)
    const target = dailyPlan()
    expect(isDailyDue(target, last, now)).toBe(true)
    expect(nextRunAt(target, last, now)).toBe(now)
  })

  it('跨天：上次运行在昨天，今天时间点已过即到期并进入补跑清单', () => {
    const now = at(5, 20, 9, 0)
    const last = at(5, 19, 3, 30)
    const target = dailyPlan({ id: 'daily-cross' })
    expect(isDailyDue(target, last, now)).toBe(true)
    expect(missedOnStartup(target, last, now)).toBe(true)
    const catchup = startupCatchupPlans([target], { [target.id]: last }, now)
    expect(catchup.map((item) => item.plan.id)).toEqual(['daily-cross'])
    expect(catchup[0].catchup).toBe(true)
    expect(catchup[0].lastRunAt).toBe(last)
  })

  it('当天已跑过时间点：不重复；nextRunAt 指向明天时间点', () => {
    const now = at(5, 20, 9, 0)
    const last = at(5, 20, 3, 5) // 今天 03:05 已经跑过
    const target = dailyPlan()
    expect(isDailyDue(target, last, now)).toBe(false)
    expect(nextRunAt(target, last, now)).toBe(at(5, 21, 3, 0))
  })

  it('当天在时间点之前手动跑过，不会吃掉当天计划：到点后仍到期', () => {
    const now = at(5, 20, 9, 0)
    const last = at(5, 20, 1, 0) // 今天 01:00 手动跑，计划是 03:00
    const target = dailyPlan()
    expect(isDailyDue(target, last, now)).toBe(true)
    expect(nextRunAt(target, last, now)).toBe(now)
  })

  it('atHour/atMinute 越界或损坏时收敛到合法值', () => {
    const now = at(5, 20, 1, 0)
    const clamped = dailyPlan({ atHour: 25, atMinute: 90 })
    expect(nextRunAt(clamped, 0, now)).toBe(at(5, 20, 23, 59))
    const broken = dailyPlan({ atHour: 'x' as never, atMinute: null as never })
    expect(nextRunAt(broken, 0, now)).toBe(at(5, 20, 3, 0))
  })

  it('停用的计划永远不到期，nextRunAt 为 null', () => {
    const target = dailyPlan({ enabled: false })
    const now = at(5, 20, 9, 0)
    expect(isDailyDue(target, at(5, 19, 3, 0), now)).toBe(false)
    expect(nextRunAt(target, 0, now)).toBeNull()
  })
})

/* ------------------------------------------------------------------ */
/* 二、interval 到期判定                                               */
/* ------------------------------------------------------------------ */

describe('interval 到期判定', () => {
  it('首次（从未运行）视为到期，nextRunAt 为 now', () => {
    const now = at(5, 20, 9, 0)
    const target = intervalPlan()
    expect(isIntervalDue(target, 0, now)).toBe(true)
    expect(collectDuePlans([target], {}, now)).toHaveLength(1)
    expect(nextRunAt(target, 0, now)).toBe(now)
  })

  it('未满一个周期不触发，nextRunAt = 上次运行 + 周期', () => {
    const now = at(5, 20, 9, 0)
    const last = now - 30 * 60_000 // 半小时前，周期 60 分钟
    const target = intervalPlan({ everyMinutes: 60 })
    expect(isIntervalDue(target, last, now)).toBe(false)
    expect(nextRunAt(target, last, now)).toBe(last + 60 * 60_000)
  })

  it('正好满一个周期即到期，nextRunAt 为 now', () => {
    const now = at(5, 20, 9, 0)
    const target = intervalPlan({ everyMinutes: 60 })
    expect(isIntervalDue(target, now - 60 * 60_000, now)).toBe(true)
    expect(nextRunAt(target, now - 60 * 60_000, now)).toBe(now)
  })

  it('超过一个周期：到期并可在启动时补跑', () => {
    const now = at(5, 20, 9, 0)
    const last = now - 2 * 60 * 60_000
    const target = intervalPlan({ id: 'interval-missed', everyMinutes: 60 })
    expect(isIntervalDue(target, last, now)).toBe(true)
    expect(missedOnStartup(target, last, now)).toBe(true)
    expect(collectDuePlans([target], { 'interval-missed': last }, now)).toHaveLength(1)
  })

  it('everyMinutes 非法/越界时按 [15,1440] 收敛（默认 120）', () => {
    const now = at(5, 20, 9, 0)
    expect(nextRunAt(intervalPlan({ everyMinutes: 1 }), 0, now)).toBe(now)
    const low = intervalPlan({ everyMinutes: 1 })
    expect(isIntervalDue(low, now - 14 * 60_000, now)).toBe(false) // 1 → 15 分钟
    expect(isIntervalDue(low, now - 15 * 60_000, now)).toBe(true)
    expect(isIntervalDue(intervalPlan({ everyMinutes: 60 * 48 }), now - 24 * 60 * 60_000, now)).toBe(true) // 48h → 24h
    const broken = intervalPlan({ everyMinutes: 'abc' as never })
    expect(isIntervalDue(broken, now - 119 * 60_000, now)).toBe(false) // 回落到 120 分钟
    expect(isIntervalDue(broken, now - 120 * 60_000, now)).toBe(true)
  })

  it('lastRun 非法（NaN/负数/未来过远）按「从未运行」容错', () => {
    const now = at(5, 20, 9, 0)
    const target = intervalPlan()
    expect(isIntervalDue(target, Number.NaN, now)).toBe(true)
    expect(isIntervalDue(target, -1, now)).toBe(true)
    expect(isIntervalDue(target, now + 6 * 60_000, now)).toBe(true) // 超出 5 分钟容差窗口 → 视为损坏
    expect(collectDuePlans([target], { 'plan-1': 'not-a-timestamp' } as never, now)).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------ */
/* 三、启动补跑与去重                                                  */
/* ------------------------------------------------------------------ */

describe('启动补跑', () => {
  it('错过的 daily/interval 会进入补跑清单，并标记 catchup', () => {
    const now = at(5, 20, 9, 0)
    const target = [dailyPlan({ id: 'd1' }), intervalPlan({ id: 'i1', everyMinutes: 60 })]
    const lastRuns = { d1: at(5, 19, 3, 0), i1: now - 2 * 60 * 60_000 }
    const catchup = startupCatchupPlans(target, lastRuns, now)
    expect(catchup.map((item) => item.plan.id)).toEqual(['d1', 'i1'])
    expect(catchup.every((item) => item.catchup === true)).toBe(true)
    expect(catchup.every((item) => Number.isFinite(item.nextAt))).toBe(true)
  })

  it('从未运行的计划不算「错过」：不进补跑清单，但按常规 tick 到期', () => {
    const now = at(5, 20, 9, 0)
    const fresh = intervalPlan({ id: 'fresh' })
    expect(startupCatchupPlans([fresh], {}, now)).toHaveLength(0)
    expect(collectDuePlans([fresh], {}, now)).toHaveLength(1)
  })

  it('未到期的计划不会补跑', () => {
    const now = at(5, 20, 9, 0)
    const target = [
      dailyPlan({ id: 'd1' }), // 今天 03:00 已过但 05:00 跑过
      intervalPlan({ id: 'i1', everyMinutes: 60 }), // 10 分钟前刚跑过
    ]
    const lastRuns = { d1: at(5, 20, 5, 0), i1: now - 10 * 60_000 }
    expect(startupCatchupPlans(target, lastRuns, now)).toHaveLength(0)
  })

  it('补跑后写回 lastRuns：同一会话第二次检查不会重复补跑', () => {
    const now = at(5, 20, 9, 0)
    const target = [dailyPlan({ id: 'd1' }), intervalPlan({ id: 'i1', everyMinutes: 60 })]
    const staleRuns = { d1: at(5, 19, 3, 0), i1: now - 3 * 60 * 60_000 }
    const first = startupCatchupPlans(target, staleRuns, now)
    expect(first).toHaveLength(2)

    // 模拟插件补跑成功后的写入：把 lastRuns 更新为本次运行时间
    const markedRuns = { ...staleRuns, d1: now, i1: now }
    const second = startupCatchupPlans(target, markedRuns, now + 30_000)
    expect(second).toHaveLength(0)
    expect(collectDuePlans(target, markedRuns, now + 30_000)).toHaveLength(0)
  })

  it('补跑清单过滤停用与损坏的计划条目', () => {
    const now = at(5, 20, 9, 0)
    const plans = [
      null,
      'not-a-plan' as never,
      { id: '' } as never,
      intervalPlan({ id: 'ok' }),
      intervalPlan({ id: 'off', enabled: false }),
    ]
    const catchup = startupCatchupPlans(plans, { ok: now - 3 * 60 * 60_000, off: now - 3 * 60 * 60_000 }, now)
    expect(catchup.map((item) => item.plan.id)).toEqual(['ok'])
  })
})

/* ------------------------------------------------------------------ */
/* 四、nextRunAt                                                       */
/* ------------------------------------------------------------------ */

describe('nextRunAt', () => {
  it('daily：未到点→今天时间点；今天已跑过→明天时间点', () => {
    const target = dailyPlan({ atHour: 6, atMinute: 30 })
    const morning = at(5, 20, 1, 0)
    expect(nextRunAt(target, 0, morning)).toBe(at(5, 20, 6, 30))
    const later = at(5, 20, 8, 0)
    expect(nextRunAt(target, at(5, 20, 7, 0), later)).toBe(at(5, 21, 6, 30))
  })

  it('interval：未到期→上次+周期，已到期/首次→now', () => {
    const now = at(5, 20, 9, 0)
    const target = intervalPlan({ everyMinutes: 30 })
    expect(nextRunAt(target, 0, now)).toBe(now)
    expect(nextRunAt(target, now - 10 * 60_000, now)).toBe(now + 20 * 60_000)
    expect(nextRunAt(target, now - 45 * 60_000, now)).toBe(now)
  })

  it('停用计划返回 null；非 daily 计划默认走 interval', () => {
    const now = at(5, 20, 9, 0)
    expect(nextRunAt(plan({ enabled: false }), 0, now)).toBeNull()
    expect(nextRunAt(undefined, 0, now)).toBeNull()
    expect(nextRunAt(intervalPlan({ daily: undefined }), 0, now)).toBe(now)
  })

  it('daily 跨年/跨月由 Date 正常进位', () => {
    const now = new Date(2026, 11, 31, 20, 0, 0).getTime() // 2026-12-31 20:00
    const target = dailyPlan({ atHour: 3, atMinute: 0 })
    expect(nextRunAt(target, new Date(2026, 11, 31, 3, 30).getTime(), now)).toBe(new Date(2027, 0, 1, 3, 0, 0).getTime())
  })
})

/* ------------------------------------------------------------------ */
/* 五、配置损坏容错                                                    */
/* ------------------------------------------------------------------ */

describe('配置损坏容错', () => {
  it('normalizePlans：null/非数组 plans 回落旧版单计划且不抛错', () => {
    expect(() => normalizePlans(null)).not.toThrow()
    expect(() => normalizePlans(undefined)).not.toThrow()
    const fallback = normalizePlans(null)
    expect(fallback).toHaveLength(1)
    expect(fallback[0]).toMatchObject({ id: 'default', enabled: false, daily: false, everyMinutes: 120, atHour: 3, atMinute: 0, mode: 'scan' })
    const legacy = normalizePlans({ plans: 'broken' as never, enabled: true, everyMinutes: 45 } as never)
    expect(legacy[0]).toMatchObject({ id: 'default', enabled: true, everyMinutes: 45 })
  })

  it('normalizePlans：丢弃损坏条目、去重、字段越界收敛', () => {
    const plans = normalizePlans({
      plans: [
        null,
        'oops',
        { name: '没有 id' },
        { id: 42 },
        { id: 'dup', name: '重复 1' },
        { id: 'dup', name: '重复 2' },
        {
          id: 'bad',
          name: '',
          enabled: 'yes',
          daily: 'yes',
          everyMinutes: 1,
          atHour: 99,
          atMinute: -5,
          taskIds: [1, 'keep', ' keep ', ''],
          mode: 'destroy',
          authorizedHash: 7,
        },
      ],
    } as never)
    expect(plans.map((item) => item.id)).toEqual(['dup', 'bad'])
    expect(plans[0].name).toBe('重复 1')
    expect(plans[1]).toMatchObject({
      id: 'bad',
      name: '计划 7', // 按原始配置下标命名（第 7 项）
      enabled: true, // 只有显式 false 才停用
      daily: false, // 只有显式 true 才是 daily
      everyMinutes: 15,
      atHour: 23,
      atMinute: 0,
      taskIds: ['keep'],
      mode: 'scan',
      authorizedHash: '',
    })
  })

  it('sanitizeLastRuns：非法值/数组/未来时间戳被安全丢弃，数字字符串可用', () => {
    const now = at(5, 20, 9, 0)
    const sanitized = sanitizeLastRuns({
      good: now - 1_000,
      numericString: String(now - 2_000),
      negative: -1,
      zero: 0,
      notNumber: 'abc',
      future: now + 60 * 60_000, // 超过 5 分钟容差 → 损坏
      nested: { at: now },
    }, now)
    expect(sanitized).toEqual({ good: now - 1_000, numericString: now - 2_000 })
    expect(sanitizeLastRuns(null)).toEqual({})
    expect(sanitizeLastRuns([])).toEqual({})
    expect(sanitizeLastRuns('broken')).toEqual({})
  })

  it('损坏的 plans/lastRuns 不会让到期判定抛错', () => {
    const now = at(5, 20, 9, 0)
    for (const value of [null, undefined, Number.NaN, -1, 'x', {}, true]) {
      expect(() => isDue(intervalPlan(), value as never, now)).not.toThrow()
      expect(() => collectDuePlans([intervalPlan()], value as never, now)).not.toThrow()
    }
    expect(collectDuePlans([intervalPlan()], null as never, now)).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------ */
/* 六、真实内核集成：启动补跑                                          */
/* ------------------------------------------------------------------ */

const STALE_MS = 3 * 60 * 60_000

function makeApp(name: string, config: Record<string, any>, lastRuns: Record<string, number>): Promise<App> {
  return createApp({
    dataDir: path.join(sandbox.dataDir, name),
    logger: false,
    loadPlugins: true,
    manifest: manifestOf([{ id: 'scheduler', plugin: schedulerPlugin, defaultEnabled: false }]),
    settingsOverrides: {
      // quarantine 模式下真实清理会把文件移入隔离区（临时 dataDir），便于断言「原文件已消失」
      clean: { mode: 'quarantine' },
      scheduler: { lastRuns },
      plugins: { scheduler: { enabled: false, config } },
    },
  })
}

describe('启动补跑（真实内核）', () => {
  it('应用启动后补跑一次：写 lastRuns，事件带 nextAt/appRunningOnly/catchup', async () => {
    const dir = sandbox.dir('catchup-scan')
    const file = path.join(dir, 'a.tmp')
    writeFileSync(file, Buffer.alloc(2048, 1))
    const planId = 'catchup-plan'
    const stale = Date.now() - STALE_MS
    const app = await makeApp('catchup-scan', {
      plans: [{ id: planId, name: '补跑计划', enabled: true, daily: false, everyMinutes: 60, atHour: 3, atMinute: 0, taskIds: ['catchup-task'], mode: 'scan', authorizedHash: '' }],
    }, { [planId]: stale })
    try {
      app.ctx.pathPolicy.addRoot(dir)
      app.ctx.cleaner.define({
        id: 'catchup-task',
        name: '补跑任务',
        category: 'system',
        risk: 'safe',
        icon: '🧪',
        defaultSelected: true,
        targets: [dir],
        scan(scan) {
          scan.emit({ path: file, kind: 'file', size: 2048 })
        },
      })
      const events: any[] = []
      ;(app.ctx as any).on('scheduler/scan', (payload: any) => events.push(payload))
      await app.ctx.plugins.enable('scheduler')

      expect(await waitFor(() => events.some((event) => event.catchup === true))).toBe(true)
      const catchup = events.find((event) => event.catchup === true)
      expect(catchup.planId).toBe(planId)
      expect(catchup.items).toBe(1)
      expect(catchup.bytes).toBe(2048)
      expect(catchup.errors).toBe(0)
      expect(catchup.appRunningOnly).toBe(true)
      expect(typeof catchup.nextAt).toBe('number')
      expect(catchup.nextAt).toBeGreaterThan(Date.now())

      // 补跑后写 lastRuns：值更新为本次运行时间，且纯函数判定不再到期
      expect(await waitFor(() => (app.ctx.settings.get().scheduler.lastRuns[planId] ?? 0) > stale)).toBe(true)
      const persisted = app.ctx.settings.get().scheduler.lastRuns[planId]
      expect(isIntervalDue(plan({ id: planId, everyMinutes: 60 }), persisted, Date.now())).toBe(false)

      // 再次启用（等价于应用重启）不会重复补跑
      const before = events.length
      await app.ctx.plugins.disable('scheduler')
      await app.ctx.plugins.enable('scheduler')
      await sleep(1_200)
      expect(events.length).toBe(before)
    } finally {
      await app.dispose()
    }
  })

  it('补跑走同一授权：有效授权时只自动清理 safe 项', async () => {
    const dir = sandbox.dir('catchup-clean')
    const safeFile = path.join(dir, 'safe.tmp')
    const riskyFile = path.join(dir, 'risky.dll')
    writeFileSync(safeFile, Buffer.alloc(1024, 1))
    writeFileSync(riskyFile, Buffer.alloc(512, 1))
    const planId = 'catchup-clean-plan'
    const taskId = 'catchup-clean-task'
    const stale = Date.now() - STALE_MS
    const app = await makeApp('catchup-clean', {
      plans: [{ id: planId, name: '补跑清理', enabled: true, daily: false, everyMinutes: 60, atHour: 3, atMinute: 0, taskIds: [taskId], mode: 'clean', authorizedHash: '' }],
    }, { [planId]: stale })
    try {
      app.ctx.pathPolicy.addRoot(dir)
      app.ctx.cleaner.define({
        id: taskId,
        name: '补跑清理任务',
        category: 'system',
        risk: 'safe',
        icon: '🧪',
        defaultSelected: true,
        targets: [dir],
        scan(scan) {
          scan.emit({ path: safeFile, kind: 'file', size: 1024, risk: 'safe' })
          scan.emit({ path: riskyFile, kind: 'file', size: 512, risk: 'caution' })
        },
      })
      // 与插件内 rulesHash(ctx, plan) 使用同一范围计算，模拟「已授权」状态
      const hash = rulesHash(app.ctx, { id: planId, taskIds: [taskId], mode: 'clean', everyMinutes: 60 })
      await app.ctx.plugins.updateConfig('scheduler', {
        plans: [{ id: planId, name: '补跑清理', enabled: true, daily: false, everyMinutes: 60, atHour: 3, atMinute: 0, taskIds: [taskId], mode: 'clean', authorizedHash: hash }],
      })

      const events: any[] = []
      ;(app.ctx as any).on('scheduler/scan', (payload: any) => events.push(payload))
      await app.ctx.plugins.enable('scheduler')

      expect(await waitFor(() => events.some((event) => event.autoCleaned === true))).toBe(true)
      const cleaned = events.find((event) => event.autoCleaned === true)
      expect(cleaned.cleaned).toBe(1)
      expect(cleaned.catchup).toBe(true)
      expect(cleaned.appRunningOnly).toBe(true)
      expect(typeof cleaned.nextAt).toBe('number')
      expect(events.some((event) => event.blocked)).toBe(false)
      expect(existsSync(safeFile)).toBe(false)
      expect(existsSync(riskyFile)).toBe(true) // 非 safe 项不得自动清理
      expect(await waitFor(() => app.ctx.history.list().length > 0)).toBe(true)
      expect(app.ctx.history.list()[0]?.cleaned).toBe(1)
    } finally {
      await app.dispose()
    }
  })

  it('补跑时授权失效：blocked 事件字段保持不变且不清理', async () => {
    const dir = sandbox.dir('catchup-blocked')
    const file = path.join(dir, 'b.tmp')
    writeFileSync(file, Buffer.alloc(1024, 1))
    const planId = 'catchup-blocked-plan'
    const taskId = 'catchup-blocked-task'
    const stale = Date.now() - STALE_MS
    const app = await makeApp('catchup-blocked', {
      plans: [{ id: planId, name: '补跑被拦截', enabled: true, daily: false, everyMinutes: 60, atHour: 3, atMinute: 0, taskIds: [taskId], mode: 'clean', authorizedHash: '' }],
    }, { [planId]: stale })
    try {
      app.ctx.pathPolicy.addRoot(dir)
      app.ctx.cleaner.define({
        id: taskId,
        name: '补跑被拦截任务',
        category: 'system',
        risk: 'safe',
        icon: '🧪',
        defaultSelected: true,
        targets: [dir],
        scan(scan) {
          scan.emit({ path: file, kind: 'file', size: 1024 })
        },
      })
      const events: any[] = []
      ;(app.ctx as any).on('scheduler/scan', (payload: any) => events.push(payload))
      await app.ctx.plugins.enable('scheduler')

      expect(await waitFor(() => events.some((event) => event.blocked === true))).toBe(true)
      const scanEvent = events.find((event) => event.planId === planId && event.items !== undefined)
      expect(scanEvent.catchup).toBe(true)
      const blocked = events.find((event) => event.blocked === true)
      // 失败/授权失效事件保持原有字段语义：blocked + reason，不混入 catchup
      expect(blocked.planId).toBe(planId)
      expect(blocked.planName).toBe('补跑被拦截')
      expect(typeof blocked.reason).toBe('string')
      expect(blocked.error).toBeUndefined()
      expect(blocked.catchup).toBeUndefined()
      expect(blocked.appRunningOnly).toBe(true)
      expect(events.some((event) => event.autoCleaned)).toBe(false)
      expect(existsSync(file)).toBe(true)
      expect(app.ctx.history.list()).toHaveLength(0)
    } finally {
      await app.dispose()
    }
  })
})
