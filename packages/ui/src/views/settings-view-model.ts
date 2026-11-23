import type { SectionIconName } from '../components/section-icons.ts'

/**
 * 设置页展示模型（纯函数，可单测）。
 *
 * 对应 docs/ui-navigation.md §8「设置」这一轮要补齐的能力：
 * - **分组搜索/定位**：12 个设置分组 + 组内设置项标签构成搜索索引，支持多关键词、
 *   只过滤「有未保存修改」的分组，并区分「没有匹配」和「没有修改」两种空状态；
 * - **修改是否保存**：表单当前值 vs 内核里已保存的设置逐项比较，给出脏状态；
 * - **默认值来源**：每项标注「默认 / 已自定义 / 未保存」，避免用户忘了改过什么；
 * - **恢复默认**：先给出「将改动哪些项」的预览，明确不重置的自定义扫描根/排除目录/编辑器命令；
 * - **危险项**：删除方式、隔离区、规则库、扫描范围的风险文案与保存前确认；
 * - **失败可解释**：把内核/传输错误归一成「原因 + 建议 + 是否可重试」。
 *
 * 纯函数约束：不读 DOM、不碰 localStorage、不发请求；坏输入（null/NaN/错误类型）
 * 一律回退到默认值而不是抛错，保证页面不会因为脏数据白屏。
 */

/* ------------------------------------------------------------------ */
/* 基础类型                                                             */
/* ------------------------------------------------------------------ */

export type CleanMode = 'recycle' | 'quarantine' | 'delete'

/** 设置页表单的扁平快照（与 SettingsView 的 reactive form 一一对应） */
export interface SettingsFormSnapshot {
  cleanMode: CleanMode
  highRiskQuarantine: boolean
  quarantineFallback: boolean
  dryRunDefault: boolean
  confirmRisky: boolean
  retries: number
  budgetFiles: number
  budgetGb: number
  concurrency: number
  maxItemsPerTask: number
  maxEntriesPerTask: number
  maxDepth: number
  largeFileThresholdMb: number
  duplicateMinSizeMb: number
  includeSystem: boolean
  includeRisky: boolean
  includeDeep: boolean
  includeCustom: boolean
  quarantineEnabled: boolean
  quarantineMaxMb: number
  quarantineMaxFiles: number
  retentionDays: number
  onlineAi: boolean
  editorCommand: string
  roots: string[]
  excludes: string[]
}

export type SettingsFieldKey = keyof SettingsFormSnapshot

/** 内核默认设置（与 packages/core/src/domains/kernel/settings.ts 的 DEFAULT_SETTINGS 对齐） */
export const SHIPPED_DEFAULT_FORM: SettingsFormSnapshot = {
  cleanMode: 'recycle',
  highRiskQuarantine: true,
  quarantineFallback: false,
  dryRunDefault: false,
  confirmRisky: true,
  retries: 2,
  budgetFiles: 50_000,
  budgetGb: 20,
  concurrency: 4,
  maxItemsPerTask: 20_000,
  maxEntriesPerTask: 400_000,
  maxDepth: 32,
  largeFileThresholdMb: 100,
  duplicateMinSizeMb: 1,
  includeSystem: true,
  includeRisky: false,
  includeDeep: false,
  includeCustom: true,
  quarantineEnabled: true,
  quarantineMaxMb: 2048,
  quarantineMaxFiles: 20_000,
  retentionDays: 0,
  onlineAi: true,
  editorCommand: '',
  roots: [],
  // 内核默认排除项；UI 的「恢复默认」不改这两组自定义范围，但默认值比较仍以它为准
  excludes: ['\\node_modules\\', '\\.git\\', '\\$Recycle.Bin\\', '\\System Volume Information\\'],
}

/* ------------------------------------------------------------------ */
/* 分组、字段与搜索索引                                                 */
/* ------------------------------------------------------------------ */

export type SettingsGroupId =
  | 'schedule'
  | 'clean'
  | 'scan'
  | 'rules'
  | 'quarantine'
  | 'privacy'
  | 'scope'
  | 'plugins'
  | 'data'
  | 'diagnostics'
  | 'logging'
  | 'env'

/** 「恢复默认」会用默认值覆盖的字段（自定义扫描根/排除目录/编辑器命令/日志/定时任务不在其中） */
export const RESET_FIELD_KEYS: readonly SettingsFieldKey[] = [
  'cleanMode',
  'highRiskQuarantine',
  'quarantineFallback',
  'dryRunDefault',
  'confirmRisky',
  'retries',
  'budgetFiles',
  'budgetGb',
  'concurrency',
  'maxItemsPerTask',
  'maxEntriesPerTask',
  'maxDepth',
  'largeFileThresholdMb',
  'duplicateMinSizeMb',
  'includeSystem',
  'includeRisky',
  'includeDeep',
  'includeCustom',
  'quarantineEnabled',
  'quarantineMaxMb',
  'quarantineMaxFiles',
  'retentionDays',
  'onlineAi',
]

export interface SettingsFieldMeta {
  key: SettingsFieldKey
  /** 面向用户的中文名称（搜索索引、修改摘要、恢复默认预览共用） */
  label: string
  group: SettingsGroupId
  /** 「恢复默认」是否覆盖该字段 */
  reset: boolean
}

