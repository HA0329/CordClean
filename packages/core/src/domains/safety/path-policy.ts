/**
 * 路径策略服务（安全阀）。
 *
 * 这是整个清理工具的「最后一道防线」：无论插件报告了什么路径，
 * 内核在真正删除之前都会调用 `check()`。策略包含四部分：
 *
 * 1. **保护根（protected）**：系统关键目录与用户重要目录，任何情况都不允许删除；
 *    既不允许删除其内部文件，也不允许删除它们的祖先目录。
 * 2. **允许根（allow）**：插件在加载时通过 `addRoot()` 声明自己的「清理辖区」，
 *    只有落在辖区内的路径才被允许清理 —— 插件无法越权清理未声明的目录。
 * 3. **名称黑名单**：pagefile.sys、NTUSER.DAT 等系统关键文件。
 * 4. **路径规范化**：去掉 Windows 会静默忽略的尾部 `.`/空格，并把 8.3 短名纳入保护，
 *    防止 `C:\Windows\System32.`、`PROGRA~1` 之类的写法绕过字符串比较。
 *
 * 性能说明：校验会被每次扫描/清理调用（万级 QPS），而 Cordis 服务实例是代理对象，
 * 方法内部每个 `this.x` 访问都会经过代理拦截（实测 ~4µs/次）。因此这里把热路径
 * 抽成「纯对象 + 模块级函数」，类方法只做一次委托，避免代理开销进入循环。
 */
import { Service, type Context } from 'cordis'
import type { PathPolicyCheck, PathPolicyLike } from '@cordclean/shared'
import { basename } from '@cordclean/shared'
import { canonicalizePath, isAbsolutePath, normalizePath, pathKey } from '@cordclean/utils'
import { expandShortNames } from '../../short-names.ts'

export interface PathPolicyConfig {
  /** 额外的保护目录（测试用） */
  extraProtected?: string[]
  /** 是否解析 8.3 短文件名并加入保护列表（默认 true） */
  resolveShortNames?: boolean
}

/**
 * 保护目录的前缀树节点。
 *
 * 用「按路径段建树」代替「遍历 N 个保护目录做字符串比较」：
 * 校验一条路径只需沿树走 4~6 步，复杂度从 O(保护目录数) 降到 O(路径深度)。
 */
interface ProtectedNode {
  children: Map<string, ProtectedNode>
  /** 该节点自身是一个保护目录 */
  root?: string
  /** 子树中是否包含保护目录 */
  hasRootBelow: boolean
}

/** 热路径状态：避开 Cordis 服务代理，纯对象访问 */
interface HotState {
  trie: ProtectedNode
  deniedNames: Set<string>
  allowRoots: Map<string, number>
  userRoots: Map<string, number>
  /** 清空白名单：允许清空这些目录的内容（目录本身受保护） */
  clearRoots: Map<string, number>
  settingsRootKeys: string[]
  shortNamesEnabled: boolean
  shortNamesResolved: boolean
  /** 保护目录原始列表（诊断用） */
  protectedRoots: string[]
  rebuildProtected(): void
}

/** 8.3 短名解析器（可注入，便于测试） */
export type ShortNameResolver = (paths: string[]) => string[]

/* ------------------------------------------------------------------ */
/* 纯函数热路径                                                        */
/* ------------------------------------------------------------------ */

function firstRootBelow(node: ProtectedNode): string | undefined {
  if (node.root) return node.root
  for (const child of node.children.values()) {
    const found = firstRootBelow(child)
    if (found) return found
  }
  return undefined
}

/** 沿前缀树查找命中的保护目录（含「路径是保护目录祖先」的情况） */
function findProtectedKey(hot: HotState, key: string): string | undefined {
  if (hot.shortNamesEnabled && !hot.shortNamesResolved) hot.rebuildProtected()
  let node = hot.trie
  for (const segment of key.split('\\')) {
    if (!segment) continue
    const next = node.children.get(segment)
    if (!next) return undefined
    node = next
    if (node.root) return node.root
  }
  return node.hasRootBelow ? firstRootBelow(node) : undefined
}

