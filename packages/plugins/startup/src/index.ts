/**
 * 启动项管理插件（startup）。
 *
 * 扫描三类自启动项并统一上报：
 * 1. 注册表 `Run` / `RunOnce`（HKCU + HKLM + WOW6432Node）—— `kind: 'registry'`；
 * 2. 用户与公共「启动」文件夹中的快捷方式/文件        —— `kind: 'file'`；
 * 3. 非禁用的计划任务（**只报告**，不支持在本工具中修改）—— `kind: 'entry'`。
 *
 * 因为清理对象包含注册表值与「必须一并删除的启动文件夹文件」，整个任务实现了
 * 自定义 `clean`（规范 §4）：
 * - 注册表项：先 `regExport` 导出 .reg 备份，再 `regDeleteValue`；备份失败视为该项失败；
 * - 启动文件夹文件：直接 `deletePath`（引擎不会接手，因为整任务都走自定义清理）；
 * - 计划任务：一律返回失败并提示到系统工具中管理；
 * - `dryRun` 时只返回 ok，不产生任何写操作；
 * - 单项失败不影响其它项，且每一步都检查 `cleanCtx.signal.aborted`。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import Schema from 'schemastery'
import { defineCleanerPlugin } from '@cordclean/shared'
import type { CleanItem, CleanItemResult, TaskCleanContext, TaskEnv, TaskScanContext } from '@cordclean/shared'
import {
  deletePath,
  describeDeleteError,
  ellipsis,
  errorMessage,
  exists,
  mapLimit,
  parseRegValues,
  powershell,
  regDeleteValue,
  regExport,
  regQuery,
  walk,
} from '@cordclean/utils'

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

export interface StartupConfig {
  /** 是否扫描 HKLM（所有用户）下的 Run/RunOnce */
  includeHklm: boolean
  /** 是否列出计划任务（仅报告） */
  includeScheduledTasks: boolean
  /** 注册表备份目录，空字符串表示使用应用数据目录下的 backups */
  backupDir: string
}

const Config = Schema.object({
  includeHklm: Schema.boolean()
    .default(true)
    .description('同时扫描 HKLM（所有用户）下的 Run / RunOnce 启动项，删除需要管理员权限'),
  includeScheduledTasks: Schema.boolean()
    .default(true)
    .description('列出非禁用的计划任务（仅报告，不支持在本工具中修改）'),
  backupDir: Schema.string()
    .default('')
    .description('注册表备份目录，留空则使用应用数据目录下的 backups 文件夹'),
})

/** 一个注册表启动项来源 */
interface RegistrySource {
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
interface RegistryValue {
  name: string
  value: string
}

/** 一个启动文件夹来源 */
interface FolderSource {
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
      scan.emit({
        path: `${source.keyPath}\\${entry.name}`,
        kind: 'registry',
        size: 0,
        title: entry.name,
        risk: 'caution',
        defaultSelected: false,
        note: ellipsis(entry.value, COMMAND_NOTE_MAX),
        meta: {
          command: entry.value,
          hive: source.keyPath.split('\\')[0],
          keyPath: source.keyPath,
          valueName: entry.name,
          label: source.label,
          kind: 'registry',
        },
      })
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
      scan.emit({
        path: entry.path,
        kind: 'file',
        size: entry.size,
        title: entry.name,
        risk: 'caution',
        defaultSelected: false,
        note: allowed
          ? `${folder.label}中的自启动文件`
          : `${folder.label}中的自启动文件（受内核路径保护，需在系统设置中禁用）`,
        meta: { source: folder.key, label: folder.label, folder: folder.path, kind: 'startup-folder' },
      })
    }
  }
}

/** 计划任务状态码转中文 */
function scheduledStateName(state: unknown): string {
  if (typeof state === 'string' && state) return TASK_STATE_NAMES[state] ?? state
  if (typeof state === 'number') return TASK_STATE_NAMES[String(state)] ?? String(state)
  return '未知'
}

/** 扫描计划任务（只报告，不提供修改能力） */
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
    scan.emit({
      path: `task:${taskPath}${name}`,
      kind: 'entry',
      size: 0,
      title: name,
      risk: 'risky',
      defaultSelected: false,
      note: '计划任务请在系统工具中管理',
      meta: {
        taskName: name,
        taskPath,
        state: scheduledStateName(record?.State),
        kind: 'scheduled-task',
      },
    })
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

export default defineCleanerPlugin<StartupConfig>({
  name: 'startup',
  version: '1.0.0',
  description: '注册表 Run/RunOnce 与启动文件夹中的自启动项，备份后删除（计划任务仅报告）',
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
        description: '注册表 Run/RunOnce 与启动文件夹中的自启动项；计划任务仅报告',
        category: 'startup',
        risk: 'caution',
        icon: '🚀',
        defaultSelected: false,
        requiresAdmin: true,
        estimatedMs: 8000,
        targets: [...registryTargets, ...folderTargets],
        tips: ['禁用前会自动导出注册表备份到数据目录 backups 文件夹', '误删可从 .reg 备份恢复'],
        async scan(scan) {
          // 计划任务需要一次 PowerShell 调用（约 1-2 秒），与注册表/文件夹扫描并行执行
          const scheduled = settings.includeScheduledTasks ? scanScheduledTasks(scan) : undefined
          // ① 注册表 Run / RunOnce
          await scanRegistry(scan, settings.includeHklm)
          // ② 启动文件夹
          await scanStartupFolders(scan, env)
          // ③ 计划任务（仅报告）
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

            // 预演模式：只统计、不写注册表、不删文件
            if (cleanCtx.dryRun) {
              results.push({ itemId: item.id, path: item.path, ok: true, bytes: item.size })
              continue
            }

            if (kind === 'scheduled-task') {
              results.push(fail(item, '计划任务不支持在本工具中修改'))
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
                results.push(fail(item, '导出注册表备份失败，已跳过该项'))
                continue
              }
              if (await regDeleteValue(keyPath, valueName)) {
                results.push({ itemId: item.id, path: item.path, ok: true, bytes: 0 })
              } else {
                results.push(fail(item, '删除注册表值失败（可能需要管理员权限）'))
              }
              continue
            }

            if (kind === 'startup-folder') {
              try {
                const deleted = await deletePath(item.path)
                results.push({ itemId: item.id, path: item.path, ok: true, bytes: deleted.bytes || item.size })
              } catch (error) {
                results.push(fail(item, describeDeleteError(error)))
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
