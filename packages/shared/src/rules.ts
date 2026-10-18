/**
 * 清理规则（数据化）契约。
 *
 * 规则是「内容资产」：一条规则描述"清哪个目录/哪类文件、什么条件、多大风险"，
 * 由规则包以 JSON 形式提供，内核与插件都不需要认识具体软件名。
 *
 * 设计参考：
 * - PC-Cleaner 的 rules.json（30 分类 / 276 条，8 种 target 类型）；
 * - 毕业设计说明书 v4.0 第 5.4 节的「规则评估插件」与 6.2.1 的「规则注册」。
 */
import type { CategoryId, RiskLevel } from './index.ts'

/** 规则来源：内置 / 导入（如从其它工具迁移）/ 用户自定义 / AI 生成 */
export type RuleSource = 'builtin' | 'imported' | 'user' | 'ai'

/** 规则动作：clear=清空目录内容，delete=删除目录本身，report=只报告，compact=数据库压缩 */
export type RuleAction = 'clear' | 'delete' | 'report' | 'compact'

/** 目标类型 */
export type RuleTargetType =
  | 'clear_dir'
  | 'delete_dir'
  | 'glob_files'
  | 'glob_dirs'
  | 'files_by_rule'
  | 'find_dirs'
  | 'broken_shortcuts'
  | 'compact_db'

/** 单个清理目标（一条规则） */
export interface RuleTarget {
  /** 目标类型 */
  type: RuleTargetType
  /** 单一路径（支持 %ENV%、~/ 展开） */
  path?: string
  /** 多候选路径（同一软件的不同版本/安装位置） */
  paths?: string[]
  /** glob 基目录 */
  base?: string
  /** glob 多候选基目录 */
  bases?: string[]
  /** glob 模式，如 thumbcache_*.db、星号斜杠 History */
  pattern?: string
  /** find_dirs 的目录名列表 */
  names?: string[]
  /** 动作，默认 clear */
  action?: RuleAction
  /** 仅在深度模式启用 */
  deepOnly?: boolean
  /** 目标被进程占用时跳过（而不是计为失败） */
  skipIfInUse?: boolean
  /** 只处理 N 天前的文件/目录 */
  olderThanDays?: number
  /** 只处理大于 N MB 的文件 */
  minSizeMb?: number
  /** find_dirs / 遍历深度上限 */
  maxDepth?: number
  /** glob 时排除的目录名（如 Startup） */
  excludeDirs?: string[]
  /** 需要管理员权限才能完整清理 */
  requiresAdmin?: boolean
}

/** 一条完整规则 */
export interface CleanRule {
  /** 全局唯一 id，建议 `${category}-${序号}` */
  id: string
  /** 所属分类 key */
  category: string
  /** 展示名（对应界面上的清理项名称） */
  name: string
  /** 目标定义 */
  target: RuleTarget
  /** 默认风险等级 */
  risk: RiskLevel
  /** 来源 */
  source: RuleSource
  /** 规则版本，用于热替换判定 */
  version: number
  /** 分类展示名（由规则包在导入时填充） */
  categoryLabel?: string
  /** 分类映射到界面的功能分类 */
  categoryId?: CategoryId
  /** 分类说明 */
  categoryNote?: string
  /** 面向用户的说明 */
  note?: string
  /** 是否启用 */
  enabled?: boolean
}

/** 规则分类（一组规则的集合，通常对应一个清理任务） */
export interface RuleCategory {
  key: string
  label: string
  /** 分类风险（取组内最高） */
  risk: RiskLevel
  /** 映射到界面的功能分类 */
  category: CategoryId
  note?: string
  rules: CleanRule[]
}

/** 规则校验结果 */
export interface RuleIssue {
  level: 'error' | 'warning'
  ruleId?: string
  category?: string
  message: string
}

export interface RuleValidationReport {
  issues: RuleIssue[]
  stats: {
    categories: number
    rules: number
    byType: Record<string, number>
    byRisk: Record<string, number>
    unsupported: number
  }
}

export const RULE_TARGET_TYPES: RuleTargetType[] = [
  'clear_dir',
  'delete_dir',
  'glob_files',
  'glob_dirs',
  'files_by_rule',
  'find_dirs',
  'broken_shortcuts',
  'compact_db',
]