export const SETTINGS_FIELDS: readonly SettingsFieldMeta[] = [
  { key: 'cleanMode', label: '默认删除方式', group: 'clean', reset: RESET_FIELD_KEYS.includes('cleanMode') },
  { key: 'highRiskQuarantine', label: '高风险项进隔离区', group: 'clean', reset: RESET_FIELD_KEYS.includes('highRiskQuarantine') },
  { key: 'quarantineFallback', label: '回收站不可用时回落隔离区', group: 'clean', reset: RESET_FIELD_KEYS.includes('quarantineFallback') },
  { key: 'dryRunDefault', label: '默认仅预演', group: 'clean', reset: RESET_FIELD_KEYS.includes('dryRunDefault') },
  { key: 'confirmRisky', label: '高风险需确认', group: 'clean', reset: RESET_FIELD_KEYS.includes('confirmRisky') },
  { key: 'retries', label: '失败重试次数', group: 'clean', reset: RESET_FIELD_KEYS.includes('retries') },
  { key: 'budgetFiles', label: '单次清理项上限', group: 'clean', reset: RESET_FIELD_KEYS.includes('budgetFiles') },
  { key: 'budgetGb', label: '单次容量上限（GB）', group: 'clean', reset: RESET_FIELD_KEYS.includes('budgetGb') },
  { key: 'concurrency', label: '任务并发度', group: 'scan', reset: RESET_FIELD_KEYS.includes('concurrency') },
  { key: 'maxItemsPerTask', label: '单任务最多清理项', group: 'scan', reset: RESET_FIELD_KEYS.includes('maxItemsPerTask') },
  { key: 'maxEntriesPerTask', label: '单任务遍历条目上限', group: 'scan', reset: RESET_FIELD_KEYS.includes('maxEntriesPerTask') },
  { key: 'maxDepth', label: '最大递归深度', group: 'scan', reset: RESET_FIELD_KEYS.includes('maxDepth') },
  { key: 'largeFileThresholdMb', label: '大文件阈值（MB）', group: 'scan', reset: RESET_FIELD_KEYS.includes('largeFileThresholdMb') },
  { key: 'duplicateMinSizeMb', label: '重复文件最小体积（MB）', group: 'scan', reset: RESET_FIELD_KEYS.includes('duplicateMinSizeMb') },
  { key: 'includeSystem', label: '包含系统级目录', group: 'scan', reset: RESET_FIELD_KEYS.includes('includeSystem') },
  { key: 'includeRisky', label: '启用高风险分类', group: 'rules', reset: RESET_FIELD_KEYS.includes('includeRisky') },
  { key: 'includeDeep', label: '启用深度规则', group: 'rules', reset: RESET_FIELD_KEYS.includes('includeDeep') },
  { key: 'includeCustom', label: '加载自定义规则', group: 'rules', reset: RESET_FIELD_KEYS.includes('includeCustom') },
  { key: 'quarantineEnabled', label: '启用隔离区', group: 'quarantine', reset: RESET_FIELD_KEYS.includes('quarantineEnabled') },
  { key: 'quarantineMaxMb', label: '隔离区容量上限（MB）', group: 'quarantine', reset: RESET_FIELD_KEYS.includes('quarantineMaxMb') },
  { key: 'quarantineMaxFiles', label: '隔离区文件数上限', group: 'quarantine', reset: RESET_FIELD_KEYS.includes('quarantineMaxFiles') },
  { key: 'retentionDays', label: '隔离区保留天数', group: 'quarantine', reset: RESET_FIELD_KEYS.includes('retentionDays') },
  { key: 'onlineAi', label: '允许在线 AI', group: 'privacy', reset: RESET_FIELD_KEYS.includes('onlineAi') },
  { key: 'editorCommand', label: '编辑器命令', group: 'privacy', reset: RESET_FIELD_KEYS.includes('editorCommand') },
  { key: 'roots', label: '额外扫描根', group: 'scope', reset: RESET_FIELD_KEYS.includes('roots') },
  { key: 'excludes', label: '始终排除', group: 'scope', reset: RESET_FIELD_KEYS.includes('excludes') },
]

const FIELD_KEY_SET = new Set<string>(SETTINGS_FIELDS.map((field) => field.key))

interface SettingsGroupSeed {
  id: SettingsGroupId
  title: string
  icon: SectionIconName
  /** 组内非表单字段的可搜索标签（按钮、说明等） */
  extras: readonly string[]
  /** 仅参与匹配、不在命中列表里展示的同义词 */
  keywords: readonly string[]
}

const GROUP_SEEDS: readonly SettingsGroupSeed[] = [
  {
    id: 'schedule',
    title: '定时任务',
    icon: 'alarm',
    extras: ['新建任务', '删除任务', '任务名称', '执行方式', '间隔', '每天固定时间', '任务范围', '模式', '授权状态', '立即运行', '授权自动清理', '清除授权'],
    keywords: ['scheduler', 'schedule', 'cron', 'plan', 'auto'],
  },
  {
    id: 'clean',
    title: '清理行为',
    icon: 'broom',
    extras: ['删除方式', '回收站', '隔离区', '永久删除', '预演', '清理预算', '安全边界'],
    keywords: ['clean', 'delete', 'recycle', 'quarantine', 'dry run', 'retry', 'budget'],
  },
  {
    id: 'scan',
    title: '扫描与性能',
    icon: 'bolt',
    extras: ['性能', '遍历条目', '递归深度', '大文件', '重复文件', '系统目录', '内存'],
    keywords: ['scan', 'performance', 'concurrency', 'depth', 'duplicate', 'large file', 'entries'],
  },
  {
    id: 'rules',
    title: '规则库',
    icon: 'book',
    extras: ['高风险分类', '深度规则', '自定义规则', '热重载'],
    keywords: ['rules', 'deep', 'custom', 'risk'],
  },
  {
    id: 'quarantine',
    title: '隔离区',
    icon: 'archive',
    extras: ['恢复', '容量', '文件数', '保留天数', '永久保留'],
    keywords: ['quarantine', 'restore', 'retention', 'capacity'],
  },
  {
    id: 'privacy',
    title: '隐私与在线 AI',
    icon: 'lock',
    extras: ['出网', '在线 AI', '离线', '编辑器', '外发记录', '剪贴板'],
    keywords: ['privacy', 'online ai', 'offline', 'egress', 'editor'],
  },
  {
    id: 'scope',
    title: '扫描范围',
    icon: 'folders',
    extras: ['额外扫描根', '始终排除', '排除目录', '绝对路径'],
    keywords: ['scope', 'root', 'exclude', 'path'],
  },
  {
    id: 'plugins',
    title: '插件系统与扩展目录',
    icon: 'puzzle',
    extras: ['插件目录', '插件状态', '插件包', '外部插件', 'AI 插件工坊'],
    keywords: ['plugin', 'external', 'workshop'],
  },
  {
    id: 'data',
    title: '数据维护',
    icon: 'toolbox',
    extras: ['数据目录', '历史记录', '清空历史', '清空隔离区'],
    keywords: ['data', 'history', 'purge'],
  },
  {
    id: 'diagnostics',
    title: '诊断与日志',
    icon: 'health',
    extras: ['运行日志', '结构化诊断', '日志目录', '诊断报告', 'JSON'],
    keywords: ['diagnostics', 'log', 'json', 'export'],
  },
  {
    id: 'logging',
    title: '日志设置',
    icon: 'receipt',
    extras: ['日志级别', '轮转', '保留天数', '重复日志', '插件级别', 'debug', 'info', 'warn', 'error'],
    keywords: ['logging', 'level', 'rotate', 'dedupe'],
  },
  {
    id: 'env',
    title: '版本与运行环境',
    icon: 'info',
    extras: ['版本', '协议版本', '运行外壳', '运行时', '系统', '管理员权限', '启动耗时', '复制环境信息'],
    keywords: ['version', 'runtime', 'environment', 'electron', 'node'],
  },
]

