/**
 * Windows 路径工具集。
 *
 * 设计要点：
 * 1. 统一分隔符与大小写，保证路径比较稳定（Windows 文件系统大小写不敏感）；
 * 2. 提供长路径（`\\?\`）转换，绕过 260 字符 MAX_PATH 限制；
 * 3. 提供「父子路径」判断，供路径策略服务做安全校验。
 */
import { win32 } from 'node:path'

/** 把剩余部分里的重复分隔符折叠成单个反斜杠（前缀已先行剥掉） */
function collapseSeparators(value: string): string {
  return value.replace(/\\{2,}/g, '\\')
}

/** 去掉结尾分隔符，但保留盘符根（`C:\` 不变成 `C:`） */
function trimRootSeparator(value: string): string {
  return value.length > 3 && value.endsWith('\\') ? value.slice(0, -1) : value
}

/**
 * 统一为反斜杠、去除多余分隔符与结尾分隔符。
 *
 * **顺序很关键**：必须先识别并剥掉前缀，只对「剩余部分」折叠重复分隔符，
 * 否则 `\\?\C:\x`、`\\srv\sh` 会先被折叠成单斜杠，长路径/UNC 语义直接丢失。
 *
 * 三类前缀的处理结果：
 * - `\\?\C:\a`       → `C:\a`（长路径前缀不参与比较，与普通盘符路径等价）
 * - `\\?\UNC\srv\sh` → `\\srv\sh`（长路径 UNC 还原为普通 UNC）
 * - `\\srv\sh`       → `\\srv\sh`（普通 UNC 保留双斜杠）
 *
 * 设备/卷路径（`\\?\GLOBALROOT\...`、`\\?\Volume{...}`、`\\.\C:`）不是常规
 * 盘符/UNC 路径，刻意保留其前缀形态，使 `isAbsolutePath()` 判为 false，
 * 由路径策略统一拒绝 —— fail-closed，绝不折叠成看似合法的绝对路径。
 */
export function normalizePath(input: string): string {
  const raw = (input ?? '').trim().replace(/\//g, '\\')
  if (!raw) return ''

  // ① 长路径 UNC：`\\?\UNC\srv\sh\a` → `\\srv\sh\a`
  if (/^\\\\\?\\UNC\\/i.test(raw)) {
    const rest = collapseSeparators(raw.slice(8).replace(/^\\+/, ''))
    if (!rest) return '\\\\'
    return trimRootSeparator('\\\\' + rest)
  }

  // ② 长路径盘符：`\\?\C:\a\.\b` → `C:\a\b`；其它长路径（设备/卷）保持前缀
  if (/^\\\\\?\\/i.test(raw)) {
    const rest = collapseSeparators(raw.slice(4).replace(/^\\+/, ''))
    if (/^[a-zA-Z]:/.test(rest)) return trimRootSeparator(win32.normalize(rest))
    return trimRootSeparator('\\\\?\\' + rest)
  }

  // ③ 设备路径（`\\.\C:`、`\\.\UNC\...`）：保留 `\\.\` 前缀，交由策略拒绝
  if (/^\\\\\.\\/i.test(raw)) {
    const rest = collapseSeparators(raw.slice(4).replace(/^\\+/, ''))
    return trimRootSeparator('\\\\.\\' + rest)
  }

  // ④ 普通 UNC：保留双斜杠，只折叠剩余部分
  if (/^\\\\/.test(raw)) {
    const rest = collapseSeparators(raw.replace(/^\\+/, ''))
    if (!rest) return '\\\\'
    return trimRootSeparator('\\\\' + rest)
  }

  // ⑤ 盘符路径 / 相对路径 / 单根路径
  return trimRootSeparator(win32.normalize(collapseSeparators(raw)))
}

/**
 * 清理路径中的「Windows 会静默修正、但字符串比较不会」的写法：
 * 每段末尾的 `.` 与空格会被文件系统忽略（`C:\Windows\System32.` 实际指向 `System32`）。
 * 返回规范化后的路径；`..` 已被 win32.normalize 解析掉。
 */
export function canonicalizePath(input: string): string {
  const normalized = normalizePath(input)
  const prefixMatch = /^([a-zA-Z]:\\|\\\\)/.exec(normalized)
  const prefix = prefixMatch ? prefixMatch[1] : ''
  const rest = normalized.slice(prefix.length)
  const segments = rest
    .split('\\')
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.replace(/[. ]+$/, '') || segment)
  return prefix + segments.join('\\')
}

