/**
 * 注册表问题清理插件（registry）。
 *
 * 采用「保守策略」：只处理三类**可以明确判定为无效**的注册表项，
 * 并且每一项在删除前都一定先导出 `.reg` 备份：
 *
 * 1. 无效卸载项：`Uninstall` 键中既没有 `DisplayName` 也没有 `UninstallString` 的垃圾键；
 * 2. 孤儿卸载项：`DisplayName` 存在，但 `InstallLocation` 指向的目录、
 *    或 `UninstallString` 指向的卸载程序 exe 已经不存在（判定逻辑见 `./orphans.ts`，
 *    只读、不执行任何 exe，网络路径/环境变量无法验证时一律跳过）；
 * 3. 无效 `App Paths`：默认值（`(默认)`）指向的 exe 已经不存在的项。
 *
 * 刻意**不做**的事情（风险过高，收益不成比例）：
 * - 不做 `SharedDLLs` 引用计数清理；
 * - 不做文件关联（`HKCR`）批量修复；
 * - 不删除任何文件系统内容（本插件只操作注册表，且全部走自定义 `clean`）。
 *
 * 权限降级：非管理员时跳过 `HKEY_LOCAL_MACHINE` 下的检查，
 * 通过 `scan.addError()` 说明原因（不抛错，任务照常返回 HKCU 的结果）。
 *
 * 中文编码：中文 Windows 上 `reg.exe` 输出为 GBK，按 UTF-8 解码会乱码，
 * 因此优先用 PowerShell 注册表提供程序 + `ConvertTo-Json`（真 Unicode），
 * 仅在 PowerShell 不可用时回退到 `reg query` + `parseRegValues`；回退时孤儿判定
 * 只接受纯 ASCII 字段（乱码路径无法可靠验证存在性，宁可跳过也不能误报）。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import Schema from 'schemastery'
import { basename, defineCleanerPlugin } from '@cordclean/shared'
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
  toLongPath,
} from '@cordclean/utils'
import { describeOrphanFailure, detectOrphanUninstall, isReliablyEncodedField } from './orphans.ts'
import type { OrphanUninstall, UninstallEntrySnapshot } from './orphans.ts'

export * from './orphans.ts'

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/** 卸载项所在的 4 个注册表位置 */
export const UNINSTALL_ROOTS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
]

/** `App Paths` 所在的注册表位置（同时覆盖 32 位视图） */
export const APP_PATH_ROOTS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths',
]

/** `reg.exe` 输出中「默认值」的值名（中英文系统不同） */
const DEFAULT_VALUE_NAME = /^\((默认|default)\)$/i

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

export interface RegistryConfig {
  checkUninstall: boolean
  checkAppPaths: boolean
  backupDir: string
}

const Config = Schema.object({
  checkUninstall: Schema.boolean()
    .default(true)
    .description('检查无效卸载项：完全空/无有效标识的垃圾键，以及 DisplayName 存在但安装目录或卸载程序已不存在的孤儿项（保守判定）'),
  checkAppPaths: Schema.boolean()
    .default(true)
    .description('检查无效的 App Paths（默认值指向的 exe 已不存在）'),
  backupDir: Schema.string()
    .default('')
    .description('注册表备份目录，留空表示使用数据目录下的 backups 文件夹'),
})

/** 无效卸载项（垃圾键） */
export interface JunkUninstallKey {
  key: string
  /** 该键包含的值数量（0 表示空键） */
  valueCount: number
}

/** 失效的 App Paths 项 */
export interface BrokenAppPath {
  key: string
  /** 键名，通常形如 `foo.exe` */
  name: string
  /** 已不存在 exe 的绝对路径 */
  exe: string
}

