/**
 * 定时扫描/清理插件（scheduler）。
 *
 * 两条运行模式：
 * - `scan`：只扫描并通过 `scheduler/scan` 事件通知（默认）；
 * - `clean`：扫描后自动清理 **risk=safe** 的项，但必须先「授权」。
 *
 * 计划级授权：
 * - 授权时把**当前规则指纹**（分类开关 + 规则统计）写入 `authorizedHash`；
 * - 每次自动清理前重新计算指纹，不一致就跳过清理并通知「规则已变，请重新授权」；
 * - 因此改规则 / 采纳 AI 规则之后，旧的无人值守授权自动失效。
 *
 * 定时器用 `ctx.effect` 管理，插件禁用或配置热重载时自动销毁。
 */
import { createHash } from 'node:crypto'
import Schema from 'schemastery'
import { defineCleanerPlugin, formatBytes } from '@cordclean/shared'
import { errorMessage } from '@cordclean/utils'

export interface SchedulerConfig {
  enabled: boolean
  everyMinutes: number
  taskIds: string[]
  /** scan = 只通知；clean = 授权后自动清理安全项 */
  mode: 'scan' | 'clean'
  /** 授权时的规则指纹；为空表示未授权 */
  authorizedHash: string
}

export const Config: Schema<SchedulerConfig> = Schema.object({
  enabled: Schema.boolean().default(false).description('启用定时任务'),
  everyMinutes: Schema.number().min(15).max(24 * 60).default(120).description('执行间隔（分钟）'),
  taskIds: Schema.array(Schema.string()).default([]).description('只处理这些任务 id（留空 = 全部）'),
  mode: Schema.union(['scan', 'clean']).default('scan').description('scan=只扫描通知；clean=授权后自动清理安全项'),
  authorizedHash: Schema.string().default('').description('规则指纹（由「授权自动清理」写入，不要手改）'),
})

const CHECK_INTERVAL_MS = 30_000

/** 规则指纹：任何影响规则集合的开关或统计变化都会导致指纹变化 */
export function rulesHash(ctx: any): string {
  const settings = ctx.settings.get()
  const stats = ctx.rules?.stats?.() ?? {}
  return createHash('sha1')
    .update(
      JSON.stringify({
        includeRisky: settings.rules.includeRisky,
        includeDeep: settings.rules.includeDeep,
        includeCustom: settings.rules.includeCustom,
        stats,
      }),
    )
    .digest('hex')
    .slice(0, 16)
}

export default defineCleanerPlugin<SchedulerConfig>({
  name: 'scheduler',
  version: '1.1.0',
  description: '定时扫描并通知；授权后可自动清理安全项，规则一变授权失效',
  inject: ['cleaner', 'settings', 'rules'],
  Config,
  setup(ctx, config) {
    let lastRun = 0

    const notify = (payload: Record<string, unknown>) => {
      ;(ctx.emit as any)('scheduler/scan', { at: Date.now(), ...payload })
    }

    const runOnce = async () => {
      try {
        const report: any = await (ctx.cleaner as any).scan(config.taskIds.length ? { taskIds: config.taskIds } : {})
        let totalBytes = 0
        for (const item of report.items as any[]) totalBytes += item.size
        notify({ items: report.items.length, bytes: totalBytes, elapsedMs: report.elapsedMs, errors: report.errors.length })

        if (config.mode !== 'clean') return
        const hash = rulesHash(ctx)
        if (!config.authorizedHash || config.authorizedHash !== hash) {
          notify({ blocked: true, reason: '规则已变化，自动清理授权失效，请重新授权' })
          return
        }
        const safeItems = (report.items as any[]).filter((item) => !item.protected && item.risk === 'safe')
        if (!safeItems.length) return
        const cleaned: any = await (ctx.cleaner as any).clean({ items: safeItems })
        notify({
          autoCleaned: true,
          cleaned: cleaned.cleaned,
          freedBytes: cleaned.freedBytes,
          recycledBytes: cleaned.recycledBytes,
          mode: cleaned.mode,
        })
        ;(ctx.logger as any).info(
          '定时自动清理：%d 项，释放 %s（回收站 %s）',
          cleaned.cleaned,
          formatBytes(cleaned.freedBytes),
          formatBytes(cleaned.recycledBytes),
        )
      } catch (error) {
        notify({ error: errorMessage(error) })
      }
    }

    // 手动触发（界面「立即运行」），不受间隔限制
    ;(ctx.on as any)('scheduler/run', () => {
      lastRun = Date.now()
      void runOnce()
    })

    // 授权：由宿主转发，计算当前指纹后回调新的插件配置
    ;(ctx.on as any)('scheduler/authorize', (patch: Partial<SchedulerConfig>, done: (next: SchedulerConfig) => void) => {
      done({
        ...config,
        ...patch,
        enabled: true,
        mode: 'clean',
        authorizedHash: rulesHash(ctx),
      })
    })

    ctx.effect(() => {
      if (!config.enabled) return () => {}
      const everyMs = Math.max(15, config.everyMinutes) * 60_000
      ;(ctx.logger as any).info('定时任务已启用：每 %d 分钟一次，模式 %s', Math.max(15, config.everyMinutes), config.mode)
      const timer = setInterval(() => {
        const now = Date.now()
        if (now - lastRun < everyMs) return
        lastRun = now
        void runOnce()
      }, CHECK_INTERVAL_MS)
      return () => clearInterval(timer)
    })
  },
})
