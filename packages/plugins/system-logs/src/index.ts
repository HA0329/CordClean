/**
 * 系统日志与崩溃转储清理插件（system-logs）。
 *
 * 注册两个任务：
 * 1. `crash-dumps`   崩溃转储与错误报告 —— 只清理 `.dmp` 与 WER 错误报告目录；
 * 2. `update-cache`  系统更新缓存与日志 —— Windows Update 下载缓存、CBS/DISM 日志、
 *    系统安装日志（Prefetch 由 temp 插件负责，这里**不重复**处理）。
 *
 * 设计要点：
 * - 两个来源都属于「可再生成 / 诊断用途」的系统文件，因此分别标注 safe / caution；
 * - `%windir%` 下的目录在非管理员权限下可能返回 EPERM，统一通过 `scan.addError`
 *   降级记录，绝不让整个任务抛错终止（规范 §7.5）；
 * - 所有清理都交给默认引擎（自动走路径策略校验 + 隔离区），插件不实现 clean。
 */
import path from 'node:path'
import { defineCleanerPlugin } from '@cordclean/shared'
import type { TaskEnv, TaskScanContext } from '@cordclean/shared'
import {
  errorMessage,
  exists,
  folderSize,
  isSubPath,
  parentPath,
  pathKey,
  walk,
} from '@cordclean/utils'

/** 单个崩溃转储目录最多上报的文件数量（防止内存溢出转储堆积时拖垮界面） */
const MAX_DUMP_FILES = 2000

/** WER 目录中文件数超过该阈值后，改为「按目录聚合」上报 */
const WER_AGGREGATE_THRESHOLD = 500

/** WER 目录单次扫描最多枚举的条目数（目录 + 文件） */
const WER_MAX_ENTRIES = 20_000

/** 单个 WER 目录最多上报的清理项数量 */
const WER_MAX_ITEMS = 500

/** 更新缓存任务最多上报的清理项数量 */
const MAX_UPDATE_ITEMS = 300

/** 一个清理来源的声明 */
interface Source {
  /** 内部标识，写入 item.meta.source */
  key: string
  /** 用户可见的来源名 */
  label: string
  /** 目录绝对路径 */
  path: string
  /** 只上报该后缀的文件（崩溃转储只清理 .dmp） */
  extension?: string
  /** 展示给用户的补充提示 */
  note?: string
  /** 是否为 Windows 错误报告目录：文件过多时按目录聚合 */
  wer?: boolean
}

/**
 * 任务 A 的来源：崩溃转储与错误报告。
 * `%LOCALAPPDATA%\CrashDumps\*.dmp` 与 `%windir%\Minidump\*.dmp` 只上报转储文件，
 * 不清理目录里的其它文件（如 .log / .txt）。
 */
function crashDumpSources(env: TaskEnv): Source[] {
  return [
    {
      key: 'crash-dumps',
      label: '应用程序崩溃转储',
      path: path.join(env.localAppData, 'CrashDumps'),
      extension: '.dmp',
      note: '程序崩溃时生成的转储文件，删除后无法再用于分析',
    },
    {
      key: 'wer-archive',
      label: 'Windows 错误报告归档',
      path: path.join(env.localAppData, 'Microsoft', 'Windows', 'WER', 'ReportArchive'),
      wer: true,
      note: '已归档的 Windows 错误报告，可安全清理',
    },
    {
      key: 'wer-queue',
      label: 'Windows 错误报告队列',
      path: path.join(env.localAppData, 'Microsoft', 'Windows', 'WER', 'ReportQueue'),
      wer: true,
      note: '等待上传的错误报告，清理后不再上报',
    },
    {
      key: 'minidump',
      label: '系统小型转储',
      path: path.join(env.windowsDir, 'Minidump'),
      extension: '.dmp',
      // 规范要求：非管理员时也在 note 中说明权限影响
      note: env.elevated
        ? '系统级蓝屏转储，删除需要管理员权限'
        : '系统级蓝屏转储：当前非管理员权限，可能无法完整枚举或删除',
    },
  ]
}

/**
 * 任务 B 的来源：系统更新缓存与日志。
 * 注意：`%windir%\Prefetch` 已由 temp 插件负责，此处刻意不包含。
 */
function updateCacheSources(env: TaskEnv): Source[] {
  return [
    {
      key: 'wu-download',
      label: 'Windows 更新下载缓存',
      path: path.join(env.windowsDir, 'SoftwareDistribution', 'Download'),
      note: '清理后 Windows Update 会按需重新下载',
    },
    {
      key: 'cbs',
      label: '组件安装日志（CBS）',
      path: path.join(env.windowsDir, 'Logs', 'CBS'),
      note: '组件安装日志，用于排查更新失败',
    },
    {
      key: 'dism',
      label: 'DISM 日志',
      path: path.join(env.windowsDir, 'Logs', 'DISM'),
      note: 'DISM 镜像维护日志',
    },
    {
      key: 'windows-update',
      label: 'Windows 更新日志',
      path: path.join(env.windowsDir, 'Logs', 'WindowsUpdate'),
      note: '更新客户端日志',
    },
    {
      key: 'panther',
      label: '系统安装日志（Panther）',
      path: path.join(env.windowsDir, 'Panther'),
      note: '系统安装与升级过程的日志',
    },
  ]
}