export interface SettingsGroupMeta {
  id: SettingsGroupId
  title: string
  icon: SectionIconName
  /** 搜索命中时展示的标签（表单字段 label + 组内动作） */
  entries: readonly string[]
  keywords: readonly string[]
}

/** 分组顺序与页面卡片顺序一致；组内字段 label 自动并入搜索索引，避免两处维护漂移 */
export const SETTINGS_GROUPS: readonly SettingsGroupMeta[] = GROUP_SEEDS.map((seed) => ({
  id: seed.id,
  title: seed.title,
  icon: seed.icon,
  keywords: seed.keywords,
  entries: [
    ...SETTINGS_FIELDS.filter((field) => field.group === seed.id).map((field) => field.label),
    ...seed.extras,
  ],
}))

const SETTINGS_GROUP_IDS = SETTINGS_GROUPS.map((group) => group.id)
const GROUP_ID_SET = new Set<string>(SETTINGS_GROUP_IDS)

/* ------------------------------------------------------------------ */
/* 容错读数                                                             */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readNumber(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
  return Number.isFinite(num) ? num : fallback
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const list: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    list.push(text)
    if (list.length >= 200) break
  }
  return list
}

function readCleanMode(value: unknown): CleanMode {
  return value === 'quarantine' || value === 'delete' ? value : 'recycle'
}

/** 字节 → MB（整数），坏值回退到给定默认 */
function bytesToMb(value: unknown, fallback: number): number {
  const bytes = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : Number.NaN
  if (!Number.isFinite(bytes)) return fallback
  return Math.round(bytes / 1024 / 1024)
}

/** 字节 → GB（保留 1 位小数），坏值回退到给定默认 */
function bytesToGb(value: unknown): number {
  const bytes = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : Number.NaN
  if (!Number.isFinite(bytes)) return SHIPPED_DEFAULT_FORM.budgetGb
  return Math.round((bytes / 1024 / 1024 / 1024) * 10) / 10
}

/* ------------------------------------------------------------------ */
/* 表单快照 ↔ 内核 Settings                                             */
/* ------------------------------------------------------------------ */

/** 把任意输入归一成扁平表单快照：坏字段回退默认值，数组去重/截断 */
export function normalizeFormSnapshot(input: unknown): SettingsFormSnapshot {
  const raw = isRecord(input) ? input : {}
  const defaults = SHIPPED_DEFAULT_FORM
  return {
    cleanMode: readCleanMode(raw.cleanMode),
    highRiskQuarantine: readBoolean(raw.highRiskQuarantine, defaults.highRiskQuarantine),
    quarantineFallback: readBoolean(raw.quarantineFallback, defaults.quarantineFallback),
    dryRunDefault: readBoolean(raw.dryRunDefault, defaults.dryRunDefault),
    confirmRisky: readBoolean(raw.confirmRisky, defaults.confirmRisky),
    retries: readNumber(raw.retries, defaults.retries),
    budgetFiles: readNumber(raw.budgetFiles, defaults.budgetFiles),
    budgetGb: readNumber(raw.budgetGb, defaults.budgetGb),
    concurrency: readNumber(raw.concurrency, defaults.concurrency),
    maxItemsPerTask: readNumber(raw.maxItemsPerTask, defaults.maxItemsPerTask),
    maxEntriesPerTask: readNumber(raw.maxEntriesPerTask, defaults.maxEntriesPerTask),
    maxDepth: readNumber(raw.maxDepth, defaults.maxDepth),
    largeFileThresholdMb: readNumber(raw.largeFileThresholdMb, defaults.largeFileThresholdMb),
    duplicateMinSizeMb: readNumber(raw.duplicateMinSizeMb, defaults.duplicateMinSizeMb),
    includeSystem: readBoolean(raw.includeSystem, defaults.includeSystem),
    includeRisky: readBoolean(raw.includeRisky, defaults.includeRisky),
    includeDeep: readBoolean(raw.includeDeep, defaults.includeDeep),
    includeCustom: readBoolean(raw.includeCustom, defaults.includeCustom),
    quarantineEnabled: readBoolean(raw.quarantineEnabled, defaults.quarantineEnabled),
    quarantineMaxMb: readNumber(raw.quarantineMaxMb, defaults.quarantineMaxMb),
    quarantineMaxFiles: readNumber(raw.quarantineMaxFiles, defaults.quarantineMaxFiles),
    retentionDays: readNumber(raw.retentionDays, defaults.retentionDays),
    onlineAi: readBoolean(raw.onlineAi, defaults.onlineAi),
    editorCommand: readString(raw.editorCommand, defaults.editorCommand),
    roots: Array.isArray(raw.roots) ? readStringList(raw.roots) : [...defaults.roots],
    excludes: Array.isArray(raw.excludes) ? readStringList(raw.excludes) : [...defaults.excludes],
  }
}