/** 注册表探测结果（同时导出给自测脚本，证明扫描真实执行） */
export interface RegistryProbe {
  /** 无有效标识的垃圾卸载键（无 DisplayName，不会与孤儿项重叠） */
  junkUninstall: JunkUninstallKey[]
  /** 孤儿卸载项：DisplayName 存在，但安装目录 / 卸载程序 exe 已不存在 */
  orphanUninstall: OrphanUninstall[]
  brokenAppPaths: BrokenAppPath[]
  /** 实际检查过的卸载项数量 */
  checkedUninstall: number
  /** 实际检查过的 App Paths 数量 */
  checkedAppPaths: number
  /** 孤儿判定中实际执行过只读存在性检查的路径数量 */
  checkedOrphanPaths: number
  /** 孤儿判定中因网络路径/环境变量/命令形式无法验证而跳过的字段数量 */
  skippedOrphanFields: number
  warnings: string[]
}

/** 探测选项：`includeHklm` 允许自测脚本在非管理员环境下也只读地检查 HKLM */
export interface RegistryProbeOptions {
  includeHklm?: boolean
  checkUninstall?: boolean
  checkAppPaths?: boolean
}

/* ------------------------------------------------------------------ */
/* 注册表读取                                                          */
/* ------------------------------------------------------------------ */

/** HKLM\A\B → HKLM:\A\B */
function toPsRegistryPath(key: string): string {
  return key.replace(/^HKLM\\/i, 'HKLM:\\').replace(/^HKCU\\/i, 'HKCU:\\')
}

/** 统一键路径为 HKEY_ 长格式 */
function normalizeKeyPath(key: string): string {
  return key.trim().replace(/[\\/]+$/, '').replace(/^HKLM\\/i, 'HKEY_LOCAL_MACHINE\\').replace(/^HKCU\\/i, 'HKEY_CURRENT_USER\\')
}

/** 展开 %VAR%（插件不直接读 process.env，统一走 TaskEnv.get） */
function expandEnvVars(input: string, env: TaskEnv): string {
  return (input ?? '').replace(/%([^%]+)%/g, (_all, name) => env.get(String(name)) ?? '')
}

/**
 * 清理 App Paths 默认值中的路径：展开变量、去引号，只保留绝对路径形式的 .exe。
 * 无法判定时返回空字符串（宁可漏报，也不要误报）。
 */
function cleanExeValue(raw: string, env: TaskEnv): string {
  let text = expandEnvVars(raw, env).trim()
  if (!text) return ''
  if (/^".*"$/.test(text) || /^'.*'$/.test(text)) text = text.slice(1, -1).trim()
  text = text.trim()
  if (!text || !/\.exe$/i.test(text) || !isAbsolutePath(text)) return ''
  try {
    return normalizePath(text)
  } catch {
    return ''
  }
}

function str(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

/**
 * 构造一次性完成「卸载项 + App Paths」枚举的 PowerShell 脚本。
 *
 * 使用 `Get-Item` + `OpenSubKey` + `GetValue`，而不是 `Get-ItemProperty`：
 * 这样即使键里一个值都没有，也一定能拿到键路径，不会漏掉空键。
 */
function buildProbeScript(uninstallRoots: string[], appPathRoots: string[]): string {
  const uninstallBlocks = uninstallRoots
    .map(
      (root) => `
$key = Get-Item -LiteralPath '${toPsRegistryPath(root)}' -ErrorAction SilentlyContinue
if ($key) {
  foreach ($sub in $key.GetSubKeyNames()) {
    $child = $null
    try { $child = $key.OpenSubKey($sub) } catch { continue }
    if ($child) {
      $valueNames = @($child.GetValueNames())
      $uninstall += [pscustomobject]@{
        key = $key.Name + '\\' + $sub
        displayName = [string]$child.GetValue('DisplayName')
        uninstallString = [string]$child.GetValue('UninstallString')
        installLocation = [string]$child.GetValue('InstallLocation')
        valueCount = $valueNames.Count
        valueNames = ($valueNames -join '|')
      }
      $child.Close()
    }
  }
}`,
    )
    .join('\n')
  const appPathBlocks = appPathRoots
    .map(
      (root) => `
$key = Get-Item -LiteralPath '${toPsRegistryPath(root)}' -ErrorAction SilentlyContinue
if ($key) {
  foreach ($sub in $key.GetSubKeyNames()) {
    $child = $null
    try { $child = $key.OpenSubKey($sub) } catch { continue }
    if ($child) {
      $appPaths += [pscustomobject]@{
        key = $key.Name + '\\' + $sub
        name = $sub
        exe = [string]$child.GetValue('')
      }
      $child.Close()
    }
  }
}`,
    )
    .join('\n')
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$uninstall = @()',
    '$appPaths = @()',
    uninstallBlocks,
    appPathBlocks,
    'ConvertTo-Json -InputObject ([pscustomobject]@{ uninstall = @($uninstall); appPaths = @($appPaths) }) -Compress -Depth 4',
  ].join('\n')
}

