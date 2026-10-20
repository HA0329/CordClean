/**
 * 路线 3A：外部插件跨线程协议与代理。
 *
 * 安全边界（如实说明，不要夸大）：
 * - worker 只是**故障隔离**，不是安全沙箱：插件代码与内核同进程、运行在 worker 线程中，
 *   仍可直接 `require('node:fs')` / `child_process`、读取完整的 `process.env` 与文件系统；
 * - 能力声明（capabilities）只是「声明 + 安装时静态校验」，运行时并不强制；worker 内也没有删除能力，
 *   只能回传候选，删除仍由主进程补偿链 + 执行器完成；
 * - 本文件能做到的边界收紧：只把**白名单环境变量**放进 `workerData.env`（供 `ctx.env` /
 *   `system.env` 便利访问器使用），避免把 AI/第三方 API Key、Token、Secret、Password
 *   等敏感变量交给插件上下文（插件若直接读 `process.env` 仍可看到，见第一条）；
 * - 崩溃/超时只影响该插件 worker。
 *
 * 协议：
 *   describe  → { name, version, capabilities, tasks }
 *   scan      → 候选数组
 *   configure → 重新校验配置并重跑 setup，返回新的任务元数据（不销毁 worker）
 */
import { Worker } from 'node:worker_threads'

/**
 * 允许通过 `workerData.env` 暴露给插件上下文的环境变量（键名统一大写）。
 *
 * 仅覆盖插件定位系统目录 / 临时目录所需的最小集合；其它变量（尤其是凭据）一律不传。
 */
export const PLUGIN_ENV_ALLOWLIST = [
  'SYSTEMROOT',
  'WINDIR',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'HOMEDRIVE',
  'HOMEPATH',
  'PATH',
  'COMSPEC',
  'PATHEXT',
] as const

/** 敏感变量模式：命中即丢弃（大小写不敏感） */
const PLUGIN_ENV_DENY_PATTERNS: RegExp[] = [
  /_API_KEY$/i,
  /_TOKEN$/i,
  /_SECRET$/i,
  /_PASSWORD$/i,
  /^DEEPSEEK_/i,
  /^OPENAI_/i,
  /^DASHSCOPE_/i,
]

/**
 * 构造传给插件 worker 的环境变量白名单。
 *
 * 输入默认为 `process.env`，返回的键统一为大写（worker 内 `workerData.env` 是普通对象，
 * 属性访问区分大小写；RUNTIME 里读取的是 `env.WINDIR` 等大写形态）。
 * 测试可显式传入模拟 env。
 */
export function sanitizePluginEnv(source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Record<string, string> {
  const allowed = new Map(PLUGIN_ENV_ALLOWLIST.map((key) => [key.toLowerCase(), key]))
  const result: Record<string, string> = {}
  for (const [rawKey, rawValue] of Object.entries(source)) {
    if (rawValue === undefined) continue
    if (PLUGIN_ENV_DENY_PATTERNS.some((pattern) => pattern.test(rawKey))) continue
    const canonical = allowed.get(rawKey.toLowerCase())
    if (!canonical) continue
    result[canonical] = rawValue
  }
  return result
}

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
/** 白名单键统一大写存储；按 Windows 习惯做大小写不敏感读取 */
const envGet = (name) => env[String(name).toUpperCase()] ?? undefined
const noop = () => {}
const state = { plugin: null, tasks: [], ctx: null, config: {} }

function makeScanContext(items) {
  return {
    emit(item) { if (items.length < MAX_ITEMS) items.push(item) },
    logger: { info: noop, warn: noop, debug: noop, error: noop },
    env: { get: envGet, userProfile: env.USERPROFILE, localAppData: env.LOCALAPPDATA, windowsDir: env.WINDIR, temp: env.TEMP },
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
    system: { env: { get: envGet, userProfile: env.USERPROFILE, localAppData: env.LOCALAPPDATA, windowsDir: env.WINDIR, temp: env.TEMP } },
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
        env: { get: envGet },
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
      workerData: { modulePath, env: sanitizePluginEnv(options.env ?? process.env) },
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
