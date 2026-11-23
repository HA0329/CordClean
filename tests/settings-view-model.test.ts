/**
 * 设置页展示模型单测：分组索引、设置快照容错、脏状态、默认值来源、
 * 恢复默认预览、危险项评估、保存失败归因与分组搜索。
 */
import { describe, expect, it } from 'vitest'
import {
  SETTINGS_FIELDS,
  SETTINGS_GROUPS,
  SHIPPED_DEFAULT_FORM,
  assessSettingRisks,
  buildFieldStatuses,
  describeEmptyFilter,
  describeRiskConfirm,
  describeSaveFailure,
  diffFormValues,
  displayFieldValue,
  fieldStatusFor,
  filterSettingsGroups,
  formValues,
  normalizeFormSnapshot,
  previewResetDefaults,
  resetFormValues,
  riskEscalations,
  saveGate,
  saveSuccessMessage,
  settingsFormSnapshot,
  settingsPagePhase,
  summarizeSettingsStatus,
} from '../packages/ui/src/views/settings-view-model.ts'

const GB = 1024 ** 3
const MB = 1024 ** 2

describe('分组与字段索引', () => {
  it('每个可跟踪字段都能归属到分组，搜索索引包含字段名', () => {
    for (const field of SETTINGS_FIELDS) {
      const group = SETTINGS_GROUPS.find((item) => item.id === field.group)
      expect(group, `${field.key} 的分组 ${field.group} 不存在`).toBeDefined()
      expect(group?.entries).toContain(field.label)
    }
    expect(new Set(SETTINGS_FIELDS.map((field) => field.key)).size).toBe(SETTINGS_FIELDS.length)
  })
})

describe('设置快照容错', () => {
  it('把内核嵌套设置映射为扁平表单，字节按页面精度换算', () => {
    const snapshot = settingsFormSnapshot({
      clean: {
        mode: 'delete',
        highRiskQuarantine: false,
        quarantineFallback: true,
        dryRunDefault: true,
        confirmRisky: false,
        retries: 1,
        budget: { maxFiles: 1234, maxBytes: 3 * GB },
      },
      scan: { concurrency: 8, maxItemsPerTask: 100, maxEntriesPerTask: 5000, maxDepth: 64, largeFileThreshold: 512 * MB, duplicateMinSize: 4 * MB },
      rules: { includeRisky: true, includeDeep: true, includeCustom: false },
      quarantine: { enabled: false, maxBytes: 128 * MB, maxFiles: 10, retentionDays: 7 },
      analysis: { roots: [' D:\\Videos ', 7, 'D:\\Videos'], excludes: ['C:\\Temp'], includeSystem: false },
      privacy: { onlineAi: false },
      ui: { editorCommand: 'code' },
      version: 1,
    })
    expect(snapshot.cleanMode).toBe('delete')
    expect(snapshot.budgetFiles).toBe(1234)
    expect(snapshot.budgetGb).toBe(3)
    expect(snapshot.largeFileThresholdMb).toBe(512)
    expect(snapshot.quarantineMaxMb).toBe(128)
    expect(snapshot.roots).toEqual(['D:\\Videos'])
    expect(snapshot.editorCommand).toBe('code')
    expect(snapshot.includeSystem).toBe(false)
  })

  it('坏输入回退默认值而不抛错', () => {
    expect(settingsFormSnapshot(null)).toEqual(SHIPPED_DEFAULT_FORM)
    expect(settingsFormSnapshot('nope')).toEqual(SHIPPED_DEFAULT_FORM)
    expect(normalizeFormSnapshot({ concurrency: Number.NaN, roots: 'x', cleanMode: 'nope' })).toMatchObject({
      concurrency: SHIPPED_DEFAULT_FORM.concurrency,
      roots: [],
      cleanMode: 'recycle',
    })
    const broken = settingsFormSnapshot({
      clean: { mode: 'unknown', budget: { maxFiles: 'bad', maxBytes: Number.POSITIVE_INFINITY } },
      scan: { concurrency: '8' },
      analysis: { roots: 'not-array' },
      quarantine: { maxBytes: -1 },
    })
    expect(broken.cleanMode).toBe('recycle')
    expect(broken.budgetFiles).toBe(SHIPPED_DEFAULT_FORM.budgetFiles)
    expect(broken.concurrency).toBe(8)
    expect(broken.roots).toEqual([])
    expect(broken.quarantineMaxMb).toBe(0)
  })

  it('规范化值表把坏数字当成默认值参与比较', () => {
    expect(formValues({ concurrency: Number.NaN }).concurrency).toBe(String(SHIPPED_DEFAULT_FORM.concurrency))
    expect(formValues(undefined).roots).toBe('')
  })
})

