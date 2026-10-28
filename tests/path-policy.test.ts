import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type App } from '@cordclean/core'

let app: App
let sandbox: string

beforeAll(async () => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), 'cc-policy-'))
  app = await createApp({
    dataDir: path.join(sandbox, 'data'),
    loadPlugins: false,
    logger: false,
  })
})

afterAll(async () => {
  await app?.dispose()
  rmSync(sandbox, { recursive: true, force: true })
})

describe('路径策略（安全阀）', () => {
  it('系统关键目录永远拒绝', () => {
    const policy = app.ctx.pathPolicy
    const windows = app.ctx.system.env.windowsDir
    const checks = [
      `${windows}\\System32\\kernel32.dll`,
      `${windows}\\WinSxS\\x86_manifest`,
      app.ctx.system.env.programFiles + '\\SomeApp\\app.exe',
      path.join(app.ctx.system.env.userProfile, 'Documents', 'thesis.docx'),
    ]
    for (const target of checks) {
      const result = policy.check(target)
      expect(result.allowed).toBe(false)
      expect(result.reason).toBe('protected')
    }
  })

  it('未声明辖区时拒绝清理任意目录', () => {
    const dir = path.join(sandbox, 'unclaimed')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'a.txt'), 'hello')
    const result = app.ctx.pathPolicy.check(path.join(dir, 'a.txt'))
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('outside')
  })

  it('声明辖区后允许，撤销后再次拒绝', () => {
    const dir = path.join(sandbox, 'claimed')
    mkdirSync(dir, { recursive: true })
    const target = path.join(dir, 'b.tmp')
    writeFileSync(target, 'x')

    const dispose = app.ctx.pathPolicy.addRoot(dir)
    expect(app.ctx.pathPolicy.check(target).allowed).toBe(true)

    dispose()
    expect(app.ctx.pathPolicy.check(target).allowed).toBe(false)
  })

  it('名称黑名单生效', () => {
    const dir = path.join(sandbox, 'names')
    mkdirSync(dir, { recursive: true })
    const dispose = app.ctx.pathPolicy.addRoot(dir)
    for (const name of ['pagefile.sys', 'hiberfil.sys', 'NTUSER.DAT']) {
      const result = app.ctx.pathPolicy.check(path.join(dir, name))
      expect(result.allowed).toBe(false)
      expect(result.reason).toBe('name-denied')
    }
    dispose()
  })

  it('拒绝驱动器根目录', () => {
    const result = app.ctx.pathPolicy.check(app.ctx.system.env.systemDrive + '\\')
    expect(result.allowed).toBe(false)
  })

  it('即时通讯/开发环境保护名按完整路径段拦截，且不误伤 WeChat 缓存', () => {
    const dir = path.join(sandbox, 'protected-names')
    mkdirSync(dir, { recursive: true })
    const dispose = app.ctx.pathPolicy.addRoot(dir)
    const protectedTargets = [
      path.join(dir, 'WeChat Files', 'a', 'msg.db'),
      path.join(dir, 'Tencent Files', 'b', 'chat.db'),
      path.join(dir, 'xwechat_files', 'c', 'msg.db'),
      path.join(dir, 'repo', '.git', 'config'),
      path.join(dir, 'project', '.venv', 'pyvenv.cfg'),
      path.join(dir, 'project', '.idea', 'workspace.xml'),
      path.join(dir, 'project', '.vscode', 'settings.json'),
    ]
    for (const target of protectedTargets) {
      const result = app.ctx.pathPolicy.check(target)
      expect(result.allowed).toBe(false)
      expect(result.reason).toBe('protected')
    }
    // 不能过度封锁：WeChat 的可重建日志/临时目录仍允许清理
    expect(app.ctx.pathPolicy.check(path.join(dir, 'WeChat', 'Logs', 'a.log')).allowed).toBe(true)
    expect(app.ctx.pathPolicy.check(path.join(dir, 'WeChat', 'Temp', 'b.tmp')).allowed).toBe(true)
    dispose()
  })

  it('包含受保护子目录的祖先目录被识别', () => {
    const windows = app.ctx.system.env.windowsDir
    expect(app.ctx.pathPolicy.containsProtected(windows)).toBe(true)
  })
})
