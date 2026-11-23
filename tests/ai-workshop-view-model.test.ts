/**
 * AI 插件工坊展示模型单测：
 * 需求归一化 / 错误脱敏 / 失败归因 / 阶段映射 / 草稿历史容错 / 校验摘要 / 按钮门禁 / 准备状态。
 */
import { describe, expect, it } from 'vitest'
import type { AiPluginDraft } from '@cordclean/shared'
import {
  MAX_DRAFT_HISTORY,
  MAX_DRAFT_FILE_CHARS,
  MAX_REQUIREMENT_LENGTH,
  appendDraftHistory,
  classifyWorkshopFailure,
  draftHistoryItems,
  draftToSnapshot,
  generateGate,
  generationStageView,
  installGate,
  materializeSnapshot,
  normalizeRequirement,
  parseDraftHistory,
  sanitizeErrorMessage,
  scanRiskyApis,
  serializeDraftHistory,
  summarizeValidation,
  workshopReadiness,
} from '../packages/ui/src/views/ai-workshop-view-model.ts'

function draft(overrides: Partial<AiPluginDraft> = {}): AiPluginDraft {
  return {
    name: 'temp-cleaner',
    code: 'export const name = "temp-cleaner"\nexport function apply(ctx) {}',
    notes: '',
    dependencies: {},
    mode: 'native',
    kind: 'cleaner',
    format: 'single-file',
    ...overrides,
  }
}

describe('需求与错误脱敏', () => {
  it('需求去首尾空白并截断超长输入，非字符串回空串', () => {
    expect(normalizeRequirement('  写一个 cleaner 插件  ')).toBe('写一个 cleaner 插件')
    expect(normalizeRequirement(42)).toBe('')
    expect(normalizeRequirement('x'.repeat(MAX_REQUIREMENT_LENGTH + 100))).toHaveLength(MAX_REQUIREMENT_LENGTH)
  })

  it('错误信息脱敏：隐藏 Key / Bearer / 本地绝对路径，并截断超长文本', () => {
    const text = sanitizeErrorMessage(
      '401 Unauthorized: key sk-abcdef123456, file C:\\Users\\alice\\secret\\KEY.txt, Bearer abcdefghijkl',
    )
    expect(text).not.toContain('sk-abcdef123456')
    expect(text).not.toContain('C:\\Users')
    expect(text).not.toContain('abcdefghijkl')
    expect(text).toContain('<本地路径>')
    expect(sanitizeErrorMessage('普通错误：接口返回 500')).toBe('普通错误：接口返回 500')
    expect(sanitizeErrorMessage('错误'.repeat(1_000)).length).toBeLessThanOrEqual(281)
  })
})

describe('生成失败归因', () => {
  it('截断 / JSON 非法 / 校验失败 / 凭据 / 超时 / 网络 / 未启用 / 未知都能归类', () => {
    expect(classifyWorkshopFailure('输出被截断（length）').kind).toBe('truncated')
    expect(classifyWorkshopFailure('接口返回的不是 JSON（HTTP 200）').kind).toBe('invalid-json')
    expect(classifyWorkshopFailure('上一次生成的插件代码未通过静态契约检查').kind).toBe('validation')
    expect(classifyWorkshopFailure(new Error('还没有配置 API Key')).kind).toBe('auth')
    expect(classifyWorkshopFailure('请求超时').kind).toBe('timeout')
    expect(classifyWorkshopFailure('与内核的连接已断开').kind).toBe('network')
    expect(classifyWorkshopFailure('「AI 插件工坊」插件未启用：请在插件页启用它').kind).toBe('plugin-disabled')
    expect(classifyWorkshopFailure('模型没有返回有效的插件代码').kind).toBe('empty-output')
    expect(classifyWorkshopFailure('任意未知故障').kind).toBe('unknown')
    expect(classifyWorkshopFailure('随便什么错误', { cancelled: true }).kind).toBe('cancelled')

    // 未知失败保留脱敏详情；已知失败给出重试与下一步动作
    const unknown = classifyWorkshopFailure(new Error('未知错误 sk-secret123456 C:\\private\\a.log'))
    expect(unknown.kind).toBe('unknown')
    expect(unknown.detail).not.toContain('sk-secret123456')
    expect(unknown.detail).not.toContain('C:\\private')
    expect(unknown.retryable).toBe(true)
    const auth = classifyWorkshopFailure('HTTP 401：invalid api key')
    expect(auth.retryable).toBe(false)
    expect(auth.actions).toContain('settings')
    const truncated = classifyWorkshopFailure('输出被截断（length）')
    expect(truncated.actions).toContain('retry')
    expect(truncated.hint).toContain('token')
  })
})

