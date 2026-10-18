/**
 * 空目录清理插件（empty-dirs）。
 *
 * 扫描范围（优先用户自定义，否则回退到默认范围）：
 *   1. `settings.analysis.roots` —— 用户在「设置 - 分析范围」里配置的目录；
 *   2. 没有配置时使用 `%LOCALAPPDATA%` 与 `%USERPROFILE%\Downloads`。
 *
 * 「空目录」的判定（自底向上，与 `rmdir` 的语义一致）：
 *   目录为空 ⇔ 自身不含任何文件，且所有子目录都为空。
 * 因此 `a/b/c` 全部为空时，`a`、`b`、`c` 都算空目录，但只上报最外层的 `a`
 * （删除 `a` 会递归删掉 b、c，重复上报只会产生「删除失败」的噪声）。
 *
 * 安全约束：
 * - 自实现的逐层遍历（不递归调用），每层用 `mapLimit` 控制并发；
 * - 每个**子目录**都用 `lstat()` 复核，符号链接 / NTFS 联接点一律不进入、不上报；
 * - 跳过 `node_modules`、`.git`、`System Volume Information`、`$Recycle.Bin` 等目录；
 * - 扫描根自身永远不会被上报（只上报深度 ≥ 1 的目录），且盘符根与系统目录会被拒绝；
 * - 不写自定义 `clean`，删除交给内核默认引擎（它还会二次校验路径策略与受保护目录）。
 */
import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import Schema from 'schemastery'
import { defineCleanerPlugin } from '@cordclean/shared'
import type { TaskScanContext } from '@cordclean/shared'
import { errorMessage, isSubPath, mapLimit, normalizePath, pathKey, safeLstat, toLongPath } from '@cordclean/utils'

export interface EmptyDirsConfig {
  /** 最大递归深度（相对扫描根，扫描根自身深度为 0） */
  maxDepth: number
  /** 最多上报的空目录数量 */
  limit: number
}

const Config = Schema.object({
  maxDepth: Schema.number().min(1).max(32).default(8).description('最大递归深度（相对扫描根；超过深度的目录不参与「是否为空」的判定）'),
  limit: Schema.number().min(1).max(50_000).default(3000).description('最多上报的空目录数量，超过后截断'),
})

/** 单个目录 readdir 的并发度（Windows 上再高也受 libuv 线程池限制，32 已足够） */
const READ_CONCURRENCY = 32
/** 默认跳过的目录名（小写比较）：这些目录里的「空目录」往往是刻意保留的占位目录 */
const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'system volume information',
  '$recycle.bin',
  'recycler',
  'config.msi',
])
/** 防御性上限：单次扫描最多读取的目录数量（防止误把 C:\ 配成扫描根时长时间占用磁盘） */
const MAX_SCANNED_DIRS = 120_000
/** 插件自身最多上报的错误条数（内核另有一层上限，这里避免错误列表被刷屏） */
const MAX_REPORTED_ERRORS = 40

/** 遍历过程中记录的一个目录节点 */
interface DirNode {
  /** 规范化后的绝对路径 */
  path: string
  /** 相对扫描根的深度（扫描根为 0） */
  depth: number
  /** 父节点的路径键（扫描根没有父节点） */
  parentKey?: string
  /** 已纳入遍历的子目录路径键 */
  children: string[]
  /** 是否确定「非空」：含文件/链接、含被跳过或超深的子目录、或读取失败 */
  hasContent: boolean
}

/** 一个待上报的空目录 */
interface EmptyDir {
  path: string
  depth: number
}

/** 目录读取结果（失败不抛异常，交给调用方记录为非致命错误） */
type ReadDirResult = { ok: true; entries: Dirent[] } | { ok: false; message: string }

async function readDir(dir: string): Promise<ReadDirResult> {
  try {
    return { ok: true, entries: await fs.readdir(toLongPath(dir), { withFileTypes: true }) }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

/** 把配置数值收敛到合理区间（防止用户手改配置文件导致越界） */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, Math.round(num)))
}

