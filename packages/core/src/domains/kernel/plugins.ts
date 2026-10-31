/**
 * 插件管理器（内核服务）。
 *
 * 它把 Cordis 的 `ctx.plugin()` 包装成「可持久化、可热插拔、可容错」的插件单元：
 *
 * - **启停**：`enable()` 加载插件模块并启动 fiber，`disable()` 销毁 fiber；
 * - **热重载**：`reload()` = 销毁 + 重新加载，插件在重载时重新注册自己的清理任务；
 * - **配置持久化**：每个插件的 `enabled` 与 `config` 写入 settings.json；
 * - **故障隔离**：单个插件抛错只标记该插件为 error，不影响其它插件与内核；
 * - **任务归属**：通过「加载前后任务集合求差」自动把任务归属到插件，
 *   插件因此不需要知道自己的 id，也不需要修改内核代码。
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { ExternalPluginProxy } from './external-proxy.ts'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Service, type Context, type Fiber } from 'cordis'
import {
  checkPluginManifestCompatibility,
  checkPluginSource,
  type CategoryId,
  type CleanerPluginModule,
  type PluginManagerLike,
  type PluginManifest,
  type PluginManifestIssue,
  type PluginPackageIssue,
  type PluginPackageReview,
  type PluginRuntimeInfo,
} from '@cordclean/shared'
import { errorMessage, isAbsolutePath, isSubPath } from '@cordclean/utils'
import {
  PLUGIN_PACKAGES_DIR,
  pluginClientEntryRelative,
  scanPluginPackages,
  type PluginPackageScan,
  type ScannedPluginPackage,
} from './plugin-package.ts'
import { cleanupPluginStaging, inspectPluginPackage, installPluginPackage, removePluginPackage } from './plugin-installer.ts'

const AUTO_INJECT_SERVICES = new Set([
  'cleaner',
  'ui',
  'window',
  'settings',
  'system',
  'pathPolicy',
  'rules',
  'evaluator',
  'history',
  'quarantine',
  'compensate',
  'executor',
  'recycleBin',
  'ai',
  'aiContext',
  'egress',
])

function describeNativePlugin(plugin: any): string {
  const explicit = typeof plugin?.description === 'string' ? plugin.description.trim() : ''
  if (explicit) return explicit
  const kind = String(plugin?.kind ?? 'cleaner')
  const cards = Array.isArray(plugin?.contributes?.overviewCards) ? plugin.contributes.overviewCards.length : 0
  const commands = Array.isArray(plugin?.contributes?.commands) ? plugin.contributes.commands.length : 0
  if (kind === 'widget') {
    return cards > 0
      ? `AI 工坊 Widget 插件：贡献 ${cards} 张概览卡片${commands ? `、${commands} 个操作按钮` : '（自动刷新）'}`
      : 'AI 工坊 Widget 插件（未提供卡片说明）'
  }
  if (kind === 'active') return 'AI 工坊主动插件：启用后在后台运行'
  if (kind === 'desktop') return 'AI 工坊桌面插件：可打开悬浮窗/托盘'
  return 'AI 工坊原生插件'
}

/** 去掉注释与字符串字面量，避免把文档里的 ctx.ai 误当成硬依赖 */
function stripPluginLiterals(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n\r]*/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '""')
}

/** 扫描源码里出现的核心服务访问；用于兼容旧 AI 工坊产物缺失 inject 的情况 */
function detectCtxServiceRefs(source: string): string[] {
  const found = new Set<string>()
  const re = /\bctx\.([A-Za-z_$][\w$]*)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(stripPluginLiterals(source)))) {
    if (AUTO_INJECT_SERVICES.has(match[1])) found.add(match[1])
  }
  return [...found]
}

/** 插件清单项 */
export interface PluginManifestEntry {
  id: string
  name: string
  description: string
  category: CategoryId
  version?: string
  /** 默认是否启用 */
  defaultEnabled?: boolean
  /** 懒加载插件模块 */
  load(): Promise<{ default?: CleanerPluginModule } & Record<string, unknown>>
}

export interface PluginCapabilities {
  /** 允许清理/读取的根目录（绝对路径，最多 20 个） */
  fsRoots: string[]
  /** 是否允许发起网络请求（默认 false） */
  network?: boolean
  /** 是否允许起子进程（默认 false） */
  childProcess?: boolean
  /** 是否允许插件自定义清理（默认 false，需安装时显式授权） */
  customClean?: boolean
}

