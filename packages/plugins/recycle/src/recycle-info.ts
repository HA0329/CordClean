/**
 * `$I` 元数据解析（纯函数，不依赖文件系统）。
 *
 * 从 `index.ts` 拆出来的原因：二进制结构解析错一位就会把错误的原始路径展示给
 * 用户（甚至影响清理判断），因此单独成文件、用构造的缓冲区做纯函数单测，
 * 无需接触真实回收站（见 `tests/plugin-rules.test.ts` / `tests/recycle-orphans.test.ts`）。
 *
 * 规范布局（v1 与绝大多数 v2 文件都适用）：
 * ```
 * 偏移 0   8   头部版本号（uint64 LE）
 * 偏移 8   8   文件大小（uint64 LE）
 * 偏移 16  8   删除时间（FILETIME，uint64 LE，100ns）
 * 偏移 24  4   名字长度（uint32 LE，UTF-16 码元数，含结尾 \0）
 * 偏移 28  ..  原始路径（UTF-16LE，以 \0\0 结尾）
 * ```
 * 另外兼容 Windows 10 上「目录型」`$I` 的变体：名字长度字段后移 8 字节
 * （偏移 24 变成 8 字节目录大小，名字长度在 32，名字从 36 开始）。
 */
import { isAbsolutePath } from '@cordclean/utils'

/** 1601-01-01 到 1970-01-01 之间的毫秒数（FILETIME 与 Unix 时间的纪元差） */
const FILETIME_EPOCH_DIFF_MS = 11_644_473_600_000

/** 从 `$I` 中解析出的元数据 */
export interface RecycleInfo {
  /** `$I` 头部版本号：1 = Vista~8.1，2 = Windows 10/11 */
  version: number
  /** 被删除项的原始字节数；0 表示 `$I` 没有记录，需要回退到文件实际大小 */
  size: number
  /** 删除时间（Unix 毫秒）；0 表示无法解析 */
  deletedAt: number
  /** 原始绝对路径；空串表示名字字段损坏，调用方应回退到 `$R` 路径 */
  original: string
}

/** FILETIME（自 1601 起的 100ns 计数）→ Unix 毫秒 */
export function filetimeToUnix(filetime: bigint): number {
  if (filetime <= 0n) return 0
  return Number(filetime / 10_000n) - FILETIME_EPOCH_DIFF_MS
}

/** 从指定偏移解码 UTF-16LE 名字（`$I` 的名字以 `\0\0` 结尾） */
function decodeOriginal(buffer: Buffer, offset: number, declaredLength: number): string {
  if (offset >= buffer.length) return ''
  const available = Math.floor((buffer.length - offset) / 2)
  if (available <= 0) return ''
  // 声明的长度可能超过真实剩余字节（`$I` 被截断），因此以两者较小值为准
  const chars = declaredLength > 0 && declaredLength <= available ? declaredLength : available
  const raw = buffer.toString('utf16le', offset, offset + chars * 2)
  const end = raw.indexOf('\u0000')
  return (end >= 0 ? raw.slice(0, end) : raw).trimEnd()
}

/** 判断解析出的名字是否像一条合法的 Windows 绝对路径（用于丢弃垃圾数据） */
function isPlausibleOriginal(value: string): boolean {
  if (!value) return false
  // 控制字符通常意味着名字长度字段误读，解出来的是二进制垃圾
  return isAbsolutePath(value) && !/[\u0000-\u001f]/.test(value)
}

/**
 * 解析一个 `$I` 文件。
 *
 * 解析失败时返回 `null`；元数据部分损坏时仍尽量返回大小与删除时间，
 * 并把 `original` 置空，让调用方回退到 `$R` 路径。
 */
export function parseRecycleInfo(buffer: Buffer): RecycleInfo | null {
  if (!buffer || buffer.length < 28) return null
  const version = Number(buffer.readBigUInt64LE(0))
  if (!Number.isSafeInteger(version) || version < 0) return null
  const rawSize = Number(buffer.readBigUInt64LE(8))
  const size = Number.isFinite(rawSize) && rawSize > 0 ? rawSize : 0
  const deletedAt = filetimeToUnix(buffer.readBigUInt64LE(16))

  // ① 规范布局
  const primary = decodeOriginal(buffer, 28, buffer.readUInt32LE(24))
  if (isPlausibleOriginal(primary)) return { version, size, deletedAt, original: primary }

  // ② Windows 10 目录型变体
  if (buffer.length >= 36) {
    const shifted = decodeOriginal(buffer, 36, buffer.readUInt32LE(32))
    if (isPlausibleOriginal(shifted)) {
      const directorySize = Number(buffer.readBigUInt64LE(24))
      const realSize = size || (Number.isFinite(directorySize) && directorySize > 0 ? directorySize : 0)
      return { version, size: realSize, deletedAt, original: shifted }
    }
  }

  // ③ 名字字段损坏：保留能解析出来的部分
  return { version, size, deletedAt, original: '' }
}
