/**
 * 启动项管理插件（startup）。
 *
 * 扫描三类自启动项并统一上报：
 * 1. 注册表 `Run` / `RunOnce`（HKCU + HKLM + WOW6432Node）—— `kind: 'registry'`；
 * 2. 用户与公共「启动」文件夹中的快捷方式/文件        —— `kind: 'file'`；
 * 3. 非禁用的计划任务                                —— `kind: 'entry'`。
 *
 * 因为清理对象包含注册表值与「必须一并删除的启动文件夹文件」，整个任务实现了
 * 自定义 `clean`（规范 §4）：
 * - 注册表项：先 `reg export` 导出 .reg 备份，再 `reg delete`；备份失败视为该项失败；
 * - 启动文件夹文件：经内核统一删除入口 `deleteInternal`（引擎不会接手，因为整任务都走自定义清理）；
 * - 计划任务：清理动作是「禁用」而不是删除——
 *   `schtasks /Change /TN "<TaskPath+TaskName>" /DISABLE`，任务本体保留，
 *   可用 `/ENABLE` 恢复；清理项 meta 标记 `action: 'disable'`、`restorable: true`；
 * - HKLM 启动项、计划任务、所有用户启动文件夹需要管理员权限：清理项 meta 标记
 *   `requiresAdmin`，note 提示权限要求；权限不足时返回可读中文错误；
 * - `dryRun` 时只返回 ok，不产生任何写操作（计划任务也不会调用 schtasks）；
 * - 单项失败不影响其它项，且每一步都检查 `cleanCtx.signal.aborted`；
 * - 外部命令统一经可注入的 `CommandRunner` 执行：单测注入假执行器即可验证参数与
 *   失败语义，绝不触碰真实启动项/计划任务。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import Schema from 'schemastery'
import { defineCleanerPlugin } from '@cordclean/shared'
import type { CleanItem, CleanItemDraft, CleanItemResult, TaskCleanContext, TaskEnv, TaskScanContext } from '@cordclean/shared'
import {
  ellipsis,
  errorMessage,
  exists,
  mapLimit,
  parseRegValues,
  powershell,
  reg,
  regExport,
  regQuery,
  runCommand,
  walk,
} from '@cordclean/utils'
import type { CommandOptions, CommandResult } from '@cordclean/utils'

/** 清理项 note 中命令行最多展示的字符数 */
const COMMAND_NOTE_MAX = 120

/** 计划任务最多上报数量（防止一次性刷出上千条） */
const MAX_SCHEDULED_TASKS = 500

/** 并发读取注册表键的数量 */
const REG_CONCURRENCY = 4

/** 计划任务状态码 → 中文状态名（CIM 枚举序列化为数字） */
const TASK_STATE_NAMES: Record<string, string> = {
  '0': '未知',
  '1': '已禁用',
  '2': '排队中',
  '3': '就绪',
  '4': '运行中',
}

/* ------------------------------------------------------------------ */
/* 可注入命令执行器                                                    */
/* ------------------------------------------------------------------ */

/**
 * 命令执行器签名（与 `@cordclean/utils` 的 `runCommand` 一致）。
 *
 * 插件涉及的外部命令都通过它执行：生产环境用 `defaultCommandRunner`，
 * 单测注入假实现即可验证参数拼装、退出码与权限错误映射，绝不改动真实系统。
 */
export type CommandRunner = (file: string, args: string[], options?: CommandOptions) => Promise<CommandResult>

/** 默认执行器：调用真实系统命令 */
export const defaultCommandRunner: CommandRunner = (file, args, options) => runCommand(file, args, options)

/** 计划任务状态操作：disable = 禁用（本工具的清理动作），enable = 恢复 */
export type ScheduledTaskAction = 'disable' | 'enable'

/** 一个计划任务的引用（对应 CIM 的 TaskName + TaskPath） */
export interface ScheduledTaskRef {
  /** 任务名（不含路径），如 `BitLocker Encrypt All Drives` */
  taskName: string
  /** 任务路径，如 `\Microsoft\Windows\BitLocker\`；允许缺省首尾反斜杠 */
  taskPath: string
}

/** 计划任务状态更改结果 */
export interface ScheduledTaskChange {
  ok: boolean
  /** 含路径的完整任务名，如 `\Microsoft\Windows\BitLocker\BitLocker Encrypt All Drives` */
  taskName: string
  /** 可读错误（仅 ok=false 时） */
  error?: string
  /** 原始命令输出（诊断用） */
  detail?: string
  /** schtasks 退出码；执行器抛异常时为 -1 */
  code?: number
}

/** schtasks 权限不足的典型输出（中英文系统） */
const ACCESS_DENIED_PATTERN = /access is denied|access denied|拒绝访问|访问被拒绝|没有足够的权限|0x80070005/i

