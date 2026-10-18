/**
 * 应用残留分析插件（leftovers）。
 *
 * 目标：找出「已卸载软件」在本机留下的痕迹，并按「能不能清理」分成两类：
 *
 * 1. 注册表残留（可清理，清理前自动导出 .reg 备份）：
 *    - A 类：`InstallLocation` 非空但目录已不存在（安装目录已丢失）；
 *    - B 类：`UninstallString` / `DisplayIcon` 指向的 exe 已不存在（卸载程序已丢失）。
 * 2. 目录残留（**只报告**，永不参与清理）：`Program Files` / `Program Files (x86)` /
 *    `%LOCALAPPDATA%` / `%APPDATA%` 下修改时间超过 180 天、且目录名与任何已安装软件
 *    都对不上的目录。
 *
 * 安全约定（见 docs/plugin-authoring.md「安全红线」）：
 * - 本插件不调用 `pathPolicy.addRoot()`，因此所有目录类上报项都会被内核标记为受保护项，
 *   引擎绝不会删除它们；
 * - 自定义 `clean` 只做「导出备份 + 删除注册表键」，不触碰文件系统内容；
 * - 所有上报项都是 `defaultSelected: false`（`caution` / `risky`）。
 *
 * 注册表读取策略：中文 Windows 上 `reg.exe` 的输出是 GBK，直接按 UTF-8 解码会出现乱码，
 * 因此**优先使用 PowerShell 注册表提供程序 + ConvertTo-Json**（输出为真正的 Unicode），
 * 仅在 PowerShell 不可用时退化为 `reg query` + `parseRegValues`。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import Schema from 'schemastery'
import { defineCleanerPlugin } from '@cordclean/shared'
import type { CleanItem, CleanItemResult, TaskCleanContext, TaskEnv } from '@cordclean/shared'
import {
  errorMessage,
  exists,
  isAbsolutePath,
  mapLimit,
  normalizePath,
  parseRegSubKeys,
  parseRegValues,
  powershell,
  regDeleteKey,
  regExport,
  regQuery,
  safeStat,
} from '@cordclean/utils'

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/** 卸载项所在的 4 个注册表位置（全部只是「读取」，写操作在 clean 中由用户显式触发） */
export const UNINSTALL_ROOTS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
]

/** 疑似残留目录的判定：修改时间必须早于 N 天 */
const SUSPECT_MAX_AGE_DAYS = 180
/** 疑似残留目录最多上报条数 */
const SUSPECT_MAX_ITEMS = 50
/** 目录名过短时匹配「DisplayName 子串」几乎必然命中，直接跳过（更保守） */
const SUSPECT_MIN_NAME_LENGTH = 3
/**
 * 目录名黑名单：这些是 Windows / 运行时自身的目录，不属于「应用残留」。
 * 加黑名单是为了让「疑似残留」的提示更保守，避免把系统目录报给用户。
 */
const SUSPECT_DENY_NAMES = new Set([
  'common files',
  'internet explorer',
  'modifiablewindowsapps',
  'msbuild',
  'reference assemblies',
  'uninstall information',
  'windowsapps',
  'windows defender',
  'windows mail',
  'windows media player',
  'windows nt',
  'windows photo viewer',
  'windows portable devices',
  'windows sidebar',
  'windowspowershell',
  'microsoft',
  'microsoft.net',
  'microsoft office',
  'microsoft shared',
  'dotnet',
  'temp',
  'packages',
  'programs',
  'virtualstore',
  'crashdumps',
  'd3dscache',
  'connecteddevicesplatform',
])

/** 卸载条目中需要读取的值名（顺序与 UninstallEntry 字段一致） */
const UNINSTALL_FIELDS: Array<[keyof UninstallEntry, string]> = [
  ['displayName', 'DisplayName'],
  ['version', 'DisplayVersion'],
  ['publisher', 'Publisher'],
  ['installLocation', 'InstallLocation'],
  ['uninstallString', 'UninstallString'],
  ['displayIcon', 'DisplayIcon'],
]

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

export interface LeftoversConfig {
  includeRegistry: boolean
  includeDirectories: boolean
  backupDir: string
}