describe('修改检测', () => {
  it('默认值快照与自身比较没有修改', () => {
    expect(diffFormValues(SHIPPED_DEFAULT_FORM, SHIPPED_DEFAULT_FORM)).toEqual([])
    expect(diffFormValues(SHIPPED_DEFAULT_FORM, settingsFormSnapshot(undefined))).toEqual([])
  })

  it('逐项给出字段名与可读的前后值', () => {
    const changes = diffFormValues({ ...SHIPPED_DEFAULT_FORM, cleanMode: 'delete', roots: ['D:\\Videos'] }, SHIPPED_DEFAULT_FORM)
    expect(changes.map((change) => change.key)).toEqual(['cleanMode', 'roots'])
    expect(changes[0]).toMatchObject({ label: '默认删除方式', from: '回收站（可还原）', to: '永久删除' })
    expect(changes[1]).toMatchObject({ label: '额外扫描根', from: '未添加', to: 'D:\\Videos' })
  })

  it('数组字段按顺序比较，顺序变化也算修改', () => {
    const saved = { ...SHIPPED_DEFAULT_FORM, excludes: ['a', 'b'] }
    const current = { ...SHIPPED_DEFAULT_FORM, excludes: ['b', 'a'] }
    expect(diffFormValues(current, saved).map((change) => change.key)).toEqual(['excludes'])
  })
})

describe('默认值来源', () => {
  it('默认 / 已保存自定义 / 未保存三态判定', () => {
    const saved = normalizeFormSnapshot({ ...SHIPPED_DEFAULT_FORM, cleanMode: 'delete' })
    const fresh = buildFieldStatuses(saved, saved)
    expect(fresh.cleanMode.origin).toBe('custom')
    expect(fresh.cleanMode.text).toBe('已自定义')
    expect(fresh.concurrency.origin).toBe('default')

    const dirty = buildFieldStatuses({ ...saved, concurrency: 8 }, saved)
    expect(dirty.concurrency.origin).toBe('unsaved')
    expect(dirty.concurrency.title).toContain('已修改但尚未保存')

    // 改回默认值但没保存：相对内核仍是脏状态
    const reverted = buildFieldStatuses({ ...saved, cleanMode: 'recycle' }, saved)
    expect(reverted.cleanMode.origin).toBe('unsaved')
    expect(reverted.cleanMode.title).toContain('已改回默认值')
  })

  it('未知字段返回 undefined，不抛错', () => {
    expect(fieldStatusFor('nope', SHIPPED_DEFAULT_FORM, SHIPPED_DEFAULT_FORM)).toBeUndefined()
    expect(fieldStatusFor('cleanMode', { ...SHIPPED_DEFAULT_FORM, cleanMode: 'delete' }, SHIPPED_DEFAULT_FORM)?.origin).toBe('unsaved')
  })
})

describe('状态汇总', () => {
  it('汇总默认/自定义/未保存与分组风险数', () => {
    const saved = normalizeFormSnapshot({ ...SHIPPED_DEFAULT_FORM, cleanMode: 'delete' })
    const current = { ...saved, concurrency: 8 }
    const statuses = buildFieldStatuses(current, saved)
    const risks = assessSettingRisks(current)
    const summary = summarizeSettingsStatus(statuses, risks)
    expect(summary.customCount).toBe(1)
    expect(summary.unsavedCount).toBe(1)
    expect(summary.nonDefaultCount).toBe(2)
    expect(summary.groups.clean.customCount).toBe(1)
    expect(summary.groups.scan.unsavedCount).toBe(1)
    expect(summary.riskyCount).toBe(risks.length)
    expect(summary.dangerCount).toBe(risks.filter((risk) => risk.level === 'danger').length)
    expect(summary.groups.clean.riskCount).toBeGreaterThan(0)
  })
})

describe('恢复默认预览', () => {
  it('列出会改动的字段，且不包含自定义扫描范围/编辑器命令', () => {
    const current = {
      ...SHIPPED_DEFAULT_FORM,
      cleanMode: 'delete' as const,
      highRiskQuarantine: false,
      execute: undefined,
      roots: ['D:\\Videos'],
      excludes: ['C:\\Temp'],
      editorCommand: 'code',
    }
    const preview = previewResetDefaults(current)
    expect(preview.changes.map((change) => change.key)).toEqual(['cleanMode', 'highRiskQuarantine'])
    expect(preview.changes[0]).toMatchObject({ from: '永久删除', to: '回收站（可还原）' })
    expect(preview.alreadyDefault).toBe(preview.totalResetFields - preview.changes.length)
    expect(preview.untouchedFields).toEqual(expect.arrayContaining(['roots', 'excludes', 'editorCommand']))
    expect(preview.changes.some((change) => preview.untouchedFields.includes(change.key))).toBe(false)
  })

  it('已经是默认值时没有待改动项', () => {
    expect(previewResetDefaults(SHIPPED_DEFAULT_FORM).changes).toEqual([])
    expect(previewResetDefaults(SHIPPED_DEFAULT_FORM).alreadyDefault).toBe(previewResetDefaults(SHIPPED_DEFAULT_FORM).totalResetFields)
  })

  it('恢复默认写入值不包含范围与编辑器命令', () => {
    const values = resetFormValues()
    expect(values).toMatchObject({ cleanMode: 'recycle', highRiskQuarantine: true, includeRisky: false })
    expect(values).not.toHaveProperty('roots')
    expect(values).not.toHaveProperty('excludes')
    expect(values).not.toHaveProperty('editorCommand')
  })
})

