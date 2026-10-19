import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runIsolated } from '../packages/core/src/domains/kernel/worker-host.ts'
import { createSandbox } from './helpers.ts'

const sandbox = createSandbox()
const write = (name: string, code: string) => {
  const file = path.join(sandbox.root, name)
  writeFileSync(file, code, 'utf8')
  return file
}

describe('外部插件隔离运行时', () => {
  it('在 worker 中执行导出函数并回传结果', async () => {
    const file = write('ok.mjs', 'export async function ping(){ return 42 }')
    const result = await runIsolated(file, 'ping')
    expect(result).toMatchObject({ ok: true, value: 42 })
  })

  it('插件抛错不会拖垮调用方，只返回错误', async () => {
    const file = write('crash.mjs', "export function ping(){ throw new Error('boom') }")
    const result = await runIsolated(file, 'ping')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('boom')
  })

  it('超时会终止 worker 并返回超时', async () => {
    const file = write('hang.mjs', 'export async function ping(){ await new Promise(r => setTimeout(r, 5000)) }')
    const started = Date.now()
    const result = await runIsolated(file, 'ping', [], 300)
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(3000)
  })
})
