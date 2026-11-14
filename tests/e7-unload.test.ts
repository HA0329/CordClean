import { describe, expect, it } from 'vitest'
import { createApp } from '@cordclean/core'
import { defineCleanerPlugin } from '@cordclean/shared'
import { createSandbox, manifestOf } from './helpers.ts'

interface E7State {
  timerTicks: number
  probeEvents: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * E7：插件卸载无残留验证。
 *
 * 正例：所有可观测副作用都通过 ctx.effect 登记，卸载后回到基线。
 * 反例：等价副作用不登记，卸载后留下任务/辖区/UI/定时器（说明“有框架”不等于“自动免疫”）。
 */
describe('E7 插件卸载无残留', () => {
  it('ctx.effect 登记的资源随 fiber 卸载归零，未登记的反例产生可观测残留', async () => {
    const sandbox = createSandbox()
    const positiveState: E7State = { timerTicks: 0, probeEvents: 0 }
    const negativeState: E7State & { disposers: Array<() => void>; timer?: NodeJS.Timeout } = {
      timerTicks: 0,
      probeEvents: 0,
      disposers: [],
    }

    const positiveRoot = sandbox.dir('e7-positive-root')
    const negativeRoot = sandbox.dir('e7-negative-root')

    const positive = defineCleanerPlugin({
      name: 'e7-positive',
      inject: ['cleaner', 'pathPolicy', 'ui'],
      setup(ctx) {
        // 1) 受控定时器
        ctx.effect(() => {
          const timer = setInterval(() => {
            positiveState.timerTicks += 1
          }, 10)
          timer.unref?.()
          return () => clearInterval(timer)
        }, 'e7/interval')

        // 2) 任务 + 辖区 + UI + 事件监听，全部集中登记
        ctx.effect(() => {
          const disposeTask = ctx.cleaner.define({
            id: 'e7-positive-task',
            name: 'E7 正例任务',
            category: 'disk',
            risk: 'safe',
            targets: [positiveRoot],
            scan() {},
          })
          const disposeRoot = ctx.pathPolicy.addRoot(positiveRoot, 'e7-positive')
          const disposeUi = ctx.ui.register('e7-positive', {
            statusItems: [{ id: 'e7-positive', label: 'E7 正例' }],
          })
          const offProbe = (ctx.on as any)('e7/probe', () => {
            positiveState.probeEvents += 1
          }) as () => void
          return () => {
            offProbe()
            disposeUi()
            disposeRoot()
            disposeTask()
          }
        }, 'e7/effects')
      },
    })

    const negative = defineCleanerPlugin({
      name: 'e7-negative',
      inject: ['cleaner', 'pathPolicy', 'ui'],
      setup(ctx) {
        // 等价副作用，但故意不通过 ctx.effect 登记
        const taskDispose = ctx.cleaner.define({
          id: 'e7-negative-task',
          name: 'E7 反例任务',
          category: 'disk',
          risk: 'safe',
          targets: [negativeRoot],
          scan() {},
        })
        const rootDispose = ctx.pathPolicy.addRoot(negativeRoot, 'e7-negative')
        const uiDispose = ctx.ui.register('e7-negative', {
          statusItems: [{ id: 'e7-negative', label: 'E7 反例' }],
        })
        const timer = setInterval(() => {
          negativeState.timerTicks += 1
        }, 10)
        timer.unref?.()
        negativeState.timer = timer
        negativeState.disposers.push(taskDispose, rootDispose, uiDispose)
      },
    })

    const app = await createApp({
      dataDir: sandbox.dataDir,
      logger: false,
      manifest: manifestOf([
        { id: 'e7-positive', plugin: positive, defaultEnabled: false },
        { id: 'e7-negative', plugin: negative, defaultEnabled: false },
      ]),
    })

    const snapshot = () => ({
      tasks: app.ctx.cleaner.list().map((task) => task.id).sort(),
      roots: app.ctx.pathPolicy.roots().map((root) => root.toLowerCase()).sort(),
      ui: app.ctx.ui.list().map((entry) => entry.pluginId).sort(),
    })
    const baseline = snapshot()

    try {
      // ---------- 正例 ----------
      await app.ctx.plugins.enable('e7-positive')
      const positiveRecord = (app.ctx.plugins as any).records.get('e7-positive')
      const positiveFiber = positiveRecord.fiber
      const loaded = snapshot()
      const positiveEffects = positiveFiber.getEffects().map((effect: { label: string }) => effect.label)
      const positiveEffectCount = positiveEffects.length
      expect(loaded.tasks).toContain('e7-positive-task')
      expect(loaded.roots).toContain(positiveRoot.toLowerCase())
      expect(loaded.ui).toContain('e7-positive')
      expect(positiveEffectCount).toBeGreaterThanOrEqual(2)

      ;(app.ctx.emit as any)('e7/probe')
      const ticksBefore = positiveState.timerTicks
      await sleep(60)
      expect(positiveState.timerTicks).toBeGreaterThan(ticksBefore)
      expect(positiveState.probeEvents).toBe(1)

      await app.ctx.plugins.disable('e7-positive')
      const afterUnload = snapshot()
      expect(afterUnload).toEqual(baseline)
      const ticksAtUnload = positiveState.timerTicks
      await sleep(60)
      expect(positiveState.timerTicks).toBe(ticksAtUnload) // 定时器已停止
      ;(app.ctx.emit as any)('e7/probe')
      expect(positiveState.probeEvents).toBe(1) // 监听器已注销
      expect(positiveFiber.getEffects()).toEqual([]) // Cordis 登记树已清空
      expect(positiveRecord.status).toBe('stopped')
      expect(positiveRecord.taskIds).toEqual([])
      const positiveResidualTicks = positiveState.timerTicks - ticksAtUnload

      // ---------- 反例 ----------
      await app.ctx.plugins.enable('e7-negative')
      const negativeRecord = (app.ctx.plugins as any).records.get('e7-negative')
      const negativeEffectCount = negativeRecord.fiber.getEffects().length
      const withNegative = snapshot()
      expect(withNegative.tasks).toContain('e7-negative-task')
      expect(withNegative.roots).toContain(negativeRoot.toLowerCase())
      expect(withNegative.ui).toContain('e7-negative')

      ;(app.ctx.emit as any)('e7/probe')
      const negativeTicksBefore = negativeState.timerTicks
      await sleep(60)
      expect(negativeState.timerTicks).toBeGreaterThan(negativeTicksBefore)

      await app.ctx.plugins.disable('e7-negative')
      const residual = snapshot()
      const negativeTicksAtUnload = negativeState.timerTicks
      await sleep(60)
      const ticksAfterUnload = negativeState.timerTicks
      const residualReport = {
        tasks: residual.tasks.filter((task) => task.startsWith('e7-negative')),
        roots: residual.roots.filter((root) => root.includes('e7-negative-root')),
        ui: residual.ui.filter((id) => id === 'e7-negative'),
        timerTicksAfterUnload: ticksAfterUnload - negativeTicksAtUnload,
      }

      // 反例故意留下残留；这里记录证据后手动清理，避免污染测试进程
      expect(residualReport.tasks).toEqual(['e7-negative-task'])
      expect(residualReport.roots).toHaveLength(1)
      expect(residualReport.ui).toEqual(['e7-negative'])
      expect(residualReport.timerTicksAfterUnload).toBeGreaterThan(0)

      console.log(
        'E7_RESULT ' +
          JSON.stringify({
            baseline,
            positiveAfterLoad: loaded,
            positiveEffects: positiveEffectCount,
            positiveEffectLabels: positiveEffects,
            positiveEffectsAfterUnload: positiveFiber.getEffects().length,
            positiveTimerTicksBeforeUnload: positiveState.timerTicks,
            positiveTimerTicksAfterUnload: positiveResidualTicks,
            positiveProbeEventsAfterUnload: positiveState.probeEvents,
            negativeEffectsBeforeUnload: negativeEffectCount,
            negativeResidual: residualReport,
          }),
      )
    } finally {
      // 反例资源清理（必须在 app.dispose 前手动做，因为它本来就没有被框架接管）
      if (negativeState.timer) clearInterval(negativeState.timer)
      for (const dispose of negativeState.disposers) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
      await app.dispose()
      const { rmSync } = await import('node:fs')
      rmSync(sandbox.root, { recursive: true, force: true })
    }
  })
})
