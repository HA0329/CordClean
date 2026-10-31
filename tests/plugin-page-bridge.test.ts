import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp, type App } from '@cordclean/core'
import {
  buildPluginPageResponse,
  parsePluginPageRequest,
} from '../packages/ui/src/api/plugin-page-bridge.ts'

describe('插件页面 bridge 兼容层', () => {
  it('解析新协议并生成回包', () => {
    const request = parsePluginPageRequest({
      type: 'cordclean/plugin-page',
      method: 'resolve',
      id: 'r1',
      resolverId: 'disks',
      params: { x: 1 },
    })
    expect(request).toEqual({ legacy: false, requestId: 'r1', resolverId: 'disks', params: { x: 1 } })
    const response = buildPluginPageResponse(request!, { ok: true, value: [1] })
    expect(response).toMatchObject({ type: 'cordclean/plugin-page-result', id: 'r1', ok: true, value: [1] })
    expect(response.requestId).toBeUndefined()
  })

  it('兼容旧工坊协议（action/key/dataId/requestId）', () => {
    const request = parsePluginPageRequest({
      channel: 'cordclean/plugin-page',
      source: 'cordclean/plugin-page',
      type: 'cordclean/plugin-page',
      action: 'resolve',
      id: 'disks',
      key: 'disks',
      dataId: 'disks',
      requestId: 'r-old',
    })
    expect(request).toEqual({ legacy: true, requestId: 'r-old', resolverId: 'disks', params: undefined })
    const response = buildPluginPageResponse(request!, { ok: true, value: { items: [] } })
    expect(response).toMatchObject({ requestId: 'r-old', requestID: 'r-old', replyTo: 'r-old', ok: true })
  })

  it('忽略非 bridge 消息', () => {
    expect(parsePluginPageRequest({ type: 'other' })).toBeNull()
    expect(parsePluginPageRequest({ type: 'cordclean/plugin-page', method: 'resolve' })).toBeNull()
    expect(parsePluginPageRequest(null)).toBeNull()
  })
})

describe('插件启用时配置保留', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cordclean-plugin-config-'))
  let app: App | undefined

  afterAll(async () => {
    await app?.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('record 配置为空时从 settings 恢复（避免工坊 Key 被默认值覆盖）', async () => {
    app = await createApp({
      dataDir: dir,
      logger: false,
      settingsOverrides: {
        plugins: {
          'ai-workshop': {
            enabled: true,
            config: {
              apiKey: 'sk-test-config-preserve',
              baseUrl: 'https://api.deepseek.com',
              apiShape: 'chat',
              model: 'deepseek-flash',
            },
          },
        },
      },
    })
    const records = (app.ctx.plugins as any).records as Map<string, any>
    const record = records.get('ai-workshop')
    expect(record).toBeTruthy()
    expect(record.config.apiKey).toBe('sk-test-config-preserve')

    // 模拟异常启动后的空 record，再启用；旧的实现会用默认配置覆盖 Key
    record.config = {}
    await app.ctx.plugins.disable('ai-workshop')
    await app.ctx.plugins.enable('ai-workshop')
    const current = app.ctx.plugins.list().find((plugin) => plugin.id === 'ai-workshop')
    expect(current?.config.apiKey).toBe('sk-test-config-preserve')
  })
})