describe('生成阶段', () => {
  it('按宿主 phase 映射阶段，done 时全部完成', () => {
    const streaming = generationStageView({ busy: true, phase: 'streaming', textLength: 1_234, toolCalls: 2, elapsedSeconds: 12 })
    expect(streaming.activeIndex).toBe(1)
    expect(streaming.headline).toContain('1,234')
    expect(streaming.headline).toContain('2 个工具调用')
    expect(streaming.stages.map((stage) => stage.state)).toEqual(['done', 'active', 'todo', 'todo'])
    expect(generationStageView({ busy: true, phase: 'received', elapsedSeconds: 20 }).activeIndex).toBe(2)
    expect(generationStageView({ busy: true, phase: 'validating', elapsedSeconds: 25 }).headline).toContain('校验')
    expect(generationStageView({ busy: true, phase: 'retry', elapsedSeconds: 30 }).activeIndex).toBe(1)
    const done = generationStageView({ busy: true, phase: 'done', elapsedSeconds: 40 })
    expect(done.activeIndex).toBe(3)
    expect(done.finished).toBe(true)
    expect(done.percent).toBe(100)
    expect(done.stages.every((stage) => stage.state === 'done')).toBe(true)
  })

  it('未知 phase 按耗时兜底；未开始时不给假进度', () => {
    expect(generationStageView({ busy: true, phase: 'mystery', elapsedSeconds: 2 }).activeIndex).toBe(0)
    expect(generationStageView({ busy: true, phase: 'mystery', elapsedSeconds: 20 }).activeIndex).toBe(1)
    const slow = generationStageView({ busy: true, elapsedSeconds: 100 })
    expect(slow.activeIndex).toBe(2)
    expect(slow.headline).toContain('放弃')
    const idle = generationStageView({ busy: false, phase: 'streaming', elapsedSeconds: 50 })
    expect(idle.activeIndex).toBe(-1)
    expect(idle.percent).toBe(0)
    expect(idle.stages.every((stage) => stage.state === 'todo')).toBe(true)
  })
})

