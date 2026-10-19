/**
 * 路线 3A：外部插件跨线程协议与代理。
 *
 * 安全边界：
 * - 外部插件的 setup / scan 全部在 worker 中执行，主进程只拿可序列化的任务描述与候选；
 * - worker 内没有删除能力：只能回传候选，删除仍由主进程补偿链 + 执行器完成；
 * - 崩溃/超时只影响该插件 worker。
 *
 * 协议：
 *   describe  → { name, version, capabilities, tasks }
 *   scan      → 候选数组
 *   configure → 重新校验配置并重跑 setup，返回新的任务元数据（不销毁 worker）
 */
import { Worker } from 'node:worker_threads'

export interface ExternalTaskMeta {
  id: string
  name: string
  category?: string
  risk?: string
  icon?: string
  defaultSelected?: boolean
  description?: string
  targets?: string[]
  hasClean?: boolean
}

export interface ExternalDescribe {
  name: string
  version?: string
  description?: string
  capabilities?: { fsRoots: string[]; network?: boolean; childProcess?: boolean; customClean?: boolean }
  tasks: ExternalTaskMeta[]
}

export interface ExternalProxyOptions {
  timeoutMs?: number
  env?: Record<string, string>
}

const RUNTIME = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
const { pathToFileURL } = require('node:url')

const MAX_ITEMS = 5000
const env = workerData.env || {}
const noop = () => {}
const state = { plugin: null, tasks: [], ctx: null, config: {} }

function makeScanContext(items) {
  return {
    emit(item) { if (items.length < MAX_ITEMS) items.push(item) },
    logger: { info: noop, warn: noop, debug: noop, error: noop },
    env: { get: (name) => env[name] ?? undefined, userProfile: env.USERPROFILE, localAppData: env.LOCALAPPDATA, windowsDir: env.WINDIR, temp: env.TEMP },
    pathPolicy: { addRoot: noop, addClearRoot: noop, check: () => ({ allowed: true }), checkClear: () => ({ allowed: true }), containsProtected: () => false },
    signal: undefined,
    throwIfAborted: noop,
  }
}

function makeCtx() {
  return {
    logger: { info: noop, warn: noop, debug: noop, error: noop },
    cleaner: { define(definition) { state.tasks.push(definition); return noop }, list: () => state.tasks },
    pathPolicy: { addRoot: noop, addClearRoot: noop, check: () => ({ allowed: true }), checkClear: () => ({ allowed: true }), containsProtected: () => false },
    settings: { get: () => ({}) },
    system: { env: { get: (name) => env[name] ?? undefined, userProfile: env.USERPROFILE, localAppData: env.LOCALAPPDATA, windowsDir: env.WINDIR, temp: env.TEMP } },
    effect: (fn) => { try { fn() } catch {}; return noop },
    on: () => noop,
    emit: noop,
  }
}

async function load() {
  if (state.plugin) return state
  const mod = await import(pathToFileURL(workerData.modulePath).href)
  const plugin = mod.default || mod
  if (!plugin || typeof plugin.setup !== 'function') throw new Error('插件缺少 setup()')
  state.plugin = plugin
  state.ctx = makeCtx()
  state.config = typeof plugin.Config === 'function' ? plugin.Config({}) : {}
  await plugin.setup(state.ctx, state.config)
  return state
}

async function reapply(rawConfig) {
  await load()
  const plugin = state.plugin
  const next = typeof plugin.Config === 'function' ? plugin.Config(rawConfig || {}) : (rawConfig || {})
  state.tasks.length = 0
  state.config = next
  await plugin.setup(state.ctx, next)
  return state
}

function describe(state) {
  return {
    name: state.plugin.name,
    version: state.plugin.version,
    description: state.plugin.description,
    capabilities: state.plugin.capabilities,
    tasks: state.tasks.map((task) => ({
      id: task.id, name: task.name, category: task.category, risk: task.risk,
      icon: task.icon, defaultSelected: task.defaultSelected, description: task.description,
      targets: task.targets,
      hasClean: typeof task.clean === 'function',
    })),
  }
}

