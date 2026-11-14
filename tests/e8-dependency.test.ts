import { describe, expect, it } from 'vitest'
import { createApp } from '@cordclean/core'
import { createSandbox, manifestOf } from './helpers.ts'

const FIBER_STATE: Record<number, string> = {
  0: 'PENDING',
  1: 'LOADING',
  2: 'ACTIVE',
  3: 'FAILED',
  4: 'DISPOSED',
  5: 'UNLOADING',
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface E8State {
  providerSetup: number
  providerTeardown: number
  consumerSetup: number
  consumerTeardown: number
  serviceCalls: number
}

/**
 * E8：插件依赖响应验证（provider / consumer）。
 *
 * provider 通过 Cordis 反射服务提供一个自定义服务，consumer 通过 inject 依赖它；
 * 在运行中禁用 provider，观察 consumer 是否自动挂起；重新启用 provider 后观察是否自动恢复。
 *
 * 与 E7 的区别：E7 验证“卸载时副作用回收”，E8 验证“依赖提供者变化时依赖者自动响应”。
 */
describe('E8 插件依赖响应', () => {
  it('provider 服务变化时 consumer 自动挂起并自动恢复', async () => {
    const sandbox = createSandbox()
    const log: string[] = []
    const transitions: Array<Record<string, unknown>> = []
    const state: E8State = {
      providerSetup: 0,
      providerTeardown: 0,
      consumerSetup: 0,
      consumerTeardown: 0,
      serviceCalls: 0,
    }
    const startedAt = Date.now()

    const provider = {
      name: 'e8-provider',
      apply(ctx: any) {
        state.providerSetup += 1
        log.push('provider:setup')
        const service = {
          ping() {
            state.serviceCalls += 1
            return `pong-${state.serviceCalls}`
          },
        }
        ctx.effect(() => {
          const dispose = ctx.reflect.provide('e8Service', service)
          return () => {
            state.providerTeardown += 1
            log.push('provider:teardown')
            dispose()
          }
        }, 'e8/provider')
      },
    }

    const consumer = {
      name: 'e8-consumer',
      inject: ['e8Service', 'cleaner'],
      apply(ctx: any) {
        state.consumerSetup += 1
        log.push('consumer:setup')
        ctx.effect(() => {
          const disposeTask = ctx.cleaner.define({
            id: 'e8-consumer-task',
            name: 'E8 consumer 任务',
            category: 'disk',
            risk: 'safe',
            targets: [],
            scan() {},
          })
          return () => {
            state.consumerTeardown += 1
            log.push('consumer:teardown')
            disposeTask()
          }
        }, 'e8/consumer')
      },
    }

    const app = await createApp({
      dataDir: sandbox.dataDir,
      logger: false,
      manifest: manifestOf([
        { id: 'e8-provider', plugin: provider, defaultEnabled: false },
        { id: 'e8-consumer', plugin: consumer, defaultEnabled: false },
      ]),
    })

    try {
      const records = (app.ctx.plugins as any).records as Map<string, any>
      const snapshot = (label: string) => {
        const providerRecord = records.get('e8-provider')
        const consumerRecord = records.get('e8-consumer')
        const providerInfo = app.ctx.plugins.list().find((plugin) => plugin.id === 'e8-provider')
        const consumerInfo = app.ctx.plugins.list().find((plugin) => plugin.id === 'e8-consumer')
        const service = (() => {
          try {
            return typeof (app.ctx as any).e8Service?.ping === 'function'
          } catch {
            return false
          }
        })()
        const value = {
          label,
          providerStatus: providerInfo?.status,
          providerFiber: providerRecord?.fiber ? FIBER_STATE[providerRecord.fiber.state] : undefined,
          consumerStatus: consumerInfo?.status,
          consumerFiber: consumerRecord?.fiber ? FIBER_STATE[consumerRecord.fiber.state] : undefined,
          consumerTask: app.ctx.cleaner.list().some((task) => task.id === 'e8-consumer-task'),
          service,
          state: { ...state },
        }
        transitions.push({ atMs: Date.now() - startedAt, ...value })
        return value
      }

      const initial = snapshot('initial')
      expect(initial.providerStatus).toBe('stopped')
      expect(initial.consumerStatus).toBe('stopped')
      expect(initial.service).toBe(false)
      expect(initial.consumerTask).toBe(false)

      await app.ctx.plugins.enable('e8-provider')
      log.push('provider-enabled')
      const providerOnly = snapshot('provider-enabled')
      expect(providerOnly.providerStatus).toBe('active')
      expect(providerOnly.providerFiber).toBe('ACTIVE')
      expect(providerOnly.service).toBe(true)

      // consumer 需要显式启用；启用后 fiber 应为 ACTIVE
      await app.ctx.plugins.enable('e8-consumer')
      log.push('consumer-enabled')
      const both = snapshot('both-active')
      expect(both.consumerStatus).toBe('active')
      expect(both.consumerFiber).toBe('ACTIVE')
      expect(both.consumerTask).toBe(true)
      expect(both.service).toBe(true)
      expect(state.consumerSetup).toBe(1)
      expect((app.ctx as any).e8Service.ping()).toBe('pong-1')

      // 禁用 provider：Cordis 应把依赖者挂起，并执行 consumer 的 effect 清理
      await app.ctx.plugins.disable('e8-provider')
      log.push('provider-disabled')
      await sleep(30)
      const afterDisableProvider = snapshot('after-disable-provider')
      expect(afterDisableProvider.providerStatus).toBe('stopped')
      expect(afterDisableProvider.state.providerTeardown).toBe(1)
      expect(afterDisableProvider.consumerFiber).toBe('PENDING')
      expect(afterDisableProvider.consumerTask).toBe(false)
      expect(afterDisableProvider.service).toBe(false)
      expect(afterDisableProvider.state.consumerSetup).toBe(1)
      expect(afterDisableProvider.state.consumerTeardown).toBe(1)
      // 插件管理器必须从 fiber 状态派生 effectiveStatus：不能继续显示 active。
      expect(afterDisableProvider.consumerStatus).toBe('suspended')
      transitions.push({
        atMs: Date.now() - startedAt,
        note: 'managerStatusSynced',
        managerStatus: afterDisableProvider.consumerStatus,
        fiberState: afterDisableProvider.consumerFiber,
      })

      // 重新启用 provider：consumer 应自动重新 setup，无需手动 enable consumer
      await app.ctx.plugins.enable('e8-provider')
      log.push('provider-reenabled')
      await sleep(30)
      const afterReenable = snapshot('after-reenable')
      expect(afterReenable.providerStatus).toBe('active')
      expect(afterReenable.consumerStatus).toBe('active')
      expect(afterReenable.consumerFiber).toBe('ACTIVE')
      expect(afterReenable.consumerTask).toBe(true)
      expect(afterReenable.service).toBe(true)
      expect(afterReenable.state.consumerSetup).toBe(2)
      expect(afterReenable.state.consumerTeardown).toBe(1)
      expect((app.ctx as any).e8Service.ping()).toBe('pong-2')

      const lifecycle = log.filter((item) => item.includes(':setup') || item.includes(':teardown'))
      expect(lifecycle).toEqual([
        'provider:setup',
        'consumer:setup',
        'consumer:teardown',
        'provider:teardown',
        'provider:setup',
        'consumer:setup',
      ])

      console.log(
        'E8_RESULT ' +
          JSON.stringify(
            {
              initial,
              providerOnly,
              both,
              afterDisableProvider,
              afterReenable,
              transitions,
            },
            null,
            2,
          ),
      )
    } finally {
      await app.dispose()
      const { rmSync } = await import('node:fs')
      rmSync(sandbox.root, { recursive: true, force: true })
    }
  })
})
