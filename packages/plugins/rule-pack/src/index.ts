/**
 * 规则包插件（rule-pack）。
 *
 * 它把「规则数据」翻译成「清理任务」：
 *   rules/catalog.json（导入/内置） + settings.rules.custom（用户规则）
 *     → 按分类注册任务 → 扫描目标 → 评估器给建议 → 内核执行删除/清空
 *
 * 关键收益（对应论文“新增清理域 = 新增数据文件，内核与插件零改动”）：
 * - 新增一个清理类别：往 catalog.json 或用户规则里加一段 JSON 即可；
 * - 新增一种目标类型：只需扩展本文件的 `scanTarget()` 与 shared 的规则契约。
 *
 * 安全边界：每条规则的根目录会在 setup 阶段登记到路径策略（addRoot），
 * 未登记的路径内核一律拒绝；高风险分类默认不装载（settings.rules.includeRisky）。
 */
import { realpathSync } from 'node:fs'
import path from 'node:path'
import Schema from 'schemastery'
import { defineCleanerPlugin } from '@cordclean/shared'
import type {
  CategoryId,
  CleanItemDraft,
  CleanRule,
  EvalInput,
  PathPolicyLike,
  RiskLevel,
  RuleTarget,
  TaskEnv,
  TaskScanContext,
} from '@cordclean/shared'
import { SUPPORTED_RULE_TYPES } from '@cordclean/shared'
import { exists, folderSize, mapLimit, normalizePath, pathKey, walk } from '@cordclean/utils'
import catalogJson from '../rules/catalog.json' with { type: 'json' }
import extraJson from '../rules/extra.json' with { type: 'json' }

export interface RulePackConfig {
  /** 只启用这些分类（空 = 全部） */
  only: string[]
  /** 明确排除的分类 key */
  exclude: string[]
  /** 单个分类最多上报的项数 */
  maxItemsPerCategory: number
  /** 计算目录体积时最多统计的条目数 */
  maxEntriesPerDir: number
}

const Config = Schema.object({
  only: Schema.array(Schema.string()).default([]).description('只启用这些分类 key（空表示全部）'),
  exclude: Schema.array(Schema.string()).default([]).description('排除这些分类 key（优先级高于 only）'),
  maxItemsPerCategory: Schema.number().default(400).min(10).max(5000).description('单个分类最多上报的清理项数量'),
  maxEntriesPerDir: Schema.number().default(200_000).min(1000).description('统计目录体积时的最大遍历条目数'),
})

/** 目录型分类的图标 */
const ICONS: Record<string, string> = {
  system: '🧹',
  browser: '🌐',
  privacy: '🕵️',
  disk: '💾',
  apps: '📦',
  startup: '🚀',
  dev: '🧰',
  ai: '🤖',
}

interface CatalogRule {
  id: string
  name: string
  target: RuleTarget
  risk: RiskLevel
  source?: CleanRule['source']
  version?: number
  note?: string
  enabled?: boolean
}

interface CatalogCategory {
  key: string
  label: string
  risk: RiskLevel
  categoryId: CategoryId
  note?: string
  rules: CatalogRule[]
}

interface Catalog {
  version: number
  generatedFrom?: string
  categories: CatalogCategory[]
}

const CATALOG: Catalog = {
  ...(catalogJson as unknown as Catalog),
  categories: [...(catalogJson as unknown as Catalog).categories, ...(extraJson as unknown as Catalog).categories],
}

/** 展开 %VAR% 与 ~/；无法展开时返回空串 */
export function expandTemplate(template: string, env: TaskEnv): string {
  let value = template.trim()
  if (!value) return ''
  if (value.startsWith('~/') || value.startsWith('~\\')) value = path.join(env.userProfile, value.slice(2))
  value = value.replace(/%([^%]+)%/g, (_, name: string) => env.get(name) ?? `%${name}%`)
  if (value.includes('%')) return ''
  return normalizePath(value)
}

/** 单段 glob 匹配（只支持 * 通配） */
export function matchSegment(pattern: string, name: string): boolean {
  if (pattern === '*') return true
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i').test(name)
}

