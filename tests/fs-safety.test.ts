/**
 * 文件系统安全专项测试（沙箱内进行，不触碰真实用户文件）。
 *
 * 覆盖清理类软件最容易出事故的几类场景：
 * 1. NTFS 联接点（junction）穿越 —— 递归删除目录时绝不能跟随链接删掉目标；
 * 2. 符号链接只删链接本身；
 * 3. 只读文件、长路径（>260）、中文/空格/emoji 文件名；
 * 4. 遍历器不跟随链接（避免重复计数与越界）。
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { deletePath, exists, inspectPath, measurePath, walk } from '@cordclean/utils'
import { createSandbox } from './helpers.ts'

const sandbox = createSandbox()

afterAll(async () => {
  // 只清理本测试创建的沙箱目录
  try {
    await deletePath(sandbox.root, { recursive: true })
  } catch {
    rmSync(sandbox.root, { recursive: true, force: true })
  }
})

function makeJunction(link: string, target: string) {
  // Node 在 Windows 上创建 junction 不需要管理员权限
  symlinkSync(target, link, 'junction')
}

describe('链接与联接点（防止越界删除）', () => {
  it('删除 junction 只删链接本身，目标文件完好', async () => {
    const target = sandbox.dir('junction-target')
    const keep = path.join(target, 'keep.txt')
    writeFileSync(keep, 'IMPORTANT')

    const link = path.join(sandbox.root, 'junction-link')
    makeJunction(link, target)
    expect(existsSync(link)).toBe(true)

    const meta = await inspectPath(link)
    expect(meta.isLink).toBe(true)
    expect(meta.isDirectory).toBe(false)

    await deletePath(link)
    expect(existsSync(link)).toBe(false)
    expect(existsSync(keep)).toBe(true)
    expect(readFileSync(keep, 'utf8')).toBe('IMPORTANT')
  })

  it('递归删除目录时不会跟随内部的 junction（关键安全用例）', async () => {
    const outside = sandbox.dir('outside-keep')
    const precious = path.join(outside, 'precious.doc')
    writeFileSync(precious, 'USER DATA')

    const victim = sandbox.dir('victim-dir')
    writeFileSync(path.join(victim, 'junk.tmp'), 'junk')
    makeJunction(path.join(victim, 'inner-link'), outside)

    // 删除包含 junction 的目录
    await deletePath(victim, { recursive: true })

    expect(existsSync(victim)).toBe(false)
    // 目标目录及其内容必须完好无损
    expect(existsSync(outside)).toBe(true)
    expect(existsSync(precious)).toBe(true)
    expect(readFileSync(precious, 'utf8')).toBe('USER DATA')
  })

  it('遍历器不进入 junction，避免重复计数', async () => {
    const target = sandbox.dir('walk-target')
    writeFileSync(path.join(target, 'a.txt'), 'a')
    const root = sandbox.dir('walk-root')
    writeFileSync(path.join(root, 'b.txt'), 'b')
    makeJunction(path.join(root, 'link-to-target'), target)

    const seen: string[] = []
    for await (const entry of walk(root)) seen.push(entry.path)

    // 只应看到 root 自身的 b.txt 和链接条目（链接作为条目被跳过）
    expect(seen.some((item) => item.toLowerCase().includes('link-to-target'))).toBe(false)
    expect(seen.some((item) => item.endsWith('b.txt'))).toBe(true)
    expect(seen.some((item) => item.endsWith('a.txt'))).toBe(false)
  })
})

describe('Windows 文件名与路径边界', () => {
  it('只读文件可以被删除', async () => {
    const dir = sandbox.dir('readonly')
    const file = path.join(dir, 'readonly.txt')
    writeFileSync(file, 'x')
    execFileSync('attrib.exe', ['+R', file])
    await expect(deletePath(file)).resolves.toBeTruthy()
    expect(existsSync(file)).toBe(false)
  })

  it('中文、空格、emoji 文件名可遍历可删除', async () => {
    const dir = sandbox.dir('unicode')
    const names = ['中文 文件名.txt', 'with space.log', 'emoji-😀-🚀.tmp', '点.号.多.bin']
    for (const name of names) writeFileSync(path.join(dir, name), 'data')

    const seen: string[] = []
    for await (const entry of walk(dir)) if (!entry.isDirectory) seen.push(path.basename(entry.path))
    expect(seen.sort()).toEqual(names.sort())

    await deletePath(dir, { recursive: true })
    expect(existsSync(dir)).toBe(false)
  })

  it('超过 260 字符的长路径可测量、可删除', async () => {
    const dir = sandbox.dir('longpath')
    // 构造 > 260 字符的深层路径
    let deep = dir
    for (let i = 0; i < 12; i++) {
      deep = path.join(deep, `level-${i}-${'x'.repeat(20)}`)
    }
    mkdirSync(deep, { recursive: true })
    const file = path.join(deep, 'deep-file.txt')
    writeFileSync(file, 'deep-data')
    expect(file.length).toBeGreaterThan(260)

    expect(await measurePath(deep)).toBeGreaterThan(0)
    expect(await exists(file)).toBe(true)

    await deletePath(dir, { recursive: true })
    expect(existsSync(dir)).toBe(false)
  })

  it('不存在的路径删除时返回 0 而不抛错（幂等）', async () => {
    const result = await deletePath(path.join(sandbox.root, 'not-exists-anywhere'))
    expect(result.bytes).toBe(0)
    expect(result.linkOnly).toBe(false)
  })
})

describe('空目录与目录体积统计', () => {
  it('measurePath 正确累计多级目录体积', async () => {
    const dir = sandbox.dir('measure')
    writeFileSync(path.join(dir, 'a.bin'), Buffer.alloc(100))
    mkdirSync(path.join(dir, 'sub'), { recursive: true })
    writeFileSync(path.join(dir, 'sub', 'b.bin'), Buffer.alloc(250))
    const size = await measurePath(dir)
    expect(size).toBe(350)
  })

  it('measurePath 不把 junction 目标计入体积', async () => {
    const target = sandbox.dir('measure-target')
    writeFileSync(path.join(target, 'big.bin'), Buffer.alloc(1024))
    const root = sandbox.dir('measure-root')
    writeFileSync(path.join(root, 'own.bin'), Buffer.alloc(10))
    makeJunction(path.join(root, 'link'), target)

    const size = await measurePath(root)
    expect(size).toBe(10)
  })

  it('临时目录路径不以系统盘根目录结尾', () => {
    expect(os.tmpdir()).not.toMatch(/^[a-zA-Z]:\\$/)
  })
})
