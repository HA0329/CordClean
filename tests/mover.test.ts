import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { moveFiles } from '../packages/core/src/domains/engine/mover.ts'
import { createSandbox } from './helpers.ts'

const sandbox = createSandbox()
const allow = { check: () => ({ allowed: true }) }

describe('大文件搬家', () => {
  it('移动文件、保留内容、源文件消失', async () => {
    const src = path.join(sandbox.root, 'move-src')
    const dst = path.join(sandbox.root, 'move-dst')
    mkdirSync(src, { recursive: true })
    writeFileSync(path.join(src, 'a.bin'), Buffer.alloc(1024, 1))
    writeFileSync(path.join(src, 'b.bin'), Buffer.alloc(2048, 2))
    const result = await moveFiles({ paths: [path.join(src, 'a.bin'), path.join(src, 'b.bin')], targetDir: dst }, allow)
    expect(result.moved).toHaveLength(2)
    // 同盘移动不释放磁盘空间，freedBytes 应为 0（跨盘才计入）
    expect(result.freedBytes).toBe(0)
    expect(readFileSync(path.join(dst, 'a.bin')).length).toBe(1024)
    await expect(statSafe(path.join(src, 'a.bin'))).resolves.toBe(false)
  })

  it('同名冲突自动加后缀，不覆盖', async () => {
    const src = path.join(sandbox.root, 'conflict-src')
    const dst = path.join(sandbox.root, 'conflict-dst')
    mkdirSync(src, { recursive: true }); mkdirSync(dst, { recursive: true })
    writeFileSync(path.join(src, 'same.txt'), 'new')
    writeFileSync(path.join(dst, 'same.txt'), 'old')
    const result = await moveFiles({ paths: [path.join(src, 'same.txt')], targetDir: dst }, allow)
    expect(result.moved[0].to).toContain('same (1).txt')
    expect(readFileSync(path.join(dst, 'same.txt'), 'utf8')).toBe('old')
  })

  it('link 选项：成功建链或失败还原，不丢数据', async () => {
    const src = path.join(sandbox.root, 'link-src')
    const dst = path.join(sandbox.root, 'link-dst')
    mkdirSync(src, { recursive: true })
    writeFileSync(path.join(src, 'l.bin'), 'link')
    const result = await moveFiles({ paths: [path.join(src, 'l.bin')], targetDir: dst }, { check: () => ({ allowed: true }), link: true })
    const sourceExists = await statSafe(path.join(src, 'l.bin'))
    const targetExists = await statSafe(path.join(dst, 'l.bin'))
    if (result.moved.length) {
      expect(sourceExists).toBe(true)
      expect(targetExists).toBe(true)
    } else {
      expect(sourceExists).toBe(true)
      expect(result.failed[0].error).toContain('符号链接')
    }
  })

  it('同盘目录搬家：重命名移动，可选目录联接', async () => {
    const src = path.join(sandbox.root, 'dir-src')
    const dst = path.join(sandbox.root, 'dir-dst')
    mkdirSync(path.join(src, 'sub'), { recursive: true })
    writeFileSync(path.join(src, 'sub', 'f.txt'), 'dir')
    const result = await moveFiles({ paths: [src], targetDir: dst }, { check: () => ({ allowed: true }), link: true })
    expect(result.moved).toHaveLength(1)
    expect(await statSafe(path.join(dst, 'dir-src', 'sub', 'f.txt'))).toBe(true)
  })

  it('路径策略拒绝时不移动', async () => {
    const src = path.join(sandbox.root, 'deny-src')
    mkdirSync(src, { recursive: true })
    writeFileSync(path.join(src, 'x.bin'), 'x')
    const result = await moveFiles({ paths: [path.join(src, 'x.bin')], targetDir: path.join(sandbox.root, 'deny-dst') }, { check: () => ({ allowed: false, reason: 'protected' }) })
    expect(result.moved).toHaveLength(0)
    expect(result.failed[0].error).toContain('策略保护')
  })

  it('拒绝 UNC / 盘符根 / 受保护目标目录', async () => {
    const src = path.join(sandbox.root, 'guard-src')
    mkdirSync(src, { recursive: true })
    writeFileSync(path.join(src, 'x.bin'), 'x')
    const file = path.join(src, 'x.bin')
    await expect(moveFiles({ paths: [file], targetDir: '\\\\server\\share\\backup' }, allow)).rejects.toThrow(/UNC/)
    await expect(moveFiles({ paths: [file], targetDir: 'C:\\' }, allow)).rejects.toThrow(/盘符根/)
    await expect(
      moveFiles({ paths: [file], targetDir: path.join(sandbox.root, 'protected-dst') }, { ...allow, isProtected: () => true }),
    ).rejects.toThrow(/受保护/)
  })

  it('目标目录位于源目录内部时拒绝移动', async () => {
    const src = path.join(sandbox.root, 'self-src')
    mkdirSync(path.join(src, 'sub'), { recursive: true })
    writeFileSync(path.join(src, 'sub', 'f.txt'), 'x')
    const result = await moveFiles({ paths: [src], targetDir: path.join(src, 'sub') }, allow)
    expect(result.moved).toHaveLength(0)
    expect(result.failed[0].error).toContain('内部')
  })
})

async function statSafe(file: string): Promise<boolean> {
  try { const { stat } = await import('node:fs/promises'); await stat(file); return true } catch { return false }
}