/** schtasks / reg 找不到目标的典型输出（中英文系统） */
const TARGET_NOT_FOUND_PATTERN = /cannot find|unable to find|找不到|不存在|does not exist|no such task|not exist/i

/** 把 TaskPath 规范化为「以 \ 开头、以 \ 结尾」的形式；缺省为根路径 `\` */
export function normalizeTaskPath(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return '\\'
  const unified = text.replace(/\//g, '\\')
  const leading = unified.startsWith('\\') ? unified : `\\${unified}`
  return leading.endsWith('\\') ? leading : `${leading}\\`
}

/** 计划任务的完整名称（`<TaskPath><TaskName>`），即 schtasks `/TN` 参数 */
export function scheduledTaskFullName(ref: ScheduledTaskRef): string {
  const name = typeof ref.taskName === 'string' ? ref.taskName.trim() : ''
  return `${normalizeTaskPath(ref.taskPath)}${name}`
}

/**
 * 从清理项还原计划任务引用（兼容 meta 缺字段的旧扫描结果）：
 * 依次尝试 `meta.taskName + meta.taskPath`、`meta.taskFullName`，最后解析 `path: 'task:...'`。
 */
export function scheduledTaskRefFromItem(
  item: Pick<CleanItem, 'path'> & { meta?: Record<string, unknown> },
): ScheduledTaskRef | undefined {
  const meta = item.meta ?? {}
  const taskName = typeof meta.taskName === 'string' ? meta.taskName.trim() : ''
  if (taskName) return { taskName, taskPath: normalizeTaskPath(meta.taskPath) }

  const fullFromMeta = typeof meta.taskFullName === 'string' ? meta.taskFullName.trim() : ''
  const fullFromPath = item.path.startsWith('task:') ? item.path.slice('task:'.length).trim() : ''
  const full = fullFromMeta || fullFromPath
  if (!full) return undefined
  const index = full.lastIndexOf('\\')
  const name = index >= 0 ? full.slice(index + 1) : full
  if (!name) return undefined
  return { taskName: name, taskPath: index >= 0 ? normalizeTaskPath(full.slice(0, index + 1)) : '\\' }
}

/** 把 schtasks 失败输出翻译成可读中文错误（区分权限不足 / 任务不存在 / 其它退出码） */
export function readableSchtasksError(result: Pick<CommandResult, 'code' | 'stdout' | 'stderr'>, taskName: string): string {
  const detail = [result.stderr, result.stdout]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
  const snippet = detail ? ellipsis(detail, 200) : `退出码 ${result.code}`
  if (ACCESS_DENIED_PATTERN.test(detail)) {
    return `需要管理员权限：修改计划任务「${taskName}」被拒绝（${snippet}）。请以管理员身份重新运行 CordClean 后重试`
  }
  if (TARGET_NOT_FOUND_PATTERN.test(detail)) {
    return `计划任务不存在或已被删除：「${taskName}」，可能已被系统或其他工具移除`
  }
  return `修改计划任务「${taskName}」失败（退出码 ${result.code}）：${snippet}`
}

/**
 * 修改计划任务状态：禁用（清理动作）或启用（恢复）。
 *
 * 使用 `schtasks /Change /TN <完整任务名> /DISABLE|/ENABLE`。
 * 命令经 `runCommand`（execFile）直接传参，不经 cmd.exe：任务名中的空格/反斜杠
 * 始终作为**单个参数**传递，因此这里不需要手工加引号，也不存在拆词或注入问题。
 */
export async function changeScheduledTaskState(
  runner: CommandRunner,
  ref: ScheduledTaskRef,
  action: ScheduledTaskAction,
  options: { timeout?: number } = {},
): Promise<ScheduledTaskChange> {
  const taskName = scheduledTaskFullName(ref)
  if (!ref.taskName || !ref.taskName.trim()) {
    return { ok: false, taskName, error: '无法解析计划任务名称，已跳过' }
  }
  const flag = action === 'disable' ? '/DISABLE' : '/ENABLE'
  try {
    const result = await runner('schtasks.exe', ['/Change', '/TN', taskName, flag], { timeout: options.timeout ?? 20_000 })
    if (result.ok) return { ok: true, taskName, code: result.code }
    const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join(' ').trim()
    return {
      ok: false,
      taskName,
      code: result.code,
      detail: detail || undefined,
      error: readableSchtasksError(result, taskName),
    }
  } catch (error) {
    return { ok: false, taskName, code: -1, error: `无法执行 schtasks：${errorMessage(error)}` }
  }
}

/** 恢复一个被本工具禁用的计划任务（清理动作的逆操作，调用 `/ENABLE`） */
export function restoreScheduledTask(
  runner: CommandRunner,
  ref: ScheduledTaskRef,
  options: { timeout?: number } = {},
): Promise<ScheduledTaskChange> {
  return changeScheduledTaskState(runner, ref, 'enable', options)
}

/**
 * 计划任务清理项的执行逻辑：把「清理」映射为禁用（可恢复），而不是删除任务。
 * `dryRun` 时不执行任何命令；失败时返回可读错误（权限不足会带管理员提示）。
 */
export async function disableScheduledTaskItem(
  item: CleanItem,
  cleanCtx: Pick<TaskCleanContext, 'dryRun' | 'env' | 'logger' | 'signal'>,
  runner: CommandRunner = defaultCommandRunner,
): Promise<CleanItemResult> {
  // 预演模式：只统计，绝不调用 schtasks
  if (cleanCtx.dryRun) return { itemId: item.id, path: item.path, ok: true, bytes: 0 }
  if (cleanCtx.signal?.aborted) return fail(item, '清理已取消')
  const ref = scheduledTaskRefFromItem(item)
  if (!ref) return fail(item, '无法解析计划任务名称')
  const change = await changeScheduledTaskState(runner, ref, 'disable')
  if (!change.ok) {
    cleanCtx.logger.warn(`禁用计划任务失败：${change.error ?? change.taskName}`)
    let error = change.error ?? '禁用计划任务失败'
    // 非管理员运行时补充可执行的下一步提示（schtasks 有时只返回笼统的失败码）
    if (!cleanCtx.env.elevated && !error.includes('管理员权限')) {
      error += '（当前不是管理员权限，建议以管理员身份运行 CordClean 后重试）'
    }
    return fail(item, error)
  }
  cleanCtx.logger.info(`已禁用计划任务（可恢复）：${change.taskName}`)
  return { itemId: item.id, path: item.path, ok: true, bytes: 0 }
}

export interface StartupConfig {
  /** 是否扫描 HKLM（所有用户）下的 Run/RunOnce */
  includeHklm: boolean
  /** 是否列出非禁用的计划任务（清理动作是禁用，可恢复） */
  includeScheduledTasks: boolean
  /** 注册表备份目录，空字符串表示使用应用数据目录下的 backups */
  backupDir: string
}

/** 创建插件时可注入的依赖（仅单测用） */
export interface StartupPluginOptions {
  /** 命令执行器；缺省调用真实系统命令 */
  runner?: CommandRunner
}

const Config = Schema.object({
  includeHklm: Schema.boolean()
    .default(true)
    .description('同时扫描 HKLM（所有用户）下的 Run / RunOnce 启动项，删除需要管理员权限'),
  includeScheduledTasks: Schema.boolean()
    .default(true)
    .description('列出非禁用的计划任务；清理动作是禁用（不删除任务，可用 /ENABLE 恢复），修改需要管理员权限'),
  backupDir: Schema.string()
    .default('')
    .description('注册表备份目录，留空则使用应用数据目录下的 backups 文件夹'),
})

/** 一个注册表启动项来源 */
export interface RegistrySource {
  /** 短名，用于备份文件名，如 HKCU-Run */
  alias: string
  /** reg.exe 使用的完整键路径 */
  keyPath: string
  /** PowerShell 注册表提供程序路径（兜底读取用），如 HKCU:\Software\... */
  psPath: string
  /** 归类标签，写入 meta.label */
  label: string
  /** 是否属于 HKLM（由配置 includeHklm 控制） */
  machine: boolean
}

/** 一条注册表值 */
export interface RegistryValue {
  name: string
  value: string
}

/** 一个启动文件夹来源 */
export interface FolderSource {
  key: string
  label: string
  path: string
}

/** 注册表 Run / RunOnce 的完整来源列表 */
function registrySources(): RegistrySource[] {
  // 键路径大小写不敏感，这里沿用注册表编辑器中的习惯写法（HKCU 用 Software，HKLM 用 SOFTWARE）
  const run = 'Microsoft\\Windows\\CurrentVersion\\Run'
  const runOnce = 'Microsoft\\Windows\\CurrentVersion\\RunOnce'
  const wowRun = 'WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run'
  const wowRunOnce = 'WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\RunOnce'
  return [
    {
      alias: 'HKCU-Run',
      keyPath: `HKEY_CURRENT_USER\\Software\\${run}`,
      psPath: `HKCU:\\Software\\${run}`,
      label: '当前用户启动（Run）',
      machine: false,
    },
    {
      alias: 'HKCU-RunOnce',
      keyPath: `HKEY_CURRENT_USER\\Software\\${runOnce}`,
      psPath: `HKCU:\\Software\\${runOnce}`,
      label: '当前用户一次性启动（RunOnce）',
      machine: false,
    },
    {
      alias: 'HKLM-Run',
      keyPath: `HKEY_LOCAL_MACHINE\\SOFTWARE\\${run}`,
      psPath: `HKLM:\\SOFTWARE\\${run}`,
      label: '所有用户启动（Run）',
      machine: true,
    },
    {
      alias: 'HKLM-RunOnce',
      keyPath: `HKEY_LOCAL_MACHINE\\SOFTWARE\\${runOnce}`,
      psPath: `HKLM:\\SOFTWARE\\${runOnce}`,
      label: '所有用户一次性启动（RunOnce）',
      machine: true,
    },
    {
      alias: 'HKLM-WOW-Run',
      keyPath: `HKEY_LOCAL_MACHINE\\SOFTWARE\\${wowRun}`,
      psPath: `HKLM:\\SOFTWARE\\${wowRun}`,
      label: '32 位程序启动（WOW6432Node\\Run）',
      machine: true,
    },
    {
      alias: 'HKLM-WOW-RunOnce',
      keyPath: `HKEY_LOCAL_MACHINE\\SOFTWARE\\${wowRunOnce}`,
      psPath: `HKLM:\\SOFTWARE\\${wowRunOnce}`,
      label: '32 位程序一次性启动（WOW6432Node\\RunOnce）',
      machine: true,
    },
  ]
}

/** 启动文件夹来源：当前用户 + 所有用户 */
function folderSources(env: TaskEnv): FolderSource[] {
  return [
    {
      key: 'user-startup',
      label: '当前用户启动文件夹',
      path: path.join(env.appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
    },
    {
      key: 'common-startup',
      label: '所有用户启动文件夹',
      path: path.join(env.programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
    },
  ]
}

/* ------------------------------------------------------------------ */
/* 清理项构造（纯函数，单测可直接断言标记）                            */
/* ------------------------------------------------------------------ */

/** 注册表启动项清理项：HKLM（所有用户）标记 requiresAdmin，note 提示权限要求 */
export function buildRegistryDraft(source: RegistrySource, entry: RegistryValue): CleanItemDraft {
  const command = ellipsis(entry.value, COMMAND_NOTE_MAX)
  const requiresAdmin = source.machine
  return {
    path: `${source.keyPath}\\${entry.name}`,
    kind: 'registry',
    size: 0,
    title: entry.name,
    risk: 'caution',
    defaultSelected: false,
    note: requiresAdmin ? `所有用户启动项，删除需要管理员权限 · ${command}` : command,
    meta: {
      command: entry.value,
      hive: source.keyPath.split('\\')[0],
      keyPath: source.keyPath,
      valueName: entry.name,
      label: source.label,
      kind: 'registry',
      requiresAdmin,
    },
  }
}

/** 启动文件夹清理项：所有用户启动文件夹标记 requiresAdmin，note 提示权限要求 */
export function buildStartupFolderDraft(
  folder: FolderSource,
  entry: { path: string; size: number; name: string },
  policyAllowed: boolean,
): CleanItemDraft {
  const requiresAdmin = folder.key === 'common-startup'
  const adminNote = requiresAdmin ? '删除需要管理员权限' : '可直接删除'
  // 启动文件夹位于受保护根内：路径策略拒绝时如实提示改用系统设置
  const protectionNote = policyAllowed ? '' : '（受内核路径保护，需在系统设置中禁用）'
  return {
    path: entry.path,
    kind: 'file',
    size: entry.size,
    title: entry.name,
    risk: 'caution',
    defaultSelected: false,
    note: `${folder.label}中的自启动文件（${adminNote}）${protectionNote}`,
    meta: {
      source: folder.key,
      label: folder.label,
      folder: folder.path,
      kind: 'startup-folder',
      requiresAdmin,
    },
  }
}

/**
 * 计划任务清理项：明确「清理 = 禁用（可恢复）」，绝不删除任务本身。
 * meta 记录 taskName / taskPath / taskFullName，供禁用与恢复（/ENABLE）复用。
 */
export function buildScheduledTaskDraft(ref: ScheduledTaskRef, state: string): CleanItemDraft {
  const taskFullName = scheduledTaskFullName(ref)
  const stateText = state ? `当前状态：${state}` : '状态未知'
  return {
    path: `task:${taskFullName}`,
    kind: 'entry',
    size: 0,
    title: ref.taskName,
    risk: 'risky',
    defaultSelected: false,
    note: `计划任务（${stateText}）：清理动作是禁用（可恢复，不删除任务），需要管理员权限；恢复用 schtasks /Change /ENABLE`,
    meta: {
      taskName: ref.taskName,
      taskPath: normalizeTaskPath(ref.taskPath),
      taskFullName,
      state,
      kind: 'scheduled-task',
      action: 'disable',
      restorable: true,
      requiresAdmin: true,
    },
  }
}

/* ------------------------------------------------------------------ */
/* 注册表读取                                                          */
/* ------------------------------------------------------------------ */

/** 用 parseRegValues 解析 reg.exe 输出（输出为 GBK/UTF-8 混合，可能产生替换字符） */
function parseRegistryText(output: string): RegistryValue[] {
  return parseRegValues(output).map((entry) => ({ name: entry.name, value: entry.value }))
}

/** 解析结果中是否出现编码替换字符（说明 reg.exe 的 GBK 输出被按 UTF-8 解码） */
function hasGarbledText(values: RegistryValue[]): boolean {
  return values.some((value) => value.name.includes('\uFFFD') || value.value.includes('\uFFFD'))
}

/** 注册表值可能是数组（REG_MULTI_SZ）或数字，统一转成字符串 */
function stringifyRegistryValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => String(item)).join(' ')
  if (value === null || value === undefined) return ''
  return String(value)
}

/**
 * PowerShell 兜底读取：`reg.exe` 输出编码异常时用它拿到正确的值名与命令行。
 * 返回空数组表示键不存在、键为空或读取失败，调用方会退回 reg.exe 的解析结果。
 */
async function readRegistryValuesViaPowerShell(psPath: string): Promise<RegistryValue[]> {
  const script = [
    `$key = '${psPath}'`,
    'if (Test-Path -LiteralPath $key) {',
    "  Get-ItemProperty -LiteralPath $key | Select-Object * -ExcludeProperty 'PS*' | ConvertTo-Json -Compress",
    '}',
  ].join('; ')
  const result = await powershell(script, { timeout: 20_000 })
  if (!result.ok || !result.stdout.trim()) return []
  try {
    const data: unknown = JSON.parse(result.stdout)
    if (!data || typeof data !== 'object' || Array.isArray(data)) return []
    return Object.entries(data as Record<string, unknown>)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([name, value]) => ({ name, value: stringifyRegistryValue(value) }))
  } catch {
    return []
  }
}

