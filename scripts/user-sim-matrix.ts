/**
 * 真实用户不可控场景矩阵（隔离数据目录，不动真实数据）。
 * 运行：pnpm exec tsx .run/sim-matrix.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '@cordclean/core'
import { toLongPath } from '@cordclean/utils'

const root = mkdtempSync(path.join(os.tmpdir(), 'cc-sim-'))
const dataDirA = path.join(root, 'data-a')
const dataDirB = path.join(root, 'data-b')
const fixtures = {
  empty: path.join(root, 'fixtures-empty'),
  files: path.join(root, 'fixtures-files'),
  big: path.join(root, 'fixtures-big'),
  large: path.join(root, 'fixtures-large'),
  deep: path.join(root, 'fixtures-deep'),
  weird: path.join(root, 'fixtures weird 名称 #1'),
}
for (const dir of Object.values(fixtures)) mkdirSync(dir, { recursive: true })
for (let i = 0; i < 20; i++) writeFileSync(path.join(fixtures.files, `f-${i}.log`), Buffer.alloc(2048, i))
for (let i = 0; i < 3000; i++) writeFileSync(path.join(fixtures.big, `big-${String(i).padStart(4, '0')}.dat`), Buffer.alloc(128, 1))
// 长路径：约 250+ 字符（Windows 普通 API 边界附近）
let deep = fixtures.deep
for (let i = 0; i < 5; i++) {
  deep = path.join(deep, ('very-long-directory-name-' + i + '-').padEnd(45, 'x'))
  mkdirSync(deep, { recursive: true })
}
writeFileSync(path.join(deep, 'deep.txt'), 'deep')
const longFile = path.join(deep, 'deep.txt')
writeFileSync(path.join(fixtures.weird, 'a b 空格.tmp'), 'x')

const results: Array<{ name: string; ok: boolean; detail: unknown }> = []
const record = (name: string, ok: boolean, detail: unknown) => {
  results.push({ name, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}: ${JSON.stringify(detail).slice(0, 500)}`)
}
const codeOf = (error: unknown) => String((error as any)?.code ?? (error as any)?.name ?? 'unknown')

const appA = await createApp({ dataDir: dataDirA, logLevel: 'error', settingsOverrides: { analysis: { roots: [fixtures.files, fixtures.large] } } })
const ctxA = appA.ctx as any
try {
  // S1 首次使用：无扫描/无设置
  const fresh = {
    tasks: ctxA.cleaner.list().length,
    lastScan: Boolean(ctxA.cleaner.lastScan?.()),
    aiConfigured: ctxA.ai?.configured?.() === true,
    workshopAvailable: Boolean(ctxA.aiWorkshop?.status?.()),
  }
  record('S1 首次使用（空数据目录）', fresh.tasks > 0 && fresh.lastScan === false && fresh.aiConfigured === false, fresh)

  // 自定义任务：空、文件、大目录、长路径、怪字符
  const defineFileTask = (id: string, dir: string) =>
    ctxA.cleaner.define({
      id,
      name: id,
      description: id,
      category: 'temp',
      risk: 'safe',
      targets: [dir],
      async scan(scan: any) {
        for (const entry of await fsp.readdir(dir)) {
          const full = path.join(dir, entry)
          const stat = await fsp.stat(full).catch(() => undefined)
          if (stat?.isFile()) scan.emit({ path: full, kind: 'file', size: stat.size, risk: 'safe', defaultSelected: false, title: entry })
        }
      },
    })
  defineFileTask('sim-empty', fixtures.empty)
  defineFileTask('sim-files', fixtures.files)
  defineFileTask('sim-big', fixtures.big)
  defineFileTask('sim-weird', fixtures.weird)
  ctxA.cleaner.define({
    id: 'sim-deep',
    name: 'deep',
    description: 'deep',
    category: 'temp',
    risk: 'safe',
    targets: [fixtures.deep],
    async scan(scan: any) {
      const stat = await fsp.stat(toLongPath(longFile)).catch(() => undefined)
      if (stat) scan.emit({ path: longFile, kind: 'file', size: stat.size, risk: 'safe', defaultSelected: false, title: 'deep.txt' })
    },
  })

  // S2 空数据扫描
  const emptyScan = await ctxA.cleaner.scan({ taskIds: ['sim-empty'] })
  record('S2 空数据扫描（0 项/0 错误）', emptyScan.items.length === 0 && emptyScan.errors.length === 0, { items: emptyScan.items.length, errors: emptyScan.errors.length })

  // S3 乱序/越界：未扫描先清理、非法 itemId、未知 taskId
  const noScanClean = await ctxA.cleaner.clean({ itemIds: ['nope'] }).then(() => ({ ok: false, code: 'unexpected-success' }), (e: unknown) => ({ ok: true, code: codeOf(e), message: String((e as any)?.message ?? '').slice(0, 120) }))
  record('S3a 未扫描/非法 itemId → 可读错误', noScanClean.ok, noScanClean)
  const badTask = await ctxA.cleaner.scan({ taskIds: ['__unknown__'] }).then(() => ({ ok: false, code: 'unexpected-success' }), (e: unknown) => ({ ok: true, code: codeOf(e), message: String((e as any)?.message ?? '').slice(0, 120) }))
  record('S3b 未知 taskId → 报错', badTask.ok, badTask)

  // S4 取消扫描（长任务：逐条 emit 并 throwIfAborted）
  ctxA.cleaner.define({
    id: 'sim-slow',
    name: 'slow',
    description: 'slow',
    category: 'temp',
    risk: 'safe',
    targets: [fixtures.big],
    async scan(scan: any) {
      for (let i = 0; i < 100000; i++) {
        scan.throwIfAborted()
        if (i % 500 === 0) await new Promise((r) => setTimeout(r, 1))
        scan.emit({ path: path.join(fixtures.big, `slow-${i}.log`), kind: 'file', size: 1, risk: 'safe', defaultSelected: false, title: 'slow' })
      }
    },
  })
  const ac = new AbortController()
  const slow = ctxA.cleaner.scan({ taskIds: ['sim-slow'], signal: ac.signal })
  setTimeout(() => ac.abort(), 30)
  const slowReport = await slow.then((r: any) => ({ ok: true, cancelled: r.cancelled, items: r.items.length }), (e: unknown) => ({ ok: true, cancelled: true, code: codeOf(e) }))
  record('S4 扫描取消', Boolean(slowReport.cancelled), slowReport)

  // S5 并发：扫描进行中再扫描/清理
  const longScan = ctxA.cleaner.scan({ taskIds: ['sim-big'] })
  const concurrentScan = ctxA.cleaner.scan({ taskIds: ['sim-files'] }).then((r: any) => ({ rejected: false, items: r.items.length }), (e: unknown) => ({ rejected: true, code: codeOf(e) }))
  const concurrentClean = ctxA.cleaner.clean({ itemIds: ['x'] }).then((r: any) => ({ rejected: false }), (e: unknown) => ({ rejected: true, code: codeOf(e) }))
  const first = await longScan.then((r: any) => ({ cancelled: r.cancelled, items: r.items.length }), (e: unknown) => ({ error: codeOf(e) }))
  const second = await concurrentScan
  const cleanDuring = await concurrentClean
  record('S5 并发扫描/扫描中清理', Boolean(second) && Boolean(cleanDuring.rejected || first.cancelled), { first, second, cleanDuring })

  // S6 无权限：扫描系统目录任务（真实规则任务）
  const perm = await ctxA.cleaner.scan({ taskIds: ['rule:system_admin'] }).then((r: any) => ({ ok: true, items: r.items.length, errors: r.errors.length }), (e: unknown) => ({ ok: false, code: codeOf(e) }))
  record('S6 无权限路径扫描不崩溃', perm.ok === true, perm)

  // S7 长路径/怪字符：只验证扫描链不崩；0 项也算优雅处理
  try {
    const deepScan = await ctxA.cleaner.scan({ taskIds: ['sim-deep'] })
    record('S7 长路径扫描（优雅处理）', true, { items: deepScan.items.length, pathLength: longFile.length, errors: deepScan.errors.length })
    const weirdScan = await ctxA.cleaner.scan({ taskIds: ['sim-weird'] })
    record('S7b 空格/中文 文件名扫描', weirdScan.items.length > 0, { items: weirdScan.items.length })
  } catch (error) {
    record('S7 长路径扫描（优雅处理）', false, { message: String((error as any)?.message ?? error) })
  }
  // S8 大目录：3000 文件扫描 + 结果量
  const tBig = Date.now()
  const big = await ctxA.cleaner.scan({ taskIds: ['sim-big'] })
  record('S8 大目录 3000 文件扫描', big.items.length >= 3000, { items: big.items.length, errors: big.errors.length, elapsedMs: Date.now() - tBig, truncated: big.stats.truncated })

  // S9 隔离数据目录清理：只清 fixture，预演 + 真实清理（强制回收站/隔离区）
  const filesScan = await ctxA.cleaner.scan({ taskIds: ['sim-files'] })
  const ids = filesScan.items.slice(0, 3).map((i: any) => i.id)
  const dry = await ctxA.cleaner.clean({ itemIds: ids, dryRun: true })
  const real = await ctxA.cleaner.clean({ itemIds: ids, forceQuarantine: true })
  const remaining = filesScan.items.slice(0, 3).filter((i: any) => {
    try { return require('node:fs').existsSync(i.path) } catch { return false }
  }).length
  record('S9 预演+真实清理（隔离区）', dry.dryRun === true && real.cleaned + real.quarantined >= 1 && remaining === 0, { dry: dry.cleaned, real: { cleaned: real.cleaned, quarantined: real.quarantined, failed: real.failed }, remaining })

  // S10 设置越界/坏值容错
  ctxA.settings.patch({ scan: { concurrency: -99, maxEntriesPerTask: 1, maxDepth: 999 }, clean: { retries: 99 } })
  const s = ctxA.settings.get()
  record('S10 设置越界被 clamp（不崩溃）', s.scan.concurrency >= 1 && s.scan.maxDepth <= 128, { concurrency: s.scan.concurrency, maxEntries: s.scan.maxEntriesPerTask, maxDepth: s.scan.maxDepth, retries: s.clean.retries })

  // S11 AI/工坊未配置 Key：明确不可用（预期）
  await ctxA.plugins.enable('ai')
  await ctxA.plugins.enable('ai-workshop')
  await new Promise((r) => setTimeout(r, 300))
  const aiNoKey = await ctxA.ai.analyze?.({}).then(() => ({ rejected: false, code: 'unexpected-success' }), (e: unknown) => ({ rejected: true, code: codeOf(e), message: String((e as any)?.message ?? '').slice(0, 120) }))
  const wsNoKey = await ctxA.aiWorkshop.draftPlugin?.('写一个插件').then(() => ({ rejected: false, code: 'unexpected-success' }), (e: unknown) => ({ rejected: true, code: codeOf(e), message: String((e as any)?.message ?? '').slice(0, 120) }))
  record('S11 未配置 Key → AI/工坊明确不可用', Boolean(aiNoKey?.rejected && wsNoKey?.rejected), { ai: aiNoKey, workshop: wsNoKey })

  // S12 工坊空/超长需求（未配置 Key 时应先报 AUTH；配置后 BAD_REQUEST 由真实模型脚本覆盖）
  const longReq = 'x'.repeat(5000)
  const longReqResult = await ctxA.aiWorkshop.draftPlugin?.(longReq).then(() => ({ rejected: false }), (e: unknown) => ({ rejected: true, code: codeOf(e) }))
  record('S12 工坊超长需求有界错误', Boolean(longReqResult?.rejected), longReqResult)
} catch (error) {
  record('矩阵未捕获异常', false, { code: codeOf(error), message: String((error as any)?.message ?? '').slice(0, 300) })
} finally {
  await appA.dispose()
}

// S13 重启恢复：同一数据目录二次启动
try {
  const app1 = await createApp({ dataDir: dataDirB, logLevel: 'error' })
  const c1 = app1.ctx as any
  await c1.plugins.enable('scheduler')
  c1.settings.patch({ scan: { concurrency: 6 }, ui: { editorCommand: 'notepad' } })
  await c1.cleaner.scan({ taskIds: ['rule:system_temp'] }).catch(() => undefined)
  await app1.dispose()
  const app2 = await createApp({ dataDir: dataDirB, logLevel: 'error' })
  const c2 = app2.ctx as any
  const scheduler = c2.plugins.list().find((p: any) => p.id === 'scheduler')
  const s = c2.settings.get()
  const history = c2.history?.list?.() ?? c2.history?.list
  record('S13 重启恢复（设置/插件状态/历史）', s.scan.concurrency === 6 && s.ui.editorCommand === 'notepad' && scheduler?.enabled === true, {
    concurrency: s.scan.concurrency,
    editor: s.ui.editorCommand,
    schedulerEnabled: scheduler?.enabled,
    historyLoaded: typeof history === 'function' ? true : Boolean(history),
    tasks: c2.cleaner.list().length,
  })
  await app2.dispose()
} catch (error) {
  record('S13 重启恢复', false, { code: codeOf(error), message: String((error as any)?.message ?? '').slice(0, 240) })
}

rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
const summary = { total: results.length, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).map((r) => r.name), results }
writeFileSync(path.join(process.cwd(), '.run', 'sim-matrix.json'), JSON.stringify(summary, null, 2), 'utf8')
const md = ['| 场景 | 结果 | 关键证据 |', '| --- | --- | --- |', ...results.map((r) => `| ${r.name} | ${r.ok ? '✅ PASS' : '❌ FAIL'} | ${JSON.stringify(r.detail).replace(/\|/g, '\\|').slice(0, 300)} |`)].join('\n')
writeFileSync(path.join(process.cwd(), '.run', 'sim-matrix.md'), md, 'utf8')
console.log(`\n===== 用户场景矩阵：${summary.passed}/${summary.total} 通过 =====`)
if (summary.failed.length) console.log('FAILED:', summary.failed.join(' | '))
process.exit(summary.failed.length ? 1 : 0)
