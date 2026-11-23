/**
 * 侧边栏导航模型（纯函数，可单测）。
 *
 * 设计目标（对应「完善优化基底」）：
 * 1. **单一事实来源**：功能区域、分组、图标、快捷键、标题都从这张表推导，
 *    新增区域只改这里 + 加一个 view，避免散落在 App.vue / e2e 脚本里；
 * 2. **对不规则使用鲁棒**：未知 hash、暂停中的扫描/清理页、历史前进后退、
 *    直接点击/键盘/搜索三种入口都走同一套 resolve，不会白屏或卡死；
 * 3. **方便未来改造**：所有函数无副作用（localStorage 只在 UI 层读写），
 *    可以直接在 Node 环境单测。
 */

/** 稳定区（侧边栏常驻） */
export type NavAreaId = 'overview' | 'clean' | 'plugins' | 'workshop' | 'ai' | 'history' | 'settings'
/** 瞬态页（进行中才从清理区进入） */
export type TransientPageId = 'cleaning' | 'scanning'
/** 所有可能的页面 id（含瞬态） */
export type PageId = NavAreaId | TransientPageId

export type NavGroupId = 'start' | 'cleanup' | 'extend' | 'assist' | 'record' | 'system'

export type AreaIcon =
  | 'home'
  | 'broom'
  | 'puzzle'
  | 'flask'
  | 'sparkles'
  | 'clock'
  | 'gear'
  | 'scan'

export interface NavArea {
  id: NavAreaId
  label: string
  /** 折叠/窄屏时的短标签 */
  shortLabel: string
  icon: AreaIcon
  group: NavGroupId
  /** 搜索关键词（中英混合，含同义词） */
  keywords: string[]
  /** 一句话说明（悬停提示/搜索结果辅助） */
  description: string
}

export interface NavGroup {
  id: NavGroupId
  label: string
}

/** 分组顺序即渲染顺序 */
export const NAV_GROUPS: readonly NavGroup[] = [
  { id: 'start', label: '开始' },
  { id: 'cleanup', label: '清理' },
  { id: 'extend', label: '扩展' },
  { id: 'assist', label: '智能' },
  { id: 'record', label: '记录' },
  { id: 'system', label: '系统' },
]

/** 区域顺序即 Alt+1..N 的顺序 */
export const NAV_AREAS: readonly NavArea[] = [
  {
    id: 'overview',
    label: '概览',
    shortLabel: '概览',
    icon: 'home',
    group: 'start',
    keywords: ['首页', 'home', 'dashboard', '状态', '磁盘', '内存'],
    description: '系统状态、磁盘空间与最近清理概览',
  },
  {
    id: 'clean',
    label: '扫描与清理',
    shortLabel: '清理',
    icon: 'broom',
    group: 'cleanup',
    keywords: ['清理', '扫描', '垃圾', '缓存', 'clean', 'scan'],
    description: '扫描可清理项、选择并执行清理',
  },
  {
    id: 'plugins',
    label: '插件',
    shortLabel: '插件',
    icon: 'puzzle',
    group: 'extend',
    keywords: ['插件', 'plugin', '扩展', '启用', '配置'],
    description: '启停内置插件、管理外部插件与插件包',
  },
  {
    id: 'workshop',
    label: 'AI 插件工坊',
    shortLabel: '工坊',
    icon: 'flask',
    group: 'extend',
    keywords: ['工坊', 'workshop', '生成', '插件包', 'ai'],
    description: '用 AI 生成插件包草稿，静态校验后安装',
  },
  {
    id: 'ai',
    label: 'AI 清理顾问',
    shortLabel: 'AI',
    icon: 'sparkles',
    group: 'assist',
    keywords: ['AI', '顾问', '建议', '模型', '清理建议'],
    description: '基于本机画像给出清理建议与规则草稿',
  },
  {
    id: 'history',
    label: '历史与隔离区',
    shortLabel: '历史',
    icon: 'clock',
    group: 'record',
    keywords: ['历史', '隔离区', '恢复', '撤销', '记录', 'history', 'quarantine'],
    description: '清理历史、隔离区恢复与撤销',
  },
  {
    id: 'settings',
    label: '设置',
    shortLabel: '设置',
    icon: 'gear',
    group: 'system',
    keywords: ['设置', '配置', 'settings', '主题', '清理模式'],
    description: '清理模式、隔离区、扫描范围与界面设置',
  },
]

const AREA_BY_ID = new Map<string, NavArea>(NAV_AREAS.map((area) => [area.id, area]))

