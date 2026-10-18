/**
 * 开发者缓存清理插件（dev-cache）。
 *
 * 一个插件注册两个清理任务：
 *  1. `dev-cache`：npm / pnpm / yarn / pip / Gradle / Maven / Go / Cargo / conda 等包管理器缓存；
 *  2. `ide-cache`：JetBrains、VS Code 扩展宿主临时目录、Vite、TypeScript、Yarn Berry、~/.cache 等
 *     IDE 与构建工具缓存。
 *
 * 上报策略（两个任务共用同一套工具函数）：
 * 这类缓存目录内部往往有上万个文件，若逐文件上报，界面会被彻底淹没，清理也会退化成上万次删除。
 * 因此这里统一「按来源目录的一级子项聚合上报」：先用 `folderSize()`（内部基于 `walk()`，不跟随
 * 符号链接/联接点）算出每个一级子目录的占用，再按体积从大到小上报，超出上限的较小项合并计入统计。
 * 这样用户既能看清「是哪个工具、哪一块缓存占了空间」，又能用几次删除释放掉大部分空间。
 *
 * 安全约定：
 * - 只为**真实存在**的目录调用 `ctx.pathPolicy.addRoot()` 声明清理辖区，插件无法越权清理未声明目录；
 * - 不写自定义 `clean`，一律走内核默认删除引擎（隔离区、路径策略、受保护目录检查都由内核保证）。
 */
