/**
 * 孤儿卸载项判定（纯逻辑层，可完整单测）。
 *
 * 背景：`Uninstall` 注册表键是「程序已卸载但卸载登记残留」的常见来源。
 * 现有 `isJunkUninstall` 只处理「完全空 / 没有任何有效标识」的垃圾键；
 * 本模块补充第二类可以**明确判定**的残留：
 *
 * - `InstallLocation` 指向的安装目录已经不存在；
 * - `UninstallString` 指向的卸载程序 exe 已经不存在。
 *
 * 安全约束（真实扫描必须保持只读、零执行）：
 * 1. 模块本身不碰文件系统、不执行任何命令：判定只依赖调用方注入的存在性检查
 *    （`exists`），因此可以完整单测；真实扫描注入的只是 `fs.lstat` 只读探测。
 * 2. 只判定 **DisplayName 非空** 的条目 —— 这保证与 `isJunkUninstall` 的垃圾键
 *    判定不重叠（垃圾键按定义没有 DisplayName 这类有业务含义的值）。
 * 3. 宁漏勿错：网络路径（UNC）、无法展开的环境变量、相对路径/设备路径、
 *    不在当前磁盘列表中的盘符、无法可靠定位 exe 的命令形式一律**跳过**，不上报。
 * 4. 存在性检查抛错时保守视为「存在」，只有明确不存在才上报，避免权限/IO 错误
 *    造成误报。
 */
import { isAbsolutePath, normalizePath } from '@cordclean/utils'

/** 只读环境变量访问器（用于展开 `%ProgramFiles%` 等）；未定义时返回 undefined */
export type EnvLookup = (name: string) => string | undefined

/**
 * 存在性检查注入。
 *
 * 约定：只有**确定不存在**才返回 `false`；权限不足 / IO 错误 / 无法访问
 * 必须返回 `true`（保守，避免误报孤儿项）。
 */
export type ExistsProbe = (target: string) => boolean | Promise<boolean>

/** 从注册表读到的单个 Uninstall 子键快照（字符串保留原始值，由本模块自行清洗） */
export interface UninstallEntrySnapshot {
  /** 完整注册表键路径，如 `HKEY_LOCAL_MACHINE\...\Uninstall\7-Zip` */
  key: string
  displayName?: string
  installLocation?: string
  uninstallString?: string
}

/** 孤儿卸载项的判定原因 */
export type OrphanReason = 'install-location-missing' | 'uninstall-exe-missing'

/** 一条具体的失效证据 */
export interface OrphanFailure {
  reason: OrphanReason
  /** 规范化后的绝对路径 */
  path: string
  /** 注册表原始字段值，便于展示与追溯 */
  raw: string
}

/** 判定为孤儿的卸载项 */
export interface OrphanUninstall {
  key: string
  displayName: string
  /** 主原因（同时命中两条时优先 uninstall-exe-missing） */
  reason: OrphanReason
  /** 主失效路径 */
  targetPath: string
  /** 全部失效证据（可能同时有两条） */
  failures: OrphanFailure[]
  installLocation: string
  uninstallString: string
}

/** 跳过验证的原因：全部属于「无法确定」，不是命中 */
export type UnverifiableReason =
  | 'display-name-empty'
  | 'no-path-fields'
  | 'network-path'
  | 'unknown-drive'
  | 'not-absolute'
  | 'unresolved-variable'
  | 'unparseable-command'

/** 被跳过的字段（用于日志统计，不产生上报项） */
export interface SkippedUninstallField {
  key: string
  field: 'entry' | 'installLocation' | 'uninstallString'
  raw: string
  reason: UnverifiableReason
}

/** 判定选项：存在性检查与只读环境注入 */
export interface OrphanDetectOptions {
  exists: ExistsProbe
  /** 只读环境变量访问器，用于展开 `%ProgramFiles%` 等 */
  env?: EnvLookup
  /** 当前存在的固定磁盘盘符（如 `['C:', 'D:']`）；传入后不在列表中的盘符一律跳过 */
  knownDrives?: readonly string[]
}

/** 判定结果 */
export interface OrphanDetectResult {
  orphans: OrphanUninstall[]
  /** 实际执行存在性检查的路径数量 */
  checkedPaths: number
  /** 因无法判定而跳过验证的字段（不产生上报） */
  skipped: SkippedUninstallField[]
}

/** 注册表路径字段的清洗结果 */
export interface ResolvedRegistryPath {
  /** 规范化后的路径（不可验证时为空字符串） */
  path: string
  /** 是否为普通 UNC 网络路径（网络路径不参与存在性检查） */
  network: boolean
  /** 不可验证原因 */
  reason?: UnverifiableReason
}