/** 是否位于「允许根」内；返回命中的最长根键 */
function rootOfKey(hot: HotState, key: string): string | undefined {
  let best: string | undefined
  const consider = (rootKey: string) => {
    if (key === rootKey || key.startsWith(rootKey.endsWith('\\') ? rootKey : rootKey + '\\')) {
      if (!best || rootKey.length > best.length) best = rootKey
    }
  }
  for (const rootKey of hot.allowRoots.keys()) consider(rootKey)
  for (const rootKey of hot.userRoots.keys()) consider(rootKey)
  // 设置中的自定义扫描根（缓存键，避免每次校验都走 ctx 代理）
  for (let i = 0; i < hot.settingsRootKeys.length; i++) consider(hot.settingsRootKeys[i])
  return best
}

/** 是否位于某个清空白名单目录内（含自身） */
function clearRootOf(hot: HotState, key: string): string | undefined {
  let best: string | undefined
  for (const rootKey of hot.clearRoots.keys()) {
    if (key === rootKey || key.startsWith(rootKey.endsWith('\\') ? rootKey : rootKey + '\\')) {
      if (!best || rootKey.length > best.length) best = rootKey
    }
  }
  return best
}

/**
 * 清空白名单校验：允许删除「受保护目录内部的内容」，但目录本身仍然受保护。
 *
 * 这是 PC-Cleaner 的 clear-under-protected 白名单机制：
 * `C:\Windows\System32\LogFiles` 不能删，但可以清空其内容。
 * 因此该函数只对**已登记为 clearRoot 的目录本身**放行，不做递归放行。
 */
function checkClearPath(hot: HotState, target: string): PathPolicyCheck {
  const normalized = normalizePath(target)
  if (!normalized) return { allowed: false, reason: 'outside', detail: '空路径' }
  if (!isAbsolutePath(normalized)) return { allowed: false, reason: 'outside', detail: '非绝对路径' }
  const path = canonicalizePath(normalized)
  if (/^[a-zA-Z]:\\?$/.test(path)) return { allowed: false, reason: 'protected', detail: '驱动器根目录' }
  const key = path.toLowerCase()
  const root = clearRootOf(hot, key)
  if (!root) return { allowed: false, reason: 'outside', detail: '不在清空白名单内' }
  const name = basename(path).toLowerCase()
  if (hot.deniedNames.has(name)) return { allowed: false, reason: 'name-denied', detail: name }
  return { allowed: true, detail: root }
}

/** 核心校验（热路径） */
function checkPath(hot: HotState, target: string): PathPolicyCheck {
  const normalized = normalizePath(target)
  if (!normalized) return { allowed: false, reason: 'outside', detail: '空路径' }
  if (!isAbsolutePath(normalized)) {
    return { allowed: false, reason: 'outside', detail: '非绝对路径' }
  }
  // 去掉每段末尾的 `.` 与空格（Windows 会静默忽略，字符串比较不会）
  const path = canonicalizePath(normalized)
  // 盘符根目录永远不允许（C:\ 之类）
  if (/^[a-zA-Z]:\\?$/.test(path)) {
    return { allowed: false, reason: 'protected', detail: '驱动器根目录' }
  }
  const key = path.toLowerCase()
  const protectedRoot = findProtectedKey(hot, key)
  if (protectedRoot) {
    return { allowed: false, reason: 'protected', detail: protectedRoot }
  }
  const name = basename(path).toLowerCase()
  if (hot.deniedNames.has(name)) {
    return { allowed: false, reason: 'name-denied', detail: name }
  }
  if (!rootOfKey(hot, key)) {
    return { allowed: false, reason: 'outside', detail: '不在允许清理的目录范围内' }
  }
  return { allowed: true }
}