import { existsSync, promises as fs, readdirSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import Schema from 'schemastery'
import { basename, defineCleanerPlugin, formatBytes } from '@cordclean/shared'
import type { TaskScanContext } from '@cordclean/shared'
import { errorMessage, folderSize, isSubPath, mapLimit, safeLstat, toLongPath } from '@cordclean/utils'

export interface DevCacheConfig {
  /* ---------- 任务 A：包管理器缓存 ---------- */
  npm: boolean
  pnpm: boolean
  yarn: boolean
  pip: boolean
  gradle: boolean
  maven: boolean
  go: boolean
  cargo: boolean
  conda: boolean
  /* ---------- 任务 B：IDE 与构建缓存 ---------- */
  jetbrains: boolean
  vscodeTemp: boolean
  vite: boolean
  typescript: boolean
  yarnBerry: boolean
  userCache: boolean
}

const Config = Schema.object({
  npm: Schema.boolean().default(true).description('npm 缓存（%LOCALAPPDATA%\\npm-cache\\_cacache，找不到时回退到 npm_config_cache）'),
  pnpm: Schema.boolean().default(true).description('pnpm 内容寻址仓库（%LOCALAPPDATA%\\pnpm\\store 与 %LOCALAPPDATA%\\pnpm-store）'),
  yarn: Schema.boolean().default(true).description('Yarn 1.x 缓存（%LOCALAPPDATA%\\Yarn\\Cache）'),
  pip: Schema.boolean().default(true).description('pip 下载缓存（%LOCALAPPDATA%\\pip\\Cache）'),
  gradle: Schema.boolean().default(true).description('Gradle 缓存（%USERPROFILE%\\.gradle\\caches）'),
  maven: Schema.boolean().default(true).description('Maven 本地仓库（%USERPROFILE%\\.m2\\repository）'),
  go: Schema.boolean().default(true).description('Go 模块缓存（%USERPROFILE%\\go\\pkg\\mod）'),
  cargo: Schema.boolean().default(true).description('Cargo 注册表缓存（%USERPROFILE%\\.cargo\\registry）'),
  conda: Schema.boolean().default(true).description('conda 包缓存（%USERPROFILE%\\.conda\\pkgs）'),
  jetbrains: Schema.boolean().default(true).description('JetBrains 系列 IDE 的索引与缓存目录（%LOCALAPPDATA%\\JetBrains）'),
  vscodeTemp: Schema.boolean().default(true).description('VS Code 扩展宿主临时目录（%LOCALAPPDATA%\\Temp\\vscode-*）'),
  vite: Schema.boolean().default(true).description('Vite 预构建缓存（%USERPROFILE%\\.vite）'),
  typescript: Schema.boolean().default(true).description('TypeScript 语言服务缓存（%LOCALAPPDATA%\\Microsoft\\TypeScript）'),
  yarnBerry: Schema.boolean().default(true).description('Yarn Berry（2+）全局缓存（%LOCALAPPDATA%\\Yarn\\Berry\\cache）'),
  userCache: Schema.boolean().default(true).description('通用用户级缓存目录（%USERPROFILE%\\.cache，uv / pipx 等工具会使用）'),
})

/** 包管理器缓存的统一提示：这些缓存都能重新下载 */
const REDOWNLOAD_NOTE = '删除后下次安装依赖会重新下载'

/** 任务 A（包管理器缓存）每个来源最多单独列出的项数 */
const PACKAGE_ITEM_LIMIT = 200
/** 任务 B（IDE 与构建缓存）每个来源最多单独列出的项数 */
const IDE_ITEM_LIMIT = 100
/** 单个来源最多参与体积统计的一级子目录数（防御异常目录结构导致扫描失控） */
const MAX_MEASURED_CHILDREN = 800
/** 统计一级子目录体积的并发度（folderSize 内部按目录批量并发 lstat） */
const MEASURE_CONCURRENCY = 6
/** 单个一级子目录最多统计的条目数（超大缓存只统计前 N 条，避免单个目录拖垮整个扫描） */
const MAX_ENTRIES_PER_CHILD = 200_000
/** 一级普通文件体积统计的并发度（这类文件通常只有几个） */
const FILE_STAT_CONCURRENCY = 8

/** 一个缓存来源 */
interface CacheSource {
  /** 对应的配置开关键 */
  key: keyof DevCacheConfig
  /** 来源名称，用于拼接清理项标题 */
  label: string
  /** 候选根目录（只上报实际存在的） */
  paths: string[]
  /** children：上报根目录的一级子项；self：根目录本身就是要清理的对象 */
  mode: 'children' | 'self'
  /** 面向用户的删除提示 */
  note: string
}

/** 来源目录的一级子项 */
interface FirstLevel {
  /** 一级子目录（绝对路径） */
  dirs: string[]
  /** 一级普通文件的体积（只计入统计，不逐项上报） */
  fileSizes: number[]
}

/** 单个一级子目录的测量结果 */
interface MeasuredChild {
  path: string
  name: string
  bytes: number
  files: number
  dirs: number
}

/** 读取来源目录的一级子项；读取失败返回错误信息 */
async function readFirstLevel(root: string): Promise<{ level?: FirstLevel; error?: string }> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(toLongPath(root), { withFileTypes: true })
  } catch (error) {
    return { error: errorMessage(error) }
  }
  const dirs: string[] = []
  const files: string[] = []
  for (const entry of entries) {
    // 不跟随符号链接与 NTFS 联接点（否则可能越界统计/删除链接目标）
    if (entry.isSymbolicLink()) continue
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) dirs.push(full)
    else if (entry.isFile()) files.push(full)
  }
  const fileSizes = await mapLimit(files, FILE_STAT_CONCURRENCY, async (file) => (await safeLstat(file))?.size ?? 0)
  return { level: { dirs, fileSizes } }
}

/** 统计单个子目录的体积（folderSize 内部基于 walk()，不跟随链接） */
async function measureDirectory(root: string, signal: AbortSignal): Promise<MeasuredChild> {
  const size = await folderSize(root, { signal, maxEntries: MAX_ENTRIES_PER_CHILD })
  return { path: root, name: basename(root), bytes: size.bytes, files: size.files, dirs: size.dirs }
}

/**
 * 上报一个来源目录（两个任务共用）。
 *
 * - `children` 模式：把根目录下的一级子目录按体积降序上报，超过 `limit` 的较小项用
 *   `scan.count()` 计入统计并用 `addError` 说明已合并（避免产生上万个文件项）；
 * - `self` 模式：根目录本身就是要清理的对象（例如 Temp 下的 vscode-* 目录）。
 */