/**
 * 把内核完整 Settings 转成扁平表单快照。
 *
 * 坏输入（配置段为 null、数值 NaN 等）回退默认；字节类字段按页面表单同样的精度换算，
 * 保证「表单值 vs 已保存值」比较不会因为 1024 精度出现假脏状态。
 */
export function settingsFormSnapshot(settings: unknown): SettingsFormSnapshot {
  const root = isRecord(settings) ? settings : {}
  const clean = isRecord(root.clean) ? root.clean : {}
  const budget = isRecord(clean.budget) ? clean.budget : {}
  const scan = isRecord(root.scan) ? root.scan : {}
  const rules = isRecord(root.rules) ? root.rules : {}
  const quarantine = isRecord(root.quarantine) ? root.quarantine : {}
  const analysis = isRecord(root.analysis) ? root.analysis : {}
  const privacy = isRecord(root.privacy) ? root.privacy : {}
  const ui = isRecord(root.ui) ? root.ui : {}
  const defaults = SHIPPED_DEFAULT_FORM
  return normalizeFormSnapshot({
    cleanMode: clean.mode,
    highRiskQuarantine: clean.highRiskQuarantine,
    quarantineFallback: clean.quarantineFallback,
    dryRunDefault: clean.dryRunDefault,
    confirmRisky: clean.confirmRisky,
    retries: clean.retries,
    budgetFiles: budget.maxFiles,
    budgetGb: bytesToGb(budget.maxBytes),
    concurrency: scan.concurrency,
    maxItemsPerTask: scan.maxItemsPerTask,
    maxEntriesPerTask: scan.maxEntriesPerTask,
    maxDepth: scan.maxDepth,
    largeFileThresholdMb: bytesToMb(scan.largeFileThreshold, defaults.largeFileThresholdMb),
    duplicateMinSizeMb: bytesToMb(scan.duplicateMinSize, defaults.duplicateMinSizeMb),
    includeSystem: analysis.includeSystem,
    includeRisky: rules.includeRisky,
    includeDeep: rules.includeDeep,
    includeCustom: rules.includeCustom,
    quarantineEnabled: quarantine.enabled,
    quarantineMaxMb: bytesToMb(quarantine.maxBytes, defaults.quarantineMaxMb),
    quarantineMaxFiles: quarantine.maxFiles,
    retentionDays: quarantine.retentionDays,
    onlineAi: privacy.onlineAi,
    editorCommand: ui.editorCommand,
    roots: analysis.roots,
    excludes: analysis.excludes,
  })
}

/* ------------------------------------------------------------------ */
/* 值比较 / 展示                                                       */
/* ------------------------------------------------------------------ */

/** 规范化后的比较键：字体值不参与比较，数组按顺序拼接（UI 里无法调整顺序） */
export type SettingsValues = Record<SettingsFieldKey, string>

function canonicalFieldValue(key: SettingsFieldKey, snapshot: SettingsFormSnapshot): string {
  const value = snapshot[key]
  return Array.isArray(value) ? value.join('\u0000') : String(value)
}

/** 任意输入 → 可比较的规范化值表（坏输入按默认值处理） */
export function formValues(input: unknown): SettingsValues {
  const snapshot = normalizeFormSnapshot(input)
  const values = {} as SettingsValues
  for (const field of SETTINGS_FIELDS) values[field.key] = canonicalFieldValue(field.key, snapshot)
  return values
}

function formatCount(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—'
}

/** 单字段的人话展示值（修改摘要、恢复默认预览、字段状态 tooltip 共用） */
export function displayFieldValue(key: SettingsFieldKey, input: unknown): string {
  const snapshot = normalizeFormSnapshot(input)
  switch (key) {
    case 'cleanMode':
      return snapshot.cleanMode === 'recycle' ? '回收站（可还原）' : snapshot.cleanMode === 'quarantine' ? '隔离区（可恢复）' : '永久删除'
    case 'highRiskQuarantine':
    case 'quarantineFallback':
    case 'dryRunDefault':
    case 'confirmRisky':
    case 'includeSystem':
    case 'includeRisky':
    case 'includeDeep':
    case 'includeCustom':
    case 'quarantineEnabled':
      return snapshot[key] ? '开启' : '关闭'
    case 'onlineAi':
      return snapshot.onlineAi ? '允许' : '禁止'
    case 'retries':
      return `${formatCount(snapshot.retries)} 次`
    case 'budgetFiles':
      return `${formatCount(snapshot.budgetFiles)} 项`
    case 'budgetGb':
      return `${snapshot.budgetGb} GB`
    case 'concurrency':
      return `${formatCount(snapshot.concurrency)} 个任务`
    case 'maxItemsPerTask':
      return `${formatCount(snapshot.maxItemsPerTask)} 项`
    case 'maxEntriesPerTask':
      return `${formatCount(snapshot.maxEntriesPerTask)} 条`
    case 'maxDepth':
      return `${formatCount(snapshot.maxDepth)} 层`
    case 'largeFileThresholdMb':
      return `${snapshot.largeFileThresholdMb} MB`
    case 'duplicateMinSizeMb':
      return `${snapshot.duplicateMinSizeMb} MB`
    case 'quarantineMaxMb':
      return snapshot.quarantineMaxMb > 0 ? `${formatCount(snapshot.quarantineMaxMb)} MB` : '未设置上限（0）'
    case 'quarantineMaxFiles':
      return snapshot.quarantineMaxFiles > 0 ? `${formatCount(snapshot.quarantineMaxFiles)} 个` : '未设置上限（0）'
    case 'retentionDays':
      return snapshot.retentionDays > 0 ? `${formatCount(snapshot.retentionDays)} 天` : '永久保留'
    case 'editorCommand':
      return snapshot.editorCommand.trim() || '系统默认'
    case 'roots':
      if (!snapshot.roots.length) return '未添加'
      return snapshot.roots.length === 1 ? snapshot.roots[0] : `${snapshot.roots.length} 个目录`
    case 'excludes':
      return snapshot.excludes.length ? `${snapshot.excludes.length} 条排除规则` : '未设置'
    default:
      return ''
  }
}