/** 安装前校验外部插件的能力声明与代码是否一致 */
export function validateCapabilities(plugin: any, code: string, allowCustomClean = false): PluginCapabilities {
  const caps = plugin?.capabilities
  if (!caps || typeof caps !== 'object') {
    throw new Error('外部插件必须在 defineCleanerPlugin({ capabilities: { fsRoots: [...] } }) 中声明能力')
  }
  const roots = Array.isArray(caps.fsRoots) ? caps.fsRoots.map(String) : []
  if (roots.length > 20) throw new Error('fsRoots 最多 20 个')
  for (const root of roots) {
    if (!/^[a-zA-Z]:[\\/]/.test(root) && !root.startsWith('\\\\')) throw new Error('fsRoots 必须是绝对路径：' + root)
    if (/^[a-zA-Z]:[\\/]?$/.test(root)) throw new Error('fsRoots 不能是盘符根：' + root)
    if (/^[a-zA-Z]:[\\/](Windows|Program Files|Program Files \(x86\))([\\/]|$)/i.test(root)) {
      throw new Error('fsRoots 不能包含系统目录：' + root)
    }
  }
  const network = caps.network === true
  const childProcess = caps.childProcess === true
  if (!network && /\b(fetch|axios|node:https?|XMLHttpRequest)\b/.test(code)) {
    throw new Error('代码包含网络请求，但未声明 network 能力')
  }
  if (!childProcess && /child_process|execSync|spawnSync/.test(code)) {
    throw new Error('代码包含子进程调用，但未声明 childProcess 能力')
  }
  return { fsRoots: roots, network, childProcess, customClean: caps.customClean === true && allowCustomClean === true }
}

interface RuntimeRecord {
  entry: PluginManifestEntry
  module?: CleanerPluginModule
  fiber?: Fiber
  status: 'active' | 'stopped' | 'error' | 'loading'
  error?: string
  errorStack?: string
  config: Record<string, any>
  taskIds: string[]
  /** 进行中的 enable；disable 必须等它结束再停用，避免停用后又被写回 active */
  enablePromise?: Promise<void>
}

export interface PluginManagerConfig {
  manifest: PluginManifestEntry[]
  /** 宿主版本，用于 v2 插件包的 engines/apiVersion 兼容检查 */
  appVersion?: string
}

/** 从 v2 清单的 kind 推断界面分类（清单暂不单独声明 category） */
function categoryOfManifest(manifest: PluginManifest): CategoryId {
  switch (manifest.kind) {
    case 'active':
      return 'system'
    case 'desktop':
      return 'apps'
    case 'widget':
      return 'apps'
    case 'integration':
      return 'apps'
    case 'cleaner':
      return 'apps'
    default:
      return 'apps'
  }
}

/** v2 插件包的运行时记录 id：与旧版 external:<name> 共用命名空间，避免与内置插件冲突 */
function packagePluginId(manifestId: string): string {
  return 'external:' + manifestId
}

/** cordis 的 FiberState.ACTIVE（const enum 在 isolatedModules 下不能直接引用，这里用等值常量） */
const FIBER_STATE_ACTIVE = 2

/** 从 Schemastery 风格的 Config 推导默认配置 */
export function defaultConfigOf(plugin: any): Record<string, any> {
  const schema = plugin?.Config
  if (!schema) return {}
  try {
    if (typeof schema === 'function') {
      const value = schema({})
      return value && typeof value === 'object' ? value : {}
    }
    const result = schema['~standard']?.validate({})
    if (result && !result.issues && result.value && typeof result.value === 'object') return result.value
  } catch {
    /* 默认值推导失败不应影响插件加载 */
  }
  return {}
}

export class PluginManagerService extends Service implements PluginManagerLike {
  static inject = ['cleaner', 'settings', 'ui', 'window']

  private records = new Map<string, RuntimeRecord>()
  private readonly appVersion: string
  /** 最近一次启动扫描 v2 插件包的结果（供管理页展示问题） */
  private packageScan?: PluginPackageScan

  constructor(ctx: Context, config: PluginManagerConfig) {
    super(ctx, 'plugins')
    this.appVersion = config.appVersion ?? '0.0.0'
    for (const entry of config.manifest) {
      const stored = ctx.settings.get().plugins[entry.id]
      this.records.set(entry.id, {
        entry,
        status: 'stopped',
        config: stored?.config ?? {},
        taskIds: [],
      })
    }
  }

  /** v2 插件包目录（dataDir/plugins） */
  private packagesDir(): string {
    return path.join(path.dirname(this.ctx.settings.file), PLUGIN_PACKAGES_DIR)
  }