/** 安全解析 JSON（空输出 / 单个对象 / 数组都能处理） */
function parseJsonResult(text: string): any {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

/** 卸载项中「有业务含义」的值名：出现任意一个即视为真实产品注册，绝不当成垃圾键 */
const MEANINGFUL_UNINSTALL_VALUES = new Set([
  'displayname',
  'uninstallstring',
  'quietuninstallstring',
  'displayversion',
  'version',
  'publisher',
  'displayicon',
  'installlocation',
  'installdate',
  'installsource',
  'installfile',
  'helplink',
  'systemcomponent',
  'norepair',
  'nomodify',
  'noremove',
  'parentkeyname',
  'pfn',
  'windowsinstaller',
  'estimatedsize',
])

/**
 * 判断一个卸载项是否为「垃圾键」。
 *
 * 采用**保守策略**：只有完全空的键，或值很少且不含任何有含义字段的键才认定为垃圾。
 * 这样可以避免把 `SystemComponent=1`（系统组件标记）或只登记了版本号的
 * 更新器（如 Microsoft Edge Update）误判为残留 —— 误删它们会破坏系统组件的卸载信息。
 */
export function isJunkUninstall(valueNames: string[], valueCount = valueNames.length): boolean {
  if (valueCount === 0) return true
  if (valueCount > 3) return false
  return !valueNames.some((name) => MEANINGFUL_UNINSTALL_VALUES.has(name.toLowerCase()))
}

/** 用 PowerShell 一次性读取卸载项与 App Paths */
async function probeWithPowerShell(
  uninstallRoots: string[],
  appPathRoots: string[],
): Promise<{ uninstall: any[]; appPaths: any[] } | undefined> {
  const result = await powershell(buildProbeScript(uninstallRoots, appPathRoots), { timeout: 60_000 })
  if (!result.ok) return undefined
  const parsed = parseJsonResult(result.stdout)
  if (!parsed || typeof parsed !== 'object') return undefined
  const toArray = (value: unknown): any[] => (Array.isArray(value) ? value : value ? [value] : [])
  return { uninstall: toArray(parsed.uninstall), appPaths: toArray(parsed.appPaths) }
}

/** PowerShell 结果 → 无效卸载项 */
function buildJunkUninstall(raw: any[]): JunkUninstallKey[] {
  const junk: JunkUninstallKey[] = []
  for (const item of raw) {
    const key = normalizeKeyPath(str(item?.key))
    if (!key) continue
    // PowerShell 可能拿到旧格式（没有 valueNames 字段），退化为按已知值名判断
    const names = str(item?.valueNames)
      ? str(item.valueNames).split('|').filter(Boolean)
      : [
          str(item?.displayName).trim() ? 'DisplayName' : '',
          str(item?.uninstallString).trim() ? 'UninstallString' : '',
        ].filter(Boolean)
    const valueCount = Number(item?.valueCount)
    const count = Number.isFinite(valueCount) ? valueCount : names.length
    if (!isJunkUninstall(names, count)) continue
    junk.push({ key, valueCount: count })
  }
  return junk
}

/**
 * PowerShell 结果 → 孤儿卸载项候选（只保留 DisplayName 非空的条目）。
 *
 * 显式排除已判定为垃圾键的条目，保证两类上报不会重复：
 * 垃圾键按定义没有 DisplayName，而孤儿项按定义必须有 DisplayName，
 * 这里的排除同时兜住「PowerShell 字段缺失导致判定口径不一致」的情况。
 */
function buildOrphanCandidates(raw: any[], junk: JunkUninstallKey[]): UninstallEntrySnapshot[] {
  const junkKeys = new Set(junk.map((item) => item.key.toLowerCase()))
  const candidates: UninstallEntrySnapshot[] = []
  for (const item of raw) {
    const key = normalizeKeyPath(str(item?.key))
    if (!key || junkKeys.has(key.toLowerCase())) continue
    const displayName = str(item?.displayName).trim()
    if (!displayName) continue
    candidates.push({
      key,
      displayName,
      installLocation: str(item?.installLocation),
      uninstallString: str(item?.uninstallString),
    })
  }
  return candidates
}

/**
 * 只读存在性探测：只有 ENOENT/ENOTDIR 才视为「确定不存在」。
 *
 * 权限不足（EACCES/EPERM）、IO 错误、非法字符等一律保守视为存在，
 * 避免因为读不到目录就误报孤儿项并删除用户的卸载登记。
 */
async function registryPathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(toLongPath(target))
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code !== 'ENOENT' && code !== 'ENOTDIR'
  }
}

