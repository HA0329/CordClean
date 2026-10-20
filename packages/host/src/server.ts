/**
 * Web 外壳宿主：HTTP 静态资源 + WebSocket JSON-RPC。
 *
 * 设计要点：
 * - 只监听 127.0.0.1，且每次启动生成随机 token，防止本机其它网页跨站调用；
 * - 校验 Host 头（阻断 DNS rebinding）与 WebSocket 的 Origin 头（阻断跨站页面）；
 * - 内核事件（扫描进度、清理进度等）通过广播通知推送到所有已连接客户端；
 * - 界面静态资源由同一端口提供，无需额外的 Web 服务器。
 */
import { randomBytes } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import type { Context } from 'cordis'
import { WebSocketServer, type WebSocket } from 'ws'
import type { RpcRequest, RpcResponse, ServerEvent } from '@cordclean/shared'
import { dlog } from './diagnostics.ts'
import { validateParams } from './validation.ts'
import { RPC_ERRORS } from '@cordclean/shared'
import type { HandlerMap } from './api.ts'

export interface HostServerOptions {
  ctx: Context
  handlers: HandlerMap
  /** 界面构建产物目录；不传则不提供静态资源（仅 API） */
  staticDir?: string
  port?: number
  host?: string
  /** 访问令牌，默认随机生成 */
  token?: string
}

export interface HostServer {
  url: string
  wsUrl: string
  port: number
  token: string
  close(): Promise<void>
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
}

/** 内核事件 → 客户端事件 */
const EVENT_BRIDGE: Array<[any, ServerEvent]> = [
  ['cleaner/scan-progress', 'scan/progress'],
  ['cleaner/scan-done', 'scan/done'],
  ['cleaner/clean-progress', 'clean/progress'],
  ['cleaner/clean-done', 'clean/done'],
  ['plugins/changed', 'plugins/changed'],
  ['history/changed', 'history/changed'],
  ['scheduler/scan', 'scheduler/scan'],
  ['ai/stream', 'ai/stream'],
  ['system/log', 'log'],
]

/** 带状态码的 HTTP 错误 */
class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

/** WebSocket 单条消息上限（1MB），防止超大帧耗尽内存 */
const WS_MAX_PAYLOAD = 1024 * 1024

/** 允许的 Host 主机名（不含端口）；只接受本机回环地址，阻断 DNS rebinding */
const ALLOWED_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]']

/**
 * 校验 Host 头（不区分大小写）。
 * 只允许 127.0.0.1 / localhost / [::1]，带端口时端口必须等于实际监听端口；
 * 也接受省略端口的写法（浏览器访问默认端口 80/443 时的形态）。缺少 Host 头直接拒绝。
 */
function isAllowedHost(header: string | undefined, port: number): boolean {
  if (typeof header !== 'string' || !header.trim()) return false
  const value = header.trim().toLowerCase()
  return ALLOWED_HOSTNAMES.some((name) => value === name || value === `${name}:${port}`)
}

/**
 * 校验 WebSocket 的 Origin 头：
 * - 没有 Origin（原生客户端、测试、非浏览器环境）允许；
 * - 有 Origin 时必须等于界面自身的 origin（http://127.0.0.1:<port> 或 http://localhost:<port>）。
 */
function isAllowedOrigin(header: string | undefined, port: number): boolean {
  if (header === undefined) return true
  if (typeof header !== 'string') return false
  const value = header.trim().toLowerCase()
  return value === `http://127.0.0.1:${port}` || value === `http://localhost:${port}`
}

/**
 * 解析请求目标。基准地址使用固定值，绝不复用未经验证的 Host 头；
 * 非法的请求目标按 400 处理，而不是抛出未捕获异常。
 */
function parseRequestUrl(rawUrl: string | undefined): URL {
  try {
    return new URL(rawUrl ?? '/', 'http://127.0.0.1')
  } catch {
    throw new HttpError(400, '请求路径不合法')
  }
}

