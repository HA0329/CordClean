/**
 * 共享选择逻辑（packages/shared/src/selection.ts）单元测试。
 *
 * 覆盖：推荐策略、三态选择、任务/分类分组、筛选、排序、TopN、选中汇总，
 * 以及 2,400+ 条确定性夹具上的聚合一致性与 5,000 条数据的性能断言。
 * 只依赖 @cordclean/shared（纯函数），不启动内核、不访问文件系统。
 */
import { describe, expect, it } from 'vitest'
import {
  CATEGORIES,
  RISK_META,
  filterItems,
  groupByCategory,
  groupByTask,
  recommendIds,
  selectionState,
  sortItems,
  summarizeSelection,
  topNBySize,
  type CategoryId,
  type CleanItem,
  type RiskLevel,
  type TaskDescriptor,
} from '@cordclean/shared'

/* ------------------------------------------------------------------ */
/* 测试夹具工具                                                        */
/* ------------------------------------------------------------------ */

const CATEGORY_LIST = Object.keys(CATEGORIES) as CategoryId[]

/** 构造 TaskDescriptor（字段齐全且可覆盖） */
function makeTask(id: string, patch: Partial<TaskDescriptor> = {}): TaskDescriptor {
  return {
    id,
    pluginId: 'fixture-plugin',
    name: `任务 ${id}`,
    category: 'system',
    risk: 'safe',
    defaultSelected: false,
    targets: [],
    tips: [],
    ...patch,
  }
}

/** 构造 CleanItem（字段齐全且可覆盖） */
function makeItem(id: string, patch: Partial<CleanItem> = {}): CleanItem {
  return {
    id,
    taskId: 'task-a',
    title: id,
    path: `C:\\fixture\\${id}`,
    kind: 'file',
    size: 100,
    risk: 'safe',
    category: 'system',
    defaultSelected: false,
    ...patch,
  }
}

/** mulberry32：确定性伪随机数（同一 seed 在任何 JS 引擎上序列相同） */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const FIXTURE_SEED = 0x5eedc0de
const FIXTURE_BASE_MTIME = 1_700_000_000_000

/**
 * 生成确定性的大规模夹具：
 * - 默认 2,436 条项、36 个任务（覆盖 8 个分类、三种风险、约 40 条 protected）；
 * - size 量化到 100KB × 0..499 共 500 个档位，人为制造大量同 size 项，便于验证稳定排序；
 * - 约 1/7 的项没有 mtimeMs、约 1/5 的项没有 note，覆盖可选字段缺失的边界。
 */
function createLargeFixture(
  itemCount = 2_436,
  taskCount = 36,
): { items: CleanItem[]; tasks: TaskDescriptor[] } {
  const random = mulberry32(FIXTURE_SEED)

  const tasks: TaskDescriptor[] = []
  for (let index = 0; index < taskCount; index++) {
    const category = CATEGORY_LIST[index % CATEGORY_LIST.length]!
    tasks.push(
      makeTask(`task-${String(index).padStart(2, '0')}`, {
        name: `清理任务 ${index}`,
        category,
        risk: index % 9 === 0 ? 'risky' : index % 4 === 0 ? 'caution' : 'safe',
        icon: index % 5 === 0 ? '🧪' : undefined,
        defaultSelected: index % 3 === 0,
        targets: [`C:\\fixture\\task-${index}`],
      }),
    )
  }

  const items: CleanItem[] = []
  for (let index = 0; index < itemCount; index++) {
    const task = tasks[index % tasks.length]!
    const roll = random()
    const risk: RiskLevel = roll < 0.55 ? 'safe' : roll < 0.85 ? 'caution' : 'risky'
    const protectedItem = index % 61 === 0
    const size = 100_000 * Math.floor(random() * 500)
    const item: CleanItem = {
      id: `item-${String(index).padStart(4, '0')}`,
      taskId: task.id,
      title: `${task.name} 缓存文件 ${index}`,
      path: `C:\\fixture\\${task.id}\\cache-${index}.tmp`,
      kind: index % 3 === 0 ? 'directory' : 'file',
      size,
      risk,
      category: task.category,
      defaultSelected: risk === 'safe' && !protectedItem,
    }
    if (index % 7 !== 0) item.mtimeMs = FIXTURE_BASE_MTIME - index * 60_000
    if (index % 5 !== 0) item.note = `规则说明 ${index}：缓存可安全重建`
    if (protectedItem) item.protected = true
    items.push(item)
  }

  return { items, tasks }
}

/** 建立 id → CleanItem 索引 */
function indexItems(items: readonly CleanItem[]): Map<string, CleanItem> {
  return new Map(items.map((item) => [item.id, item] as [string, CleanItem]))
}

/** 建立任务 id → TaskDescriptor 索引 */
function indexTaskDescriptors(tasks: readonly TaskDescriptor[]): Map<string, TaskDescriptor> {
  return new Map(tasks.map((task) => [task.id, task] as [string, TaskDescriptor]))
}

/** 记录项在输入数组中的位置（用于验证稳定排序） */
function indexOfItem(items: readonly CleanItem[]): Map<string, number> {
  return new Map(items.map((item, index) => [item.id, index] as [string, number]))
}

/* ------------------------------------------------------------------ */
/* 大规模夹具本身                                                      */
/* ------------------------------------------------------------------ */

