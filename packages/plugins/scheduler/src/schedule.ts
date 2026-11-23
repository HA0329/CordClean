/**
 * 定时计划纯函数层：到期判定、启动补跑识别、nextRunAt 计算。
 *
 * 从插件主体（index.ts）拆出来的原因：这些规则是**纯函数**，时间一律由调用方
 * 显式传入（毫秒时间戳），不读全局状态、不起定时器，因此可以完整单测
 * （daily 跨天/未到点/已过点、interval 首次/到期/未到期、配置损坏容错）。
 *
 * 约定：
 * - `due`（到期）= 从上次运行之后，计划应当触发的那一个时间点已经过去；
 * - `missedOnStartup`（启动补跑）= 应用启动时已经有「到期」的触发点，
 *   且上一次运行发生在该触发点之前 —— 说明触发时应用没在运行，需要补跑一次；
 * - 从未运行过（lastRuns 无记录）的计划不算「错过」：它不是补跑，按常规 tick 触发；
 * - 所有计划只在应用进程运行期间才会被触发（事件 payload 用 `appRunningOnly: true` 说明）。
 *
 * 时间语义：daily 使用本地时区的「当天 HH:mm」时间点，跟随系统时区/DST；
 * 时间点不存在时（夏令时跳变）由 Date 归一化到邻近的合法时刻。
 */

/** 事件里用于说明「定时只在应用运行期间生效」，避免被误解成系统级计划任务 */
export const APP_RUNNING_ONLY = true

/** 常规轮询间隔；启动补跑不依赖它，会在插件加载稳定后单独触发 */
export const CHECK_INTERVAL_MS = 30_000

/** 间隔计划的最小/最大周期（分钟）与默认值，与 schemastery 配置范围一致 */
export const MIN_INTERVAL_MINUTES = 15
export const MAX_INTERVAL_MINUTES = 24 * 60
export const DEFAULT_INTERVAL_MINUTES = 120

/** daily 计划的默认时间点（凌晨 3 点），与配置默认值一致 */
export const DEFAULT_AT_HOUR = 3
export const DEFAULT_AT_MINUTE = 0

/**
 * 允许的「未来时间戳」窗口：lastRuns 里的值比当前时间还晚（时钟回拨/配置被手改）
 * 时，超过该窗口就视为损坏，按「从未运行」处理，避免计划被永久卡住。
 */
const MAX_FUTURE_SKEW_MS = 5 * 60_000

/** 计划判定需要的最小字段集（SchedulePlan 结构上兼容它） */
export interface PlanLike {
  id: string
  enabled?: boolean
  daily?: boolean
  everyMinutes?: number
  atHour?: number
  atMinute?: number
}

/** 一次「该跑」的判定结果 */
export interface PlannedRun<T extends PlanLike = PlanLike> {
  plan: T
  /** 上次运行时间；0 表示从未运行 */
  lastRunAt: number
  /** 本次运行结束后的下一次触发时间（纯函数无法预知运行耗时，调用方可传 projectedLastRun） */
  nextAt: number
  /** 是否为应用启动时的补跑（而非应用运行期间的常规轮询） */
  catchup: boolean
}

/** 把未知值转成有限数字；失败返回 NaN（调用方决定默认值） */
function toNumber(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim()) return Number(value)
  return Number.NaN
}

/** 间隔分钟数：非法值回落默认值，越界收敛到 [15, 1440] */
export function clampEveryMinutes(value: unknown): number {
  const num = toNumber(value)
  if (!Number.isFinite(num)) return DEFAULT_INTERVAL_MINUTES
  return Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.round(num)))
}

/** daily 小时：非法值回落默认值，越界收敛到 [0, 23] */
export function clampAtHour(value: unknown): number {
  const num = toNumber(value)
  if (!Number.isFinite(num)) return DEFAULT_AT_HOUR
  return Math.min(23, Math.max(0, Math.round(num)))
}

