/**
 * 定时任务插件（scheduler）——多计划 + 持久化 + 启动补跑。
 *
 * 计划保存在插件配置 `plans[]`；上次运行时间持久化在 `settings.scheduler.lastRuns`，
 * 因此重启后间隔不会重置。自动清理仍需按计划授权，授权绑定规则指纹。
 *
 * 相对「30 秒轮询」的增强（纯函数在 ./schedule.ts，可单测）：
 * - **启动补跑**：应用启动、插件集合稳定后，检查 daily 当天时间点已过 / interval 距上次
 *   已满一个周期的计划，补跑一次并写入 lastRuns，避免应用关闭期间错过就整段跳过；
 * - **nextRunAt**：每次 `scheduler/scan` 事件附带 `nextAt`，说明下一次触发的绝对时间；
 * - 事件统一带 `appRunningOnly: true`：定时只在应用运行期间生效，不是系统计划任务；
 * - 补跑与常规触发走同一个 runPlan：同样的规则指纹授权、同样只清理 safe 项。
 */
import { createHash } from 'node:crypto'
import Schema from 'schemastery'
import { defineCleanerPlugin } from '@cordclean/shared'
import { errorMessage } from '@cordclean/utils'
import {
  APP_RUNNING_ONLY,
  CHECK_INTERVAL_MS,
  clampAtHour,
  clampAtMinute,
  clampEveryMinutes,
  collectDuePlans,
  nextRunAt,
  sanitizeLastRuns,
  startupCatchupPlans,
  type PlanLike,
} from './schedule.ts'

export * from './schedule.ts'

export interface SchedulePlan extends PlanLike {
  name: string
  enabled: boolean
  daily: boolean
  everyMinutes: number
  atHour: number
  atMinute: number
  taskIds: string[]
  mode: 'scan' | 'clean'
  authorizedHash: string
}

export interface SchedulerConfig {
  plans: SchedulePlan[]
  enabled: boolean
  everyMinutes: number
  taskIds: string[]
  mode: 'scan' | 'clean'
  authorizedHash: string
  daily: boolean
  atHour: number
  atMinute: number
}

const PlanSchema = Schema.object({
  id: Schema.string().required(),
  name: Schema.string().default('定时任务'),
  enabled: Schema.boolean().default(true),
  daily: Schema.boolean().default(false),
  everyMinutes: Schema.number().min(15).max(24 * 60).default(120),
  atHour: Schema.number().min(0).max(23).default(3),
  atMinute: Schema.number().min(0).max(59).default(0),
  taskIds: Schema.array(Schema.string()).default([]),
  mode: Schema.union(['scan', 'clean']).default('scan'),
  authorizedHash: Schema.string().default(''),
})

export const Config: Schema<SchedulerConfig> = Schema.object({
  plans: Schema.array(PlanSchema).default([]),
  enabled: Schema.boolean().default(false),
  everyMinutes: Schema.number().min(15).max(24 * 60).default(120),
  taskIds: Schema.array(Schema.string()).default([]),
  mode: Schema.union(['scan', 'clean']).default('scan'),
  authorizedHash: Schema.string().default(''),
  daily: Schema.boolean().default(false),
  atHour: Schema.number().min(0).max(23).default(3),
  atMinute: Schema.number().min(0).max(59).default(0),
})

/**
 * 启动补跑调度参数：
 * - 等插件集合稳定（`plugins/changed` 停止抖动）后再补跑，避免扫描到尚未加载完成的任务；
 * - 兜底定时器保证即使没收到事件，也会在启动后不久检查一次。
 */
const CATCHUP_DEBOUNCE_MS = 400
const CATCHUP_FALLBACK_MS = 2_000

/** 规则 + 计划范围指纹：规则开关或统计变化、以及计划的任务范围/删除模式变化，都会让授权失效 */
export interface RulesHashScope {
  id?: string
  taskIds?: string[]
  mode?: string
  everyMinutes?: number
}