describe('草稿历史（本地持久化）', () => {
  it('快照：空需求/无效草稿丢弃，超长文件不持久化，合法草稿归一化', () => {
    expect(draftToSnapshot('', draft(), 1)).toBeUndefined()
    expect(draftToSnapshot('需求', null, 1)).toBeUndefined()
    expect(draftToSnapshot('需求', { name: 'x', code: '   ' }, 1)).toBeUndefined()
    expect(draftToSnapshot('需求', draft({ code: 'x'.repeat(MAX_DRAFT_FILE_CHARS + 10) }), 1)).toBeUndefined()
    const snapshot = draftToSnapshot('  写一个临时文件清理插件 ', draft(), 1_700_000_000_000)
    expect(snapshot?.requirement).toBe('写一个临时文件清理插件')
    expect(snapshot?.draft.name).toBe('temp-cleaner')
    expect(snapshot?.id).toMatch(/^draft-[0-9a-f]{8}$/)
  })

  it('序列化/解析容错：坏 JSON、垃圾条目只跳过自身、兼容旧数组格式', () => {
    expect(parseDraftHistory(null)).toEqual([])
    expect(parseDraftHistory('not-json')).toEqual([])
    expect(parseDraftHistory('{"items":"bad"}')).toEqual([])
    const first = draftToSnapshot('需求一', draft({ name: 'one', code: 'export function apply(ctx) {}\n// one' }), 1_000)!
    const second = draftToSnapshot('需求二', draft({ name: 'two', code: 'export function apply(ctx) {}\n// two' }), 2_000)!
    const parsed = parseDraftHistory(serializeDraftHistory([first, second]))
    expect(parsed.map((item) => item.requirement)).toEqual(['需求二', '需求一'])
    const mixed = JSON.stringify({
      version: 1,
      items: [{ requirement: '坏条目', draft: 'nope' }, JSON.parse(JSON.stringify(second))],
    })
    expect(parseDraftHistory(mixed).map((item) => item.requirement)).toEqual(['需求二'])
    expect(parseDraftHistory(JSON.stringify([JSON.parse(JSON.stringify(first))]))).toHaveLength(1)
  })

  it('追加历史：同一需求去重保留最新，最多保留上限条数', () => {
    let history: ReturnType<typeof appendDraftHistory> = []
    for (let index = 0; index < MAX_DRAFT_HISTORY + 3; index++) {
      const snapshot = draftToSnapshot(`需求 ${index}`, draft({ code: `export function apply(ctx) {}\n// ${index}` }), 1_000 + index)!
      history = appendDraftHistory(history, snapshot)
    }
    expect(history).toHaveLength(MAX_DRAFT_HISTORY)
    expect(history[0].requirement).toBe(`需求 ${MAX_DRAFT_HISTORY + 2}`)
    const newer = draftToSnapshot(
      `需求 ${MAX_DRAFT_HISTORY + 2}`,
      draft({ name: 'newer', code: 'export function apply(ctx) {}\n// newer' }),
      9_999,
    )!
    const deduped = appendDraftHistory(history, newer)
    expect(deduped.filter((item) => item.requirement === `需求 ${MAX_DRAFT_HISTORY + 2}`)).toHaveLength(1)
    expect(deduped.find((item) => item.requirement === `需求 ${MAX_DRAFT_HISTORY + 2}`)?.draft.name).toBe('newer')
  })

  it('恢复草稿是独立副本；历史列表给出文件数/体积/依赖数', () => {
    const snapshot = draftToSnapshot(
      '带页面的插件需求',
      draft({
        dependencies: { 'tiny-invariant': '^1.3.0' },
        files: [
          { path: 'index.mjs', content: 'export function apply(ctx) {}' },
          { path: 'client/index.html', content: '<p>hi</p>' },
        ],
        format: 'package',
      }),
      5_000,
    )!
    expect(snapshot.draft.dependencies).toEqual({ 'tiny-invariant': '^1.3.0' })
    const restored = materializeSnapshot(snapshot)!
    expect(restored.requirement).toBe('带页面的插件需求')
    restored.draft.code = 'changed'
    expect(snapshot.draft.code).not.toBe('changed')
    const items = draftHistoryItems([snapshot])
    expect(items[0]).toMatchObject({ name: 'temp-cleaner', kind: 'cleaner', fileCount: 2, dependencyCount: 1 })
    expect(items[0].totalBytes).toBeGreaterThan(0)
    expect(items[0].requirement.length).toBeLessThanOrEqual(64)
    expect(materializeSnapshot({ ...snapshot, draft: { ...snapshot.draft, name: '' } })).toBeTruthy()
  })
})

describe('安装前校验摘要', () => {
  it('错误按闸门归类，失败数量/危险 API/原始信息齐全', () => {
    const summary = summarizeValidation({
      validation: {
        ok: false,
        errors: [
          '清单校验失败：id 必须是小写',
          '入口源码：禁止使用 child_process（不能起子进程）',
          '缺少客户端页面：client/index.html',
          '插件包没有任何文件',
          '依赖 foo 的版本必须是 semver 范围',
          '一个无法归类的问题',
        ],
        warnings: ['建议 export const description'],
      },
      risky: [{ id: 'child-process', level: 'danger', label: '子进程 / shell', hint: '会被拦截' }],
    })
    expect(summary.status).toBe('failed')
    expect(summary.failedGates).toBe(6)
    expect(summary.gates).toHaveLength(6)
    expect(summary.gates.find((gate) => gate.id === 'manifest')?.ok).toBe(false)
    expect(summary.gates.find((gate) => gate.id === 'manifest')?.errors[0]).toContain('清单校验失败')
    expect(summary.gates.find((gate) => gate.id === 'client')?.errors[0]).toContain('客户端页面')
    expect(summary.gates.find((gate) => gate.id === 'entry')?.errors).toHaveLength(1)
    expect(summary.gates.find((gate) => gate.id === 'other')?.errors[0]).toContain('无法归类')
    expect(summary.risky).toHaveLength(1)
    expect(summary.warningCount).toBe(1)
    expect(summary.headline).toContain('校验未通过')
  })

  it('通过 / 重新校验中 / 未校验的文案区分清楚', () => {
    const passed = summarizeValidation({ validation: { ok: true, errors: [], warnings: [] } })
    expect(passed.status).toBe('passed')
    expect(passed.failedGates).toBe(0)
    expect(passed.gates.every((gate) => gate.ok)).toBe(true)
    expect(passed.headline).toContain('全部通过')
    expect(summarizeValidation({ validation: { ok: true, warnings: ['有提示'] }, validating: true }).headline).toContain('1 条提示')
    const pending = summarizeValidation({ validation: null, validating: true })
    expect(pending.status).toBe('pending')
    expect(pending.headline).toContain('正在重新校验')
    expect(summarizeValidation({}).status).toBe('idle')
  })

  it('危险 API 扫描：区分阻断项与提示项，空输入不报错', () => {
    const hits = scanRiskyApis('const cp = require("child_process"); fetch("https://x"); if (process.env.A) {}')
    expect(hits.map((hit) => hit.id)).toEqual(['child-process', 'network', 'process-env'])
    expect(hits.find((hit) => hit.id === 'process-env')?.level).toBe('warn')
    expect(scanRiskyApis([])).toEqual([])
    expect(scanRiskyApis('export function apply(ctx) {}')).toEqual([])
  })
})

