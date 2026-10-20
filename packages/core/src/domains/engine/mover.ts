/**
 * 大文件「搬家」：把文件移动到目标盘/目标目录（不删除数据）。
 *
 * 安全约束：
 * - 只移动**文件**，不移动目录（目录搬家涉及递归与占用，后续单独做）；
 * - 每个源路径都必须通过路径策略检查（与删除同一套辖区规则）；
 * - 目标必须是绝对路径；目标与源相同则跳过；
 * - 冲突时自动加后缀，绝不覆盖；
 * - 复制后校验字节数，成功才删除源；失败清理半成品目标文件。
 *
 * 注意：这是「移动」，不是删除。它不签发 CleanTicket，也不走执行器；
 * 因此不会计入清理历史，空间变化靠前后磁盘可用量观察。
 */
import { copyFile, mkdir, rename, stat, symlink, unlink } from 'node:fs/promises'
import path from 'node:path'

export interface MoveFileRequest {
  /** 要移动的文件绝对路径 */
  paths: string[]
  /** 目标目录（绝对路径） */
  targetDir: string
}

export interface MoveFileOutcome {
  moved: Array<{ from: string; to: string; bytes: number }>
  failed: Array<{ path: string; error: string }>
  freedBytes: number
}

export interface MoveFileOptions {
  /** 路径策略检查（与清理使用同一套辖区/保护目录规则） */
  check: (target: string) => { allowed: boolean; reason?: string }
  /** 目标目录是否受保护（系统/用户重要目录）；受保护目录禁止作为搬家目标 */
  isProtected?: (target: string) => boolean
  /** 最大并发（默认 4） */
  concurrency?: number
  /** 移动后是否在原位置创建符号链接（失败会自动还原） */
  link?: boolean
}

function absolute(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

/** 校验目标目录：绝对路径、非 UNC/设备路径、非盘符根、未受保护 */
function validateTargetDir(raw: string, isProtected?: (target: string) => boolean): string {
  if (!absolute(raw)) throw new Error('目标目录必须是绝对路径')
  const target = path.resolve(raw)
  if (target.startsWith('\\\\')) throw new Error('目标目录不支持网络共享路径（UNC）')
  if (target.startsWith('\\\\.\\') || target.startsWith('\\\\?\\')) throw new Error('目标目录不支持设备路径')
  if (/^[a-zA-Z]:\\?$/.test(target)) throw new Error('目标目录不能是盘符根目录')
  if (isProtected?.(target)) throw new Error('目标目录位于受保护目录，不能作为搬家目标')
  return target
}

function isSubPathOf(child: string, parent: string): boolean {
  const c = child.toLowerCase().replace(/[\\/]+$/, '')
  const p = parent.toLowerCase().replace(/[\\/]+$/, '')
  return c === p || c.startsWith(p + '\\')
}

async function uniqueTarget(dir: string, name: string): Promise<string> {
  const ext = path.extname(name)
  const base = name.slice(0, name.length - ext.length)
  let candidate = path.join(dir, name)
  for (let index = 1; index < 1000; index++) {
    try {
      await stat(candidate)
      candidate = path.join(dir, `${base} (${index})${ext}`)
    } catch {
      return candidate
    }
  }
  throw new Error('目标目录中存在过多同名文件')
}

/** 移动一批文件；逐个处理，失败不影响其他文件 */
export async function moveFiles(request: MoveFileRequest, options: MoveFileOptions): Promise<MoveFileOutcome> {
  const outcome: MoveFileOutcome = { moved: [], failed: [], freedBytes: 0 }
  const targetDir = validateTargetDir(request.targetDir, options.isProtected)
  await mkdir(targetDir, { recursive: true })

  const queue = [...new Set(request.paths.map((item) => path.resolve(item)))]
  queue.sort((a, b) => a.length - b.length) // 先移动浅层路径，避免先动子项导致父项失败
  const limit = Math.max(1, Math.min(8, options.concurrency ?? 4))

  const runOne = async (source: string) => {
    try {
      const policy = options.check(source)
      if (!policy.allowed) throw new Error(policy.reason ? `路径被策略保护：${policy.reason}` : '路径被策略保护')
      if (!absolute(source)) throw new Error('源路径必须是绝对路径')
      const info = await stat(source)
      if (!info.isFile() && !info.isDirectory()) throw new Error('只支持移动文件或目录')
      if (path.dirname(source).toLowerCase() === targetDir.toLowerCase()) {
        throw new Error('目标目录与源目录相同')
      }
      // 目录：仅支持同盘重命名（原子、快、可回滚）；跨盘目录搬家先拒绝，避免半复制
      if (info.isDirectory()) {
        if (isSubPathOf(targetDir, source)) throw new Error('目标目录不能位于源目录内部')
        const sameVolume = path.parse(source).root.toLowerCase() === path.parse(targetDir).root.toLowerCase()
        if (!sameVolume) throw new Error('目录跨盘搬家暂不支持（请先手动复制到目标盘）')
        const dirTarget = await uniqueTarget(targetDir, path.basename(source))
        await rename(source, dirTarget)
        if (options.link) {
          try {
            await symlink(dirTarget, source, 'junction')
          } catch (error) {
            await rename(dirTarget, source)
            throw new Error('目录联接创建失败，已还原目录：' + (error instanceof Error ? error.message : String(error)))
          }
        }
        outcome.moved.push({ from: source, to: dirTarget, bytes: info.size })
        return
      }

      const target = await uniqueTarget(targetDir, path.basename(source))
      try {
        await copyFile(source, target)
        const copied = await stat(target)
        if (copied.size !== info.size) throw new Error('复制后大小不一致')
        await unlink(source)
        if (options.link) {
          try {
            await symlink(target, source, 'file')
          } catch (error) {
            // 链接创建失败（常见于未开启开发者模式）：还原源文件并删除目标，整体判失败
            await copyFile(target, source)
            await unlink(target).catch(() => undefined)
            throw new Error('符号链接创建失败，已还原原文件：' + (error instanceof Error ? error.message : String(error)))
          }
        }
      } catch (error) {
        await unlink(target).catch(() => undefined)
        throw error
      }
      outcome.moved.push({ from: source, to: target, bytes: info.size })
      // 同盘移动不释放空间；只有跨盘时才计入 freedBytes
      if (path.parse(source).root.toLowerCase() !== path.parse(targetDir).root.toLowerCase()) {
        outcome.freedBytes += info.size
      }
    } catch (error) {
      outcome.failed.push({ path: source, error: error instanceof Error ? error.message : String(error) })
    }
  }

  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (cursor < queue.length) {
        const index = cursor++
        await runOne(queue[index])
      }
    }),
  )
  return outcome
}
