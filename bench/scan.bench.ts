/**
 * 性能基准测试（用于论文第 5 章「系统测试与性能分析」）。
 *
 *   pnpm bench
 *
 * 覆盖：
 * 1. 内核冷启动耗时；
 * 2. 目录遍历吞吐（文件/秒）；
 * 3. 重复文件哈希吞吐（MB/秒，三级策略）；
 * 4. 清理（删除）吞吐；
 * 5. 隔离区写入开销；
 * 6. 内存占用。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { createApp } from '@cordclean/core'
import { formatBytes } from '@cordclean/shared'
import { defineCleanerPlugin } from '@cordclean/shared'
import { hashFile, walk } from '@cordclean/utils'
import { fakeFilesPlugin, manifestOf } from '../tests/helpers.ts'

const rows: Array<[string, string, string]> = []
const root = mkdtempSync(path.join(os.tmpdir(), 'cc-bench-'))

function log(section: string, metric: string, value: string) {
  rows.push([section, metric, value])
  console.log(`${section} | ${metric} | ${value}`)
}

async function time<T>(task: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const start = performance.now()
  const value = await task()
  return { ms: performance.now() - start, value }
}

/* ------------------------------------------------------------------ */
/* 1. 冷启动                                                           */
/* ------------------------------------------------------------------ */
async function benchBoot() {
  const samples: number[] = []
  for (let i = 0; i < 5; i++) {
    const dataDir = path.join(root, `boot-${i}`)
    const start = performance.now()
    const app = await createApp({ dataDir, logger: false, loadPlugins: false })
    samples.push(performance.now() - start)
    await app.dispose()
  }
  samples.sort((a, b) => a - b)
  const median = samples[Math.floor(samples.length / 2)]
  log('冷启动', '内核启动（仅服务，中位数/5 次）', `${median.toFixed(1)} ms`)
  log('冷启动', '波动范围', `${samples[0].toFixed(1)} ~ ${samples[samples.length - 1].toFixed(1)} ms`)

  // 完整启动：加载全部内置插件（含 13 个插件、15 个清理任务）
  const fullSamples: number[] = []
  let taskCount = 0
  for (let i = 0; i < 3; i++) {
    const dataDir = path.join(root, `full-${i}`)
    const start = performance.now()
    const app = await createApp({ dataDir, logger: false, loadPlugins: true })
    fullSamples.push(performance.now() - start)
    taskCount = app.ctx.cleaner.list().length
    await app.dispose()
  }
  fullSamples.sort((a, b) => a - b)
  log('冷启动', `完整启动（加载全部插件与 ${taskCount} 个任务，中位数/3 次）`, `${fullSamples[1].toFixed(1)} ms`)
}

/* ------------------------------------------------------------------ */
/* 2/4/5. 遍历、清理、隔离区                                            */
/* ------------------------------------------------------------------ */
async function benchTraversal(totalFiles: number) {
  const filesDir = path.join(root, 'bulk')
  const dirs = 40
  const perDir = Math.ceil(totalFiles / dirs)
  const payload = 'x'.repeat(1024)
  for (let d = 0; d < dirs; d++) {
    const dir = path.join(filesDir, `dir-${d}`)
    mkdirSync(dir, { recursive: true })
    for (let f = 0; f < perDir; f++) {
      writeFileSync(path.join(dir, `file-${f}.log`), payload)
    }
  }

  const dataDir = path.join(root, 'data-bulk')
  const app = await createApp({
    dataDir,
    logger: false,
    manifest: manifestOf([{ id: 'bulk', plugin: fakeFilesPlugin({ id: 'bulk', roots: [filesDir] }) }]),
    settingsOverrides: { clean: { dryRunDefault: false } },
  })

  const scan = await time(() => app.ctx.cleaner.scan())
  const scanned = scan.value.items.length
  log('扫描性能', `遍历 ${scanned} 个文件（${dirs} 个目录）耗时`, `${(scan.ms / 1000).toFixed(2)} s`)
  log('扫描性能', '吞吐', `${Math.round(scanned / (scan.ms / 1000))} 文件/秒`)

  const dry = await time(() => app.ctx.cleaner.clean({ dryRun: true }))
  log('清理性能', `预演 ${dry.value.cleaned} 项耗时`, `${dry.ms.toFixed(0)} ms`)

  const real = await time(() => app.ctx.cleaner.clean({}))
  log('清理性能', `删除 ${real.value.cleaned} 个文件耗时`, `${(real.ms / 1000).toFixed(2)} s`)
  log('清理性能', '删除吞吐', `${Math.round(real.value.cleaned / (real.ms / 1000))} 文件/秒`)

  // 隔离区写入（用新文件，避免已被删除）
  const quarantineDir = path.join(root, 'q-src')
  mkdirSync(quarantineDir, { recursive: true })
  const session = app.ctx.quarantine.beginSession(`bench-${Date.now()}`)
  const qStart = performance.now()
  const count = 200
  for (let i = 0; i < count; i++) {
    const file = path.join(quarantineDir, `q-${i}.bin`)
    writeFileSync(file, payload)
    await session.move(file, 'bulk', 1024)
  }
  const qMs = performance.now() - qStart
  await session.close()
  log('隔离区', `移入 ${count} 个文件耗时`, `${qMs.toFixed(0)} ms`)
  log('隔离区', '单项平均开销', `${(qMs / count).toFixed(2)} ms`)

  await app.dispose()
}

