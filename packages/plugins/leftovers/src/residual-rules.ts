/**
 * leftovers 纯判定规则（不访问文件系统）。
 *
 * 为什么单独成文件：目录残留的判定由「名称/路径排除 → 已安装软件匹配 → 180 天年龄阈值」
 * 多道保守规则组成，任何一道放宽都会把正常目录当成残留。抽成纯函数后可以直接单测
 * （tests/leftovers-residual.test.ts），扫描函数只负责遍历目录、取 mtime 与上报。
 *
 * 判定顺序（与 judgeSuspectDirectory 一致）：
 * 1. 链接 / 联接点、名称过短 → 跳过；
 * 2. 目录名命中系统 / 缓存 / 包管理器 / 开发目录黑名单 → 跳过；
 * 3. 目录完整路径命中 CordClean 数据目录 / Windows / Temp / 回收站 → 跳过；
 * 4. 目录名与已安装软件的显示名、发布者、安装目录匹配 → 跳过（不是残留）；
 * 5. 目录最后修改时间不足 180 天 → 跳过；
 * 6. 其余才是「疑似残留」，且只提示、永不删除。
 */
import { win32 } from 'node:path'
import { isSubPath, normalizePath } from '@cordclean/utils'

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/** 疑似残留目录的最小年龄（天）：最后修改时间必须早于该阈值 */
export const SUSPECT_MAX_AGE_DAYS = 180
/** 目录名短于该长度时匹配几乎没有区分度，直接跳过 */
export const SUSPECT_MIN_NAME_LENGTH = 3

/** 扫描根类别：决定 note 措辞，也说明该根下的顶层目录通常是什么 */
export type SuspectRootKind = 'program-files' | 'local-appdata' | 'local-programs' | 'roaming-appdata' | 'program-data'

/** 一个扫描根 */
export interface SuspectRoot {
  label: string
  path: string
  kind: SuspectRootKind
}

/** 构造默认扫描根所需的环节字段（TaskEnv 的超集，便于单测造假数据） */
export interface SuspectEnvLike {
  programFiles?: string
  programFilesX86?: string
  localAppData?: string
  appData?: string
  programData?: string
}

/**
 * 默认的目录检查范围。
 *
 * 在原有 Program Files / Program Files (x86) / %LOCALAPPDATA% / %APPDATA% 基础上，
 * 追加 `%LOCALAPPDATA%\Programs`（用户级安装的程序）与 `%PROGRAMDATA%`（发布者级数据）。
 * 不存在的根由扫描函数在 readdir 失败时静默跳过，因此这里只做路径拼接。
 */
