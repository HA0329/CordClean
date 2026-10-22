/**
 * Web 外壳宿主（startHostServer）安全与健壮性测试。
 *
 * 覆盖：
 * - 静态服务遇到非法百分号编码时返回 400，而不是抛未捕获异常拖垮 Node 进程；
 * - Host 头校验（阻断 DNS rebinding，静态页面内联了 token）；
 * - /api/rpc 鉴权；
 * - WebSocket 的 Origin / token 校验与 maxPayload。
 *
 * 使用临时 staticDir + port 0，既不依赖 UI 构建产物，也不会占用固定端口。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { connect } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { Context } from 'cordis'
import { startHostServer, type HandlerMap, type HostServer } from '@cordclean/host'

const TOKEN = 'host-server-test-token'

let servers: HostServer[] = []
let staticDir = ''

/** 最小 ctx：server.ts 只用到 ctx.on 注册事件桥 */
const ctx = { on: () => () => {} } as unknown as Context
/** 最小 handlers：只测鉴权与分发链路，不需要真实内核 */
const handlers = {
  'app/info': () => ({ name: 'CordClean', protocolVersion: 1 }),
} as unknown as HandlerMap

async function startServer(): Promise<HostServer> {
  const server = await startHostServer({ ctx, handlers, staticDir, port: 0, token: TOKEN })
  servers.push(server)
  return server
}

beforeEach(() => {
  staticDir = mkdtempSync(path.join(os.tmpdir(), 'cc-host-server-'))
  writeFileSync(
    path.join(staticDir, 'index.html'),
    '<!doctype html><html><head><!--CORDCLEAN_BOOT--></head><body><div id="app"></div></body></html>',
  )
})

afterEach(async () => {
  const current = servers
  servers = []
  for (const server of current) {
    await server.close().catch(() => {})
  }
  if (staticDir) rmSync(staticDir, { recursive: true, force: true })
})

interface RawRequestOptions {
  method?: string
  path?: string
  headers?: Record<string, string>
  /** 显式指定 Host 头；null 表示不发送 Host，undefined 表示交给 Node 自动生成 */
  host?: string | null
  body?: string
}

interface RawResponse {
  status: number
  headers: NodeJS.Dict<string | string[]>
  body: string
}

/** 用 node:http 发原始请求，便于精确控制 Host 头与请求路径 */
function rawRequest(port: number, options: RawRequestOptions = {}): Promise<RawResponse> {
  const headers: Record<string, string> = { ...options.headers }
  if (typeof options.host === 'string') headers.Host = options.host
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path ?? '/',
        headers,
        // 只有完全没指定 host 时才让 Node 自动补 Host 头
        setHost: options.host === undefined,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

/** 用 TCP 直接发 HTTP 请求，用于构造 Node http 客户端不方便发送的报文（如 HTTP/1.0 无 Host） */
function rawSocketRequest(port: number, payload: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.setTimeout(5000, () => socket.destroy(new Error('rawSocketRequest timeout')))
    const chunks: Buffer[] = []
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    socket.on('error', reject)
    socket.on('close', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(text)
      resolve({ status: match ? Number(match[1]) : 0, body: text })
    })
    socket.write(payload)
  })
}

interface WsHandshakeResult {
  opened: boolean
  /** 服务端明确拒绝时 ws 会给出 HTTP 状态码 */
  status?: number
  timedOut?: boolean
}

/** 尝试建立 WS 连接，返回握手是否成功（不抛错，便于断言拒绝场景） */
function connectWs(
  server: HostServer,
  options: { token?: string; origin?: string; headers?: Record<string, string> } = {},
): Promise<WsHandshakeResult> {
  const query = options.token === undefined ? '' : `?token=${encodeURIComponent(options.token)}`
  const wsUrl = `ws://127.0.0.1:${server.port}/rpc${query}`
  const wsOptions: WebSocket.ClientOptions = {}
  if (options.origin !== undefined) wsOptions.origin = options.origin
  if (options.headers !== undefined) wsOptions.headers = options.headers
  return new Promise((resolve) => {
    const socket = new WebSocket(wsUrl, wsOptions)
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (result: WsHandshakeResult) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }
    // 兜底定时器：避免断言失败时测试挂到超时
    timer = setTimeout(() => finish({ opened: false, timedOut: true }), 5000)
    socket.once('open', () => {
      finish({ opened: true })
      socket.close()
    })
    socket.once('unexpected-response', (req, res) => {
      res.resume()
      req.destroy()
      finish({ opened: false, status: res.statusCode })
    })
    socket.once('error', () => finish({ opened: false }))
    socket.once('close', () => finish({ opened: false }))
  })
}