export function rulesHash(ctx: any, scope: RulesHashScope = {}): string {
  const settings = ctx.settings.get()
  const stats = ctx.rules?.stats?.() ?? {}
  return createHash('sha1')
    .update(JSON.stringify({
      includeRisky: settings.rules.includeRisky,
      includeDeep: settings.rules.includeDeep,
      includeCustom: settings.rules.includeCustom,
      stats,
      // 把计划范围纳入指纹：只授权「这些任务 + clean 模式」，改范围后必须重新授权
      plan: {
        id: scope.id ?? '',
        taskIds: [...(scope.taskIds ?? [])].sort(),
        mode: scope.mode ?? 'scan',
        everyMinutes: scope.everyMinutes ?? 0,
      },
    }))
    .digest('hex')
    .slice(0, 16)
}

/** 任务 id 列表归一：去空、去空格、去重（授权指纹与运行时都必须用同一份归一结果） */
function normalizeTaskIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids = value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
  return [...new Set(ids)]
}

/** 单个计划条目的容错归一化：配置损坏（非对象、缺 id、字段类型错误）时返回 null 丢弃 */
function normalizePlan(raw: unknown, index: number): SchedulePlan | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const source = raw as Record<string, unknown>
  const id = typeof source.id === 'string' ? source.id.trim() : ''
  if (!id) return null
  const name = typeof source.name === 'string' && source.name.trim() ? source.name.trim() : `计划 ${index + 1}`
  const taskIds = normalizeTaskIds(source.taskIds)
  return {
    id,
    name,
    enabled: source.enabled !== false,
    daily: source.daily === true,
    everyMinutes: clampEveryMinutes(source.everyMinutes),
    atHour: clampAtHour(source.atHour),
    atMinute: clampAtMinute(source.atMinute),
    taskIds,
    mode: source.mode === 'clean' ? 'clean' : 'scan',
    authorizedHash: typeof source.authorizedHash === 'string' ? source.authorizedHash.trim() : '',
  }
}

/**
 * 计划归一化：优先用 `plans[]`；空数组时把旧版单计划字段迁移成 plans[0]。
 * 配置损坏（plans 非数组、条目缺 id、字段越界）不会抛错，非法条目直接丢弃。
 */
export function normalizePlans(config: Partial<SchedulerConfig> | null | undefined): SchedulePlan[] {
  const rawPlans: unknown[] = config && Array.isArray(config.plans) ? (config.plans as unknown[]) : []
  const seen = new Set<string>()
  const plans: SchedulePlan[] = []
  for (let index = 0; index < rawPlans.length; index++) {
    const plan = normalizePlan(rawPlans[index], index)
    if (!plan || seen.has(plan.id)) continue
    seen.add(plan.id)
    plans.push(plan)
  }
  if (plans.length) return plans
  // 旧版单计划配置迁移成 plans[0]（同样逐字段容错）
  const legacy = normalizePlan({
    id: 'default',
    name: '默认计划',
    enabled: config?.enabled === true,
    daily: config?.daily,
    everyMinutes: config?.everyMinutes,
    atHour: config?.atHour,
    atMinute: config?.atMinute,
    taskIds: config?.taskIds,
    mode: config?.mode,
    authorizedHash: config?.authorizedHash,
  }, 0)
  return legacy ? [legacy] : []
}

