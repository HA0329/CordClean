/**
 * 规则库审计：结构校验 + 死目标检测 + 受保护目标告警 + 重复检测 + 覆盖率报告。
 *
 *   pnpm exec tsx scripts/audit-rules.ts            # 控制台 + 写 docs/rules-report.md
 *   pnpm exec tsx scripts/audit-rules.ts --no-write # 只打印
 *
 * 对应 PC-Cleaner 的 validate_rules()（errors 拦截 / warnings 只提示），
 * 并额外用本项目的路径策略判断「规则是否会被安全机制拦截」。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '@cordclean/core'
import { SUPPORTED_RULE_TYPES, validateRules } from '@cordclean/shared'
import type { CleanRule } from '@cordclean/shared'

interface Catalog {
  version: number
  generatedFrom?: string
  categories: Array<{
    key: string
    label: string
    risk: string
    categoryId: string
    note?: string
    rules: Array<Omit<CleanRule, 'category' | 'categoryLabel' | 'categoryId'>>
  }>
}

const catalogPath = path.resolve(import.meta.dirname, '../packages/plugins/rule-pack/rules/catalog.json')
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as Catalog

/** 与插件运行时一致的变量展开（仅用于审计，不产生副作用） */
function expand(template: string): string {
  let value = template.trim()
  if (!value) return ''
  if (value.startsWith('~/') || value.startsWith('~\\')) value = path.join(os.homedir(), value.slice(2))
  value = value.replace(/%([^%]+)%/g, (_, name: string) => process.env[name] ?? process.env[name.toUpperCase()] ?? `%${name}%`)
  return value.includes('%') ? '' : value
}

function rootsOf(rule: CleanRule): string[] {
  const target = rule.target
  const raw = [target.path, ...(target.paths ?? []), target.base, ...(target.bases ?? [])].filter(Boolean) as string[]
  return [...new Set(raw.map(expand).filter(Boolean))]
}

const rules: CleanRule[] = catalog.categories.flatMap((category) =>
  category.rules.map((item) => ({
    ...item,
    category: category.key,
    categoryLabel: category.label,
    categoryId: category.categoryId as CleanRule['categoryId'],
    categoryNote: category.note,
  })),
)

const issues = validateRules(rules)
const errors = issues.filter((issue) => issue.level === 'error')
const warnings = issues.filter((issue) => issue.level === 'warning')

/* ------------------------------ 文件系统相关告警 ------------------------------ */

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cordclean-rules-audit-'))
const app = await createApp({ dataDir, logger: false, manifest: [] })

interface CategoryReport {
  key: string
  label: string
  risk: string
  categoryId: string
  rules: number
  roots: number
  existing: number
  blocked: number
  clearable: number
  unsupported: number
}

const reports: CategoryReport[] = []
const duplicates: string[] = []
const seen = new Map<string, string>()
const blockedSamples: string[] = []

for (const category of catalog.categories) {
  const categoryRules = rules.filter((rule) => rule.category === category.key)
  let roots = 0
  let existing = 0
  let blocked = 0
  let clearable = 0
  let unsupported = 0

  for (const rule of categoryRules) {
    if (!SUPPORTED_RULE_TYPES.includes(rule.target.type)) {
      unsupported++
      continue
    }
    for (const root of rootsOf(rule)) {
      roots++
      const key = `\$\{rule.target.type\}:\$\{root.toLowerCase()\}:\$\{rule.target.pattern ?? ''\}`
      if (seen.has(key)) duplicates.push(`${root}（${seen.get(key)} 与 ${rule.id}）`)
      else seen.set(key, rule.id)

      if (!existsSync(root)) continue
      existing++
      const clear = rule.target.type === 'clear_dir' || (rule.target.type === 'glob_dirs' && rule.target.action !== 'delete')
      // 模拟插件运行时的登记行为，再判断策略是否真的会拦截
      const dispose = clear ? app.ctx.pathPolicy.addClearRoot(root) : app.ctx.pathPolicy.addRoot(root)
      const check = clear ? app.ctx.pathPolicy.checkClear(root) : app.ctx.pathPolicy.check(root)
      if (!check.allowed) {
        // 已登记辖区仍被拒 = 命中了真正的保护目录（如 Windows\\System32），值得提示
        blocked++
        if (blockedSamples.length < 12) blockedSamples.push(`\（\）`)
      } else {
        clearable++
      }
      dispose()
    }
  }

  reports.push({
    key: category.key,
    label: category.label,
    risk: category.risk,
    categoryId: category.categoryId,
    rules: categoryRules.length,
    roots,
    existing,
    blocked,
    clearable,
    unsupported,
  })
}

await app.dispose()
rmSync(dataDir, { recursive: true, force: true })

/* --------------------------------- 输出 --------------------------------- */

const totalRules = reports.reduce((sum, item) => sum + item.rules, 0)
const totalRoots = reports.reduce((sum, item) => sum + item.roots, 0)
const totalExisting = reports.reduce((sum, item) => sum + item.existing, 0)
const totalUnsupported = reports.reduce((sum, item) => sum + item.unsupported, 0)

const lines: string[] = []
lines.push('# 规则库审计报告', '')
lines.push(`- 来源：${catalog.generatedFrom ?? '内置规则目录'}`)
lines.push(`- 生成时间：${new Date().toISOString()}`)
lines.push(`- 规模：${reports.length} 个分类 / ${totalRules} 条规则 / ${totalRoots} 个候选根目录`)
lines.push(`- 结构校验：${errors.length} 个错误，${warnings.length} 个提示；暂未实现的规则类型 ${totalUnsupported} 条（broken_shortcuts / compact_db）`)
lines.push(`- 本机可命中的根目录：${totalExisting} 个；登记辖区后仍被路径策略拦截：${reports.reduce((sum, item) => sum + item.blocked, 0)} 个`)
lines.push('')
lines.push('## 分类明细', '')
lines.push('| 分类 | 风险 | 界面归类 | 规则数 | 候选根 | 本机存在 | 策略拦截 | 策略放行 | 未实现 |')
lines.push('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |')
for (const item of [...reports].sort((a, b) => b.rules - a.rules)) {
  lines.push(`| ${item.label}（${item.key}） | ${item.risk} | ${item.categoryId} | ${item.rules} | ${item.roots} | ${item.existing} | ${item.blocked} | ${item.clearable} | ${item.unsupported} |`)
}
lines.push('')
if (duplicates.length) {
  lines.push('## 重复目标', '', ...duplicates.slice(0, 20).map((item) => `- ${item}`), '')
}
if (blockedSamples.length) {
  lines.push('## 受保护目标样例（需清空白名单或不应清理）', '', ...blockedSamples.map((item) => `- ${item}`), '')
}
if (errors.length) {
  lines.push('## 结构错误', '', ...errors.slice(0, 30).map((issue) => `- ${issue.message}`), '')
}
if (warnings.length) {
  lines.push('## 结构提示', '', ...warnings.slice(0, 40).map((issue) => `- ${issue.message}`), '')
}

const text = lines.join('\n')
console.log(text)

if (!process.argv.includes('--no-write')) {
  const output = path.resolve(import.meta.dirname, '../docs/rules-report.md')
  writeFileSync(output, text + '\n', 'utf8')
  console.log(`\n报告已写入 ${output}`)
}