/**
 * 读取一组注册表启动项。
 *
 * 主路径严格使用 `regQuery` + `parseRegValues`；当解析结果为空（可能是编码问题、
 * 也可能是键确实为空）或出现乱码时，并发地用 PowerShell 兜底读一次，
 * 避免中文系统下 GBK 输出被吞掉导致「启动项凭空消失」。
 */
async function collectRegistryValues(
  scan: TaskScanContext,
  sources: RegistrySource[],
): Promise<Array<{ source: RegistrySource; values: RegistryValue[] }>> {
  const primaries = await mapLimit(sources, REG_CONCURRENCY, async (source) => {
    const raw = await regQuery(source.keyPath)
    return { source, values: parseRegistryText(raw) }
  })

  const needFallback = primaries.filter((item) => !item.values.length || hasGarbledText(item.values))
  if (!needFallback.length) return primaries

  const fallback = await mapLimit(needFallback, REG_CONCURRENCY, async (item) => {
    const values = await readRegistryValuesViaPowerShell(item.source.psPath)
    // 兜底也读不到时保留 reg.exe 的解析结果（键确实为空时两者都是空）
    return { keyPath: item.source.keyPath, values: values.length ? values : item.values }
  })
  const byKey = new Map(fallback.map((item) => [item.keyPath, item.values]))
  scan.logger.debug(`注册表读取兜底：${needFallback.map((item) => item.source.alias).join(', ')}`)
  return primaries.map((item) => ({ source: item.source, values: byKey.get(item.source.keyPath) ?? item.values }))
}

