/**
 * 规则注册表（`ctx.rules`）。
 *
 * 设计要点（对应论文 5.2 / 6.2.1）：
 * - 规则是**数据**，谁登记、谁负责：`register(scope, rules)` 把规则挂到调用方的
 *   fiber 上，插件卸载时规则自动消失，不会出现「禁用插件后规则仍然生效」；
 * - 登记即副作用：整个登记过程放在 `scope.effect()` 里，回收与登记成对出现；
 * - 变更事件：批量登记/注销后广播 `rules/changed`，依赖方（规则包、界面）可增量刷新。
 */
import { Service, type Context } from 'cordis'
import { validateRules } from '@cordclean/shared'
import type {
  CleanRule,
  RuleCategory,
  RuleIssue,
  RuleValidationReport,
  RulesLike,
} from '@cordclean/shared'
import { RISK_META } from '@cordclean/shared'

/** 规则风险权重，用于取分类最高风险 */
const RISK_WEIGHT = RISK_META


export class RulesService extends Service implements RulesLike {
  static inject = ['settings']

  /** ruleId → 规则 */
  private table = new Map<string, CleanRule>()
  /** ruleId → 登记来源标签（诊断用：哪个插件登记的） */
  private origins = new Map<string, string>()

  constructor(ctx: Context) {
    super(ctx, 'rules')
  }

  /**
   * 登记规则。
   * @param scope 调用方上下文（通常是插件自己的 ctx），卸载时规则随之注销
   * @param input 单条或多条规则
   * @returns 手动注销函数
   */
  register(scope: Context, input: CleanRule[] | CleanRule): () => void {
    const list = (Array.isArray(input) ? input : [input]).filter(Boolean)
    if (!list.length) return () => {}

    const issues = this.validate(list)
    const rejected = new Set(issues.filter((issue) => issue.level === 'error' && issue.ruleId).map((issue) => issue.ruleId!))
    const accepted = list.filter((rule) => !rejected.has(rule.id))
    for (const issue of issues) {
      if (issue.level === 'error') this.ctx.logger.warn('规则被拒绝：%s', issue.message)
      else this.ctx.logger.debug('规则提示：%s', issue.message)
    }
    if (!accepted.length) return () => {}

    const origin = scope.fiber?.name ?? 'unknown'
    const dispose = scope.effect(() => {
      for (const rule of accepted) {
        this.table.set(rule.id, rule)
        this.origins.set(rule.id, origin)
      }
      scope.emit('rules/changed')
      return () => {
        for (const rule of accepted) {
          if (this.table.get(rule.id) === rule) this.table.delete(rule.id)
          this.origins.delete(rule.id)
        }
        scope.emit('rules/changed')
      }
    }, `rules:${accepted.length}@${origin}`)

    return () => {
      void dispose()
    }
  }

  list(): CleanRule[] {
    return [...this.table.values()].sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id))
  }

  get(id: string): CleanRule | undefined {
    return this.table.get(id)
  }

  /** 按分类聚合（分类标签取规则上的 categoryLabel） */
  categories(): RuleCategory[] {
    const groups = new Map<string, CleanRule[]>()
    for (const rule of this.list()) {
      const list = groups.get(rule.category)
      if (list) list.push(rule)
      else groups.set(rule.category, [rule])
    }
    const result: RuleCategory[] = []
    for (const [key, rules] of groups) {
      let risk = rules[0].risk
      for (const rule of rules) {
        if (RISK_WEIGHT[rule.risk].weight > RISK_WEIGHT[risk].weight) risk = rule.risk
      }
      result.push({
        key,
        label: rules[0].categoryLabel ?? key,
        risk,
        category: rules[0].categoryId ?? 'system',
        note: rules[0].categoryNote,
        rules,
      })
    }
    return result.sort((a, b) => a.key.localeCompare(b.key))
  }

  validate(rules: CleanRule[]): RuleIssue[] {
    return validateRules(rules)
  }

  stats(): RuleValidationReport['stats'] {
    const byType: Record<string, number> = {}
    const byRisk: Record<string, number> = {}
    let unsupported = 0
    for (const rule of this.table.values()) {
      byType[rule.target.type] = (byType[rule.target.type] ?? 0) + 1
      byRisk[rule.risk] = (byRisk[rule.risk] ?? 0) + 1
      if (!['clear_dir', 'delete_dir', 'glob_files', 'glob_dirs', 'files_by_rule', 'find_dirs'].includes(rule.target.type)) {
        unsupported++
      }
    }
    return {
      categories: this.categories().length,
      rules: this.table.size,
      byType,
      byRisk,
      unsupported,
    }
  }

  /** 诊断：某条规则的登记来源 */
  originOf(ruleId: string): string | undefined {
    return this.origins.get(ruleId)
  }
}