  /** 启动时加载全部启用的插件（顺序加载，确保任务归属统计准确） */
  async loadAll(): Promise<void> {
    const settings = this.ctx.settings.get()
    for (const [id, record] of this.records) {
      const stored = settings.plugins[id]
      const enabled = stored?.enabled ?? record.entry.defaultEnabled ?? true
      if (!enabled) continue
      await this.enable(id)
    }
    // v2 插件包（目录 + plugin.json）先扫描登记，再处理旧版单文件外部插件
    await this.loadPackagePlugins()
    // 外部插件（含 AI 工坊生成的插件）在进程内安装，settings 里保存了路径；
    // 启动时按路径重新加载，让“装一次以后一直能用”成立。
    await this.loadPersistedExternalPlugins()
  }

  /** 扫描 dataDir/plugins 下的 v2 插件包并登记为 external 记录 */
  private async loadPackagePlugins(options: { autoEnable?: boolean } = {}): Promise<void> {
    const dir = this.packagesDir()
    await cleanupPluginStaging(dir).catch(() => {})
    const scan = await scanPluginPackages(dir, { appVersion: this.appVersion })
    this.packageScan = scan
    for (const problem of scan.problems) {
      this.ctx.logger?.warn?.(
        `插件包 ${problem.target} 未加载：${problem.errors.map((item) => item.message).join('；')}`,
      )
    }
    for (const problem of scan.warnings) {
      this.ctx.logger?.warn?.(`插件包扫描警告：${problem.message}`)
    }
    for (const pkg of scan.packages) {
      this.registerPackagePlugin(pkg)
      const id = packagePluginId(pkg.manifest.id)
      const stored = this.ctx.settings.get().plugins[id]
      if (options.autoEnable !== false && stored?.enabled !== false && this.records.has(id)) {
        await this.enable(id)
      }
    }
  }

  /** 把扫描到的插件包注册为运行时记录（不启动） */
  private registerPackagePlugin(pkg: ScannedPluginPackage): void {
    const id = packagePluginId(pkg.manifest.id)
    if (this.records.has(id)) {
      this.ctx.logger?.warn?.(`插件包 ${pkg.manifest.id} 与已登记插件 id 冲突，已跳过`)
      return
    }
    const manifest = pkg.manifest
    const stored = this.ctx.settings.get().plugins[id]
    const entry: PluginManifestEntry = {
      id,
      name: manifest.name,
      description: manifest.description ?? '外部插件包（v2 清单）',
      category: categoryOfManifest(manifest),
      version: manifest.version,
      defaultEnabled: true,
      load: async () => {
        const url =
          pathToFileURL(pkg.entryPath).href +
          '?v=' +
          Date.now().toString(36) +
          Math.random().toString(36).slice(2, 8)
        return (await import(url)) as Record<string, unknown>
      },
    }
    const record: RuntimeRecord = {
      entry,
      status: 'stopped',
      config: stored?.config ?? {},
      taskIds: [],
    }
    ;(record as any).externalPath = pkg.dir
    ;(record as any).externalType = 'package'
    ;(record as any).manifest = manifest
    ;(record as any).permissions = manifest.permissions
    ;(record as any).packageEntryPath = pkg.entryPath
    ;(record as any).clientEntryPath = pkg.clientEntryPath
    ;(record as any).capabilities = {
      fsRoots: manifest.permissions.fsRoots ?? [],
      network: manifest.permissions.network,
      childProcess: manifest.permissions.subprocess,
    }
    this.records.set(id, record)
  }