/* ------------------------------------------------------------------ */
/* 扫描                                                                */
/* ------------------------------------------------------------------ */

/** 扫描注册表 Run / RunOnce 项 */
async function scanRegistry(scan: TaskScanContext, includeHklm: boolean): Promise<void> {
  const sources = registrySources().filter((source) => includeHklm || !source.machine)
  const groups = await collectRegistryValues(scan, sources)
  for (const { source, values } of groups) {
    scan.throwIfAborted()
    for (const entry of values) {
      // reg.exe 无法按值名删除「默认」值，这类条目跳过（Run 键实际也不会出现）
      if (!entry.name || entry.name === '(Default)' || entry.name === '(默认)') continue
      scan.emit(buildRegistryDraft(source, entry))
    }
  }
}

/** 扫描启动文件夹中的快捷方式 / 可执行文件 */
async function scanStartupFolders(scan: TaskScanContext, env: TaskEnv): Promise<void> {
  for (const folder of folderSources(env)) {
    scan.throwIfAborted()
    if (!(await exists(folder.path))) continue
    for await (const entry of walk(folder.path, {
      maxDepth: 1,
      signal: scan.signal,
      onError: (target, error) => scan.addError({ path: target, message: errorMessage(error) }),
    })) {
      if (entry.isDirectory) continue
      // desktop.ini 是资源管理器的显示配置文件，不是启动项
      if (entry.name.toLowerCase() === 'desktop.ini') continue
      // 启动文件夹位于内核的受保护根（AppData\Roaming / ProgramData）之内，
      // 路径策略会把这些项标记为 protected，这里如实提示用户改用系统设置。
      const allowed = scan.pathPolicy.check(entry.path).allowed
      scan.emit(buildStartupFolderDraft(folder, entry, allowed))
    }
  }
}

