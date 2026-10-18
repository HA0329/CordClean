/**
 * 规则评估服务（`ctx.evaluator`）。
 *
 * 评估器回答的是「这条候选该不该清、风险几何、理由是什么」，与「怎么删」无关。
 * 内置启发式评估器是默认实现；AI 适配器等其它策略通过 `register()` 注册并由
 * `use()` 切换 —— 这正是论文 5.4 节「评估器可替换」的落点。
 */
import { Service, type Context } from 'cordis'
import type { EvalInput, EvalResult, EvaluatorLike, EvaluatorStrategy, RiskLevel } from '@cordclean/shared'
import { RISK_META } from '@cordclean/shared'

/** 默认启发式策略 */
export const HEURISTIC_STRATEGY: EvaluatorStrategy = {
  id: 'heuristic',
  name: '内置启发式',
  evaluate(inputs: EvalInput[]): EvalResult[] {
    return inputs.map((input) => {
      const { rule } = input
      if (input.protected) {
        return { suggest: false, risk: rule.risk, reason: '位于受保护目录，工具不会删除', strategy: 'heuristic' }
      }
      if (rule.risk === 'risky') {
        return {
          suggest: false,
          risk: 'risky' as RiskLevel,
          reason: `高风险规则（${rule.name}），默认不勾选，需手动确认`,
          strategy: 'heuristic',
        }
      }
      // 最近 24 小时修改过的文件降级为需确认，避免误删正在使用的内容
      const ageDays = input.mtimeMs > 0 ? (Date.now() - input.mtimeMs) / 86_400_000 : Number.POSITIVE_INFINITY
      if (rule.risk === 'caution' || ageDays < 1) {
        return {
          suggest: false,
          risk: 'caution' as RiskLevel,
          reason: ageDays < 1 ? '最近 24 小时内修改过，需确认' : `需人工确认（${rule.name}）`,
          strategy: 'heuristic',
        }
      }
      return { suggest: true, risk: 'safe' as RiskLevel, reason: `命中规则：${rule.name}`, strategy: 'heuristic' }
    })
  },
}

export class EvaluatorService extends Service implements EvaluatorLike {
  static inject = ['settings']

  private registry = new Map<string, EvaluatorStrategy>()
  private active = 'heuristic'

  constructor(ctx: Context) {
    super(ctx, 'evaluator')
    this.registry.set(HEURISTIC_STRATEGY.id, HEURISTIC_STRATEGY)
  }

  register(strategy: EvaluatorStrategy): () => void {
    if (!strategy?.id) throw new Error('评估策略必须提供 id')
    this.registry.set(strategy.id, strategy)
    this.ctx.logger.debug('评估策略已注册：%s（%s）', strategy.id, strategy.name)
    return () => {
      if (this.active === strategy.id) this.active = 'heuristic'
      this.registry.delete(strategy.id)
    }
  }

  strategies(): string[] {
    return [...this.registry.keys()]
  }

  current(): string {
    return this.active
  }

  use(id: string): void {
    if (!this.registry.has(id)) throw new Error(`未知的评估策略：${id}`)
    this.active = id
    this.ctx.logger.info('评估策略切换为 %s', id)
  }

  async evaluate(inputs: EvalInput[]): Promise<EvalResult[]> {
    if (!inputs.length) return []
    const strategy = this.registry.get(this.active) ?? HEURISTIC_STRATEGY
    try {
      const result = await strategy.evaluate(inputs)
      if (!Array.isArray(result) || result.length !== inputs.length) {
        throw new Error(`评估策略 ${strategy.id} 返回的结果数量不匹配`)
      }
      return result
    } catch (error) {
      this.ctx.logger.warn('评估策略 %s 失败，回退到启发式：%s', strategy.id, String(error))
      return HEURISTIC_STRATEGY.evaluate(inputs)
    }
  }

  /** 诊断：当前策略与已注册策略 */
  info(): { active: string; available: string[] } {
    return { active: this.active, available: this.strategies() }
  }
}

/** 取一组评估结果里的最高风险，供任务/分类汇总使用 */
export function maxEvalRisk(results: EvalResult[]): RiskLevel {
  let risk: RiskLevel = 'safe'
  for (const item of results) {
    if (RISK_META[item.risk].weight > RISK_META[risk].weight) risk = item.risk
  }
  return risk
}