describe('按钮门禁', () => {
  it('生成按钮：按优先级给出第一个可读原因', () => {
    expect(generateGate({ busy: false, installing: false, requirement: '写个插件', available: true, configured: true })).toEqual({ ok: true })
    expect(generateGate({ busy: false, installing: true, requirement: 'x', available: true, configured: true }).reason).toContain('安装')
    expect(generateGate({ busy: true, installing: false, requirement: 'x', available: true, configured: true }).reason).toContain('生成中')
    expect(generateGate({ busy: false, installing: false, requirement: '   ', available: true, configured: true }).reason).toContain('描述')
    expect(generateGate({ busy: false, installing: false, requirement: 'x', available: false, configured: false }).reason).toContain('未启用')
    expect(generateGate({ busy: false, installing: false, requirement: 'x', available: true, configured: false }).reason).toContain('API')
  })

  it('安装按钮：校验/新鲜度/勾选/依赖任一缺失都给出原因', () => {
    const base = {
      hasDraft: true,
      validationStatus: 'passed' as const,
      validationFresh: true,
      manifestError: '',
      reviewed: true,
      installing: false,
      dependencyCount: 0,
      dependenciesAccepted: false,
    }
    expect(installGate(base)).toEqual({ ok: true })
    expect(installGate({ ...base, hasDraft: false }).reason).toContain('先生成')
    expect(installGate({ ...base, manifestError: 'bad json' }).reason).toContain('JSON')
    expect(installGate({ ...base, validationStatus: 'pending' }).reason).toContain('校验')
    expect(installGate({ ...base, validationStatus: 'failed' }).reason).toContain('校验未通过')
    expect(installGate({ ...base, validationFresh: false }).reason).toContain('重新校验')
    expect(installGate({ ...base, reviewed: false }).reason).toContain('阅读')
    expect(installGate({ ...base, dependencyCount: 2 }).reason).toContain('依赖')
  })

  it('准备状态：状态未知/未启用/未配置/无模型分别引导，齐全即就绪', () => {
    const unknown = workshopReadiness({
      statusLoading: false,
      statusKnown: false,
      statusError: '与内核的连接已断开',
      available: false,
      configured: false,
    })
    expect(unknown.ready).toBe(false)
    expect(unknown.blockers[0]).toMatchObject({ id: 'status', action: 'refresh' })
    expect(workshopReadiness({ statusLoading: true, statusKnown: false, available: false, configured: false }).blockers).toEqual([])
    const disabled = workshopReadiness({ statusLoading: false, statusKnown: true, available: false, configured: false })
    expect(disabled.blockers[0]).toMatchObject({ id: 'plugin', action: 'enable' })
    const unconfigured = workshopReadiness({ statusLoading: false, statusKnown: true, available: true, configured: false })
    expect(unconfigured.blockers[0]).toMatchObject({ id: 'api-key', action: 'settings' })
    const noModel = workshopReadiness({ statusLoading: false, statusKnown: true, available: true, configured: true, model: '  ' })
    expect(noModel.blockers[0].id).toBe('model')
    const ready = workshopReadiness({
      statusLoading: false,
      statusKnown: true,
      available: true,
      configured: true,
      model: 'deepseek-flash',
      keySource: '工坊配置',
    })
    expect(ready.ready).toBe(true)
    expect(ready.headline).toContain('准备就绪')
  })
})