/* ------------------------------------------------------------------ */
/* 脏状态 / 修改摘要 / 默认值来源                                       */
/* ------------------------------------------------------------------ */

export interface SettingsChange {
  key: SettingsFieldKey
  label: string
  group: SettingsGroupId
  /** 已保存值的人话 */
  from: string
  /** 当前表单值的人话 */
  to: string
}

/**
 * 当前表单 vs 已保存设置的差异列表。
 * 保存值缺失（如设置尚未加载）时按内核默认值比较，不会把所有字段都误报成修改。
 */
export function diffFormValues(current: unknown, saved: unknown): SettingsChange[] {
  const currentSnapshot = normalizeFormSnapshot(current)
  const savedSnapshot = normalizeFormSnapshot(saved)
  const changes: SettingsChange[] = []
  for (const field of SETTINGS_FIELDS) {
    if (canonicalFieldValue(field.key, currentSnapshot) === canonicalFieldValue(field.key, savedSnapshot)) continue
    changes.push({
      key: field.key,
      label: field.label,
      group: field.group,
      from: displayFieldValue(field.key, savedSnapshot),
      to: displayFieldValue(field.key, currentSnapshot),
    })
  }
  return changes
}

export type FieldOrigin = 'default' | 'custom' | 'unsaved'

export interface SettingsFieldStatus {
  key: SettingsFieldKey
  /** default=内核默认值；custom=已保存的自定义值；unsaved=改了还没保存 */
  origin: FieldOrigin
  /** 短的角标文案 */
  text: string
  /** tooltip 里的完整说明 */
  title: string
  tone: FieldOrigin
}

/**
 * 逐字段判定「当前值来源」：
 * - 与已保存值相同 → 默认 / 已自定义；
 * - 与已保存值不同 → 未保存（即使改回了默认值也算未保存，因为内核里还是旧值）。
 */
export function buildFieldStatuses(current: unknown, saved: unknown): Record<SettingsFieldKey, SettingsFieldStatus> {
  const currentSnapshot = normalizeFormSnapshot(current)
  const savedSnapshot = normalizeFormSnapshot(saved)
  const defaultSnapshot = normalizeFormSnapshot(undefined)
  const statuses = {} as Record<SettingsFieldKey, SettingsFieldStatus>
  for (const field of SETTINGS_FIELDS) {
    const currentValue = canonicalFieldValue(field.key, currentSnapshot)
    const savedValue = canonicalFieldValue(field.key, savedSnapshot)
    const defaultValue = canonicalFieldValue(field.key, defaultSnapshot)
    let origin: FieldOrigin
    let text: string
    let title: string
    if (currentValue === savedValue) {
      if (currentValue === defaultValue) {
        origin = 'default'
        text = '默认'
        title = '与内核默认值一致'
      } else {
        origin = 'custom'
        text = '已自定义'
        title = `已保存的自定义值：${displayFieldValue(field.key, currentSnapshot)}`
      }
    } else {
      origin = 'unsaved'
      text = '未保存'
      title =
        currentValue === defaultValue
          ? '已改回默认值，但尚未保存（内核中仍是上次保存的值）'
          : `已修改但尚未保存：${displayFieldValue(field.key, savedSnapshot)} → ${displayFieldValue(field.key, currentSnapshot)}`
    }
    statuses[field.key] = { key: field.key, origin, text, title, tone: origin }
  }
  return statuses
}

/** 单字段状态查询；未知键返回 undefined（模板/测试里可安全忽略） */
export function fieldStatusFor(key: string, current: unknown, saved: unknown): SettingsFieldStatus | undefined {
  if (!FIELD_KEY_SET.has(key)) return undefined
  return buildFieldStatuses(current, saved)[key as SettingsFieldKey]
}

export interface SettingsGroupSummary {
  group: SettingsGroupId
  fieldCount: number
  /** 已保存但非默认的字段数 */
  customCount: number
  /** 未保存的字段数（含改回默认值但未保存） */
  unsavedCount: number
  riskCount: number
}

export interface SettingsStatusSummary {
  totalFields: number
  defaultCount: number
  customCount: number
  unsavedCount: number
  /** 非默认字段总数（含未保存） */
  nonDefaultCount: number
  riskyCount: number
  dangerCount: number
  groups: Record<SettingsGroupId, SettingsGroupSummary>
}

