/**
 * 工坊「放弃生成」真正中断宿主 HTTP 请求的验证。
 *
 * - 传输层：外部取消 → AiError('CANCELLED')，且不按超时重试；
 * - 服务层：draftPlugin 进行中调用 cancelDraft() → 请求被中断、Promise 以 CANCELLED 拒绝；
 * - 空闲时 cancelDraft() 返回 false（界面可据此提示「没有可取消的生成」）。
 */
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from '@cordclean/core'
import { AiError, requestJson, requestSse } from '../packages/plugins/ai/src/http.ts'

/** 接收请求但永不响应的服务器：模拟「已发出、还没返回」的长请求 */
const hangingServer: Server = createServer(() => {
  /* 故意不响应，直到客户端 abort */
})
await new Promise<void>((resolve) => hangingServer.listen(0, '127.0.0.1', () => resolve()))
const port = (hangingServer.address() as { port: number }).port
const baseUrl = `http://127.0.0.1:${port}`

afterAll(async () => {
  hangingServer.closeAllConnections?.()
  await new Promise<void>((resolve) => hangingServer.close(() => resolve()))
})

describe('传输层取消', () => {
  it('外部 abort → CANCELLED，且远早于超时（不重试）', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const started = Date.now()
    const error = await requestJson(`${baseUrl}/chat`, {
      headers: { 'content-type': 'application/json' },
      body: { messages: [] },
      timeoutMs: 30_000,
      retries: 3,
      signal: controller.signal,
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AiError)
    expect((error as AiError).code).toBe('CANCELLED')
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('SSE 读取中外部 abort → 快速中断（不悬挂）', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const started = Date.now()
    const error = await requestSse(
      `${baseUrl}/sse`,
      {
        headers: { 'content-type': 'application/json' },
        body: '{}',
        timeoutMs: 30_000,
        signal: controller.signal,
      },
      () => undefined,
    ).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect(Date.now() - started).toBeLessThan(3_000)
  })
})

describe('工坊服务取消', () => {
  it('空闲时 cancelDraft() 返回 false', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cc-workshop-cancel-'))
    const app = await createApp({ dataDir, logLevel: 'error' })
    try {
      await app.ctx.plugins.enable('ai-workshop')
      const workshop = (app.ctx as unknown as { aiWorkshop?: { cancelDraft?(): boolean } }).aiWorkshop
      expect(workshop?.cancelDraft).toBeTypeOf('function')
      expect(workshop!.cancelDraft!()).toBe(false)
    } finally {
      await app.dispose()
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 30_000)

  it('生成进行中调用 cancelDraft() → 请求被真正中断，Promise 以 CANCELLED 拒绝', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cc-workshop-cancel-run-'))
    const app = await createApp({ dataDir, logLevel: 'error' })
    try {
      await app.ctx.plugins.enable('ai-workshop')
      // 指向「永不响应」的本地服务器：走非流式（messages 形态），确保 requestJson 挂住
      await app.ctx.plugins.updateConfig('ai-workshop', {
        apiKey: 'test-key',
        baseUrl,
        apiShape: 'messages',
        model: 'test-model',
        timeoutMs: 30_000,
        retries: 0,
      })
      await new Promise((resolve) => setTimeout(resolve, 100))
      const workshop = (app.ctx as unknown as {
        aiWorkshop?: { draftPlugin(text: string): Promise<unknown>; cancelDraft(): boolean }
      }).aiWorkshop
      expect(workshop).toBeTruthy()

      const started = Date.now()
      const pending = workshop!.draftPlugin('给我一个示例插件').catch((error: unknown) => error)
      // 等请求真正发出去，再取消
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(workshop!.cancelDraft()).toBe(true)
      const error = await pending
      expect(error).toBeInstanceOf(AiError)
      expect((error as AiError).code).toBe('CANCELLED')
      expect(Date.now() - started).toBeLessThan(10_000)
      // 取消后状态清空，再取消返回 false
      expect(workshop!.cancelDraft()).toBe(false)
    } finally {
      await app.dispose()
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 30_000)
})