describe('确定性大规模夹具', () => {
  const { items, tasks } = createLargeFixture()

  it('规模与覆盖满足要求（2400+ 条、30+ 任务、三种风险、protected、缺失可选字段）', () => {
    expect(items.length).toBe(2_436)
    expect(items.length).toBeGreaterThanOrEqual(2_400)
    expect(new Set(items.map((item) => item.taskId)).size).toBeGreaterThanOrEqual(30)
    expect(tasks.length).toBe(36)
    expect(new Set(items.map((item) => item.risk))).toEqual(new Set(['safe', 'caution', 'risky']))
    expect(items.filter((item) => item.protected === true).length).toBeGreaterThan(0)
    expect(items.some((item) => item.mtimeMs === undefined)).toBe(true)
    expect(items.some((item) => item.note === undefined)).toBe(true)
    expect(items.every((item) => item.id.length > 0 && item.taskId.length > 0)).toBe(true)
  })

  it('相同 seed 两次生成结果完全一致', () => {
    const first = createLargeFixture()
    const second = createLargeFixture()
    expect(first.items).toEqual(second.items)
    expect(first.tasks).toEqual(second.tasks)
  })
})

/* ------------------------------------------------------------------ */
/* recommendIds                                                        */
/* ------------------------------------------------------------------ */

