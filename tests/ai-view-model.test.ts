/**
 * AI 清理顾问页展示模型单测：
 * 引导态、分析门禁、错误分类与脱敏、建议聚合、批量选择、扫描根分级、页面阶段。
 */
import { describe, expect, it } from 'vitest'
import {
  UNASSIGNED_TASK_KEY,
  aiSetupGuide,
  aiViewPhase,
  analyzeGate,
  buildRootSuggestionPlan,
  buildSelectionPlan,
  buildSelectionRows,
  classifyAiError,
  classifyRootSuggestion,
  describeStreamActivity,
  filterSuggestions,
  formatBytesText,
  isBroadRoot,
  normalizeRootPath,
  redactSensitiveText,
  selectedRootTargets,
  selectableSelectionIds,
  selectionConfirmSummary,
  summarizeSuggestions,
  toggleSelectionIds,
} from '../packages/ui/src/views/ai-view-model.ts'

const baseSetup = {
  available: true,
  configured: true,
  onlineAi: true,
  model: 'deepseek-flash',
  modelIds: ['deepseek-flash'],
}

describe('引导态（未启用 / 隐私关闭 / 缺 Key / 缺模型 / 探测失败 / 自定义模型）', () => {
  it('阻断项按顺序给出原因和主操作', () => {
    const disabled = aiSetupGuide({ ...baseSetup, available: false })
    expect(disabled.state).toBe('plugin-disabled')
    expect(disabled.blocking).toBe(true)
    expect(disabled.actions[0]).toMatchObject({ id: 'enable-plugin', label: '立即启用', primary: true })

    const privacy = aiSetupGuide({ ...baseSetup, onlineAi: false, configured: false })
    expect(privacy.state).toBe('privacy-blocked')
    expect(privacy.blocking).toBe(true)
    expect(privacy.tone).toBe('error')
    expect(privacy.actions.map((action) => action.id)).toEqual(['open-settings', 'open-egress'])
    expect(privacy.message).toContain('隐私')

    const noKey = aiSetupGuide({ ...baseSetup, configured: false })
    expect(noKey.state).toBe('missing-key')
    expect(noKey.blocking).toBe(true)
    expect(noKey.actions[0].id).toBe('fill-key')

    const noModel = aiSetupGuide({ ...baseSetup, model: '   ' })
    expect(noModel.state).toBe('missing-model')
    expect(noModel.blocking).toBe(true)
    expect(noModel.actions[0].id).toBe('change-model')
  })

  it('非阻断提示：探测失败优先于自定义模型，就绪时不带动作', () => {
    const probeFailed = aiSetupGuide({ ...baseSetup, probe: { ok: false, error: 'HTTP 401：invalid api key' } })
    expect(probeFailed.state).toBe('probe-failed')
    expect(probeFailed.blocking).toBe(false)
    expect(probeFailed.actions[0].id).toBe('fill-key')

    const custom = aiSetupGuide({ ...baseSetup, model: 'my-model', modelIds: ['deepseek-flash'] })
    expect(custom.state).toBe('model-custom')
    expect(custom.blocking).toBe(false)
    expect(custom.actions[0].id).toBe('change-model')

    const ready = aiSetupGuide(baseSetup)
    expect(ready.state).toBe('ready')
    expect(ready.blocking).toBe(false)
    expect(ready.actions).toEqual([])
  })
})

describe('开始分析门禁', () => {
  it('逐项给出不可用原因，全部满足才放行', () => {
    expect(analyzeGate({ available: false, configured: false, onlineAi: true, running: false })).toEqual({
      ok: false,
      reason: 'AI 插件未启用，请先启用',
    })
    expect(analyzeGate({ available: true, configured: false, onlineAi: true, running: false }).reason).toContain('API Key')
    expect(analyzeGate({ available: true, configured: true, onlineAi: false, running: false }).reason).toContain('在线 AI')
    expect(analyzeGate({ available: true, configured: true, onlineAi: true, running: true }).reason).toContain('正在分析')
    expect(analyzeGate({ available: true, configured: true, onlineAi: true, running: false, saving: true }).reason).toContain('保存')
    expect(analyzeGate({ available: true, configured: true, onlineAi: true, running: false })).toEqual({ ok: true })
  })
})