describe('危险项评估', () => {
  it('默认设置没有风险', () => {
    expect(assessSettingRisks(SHIPPED_DEFAULT_FORM)).toEqual([])
    expect(assessSettingRisks(undefined)).toEqual([])
  })

  it('永久删除 / 关闭隔离区 / 启用高风险规则属于高风险', () => {
    const risks = assessSettingRisks({
      ...SHIPPED_DEFAULT_FORM,
      cleanMode: 'delete',
      quarantineEnabled: false,
      includeRisky: true,
      confirmRisky: false,
      includeDeep: true,
      roots: ['D:\\Videos', 'E:\\Backup'],
    })
    const ids = risks.map((risk) => risk.id)
    expect(ids).toEqual(expect.arrayContaining(['clean-mode-delete', 'quarantine-disabled', 'risky-rules-on', 'confirm-risky-off', 'deep-rules-on', 'custom-roots']))
    // 高风险项全部排在注意项前面
    const firstWarn = risks.findIndex((risk) => risk.level === 'warn')
    const lastDanger = risks.map((risk) => risk.level).lastIndexOf('danger')
    expect(lastDanger).toBeLessThan(firstWarn)
    expect(risks.find((risk) => risk.id === 'custom-roots')?.detail).toContain('D:\\Videos')
  })

  it('隔离区上限为 0 时给出注意项', () => {
    const risks = assessSettingRisks({ ...SHIPPED_DEFAULT_FORM, quarantineMaxFiles: 0 })
    expect(risks.map((risk) => risk.id)).toContain('quarantine-capacity-zero')
  })

  it('风险升级只统计本次新增的风险', () => {
    expect(riskEscalations({ ...SHIPPED_DEFAULT_FORM, cleanMode: 'delete' }, SHIPPED_DEFAULT_FORM).map((risk) => risk.id)).toEqual(['clean-mode-delete'])
    // 保存前已经是相同风险：不重复确认
    const saved = normalizeFormSnapshot({ ...SHIPPED_DEFAULT_FORM, cleanMode: 'delete' })
    expect(riskEscalations(saved, saved)).toEqual([])
    expect(riskEscalations({ ...SHIPPED_DEFAULT_FORM, includeDeep: true }, undefined).map((risk) => risk.id)).toEqual(['deep-rules-on'])
  })

  it('确认文案为空 / 包含风险标题与提示', () => {
    expect(describeRiskConfirm([])).toBe('')
    const text = describeRiskConfirm(assessSettingRisks({ ...SHIPPED_DEFAULT_FORM, cleanMode: 'delete' }))
    expect(text).toContain('默认删除方式为永久删除')
    expect(text).toContain('确定继续保存')
  })
})

describe('保存失败归因', () => {
  it('连接 / 校验 / 权限 / 磁盘 / 未知分别给出原因与建议', () => {
    const connection = describeSaveFailure(new Error('内核连接尚未建立'))
    expect(connection).toMatchObject({ kind: 'connection', retriable: true })
    expect(connection.hint).toContain('后台服务')

    const validation = describeSaveFailure(new Error('非法设置键：__proto__'))
    expect(validation.kind).toBe('validation')
    expect(validation.retriable).toBe(false)
    expect(validation.hint).toContain('没有写入')

    expect(describeSaveFailure({ message: 'EACCES: permission denied' }).kind).toBe('permission')
    expect(describeSaveFailure('磁盘空间不足（ENOSPC）').kind).toBe('storage')

    const unknown = describeSaveFailure(undefined)
    expect(unknown.kind).toBe('unknown')
    expect(unknown.reason).toContain('未知错误')
    expect(unknown.retriable).toBe(true)
  })

  it('错误消息清洗超长内容', () => {
    const info = describeSaveFailure(new Error('x'.repeat(800)))
    expect(info.reason.length).toBeLessThanOrEqual(301)
    expect(info.reason.endsWith('…')).toBe(true)
  })
})

