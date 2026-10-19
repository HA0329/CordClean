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
import type {
  CategoryId,
  CleanerPluginModule,
  PluginManagerLike,
  PluginRuntimeInfo,
} from '@cordclean/shared'
import { errorMessage } from '@cordclean/utils'

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
}

/** 安装前校验外部插件的能力声明与代码是否一致 */
export function validateCapabilities(plugin: any, code: string): PluginCapabilities {
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
  return { fsRoots: roots, network, childProcess }
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
}

export interface PluginManagerConfig {
  manifest: PluginManifestEntry[]
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
  static inject = ['cleaner', 'settings']

  private records = new Map<string, RuntimeRecord>()

  constructor(ctx: Context, config: PluginManagerConfig) {
    super(ctx, 'plugins')
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

  /** 启动时加载全部启用的插件（顺序加载，确保任务归属统计准确） */
  async loadAll(): Promise<void> {
    const settings = this.ctx.settings.get()
    for (const [id, record] of this.records) {
      const stored = settings.plugins[id]
      const enabled = stored?.enabled ?? record.entry.defaultEnabled ?? true
      if (!enabled) continue
      await this.enable(id)
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
        source: 'builtin',
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
      }
    })
  }

  /** 加载插件模块（带缓存） */
  private async loadModule(record: RuntimeRecord): Promise<CleanerPluginModule> {
    if (record.module) return record.module
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
    if (!record) throw new Error(`插件不存在：${id}`)
    if (record.status === 'active' || record.status === 'loading') return

    record.status = 'loading'
    record.error = undefined
    record.errorStack = undefined
    this.emitChanged()

    const before = new Set(this.ctx.cleaner.list().map((task) => task.id))
    let fiber: Fiber | undefined
    try {
      const plugin = await this.loadModule(record)
      if (!Object.keys(record.config).length) {
        record.config = defaultConfigOf(plugin)
      }
      fiber = this.ctx.plugin(plugin as any, record.config) as Fiber
      await fiber
      record.fiber = fiber
      record.status = (fiber.state as unknown as number) === FIBER_STATE_ACTIVE ? 'active' : 'stopped'
      const registered = new Set(this.ctx.cleaner.list().map((task) => task.id))
      record.taskIds = [...registered].filter((taskId) => !before.has(taskId))
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
    this.persist(record, true)
    this.emitChanged()
  }

  /**
   * 安装本地插件：import 任意本地 .mjs/.js 模块，校验其导出后挂到运行时。
   * 说明：仅本次运行有效（不复制用户文件、不修改安装包）。
   */
  async installExternal(filePath: string): Promise<void> {
    const abs = path.resolve(filePath)
    if (!existsSync(abs)) throw new Error('插件文件不存在：' + abs)
    const code = await readFile(abs, 'utf8')
    const { proxy, info } = await ExternalPluginProxy.create(abs)
    let capabilities: PluginCapabilities
    try {
      capabilities = validateCapabilities({ capabilities: info.capabilities }, code)
    } catch (error) {
      await proxy.dispose()
      throw error
    }
    const id = 'external:' + (info.name || path.basename(abs, path.extname(abs)))
    if (this.records.has(id)) {
      await proxy.dispose()
      throw new Error('同名插件已加载：' + id)
    }
    const proxyRef = proxy
    const synthetic: any = {
      name: info.name,
      version: info.version ?? '0.0.0',
      description: info.description ?? '外部插件（worker 隔离）',
      capabilities,
      inject: ['cleaner', 'pathPolicy'],
      apply(ctx: any) {
        for (const task of info.tasks) {
          for (const target of task.targets ?? []) {
            if (task.id && target) {
              ctx.pathPolicy.addRoot(target)
              ctx.pathPolicy.addClearRoot(target)
            }
          }
          ctx.effect(() =>
            ctx.cleaner.define({
              ...task,
              risk: task.risk ?? 'caution',
              category: task.category ?? 'apps',
              icon: task.icon ?? '🔌',
              defaultSelected: task.defaultSelected === true,
              targets: task.targets ?? [],
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
      name: info.name || id,
      description: info.description ?? '外部插件（worker 隔离）',
      category: 'apps',
      version: info.version ?? '0.0.0',
      defaultEnabled: true,
      load: async () => ({ default: synthetic }),
    }
    this.records.set(id, { entry, module: synthetic, status: 'stopped', config: {}, taskIds: [], externalPath: abs, capabilities, externalProxy: proxyRef } as any)
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

  async disable(id: string): Promise<void> {
    const record = this.records.get(id)
    if (!record) throw new Error(`插件不存在：${id}`)
    const fiber = record.fiber
    record.fiber = undefined
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
    this.ctx.settings.patch({
      plugins: {
        [record.entry.id]: { enabled, config: record.config },
      },
    })
  }

  /** 供 RPC 查询单个插件 */
  find(id: string): PluginRuntimeInfo | undefined {
    return this.list().find((item) => item.id === id)
  }
}
