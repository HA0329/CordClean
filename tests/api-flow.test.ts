/**
 * API 全链路集成测试（不是传输层单测）：
 * 走真实 host server + handlers，覆盖 扫描 → 清理 → 历史 → 撤销状态 → 参数校验。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type App } from '@cordclean/core'
import { createHandlers, startHostServer, type HostServer, type ShellAdapter } from '@cordclean/host'
import { createSandbox, fakeFilesPlugin, manifestOf } from './helpers.ts'

const sandbox = createSandbox()
const TOKEN = 'api-flow-token'
let app: App
let server: HostServer
let dir: string

const shell: ShellAdapter = { electron: false, async openPath() {}, async openDataDir() {} }

beforeAll(async () => {
  dir = sandbox.dir('api-flow')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'a.tmp'), 'a'.repeat(100))
  writeFileSync(path.join(dir, 'b.tmp'), 'b'.repeat(200))
  app = await createApp({
    dataDir: sandbox.dataDir,
    logger: false,
    manifest: manifestOf([{ id: 'flow', plugin: fakeFilesPlugin({ id: 'flow', roots: [dir] }) }]),
  })
  app.ctx.recycleBin.setRunnerForTests(async (items) => ({ ok: items.map((item) => item.path), failed: [] }))
  server = await startHostServer({
    ctx: app.ctx,
    handlers: createHandlers({ ctx: app.ctx, dataDir: app.dataDir, version: app.version, bootMs: app.bootMs, shell }),
    token: TOKEN,
  })
})

afterAll(async () => {
  await server?.close()
  await app?.dispose()
})

async function rpc(method: string, params: unknown = {}) {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/rpc?token=${TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return response.json() as Promise<any>
}

describe('API 全链路', () => {
  it('扫描 → 清理 → 历史 → 撤销状态', async () => {
    const info = await rpc('app/info')
    expect(info.result.protocolVersion).toBe(1)

    const scan = await rpc('scan/start', { taskIds: ['flow-files'] })
    expect(scan.result.items.length).toBeGreaterThanOrEqual(2)
    const ids = scan.result.items.map((item: any) => item.id)

    const cleaned = await rpc('clean/start', { itemIds: ids })
    expect(cleaned.result.mode).toBe('recycle')
    expect(cleaned.result.cleaned).toBeGreaterThanOrEqual(2)

    const history = await rpc('history/list', { limit: 10 })
    expect(history.result[0].cleaned).toBeGreaterThanOrEqual(2)

    const undo = await rpc('clean/undo-state')
    // 回收站模式无法通过“撤销”接口真正恢复（需要用户手动清空/还原回收站），因此不再显示为可撤销
    expect(undo.result.available).toBe(false)
    expect(undo.result.recycle).toBeGreaterThanOrEqual(2)
  })

  it('clean/start 不接受界面回传的清理项（只认 itemIds）', async () => {
    const bad = await rpc('clean/start', { items: [{ id: 'x', taskId: 'flow-files', path: dir, kind: 'file', size: 1, risk: 'safe', category: 'system', title: 'x' }] })
    expect(bad.error.code).toBe(-32602)
    expect(bad.error.message).toContain('参数校验失败')
  })

  it('settings/set 拒绝原型链路径，settings/patch 对 null 配置段自愈', async () => {
    const polluted = await rpc('settings/set', { path: '__proto__.polluted', value: 'yes' })
    expect(polluted.error).toBeTruthy()
    expect(({} as any).polluted).toBeUndefined()

    const healed = await rpc('settings/patch', { patch: { scan: null } })
    expect(healed.error).toBeUndefined()
    expect(healed.result.scan).toBeTruthy()
    expect(healed.result.scan.concurrency).toBeGreaterThan(0)
  })

  it('RPC 参数校验拦截非法请求', async () => {
    const bad = await rpc('plugins/enable', {})
    expect(bad.error.code).toBe(-32602)
    expect(bad.error.message).toContain('参数校验失败')
  })
})
