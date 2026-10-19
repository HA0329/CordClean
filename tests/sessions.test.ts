import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from '@cordclean/core'
import { createSandbox, manifestOf } from './helpers.ts'

const sandbox = createSandbox()
afterAll(() => {})

describe('清理会话持久化', () => {
  it('进程重启后残留 running 会话标记为 interrupted', async () => {
    const dataDir = path.join(sandbox.dataDir, 'sessions')
    const first = await createApp({ dataDir, logger: false, manifest: manifestOf([]) })
    first.ctx.history.beginSession('s-test', ['temp'])
    await first.dispose()

    const second = await createApp({ dataDir, logger: false, manifest: manifestOf([]) })
    try {
      const sessions = second.ctx.history.sessions()
      expect(sessions.length).toBe(1)
      expect(sessions[0]).toMatchObject({ sessionId: 's-test', status: 'interrupted' })
    } finally {
      await second.dispose()
    }
  })
})
