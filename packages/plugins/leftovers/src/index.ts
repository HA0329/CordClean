/**
 * 应用残留分析插件（leftovers）。
 *
 * 目标：找出「已卸载软件」在本机留下的痕迹，并按「能不能清理」分成两类：
 *
 * 1. 注册表残留（可清理，清理前自动导出 .reg 备份）：
 *    - A 类：`InstallLocation` 非空但目录已不存在（安装目录已丢失）；
 *    - B 类：`UninstallString` / `DisplayIcon` 指向的 exe 已不存在（卸载程序已丢失）。
 * 2. 目录残留（**只报告**，永不参与清理）：在 `Program Files` / `Program Files (x86)` /
 *    `%LOCALAPPDATA%` / `%APPDATA%` 的基础上，追加 `%LOCALAPPDATA%\Programs`（用户级安装）
 *    与 `%PROGRAMDATA%`（发布者级数据，顶层通常是发布者目录）作为扫描根。目录需同时满足：
 *    - 名称/路径未命中排除名单（Windows/System32、回收站、Temp、包管理器缓存与开发目录、
 *      CordClean 自身数据目录等）；
 *    - 目录名与任何已安装软件（显示名 / 发布者 / 安装目录）都对不上；
 *    - 最后修改时间超过 180 天。
 *    真实判定逻辑全部在 `residual-rules.ts` 的纯函数里，由 tests/leftovers-residual.test.ts
 *    直接覆盖；每条目录残留的 note 会写明匹配依据（与已安装软件均无匹配）、年龄与所在根。
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
  pathKey,
  powershell,
  regDeleteKey,
  regExport,
  regQuery,
  safeLstat,
} from '@cordclean/utils'
import {
  SUSPECT_MAX_AGE_DAYS,
  buildExclusionContext,
  buildInstalledSoftwareIndex,
  defaultSuspectRoots,
  judgeSuspectDirectory,
  toSuspectDraft,
  type SuspectRoot,
  type SuspectRootKind,
  type SuspectSkipReason,
} from './residual-rules.ts'

// 纯判定规则一并从插件入口导出，便于测试与后续复用（package.json 只映射到 index.ts）
export {
  SUSPECT_MAX_AGE_DAYS,
  SUSPECT_MIN_NAME_LENGTH,
  ageDaysFromMtime,
  buildExclusionContext,
  buildInstalledSoftwareIndex,
  classifyExcludedName,
  classifyExcludedPath,
  defaultSuspectRoots,
  findInstalledSoftwareMatch,
  formatAgeDays,
  formatSuspectNote,
  isSuspectAge,
  judgeSuspectDirectory,
  normalizePublisher,
  normalizeSoftwareName,
  textContainsToken,
  toSuspectDraft,
} from './residual-rules.ts'
export type {
  DirectoryCandidate,
  ExclusionContext,
  ExclusionEnv,
  ExclusionReason,
  InstalledSoftwareIndex,
  JudgeContext,
  SoftwareEntryLike,
  SoftwareMatch,
  SoftwareMatchBasis,
  SuspectDecision,
  SuspectDirectoryDetail,
  SuspectItemDraft,
  SuspectRoot,
  SuspectRootKind,
  SuspectSkipReason,
} from './residual-rules.ts'

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

/** 疑似残留目录最多上报条数 */
const SUSPECT_MAX_ITEMS = 50

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
    .description(
      '在 Program Files / AppData / %PROGRAMDATA% 下提示疑似残留目录（只做提示，永远不会被删除；系统目录、Temp、回收站、包管理器缓存与 CordClean 自身数据目录会被排除）',
    ),
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
  /** 所属根目录标签（用于界面分组），如 `%PROGRAMDATA%` */
  root: string
  /** 扫描根类别（用于说明该目录的判定语境） */
  rootKind: SuspectRootKind
  /** 距今天数（目录最后修改时间） */
  ageDays: number
  /** 目录最后修改时间（毫秒） */
  mtimeMs: number
}

/** 单个扫描根的统计（用于日志与自测证明扫描确实覆盖了新根） */
export interface SuspectRootStat {
  label: string
  path: string
  /** 根目录是否存在且可读（不存在的根会被静默跳过） */
  readable: boolean
  /** 顶层目录数量（已排除符号链接） */
  candidates: number
  /** 该根命中数 */
  suspects: number
}

/** findSuspectDirectories 的统计结果（供日志/审计使用） */
export interface SuspectDirectoryStats {
  /** 去重后的已安装软件索引规模 */
  index: { displayNames: number; publishers: number; installDirs: number }
  roots: SuspectRootStat[]
  /** 各类跳过原因计数（黑名单/匹配/年龄不足等） */
  skipped: Partial<Record<SuspectSkipReason, number>>
  /** 命中已安装软件（因此不上报）的目录数 */
  matched: number
  /** 判定为疑似残留的总数（截断前） */
  suspectTotal: number
  /** 是否因 maxItems 截断 */
  truncated: boolean
}