/** daily 分钟：非法值回落默认值，越界收敛到 [0, 59] */
export function clampAtMinute(value: unknown): number {
  const num = toNumber(value)
  if (!Number.isFinite(num)) return DEFAULT_AT_MINUTE
  return Math.min(59, Math.max(0, Math.round(num)))
}

/** 间隔计划的周期毫秒数 */
export function intervalMs(everyMinutes: unknown): number {
  return clampEveryMinutes(everyMinutes) * 60_000
}

/**
 * 把 lastRuns 中的值归一成可信的毫秒时间戳。
 * 非法值（非数字、<=0、比现在还晚超过容差窗口）返回 0，表示「从未运行」。
 */
export function toTimestamp(value: unknown, now = Date.now()): number {
  const num = toNumber(value)
  if (!Number.isFinite(num) || num <= 0) return 0
  if (num > now + MAX_FUTURE_SKEW_MS) return 0
  return Math.trunc(num)
}

/** lastRuns 配置损坏容错：只保留「合法 id → 可信时间戳」的条目 */
export function sanitizeLastRuns(value: unknown, now = Date.now()): Record<string, number> {
  const result: Record<string, number> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const id = typeof key === 'string' ? key.trim() : ''
    if (!id) continue
    const timestamp = toTimestamp(raw, now)
    if (timestamp > 0) result[id] = timestamp
  }
  return result
}

/** 计划是否处于启用状态（省略 enabled 视为启用，显式 false 才停用） */
export function isPlanEnabled(plan: PlanLike | null | undefined): boolean {
  return !!plan && typeof plan === 'object' && plan.enabled !== false
}

/** 运行时防御：配置损坏时数组里可能混入 null/非对象/没有 id 的条目 */
function isUsablePlan<T extends PlanLike>(plan: T | null | undefined): plan is T {
  return !!plan && typeof plan === 'object' && typeof plan.id === 'string' && plan.id.trim().length > 0
}

/** 当天（本地时区）的 HH:mm 触发时间点 */
export function dailyPointAt(plan: Pick<PlanLike, 'atHour' | 'atMinute'> | null | undefined, now = Date.now()): number {
  const date = new Date(now)
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    clampAtHour(plan?.atHour),
    clampAtMinute(plan?.atMinute),
    0,
    0,
  ).getTime()
}

/** 明天的 HH:mm 触发时间点（用日期 +1 构造，跨月/跨年由 Date 处理） */
function nextDailyPointAfter(plan: Pick<PlanLike, 'atHour' | 'atMinute'> | null | undefined, now: number): number {
  const date = new Date(now)
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + 1,
    clampAtHour(plan?.atHour),
    clampAtMinute(plan?.atMinute),
    0,
    0,
  ).getTime()
}

/**
 * daily 计划是否到期：今天的时间点已过，且上次运行在「今天这个时间点」之前。
 * 这样当天手动提前跑（例如 2:00 跑了、计划是 3:00）不会吃掉 3:00 的触发。
 */
export function isDailyDue(plan: PlanLike | null | undefined, lastRunAt: unknown, now = Date.now()): boolean {
  if (!isPlanEnabled(plan) || !plan) return false
  const point = dailyPointAt(plan, now)
  if (now < point) return false
  return toTimestamp(lastRunAt, now) < point
}

/** interval 计划是否到期：从未运行，或距上次运行已满一个周期 */
export function isIntervalDue(plan: PlanLike | null | undefined, lastRunAt: unknown, now = Date.now()): boolean {
  if (!isPlanEnabled(plan) || !plan) return false
  const last = toTimestamp(lastRunAt, now)
  if (last <= 0) return true
  return now - last >= intervalMs(plan.everyMinutes)
}

/** 统一到期判定：daily 走每天时间点，否则走固定间隔 */
export function isDue(plan: PlanLike | null | undefined, lastRunAt: unknown, now = Date.now()): boolean {
  if (!plan || typeof plan !== 'object') return false
  return plan.daily === true ? isDailyDue(plan, lastRunAt, now) : isIntervalDue(plan, lastRunAt, now)
}