export function defaultSuspectRoots(env: SuspectEnvLike): SuspectRoot[] {
  const roots: SuspectRoot[] = [
    { label: 'Program Files', path: env.programFiles ?? '', kind: 'program-files' },
    { label: 'Program Files (x86)', path: env.programFilesX86 ?? '', kind: 'program-files' },
    { label: '%LOCALAPPDATA%', path: env.localAppData ?? '', kind: 'local-appdata' },
    { label: '%APPDATA%', path: env.appData ?? '', kind: 'roaming-appdata' },
    {
      label: '%LOCALAPPDATA%\\Programs',
      path: env.localAppData ? win32.join(env.localAppData, 'Programs') : '',
      kind: 'local-programs',
    },
    { label: '%PROGRAMDATA%', path: env.programData ?? '', kind: 'program-data' },
  ]
  // 去空、去重（大小写不敏感）：避免同一目录被两个根重复扫描
  const seen = new Set<string>()
  return roots.filter((root) => {
    if (!root.path) return false
    const key = normalizePath(root.path).toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/* ------------------------------------------------------------------ */
/* 名称归一化                                                          */
/* ------------------------------------------------------------------ */

/**
 * 归一化软件名 / 发布者名 / 目录名：NFKC（全角转半角）→ 小写 → 去商标符号 →
 * 折叠空白 → 去首尾标点。只用于匹配，不用于展示。
 */
export function normalizeSoftwareName(value: string): string {
  return (value ?? '')
    // 商标符号必须在 NFKC 之前去掉：NFKC 会把 ™ 折叠成 "TM"
    .replace(/[\u2122\u00ae\u00a9]/g, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, ' ')
    .trim()
    .replace(/[.。,，:：;；]+$/u, '')
    .trim()
}

/** 公司名常见法律后缀：发布者匹配时去掉，`NVIDIA Corporation` → `nvidia` */
const COMPANY_SUFFIX_TOKENS = new Set([
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'ltd',
  'limited',
  'llc',
  'co',
  'company',
  'gmbh',
  'ag',
  'plc',
  'pty',
  'pte',
  'bv',
  'nv',
  'sa',
  'sas',
  'srl',
  'oy',
  'ab',
  'kk',
  'kg',
  'spa',
])

/** 去掉发布者名末尾的法律后缀（含 `Inc.` / `Co., Ltd.` / `S.A.S.` 等写法） */
export function normalizePublisher(value: string): string {
  const tokens = normalizeSoftwareName(value).split(' ').filter(Boolean)
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1]!.replace(/[.,]/g, '')
    if (!COMPANY_SUFFIX_TOKENS.has(last)) break
    tokens.pop()
  }
  return tokens.join(' ')
}

/* ------------------------------------------------------------------ */
/* 已安装软件索引（名称除重）                                          */
/* ------------------------------------------------------------------ */

/** 索引构建只需要这三个字段（UninstallEntry 结构兼容） */
export interface SoftwareEntryLike {
  displayName?: string
  publisher?: string
  installLocation?: string
}

/** 已安装软件索引：三组均已归一化 + 除重 + 排序，匹配结果可复现 */
export interface InstalledSoftwareIndex {
  /** 去重后的软件显示名 */
  displayNames: string[]
  /** 去重后的发布者核心名（已去法律后缀） */
  publishers: string[]
  /** 去重后的安装目录末段名 */
  installDirs: string[]
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(Boolean))].sort()
}

/** 取安装目录末段；盘符根 / 空串不参与匹配 */
function installDirName(location: string): string {
  const normalized = normalizePath(location ?? '')
  if (!normalized) return ''
  const index = normalized.lastIndexOf('\\')
  if (index < 0) return ''
  const name = normalized.slice(index + 1).trim()
  return /^[a-z]:$/i.test(name) ? '' : name
}

/**
 * 由注册表卸载项构建「已安装软件索引」。
 *
 * 同一发布者往往对应十几条卸载项（如 NVIDIA 的 19 条），必须去重：
 * 否则匹配成本随条目数线性增长，且统计出的「已比对软件数」会失真。
 */
export function buildInstalledSoftwareIndex(entries: readonly SoftwareEntryLike[]): InstalledSoftwareIndex {
  const displayNames: string[] = []
  const publishers: string[] = []
  const installDirs: string[] = []
  for (const entry of entries) {
    const displayName = normalizeSoftwareName(entry.displayName ?? '')
    if (displayName.length >= 2) displayNames.push(displayName)
    const publisher = normalizePublisher(entry.publisher ?? '')
    if (publisher.length >= 2) publishers.push(publisher)
    const installDir = normalizeSoftwareName(installDirName(entry.installLocation ?? ''))
    if (installDir.length >= 2) installDirs.push(installDir)
  }
  return {
    displayNames: uniqueSorted(displayNames),
    publishers: uniqueSorted(publishers),
    installDirs: uniqueSorted(installDirs),
  }
}

/* ------------------------------------------------------------------ */
/* 已安装软件匹配                                                      */
/* ------------------------------------------------------------------ */

export type SoftwareMatchBasis = 'display-name' | 'publisher' | 'install-dir'

