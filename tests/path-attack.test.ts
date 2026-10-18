/**
 * 路径策略攻击面测试：覆盖常见的「路径绕过」手法。
 *
 * 这些用例只读真实系统目录（不删除），删除类用例全部落在沙箱。
 */
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type App } from '@cordclean/core'
import { createSandbox, fakeFilesPlugin, manifestOf } from './helpers.ts'

let app: App
const sandbox = createSandbox()

beforeAll(async () => {
  app = await createApp({
    dataDir: sandbox.dataDir,
    loadPlugins: false,
    logger: false,
  })
})

afterAll(async () => {
  await app?.dispose()
  const { deletePath } = await import('@cordclean/utils')
  try {
    await deletePath(sandbox.root, { recursive: true })
  } catch {
    /* 沙箱可能已不存在 */
  }
})

const denied = (target: string) => {
  const result = app.ctx.pathPolicy.check(target)
  expect(result.allowed, `${target} 不应被允许`).toBe(false)
  return result
}

describe('路径长度与语法变体', () => {
  it('拒绝空路径、相对路径与盘符根', () => {
    denied('')
    denied('   ')
    denied('Windows\\System32\\a.dll')
    denied('.\\a.txt')
    denied('C:')
    denied('C:\\')
    denied('D:\\')
  })

  it('路径末尾的 `.` 与空格不能绕过保护（Windows 会静默忽略）', () => {
    const windows = app.ctx.system.env.windowsDir
    for (const suffix of ['.', '...', ' ', ' .', '..']) {
      const result = denied(`${windows}\\System32${suffix}\\kernel32.dll`)
      expect(result.reason).toBe('protected')
    }
  })

  it('路径中段的尾点同样不能绕过保护', () => {
    const windows = app.ctx.system.env.windowsDir
    const result = denied(`${windows}\\.\\System32\\drivers\\etc\\hosts`)
    expect(result.reason).toBe('protected')
    void result
  })

  it('`..` 段会被规范化，无法逃逸到保护目录', () => {
    const env = app.ctx.system.env
    const target = `${env.localAppData}\\Temp\\..\\..\\..\\..\\Windows\\System32\\cmd.exe`
    const result = denied(target)
    expect(['protected', 'outside']).toContain(result.reason ?? '')
  })

  it('正斜杠与混合分隔符同样被识别', () => {
    const windows = app.ctx.system.env.windowsDir.replace(/\\/g, '/')
    const result = denied(`${windows}/System32/kernel32.dll`)
    expect(result.reason).toBe('protected')
  })

  it('Win32 长路径前缀 `\\\\?\\` 不能绕过保护', () => {
    const windows = app.ctx.system.env.windowsDir
    for (const prefix of ['\\\\?\\', '\\\\.\\']) {
      const result = denied(`${prefix}${windows}\\System32\\kernel32.dll`)
      expect(result.allowed).toBe(false)
    }
  })

  it('8.3 短名（PROGRA~1）不能绕过保护', () => {
    const programFiles = app.ctx.system.env.programFiles
    const shortName = programFiles.replace(/Program Files/i, 'PROGRA~1')
    if (shortName === programFiles) return // 不在默认安装位置，跳过
    const result = app.ctx.pathPolicy.check(`${shortName}\\SomeApp\\app.exe`)
    expect(result.allowed).toBe(false)
  })

  it('大小写混写不能绕过保护', () => {
    const windows = app.ctx.system.env.windowsDir
    const result = denied(`${windows.toUpperCase()}\\SyStEm32\\kernel32.dll`)
    expect(result.reason).toBe('protected')
  })

  it('UNC 路径与其它盘符路径默认拒绝（未声明辖区）', () => {
    denied('\\\\server\\share\\file.txt')
    denied('Z:\\whatever\\file.txt')
  })
})

