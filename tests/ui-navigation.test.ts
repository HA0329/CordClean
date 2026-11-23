/**
 * 侧边栏导航模型单测（纯函数，不依赖 DOM / Vue）。
 *
 * 覆盖「不规则使用」的关键路径：未知 hash、深链接、前进后退、
 * 瞬态页（扫描/清理进行中）回落、快捷键冲突、偏好存储损坏。
 */
import { describe, expect, it } from 'vitest'
import {
  NAV_AREAS,
  NAV_GROUPS,
  NAV_STORAGE_KEYS,
  areaById,
  areaForShortcut,
  activeAreaId,
  badgeForArea,
  filterAreas,
  groupedAreas,
  initialPage,
  isTypingTarget,
  nextAreaId,
  pageHash,
  pageTitle,
  parseNavPreferences,
  resolveAreaId,
  resolvePage,
  serializeNavPreferences,
  shortcutLabel,
  type NavStatus,
} from '../packages/ui/src/navigation.ts'

const idle: NavStatus = { scanning: false, cleaning: false, pluginErrors: 0, quarantineCount: 0, aiConfigured: true }

describe('区域解析（未知输入不白屏）', () => {
  it('已知区域与 hash 都能解析', () => {
    expect(resolveAreaId('overview')).toBe('overview')
    expect(resolveAreaId('#plugins')).toBe('plugins')
    expect(resolveAreaId('  SETTINGS  ')).toBe('settings')
    expect(resolveAreaId('workshop')).toBe('workshop')
  })

  it('未知/空值一律回落概览；瞬态页别名到清理', () => {
    expect(resolveAreaId('')).toBe('overview')
    expect(resolveAreaId(undefined)).toBe('overview')
    expect(resolveAreaId('#nope')).toBe('overview')
    expect(resolveAreaId('cleaning')).toBe('clean')
    expect(resolveAreaId('scanning')).toBe('clean')
  })

  it('areaById 永远返回合法区域', () => {
    expect(areaById('history').label).toBe('历史与隔离区')
    expect(areaById('不存在').id).toBe('overview')
  })
})

describe('瞬态页（扫描/清理进行中）', () => {
  it('进行中才允许进入瞬态页，结束后回落清理页', () => {
    expect(resolvePage('scanning', { scanning: true, cleaning: false })).toBe('scanning')
    expect(resolvePage('scanning', { scanning: false, cleaning: false })).toBe('clean')
    expect(resolvePage('cleaning', { scanning: false, cleaning: true })).toBe('cleaning')
    expect(resolvePage('cleaning', { scanning: false, cleaning: false })).toBe('clean')
    expect(resolvePage('nope', { scanning: false, cleaning: false })).toBe('overview')
  })

  it('瞬态页高亮父区域（清理）', () => {
    expect(activeAreaId('cleaning')).toBe('clean')
    expect(activeAreaId('scanning')).toBe('clean')
    expect(activeAreaId('plugins')).toBe('plugins')
  })

  it('标题：瞬态页显示进行中标签', () => {
    expect(pageTitle('overview')).toBe('概览')
    expect(pageTitle('cleaning')).toBe('清理进行中')
    expect(pageTitle('scanning')).toBe('扫描进行中')
    expect(pageTitle('unknown')).toBe('概览')
  })
})

describe('首次挂载与 hash 深链接', () => {
  it('hash 优先于上次停留页', () => {
    expect(initialPage('#plugins', { ...idle, lastPage: 'settings' })).toBe('plugins')
  })

  it('没有 hash 时回到上次停留的稳定区', () => {
    expect(initialPage('', { ...idle, lastPage: 'history' })).toBe('history')
    expect(initialPage(null, { ...idle, lastPage: '不存在' })).toBe('overview')
    expect(initialPage('', { ...idle, lastPage: 'cleaning' })).toBe('clean')
  })

  it('深链接到非活动瞬态页会回落到清理页', () => {
    expect(initialPage('#scanning', { ...idle, lastPage: null })).toBe('clean')
    expect(initialPage('#scanning', { scanning: true, cleaning: false, lastPage: null })).toBe('scanning')
  })
})

describe('搜索过滤与分组', () => {
  it('空查询返回全部区域', () => {
    expect(filterAreas('')).toHaveLength(NAV_AREAS.length)
    expect(filterAreas('   ')).toHaveLength(NAV_AREAS.length)
  })

  it('按标签/关键词/英文命中', () => {
    expect(filterAreas('隔离').map((area) => area.id)).toContain('history')
    // 「隔离区」也会命中设置页描述里的「隔离区」——搜索结果允许跨区域，不强行唯一
    expect(filterAreas('隔离区').map((area) => area.id)).toEqual(['history', 'settings'])
    expect(filterAreas('workshop').map((area) => area.id)).toContain('workshop')
    expect(filterAreas('ai').map((area) => area.id)).toEqual(expect.arrayContaining(['ai', 'workshop']))
    expect(filterAreas('完全不存在的词')).toEqual([])
  })

  it('分组覆盖所有区域且顺序稳定（搜索时只保留有命中的分组）', () => {
    const full = groupedAreas()
    const ids = full.flatMap((entry) => entry.areas.map((area) => area.id))
    expect(new Set(ids).size).toBe(NAV_AREAS.length)
    expect(full.map((entry) => entry.group.id)).toEqual(NAV_GROUPS.slice(0, full.length).map((group) => group.id))
    const matched = groupedAreas(filterAreas('隔离区'))
    expect(matched.map((entry) => entry.group.id)).toEqual(['record', 'system'])
    expect(matched[0].areas.map((area) => area.id)).toEqual(['history'])
  })
})