describe('错误分类与脱敏（不泄露 Key / token / 真实路径由页面负责）', () => {
  it('脱敏 Key、Bearer、环境变量与 URL token，同时不误伤正常提示', () => {
    const raw =
      'HTTP 401：invalid api key sk-abcdefghijk12345；Authorization: Bearer abcdefghijklmnop；' +
      'https://api.example.com/v1?token=s3cr3t&x=1；DEEPSEEK_API_KEY=sk-zzzzzzzzzzzz'
    const text = redactSensitiveText(raw)
    expect(text).not.toContain('abcdefghijk12345')
    expect(text).not.toContain('sk-zzzzzzzz')
    expect(text).not.toContain('s3cr3t')
    expect(text).not.toContain('abcdefghijklmnop')
    expect(text).toContain('***')
    expect(redactSensitiveText('未配置 API Key：请在设置中填写')).toContain('未配置 API Key')
    expect(redactSensitiveText(undefined)).toBe('')
  })

  it('缺 Key / 鉴权 / 隐私拦截分类', () => {
    const noKey = classifyAiError('未配置 API Key：请在「接口设置」中填写，或设置环境变量 DEEPSEEK_API_KEY / OPENAI_API_KEY')
    expect(noKey.kind).toBe('missing-key')
    expect(noKey.actions[0].id).toBe('fill-key')
    expect(noKey.retryable).toBe(true)

    const auth = classifyAiError('HTTP 401：invalid api key "sk-live-0123456789"')
    expect(auth.kind).toBe('auth')
    expect(auth.detail).not.toContain('sk-live-0123456789')
    expect(auth.actions.map((action) => action.id)).toContain('fill-key')

    const privacy = classifyAiError('在线 AI 已在设置中关闭（隐私开关）')
    expect(privacy.kind).toBe('privacy')
    expect(privacy.actions[0].id).toBe('open-settings')
  })

  it('超时 / 取消 / 截断 / 非法 JSON / 无最终答案分类', () => {
    expect(classifyAiError('请求超时（超过 90000 ms）').kind).toBe('timeout')
    expect(classifyAiError('请求超时（超过 90000 ms）', { cancelled: true }).kind).toBe('cancelled')
    expect(classifyAiError('输出被截断（length），请调大「最大输出 token」后重试').kind).toBe('truncated')
    expect(classifyAiError('模型输出不是合法 JSON：模型输出中没有 JSON 对象').kind).toBe('invalid-json')
    expect(classifyAiError('模型没有返回最终答案（可能只输出了思维链）').kind).toBe('no-answer')
    const truncated = classifyAiError('输出被截断（length）')
    expect(truncated.actions.map((action) => action.id)).toContain('increase-tokens')
    const json = classifyAiError('模型输出不是合法 JSON')
    expect(json.actions[0].id).toBe('retry')
  })

  it('限流 / 服务端 / 请求参数 / 网络 / 未知错误分类', () => {
    expect(classifyAiError('HTTP 429：rate limit exceeded').kind).toBe('rate-limit')
    expect(classifyAiError('HTTP 503：Service Unavailable').kind).toBe('server')
    expect(classifyAiError('HTTP 400：invalid model').kind).toBe('bad-request')
    expect(classifyAiError('网络请求失败：fetch failed').kind).toBe('network')
    expect(classifyAiError('当前模型不支持图片输入').retryable).toBe(false)
    expect(classifyAiError('图片过大（base64 超过 4MB），请压缩后再试').kind).toBe('image-too-large')
    const unknown = classifyAiError('boom')
    expect(unknown.kind).toBe('unknown')
    expect(unknown.retryable).toBe(true)
    expect(unknown.actions[0].id).toBe('retry')
  })
})