/** `isDue` 的可读别名（对外契约用） */
export const isPlanDue = isDue

/**
 * 下一次触发时间（毫秒时间戳）；计划停用返回 null。
 *
 * - daily：未到点 → 今天的时间点；今天已跑过 → 明天的时间点；
 *   已过点但还没跑（已到期）→ now（下个 tick 会立刻补跑/触发）；
 * - interval：从未运行 → now（首次运行）；已到期 → now；未到期 → 上次运行 + 周期。
 *
 * 注意：纯函数不知道运行耗时；插件在事件 payload 里计算 nextAt 时会把
 * 「本次运行的时间」当作 projectedLastRun 传进来，因此正常事件里的 nextAt 总是未来时间。
 */
export function nextRunAt(plan: PlanLike | null | undefined, lastRunAt: unknown, now = Date.now()): number | null {
  if (!isPlanEnabled(plan) || !plan) return null
  const last = toTimestamp(lastRunAt, now)
  if (plan.daily === true) {
    const point = dailyPointAt(plan, now)
    if (now < point) return point
    if (last < point) return now
    return nextDailyPointAfter(plan, now)
  }
  const period = intervalMs(plan.everyMinutes)
  if (last <= 0) return now
  const next = last + period
  return next <= now ? now : next
}

/** `nextRunAt` 的别名（便于按语义选择命名） */
export const computeNextRunAt = nextRunAt

/**
 * 启动补跑判定：应用刚启动时，该计划是否已错过触发点。
 *
 * - 必须有上次运行记录（从未运行不算「错过」，按常规 tick 处理）；
 * - daily：今天的时间点已过，且上次运行早于今天的时间点（跨天/跨时区后仍成立）；
 * - interval：距上次运行已满一个完整周期。
 */
export function missedOnStartup(plan: PlanLike | null | undefined, lastRunAt: unknown, startedAt = Date.now()): boolean {
  if (!isPlanEnabled(plan) || !plan) return false
  const last = toTimestamp(lastRunAt, startedAt)
  if (last <= 0) return false
  if (plan.daily === true) {
    const point = dailyPointAt(plan, startedAt)
    return startedAt >= point && last < point
  }
  return startedAt - last >= intervalMs(plan.everyMinutes)
}

/**
 * 应用启动时收集需要「补跑一次」的计划。
 * 首次 tick 执行它，补跑完成后插件会写 lastRuns，因此同一会话不会重复补跑。
 */
export function startupCatchupPlans<T extends PlanLike>(
  plans: readonly (T | null | undefined)[] | null | undefined,
  lastRuns: unknown,
  startedAt = Date.now(),
): PlannedRun<T>[] {
  const safeLastRuns = sanitizeLastRuns(lastRuns, startedAt)
  const result: PlannedRun<T>[] = []
  for (const plan of Array.isArray(plans) ? plans : []) {
    if (!isUsablePlan(plan)) continue
    const lastRunAt = safeLastRuns[plan.id] ?? 0
    if (!missedOnStartup(plan, lastRunAt, startedAt)) continue
    result.push({ plan, lastRunAt, nextAt: nextRunAt(plan, lastRunAt, startedAt) ?? startedAt, catchup: true })
  }
  return result
}

/** 常规轮询：收集当前所有到期计划（应用运行期间使用，不区分是否错过） */
export function collectDuePlans<T extends PlanLike>(
  plans: readonly (T | null | undefined)[] | null | undefined,
  lastRuns: unknown,
  now = Date.now(),
): PlannedRun<T>[] {
  const safeLastRuns = sanitizeLastRuns(lastRuns, now)
  const result: PlannedRun<T>[] = []
  for (const plan of Array.isArray(plans) ? plans : []) {
    if (!isUsablePlan(plan)) continue
    const lastRunAt = safeLastRuns[plan.id] ?? 0
    if (!isDue(plan, lastRunAt, now)) continue
    result.push({ plan, lastRunAt, nextAt: nextRunAt(plan, lastRunAt, now) ?? now, catchup: false })
  }
  return result
}