/** 本版本已实现的规则类型（其余会在校验中提示"暂不支持"） */
export const SUPPORTED_RULE_TYPES: RuleTargetType[] = [
  'clear_dir',
  'delete_dir',
  'glob_files',
  'glob_dirs',
  'files_by_rule',
  'find_dirs',
  'compact_db',
]

/** 规则动作是否有删除语义 */
export function isDestructiveAction(action: RuleAction | undefined): boolean {
  return action !== 'report'
}

/** 需要路径的目标类型 */
const PATH_TYPES: RuleTargetType[] = ['clear_dir', 'delete_dir']
/** 需要 base + pattern 的目标类型 */
const GLOB_TYPES: RuleTargetType[] = ['glob_files', 'glob_dirs']

/**
 * 结构校验（纯函数，不访问文件系统）。
 *
 * 返回 error 级别的问题会阻止该规则被注册；warning 只提示。
 * 文件系统相关的告警（死目标、冗余、落在保护目录）由 scripts/audit-rules.ts 补充。
 */
export function validateRules(rules: CleanRule[]): RuleIssue[] {
  const issues: RuleIssue[] = []
  const seen = new Set<string>()
  for (const rule of rules) {
    const where = rule?.id ? `规则 ${rule.id}` : '未命名规则'
    if (!rule || typeof rule !== 'object') {
      issues.push({ level: 'error', message: '规则不是对象' })
      continue
    }
    if (!rule.id) issues.push({ level: 'error', message: '缺少 id' })
    if (!rule.category) issues.push({ level: 'error', ruleId: rule.id, message: `${where} 缺少 category` })
    if (!rule.name) issues.push({ level: 'warning', ruleId: rule.id, message: `${where} 缺少 name` })
    if (!rule.risk) issues.push({ level: 'error', ruleId: rule.id, message: `${where} 缺少 risk` })
    if (rule.id) {
      if (seen.has(rule.id)) issues.push({ level: 'error', ruleId: rule.id, message: `${where} id 重复` })
      seen.add(rule.id)
    }
    const target = rule.target
    if (!target || typeof target !== 'object') {
      issues.push({ level: 'error', ruleId: rule.id, message: `${where} 缺少 target` })
      continue
    }
    if (!RULE_TARGET_TYPES.includes(target.type)) {
      issues.push({ level: 'error', ruleId: rule.id, message: `${where} 非法 target.type=${String(target.type)}` })
      continue
    }
    if (!SUPPORTED_RULE_TYPES.includes(target.type)) {
      issues.push({ level: 'warning', ruleId: rule.id, message: `${where} 类型 ${target.type} 暂未实现，将被跳过` })
      continue
    }
    if (PATH_TYPES.includes(target.type) && !target.path && !target.paths?.length) {
      issues.push({ level: 'error', ruleId: rule.id, message: `${where} 缺少 path/paths` })
    }
    if (GLOB_TYPES.includes(target.type)) {
      if (!target.base && !target.bases?.length) {
        issues.push({ level: 'error', ruleId: rule.id, message: `${where} 缺少 base/bases` })
      }
      if (!target.pattern) {
        issues.push({ level: 'error', ruleId: rule.id, message: `${where} 缺少 pattern` })
      }
    }
    if (target.type === 'files_by_rule') {
      if (!target.base && !target.bases?.length) {
        issues.push({ level: 'error', ruleId: rule.id, message: `${where} 缺少 base` })
      }
      if (!target.pattern && !target.minSizeMb && !target.olderThanDays) {
        issues.push({ level: 'error', ruleId: rule.id, message: `${where} 至少需要 pattern/minSizeMb/olderThanDays 之一` })
      }
    }
    if (target.type === 'find_dirs') {
      if (!target.names?.length) {
        issues.push({ level: 'error', ruleId: rule.id, message: `${where} 缺少 names` })
      }
      if (!target.maxDepth || target.maxDepth <= 0) {
        issues.push({ level: 'error', ruleId: rule.id, message: `${where} find_dirs 需要正整数 maxDepth` })
      }
    }
    if (target.olderThanDays !== undefined && (!Number.isFinite(target.olderThanDays) || target.olderThanDays < 0)) {
      issues.push({ level: 'error', ruleId: rule.id, message: `${where} olderThanDays 非法` })
    }
    if (target.minSizeMb !== undefined && (!Number.isFinite(target.minSizeMb) || target.minSizeMb < 0)) {
      issues.push({ level: 'error', ruleId: rule.id, message: `${where} minSizeMb 非法` })
    }
  }
  return issues
}