describe('建议结果聚合与筛选', () => {
  const items = [
    { id: 'a', risk: 'safe', taskId: 't1', estimatedBytes: 1000, confidence: 0.9 },
    { id: 'b', risk: 'caution', taskId: 't1', estimatedBytes: 2000, confidence: 0.4 },
    { id: 'c', risk: 'risky', taskId: 't2', estimatedBytes: 3000 },
    { id: 'd', risk: 'safe' },
  ]

  it('按风险与任务统计数量/体积，未关联任务排最后', () => {
    const summary = summarizeSuggestions(items)
    expect(summary.total).toBe(4)
    expect(summary.bytes).toBe(6000)
    expect(summary.riskCounts).toEqual({ safe: 2, caution: 1, risky: 1 })
    expect(summary.riskBytes).toEqual({ safe: 1000, caution: 2000, risky: 3000 })
    expect(summary.riskyCount).toBe(1)
    expect(summary.lowConfidenceCount).toBe(1)
    expect(summary.taskCount).toBe(3)
    expect(summary.byTask.map((group) => group.key)).toEqual(['t1', 't2', UNASSIGNED_TASK_KEY])
    expect(summary.byTask[0]).toMatchObject({ count: 2, bytes: 3000, riskyCount: 0 })
    expect(summary.byTask[0].bytes).toBe(summary.byTask[1].bytes)
    expect(summarizeSuggestions([])).toMatchObject({ total: 0, bytes: 0, taskCount: 0, byTask: [] })
  })

  it('脏数据容错：未知风险按谨慎、非法字节按 0；筛选按风险/任务组合', () => {
    const dirty = summarizeSuggestions([
      { risk: 'wat', estimatedBytes: Number.NaN },
      { risk: 'safe', estimatedBytes: -5, confidence: 0.99 },
    ] as never)
    expect(dirty.total).toBe(2)
    expect(dirty.bytes).toBe(0)
    expect(dirty.riskCounts.caution).toBe(1)
    expect(dirty.lowConfidenceCount).toBe(0)

    expect(filterSuggestions(items, { risk: 'safe', task: 'all' }).map((item) => item.id)).toEqual(['a', 'd'])
    expect(filterSuggestions(items, { risk: 'all', task: 't1' }).map((item) => item.id)).toEqual(['a', 'b'])
    expect(filterSuggestions(items, { risk: 'all', task: UNASSIGNED_TASK_KEY }).map((item) => item.id)).toEqual(['d'])
  })
})

describe('清理项批量选择', () => {
  const entries = [
    { itemId: 'i1', reason: '临时缓存' },
    { itemId: 'i2' },
    { itemId: 'i3' },
    { itemId: 'gone' },
    { itemId: 'i1', reason: '重复项' },
  ]
  const scanItems = [
    { id: 'i1', path: 'C:\\Temp\\a', size: 100, taskId: 't1', risk: 'safe' },
    { id: 'i2', path: 'C:\\Temp\\b', size: 0, taskId: 't1', risk: 'safe' },
    { id: 'i3', path: 'C:\\Windows', size: 500, taskId: 't2', risk: 'risky', protected: true },
  ]

  it('连接扫描结果：失效 / 受保护 / 0 字节不可选，重复 id 去重', () => {
    const rows = buildSelectionRows(entries, scanItems)
    expect(rows.map((row) => row.id)).toEqual(['i1', 'i2', 'i3', 'gone'])
    expect(rows[0]).toMatchObject({ path: 'C:\\Temp\\a', size: 100, taskId: 't1', selectable: true, missing: false })
    expect(rows[1].selectable).toBe(false)
    expect(rows[2]).toMatchObject({ protected: true, selectable: false })
    expect(rows[3]).toMatchObject({ missing: true, selectable: false })
    expect(selectableSelectionIds(rows)).toEqual(['i1'])
    expect(toggleSelectionIds(['i1'], 'i1', true)).toEqual(['i1'])
    expect(toggleSelectionIds(['i1'], 'i1', false)).toEqual([])
  })

  it('选择计划剔除不可选 / 未勾选项，摘要说清体积、未勾选、风险与失效', () => {
    const rows = buildSelectionRows(entries, scanItems)
    const plan = buildSelectionPlan(rows, ['i1', 'i2', 'i3', 'gone', 'not-exist'])
    expect(plan.selectedIds).toEqual(['i1'])
    expect(plan.selectedCount).toBe(1)
    expect(plan.selectedBytes).toBe(100)
    expect(plan.riskCounts).toEqual({ safe: 1, caution: 0, risky: 0 })
    expect(plan.missingCount).toBe(1)
    expect(plan.protectedCount).toBe(1)
    expect(plan.summary).toContain('已选 1 项')
    expect(plan.summary).toContain('0 B')
    expect(plan.summary).toContain('不会处理')
    expect(plan.summary).toContain('受保护')

    const empty = buildSelectionPlan(rows, [])
    expect(empty.selectedCount).toBe(0)
    expect(empty.summary).toBe(selectionConfirmSummary(empty))
    expect(empty.summary).toContain('没有可清理的选中项')
    const selectableOnly = buildSelectionPlan(rows.filter((row) => row.selectable), [])
    expect(selectableOnly.summary).toContain('尚未勾选')
    const noneAvailable = buildSelectionPlan(rows.filter((row) => !row.selectable), [])
    expect(noneAvailable.summary).toContain('没有可清理的选中项')
    expect(formatBytesText(1536)).toBe('1.50 KB')
  })
})