/** 多段 glob 匹配（按路径分隔符逐段比较） */
export function matchSegments(patterns: string[], segments: string[]): boolean {
  if (patterns.length !== segments.length) return false
  return patterns.every((pattern, index) => matchSegment(pattern, segments[index]))
}

/** 已存在的路径用 realpath 规范成长名，避免 8.3 短名（ADMINI~1）造成同一目录两种写法 */
function canonicalizeExisting(target: string): string {
  try {
    return normalizePath(realpathSync.native(target))
  } catch {
    return target
  }
}

/** 展开一条规则的全部候选根目录（用于登记辖区与扫描） */
export function ruleRoots(rule: CleanRule, env: TaskEnv): string[] {
  const target = rule.target
  const roots: string[] = []
  const push = (value?: string) => {
    if (!value) return
    const expanded = expandTemplate(value, env)
    if (expanded) roots.push(expanded)
  }
  target.paths?.forEach(push)
  push(target.path)
  target.bases?.forEach(push)
  push(target.base)
  return [...new Set(roots.map((root) => canonicalizeExisting(root)))]
}

/** 是否属于高风险/需要管理员的规则 */
function needsAdmin(rule: CleanRule, env: TaskEnv): boolean {
  if (rule.target.requiresAdmin) return true
  return ruleRoots(rule, env).some((root) => /^[a-z]:\\windows(\\|$)/i.test(root) || /^[a-z]:\\programdata(\\|$)/i.test(root))
}

/**
 * 判断单个候选路径在「引擎视角」下是否允许清理。
 *
 * 这里必须与内核 `cleaner.pushItem` 的路径策略判断**完全一致**，否则评估器会算出
 * 与引擎相反的 `protected`，产出「位于受保护目录，工具不会删除」这类误导说明
 * （真实故障：普通缓存目录的 clear 规则被标成受保护，但引擎其实允许清理）。
 *
 * 引擎语义：
 * - 文件：只用 `check(path)`；
 * - 目录且 `action === 'clear'`：先 `checkClear(path)`（清空白名单），
 *   **不允许时回落到 `check(path)`**（普通缓存目录本来就在允许根内）；
 * - 其它目录动作：`check(path)`。
 *
 * @returns 引擎是否允许处理该路径（false 表示引擎会把该项标记为 protected）
 */
export function policyAllowsItem(
  pathPolicy: Pick<PathPolicyLike, 'check' | 'checkClear'>,
  path: string,
  kind: 'file' | 'directory',
  action?: string,
): boolean {
  const isClear = kind === 'directory' && action === 'clear'
  const clearCheck = isClear ? pathPolicy.checkClear(path) : undefined
  // 清空白名单命中则放行；否则回落普通允许根校验（与 cleaner.pushItem 同一分支）
  const policy = clearCheck?.allowed === true ? clearCheck : pathPolicy.check(path)
  return policy.allowed
}

/** 年龄/大小条件 */
function passesConditions(mtimeMs: number, size: number, target: RuleTarget): boolean {
  if (target.olderThanDays && target.olderThanDays > 0) {
    if (!mtimeMs || Date.now() - mtimeMs < target.olderThanDays * 86_400_000) return false
  }
  if (target.minSizeMb && target.minSizeMb > 0) {
    if (size < target.minSizeMb * 1024 * 1024) return false
  }
  return true
}

/** 判断目录是否应被排除 */
function isExcluded(dir: string, target: RuleTarget): boolean {
  if (!target.excludeDirs?.length) return false
  const name = path.basename(dir).toLowerCase()
  return target.excludeDirs.some((item) => item.toLowerCase() === name)
}

interface DraftWithRule {
  rule: CleanRule
  draft: CleanItemDraft
}