/** PowerShell 结果 → 失效 App Paths（存在性检查在调用方异步完成） */
function buildAppPathCandidates(raw: any[], env: TaskEnv): Array<{ key: string; name: string; exe: string }> {
  const candidates: Array<{ key: string; name: string; exe: string }> = []
  for (const item of raw) {
    const key = normalizeKeyPath(str(item?.key))
    if (!key) continue
    const exe = cleanExeValue(str(item?.exe), env)
    if (!exe) continue
    candidates.push({ key, name: str(item?.name).trim() || basename(key), exe })
  }
  return candidates
}

/**
 * reg.exe 兜底：一次性枚举卸载项，同时收集「垃圾键」与「孤儿项候选」，
 * 避免为了两类判定把每个子键查询两遍。
 *
 * 孤儿候选必须所有字段都能可靠解码（`isReliablyEncodedField`）：回退路径把 GBK
 * 输出按 UTF-8 解码，中文路径会乱码，拿去 lstat 必然不存在，从而把正常登记
 * 误报成孤儿。`untrusted` 是因此**放弃孤儿判定**的条目数，用于向上如实说明。
 */
async function collectUninstallViaReg(
  roots: string[],
): Promise<{ junk: JunkUninstallKey[]; candidates: UninstallEntrySnapshot[]; scanned: number; untrusted: number }> {
  const junk: JunkUninstallKey[] = []
  const candidates: UninstallEntrySnapshot[] = []
  let scanned = 0
  let untrusted = 0
  for (const root of roots) {
    const subKeys = parseRegSubKeys(await regQuery(root))
    scanned += subKeys.length
    const found = await mapLimit(subKeys, 6, async (key) => {
      const output = await regQuery(key)
      if (!output) return undefined
      const values = parseRegValues(output).filter((value) => !DEFAULT_VALUE_NAME.test(value.name))
      const names = values.map((value) => value.name)
      const normalizedKey = normalizeKeyPath(key)
      if (isJunkUninstall(names, names.length)) {
        return { junk: { key: normalizedKey, valueCount: names.length } }
      }
      const lookup = new Map(values.map((value) => [value.name.toLowerCase(), value.value]))
      const candidate: UninstallEntrySnapshot = {
        key: normalizedKey,
        displayName: lookup.get('displayname') ?? '',
        installLocation: lookup.get('installlocation') ?? '',
        uninstallString: lookup.get('uninstallstring') ?? '',
      }
      if (!candidate.displayName?.trim()) return undefined
      const trusted =
        isReliablyEncodedField(candidate.displayName ?? '') &&
        isReliablyEncodedField(candidate.installLocation ?? '') &&
        isReliablyEncodedField(candidate.uninstallString ?? '')
      if (!trusted) return { untrusted: true }
      return { candidate }
    })
    for (const item of found) {
      if (!item) continue
      if (item.junk) junk.push(item.junk)
      if (item.candidate) candidates.push(item.candidate)
      if (item.untrusted) untrusted++
    }
  }
  return { junk, candidates, scanned, untrusted }
}

