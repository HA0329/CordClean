/**
 * 规则导入器：把 PC-Cleaner 的 rules.json 转换为本项目的规则目录。
 *
 *   pnpm exec tsx scripts/import-rules.ts [源文件] [输出文件]
 *
 * 转换原则：
 * - 保留原分类 key / 标签 / 风险 / 说明，便于对照与署名；
 * - 目标字段做 camelCase 映射（skip_if_in_use → skipIfInUse 等）；
 * - `performance`/`<CWD>` 这类与"当前目录"绑定的目标会被丢弃（桌面工具没有 CWD 语义）；
 * - 暂不支持的类型（broken_shortcuts / compact_db）保留在目录里，由审计脚本报告"未实现"；
 * - 高风险分类保留但默认不装载（rule-pack 读 settings.rules.includeRisky）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

interface SourceTarget {
  type: string
  path?: string
  paths?: string[]
  base?: string
  bases?: string[]
  pattern?: string
  names?: string[]
  action?: string
  deep_only?: boolean
  skip_if_in_use?: boolean
  older_than_days?: number
  min_size_mb?: number
  max_depth?: number
  exclude_dirs?: string[]
  label?: string
}

interface SourceCategory {
  key: string
  label: string
  risk: 'safe' | 'moderate' | 'risky'
  note?: string
  targets: SourceTarget[]
}

interface SourceRules {
  version?: string
  description?: string
  categories: SourceCategory[]
}

const RISK_MAP: Record<string, 'safe' | 'caution' | 'risky'> = {
  safe: 'safe',
  moderate: 'caution',
  risky: 'risky',
}

/** PC-Cleaner 分类 → 本项目的界面分类 */
const CATEGORY_MAP: Record<string, string> = {
  system_temp: 'system',
  gpu_caches: 'system',
  nvidia_app_cache: 'system',
  web_cache: 'browser',
  wechat_cache: 'apps',
  office_caches: 'apps',
  media_caches: 'apps',
  comm_caches: 'apps',
  game_caches: 'apps',
  game_runtime_cache: 'apps',
  live_stream_cache: 'apps',
  dev_caches: 'dev',
  downloads: 'disk',
  system_admin: 'system',
  system_logs: 'system',
  windows_old: 'system',
  dev_purge: 'dev',
  browser_privacy: 'privacy',
  browser_data: 'privacy',
  database_compact: 'browser',
  webview2_caches: 'browser',
  hidden_installer_backups: 'system',
  recycle_and_diagnostics: 'system',
  cloud_app_hidden: 'apps',
  java_rdp_legacy: 'system',
  rdp_legacy_cache: 'system',
  crash_telemetry: 'system',
  extreme_stealth: 'system',
  broken_shortcuts: 'apps',
  usage_traces: 'privacy',
}

/** 需要管理员权限的分类（按名称判断，再叠加路径判断） */
const ADMIN_CATEGORIES = new Set(['system_admin', 'windows_old', 'hidden_installer_backups', 'recycle_and_diagnostics'])

const SUPPORTED = new Set(['clear_dir', 'delete_dir', 'glob_files', 'glob_dirs', 'files_by_rule', 'find_dirs'])

const source = process.argv[2] ?? 'D:/桌面/deepseek-harness/myproject/PC-Cleaner/repo/pc_cleaner/rules.json'
const output = process.argv[3] ?? path.join(process.cwd(), 'packages/plugins/rule-pack/rules/catalog.json')

const raw = JSON.parse(readFileSync(source, 'utf8')) as SourceRules
if (!Array.isArray(raw.categories)) {
  console.error('源文件缺少 categories 数组')
  process.exit(1)
}

let dropped = 0
let converted = 0
let unsupported = 0
const categories = []

for (const category of raw.categories) {
  const rules: any[] = []
  for (const [index, target] of category.targets.entries()) {
    if (!target || !target.type) {
      dropped++
      continue
    }
    // <CWD> / . 这类与工作目录绑定的目标在桌面工具里没有意义
    const bases = (target.bases ?? (target.base ? [target.base] : [])).filter(Boolean)
    if (bases.some((base) => base.includes('<CWD>'))) {
      dropped++
      continue
    }
    const requiresAdmin =
      ADMIN_CATEGORIES.has(category.key) ||
      [target.path, target.base, ...(target.paths ?? []), ...(target.bases ?? [])].some(
        (value) => typeof value === 'string' && /%(WINDIR|SystemRoot|PROGRAMDATA|ProgramData)%/i.test(value),
      )
    const mapped: any = {
      id: `${category.key}-${index + 1}`,
      name: target.label ?? `${category.label} #${index + 1}`,
      risk: RISK_MAP[category.risk] ?? 'caution',
      source: 'imported',
      version: 1,
      target: {
        type: target.type,
        ...(target.path ? { path: target.path } : {}),
        ...(target.paths?.length ? { paths: target.paths } : {}),
        ...(target.base ? { base: target.base } : {}),
        ...(target.bases?.length ? { bases: target.bases } : {}),
        ...(target.pattern ? { pattern: target.pattern } : {}),
        ...(target.names?.length ? { names: target.names } : {}),
        ...(target.action ? { action: target.action } : {}),
        ...(target.deep_only ? { deepOnly: true } : {}),
        ...(target.skip_if_in_use ? { skipIfInUse: true } : {}),
        ...(target.older_than_days ? { olderThanDays: target.older_than_days } : {}),
        ...(target.min_size_mb ? { minSizeMb: target.min_size_mb } : {}),
        ...(target.max_depth ? { maxDepth: target.max_depth } : {}),
        ...(target.exclude_dirs?.length ? { excludeDirs: target.exclude_dirs } : {}),
        ...(requiresAdmin ? { requiresAdmin: true } : {}),
      },
    }
    if (!SUPPORTED.has(target.type)) unsupported++
    rules.push(mapped)
    converted++
  }
  if (!rules.length) continue
  categories.push({
    key: category.key,
    label: category.label,
    risk: RISK_MAP[category.risk] ?? 'caution',
    categoryId: CATEGORY_MAP[category.key] ?? 'system',
    ...(category.note ? { note: category.note } : {}),
    rules,
  })
}

const catalog = {
  version: 1,
  generatedFrom: `PC-Cleaner ${raw.version ?? 'rules.json'}（导入时间 ${new Date().toISOString()}）`,
  description: raw.description ?? '由 PC-Cleaner rules.json 转换而来',
  categories,
}

mkdirSync(path.dirname(output), { recursive: true })
writeFileSync(output, JSON.stringify(catalog, null, 2), 'utf8')

console.log(`源分类 ${raw.categories.length} 个，转换 ${converted} 条规则（丢弃 ${dropped} 条、其中暂不支持 ${unsupported} 条）`)
console.log(`输出：${output}`)
for (const category of categories) {
  console.log(`  ${category.key.padEnd(26)} ${String(category.rules.length).padStart(3)} 条  ${category.risk.padEnd(8)} ${category.label}`)
}