/** 汇总字段状态与风险，供顶部工具栏和每张卡片角标使用 */
export function summarizeSettingsStatus(
  statuses: Record<SettingsFieldKey, SettingsFieldStatus>,
  risks: readonly SettingRisk[] = [],
): SettingsStatusSummary {
  const groups = {} as Record<SettingsGroupId, SettingsGroupSummary>
  for (const group of SETTINGS_GROUPS) {
    groups[group.id] = { group: group.id, fieldCount: 0, customCount: 0, unsavedCount: 0, riskCount: 0 }
  }
  let defaultCount = 0
  let customCount = 0
  let unsavedCount = 0
  for (const field of SETTINGS_FIELDS) {
    const status = statuses[field.key]
    if (!status) continue
    const summary = groups[field.group]
    summary.fieldCount += 1
    if (status.origin === 'default') defaultCount += 1
    else if (status.origin === 'custom') {
      customCount += 1
      summary.customCount += 1
    } else {
      unsavedCount += 1
      summary.unsavedCount += 1
    }
  }
  for (const risk of risks) groups[risk.group].riskCount += 1
  return {
    totalFields: SETTINGS_FIELDS.length,
    defaultCount,
    customCount,
    unsavedCount,
    nonDefaultCount: customCount + unsavedCount,
    riskyCount: risks.length,
    dangerCount: risks.filter((risk) => risk.level === 'danger').length,
    groups,
  }
}

/* ------------------------------------------------------------------ */
/* 恢复默认预览                                                         */
/* ------------------------------------------------------------------ */

export interface ResetPreview {
  changes: SettingsChange[]
  /** 已经是默认值的字段数 */
  alreadyDefault: number
  totalResetFields: number
  /** 不会被恢复默认改动的字段（自定义扫描范围、编辑器命令等） */
  untouchedFields: SettingsFieldKey[]
}

/** 恢复默认前预览：只对比会被重置的字段，并明确列出不动的字段 */
export function previewResetDefaults(current: unknown): ResetPreview {
  const currentSnapshot = normalizeFormSnapshot(current)
  const defaultSnapshot = normalizeFormSnapshot(undefined)
  const resetSet = new Set<SettingsFieldKey>(RESET_FIELD_KEYS)
  const changes: SettingsChange[] = []
  let alreadyDefault = 0
  for (const field of SETTINGS_FIELDS) {
    if (!resetSet.has(field.key)) continue
    if (canonicalFieldValue(field.key, currentSnapshot) === canonicalFieldValue(field.key, defaultSnapshot)) {
      alreadyDefault += 1
      continue
    }
    changes.push({
      key: field.key,
      label: field.label,
      group: field.group,
      from: displayFieldValue(field.key, currentSnapshot),
      to: displayFieldValue(field.key, defaultSnapshot),
    })
  }
  return {
    changes,
    alreadyDefault,
    totalResetFields: RESET_FIELD_KEYS.length,
    untouchedFields: SETTINGS_FIELDS.filter((field) => !resetSet.has(field.key)).map((field) => field.key),
  }
}

/** 「恢复默认」要写回表单的值（只含 RESET_FIELD_KEYS，数组是新的副本） */
export function resetFormValues(): Partial<SettingsFormSnapshot> {
  const values: Record<string, unknown> = {}
  for (const key of RESET_FIELD_KEYS) {
    const value = SHIPPED_DEFAULT_FORM[key]
    values[key] = Array.isArray(value) ? [...value] : value
  }
  return values as Partial<SettingsFormSnapshot>
}

/* ------------------------------------------------------------------ */
/* 危险设置                                                             */
/* ------------------------------------------------------------------ */

export type SettingsRiskLevel = 'danger' | 'warn'

export interface SettingRisk {
  id: string
  level: SettingsRiskLevel
  group: SettingsGroupId
  /** 风险对应的表单字段（用于「定位」跳转与内联提示） */
  field: SettingsFieldKey
  title: string
  detail: string
  suggestion: string
}

/**
 * 按当前表单值评估风险（保存后生效）。
 * 默认设置不产生任何风险；只列出真正放宽安全边界的组合。
 */
export function assessSettingRisks(current: unknown): SettingRisk[] {
  const snapshot = normalizeFormSnapshot(current)
  const dangers: SettingRisk[] = []
  const warnings: SettingRisk[] = []

  if (snapshot.cleanMode === 'delete') {
    dangers.push({
      id: 'clean-mode-delete',
      level: 'danger',
      group: 'clean',
      field: 'cleanMode',
      title: '默认删除方式为永久删除',
      detail: '清理时直接删除文件，不经过回收站或隔离区，删除后无法还原。',
      suggestion: '确认这些文件不再需要时再使用；更稳妥的是改为回收站或隔离区。',
    })
  }
  if (!snapshot.quarantineEnabled) {
    dangers.push({
      id: 'quarantine-disabled',
      level: 'danger',
      group: 'quarantine',
      field: 'quarantineEnabled',
      title: '隔离区已关闭',
      detail: '高风险项不再强制隔离，会按默认删除方式处理；默认删除方式为隔离区时也会回退到回收站。',
      suggestion: '除非明确知道自己在做什么，建议保持隔离区开启。',
    })
  }
  if (snapshot.quarantineEnabled && !snapshot.highRiskQuarantine) {
    dangers.push({
      id: 'high-risk-no-quarantine',
      level: 'danger',
      group: 'clean',
      field: 'highRiskQuarantine',
      title: '高风险项不再强制进隔离区',
      detail: '密码/Cookie、Windows.old 等高风险项会走默认删除方式，可能是永久删除。',
      suggestion: '保持开启，让高风险项始终先进入隔离区，误删还能恢复。',
    })
  }
  if (!snapshot.confirmRisky) {
    warnings.push({
      id: 'confirm-risky-off',
      level: 'warn',
      group: 'clean',
      field: 'confirmRisky',
      title: '高风险清理不再二次确认',
      detail: '一键清理时不会暂停等待确认高风险项，误选后只能靠撤销或隔离区恢复。',
      suggestion: '保持开启，清理高风险内容前多一道确认。',
    })
  }
  if (snapshot.includeRisky) {
    dangers.push({
      id: 'risky-rules-on',
      level: 'danger',
      group: 'rules',
      field: 'includeRisky',
      title: '已启用高风险分类',
      detail: '扫描会把密码/Cookie、Windows.old 等内容纳入可清理项，界面会以高风险标签提示。',
      suggestion: '只在这台机器上的数据可丢弃时开启，并在清理前逐项确认。',
    })
  }
  if (snapshot.includeDeep) {
    warnings.push({
      id: 'deep-rules-on',
      level: 'warn',
      group: 'rules',
      field: 'includeDeep',
      title: '已启用深度规则',
      detail: 'deep_only 规则覆盖更彻底、扫描更慢，可能产出更激进的清理项。',
      suggestion: '确认了解规则含义后再开启，可先用「仅预演」跑一次。',
    })
  }
  if (snapshot.quarantineEnabled && (snapshot.quarantineMaxMb <= 0 || snapshot.quarantineMaxFiles <= 0)) {
    warnings.push({
      id: 'quarantine-capacity-zero',
      level: 'warn',
      group: 'quarantine',
      field: 'quarantineMaxFiles',
      title: '隔离区上限为 0',
      detail: '隔离区容量或文件数上限为 0：任何文件都无法移入，高风险项的处理会失败或跳过。',
      suggestion: '把容量与文件数上限调到大于 0，或关闭隔离方案。',
    })
  }
  if (snapshot.roots.length > 0) {
    const preview = snapshot.roots.slice(0, 3).join('、')
    warnings.push({
      id: 'custom-roots',
      level: 'warn',
      group: 'scope',
      field: 'roots',
      title: `自定义扫描根 ${snapshot.roots.length} 个`,
      detail: `额外扫描根：${preview}${snapshot.roots.length > 3 ? ' 等' : ''}。这些目录中的可清理项也会被扫描与处理。`,
      suggestion: '确认其中没有需要长期保留的数据；不确定时先移除或先用「仅预演」。',
    })
  }
  return [...dangers, ...warnings]
}