export interface SuspectDirectoryOptions {
  env: TaskEnv
  entries: UninstallEntry[]
  /** 最小目录年龄（天），默认 180 */
  minAgeDays?: number
  /** 最多返回条数，默认无限（由调用方截断） */
  maxItems?: number
  /**
   * 自定义扫描根，默认 Program Files / Program Files (x86) / %LOCALAPPDATA% / %APPDATA% /
   * %LOCALAPPDATA%\Programs / %PROGRAMDATA%
   */
  roots?: Array<{ label: string; path: string; kind?: SuspectRootKind }>
  /** 扫描统计回调（日志与自测用） */
  onStats?: (stats: SuspectDirectoryStats) => void
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

/** 跳过原因 → 日志可读标签 */
const SKIP_REASON_LABELS: Record<SuspectSkipReason, string> = {
  link: '链接/不可读',
  'too-short': '名称过短',
  'excluded-name': '系统/缓存/开发目录',
  'excluded-path': '受保护位置',
  'installed-match': '已安装软件匹配',
  'invalid-age': '时间异常',
  'too-new': '未满年龄阈值',
}

/** 把跳过原因计数格式化为一行日志 */
function describeSuspectSkips(skipped: Partial<Record<SuspectSkipReason, number>>): string {
  return Object.entries(skipped)
    .filter(([, count]) => (count ?? 0) > 0)
    .map(([reason, count]) => `${SKIP_REASON_LABELS[reason as SuspectSkipReason] ?? reason}=${count}`)
    .join('，')
}

/** 根据 TaskEnv 构造路径排除上下文（含 TEMP/TMP 环境变量） */
function exclusionsForEnv(env: TaskEnv) {
  return buildExclusionContext({
    dataDir: env.dataDir,
    windowsDir: env.windowsDir,
    localAppData: env.localAppData,
    appData: env.appData,
    userProfile: env.userProfile,
    systemDrive: env.systemDrive,
    drives: env.drives,
    tempDirs: [env.get('TEMP'), env.get('TMP')],
  })
}

/**
 * 找出「疑似残留目录」。
 *
 * 判定刻意保守（宁可漏报，不要误报），核心判定在 residual-rules.ts 的纯函数里：
 * 1. 只看扫描根下的顶层目录，不递归；
 * 2. 跳过联接点 / 符号链接（readdir 的 dirent 与 lstat 双重确认，不跟随链接）；
 * 3. 名称/路径命中排除名单（系统目录、Temp、回收站、包管理器缓存、CordClean 自身数据目录）；
 * 4. 目录名与任何已安装软件（显示名 / 发布者 / 安装目录）匹配；
 * 5. 目录的最后修改时间必须早于 180 天；
 * 6. 结果按年龄从旧到新排序后截断到 maxItems。
 *
 * onStats 会给出每个扫描根的候选/命中数与各类跳过计数，便于日志和「扫描确实覆盖新根」的验证。
 */
export async function findSuspectDirectories(options: SuspectDirectoryOptions): Promise<SuspectDirectory[]> {
  const minAgeDays = options.minAgeDays ?? SUSPECT_MAX_AGE_DAYS
  const maxItems = options.maxItems ?? SUSPECT_MAX_ITEMS
  const roots: SuspectRoot[] = (options.roots?.length ? options.roots : defaultSuspectRoots(options.env)).map((root) => ({
    label: root.label,
    path: root.path,
    kind: root.kind ?? 'program-files',
  }))
  // 已安装软件索引只构建一次（名称/发布者/安装目录均已归一化去重）
  const index = buildInstalledSoftwareIndex(options.entries)
  const exclusions = exclusionsForEnv(options.env)
  const now = Date.now()
  const found: SuspectDirectory[] = []
  const seen = new Set<string>()
  const stats: SuspectDirectoryStats = {
    index: {
      displayNames: index.displayNames.length,
      publishers: index.publishers.length,
      installDirs: index.installDirs.length,
    },
    roots: [],
    skipped: {},
    matched: 0,
    suspectTotal: 0,
    truncated: false,
  }
  const countSkip = (reason: SuspectSkipReason): void => {
    stats.skipped[reason] = (stats.skipped[reason] ?? 0) + 1
  }

  for (const root of roots) {
    if (!root.path) continue
    const rootStat: SuspectRootStat = { label: root.label, path: root.path, readable: false, candidates: 0, suspects: 0 }
    let dirents
    try {
      dirents = await fs.readdir(root.path, { withFileTypes: true })
      rootStat.readable = true
    } catch {
      // 不存在的扫描根（例如没有 %PROGRAMDATA% 的精简系统）静默跳过
      stats.roots.push(rootStat)
      continue
    }
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue
      rootStat.candidates++
      const full = path.join(root.path, dirent.name)
      const key = pathKey(full)
      if (seen.has(key)) continue
      seen.add(key)
      if (dirent.isSymbolicLink()) {
        countSkip('link')
        continue
      }
      const stat = await safeLstat(full)
      // 复核：readdir 的类型在部分网络盘/重解析点上不可靠；lstat 失败或发现链接一律不进入
      if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
        countSkip('link')
        continue
      }
      const decision = judgeSuspectDirectory(
        { path: full, name: dirent.name, rootKind: root.kind, mtimeMs: stat.mtimeMs },
        { index, exclusions, now, minAgeDays },
      )
      if (!decision.suspect) {
        countSkip(decision.skipReason ?? 'too-new')
        if (decision.skipReason === 'installed-match') stats.matched++
        continue
      }
      rootStat.suspects++
      found.push({
        path: full,
        name: dirent.name,
        root: root.label,
        rootKind: root.kind,
        ageDays: decision.ageDays ?? 0,
        mtimeMs: stat.mtimeMs,
      })
    }
    stats.roots.push(rootStat)
  }

  // 越旧的目录越像残留：按年龄降序后截断，保证 50 条上限优先保留最旧项
  found.sort((left, right) => right.ageDays - left.ageDays || left.path.localeCompare(right.path))
  stats.suspectTotal = found.length
  stats.truncated = found.length > maxItems
  options.onStats?.(stats)
  return found.slice(0, maxItems)
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
        description: '找出已卸载软件留下的注册表卸载项与疑似残留目录（目录仅提示，永不删除）',
        category: 'apps',
        risk: 'risky',
        icon: '🧩',
        defaultSelected: false,
        estimatedMs: 6000,
        targets: [...UNINSTALL_ROOTS, ...defaultSuspectRoots(env).map((root) => root.path)].filter(Boolean),
        tips: [
          '清理注册表前会自动导出 .reg 备份',
          '目录类残留只做提示，永远不会被删除，建议人工确认',
          '目录扫描覆盖 Program Files（含 x86）、%LOCALAPPDATA%、%APPDATA%、%LOCALAPPDATA%\\Programs 与 %PROGRAMDATA%',
          '系统目录、Temp、回收站、包管理器缓存（node_modules/.pnpm 等）与 CordClean 自身数据目录会被自动排除，避免误报',
        ],
        async scan(scan) {
          scan.throwIfAborted()

          // 目录比对需要「所有已安装软件的显示名 / 发布者 / 安装路径」，
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
            let stats: SuspectDirectoryStats | undefined
            const suspects = await findSuspectDirectories({
              env: scan.env,
              entries: collection.entries,
              // 多取一条用于判断是否超上限（真实上报仍按 SUSPECT_MAX_ITEMS 截断）
              maxItems: SUSPECT_MAX_ITEMS + 1,
              onStats: (value) => {
                stats = value
              },
            })
            // 把「扫了哪些根、比对了多少软件、跳过了什么」如实写进日志，便于用户/审计判断结果可信度
            if (stats) {
              scan.logger.info(
                `目录比对索引（已去重）：软件名 ${stats.index.displayNames} 个，发布者 ${stats.index.publishers} 个，安装目录 ${stats.index.installDirs} 个`,
              )
              for (const root of stats.roots) {
                scan.logger.info(
                  `  扫描根 ${root.label}：候选目录 ${root.candidates} 个，命中 ${root.suspects} 个${
                    root.readable ? '' : '（不存在或不可读，已跳过）'
                  }`,
                )
              }
              // 「已安装软件匹配」单独展示，其余跳过原因聚合为一行
              const otherSkips: Partial<Record<SuspectSkipReason, number>> = { ...stats.skipped }
              delete otherSkips['installed-match']
              const skippedText = describeSuspectSkips(otherSkips)
              scan.logger.info(
                `疑似残留目录：命中 ${stats.suspectTotal} 个（仅提示，不参与清理）；已安装软件匹配 ${stats.matched} 个${
                  skippedText ? `；其余跳过：${skippedText}` : ''
                }`,
              )
            }
            if (suspects.length > SUSPECT_MAX_ITEMS) {
              scan.addError({
                path: defaultSuspectRoots(scan.env)[0]?.path ?? scan.env.programFiles,
                message: `疑似残留目录超过 ${SUSPECT_MAX_ITEMS} 个，仅上报最旧的 ${SUSPECT_MAX_ITEMS} 个`,
              })
            }
            const installedCount = collection.entries.length
            for (const suspect of suspects.slice(0, SUSPECT_MAX_ITEMS)) {
              scan.throwIfAborted()
              // note 写明匹配依据/年龄/所在根；defaultSelected=false 由 toSuspectDraft 固定
              scan.emit(
                toSuspectDraft(
                  {
                    path: suspect.path,
                    name: suspect.name,
                    rootLabel: suspect.root,
                    rootKind: suspect.rootKind,
                    ageDays: suspect.ageDays,
                    mtimeMs: suspect.mtimeMs,
                  },
                  installedCount,
                ),
              )
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
              results.push({
                itemId: item.id,
                path: item.path,
                ok: false,
                bytes: 0,
                error: '目录类残留仅提示，不参与清理（请人工确认后手动处理）',
              })
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
