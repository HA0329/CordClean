/**
 * 生成项目事实表（docs/project-facts.json / docs/project-facts.md）。
 *
 *   pnpm facts
 *
 * 目的：把「插件数、任务数、RPC 数、测试文件/用例数、规则条数」从源码和
 * 测试运行器中直接算出来，避免 README、论文大纲、导师材料各自维护一套数字。
 * 历史文档（release notes / verification）保留发布时口径，不回改。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '@cordclean/core'

const root = process.cwd()
const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8')
const readJson = (relative: string) => JSON.parse(read(relative))

function gitCommit(): string {
  try {
    const bin = process.platform === 'win32' ? 'git.exe' : 'git'
    return execFileSync(bin, ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

function countVitestCases(): number {
  // 直接调用本地 vitest 入口 + 当前 node。Windows 上 `pnpm.cmd` 是批处理 shim，
  // execFileSync 无法直接启动（EINVAL），以前会静默回退到静态计数、导致口径悄悄漂移。
  const vitestEntry = path.join(root, 'node_modules', 'vitest', 'vitest.mjs')
  try {
    const stdout = execFileSync(process.execPath, [vitestEntry, 'list', '--json'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const start = stdout.indexOf('[')
    if (start < 0) throw new Error('vitest list 未返回 JSON')
    const parsed = JSON.parse(stdout.slice(start))
    return Array.isArray(parsed) ? parsed.length : 0
  } catch (error) {
    console.warn('无法从 vitest list 读取用例数，回退到静态统计：' + String(error))
    const files = readdirSync(path.join(root, 'tests')).filter((file) => file.endsWith('.test.ts'))
    return files.reduce((sum, file) => {
      const text = readFileSync(path.join(root, 'tests', file), 'utf8')
      return sum + (text.match(/\b(it|test)(?:\.(?:only|skip|todo))?\s*\(/g)?.length ?? 0)
    }, 0)
  }
}

const pkg = readJson('package.json')
const manifestSource = read('packages/core/src/manifest.ts')
// 按清单条目的 `{ ... }` 块解析，避免用跨条目的正则误把下一个插件的 defaultEnabled 算到当前插件头上。
const pluginEntries = [...manifestSource.matchAll(/^ {2}\{\n([\s\S]*?)^ {2}\},?$/gm)]
  .map((match) => ({
    id: match[1].match(/\bid:\s*'([^']+)'/)?.[1] ?? '',
    defaultEnabled: !/defaultEnabled:\s*false/.test(match[1]),
  }))
  .filter((entry) => entry.id)
const pluginIds = pluginEntries.map((entry) => entry.id)
const defaultEnabledPlugins = pluginEntries.filter((entry) => entry.defaultEnabled).length

const rpcSource = read('packages/shared/src/rpc.ts')
const apiMapBody = rpcSource.match(/export interface ApiMap \{([\s\S]*?)\n\}/)?.[1] ?? ''
const rpcMethods = [...apiMapBody.matchAll(/^\s+'([^']+)':\s*\{/gm)].map((match) => match[1])

const testFiles = readdirSync(path.join(root, 'tests')).filter((file) => file.endsWith('.test.ts')).length
const testCases = countVitestCases()

const catalog = readJson('packages/plugins/rule-pack/rules/catalog.json') as { categories?: unknown }
const extra = readJson('packages/plugins/rule-pack/rules/extra.json') as { categories?: unknown }
const categoriesOf = (data: { categories?: unknown }): Array<{ rules?: unknown[] }> =>
  Array.isArray(data.categories) ? (data.categories as Array<{ rules?: unknown[] }>) : Object.values(data.categories ?? {}) as Array<{ rules?: unknown[] }>
const catalogCategories = categoriesOf(catalog)
const extraCategories = categoriesOf(extra)
const ruleCount = (categories: Array<{ rules?: unknown[] }>) =>
  categories.reduce((sum, category) => sum + (Array.isArray(category.rules) ? category.rules.length : 0), 0)

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cordclean-facts-'))
let runtimePlugins = 0
let activePlugins = 0
let tasks = 0
try {
  const app = await createApp({ dataDir, logger: false, loadPlugins: true })
  runtimePlugins = app.ctx.plugins.list().length
  activePlugins = app.ctx.plugins.list().filter((plugin) => plugin.status === 'active').length
  tasks = app.ctx.cleaner.list().length
  await app.dispose()
} finally {
  rmSync(dataDir, { recursive: true, force: true })
}

const benchmark = read('docs/benchmark.md')
const benchmarkDate = benchmark.match(/生成时间：([^\n]+)/)?.[1]?.trim() ?? 'unknown'
const benchmarkEnv = benchmark.match(/运行环境：([^\n]+)/)?.[1]?.trim() ?? 'unknown'

const facts = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  commit: gitCommit(),
  version: pkg.version,
  plugins: {
    total: runtimePlugins || pluginIds.length,
    defaultEnabled: defaultEnabledPlugins,
    activeAtRuntime: activePlugins,
    ids: pluginIds,
  },
  tasks,
  rpcMethods: rpcMethods.length,
  tests: { files: testFiles, cases: testCases },
  rules: {
    catalogCategories: catalogCategories.length,
    catalogRules: ruleCount(catalogCategories),
    extraCategories: extraCategories.length,
    extraRules: ruleCount(extraCategories),
    totalCategories: catalogCategories.length + extraCategories.length,
    totalRules: ruleCount(catalogCategories) + ruleCount(extraCategories),
  },
  benchmark: {
    file: 'docs/benchmark.md',
    snapshotDate: benchmarkDate,
    environment: benchmarkEnv,
  },
}

const markdown = [
  '# CordClean 项目事实表',
  '',
  '> 本文件由 `pnpm facts` 从源码、`vitest list` 与规则 JSON 自动生成，**请勿手改**。',
  `> 生成时间：${facts.generatedAt}；commit：\`${facts.commit}\`；版本：\`${facts.version}\`。`,
  '> 论文、README、答辩材料引用数量时以本表为准；性能数字以 [benchmark.md](benchmark.md) 为唯一来源；历史发布说明保留发布时口径。',
  '',
  '| 项目 | 值 | 来源 |',
  '| --- | --- | --- |',
  `| 当前版本 | ${facts.version} | \`package.json\` |`,
  `| 内置插件 | ${facts.plugins.total} 个（默认启用 ${facts.plugins.defaultEnabled} 个，运行时 active ${facts.plugins.activeAtRuntime} 个） | \`packages/core/src/manifest.ts\` + 运行时 \`ctx.plugins.list()\` |`,
  `| 默认清理任务 | ${facts.tasks} 个 | 运行时 \`ctx.cleaner.list()\`（全部内置插件加载后） |`,
  `| RPC 方法 | ${facts.rpcMethods} 个 | \`packages/shared/src/rpc.ts\` 的 \`ApiMap\` |`,
  `| 测试文件 | ${facts.tests.files} 个 | \`tests/*.test.ts\` |`,
  `| 测试用例 | ${facts.tests.cases} 个 | \`pnpm exec vitest list --json\` |`,
  `| 规则库 | ${facts.rules.totalCategories} 类 / ${facts.rules.totalRules} 条（catalog ${facts.rules.catalogCategories} 类/${facts.rules.catalogRules} 条 + extra ${facts.rules.extraCategories} 类/${facts.rules.extraRules} 条） | \`packages/plugins/rule-pack/rules/*.json\` |`,
  `| 性能快照 | ${facts.benchmark.snapshotDate} · ${facts.benchmark.environment} | [benchmark.md](benchmark.md)（\`pnpm bench\` 生成） |`,
  '',
  '## 口径说明',
  '',
  '- 测试用例数来自运行中的 Vitest 收集结果，包含循环/动态生成的用例；静态 `it(` 计数通常会少几条，不能作为论文数字。',
  '- `docs/verification/*`、`docs/release-notes-*`、`docs/defect-log.md` 是历史快照，保留当时版本的测试数量，不代表当前仓库口径。',
  '- 论文中引用性能数据时，必须同时给出 [benchmark.md](benchmark.md) 的快照日期与运行环境；重新跑 `pnpm bench` 会覆盖该文件并生成 `docs/benchmark.json`。',
  '',
].join('\n')

writeFileSync(path.join(root, 'docs/project-facts.json'), JSON.stringify(facts, null, 2) + '\n', 'utf8')
writeFileSync(path.join(root, 'docs/project-facts.md'), markdown, 'utf8')
console.log(`facts: ${facts.plugins.total} plugins, ${facts.tasks} tasks, ${facts.rpcMethods} RPC, ${facts.tests.files} files / ${facts.tests.cases} cases, ${facts.rules.totalRules} rules`)
