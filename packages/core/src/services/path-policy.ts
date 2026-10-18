/**
 * 路径策略服务（安全阀）。
 *
 * 这是整个清理工具的「最后一道防线」：无论插件报告了什么路径，
 * 内核在真正删除之前都会调用 `check()`。策略包含三部分：
 *
 * 1. **保护根（protected）**：系统关键目录与用户重要目录，任何情况都不允许删除；
 *    既不允许删除其内部文件，也不允许删除它们的祖先目录。
 * 2. **允许根（allow）**：插件在加载时通过 `addRoot()` 声明自己的「清理辖区」，
 *    只有落在辖区内的路径才被允许清理 —— 插件无法越权清理未声明的目录。
 * 3. **名称黑名单**：pagefile.sys、NTUSER.DAT 等系统关键文件。
 */
import { Service, type Context } from 'cordis'
import type { PathPolicyCheck, PathPolicyLike } from '@cordclean/shared'
import { basename } from '@cordclean/shared'
import { isAbsolutePath, isSubPath, normalizePath, pathKey } from '@cordclean/utils'

export interface PathPolicyConfig {
  /** 额外的保护目录（测试用） */
  extraProtected?: string[]
}

export class PathPolicyService extends Service implements PathPolicyLike {
  static inject = ['settings', 'system']

  /** 允许清理的根目录（引用计数，支持多个插件声明同一目录） */
  private allowRoots = new Map<string, number>()
  /** 用户显式添加的扫描根（来自设置） */
  private userRoots = new Map<string, number>()
  /** 保护目录 */
  private protectedRoots: string[] = []
  /** 名称黑名单 */
  private deniedNames = new Set<string>([
    'ntuser.dat',
    'ntuser.ini',
    'bootmgr',
    'bootnxt',
    'bcd',
    'pagefile.sys',
    'hiberfil.sys',
    'swapfile.sys',
    'desktop.ini',
  ])

  constructor(ctx: Context, config: PathPolicyConfig = {}) {
    super(ctx, 'pathPolicy')
    const env = ctx.system.env
    const w = env.windowsDir
    const candidates = [
      // Windows 关键目录
      w + '\\System32',
      w + '\\SysWOW64',
      w + '\\WinSxS',
      w + '\\Boot',
      w + '\\servicing',
      w + '\\Installer',
      w + '\\assembly',
      w + '\\Fonts',
      w + '\\System32\\config',
      w + '\\System32\\drivers',
      // 应用程序目录：默认不清理（残留文件由「应用残留」插件只报告不删除）
      env.programFiles,
      env.programFilesX86,
      env.programData,
      // 用户重要目录
      env.userProfile + '\\Desktop',
      env.userProfile + '\\Documents',
      env.userProfile + '\\Pictures',
      env.userProfile + '\\Videos',
      env.userProfile + '\\Music',
      env.userProfile + '\\Downloads',
      env.userProfile + '\\OneDrive',
      // 应用数据目录（Roaming 保存配置，默认不清理）
      env.userProfile + '\\AppData\\Roaming',
      // 系统保留区（回收站本身允许清理：其内容本就是待删除文件）
      env.systemDrive + '\\System Volume Information',
      env.systemDrive + '\\Recovery',
      env.systemDrive + '\\EFI',
      env.systemDrive + '\\Boot',
      ...(config.extraProtected ?? []),
    ]
    // 逐个规范化，过滤空值
    this.protectedRoots = candidates.filter(Boolean).map((item) => normalizePath(item))

    // 用户自定义扫描根（持久化在设置中）
    for (const root of ctx.settings.get().analysis.roots) {
      if (root) this.userRoots.set(pathKey(root), 1)
    }
  }

  /** 声明一个允许清理的根目录，返回撤销函数（通常由插件在 apply 中调用） */
  addRoot(target: string, _source?: string): () => void {
    const key = pathKey(target)
    if (!key) return () => {}
    this.allowRoots.set(key, (this.allowRoots.get(key) ?? 0) + 1)
    return () => {
      const count = this.allowRoots.get(key) ?? 0
      if (count <= 1) this.allowRoots.delete(key)
      else this.allowRoots.set(key, count - 1)
    }
  }

  /** 添加用户扫描根（大文件/重复文件等「按用户选择范围分析」的场景） */
  addUserRoot(target: string): () => void {
    const key = pathKey(target)
    if (!key) return () => {}
    this.userRoots.set(key, (this.userRoots.get(key) ?? 0) + 1)
    return () => {
      const count = this.userRoots.get(key) ?? 0
      if (count <= 1) this.userRoots.delete(key)
      else this.userRoots.set(key, count - 1)
    }
  }

  /** 当前所有允许根 */
  roots(): string[] {
    return [...new Set([...this.allowRoots.keys(), ...this.userRoots.keys()])]
  }

  /** 是否受保护（包括「包含受保护目录」这一祖先情况） */
  isProtected(target: string): boolean {
    return this.findProtected(target) !== undefined
  }

  private findProtected(target: string): string | undefined {
    const path = normalizePath(target)
    for (const root of this.protectedRoots) {
      // 路径位于保护目录内部，或本身就是保护目录、或包含保护目录
      if (isSubPath(root, path) || isSubPath(path, root)) return root
    }
    return undefined
  }

  /** 是否包含受保护子目录（删除目录前必须为 false） */
  containsProtected(target: string): boolean {
    return this.findProtected(target) !== undefined
  }

  private insideAllowed(target: string): boolean {
    const path = normalizePath(target)
    for (const root of this.allowRoots.keys()) {
      if (isSubPath(root, path)) return true
    }
    for (const root of this.userRoots.keys()) {
      if (isSubPath(root, path)) return true
    }
    // 设置中的「自定义扫描范围」实时生效：用户在界面上新增目录后无需重启
    for (const root of this.ctx.settings.get().analysis.roots) {
      if (root && isSubPath(root, path)) return true
    }
    return false
  }

  /** 核心校验 */
  check(target: string): PathPolicyCheck {
    const path = normalizePath(target)
    if (!path) return { allowed: false, reason: 'outside', detail: '空路径' }
    if (!isAbsolutePath(path)) {
      return { allowed: false, reason: 'outside', detail: '非绝对路径' }
    }
    // 盘符根目录永远不允许（C:\ 之类）
    if (/^[a-zA-Z]:\\?$/.test(path)) {
      return { allowed: false, reason: 'protected', detail: '驱动器根目录' }
    }
    const protectedRoot = this.findProtected(path)
    if (protectedRoot) {
      return { allowed: false, reason: 'protected', detail: protectedRoot }
    }
    const name = basename(path).toLowerCase()
    if (this.deniedNames.has(name)) {
      return { allowed: false, reason: 'name-denied', detail: name }
    }
    if (!this.insideAllowed(path)) {
      return { allowed: false, reason: 'outside', detail: '不在允许清理的目录范围内' }
    }
    return { allowed: true }
  }

  /** 仅供测试/诊断：列出保护目录 */
  protected(): string[] {
    return [...this.protectedRoots]
  }
}