/** 构造一条清理项的公共 meta */
function itemMeta(source: Source, mode: 'file' | 'directory', extra?: Record<string, unknown>) {
  return { source: source.key, label: source.label, mode, ...extra }
}

/**
 * 扫描一个只收特定后缀的转储目录（CrashDumps / Minidump）。
 * 目录不存在时静默跳过；权限不足时通过 addError 降级记录。
 */
async function scanDumpDirectory(scan: TaskScanContext, source: Source): Promise<void> {
  let emitted = 0
  for await (const entry of walk(source.path, {
    maxDepth: 1,
    signal: scan.signal,
    onError: (target, error) => scan.addError({ path: target, message: errorMessage(error) }),
  })) {
    if (entry.isDirectory) continue
    if (source.extension && !entry.name.toLowerCase().endsWith(source.extension)) continue
    if (emitted >= MAX_DUMP_FILES) {
      scan.addError({ path: source.path, message: `转储文件超过上限（${MAX_DUMP_FILES}），已截断` })
      break
    }
    emitted++
    scan.emit({
      path: entry.path,
      size: entry.size,
      kind: 'file',
      note: source.note,
      meta: itemMeta(source, 'file', { mtime: entry.mtimeMs }),
    })
  }
}

/**
 * 扫描一个 Windows 错误报告（WER）目录。
 *
 * 规范要求：WER 目录下的文件全部上报；若条目超过 500，则按目录聚合为
 * `kind: 'directory'` 项，并在 note 中说明「目录内 N 个文件」。
 * 直接位于 WER 根目录下的文件始终按文件项上报 —— 不能把 WER 根目录本身
 * 当作清理项，否则会删除整个错误报告仓库。
 */
async function scanWerDirectory(scan: TaskScanContext, source: Source): Promise<void> {
  const files: Array<{ path: string; size: number }> = []
  let walked = 0
  for await (const entry of walk(source.path, {
    maxDepth: 8,
    maxEntries: WER_MAX_ENTRIES,
    signal: scan.signal,
    onError: (target, error) => scan.addError({ path: target, message: errorMessage(error) }),
  })) {
    walked++
    if (entry.isDirectory) continue
    files.push({ path: entry.path, size: entry.size })
  }
  if (!files.length) return
  if (walked >= WER_MAX_ENTRIES) {
    scan.addError({
      path: source.path,
      message: `条目超过枚举上限（${WER_MAX_ENTRIES}），仅统计前 ${files.length} 个文件`,
    })
  }

  // ① 文件数量在阈值内：逐文件上报
  if (files.length <= WER_AGGREGATE_THRESHOLD) {
    for (const file of files) {
      scan.emit({
        path: file.path,
        size: file.size,
        kind: 'file',
        note: source.note,
        meta: itemMeta(source, 'file'),
      })
    }
    return
  }

  // ② 文件过多：按一级父目录聚合，避免一次扫描产出上万个清理项
  const rootKey = pathKey(source.path)
  const groups = new Map<string, { files: number; bytes: number }>()
  const rootFiles: Array<{ path: string; size: number }> = []
  for (const file of files) {
    const parent = parentPath(file.path)
    if (pathKey(parent) === rootKey) {
      rootFiles.push(file)
      continue
    }
    const group = groups.get(parent) ?? { files: 0, bytes: 0 }
    group.files++
    group.bytes += file.size
    groups.set(parent, group)
  }

  let emitted = 0
  const covered: string[] = []
  for (const [dir, group] of groups) {
    if (emitted >= WER_MAX_ITEMS) break
    // 父目录已被聚合上报时，跳过其子目录，避免「重复删除 / 第二次删除失败」
    if (covered.some((parent) => isSubPath(parent, dir))) continue
    emitted++
    covered.push(dir)
    scan.emit({
      path: dir,
      size: group.bytes,
      kind: 'directory',
      note: `${source.note ? `${source.note}；` : ''}目录内 ${group.files} 个文件`,
      meta: itemMeta(source, 'directory', { files: group.files }),
    })
  }
  // 根目录下的零散文件仍按文件项上报（不能删除 WER 根目录本身）
  for (const file of rootFiles) {
    if (emitted >= WER_MAX_ITEMS) break
    emitted++
    scan.emit({
      path: file.path,
      size: file.size,
      kind: 'file',
      note: source.note,
      meta: itemMeta(source, 'file'),
    })
  }
  if (groups.size + rootFiles.length > emitted) {
    scan.addError({ path: source.path, message: `清理项超过上限（${WER_MAX_ITEMS}），已截断` })
  }
}