export interface SoftwareMatch {
  basis: SoftwareMatchBasis
  /** 命中的归一化名称（用于日志/调试） */
  value: string
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 判断 `haystack` 中是否以「完整单词」形态出现 `token`。
 *
 * 用单词边界而不是裸 `includes`：目录名 `java` 会命中显示名 `java(tm) se ...`，
 * 但 `go` 不会到处命中 `google`、`cat` 不会命中 `certificate`。
 */
export function textContainsToken(haystack: string, token: string): boolean {
  if (!haystack || !token) return false
  const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(token)}(?:$|[^\\p{L}\\p{N}])`, 'u')
  return pattern.test(haystack)
}

/** 目录名与已安装名称是否匹配（双向包含 + 完整单词边界，长度不足 3 时只认完全相等） */
function nameMatches(dirName: string, installedName: string): boolean {
  if (!dirName || !installedName) return false
  if (dirName === installedName) return true
  const shorter = dirName.length <= installedName.length ? dirName : installedName
  if (shorter.length < SUSPECT_MIN_NAME_LENGTH) return false
  return textContainsToken(dirName, installedName) || textContainsToken(installedName, dirName)
}

/**
 * 在已安装软件索引中查找目录名对应的软件。
 *
 * 依次比对：软件显示名 → 安装目录末段名 → 发布者（核心名）。
 * ProgramData 的顶层目录通常是**发布者目录**（`Adobe` / `NVIDIA Corporation`），
 * 因此发布者比对是这里避免误报的关键：只要目录名等于（或完整包含）某个已安装
 * 软件的发布者名，就说明该目录属于仍在安装的软件，不能当残留上报。
 */
export function findInstalledSoftwareMatch(dirName: string, index: InstalledSoftwareIndex): SoftwareMatch | undefined {
  const dirNorm = normalizeSoftwareName(dirName)
  if (!dirNorm) return undefined
  const dirCore = normalizePublisher(dirName)

  for (const value of index.displayNames) {
    if (nameMatches(dirNorm, value)) return { basis: 'display-name', value }
  }
  for (const value of index.installDirs) {
    if (nameMatches(dirNorm, value)) return { basis: 'install-dir', value }
  }
  for (const value of index.publishers) {
    if (dirNorm === value || (dirCore && dirCore === value)) return { basis: 'publisher', value }
    if (nameMatches(dirCore || dirNorm, value)) return { basis: 'publisher', value }
  }
  return undefined
}

/* ------------------------------------------------------------------ */
/* 年龄阈值                                                            */
/* ------------------------------------------------------------------ */

/**
 * 由目录最后修改时间得到「距今天数」。
 * 未来时间 / 非法值返回 undefined（视为异常，不当作残留）。
 */
export function ageDaysFromMtime(mtimeMs: number, now: number = Date.now()): number | undefined {
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(now)) return undefined
  const diff = now - mtimeMs
  if (diff < 0) return undefined
  return Math.floor(diff / 86_400_000)
}

/** 年龄是否达到「疑似残留」阈值（恰好 180 天视为达到，与旧实现一致） */
export function isSuspectAge(ageDays: number | undefined, minAgeDays: number = SUSPECT_MAX_AGE_DAYS): boolean {
  return typeof ageDays === 'number' && Number.isFinite(ageDays) && ageDays >= minAgeDays
}

/** 人类可读年龄，用于 note：`7 个月（221 天）` / `2.6 年（966 天）` / `20 天` */
export function formatAgeDays(ageDays: number): string {
  if (!Number.isFinite(ageDays) || ageDays < 0) return '未知'
  if (ageDays < 30) return `${ageDays} 天`
  if (ageDays < 365) return `${Math.floor(ageDays / 30)} 个月（${ageDays} 天）`
  const years = Math.round((ageDays / 365) * 10) / 10
  return `${years.toFixed(1)} 年（${ageDays} 天）`
}

/* ------------------------------------------------------------------ */
/* 排除规则                                                            */
/* ------------------------------------------------------------------ */

/** 排除原因（也是扫描统计的分组键） */
export type ExclusionReason =
  | 'cordclean-data'
  | 'windows'
  | 'system-directory'
  | 'temporary'
  | 'recycle-bin'
  | 'package-manager-cache'
  | 'development'
  | 'cache'

/** Windows 系统目录名（前缀匹配即可覆盖 WindowsApps / Windows Defender / WindowsPowerShell …） */
const WINDOWS_NAME_PATTERN = /^(windows|winsxs|system32|syswow64|wow64|regid\.)/
/** 微软系统目录（Microsoft / Microsoft Office / Microsoft.NET …） */
const MICROSOFT_NAME_PATTERN = /^microsoft($|[\s.])/
/** 临时目录名 */
const TEMPORARY_DIRECTORY_NAMES = new Set(['temp', 'tmp', 'temporary internet files', 'crashdumps', 'dumps'])
/** 回收站目录名 */
const RECYCLE_BIN_DIRECTORY_NAMES = new Set(['$recycle.bin', 'recycler', 'recycle.bin'])
/** 包管理器缓存目录名（明显是开发/缓存目录，不属于应用残留） */
const PACKAGE_MANAGER_DIRECTORY_NAMES = new Set([
  'node_modules',
  '.pnpm',
  '.pnpm-store',
  'pnpm',
  'pnpm-store',
  'npm',
  'npm-cache',
  '_cacache',
  '.npm',
  'yarn',
  'yarn-cache',
  '.yarn',
  'pip',
  'pip-cache',
  '.gradle',
  '.m2',
  '.nuget',
  '.cargo',
  '.rustup',
  '.composer',
  '.deno',
  '.bun',
  'package cache',
  'package_cache',
  'chocolatey',
  'chocolateyhttpcache',
  'scoop',
  'winget',
])
/** 源码仓库 / 构建产物目录名 */
const DEVELOPMENT_DIRECTORY_NAMES = new Set(['.git', '.svn', '.hg', 'dist', 'build', 'coverage', 'out', '.vs', '.vscode', '.idea'])
/** 通用缓存目录名 */
const CACHE_DIRECTORY_NAMES = new Set(['.cache', 'cache', 'caches', 'code cache', 'gpucache', 'shadercache', 'webcache', 'inetcache', 'inetcookies', 'iconcache'])
/** 系统 / 运行时自带的目录名（小写精确匹配） */
const SYSTEM_DIRECTORY_NAMES = new Set([
  'common',
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
  'windows security',
  'windowspowershell',
  'microsoft',
  'microsoft.net',
  'microsoft office',
  'microsoft shared',
  'microsoft help',
  'microsoft windows',
  'microsoft corporation',
  'dotnet',
  'packages',
  'programs',
  'virtualstore',
  'd3dscache',
  'connecteddevicesplatform',
  'usoprivate',
  'usoshared',
  'regid.1991-06.com.microsoft',
  'printers',
  'portable devices',
  'application data',
  'desktop',
  'documents',
  'templates',
  'start menu',
  'favorites',
  'pictures',
  'music',
  'videos',
  'my music',
  'my pictures',
  'my videos',
  'recent',
])

/**
 * 目录名黑名单判定。
 *
 * 这些目录要么是 Windows 自带的系统/兼容目录，要么是包管理器缓存与构建产物，
 * 即使很旧、也没有对应卸载项，也不能报成「应用残留」。
 */
export function classifyExcludedName(name: string): ExclusionReason | undefined {
  const normalized = normalizeSoftwareName(name)
  if (!normalized) return 'system-directory'
  if (WINDOWS_NAME_PATTERN.test(normalized)) return 'windows'
  if (TEMPORARY_DIRECTORY_NAMES.has(normalized)) return 'temporary'
  if (RECYCLE_BIN_DIRECTORY_NAMES.has(normalized)) return 'recycle-bin'
  if (SYSTEM_DIRECTORY_NAMES.has(normalized)) return 'system-directory'
  if (MICROSOFT_NAME_PATTERN.test(normalized)) return 'system-directory'
  if (PACKAGE_MANAGER_DIRECTORY_NAMES.has(normalized)) return 'package-manager-cache'
  if (DEVELOPMENT_DIRECTORY_NAMES.has(normalized)) return 'development'
  if (CACHE_DIRECTORY_NAMES.has(normalized)) return 'cache'
  return undefined
}

/** 路径排除上下文：全部是小写可比对的绝对路径，由 buildExclusionContext 生成 */
export interface ExclusionContext {
  /** CordClean 自身数据目录（含默认位置），候选目录在其中一律不报告 */
  dataDirs: string[]
  /** Windows 目录（含 System32），候选目录在其中一律不报告 */
  windowsDirs: string[]
  /** 临时目录 */
  tempDirs: string[]
  /** 回收站目录 */
  recycleBinDirs: string[]
}

/** buildExclusionContext 的输入（从 TaskEnv 中挑出需要的字段，便于单测） */
export interface ExclusionEnv {
  dataDir?: string
  windowsDir?: string
  localAppData?: string
  appData?: string
  userProfile?: string
  systemDrive?: string
  drives?: string[]
  /** 额外临时目录（通常来自 TEMP / TMP 环境变量） */
  tempDirs?: Array<string | undefined>
}

function cleanDirs(values: Array<string | undefined>): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const normalized = normalizePath(value ?? '')
    if (!normalized) continue
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(normalized)
  }
  return result
}

/**
 * 构造「不能算残留」的绝对路径集合。
 *
 * 显式覆盖需求里点名的四类位置：
 * - CordClean 自身数据目录（含默认 `%LOCALAPPDATA%\CordClean`）；
 * - Windows / System32（候选在 Windows 目录内一律跳过）；
 * - 回收站（各盘 `$Recycle.Bin`）；
 * - Temp（`%LOCALAPPDATA%\Temp`、`%TEMP%` 等）。
 */
export function buildExclusionContext(env: ExclusionEnv): ExclusionContext {
  const localAppData = env.localAppData ?? ''
  const windowsDir = env.windowsDir ?? ''
  const userProfile = env.userProfile ?? ''
  const drives = new Set<string>()
  for (const drive of env.drives ?? []) {
    if (drive) drives.add(drive.replace(/[\\/]+$/, '').toUpperCase())
  }
  if (env.systemDrive) drives.add(env.systemDrive.replace(/[\\/]+$/, '').toUpperCase())
  const windowsDirs = cleanDirs([windowsDir, windowsDir ? win32.join(windowsDir, 'System32') : ''])
  const dataDirs = cleanDirs([
    env.dataDir,
    localAppData ? win32.join(localAppData, 'CordClean') : '',
    env.appData ? win32.join(env.appData, 'CordClean') : '',
  ])
  const tempDirs = cleanDirs([
    localAppData ? win32.join(localAppData, 'Temp') : '',
    windowsDir ? win32.join(windowsDir, 'Temp') : '',
    userProfile ? win32.join(userProfile, 'AppData', 'Local', 'Temp') : '',
    ...(env.tempDirs ?? []),
  ])
  const recycleBinDirs = cleanDirs([...drives].map((drive) => win32.join(drive, '$Recycle.Bin')))
  return { dataDirs, windowsDirs, tempDirs, recycleBinDirs }
}

/** 目标目录是否位于排除路径之下（含相等） */
export function classifyExcludedPath(candidatePath: string, context: ExclusionContext): ExclusionReason | undefined {
  const target = normalizePath(candidatePath)
  if (!target) return undefined
  const groups: Array<[ExclusionReason, string[]]> = [
    ['cordclean-data', context.dataDirs],
    ['temporary', context.tempDirs],
    ['recycle-bin', context.recycleBinDirs],
    ['windows', context.windowsDirs],
  ]
  for (const [reason, roots] of groups) {
    for (const root of roots) {
      if (root && isSubPath(root, target)) return reason
    }
  }
  return undefined
}

/* ------------------------------------------------------------------ */
/* 单目录判定（纯函数核心）                                            */
/* ------------------------------------------------------------------ */

/** 候选目录（调用方已读到 mtime / 链接信息） */
export interface DirectoryCandidate {
  /** 完整路径，用于路径级排除（纯判定可省略） */
  path?: string
  name: string
  rootKind: SuspectRootKind
  /** 最后修改时间（毫秒） */
  mtimeMs: number
  isLink?: boolean
}

/** judgeSuspectDirectory 的上下文 */
export interface JudgeContext {
  index: InstalledSoftwareIndex
  exclusions: ExclusionContext
  now?: number
  minAgeDays?: number
}

/** 不报告的跳过原因（也是扫描统计的分组键） */
export type SuspectSkipReason =
  | 'link'
  | 'too-short'
  | 'excluded-name'
  | 'excluded-path'
  | 'installed-match'
  | 'invalid-age'
  | 'too-new'

export interface SuspectDecision {
  suspect: boolean
  skipReason?: SuspectSkipReason
  exclusion?: ExclusionReason
  match?: SoftwareMatch
  ageDays?: number
}

/**
 * 判定一个候选目录是否属于「疑似残留」。
 *
 * 这是整个目录残留能力的唯一判定入口：真实扫描与单元测试走同一条代码路径，
 * 保证「测试里的判定」与「用户看到的判定」不会分叉。
 */
export function judgeSuspectDirectory(candidate: DirectoryCandidate, context: JudgeContext): SuspectDecision {
  if (candidate.isLink) return { suspect: false, skipReason: 'link' }
  const name = (candidate.name ?? '').trim()
  if (name.length < SUSPECT_MIN_NAME_LENGTH) return { suspect: false, skipReason: 'too-short' }

  const nameExclusion = classifyExcludedName(name)
  if (nameExclusion) return { suspect: false, skipReason: 'excluded-name', exclusion: nameExclusion }

  if (candidate.path) {
    const pathExclusion = classifyExcludedPath(candidate.path, context.exclusions)
    if (pathExclusion) return { suspect: false, skipReason: 'excluded-path', exclusion: pathExclusion }
  }

  const match = findInstalledSoftwareMatch(name, context.index)
  if (match) return { suspect: false, skipReason: 'installed-match', match }

  const ageDays = ageDaysFromMtime(candidate.mtimeMs, context.now ?? Date.now())
  if (ageDays === undefined) return { suspect: false, skipReason: 'invalid-age' }
  if (!isSuspectAge(ageDays, context.minAgeDays ?? SUSPECT_MAX_AGE_DAYS)) {
    return { suspect: false, skipReason: 'too-new', ageDays }
  }
  return { suspect: true, ageDays }
}

/* ------------------------------------------------------------------ */
/* 上报项与 note                                                       */
/* ------------------------------------------------------------------ */

/** 疑似残留目录（扫描结果） */
export interface SuspectDirectoryDetail {
  path: string
  name: string
  /** 所属扫描根标签，如 `%PROGRAMDATA%` */
  rootLabel: string
  rootKind: SuspectRootKind
  ageDays: number
  mtimeMs?: number
}

const ROOT_KIND_LABEL: Record<SuspectRootKind, string> = {
  'program-files': '程序目录',
  'local-programs': '用户级程序目录',
  'program-data': '发布者目录',
  'local-appdata': '应用数据目录',
  'roaming-appdata': '漫游应用数据目录',
}

/**
 * 生成可读 note：写明「为什么被判定为疑似残留」（无任何已安装软件匹配）、
 * 年龄、所在扫描根，以及「只提示不删除」的语义。
 */
export function formatSuspectNote(detail: Pick<SuspectDirectoryDetail, 'name' | 'rootLabel' | 'rootKind' | 'ageDays'>, installedCount: number): string {
  const kindLabel = ROOT_KIND_LABEL[detail.rootKind] ?? '目录'
  const location = detail.rootKind === 'program-data'
    ? `${detail.rootLabel} 的发布者目录层`
    : detail.rootLabel
  const compared = installedCount > 0 ? `${installedCount} 个已安装软件` : '已解析的卸载项'
  return `疑似残留${kindLabel}：目录名「${detail.name}」与 ${compared}（显示名/发布者/安装路径）均无匹配；最后修改距今 ${formatAgeDays(detail.ageDays)}；位于 ${location}；仅提示，不会自动删除，请人工确认`
}

/** 上报给内核的清理项草稿（结构性兼容 CleanItemDraft） */
export interface SuspectItemDraft {
  path: string
  title: string
  kind: 'directory'
  size: 0
  risk: 'risky'
  defaultSelected: false
  recommended: false
  note: string
  meta: {
    root: string
    rootKind: SuspectRootKind
    ageDays: number
    installedCount: number
    /** 判定依据：未匹配到任何已安装软件 */
    reason: 'no-installed-software-match'
  }
}

/**
 * 疑似残留目录 → 清理项草稿。
 *
 * 语义红线在这里固化：目录类残留永远是 `risky` + `defaultSelected: false` +
 * `recommended: false`，并且不声明 pathPolicy 根，内核会把它标记为受保护项，
 * 因此它只会出现在报告里，永远不会被清理。
 */
export function toSuspectDraft(suspect: SuspectDirectoryDetail, installedCount: number): SuspectItemDraft {
  return {
    path: suspect.path,
    title: suspect.name,
    kind: 'directory',
    size: 0,
    risk: 'risky',
    defaultSelected: false,
    recommended: false,
    note: formatSuspectNote(suspect, installedCount),
    meta: {
      root: suspect.rootLabel,
      rootKind: suspect.rootKind,
      ageDays: suspect.ageDays,
      installedCount,
      reason: 'no-installed-software-match',
    },
  }
}