describe('页面阶段与保存可用性', () => {
  it('三态判定：有数据优先正常，其次错误，最后加载', () => {
    expect(settingsPagePhase({ ready: true, hasSettings: true })).toBe('ready')
    expect(settingsPagePhase({ ready: true, hasSettings: true, loadError: 'boom' })).toBe('ready')
    expect(settingsPagePhase({ ready: true, hasSettings: false })).toBe('error')
    expect(settingsPagePhase({ ready: true, hasSettings: false, loadError: 'boom' })).toBe('error')
    expect(settingsPagePhase({ ready: false, hasSettings: false })).toBe('loading')
  })

  it('保存按钮不可用时一定给出原因', () => {
    expect(saveGate({ phase: 'loading', saving: false, changeCount: 1 })).toMatchObject({ ok: false })
    expect(saveGate({ phase: 'error', saving: false, changeCount: 1 }).reason).toContain('重试')
    expect(saveGate({ phase: 'ready', saving: true, changeCount: 1 }).reason).toContain('正在保存')
    expect(saveGate({ phase: 'ready', saving: false, changeCount: 0 }).reason).toContain('没有')
    expect(saveGate({ phase: 'ready', saving: false, changeCount: 2 })).toEqual({ ok: true })
    expect(saveSuccessMessage(0)).toBe('设置已保存')
    expect(saveSuccessMessage(3)).toBe('设置已保存（3 项修改）')
  })
})

describe('分组搜索', () => {
  it('空查询显示全部分组，坏输入按空查询处理', () => {
    expect(filterSettingsGroups({}).visible).toHaveLength(SETTINGS_GROUPS.length)
    expect(filterSettingsGroups({ query: '   ' }).active).toBe(false)
    expect(filterSettingsGroups({ query: 42 }).visible).toHaveLength(SETTINGS_GROUPS.length)
    expect(filterSettingsGroups({ query: { evil: true } }).active).toBe(false)
  })

  it('按关键词命中分组并给出命中标签', () => {
    const result = filterSettingsGroups({ query: '隔离区' })
    expect(result.visible).toContain('quarantine')
    expect(result.visible).toContain('clean')
    expect(result.matches.quarantine?.length).toBeGreaterThan(0)
  })

  it('多关键词是 AND 关系，英文大小写不敏感', () => {
    const and = filterSettingsGroups({ query: '清理 重试' })
    expect(and.visible).toEqual(['clean'])
    expect(filterSettingsGroups({ query: 'ai' }).visible).toEqual(expect.arrayContaining(['privacy', 'plugins']))
  })

  it('搜不到时给出 no-match 空状态原因', () => {
    const result = filterSettingsGroups({ query: '绝对不存在的设置关键词' })
    expect(result.visible).toEqual([])
    expect(result.emptyReason).toBe('no-match')
    expect(describeEmptyFilter(result).title).toContain('绝对不存在')
    expect(describeEmptyFilter(filterSettingsGroups({ onlyDirty: true, dirtyGroups: [] })).title).toContain('没有未保存修改')
  })

  it('只看未保存修改：与关键词取交集，非法分组 id 忽略', () => {
    const dirty = filterSettingsGroups({ onlyDirty: true, dirtyGroups: ['clean', 'not-a-group', 42 as unknown as string] })
    expect(dirty.active).toBe(true)
    expect(dirty.visible).toEqual(['clean'])

    const empty = filterSettingsGroups({ onlyDirty: true, dirtyGroups: [] })
    expect(empty.visible).toEqual([])
    expect(empty.emptyReason).toBe('no-dirty')

    const combined = filterSettingsGroups({ query: '并发', onlyDirty: true, dirtyGroups: ['clean'] })
    expect(combined.visible).toEqual([])
    expect(combined.emptyReason).toBe('no-match')
  })
})

describe('展示值', () => {
  it('数字/开关/目录给出人话', () => {
    expect(displayFieldValue('retentionDays', { ...SHIPPED_DEFAULT_FORM, retentionDays: 0 })).toBe('永久保留')
    expect(displayFieldValue('retentionDays', { ...SHIPPED_DEFAULT_FORM, retentionDays: 7 })).toBe('7 天')
    expect(displayFieldValue('onlineAi', SHIPPED_DEFAULT_FORM)).toBe('允许')
    expect(displayFieldValue('editorCommand', SHIPPED_DEFAULT_FORM)).toBe('系统默认')
    expect(displayFieldValue('roots', { ...SHIPPED_DEFAULT_FORM, roots: ['D:\\Videos', 'E:\\Backup'] })).toBe('2 个目录')
  })
})