/** 扫描单条规则，产出清理项草稿 */
async function scanRule(
  rule: CleanRule,
  scan: TaskScanContext,
  options: { maxItems: number; maxEntriesPerDir: number },
): Promise<DraftWithRule[]> {
  const target = rule.target
  const env = scan.env
  const drafts: DraftWithRule[] = []
  const push = (draft: CleanItemDraft) => {
    if (drafts.length >= options.maxItems) return
    drafts.push({ rule, draft })
  }

  if (target.type === 'clear_dir' || target.type === 'delete_dir') {
    for (const root of ruleRoots(rule, env)) {
      scan.throwIfAborted()
      if (!(await exists(root))) continue
      const action = target.type === 'delete_dir' ? 'delete' : target.action ?? 'clear'
      if (action === 'report') continue
      if (action === 'delete') {
        push({ path: root, kind: 'directory', size: 0, meta: { ruleId: rule.id, action: 'delete' } })
        continue
      }
      const size = await folderSize(root, { maxEntries: options.maxEntriesPerDir, signal: scan.signal })
      if (!size.bytes) continue
      if (!passesConditions(0, size.bytes, target)) continue
      // 整体清空用户临时目录可能影响正在运行的程序：安全但不进入默认推荐，
      // 用户需在结果页显式勾选；其余具名缓存目录保持原推荐策略。
      const targetPaths = [target.path, ...(target.paths ?? [])].filter(Boolean).map((item) => String(item))
      const isWholeTempRoot =
        rule.category === 'system_temp' && targetPaths.some((item) => /^%(TEMP|TMP)%$/i.test(item))
      push({
        path: root,
        kind: 'directory',
        size: size.bytes,
        ...(isWholeTempRoot ? { recommended: false } : {}),
        ...(isWholeTempRoot
          ? { note: '整体清空用户临时目录，可能影响正在运行的程序；默认不勾选，建议确认无程序运行时再手动选择' }
          : {}),
        meta: { ruleId: rule.id, action: 'clear', files: size.files },
      })
    }
    return drafts
  }

  if (target.type === 'glob_files' || target.type === 'glob_dirs') {
    const patternSegments = (target.pattern ?? '*').split(/[\\/]+/).filter(Boolean)
    const wantDirectory = target.type === 'glob_dirs'
    const action = target.action ?? (wantDirectory ? 'delete' : 'clear')
    if (action === 'report') return drafts
    for (const root of ruleRoots(rule, env)) {
      scan.throwIfAborted()
      if (!(await exists(root))) continue
      for await (const entry of walk(root, {
        signal: scan.signal,
        maxDepth: patternSegments.length,
        onError: (targetPath, error) => scan.addError({ path: targetPath, message: String(error) }),
        shouldEnter: (dir) => !isExcluded(dir, target),
      })) {
        if (entry.isDirectory !== wantDirectory) continue
        const relative = entry.path.slice(root.length + 1)
        const segments = relative.split(/[\\/]+/)
        if (!matchSegments(patternSegments, segments)) continue
        if (!passesConditions(entry.mtimeMs, entry.size, target)) continue
        push({
          path: entry.path,
          kind: wantDirectory ? 'directory' : 'file',
          mtimeMs: entry.mtimeMs,
          size: wantDirectory ? (await folderSize(entry.path, { maxEntries: options.maxEntriesPerDir, signal: scan.signal })).bytes : entry.size,
          meta: { ruleId: rule.id, action: wantDirectory ? (action === 'clear' ? 'clear' : 'delete') : 'delete' },
        })
      }
    }
    return drafts
  }

  if (target.type === 'compact_db') {
    // 数据库压缩：只匹配文件，按 base + pattern（如 */History）定位
    const patternSegments = (target.pattern ?? '*').split(/[\\/]+/).filter(Boolean)
    for (const root of ruleRoots(rule, env)) {
      scan.throwIfAborted()
      if (!(await exists(root))) continue
      for await (const entry of walk(root, {
        signal: scan.signal,
        maxDepth: patternSegments.length,
        onError: (targetPath, error) => scan.addError({ path: targetPath, message: String(error) }),
      })) {
        if (entry.isDirectory) continue
        const segments = entry.path.slice(root.length + 1).split(/[\\/]+/)
        if (!matchSegments(patternSegments, segments)) continue
        push({
          path: entry.path,
          kind: 'file',
          size: entry.size,
          meta: { ruleId: rule.id, action: 'compact' },
          note: 'SQLite VACUUM：只回收空闲页，不删除数据（需先退出浏览器）',
        })
      }
    }
    return drafts
  }

  if (target.type === 'files_by_rule') {
    const patternSegments = target.pattern ? target.pattern.split(/[\\/]+/).filter(Boolean) : []
    const maxDepth = Math.max(1, patternSegments.length || 1)
    for (const root of ruleRoots(rule, env)) {
      scan.throwIfAborted()
      if (!(await exists(root))) continue
      for await (const entry of walk(root, {
        signal: scan.signal,
        maxDepth,
        onError: (targetPath, error) => scan.addError({ path: targetPath, message: String(error) }),
      })) {
        if (entry.isDirectory) continue
        if (patternSegments.length) {
          const segments = entry.path.slice(root.length + 1).split(/[\\/]+/)
          if (!matchSegments(patternSegments, segments)) continue
        }
        if (!passesConditions(entry.mtimeMs, entry.size, target)) continue
        push({ path: entry.path, kind: 'file', size: entry.size, mtimeMs: entry.mtimeMs, meta: { ruleId: rule.id, action: 'delete' } })
      }
    }
    return drafts
  }

  if (target.type === 'find_dirs') {
    const names = new Set((target.names ?? []).map((name) => name.toLowerCase()))
    if (!names.size) return drafts
    for (const root of ruleRoots(rule, env)) {
      scan.throwIfAborted()
      if (!(await exists(root))) continue
      for await (const entry of walk(root, {
        signal: scan.signal,
        maxDepth: target.maxDepth ?? 8,
        shouldEnter: (dir) => !isExcluded(dir, target),
        onError: (targetPath, error) => scan.addError({ path: targetPath, message: String(error) }),
      })) {
        if (!entry.isDirectory) continue
        if (!names.has(path.basename(entry.path).toLowerCase())) continue
        if (!passesConditions(entry.mtimeMs, 0, target)) continue
        const size = (await folderSize(entry.path, { maxEntries: options.maxEntriesPerDir, signal: scan.signal })).bytes
        push({ path: entry.path, kind: 'directory', size, meta: { ruleId: rule.id, action: 'delete' } })
      }
    }
    return drafts
  }

  return drafts
}

