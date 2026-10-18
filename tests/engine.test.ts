import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from '@cordclean/core'
import { createSandbox, fakeFilesPlugin, manifestOf } from './helpers.ts'

const sandbox = createSandbox()
const cleanDir = sandbox.dir('temp-files')
const outsider = sandbox.dir('outsider')

const fileA = sandbox.file('temp-files/a.log', 'a'.repeat(10))
const fileB = sandbox.file('temp-files/b.log', 'b'.repeat(20))
const fileC = sandbox.file('temp-files/sub/c.log', 'c'.repeat(5))
const fileOutside = sandbox.file('outsider/d.log', 'd'.repeat(7))

const app = await createApp({
  dataDir: sandbox.dataDir,
  logger: false,
  settingsOverrides: { clean: { mode: 'delete' } },
  manifest: manifestOf([
    {
      id: 'fake',
      plugin: fakeFilesPlugin({ roots: [cleanDir], scanDirs: [cleanDir, outsider] }),
    },
  ]),
})

afterAll(async () => {
  await app.dispose()
  rmSync(sandbox.root, { recursive: true, force: true })
})

describe('清理引擎', () => {
  it('扫描能聚合任务产出的清理项', async () => {
    const report = await app.ctx.cleaner.scan()
    expect(report.items.length).toBe(4)
    expect(report.stats.bytes).toBe(10 + 20 + 5 + 7)
    expect(report.tasks).toHaveLength(1)
    expect(report.tasks[0].status).toBe('ok')
    // 结果按体积降序
    expect(report.items[0].size).toBeGreaterThanOrEqual(report.items[1].size)
  })

  it('未声明辖区的路径被标记为受保护，且默认不勾选', async () => {
    const report = app.ctx.cleaner.lastScan()!
    const item = report.items.find((entry) => entry.path === fileOutside)!
    expect(item.protected).toBe(true)
    expect(item.defaultSelected).toBe(false)
  })

  it('预演模式只统计、不删除文件', async () => {
    const before = existsSync(fileA)
    const report = await app.ctx.cleaner.clean({ dryRun: true })
    expect(report.dryRun).toBe(true)
    expect(report.cleaned).toBe(3)
    expect(report.freedBytes).toBe(10 + 20 + 5)
    expect(existsSync(fileA)).toBe(before)
    // 预演不写入历史
    expect(app.ctx.history.totals().sessions).toBe(0)
  })

  it('真实清理删除文件并记录历史', async () => {
    const report = await app.ctx.cleaner.clean({})
    expect(report.cleaned).toBe(3)
    expect(report.failed).toBe(0)
    expect(report.freedBytes).toBe(35)
    for (const target of [fileA, fileB, fileC]) expect(existsSync(target)).toBe(false)
    // 受保护文件保持不变
    expect(existsSync(fileOutside)).toBe(true)
    expect(app.ctx.history.totals().sessions).toBe(1)
    expect(app.ctx.history.totals().freedBytes).toBe(35)
    expect(app.ctx.history.list()[0].taskIds).toEqual(['fake-files'])
  })

  it('同一路径被重复上报时去重', async () => {
    const scan1 = await app.ctx.cleaner.scan({ taskIds: ['fake-files'] })
    const paths = scan1.items.map((item) => item.path.toLowerCase())
    expect(new Set(paths).size).toBe(paths.length)
    expect(path.resolve).toBeTruthy()
  })

  it('清理未选择的项时报错', async () => {
    await expect(app.ctx.cleaner.clean({ itemIds: ['not-exist'] })).rejects.toThrow(/没有选中/)
  })

  it('任务清单包含插件元信息', () => {
    const tasks = app.ctx.cleaner.list()
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ id: 'fake-files', category: 'disk', risk: 'safe' })
  })
})
