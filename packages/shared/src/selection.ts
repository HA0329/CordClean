/**
 * 扫描结果的选择逻辑（Cleaning Selection UX v2 的纯函数层）。
 *
 * 设计约束（docs/scan-selection-design.md 第 4 节）：
 * - 纯函数：只依赖入参与 `CATEGORIES` / `RISK_META` 常量，无 DOM / Node / Vue 依赖，无副作用；
 * - 不修改入参：需要排序时先复制数组，返回新数组或新对象；
 * - 结果确定：同值排序规则固定为码元序 / 输入顺序，不依赖 locale 与 ICU 版本，
 *   保证浏览器、Electron 主进程、Node 测试与 Web 服务端拿到完全一致的顺序；
 * - 规模：对 5,000 条输入的分组 / 筛选 / 排序 / 汇总在百毫秒级完成
 *   （单次线性遍历，排序为 O(n log n)）。
 *
 * 注意：本文件与 `./index.ts` 构成 ESM 循环引用（`index.ts` 末尾 `export *`）。
 * 循环只发生在模块求值阶段，且本模块仅在函数体内读取 `CATEGORIES` / `RISK_META`，
 * 此时它们在 `index.ts` 中早已初始化完毕，因此运行期是安全的。
 */
import type { CategoryId, CleanItem, RiskLevel } from './index.ts'
import { CATEGORIES, RISK_META } from './index.ts'
import type { TaskDescriptor } from './task.ts'

/** 分组展开预览的默认样例数量：前 3 大项 */
const DEFAULT_SAMPLE_LIMIT = 3

/* ------------------------------------------------------------------ */
/* 内部工具                                                            */
/* ------------------------------------------------------------------ */

/**
 * 按 UTF-16 码元比较字符串。
 *
 * 不使用 `localeCompare`：后者的结果依赖运行环境的 locale / ICU 版本，
 * 会让浏览器与 Node 下的排序、分组顺序不一致。码元序是确定性的。
 */