async function reportSource(scan: TaskScanContext, source: CacheSource, root: string, limit: number): Promise<void> {
  scan.throwIfAborted()

  if (source.mode === 'self') {
    const measured = await measureDirectory(root, scan.signal)
    scan.emit({
      path: measured.path,
      title: `${source.label} · ${measured.name}`,
      kind: 'directory',
      size: measured.bytes,
      risk: 'caution',
      // 风险等级为 caution，按插件开发规范默认不勾选（由用户显式确认）
      defaultSelected: false,
      note: source.note,
      meta: { source: source.key, files: measured.files, dirs: measured.dirs },
    })
    return
  }

  const { level, error } = await readFirstLevel(root)
  if (error) {
    scan.addError({ path: root, message: `无法读取缓存目录：${error}` })
    return
  }
  if (!level) return

  // 一级普通文件数量很少，只计入统计，避免产生零散的小清理项
  for (const size of level.fileSizes) scan.count('file', size)

  if (!level.dirs.length) {
    scan.logger.debug(`缓存目录 ${root} 没有一级子目录，跳过`)
    return
  }

  const measuredDirs = level.dirs.slice(0, MAX_MEASURED_CHILDREN)
  const measured = await mapLimit(measuredDirs, MEASURE_CONCURRENCY, (dir) => measureDirectory(dir, scan.signal))
  const skippedDirs = level.dirs.length - measuredDirs.length
  if (skippedDirs > 0) {
    scan.addError({
      path: root,
      message: `一级子目录超过 ${MAX_MEASURED_CHILDREN} 个，仅统计前 ${MAX_MEASURED_CHILDREN} 个，其余 ${skippedDirs} 个未计入`,
    })
  }

  measured.sort((a, b) => b.bytes - a.bytes)
  const top = measured.slice(0, limit)
  const merged = measured.slice(limit)

  for (const child of top) {
    if (scan.signal.aborted) return
    scan.emit({
      path: child.path,
      title: `${source.label} · ${child.name}`,
      kind: 'directory',
      size: child.bytes,
      risk: 'caution',
      // 风险等级为 caution，按插件开发规范默认不勾选（缓存可重新下载，但不是「垃圾」）
      defaultSelected: false,
      note: source.note,
      meta: { source: source.key, files: child.files, dirs: child.dirs },
    })
  }

  if (merged.length) {
    let mergedBytes = 0
    for (const child of merged) {
      mergedBytes += child.bytes
      // 只计入统计：不产出清理项，但体积仍然体现在总释放空间里
      scan.count('directory', child.bytes)
    }
    scan.addError({
      path: root,
      message: `一级子目录超过 ${limit} 个，体积较小的 ${merged.length} 个（共 ${formatBytes(mergedBytes)}）已合并计入统计，不再单独列出`,
    })
  }
}