/** reg.exe 兜底：枚举 App Paths 默认值 */
async function collectAppPathsViaReg(
  roots: string[],
  env: TaskEnv,
): Promise<{ candidates: Array<{ key: string; name: string; exe: string }>; scanned: number }> {
  const candidates: Array<{ key: string; name: string; exe: string }> = []
  let scanned = 0
  for (const root of roots) {
    const subKeys = parseRegSubKeys(await regQuery(root))
    scanned += subKeys.length
    const found = await mapLimit(subKeys, 6, async (key) => {
      const output = await regQuery(key)
      if (!output) return undefined
      const values = parseRegValues(output)
      const defaultValue = values.find((value) => DEFAULT_VALUE_NAME.test(value.name))
      if (!defaultValue) return undefined
      const exe = cleanExeValue(defaultValue.value, env)
      if (!exe) return undefined
      return { key: normalizeKeyPath(key), name: basename(key), exe }
    })
    for (const item of found) if (item) candidates.push(item)
  }
  return { candidates, scanned }
}

/**
 * 探测注册表问题（只读，不做任何修改）。
 *
 * 导出给自测脚本使用：`includeHklm: true` 时即使当前不是管理员，
 * 也只会「读取」HKLM 下的项，用于验证 HKLM 分支逻辑。
 */