/**
 * 本次保存会「新增」的风险（已保存设置里本来就有的风险不算，避免每次保存都弹确认）。
 * saved 缺失时按默认设置比较。
 */
export function riskEscalations(current: unknown, saved: unknown): SettingRisk[] {
  const savedIds = new Set(assessSettingRisks(saved).map((risk) => risk.id))
  return assessSettingRisks(current).filter((risk) => !savedIds.has(risk.id))
}

/** 保存前二次确认文案；没有升级风险时返回空串（调用方据此跳过确认） */
export function describeRiskConfirm(risks: readonly SettingRisk[]): string {
  if (!risks.length) return ''
  const details = risks.map((risk) => `${risk.title}（${risk.detail}）`).join('；')
  return `保存后以下安全限制会被放宽：${details}。确定继续保存？`
}

/* ------------------------------------------------------------------ */
/* 页面三态 / 保存可用性 / 失败归因                                     */
/* ------------------------------------------------------------------ */

export type SettingsPagePhase = 'loading' | 'error' | 'ready'

export interface SettingsPhaseInput {
  /** 内核连接是否就绪 */
  ready: boolean
  /** 是否已经拿到设置数据 */
  hasSettings: boolean
  /** 最近一次读取失败原因 */
  loadError?: string
}

/**
 * 设置页阶段：
 * - 有设置数据 → 正常渲染（即使有过读取失败，也不清空已加载内容）；
 * - 没有数据但正在连接 → 骨架屏；
 * - 没有数据且连接就绪/已报错 → 错误态（可重试）。
 */
export function settingsPagePhase(input: SettingsPhaseInput): SettingsPagePhase {
  if (input.hasSettings) return 'ready'
  if (input.loadError) return 'error'
  if (!input.ready) return 'loading'
  return 'error'
}

export interface SaveGateInput {
  phase: SettingsPagePhase
  saving: boolean
  changeCount: number
}

export interface ActionGate {
  ok: boolean
  reason?: string
}

/** 保存按钮是否可用 + 不可用原因（tooltip 与 aria-disabled 共用） */
export function saveGate(input: SaveGateInput): ActionGate {
  if (input.phase === 'loading') return { ok: false, reason: '设置仍在加载，请稍候' }
  if (input.phase === 'error') return { ok: false, reason: '设置尚未加载成功，请先重试读取' }
  if (input.saving) return { ok: false, reason: '正在保存，请稍候' }
  if (input.changeCount <= 0) return { ok: false, reason: '没有需要保存的修改' }
  return { ok: true }
}

export type SaveFailureKind = 'connection' | 'validation' | 'permission' | 'storage' | 'unknown'

export interface SaveFailureInfo {
  kind: SaveFailureKind
  title: string
  reason: string
  hint: string
  retriable: boolean
}

function rawErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string') return error
  if (isRecord(error) && typeof error.message === 'string') return error.message
  return ''
}

