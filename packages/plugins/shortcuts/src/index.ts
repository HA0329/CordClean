/**
 * 失效快捷方式清理插件（shortcuts）。
 *
 * ## 设计要点：删的是「指针」，不是目标
 * `.lnk` 文件本身只是一个指向目标的快捷方式文件（几 KB 的普通文件，`kind: 'file'`），
 * 删除它**不会**影响任何被指向的程序、文档或目录 —— 目标文件仍然原样存在。
 * 这也是本任务虽然标为 `risky`（用户会失去一个入口）却仍然安全的前提：
 * 扫描/清理的每一个路径都是 `.lnk` 自身，绝不对解析出来的目标路径做任何写操作。
 *
 * ## 判定边界（四档：跳过 / 死链）
 * 只有「解析出确定是文件系统路径 + 盘符在线 + 目标确实不存在」才上报为死链，
 * 其余情况一律跳过，宁可漏报也不误删：
 * 1. `url`（http/https/ftp/mailto）：网络不可达 != 快捷方式失效；
 * 2. `shell`（此电脑 / 回收站 / UWP 入口等 Shell 命名空间项）：没有文件系统路径可查；
 * 3. `unknown`（结构损坏、截断、ANSI 编码不可信）：无法确证目标；
 * 4. UNC 网络路径、无盘符的相对路径：网络盘离线性无法可靠判定；
 * 5. 盘符根目录都不存在（离线盘 / 未挂载）：目标「查不到」不代表「被删除」；
 * 6. 目标存在：不是死链。
 *
 * ## 扫描范围
 * - `%APPDATA%\Microsoft\Windows\Start Menu\Programs`（当前用户开始菜单）
 * - `%PROGRAMDATA%\Microsoft\Windows\Start Menu\Programs`（所有用户开始菜单，存在时）
 * - 桌面：`%USERPROFILE%\Desktop` 与 `%PUBLIC%\Desktop`（`includeDesktop` 控制）
 * - `%APPDATA%\Microsoft\Internet Explorer\Quick Launch`（快速启动栏）
 *
 * 「启动（Startup）」文件夹默认排除：其中的快捷方式属于自启动项，应由 startup 插件
 * 统一管理，两个插件重复上报同一文件会让用户看到重复项。
 *
 * ## 与内核路径策略的关系
 * 桌面、开始菜单、`%APPDATA%`、`%PROGRAMDATA%` 在内核的路径策略里默认属于「保护根」，
 * 因此本插件上报的项会被内核标记为 `protected`，最终能否真正删除由内核策略决定。
 * 插件只负责「发现死链」，不绕过、也不尝试绕过路径策略。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import Schema from 'schemastery'
import { defineCleanerPlugin } from '@cordclean/shared'
import type { TaskEnv, TaskScanContext } from '@cordclean/shared'
import { driveOf, errorMessage, exists, isAbsolutePath, normalizePath, toLongPath, walk } from '@cordclean/utils'
import { parseLnkTarget } from './lnk.ts'
import type { LnkTargetKind } from './lnk.ts'

/** 单个 .lnk 允许读取的最大字节数（正常快捷方式只有几 KB；超过 1MB 视为异常文件） */
const MAX_LNK_BYTES = 1024 * 1024

/** 快捷方式最多递归的目录深度（开始菜单树较深，6 层足够覆盖常见结构） */
const MAX_SCAN_DEPTH = 6

/** 单个扫描目录最多枚举的条目数（防止异常巨型目录拖垮界面） */
const MAX_ENTRIES = 20_000

export interface ShortcutsConfig {
  /** 是否扫描「启动」文件夹（默认 false：启动项由 startup 插件负责） */
  includeStartup: boolean
  /** 是否扫描桌面（当前用户桌面 + 公共桌面） */
  includeDesktop: boolean
}