/**
 * 扫描一个更新缓存 / 日志目录。
 * 一级子目录整体按 `kind: 'directory'` 聚合（用 folderSize 统计），
 * 直接位于根目录下的文件按文件项上报，总条目不超过 MAX_UPDATE_ITEMS。
 */
async function scanUpdateSource(scan: TaskScanContext, source: Source): Promise<number> {
  let emitted = 0
  for await (const entry of walk(source.path, {
    maxDepth: 1,
    signal: scan.signal,
    onError: (target, error) => scan.addError({ path: target, message: errorMessage(error) }),
  })) {
    if (emitted >= MAX_UPDATE_ITEMS) return emitted
    if (entry.isDirectory) {
      const size = await folderSize(entry.path, {
        signal: scan.signal,
        onError: (target, error) => scan.addError({ path: target, message: errorMessage(error) }),
      })
      // 完全空的子目录没有可释放空间，不上报（避免产出 0 字节的噪声项）
      if (!size.files && !size.dirs) continue
      emitted++
      scan.emit({
        path: entry.path,
        size: size.bytes,
        kind: 'directory',
        defaultSelected: false,
        note: `${size.files} 个文件${source.note ? `；${source.note}` : ''}`,
        meta: itemMeta(source, 'directory', { files: size.files, dirs: size.dirs }),
      })
      continue
    }
    emitted++
    scan.emit({
      path: entry.path,
      size: entry.size,
      kind: 'file',
      defaultSelected: false,
      note: source.note,
      meta: itemMeta(source, 'file', { mtime: entry.mtimeMs }),
    })
  }
  return emitted
}

export default defineCleanerPlugin({
  name: 'system-logs',
  version: '1.0.0',
  description: '崩溃转储、Windows 错误报告、系统更新缓存与安装/更新日志',
  inject: ['cleaner', 'pathPolicy', 'system'],
  setup(ctx) {
    const env = ctx.system.env
    const crashSources = crashDumpSources(env)
    const updateSources = updateCacheSources(env)

    // 声明清理辖区：只有这些目录下的路径才允许被本插件删除（安全阀）
    ctx.effect(() => {
      const disposers = [...crashSources, ...updateSources].map((source) =>
        ctx.pathPolicy.addRoot(source.path, 'system-logs'),
      )
      return () => disposers.forEach((dispose) => dispose())
    })

    // 任务 A：崩溃转储与错误报告
    ctx.effect(() =>
      ctx.cleaner.define({
        id: 'crash-dumps',
        name: '崩溃转储与错误报告',
        description: '应用崩溃转储（.dmp）、Windows 错误报告归档与队列、系统小型转储',
        category: 'system',
        risk: 'safe',
        icon: '💥',
        defaultSelected: true,
        estimatedMs: 3000,
        targets: crashSources.map((source) => source.path),
        tips: [
          '崩溃转储用于分析蓝屏与程序崩溃，删除后无法再回看',
          'Windows 错误报告（WER）归档与队列可安全清理',
          '系统小型转储位于 %windir%\\Minidump，删除需要管理员权限',
        ],
        async scan(scan) {
          for (const source of crashSources) {
            scan.throwIfAborted()
            if (!(await exists(source.path))) continue
            if (source.wer) await scanWerDirectory(scan, source)
            else await scanDumpDirectory(scan, source)
          }
        },
      }),
    )

    // 任务 B：系统更新缓存与日志
    ctx.effect(() =>
      ctx.cleaner.define({
        id: 'update-cache',
        name: '系统更新缓存与日志',
        description: 'Windows Update 下载缓存、CBS/DISM 更新日志与系统安装日志（Panther）',
        category: 'system',
        risk: 'caution',
        icon: '🪵',
        defaultSelected: false,
        estimatedMs: 5000,
        targets: updateSources.map((source) => source.path),
        tips: [
          '清理后 Windows Update 会按需重新下载所需文件',
          'CBS/DISM 日志用于排查更新失败，一般可安全删除',
          '需要管理员权限才能清理 %windir% 下的目录，权限不足时会跳过并记录',
          'Prefetch 预读文件由「临时文件」任务负责，不在此重复',
        ],
        async scan(scan) {
          let emitted = 0
          for (const source of updateSources) {
            scan.throwIfAborted()
            if (emitted >= MAX_UPDATE_ITEMS) break
            if (!(await exists(source.path))) continue
            emitted += await scanUpdateSource(scan, source)
          }
          if (emitted >= MAX_UPDATE_ITEMS) {
            scan.addError({ message: `清理项超过上限（${MAX_UPDATE_ITEMS}），已截断`, path: env.windowsDir })
          }
        },
      }),
    )
  },
})