function compareText(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/** 风险权重：safe(0) < caution(1) < risky(2)，与 `RISK_META.weight` 保持一致 */
function riskWeight(risk: RiskLevel): number {
  return RISK_META[risk].weight
}

/**
 * 复制后稳定排序。
 * `Array.prototype.sort` 自 ES2019 起保证稳定，因此同值元素会保持输入顺序。
 */
function stableSort<T>(items: readonly T[], compare: (a: T, b: T) => number): T[] {
  return [...items].sort(compare)
}

/** 按 size 降序（同 size 保持输入顺序） */
function compareSizeDesc(a: CleanItem, b: CleanItem): number {
  return b.size - a.size
}

/** 按 size 升序（同 size 保持输入顺序） */
function compareSizeAsc(a: CleanItem, b: CleanItem): number {
  return a.size - b.size
}

/** 建立 taskId → TaskDescriptor 的索引（重复 id 时后者覆盖前者） */
function indexTasks(tasks: readonly TaskDescriptor[]): Map<string, TaskDescriptor> {
  const index = new Map<string, TaskDescriptor>()
  for (const task of tasks) index.set(task.id, task)
  return index
}

/** 归一化 minSize：未传或非有限值按 0 处理 */
function normalizeMinSize(minSize: number | undefined): number {
  if (minSize === undefined || !Number.isFinite(minSize)) return 0
  return minSize
}

/** 归一化 sampleLimit：未传或非有限值回退默认值，负数按 0，小数向下取整 */
function normalizeSampleLimit(sampleLimit: number | undefined): number {
  if (sampleLimit === undefined || !Number.isFinite(sampleLimit)) return DEFAULT_SAMPLE_LIMIT
  return Math.max(0, Math.floor(sampleLimit))
}

/** 是否命中默认推荐策略：safe、未受保护，且未被显式排除（recommended !== false） */
function isDefaultRecommended(item: CleanItem): boolean {
  if (item.recommended === false) return false
  return item.risk === 'safe' && item.protected !== true
}

/**
 * query 是否命中清理项的可搜索字段（`title` / `path` / `note`，大小写不敏感子串）。
 * `query` 需已 trim + 转小写。
 */
function matchesQuery(item: CleanItem, query: string): boolean {
  if (item.title.toLowerCase().includes(query)) return true
  if (item.path.toLowerCase().includes(query)) return true
  if (item.note !== undefined && item.note.toLowerCase().includes(query)) return true
  return false
}

/* ------------------------------------------------------------------ */
/* 推荐选择                                                            */
/* ------------------------------------------------------------------ */

/** 「一键推荐」的选项 */
export interface RecommendOptions {
  /** 体积下限（字节，含等于），默认 0，用于过滤碎文件、聚焦大头 */
  minSize?: number
  /** 是否把 caution（谨慎）项纳入推荐，默认 false；risky 无论如何都不推荐 */
  includeCaution?: boolean
  /**
   * 只推荐这些任务下的项；未传或空数组表示不限制任务
   * （与内核 `scan({ taskIds: [] })` 的约定一致：空数组 = 全部任务）。
   */
  taskIds?: readonly string[]
}

/**
 * 计算「一键推荐」的清理项 id 列表。
 *
 * 推荐策略（docs/scan-selection-design.md 3.2）：
 * - 只推荐 `risk === 'safe'` 的项；`includeCaution` 为 true 时额外纳入 `caution`；
 * - `risky` 与 `protected` 项**永远不推荐**（无论选项如何组合）；
 * - `minSize` 为体积下限（字节，**含等于**），默认 0；
 * - `taskIds` 限定任务范围，未传或空数组表示不限制。
 *
 * 返回顺序：按 `size` 降序；`size` 相同时按 `id` 升序（码元序），
 * 保证相同输入在任何环境下都得到完全一致的顺序。
 *
 * 纯函数：不修改 `items`，返回新数组。
 */
export function recommendIds(items: readonly CleanItem[], options: RecommendOptions = {}): string[] {
  const minSize = normalizeMinSize(options.minSize)
  const includeCaution = options.includeCaution === true
  const taskFilter = options.taskIds !== undefined && options.taskIds.length > 0 ? new Set(options.taskIds) : undefined

  const picked: CleanItem[] = []
  for (const item of items) {
    if (item.protected === true) continue
    if (item.recommended === false) continue
    if (item.risk === 'risky') continue
    if (item.risk === 'caution' && !includeCaution) continue
    if (item.size < minSize) continue
    if (taskFilter !== undefined && !taskFilter.has(item.taskId)) continue
    picked.push(item)
  }

  picked.sort((a, b) => b.size - a.size || compareText(a.id, b.id))
  return picked.map((item) => item.id)
}

/* ------------------------------------------------------------------ */
/* 三态选择                                                            */
/* ------------------------------------------------------------------ */

/** 一组项在已选集合中的三态：全选 / 部分选中 / 未选中 */
export type SelectionState = 'all' | 'partial' | 'none'

/**
 * 计算一组 id 在已选集合中的三态（用于分组行的三态勾选框）。
 *
 * - `ids` 为空 → `'none'`（空组没有可勾选内容，不能视为“全选”）；
 * - `ids` 全部位于 `selected` → `'all'`；
 * - 只有一部分位于 `selected` → `'partial'`；
 * - 一个都不在（含 `ids` 非空但 `selected` 为空）→ `'none'`。
 *
 * `selected` 中的其它 id 会被忽略。纯函数，不修改入参。
 */
export function selectionState(ids: readonly string[], selected: ReadonlySet<string>): SelectionState {
  if (ids.length === 0) return 'none'
  let hit = 0
  for (const id of ids) {
    if (selected.has(id)) hit++
  }
  if (hit === 0) return 'none'
  if (hit === ids.length) return 'all'
  return 'partial'
}

/* ------------------------------------------------------------------ */
/* 分组聚合                                                            */
/* ------------------------------------------------------------------ */

/** 按清理任务聚合出的分组（分组总览视图的一行） */
export interface TaskGroup {
  taskId: string
  /** 任务展示名；找不到 TaskDescriptor 时回退为 taskId */
  name: string
  /** 任务图标；找不到 TaskDescriptor 时为 undefined */
  icon?: string
  /** 分类；找不到 TaskDescriptor 时取组内首个项（输入顺序）的 category */
  category: CategoryId
  /** 组内最高风险（safe < caution < risky） */
  risk: RiskLevel
  /** 组内项数（含受保护项） */
  count: number
  /** 组内字节数（含受保护项） */
  bytes: number
  /** 组内命中推荐策略的项数（按 `recommend` 选项计算） */
  recommendCount: number
  /** 组内命中推荐策略的字节数 */
  recommendBytes: number
  /** 组内受路径策略保护、不可删除的项数 */
  protectedCount: number
  /** 组内所有项 id（按 size 降序） */
  ids: string[]
  /** 前 `sampleLimit` 大的项，用于展开组时预览 */
  samples: CleanItem[]
}

/**
 * 按 `taskId` 把清理项聚合为任务分组。
 *
 * 语义：
 * - 每个出现过的 taskId 输出一组；空输入返回 `[]`；
 * - 组内项按 `size` 降序（同 size 保持输入顺序），`ids` 与 `samples` 都基于该顺序；
 * - `risk` 取组内最高风险（safe < caution < risky）；
 * - `recommendCount` / `recommendBytes` 按 `recommend` 选项计算，缺省即默认安全策略
 *   （safe 且非 protected；`risky` / `protected` 永不推荐）；
 * - 找不到 TaskDescriptor 时：`name = taskId`、`icon = undefined`、
 *   `category` 取组内首个项（输入顺序）的 category；
 * - `samples` 取前 `sampleLimit` 大项（默认 3；负数按 0；大于组内项数时返回全部）；
 * - 结果组按 `bytes` 降序，`bytes` 相同时按 `taskId` 升序；
 * - `count` / `bytes` / `protectedCount` 统计包含受保护项（受保护项只是不可删除，不是不存在）。
 *
 * 纯函数：不修改 `items` / `tasks` / `options`。
 */
export function groupByTask(
  items: readonly CleanItem[],
  tasks: readonly TaskDescriptor[],
  options: { sampleLimit?: number; recommend?: RecommendOptions } = {},
): TaskGroup[] {
  const sampleLimit = normalizeSampleLimit(options.sampleLimit)
  const taskIndex = indexTasks(tasks)
  const recommended = new Set(recommendIds(items, options.recommend))

  // 一次线性遍历完成分桶（Map 保留首次出现顺序，但最终结果会重新排序）
  const buckets = new Map<string, CleanItem[]>()
  for (const item of items) {
    const bucket = buckets.get(item.taskId)
    if (bucket === undefined) buckets.set(item.taskId, [item])
    else bucket.push(item)
  }

  const groups: TaskGroup[] = []
  for (const [taskId, bucket] of buckets) {
    const sorted = stableSort(bucket, compareSizeDesc)
    const descriptor = taskIndex.get(taskId)

    let bytes = 0
    let recommendCount = 0
    let recommendBytes = 0
    let protectedCount = 0
    let risk: RiskLevel = 'safe'
    for (const item of sorted) {
      bytes += item.size
      if (recommended.has(item.id)) {
        recommendCount++
        recommendBytes += item.size
      }
      if (item.protected === true) protectedCount++
      if (riskWeight(item.risk) > riskWeight(risk)) risk = item.risk
    }

    // 未知任务的分类回退：组内首个项（输入顺序，即未排序的 bucket[0]）的 category
    const first = bucket[0]
    groups.push({
      taskId,
      name: descriptor === undefined ? taskId : descriptor.name,
      icon: descriptor?.icon,
      category: descriptor === undefined ? first.category : descriptor.category,
      risk,
      count: sorted.length,
      bytes,
      recommendCount,
      recommendBytes,
      protectedCount,
      ids: sorted.map((item) => item.id),
      samples: sorted.slice(0, sampleLimit),
    })
  }

  groups.sort((a, b) => b.bytes - a.bytes || compareText(a.taskId, b.taskId))
  return groups
}

/** 按功能分类聚合出的分组（分组总览视图的第一层） */
export interface CategoryGroup {
  category: CategoryId
  /** 分类展示名，取自 `CATEGORIES` */
  name: string
  /** 分类配色，取自 `CATEGORIES` */
  color: string
  /** 分类内项数（含受保护项） */
  count: number
  /** 分类内字节数（含受保护项） */
  bytes: number
  /** 分类内命中推荐策略的项数 */
  recommendCount: number
  /** 分类内命中推荐策略的字节数 */
  recommendBytes: number
  /** 分类内的任务分组（按 bytes 降序，同 bytes 按 taskId 升序） */
  tasks: TaskGroup[]
}

/**
 * 按功能分类聚合（分类 → 任务 → 样例 的三级视图）。
 *
 * 语义：
 * - 只输出有数据的分类（8 个 `CategoryId` 中为空的不出现），
 *   顺序严格按 `CATEGORIES` 的声明顺序；
 * - `name` / `color` 取自 `CATEGORIES[category]`；
 * - 分类内 `tasks` 按 `bytes` 降序（复用 `groupByTask` 的组顺序，同 bytes 按 taskId 升序）；
 * - `count` / `bytes` / `recommendCount` / `recommendBytes` 为分类内各任务组的求和；
 * - 分组依据是任务所属分类（`TaskGroup.category`），未知任务回退为组内首个项的 category；
 * - 空输入返回 `[]`。
 *
 * 纯函数：不修改 `items` / `tasks` / `options`。
 */
export function groupByCategory(
  items: readonly CleanItem[],
  tasks: readonly TaskDescriptor[],
  options: { sampleLimit?: number; recommend?: RecommendOptions } = {},
): CategoryGroup[] {
  const taskGroups = groupByTask(items, tasks, options)

  const byCategory = new Map<CategoryId, TaskGroup[]>()
  for (const group of taskGroups) {
    const list = byCategory.get(group.category)
    if (list === undefined) byCategory.set(group.category, [group])
    else list.push(group)
  }

  // 分类顺序以 CATEGORIES 的声明顺序为准（对象字符串键保留插入顺序）
  const categoryOrder = Object.keys(CATEGORIES) as CategoryId[]
  const categories: CategoryGroup[] = []
  for (const category of categoryOrder) {
    const groups = byCategory.get(category)
    if (groups === undefined || groups.length === 0) continue

    let count = 0
    let bytes = 0
    let recommendCount = 0
    let recommendBytes = 0
    for (const group of groups) {
      count += group.count
      bytes += group.bytes
      recommendCount += group.recommendCount
      recommendBytes += group.recommendBytes
    }

    const meta = CATEGORIES[category]
    categories.push({
      category,
      name: meta.name,
      color: meta.color,
      count,
      bytes,
      recommendCount,
      recommendBytes,
      tasks: groups,
    })
  }
  return categories
}

/* ------------------------------------------------------------------ */
/* 筛选                                                                */
/* ------------------------------------------------------------------ */

/** 逐项明细视图的筛选条件（所有字段缺省 = 不过滤；`includeProtected` 缺省 = 排除受保护项） */
export interface ItemFilter {
  /** 搜索词：对 `title` / `path` / `note` 做大小写不敏感子串匹配；trim 后为空视为不过滤 */
  query?: string
  /** 限定任务；未传或空数组表示不限制任务 */
  taskIds?: readonly string[]
  /** 限定风险；未传或空数组表示全部风险 */
  risks?: readonly RiskLevel[]
  /** 体积下限（字节，含等于），默认 0 */
  minSize?: number
  /** 只保留默认推荐策略命中的项：`risk === 'safe' && !protected` */
  onlyRecommended?: boolean
  /** 只保留 `selected` 中的项；未传 `selected` 时结果为空 */
  onlySelected?: boolean
  /** 是否保留受路径策略保护的项，默认 false（默认排除） */
  includeProtected?: boolean
}

/**
 * 按界面筛选条件过滤清理项（逐项明细视图）。
 *
 * 语义：
 * - `query`：对 `title` / `path` / `note` 做大小写不敏感子串匹配；
 *   查询串先 trim，trim 后为空视为不过滤；
 * - `taskIds`：限定任务；未传或空数组表示不限制（与内核 scan 的约定一致）；
 * - `risks`：限定风险；未传或空数组表示全部风险；
 * - `minSize`：体积下限（字节，**含等于**），默认 0；
 * - `onlyRecommended`：只保留默认推荐策略命中的项（`safe` 且非 `protected`）；
 * - `onlySelected`：只保留 `selected` 中的项；未传 `selected` 时结果为空；
 * - `includeProtected`：默认 false，即默认排除受路径策略保护的项；true 时保留，
 *   但其它筛选条件仍然生效；
 * - 保持输入顺序（不排序、不修改入参，返回新数组）。
 */
export function filterItems(items: readonly CleanItem[], filter: ItemFilter, selected?: ReadonlySet<string>): CleanItem[] {
  const query = filter.query?.trim().toLowerCase() ?? ''
  const taskFilter = filter.taskIds !== undefined && filter.taskIds.length > 0 ? new Set(filter.taskIds) : undefined
  const riskFilter = filter.risks !== undefined && filter.risks.length > 0 ? new Set(filter.risks) : undefined
  const minSize = normalizeMinSize(filter.minSize)
  const includeProtected = filter.includeProtected === true
  const onlyRecommended = filter.onlyRecommended === true
  const onlySelected = filter.onlySelected === true

  const result: CleanItem[] = []
  for (const item of items) {
    if (!includeProtected && item.protected === true) continue
    if (taskFilter !== undefined && !taskFilter.has(item.taskId)) continue
    if (riskFilter !== undefined && !riskFilter.has(item.risk)) continue
    if (item.size < minSize) continue
    if (onlyRecommended && !isDefaultRecommended(item)) continue
    if (onlySelected && !(selected?.has(item.id) ?? false)) continue
    if (query !== '' && !matchesQuery(item, query)) continue
    result.push(item)
  }
  return result
}

/* ------------------------------------------------------------------ */
/* 排序                                                                */
/* ------------------------------------------------------------------ */

/** 支持排序的维度 */
export type ItemSort = 'size-desc' | 'size-asc' | 'name' | 'mtime-desc' | 'risk-desc'

/**
 * 按指定规则返回新的排序数组（稳定排序：同值保持输入顺序）。
 *
 * - `size-desc` / `size-asc`：按 `size` 降序 / 升序；
 * - `name`：按 `title` 的 UTF-16 码元序（与 locale 无关，跨环境一致）；
 * - `mtime-desc`：按 `mtimeMs` 降序；**没有 mtimeMs 的项排在最后**
 *   （缺失项之间保持输入顺序）；
 * - `risk-desc`：按风险降序（risky > caution > safe），同风险保持输入顺序。
 *
 * 不修改 `items`，返回新数组。
 */
export function sortItems(items: readonly CleanItem[], sort: ItemSort): CleanItem[] {
  switch (sort) {
    case 'size-desc':
      return stableSort(items, compareSizeDesc)
    case 'size-asc':
      return stableSort(items, compareSizeAsc)
    case 'name':
      return stableSort(items, (a, b) => compareText(a.title, b.title))
    case 'mtime-desc':
      return stableSort(items, (a, b) => {
        const aHas = a.mtimeMs !== undefined
        const bHas = b.mtimeMs !== undefined
        // 无 mtime 的项排最后（两者都缺失时保持输入顺序）
        if (!aHas && !bHas) return 0
        if (!aHas) return 1
        if (!bHas) return -1
        return (b.mtimeMs as number) - (a.mtimeMs as number)
      })
    case 'risk-desc':
      return stableSort(items, (a, b) => riskWeight(b.risk) - riskWeight(a.risk))
    default:
      return [...items]
  }
}

/**
 * 取 `size` 最大的前 N 项（按 size 降序返回；同 size 保持输入顺序）。
 *
 * - `n <= 0` 或非有限值 → `[]`；
 * - `n` 超过项数 → 返回全部项（仍按 size 降序）；
 * - `n` 为小数时向下取整。
 *
 * 不修改 `items`，返回新数组。
 */
export function topNBySize(items: readonly CleanItem[], n: number): CleanItem[] {
  if (!Number.isFinite(n) || n <= 0) return []
  const limit = Math.floor(n)
  if (limit <= 0) return []
  return stableSort(items, compareSizeDesc).slice(0, limit)
}

/* ------------------------------------------------------------------ */
/* 选中汇总                                                            */
/* ------------------------------------------------------------------ */

/** 选中项汇总（清理确认对话框、AI 上下文与底部状态栏共用） */
export interface SelectionSummary {
  /** 选中项数量 */
  count: number
  /** 选中项字节数合计 */
  bytes: number
  /** 各风险等级的数量与字节数（三个 key 恒存在，无数据时为 0） */
  byRisk: Record<RiskLevel, { count: number; bytes: number }>
  /** 按任务聚合（只含被选中项），按 bytes 降序；`risk` 为该任务选中项中的最高风险 */
  byTask: Array<{ taskId: string; name: string; count: number; bytes: number; risk: RiskLevel }>
  /** 需要提醒用户的数量：选中项中 caution + risky 的数量 */
  warnCount: number
  /** 选中项中 `risk === 'risky'` 的 id（按输入顺序） */
  riskyIds: string[]
}

/**
 * 汇总「当前被选中」的清理项。
 *
 * 语义：
 * - 只统计 `id` 位于 `selected` 中的项，其余忽略（`selected` 中不在 `items` 里的 id 也忽略）；
 * - `byRisk` 三个风险等级 key 恒存在，无数据时为 `{ count: 0, bytes: 0 }`；
 * - `byTask` 只含有选中项的任务：`name` 取自 TaskDescriptor（找不到时为 taskId），
 *   `risk` 为该任务选中项中的最高风险，按 `bytes` 降序（同 bytes 按 taskId 升序）；
 * - `warnCount` 为选中项中 `caution` 与 `risky` 的数量之和；
 * - `riskyIds` 为选中项中 `risk === 'risky'` 的 id，按输入顺序。
 *
 * 纯函数：不修改 `items` / `selected` / `tasks`。
 */
export function summarizeSelection(
  items: readonly CleanItem[],
  selected: ReadonlySet<string>,
  tasks: readonly TaskDescriptor[],
): SelectionSummary {
  const taskIndex = indexTasks(tasks)
  const byRisk: Record<RiskLevel, { count: number; bytes: number }> = {
    safe: { count: 0, bytes: 0 },
    caution: { count: 0, bytes: 0 },
    risky: { count: 0, bytes: 0 },
  }
  const taskBuckets = new Map<string, { taskId: string; name: string; count: number; bytes: number; risk: RiskLevel }>()

  let count = 0
  let bytes = 0
  let warnCount = 0
  const riskyIds: string[] = []

  for (const item of items) {
    if (!selected.has(item.id)) continue

    count++
    bytes += item.size
    const riskBucket = byRisk[item.risk]
    riskBucket.count++
    riskBucket.bytes += item.size
    if (item.risk !== 'safe') warnCount++
    if (item.risk === 'risky') riskyIds.push(item.id)

    let taskBucket = taskBuckets.get(item.taskId)
    if (taskBucket === undefined) {
      taskBucket = {
        taskId: item.taskId,
        name: taskIndex.get(item.taskId)?.name ?? item.taskId,
        count: 0,
        bytes: 0,
        risk: 'safe',
      }
      taskBuckets.set(item.taskId, taskBucket)
    }
    taskBucket.count++
    taskBucket.bytes += item.size
    if (riskWeight(item.risk) > riskWeight(taskBucket.risk)) taskBucket.risk = item.risk
  }

  const byTask = [...taskBuckets.values()].sort(
    (a, b) => b.bytes - a.bytes || compareText(a.taskId, b.taskId),
  )

  return { count, bytes, byRisk, byTask, warnCount, riskyIds }
}