function tidyMessage(message: string): string {
  const text = message.replace(/\s+/g, ' ').trim()
  if (!text) return '未知错误（内核没有返回错误信息）'
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

/** 把保存/读取错误归一成「原因 + 建议 + 是否可重试」；不依赖错误类型，只按消息分类 */
export function describeSaveFailure(error: unknown): SaveFailureInfo {
  const reason = tidyMessage(rawErrorMessage(error))
  if (/内核连接|连接尚未建立|not connected|websocket|transport|econnrefused|econnreset|fetch failed|network|网络|已断开/i.test(reason)) {
    return {
      kind: 'connection',
      title: '无法连接内核',
      reason,
      hint: '请确认 CordClean 后台服务/桌面进程仍在运行，然后点「重试保存」；本页修改仍保留。',
      retriable: true,
    }
  }
  if (/eacces|eperm|permission denied|access denied|权限|拒绝访问|只读/i.test(reason)) {
    return {
      kind: 'permission',
      title: '没有写入配置的权限',
      reason,
      hint: '配置文件写入被拒绝：检查数据目录权限，或以管理员身份运行 CordClean 后再试。',
      retriable: true,
    }
  }
  if (/enospc|no space|disk full|磁盘空间|空间不足/i.test(reason)) {
    return {
      kind: 'storage',
      title: '磁盘空间不足',
      reason,
      hint: '清理磁盘或更换数据目录后重试；本次修改还没有写入。',
      retriable: true,
    }
  }
  if (/非法设置|未知设置项|未知设置|层级过深|invalid|validation|zod|unexpected token|不是合法|json/i.test(reason)) {
    return {
      kind: 'validation',
      title: '设置内容未通过校验',
      reason,
      hint: '本次修改没有写入。请检查数值/选项是否合法，或先「恢复默认」再重试；导入的 JSON 需是设置对象。',
      retriable: false,
    }
  }
  return {
    kind: 'unknown',
    title: '保存设置失败',
    reason,
    hint: '修改仍保留在本页，可以重试；反复失败请复制原因反馈。',
    retriable: true,
  }
}

export function saveSuccessMessage(changedCount: number): string {
  const count = Number.isFinite(changedCount) ? Math.max(0, Math.floor(changedCount)) : 0
  return count ? `设置已保存（${count} 项修改）` : '设置已保存'
}

/* ------------------------------------------------------------------ */
/* 分组搜索 / 过滤                                                      */
/* ------------------------------------------------------------------ */

export interface SettingsFilterInput {
  query?: unknown
  /** 只看有未保存修改的分组 */
  onlyDirty?: boolean
  /** 有未保存修改的分组 id（非法 id 自动忽略） */
  dirtyGroups?: readonly string[]
}

export type SettingsEmptyReason = 'no-match' | 'no-dirty'

export interface SettingsFilterResult {
  /** 是否处于过滤态（有关键词或只看未保存） */
  active: boolean
  query: string
  tokens: string[]
  visible: SettingsGroupId[]
  /** 每个可见分组命中的标签（最多 4 个），供「跳到」按钮展示 */
  matches: Partial<Record<SettingsGroupId, string[]>>
  /** 过滤后为空时区分原因，给不同的空状态文案 */
  emptyReason?: SettingsEmptyReason
  totalGroups: number
}

const GROUP_HAYSTACKS = new Map<SettingsGroupId, string>(
  SETTINGS_GROUPS.map((group) => [group.id, [group.title, ...group.entries, ...group.keywords].join(' ').toLowerCase()]),
)

function normalizeDirtyGroups(input: readonly string[] | undefined): Set<SettingsGroupId> {
  const set = new Set<SettingsGroupId>()
  if (!Array.isArray(input)) return set
  for (const id of input) {
    if (typeof id === 'string' && GROUP_ID_SET.has(id)) set.add(id as SettingsGroupId)
  }
  return set
}

function normalizeQuery(input: unknown): string {
  return typeof input === 'string' ? input.trim().slice(0, 120) : ''
}

function collectMatches(group: SettingsGroupMeta, tokens: readonly string[]): string[] {
  const labels: string[] = []
  for (const token of tokens) {
    for (const entry of group.entries) {
      if (entry.toLowerCase().includes(token) && !labels.includes(entry)) labels.push(entry)
    }
    if (group.title.toLowerCase().includes(token) && !labels.includes(group.title)) labels.push(group.title)
    if (labels.length >= 4) return labels.slice(0, 4)
  }
  return labels.slice(0, 4)
}

/**
 * 分组过滤：
 * - 关键词按空白拆分，多个关键词是 AND 关系（每个词都要在标题/标签/同义词里命中）；
 * - `onlyDirty` 与关键词取交集；
 * - 过滤为空时用 `emptyReason` 区分「搜不到」和「没有未保存修改」。
 */
export function filterSettingsGroups(input: SettingsFilterInput): SettingsFilterResult {
  const query = normalizeQuery(input.query)
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .map((token) => token.slice(0, 40))
  const onlyDirty = input.onlyDirty === true
  const dirtyGroups = normalizeDirtyGroups(input.dirtyGroups)
  const candidates = onlyDirty ? SETTINGS_GROUPS.filter((group) => dirtyGroups.has(group.id)) : SETTINGS_GROUPS
  const visible: SettingsGroupId[] = []
  const matches: Partial<Record<SettingsGroupId, string[]>> = {}
  for (const group of candidates) {
    if (tokens.length) {
      const haystack = GROUP_HAYSTACKS.get(group.id) ?? ''
      if (!tokens.every((token) => haystack.includes(token))) continue
      matches[group.id] = collectMatches(group, tokens)
    }
    visible.push(group.id)
  }
  const active = tokens.length > 0 || onlyDirty
  const result: SettingsFilterResult = {
    active,
    query,
    tokens,
    visible,
    matches,
    totalGroups: SETTINGS_GROUPS.length,
  }
  if (active && visible.length === 0) result.emptyReason = tokens.length ? 'no-match' : 'no-dirty'
  return result
}

/** 过滤为空时的空状态文案（区分「搜不到」与「没有未保存修改」） */
export function describeEmptyFilter(result: SettingsFilterResult): { title: string; hint: string } {
  if (result.emptyReason === 'no-dirty') {
    return {
      title: '没有未保存修改的分组',
      hint: '当前所有修改都已保存。可以取消「只看未保存修改」，查看全部设置项。',
    }
  }
  if (result.emptyReason === 'no-match') {
    return {
      title: `没有找到与「${result.query}」匹配的设置项`,
      hint: '可以试试「隔离区」「并发」「回收站」「日志」等关键词，或清空搜索查看全部设置。',
    }
  }
  return { title: '', hint: '' }
}