export default defineCleanerPlugin<SchedulerConfig>({
  name: 'scheduler',
  version: '2.1.0',
  description: '多计划定时扫描；启动补跑错过的计划，授权后可自动清理安全项，规则一变授权失效',
  inject: ['cleaner', 'settings', 'rules'],
  Config,
  setup(ctx, config) {
    /** 本插件实例是否仍处于激活状态（fiber 销毁后排队中的旧任务不再执行） */
    let active = true
    /** 串行队列：多个计划/多个来源的扫描排队执行，避免 cleaner 的「新扫描中止旧扫描」互相打断 */
    let queue: Promise<void> = Promise.resolve()

    const plans = (): SchedulePlan[] => normalizePlans(config)
    const readLastRuns = (): Record<string, number> => sanitizeLastRuns(ctx.settings.get().scheduler?.lastRuns)

    /** 写回 lastRuns：用 set 整体替换（patch 是深合并，会把已删除计划的旧记录一直留着） */
    const markRun = (planId: string): void => {
      const next = readLastRuns()
      next[planId] = Date.now()
      ctx.settings.set('scheduler.lastRuns', next)
    }

    /**
     * 发出 scheduler/scan 事件：保留原有 payload 字段，额外补上
     * `nextAt`（下次触发时间）与 `appRunningOnly: true`（定时仅在应用运行期间生效）。
     */
    const emitScan = (plan: SchedulePlan, payload: Record<string, unknown>, projectedLastRun?: number): void => {
      const at = Date.now()
      const lastRunAt = projectedLastRun ?? readLastRuns()[plan.id] ?? 0
      ;(ctx.emit as any)('scheduler/scan', {
        at,
        appRunningOnly: APP_RUNNING_ONLY,
        nextAt: nextRunAt(plan, lastRunAt, at),
        ...payload,
      })
    }

    /**
     * 计划的 taskIds 引用的任务是否都已注册。
     * 启动补跑发生在插件加载阶段之后，但外部/慢加载插件仍可能缺席；
     * 此时先不补跑（留到下一次常规 tick），避免 cleaner.scan 因未知任务 id 报错。
     * taskIds 为空表示「全部任务」，无需等待。
     */
    const tasksReady = (plan: SchedulePlan): boolean => {
      if (!plan.taskIds.length) return true
      const cleaner = ctx.cleaner as any
      if (typeof cleaner.has !== 'function') return true
      return plan.taskIds.every((taskId) => cleaner.has(taskId) === true)
    }

    /** 执行一个计划（常规触发与启动补跑共用：同一授权校验、同样只清理 safe 项） */
    const runPlan = async (plan: SchedulePlan, catchup = false): Promise<void> => {
      if (!active) return
      try {
        const report: any = await (ctx.cleaner as any).scan(plan.taskIds.length ? { taskIds: plan.taskIds } : {})
        let totalBytes = 0
        for (const item of report.items as any[]) totalBytes += item.size
        // 本次运行结束后的「上次运行时间」近似值：用于事件里的 nextAt，使之指向未来时间
        const runAt = Date.now()
        emitScan(plan, {
          planId: plan.id,
          planName: plan.name,
          items: report.items.length,
          bytes: totalBytes,
          elapsedMs: report.elapsedMs,
          errors: report.errors.length,
          ...(catchup ? { catchup: true } : {}),
        }, runAt)

        if (plan.mode === 'clean') {
          const hash = rulesHash(ctx, plan)
          if (!plan.authorizedHash || plan.authorizedHash !== hash) {
            // 授权失效：payload 字段保持不变（blocked + reason），只由 emitScan 统一补 nextAt/appRunningOnly
            emitScan(plan, {
              planId: plan.id,
              planName: plan.name,
              blocked: true,
              reason: '规则已变化，自动清理授权失效，请重新授权',
            }, runAt)
          } else {
            // 与手动/常规触发一致：只清理未被保护且风险为 safe 的项
            const safeItems = (report.items as any[]).filter((item) => !item.protected && item.risk === 'safe')
            if (safeItems.length) {
              const cleaned: any = await (ctx.cleaner as any).clean({ items: safeItems })
              emitScan(plan, {
                planId: plan.id,
                planName: plan.name,
                autoCleaned: true,
                cleaned: cleaned.cleaned,
                freedBytes: cleaned.freedBytes,
                recycledBytes: cleaned.recycledBytes,
                mode: cleaned.mode,
                ...(catchup ? { catchup: true } : {}),
              }, runAt)
            }
          }
        }

        // 成功走到这里才写 lastRuns：失败会保留「到期」状态，下个 tick 自动重试
        markRun(plan.id)
      } catch (error) {
        // 失败 payload 字段保持不变（error），只由 emitScan 统一补 nextAt/appRunningOnly
        emitScan(plan, { planId: plan.id, planName: plan.name, error: errorMessage(error) })
      }
    }

    /** 把一批计划放进串行队列执行（同一时刻只有一次清理器扫描在跑） */
    const enqueue = (work: () => Promise<void>): void => {
      queue = queue.then(async () => {
        if (!active) return
        await work()
      }).catch(() => { /* runPlan 内部已记录错误；队列本身不允许中断 */ })
    }

    const enqueuePlans = (items: Array<{ plan: SchedulePlan; catchup: boolean }>): void => {
      if (!items.length) return
      enqueue(async () => {
        for (const item of items) {
          if (!active) return
          await runPlan(item.plan, item.catchup)
        }
      })
    }

    ;(ctx.on as any)('scheduler/run', (planId?: string) => {
      // 手动「立即运行」保持原有语义：指定的计划即使停用也会执行
      const targets = plans().filter((plan) => !planId || plan.id === planId)
      enqueuePlans(targets.map((plan) => ({ plan, catchup: false })))
    })

    ;(ctx.on as any)('scheduler/authorize', (patch: { planId?: string; taskIds?: string[]; everyMinutes?: number }, done: (next: SchedulerConfig) => void) => {
      const target = patch.planId ?? plans()[0]?.id
      if (!target) return
      const current = plans().find((plan) => plan.id === target)
      if (!current) return
      // 授权时把计划范围一起绑定进指纹（并写入配置，保证后续运行按同一范围校验）
      const effective: SchedulePlan = {
        ...current,
        enabled: true,
        mode: 'clean',
        everyMinutes: clampEveryMinutes(patch.everyMinutes ?? current.everyMinutes),
        // taskIds 先归一（trim/去重），保证指纹与运行时读到的计划范围一致
        taskIds: Array.isArray(patch.taskIds) ? normalizeTaskIds(patch.taskIds) : current.taskIds,
      }
      const hash = rulesHash(ctx, effective)
      effective.authorizedHash = hash
      done({
        ...config,
        plans: plans().map((plan) => (plan.id === target ? effective : plan)),
        enabled: false,
        mode: 'scan',
        authorizedHash: '',
      })
    })

    ;(ctx.on as any)('scheduler/revoke', (planId: string | undefined, done: (next: SchedulerConfig) => void) => {
      done({
        ...config,
        plans: plans().map((plan) => ((planId ? plan.id === planId : true) ? { ...plan, mode: 'scan', authorizedHash: '' } : plan)),
        mode: 'scan',
        authorizedHash: '',
      })
    })

    ctx.effect(() => {
      let catchupDone = false
      let catchupTimer: ReturnType<typeof setTimeout> | undefined
      let fallbackTimer: ReturnType<typeof setTimeout> | undefined

      /** 启动补跑：只跑「应用不在运行时已错过」的计划，跑完写 lastRuns（同一会话不会再补） */
      const runCatchup = (): void => {
        if (catchupDone) return
        catchupDone = true
        if (catchupTimer) {
          clearTimeout(catchupTimer)
          catchupTimer = undefined
        }
        if (fallbackTimer) {
          clearTimeout(fallbackTimer)
          fallbackTimer = undefined
        }
        // 清单在队列真正执行时再算：如果补跑前面还有手动运行，lastRuns 已经更新，避免重复补跑
        enqueue(async () => {
          const missed = startupCatchupPlans(plans(), readLastRuns(), Date.now()).filter((item) => tasksReady(item.plan))
          if (!missed.length) return
          ;(ctx.logger as any).info('启动补跑：%d 个计划已错过，立即补跑一次', missed.length)
          for (const item of missed) {
            if (!active) return
            await runPlan(item.plan, true)
          }
        })
      }

      /** 等插件集合稳定再补跑：每次 plugins/changed 重置防抖，避免扫描到尚未加载的任务 */
      const scheduleCatchup = (): void => {
        if (catchupDone) return
        if (catchupTimer) clearTimeout(catchupTimer)
        catchupTimer = setTimeout(runCatchup, CATCHUP_DEBOUNCE_MS)
      }

      const timer = setInterval(() => {
        // 到期判定放在队列执行时：前面的补跑可能已经更新 lastRuns，避免重复触发
        enqueue(async () => {
          const due = collectDuePlans(plans(), readLastRuns(), Date.now())
          for (const item of due) {
            if (!active) return
            await runPlan(item.plan, item.catchup)
          }
        })
      }, CHECK_INTERVAL_MS)

      const offChanged = (ctx.on as any)('plugins/changed', scheduleCatchup)
      scheduleCatchup()
      fallbackTimer = setTimeout(runCatchup, CATCHUP_FALLBACK_MS)

      return () => {
        active = false
        clearInterval(timer)
        if (catchupTimer) clearTimeout(catchupTimer)
        if (fallbackTimer) clearTimeout(fallbackTimer)
        if (typeof offChanged === 'function') offChanged()
      }
    })

    ;(ctx.logger as any).info('定时任务已加载：%d 个计划（仅应用运行期间生效）', plans().length)
  },
})