describe('recommendIds 推荐策略', () => {
  it('默认只推荐 safe 且非 protected 的项', () => {
    const items = [
      makeItem('safe-ok'),
      makeItem('safe-protected', { protected: true }),
      makeItem('caution-1', { risk: 'caution' }),
      makeItem('risky-1', { risk: 'risky' }),
    ]
    expect(recommendIds(items)).toEqual(['safe-ok'])
  })

  it('recommended=false 的 safe 项不进入默认推荐（空目录/整体临时目录等）', () => {
    const items = [
      makeItem('safe-normal'),
      makeItem('safe-no-recommend', { recommended: false }),
      makeItem('safe-explicit', { recommended: true }),
      makeItem('caution-no-recommend', { risk: 'caution', recommended: false }),
    ]
    expect(recommendIds(items)).toEqual(['safe-explicit', 'safe-normal'])
  })

  it('includeCaution=true 纳入 caution，但永远排除 risky 与 protected', () => {
    const items = [
      makeItem('safe-ok'),
      makeItem('safe-protected', { protected: true }),
      makeItem('caution-1', { risk: 'caution' }),
      makeItem('caution-protected', { risk: 'caution', protected: true }),
      makeItem('risky-1', { risk: 'risky' }),
    ]
    const picked = recommendIds(items, { includeCaution: true })
    expect(picked).toEqual(['caution-1', 'safe-ok'])
    expect(picked).not.toContain('risky-1')
    expect(picked).not.toContain('safe-protected')
    expect(picked).not.toContain('caution-protected')
  })

  it('minSize 为下限且含等于', () => {
    const items = [makeItem('small', { size: 999 }), makeItem('edge', { size: 1_000 }), makeItem('big', { size: 1_001 })]
    expect(recommendIds(items, { minSize: 1_000 })).toEqual(['big', 'edge'])
    expect(recommendIds(items, { minSize: 1_002 })).toEqual([])
  })

  it('taskIds 限定任务；空数组按仓库约定视为“不限制”', () => {
    const items = [
      makeItem('t1-a', { taskId: 't1', size: 1 }),
      makeItem('t2-a', { taskId: 't2', size: 2 }),
      makeItem('t2-b', { taskId: 't2', size: 3 }),
    ]
    expect(recommendIds(items, { taskIds: ['t2'] })).toEqual(['t2-b', 't2-a'])
    expect(recommendIds(items, { taskIds: [] })).toEqual(['t2-b', 't2-a', 't1-a'])
    expect(recommendIds(items, { taskIds: ['missing-task'] })).toEqual([])
  })

  it('按 size 降序返回，同 size 按 id 升序（确定顺序）', () => {
    const items = [
      makeItem('b', { size: 100 }),
      makeItem('a', { size: 100 }),
      makeItem('c', { size: 200 }),
      makeItem('d', { size: 50 }),
    ]
    expect(recommendIds(items)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('空输入返回空数组，且不修改入参', () => {
    expect(recommendIds([])).toEqual([])
    const items = [makeItem('z', { size: 1 }), makeItem('y', { size: 2 })]
    const before = items.map((item) => item.id)
    recommendIds(items)
    expect(items.map((item) => item.id)).toEqual(before)
  })
})

/* ------------------------------------------------------------------ */
/* selectionState                                                      */
/* ------------------------------------------------------------------ */

describe('selectionState 三态', () => {
  it('空 ids → none；全部选中 → all；部分 → partial；一个未选 → none', () => {
    expect(selectionState([], new Set())).toBe('none')
    expect(selectionState([], new Set(['x']))).toBe('none')
    expect(selectionState(['a'], new Set())).toBe('none')
    expect(selectionState(['a', 'b'], new Set(['a', 'b']))).toBe('all')
    expect(selectionState(['a', 'b'], new Set(['a']))).toBe('partial')
    expect(selectionState(['a', 'b'], new Set(['b']))).toBe('partial')
  })

  it('忽略 selected 中的无关 id（多余选择不影响本组三态）', () => {
    expect(selectionState(['a', 'b'], new Set(['a', 'b', 'c', 'd']))).toBe('all')
    expect(selectionState(['a', 'b'], new Set(['c']))).toBe('none')
  })

  it('可与分组 ids 组合使用（整组勾选的三态来源）', () => {
    const group = groupByTask(makeItemScenario().items, makeItemScenario().tasks)[0]!
    expect(selectionState(group.ids, new Set(group.ids))).toBe('all')
    expect(selectionState(group.ids, new Set([group.ids[0]!]))).toBe('partial')
    expect(selectionState(group.ids, new Set())).toBe('none')
  })
})

/* ------------------------------------------------------------------ */
/* 任务 / 分类分组的小型场景                                            */
/* ------------------------------------------------------------------ */

const makeTaskScenario = () => ({
  tasks: [
    makeTask('task-a', { name: '系统任务 A', category: 'system', icon: '🧪' }),
    makeTask('task-sys2', { name: '系统任务 B', category: 'system' }),
    makeTask('task-b', { name: '浏览器任务 B', category: 'browser', icon: '🌐' }),
  ],
  items: [
    makeItem('a1', { taskId: 'task-a', size: 300 }),
    makeItem('a2', { taskId: 'task-a', size: 100, risk: 'risky' }),
    makeItem('s1', { taskId: 'task-sys2', size: 200, risk: 'caution' }),
    makeItem('b1', { taskId: 'task-b', size: 500, risk: 'caution', category: 'browser' }),
    makeItem('b2', { taskId: 'task-b', size: 200, protected: true, category: 'browser' }),
    makeItem('m1', { taskId: 'task-missing', size: 400, risk: 'caution', category: 'dev' }),
    makeItem('m2', { taskId: 'task-missing', size: 50, category: 'dev' }),
  ],
})

const makeItemScenario = makeTaskScenario

/* ------------------------------------------------------------------ */
/* groupByTask                                                         */
/* ------------------------------------------------------------------ */

describe('groupByTask 任务分组', () => {
  const { items, tasks } = makeTaskScenario()

  it('按 taskId 分组、组间按 bytes 降序、同 bytes 按 taskId 升序', () => {
    const groups = groupByTask(items, tasks)
    expect(groups.map((group) => group.taskId)).toEqual(['task-b', 'task-missing', 'task-a', 'task-sys2'])
  })

  it('组内按 size 降序，ids / samples 基于该顺序', () => {
    const groups = groupByTask(items, tasks)
    const byTask = new Map(groups.map((group) => [group.taskId, group]))
    expect(byTask.get('task-a')!.ids).toEqual(['a1', 'a2'])
    expect(byTask.get('task-b')!.ids).toEqual(['b1', 'b2'])
    expect(byTask.get('task-missing')!.ids).toEqual(['m1', 'm2'])
    expect(byTask.get('task-a')!.samples.map((item) => item.id)).toEqual(['a1', 'a2'])
  })

  it('count / bytes / protectedCount 覆盖组内全部项，risk 取组内最高', () => {
    const groups = groupByTask(items, tasks)
    const byTask = new Map(groups.map((group) => [group.taskId, group]))

    expect(byTask.get('task-a')).toMatchObject({
      name: '系统任务 A',
      icon: '🧪',
      category: 'system',
      risk: 'risky',
      count: 2,
      bytes: 400,
      protectedCount: 0,
    })
    expect(byTask.get('task-b')).toMatchObject({
      name: '浏览器任务 B',
      icon: '🌐',
      category: 'browser',
      risk: 'caution',
      count: 2,
      bytes: 700,
      protectedCount: 1,
    })
    expect(byTask.get('task-sys2')).toMatchObject({ risk: 'caution', count: 1, bytes: 200, protectedCount: 0 })
  })

  it('未知任务回退：name=taskId、icon=undefined、category=组内首项 category', () => {
    const groups = groupByTask(items, tasks)
    const missing = groups.find((group) => group.taskId === 'task-missing')!
    expect(missing.name).toBe('task-missing')
    expect(missing.icon).toBeUndefined()
    expect(missing.category).toBe('dev')
    expect(missing.risk).toBe('caution')
    expect(missing.count).toBe(2)
    expect(missing.bytes).toBe(450)
  })

  it('recommendCount / recommendBytes 按 recommend 选项计算（默认安全策略）', () => {
    const groups = groupByTask(items, tasks)
    const byTask = new Map(groups.map((group) => [group.taskId, group]))
    // 默认：safe 且非 protected（a1 300B、m2 50B；b1 是 caution、b2 受保护）
    expect(byTask.get('task-a')).toMatchObject({ recommendCount: 1, recommendBytes: 300 })
    expect(byTask.get('task-missing')).toMatchObject({ recommendCount: 1, recommendBytes: 50 })
    expect(byTask.get('task-b')).toMatchObject({ recommendCount: 0, recommendBytes: 0 })
    expect(byTask.get('task-sys2')).toMatchObject({ recommendCount: 0, recommendBytes: 0 })
  })

  it('recommend 选项 includeCaution / minSize / taskIds 生效', () => {
    const withCaution = new Map(
      groupByTask(items, tasks, { recommend: { includeCaution: true } }).map((group) => [group.taskId, group]),
    )
    expect(withCaution.get('task-b')).toMatchObject({ recommendCount: 1, recommendBytes: 500 })
    expect(withCaution.get('task-missing')).toMatchObject({ recommendCount: 2, recommendBytes: 450 })
    expect(withCaution.get('task-sys2')).toMatchObject({ recommendCount: 1, recommendBytes: 200 })

    const withMinSize = new Map(
      groupByTask(items, tasks, { recommend: { minSize: 100 } }).map((group) => [group.taskId, group]),
    )
    expect(withMinSize.get('task-a')).toMatchObject({ recommendCount: 1, recommendBytes: 300 })
    expect(withMinSize.get('task-missing')).toMatchObject({ recommendCount: 0, recommendBytes: 0 })
    expect(withMinSize.get('task-sys2')).toMatchObject({ recommendCount: 0, recommendBytes: 0 })

    const scoped = new Map(
      groupByTask(items, tasks, { recommend: { taskIds: ['task-missing'] } }).map((group) => [group.taskId, group]),
    )
    expect(scoped.get('task-missing')).toMatchObject({ recommendCount: 1, recommendBytes: 50 })
    expect(scoped.get('task-a')).toMatchObject({ recommendCount: 0, recommendBytes: 0 })
  })

  it('samples 取前 sampleLimit 大项，默认 3 且可配 0 / 超过组大小', () => {
    const cTasks = [makeTask('task-c', { name: '任务 C', category: 'apps' })]
    const cItems = [
      makeItem('c1', { taskId: 'task-c', size: 10 }),
      makeItem('c2', { taskId: 'task-c', size: 40 }),
      makeItem('c3', { taskId: 'task-c', size: 30 }),
      makeItem('c4', { taskId: 'task-c', size: 20 }),
    ]
    const defaultGroup = groupByTask(cItems, cTasks)[0]!
    expect(defaultGroup.samples.map((item) => item.id)).toEqual(['c2', 'c3', 'c4'])
    expect(defaultGroup.ids).toEqual(['c2', 'c3', 'c4', 'c1'])
    expect(groupByTask(cItems, cTasks, { sampleLimit: 1 })[0]!.samples.map((item) => item.id)).toEqual(['c2'])
    expect(groupByTask(cItems, cTasks, { sampleLimit: 0 })[0]!.samples).toEqual([])
    expect(groupByTask(cItems, cTasks, { sampleLimit: 10 })[0]!.samples).toHaveLength(4)
  })

  it('bytes 相同的组按 taskId 升序（未知任务也能稳定排序）', () => {
    const tieItems = [
      makeItem('y1', { taskId: 'task-y', size: 100 }),
      makeItem('x1', { taskId: 'task-x', size: 100 }),
    ]
    expect(groupByTask(tieItems, []).map((group) => group.taskId)).toEqual(['task-x', 'task-y'])
  })

  it('空输入返回 []，且不修改入参顺序', () => {
    expect(groupByTask([], [])).toEqual([])
    const before = items.map((item) => item.id)
    groupByTask(items, tasks)
    expect(items.map((item) => item.id)).toEqual(before)
  })
})

/* ------------------------------------------------------------------ */
/* groupByCategory                                                     */
/* ------------------------------------------------------------------ */

describe('groupByCategory 分类分组', () => {
  const { items, tasks } = makeTaskScenario()

  it('只输出有数据的分类，顺序按 CATEGORIES 声明顺序，name/color 取自 CATEGORIES', () => {
    const categories = groupByCategory(items, tasks)
    expect(categories.map((category) => category.category)).toEqual(['system', 'browser', 'dev'])
    for (const category of categories) {
      expect(category.name).toBe(CATEGORIES[category.category].name)
      expect(category.color).toBe(CATEGORIES[category.category].color)
    }
  })

  it('分类内 tasks 按 bytes 降序，count/bytes/recommend* 为组求和', () => {
    const categories = groupByCategory(items, tasks)
    const byCategory = new Map(categories.map((category) => [category.category, category]))

    const system = byCategory.get('system')!
    expect(system.tasks.map((group) => group.taskId)).toEqual(['task-a', 'task-sys2'])
    expect(system.count).toBe(3)
    expect(system.bytes).toBe(600)
    expect(system.recommendCount).toBe(1)
    expect(system.recommendBytes).toBe(300)

    const browser = byCategory.get('browser')!
    expect(browser.count).toBe(2)
    expect(browser.bytes).toBe(700)
    expect(browser.recommendCount).toBe(0)
    expect(browser.recommendBytes).toBe(0)

    const dev = byCategory.get('dev')!
    expect(dev.tasks).toHaveLength(1)
    expect(dev.tasks[0]!.name).toBe('task-missing')
    expect(dev.count).toBe(2)
    expect(dev.bytes).toBe(450)
    expect(dev.recommendCount).toBe(1)
    expect(dev.recommendBytes).toBe(50)
  })

  it('分类求和恒等于其任务分组求和', () => {
    for (const category of groupByCategory(items, tasks)) {
      expect(category.count).toBe(category.tasks.reduce((sum, group) => sum + group.count, 0))
      expect(category.bytes).toBe(category.tasks.reduce((sum, group) => sum + group.bytes, 0))
      expect(category.recommendCount).toBe(category.tasks.reduce((sum, group) => sum + group.recommendCount, 0))
      expect(category.recommendBytes).toBe(category.tasks.reduce((sum, group) => sum + group.recommendBytes, 0))
      expect(category.tasks.every((group) => group.category === category.category)).toBe(true)
    }
  })

  it('recommend 选项会透传到任务分组；空输入返回 []', () => {
    const categories = groupByCategory(items, tasks, { recommend: { includeCaution: true } })
    const browser = categories.find((category) => category.category === 'browser')!
    expect(browser.recommendCount).toBe(1)
    expect(browser.recommendBytes).toBe(500)
    expect(groupByCategory([], [])).toEqual([])
  })
})

/* ------------------------------------------------------------------ */
/* filterItems                                                         */
/* ------------------------------------------------------------------ */

describe('filterItems 筛选', () => {
  const items: CleanItem[] = [
    makeItem('alpha-safe', {
      taskId: 't1',
      title: 'Alpha Cache',
      path: 'C:\\data\\Alpha.bin',
      note: '安全缓存，可安全重建',
      size: 100,
    }),
    makeItem('beta-risky', {
      taskId: 't2',
      title: 'Beta Database',
      path: 'D:\\beta\\history.db',
      note: '高风险数据库，删除前请确认',
      size: 500,
      risk: 'risky',
    }),
    makeItem('gamma-caution', {
      taskId: 't1',
      title: 'Gamma Log',
      path: 'C:\\logs\\gamma.log',
      note: '谨慎：可能仍在使用',
      size: 200,
      risk: 'caution',
    }),
    makeItem('protected-one', {
      taskId: 't3',
      title: 'Protected System',
      path: 'C:\\Windows\\system.ini',
      note: undefined,
      size: 1_000,
      protected: true,
    }),
    makeItem('delta-safe', { taskId: 't2', title: 'Delta Temp', path: 'C:\\temp\\delta.tmp', size: 50 }),
  ]

  it('默认排除 protected，保持输入顺序', () => {
    expect(filterItems(items, {}).map((item) => item.id)).toEqual([
      'alpha-safe',
      'beta-risky',
      'gamma-caution',
      'delta-safe',
    ])
  })

  it('includeProtected=true 时保留受保护项（其它条件仍生效）', () => {
    expect(filterItems(items, { includeProtected: true }).map((item) => item.id)).toHaveLength(5)
    expect(filterItems(items, { includeProtected: true, taskIds: ['t3'] }).map((item) => item.id)).toEqual([
      'protected-one',
    ])
  })

  it('query 对 title/path/note 做大小写不敏感子串匹配，trim 后为空不过滤', () => {
    expect(filterItems(items, { query: 'alpha' }).map((item) => item.id)).toEqual(['alpha-safe'])
    expect(filterItems(items, { query: 'GAMMA' }).map((item) => item.id)).toEqual(['gamma-caution'])
    expect(filterItems(items, { query: '安全' }).map((item) => item.id)).toEqual(['alpha-safe'])
    expect(filterItems(items, { query: '  alpha  ' }).map((item) => item.id)).toEqual(['alpha-safe'])
    expect(filterItems(items, { query: '不存在的内容' })).toEqual([])
    expect(filterItems(items, { query: '   ' }).map((item) => item.id)).toHaveLength(4)
  })

  it('taskIds 限定任务；空数组视为不限制', () => {
    expect(filterItems(items, { taskIds: ['t1'] }).map((item) => item.id)).toEqual(['alpha-safe', 'gamma-caution'])
    expect(filterItems(items, { taskIds: [] }).map((item) => item.id)).toHaveLength(4)
    expect(filterItems(items, { taskIds: ['missing'] })).toEqual([])
  })

  it('risks 限定风险；空数组=全部', () => {
    expect(filterItems(items, { risks: ['risky'] }).map((item) => item.id)).toEqual(['beta-risky'])
    expect(filterItems(items, { risks: ['safe'] }).map((item) => item.id)).toEqual(['alpha-safe', 'delta-safe'])
    expect(filterItems(items, { risks: [] }).map((item) => item.id)).toHaveLength(4)
  })

  it('minSize 为下限且含等于', () => {
    expect(filterItems(items, { minSize: 200 }).map((item) => item.id)).toEqual(['beta-risky', 'gamma-caution'])
    expect(filterItems(items, { minSize: 1_000 }).map((item) => item.id)).toEqual([])
    expect(filterItems(items, { minSize: 1_000, includeProtected: true }).map((item) => item.id)).toEqual([
      'protected-one',
    ])
  })

  it('onlyRecommended 使用默认安全策略（safe && !protected）', () => {
    expect(filterItems(items, { onlyRecommended: true }).map((item) => item.id)).toEqual(['alpha-safe', 'delta-safe'])
  })

  it('onlySelected 只保留选中项；未传 selected 时结果为空', () => {
    const selected = new Set(['beta-risky', 'gamma-caution'])
    expect(filterItems(items, { onlySelected: true }, selected).map((item) => item.id)).toEqual([
      'beta-risky',
      'gamma-caution',
    ])
    expect(filterItems(items, { onlySelected: true })).toEqual([])
  })

  it('组合筛选：query + taskIds + risks + minSize 同时生效', () => {
    expect(
      filterItems(items, { query: 'a', taskIds: ['t1'], risks: ['caution'], minSize: 200 }).map((item) => item.id),
    ).toEqual(['gamma-caution'])
    expect(filterItems(items, { query: '安全', risks: ['safe'], minSize: 50 }).map((item) => item.id)).toEqual([
      'alpha-safe',
    ])
  })

  it('返回新数组且不修改入参；空输入返回 []', () => {
    const snapshot = items.map((item) => item.id)
    const result = filterItems(items, {})
    expect(result).not.toBe(items)
    expect(items.map((item) => item.id)).toEqual(snapshot)
    expect(filterItems([], {})).toEqual([])
  })
})

/* ------------------------------------------------------------------ */
/* sortItems                                                           */
/* ------------------------------------------------------------------ */

describe('sortItems 排序', () => {
  const makeSortItems = (): CleanItem[] => [
    makeItem('s1', { size: 300, title: 'b', mtimeMs: 3_000, risk: 'safe' }),
    makeItem('s2', { size: 100, title: 'a', mtimeMs: 1_000, risk: 'risky' }),
    makeItem('s3', { size: 200, title: 'c', mtimeMs: 2_000, risk: 'caution' }),
    makeItem('s4', { size: 200, title: 'd', risk: 'safe' }),
    makeItem('s5', { size: 100, title: 'e', mtimeMs: 5_000, risk: 'safe' }),
    makeItem('s6', { size: 400, title: 'f', risk: 'safe' }),
  ]

  it('size-desc / size-asc 稳定（同 size 保持输入顺序）', () => {
    const items = makeSortItems()
    expect(sortItems(items, 'size-desc').map((item) => item.id)).toEqual(['s6', 's1', 's3', 's4', 's2', 's5'])
    expect(sortItems(items, 'size-asc').map((item) => item.id)).toEqual(['s2', 's5', 's3', 's4', 's1', 's6'])
  })

  it('name 按 title 排序', () => {
    expect(sortItems(makeSortItems(), 'name').map((item) => item.id)).toEqual([
      's2',
      's1',
      's3',
      's4',
      's5',
      's6',
    ])
  })

  it('mtime-desc 按修改时间降序，无 mtime 的排最后（缺失项保持输入顺序）', () => {
    expect(sortItems(makeSortItems(), 'mtime-desc').map((item) => item.id)).toEqual([
      's5',
      's1',
      's3',
      's2',
      's4',
      's6',
    ])
  })

  it('risk-desc 按 risky > caution > safe，同风险保持输入顺序', () => {
    expect(sortItems(makeSortItems(), 'risk-desc').map((item) => item.id)).toEqual([
      's2',
      's3',
      's1',
      's4',
      's5',
      's6',
    ])
  })

  it('返回新数组、不修改入参；空输入返回 []', () => {
    const items = makeSortItems()
    const snapshot = items.map((item) => item.id)
    const sorted = sortItems(items, 'size-desc')
    expect(sorted).not.toBe(items)
    expect(items.map((item) => item.id)).toEqual(snapshot)
    expect(sortItems([], 'size-desc')).toEqual([])
  })
})

/* ------------------------------------------------------------------ */
/* topNBySize                                                          */
/* ------------------------------------------------------------------ */

describe('topNBySize', () => {
  const makeSized = (): CleanItem[] => [
    makeItem('a', { size: 100 }),
    makeItem('b', { size: 300 }),
    makeItem('c', { size: 200 }),
    makeItem('d', { size: 200 }),
  ]

  it('取 size 最大的前 N 项，同 size 保持输入顺序', () => {
    expect(topNBySize(makeSized(), 2).map((item) => item.id)).toEqual(['b', 'c'])
    expect(topNBySize(makeSized(), 10).map((item) => item.id)).toEqual(['b', 'c', 'd', 'a'])
    expect(topNBySize(makeSized(), 1.9).map((item) => item.id)).toEqual(['b'])
  })

  it('n<=0 或非有限值返回 []；不修改入参', () => {
    expect(topNBySize(makeSized(), 0)).toEqual([])
    expect(topNBySize(makeSized(), -3)).toEqual([])
    expect(topNBySize(makeSized(), Number.NaN)).toEqual([])
    expect(topNBySize([], 5)).toEqual([])
    const items = makeSized()
    const snapshot = items.map((item) => item.id)
    topNBySize(items, 2)
    expect(items.map((item) => item.id)).toEqual(snapshot)
  })
})

/* ------------------------------------------------------------------ */
/* summarizeSelection                                                  */
/* ------------------------------------------------------------------ */

describe('summarizeSelection 选中汇总', () => {
  const tasks = [makeTask('task-a', { name: '任务 A' }), makeTask('task-b', { name: '任务 B' })]
  const items: CleanItem[] = [
    makeItem('a1', { taskId: 'task-a', size: 100 }),
    makeItem('a2', { taskId: 'task-a', size: 300, risk: 'risky' }),
    makeItem('a3', { taskId: 'task-a', size: 200, risk: 'caution' }),
    makeItem('b1', { taskId: 'task-b', size: 400, risk: 'caution' }),
    makeItem('b2', { taskId: 'task-b', size: 50 }),
    makeItem('x1', { taskId: 'task-x', size: 500, risk: 'risky' }),
    makeItem('unselected', { taskId: 'task-a', size: 999 }),
  ]
  const selected = new Set(['a1', 'a2', 'a3', 'b1', 'x1'])

  it('只统计 selected 中的项，count / bytes 正确', () => {
    const summary = summarizeSelection(items, selected, tasks)
    expect(summary.count).toBe(5)
    expect(summary.bytes).toBe(1_500)
  })

  it('byRisk 三个等级 key 恒存在且分组合计正确', () => {
    const summary = summarizeSelection(items, selected, tasks)
    expect(Object.keys(summary.byRisk).sort()).toEqual(['caution', 'risky', 'safe'])
    expect(summary.byRisk.safe).toEqual({ count: 1, bytes: 100 })
    expect(summary.byRisk.caution).toEqual({ count: 2, bytes: 600 })
    expect(summary.byRisk.risky).toEqual({ count: 2, bytes: 800 })
    expect(summary.byRisk.safe.count + summary.byRisk.caution.count + summary.byRisk.risky.count).toBe(5)
  })

  it('byTask 按 bytes 降序，name 取 TaskDescriptor（未知任务回退 taskId），risk 取任务内最高', () => {
    const summary = summarizeSelection(items, selected, tasks)
    expect(summary.byTask.map((task) => task.taskId)).toEqual(['task-a', 'task-x', 'task-b'])
    expect(summary.byTask[0]).toEqual({ taskId: 'task-a', name: '任务 A', count: 3, bytes: 600, risk: 'risky' })
    expect(summary.byTask[1]).toEqual({ taskId: 'task-x', name: 'task-x', count: 1, bytes: 500, risk: 'risky' })
    expect(summary.byTask[2]).toEqual({ taskId: 'task-b', name: '任务 B', count: 1, bytes: 400, risk: 'caution' })
  })

  it('byTask 同 bytes 时按 taskId 升序', () => {
    const tieItems = [
      makeItem('i1', { taskId: 'task-y', size: 100 }),
      makeItem('i2', { taskId: 'task-x', size: 100 }),
    ]
    const summary = summarizeSelection(tieItems, new Set(['i1', 'i2']), [])
    expect(summary.byTask.map((task) => task.taskId)).toEqual(['task-x', 'task-y'])
  })

  it('warnCount = caution + risky 数量；riskyIds 为 risky 项 id（输入顺序）', () => {
    const summary = summarizeSelection(items, selected, tasks)
    expect(summary.warnCount).toBe(4)
    expect(summary.riskyIds).toEqual(['a2', 'x1'])
  })

  it('空选择 / 未命中项：零值汇总且 byRisk 仍有三个 key', () => {
    const summary = summarizeSelection(items, new Set(), tasks)
    expect(summary).toEqual({
      count: 0,
      bytes: 0,
      byRisk: { safe: { count: 0, bytes: 0 }, caution: { count: 0, bytes: 0 }, risky: { count: 0, bytes: 0 } },
      byTask: [],
      warnCount: 0,
      riskyIds: [],
    })
    const stale = summarizeSelection(items, new Set(['a1', 'ghost-id']), tasks)
    expect(stale.count).toBe(1)
    expect(stale.bytes).toBe(100)
  })

  it('全为 safe 时 byRisk 的 caution/risky 也返回 0；不修改入参', () => {
    const safeItems = [makeItem('safe-1', { size: 10 }), makeItem('safe-2', { size: 20 })]
    const snapshot = safeItems.map((item) => item.id)
    const summary = summarizeSelection(safeItems, new Set(['safe-1', 'safe-2']), tasks)
    expect(summary.byRisk.caution).toEqual({ count: 0, bytes: 0 })
    expect(summary.byRisk.risky).toEqual({ count: 0, bytes: 0 })
    expect(summary.warnCount).toBe(0)
    expect(summary.riskyIds).toEqual([])
    expect(safeItems.map((item) => item.id)).toEqual(snapshot)
  })
})

/* ------------------------------------------------------------------ */
/* 大规模数据上的聚合一致性                                            */
/* ------------------------------------------------------------------ */

describe('大规模夹具上的聚合一致性', () => {
  const { items, tasks } = createLargeFixture()
  const itemById = indexItems(items)
  const taskById = indexTaskDescriptors(tasks)
  const totalBytes = items.reduce((sum, item) => sum + item.size, 0)

  it('groupByTask：计数/字节守恒、组间与组内排序正确、推荐与保护统计正确', () => {
    const groups = groupByTask(items, tasks)
    const recommended = new Set(recommendIds(items))

    expect(groups.length).toBe(new Set(items.map((item) => item.taskId)).size)
    expect(groups.reduce((sum, group) => sum + group.count, 0)).toBe(items.length)
    expect(groups.reduce((sum, group) => sum + group.bytes, 0)).toBe(totalBytes)

    for (let index = 0; index < groups.length - 1; index++) {
      const current = groups[index]!
      const next = groups[index + 1]!
      expect(current.bytes).toBeGreaterThanOrEqual(next.bytes)
      if (current.bytes === next.bytes) expect(current.taskId < next.taskId).toBe(true)
    }

    for (const group of groups) {
      const descriptor = taskById.get(group.taskId)!
      expect(group.name).toBe(descriptor.name)
      expect(group.category).toBe(descriptor.category)
      expect(group.icon).toBe(descriptor.icon)
      expect(group.count).toBe(group.ids.length)
      expect(group.samples.length).toBe(Math.min(3, group.count))

      const members = group.ids.map((id) => itemById.get(id)!)
      let bytes = 0
      let recommendCount = 0
      let recommendBytes = 0
      let protectedCount = 0
      let maxRisk: RiskLevel = 'safe'
      for (let index = 0; index < members.length; index++) {
        const member = members[index]!
        expect(member.taskId).toBe(group.taskId)
        if (index > 0) expect(members[index - 1]!.size).toBeGreaterThanOrEqual(member.size)
        bytes += member.size
        if (recommended.has(member.id)) {
          recommendCount++
          recommendBytes += member.size
        }
        if (member.protected === true) protectedCount++
        if (RISK_META[member.risk].weight > RISK_META[maxRisk].weight) maxRisk = member.risk
      }
      expect(group.bytes).toBe(bytes)
      expect(group.risk).toBe(maxRisk)
      expect(group.recommendCount).toBe(recommendCount)
      expect(group.recommendBytes).toBe(recommendBytes)
      expect(group.protectedCount).toBe(protectedCount)
    }
  })

  it('groupByCategory：只含有数据分类、按 CATEGORIES 顺序、求和与排序正确', () => {
    const groups = groupByTask(items, tasks)
    const categories = groupByCategory(items, tasks)
    const expectedOrder = CATEGORY_LIST.filter((category) =>
      groups.some((group) => group.category === category),
    )
    expect(categories.map((category) => category.category)).toEqual(expectedOrder)
    expect(categories.reduce((sum, category) => sum + category.count, 0)).toBe(items.length)
    expect(categories.reduce((sum, category) => sum + category.bytes, 0)).toBe(totalBytes)

    const recommended = new Set(recommendIds(items))
    for (const category of categories) {
      expect(category.name).toBe(CATEGORIES[category.category].name)
      expect(category.color).toBe(CATEGORIES[category.category].color)
      let count = 0
      let bytes = 0
      let recommendCount = 0
      let recommendBytes = 0
      for (let index = 0; index < category.tasks.length; index++) {
        const group = category.tasks[index]!
        if (index > 0) expect(category.tasks[index - 1]!.bytes).toBeGreaterThanOrEqual(group.bytes)
        count += group.count
        bytes += group.bytes
        recommendCount += group.recommendCount
        recommendBytes += group.recommendBytes
      }
      expect(category.count).toBe(count)
      expect(category.bytes).toBe(bytes)
      expect(category.recommendCount).toBe(recommendCount)
      expect(category.recommendBytes).toBe(recommendBytes)
    }
    expect(recommended.size).toBeGreaterThan(0)
  })

  it('recommendIds：只含 safe（可选 caution）、排除 protected，排序确定', () => {
    const recommended = recommendIds(items)
    const expected = items.filter((item) => item.risk === 'safe' && item.protected !== true)
    expect(recommended).toHaveLength(expected.length)
    expect(recommended.every((id) => {
      const item = itemById.get(id)!
      return item.risk === 'safe' && item.protected !== true
    })).toBe(true)
    for (let index = 0; index < recommended.length - 1; index++) {
      const current = itemById.get(recommended[index]!)!
      const next = itemById.get(recommended[index + 1]!)!
      expect(current.size).toBeGreaterThanOrEqual(next.size)
      if (current.size === next.size) expect(current.id < next.id).toBe(true)
    }

    const withCaution = recommendIds(items, { includeCaution: true })
    expect(withCaution).toHaveLength(
      items.filter((item) => (item.risk === 'safe' || item.risk === 'caution') && item.protected !== true).length,
    )
    expect(withCaution.some((id) => itemById.get(id)!.risk === 'risky')).toBe(false)

    const threshold = 10_000_000
    const bigOnly = recommendIds(items, { minSize: threshold })
    expect(bigOnly.length).toBeGreaterThan(0)
    expect(bigOnly.every((id) => itemById.get(id)!.size >= threshold)).toBe(true)
    expect(bigOnly).toHaveLength(
      items.filter((item) => item.risk === 'safe' && item.protected !== true && item.size >= threshold).length,
    )
  })

  it('filterItems：条件组合正确且保持输入顺序', () => {
    const filtered = filterItems(items, { risks: ['risky'], minSize: 1_000_000 })
    const expected = items.filter(
      (item) => item.risk === 'risky' && item.size >= 1_000_000 && item.protected !== true,
    )
    expect(filtered.length).toBeGreaterThan(0)
    expect(filtered.map((item) => item.id)).toEqual(expected.map((item) => item.id))

    const taskId = tasks[3]!.id
    const selected = new Set(items.filter((item) => item.taskId === taskId).slice(0, 3).map((item) => item.id))
    const combined = filterItems(
      items,
      { query: 'cache', taskIds: [taskId], risks: ['safe'], onlyRecommended: true, minSize: 0 },
      selected,
    )
    expect(combined.every((item) => item.taskId === taskId && item.risk === 'safe' && item.protected !== true)).toBe(
      true,
    )
    expect(combined.map((item) => item.id)).toEqual(
      items
        .filter(
          (item) => item.taskId === taskId && item.risk === 'safe' && item.protected !== true,
        )
        .map((item) => item.id),
    )
  })

  it('sortItems：size-desc 单调且同 size 保持输入顺序；mtime-desc 缺失项排最后', () => {
    const sorted = sortItems(items, 'size-desc')
    expect(sorted).toHaveLength(items.length)
    const originalIndex = indexOfItem(items)
    let tieCount = 0
    for (let index = 0; index < sorted.length - 1; index++) {
      const current = sorted[index]!
      const next = sorted[index + 1]!
      expect(current.size).toBeGreaterThanOrEqual(next.size)
      if (current.size === next.size) {
        tieCount++
        expect(originalIndex.get(current.id)!).toBeLessThan(originalIndex.get(next.id)!)
      }
    }
    expect(tieCount).toBeGreaterThan(100) // 夹具确实制造了大量同 size 项

    const byMtime = sortItems(items, 'mtime-desc')
    const firstMissing = byMtime.findIndex((item) => item.mtimeMs === undefined)
    expect(firstMissing).toBeGreaterThan(0)
    expect(byMtime.slice(firstMissing).every((item) => item.mtimeMs === undefined)).toBe(true)
    for (let index = 0; index < firstMissing - 1; index++) {
      expect(byMtime[index]!.mtimeMs!).toBeGreaterThanOrEqual(byMtime[index + 1]!.mtimeMs!)
    }
  })

  it('summarizeSelection：全选时汇总等于全量统计；部分选择时等于子集统计', () => {
    const summary = summarizeSelection(items, new Set(items.map((item) => item.id)), tasks)
    expect(summary.count).toBe(items.length)
    expect(summary.bytes).toBe(totalBytes)
    expect(summary.byRisk.safe.count + summary.byRisk.caution.count + summary.byRisk.risky.count).toBe(items.length)
    expect(summary.byRisk.safe.bytes + summary.byRisk.caution.bytes + summary.byRisk.risky.bytes).toBe(totalBytes)
    expect(summary.warnCount).toBe(items.filter((item) => item.risk !== 'safe').length)
    expect(summary.riskyIds.length).toBe(items.filter((item) => item.risk === 'risky').length)
    expect(summary.byTask.reduce((sum, task) => sum + task.count, 0)).toBe(items.length)
    for (let index = 0; index < summary.byTask.length - 1; index++) {
      expect(summary.byTask[index]!.bytes).toBeGreaterThanOrEqual(summary.byTask[index + 1]!.bytes)
    }

    const subset = items.slice(0, 1_000)
    const subsetSelected = new Set(subset.map((item) => item.id))
    const subsetSummary = summarizeSelection(items, subsetSelected, tasks)
    expect(subsetSummary.count).toBe(subset.length)
    expect(subsetSummary.bytes).toBe(subset.reduce((sum, item) => sum + item.size, 0))
  })
})

/* ------------------------------------------------------------------ */
/* 性能                                                                */
/* ------------------------------------------------------------------ */

describe('性能（5,000 条）', () => {
  it('分组 + 筛选 + 排序 + 汇总总耗时 < 1000ms', () => {
    const { items: largeItems, tasks: largeTasks } = createLargeFixture(5_000, 40)
    expect(largeItems).toHaveLength(5_000)
    const selected = new Set(largeItems.slice(0, 2_000).map((item) => item.id))

    const startedAt = performance.now()
    const categories = groupByCategory(largeItems, largeTasks, {
      sampleLimit: 3,
      recommend: { includeCaution: true, minSize: 1_024 },
    })
    const filtered = filterItems(largeItems, { query: 'cache', risks: ['safe', 'caution'], minSize: 1_024 }, selected)
    const sorted = sortItems(filtered, 'size-desc')
    const summary = summarizeSelection(largeItems, selected, largeTasks)
    const elapsedMs = performance.now() - startedAt

    // 结果自检：确认四个函数都真的跑了数据，而不是空转
    expect(categories.length).toBeGreaterThan(0)
    expect(filtered.length).toBeGreaterThan(0)
    expect(sorted).toHaveLength(filtered.length)
    expect(summary.count).toBe(2_000)
    expect(elapsedMs).toBeLessThan(1_000)
  })
})
