/**
 * 大文件扫描插件（只报告，不主动删除）。
 *
 * 定位：磁盘空间分析工具，而不是「一键清理」。插件只负责把扫描范围内
 * 体积最大的 N 个文件找出来交给界面，由用户逐个确认后再由内核通用引擎
 * （隔离区 + 路径策略校验）执行删除，因此本插件不实现 `clean`。
 *
 * 关键设计：
 * 1. **Top-N 用定容最小堆维护**：内存只占 O(limit)，时间复杂度 O(n log limit)，
 *    避免把全盘几十万个文件路径都留在内存里再排序；
 * 2. **遍历复用 `utils/walk`**：默认不跟随符号链接 / NTFS 联接点，
 *    并用 `shouldEnter` 剪掉 node_modules、.git、回收站、系统卷信息、用户临时目录；
 * 3. **参数实时读设置**：扫描根、阈值、遍历条目上限都在扫描开始时从 `ctx.settings` 读取，
 *    用户在界面上改完设置不需要重启插件；
 * 4. **扫描根即清理辖区**：对每个扫描根调用 `pathPolicy.addRoot` + `addUserRoot`，
 *    声明「我只在用户指定的范围内工作」，超出范围的路径内核会拒绝删除。
 */
import Schema from 'schemastery'
import { basename, defineCleanerPlugin, formatBytes, formatTime } from '@cordclean/shared'
import { errorMessage, exists, isSubPath, normalizePath, parentPath, pathKey, walk } from '@cordclean/utils'

export interface LargeFilesConfig {
  /** 阈值（MB），0 表示跟随全局设置 scan.largeFileThreshold */
  thresholdMb: number
  /** 最多上报的文件数量 */
  limit: number
  /** 是否跳过系统/依赖噪声目录 */
  excludeSystem: boolean
}

const Config = Schema.object({
  thresholdMb: Schema.number()
    .default(0)
    .description('大文件阈值（MB）。0 表示跟随全局设置「大文件阈值」，大于 0 时覆盖全局设置'),
  limit: Schema.number()
    .default(80)
    .description('最多上报的文件数量，按体积从大到小取前 N 个'),
  excludeSystem: Schema.boolean()
    .default(true)
    .description('跳过 node_modules、.git、回收站、系统卷信息与 AppData\\Local\\Temp 等目录（全局设置里的排除片段始终生效）'),
})

/** 遍历进度日志的间隔条目数 */
const PROGRESS_EVERY = 5000
/** 缺省大文件阈值（全局设置异常时的兜底） */
const FALLBACK_THRESHOLD = 100 * 1024 ** 2

/** 候选文件（只保留必要字段，避免把整个 WalkEntry 留在堆里） */
interface Candidate {
  path: string
  size: number
  mtimeMs: number
}

/**
 * 定容最小堆：用来在流式遍历中维护「体积最大的 capacity 个文件」。
 *
 * 堆顶是当前候选集合里最小的那个，新文件只有比堆顶更大才值得替换进来，
 * 因此单次插入是 O(log capacity)，整体 O(n log capacity)。
 */
class TopFiles {
  private readonly heap: Candidate[] = []

  constructor(
    private readonly capacity: number,
    private readonly compare: (a: Candidate, b: Candidate) => number,
  ) {}

  get size(): number {
    return this.heap.length
  }

  push(value: Candidate): void {
    if (this.capacity <= 0) return
    if (this.heap.length < this.capacity) {
      this.heap.push(value)
      this.siftUp(this.heap.length - 1)
      return
    }
    // 未达到候选门槛，直接丢弃
    if (this.compare(value, this.heap[0]) <= 0) return
    this.heap[0] = value
    this.siftDown(0)
  }

  /** 取出全部候选并按体积从大到小排序 */
  drain(): Candidate[] {
    return this.heap.sort((a, b) => this.compare(b, a))
  }