/** 拒绝 WebSocket 升级：先回写状态行再销毁连接 */
function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  } catch {
    /* 连接可能已被对端关闭，忽略写入失败 */
  }
  socket.destroy()
}

/**
 * 读取请求体（默认上限 2MB）。
 * 超限时不销毁连接，而是排空数据后返回 413，让客户端能正常收到错误响应。
 */
function readBody(req: IncomingMessage, limit = 2 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    let overflow = false
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      if (overflow) return
      size += chunk.length
      if (size > limit) {
        // 丢弃已缓存的数据并继续排空，避免 TCP 连接被重置
        overflow = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (overflow) reject(new HttpError(413, `请求体过大（上限 ${Math.round(limit / 1024)} KB）`))
      else resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

export async function startHostServer(options: HostServerOptions): Promise<HostServer> {
  const host = options.host ?? '127.0.0.1'
  const token = options.token ?? randomBytes(24).toString('base64url')
  const clients = new Set<WebSocket>()
  let port = 0

  const broadcast = (event: ServerEvent, params: unknown) => {
    const payload = JSON.stringify({ jsonrpc: '2.0', method: event, params })
    for (const client of clients) {
      if (client.readyState === 1) {
        try {
          client.send(payload)
        } catch {
          /* 单个客户端发送失败不影响其它客户端 */
        }
      }
    }
  }

  // 内核事件 → 客户端广播
  const unbinds: Array<() => void> = []
  for (const [internal, external] of EVENT_BRIDGE) {
    const handler = (payload: unknown) => broadcast(external, payload)
    const unbind = options.ctx.on(internal, handler)
    unbinds.push(typeof unbind === 'function' ? unbind : () => {})
  }

  const dispatch = async (request: RpcRequest): Promise<RpcResponse> => {
    const startedAt = Date.now()
    const handler = (options.handlers as Record<string, (params: any) => any>)[request.method]
    if (!handler) {
      return { jsonrpc: '2.0', id: request.id, error: { code: RPC_ERRORS.METHOD_NOT_FOUND, message: `未知方法：${request.method}` } }
    }
    const validation = validateParams(request.method, request.params)
    if (!validation.ok) {
      dlog('warn', 'rpc', request.method + ' 参数校验失败', { message: validation.message })
      return { jsonrpc: '2.0', id: request.id, error: { code: RPC_ERRORS.INVALID_PARAMS ?? -32602, message: '参数校验失败：' + validation.message } }
    }
    try {
      const result = await handler(request.params ?? {})
      dlog('info', 'rpc', request.method, { ms: Date.now() - startedAt, params: request.params })
      return { jsonrpc: '2.0', id: request.id, result: result ?? null }
    } catch (error) {
      dlog('error', 'rpc', request.method + ' 失败', { ms: Date.now() - startedAt, error: (error as Error)?.message, params: request.params })
      const err = error as { code?: number; message?: string }
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: typeof err.code === 'number' ? err.code : RPC_ERRORS.INTERNAL, message: err.message ?? String(error) },
      }
    }
  }

  const serveStatic = async (url: URL, res: ServerResponse) => {
    const staticDir = options.staticDir
    if (!staticDir) {
      res.writeHead(404).end('Not Found')
      return
    }
    let pathname: string
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      // 非法百分号编码（如 /%）必须转成 400，而不是让 URIError 逃逸成未处理拒绝
      throw new HttpError(400, '请求路径编码不合法')
    }
    if (pathname === '/') pathname = '/index.html'
    // 防目录穿越
    const base = path.normalize(staticDir)
    const resolved = path.normalize(path.join(staticDir, pathname))
    // 必须以 base + 分隔符开头（或等于 base），避免 `C:\ui-evil` 被 `C:\ui` 前缀误判
    if (resolved !== base && !resolved.startsWith(base.endsWith(path.sep) ? base : base + path.sep)) {
      res.writeHead(403).end('Forbidden')
      return
    }
    let target = resolved
    try {
      const stat = await fs.stat(target)
      if (stat.isDirectory()) target = path.join(target, 'index.html')
    } catch {
      // SPA 回退
      target = path.join(staticDir, 'index.html')
    }

    try {
      let content = await fs.readFile(target)
      if (target.endsWith('index.html')) {
        // 注入启动参数（token / WS 地址）；版本统一由 app/info 返回，避免此处硬编码漂移
        const boot = `<script>window.__CORDCLEAN__=${JSON.stringify({
          token,
          wsUrl: `ws://${host}:${port}/rpc`,
        })}</script>`
        content = Buffer.from(
          content.toString('utf8').replace('<!--CORDCLEAN_BOOT-->', boot),
          'utf8',
        )
      }
      const type = MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' })
      res.end(content)
    } catch {
      res.writeHead(404).end('Not Found')
    }
  }

  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    // 所有 HTTP 请求（含静态资源）先校验 Host：页面内联了 token，必须阻断 DNS rebinding
    if (!isAllowedHost(req.headers.host, port)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'forbidden host' }))
      return
    }
    const url = parseRequestUrl(req.url)
    // 健康检查 / 版本探测
    if (url.pathname === '/api/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, name: 'CordClean' }))
      return
    }
    // 兼容非 WebSocket 的 JSON-RPC（便于 curl 调试与自动化测试）
    if (url.pathname === '/api/rpc' && req.method === 'POST') {
      if (url.searchParams.get('token') !== token) {
        res.writeHead(401).end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      try {
        const body = await readBody(req)
        const response = await dispatch(JSON.parse(body) as RpcRequest)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(response))
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 400
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: String(error instanceof Error ? error.message : error) }))
      }
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end('Method Not Allowed')
      return
    }
    await serveStatic(url, res)
  }

  const server = createServer((req, res) => {
    // 处理入口统一兜底：任何异常都转成错误响应，不能出现未处理的 Promise 拒绝
    handleRequest(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      const status = error instanceof HttpError ? error.status : 500
      const message = status === 500 ? 'internal server error' : ((error as Error)?.message ?? String(error))
      try {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: message }))
      } catch {
        res.destroy()
      }
    })
  })

  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD })

  server.on('upgrade', (req, socket, head) => {
    try {
      // 与普通 HTTP 请求一致：先校验 Host（带端口的写法已由 isAllowedHost 归一化处理）
      if (!isAllowedHost(req.headers.host, port)) {
        rejectUpgrade(socket, 403, 'Forbidden Host')
        return
      }
      const url = parseRequestUrl(req.url)
      if (url.pathname !== '/rpc') {
        socket.destroy()
        return
      }
      // 浏览器发起的跨站页面会带上自己的 Origin，必须等于界面自身的 origin
      if (!isAllowedOrigin(req.headers.origin, port)) {
        rejectUpgrade(socket, 403, 'Forbidden Origin')
        return
      }
      if (url.searchParams.get('token') !== token) {
        rejectUpgrade(socket, 401, 'Unauthorized')
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
    } catch {
      // 升级阶段同样不允许异常逃逸（例如被破坏的请求目标）
      socket.destroy()
    }
  })

  wss.on('connection', (socket) => {
    clients.add(socket)
    socket.on('close', () => clients.delete(socket))
    socket.on('error', () => clients.delete(socket))
    socket.on('message', (raw) => {
      void (async () => {
        let request: RpcRequest
        try {
          request = JSON.parse(String(raw)) as RpcRequest
        } catch {
          socket.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: RPC_ERRORS.PARSE, message: 'JSON 解析失败' } }))
          return
        }
        const response = await dispatch(request)
        try {
          socket.send(JSON.stringify(response))
        } catch {
          /* ignore */
        }
      })()
    })
  })

  port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : (options.port ?? 0))
    })
  })

  return {
    port,
    token,
    url: `http://${host}:${port}/`,
    wsUrl: `ws://${host}:${port}/rpc`,
    async close() {
      for (const unbind of unbinds) unbind()
      for (const client of clients) client.terminate()
      clients.clear()
      wss.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