/** hash / 旧页面 id → 稳定区 */
export const PAGE_ALIASES: Readonly<Record<string, NavAreaId>> = {
  cleaning: 'clean',
  scanning: 'clean',
}

/** 瞬态页描述：只在扫描/清理进行中出现，点它回到实时进度页 */
export const TRANSIENT_PAGES: Readonly<
  Record<TransientPageId, { label: string; icon: AreaIcon; parent: NavAreaId; description: string }>
> = {
  cleaning: { label: '清理进行中', icon: 'broom', parent: 'clean', description: '查看实时清理进度与结果' },
  scanning: { label: '扫描进行中', icon: 'scan', parent: 'clean', description: '查看实时扫描进度与结果' },
}

/** 规范化任意输入（hash / page id / 带 # 的字符串） */
export function normalizePageId(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .replace(/^#/, '')
    .toLowerCase()
}

/** 已知 or 未知 → 稳定区；未知一律回落到概览（不白屏） */
export function resolveAreaId(value: string | null | undefined): NavAreaId {
  const raw = normalizePageId(value)
  if (!raw) return 'overview'
  const alias = PAGE_ALIASES[raw]
  if (alias) return alias
  const area = AREA_BY_ID.get(raw)
  return area ? area.id : 'overview'
}

export function areaById(value: string | null | undefined): NavArea {
  return AREA_BY_ID.get(normalizePageId(value)) ?? AREA_BY_ID.get('overview')!
}

export interface PageStatus {
  scanning: boolean
  cleaning: boolean
}

/**
 * 解析页面：
 * - `cleaning` / `scanning` 只有对应任务真的在跑才保留，否则回落到清理页；
 * - 未知页面回到概览；
 * - 其余按稳定区解析。
 */
export function resolvePage(value: string | null | undefined, status: PageStatus): PageId {
  const raw = normalizePageId(value)
  if (raw === 'cleaning') return status.cleaning ? 'cleaning' : 'clean'
  if (raw === 'scanning') return status.scanning ? 'scanning' : 'clean'
  return resolveAreaId(raw)
}

/** 当前页面高亮哪个侧边栏区域（瞬态页高亮其父区域） */
export function activeAreaId(page: string | null | undefined): NavAreaId {
  const raw = normalizePageId(page)
  if (raw === 'cleaning' || raw === 'scanning') return PAGE_ALIASES[raw] ?? 'clean'
  return resolveAreaId(raw)
}

/** 页面标题（document.title / 顶栏共用） */
export function pageTitle(page: string | null | undefined): string {
  const raw = normalizePageId(page)
  if (raw === 'cleaning') return TRANSIENT_PAGES.cleaning.label
  if (raw === 'scanning') return TRANSIENT_PAGES.scanning.label
  return areaById(raw).label
}

/** 页面 → hash（统一带 #，便于深链接与 e2e 断言） */
export function pageHash(page: string | null | undefined): string {
  return '#' + normalizePageId(page)
}

export interface InitialPageOptions extends PageStatus {
  /** 上次浏览器会话停留的稳定区（localStorage，可为空/非法） */
  lastPage?: string | null
}

/** 首次挂载时的页面：hash 优先，其次上次停留，最后概览；非法的瞬态页会回落 */
export function initialPage(hash: string | null | undefined, options: InitialPageOptions): PageId {
  const raw = normalizePageId(hash)
  if (raw) return resolvePage(raw, options)
  return resolveAreaId(options.lastPage)
}

/** 搜索过滤：标签 / 短标签 / id / 关键词，大小写不敏感，空查询返回全部 */
export function filterAreas(query: string | null | undefined): NavArea[] {
  const needle = String(query ?? '').trim().toLowerCase()
  if (!needle) return [...NAV_AREAS]
  return NAV_AREAS.filter((area) => {
    const haystack = [area.label, area.shortLabel, area.id, area.description, ...area.keywords].join(' ').toLowerCase()
    return haystack.includes(needle)
  })
}

/** 分组渲染数据：空分组自动省略（搜索时只显示有命中项的分组） */
export function groupedAreas(areas: readonly NavArea[] = NAV_AREAS): Array<{ group: NavGroup; areas: NavArea[] }> {
  const result: Array<{ group: NavGroup; areas: NavArea[] }> = []
  for (const group of NAV_GROUPS) {
    const items = areas.filter((area) => area.group === group.id)
    if (items.length) result.push({ group, areas: items })
  }
  return result
}

/** 在区域间循环移动（键盘上下/快捷键切换用）；delta 可为负 */
export function nextAreaId(current: string | null | undefined, delta: number): NavAreaId {
  const currentId = activeAreaId(current)
  const index = NAV_AREAS.findIndex((area) => area.id === currentId)
  const safeIndex = index < 0 ? 0 : index
  const size = NAV_AREAS.length
  const next = ((safeIndex + delta) % size + size) % size
  return NAV_AREAS[next].id
}

/** 区域对应的快捷键序号（Alt+1..N），无则 undefined */
export function shortcutLabel(areaId: string | null | undefined): string | undefined {
  const index = NAV_AREAS.findIndex((area) => area.id === normalizePageId(areaId))
  return index >= 0 ? `Alt+${index + 1}` : undefined
}

export interface ModifierState {
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

/**
 * 全局快捷键 → 区域。
 * 用 Alt+数字 而不是 Ctrl+数字：浏览器/Electron 的 Ctrl+数字通常被标签页占用，
 * Alt+数字在两种外壳下都更稳定，且不会和系统输入法冲突。
 */
export function areaForShortcut(event: ModifierState): NavAreaId | undefined {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return undefined
  if (!/^[1-9]$/.test(event.key)) return undefined
  const index = Number(event.key) - 1
  return NAV_AREAS[index]?.id
}

/** 键盘事件是否发生在输入控件里（快捷键/方向键必须让位给输入） */
export function isTypingTarget(target: { tagName?: string; isContentEditable?: boolean } | null | undefined): boolean {
  if (!target) return false
  if (target.isContentEditable) return true
  const tag = String(target.tagName ?? '').toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/* ------------------------------------------------------------------ */
/* 侧边栏偏好（折叠 / 分组展开）：纯序列化，存储留给 UI 层              */
/* ------------------------------------------------------------------ */

export interface NavPreferences {
  collapsed: boolean
  /** groupId → 是否展开（缺省视为展开） */
  groups: Record<string, boolean>
}

export const NAV_STORAGE_KEYS = {
  collapsed: 'cordclean.nav.collapsed',
  groups: 'cordclean.nav.groups',
  lastPage: 'cordclean.nav.lastPage',
} as const

export const DEFAULT_NAV_PREFERENCES: NavPreferences = { collapsed: false, groups: {} }

/** 容错解析（损坏 JSON / 非法类型 → 默认值，永不抛错） */
export function parseNavPreferences(collapsedRaw: string | null | undefined, groupsRaw: string | null | undefined): NavPreferences {
  const preferences: NavPreferences = { collapsed: false, groups: {} }
  if (collapsedRaw === '1' || collapsedRaw === 'true') preferences.collapsed = true
  if (groupsRaw) {
    try {
      const parsed: unknown = JSON.parse(groupsRaw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === 'boolean' && NAV_GROUPS.some((group) => group.id === key)) {
            preferences.groups[key] = value
          }
        }
      }
    } catch {
      /* 损坏值忽略，用默认展开 */
    }
  }
  return preferences
}

export function serializeNavPreferences(preferences: NavPreferences): { collapsed: string; groups: string } {
  return {
    collapsed: preferences.collapsed ? '1' : '0',
    groups: JSON.stringify(preferences.groups ?? {}),
  }
}

/* ------------------------------------------------------------------ */
/* 状态徽标：让用户在任何页面都能看到「正在发生什么」                    */
/* ------------------------------------------------------------------ */

export interface NavStatus {
  scanning: boolean
  cleaning: boolean
  /** 处于 error 状态的插件数 */
  pluginErrors: number
  /** 隔离区未恢复项数 */
  quarantineCount: number
  aiConfigured: boolean
}

export interface NavBadge {
  text: string
  tone: 'info' | 'warn' | 'danger'
}

/** 区域 → 徽标；没有可展示状态时返回 undefined（不占位） */
export function badgeForArea(areaId: string | null | undefined, status: NavStatus): NavBadge | undefined {
  const id = resolveAreaId(areaId)
  if (id === 'clean') {
    if (status.cleaning) return { text: '清理中', tone: 'warn' }
    if (status.scanning) return { text: '扫描中', tone: 'info' }
    return undefined
  }
  if (id === 'plugins' && status.pluginErrors > 0) {
    return { text: `${status.pluginErrors} 异常`, tone: 'danger' }
  }
  if (id === 'history' && status.quarantineCount > 0) {
    return { text: status.quarantineCount > 999 ? '999+' : String(status.quarantineCount), tone: 'info' }
  }
  if (id === 'ai' && !status.aiConfigured) return { text: '未配置', tone: 'warn' }
  return undefined
}
