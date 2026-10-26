import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyLoggingConfig, createApp, isLevelEnabled } from '@cordclean/core'
import {
  appendLogEvent,
  configureLogFile,
  flushLogDedupe,
  flushLogFile,
  logFilePath,
  onLogEvent,
  readLogEntries,
  readLogLines,
  redactLogText,
} from '@cordclean/utils'
import { createHandlers, shouldLogRpc, startHostServer, summarizeRpcParams, type ShellAdapter } from '@cordclean/host'
import { exportDiagnostics, exportDiagnosticsJson, recentLogEntries, recentLogs } from '../packages/host/src/diagnostics.ts'

const shell: ShellAdapter = { electron: false, async openPath() {}, async openDataDir() {} }

function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'cordclean-logging-'))
}

describe('统一日志文件', () => {
  it('写入/读取/轮转：超过上限生成 .1/.2，且保留份数受控', () => {
    const dir = tempDir()
    try {
      configureLogFile({ dir, maxBytes: 1024, keep: 2, retainDays: 0 })
      // 写入足够多数据以触发多次缓冲 flush 与轮转
      for (let index = 0; index < 5000; index += 1) appendLogEvent({ level: 'info', scope: 'test', message: `line-${index}-${'x'.repeat(40)}` })
      flushLogFile()
      const file = logFilePath()!
      expect(existsSync(file)).toBe(true)
      expect(existsSync(`${file}.1`)).toBe(true)
      for (let index = 0; index < 5000; index += 1) appendLogEvent({ level: 'info', scope: 'test', message: `line2-${index}-${'y'.repeat(40)}` })
      flushLogFile()
      expect(existsSync(`${file}.2`)).toBe(true)
      expect(existsSync(`${file}.3`)).toBe(false)
      expect(readLogLines(10)).toHaveLength(10)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('统一脱敏：Key/Token/Authorization 不落入日志', () => {
    const redacted = redactLogText(
      'apiKey="sk-abcdefghijklmnop" token=abc123 Bearer abc.def-ghi password=hello {"authorization":"Secret"}',
    )
    expect(redacted).not.toContain('sk-abcdefghijklmnop')
    expect(redacted).not.toContain('abc123')
    expect(redacted).not.toContain('Bearer abc.def-ghi')
    expect(redacted).toContain('<redacted>')
  })

  it('旧版 app-*.log 按保留天数清理', () => {
    const dir = tempDir()
    try {
      const legacy = path.join(dir, 'app-2020-01-01.log')
      writeFileSync(legacy, 'old')
      const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      utimesSync(legacy, old, old)
      configureLogFile({ dir, maxBytes: 1024, keep: 2, retainDays: 14 })
      expect(existsSync(legacy)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('RPC 日志降噪', () => {
  it('高频只读方法默认不记；失败、慢请求、普通方法要记', () => {
    expect(shouldLogRpc('system/live', 12, true)).toBe(false)
    expect(shouldLogRpc('app/info', 1, true)).toBe(false)
    expect(shouldLogRpc('system/live', 800, true)).toBe(true)
    expect(shouldLogRpc('system/live', 3, false)).toBe(true)
    expect(shouldLogRpc('scan/start', 20, true)).toBe(true)
  })

  it('参数摘要：Key 脱敏、代码/文件只记形状', () => {
    const summary = summarizeRpcParams({
      apiKey: 'sk-secret',
      code: 'x'.repeat(1000),
      files: [{ path: 'index.mjs', content: 'y' }],
      manifest: { entry: 'index.mjs' },
      taskIds: ['a', 'b'],
      limit: 20,
      query: 'small',
    }) as Record<string, unknown>
    expect(summary.apiKey).toBe('<redacted>')
    expect(summary.code).toBe('<1000 chars>')
    expect(summary.files).toBe('<array:1>')
    expect(summary.manifest).toBe('<object>')
    expect(summary.taskIds).toBe('<array:2>')
    expect(summary.limit).toBe(20)
    expect(summary.query).toBe('small')
  })
})

describe('结构化日志（Phase 2）', () => {
  it('JSONL：每行一个结构化对象，字段脱敏并可通过 onLogEvent 实时订阅', () => {
    const dir = tempDir()
    try {
      configureLogFile({ dir, maxBytes: 4 * 1024 * 1024, keep: 2, retainDays: 0 })
      const events: unknown[] = []
      const off = onLogEvent((entry) => events.push(entry))
      const entry = appendLogEvent({
        level: 'warn',
        scope: 'test',
        message: 'apiKey=sk-abcdefghijklmnop 测试',
        fields: { apiKey: 'sk-abcdefghijklmnop', count: 2, code: 'x'.repeat(2000) },
        requestId: 'rpc-test-1',
      })
      off()
      expect(events).toHaveLength(1)
      expect(entry.fields?.apiKey).toBe('<redacted>')
      expect(entry.fields?.count).toBe(2)
      expect(String(entry.fields?.code)).toContain('…')
      const file = logFilePath()!
      flushLogFile()
      const lastLine = readFileSync(file, 'utf8').trim().split('\n').at(-1)!
      const parsed = JSON.parse(lastLine)
      expect(parsed.level).toBe('warn')
      expect(parsed.scope).toBe('test')
      expect(parsed.requestId).toBe('rpc-test-1')
      expect(parsed.fields.apiKey).toBe('<redacted>')
      expect(readLogEntries(5).at(-1)?.requestId).toBe('rpc-test-1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('运行时日志级别：settings.logging.level=error 时 info 不落盘', async () => {
    const dir = tempDir()
    const app = await createApp({
      dataDir: dir,
      logger: true,
      logLevel: 'info',
      logForward: false,
      settingsOverrides: { logging: { level: 'error', maxBytes: 5 * 1024 * 1024, keep: 2, retainDays: 0 } },
    })
    try {
      app.ctx.logger.info('SHOULD-NOT-BE-WRITTEN')
      app.ctx.logger.error('SHOULD-BE-WRITTEN')
      const entries = recentLogEntries(100)
      expect(entries.some((entry) => entry.message.includes('SHOULD-BE-WRITTEN'))).toBe(true)
      expect(entries.some((entry) => entry.message.includes('SHOULD-NOT-BE-WRITTEN'))).toBe(false)
    } finally {
      await app.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('重复日志合并：窗口内相同 level/scope/message 只保留首条 + 汇总次数', () => {
    const dir = tempDir()
    try {
      configureLogFile({ dir, maxBytes: 4 * 1024 * 1024, keep: 2, retainDays: 0, dedupeWindowMs: 30 })
      const events: unknown[] = []
      const off = onLogEvent((entry) => events.push(entry))
      for (let index = 0; index < 5; index += 1) {
        appendLogEvent({ level: 'warn', scope: 'plugin-demo', message: '相同的告警消息' })
      }
      flushLogDedupe()
      const matched = readLogEntries(50).filter((entry) => entry.message === '相同的告警消息')
      off()
      expect(matched).toHaveLength(2)
      expect(matched[0]?.fields?.repeat).toBeUndefined()
      expect(matched[1]?.fields?.repeat).toBe(5)
      expect(events.length).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('插件级别覆盖：只对指定插件放宽/收紧级别', () => {
    applyLoggingConfig({ level: 'warn', pluginLevels: { 'plugin-demo': 'debug' }, dedupeWindowMs: 0 })
    expect(isLevelEnabled('plugin-demo', 'debug')).toBe(true)
    expect(isLevelEnabled('plugin-demo', 'info')).toBe(true)
    expect(isLevelEnabled('other-plugin', 'info')).toBe(false)
    expect(isLevelEnabled('other-plugin', 'warn')).toBe(true)
    applyLoggingConfig({ level: 'info', pluginLevels: {}, dedupeWindowMs: 0 })
  })

  it('RPC requestId 关联：错误请求日志带 requestId，app/logs/entries 可读', async () => {
    const dir = tempDir()
    const app = await createApp({ dataDir: dir, logger: true, logLevel: 'info', logForward: false })
    const handlers = createHandlers({ ctx: app.ctx, dataDir: dir, version: app.version, bootMs: app.bootMs, shell })
    const server = await startHostServer({ ctx: app.ctx, handlers, dataDir: dir, port: 0 })
    try {
      const response = await fetch(new URL(`/api/rpc?token=${server.token}`, server.url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'plugins/source', params: { id: 'missing-plugin' } }),
      })
      const payload = await response.json()
      expect(payload.error).toBeTruthy()
      const entries = recentLogEntries(200)
      const rpcError = entries.find((entry) => entry.scope === 'rpc' && entry.level === 'error')
      expect(rpcError).toBeTruthy()
      expect(rpcError?.requestId).toMatch(/^rpc-\d+$/)
      const apiEntries = await handlers['app/logs/entries']({ limit: 100 })
      expect(Array.isArray(apiEntries)).toBe(true)
      expect(apiEntries.some((entry) => entry.requestId === rpcError?.requestId)).toBe(true)
    } finally {
      await server.close()
      await app.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('内核/插件日志与诊断统一', () => {
  it('ctx.logger 日志会进入统一文件，最近日志/诊断导出都能读到', async () => {
    const dir = tempDir()
    const app = await createApp({ dataDir: dir, logger: true, logLevel: 'info', logForward: false })
    try {
      app.ctx.logger.info('统一日志集成测试：插件消息可见')
      const lines = recentLogs(80)
      expect(lines.some((line) => line.includes('统一日志集成测试：插件消息可见'))).toBe(true)
      expect(lines.some((line) => line.includes('[info]'))).toBe(true)

      const report = exportDiagnostics({ version: 'test' })
      const content = readFileSync(report, 'utf8')
      expect(content).toContain('CordClean 诊断报告')
      expect(content).toContain('统一日志集成测试：插件消息可见')
      expect(content).toContain('最近日志')

      const jsonFile = exportDiagnosticsJson({ version: 'test' })
      const payload = JSON.parse(readFileSync(jsonFile, 'utf8'))
      expect(payload.environment.version).toBe('test')
      expect(Array.isArray(payload.entries)).toBe(true)
      expect(payload.entries.some((entry: any) => entry.message.includes('统一日志集成测试'))).toBe(true)
    } finally {
      await app.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
