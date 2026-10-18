/**
 * 重复文件查找插件（三级筛选策略，只报告，不主动删除）。
 *
 * 三级策略的目的：**用最少的磁盘 I/O 排除掉绝大多数不可能重复的文件**，
 * 因为读取文件内容（尤其是大文件）才是这类功能的主要瓶颈：
 *
 * 1. **按体积分组**：内容完全相同 ⇒ 体积必然相同，先按 `stat.size` 分桶，
 *    同尺寸组内只有 1 个文件的直接排除，不需要读盘；
 * 2. **前 4096 字节 SHA-256**：同尺寸是「必要不充分」条件，用文件头部指纹
 *    再做一次分桶，可以把「大小相同但内容不同」的文件（视频、安装包、数据库）排除掉；
 * 3. **完整 SHA-256 确认**：只对「同尺寸 + 同头部指纹」的极小集合做全量哈希，
 *    得到严格意义的内容相同判定，最后每组保留修改时间最早的一个作为「保留项」。
 *
 * 其它工程约束：
 * - 哈希是 I/O 密集型操作，用 `mapLimit` 把并发收敛到 4~8，避免打满磁盘队列；
 * - 每个哈希前检查 `scan.signal`，用户取消后立即停止；
 * - 单个文件读失败（被占用 / 权限不足）只记录错误并跳过，不影响整次扫描；
 * - 候选文件数量受 `scan.duplicateMaxCandidates` 限制，超出的只计数不哈希，
 *   防止在几万个同尺寸文件上跑出不可接受的时间。
 */
import Schema from 'schemastery'
import type { TaskScanContext } from '@cordclean/shared'
import { basename, defineCleanerPlugin, formatBytes } from '@cordclean/shared'
import { errorMessage, exists, hashFile, mapLimit, normalizePath, pathKey, walk } from '@cordclean/utils'

export interface DuplicatesConfig {
  /** 最小文件体积（MB），0 表示跟随全局设置 scan.duplicateMinSize */
  minSizeMb: number
  /** 参与哈希的候选上限，0 表示跟随全局设置 scan.duplicateMaxCandidates */
  maxCandidates: number
}

const Config = Schema.object({
  minSizeMb: Schema.number()
    .default(0)
    .description('只分析不小于该体积（MB）的文件。0 表示跟随全局设置「重复文件最小体积」'),
  maxCandidates: Schema.number()
    .default(0)
    .description('最多对多少个候选文件计算哈希。0 表示跟随全局设置；超出的文件只在统计中计数，不参与哈希'),
})

/** 第二级筛选读取的头部字节数 */
const SAMPLE_BYTES = 4096
/** 哈希并发度（磁盘 I/O 密集，取 4~8 之间） */
const HASH_CONCURRENCY = 6
/** 遍历进度日志的间隔文件数 */
const PROGRESS_EVERY = 5000
/** 每上报多少项检查一次取消信号 */
const EMIT_CHUNK = 200
/** 缺省最小体积 / 候选上限（全局设置异常时的兜底） */
const FALLBACK_MIN_SIZE = 1024 ** 2

/** 候选文件 */
interface Candidate {
  path: string
  /** 去重键：规范化 + 小写后的路径，避免多个扫描根重叠时把同一文件当成自己的副本 */
  key: string
  size: number
  mtimeMs: number
}

/** 一次扫描的统计量（用于日志与论文性能分析） */
interface ScanStats {
  /** 遍历到的文件数（仅用于日志，不计入 scan.count） */
  scanned: number
  /** 实际参与哈希的候选文件数 */
  candidates: number
  /** 因超出上限而未参与哈希的候选文件数 */
  dropped: number
  /** 第二级完成头部哈希的文件数 */
  shortHashed: number
  /** 第三级完成全量哈希的文件数 */
  fullHashed: number
  /** 哈希失败（被占用 / 权限不足）的文件数 */
  hashErrors: number
  /** 最终确认的重复组数量 */
  groups: number
}

/** 具有相同「体积 + 内容哈希」的一组文件 */
interface HashGroup {
  /** 该组文件的内容哈希（第三级为完整 SHA-256） */
  hash: string
  size: number
  files: Candidate[]
}

/** 把任意输入裁剪为安全区间的整数 */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = Math.round(Number(value))
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}

