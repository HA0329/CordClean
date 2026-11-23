/**
 * 回归：cleaner.scan({ taskIds }) 传未知 id 时必须报错，不能静默回退到「扫描全部任务」。
 * 空数组仍保持「全部任务」语义；重复 id 去重。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, type App } from '@cordclean/core'

let app: App | undefined
let dataDir = ''

afterEach(async () => {
  if (app) {
    await app.dispose()
    app = undefined
  }
  if (dataDir) {
    rmSync(dataDir, { recursive: true, force: true })
    dataDir = ''
  }
})

async function makeApp(): Promise<App> {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'cc-scan-filter-'))
  app = await createApp({ dataDir, logLevel: 'error' })
  ;(app.ctx.cleaner as any).define({
    id: 'p0-task',
    name: 'P0 测试任务',
    description: '用于验证 taskIds 过滤',
    category: 'temp',
    risk: 'safe',
    targets: [],
    async scan(scan: any) {
      scan.emit({
        path: path.join(dataDir, 'p0-demo.log'),
        title: 'demo',
        kind: 'file',
        size: 1,
        risk: 'safe',
        defaultSelected: false,
      })
    },
  })
  return app
}

describe('cleaner.scan taskIds 过滤', () => {
  it('传未知 taskId 抛明确错误（不再静默全量扫描）', async () => {
    await makeApp()
    await expect(app!.ctx.cleaner.scan({ taskIds: ['p0-task', '__not_a_task__'] })).rejects.toThrow(/未知清理任务/)
    await expect(app!.ctx.cleaner.scan({ taskIds: ['__not_a_task__'] })).rejects.toThrow(/__not_a_task__/)
  })

  it('只扫指定任务，重复 id 去重', async () => {
    await makeApp()
    const report = await app!.ctx.cleaner.scan({ taskIds: ['p0-task', 'p0-task'] })
    expect(report.tasks.map((task) => task.taskId)).toEqual(['p0-task'])
    expect(report.items).toHaveLength(1)
  })
})