const Config = Schema.object({
  includeRegistry: Schema.boolean()
    .default(true)
    .description('分析注册表卸载项，找出安装目录或卸载程序已丢失的残留项（清理前自动导出 .reg 备份）'),
  includeDirectories: Schema.boolean()
    .default(true)
    .description('在 Program Files / AppData 下提示疑似残留目录（只做提示，永远不会被删除）'),
  backupDir: Schema.string()
    .default('')
    .description('注册表备份目录，留空表示使用数据目录下的 backups 文件夹'),
})

/** 一个注册表卸载项 */
export interface UninstallEntry {
  /** 卸载项完整键路径，如 HKEY_LOCAL_MACHINE\SOFTWARE\...\Uninstall\7-Zip */
  key: string
  displayName: string
  version: string
  publisher: string
  installLocation: string
  uninstallString: string
  displayIcon: string
}

/** 残留类型：A 类（安装目录缺失）/ B 类（卸载程序缺失） */
export type ResidualKind = 'install-dir' | 'uninstaller'

export interface ResidualHint {
  kind: ResidualKind
  /** 缺失的那个路径，用于 note 与 meta */
  detail: string
}

/** 注册表卸载项的收集结果（同时暴露给自测脚本，便于证明扫描真实执行） */
export interface UninstallCollection {
  entries: UninstallEntry[]
  /** 实际使用的读取方式 */
  source: 'powershell' | 'reg'
  warnings: string[]
}

/** 疑似残留目录 */
export interface SuspectDirectory {
  path: string
  name: string
  /** 所属根目录（用于界面分组） */
  root: string
  /** 距今天数（目录最后修改时间） */
  ageDays: number
}

export interface SuspectDirectoryOptions {
  env: TaskEnv
  entries: UninstallEntry[]
  /** 最小目录年龄（天），默认 180 */
  minAgeDays?: number
  /** 最多返回条数，默认 50 */
  maxItems?: number
  /** 自定义扫描根，默认 Program Files / Program Files (x86) / %LOCALAPPDATA% / %APPDATA% */
  roots?: Array<{ label: string; path: string }>
}

/* ------------------------------------------------------------------ */
/* 注册表读取                                                          */
/* ------------------------------------------------------------------ */

/** 把 HKLM\A\B 形式的键转换成 PowerShell 注册表提供程序路径 HKLM:\A\B */
function toPsRegistryPath(key: string): string {
  return key.replace(/^HKLM\\/i, 'HKLM:\\').replace(/^HKCU\\/i, 'HKCU:\\')
}

/** 统一键路径（去掉结尾分隔符），并以 HKEY_ 长格式返回 */
function normalizeKeyPath(key: string): string {
  return key.trim().replace(/[\\/]+$/, '').replace(/^HKLM\\/i, 'HKEY_LOCAL_MACHINE\\').replace(/^HKCU\\/i, 'HKEY_CURRENT_USER\\')
}

/**
 * 构造 PowerShell 枚举脚本：逐个打开子键并读取需要的值。
 *
 * 这里刻意不使用 `Get-ItemProperty | ConvertTo-Json`，而是用 `OpenSubKey` +
 * `GetValue`：这样即使某个键没有任何值也一定能拿到键路径，避免漏项。
 */
function buildEnumerationScript(roots: string[]): string {
  const blocks = roots
    .map(
      (root) => `
$key = Get-Item -LiteralPath '${toPsRegistryPath(root)}' -ErrorAction SilentlyContinue
if ($key) {
  foreach ($sub in $key.GetSubKeyNames()) {
    $child = $null
    try { $child = $key.OpenSubKey($sub) } catch { continue }
    if ($child) {
      $out += [pscustomobject]@{
        key = $key.Name + '\\' + $sub
${UNINSTALL_FIELDS.map(([field, valueName]) => `        ${field} = [string]$child.GetValue('${valueName}')`).join('\n')}
      }
      $child.Close()
    }
  }
}`,
    )
    .join('\n')
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$out = @()',
    blocks,
    'ConvertTo-Json -InputObject @($out) -Compress -Depth 4',
  ].join('\n')
}

