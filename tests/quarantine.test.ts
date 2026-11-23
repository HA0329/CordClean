import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from '@cordclean/core'
import { createSandbox } from './helpers.ts'

const sandbox = createSandbox()
const app = await createApp({ dataDir: sandbox.dataDir, logger: false, loadPlugins: false })

afterAll(async () => {
  await app.dispose()
  rmSync(sandbox.root, { recursive: true, force: true })
})

describe('隔离区', () => {
  it('移入隔离区后原文件消失，可完整恢复', async () => {
    const source = sandbox.file('quarantine/a.txt', 'hello-cordclean')
    const session = app.ctx.quarantine.beginSession('session-1')
    await session.move(source, 'temp', 16)
    await session.close()

    expect(existsSync(source)).toBe(false)
    const list = await app.ctx.quarantine.list()
    expect(list).toHaveLength(1)
    expect(list[0].originalPath).toBe(source)
    expect(list[0].taskId).toBe('temp')

    const result = await app.ctx.quarantine.restore([list[0].id])
    expect(result.restored).toBe(1)
    expect(result.failed).toHaveLength(0)
    expect(readFileSync(source, 'utf8')).toBe('hello-cordclean')
    expect(await app.ctx.quarantine.list()).toHaveLength(0)
  })

  it('原路径被占用时恢复失败并给出原因', async () => {
    const source = sandbox.file('quarantine/b.txt', 'b-content')
    const session = app.ctx.quarantine.beginSession('session-2')
    await session.move(source, 'temp', 9)
    // 占用原路径
    const { writeFileSync } = await import('node:fs')
    writeFileSync(source, 'occupied')
    const list = await app.ctx.quarantine.list()
    const result = await app.ctx.quarantine.restore([list[0].id])
    expect(result.restored).toBe(0)
    expect(result.failed[0].message).toContain('已存在')
  })

  it('恢复 id 不能穿越隔离区删除任意目录', async () => {
    const victim = path.join(sandbox.root, 'victim-outside-quarantine')
    mkdirSync(victim, { recursive: true })
    writeFileSync(path.join(victim, 'keep.txt'), 'must-survive')
    const relative = path.relative(app.ctx.quarantine.directory, victim).replace(/\\/g, '/')
    const result = await app.ctx.quarantine.restore([`${relative}/0001_any`])
    expect(result.restored).toBe(0)
    expect(result.failed.length).toBeGreaterThan(0)
    expect(existsSync(path.join(victim, 'keep.txt'))).toBe(true)
  })

  it('彻底删除隔离项后不可恢复', async () => {
    const source = sandbox.file('quarantine/c.txt', 'c-content')
    const session = app.ctx.quarantine.beginSession('session-3')
    await session.move(source, 'temp', 9)
    // 上一用例恢复失败的那一项仍在隔离区中，这里一并清除
    const before = await app.ctx.quarantine.list()
    expect(before.length).toBeGreaterThanOrEqual(1)
    const removed = await app.ctx.quarantine.purge(before.map((item) => item.id))
    expect(removed).toBe(before.length)
    expect(await app.ctx.quarantine.list()).toHaveLength(0)
    expect(existsSync(source)).toBe(false)
  })

  it('隔离区容量上限生效', async () => {
    app.ctx.settings.patch({ quarantine: { maxFiles: 0 } })
    const source = sandbox.file('quarantine/d.txt', 'd')
    const session = app.ctx.quarantine.beginSession('session-4')
    await expect(session.move(source, 'temp', 1)).rejects.toThrow(/上限/)
    expect(existsSync(source)).toBe(true)
    app.ctx.settings.patch({ quarantine: { maxFiles: 20000 } })
  })

  it('隔离目录位于数据目录下', () => {
    expect(app.ctx.quarantine.directory.startsWith(path.resolve(sandbox.dataDir))).toBe(true)
  })

  it('清单被篡改：purge 不删除隔离区外的文件（相对路径穿越）', async () => {
    const victimDir = path.join(sandbox.root, 'victim-purge')
    mkdirSync(victimDir, { recursive: true })
    const victim = path.join(victimDir, 'keep.txt')
    writeFileSync(victim, 'must-survive')

    const source = sandbox.file('quarantine/e.txt', 'e-content')
    const session = app.ctx.quarantine.beginSession('session-5')
    const record = await session.move(source, 'temp', 9)
    const manifest = path.join(app.ctx.quarantine.directory, 'session-5', 'manifest.jsonl')
    writeFileSync(manifest, JSON.stringify({ ...record, storedName: '..\\..\\victim-purge\\keep.txt' }) + '\n')

    const removed = await app.ctx.quarantine.purge()
    expect(removed).toBe(0)
    expect(existsSync(victim)).toBe(true)
    // 非法记录被丢弃，不再出现在列表里
    expect(await app.ctx.quarantine.list()).toHaveLength(0)
  })

  it('清单被篡改：绝对路径 storedName 不会删除任意文件', async () => {
    const victim = sandbox.file('victim-abs/keep.txt', 'must-survive')
    const source = sandbox.file('quarantine/f.txt', 'f-content')
    const session = app.ctx.quarantine.beginSession('session-6')
    const record = await session.move(source, 'temp', 9)
    const manifest = path.join(app.ctx.quarantine.directory, 'session-6', 'manifest.jsonl')
    writeFileSync(manifest, JSON.stringify({ ...record, storedName: victim }) + '\n')

    const removed = await app.ctx.quarantine.purge()
    expect(removed).toBe(0)
    expect(existsSync(victim)).toBe(true)
  })

  it('清单被篡改：restore 拒绝相对路径与隔离区内目标', async () => {
    const source = sandbox.file('quarantine/g.txt', 'g-content')
    const session = app.ctx.quarantine.beginSession('session-7')
    const record = await session.move(source, 'temp', 9)
    const manifest = path.join(app.ctx.quarantine.directory, 'session-7', 'manifest.jsonl')
    writeFileSync(manifest, JSON.stringify({ ...record, originalPath: 'relative\\g.txt' }) + '\n')

    const result = await app.ctx.quarantine.restore([record.id])
    expect(result.restored).toBe(0)
    expect(result.failed[0].message).toContain('恢复目标')
  })
})
