/**
 * 高性能目录遍历器。
 *
 * 相比 `fs.readdir({recursive:true})`，本实现：
 * - 跳过符号链接与 NTFS 联接点（junction），避免「跟随链接越界删除」这一经典事故；
 * - 支持取消（AbortSignal）、深度限制、条目上限、目录过滤；
 * - 按目录批量并发 `lstat`，在机械盘/SSD 上均能获得较好吞吐。
 */
import type { Dirent } from 'node:fs'
import { promises as fs } from 'node:fs'
import { normalizePath, toLongPath } from './paths.ts'
import { errorMessage, mapLimit } from './utils.ts'

/** 遍历得到的条目 */
export interface WalkEntry {
  path: string
  name: string
  isDirectory: boolean
  size: number
  mtimeMs: number
  depth: number
}

/** 遍历选项 */
export interface WalkOptions {
  signal?: AbortSignal
  /** 最大递归深度，默认 32 */
  maxDepth?: number
  /** 最多返回的条目数，超出后截断（防止全盘扫描卡死） */
  maxEntries?: number
  /** 是否进入链接目录，默认 false */
  followLinks?: boolean
  /** 目录过滤器，返回 false 则不进入该目录 */
  shouldEnter?(dir: string, depth: number): boolean
  /** 非致命错误回调 */
  onError?(path: string, error: unknown): void
  /** 每个目录内 stat 并发度，默认 24 */
  concurrency?: number
}

/** 判断某个 Dirent 是否应被视为链接（符号链接/联接点） */
function isLink(entry: Dirent): boolean {
  return entry.isSymbolicLink()
}

/**
 * 深度优先遍历目录，逐个产出文件与目录条目。
 * 目录条目 size 先记 0，由调用方决定是否递归累加。
 */
export async function* walk(root: string, options: WalkOptions = {}): AsyncGenerator<WalkEntry> {
  const maxDepth = options.maxDepth ?? 32
  const maxEntries = options.maxEntries ?? Number.POSITIVE_INFINITY
  const concurrency = options.concurrency ?? 24
  const start = normalizePath(root)
  const stack: Array<{ dir: string; depth: number }> = [{ dir: start, depth: 0 }]
  let produced = 0

  while (stack.length) {
    if (options.signal?.aborted) return
    const { dir, depth } = stack.pop()!
    let entries: Dirent[]
    try {
      entries = await fs.readdir(toLongPath(dir), { withFileTypes: true })
    } catch (error) {
      options.onError?.(dir, error)
      continue
    }

    const files: Dirent[] = []
    const subdirs: string[] = []
    for (const entry of entries) {
      if (isLink(entry) && !options.followLinks) continue
      const full = dir + '\\' + entry.name
      if (entry.isDirectory()) {
        if (depth + 1 > maxDepth) continue
        if (options.shouldEnter && !options.shouldEnter(full, depth + 1)) continue
        subdirs.push(full)
      } else if (entry.isFile()) {
        files.push(entry)
      }
    }

    const stats = await mapLimit(files, concurrency, async (entry) => {
      try {
        return await fs.lstat(toLongPath(dir + '\\' + entry.name))
      } catch {
        return null
      }
    })

    for (let i = 0; i < files.length; i++) {
      if (produced++ >= maxEntries) return
      const stat = stats[i]
      yield {
        path: dir + '\\' + files[i].name,
        name: files[i].name,
        isDirectory: false,
        size: stat?.size ?? 0,
        mtimeMs: stat?.mtimeMs ?? 0,
        depth: depth + 1,
      }
    }

    for (let i = 0; i < subdirs.length; i++) {
      if (produced++ >= maxEntries) return
      yield {
        path: subdirs[i],
        name: subdirs[i].slice(subdirs[i].lastIndexOf('\\') + 1),
        isDirectory: true,
        size: 0,
        mtimeMs: 0,
        depth: depth + 1,
      }
    }

    // 逆序入栈，保证遍历顺序稳定（字典序）
    for (let i = subdirs.length - 1; i >= 0; i--) {
      stack.push({ dir: subdirs[i], depth: depth + 1 })
    }
  }
}

/** 目录占用统计结果 */
export interface FolderSize {
  bytes: number
  files: number
  dirs: number
  errors: number
  truncated: boolean
}

/** 统计一个目录的占用大小（不跟随链接） */
export async function folderSize(root: string, options: WalkOptions = {}): Promise<FolderSize> {
  const result: FolderSize = { bytes: 0, files: 0, dirs: 0, errors: 0, truncated: false }
  const maxEntries = options.maxEntries
  let seen = 0
  try {
    for await (const entry of walk(root, {
      ...options,
      onError: (path, error) => {
        result.errors++
        options.onError?.(path, error)
      },
    })) {
      if (entry.isDirectory) {
        result.dirs++
        continue
      }
      result.files++
      result.bytes += entry.size
      if (maxEntries && ++seen >= maxEntries) {
        result.truncated = true
        break
      }
    }
  } catch (error) {
    result.errors++
    options.onError?.(root, error)
  }
  return result
}

/** 判断路径是否存在（不抛异常） */
export async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(toLongPath(path))
    return true
  } catch {
    return false
  }
}

/** 安全获取 stat */
export async function safeStat(path: string) {
  try {
    return await fs.stat(toLongPath(path))
  } catch {
    return null
  }
}

/** 安全获取 lstat（不跟随链接） */
export async function safeLstat(path: string) {
  try {
    return await fs.lstat(toLongPath(path))
  } catch {
    return null
  }
}

/** 删除空目录，返回是否删除成功 */
export async function removeEmptyDir(path: string): Promise<boolean> {
  try {
    await fs.rmdir(toLongPath(path))
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // 目录非空是正常情况，静默忽略
    if (code === 'ENOTEMPTY' || code === 'EEXIST') return false
    return false
  }
}

export { errorMessage }