/** 安全解析 PowerShell 输出的 JSON（单个对象 / 数组 / 空输出都能处理） */
function parseJsonResult(text: string): unknown[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return parsed
    return parsed ? [parsed] : []
  } catch {
    return []
  }
}

function str(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

/** PowerShell 结果 → 条目 */
function toEntry(raw: any): UninstallEntry | undefined {
  const key = normalizeKeyPath(str(raw?.key))
  if (!key) return undefined
  const entry: UninstallEntry = {
    key,
    displayName: str(raw?.displayName).trim(),
    version: str(raw?.version).trim(),
    publisher: str(raw?.publisher).trim(),
    installLocation: str(raw?.installLocation).trim(),
    uninstallString: str(raw?.uninstallString).trim(),
    displayIcon: str(raw?.displayIcon).trim(),
  }
  return entry
}

/** 用 PowerShell 读取全部卸载项 */
async function collectWithPowerShell(roots: string[]): Promise<UninstallEntry[]> {
  const result = await powershell(buildEnumerationScript(roots), { timeout: 60_000 })
  if (!result.ok) return []
  const entries: UninstallEntry[] = []
  for (const raw of parseJsonResult(result.stdout)) {
    const entry = toEntry(raw)
    if (entry) entries.push(entry)
  }
  return entries
}

/** 用 reg.exe 读取单个卸载根（PowerShell 不可用时的兜底） */
async function collectRootWithReg(root: string): Promise<UninstallEntry[]> {
  const subKeys = parseRegSubKeys(await regQuery(root))
  const entries = await mapLimit(subKeys, 6, async (key) => {
    const output = await regQuery(key)
    if (!output) return undefined
    const values = new Map<string, string>()
    for (const value of parseRegValues(output)) values.set(value.name.toLowerCase(), value.value)
    const entry: UninstallEntry = {
      key: normalizeKeyPath(key),
      displayName: (values.get('displayname') ?? '').trim(),
      version: (values.get('displayversion') ?? '').trim(),
      publisher: (values.get('publisher') ?? '').trim(),
      installLocation: (values.get('installlocation') ?? '').trim(),
      uninstallString: (values.get('uninstallstring') ?? '').trim(),
      displayIcon: (values.get('displayicon') ?? '').trim(),
    }
    return entry
  })
  return entries.filter((entry): entry is UninstallEntry => !!entry)
}

/** 判断文本中是否存在「解码失败的替换字符」，用于识别 reg.exe 的中文乱码 */
function looksGarbled(entry: UninstallEntry): boolean {
  return /\uFFFD/.test(entry.displayName + entry.publisher + entry.installLocation)
}

/**
 * 读取注册表卸载项（PowerShell 优先，reg.exe 兜底）。
 *
 * 导出给自测脚本使用，便于在扫描之外单独验证「到底解析到了多少个卸载项」。
 */
export async function collectUninstallEntries(options: { roots?: string[] } = {}): Promise<UninstallCollection> {
  const roots = options.roots?.length ? options.roots : UNINSTALL_ROOTS
  const warnings: string[] = []

  try {
    const entries = await collectWithPowerShell(roots)
    if (entries.length) return { entries, source: 'powershell', warnings }
    warnings.push('PowerShell 未返回任何卸载项，已回退到 reg.exe')
  } catch (error) {
    warnings.push(`PowerShell 读取注册表失败：${errorMessage(error)}`)
  }

  const collected: UninstallEntry[] = []
  for (const root of roots) {
    try {
      collected.push(...(await collectRootWithReg(root)))
    } catch (error) {
      warnings.push(`reg.exe 读取 ${root} 失败：${errorMessage(error)}`)
    }
  }
  const garbled = collected.some(looksGarbled)
  if (garbled) warnings.push('reg.exe 输出的中文出现乱码（GBK 编码），建议启用 PowerShell 读取路径')
  return { entries: collected, source: 'reg', warnings }
}

/* ------------------------------------------------------------------ */
/* 残留判定                                                            */
/* ------------------------------------------------------------------ */

/** 展开 %VAR% 环境变量（只通过 TaskEnv.get 读取，插件不直接读 process.env） */
function expandEnvVars(input: string, env: TaskEnv): string {
  return input.replace(/%([^%]+)%/g, (_all, name) => env.get(String(name)) ?? '')
}

/** 清理路径类注册表值：展开变量、去引号、去空白 */
function cleanPathValue(raw: string, env: TaskEnv): string {
  let text = expandEnvVars(raw ?? '', env).trim()
  if (!text) return ''
  if (/^".*"$/.test(text) || /^'.*'$/.test(text)) text = text.slice(1, -1).trim()
  text = text.trim().replace(/\\+$/, '')
  if (!text || !isAbsolutePath(text)) return ''
  try {
    return normalizePath(text)
  } catch {
    return ''
  }
}

/**
 * 从 UninstallString / DisplayIcon 中提取可执行文件路径。
 *
 * 需要覆盖的真实形态：
 * - `"C:\Program Files\7-Zip\Uninstall.exe"`
 * - `C:\Program Files\Foo\unins000.exe /SILENT`
 * - `C:\path\app.exe,0`（DisplayIcon 常带图标索引）
 * - `MsiExec.exe /X{GUID}`（相对路径，无法校验，返回 undefined）
 */
function extractExePath(raw: string, env: TaskEnv): string | undefined {
  let text = expandEnvVars(raw ?? '', env).trim()
  if (!text) return undefined
  // 去掉图标索引后缀：",0" / ",-12"
  text = text.replace(/,\s*-?\d+\s*$/, '').trim()
  if (!text) return undefined

  let candidate: string
  if (text.startsWith('"') || text.startsWith("'")) {
    const quote = text[0]
    const end = text.indexOf(quote, 1)
    candidate = end > 1 ? text.slice(1, end) : text.slice(1)
  } else {
    // 无引号：截取到第一个 .exe 结尾（路径中可能含空格）
    const match = /^(.*?\.exe)(?:[\s,]|$)/i.exec(text)
    candidate = match ? match[1] : (text.split(/\s+/)[0] ?? '')
  }

  candidate = candidate.trim().replace(/^["']|["']$/g, '').trim()
  if (!/\.exe$/i.test(candidate)) return undefined
  if (!isAbsolutePath(candidate)) return undefined
  try {
    return normalizePath(candidate)
  } catch {
    return undefined
  }
}

/**
 * 判定一个卸载项是否属于残留。
 * - A 类：InstallLocation 非空但目录不存在；
 * - B 类：UninstallString / DisplayIcon 指向的 exe 不存在。
 * 同一卸载项只会返回一种结论（避免同一个键路径被上报两次）。
 */
export async function detectResidual(entry: UninstallEntry, env: TaskEnv): Promise<ResidualHint | undefined> {
  const installDir = cleanPathValue(entry.installLocation, env)
  if (installDir && !(await exists(installDir))) {
    return { kind: 'install-dir', detail: installDir }
  }
  for (const raw of [entry.uninstallString, entry.displayIcon]) {
    const exe = extractExePath(raw, env)
    if (!exe) continue
    if (!(await exists(exe))) return { kind: 'uninstaller', detail: exe }
  }
  return undefined
}

/* ------------------------------------------------------------------ */
/* 疑似残留目录                                                        */
/* ------------------------------------------------------------------ */

/** 默认的目录检查范围 */
export function defaultSuspectRoots(env: TaskEnv): Array<{ label: string; path: string }> {
  return [
    { label: 'Program Files', path: env.programFiles },
    { label: 'Program Files (x86)', path: env.programFilesX86 },
    { label: '%LOCALAPPDATA%', path: env.localAppData },
    { label: '%APPDATA%', path: env.appData },
  ].filter((root) => !!root.path)
}

/**
 * 找出「疑似残留目录」。
 *
 * 判定刻意保守（宁可漏报，不要误报）：
 * 1. 只看顶层目录，不递归；
 * 2. 跳过联接点 / 符号链接（不跟随链接）；
 * 3. 目录名去空白后至少 3 个字符，且不在系统目录黑名单中；
 * 4. 目录名（小写）不能出现在任何卸载项的 DisplayName / InstallLocation 中；
 * 5. 目录的最后修改时间必须早于 180 天；
 * 6. 最多返回 50 条。
 */
export async function findSuspectDirectories(options: SuspectDirectoryOptions): Promise<SuspectDirectory[]> {
  const minAgeDays = options.minAgeDays ?? SUSPECT_MAX_AGE_DAYS
  const maxItems = options.maxItems ?? SUSPECT_MAX_ITEMS
  const roots = options.roots?.length ? options.roots : defaultSuspectRoots(options.env)
  const haystack = options.entries
    .map((entry) => `${entry.displayName}\n${entry.installLocation}`)
    .join('\n')
    .toLowerCase()
  const now = Date.now()
  const found: SuspectDirectory[] = []
  const seen = new Set<string>()

  for (const root of roots) {
    if (!root.path) continue
    let dirents
    try {
      dirents = await fs.readdir(root.path, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dirent of dirents) {
      if (found.length >= maxItems) return found
      if (!dirent.isDirectory() || dirent.isSymbolicLink()) continue
      const name = dirent.name
      const lower = name.toLowerCase().trim()
      if (lower.length < SUSPECT_MIN_NAME_LENGTH) continue
      if (SUSPECT_DENY_NAMES.has(lower)) continue
      if (haystack.includes(lower)) continue
      const full = `${root.path}\\${name}`
      if (seen.has(full.toLowerCase())) continue
      const stat = await safeStat(full)
      if (!stat || !stat.isDirectory()) continue
      const ageDays = Math.floor((now - stat.mtimeMs) / 86_400_000)
      if (!Number.isFinite(ageDays) || ageDays < minAgeDays) continue
      seen.add(full.toLowerCase())
      found.push({ path: full, name, root: root.label, ageDays })
    }
  }
  return found
}

/* ------------------------------------------------------------------ */
/* 备份目录                                                            */
/* ------------------------------------------------------------------ */

/** 备份目录：优先使用配置项，否则 `<dataDir>\backups` */
function resolveBackupDir(env: TaskEnv, configured: string): string {
  const custom = (configured ?? '').trim()
  return custom ? path.resolve(custom) : path.join(env.dataDir, 'backups')
}

/* ------------------------------------------------------------------ */
/* 插件定义                                                            */
/* ------------------------------------------------------------------ */

export default defineCleanerPlugin<LeftoversConfig>({
  name: 'leftovers',
  version: '1.0.0',
  description: '比对注册表卸载项与实际安装目录，找出已卸载软件的残留（注册表项可备份清理，目录只做提示）',
  tasks: ['leftovers'],
  inject: ['cleaner', 'system'],
  Config,
  setup(ctx, config) {
    const env = ctx.system.env
    const includeRegistry = () => config?.includeRegistry !== false
    const includeDirectories = () => config?.includeDirectories !== false

    ctx.effect(() =>
      ctx.cleaner.define({
        id: 'leftovers',
        name: '应用残留',
        description: '找出已卸载软件留下的注册表卸载项与疑似残留目录',
        category: 'apps',
        risk: 'risky',
        icon: '🧩',
        defaultSelected: false,
        estimatedMs: 6000,
        targets: [
          ...UNINSTALL_ROOTS,
          env.programFiles,
          env.programFilesX86,
          env.localAppData,
          env.appData,
        ].filter(Boolean),
        tips: ['清理注册表前会自动导出 .reg 备份', '目录类残留只做提示，建议人工确认'],
        async scan(scan) {
          scan.throwIfAborted()

          // 目录比对需要「所有已安装软件的 DisplayName / InstallLocation」，
          // 因此只要有一项功能开启，就需要读取一次注册表卸载项。
          const collection: UninstallCollection = includeRegistry() || includeDirectories()
            ? await collectUninstallEntries()
            : { entries: [], source: 'powershell', warnings: [] }
          for (const warning of collection.warnings) scan.logger.warn(warning)
          if (includeRegistry() || includeDirectories()) {
            scan.logger.info(
              `已解析 ${collection.entries.length} 个注册表卸载项（来源：${collection.source === 'powershell' ? 'PowerShell' : 'reg.exe'}）`,
            )
          }

          // ① 注册表残留：A 类（安装目录缺失）与 B 类（卸载程序缺失）
          if (includeRegistry()) {
            for (const entry of collection.entries) {
              scan.throwIfAborted()
              const residual = await detectResidual(entry, scan.env)
              if (!residual) continue
              const meta = {
                displayName: entry.displayName || entry.key.slice(entry.key.lastIndexOf('\\') + 1),
                publisher: entry.publisher,
                version: entry.version,
                installLocation: entry.installLocation,
              }
              if (residual.kind === 'install-dir') {
                scan.emit({
                  path: entry.key,
                  title: meta.displayName,
                  kind: 'registry',
                  size: 0,
                  risk: 'caution',
                  defaultSelected: false,
                  note: `安装目录已不存在：${residual.detail}`,
                  meta,
                })
              } else {
                scan.emit({
                  path: entry.key,
                  title: meta.displayName,
                  kind: 'registry',
                  size: 0,
                  risk: 'risky',
                  defaultSelected: false,
                  note: `卸载程序丢失：${residual.detail}`,
                  meta,
                })
              }
            }
          }

          // ② 疑似残留目录：只报告、不可清理
          if (includeDirectories()) {
            scan.throwIfAborted()
            const suspects = await findSuspectDirectories({
              env: scan.env,
              entries: collection.entries,
              maxItems: SUSPECT_MAX_ITEMS + 1,
            })
            if (suspects.length > SUSPECT_MAX_ITEMS) {
              scan.addError({
                path: scan.env.programFiles,
                message: `疑似残留目录超过 ${SUSPECT_MAX_ITEMS} 个，仅上报前 ${SUSPECT_MAX_ITEMS} 个`,
              })
            }
            for (const suspect of suspects.slice(0, SUSPECT_MAX_ITEMS)) {
              scan.throwIfAborted()
              scan.emit({
                path: suspect.path,
                title: suspect.name,
                kind: 'directory',
                size: 0,
                risk: 'risky',
                defaultSelected: false,
                note: '疑似残留目录（仅供参考，请人工确认）',
                meta: { ageDays: suspect.ageDays, root: suspect.root },
              })
            }
          }
        },
        async clean(items: CleanItem[], cleanCtx: TaskCleanContext): Promise<CleanItemResult[]> {
          const results: CleanItemResult[] = []
          const backupDir = resolveBackupDir(cleanCtx.env, config?.backupDir)
          const stamp = Date.now()
          let index = 0

          for (const item of items) {
            if (cleanCtx.signal.aborted) break
            // 目录类残留一律只报告，即使因为自定义扫描根而通过了路径策略也不处理
            if (item.kind !== 'registry') {
              results.push({ itemId: item.id, path: item.path, ok: false, bytes: 0, error: '仅报告项' })
              continue
            }
            if (cleanCtx.dryRun) {
              results.push({ itemId: item.id, path: item.path, ok: true, bytes: 0 })
              continue
            }

            index++
            const file = path.join(backupDir, `leftovers-${stamp}-${index}.reg`)
            try {
              await fs.mkdir(path.dirname(file), { recursive: true })
              if (!(await regExport(item.path, file))) {
                results.push({
                  itemId: item.id,
                  path: item.path,
                  ok: false,
                  bytes: 0,
                  error: '导出注册表备份失败，已跳过该键（可能需要管理员权限）',
                })
                continue
              }
              cleanCtx.logger.info(`已备份注册表项到 ${file}`)
              const deleted = await regDeleteKey(item.path)
              if (deleted) {
                cleanCtx.logger.info(`已删除注册表项 ${item.path}`)
                results.push({ itemId: item.id, path: item.path, ok: true, bytes: 0 })
              } else {
                results.push({
                  itemId: item.id,
                  path: item.path,
                  ok: false,
                  bytes: 0,
                  error: '删除注册表项失败（可能需要管理员权限），备份已保留',
                })
              }
            } catch (error) {
              results.push({ itemId: item.id, path: item.path, ok: false, bytes: 0, error: errorMessage(error) })
            }
          }
          return results
        },
      }),
    )
  },
})
