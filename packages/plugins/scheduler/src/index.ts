/**
 * 定时扫描插件（scheduler）。
 *
 * 设计取舍：
 * - **只扫描、只通知**：定时任务不应该在无人值守时删文件；自动清理需要「计划级授权」，
 *   会在后续版本以独立的 authorize 流程加入（规则版本绑定，规则一变授权即失效）。
 * - 用 `ctx.effect` 管理定时器：插件被禁用 / 配置热重载时定时器自动清理，不会泄漏。
 * - 每 30 秒检查一次是否到期，避免长期 sleep 造成的漂移。
 * - 扫描结果通过 `scheduler/scan` 事件广播给外壳（网页 toast / 桌面通知），
 *   用户点开后再决定是否清理。
 */
import Schema from 'schemastery'
import { defineCleanerPlugin, formatBytes } from '@cordclean/shared'
import type { ScanReport } from '@cordclean/shared'
import { errorMessage } from '@cordclean/utils'

export interface SchedulerConfig {
  /** 是否启用定时扫描 */
  enabled: boolean
  /** 扫描间隔（分钟，最小 15） */
  everyMinutes: number
  /** 只扫描这些任务（留空 = 全部任务） */
  taskIds: string[]
}

export const Config: Schema<SchedulerConfig> = Schema.object({
  enabled: Schema.boolean().default(false).description('启用定时扫描（只扫描并通知，不会自动删除）'),
  everyMinutes: Schema.number().min(15).max(24 * 60).default(120).description('扫描间隔（分钟）'),
  taskIds: Schema.array(Schema.string()).default([]).description('只扫描这些任务 id（留空 = 全部）'),
})

const CHECK_INTERVAL_MS = 30_000

export default defineCleanerPlugin({
  name: 'scheduler',
  description: '定时扫描并在完成后通知，可配置间隔与任务范围',
  Config,
  inject: ['cleaner'],
  setup(ctx, config) {
    let lastRun = 0

    ctx.effect(() => {
      if (!config.enabled) return () => {}
      const everyMs = Math.max(15, config.everyMinutes) * 60_000
      ctx.logger.info('定时扫描已启用：每 %d 分钟一次', Math.max(15, config.everyMinutes))

      const timer = setInterval(async () => {
        const now = Date.now()
        if (now - lastRun < everyMs) return
        lastRun = now
        try {
          const report: any = await (ctx.cleaner as any).scan(config.taskIds.length ? { taskIds: config.taskIds } : {})
          let totalBytes = 0
          for (const item of (report.items as any[])) totalBytes += item.size
          (ctx.emit as any)('scheduler/scan', {
            at: now,
            items: report.items.length,
            bytes: totalBytes,
            elapsedMs: report.elapsedMs,
            errors: report.errors.length,
          })
          (ctx.logger as any).info('定时扫描完成：%d 项，%s，耗时 %d ms', report.items.length, formatBytes(totalBytes), report.elapsedMs)
        } catch (error) {
          (ctx.logger as any).warn('定时扫描失败：%s', errorMessage(error))
          (ctx.emit as any)('scheduler/scan', { at: now, error: errorMessage(error) })
        }
      }, CHECK_INTERVAL_MS)

      return () => clearInterval(timer)
    })
  },
})
