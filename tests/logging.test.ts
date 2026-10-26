import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createApp } from '@cordclean/core'
import {
  appendLogLine,
  configureLogFile,
  flushLogFile,
  logFilePath,
  readLogLines,
  redactLogText,
} from '@cordclean/utils'
import { shouldLogRpc, summarizeRpcParams } from '@cordclean/host'
import { exportDiagnostics, recentLogs } from '../packages/host/src/diagnostics.ts'

function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'cordclean-logging-'))
}

describe('统一日志文件', () => {
  it('写入/读取/轮转：超过上限生成 .1/.2，且保留份数受控', () => {
    const dir = tempDir()
    try {
      configureLogFile({ dir, maxBytes: 1024, keep: 2, retainDays: 0 })
      // 写入足够多数据以触发多次缓冲 flush 与轮转
      for (let index = 0; index < 5000; index += 1) appendLogLine(`line-${index}-${'x'.repeat(40)}`)
      flushLogFile()
      const file = logFilePath()!
      expect(existsSync(file)).toBe(true)
      expect(existsSync(`${file}.1`)).toBe(true)
      for (let index = 0; index < 5000; index += 1) appendLogLine(`line2-${index}-${'y'.repeat(40)}`)
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
    } finally {
      await app.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