describe('扫描根建议分级（安全边界不放松）', () => {
  const items = [
    { path: 'C:\\Users\\me\\.gradle', reason: '构建缓存', sizeBytes: 1024 },
    { path: 'C:\\Users\\me\\AppData', reason: '应用数据', sizeBytes: 2048 },
    { path: 'C:\\', reason: '整盘', sizeBytes: 0 },
    { path: 'C:\\Users\\me\\Downloads\\', reason: '下载目录', sizeBytes: 4096 },
    { path: 'c:/users/me/.gradle/', reason: '重复项' },
  ]

  it('推荐 / 宽目录 / 盘符根 / 已在范围四级判定', () => {
    expect(normalizeRootPath('c:/users/me/.gradle/')).toBe('c:\\users\\me\\.gradle')
    expect(normalizeRootPath('C:\\')).toBe('C:')
    expect(isBroadRoot('C:\\Users\\me\\AppData')).toBe(true)
    expect(isBroadRoot('C:\\Windows')).toBe(true)
    expect(isBroadRoot('C:\\Users\\me\\.gradle')).toBe(false)

    expect(classifyRootSuggestion('C:\\Users\\me\\AppData')).toMatchObject({
      level: 'broad',
      broad: true,
      defaultSelected: false,
      selectable: true,
    })
    expect(classifyRootSuggestion('C:\\')).toMatchObject({ level: 'drive-root', selectable: false, defaultSelected: false })
    expect(classifyRootSuggestion('C:\\Users\\me\\Downloads', ['c:\\users\\me\\downloads'])).toMatchObject({
      level: 'configured',
      selectable: false,
      defaultSelected: false,
    })
    expect(classifyRootSuggestion('C:\\Users\\me\\.gradle')).toMatchObject({
      level: 'recommended',
      selectable: true,
      defaultSelected: true,
    })
  })

  it('计划默认只勾推荐目录；添加目标剔除盘符根、已在范围与重复项', () => {
    const plan = buildRootSuggestionPlan(items, [])
    expect(plan.summary.total).toBe(4)
    expect(plan.summary.recommendedCount).toBe(1)
    expect(plan.summary.broadCount).toBe(2)
    expect(plan.summary.driveRootCount).toBe(1)
    expect(plan.summary.selectableCount).toBe(3)
    expect(plan.summary.defaultSelectedPaths).toEqual(['C:\\Users\\me\\.gradle'])

    const configuredPlan = buildRootSuggestionPlan(items, ['C:\\Users\\me\\.gradle'])
    expect(configuredPlan.summary.configuredCount).toBe(1)
    expect(configuredPlan.summary.defaultSelectedPaths).toEqual([])

    const targets = selectedRootTargets(plan.items, [
      'C:\\Users\\me\\.gradle',
      'C:\\',
      'C:\\Users\\me\\AppData',
      'c:/users/me/downloads/',
      'C:\\Users\\me\\.gradle',
    ])
    expect(targets.map((item) => item.path)).toEqual(['C:\\Users\\me\\.gradle', 'C:\\Users\\me\\AppData', 'C:\\Users\\me\\Downloads'])
  })
})

describe('页面阶段与流式活动', () => {
  it('阶段：插件禁用 / 需配置 / 分析中 / 失败 / 就绪，有结果优先展示', () => {
    const base = { available: true, configured: true, onlineAi: true, busy: false, hasAnalysis: false, hasError: false }
    expect(aiViewPhase({ ...base, available: false })).toBe('plugin-disabled')
    expect(aiViewPhase({ ...base, configured: false })).toBe('needs-setup')
    expect(aiViewPhase({ ...base, onlineAi: false })).toBe('needs-setup')
    expect(aiViewPhase({ ...base, busy: true })).toBe('analyzing')
    expect(aiViewPhase({ ...base, hasError: true })).toBe('failed')
    expect(aiViewPhase({ ...base, hasAnalysis: true })).toBe('ready')
    expect(aiViewPhase({ ...base, hasAnalysis: true, hasError: true })).toBe('ready')
  })

  it('流式活动文案包含字符数、思维链与用时', () => {
    expect(describeStreamActivity({ textChars: 0 })).toBe('已接收 0 字符')
    expect(describeStreamActivity({ textChars: 1234, reasoningChars: 56, elapsedSeconds: 65 })).toBe(
      '已接收 1234 字符 · 思维链 56 字符 · 已用时 1 分 5 秒',
    )
    expect(describeStreamActivity({ textChars: -1, elapsedSeconds: Number.NaN })).toBe('已接收 0 字符')
  })
})