/** 计划任务状态码转中文 */
function scheduledStateName(state: unknown): string {
  if (typeof state === 'string' && state) return TASK_STATE_NAMES[state] ?? state
  if (typeof state === 'number') return TASK_STATE_NAMES[String(state)] ?? String(state)
  return '未知'
}

/**
 * 扫描计划任务（只列出非禁用项）。
 * 清理动作是禁用而不是删除：清理项 meta 标记 action=disable / restorable=true。
 */
async function scanScheduledTasks(scan: TaskScanContext): Promise<void> {
  const result = await powershell(
    'Get-ScheduledTask | Where-Object {$_.State -ne "Disabled"} | Select-Object TaskName,TaskPath,State | ConvertTo-Json -Compress',
    { timeout: 60_000 },
  )
  if (!result.ok) {
    scan.addError({ path: 'task:', message: `读取计划任务失败：${result.stderr.trim() || '未知错误'}` })
    return
  }
  if (!result.stdout.trim()) return

  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch (error) {
    scan.addError({ path: 'task:', message: `解析计划任务列表失败：${errorMessage(error)}` })
    return
  }
  // ConvertTo-Json 在只有一个任务时输出对象而不是数组
  const list = Array.isArray(parsed) ? parsed : [parsed]
  let emitted = 0
  for (const raw of list) {
    scan.throwIfAborted()
    const record = raw as Record<string, unknown>
    const name = typeof record?.TaskName === 'string' ? record.TaskName.trim() : ''
    if (!name) continue
    if (emitted >= MAX_SCHEDULED_TASKS) {
      scan.addError({ path: 'task:', message: `计划任务超过上限（${MAX_SCHEDULED_TASKS}），已截断` })
      break
    }
    const rawPath = typeof record?.TaskPath === 'string' ? record.TaskPath : '\\'
    const taskPath = rawPath.endsWith('\\') ? rawPath : `${rawPath}\\`
    emitted++
    scan.emit(buildScheduledTaskDraft({ taskName: name, taskPath }, scheduledStateName(record?.State)))
  }
}