export async function probeRegistryProblems(env: TaskEnv, options: RegistryProbeOptions = {}): Promise<RegistryProbe> {
  const includeHklm = options.includeHklm ?? env.elevated
  const checkUninstall = options.checkUninstall !== false
  const checkAppPaths = options.checkAppPaths !== false
  const warnings: string[] = []

  if (!checkUninstall && !checkAppPaths) {
    return {
      junkUninstall: [],
      orphanUninstall: [],
      brokenAppPaths: [],
      checkedUninstall: 0,
      checkedAppPaths: 0,
      checkedOrphanPaths: 0,
      skippedOrphanFields: 0,
      warnings,
    }
  }

  const pick = (roots: string[]) => roots.filter((root) => includeHklm || !/^HKLM\\/i.test(root))
  const uninstallRoots = checkUninstall ? pick(UNINSTALL_ROOTS) : []
  const appPathRoots = checkAppPaths ? pick(APP_PATH_ROOTS) : []

  let junkUninstall: JunkUninstallKey[] = []
  let orphanCandidates: UninstallEntrySnapshot[] = []
  let appPathCandidates: Array<{ key: string; name: string; exe: string }> = []
  let checkedUninstall = 0
  let checkedAppPaths = 0

  const viaPowerShell = await probeWithPowerShell(uninstallRoots, appPathRoots).catch((error) => {
    warnings.push(`PowerShell 读取注册表失败：${errorMessage(error)}`)
    return undefined
  })

  if (viaPowerShell) {
    junkUninstall = buildJunkUninstall(viaPowerShell.uninstall)
    orphanCandidates = buildOrphanCandidates(viaPowerShell.uninstall, junkUninstall)
    appPathCandidates = buildAppPathCandidates(viaPowerShell.appPaths, env)
    checkedUninstall = viaPowerShell.uninstall.length
    checkedAppPaths = viaPowerShell.appPaths.length
  } else {
    warnings.push('PowerShell 不可用，已回退到 reg.exe（中文路径可能乱码）')
    if (uninstallRoots.length) {
      const result = await collectUninstallViaReg(uninstallRoots)
      junkUninstall = result.junk
      orphanCandidates = result.candidates
      checkedUninstall = result.scanned
      if (result.untrusted > 0) {
        warnings.push(
          `reg.exe 回退输出按 UTF-8 解码，${result.untrusted} 条含非 ASCII 字段的卸载项编码不可靠，已跳过孤儿判定（避免乱码路径被误判为不存在）`,
        )
      }
    }
    if (appPathRoots.length) {
      const result = await collectAppPathsViaReg(appPathRoots, env)
      appPathCandidates = result.candidates
      checkedAppPaths = result.scanned
    }
  }

  // 孤儿卸载项：只读存在性检查（网络路径/无法展开的变量/未知盘符已在纯函数内跳过，
  // 不会发起网络探测，也不会执行任何 UninstallString）
  let orphanUninstall: OrphanUninstall[] = []
  let checkedOrphanPaths = 0
  let skippedOrphanFields = 0
  if (checkUninstall && orphanCandidates.length > 0) {
    const detection = await detectOrphanUninstall(orphanCandidates, {
      exists: registryPathExists,
      env: (name) => env.get(name),
      knownDrives: env.drives,
    })
    orphanUninstall = detection.orphans
    checkedOrphanPaths = detection.checkedPaths
    skippedOrphanFields = detection.skipped.length
  }

  // 存在性检查并发执行（每个 App Paths 一次 lstat）
  const checked = await mapLimit(appPathCandidates, 8, async (candidate) => {
    try {
      return (await exists(candidate.exe)) ? undefined : candidate
    } catch {
      return undefined
    }
  })

  return {
    junkUninstall,
    orphanUninstall,
    brokenAppPaths: checked.filter((item): item is BrokenAppPath => !!item),
    checkedUninstall,
    checkedAppPaths,
    checkedOrphanPaths,
    skippedOrphanFields,
    warnings,
  }
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

export default defineCleanerPlugin<RegistryConfig>({
  name: 'registry',
  version: '1.0.0',
  description: '清理无效/孤儿卸载项与失效的 App Paths（删除前自动导出 .reg 备份）',
  tasks: ['registry'],
  inject: ['cleaner', 'system'],
  Config,
  setup(ctx, config) {
    const env = ctx.system.env
    const checkUninstall = () => config?.checkUninstall !== false
    const checkAppPaths = () => config?.checkAppPaths !== false

    ctx.effect(() =>
      ctx.cleaner.define({
        id: 'registry',
        name: '注册表问题',
        description: '清理无效/孤儿卸载项与失效的 App Paths，删除前自动导出 .reg 备份',
        category: 'system',
        risk: 'risky',
        icon: '🗃️',
        defaultSelected: false,
        requiresAdmin: true,
        estimatedMs: 5000,
        targets: [...UNINSTALL_ROOTS, ...APP_PATH_ROOTS],
        tips: [
          '所有删除操作前都会导出 .reg 备份到数据目录 backups 文件夹',
          '孤儿卸载项指 DisplayName 存在、但安装目录或卸载程序 exe 已不存在的卸载登记（默认不勾选）',
          '非管理员权限下只能处理 HKCU 下的项',
        ],
        async scan(scan) {
          scan.throwIfAborted()
          const elevated = scan.env.elevated

          // 非管理员：跳过 HKLM，退化为只检查 HKCU（不抛错，只记录一条错误说明）
          if (!elevated && (checkUninstall() || checkAppPaths())) {
            scan.addError({
              path: 'HKEY_LOCAL_MACHINE',
              message: '当前不是管理员权限，已跳过 HKEY_LOCAL_MACHINE 下的注册表检查（仅检查 HKEY_CURRENT_USER）',
            })
          }

          const probe = await probeRegistryProblems(scan.env, {
            includeHklm: elevated,
            checkUninstall: checkUninstall(),
            checkAppPaths: checkAppPaths(),
          })
          for (const warning of probe.warnings) scan.logger.warn(warning)
          scan.logger.info(
            `注册表检查完成：${probe.checkedUninstall} 个卸载项（无效 ${probe.junkUninstall.length} 个、孤儿 ${probe.orphanUninstall.length} 个，` +
              `孤儿候选实际验证路径 ${probe.checkedOrphanPaths} 条 / 跳过 ${probe.skippedOrphanFields} 条）、` +
              `${probe.checkedAppPaths} 个 App Paths（失效 ${probe.brokenAppPaths.length} 个），范围：${elevated ? 'HKLM + HKCU' : 'HKCU'}`,
          )

          // ① 无效卸载项（垃圾键）
          if (checkUninstall()) {
            for (const junk of probe.junkUninstall) {
              scan.throwIfAborted()
              const name = basename(junk.key) || junk.key
              scan.emit({
                path: junk.key,
                title: name,
                kind: 'registry',
                size: 0,
                risk: 'risky',
                defaultSelected: false,
                note: junk.valueCount === 0
                  ? '卸载项是空键：没有任何注册表值，确属卸载残留'
                  : '卸载项没有任何有效标识字段（DisplayName / UninstallString / DisplayVersion 等）',
                meta: { kind: 'uninstall', detail: `无效卸载项：${name}（值数量 ${junk.valueCount}）` },
              })
            }
          }

          // ② 孤儿卸载项：DisplayName 存在，但安装目录 / 卸载程序 exe 已不存在。
          // 判定只读（lstat）+ 纯函数，绝不执行 UninstallString；风险标 caution、
          // 默认不勾选，清理时同样先导出 .reg 备份（复用下方 clean 的备份逻辑）。
          if (checkUninstall()) {
            for (const orphan of probe.orphanUninstall) {
              scan.throwIfAborted()
              const detail = orphan.failures.map((failure) => describeOrphanFailure(failure)).join('；')
              scan.emit({
                path: orphan.key,
                title: orphan.displayName || basename(orphan.key) || orphan.key,
                kind: 'registry',
                size: 0,
                risk: 'caution',
                defaultSelected: false,
                note: `孤儿卸载登记：${detail}（清理前会先导出 .reg 备份）`,
                meta: { kind: 'uninstall-orphan', reason: orphan.reason, detail: `孤儿卸载项：${detail}` },
              })
            }
          }

          // ③ 失效 App Paths
          if (checkAppPaths()) {
            for (const broken of probe.brokenAppPaths) {
              scan.throwIfAborted()
              scan.emit({
                path: broken.key,
                title: broken.name || basename(broken.key),
                kind: 'registry',
                size: 0,
                risk: 'risky',
                defaultSelected: false,
                note: `默认值指向的程序已不存在：${broken.exe}`,
                meta: { kind: 'app-path', detail: `App Paths 默认值指向的 exe 不存在：${broken.exe}` },
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
            if (item.kind !== 'registry') {
              results.push({ itemId: item.id, path: item.path, ok: false, bytes: 0, error: '仅支持注册表项清理' })
              continue
            }
            if (cleanCtx.dryRun) {
              results.push({ itemId: item.id, path: item.path, ok: true, bytes: 0 })
              continue
            }

            index++
            const file = path.join(backupDir, `registry-${stamp}-${index}.reg`)
            try {
              await fs.mkdir(path.dirname(file), { recursive: true })
              // 必须先备份成功，才允许删除
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
              if (await regDeleteKey(item.path)) {
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