describe('键盘导航', () => {
  it('Alt+数字 映射区域，Ctrl/Shift/无修饰符不触发', () => {
    expect(areaForShortcut({ key: '1', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false })).toBe('overview')
    expect(areaForShortcut({ key: '7', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false })).toBe('settings')
    expect(areaForShortcut({ key: '9', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false })).toBeUndefined()
    expect(areaForShortcut({ key: '1', altKey: false, ctrlKey: true, metaKey: false, shiftKey: false })).toBeUndefined()
    expect(areaForShortcut({ key: '1', altKey: true, ctrlKey: false, metaKey: false, shiftKey: true })).toBeUndefined()
    expect(areaForShortcut({ key: '0', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false })).toBeUndefined()
  })

  it('区域间循环移动（Alt+↑/↓）', () => {
    expect(nextAreaId('overview', 1)).toBe('clean')
    expect(nextAreaId('settings', 1)).toBe('overview')
    expect(nextAreaId('overview', -1)).toBe('settings')
    expect(nextAreaId('不存在', 1)).toBe('clean')
  })

  it('快捷键标签与区域一一对应（不重复）', () => {
    const labels = NAV_AREAS.map((area) => shortcutLabel(area.id))
    expect(labels.every(Boolean)).toBe(true)
    expect(new Set(labels).size).toBe(NAV_AREAS.length)
    expect(shortcutLabel('overview')).toBe('Alt+1')
    expect(shortcutLabel('不存在')).toBeUndefined()
  })

  it('输入控件内不抢快捷键', () => {
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true)
    expect(isTypingTarget({ tagName: 'textarea' })).toBe(true)
    expect(isTypingTarget({ tagName: 'div', isContentEditable: true })).toBe(true)
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})

describe('偏好存储（损坏数据不影响启动）', () => {
  it('解析容错：非法类型/未知分组/坏 JSON 全部回默认', () => {
    expect(parseNavPreferences(null, null)).toEqual({ collapsed: false, groups: {} })
    expect(parseNavPreferences('1', null).collapsed).toBe(true)
    expect(parseNavPreferences('true', null).collapsed).toBe(true)
    expect(parseNavPreferences('0', null).collapsed).toBe(false)
    expect(parseNavPreferences(null, 'not-json').groups).toEqual({})
    expect(parseNavPreferences(null, '{"extend":false,"nope":false,"record":"x"}').groups).toEqual({ extend: false })
  })

  it('序列化可往返且键名与存储常量一致', () => {
    const preferences = { collapsed: true, groups: { extend: false } }
    const serialized = serializeNavPreferences(preferences)
    expect(serialized.collapsed).toBe('1')
    expect(Object.keys(NAV_STORAGE_KEYS).sort()).toEqual(['collapsed', 'groups', 'lastPage'])
    expect(parseNavPreferences(serialized.collapsed, serialized.groups)).toEqual(preferences)
  })
})

describe('状态徽标（任何页面都能看到正在发生什么）', () => {
  it('清理/扫描进行中', () => {
    expect(badgeForArea('clean', { ...idle, scanning: true })).toEqual({ text: '扫描中', tone: 'info' })
    expect(badgeForArea('clean', { ...idle, scanning: true, cleaning: true })).toEqual({ text: '清理中', tone: 'warn' })
    expect(badgeForArea('clean', idle)).toBeUndefined()
  })

  it('插件异常 / 隔离区待恢复 / AI 未配置', () => {
    expect(badgeForArea('plugins', { ...idle, pluginErrors: 2 })).toEqual({ text: '2 异常', tone: 'danger' })
    expect(badgeForArea('plugins', idle)).toBeUndefined()
    expect(badgeForArea('history', { ...idle, quarantineCount: 5 })).toEqual({ text: '5', tone: 'info' })
    expect(badgeForArea('history', { ...idle, quarantineCount: 1200 })?.text).toBe('999+')
    expect(badgeForArea('history', idle)).toBeUndefined()
    expect(badgeForArea('ai', { ...idle, aiConfigured: false })).toEqual({ text: '未配置', tone: 'warn' })
    expect(badgeForArea('ai', idle)).toBeUndefined()
    expect(badgeForArea('overview', { ...idle, scanning: true })).toBeUndefined()
  })
})

describe('hash 生成', () => {
  it('统一带 # 前缀，便于深链接与 e2e 断言', () => {
    expect(pageHash('overview')).toBe('#overview')
    expect(pageHash('#plugins')).toBe('#plugins')
    expect(pageHash('')).toBe('#')
  })
})