/* ------------------------------------------------------------------ */
/* 自定义清理                                                          */
/* ------------------------------------------------------------------ */

/** 时间戳（用于备份文件名）：20250101-120000 */
function formatStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return [
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
  ].join('-')
}

/** 把注册表键路径缩成可读的备份文件后缀：HKCU\...\Run → HKCU-Run */
function keyAlias(keyPath: string): string {
  const parts = keyPath.split('\\').filter(Boolean)
  const hive = (parts[0] ?? 'HKEY')
    .replace(/^HKEY_CURRENT_USER$/i, 'HKCU')
    .replace(/^HKEY_LOCAL_MACHINE$/i, 'HKLM')
    .replace(/^HKEY_USERS$/i, 'HKU')
    .replace(/^HKEY_CLASSES_ROOT$/i, 'HKCR')
  const tail = parts[parts.length - 1] ?? 'key'
  const wow = parts.some((part) => part.toLowerCase() === 'wow6432node') ? '-WOW' : ''
  return `${hive}-${tail}${wow}`.replace(/[^A-Za-z0-9_-]+/g, '')
}

/** 解析备份目录：配置为空时落在 <dataDir>\backups */
function resolveBackupDir(env: TaskEnv, configured: string): string {
  const trimmed = (configured ?? '').trim()
  return trimmed ? path.resolve(trimmed) : path.join(env.dataDir, 'backups')
}

/** 清理项的类别：优先取 meta.kind，其次按 item.kind / path 形式推断 */
function resolveItemKind(item: CleanItem, meta: Record<string, unknown>): string {
  const tag = typeof meta.kind === 'string' ? meta.kind : ''
  if (tag === 'registry' || tag === 'startup-folder' || tag === 'scheduled-task') return tag
  if (item.kind === 'registry') return 'registry'
  if (item.kind === 'entry' || item.path.startsWith('task:')) return 'scheduled-task'
  if (item.kind === 'file' || item.kind === 'directory') return 'startup-folder'
  return 'unknown'
}

