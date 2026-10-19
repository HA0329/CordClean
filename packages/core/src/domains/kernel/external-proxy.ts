/**
 * 路线 3A.2：外部插件跨线程协议与代理。
 *
 * 安全边界：
 * - 外部插件的 setup/scan 全部在 worker 中执行，主进程只拿**可序列化的任务描述与候选列表**；
 * - worker 内没有删除能力：它只能 emit 候选，删除仍由主进程的补偿链 + 执行器完成；
 * - 崩溃/超时只影响该插件的 worker，主进程可继续工作。
 *
 * 协议：
 *   parent → worker: { id, type: 'describe' } | { id, type: 'scan', taskId }
 *   worker → parent: { id, ok: true, value } | { id, ok: false, error }
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
}

export interface ExternalDescribe {
  name: string
  version?: string
  description?: string
  capabilities?: { fsRoots: string[]; network?: boolean; childProcess?: boolean }
  tasks: ExternalTaskMeta[]
}

export interface ExternalProxyOptions {
  /** 单次调用超时（默认 15s，扫描给 60s） */
  timeoutMs?: number
  /** 传给插件的环境变量子集 */
  env?: Record<string, string>
}

const RUNTIME = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
const { pathToFileURL } = require('node:url')

const MAX_ITEMS = 5000
const env = workerData.env || {}
const noop = () => {}
const tasks = []
let loaded

async function load() {
  if (loaded) return loaded
  const mod = await import(pathToFileURL(workerData.modulePath).href)
  const plugin = mod.default || mod
  if (!plugin || typeof plugin.setup !== 'function') throw new Error('插件缺少 setup()')
  const makeScanContext = (sink) => ({
    emit(item) { if (sink.length < MAX_ITEMS) sink.push(item) },
    logger: { info: noop, warn: noop, debug: noop, error: noop },
    env: { get: (name) => env[name] ?? undefined, userProfile: env.USERPROFILE, localAppData: env.LOCALAPPDATA, windowsDir: env.WINDIR, temp: env.TEMP },
    pathPolicy: { addRoot: noop, addClearRoot: noop, check: () => ({ allowed: true }), checkClear: () => ({ allowed: true }), containsProtected: () => false },
    signal: undefined,
    throwIfAborted: noop,
  })
  const ctx = {
    logger: { info: noop, warn: noop, debug: noop, error: noop },
    cleaner: {
      define(definition) { tasks.push(definition); return () => {} },
      list: () => tasks,
    },
    pathPolicy: { addRoot: noop, addClearRoot: noop, check: () => ({ allowed: true }), checkClear: () => ({ allowed: true }), containsProtected: () => false },
    settings: { get: () => ({}) },
    system: { env: { get: (name) => env[name] ?? undefined, userProfile: env.USERPROFILE, localAppData: env.LOCALAPPDATA, windowsDir: env.WINDIR, temp: env.TEMP } },
    effect: (fn) => { try { fn() } catch {} ; return noop },
    on: () => noop,
    emit: noop,
    inject: () => {},
  }
  await plugin.setup(ctx, plugin.Config ? plugin.Config({}) : {})
  loaded = { plugin, tasks }
  return loaded
}

parentPort.on('message', async (message) => {
  try {
    const state = await load()
    if (message.type === 'describe') {
      const tasks = state.tasks.map((task) => ({
        id: task.id, name: task.name, category: task.category, risk: task.risk,
        icon: task.icon, defaultSelected: task.defaultSelected, description: task.description,
        targets: task.targets,
      }))
      parentPort.postMessage({ id: message.id, ok: true, value: {
        name: state.plugin.name, version: state.plugin.version, description: state.plugin.description,
        capabilities: state.plugin.capabilities, tasks,
      } })
      return
    }
    if (message.type === 'scan') {
      const task = state.tasks.find((item) => item.id === message.taskId)
      if (!task || typeof task.scan !== 'function') throw new Error('插件没有任务 ' + message.taskId)
      const items = []
      await task.scan({
        emit(item) { if (items.length < MAX_ITEMS) items.push(item) },
        logger: { info: noop, warn: noop, debug: noop, error: noop },
        env: { get: (name) => env[name] ?? undefined },
        signal: undefined,
        throwIfAborted: noop,
      })
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

  static async create(modulePath: string, options: ExternalProxyOptions = {}): Promise<{ proxy: ExternalPluginProxy; info: ExternalDescribe }> {
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