export default defineCleanerPlugin<DevCacheConfig>({
  name: 'dev-cache',
  version: '1.0.0',
  description: 'npm / pnpm / yarn / pip / Gradle / Maven / Go / Cargo / conda 缓存与 IDE、构建工具缓存',
  inject: ['cleaner', 'pathPolicy', 'system'],
  Config,
  setup(ctx, config) {
    const env = ctx.system.env

    /** 包管理器缓存来源（任务 A） */
    const packageSources = (): CacheSource[] => {
      // npm 的缓存位置可以被 npm_config_cache 环境变量覆盖：默认优先使用
      // %LOCALAPPDATA%\npm-cache\_cacache，找不到时才回退到该环境变量指向的目录
      const npmCandidates = [path.join(env.localAppData, 'npm-cache', '_cacache')]
      const customNpmCache = env.get('npm_config_cache')
      if (customNpmCache) npmCandidates.push(path.join(customNpmCache, '_cacache'), customNpmCache)
      // 只取第一个存在的候选目录：npm-cache 与 _cacache 是包含关系，同时上报会重复统计
      const npmPaths = npmCandidates.filter((candidate) => existsSync(candidate)).slice(0, 1)
      return [
        { key: 'npm', label: 'npm', paths: npmPaths, mode: 'children', note: REDOWNLOAD_NOTE },
        {
          key: 'pnpm',
          label: 'pnpm',
          // pnpm 7+ 默认在 %LOCALAPPDATA%\pnpm\store，旧版本/自定义安装可能在 %LOCALAPPDATA%\pnpm-store
          paths: [path.join(env.localAppData, 'pnpm', 'store'), path.join(env.localAppData, 'pnpm-store')],
          mode: 'children',
          note: REDOWNLOAD_NOTE,
        },
        { key: 'yarn', label: 'Yarn', paths: [path.join(env.localAppData, 'Yarn', 'Cache')], mode: 'children', note: REDOWNLOAD_NOTE },
        { key: 'pip', label: 'pip', paths: [path.join(env.localAppData, 'pip', 'Cache')], mode: 'children', note: REDOWNLOAD_NOTE },
        { key: 'gradle', label: 'Gradle', paths: [path.join(env.userProfile, '.gradle', 'caches')], mode: 'children', note: REDOWNLOAD_NOTE },
        { key: 'maven', label: 'Maven', paths: [path.join(env.userProfile, '.m2', 'repository')], mode: 'children', note: REDOWNLOAD_NOTE },
        { key: 'go', label: 'Go 模块', paths: [path.join(env.userProfile, 'go', 'pkg', 'mod')], mode: 'children', note: REDOWNLOAD_NOTE },
        { key: 'cargo', label: 'Cargo', paths: [path.join(env.userProfile, '.cargo', 'registry')], mode: 'children', note: REDOWNLOAD_NOTE },
        { key: 'conda', label: 'conda', paths: [path.join(env.userProfile, '.conda', 'pkgs')], mode: 'children', note: REDOWNLOAD_NOTE },
      ]
    }

    /** 找出 %LOCALAPPDATA%\Temp 下由 VS Code 扩展宿主创建的临时目录（vscode-*） */
    const vscodeTempDirs = (): string[] => {
      const tempDir = path.join(env.localAppData, 'Temp')
      try {
        return readdirSync(tempDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.toLowerCase().startsWith('vscode-'))
          .map((entry) => path.join(tempDir, entry.name))
      } catch {
        // 目录不存在或无权限：视为没有该来源，不视为错误
        return []
      }
    }

    /** IDE 与构建缓存来源（任务 B） */
    const ideSources = (): CacheSource[] => [
      {
        key: 'jetbrains',
        label: 'JetBrains IDE',
        paths: [path.join(env.localAppData, 'JetBrains')],
        mode: 'children',
        note: 'IDE 会重新生成索引，首次打开项目会变慢',
      },
      {
        key: 'vscodeTemp',
        label: 'VS Code 临时目录',
        paths: vscodeTempDirs(),
        mode: 'self',
        note: 'VS Code 扩展宿主的临时目录，删除不影响设置与插件',
      },
      {
        key: 'vite',
        label: 'Vite',
        paths: [path.join(env.userProfile, '.vite')],
        mode: 'children',
        note: 'Vite 预构建缓存，启动开发服务器时会重新生成',
      },
      {
        key: 'typescript',
        label: 'TypeScript',
        paths: [path.join(env.localAppData, 'Microsoft', 'TypeScript')],
        mode: 'children',
        note: 'TypeScript 语言服务缓存，重新打开编辑器时会重建',
      },
      {
        key: 'yarnBerry',
        label: 'Yarn Berry',
        paths: [path.join(env.localAppData, 'Yarn', 'Berry', 'cache')],
        mode: 'children',
        note: '删除后下次 yarn install 会重新下载',
      },
      {
        key: 'userCache',
        label: '通用缓存',
        paths: [path.join(env.userProfile, '.cache')],
        mode: 'children',
        note: '各类命令行工具的用户级缓存，删除后按需重建',
      },
    ]

    /** 过滤配置开关与实际存在性，得到本次真正要扫描的来源 */
    const activeSources = (sources: CacheSource[]): CacheSource[] => {
      const resolved = sources
        .filter((source) => config[source.key])
        .map((source) => ({ ...source, paths: source.paths.filter((root) => !!root && existsSync(root)) }))
        .filter((source) => source.paths.length > 0)
      // 去重：同一路径只保留第一次出现的来源；被其它来源路径包含的路径也不再单独扫描，
      // 否则同一批文件会被统计两次（例如 npm_config_cache 恰好就是 %LOCALAPPDATA%\npm-cache）
      const kept: string[] = []
      return resolved
        .map((source) => ({
          ...source,
          paths: source.paths.filter((root) => {
            if (kept.some((other) => isSubPath(other, root))) return false
            kept.push(root)
            return true
          }),
        }))
        .filter((source) => source.paths.length > 0)
    }

    /** 当前所有要声明辖区的根目录（只声明真实存在的） */
    const allRoots = (): string[] => [
      ...new Set([...activeSources(packageSources()), ...activeSources(ideSources())].flatMap((source) => source.paths)),
    ]

    // ① 声明清理辖区：只有这些缓存目录下的路径才允许被本插件删除
    ctx.effect(() => {
      const disposers = allRoots().map((root) => ctx.pathPolicy.addRoot(root, 'dev-cache'))
      return () => disposers.forEach((dispose) => dispose())
    })

    // ② 注册任务 A：包管理器缓存
    ctx.effect(() =>
      ctx.cleaner.define({
        id: 'dev-cache',
        name: '包管理器缓存',
        description: 'npm / pnpm / yarn / pip / Gradle / Maven / Go / Cargo / conda 的本地缓存（按一级子目录聚合上报）',
        category: 'dev',
        risk: 'caution',
        icon: '📦',
        defaultSelected: true,
        estimatedMs: 6000,
        targets: [...new Set(activeSources(packageSources()).flatMap((source) => source.paths))],
        tips: [
          '缓存只影响下载速度：删除后下次安装依赖会重新下载，离线环境下可能安装失败',
          '按一级子目录聚合上报，避免上万个文件把界面淹没',
          '正在被其它程序占用的文件会被跳过，不影响其它清理项',
        ],
        async scan(scan) {
          for (const source of activeSources(packageSources())) {
            for (const root of source.paths) {
              if (scan.signal.aborted) return
              await reportSource(scan, source, root, PACKAGE_ITEM_LIMIT)
            }
          }
          scan.logger.info('包管理器缓存扫描完成')
        },
      }),
    )

    // ③ 注册任务 B：IDE 与构建缓存
    ctx.effect(() =>
      ctx.cleaner.define({
        id: 'ide-cache',
        name: 'IDE 与构建缓存',
        description: 'JetBrains / VS Code 临时目录 / Vite / TypeScript / Yarn Berry / 用户级 .cache 等 IDE 与构建工具缓存',
        category: 'dev',
        risk: 'caution',
        icon: '🧰',
        defaultSelected: true,
        estimatedMs: 3000,
        targets: [...new Set(activeSources(ideSources()).flatMap((source) => source.paths))],
        tips: [
          'IDE 缓存删除后会自动重建，首次打开项目或加载语言服务会变慢',
          '运行中的 IDE 可能占用其中的文件，被占用的项会被跳过',
          '按一级子目录聚合上报，体积较小的项会合并计入统计',
        ],
        async scan(scan) {
          for (const source of activeSources(ideSources())) {
            for (const root of source.paths) {
              if (scan.signal.aborted) return
              await reportSource(scan, source, root, IDE_ITEM_LIMIT)
            }
          }
          scan.logger.info('IDE 与构建缓存扫描完成')
        },
      }),
    )
  },
})
