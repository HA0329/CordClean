/**
 * Windows 路径工具集。
 *
 * 设计要点：
 * 1. 统一分隔符与大小写，保证路径比较稳定（Windows 文件系统大小写不敏感）；
 * 2. 提供长路径（`\\?\`）转换，绕过 260 字符 MAX_PATH 限制；
 * 3. 提供「父子路径」判断，供路径策略服务做安全校验。
 */
import { win32 } from 'node:path'

/** 统一为反斜杠、去除多余分隔符与结尾分隔符 */
export function normalizePath(input: string): string {
  let path = input.trim().replace(/\//g, '\\').replace(/\\{2,}/g, '\\')
  path = win32.normalize(path)
  if (path.length > 3 && path.endsWith('\\')) path = path.slice(0, -1)
  return path
}

/** 用于比较的路径键：规范化 + 小写 */
export function pathKey(input: string): string {
  return normalizePath(input).toLowerCase()
}

/** 是否为绝对路径（`C:\...` 或 UNC `\\server\share`） */
export function isAbsolutePath(input: string): boolean {
  return /^[a-zA-Z]:\\/.test(input) || /^\\\\[^\\?]/.test(input) || input.startsWith('\\\\?\\')
}

/** parent 是否为 child 的祖先目录（或相等） */
export function isSubPath(parent: string, child: string): boolean {
  const p = pathKey(parent)
  const c = pathKey(child)
  if (p === c) return true
  const prefix = p.endsWith('\\') ? p : p + '\\'
  return c.startsWith(prefix)
}

/** 转换为长路径形式，避免 MAX_PATH 限制 */
export function toLongPath(input: string): string {
  const path = normalizePath(input)
  if (path.startsWith('\\\\?\\')) return path
  if (path.startsWith('\\\\')) return '\\\\?\\UNC\\' + path.slice(2)
  return '\\\\?\\' + path
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