/** 是否含有 `..` 段（规范化之后仍存在说明是异常输入） */
export function hasParentSegment(input: string): boolean {
  return input.split(/[\\/]/).some((segment) => segment === '..')
}

/** 用于比较的路径键：规范化 + 小写 */
export function pathKey(input: string): string {
  return normalizePath(input).toLowerCase()
}

/**
 * 是否为绝对路径（`C:\...` 或 UNC `\\server\share`）。
 *
 * 先自行规范化，因此 `\\?\C:\a` 会被还原为 `C:\a` 判 true；而设备/卷路径
 * （`\\?\GLOBALROOT\...`、`\\.\C:`）以及只有服务器名没有共享名的 `\\srv`
 * 一律判 false —— 这些写法无法可靠映射到常规文件系统路径，必须 fail-closed。
 */
export function isAbsolutePath(input: string): boolean {
  const path = normalizePath(input)
  if (!path) return false
  if (/^[a-zA-Z]:\\/.test(path)) return true
  if (!path.startsWith('\\\\')) return false
  // 长路径/设备前缀未在 normalizePath 中被还原：不是常规绝对路径
  if (path.startsWith('\\\\?\\') || path.startsWith('\\\\.\\')) return false
  // UNC 必须同时具备「服务器名 + 共享名」两段
  return path.slice(2).split('\\').filter(Boolean).length >= 2
}

/** parent 是否为 child 的祖先目录（或相等） */
export function isSubPath(parent: string, child: string): boolean {
  const p = pathKey(parent)
  const c = pathKey(child)
  if (p === c) return true
  const prefix = p.endsWith('\\') ? p : p + '\\'
  return c.startsWith(prefix)
}

/**
 * 转换为长路径形式，避免 MAX_PATH 限制。
 *
 * - 盘符路径 `C:\a`     → `\\?\C:\a`
 * - UNC 路径 `\\srv\sh` → `\\?\UNC\srv\sh`（这是 Win32 唯一正确的长 UNC 形式）
 * - 已是 `\\?\` / `\\.\` 前缀 → 原样返回，避免重复加前缀
 * - 相对路径无法安全转换 → 原样返回（调用方只在路径策略放行后使用，
 *   策略会拒绝非绝对路径，因此不会把相对路径当绝对路径操作）
 */
export function toLongPath(input: string): string {
  const path = normalizePath(input)
  if (!path) return path
  if (path.startsWith('\\\\?\\') || path.startsWith('\\\\.\\')) return path
  if (path.startsWith('\\\\')) {
    // 只有服务器名没有共享名的畸形 UNC（`\\srv`）保持原样，不伪造长路径
    if (path.slice(2).split('\\').filter(Boolean).length < 2) return path
    return '\\\\?\\UNC\\' + path.slice(2)
  }
  if (/^[a-zA-Z]:\\/.test(path)) return '\\\\?\\' + path
  return path
}

/** 取盘符，如 `D:\a` → `D:` */
export function driveOf(input: string): string {
  const match = /^([a-zA-Z]:)/.exec(normalizePath(input))
  return match ? match[1].toUpperCase() : ''
}

/** 取父目录；已是根目录时返回自身 */
export function parentPath(input: string): string {
  const path = normalizePath(input)
  const dir = win32.dirname(path)
  return dir === path ? path : dir
}

/** 路径深度（`C:\a\b` → 2） */
export function depthOf(input: string): number {
  const path = normalizePath(input)
  return path.split('\\').filter(Boolean).length - 1
}

/** 是否为「伪路径」（注册表键、命令等非文件系统对象） */
export function isVirtualPath(input: string): boolean {
  return /^(HKEY_|HKLM|HKCU|HKCR|HKU|reg:|task:|shell:|cmd:)/i.test(input)
}

/** 裁剪字符串到指定长度，中间用省略号代替（用于日志与界面展示） */
export function ellipsis(input: string, max = 80): string {
  if (input.length <= max) return input
  const keep = Math.max(4, Math.floor((max - 3) / 2))
  return input.slice(0, keep) + '...' + input.slice(input.length - keep)
}
