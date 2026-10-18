/**
 * 文件系统安全操作原语。
 *
 * 全部操作都遵循两条铁律：
 * 1. **不跟随符号链接/联接点**：删除链接本身而不是目标（Windows 下 junction 事故的根源）；
 * 2. **长路径安全**：统一使用 `\\?\` 前缀，绕开 MAX_PATH=260 的限制。
 */
import { promises as fs } from 'node:fs'
import { errorCode, errorMessage, isAbortError } from './utils.ts'
import { normalizePath, toLongPath } from './paths.ts'

/** 删除结果 */
export interface DeleteResult {
  /** 实际释放字节数（删除前统计） */
  bytes: number
  /** 是否因为该项是链接而只删除了链接本身 */
  linkOnly: boolean
}

/**
 * 检查目标路径的祖先目录中是否含有符号链接 / NTFS 联接点。
 *
 * 这是「路径策略」之外的第二道防线：即使某个路径字符串通过了白名单校验，
 * 只要它的祖先目录是链接（例如 `%TEMP%\link → C:\Windows`），
 * 真实删除就会穿透到链接目标，造成越界删除。
 *
 * @param target 目标文件/目录
 * @param stopAt 停止上溯的边界（通常是命中的允许根目录，含自身）
 * @returns 命中的链接路径；未发现返回 undefined
 */
export async function findLinkAncestor(target: string, stopAt?: string): Promise<string | undefined> {
  const boundary = stopAt ? normalizePath(stopAt).toLowerCase() : undefined
  let current = normalizePath(target)
  // 从父目录开始检查（目标自身由 deletePath 以「只删链接」方式处理）
  current = current.slice(0, current.lastIndexOf('\\'))
  let guard = 0
  while (current && guard++ < 64) {
    const lower = current.toLowerCase()
    if (boundary && (lower === boundary || !lower.startsWith(boundary + '\\'))) break
    try {
      const stat = await fs.lstat(toLongPath(current))
      if (stat.isSymbolicLink()) return current
    } catch {
      // 不存在或不可访问：继续向上检查
    }
    const index = current.lastIndexOf('\\')
    if (index <= 2) break
    current = current.slice(0, index)
  }
  return undefined
}

/** 统计路径占用（文件直接返回大小；目录递归累加） */
export async function measurePath(target: string): Promise<number> {
  const long = toLongPath(target)
  let stat
  try {
    stat = await fs.lstat(long)
  } catch {
    return 0
  }
  if (!stat.isDirectory()) return stat.size
  let total = 0
  const stack = [target]
  while (stack.length) {
    const dir = stack.pop()!
    let entries
    try {
      entries = await fs.readdir(toLongPath(dir), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = dir.endsWith('\\') ? dir + entry.name : dir + '\\' + entry.name
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile()) {
        try {
          total += (await fs.lstat(toLongPath(full))).size
        } catch {
          /* 文件在统计过程中消失，忽略 */
        }
      }
    }
  }
  return total
}

/** 待删除路径的元信息 */
export interface PathMeta {
  exists: boolean
  isDirectory: boolean
  isLink: boolean
  size: number
}

const LINK_FLAG = 0x400 // FILE_ATTRIBUTE_REPARSE_POINT

/** 探测路径元信息（包含 NTFS 联接点识别） */
export async function inspectPath(target: string): Promise<PathMeta> {
  try {
    const stat = await fs.lstat(toLongPath(target))
    // Windows 下 junction 的 lstat 会标记为符号链接；这里双重判断
    const isLink = stat.isSymbolicLink() || ((stat as any).mode & LINK_FLAG) !== 0
    return { exists: true, isDirectory: stat.isDirectory() && !isLink, isLink, size: stat.size }
  } catch {
    return { exists: false, isDirectory: false, isLink: false, size: 0 }
  }
}

/**
 * 删除一个文件或目录（不跟随链接）。
 * 失败会抛出原始错误，由调用方归类为「被占用」「权限不足」等。
 */
export async function deletePath(target: string, options: { recursive?: boolean; retries?: number } = {}): Promise<DeleteResult> {
  const meta = await inspectPath(target)
  if (!meta.exists) return { bytes: 0, linkOnly: false }

  // 链接：只删除链接本身，绝不进入目标
  if (meta.isLink) {
    try {
      await fs.unlink(toLongPath(target))
      return { bytes: 0, linkOnly: true }
    } catch (error) {
      if (errorCode(error) === 'EISDIR' || errorCode(error) === 'EPERM') {
        await fs.rmdir(toLongPath(target))
        return { bytes: 0, linkOnly: true }
      }
      throw error
    }
  }

  if (!meta.isDirectory) {
    try {
      await fs.unlink(toLongPath(target))
      return { bytes: meta.size, linkOnly: false }
    } catch (error) {
      // 只读文件：去掉只读属性后重试一次
      if (errorCode(error) === 'EPERM' || errorCode(error) === 'EACCES') {
        try {
          await fs.chmod(toLongPath(target), 0o666)
          await fs.unlink(toLongPath(target))
          return { bytes: meta.size, linkOnly: false }
        } catch {
          throw error
        }
      }
      throw error
    }
  }

  // 目录：先统计字节数，供「释放空间」统计使用
  const bytes = await measurePath(target)
  const retries = options.retries ?? 2
  let attempt = 0
  while (true) {
    try {
      await fs.rm(toLongPath(target), { recursive: options.recursive ?? true, force: false, maxRetries: 2 })
      return { bytes, linkOnly: false }
    } catch (error) {
      attempt++
      // 只读属性导致的失败：递归去只读后重试
      if ((errorCode(error) === 'EPERM' || errorCode(error) === 'EACCES') && attempt <= retries) {
        await clearReadonly(target)
        continue
      }
      throw error
    }
  }
}

/** 递归清除只读属性（Windows 上删除顽固文件需要） */
async function clearReadonly(root: string): Promise<void> {
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()!
    let entries
    try {
      entries = await fs.readdir(toLongPath(dir), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = dir + '\\' + entry.name
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        stack.push(full)
      } else {
        try {
          await fs.chmod(toLongPath(full), 0o666)
        } catch {
          /* ignore */
        }
      }
    }
  }
}

/** 移动文件（跨卷时退化为「复制 + 删除」） */
export async function moveFile(source: string, target: string): Promise<void> {
  try {
    await fs.rename(toLongPath(source), toLongPath(target))
  } catch (error) {
    if (errorCode(error) !== 'EXDEV') throw error
    await fs.copyFile(toLongPath(source), toLongPath(target))
    await fs.unlink(toLongPath(source))
  }
}

/** 从错误中提取用户可读描述 */
export function describeDeleteError(error: unknown): string {
  const code = errorCode(error)
  switch (code) {
    case 'EBUSY':
    case 'EPERM':
      return '文件正被其它程序占用或权限不足'
    case 'EACCES':
      return '没有访问权限'
    case 'ENOENT':
      return '路径已不存在'
    case 'ENOTEMPTY':
      return '目录非空（可能有新文件写入）'
    case 'ENAMETOOLONG':
      return '路径过长'
    default:
      return errorMessage(error)
  }
}

export { isAbortError, errorMessage, errorCode, normalizePath }
