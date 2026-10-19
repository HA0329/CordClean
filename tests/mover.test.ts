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
    expect(result.freedBytes).toBe(3072)
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

  it('路径策略拒绝时不移动', async () => {
    const src = path.join(sandbox.root, 'deny-src')
    mkdirSync(src, { recursive: true })
    writeFileSync(path.join(src, 'x.bin'), 'x')
    const result = await moveFiles({ paths: [path.join(src, 'x.bin')], targetDir: path.join(sandbox.root, 'deny-dst') }, { check: () => ({ allowed: false, reason: 'protected' }) })
    expect(result.moved).toHaveLength(0)
    expect(result.failed[0].error).toContain('策略保护')
  })
})

async function statSafe(file: string): Promise<boolean> {
  try { const { stat } = await import('node:fs/promises'); await stat(file); return true } catch { return false }
}