/* ------------------------------------------------------------------ */
/* 服务实现                                                            */
/* ------------------------------------------------------------------ */

export class PathPolicyService extends Service implements PathPolicyLike {
  static inject = ['settings', 'system']

  private hot: HotState
  private shortNameResolver: ShortNameResolver

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

    this.shortNameResolver = expandShortNames
    const hot: HotState = {
      trie: { children: new Map(), hasRootBelow: false },
      deniedNames: new Set([
        'ntuser.dat',
        'ntuser.ini',
        'bootmgr',
        'bootnxt',
        'bcd',
        'pagefile.sys',
        'hiberfil.sys',
        'swapfile.sys',
        'desktop.ini',
      ]),
      allowRoots: new Map(),
      userRoots: new Map(),
      clearRoots: new Map(),
      settingsRootKeys: [],
      shortNamesEnabled: config.resolveShortNames !== false,
      shortNamesResolved: false,
      protectedRoots: candidates.filter(Boolean).map((item) => normalizePath(item)),
      rebuildProtected: () => this.rebuildProtected(hot),
    }
    this.hot = hot
    this.rebuildProtected(hot)

    // 用户自定义扫描根（持久化在设置中）
    for (const root of ctx.settings.get().analysis.roots) {
      if (root) hot.userRoots.set(pathKey(root), 1)
    }
    this.refreshSettingsRoots(hot)
    // 设置变更时刷新缓存（用户新增扫描目录后立即生效）
    ctx.effect(() => ctx.settings.onChange(() => this.refreshSettingsRoots(hot)))
  }

  /* ------------------------- 供热路径使用的绑定方法 ------------------------- */

  readonly check = (target: string): PathPolicyCheck => checkPath(this.hot, target)

  readonly isProtected = (target: string): boolean =>
    findProtectedKey(this.hot, canonicalizePath(target).toLowerCase()) !== undefined

  readonly containsProtected = (target: string): boolean =>
    findProtectedKey(this.hot, canonicalizePath(target).toLowerCase()) !== undefined

  /** 找出路径命中的「允许根」（用于删除前检查链接祖先） */
  readonly rootOf = (target: string): string | undefined =>
    rootOfKey(this.hot, canonicalizePath(target).toLowerCase())

  /** 清空白名单校验（允许清空受保护目录的内容） */
  readonly checkClear = (target: string): PathPolicyCheck => checkClearPath(this.hot, target)

  /* ------------------------------ 维护类 API ------------------------------ */

  /**
   * 登记「只允许清空内容、不允许删除目录本身」的目录。
   *
   * 用于 `C:\Windows\System32\LogFiles`、`%WINDIR%\Temp` 这类
   * 「目录受保护但内容可重建」的场景，对应 PC-Cleaner 的 clear 白名单。
   *
   * 安全约束：不允许登记保护根本身（等于允许清空整个 Windows/用户目录），
   * 也不允许登记任何保护根的祖先目录；只接受绝对路径/UNC。
   */
  addClearRoot(target: string, source?: string): () => void {
    const normalized = normalizePath(target)
    const key = pathKey(normalized)
    if (!key) return () => {}
    if (!/^[a-zA-Z]:\\/.test(normalized) && !normalized.startsWith('\\\\')) {
      this.ctx.logger?.warn?.('清空白名单只接受绝对路径，已忽略：%s', target)
      return () => {}
    }
    // 盘符根（允许根的最上层）永远不能进入清空白名单
    if (/^[a-zA-Z]:\\?$/.test(normalized)) {
      this.ctx.logger?.warn?.('拒绝把盘符根登记为清空白名单（来源 %s）：%s', source ?? 'unknown', target)
      return () => {}
    }
    const keyBase = key.replace(/\\+$/, '')
    for (const root of this.hot.protectedRoots) {
      const rootKey = pathKey(root).replace(/\\+$/, '')
      if (!rootKey) continue
      // 保护根本身，或保护根的祖先：登记后会放大清空范围，一律拒绝
      if (rootKey === keyBase || rootKey.startsWith(keyBase + '\\')) {
        this.ctx.logger?.warn?.('拒绝登记清空白名单（会覆盖保护目录 %s，来源 %s）：%s', root, source ?? 'unknown', target)
        return () => {}
      }
    }
    const roots = this.hot.clearRoots
    roots.set(key, (roots.get(key) ?? 0) + 1)
    return () => {
      const count = roots.get(key) ?? 0
      if (count <= 1) roots.delete(key)
      else roots.set(key, count - 1)
    }
  }

  /** 声明一个允许清理的根目录，返回撤销函数（通常由插件在 apply 中调用） */
  addRoot(target: string, _source?: string): () => void {
    const key = pathKey(target)
    if (!key) return () => {}
    const roots = this.hot.allowRoots
    roots.set(key, (roots.get(key) ?? 0) + 1)
    return () => {
      const count = roots.get(key) ?? 0
      if (count <= 1) roots.delete(key)
      else roots.set(key, count - 1)
    }
  }

  /** 添加用户扫描根（大文件/重复文件等「按用户选择范围分析」的场景） */
  addUserRoot(target: string): () => void {
    const key = pathKey(target)
    if (!key) return () => {}
    const roots = this.hot.userRoots
    roots.set(key, (roots.get(key) ?? 0) + 1)
    return () => {
      const count = roots.get(key) ?? 0
      if (count <= 1) roots.delete(key)
      else roots.set(key, count - 1)
    }
  }

  /** 当前所有允许根（含清空白名单） */
  roots(): string[] {
    return [...new Set([...this.hot.allowRoots.keys(), ...this.hot.userRoots.keys(), ...this.hot.clearRoots.keys()])]
  }

  /** 仅供测试/诊断：列出保护目录 */
  protected(): string[] {
    return [...this.hot.protectedRoots]
  }

  /** 仅供测试：替换短名解析器并重置解析状态 */
  setShortNameResolver(resolver: ShortNameResolver): void {
    this.shortNameResolver = resolver
    this.hot.shortNamesResolved = false
    this.rebuildProtected(this.hot)
  }

  /** 解析 8.3 短名并重建前缀树（首次校验时触发，cmd.exe 约 30~40ms） */
  private rebuildProtected(hot: HotState): void {
    if (hot.shortNamesEnabled && !hot.shortNamesResolved) {
      hot.shortNamesResolved = true
      try {
        const aliases = this.shortNameResolver?.(hot.protectedRoots) ?? []
        for (const alias of aliases) {
          const normalized = normalizePath(alias)
          if (normalized && !hot.protectedRoots.includes(normalized)) hot.protectedRoots.push(normalized)
        }
      } catch {
        /* 短名解析失败不影响主流程 */
      }
    }

    const top: ProtectedNode = { children: new Map(), hasRootBelow: false }
    for (const root of hot.protectedRoots) {
      const segments = pathKey(root).split('\\').filter(Boolean)
      let node = top
      for (const segment of segments) {
        let next = node.children.get(segment)
        if (!next) {
          next = { children: new Map(), hasRootBelow: false }
          node.children.set(segment, next)
        }
        node = next
      }
      node.root = root
    }
    // 自底向上标注「子树中含保护目录」
    const mark = (node: ProtectedNode): boolean => {
      let has = !!node.root
      for (const child of node.children.values()) {
        if (mark(child)) has = true
      }
      node.hasRootBelow = has
      return has
    }
    mark(top)
    hot.trie = top
  }

  /** 刷新「设置中的自定义扫描根」缓存 */
  private refreshSettingsRoots(hot: HotState): void {
    const roots = this.ctx.settings.get().analysis.roots ?? []
    hot.settingsRootKeys = roots.filter((root) => !!root).map((root) => canonicalizePath(root).toLowerCase())
  }
}