/** 从清理项中还原注册表键路径与值名 */
function splitRegistryPath(item: CleanItem, meta: Record<string, unknown>): { keyPath: string; valueName: string } {
  if (typeof meta.keyPath === 'string' && typeof meta.valueName === 'string' && meta.valueName) {
    return { keyPath: meta.keyPath, valueName: meta.valueName }
  }
  const index = item.path.lastIndexOf('\\')
  if (index <= 0) return { keyPath: '', valueName: '' }
  return { keyPath: item.path.slice(0, index), valueName: item.path.slice(index + 1) }
}

/** 构造失败结果 */
function fail(item: CleanItem, error: string): CleanItemResult {
  return { itemId: item.id, path: item.path, ok: false, bytes: 0, error }
}

/** 清理项是否需要管理员权限（优先 meta.requiresAdmin，其次兼容旧数据的 HKLM 键路径 / 公共启动文件夹推断） */
function itemRequiresAdmin(meta: Record<string, unknown>): boolean {
  if (meta.requiresAdmin === true) return true
  if (meta.source === 'common-startup') return true
  return typeof meta.keyPath === 'string' && /^HKEY_LOCAL_MACHINE/i.test(meta.keyPath)
}

/** 把命令的多段输出压成一行，写进可读错误里 */
function commandDetail(parts: Array<string | undefined>): string {
  return parts
    .map((part) => (part ?? '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
}

/**
 * 清理动作失败的可读错误：
 * - 权限不足 / 非管理员却需要管理员 → 明确提示「需要管理员权限」和下一步操作；
 * - 目标已消失 → 提示可能被其它程序修改；
 * - 其它失败 → 带上原始命令输出，避免只报一句「失败」。
 */
function readableActionError(
  item: CleanItem,
  actionText: string,
  detail: string | undefined,
  requiresAdmin: boolean,
  env: TaskEnv,
): string {
  const text = (detail ?? '').trim()
  const suffix = text ? `（${ellipsis(text, 160)}）` : ''
  if (ACCESS_DENIED_PATTERN.test(text) || (requiresAdmin && !env.elevated)) {
    return `需要管理员权限：${actionText}「${item.title}」失败${suffix}。请以管理员身份重新运行 CordClean 后重试`
  }
  if (TARGET_NOT_FOUND_PATTERN.test(text)) {
    return `${actionText}「${item.title}」失败：目标已不存在或被其它程序修改`
  }
  return `${actionText}「${item.title}」失败${suffix || '：未知错误'}`
}

/** 导出注册表键备份，成功返回备份文件路径 */
async function backupRegistryKey(
  keyPath: string,
  backupDir: string,
  stamp: string,
  cleanCtx: TaskCleanContext,
): Promise<string | null> {
  try {
    await fs.mkdir(backupDir, { recursive: true })
  } catch (error) {
    cleanCtx.logger.warn(`创建备份目录失败：${errorMessage(error)}`)
    return null
  }
  // 文件名带上键别名，避免多个 Run 键互相覆盖同一份备份
  const file = path.join(backupDir, `startup-${stamp}-${keyAlias(keyPath)}.reg`)
  if (!(await regExport(keyPath, file))) {
    cleanCtx.logger.warn(`导出注册表备份失败：${keyPath}`)
    return null
  }
  cleanCtx.logger.info(`已导出注册表备份：${file}`)
  return file
}

/** 创建 startup 插件；`runner` 供单测注入假命令执行器（默认执行真实系统命令） */
export function createStartupPlugin(options: StartupPluginOptions = {}) {
  const runner = options.runner ?? defaultCommandRunner
  return defineCleanerPlugin<StartupConfig>({
    name: 'startup',
    version: '1.1.0',
    description: '注册表 Run/RunOnce 与启动文件夹中的自启动项（备份后删除）；计划任务改为禁用（可恢复，不删除任务）',
    inject: ['cleaner', 'pathPolicy', 'system'],
    Config,
    setup(ctx, config) {
      const env = ctx.system.env
      // 配置文件中可能残留旧版本字段，这里补齐默认值，避免 undefined 影响判断
      const settings: StartupConfig = {
        includeHklm: config?.includeHklm ?? true,
        includeScheduledTasks: config?.includeScheduledTasks ?? true,
        backupDir: config?.backupDir ?? '',
      }
      const registryTargets = registrySources().map((source) => source.keyPath)
      const folderTargets = folderSources(env).map((folder) => folder.path)

      ctx.effect(() =>
        ctx.cleaner.define({
          id: 'startup',
          name: '启动项',
          description: '注册表 Run/RunOnce 与启动文件夹中的自启动项；计划任务的清理动作是禁用（可恢复）',
          category: 'startup',
          risk: 'caution',
          icon: '🚀',
          defaultSelected: false,
          requiresAdmin: true,
          estimatedMs: 8000,
          targets: [...registryTargets, ...folderTargets],
          tips: [
            '注册表启动项删除前会自动导出 .reg 备份到数据目录 backups 文件夹，误删可从备份恢复',
            '计划任务的清理动作是「禁用」而不是删除：任务本体保留，可用 schtasks /Change /ENABLE 恢复',
            'HKLM 启动项、计划任务与所有用户启动文件夹需要以管理员身份运行才能修改',
          ],
          async scan(scan) {
            // 计划任务需要一次 PowerShell 调用（约 1-2 秒），与注册表/文件夹扫描并行执行
            const scheduled = settings.includeScheduledTasks ? scanScheduledTasks(scan) : undefined
            // ① 注册表 Run / RunOnce
            await scanRegistry(scan, settings.includeHklm)
            // ② 启动文件夹
            await scanStartupFolders(scan, env)
            // ③ 计划任务（清理动作 = 禁用，可恢复）
            if (scheduled) await scheduled
          },
          async clean(items, cleanCtx) {
            const results: CleanItemResult[] = []
            const backupDir = resolveBackupDir(cleanCtx.env, settings.backupDir)
            const stamp = formatStamp(new Date())
            /** keyPath（小写）→ 备份文件路径；null 表示该键导出失败 */
            const backups = new Map<string, string | null>()

            for (const item of items) {
              // 逐项检查取消信号：中断后剩余项直接不返回（引擎按失败计数）
              if (cleanCtx.signal.aborted) break
              const meta = (item.meta ?? {}) as Record<string, unknown>
              const kind = resolveItemKind(item, meta)
              const requiresAdmin = itemRequiresAdmin(meta)

              // 预演模式：只统计、不写注册表、不删文件、不调用 schtasks
              if (cleanCtx.dryRun) {
                results.push({ itemId: item.id, path: item.path, ok: true, bytes: item.size })
                continue
              }

              if (kind === 'scheduled-task') {
                // 清理 = 禁用（/DISABLE），不删除任务；失败返回可读错误（权限不足带管理员提示）
                results.push(await disableScheduledTaskItem(item, cleanCtx, runner))
                continue
              }

              if (kind === 'registry') {
                const { keyPath, valueName } = splitRegistryPath(item, meta)
                if (!keyPath || !valueName) {
                  results.push(fail(item, '无法解析注册表键路径'))
                  continue
                }
                // 同一个键只备份一次（一次清理通常会删除同一 Run 键下的多个值）
                const cacheKey = keyPath.toLowerCase()
                let backupFile = backups.get(cacheKey)
                if (backupFile === undefined) {
                  backupFile = await backupRegistryKey(keyPath, backupDir, stamp, cleanCtx)
                  backups.set(cacheKey, backupFile)
                }
                if (!backupFile) {
                  results.push(
                    fail(
                      item,
                      requiresAdmin
                        ? `需要管理员权限：导出 HKLM 启动项「${item.title}」备份失败，已跳过该项。请以管理员身份重新运行 CordClean 后重试`
                        : '导出注册表备份失败，已跳过该项',
                    ),
                  )
                  continue
                }
                // 用 reg delete 的原始输出区分「权限不足」「值已不存在」与其它失败
                const deletion = await reg(['delete', keyPath, '/v', valueName, '/f'])
                if (deletion.ok) {
                  results.push({ itemId: item.id, path: item.path, ok: true, bytes: 0 })
                } else {
                  const detail = commandDetail([deletion.stderr, deletion.stdout])
                  results.push(
                    fail(
                      item,
                      readableActionError(
                        item,
                        requiresAdmin ? '删除 HKLM 启动项' : '删除启动项',
                        detail,
                        requiresAdmin,
                        cleanCtx.env,
                      ),
                    ),
                  )
                }
                continue
              }

              if (kind === 'startup-folder') {
                // 统一删除入口：启动文件夹快捷方式经执行器按 reason 校验后删除，
                // 插件不再直接 deletePath（路径策略对该目录是保护态，见 deleteInternal）
                if (!cleanCtx.deleteInternal) {
                  results.push(fail(item, '内核未提供统一删除入口，已跳过（需升级内核）'))
                  continue
                }
                const removed = await cleanCtx.deleteInternal(item.path, 'startup-entry')
                if (removed.ok) {
                  results.push({ itemId: item.id, path: item.path, ok: true, bytes: removed.bytes || item.size })
                } else {
                  results.push(
                    fail(
                      item,
                      readableActionError(
                        item,
                        '删除启动文件夹中的自启动文件',
                        removed.error,
                        requiresAdmin,
                        cleanCtx.env,
                      ),
                    ),
                  )
                }
                continue
              }

              results.push(fail(item, '未知的启动项类型'))
            }

            return results
          },
        }),
      )
    },
  })
}

export default createStartupPlugin()