/** 打开一个可用的 WS 连接（用于 maxPayload 等需要真实连接行为的用例） */
function openSocket(server: HostServer, options: { token?: string; origin?: string } = {}): Promise<WebSocket> {
  const token = options.token ?? TOKEN
  const wsOptions: WebSocket.ClientOptions = {}
  if (options.origin !== undefined) wsOptions.origin = options.origin
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/rpc?token=${encodeURIComponent(token)}`, wsOptions)
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

describe('HTTP 静态服务健壮性', () => {
  it('非法百分号编码返回 400，且服务器仍能继续响应请求', async () => {
    const server = await startServer()
    for (const requestPath of ['/%', '/%ZZ', '/%E0%A4%A', '/assets/%']) {
      const response = await rawRequest(server.port, { path: requestPath })
      expect(response.status, requestPath).toBe(400)
    }
    // 崩溃修复的关键断言：出错的请求不能拖垮进程，同一服务器仍然可用
    const ping = await rawRequest(server.port, { path: '/api/ping' })
    expect(ping.status).toBe(200)
    expect(JSON.parse(ping.body).ok).toBe(true)
  })
})

describe('token 生成', () => {
  it('未指定 token 时使用 crypto.randomBytes 的 URL 安全令牌', async () => {
    const server = await startHostServer({ ctx, handlers, staticDir, port: 0 })
    servers.push(server)
    // base64url(24 字节) 固定 32 个字符，只含 URL 安全字符
    expect(server.token).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(server.url).toContain(`:${server.port}/`)
  })
})

describe('Host 头校验', () => {
  it('非本机 Host（含 DNS rebinding 形态）返回 403', async () => {
    const server = await startServer()
    const wrongPort = server.port === 65535 ? 1 : server.port + 1
    const evilHosts = [
      'evil.example',
      `evil.example:${server.port}`,
      `localhost.evil.example:${server.port}`,
      `127.0.0.1.evil.example:${server.port}`,
      `127.0.0.1:${wrongPort}`,
    ]
    for (const host of evilHosts) {
      const response = await rawRequest(server.port, { host })
      expect(response.status, host).toBe(403)
    }
  })

  it('缺少 Host 头被拒绝', async () => {
    const server = await startServer()
    // HTTP/1.0 允许省略 Host，请求能到达处理器：显式校验必须返回 403
    const legacy = await rawSocketRequest(server.port, 'GET / HTTP/1.0\r\n\r\n')
    expect(legacy.status).toBe(403)
    expect(legacy.body).toContain('forbidden host')
    // HTTP/1.1 缺 Host 时 Node 的 HTTP 解析器会先返回 400，同样不会放行
    const http11 = await rawRequest(server.port, { host: null })
    expect([400, 403]).toContain(http11.status)
  })

  it('合法 Host 返回注入了 token 的 index.html', async () => {
    const server = await startServer()
    const allowedHosts = [
      `127.0.0.1:${server.port}`,
      `LOCALHOST:${server.port}`, // Host 头不区分大小写
      `[::1]:${server.port}`,
    ]
    for (const host of allowedHosts) {
      const response = await rawRequest(server.port, { host })
      expect(response.status, host).toBe(200)
      expect(response.body).toContain('window.__CORDCLEAN__')
      expect(response.body).toContain(TOKEN)
    }
    // 默认由 Node 生成的 Host 也是 127.0.0.1:<port>
    const defaultHost = await rawRequest(server.port)
    expect(defaultHost.status).toBe(200)
    expect(defaultHost.body).toContain(TOKEN)
  })
})

describe('HTTP RPC 鉴权', () => {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'app/info', params: {} })
  const headers = { 'Content-Type': 'application/json' }

  it('缺少或错误 token 返回 401', async () => {
    const server = await startServer()
    const missing = await rawRequest(server.port, { method: 'POST', path: '/api/rpc', headers, body: payload })
    expect(missing.status).toBe(401)
    const wrong = await rawRequest(server.port, {
      method: 'POST',
      path: '/api/rpc?token=wrong-token',
      headers,
      body: payload,
    })
    expect(wrong.status).toBe(401)
  })

  it('正确 token 可以通过 HTTP 调用 RPC 方法', async () => {
    const server = await startServer()
    const response = await rawRequest(server.port, {
      method: 'POST',
      path: `/api/rpc?token=${TOKEN}`,
      headers,
      body: payload,
    })
    expect(response.status).toBe(200)
    const body = JSON.parse(response.body)
    expect(body.id).toBe(1)
    expect(body.result.protocolVersion).toBe(1)
  })
})

describe('WebSocket 握手校验', () => {
  it('错误的 Host 在升级阶段同样被拒绝', async () => {
    const server = await startServer()
    const result = await connectWs(server, { token: TOKEN, headers: { Host: 'evil.example' } })
    expect(result.opened).toBe(false)
  })

  it('错误的 Origin 被拒绝', async () => {
    const server = await startServer()
    const wrongPort = server.port === 65535 ? 1 : server.port + 1
    const evilOrigins = [
      'http://evil.example',
      `http://evil.example:${server.port}`,
      `http://127.0.0.1:${wrongPort}`,
      'null',
    ]
    for (const origin of evilOrigins) {
      const result = await connectWs(server, { token: TOKEN, origin })
      expect(result.opened, origin).toBe(false)
    }
  })

  it('正确的 Origin（127.0.0.1 与 localhost）可以连接', async () => {
    const server = await startServer()
    for (const origin of [`http://127.0.0.1:${server.port}`, `http://localhost:${server.port}`]) {
      const result = await connectWs(server, { token: TOKEN, origin })
      expect(result.opened, origin).toBe(true)
    }
  })

  it('没有 Origin 的原生客户端允许连接', async () => {
    const server = await startServer()
    const result = await connectWs(server, { token: TOKEN })
    expect(result.opened).toBe(true)
  })

  it('缺少或错误 token 的握手被拒绝', async () => {
    const server = await startServer()
    const origin = `http://127.0.0.1:${server.port}`
    const missing = await connectWs(server, { origin })
    expect(missing.opened).toBe(false)
    const wrong = await connectWs(server, { token: 'wrong-token', origin })
    expect(wrong.opened).toBe(false)
  })

  it('超过 1MB maxPayload 的消息会关闭连接', async () => {
    const server = await startServer()
    const socket = await openSocket(server, { origin: `http://127.0.0.1:${server.port}` })
    const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)))
    socket.send('x'.repeat(1024 * 1024 + 1))
    const code = await Promise.race([
      closed,
      new Promise<number>((resolve) => setTimeout(() => resolve(-1), 5000)),
    ])
    expect(code).toBe(1009)
  })
})