/** 展开 `%VAR%`：任何一个变量展开失败就整体判为不可验证（不能把 `%X%` 当空串） */
function expandEnvVarsStrict(input: string, env?: EnvLookup): { text: string; unresolved: boolean } {
  let unresolved = false
  const text = (input ?? '').replace(/%([^%]+)%/g, (_all, name) => {
    const value = env?.(String(name))
    if (value === undefined) {
      unresolved = true
      return `%${name}%`
    }
    return value
  })
  return { text, unresolved }
}

/** 去掉包裹整个字段的成对引号（不处理引号中间的内容） */
function stripWrappingQuotes(text: string): string {
  const trimmed = text.trim()
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

/** 盘符是否位于当前已知磁盘列表（大小写不敏感） */
function isKnownDrive(list: readonly string[], drive: string): boolean {
  const upper = drive.trim().toUpperCase()
  return list.some((item) => item.trim().toUpperCase() === upper)
}

/**
 * 把注册表里的路径字段清洗为「可验证的绝对路径」（纯函数，不访问文件系统）。
 *
 * 处理顺序：展开环境变量 → 去包裹引号 → 规范化 → 判定 UNC/绝对路径/盘符。
 * 返回 `{ path, network, reason }`：`reason` 存在表示当前环境无法可靠验证该路径，
 * 调用方必须跳过而不是猜测。网络路径（UNC）只标记 `network` + 理由，绝不发起探测，
 * 避免扫描卡在不可达的网络位置上。
 */
export function resolveRegistryPath(raw: string, env?: EnvLookup, knownDrives?: readonly string[]): ResolvedRegistryPath {
  const expanded = expandEnvVarsStrict(raw, env)
  if (expanded.unresolved) return { path: '', network: false, reason: 'unresolved-variable' }
  const text = stripWrappingQuotes(expanded.text)
  if (!text) return { path: '', network: false, reason: 'no-path-fields' }

  const normalized = normalizePath(text)
  if (!normalized) return { path: '', network: false, reason: 'no-path-fields' }

  // 普通 UNC（`\\server\share`）不算常规可验证路径；排除 `\\?\` / `\\.\` 设备前缀
  const network = /^\\\\[^\\?.]/.test(normalized)
  if (network) return { path: normalized, network: true, reason: 'network-path' }
  if (!isAbsolutePath(normalized)) return { path: normalized, network: false, reason: 'not-absolute' }

  if (knownDrives && knownDrives.length > 0) {
    const drive = /^([a-zA-Z]:)\\/.exec(normalized)
    if (drive && !isKnownDrive(knownDrives, drive[1])) {
      return { path: normalized, network: false, reason: 'unknown-drive' }
    }
  }
  return { path: normalized, network: false }
}

/** `UninstallString` 解析结果 */
export interface ParsedUninstallCommand {
  /** 可验证的 exe 绝对路径；无法可靠定位时为空 */
  executable?: string
  /** 去掉可执行文件后的参数原文（只为展示/追溯，**绝不执行**） */
  args: string
  /** 无法定位 exe 的原因 */
  reason?: UnverifiableReason
}

/**
 * 解析 `UninstallString`（纯函数，不执行任何命令）。
 *
 * 支持的常见形式：
 * - `"C:\Program Files\App\unins000.exe" /S`（引号 + 参数；参数原样保留）
 * - `C:\Program Files\App\uninstall.exe`（未加引号、无参数）
 * - `C:\App\uninstall.exe --mode=uninstall`（未加引号 + 参数）
 *
 * 明确不支持（返回 `reason` 由调用方跳过）：
 * - `MsiExec.exe /X{GUID}` 这类依赖 PATH 解析、无法确认绝对路径的命令；
 * - 引号不闭合、不含 `.exe` 的命令形式；
 * - 网络路径、无法展开的 `%VAR%`、相对路径/设备路径。
 */
export function parseUninstallCommand(
  raw: string,
  env?: EnvLookup,
  knownDrives?: readonly string[],
): ParsedUninstallCommand {
  const expanded = expandEnvVarsStrict(raw, env)
  if (expanded.unresolved) return { args: '', reason: 'unresolved-variable' }
  const text = expanded.text.trim()
  if (!text) return { args: '', reason: 'no-path-fields' }

  let executableRaw = ''
  let args = ''
  if (text.startsWith('"')) {
    const close = text.indexOf('"', 1)
    // 引号不闭合：不做猜测，交给调用方跳过
    if (close <= 0) return { args: text, reason: 'unparseable-command' }
    executableRaw = text.slice(1, close)
    args = text.slice(close + 1).trim()
  } else {
    // 未加引号：取第一个以 `.exe` 结束且后面是空白/结尾的片段作为可执行文件。
    // 注意：路径本身带空格且未加引号在 Windows 上语义有歧义，这里按最保守的
    // 「首个 .exe 边界」解析；解析结果仍须是绝对路径才会被验证，否则跳过。
    const match = /^(.*?\.exe)(?=\s|$)/i.exec(text)
    if (!match) return { args: text, reason: 'unparseable-command' }
    executableRaw = match[1]
    args = text.slice(executableRaw.length).trim()
  }

  const resolved = resolveRegistryPath(executableRaw, env, knownDrives)
  if (!resolved.path || resolved.reason) return { args, reason: resolved.reason ?? 'unparseable-command' }
  return { executable: resolved.path, args }
}

/**
 * `reg.exe` 回退解码的可靠性判定：只有纯可打印 ASCII 字段才可信。
 *
 * 中文 Windows 上 `reg query` 输出是 GBK，回退路径按 UTF-8 解码会得到替换字符 /
 * 乱码（真实案例：「完美世界竞技平台」→ `����...`）。垃圾键判定只比值名、
 * 不受影响；但孤儿判定依赖路径存在性，乱码路径必然 lstat 不到，会把正常登记
 * 误判成「程序已不存在」。因此回退模式下必须用本函数先过滤，宁可漏报。
 */
export function isReliablyEncodedField(value: string): boolean {
  return /^[\x20-\x7E]*$/.test(value)
}

/** 调用注入的存在性检查：抛错或非明确 false 都保守视为「存在」 */
async function probeExists(probe: ExistsProbe, target: string): Promise<boolean> {
  try {
    return (await probe(target)) !== false
  } catch {
    return true
  }
}

/** 把失效证据转成一句面向用户的说明（供扫描项 note 复用） */
export function describeOrphanFailure(failure: OrphanFailure): string {
  return failure.reason === 'install-location-missing'
    ? `安装目录已不存在：${failure.path}`
    : `卸载程序已不存在：${failure.path}`
}

/**
 * 判定一批卸载项中的孤儿项（需要存在性检查，因此为 async；无其它副作用）。
 *
 * 判定规则：
 * 1. `displayName` 为空 → 跳过（与垃圾键判定不重叠，交给 `isJunkUninstall`）；
 * 2. 两个路径字段都为空 → 跳过（没有可验证内容）；
 * 3. `InstallLocation` 可解析为绝对路径且**确定不存在** → `install-location-missing`；
 * 4. `UninstallString` 可解析出绝对 exe 路径且**确定不存在** → `uninstall-exe-missing`；
 * 5. 其余无法判定的路径（网络/环境变量/相对路径/盘符等）只记入 `skipped`，不上报。
 *
 * 同一条目两条证据都命中时，`failures` 保留两条，主 `reason` 优先 exe 缺失
 * （卸载程序都没了，比安装目录缺失更直接）。
 *
 * `exists` 抛错时保守视为存在（见 {@link ExistsProbe}）。
 */
export async function detectOrphanUninstall(
  entries: readonly UninstallEntrySnapshot[],
  options: OrphanDetectOptions,
): Promise<OrphanDetectResult> {
  const orphans: OrphanUninstall[] = []
  const skipped: SkippedUninstallField[] = []
  let checkedPaths = 0

  for (const entry of entries) {
    const key = (entry?.key ?? '').trim()
    if (!key) continue
    const displayName = (entry?.displayName ?? '').trim()
    if (!displayName) {
      skipped.push({ key, field: 'entry', raw: entry?.displayName ?? '', reason: 'display-name-empty' })
      continue
    }

    const installLocation = (entry?.installLocation ?? '').trim()
    const uninstallString = (entry?.uninstallString ?? '').trim()
    if (!installLocation && !uninstallString) {
      skipped.push({ key, field: 'entry', raw: '', reason: 'no-path-fields' })
      continue
    }

    const failures: OrphanFailure[] = []

    if (installLocation) {
      const resolved = resolveRegistryPath(installLocation, options.env, options.knownDrives)
      if (!resolved.path || resolved.reason) {
        skipped.push({ key, field: 'installLocation', raw: installLocation, reason: resolved.reason ?? 'not-absolute' })
      } else {
        checkedPaths++
        if (!(await probeExists(options.exists, resolved.path))) {
          failures.push({ reason: 'install-location-missing', path: resolved.path, raw: installLocation })
        }
      }
    }

    if (uninstallString) {
      const parsed = parseUninstallCommand(uninstallString, options.env, options.knownDrives)
      if (!parsed.executable) {
        skipped.push({
          key,
          field: 'uninstallString',
          raw: uninstallString,
          reason: parsed.reason ?? 'unparseable-command',
        })
      } else {
        checkedPaths++
        if (!(await probeExists(options.exists, parsed.executable))) {
          failures.push({ reason: 'uninstall-exe-missing', path: parsed.executable, raw: uninstallString })
        }
      }
    }

    if (failures.length === 0) continue
    const primary = failures.find((failure) => failure.reason === 'uninstall-exe-missing') ?? failures[0]
    orphans.push({
      key,
      displayName,
      reason: primary.reason,
      targetPath: primary.path,
      failures,
      installLocation,
      uninstallString,
    })
  }

  return { orphans, checkedPaths, skipped }
}