parentPort.on('message', async (message) => {
  try {
    if (message.type === 'describe') {
      const s = await load()
      parentPort.postMessage({ id: message.id, ok: true, value: describe(s) })
      return
    }
    if (message.type === 'configure') {
      const s = await reapply(message.config)
      parentPort.postMessage({ id: message.id, ok: true, value: describe(s) })
      return
    }
    if (message.type === 'clean') {
      const s = await load()
      if (!s.plugin.capabilities || s.plugin.capabilities.customClean !== true) throw new Error('插件未声明 customClean 能力')
      const task = s.tasks.find((item) => item.id === message.taskId)
      if (!task || typeof task.clean !== 'function') throw new Error('插件没有自定义清理 ' + message.taskId)
      const ctx = {
        mode: message.mode || 'delete',
        dryRun: message.dryRun === true,
        logger: { info: noop, warn: noop, debug: noop, error: noop },
        env: { get: (name) => env[name] ?? undefined },
        pathPolicy: { addRoot: noop, addClearRoot: noop, check: () => ({ allowed: true }), checkClear: () => ({ allowed: true }), containsProtected: () => false },
        throwIfAborted: noop,
        signal: undefined,
      }
      const result = await task.clean(message.items || [], ctx)
      parentPort.postMessage({ id: message.id, ok: true, value: result })
      return
    }
    if (message.type === 'scan') {
      const s = await load()
      const task = s.tasks.find((item) => item.id === message.taskId)
      if (!task || typeof task.scan !== 'function') throw new Error('插件没有任务 ' + message.taskId)
      const items = []
      await task.scan(makeScanContext(items))
      parentPort.postMessage({ id: message.id, ok: true, value: items })
      return
    }
    throw new Error('未知指令 ' + message.type)
  } catch (error) {
    parentPort.postMessage({ id: message.id, ok: false, error: String(error && error.stack ? error.stack : error) })
  }
})
`

interface Pending {
  resolve: (value: any) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class ExternalPluginProxy {
  private worker: Worker
  private seq = 0
  private pending = new Map<number, Pending>()
  private closed = false

  private constructor(worker: Worker) {
    this.worker = worker
    worker.on('message', (message: any) => {
      const entry = this.pending.get(message.id)
      if (!entry) return
      clearTimeout(entry.timer)
      this.pending.delete(message.id)
      if (message.ok) entry.resolve(message.value)
      else entry.reject(new Error(message.error))
    })
    worker.on('error', (error) => this.failAll(error))
    worker.on('exit', (code) => {
      if (!this.closed && code !== 0) this.failAll(new Error(`插件 worker 异常退出（code=${code}）`))
    })
  }

  static async create(
    modulePath: string,
    options: ExternalProxyOptions = {},
  ): Promise<{ proxy: ExternalPluginProxy; info: ExternalDescribe }> {
    const worker = new Worker(RUNTIME, {
      eval: true,
      workerData: { modulePath, env: options.env ?? process.env },
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    })
    const proxy = new ExternalPluginProxy(worker)
    const info = (await proxy.call({ type: 'describe' }, options.timeoutMs ?? 15_000)) as ExternalDescribe
    return { proxy, info }
  }

  private call(message: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('插件已卸载'))
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`插件调用超时（${timeoutMs} ms）`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.worker.postMessage({ id, ...message })
    })
  }

  scan(taskId: string, timeoutMs = 60_000): Promise<Array<Record<string, unknown>>> {
    return this.call({ type: 'scan', taskId }, timeoutMs) as Promise<Array<Record<string, unknown>>>
  }

  /** 执行插件自定义清理（仅声明并获批 customClean 的插件可用） */
  clean(taskId: string, items: Array<Record<string, unknown>>, options: { mode?: string; dryRun?: boolean } = {}, timeoutMs = 60_000): Promise<unknown> {
    return this.call({ type: 'clean', taskId, items, mode: options.mode, dryRun: options.dryRun }, timeoutMs)
  }

  /** 热更新配置：worker 内重新校验并重跑 setup，不销毁 worker */
  configure(config: Record<string, unknown>, timeoutMs = 15_000): Promise<ExternalDescribe> {
    return this.call({ type: 'configure', config }, timeoutMs) as Promise<ExternalDescribe>
  }

  private failAll(error: Error): void {
    if (this.closed) return
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  async dispose(): Promise<void> {
    this.closed = true
    await this.worker.terminate()
  }
}