/**
 * 判断路径中包含某个「目录片段」（按目录层级匹配，而不是裸子串）。
 * 全局设置里的 excludes 形如 `\node_modules\`，这里统一成层级比较更稳妥。
 */
function containsSegments(haystack: string, fragment: unknown): boolean {
  if (typeof fragment !== 'string') return false
  const segments = fragment.toLowerCase().replace(/\//g, '\\').split('\\').filter(Boolean)
  if (!segments.length) return false
  return haystack.includes('\\' + segments.join('\\') + '\\')
}

/**
 * 第一级：遍历扫描根，按体积分组。
 *
 * 返回「体积 → 候选列表」的映射；只有一个文件的尺寸组也会返回，
 * 由调用方统一过滤（这样遍历阶段不需要额外结构）。
 */
async function collectBySize(
  scan: TaskScanContext,
  roots: string[],
  options: {
    minSize: number
    maxEntries: number
    maxDepth: number
    shouldEnter(dir: string): boolean
  },
  stats: ScanStats,
): Promise<Map<number, Candidate[]>> {
  const bySize = new Map<number, Candidate[]>()
  const seen = new Set<string>()
  let remaining = options.maxEntries

  for (const root of roots) {
    scan.throwIfAborted()
    if (remaining <= 0) break
    if (!options.shouldEnter(root) || !(await exists(root))) {
      scan.logger.warn(`扫描根不可用或已被排除，跳过：${root}`)
      continue
    }
    for await (const entry of walk(root, {
      signal: scan.signal,
      maxDepth: options.maxDepth,
      maxEntries: remaining,
      shouldEnter: options.shouldEnter,
      onError: (target, error) => scan.addError({ path: target, message: errorMessage(error) }),
    })) {
      remaining--
      if (entry.isDirectory) {
        scan.count('directory')
        continue
      }
      stats.scanned++
      if (stats.scanned % PROGRESS_EVERY === 0) {
        scan.logger.info(`已遍历 ${stats.scanned} 个文件，同尺寸候选 ${bySize.size} 组`)
      }
      if (entry.size < options.minSize) continue
      const key = pathKey(entry.path)
      if (seen.has(key)) continue
      seen.add(key)
      const candidate: Candidate = { path: entry.path, key, size: entry.size, mtimeMs: entry.mtimeMs }
      const list = bySize.get(entry.size)
      if (list) list.push(candidate)
      else bySize.set(entry.size, [candidate])
    }
  }

  if (remaining <= 0) {
    scan.addError({
      path: roots.join(', '),
      message: `遍历条目数达到上限（${options.maxEntries}），重复文件结果可能不完整`,
    })
  }
  return bySize
}

/**
 * 第二/三级：对给定文件集合计算哈希，并按「体积 + 哈希」重新分组。
 * 单个文件哈希失败只记录错误并跳过，返回的 `hashed` 是真正成功的数量。
 */
async function hashAndGroup(
  scan: TaskScanContext,
  files: Candidate[],
  sampleBytes: number | undefined,
  stats: ScanStats,
): Promise<{ groups: HashGroup[]; hashed: number }> {
  const hashes = await mapLimit(files, HASH_CONCURRENCY, async (file) => {
    scan.throwIfAborted()
    try {
      return await hashFile(file.path, sampleBytes)
    } catch (error) {
      stats.hashErrors++
      scan.addError({ path: file.path, message: errorMessage(error) })
      return undefined
    }
  })

  const buckets = new Map<string, HashGroup>()
  let hashed = 0
  for (let i = 0; i < files.length; i++) {
    const hash = hashes[i]
    if (!hash) continue
    hashed++
    const file = files[i]
    const bucketKey = `${file.size}:${hash}`
    const group = buckets.get(bucketKey)
    if (group) group.files.push(file)
    else buckets.set(bucketKey, { hash, size: file.size, files: [file] })
  }
  // 只有 ≥2 个文件的组才可能产生「重复项」
  return { groups: [...buckets.values()].filter((group) => group.files.length >= 2), hashed }
}

export default defineCleanerPlugin<DuplicatesConfig>({
  name: 'duplicates',
  version: '1.0.0',
  description: '按「体积 → 头部哈希 → 全量 SHA-256」三级策略找出重复文件（只报告）',
  tasks: ['duplicates'],
  inject: ['cleaner', 'pathPolicy', 'system', 'settings'],
  Config,
  setup(ctx, config) {
    const env = ctx.system.env

    /** 当前生效的扫描根：优先全局设置里的自定义范围，为空时退回用户主目录 */
    const resolveRoots = (): string[] => {
      const configured = ctx.settings
        .get()
        .analysis.roots.filter((root) => typeof root === 'string' && root.trim().length > 0)
        .map((root) => normalizePath(root))
      return configured.length ? configured : [normalizePath(env.userProfile)]
    }

    /** 最小体积（字节）：插件配置优先，0 表示跟随全局设置 */
    const resolveMinSize = (): number => {
      const overrideMb = Number(config.minSizeMb)
      if (Number.isFinite(overrideMb) && overrideMb > 0) return Math.round(overrideMb * 1024 * 1024)
      const preset = Number(ctx.settings.get().scan.duplicateMinSize)
      return Number.isFinite(preset) && preset > 0 ? Math.round(preset) : FALLBACK_MIN_SIZE
    }

    /** 候选哈希上限：插件配置优先，0 表示跟随全局设置（设置非法时视为不限制） */
    const resolveCandidateBudget = (): number => {
      const override = Number(config.maxCandidates)
      if (Number.isFinite(override) && override > 0) return Math.max(1, Math.round(override))
      const preset = Number(ctx.settings.get().scan.duplicateMaxCandidates)
      return Number.isFinite(preset) && preset > 0 ? Math.round(preset) : Number.POSITIVE_INFINITY
    }

    // ① 声明清理辖区（安全阀）：扫描根下的路径才允许被本插件清理；设置变更后重新声明
    ctx.effect(() => {
      let disposers: Array<() => void> = []
      const declare = () => {
        for (const dispose of disposers) dispose()
        disposers = []
        for (const root of resolveRoots()) {
          disposers.push(ctx.pathPolicy.addRoot(root, 'duplicates'))
          disposers.push(ctx.pathPolicy.addUserRoot(root))
        }
      }
      declare()
      const off = ctx.settings.onChange(() => declare())
      return () => {
        off()
        for (const dispose of disposers) dispose()
        disposers = []
      }
    })

    // ② 注册清理任务
    ctx.effect(() =>
      ctx.cleaner.define({
        id: 'duplicates',
        name: '重复文件',
        description: '用三级哈希策略找出内容完全相同的文件，每组保留修改时间最早的一个',
        category: 'disk',
        risk: 'caution',
        icon: '🧬',
        defaultSelected: false,
        targets: resolveRoots(),
        tips: [
          '每组只上报副本，保留项（修改时间最早）不会被上报，也不会被删除',
          '默认只分析不小于 1 MB 的文件，可在插件配置里调整',
          '默认跳过 node_modules、.git、回收站与系统卷信息目录',
          '删除会经过内核隔离区，可在隔离区中恢复',
        ],
        estimatedMs: 15000,
        async scan(scan) {
          const settings = ctx.settings.get()
          const roots = resolveRoots()
          const minSize = resolveMinSize()
          const budget = resolveCandidateBudget()
          const maxEntries = clampInt(settings.scan.maxEntriesPerTask, 1000, 5_000_000, 400_000)
          const maxDepth = clampInt(settings.scan.maxDepth, 1, 128, 32)
          const excludes = Array.isArray(settings.analysis.excludes) ? settings.analysis.excludes : []

          // 依赖/版本库/回收站等目录永远是噪声，不参与重复文件比较
          const skipNames = new Set(['node_modules', '.git', '$recycle.bin', 'system volume information'])
          const shouldEnter = (dir: string): boolean => {
            if (skipNames.has(basename(dir).toLowerCase())) return false
            if (excludes.length) {
              const haystack = '\\' + pathKey(dir) + '\\'
              for (const fragment of excludes) {
                if (containsSegments(haystack, fragment)) return false
              }
            }
            return true
          }

          const stats: ScanStats = {
            scanned: 0,
            candidates: 0,
            dropped: 0,
            shortHashed: 0,
            fullHashed: 0,
            hashErrors: 0,
            groups: 0,
          }
          const startedAt = Date.now()

          // 第 1 级：按体积分组
          const bySize = await collectBySize(scan, roots, { minSize, maxEntries, maxDepth, shouldEnter }, stats)
          const candidates = [...bySize.values()].filter((group) => group.length >= 2).flat()
          // 体积大的文件重复时节省的空间更多，优先占用哈希预算
          candidates.sort((a, b) => b.size - a.size || a.path.localeCompare(b.path))
          const selected = Number.isFinite(budget) ? candidates.slice(0, budget) : candidates
          stats.candidates = selected.length
          stats.dropped = candidates.length - selected.length
          if (stats.dropped > 0) {
            // 超出上限的候选只计数、不做哈希（对应设置项「重复文件最多参与哈希的候选数量」）
            for (let i = selected.length; i < candidates.length; i++) scan.count('file')
            scan.logger.warn(
              `候选文件超过上限（${budget}），${stats.dropped} 个文件未参与哈希（仅计数）`,
            )
            scan.addError({
              path: roots.join(', '),
              message: `重复文件候选超过上限（${budget}），${stats.dropped} 个文件未参与哈希`,
            })
          }
          // 预算截断可能把某个尺寸组切成只剩一个文件，这里重新过滤一次
          const sizeBuckets = new Map<number, Candidate[]>()
          for (const file of selected) {
            const list = sizeBuckets.get(file.size)
            if (list) list.push(file)
            else sizeBuckets.set(file.size, [file])
          }
          const phase2Input = [...sizeBuckets.values()].filter((group) => group.length >= 2).flat()
          const enumeratedAt = Date.now()
          scan.logger.info(
            `重复文件枚举完成：遍历 ${stats.scanned} 个文件，${formatBytes(minSize)} 以上的同尺寸候选 ` +
              `${candidates.length} 个，参与哈希 ${phase2Input.length} 个，用时 ${enumeratedAt - startedAt} ms`,
          )

          // 第 2 级：前 4096 字节 SHA-256
          scan.throwIfAborted()
          const phase2 = await hashAndGroup(scan, phase2Input, SAMPLE_BYTES, stats)
          stats.shortHashed = phase2.hashed
          const hashedAt = Date.now()
          scan.logger.info(
            `短哈希筛选完成：${stats.shortHashed} 个文件（前 ${SAMPLE_BYTES} 字节），` +
              `剩余 ${phase2.groups.length} 组同尺寸同前缀文件，用时 ${hashedAt - enumeratedAt} ms`,
          )

          // 第 3 级：完整 SHA-256 确认
          const phase3Input = phase2.groups.flatMap((group) => group.files)
          let finalGroups: HashGroup[] = []
          if (phase3Input.length) {
            scan.throwIfAborted()
            const phase3 = await hashAndGroup(scan, phase3Input, undefined, stats)
            stats.fullHashed = phase3.hashed
            finalGroups = phase3.groups
          }
          stats.groups = finalGroups.length
          const confirmedAt = Date.now()
          scan.logger.info(
            `全量哈希确认完成：${stats.fullHashed} 个文件，确认 ${finalGroups.length} 组重复，` +
              `用时 ${confirmedAt - hashedAt} ms`,
          )

          // 上报：每组保留修改时间最早的一个，其余作为重复项
          let reported = 0
          let bytes = 0
          for (const group of finalGroups) {
            const ordered = [...group.files].sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path))
            const original = ordered[0]
            const groupId = `${group.size}-${group.hash.slice(0, 8)}`
            for (let i = 1; i < ordered.length; i++) {
              if (reported % EMIT_CHUNK === 0) scan.throwIfAborted()
              const file = ordered[i]
              reported++
              bytes += file.size
              scan.emit({
                path: file.path,
                title: basename(file.path),
                kind: 'file',
                size: file.size,
                risk: 'caution',
                defaultSelected: false,
                note: `与 ${original.path} 重复`,
                meta: {
                  group: groupId,
                  original: original.path,
                  hashAlgorithm: 'sha256',
                  sizeGroup: group.size,
                },
              })
            }
          }

          const elapsed = Date.now() - startedAt
          scan.logger.info(
            `重复文件扫描统计：根 ${roots.length} 个，遍历 ${stats.scanned} 个文件，候选 ${stats.candidates} 个，` +
              `短哈希 ${stats.shortHashed} 个，全量哈希 ${stats.fullHashed} 个，重复组 ${stats.groups} 个，` +
              `上报 ${reported} 个（${formatBytes(bytes)}），用时 ${elapsed} ms`,
          )
        },
      }),
    )
  },
})