describe('辖区边界', () => {
  it('同一父目录下的兄弟目录不会被辖区覆盖', () => {
    const root = sandbox.dir('scope-root')
    const sibling = sandbox.dir('scope-sibling')
    const dispose = app.ctx.pathPolicy.addRoot(root)
    const inside = path.join(root, 'a.txt')
    const outside = path.join(sibling, 'b.txt')
    writeFileSync(inside, 'a')
    writeFileSync(outside, 'b')
    expect(app.ctx.pathPolicy.check(inside).allowed).toBe(true)
    expect(app.ctx.pathPolicy.check(outside).allowed).toBe(false)
    dispose()
  })

  it('前缀相同的目录不会被误判为辖区（C:\\Temp 与 C:\\Temp-evil）', () => {
    const root = sandbox.dir('prefix-root')
    const evil = sandbox.dir('prefix-root-evil')
    const dispose = app.ctx.pathPolicy.addRoot(root)
    writeFileSync(path.join(root, 'ok.txt'), 'x')
    writeFileSync(path.join(evil, 'bad.txt'), 'y')
    expect(app.ctx.pathPolicy.check(path.join(root, 'ok.txt')).allowed).toBe(true)
    expect(app.ctx.pathPolicy.check(path.join(evil, 'bad.txt')).allowed).toBe(false)
    dispose()
  })

  it('rootOf 返回最长匹配的辖区', () => {
    const outer = sandbox.dir('root-outer')
    const inner = sandbox.dir('root-outer\\inner')
    const d1 = app.ctx.pathPolicy.addRoot(outer)
    const d2 = app.ctx.pathPolicy.addRoot(inner)
    const matched = app.ctx.pathPolicy.rootOf(path.join(inner, 'x.txt'))
    expect(matched?.toLowerCase()).toBe(inner.toLowerCase())
    d1()
    d2()
  })
})

describe('链接祖先穿透（引擎级）', () => {
  it('辖区内的 junction 不能把删除引到辖区外', async () => {
    const outside = sandbox.dir('escape-outside')
    const precious = path.join(outside, 'precious.txt')
    writeFileSync(precious, 'DO NOT DELETE')

    const scope = sandbox.dir('escape-scope')
    const link = path.join(scope, 'link')
    symlinkSync(outside, link, 'junction')

    const target = path.join(link, 'precious.txt')
    writeFileSync(precious, 'DO NOT DELETE')

    const escapeApp = await createApp({
      dataDir: path.join(sandbox.root, 'escape-data'),
      logger: false,
      manifest: manifestOf([
        {
          id: 'escape',
          plugin: fakeFilesPlugin({ id: 'escape', roots: [scope], scanDirs: [scope] }),
        },
      ]),
    })
    try {
      // 直接构造一个「看起来在辖区内、实际指向外部」的清理项
      const report = await escapeApp.ctx.cleaner.clean({
        items: [
          {
            id: 'escape:manual',
            taskId: 'escape-files',
            path: target,
            title: 'precious.txt',
            kind: 'file',
            size: 13,
            risk: 'safe',
            category: 'disk',
            defaultSelected: true,
          },
        ],
      })
      // 策略允许（字符串在辖区内），但链接祖先检查必须拦截
      expect(report.cleaned).toBe(0)
      expect(report.failed).toBe(1)
      expect(report.failures[0].message).toMatch(/联接点|符号链接/)
      expect(existsSync(precious)).toBe(true)
    } finally {
      await escapeApp.dispose()
    }
  })

  it('正常辖区内的普通目录仍可清理（避免过度拦截）', async () => {
    const scope = sandbox.dir('normal-scope')
    const file = path.join(scope, 'plain.tmp')
    writeFileSync(file, 'x'.repeat(16))
    mkdirSync(path.join(scope, 'sub'), { recursive: true })
    writeFileSync(path.join(scope, 'sub', 'y.tmp'), 'y')

    const normalApp = await createApp({
      dataDir: path.join(sandbox.root, 'normal-data'),
      logger: false,
      manifest: manifestOf([{ id: 'normal', plugin: fakeFilesPlugin({ id: 'normal', roots: [scope] }) }]),
    })
    try {
      const report = await normalApp.ctx.cleaner.scan()
      expect(report.items.length).toBe(2)
      const cleaned = await normalApp.ctx.cleaner.clean({})
      expect(cleaned.cleaned).toBe(2)
      expect(cleaned.failed).toBe(0)
      expect(existsSync(file)).toBe(false)
    } finally {
      await normalApp.dispose()
    }
  })
})