/* ------------------------------------------------------------------ */
/* 3. 重复文件哈希                                                      */
/* ------------------------------------------------------------------ */
async function benchHash() {
  const dir = path.join(root, 'hash')
  mkdirSync(dir, { recursive: true })
  const size = 256 * 1024
  const payload = Buffer.alloc(size, 7)
  const files = 120
  for (let i = 0; i < files; i++) {
    // 每 3 个文件内容相同，其余随机化尾部
    const buffer = Buffer.from(payload)
    buffer.writeUInt32LE(Math.floor(i / 3), 0)
    writeFileSync(path.join(dir, `h-${i}.bin`), buffer)
  }
  const list: string[] = []
  for await (const entry of walk(dir)) if (!entry.isDirectory) list.push(entry.path)

  const shortest = await time(async () => {
    for (const file of list) await hashFile(file, 4096)
  })
  log('重复检测', `短哈希（4KB）${list.length} 个文件`, `${shortest.ms.toFixed(0)} ms`)

  const full = await time(async () => {
    for (const file of list) await hashFile(file)
  })
  const mb = (list.length * size) / 1024 / 1024
  log('重复检测', `全量 SHA-256 ${list.length} 个文件（${formatBytes(mb * 1024 * 1024)}）`, `${full.ms.toFixed(0)} ms`)
  log('重复检测', '全量哈希吞吐', `${(mb / (full.ms / 1000)).toFixed(0)} MB/秒`)
}

/* ------------------------------------------------------------------ */
/* 6. 内存                                                             */
/* ------------------------------------------------------------------ */
function benchMemory() {
  const used = process.memoryUsage()
  log('资源占用', '常驻内存 RSS', formatBytes(used.rss))
  log('资源占用', '堆内存 heapUsed', formatBytes(used.heapUsed))
}

/* ------------------------------------------------------------------ */
/* 输出                                                                */
/* ------------------------------------------------------------------ */
console.log('')
await benchBoot()
await benchTraversal(4000)
await benchHash()
benchMemory()

const markdown = [
  '# CordClean 性能基准测试结果',
  '',
  `生成时间：${new Date().toLocaleString('zh-CN')}`,
  `运行环境：${os.platform()} ${os.release()} · ${os.cpus().length} 核 · Node ${process.versions.node}`,
  '',
  '| 分类 | 指标 | 数值 |',
  '| --- | --- | --- |',
  ...rows.map(([a, b, c]) => `| ${a} | ${b} | ${c} |`),
  '',
  '> 说明：扫描/清理数据均在临时目录中生成（4000 个 1KB 文件，40 个目录），避免受本机磁盘状态影响；',
  '> 重复检测使用 120 个 256KB 文件（每 3 个内容相同）。',
  '',
].join('\n')

const outFile = path.join(process.cwd(), 'docs', 'benchmark.md')
mkdirSync(path.dirname(outFile), { recursive: true })
writeFileSync(outFile, markdown, 'utf8')
console.log(`\n已写入 ${outFile}`)

rmSync(root, { recursive: true, force: true })
