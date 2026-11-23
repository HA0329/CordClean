/**
 * 插件页展示模型单测：状态归一、统计、过滤、风险提示、异常诊断、批量计划。
 */
import { describe, expect, it } from 'vitest'
import {
  capabilityWarnings,
  emptyFilterHint,
  filterPlugins,
  planBatch,
  pluginDiagnostics,
  pluginStatusKey,
  pluginStatusLabel,
  summarizePlugins,
  type PluginLike,
} from '../packages/ui/src/views/plugins-view-model.ts'

function plugin(partial: Partial<PluginLike> & { id: string }): PluginLike {
  return { name: partial.id, enabled: true, status: 'active', ...partial }
}

const PLUGINS: PluginLike[] = [
  plugin({ id: 'rule-pack', name: '规则库', taskCount: 31, status: 'active' }),
  plugin({ id: 'ex-cache', name: '开发缓存', source: 'external', capabilities: { fsRoots: ['D:\\cache', 'D:\\tmp'], customClean: true } }),
  plugin({ id: 'broken', name: '坏插件', enabled: false, status: 'error', error: '加载失败：ENOENT plugin.mjs' }),
  plugin({ id: 'ai', name: 'AI 顾问', enabled: false, status: 'stopped' }),
]

describe('状态归一', () => {
  it('已知状态映射，未知/缺失回 stopped', () => {
    expect(pluginStatusKey('active')).toBe('active')
    expect(pluginStatusKey('SUSPENDED')).toBe('suspended')
    expect(pluginStatusKey('error')).toBe('error')
    expect(pluginStatusKey('loading')).toBe('loading')
    expect(pluginStatusKey('whatever')).toBe('stopped')
    expect(pluginStatusKey(undefined)).toBe('stopped')
    expect(pluginStatusLabel('suspended')).toBe('等待依赖')
    expect(pluginStatusLabel(undefined)).toBe('已停止')
  })
})

describe('统计', () => {
  it('汇总数量/异常/外部/任务', () => {
    const stats = summarizePlugins(PLUGINS)
    expect(stats.total).toBe(4)
    expect(stats.enabled).toBe(2)
    expect(stats.running).toBe(2)
    expect(stats.errors).toBe(1)
    expect(stats.external).toBe(1)
    expect(stats.tasks).toBe(31)
  })

  it('空列表返回全零', () => {
    expect(summarizePlugins([])).toEqual({ total: 0, enabled: 0, running: 0, errors: 0, external: 0, configurable: 0, tasks: 0 })
  })
})

describe('过滤', () => {
  it('空查询 + all 保持顺序与数量', () => {
    expect(filterPlugins(PLUGINS, '', 'all').map((item) => item.id)).toEqual(['rule-pack', 'ex-cache', 'broken', 'ai'])
    expect(filterPlugins(PLUGINS, '   ', 'all')).toHaveLength(4)
  })

  it('按 id/名称/描述/任务名搜索', () => {
    expect(filterPlugins(PLUGINS, '规则', 'all').map((item) => item.id)).toEqual(['rule-pack'])
    expect(filterPlugins(PLUGINS, 'EX-CACHE', 'all').map((item) => item.id)).toEqual(['ex-cache'])
    expect(filterPlugins(PLUGINS, '顾问', 'all').map((item) => item.id)).toEqual(['ai'])
  })

  it('状态筛选：异常/外部/运行中/已停止', () => {
    expect(filterPlugins(PLUGINS, '', 'error').map((item) => item.id)).toEqual(['broken'])
    expect(filterPlugins(PLUGINS, '', 'external').map((item) => item.id)).toEqual(['ex-cache'])
    expect(filterPlugins(PLUGINS, '', 'active').map((item) => item.id)).toEqual(['rule-pack', 'ex-cache'])
    expect(filterPlugins(PLUGINS, '', 'stopped').map((item) => item.id)).toEqual(['broken', 'ai'])
  })
})

describe('风险提示', () => {
  it('能力与权限都转成可读提示', () => {
    const warnings = capabilityWarnings(
      plugin({
        id: 'ext',
        capabilities: { fsRoots: ['a', 'b'], network: true, childProcess: true, customClean: true },
        permissions: { services: ['fs', 'net'], network: true, subprocess: true },
      }),
    )
    expect(warnings).toEqual([
      '可访问 2 个声明目录',
      '可发起网络请求',
      '可启动子进程',
      '含自定义清理逻辑（不受统一清理引擎约束）',
      '申请 2 个内核服务',
      '权限声明含网络',
      '权限声明含子进程',
    ])
  })

  it('普通内置插件没有提示', () => {
    expect(capabilityWarnings(plugin({ id: 'plain' }))).toEqual([])
  })
})

describe('异常诊断', () => {
  it('有 error 或异常状态时给消息与下一步提示', () => {
    const diagnostics = pluginDiagnostics(plugin({ id: 'broken', status: 'error', error: 'ENOENT', errorStack: 'stack line' }))
    expect(diagnostics?.message).toBe('ENOENT')
    expect(diagnostics?.stack).toBe('stack line')
    expect(diagnostics?.hint).toContain('热重载')
  })

  it('状态异常但没有 error 文本也有兜底', () => {
    const diagnostics = pluginDiagnostics(plugin({ id: 'x', status: 'error' }))
    expect(diagnostics?.message).toContain('没有返回错误信息')
    expect(diagnostics?.stack).toBeUndefined()
  })

  it('正常插件没有诊断', () => {
    expect(pluginDiagnostics(plugin({ id: 'ok' }))).toBeUndefined()
  })
})

describe('批量计划', () => {
  it('启用只选未启用的；停用只选已启用的；重载只选已启用的', () => {
    expect(planBatch(PLUGINS, 'enable').ids).toEqual(['broken', 'ai'])
    expect(planBatch(PLUGINS, 'disable').ids).toEqual(['rule-pack', 'ex-cache'])
    expect(planBatch(PLUGINS, 'reload').ids).toEqual(['rule-pack', 'ex-cache'])
  })

  it('摘要包含数量，停用带影响提示；无操作项时 ids 为空', () => {
    const disable = planBatch(PLUGINS, 'disable')
    expect(disable.summary).toContain('停用 2 个插件')
    expect(disable.warning).toContain('清理任务')
    expect(planBatch([plugin({ id: 'a', enabled: true })], 'enable').ids).toEqual([])
    expect(planBatch([], 'reload').ids).toEqual([])
  })
})

describe('空过滤提示', () => {
  it('区分搜索词与状态筛选', () => {
    expect(emptyFilterHint('', 'error')).toBe('当前没有异常插件，状态良好')
    expect(emptyFilterHint('', 'external')).toContain('外部')
    expect(emptyFilterHint('xyz', 'all')).toContain('xyz')
    expect(emptyFilterHint('xyz', 'error')).toContain('同时匹配')
    expect(emptyFilterHint('', 'all')).toBe('没有插件')
  })
})
