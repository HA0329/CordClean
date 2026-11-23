/**
 * 插件契约：定时扫描（scheduler）
 *
 * 「插件区逐个插件独立完成」的独立验证：
 * 真实加载内核 → 必要时临时启用 → 核对默认状态/任务注册/任务元数据。
 * 同插件的真实扫描审计：pnpm exec tsx scripts/audit-plugin.ts scheduler
 * 最近一次审计：汇总：任务 0，清理项 0，体积 0.0 MB，扫描错误 0，契约违例 0
 */
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from '@cordclean/core'

const ID = 'scheduler'
const DEFAULT_ENABLED = false
const EXPECTED_TASKS = 0

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cc-plugin-scheduler-'))
const app = await createApp({ dataDir, logLevel: 'error' })
afterAll(async () => {
  await app.dispose()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('插件契约：scheduler', () => {
  it('插件在清单中，默认启用状态符合预期', () => {
    const plugin = app.ctx.plugins.list().find((item) => item.id === ID)
    expect(plugin).toBeTruthy()
    expect(plugin!.enabled).toBe(DEFAULT_ENABLED)
  })

  it('可启用/已启用，注册任务数量与清单一致', async () => {
    let plugin = app.ctx.plugins.list().find((item) => item.id === ID)!
    if (!plugin.enabled) await app.ctx.plugins.enable(ID)
    plugin = app.ctx.plugins.list().find((item) => item.id === ID)!
    expect(plugin.status).toBe('active')
    const pluginTaskIds = new Set((plugin.tasks ?? []).map((task) => task.id))
    const tasks = app.ctx.cleaner.list().filter((task) => pluginTaskIds.has(task.id))
    expect(plugin.tasks.length).toBe(EXPECTED_TASKS)
    expect(tasks.length).toBe(EXPECTED_TASKS)
  })

  it('任务元数据合法（名称/风险/目标；高风险不得默认勾选）', () => {
    const plugin = app.ctx.plugins.list().find((item) => item.id === ID)!
    for (const task of plugin.tasks ?? []) {
      expect(task.id.trim().length).toBeGreaterThan(0)
      expect(task.name.trim().length).toBeGreaterThan(0)
      expect(['safe', 'caution', 'risky']).toContain(task.risk)
      expect(task.description === undefined || typeof task.description === 'string').toBe(true)
      if (task.risk === 'risky' && typeof (task as { defaultSelected?: boolean }).defaultSelected === 'boolean') expect((task as { defaultSelected?: boolean }).defaultSelected).toBe(false)
    }
  })
})