/**
 * 找出所有空目录。
 *
 * 实现要点：
 * 1. 逐层（BFS）读取目录：每层用 mapLimit 并发 readdir，然后用 lstat 复核子目录是否为链接；
 * 2. 记录每个目录的「是否含内容」与子目录关系；
 * 3. 自底向上汇总：子目录全空且自身无内容的目录才算空目录；
 * 4. 只输出最外层空目录，并遵守 limit / maxDepth / 目录数量预算。
 */
async function findEmptyDirs(
  scan: TaskScanContext,
  roots: string[],
  options: { maxDepth: number; limit: number; excludes: string[] },
): Promise<{ dirs: EmptyDir[]; scannedDirs: number; truncated: boolean }> {
  const nodes = new Map<string, DirNode>()
  const levels: string[][] = []
  let frontier: DirNode[] = []
  let reportedErrors = 0

  const reportError = (target: string, message: string) => {
    if (reportedErrors >= MAX_REPORTED_ERRORS) return
    reportedErrors++
    scan.addError({ path: target, message })
  }

  /** 设置里的排除片段（如 `\node_modules\`），命中则不进入该目录 */
  const excludeFragments = options.excludes
    .map((fragment) => fragment.replace(/\//g, '\\').toLowerCase())
    .filter(Boolean)
  const isExcluded = (target: string): boolean => {
    if (!excludeFragments.length) return false
    const value = target.replace(/\//g, '\\').toLowerCase() + '\\'
    return excludeFragments.some((fragment) => value.includes(fragment))
  }

  const ensureLevel = (depth: number): string[] => {
    let keys = levels[depth]
    if (!keys) {
      keys = []
      levels[depth] = keys
    }
    return keys
  }

  const addNode = (dirPath: string, depth: number, parentKey?: string): { node: DirNode; isNew: boolean } => {
    const key = pathKey(dirPath)
    const existing = nodes.get(key)
    if (existing) return { node: existing, isNew: false }
    const node: DirNode = { path: dirPath, depth, parentKey, children: [], hasContent: false }
    nodes.set(key, node)
    ensureLevel(depth).push(key)
    return { node, isNew: true }
  }

  for (const root of roots) frontier.push(addNode(root, 0).node)

  let scanned = 0
  let budgetExceeded = false

  while (frontier.length) {
    scan.throwIfAborted()
    const batch = frontier
    frontier = []

    const listings = await mapLimit(batch, READ_CONCURRENCY, async (node) => {
      if (scanned >= MAX_SCANNED_DIRS) return { node, skipped: true as const }
      scanned++
      return { node, skipped: false as const, result: await readDir(node.path) }
    })

    /** 本层待用 lstat 复核的子目录（readdir 的 dirent 类型在部分网络盘上不可靠） */
    const candidates: Array<{ parent: DirNode; childPath: string }> = []

    for (const item of listings) {
      if (item.skipped) {
        budgetExceeded = true
        continue
      }
      const node = item.node
      if (!item.result.ok) {
        // 读不到就无法确认是否为空，保守地按「非空」处理
        node.hasContent = true
        reportError(node.path, `无法读取目录：${item.result.message}`)
        continue
      }
      for (const entry of item.result.entries) {
        // 链接/联接点：不进入、不上报，并让父目录保持「非空」以免误删
        if (entry.isSymbolicLink()) {
          node.hasContent = true
          continue
        }
        if (!entry.isDirectory()) {
          // 文件、套接字、挂载点等任何非目录条目都视为「有内容」
          node.hasContent = true
          continue
        }
        const name = entry.name.toLowerCase()
        if (SKIP_DIR_NAMES.has(name)) {
          node.hasContent = true
          continue
        }
        const childPath = path.join(node.path, entry.name)
        if (isExcluded(childPath)) {
          node.hasContent = true
          continue
        }
        if (node.depth + 1 > options.maxDepth) {
          // 超出深度限制：无法确认，按「有内容」处理（宁可不删）
          node.hasContent = true
          continue
        }
        candidates.push({ parent: node, childPath })
      }
    }

    if (!candidates.length) continue

    const kinds = await mapLimit(candidates, READ_CONCURRENCY * 2, async ({ childPath }) => {
      const stat = await safeLstat(childPath)
      if (!stat) return 'gone' as const
      return stat.isSymbolicLink() ? 'link' as const : 'dir' as const
    })

    for (let index = 0; index < candidates.length; index++) {
      const { parent, childPath } = candidates[index]
      // 复核不通过（链接/联接点，或遍历期间已被删除）：父目录按「非空」保守处理
      if (kinds[index] !== 'dir') {
        parent.hasContent = true
        continue
      }
      const { node, isNew } = addNode(childPath, parent.depth + 1, pathKey(parent.path))
      parent.children.push(pathKey(childPath))
      if (isNew) frontier.push(node)
    }
  }

  /* ---------- 自底向上汇总：目录为空 ⇔ 自身无内容且所有子目录为空 ---------- */
  const empty = new Map<string, boolean>()
  for (let depth = levels.length - 1; depth >= 0; depth--) {
    const keys = levels[depth]
    if (!keys) continue
    for (const key of keys) {
      const node = nodes.get(key)
      if (!node) continue
      if (node.hasContent) {
        empty.set(key, false)
        continue
      }
      let allEmpty = true
      for (const childKey of node.children) {
        if (empty.get(childKey) !== true) {
          allEmpty = false
          break
        }
      }
      empty.set(key, allEmpty)
    }
  }

  /* ---------- 只上报最外层空目录（扫描根自身永远不上报） ---------- */
  const dirs: EmptyDir[] = []
  let truncated = false
  for (let depth = 1; depth < levels.length; depth++) {
    const keys = levels[depth]
    if (!keys) continue
    for (const key of keys) {
      if (scan.signal.aborted) return { dirs, scannedDirs: scanned, truncated }
      if (empty.get(key) !== true) continue
      const node = nodes.get(key)
      if (!node) continue
      // 父目录（深度 ≥ 1）也是空目录时，父目录会被上报，这里跳过以避免父子重复
      if (node.parentKey) {
        const parent = nodes.get(node.parentKey)
        if (parent && parent.depth >= 1 && empty.get(node.parentKey) === true) continue
      }
      if (dirs.length >= options.limit) {
        truncated = true
        break
      }
      dirs.push({ path: node.path, depth: node.depth })
    }
    if (truncated) break
  }

  if (truncated) {
    reportError(roots[0] ?? '', `空目录数量超过上限（${options.limit} 个），结果已截断`)
  }
  if (budgetExceeded) {
    reportError(roots[0] ?? '', `目录数量超过扫描上限（${MAX_SCANNED_DIRS} 个），其余目录未扫描`)
  }

  return { dirs, scannedDirs: scanned, truncated }
}

export default defineCleanerPlugin<EmptyDirsConfig>({
  name: 'empty-dirs',
  version: '1.0.0',
  description: '找出并删除没有任何文件的空文件夹，扫描范围可在设置中自定义',
  inject: ['cleaner', 'pathPolicy', 'system', 'settings'],
  Config,
  setup(ctx, config) {
    const env = ctx.system.env

    /**
     * 当前扫描范围：优先使用用户自定义范围（settings.analysis.roots），
     * 为空时回退到「本地应用数据 + 下载」两个默认目录。
     */
    const scanRoots = (): string[] => {
      const configured = (ctx.settings.get().analysis.roots ?? [])
        .filter((root): root is string => typeof root === 'string' && root.trim().length > 0)
        .map((root) => normalizePath(root))
      const raw = configured.length
        ? configured
        : [normalizePath(env.localAppData), normalizePath(path.join(env.userProfile, 'Downloads'))]
      const unique = [...new Set(raw.filter(Boolean))]
      // 去掉被其它扫描根包含的重复范围（例如同时配置了 D:\Data 与 D:\Data\Cache）
      return unique.filter((root) => !unique.some((other) => other !== root && isSubPath(other, root)))
    }

    /** 安全兜底：盘符根与系统目录不参与空目录清理 */
    const unsafeRootReason = (root: string): string | undefined => {
      if (/^[a-zA-Z]:\\?$/.test(root)) return '驱动器根目录'
      for (const system of [env.windowsDir, env.programFiles, env.programFilesX86, env.programData]) {
        if (system && isSubPath(system, root)) return `系统目录（${system}）`
      }
      return undefined
    }

    // ① 声明清理辖区：每个扫描根都同时登记为「允许清理根」与「用户扫描根」
    const declared = new Map<string, Array<() => void>>()
    const syncRoots = (roots: string[]): void => {
      const wanted = new Map(roots.map((root) => [pathKey(root), root]))
      for (const [key, disposers] of declared) {
        if (wanted.has(key)) continue
        disposers.forEach((dispose) => dispose())
        declared.delete(key)
      }
      for (const [key, root] of wanted) {
        if (declared.has(key)) continue
        declared.set(key, [ctx.pathPolicy.addRoot(root, 'empty-dirs'), ctx.pathPolicy.addUserRoot(root)])
      }
    }

    ctx.effect(() => {
      syncRoots(scanRoots())
      // 用户在设置里修改扫描范围后实时生效，无需重载插件
      const off = ctx.settings.onChange(() => syncRoots(scanRoots()))
      return () => {
        off()
        for (const disposers of declared.values()) disposers.forEach((dispose) => dispose())
        declared.clear()
      }
    })

    // ② 注册清理任务
    ctx.effect(() =>
      ctx.cleaner.define({
        id: 'empty-dirs',
        name: '空目录',
        description: '清理没有任何文件（也没有含文件的子目录）的空文件夹，删除不影响数据',
        category: 'disk',
        risk: 'safe',
        icon: '📁',
        defaultSelected: true,
        estimatedMs: 4000,
        targets: scanRoots(),
        tips: [
          '空目录里没有任何文件，删除不影响数据',
          '默认跳过 node_modules、.git、系统卷信息与回收站等目录，以及所有符号链接/联接点',
          '父子目录都为空时只上报最外层目录，删除一次即可',
          '可以在「设置 - 分析范围」中自定义要扫描的目录',
        ],
        async scan(scan) {
          const maxDepth = clampInt(config.maxDepth, 1, 32, 8)
          const limit = clampInt(config.limit, 1, 50_000, 3000)
          const excludes = ctx.settings.get().analysis.excludes ?? []

          const roots: string[] = []
          for (const root of scanRoots()) {
            scan.throwIfAborted()
            const reason = unsafeRootReason(root)
            if (reason) {
              scan.addError({ path: root, message: `已跳过扫描根（${reason}）` })
              continue
            }
            const stat = await safeLstat(root)
            if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
              scan.addError({ path: root, message: '扫描根不存在、不是目录或是符号链接，已跳过' })
              continue
            }
            roots.push(root)
          }
          if (!roots.length) {
            scan.logger.warn('没有可扫描的目录，可在设置中配置自定义扫描范围')
            return
          }

          const result = await findEmptyDirs(scan, roots, { maxDepth, limit, excludes })
          for (const dir of result.dirs) {
            scan.emit({
              path: dir.path,
              kind: 'directory',
              size: 0,
              risk: 'safe',
              defaultSelected: true,
              note: '空目录，删除不影响数据',
              meta: { depth: dir.depth },
            })
          }
          scan.logger.info(
            `扫描 ${roots.length} 个根目录、${result.scannedDirs} 个子目录，找到 ${result.dirs.length} 个空目录`,
          )
        },
      }),
    )
  },
})
