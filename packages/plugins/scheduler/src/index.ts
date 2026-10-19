/**
 * 定时任务插件（scheduler）——多计划 + 持久化。
 *
 * 计划保存在插件配置 `plans[]`；上次运行时间持久化在 `settings.scheduler.lastRuns`，
 * 因此重启后间隔不会重置。自动清理仍需按计划授权，授权绑定规则指纹。
 */
import { createHash } from 'node:crypto'
import Schema from 'schemastery'
import { defineCleanerPlugin } from '@cordclean/shared'
import { errorMessage } from '@cordclean/utils'

export interface SchedulePlan {
  id: string
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

/** 规则指纹：规则开关或统计变化都会导致授权失效 */
export function rulesHash(ctx: any): string {
  const settings = ctx.settings.get()
  const stats = ctx.rules?.stats?.() ?? {}
  return createHash('sha1')
    .update(JSON.stringify({
      includeRisky: settings.rules.includeRisky,
      includeDeep: settings.rules.includeDeep,
      includeCustom: settings.rules.includeCustom,
      stats,
    }))
    .digest('hex')
    .slice(0, 16)
}

/** 旧版单计划配置迁移成 plans[0] */
export function normalizePlans(config: SchedulerConfig): SchedulePlan[] {
  if (Array.isArray(config.plans) && config.plans.length) return config.plans
  return [{
    id: 'default',
    name: '默认计划',
    enabled: config.enabled === true,
    daily: config.daily === true,
    everyMinutes: config.everyMinutes || 120,
    atHour: config.atHour ?? 3,
    atMinute: config.atMinute ?? 0,
    taskIds: config.taskIds ?? [],
    mode: config.mode === 'clean' ? 'clean' : 'scan',
    authorizedHash: config.authorizedHash ?? '',
  }]
}

const CHECK_INTERVAL_MS = 30_000

export default defineCleanerPlugin<SchedulerConfig>({
  name: 'scheduler',
  version: '2.0.0',
  description: '多计划定时扫描；授权后可自动清理安全项，规则一变授权失效',
  inject: ['cleaner', 'settings', 'rules'],
  Config,
  setup(ctx, config) {
    const notify = (payload: Record<string, unknown>) => {
      ;(ctx.emit as any)('scheduler/scan', { at: Date.now(), ...payload })
    }
    const plans = (): SchedulePlan[] => normalizePlans(config)
    const lastRuns = (): Record<string, number> => ({ ...(ctx.settings.get().scheduler?.lastRuns ?? {}) })

    const due = (plan: SchedulePlan): boolean => {
      if (!plan.enabled) return false
      const last = lastRuns()[plan.id] ?? 0
      if (plan.daily) {
        const now = new Date()
        const key = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
        const prev = last ? new Date(last) : undefined
        const prevKey = prev ? `${prev.getFullYear()}-${prev.getMonth() + 1}-${prev.getDate()}` : ''
        return prevKey !== key && now.getHours() * 60 + now.getMinutes() >= plan.atHour * 60 + plan.atMinute
      }
      return Date.now() - last >= Math.max(15, plan.everyMinutes) * 60_000
    }

    const runPlan = async (plan: SchedulePlan) => {
      try {
        const report: any = await (ctx.cleaner as any).scan(plan.taskIds.length ? { taskIds: plan.taskIds } : {})
        let totalBytes = 0
        for (const item of report.items as any[]) totalBytes += item.size
        notify({ planId: plan.id, planName: plan.name, items: report.items.length, bytes: totalBytes, elapsedMs: report.elapsedMs, errors: report.errors.length })

        if (plan.mode === 'clean') {
          const hash = rulesHash(ctx)
          if (!plan.authorizedHash || plan.authorizedHash !== hash) {
            notify({ planId: plan.id, planName: plan.name, blocked: true, reason: '规则已变化，自动清理授权失效，请重新授权' })
          } else {
            const safeItems = (report.items as any[]).filter((item) => !item.protected && item.risk === 'safe')
            if (safeItems.length) {
              const cleaned: any = await (ctx.cleaner as any).clean({ items: safeItems })
              notify({
                planId: plan.id,
                planName: plan.name,
                autoCleaned: true,
                cleaned: cleaned.cleaned,
                freedBytes: cleaned.freedBytes,
                recycledBytes: cleaned.recycledBytes,
                mode: cleaned.mode,
              })
            }
          }
        }

        const next = lastRuns()
        next[plan.id] = Date.now()
        ctx.settings.patch({ scheduler: { lastRuns: next } } as any)
      } catch (error) {
        notify({ planId: plan.id, planName: plan.name, error: errorMessage(error) })
      }
    }

    ;(ctx.on as any)('scheduler/run', (planId?: string) => {
      for (const plan of plans()) {
        if (!planId || plan.id === planId) void runPlan(plan)
      }
    })

    ;(ctx.on as any)('scheduler/authorize', (patch: { planId?: string }, done: (next: SchedulerConfig) => void) => {
      const hash = rulesHash(ctx)
      const target = patch.planId ?? plans()[0]?.id
      done({
        ...config,
        plans: plans().map((plan) => (plan.id === target ? { ...plan, enabled: true, mode: 'clean', authorizedHash: hash } : plan)),
        enabled: false,
        mode: 'scan',
        authorizedHash: '',
      })
    })

    ;(ctx.on as any)('scheduler/revoke', (planId: string | undefined, done: (next: SchedulerConfig) => void) => {
      done({
        ...config,
        plans: plans().map((plan) => (plan.id === (planId ?? plan.id) ? { ...plan, mode: 'scan', authorizedHash: '' } : plan)),
      })
    })

    ctx.effect(() => {
      const timer = setInterval(() => {
        for (const plan of plans()) {
          if (due(plan)) void runPlan(plan)
        }
      }, CHECK_INTERVAL_MS)
      return () => clearInterval(timer)
    })

    ;(ctx.logger as any).info('定时任务已加载：%d 个计划', plans().length)
  },
})