  private siftUp(index: number): void {
    const heap = this.heap
    let i = index
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.compare(heap[i], heap[parent]) >= 0) break
      const temp = heap[i]
      heap[i] = heap[parent]
      heap[parent] = temp
      i = parent
    }
  }

  private siftDown(index: number): void {
    const heap = this.heap
    let i = index
    for (;;) {
      const left = i * 2 + 1
      const right = left + 1
      let smallest = i
      if (left < heap.length && this.compare(heap[left], heap[smallest]) < 0) smallest = left
      if (right < heap.length && this.compare(heap[right], heap[smallest]) < 0) smallest = right
      if (smallest === i) break
      const temp = heap[i]
      heap[i] = heap[smallest]
      heap[smallest] = temp
      i = smallest
    }
  }
}

/** 把任意输入裁剪为安全区间的整数 */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = Math.round(Number(value))
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}

/**
 * 判断路径中包含某个「目录片段」。
 *
 * 全局设置里的 excludes 形如 `\node_modules\`，这里按目录层级（而不是裸子串）匹配，
 * 因此 `C:\a\node_modules` 与 `C:\a\node_modules\b` 都能命中，而 `C:\a\my_node_modules_bak` 不会。
 */
function containsSegments(haystack: string, fragment: unknown): boolean {
  if (typeof fragment !== 'string') return false
  const segments = fragment.toLowerCase().replace(/\//g, '\\').split('\\').filter(Boolean)
  if (!segments.length) return false
  return haystack.includes('\\' + segments.join('\\') + '\\')
}

export default defineCleanerPlugin<LargeFilesConfig>({
  name: 'large-files',
  version: '1.0.0',
  description: '在指定范围内找出最占空间的大文件（只报告，选中后由用户确认删除）',
  tasks: ['large-files'],
  inject: ['cleaner', 'pathPolicy', 'system', 'settings'],
  Config,
  setup(ctx, config) {
    const env = ctx.system.env

    /**
     * 当前生效的扫描根：优先使用全局设置里的自定义分析范围，
     * 为空时退回用户主目录（绝不默认扫整个系统盘，否则耗时不可接受）。
     */
    const resolveRoots = (): string[] => {
      const configured = ctx.settings
        .get()
        .analysis.roots.filter((root) => typeof root === 'string' && root.trim().length > 0)
        .map((root) => normalizePath(root))
      return configured.length ? configured : [normalizePath(env.userProfile)]
    }

    /** 阈值（字节）：插件配置优先，0 表示跟随全局设置 */
    const resolveThreshold = (): number => {
      const overrideMb = Number(config.thresholdMb)
      if (Number.isFinite(overrideMb) && overrideMb > 0) return Math.round(overrideMb * 1024 * 1024)
      const preset = Number(ctx.settings.get().scan.largeFileThreshold)
      return Number.isFinite(preset) && preset > 0 ? Math.round(preset) : FALLBACK_THRESHOLD
    }

    // ① 声明清理辖区（安全阀）：只有这些根目录下的路径才允许被本插件清理。
    //    扫描范围可以在设置里随时调整，因此订阅设置变化后重新声明（幂等）。
    ctx.effect(() => {
      let disposers: Array<() => void> = []
      const declare = () => {
        for (const dispose of disposers) dispose()
        disposers = []
        for (const root of resolveRoots()) {
          disposers.push(ctx.pathPolicy.addRoot(root, 'large-files'))
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

    // ② 注册清理任务（ctx.effect 保证插件卸载/热重载时自动注销）
    ctx.effect(() =>
      ctx.cleaner.define({
        id: 'large-files',
        name: '大文件',
        description: '扫描指定范围内最占空间的大文件，只报告不改动，由你确认后再删除',
        category: 'disk',
        risk: 'caution',
        icon: '🗂️',
        defaultSelected: false,
        targets: resolveRoots(),
        tips: [
          '本任务只做分析，默认不会勾选任何文件',
          '默认跳过 node_modules、.git、回收站、系统卷信息与临时目录',
          '位于受保护目录（文档、桌面、下载等）的文件只能手动删除',
          '删除会经过内核隔离区，可在隔离区中恢复',
        ],
        estimatedMs: 8000,
        async scan(scan) {
          const settings = ctx.settings.get()
          const roots = resolveRoots()
          const threshold = resolveThreshold()
          const limit = clampInt(config.limit, 1, 20_000, 80)
          const maxEntries = clampInt(settings.scan.maxEntriesPerTask, 1000, 5_000_000, 400_000)
          const maxDepth = clampInt(settings.scan.maxDepth, 1, 128, 32)
          const excludes = Array.isArray(settings.analysis.excludes) ? settings.analysis.excludes : []

          // 系统/依赖噪声目录（excludeSystem 关闭时全部扫描，用户可能是刻意想全量分析）
          const skipNames = config.excludeSystem
            ? new Set(['node_modules', '.git', '$recycle.bin', 'system volume information'])
            : new Set<string>()
          const skipTrees = config.excludeSystem ? [normalizePath(env.localAppData + '\\Temp')] : []

          const shouldEnter = (dir: string): boolean => {
            if (skipNames.size) {
              if (skipNames.has(basename(dir).toLowerCase())) return false
              if (skipTrees.some((tree) => isSubPath(tree, dir))) return false
            }
            if (excludes.length) {
              const haystack = '\\' + pathKey(dir) + '\\'
              for (const fragment of excludes) {
                if (containsSegments(haystack, fragment)) return false
              }
            }
            return true
          }

          const startedAt = Date.now()
          const heap = new TopFiles(limit, (a, b) => a.size - b.size)
          // 多个扫描根互相重叠时（如同时选了 D:\ 和 D:\data）避免同一文件被重复计入
          const seen = new Set<string>()
          const trackSeen = roots.length > 1
          let traversed = 0
          let remaining = maxEntries
          let hits = 0
          let truncated = false

          for (const root of roots) {
            scan.throwIfAborted()
            if (remaining <= 0) {
              truncated = true
              break
            }
            if (!shouldEnter(root) || !(await exists(root))) {
              scan.logger.warn(`扫描根不可用或已被排除，跳过：${root}`)
              continue
            }
            for await (const entry of walk(root, {
              signal: scan.signal,
              maxDepth,
              maxEntries: remaining,
              shouldEnter,
              onError: (target, error) => scan.addError({ path: target, message: errorMessage(error) }),
            })) {
              traversed++
              remaining--
              if (entry.isDirectory) {
                scan.count('directory')
                continue
              }
              if (traversed % PROGRESS_EVERY === 0) {
                scan.logger.info(`已遍历 ${traversed} 个条目，当前候选大文件 ${hits} 个`)
              }
              if (entry.size < threshold) continue
              if (trackSeen) {
                const key = pathKey(entry.path)
                if (seen.has(key)) continue
                seen.add(key)
              }
              hits++
              heap.push({ path: entry.path, size: entry.size, mtimeMs: entry.mtimeMs })
            }
          }

          scan.throwIfAborted()
          const top = heap.drain()
          for (const file of top) {
            // 受保护目录里的文件同样值得报告（只报告任务），但界面会标记「受保护」且不可勾选删除
            const locked = scan.pathPolicy.isProtected(file.path)
            scan.emit({
              path: file.path,
              size: file.size,
              risk: 'caution',
              defaultSelected: false,
              note: locked
                ? `修改于 ${formatTime(file.mtimeMs)}，位于受保护目录，仅支持手动删除`
                : `修改于 ${formatTime(file.mtimeMs)}`,
              meta: { mtime: file.mtimeMs, dir: parentPath(file.path) },
            })
          }

          const elapsed = Date.now() - startedAt
          scan.logger.info(
            `大文件扫描统计：根 ${roots.length} 个，遍历 ${traversed} 个条目，` +
              `${formatBytes(threshold)} 以上 ${hits} 个文件，上报 ${top.length} 个，用时 ${elapsed} ms`,
          )
          if (truncated || remaining <= 0) {
            scan.addError({
              path: roots.join(', '),
              message: `遍历条目数达到上限（${maxEntries}），大文件结果可能不完整`,
            })
          }
        },
      }),
    )
  },
})
