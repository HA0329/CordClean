/**
 * 日志系统性能基准（v0.6.1 日志升级配套）。
 *
 *   pnpm bench:logging
 *
 * 覆盖：
 * 1. 统一日志文件追加吞吐（行/秒、MB/秒）；
 * 2. 读取末尾 1000 行耗时；
 * 3. 统一脱敏吞吐；
 * 4. RPC 日志摘要吞吐（降噪策略的 CPU 开销）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { appendLogEvent, configureLogFile, flushLogFile, readLogEntries, redactLogText } from '@cordclean/utils'
import { summarizeRpcParams } from '@cordclean/host'

const rows: Array<[string, string, string]> = []
const root = mkdtempSync(path.join(os.tmpdir(), 'cordclean-log-bench-'))

function log(section: string, metric: string, value: string): void {
  rows.push([section, metric, value])
  console.log(`${section} | ${metric} | ${value}`)
}

function formatMB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(2) + ' MB'
}

async function main(): Promise<void> {
  configureLogFile({ dir: path.join(root, 'logs'), maxBytes: 64 * 1024 * 1024, keep: 2, retainDays: 0, dedupeWindowMs: 0 })
  const line = `${new Date().toISOString()} [info] [bench] 日志写入基准：` + 'x'.repeat(120)
  const lineBytes = Buffer.byteLength(line, 'utf8')
  const writes = 20_000

  const writeStart = performance.now()
  for (let index = 0; index < writes; index += 1) appendLogEvent({ level: 'info', scope: 'bench', message: line })
  flushLogFile()
  const writeMs = performance.now() - writeStart
  log('日志写入', '行数', String(writes))
  log('日志写入', '总耗时', writeMs.toFixed(1) + ' ms')
  log('日志写入', '吞吐（含 flush）', Math.round(writes / (writeMs / 1000)).toString() + ' 行/秒')
  log('日志写入', '字节吞吐', formatMB((lineBytes * writes) / (writeMs / 1000)) + '/秒')

  const readStart = performance.now()
  const tail = readLogEntries(1000)
  const readMs = performance.now() - readStart
  log('日志读取', '末尾 1000 行', readMs.toFixed(2) + ' ms')
  log('日志读取', '实际行数', String(tail.length))

  const samples = 20_000
  const redactStart = performance.now()
  for (let index = 0; index < samples; index += 1) {
    redactLogText(`apiKey="sk-${index}abcdefghij" Bearer token-${index} 普通日志内容`)
  }
  const redactMs = performance.now() - redactStart
  log('脱敏', `${samples} 次`, redactMs.toFixed(1) + ' ms')
  log('脱敏', '吞吐', Math.round(samples / (redactMs / 1000)).toString() + ' 次/秒')

  const summaryStart = performance.now()
  for (let index = 0; index < samples; index += 1) {
    summarizeRpcParams({
      method: 'ai/plugin/install',
      apiKey: 'sk-secret',
      code: 'x'.repeat(2000),
      files: [{ path: 'index.mjs', content: 'y' }],
      manifest: { entry: 'index.mjs' },
      taskIds: ['a', 'b'],
      limit: 20,
    })
  }
  const summaryMs = performance.now() - summaryStart
  log('RPC 摘要', `${samples} 次`, summaryMs.toFixed(1) + ' ms')
  log('RPC 摘要', '吞吐', Math.round(samples / (summaryMs / 1000)).toString() + ' 次/秒')

  console.log('')
  console.log('| 分项 | 指标 | 结果 |')
  console.log('| --- | --- | --- |')
  for (const [section, metric, value] of rows) console.log(`| ${section} | ${metric} | ${value} |`)

  const markdown = [
    '# CordClean 日志系统基准（v0.6.3）',
    '',
    `生成时间：${new Date().toLocaleString('zh-CN')}`,
    `运行环境：${os.platform()} ${os.release()} · Node ${process.versions.node}`,
    '',
    '| 分项 | 指标 | 结果 |',
    '| --- | --- | --- |',
    ...rows.map(([section, metric, value]) => `| ${section} | ${metric} | ${value} |`),
    '',
    '> 写入路径：临时目录中的统一日志文件（64KB/100ms 缓冲，含最终 flush）。',
    '> 复现：`pnpm bench:logging`。',
    '',
  ].join('\n')
  const outFile = path.resolve('docs/benchmark-logging.md')
  mkdirSync(path.dirname(outFile), { recursive: true })
  writeFileSync(outFile, markdown, 'utf8')
  console.log(`\n已写入 ${outFile}`)
}

try {
  await main()
} finally {
  rmSync(root, { recursive: true, force: true })
}
