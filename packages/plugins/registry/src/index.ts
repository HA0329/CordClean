/**
 * 注册表问题清理插件（registry）。
 *
 * 采用「保守策略」：只处理两类**可以明确判定为无效**的注册表项，
 * 并且每一项在删除前都一定先导出 `.reg` 备份：
 *
 * 1. 无效卸载项：`Uninstall` 键中既没有 `DisplayName` 也没有 `UninstallString` 的垃圾键；
 * 2. 无效 `App Paths`：默认值（`(默认)`）指向的 exe 已经不存在的项。
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
 * 仅在 PowerShell 不可用时回退到 `reg query` + `parseRegValues`。
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
} from '@cordclean/utils'

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
    .description('检查无效的卸载项（既没有 DisplayName 也没有 UninstallString 的垃圾键）'),
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
  junkUninstall: JunkUninstallKey[]
  brokenAppPaths: BrokenAppPath[]
  /** 实际检查过的卸载项数量 */
  checkedUninstall: number
  /** 实际检查过的 App Paths 数量 */
  checkedAppPaths: number
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
        valueCount = $valueNames.Count
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
    if (str(item?.displayName).trim() || str(item?.uninstallString).trim()) continue
    const valueCount = Number(item?.valueCount)
    junk.push({ key, valueCount: Number.isFinite(valueCount) ? valueCount : 0 })
  }
  return junk
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

/** reg.exe 兜底：枚举卸载项中的垃圾键 */
async function collectJunkUninstallViaReg(roots: string[]): Promise<{ junk: JunkUninstallKey[]; scanned: number }> {
  const junk: JunkUninstallKey[] = []
  let scanned = 0
  for (const root of roots) {
    const subKeys = parseRegSubKeys(await regQuery(root))
    scanned += subKeys.length
    const found = await mapLimit(subKeys, 6, async (key) => {
      const output = await regQuery(key)
      if (!output) return undefined
      const values = parseRegValues(output).filter((value) => !DEFAULT_VALUE_NAME.test(value.name))
      const names = new Set(values.map((value) => value.name.toLowerCase()))
      if (names.has('displayname') || names.has('uninstallstring')) return undefined
      return { key: normalizeKeyPath(key), valueCount: values.length }
    })
    for (const item of found) if (item) junk.push(item)
  }
  return { junk, scanned }
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
    return { junkUninstall: [], brokenAppPaths: [], checkedUninstall: 0, checkedAppPaths: 0, warnings }
  }

  const pick = (roots: string[]) => roots.filter((root) => includeHklm || !/^HKLM\\/i.test(root))
  const uninstallRoots = checkUninstall ? pick(UNINSTALL_ROOTS) : []
  const appPathRoots = checkAppPaths ? pick(APP_PATH_ROOTS) : []

  let junkUninstall: JunkUninstallKey[] = []
  let appPathCandidates: Array<{ key: string; name: string; exe: string }> = []
  let checkedUninstall = 0
  let checkedAppPaths = 0

  const viaPowerShell = await probeWithPowerShell(uninstallRoots, appPathRoots).catch((error) => {
    warnings.push(`PowerShell 读取注册表失败：${errorMessage(error)}`)
    return undefined
  })

  if (viaPowerShell) {
    junkUninstall = buildJunkUninstall(viaPowerShell.uninstall)
    appPathCandidates = buildAppPathCandidates(viaPowerShell.appPaths, env)
    checkedUninstall = viaPowerShell.uninstall.length
    checkedAppPaths = viaPowerShell.appPaths.length
  } else {
    warnings.push('PowerShell 不可用，已回退到 reg.exe（中文路径可能乱码）')
    if (uninstallRoots.length) {
      const result = await collectJunkUninstallViaReg(uninstallRoots)
      junkUninstall = result.junk
      checkedUninstall = result.scanned
    }
    if (appPathRoots.length) {
      const result = await collectAppPathsViaReg(appPathRoots, env)
      appPathCandidates = result.candidates
      checkedAppPaths = result.scanned
    }
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
    brokenAppPaths: checked.filter((item): item is BrokenAppPath => !!item),
    checkedUninstall,
    checkedAppPaths,
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
  description: '清理无效的卸载项与失效的 App Paths（删除前自动导出 .reg 备份）',
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
        description: '清理无效的卸载项与失效的 App Paths，删除前自动导出 .reg 备份',
        category: 'system',
        risk: 'risky',
        icon: '🗃️',
        defaultSelected: false,
        requiresAdmin: true,
        estimatedMs: 5000,
        targets: [...UNINSTALL_ROOTS, ...APP_PATH_ROOTS],
        tips: [
          '所有删除操作前都会导出 .reg 备份到数据目录 backups 文件夹',
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
            `注册表检查完成：${probe.checkedUninstall} 个卸载项（无效 ${probe.junkUninstall.length} 个）、` +
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
                  ? '卸载项是空键：既没有 DisplayName 也没有 UninstallString'
                  : '卸载项缺少 DisplayName 与 UninstallString，属于无效注册表键',
                meta: { kind: 'uninstall', detail: `无效卸载项：${name}（值数量 ${junk.valueCount}）` },
              })
            }
          }

          // ② 失效 App Paths
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
