/**
 * 路径校验性能拆解（用于性能优化验证）。
 *
 *   pnpm exec tsx scripts/bench-policy.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { canonicalizePath, normalizePath, pathKey, isSubPath } from '@cordclean/utils'
import { createApp } from '@cordclean/core'

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cc-micro2-'))
const app = await createApp({ dataDir, logger: false, loadPlugins: false })
const dir = path.join(dataDir, 'scope')
mkdirSync(dir, { recursive: true })
app.ctx.pathPolicy.addRoot(dir)
const policy = app.ctx.pathPolicy as any

const sample = path.join(dir, 'some-file-name.log')
const targets = Array.from({ length: 4000 }, (_, i) => path.join(dir, `file-${i}.log`))

function bench(name: string, fn: (target: string) => unknown, warm = 50) {
  for (let i = 0; i < warm; i++) fn(targets[i])
  const start = performance.now()
  for (const target of targets) fn(target)
  const elapsed = performance.now() - start
  console.log(`${name.padEnd(28)} ${elapsed.toFixed(1)} ms  (${((elapsed / targets.length) * 1000).toFixed(2)} µs/次)`)
}

bench('normalizePath', normalizePath)
bench('canonicalizePath', canonicalizePath)
bench('pathKey', pathKey)
bench('isSubPath(dir, target)', (t) => isSubPath(dir, t))
bench('policy.check', (t) => policy.check(t))
bench('policy.rootOf', (t) => policy.rootOf(t))
bench('policy.isProtected', (t) => policy.isProtected(t))
bench('ctx.pathPolicy.check', (t) => app.ctx.pathPolicy.check(t))
bench('JSON.parse 小对象', () => JSON.parse('{"a":1,"b":"x"}'))
console.log('样本：', sample.length, '字符；保护根数量：', policy.protected().length)

await app.dispose()
rmSync(dataDir, { recursive: true, force: true })
