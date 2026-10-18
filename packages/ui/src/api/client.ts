/**
 * 传输层客户端。
 *
 * 同一份界面代码可以运行在两种外壳下：
 * - 浏览器：通过 WebSocket 连接本机 RPC 服务（地址由服务端注入到 window.__CORDCLEAN__）；
 * - Electron：通过 preload 暴露的 `window.cordclean` 走 IPC。
 *
 * 界面只依赖 `ApiTransport` 接口，因此外壳切换对业务代码完全透明。
 */
import type { ApiMap, ApiMethod, ApiParams, ApiResult, ServerEvent, ServerEventMap } from '@cordclean/shared'
import { RpcError } from '@cordclean/shared'

export interface ApiTransport {
  request<M extends ApiMethod>(method: M, params: ApiParams<M>): Promise<ApiResult<M>>
  on<E extends ServerEvent>(event: E, listener: (payload: ServerEventMap[E]) => void): () => void
  readonly kind: 'websocket' | 'electron'
  close(): void
}

interface BootInfo {
  token: string
  wsUrl: string
  version?: string
}

declare global {
  interface Window {
    __CORDCLEAN__?: BootInfo
    cordclean?: {
      invoke(method: string, params: unknown): Promise<unknown>
      onEvent(listener: (event: string, payload: unknown) => void): () => void
      platform: string
    }
  }
}

/* ---------------------------------- WebSocket ---------------------------------- */

export function createWebSocketTransport(info: BootInfo): ApiTransport {
  const url = `${info.wsUrl}?token=${encodeURIComponent(info.token)}`
  let sequence = 0
  const pending = new Map<number, { resolve: (value: any) => void; reject: (reason: unknown) => void }>()
  const listeners = new Map<string, Set<(payload: any) => void>>()
  let socket: WebSocket | undefined
  let closed = false
  const queue: string[] = []

  const emit = (event: string, payload: unknown) => {
    for (const listener of listeners.get(event) ?? []) {
      try {
        listener(payload)
      } catch {
        /* 单个订阅者异常不影响其它订阅者 */
      }
    }
  }

  const connect = () => {
    socket = new WebSocket(url)
    socket.onopen = () => {
      while (queue.length && socket?.readyState === WebSocket.OPEN) socket.send(queue.shift()!)
    }
    socket.onmessage = (event) => {
      let message: any
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const task = pending.get(message.id)!
        pending.delete(message.id)
        if (message.error) task.reject(new RpcError(message.error.code, message.error.message, message.error.data))
        else task.resolve(message.result)
        return
      }
      if (message.method) emit(message.method, message.params)
    }
    socket.onclose = () => {
      for (const task of pending.values()) task.reject(new RpcError(-32000, '与内核的连接已断开'))
      pending.clear()
      if (!closed) {
        // 断线后延迟重连（例如内核重启）
        setTimeout(() => {
          if (!closed) connect()
        }, 1500)
      }
    }
  }
  connect()

  return {
    kind: 'websocket',
    request<M extends ApiMethod>(method: M, params: ApiParams<M>) {
      const id = ++sequence
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })
      return new Promise<ApiResult<M>>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        if (socket?.readyState === WebSocket.OPEN) socket.send(payload)
        else queue.push(payload)
      })
    },
    on<E extends ServerEvent>(event: E, listener: (payload: ServerEventMap[E]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(listener as (payload: any) => void)
      return () => listeners.get(event)?.delete(listener as (payload: any) => void)
    },
    close() {
      closed = true
      socket?.close()
    },
  }
}

/* ---------------------------------- Electron ---------------------------------- */

export function createElectronTransport(bridge: NonNullable<Window['cordclean']>): ApiTransport {
  const listeners = new Map<string, Set<(payload: any) => void>>()
  bridge.onEvent((event, payload) => {
    for (const listener of listeners.get(event) ?? []) {
      try {
        listener(payload)
      } catch {
        /* ignore */
      }
    }
  })
  return {
    kind: 'electron',
    async request<M extends ApiMethod>(method: M, params: ApiParams<M>) {
      try {
        return (await bridge.invoke(method, params)) as ApiResult<M>
      } catch (error: any) {
        throw new RpcError(error?.code ?? -32000, error?.message ?? String(error))
      }
    },
    on<E extends ServerEvent>(event: E, listener: (payload: ServerEventMap[E]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(listener as (payload: any) => void)
      return () => listeners.get(event)?.delete(listener as (payload: any) => void)
    },
    close() {
      /* IPC 无需关闭 */
    },
  }
}

/** 根据运行环境自动选择传输层 */
export function createTransport(): ApiTransport {
  if (window.cordclean) return createElectronTransport(window.cordclean)
  const info = window.__CORDCLEAN__
  if (!info) {
    throw new Error('未注入启动参数：请通过 CordClean 启动器打开界面（缺少 window.__CORDCLEAN__）')
  }
  return createWebSocketTransport(info)
}

export type { ApiMap }