export default defineCleanerPlugin<RulePackConfig>({
  name: 'rule-pack',
  version: '2.0.0',
  description: '规则库：把 JSON 规则自动转换为清理能力（新增清理域只需加数据）',
  inject: ['cleaner', 'rules', 'pathPolicy', 'system', 'settings', 'evaluator'],
  Config,
  setup(ctx, config) {
    const settings = ctx.settings.get()
    if (!CATALOG?.categories?.length) return

    // 用户/AI 自定义规则（只有经 importRules 管线通过后才会写入 settings.rules.custom）
    const customCategories: CatalogCategory[] = []
    if (settings.rules.includeCustom) {
      const groups = new Map<string, CatalogCategory>()
      for (const rule of settings.rules.custom as unknown as CleanRule[]) {
        if (!rule?.target?.type || !rule.id) continue
        const key = rule.category || 'ai-custom'
        let group = groups.get(key)
        if (!group) {
          group = {
            key,
            label: rule.categoryLabel ?? key,
            risk: rule.risk ?? 'caution',
            categoryId: (rule.categoryId as CategoryId) ?? 'apps',
            rules: [],
          }
          groups.set(key, group)
          customCategories.push(group)
        }
        group.rules.push(rule as unknown as CatalogRule)
      }
    }
    const categories = [...CATALOG.categories, ...customCategories].filter((category) => {
      if (config.exclude.includes(category.key)) return false
      if (config.only.length && !config.only.includes(category.key)) return false
      if (category.risk === 'risky' && !settings.rules.includeRisky) return false
      return true
    })

    for (const category of categories) {
      const rules: CleanRule[] = category.rules
        .filter((rule) => rule.enabled !== false)
        .filter((rule) => SUPPORTED_RULE_TYPES.includes(rule.target.type))
        .filter((rule) => rule.target.deepOnly !== true || settings.rules.includeDeep)
        .map((rule) => ({
          ...rule,
          category: category.key,
          categoryLabel: category.label,
          categoryId: category.categoryId,
          categoryNote: category.note,
          source: rule.source ?? 'imported',
          version: rule.version ?? 1,
        }))
      if (!rules.length) continue

      const env = ctx.system.env
      const adminRequired = rules.some((rule) => needsAdmin(rule, env))
      const expandedTargets = [...new Set(rules.flatMap((rule) => ruleRoots(rule, env)))].slice(0, 8)

      // 0) 登记规则：归属本插件 fiber，卸载即注销（论文 6.2.1）
      const imported = ctx.rules.importRules(ctx, rules, (rule) => ruleRoots(rule, env))
      for (const item of imported.rejected) ctx.logger.debug('规则被拒绝（%s）：%s', item.ruleId, item.reason)
      if (imported.rejected.length) {
        ctx.logger.info('规则包 %s：%d 条规则因安全策略跳过（详见 debug 日志）', category.key, imported.rejected.length)
      }

      // 1) 声明辖区：每条规则的根目录都必须在路径策略里登记，否则内核拒绝删除
      ctx.effect(() => {
        const disposers = rules
          .flatMap((rule) => ruleRoots(rule, env))
          .map((root) => ctx.pathPolicy.addRoot(root, `rule-pack:${category.key}`))
        return () => disposers.forEach((dispose) => dispose())
      })

      // 2) 注册任务：每条规则在扫描时产出候选，评估器决定 risk/suggest/reason
      ctx.effect(() =>
        ctx.cleaner.define({
          id: `rule:${category.key}`,
          name: category.label,
          description: category.note?.slice(0, 120) ?? `规则包：${rules.length} 条规则`,
          category: category.categoryId,
          risk: category.risk,
          icon: ICONS[category.categoryId] ?? '🧹',
          defaultSelected: category.risk === 'safe' && !adminRequired,
          requiresAdmin: adminRequired,
          targets: expandedTargets,
          tips: [
            `共 ${rules.length} 条规则，来自规则库`,
            '规则命中后仍会经过路径策略、评估器与补偿链',
          ],
          async scan(scan) {
            const drafts = await scanCategory(scan)
            if (!drafts.length) return
            const inputs: EvalInput[] = drafts.map(({ rule, draft }) => {
              const kind = draft.kind === 'directory' ? 'directory' : 'file'
              const action = typeof draft.meta?.action === 'string' ? draft.meta.action : undefined
              return {
                rule,
                path: draft.path,
                kind,
                size: draft.size ?? 0,
                mtimeMs: 0,
                // 与引擎 cleaner.pushItem 对齐：clear 先查清空白名单，不允许再回落普通允许根，
                // 避免把引擎允许清理的项误判为 protected、向用户输出错误说明
                protected: !policyAllowsItem(scan.pathPolicy, draft.path, kind, action),
              }
            })
            const results = await ctx.evaluator.evaluate(inputs)
            for (let index = 0; index < drafts.length; index++) {
              const { rule, draft } = drafts[index]
              const result = results[index]
              scan.emit({
                ...draft,
                risk: result?.risk ?? rule.risk,
                defaultSelected: result?.suggest === true && draft.recommended !== false,
                note: result?.reason ?? rule.note,
                meta: { ...draft.meta, ruleId: rule.id, ruleName: rule.name, strategy: result?.strategy },
              })
            }
          },
        }),
      )

      async function scanCategory(scan: TaskScanContext): Promise<DraftWithRule[]> {
        // 规则之间互不依赖：并发扫描，让体积统计的 I/O 重叠起来
        const perRule = await mapLimit(rules, Math.max(1, settings.scan.concurrency), async (rule) => {
          scan.throwIfAborted()
          return scanRule(rule, scan, {
            maxItems: config.maxItemsPerCategory,
            maxEntriesPerDir: Math.min(config.maxEntriesPerDir, settings.scan.maxEntriesPerTask),
          })
        })
        const output = perRule.flat()
        return output.slice(0, config.maxItemsPerCategory)
      }
    }
  },
})