  private async loadPersistedExternalPlugins(): Promise<void> {
    const settings = this.ctx.settings.get()
    const dataDir = path.dirname(this.ctx.settings.file)
    for (const [id, stored] of Object.entries(settings.plugins ?? {})) {
      if (!id.startsWith('external:') || !stored) continue
      const isNative = (stored as any).externalType === 'native'
      if ((stored as any).externalType === 'package') continue
      if (!isNative && stored.enabled === false) continue
      if (this.records.has(id)) continue
      const name = id.slice('external:'.length)
      const safe = name.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40) || 'ai-plugin'
      const candidates = [
        stored.externalPath,
        path.join(dataDir, 'generated-plugins', `${safe}.mjs`),
        path.join(dataDir, 'generated-plugins', safe, 'plugin.mjs'),
      ].filter((item): item is string => typeof item === 'string' && item.length > 0)
      const file = candidates.find((candidate) => existsSync(candidate))
      if (!file) {
        this.ctx.logger?.warn?.(`外部插件 ${id} 的源文件已不存在，跳过自动加载`)
        continue
      }
      try {
        if (isNative) await this.installNativePlugin(file, { enable: stored.enabled !== false })
        else await this.installExternal(file)
      } catch (error) {
        this.ctx.logger?.warn?.(`外部插件 ${id} 自动加载失败：%s`, error instanceof Error ? error.message : String(error))
      }
    }
  }

  private emitChanged(): void {
    this.ctx.emit('plugins/changed')
  }

  list(): PluginRuntimeInfo[] {
    return [...this.records.values()].map((record) => {
      const descriptor = record.module
      const tasks = this.ctx.cleaner
        .list()
        .filter((task) => record.taskIds.includes(task.id))
        .map((task) => ({ id: task.id, name: task.name, risk: task.risk, description: task.description }))
      return {
        id: record.entry.id,
        name: record.entry.name,
        description: record.entry.description,
        category: record.entry.category,
        source: record.entry.id.startsWith('external:') ? 'external' : 'builtin',
        version: record.entry.version ?? descriptor?.version ?? '0.1.0',
        taskCount: tasks.length,
        status: record.status,
        error: record.error,
        errorStack: record.errorStack,
        enabled: record.status === 'active' || record.status === 'loading',
        tasks,
        config: record.config,
        configurable: !!descriptor?.Config,
        capabilities: (record as any).capabilities,
        manifest: (record as any).manifest,
        permissions: (record as any).permissions,
      }
    })
  }

  /** 加载插件模块（带缓存） */
  private async loadModule(record: RuntimeRecord): Promise<CleanerPluginModule> {
    if (record.module) return record.module
    const manifest = (record as any).manifest as PluginManifest | undefined
    if (manifest) {
      // 启用前再做一次兼容检查（安装后宿主升级/清单被手改都可能造成不兼容）
      const compatibility = checkPluginManifestCompatibility(manifest, { appVersion: this.appVersion })
      if (!compatibility.ok) {
        throw new Error(compatibility.errors.map((item) => item.message).join('；'))
      }
      // 入口源码静态契约复查：防止安装后文件被替换
      const entryPath = (record as any).packageEntryPath as string | undefined
      if (entryPath) {
        const source = await readFile(entryPath, 'utf8').catch(() => '')
        if (source) {
          const check = checkPluginSource(source, {
            mode: 'native',
            allowRelativeImports: true,
            dependencies: manifest.dependencies ?? {},
          })
          if (!check.ok) throw new Error('插件入口校验失败：' + check.errors.join('；'))
        }
      }
    }
    const namespace = await record.entry.load()
    const plugin = (namespace.default ?? namespace) as CleanerPluginModule
    if (!plugin || typeof plugin.apply !== 'function') {
      throw new Error(`插件 ${record.entry.id} 没有导出 apply 函数`)
    }
    record.module = plugin
    return plugin
  }

  async enable(id: string): Promise<void> {
    const record = this.records.get(id)
    const idle = (record as any)?.idleTimer
    if (idle) { clearTimeout(idle); (record as any).idleTimer = undefined }
    if (!record) throw new Error(`插件不存在：${id}`)
    if (record.status === 'active') return
    if (record.status === 'loading') {
      if (record.enablePromise) return record.enablePromise
      return
    }

    record.status = 'loading'
    record.error = undefined
    record.errorStack = undefined
    this.emitChanged()

    const before = new Set(this.ctx.cleaner.list().map((task) => task.id))
    const promise = this.finishEnable(record, before)
    record.enablePromise = promise
    try {
      await promise
    } finally {
      if (record.enablePromise === promise) record.enablePromise = undefined
    }
  }

  private async finishEnable(record: RuntimeRecord, before: Set<string>): Promise<void> {
    const id = record.entry.id
    let fiber: Fiber | undefined
    try {
      const plugin = await this.loadModule(record)
      if (!Object.keys(record.config).length) {
        // 兼容旧状态/异常启动：record 为空时优先从已持久化的 settings 恢复配置，
        // 而不是直接用默认值覆盖（否则 AI 工坊等插件的 API Key 会在启用时丢失）。
        const stored = this.ctx.settings.get().plugins[record.entry.id]?.config
        record.config = stored && Object.keys(stored).length ? stored : defaultConfigOf(plugin)
      }
      fiber = this.ctx.plugin(plugin as any, record.config) as Fiber
      await fiber
      record.fiber = fiber
      record.status = (fiber.state as unknown as number) === FIBER_STATE_ACTIVE ? 'active' : 'stopped'
      const registered = new Set(this.ctx.cleaner.list().map((task) => task.id))
      record.taskIds = [...registered].filter((taskId) => !before.has(taskId))
      // 原生通用插件（含 v2 插件包）可在模块上声明 UI 贡献；每次启用都重新登记，禁用时由 disable 清理
      if (
        ((record as any).externalType === 'native' || (record as any).externalType === 'package') &&
        (plugin as any).contributes &&
        this.ctx.ui
      ) {
        ;(record as any).uiDispose = this.ctx.ui.register(
          id,
          (plugin as any).contributes,
          (plugin as any).kind,
        )
      }
    } catch (error) {
      record.status = 'error'
      record.error = errorMessage(error)
      record.errorStack = error instanceof Error ? error.stack : undefined
      record.taskIds = []
      if (fiber) {
        try {
          await fiber.dispose()
        } catch {
          /* 启动失败的 fiber 销毁也可能抛错，忽略 */
        }
      }
      this.ctx.logger?.warn?.(`插件 ${id} 启动失败：%s`, record.error)
    }
    // 启动失败不应在下次启动时继续被当作 enabled；成功/停用才持久化启用状态
    this.persist(record, record.status === 'active')
    this.emitChanged()
  }

  /**
   * 安装「原生 Cordis 插件」（P1）：外部插件不再只能是 cleaner worker，
   * 而是像内置插件一样通过 ctx.plugin() 获得完整上下文（服务/事件/UI/RPC）。
   * 这是可信代码模型：安装确认后即执行，和 DeepSeek Harness 的插件模型一致。
   */
  async installNativePlugin(filePath: string, options: { enable?: boolean } = {}): Promise<{ id: string }> {
    const abs = path.resolve(filePath)
    if (!existsSync(abs)) throw new Error('插件文件不存在：' + abs)
    const namespace = await import(pathToFileURL(abs).href)
    const plugin: any = namespace.default ?? namespace
    if (!plugin || (typeof plugin.apply !== 'function' && typeof plugin.setup !== 'function' && typeof plugin !== 'function')) {
      throw new Error('原生插件必须导出 Cordis 插件（apply(ctx) 函数或含 apply 的对象）')
    }
    // 旧版 AI 工坊可能生成“只 inject ui、却访问 ctx.cleaner/system”的插件。
    // 严格校验会拦截新安装；这里对已生成文件做一次兼容补齐，避免用户升级后插件永久报错。
    let loadedPlugin = plugin
    if (plugin && typeof plugin === 'object' && typeof plugin.apply === 'function') {
      const source = await readFile(abs, 'utf8').catch(() => '')
      const declared = new Set<string>(
        Array.isArray(plugin.inject) ? plugin.inject.filter((item: unknown): item is string => typeof item === 'string') : [],
      )
      const missing = detectCtxServiceRefs(source).filter((service) => {
        if (declared.has(service)) return false
        // 只补当前已注册的服务；否则会把插件挂成永远 pending（例如 AI 插件默认停用时注入 ai）
        try {
          return (this.ctx as any)[service] != null
        } catch {
          return false
        }
      })
      if (missing.length) {
        loadedPlugin = { ...plugin, inject: [...declared, ...missing] }
        this.ctx.logger?.warn?.(
          `插件 ${String(plugin.name ?? path.basename(abs))} 未声明 inject: ${missing.join(', ')}；已按源码自动补齐（旧工坊产物兼容）`,
        )
      }
    }
    const name = String(plugin.name ?? namespace.name ?? path.basename(abs, path.extname(abs)))
    const id = 'external:' + name
    if (this.records.has(id)) throw new Error('同名插件已加载：' + id)
    const stored = this.ctx.settings.get().plugins[id]
    const entry: PluginManifestEntry = {
      id,
      name,
      description: describeNativePlugin(plugin),
      category: (plugin.category as CategoryId) ?? 'apps',
      version: String(plugin.version ?? '0.0.0'),
      defaultEnabled: true,
      load: async () => ({ default: loadedPlugin }),
    }
    const record: RuntimeRecord = {
      entry,
      module: loadedPlugin,
      status: 'stopped',
      config: stored?.config ?? {},
      taskIds: [],
    }
    ;(record as any).externalPath = abs
    ;(record as any).externalType = 'native'
    if (plugin.capabilities) (record as any).capabilities = plugin.capabilities
    this.records.set(id, record)
    if (options.enable === false) {
      this.persist(record, false)
      this.emitChanged()
    } else {
      await this.enable(id)
      this.emitChanged()
    }
    return { id }
  }

  /**
   * 安装本地插件：import 任意本地 .mjs/.js 模块，校验其导出后挂到运行时。
   * 路径会写入 settings.plugins[id].externalPath，下次启动自动重新加载；
   * 文件由宿主写入用户数据目录，不在本方法内复制或删除。
   */
  async installExternal(filePath: string, options: { allowCustomClean?: boolean } = {}): Promise<void> {
    const abs = path.resolve(filePath)
    if (!existsSync(abs)) throw new Error('插件文件不存在：' + abs)
    const code = await readFile(abs, 'utf8')
    const { proxy, info } = await ExternalPluginProxy.create(abs)
    // 外部插件生成器往往不知道当前用户的绝对路径，允许用 %TEMP%/%USERPROFILE% 等模板，
    // 安装时用真实环境展开，再做绝对路径与辖区校验。
    const env = process.env
    const expandPath = (value: unknown): string =>
      String(value ?? '').replace(/%([^%]+)%/g, (_, name: string) => {
        const key = String(name)
        const found = env[key] ?? env[key.toUpperCase()]
        return typeof found === 'string' && found.trim() ? found : `%${name}%`
      })
    const expandedInfo = {
      ...info,
      capabilities: info.capabilities
        ? { ...info.capabilities, fsRoots: (info.capabilities.fsRoots ?? []).map((root) => expandPath(root)) }
        : info.capabilities,
      tasks: info.tasks.map((task) => ({
        ...task,
        targets: (task.targets ?? []).map((target) => expandPath(target)),
      })),
    }
    let capabilities: PluginCapabilities
    try {
      capabilities = validateCapabilities({ capabilities: expandedInfo.capabilities }, code, options.allowCustomClean === true)
    } catch (error) {
      await proxy.dispose()
      throw error
    }
    const id = 'external:' + (expandedInfo.name || path.basename(abs, path.extname(abs)))
    if (this.records.has(id)) {
      await proxy.dispose()
      throw new Error('同名插件已加载：' + id)
    }
    const proxyRef = proxy
    const synthetic: any = {
      name: expandedInfo.name,
      version: expandedInfo.version ?? '0.0.0',
      description: expandedInfo.description ?? '外部插件（worker 隔离）',
      capabilities,
      inject: ['cleaner', 'pathPolicy'],
      apply(ctx: any) {
        // 允许根必须随插件 fiber 回收，否则 disable/reload 后辖区残留到进程退出
        const rootDisposers: Array<() => void> = []
        ctx.effect(() => () => {
          for (const dispose of rootDisposers) {
            try {
              dispose()
            } catch {
              /* 单个根回收失败不影响其它根 */
            }
          }
          rootDisposers.length = 0
        })
        for (const task of expandedInfo.tasks) {
          const targets = (task.targets ?? []).filter(
            (target: unknown): target is string => typeof target === 'string' && target.trim().length > 0,
          )
          // 外部插件不得扩大清空白名单（addClearRoot 只给内置规则使用）；
          // target 还必须是绝对路径，且落在安装时声明的 capabilities.fsRoots 内，
          // 否则整个任务不注册（不阻塞该插件的其它任务）。
          const invalidTarget = targets.find((target) => {
            if (!isAbsolutePath(target)) return true
            return !capabilities.fsRoots.some((root) => isSubPath(root, target))
          })
          if (invalidTarget !== undefined) {
            ctx.logger?.warn?.(
              `外部插件 ${expandedInfo.name || id} 的任务 ${task.id || '(未命名)'} 已跳过：目标 ${invalidTarget} 不是绝对路径或不在能力声明的 fsRoots 内`,
            )
            continue
          }
          for (const target of targets) rootDisposers.push(ctx.pathPolicy.addRoot(target))
          ctx.effect(() =>
            ctx.cleaner.define({
              ...task,
              risk: task.risk ?? 'caution',
              category: task.category ?? 'apps',
              icon: task.icon ?? '🔌',
              defaultSelected: task.defaultSelected === true,
              targets: task.targets ?? [],
              ...(capabilities.customClean && task.hasClean ? {
                async clean(items: any[], cleanCtx: any) {
                  const result = await proxyRef.clean(task.id, items, { mode: cleanCtx?.mode, dryRun: cleanCtx?.dryRun })
                  return Array.isArray(result) ? result : []
                },
              } : {}),
              async scan(scanCtx: any) {
                const items = await proxyRef.scan(task.id)
                for (const item of items) {
                  const check = ctx.pathPolicy.check(String(item.path))
                  if (check.allowed) scanCtx.emit(item)
                }
              },
            }),
          )
        }
      },
    }
    const entry: PluginManifestEntry = {
      id,
      name: expandedInfo.name || id,
      description: expandedInfo.description ?? '外部插件（worker 隔离）',
      category: 'apps',
      version: expandedInfo.version ?? '0.0.0',
      defaultEnabled: true,
      load: async () => ({ default: synthetic }),
    }
    const storedConfig = this.ctx.settings.get().plugins[id]?.config
    if (storedConfig && Object.keys(storedConfig).length) {
      try {
        await proxy.configure(storedConfig)
      } catch (error) {
        this.ctx.logger?.warn?.(
          `外部插件 ${id} 应用已保存配置失败，将使用默认配置：%s`,
          error instanceof Error ? error.message : String(error),
        )
      }
    }
    this.records.set(id, { entry, module: synthetic, status: 'stopped', config: storedConfig ?? {}, taskIds: [], externalPath: abs, capabilities, externalProxy: proxyRef } as any)
    await this.enable(id)
    this.emitChanged()
  }
  /** 卸载外部插件（内部插件只能停用，避免误删安装包） */
  async uninstallExternal(id: string): Promise<void> {
    if (!id.startsWith('external:')) throw new Error('内置插件只能停用，不能卸载')
    const record = this.records.get(id)
    if (!record) return
    const proxy = (record as any).externalProxy
    await this.disable(id)
    if (proxy) await proxy.dispose()
    this.records.delete(id)
    // 清掉持久化记录，避免下次启动再次尝试加载；文件由宿主 API 负责删除
    this.ctx.settings.patch({ plugins: { [id]: { enabled: false, config: {}, externalPath: '' } } })
    this.emitChanged()
  }

  /** 源码路径：内置插件返回 packages/plugins/<id>，外部插件返回安装时的绝对路径 */
  sourcePath(id: string): string | undefined {
    const record = this.records.get(id)
    if (!record) return undefined
    const external = (record as any).externalPath as string | undefined
    if (external) return external
    const dir = path.resolve('packages/plugins', id)
    return existsSync(dir) ? dir : undefined
  }

  /** 只读检查 v2 插件包目录（管理页审阅用，不落盘） */
  async inspectPackage(sourceDir: string): Promise<PluginPackageReview> {
    const review = await inspectPluginPackage({ sourceDir, appVersion: this.appVersion })
    if (review.manifest) {
      const record = this.records.get(packagePluginId(review.manifest.id))
      const installed = (record as any)?.manifest as PluginManifest | undefined
      if (installed) review.installedVersion = installed.version
    }
    return review
  }

  /**
   * 安装 v2 插件包：校验 → 暂存 → 原子落盘 → 登记 → （可选）启用。
   * 依赖安装与用户审阅由宿主层在调用前完成；这里只接受已就绪的目录。
   */
  async installPackage(
    sourceDir: string,
    options: {
      enable?: boolean
      upgrade?: boolean
      /** 暂存完成后的准备工作（例如在 staging 内安装 npm 依赖）；抛错即回滚 */
      prepareStaging?: (stagingDir: string, manifest: PluginManifest) => Promise<void>
    } = {},
  ): Promise<{ id: string; manifest: PluginManifest; warnings: PluginManifestIssue[] }> {
    const result = await installPluginPackage({
      pluginsDir: this.packagesDir(),
      sourceDir,
      appVersion: this.appVersion,
      upgrade: options.upgrade === true,
      prepareStaging: options.prepareStaging,
    })
    const id = packagePluginId(result.id)
    const existing = this.records.get(id)
    if (existing) {
      await this.disable(id)
      this.records.delete(id)
    }
    await this.loadPackagePlugins({ autoEnable: options.enable !== false })
    if (!this.records.has(id)) {
      const problems = (this.packageScan?.problems ?? [])
        .map((problem) => problem.errors.map((item) => item.message).join('；'))
        .filter(Boolean)
        .join('；')
      throw new Error(`插件 ${result.id} 已落盘但未能登记为运行时插件${problems ? '：' + problems : ''}`)
    }
    if (options.enable !== false) await this.enable(id)
    this.emitChanged()
    return { id, manifest: result.manifest, warnings: result.warnings }
  }

  /** 卸载 v2 插件包：停用 → 删登记 → 目录移入 .trash（可回滚） */
  async uninstallPackage(id: string): Promise<void> {
    if (!id.startsWith('external:')) throw new Error('内置插件只能停用，不能卸载')
    const record = this.records.get(id)
    if (!record) throw new Error(`插件不存在：${id}`)
    const manifest = (record as any).manifest as PluginManifest | undefined
    if ((record as any).externalType !== 'package' || !manifest) throw new Error(`不是 v2 插件包：${id}`)
    await this.disable(id)
    this.records.delete(id)
    this.ctx.settings.patch({ plugins: { [id]: { enabled: false, config: {}, externalPath: '' } } })
    await removePluginPackage(this.packagesDir(), manifest.id)
    this.emitChanged()
  }

  /** v2 插件包的客户端页面（client.mode=page 时存在） */
  clientPage(id: string): { pluginId: string; entry: string; network: boolean } | undefined {
    const record = this.records.get(id)
    if (!record || (record as any).externalType !== 'package') return undefined
    const manifest = (record as any).manifest as PluginManifest | undefined
    if (!manifest) return undefined
    const entry = pluginClientEntryRelative(manifest)
    if (!entry) return undefined
    return { pluginId: manifest.id, entry, network: manifest.permissions.network === true }
  }

  /** 最近一次启动扫描发现的插件包问题（安装/启用失败原因也在这里） */
  packageProblems(): PluginPackageIssue[] {
    return this.packageScan?.problems ?? []
  }

  async disable(id: string): Promise<void> {
    const record = this.records.get(id)
    if (!record) throw new Error(`插件不存在：${id}`)
    // 如果启动正在进行，先等它结束，否则 disable 后 in-flight enable 会把状态写回 active
    if (record.enablePromise) {
      try {
        await record.enablePromise
      } catch {
        /* 启动失败也会在 finishEnable 中落到 error 状态 */
      }
    }
    try {
      this.ctx.window.closeAll(id)
    } catch {}
    const uiDispose = (record as any).uiDispose as (() => void) | undefined
    if (uiDispose) {
      try {
        uiDispose()
      } catch {}
      ;(record as any).uiDispose = undefined
    }
    const fiber = record.fiber
    record.fiber = undefined
    // v2 插件包：丢弃模块缓存，下次 enable/reload 会带 cache-busting 重新 import
    if ((record as any).externalType === 'package') record.module = undefined
    record.status = 'stopped'
    record.taskIds = []
    record.error = undefined
    record.errorStack = undefined
    if (fiber) {
      try {
        await fiber.dispose()
      } catch (error) {
        record.error = errorMessage(error)
        record.status = 'error'
      }
    }
    this.persist(record, false)
    const proxy = (record as any).externalProxy
    if (proxy) {
      const timer = setTimeout(() => {
        void proxy.dispose()
        ;(record as any).externalProxy = undefined
      }, 5 * 60_000)
      ;(record as any).idleTimer = timer
      timer.unref?.()
    }
    this.emitChanged()
  }

  async reload(id: string): Promise<void> {
    const record = this.records.get(id)
    if (!record) throw new Error(`插件不存在：${id}`)
    const wasEnabled = record.status === 'active' || record.status === 'loading'
    await this.disable(id)
    if (wasEnabled) await this.enable(id)
  }

  async updateConfig(id: string, config: Record<string, any>): Promise<void> {
    const record = this.records.get(id)
    if (!record) throw new Error(`插件不存在：${id}`)
    // 外部插件：把配置发给 worker 重新校验并重跑 setup，主进程任务保持不变
    const externalProxy = (record as any).externalProxy
    if (externalProxy) {
      await externalProxy.configure(config ?? {})
      record.config = config ?? {}
      this.ctx.settings.patch({ plugins: { [id]: { config: record.config } } })
      this.emitChanged()
      return
    }
    // 先校验再落地：非法配置直接抛给调用方，运行中的插件保持原状
    const plugin = await this.loadModule(record)
    const validated = this.validateConfig(plugin, config ?? {})
    record.config = validated
    this.ctx.settings.patch({ plugins: { [id]: { config: record.config } } })
    if (record.status === 'active' && record.fiber) {
      try {
        record.fiber.update(record.config)
        await record.fiber
        record.error = undefined
        record.errorStack = undefined
      } catch (error) {
        record.status = 'error'
        record.error = errorMessage(error)
        record.errorStack = error instanceof Error ? error.stack : undefined
      }
    }
    this.emitChanged()
  }

  /** 用插件的 Schemastery 配置校验（无效时抛错，避免污染运行中的 fiber） */
  private validateConfig(plugin: any, config: Record<string, any>): Record<string, any> {
    const schema = plugin?.Config
    if (!schema?.['~standard']) return config
    const result = schema['~standard'].validate(config)
    if (result?.issues?.length) {
      const detail = result.issues
        .map((issue: any) => (issue.path?.length ? `${issue.path.join('.')}: ` : '') + issue.message)
        .join('；')
      throw new Error(`配置校验失败：${detail}`)
    }
    return (result?.value ?? config) as Record<string, any>
  }

  async defaults(id: string): Promise<Record<string, any>> {
    const record = this.records.get(id)
    if (!record) throw new Error(`插件不存在：${id}`)
    try {
      const plugin = await this.loadModule(record)
      return defaultConfigOf(plugin)
    } catch {
      return {}
    }
  }

  private persist(record: RuntimeRecord, enabled: boolean): void {
    const externalPath = (record as any).externalPath as string | undefined
    const externalType = (record as any).externalType as 'native' | 'worker' | 'package' | undefined
    this.ctx.settings.patch({
      plugins: {
        [record.entry.id]: {
          enabled,
          config: record.config,
          ...(externalPath ? { externalPath } : {}),
          ...(externalType ? { externalType } : {}),
        },
      },
    })
  }

  /** 供 RPC 查询单个插件 */
  find(id: string): PluginRuntimeInfo | undefined {
    return this.list().find((item) => item.id === id)
  }
}