const Config = Schema.object({
  includeStartup: Schema.boolean()
    .default(false)
    .description('同时检查「启动」文件夹中的快捷方式（默认排除：启动项由启动项管理插件负责）'),
  includeDesktop: Schema.boolean().default(true).description('检查桌面上的快捷方式（当前用户桌面 + 公共桌面）'),
})

/** 候选扫描目录（是否存在由 setup 阶段过滤） */
function candidateDirs(env: TaskEnv, config: ShortcutsConfig): string[] {
  const list: string[] = [
    path.join(env.appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(env.programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  ]
  if (config.includeDesktop) {
    // 公共桌面：优先读 %PUBLIC%，没有该变量时按 Windows 默认位置拼一个（不存在会被过滤掉）
    const publicRoot = env.get('PUBLIC') || `${env.systemDrive}\\Users\\Public`
    list.push(path.join(env.userProfile, 'Desktop'))
    list.push(path.join(publicRoot, 'Desktop'))
  }
  list.push(path.join(env.appData, 'Microsoft', 'Internet Explorer', 'Quick Launch'))
  return list
}

/** 扫描过但被跳过的原因（用于统计与调试日志） */
export type ShortcutSkipReason =
  | 'url'
  | 'shell'
  | 'unknown'
  | 'relative-target'
  | 'network'
  | 'offline-drive'
  | 'target-exists'
  | 'unresolved-env'
  | 'empty-target'

/** 判定结果的原因；`missing-target` 是本插件唯一会上报的状态 */
export type ShortcutReason = ShortcutSkipReason | 'missing-target'

/** 单个快捷方式的判定结果 */
export interface ShortcutClassification {
  /** 被检查的 .lnk 路径（仅用于日志/断言，不参与判定） */
  lnkPath: string
  /** `broken` 才会被上报为清理项，`skip` 表示不判定 */
  verdict: 'broken' | 'skip'
  reason: ShortcutReason
  /** 解析出的目标类型 */
  kind: LnkTargetKind
  /** 目标路径（`file` 时为已展开环境变量、规范化后的路径；其余为解析原文或空串） */
  target: string
}

/** 环境变量访问器（与 TaskEnv 的 get 兼容，测试可直接注入 Map） */
export interface ShortcutEnv {
  get(name: string): string | undefined
}

export interface ClassifyShortcutOptions {
  /** .lnk 文件内容（调用方负责限制大小） */
  buffer: Buffer
  /** .lnk 的绝对路径 */
  lnkPath: string
  /** 用于展开目标路径中的 %VAR% */
  env: ShortcutEnv
  /** 目标存在性检查，默认使用 @cordclean/utils 的 exists；测试可注入 */
  exists?(target: string): Promise<boolean>
}

/* ------------------------------------------------------------------ */
/* 纯函数：目录与过滤                                                   */
/* ------------------------------------------------------------------ */

/**
 * 目录遍历过滤器（walk 的 shouldEnter）。
 * - `Windows Apps`：系统为 UWP 应用自动生成的入口目录，目标是 shell:AppsFolder，
 *   删掉也会被系统重建，没有清理价值；
 * - `Startup`：自启动项，默认不扫描（`includeStartup` 为 true 时保留），
 *   避免与 startup 插件重复上报同一个快捷方式。
 */
function shouldEnter(dir: string, includeStartup: boolean): boolean {
  const name = dir.slice(dir.lastIndexOf('\\') + 1).toLowerCase()
  if (name === 'windows apps') return false
  if (!includeStartup && name === 'startup') return false
  return true
}

/** 展开路径中的 `%VAR%`；返回是否出现无法解析的变量 */
function expandEnv(input: string, env: ShortcutEnv): { value: string; unresolved: boolean } {
  let unresolved = false
  const value = input.replace(/%([^%]+)%/g, (_all, name: string) => {
    const found = env.get(String(name))
    if (found === undefined) {
      unresolved = true
      return ''
    }
    return found
  })
  return { value, unresolved }
}

/** 盘符根（如 `C:\`） */
const DRIVE_ROOT_PATTERN = /^[a-zA-Z]:\\$/

/**
 * 默认的目标存在性检查。
 *
 * 正常路径直接复用 `@cordclean/utils` 的 `exists()`（内部用 `\\?\` 长路径前缀）。
 * 唯一的例外是「盘符根」：`exists('C:\\')` 会访问 `\\?\C:\`，而 Windows 对带尾斜杠的
 * 驱动器根返回 EISDIR，会被当成「不存在」，进而把所有在线磁盘误判成离线盘。
 * 因此盘符根改用不带长路径前缀的 `fs.stat` 探测。
 */
async function defaultExists(target: string): Promise<boolean> {
  if (!DRIVE_ROOT_PATTERN.test(target)) return exists(target)
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}

/**
 * 判定一个快捷方式是死链还是应跳过（全部是纯逻辑，不读文件系统）。
 *
 * 判定顺序：类型 → 环境变量 → UNC/相对路径 → 盘符在线 → 目标存在性。
 * 任何一步无法确证「目标确实被删除」都返回 skip，只有走完全部检查仍不存在才返回 broken。
 */
export async function classifyShortcut(options: ClassifyShortcutOptions): Promise<ShortcutClassification> {
  const targetExists = options.exists ?? defaultExists
  const parsed = parseLnkTarget(options.buffer)
  const base: ShortcutClassification = {
    lnkPath: options.lnkPath,
    verdict: 'skip',
    reason: 'unknown',
    kind: parsed.kind,
    target: parsed.target ?? '',
  }

  // ① url / shell / unknown：结构上就不参与死链判定（理由见文件头注释）
  if (parsed.kind === 'url') return { ...base, reason: 'url' }
  if (parsed.kind === 'shell') return { ...base, reason: 'shell' }
  if (parsed.kind !== 'file' || !parsed.target) return { ...base, reason: 'unknown' }

  // ② 展开 %VAR%：含无法解析的变量时路径不可信，跳过（空串会导致误判）
  const expanded = expandEnv(parsed.target, options.env)
  if (expanded.unresolved) return { ...base, reason: 'unresolved-env' }
  const raw = expanded.value.trim()
  if (!raw) return { ...base, reason: 'empty-target' }

  // ③ UNC 网络路径：不判定（网络盘离线/掉线不等于快捷方式失效）。
  //    注意必须在 normalizePath 之前判断：它会折叠重复反斜杠，把 `\\server` 变成 `\server`。
  if (/^\\\\/.test(raw) || /^\/\//.test(raw)) return { ...base, target: raw, reason: 'network' }
  const target = normalizePath(raw)
  if (!isAbsolutePath(target)) return { ...base, target, reason: 'relative-target' }
  const drive = driveOf(target)
  if (!drive) return { ...base, target, reason: 'network' }

  // ④ 盘符根目录不存在 → 离线盘/未挂载（如拔掉的移动硬盘），不能判成死链
  if (!(await targetExists(`${drive}\\`))) return { ...base, target, reason: 'offline-drive' }

  // ⑤ 目标还在 → 不是死链；确实不存在 → 死链
  if (await targetExists(target)) return { ...base, target, reason: 'target-exists' }
  return { ...base, target, verdict: 'broken', reason: 'missing-target' }
}

/* ------------------------------------------------------------------ */
/* 扫描                                                                */
/* ------------------------------------------------------------------ */

/**
 * 扫描一个目录下（递归）的所有 .lnk，把死链作为清理项上报。
 * 读取失败（权限/占用）通过 addError 降级记录，不让整个任务失败。
 */
async function scanDirectory(
  scan: TaskScanContext,
  dir: string,
  includeStartup: boolean,
  stats: { broken: number; skipped: Record<string, number>; tooLarge: number },
): Promise<void> {
  for await (const entry of walk(dir, {
    maxDepth: MAX_SCAN_DEPTH,
    maxEntries: MAX_ENTRIES,
    signal: scan.signal,
    shouldEnter: (target) => shouldEnter(target, includeStartup),
    onError: (target, error) => scan.addError({ path: target, message: errorMessage(error) }),
  })) {
    if (entry.isDirectory) continue
    // 只处理 .lnk：其它文件（桌面上的文档、图片等）与本任务无关
    if (!entry.name.toLowerCase().endsWith('.lnk')) continue
    if (entry.size > MAX_LNK_BYTES) {
      stats.tooLarge++
      continue
    }

    let buffer: Buffer
    try {
      buffer = await fs.readFile(toLongPath(entry.path))
    } catch (error) {
      scan.addError({ path: entry.path, message: `读取快捷方式失败：${errorMessage(error)}` })
      continue
    }
    if (buffer.length > MAX_LNK_BYTES) {
      stats.tooLarge++
      continue
    }

    const result = await classifyShortcut({ buffer, lnkPath: entry.path, env: scan.env })
    if (result.verdict === 'skip') {
      stats.skipped[result.reason] = (stats.skipped[result.reason] ?? 0) + 1
      continue
    }

    scan.throwIfAborted()
    stats.broken++
    // 只上报 .lnk 文件本身（kind: 'file'），meta.target 仅用于界面展示/审计，
    // 真正的删除目标永远是 item.path，绝不会是目标路径
    scan.emit({
      path: entry.path,
      kind: 'file',
      size: entry.size,
      risk: 'risky',
      defaultSelected: false,
      note: `目标不存在：${result.target}`,
      meta: { target: result.target, action: 'delete' },
    })
  }
}

export default defineCleanerPlugin<ShortcutsConfig>({
  name: 'shortcuts',
  version: '2.0.0',
  description: '清理开始菜单、桌面与快速启动栏中指向已删除程序的失效快捷方式（.lnk 死链）',
  inject: ['cleaner', 'pathPolicy', 'system'],
  Config,
  async setup(ctx, config) {
    const env = ctx.system.env
    // 配置文件中可能残留旧版本字段，这里补齐默认值，避免 undefined 影响判断
    const settings: ShortcutsConfig = {
      includeStartup: config?.includeStartup ?? false,
      includeDesktop: config?.includeDesktop ?? true,
    }

    // 只保留真实存在的目录：不存在时既不登记清理辖区，也不出现在 targets 里
    const dirs: string[] = []
    for (const dir of candidateDirs(env, settings)) {
      if (!(await exists(dir))) continue
      // 声明清理辖区：只有这些目录下的文件才允许被本插件删除
      ctx.effect(() => ctx.pathPolicy.addRoot(dir, 'shortcuts'))
      dirs.push(dir)
    }

    ctx.effect(() =>
      ctx.cleaner.define({
        id: 'broken-shortcuts',
        name: '失效快捷方式',
        description: '检查开始菜单、桌面与快速启动栏中的 .lnk，找出目标已不存在的死链',
        category: 'apps',
        risk: 'risky',
        icon: '🔗',
        defaultSelected: false,
        requiresAdmin: false,
        estimatedMs: 2000,
        targets: dirs,
        tips: [
          '只删除 .lnk 快捷方式文件本身，不会影响它指向的程序或文件',
          '网络路径、离线磁盘与「此电脑/回收站」等系统入口一律跳过，不做判定',
          '「启动」文件夹默认不扫描，避免与启动项管理插件重复',
        ],
        async scan(scan) {
          const stats = { broken: 0, skipped: {} as Record<string, number>, tooLarge: 0 }
          for (const dir of dirs) {
            scan.throwIfAborted()
            await scanDirectory(scan, dir, settings.includeStartup, stats)
          }
          const skipped = Object.entries(stats.skipped)
            .map(([reason, count]) => `${reason}:${count}`)
            .join(' ')
          scan.logger.debug(
            `失效快捷方式：发现 ${stats.broken} 个死链` +
              (skipped ? `，跳过 ${skipped}` : '') +
              (stats.tooLarge ? `，超大文件 ${stats.tooLarge}` : ''),
          )
        },
      }),
    )
  },
})
