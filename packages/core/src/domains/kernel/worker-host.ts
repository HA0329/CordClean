/**
 * 路线 3A 第一步：外部插件的隔离运行时基础设施。
 *
 * 说明（重要）：
 * - 这里只提供「在 worker 中加载模块并调用导出函数」的底座，**尚未接入插件管理器**；
 * - 真正的插件契约（describe / scan / clean 的序列化协议）在下一步实现；
 * - 现在它能证明三件事：模块加载、崩溃隔离、超时终止。
 *
 * 为什么用 worker 而不是 vm：Node 的 vm 不是安全边界；worker 至少有独立堆与
 * 崩溃隔离（进程内 worker 崩溃只影响自身线程，不会拖垮主线程）。
 */
import { Worker } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'

export interface IsolatedRunResult {
  ok: boolean
  value?: unknown
  error?: string
  timedOut?: boolean
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const { pathToFileURL } = require('node:url')
;(async () => {
  try {
    const mod = await import(pathToFileURL(workerData.modulePath).href)
    const target = mod?.[workerData.method] ?? mod?.default?.[workerData.method]
    if (typeof target !== 'function') {
      parentPort.postMessage({ ok: false, error: '导出中没有可调用的 ' + workerData.method })
      return
    }
    const value = await target(...(workerData.args ?? []))
    parentPort.postMessage({ ok: true, value })
  } catch (error) {
    parentPort.postMessage({ ok: false, error: String(error && error.stack ? error.stack : error) })
  }
})()
`

/** 在独立 worker 中调用模块导出函数；超时会终止 worker */
export function runIsolated(
  modulePath: string,
  method: string,
  args: unknown[] = [],
  timeoutMs = 5_000,
): Promise<IsolatedRunResult> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: IsolatedRunResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { modulePath, method, args },
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    })

    const timer = setTimeout(() => {
      void worker.terminate()
      finish({ ok: false, timedOut: true, error: `执行超时（${timeoutMs} ms）` })
    }, timeoutMs)

    worker.once('message', (message: IsolatedRunResult) => {
      clearTimeout(timer)
      void worker.terminate()
      finish(message)
    })
    worker.once('error', (error) => {
      clearTimeout(timer)
      finish({ ok: false, error: String(error?.stack ?? error) })
    })
    worker.once('exit', (code) => {
      clearTimeout(timer)
      if (!settled) finish({ ok: false, error: `worker 提前退出（code=${code}）` })
    })
  })
}

/** 便捷函数：在隔离环境中加载插件模块并读取描述（下一步供插件管理器使用） */
export function describeIsolated(modulePath: string, timeoutMs = 5_000): Promise<IsolatedRunResult> {
  return runIsolated(modulePath, 'describe', [], timeoutMs)
}
