/**
 * CordClean 大规模扫描结果 UI 验收脚本（mock RPC + 无头 Edge CDP）。
 *
 * 流程：
 * 1. 以子进程启动 `scripts/ui-mock-server.mjs`（默认 3000 条固定种子合成数据、
 *    注入 window.__CORDCLEAN__ 的静态服务 + `/rpc` WebSocket mock）；
 * 2. 以无头 Edge（--headless=new + 独立临时 profile）通过 CDP 打开 `#clean` 页面；
 * 3. 收集 Runtime.exceptionThrown / console.error / Log.error，必须为 0；
 * 4. 在清理页做交互断言（分组总览、推荐横幅、默认选中、明细分页、风险筛选、
 *    整组勾选、详情抽屉、清理确认摘要），并各截一张亮色/暗色全页图；
 * 5. 输出 PASS/FAIL 明细，失败退出码 1；结束时清理 Edge、mock server 与临时 profile。
 *
 * 用法：
 *   node scripts/verify-clean-ui.mjs                  # 最终验收（要求新 UI 已构建）
 *   node scripts/verify-clean-ui.mjs --smoke          # 旧版/基础冒烟：只验证能拉起页面、
 *                                                     # 无 JS 报错、mock 数据与 RPC 正常
 *   node scripts/verify-clean-ui.mjs --mode=auto      # 自动探测：有新版钩子跑最终断言，否则冒烟
 *   node scripts/verify-clean-ui.mjs --items=3000 --port=7841 --cdp-port=9444
 *
 * 其它选项：
 *   --seed=<n>           合成数据种子（默认 20251020）
 *   --screenshot-dir=dir 截图目录（默认 docs/screenshots）
 *   --edge=<path>        指定 Edge 可执行文件（默认自动查找）
 *   --keep-profile       保留临时 Edge profile（排障用）
 *   --verbose            打印每一步 evaluate 细节
 *   --timeout=<ms>       全局超时（默认 240000）
 *
 * 说明：所有选择器以任务约定为准；若新版 UI 的实际渲染与约定不同，只做最小调整，
 *       绝不修改 UI / 内核源码。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import { createFixture, DEFAULT_ITEMS, DEFAULT_SEED, formatBytes, MOCK_TOKEN } from './ui-mock-server.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const MOCK_SCRIPT = path.join(HERE, 'ui-mock-server.mjs')
const DEFAULT_SCREENSHOT_DIR = path.join(ROOT, 'docs', 'screenshots')
const DEFAULT_MOCK_PORT = 7841
const DEFAULT_CDP_PORT = 9444

/* ------------------------------------------------------------------ */
/* CLI / 日志                                                           */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const options = { mode: 'final' }
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg)
    if (!match) continue
    const [, rawKey, rawValue] = match
    const key = rawKey.trim()
    const value = rawValue?.trim()
    if (key === 'help' || key === 'h') options.help = true
    else if (key === 'smoke' || key === 'legacy') options.mode = 'smoke'
    else if (key === 'mode') options.mode = value === 'auto' ? 'auto' : value === 'smoke' ? 'smoke' : 'final'
    else if (key === 'items') options.items = Number(value)
    else if (key === 'seed') options.seed = Number(value)
    else if (key === 'port') options.port = Number(value)
    else if (key === 'cdp-port') options.cdpPort = Number(value)
    else if (key === 'screenshot-dir') options.screenshotDir = value
    else if (key === 'edge') options.edge = value
    else if (key === 'keep-profile') options.keepProfile = true
    else if (key === 'verbose') options.verbose = true
    else if (key === 'timeout') options.timeout = Number(value)
  }
  return options
}

function printUsage() {
  console.log(
    [
      'CordClean 扫描结果 UI 验收（mock RPC + Edge CDP）',
      '',
      '用法：node scripts/verify-clean-ui.mjs [选项]',
      '',
      '选项：',
      '  --smoke              只做基础冒烟（旧版界面可用）：页面能起、无 JS 报错、mock 数据正常',
      '  --mode=final|smoke|auto  验收模式，默认 final（要求新版 CleanView 已构建）',
      `  --items=<条数>       合成数据条数，默认 ${DEFAULT_ITEMS}`,
      `  --seed=<整数>        随机种子，默认 ${DEFAULT_SEED}`,
      `  --port=<端口>        mock 服务器端口，默认 ${DEFAULT_MOCK_PORT}（被占用时自动顺延）`,
      `  --cdp-port=<端口>    Edge 调试端口，默认 ${DEFAULT_CDP_PORT}（被占用时自动顺延）`,
      '  --screenshot-dir=<目录> 截图目录，默认 docs/screenshots',
      '  --edge=<路径>        指定 Edge/Chrome 可执行文件',
      '  --keep-profile       保留临时 Edge profile（排障用）',
      '  --verbose            输出更详细的步骤信息',
      '  --timeout=<毫秒>     全局超时，默认 240000',
    ].join('\n'),
  )
}

const ANSI = { green: '\u001b[32m', red: '\u001b[31m', yellow: '\u001b[33m', dim: '\u001b[2m', reset: '\u001b[0m' }
const useColor = process.stdout.isTTY
const paint = (color, text) => (useColor ? color + text + ANSI.reset : text)
const log = (...args) => console.log(...args)
const logStep = (message) => log(`\n${paint(ANSI.dim, '──')} ${message}`)
const logInfo = (message) => log(`  ${paint(ANSI.dim, '·')} ${message}`)
const logWarn = (message) => log(`  ${paint(ANSI.yellow, '!')} ${message}`)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ------------------------------------------------------------------ */
/* 进程 / 端口工具                                                       */
/* ------------------------------------------------------------------ */

function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = createNetServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

/** 从 startPort 起找一个可用端口（避免与 dev 服务器 7801/5174/3080 冲突） */
async function findFreePort(startPort, attempts = 12) {
  for (let offset = 0; offset < attempts; offset++) {
    const port = startPort + offset
    if (await isPortFree(port)) return port
  }
  throw new Error(`从 ${startPort} 起的 ${attempts} 个端口都被占用`)
}

function killProcessTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return
  const pid = child.pid
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15_000 })
    } else {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
  } catch {
    /* ignore */
  }
}

function waitProcessExit(child, timeoutMs = 8_000) {
  if (!child || child.exitCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit)
      resolve()
    }, timeoutMs)
    function onExit() {
      clearTimeout(timer)
      resolve()
    }
    child.once('exit', onExit)
  })
}

/** 收集子进程输出（只保留尾部，失败时打印） */
function captureOutput(child, cap = 32_000) {
  const chunks = []
  let size = 0
  const onData = (chunk) => {
    const text = String(chunk)
    chunks.push(text)
    size += text.length
    while (size > cap && chunks.length > 1) size -= chunks.shift().length
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
  return () => chunks.join('')
}

/** 查找 Edge（也兼容 Chrome，方便在其它机器上运行） */
function resolveBrowserExecutable(explicitPath) {
  if (explicitPath) {
    if (!existsSync(explicitPath)) throw new Error(`指定的浏览器不存在：${explicitPath}`)
    return explicitPath
  }
  if (process.env.CORDCLEAN_EDGE_PATH) {
    if (existsSync(process.env.CORDCLEAN_EDGE_PATH)) return process.env.CORDCLEAN_EDGE_PATH
    throw new Error(`CORDCLEAN_EDGE_PATH 指向的浏览器不存在：${process.env.CORDCLEAN_EDGE_PATH}`)
  }
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) throw new Error('找不到 Edge/Chrome 可执行文件，请用 --edge=<路径> 指定')
  return found
}

/* ------------------------------------------------------------------ */
/* CDP 客户端                                                          */
/* ------------------------------------------------------------------ */

class CdpClient {
  constructor(socket) {
    this.socket = socket
    this.nextId = 0
    this.pending = new Map()
    this.listeners = new Map()
    socket.on('message', (raw) => this.#handleMessage(raw))
    socket.on('close', () => {
      for (const task of this.pending.values()) task.reject(new Error('CDP 连接已断开'))
      this.pending.clear()
    })
  }

  static async connect(webSocketDebuggerUrl, timeoutMs = 15_000) {
    const socket = new WebSocket(webSocketDebuggerUrl, { perMessageDeflate: false })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接 CDP WebSocket 超时')), timeoutMs)
      socket.once('open', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
    return new CdpClient(socket)
  }

  #handleMessage(raw) {
    let message
    try {
      message = JSON.parse(String(raw))
    } catch {
      return
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const task = this.pending.get(message.id)
      this.pending.delete(message.id)
      clearTimeout(task.timer)
      if (message.error) task.reject(new Error(`CDP 错误（${task.method}）：${message.error.message}`))
      else task.resolve(message.result)
      return
    }
    if (message.method) {
      for (const listener of this.listeners.get(message.method) ?? []) {
        try {
          listener(message.params)
        } catch {
          /* 单个监听器异常不影响其它监听器 */
        }
      }
    }
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set())
    this.listeners.get(method).add(listener)
    return () => this.listeners.get(method)?.delete(listener)
  }

  send(method, params = {}, timeoutMs = 30_000) {
    const id = ++this.nextId
    const payload = JSON.stringify({ id, method, params })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP 超时（${method}）`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, method, timer })
      try {
        this.socket.send(payload)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  /** 在页面上下文执行表达式（返回可结构化克隆的值） */
  async evaluate(expression, { awaitPromise = true, returnByValue = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      const description =
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.exception?.value ?? result.exceptionDetails.text
      throw new Error(`页面脚本异常：${description}`)
    }
    return result.result?.value
  }

  /** 轮询直到回调返回真值（或抛错）；超时抛错 */
  async waitFor(description, fn, timeoutMs = 30_000, interval = 200) {
    const startedAt = Date.now()
    let lastError
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const value = await fn()
        if (value) return value
      } catch (error) {
        lastError = error
      }
      await sleep(interval)
    }
    const suffix = lastError ? `（最后错误：${lastError.message}）` : ''
    throw new Error(`等待超时：${description}${suffix}`)
  }

  close() {
    try {
      this.socket.close()
    } catch {
      /* ignore */
    }
    for (const task of this.pending.values()) {
      clearTimeout(task.timer)
      task.reject(new Error('CDP 已关闭'))
    }
    this.pending.clear()
  }
}

/* ------------------------------------------------------------------ */
/* 验收断言收集                                                         */
/* ------------------------------------------------------------------ */

class Cheks {
  constructor(mode) {
    this.mode = mode
    this.records = []
  }

  pass(name, detail) {
    this.records.push({ name, ok: true, detail })
    log(`  ${paint(ANSI.green, '✓ PASS')}  ${name}${detail ? paint(ANSI.dim, `  (${detail})`) : ''}`)
  }

  fail(name, detail) {
    this.records.push({ name, ok: false, detail })
    log(`  ${paint(ANSI.red, '✗ FAIL')}  ${name}${detail ? `  →  ${detail}` : ''}`)
  }

  /** 断言：condition 为真才算通过；detail 或 failDetail 用于输出 */
  assert(name, condition, detail, failDetail) {
    if (condition) this.pass(name, detail)
    else this.fail(name, failDetail ?? detail)
    return Boolean(condition)
  }

  get failed() {
    return this.records.filter((record) => !record.ok)
  }

  get passedCount() {
    return this.records.length - this.failed.length
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  printUsage()
  process.exit(0)
}

const mode = options.mode
const screenshotDir = path.resolve(options.screenshotDir ?? DEFAULT_SCREENSHOT_DIR)
const items = Number(options.items ?? process.env.CORDCLEAN_MOCK_ITEMS ?? DEFAULT_ITEMS)
const seed = Number(options.seed ?? process.env.CORDCLEAN_MOCK_SEED ?? DEFAULT_SEED)
const verbose = Boolean(options.verbose)
const timeoutMs = Number(options.timeout ?? 240_000)
const checks = new Cheks(mode)

const fixture = createFixture({ items, seed })
const expected = fixture.summary

log('')
log('  ╭──────────────────────────────────────────────────────╮')
log('  │  CordClean 清理页 UI 验收（mock RPC + 无头 Edge）      │')
log('  ╰──────────────────────────────────────────────────────╯')
log(`  模式:     ${mode}`)
log(`  合成数据: ${expected.items} 条 / ${expected.tasks} 任务 / ${expected.protectedCount} protected / 推荐 ${expected.recommend.count} 项`)
log(`  期望值:   safe ${expected.riskCounts.safe} · caution ${expected.riskCounts.caution} · risky ${expected.riskCounts.risky}`)

let mockChild
let mockLog = () => ''
let edgeChild
let edgeLog = () => ''
let cdp
let mockPort
let cdpPort
let profileDir
let watchdog
let cleanedUp = false
const pageErrors = []
const pageWarnings = []

async function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  if (watchdog) clearTimeout(watchdog)
  try {
    cdp?.close()
  } catch {
    /* ignore */
  }
  if (edgeChild) {
    killProcessTree(edgeChild)
    await waitProcessExit(edgeChild, 8_000)
    // Edge 被杀后 crashpad / 子进程可能短暂继续持有 profile 文件句柄，等一拍再删
    await sleep(600)
  }
  if (mockChild) {
    killProcessTree(mockChild)
    await waitProcessExit(mockChild, 8_000)
  }
  if (profileDir) {
    if (options.keepProfile) {
      logInfo(`已保留临时 Edge profile：${profileDir}`)
    } else {
      let removed = false
      let lastError
      for (let attempt = 0; attempt < 25; attempt++) {
        try {
          rmSync(profileDir, { recursive: true, force: true })
          removed = true
          break
        } catch (error) {
          lastError = error
          await sleep(300)
        }
      }
      if (!removed && existsSync(profileDir)) {
        // Windows 上 Edge 退出后 crashpad / 杀毒扫描可能短暂占用 profile 文件句柄。
        // 主进程不再等待，交给一个 detached 子进程在后台继续重试清理（最多约 60 秒）。
        try {
          const helperCode = `const fs = require('node:fs'); const dir = process.argv[1]; let tries = 0; const timer = setInterval(() => { tries++; try { fs.rmSync(dir, { recursive: true, force: true }); clearInterval(timer); process.exit(0) } catch (error) {} if (tries > 120) { clearInterval(timer); process.exit(1) } }, 500)`
          const helper = spawn(process.execPath, ['-e', helperCode, profileDir], { detached: true, stdio: 'ignore', windowsHide: true })
          helper.unref()
          logWarn(`临时 profile 暂被占用，已交由后台进程继续清理：${profileDir}（${lastError?.code ?? lastError?.message ?? 'unknown'}）`)
        } catch {
          logWarn(`临时 Edge profile 未能删除（可手动清理）：${profileDir}`)
        }
      }
    }
  }
}

function registerErrorCollectors(client) {
  client.on('Runtime.exceptionThrown', (params) => {
    const detail = params.exceptionDetails
    const description = detail?.exception?.description ?? detail?.exception?.value ?? detail?.text ?? '未知异常'
    pageErrors.push(`[exception] ${description}`)
  })
  client.on('Runtime.consoleAPICalled', (params) => {
    const text = (params.args ?? [])
      .map((arg) => arg.value ?? arg.description ?? arg.unserializableValue ?? '')
      .join(' ')
      .trim()
    if (params.type === 'error') pageErrors.push(`[console.error] ${text}`)
    else if (params.type === 'warning' || params.type === 'warn') pageWarnings.push(`[console.warn] ${text}`)
  })
  client.on('Log.entryAdded', (params) => {
    const entry = params.entry ?? {}
    const text = entry.text ?? ''
    if (entry.level === 'error') {
      // favicon / sourcemap 之类静态资源 404 不应算界面错误，mock 已对 favicon 返回 204；
      // 这里仍保留原始信息便于排障，但过滤浏览器扩展/网络探测类噪声。
      if (/favicon\.ico/i.test(entry.url ?? '')) return
      pageErrors.push(`[log.${entry.source ?? 'unknown'}] ${text}`)
    } else if (entry.level === 'warning') {
      pageWarnings.push(`[log.warning] ${text}`)
    }
  })
}

/**
 * 全页截图。
 *
 * 本应用是「固定视口 + 内部滚动容器（.content）」布局：body 高度等于视口，
 * Page.captureScreenshot 只能截到视口内的内容。因此先临时把 CDP viewport
 * 撑到内容总高度（.content 的 scrollHeight + 外壳高度），整页渲染后再截图，
 * 最后恢复为 1600×1000。
 */
async function captureFullPage(client, file) {
  const viewport = { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }
  const measure = () =>
    client.evaluate(`(() => {
      const content = document.querySelector('.content')
      const contentScroll = content ? content.scrollHeight : 0
      const contentClient = content ? content.clientHeight : 0
      const extra = content ? Math.max(0, contentScroll - contentClient) : 0
      return { innerHeight: window.innerHeight, docHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight), extra }
    })()`)
  const first = await measure()
  const targetHeight = Math.min(12_000, Math.max(viewport.height, first.innerHeight + first.extra + 8))
  let restored = false
  const restore = async () => {
    if (restored) return
    restored = true
    try {
      await client.send('Emulation.setDeviceMetricsOverride', viewport)
      await sleep(150)
    } catch {
      /* ignore */
    }
  }
  try {
    if (targetHeight > first.innerHeight) {
      await client.send('Emulation.setDeviceMetricsOverride', { ...viewport, height: targetHeight })
      await sleep(450)
    }
    await client.evaluate(`(() => { window.scrollTo(0, 0); const content = document.querySelector('.content'); if (content) content.scrollTop = 0 })()`)
    await sleep(250)
    const metrics = await client.send('Page.getLayoutMetrics')
    const size = metrics.cssContentSize ?? metrics.contentSize ?? { width: viewport.width, height: targetHeight }
    const width = Math.max(800, Math.ceil(size.width))
    const height = Math.max(600, Math.ceil(Math.max(size.height, targetHeight)))
    const result = await client.send(
      'Page.captureScreenshot',
      {
        format: 'png',
        captureBeyondViewport: true,
        fromSurface: true,
        clip: { x: 0, y: 0, width, height, scale: 1 },
      },
      60_000,
    )
    const buffer = Buffer.from(result.data, 'base64')
    writeFileSync(file, buffer)
    return { file, bytes: buffer.length, width, height }
  } finally {
    await restore()
  }
}

/** 切换主题：优先点界面上的主题按钮，退化为直接改 html.dark class */
async function setTheme(client, theme) {
  const currentDark = await client.evaluate("document.documentElement.classList.contains('dark')")
  const wantDark = theme === 'dark'
  if (currentDark !== wantDark) {
    const toggled = await client.evaluate(
      `(() => { const btn = document.querySelector('.theme-toggle'); if (!btn) return false; btn.click(); return true })()`,
    )
    if (!toggled) {
      await client.evaluate(
        `(() => { document.documentElement.classList.toggle('dark', ${wantDark}); try { localStorage.setItem('cordclean.theme', '${theme}') } catch (error) {} })()`,
      )
    }
    await sleep(450)
  }
  return client.evaluate("document.documentElement.classList.contains('dark')")
}

function formatBytesShort(bytes) {
  return formatBytes(bytes)
}

/* --------------------------- 冒烟断言（旧版/基础） --------------------------- */

async function runSmokeAssertions(client) {
  logStep('基础冒烟断言（页面启动 / mock RPC / 无 JS 错误）')

  const bootInfo = await client.evaluate('window.__CORDCLEAN__ ?? null')
  checks.assert(
    '注入 window.__CORDCLEAN__ 且 token/wsUrl 正确',
    Boolean(bootInfo) && bootInfo.token === MOCK_TOKEN && /\/rpc$/.test(bootInfo.wsUrl ?? ''),
    `token=${bootInfo?.token} wsUrl=${bootInfo?.wsUrl}`,
    `window.__CORDCLEAN__=${JSON.stringify(bootInfo)}`,
  )

  const shell = await client.evaluate(`(() => ({
    sidebar: Boolean(document.querySelector('.sidebar')),
    navCount: document.querySelectorAll('.nav-item').length,
    title: document.querySelector('.cc-page-title h1')?.textContent?.trim() ?? '',
    hash: location.hash,
  }))()`)
  checks.assert(
    '应用外壳与侧边栏渲染',
    shell.sidebar && shell.navCount > 0,
    `nav=${shell.navCount} hash=${shell.hash}`,
    `sidebar=${shell.sidebar} navCount=${shell.navCount}`,
  )

  const snapshot = await client.evaluate(`(() => {
    const text = document.body.innerText.replace(/\\s+/g, ' ')
    return {
      groupRows: document.querySelectorAll('.group-row').length,
      itemRows: document.querySelectorAll('.item-row').length,
      taskCards: document.querySelectorAll('.task-card').length,
      tableRows: document.querySelectorAll('.el-table__row').length,
      statCards: document.querySelectorAll('.cc-stat').length,
      footer: document.querySelector('.footer-bar')?.innerText?.replace(/\\s+/g, ' ').trim() ?? '',
      hasTotal: /(?:2,?960|3,?000)\\s*(?:项|条)/.test(text),
    }
  })()`)
  const dataLoaded =
    snapshot.groupRows > 0 ||
    snapshot.taskCards === expected.tasks ||
    snapshot.tableRows > 0 ||
    snapshot.hasTotal
  checks.assert(
    'mock 扫描数据经 WebSocket RPC 渲染到清理页',
    dataLoaded,
    `groupRow=${snapshot.groupRows} taskCard=${snapshot.taskCards} tableRow=${snapshot.tableRows} stat=${snapshot.statCards} hasTotal=${snapshot.hasTotal}`,
    `页面未渲染出扫描数据：${JSON.stringify(snapshot)}（mock server 输出：${mockLog().slice(-1200)}）`,
  )

  if (snapshot.taskCards > 0) {
    checks.assert('旧版任务卡片数量与 mock tasks/list 一致', snapshot.taskCards === expected.tasks, `${snapshot.taskCards} / ${expected.tasks}`)
  }
  if (snapshot.footer) {
    const match = /(\d[\d,]*)\s*项已选/.exec(snapshot.footer)
    const count = match ? Number(match[1].replace(/,/g, '')) : null
    if (count !== null) {
      checks.assert(
        '旧版默认勾选数等于推荐策略期望值（mock scan/last 生效）',
        count === expected.recommend.count,
        `已选 ${count} / 推荐 ${expected.recommend.count}`,
        `旧版 footer 已选 ${count}，期望推荐 ${expected.recommend.count}（${snapshot.footer.slice(0, 160)}）`,
      )
    }
  }

  await sleep(400)
  checks.assert(
    '页面无 JS 异常 / console.error / Log.error',
    pageErrors.length === 0,
    '0 条错误',
    `${pageErrors.length} 条：${[...new Set(pageErrors)].slice(0, 8).join(' | ')}`,
  )

  logStep('截图（冒烟）')
  const light = await captureFullPage(client, path.join(screenshotDir, 'scan-select-smoke-light.png'))
  logInfo(`亮色全页截图：${path.relative(ROOT, light.file)}（${light.width}×${light.height}, ${(light.bytes / 1024).toFixed(0)} KB）`)
  const darkState = await setTheme(client, 'dark')
  const dark = await captureFullPage(client, path.join(screenshotDir, 'scan-select-smoke-dark.png'))
  logInfo(`暗色全页截图：${path.relative(ROOT, dark.file)}（${dark.width}×${dark.height}, ${(dark.bytes / 1024).toFixed(0)} KB）`)
  await setTheme(client, 'light')
  checks.assert('亮/暗主题切换生效', darkState === true, `dark class=${darkState}`)
  checks.assert('冒烟截图文件已生成', light.bytes > 5_000 && dark.bytes > 5_000, `${(light.bytes / 1024).toFixed(0)} KB / ${(dark.bytes / 1024).toFixed(0)} KB`)
}

/* --------------------------- 最终验收断言（新版 CleanView） --------------------------- */

async function readSelectedCount(client) {
  return client.evaluate(`(() => {
    const el = document.querySelector('.selected-count')
    const text = (el ? el.innerText : (document.querySelector('.footer-bar')?.innerText ?? '')).replace(/\\s+/g, ' ').trim()
    const match = /(\\d[\\d,]*)\\s*项/.exec(text)
    return { text, count: match ? Number(match[1].replace(/,/g, '')) : null }
  })()`)
}

async function findGroupRowInfo(client) {
  return client.evaluate(`(() => [...document.querySelectorAll('.group-row')].map((row, index) => {
    const checkbox = row.querySelector('.group-checkbox')
    const input = checkbox?.querySelector?.('input')
    const className = typeof checkbox?.className === 'string' ? checkbox.className : ''
    const aria = checkbox?.getAttribute?.('aria-checked') ?? ''
    let state = aria || className
    if (input) state += input.indeterminate ? ' mixed-indeterminate' : input.checked ? ' checked' : ' unchecked'
    return {
      index,
      taskId: row.getAttribute('data-task-id') ?? '',
      text: row.innerText.replace(/\\s+/g, ' ').trim().slice(0, 200),
      state,
      hasCheckbox: Boolean(checkbox),
    }
  }))()`)
}

/** 把分组行文本匹配到 fixture 里的任务或分类（取最长匹配名） */
function identifyGroup(rowText) {
  const normalized = rowText.replace(/\s+/g, '')
  let best = null
  for (const task of fixture.tasks) {
    const name = task.name.replace(/\s+/g, '')
    if (normalized.includes(name) && (!best || name.length > best.name.length)) {
      best = { kind: 'task', id: task.id, name: task.name }
    }
  }
  for (const category of expected.perCategory) {
    if (normalized.includes(category.name) && (!best || category.name.length > best.name.length)) {
      best = { kind: 'category', id: category.category, name: category.name }
    }
  }
  return best
}

function statsForGroup(group) {
  if (!group) return undefined
  return group.kind === 'task'
    ? expected.perTask.find((stat) => stat.taskId === group.id)
    : expected.perCategory.find((stat) => stat.category === group.id)
}

async function runFinalAssertions(client) {
  /* ---------- 1. 分组总览 ---------- */
  logStep('1. 分组总览与推荐横幅')
  const overview = await client.evaluate(`(() => {
    const groupRows = [...document.querySelectorAll('.group-row')]
    const overviewRow = document.querySelector('.overview-row, .summary-row, .clean-summary, .clean-overview')
    const banner = document.querySelector('.recommend-banner')
    return {
      groupCount: groupRows.length,
      firstRows: groupRows.slice(0, 3).map((row) => row.innerText.replace(/\s+/g, ' ').trim().slice(0, 160)),
      overviewText: overviewRow ? overviewRow.innerText.replace(/\s+/g, ' ').trim() : '',
      bannerText: banner ? banner.innerText.replace(/\s+/g, ' ').trim() : '',
      statCards: [...document.querySelectorAll('.cc-stat')].map((card) => ({
        label: (card.querySelector('.cc-stat-label')?.innerText ?? '').trim(),
        value: (card.querySelector('.cc-stat-value')?.innerText ?? '').trim(),
      })),
      bodyText: document.body.innerText.replace(/\s+/g, ' '),
    }
  })()`)
  checks.assert('清理页出现分组视图（.group-row 数量 > 0）', overview.groupCount > 0, `${overview.groupCount} 个分组行`, `.group-row 数量为 0；首屏文本：${overview.bodyText.slice(0, 300)}`)
  // 「总览 3000 相关合计」：新版顶部统计卡显示「可清理项 2,960」「受保护 40」，
  // 两者之和即扫描总数 3000（可清理项在界面上以 zh-CN 千分位显示）。
  const parseStatNumber = (text) => {
    const match = /(\d[\d,]*)/.exec(text ?? '')
    return match ? Number(match[1].replace(/,/g, '')) : NaN
  }
  const cleanableCard = overview.statCards.find((card) => /可清理项/.test(card.label))
  const protectedCard = overview.statCards.find((card) => /受保护/.test(card.label))
  const cleanableValue = parseStatNumber(cleanableCard?.value)
  const protectedValue = parseStatNumber(protectedCard?.value)
  const combinedTotal = cleanableValue + protectedValue
  const totalTextOk =
    cleanableValue === expected.nonProtectedCount &&
    protectedValue === expected.protectedCount &&
    combinedTotal === expected.items
  checks.assert(
    `总览统计合计等于扫描总数 ${expected.items}（可清理 ${expected.nonProtectedCount} + 受保护 ${expected.protectedCount}）`,
    totalTextOk,
    `可清理项 ${cleanableCard?.value ?? '?'} + 受保护 ${protectedCard?.value ?? '?'} = ${expected.items}`,
    `统计卡未得到 ${expected.items}（可清理项=${cleanableCard?.value ?? '缺失'}、受保护=${protectedCard?.value ?? '缺失'}）；统计卡=${JSON.stringify(overview.statCards).slice(0, 500)}`,
  )

  checks.assert('推荐横幅 .recommend-banner 存在', Boolean(overview.bannerText), overview.bannerText.slice(0, 120), '未找到 .recommend-banner')
  const bannerCountOk = new RegExp(`(^|[^\\d])${expected.recommend.count}([^\\d]|$)`).test(overview.bannerText)
  const bannerSizeOk = /\d+(?:\.\d+)?\s*(?:B|KB|MB|GB|TB)/.test(overview.bannerText)
  checks.assert(
    '推荐横幅包含推荐项数与大小',
    bannerCountOk && bannerSizeOk,
    `推荐 ${expected.recommend.count} 项 / ${formatBytesShort(expected.recommend.bytes)}`,
    `横幅未同时包含项数 ${expected.recommend.count} 与大小：${overview.bannerText.slice(0, 200)}`,
  )

  /* ---------- 2. 首屏默认选中 ---------- */
  logStep('2. 首屏默认选中（推荐策略）')
  const selected = await readSelectedCount(client)
  checks.assert(
    '首屏默认选中数 > 0（.selected-count / footer）',
    typeof selected.count === 'number' && selected.count > 0,
    `已选 ${selected.count} 项 · ${selected.text.slice(0, 80)}`,
    `无法从 .selected-count/footer 解析选中数：${selected.text.slice(0, 160)}`,
  )
  checks.assert(
    `首屏默认选中数等于安全推荐数（${expected.recommend.count}，不含 risky/protected）`,
    selected.count === expected.recommend.count,
    `已选 ${selected.count} = 推荐 ${expected.recommend.count}`,
    `已选 ${selected.count}，期望推荐 ${expected.recommend.count}（safe 且非 protected）；若实现有意不同请报告 Lead`,
  )

  /* ---------- 3. 明细视图分页 ---------- */
  logStep('3. 明细视图与分页')
  const tabClicked = await client.evaluate(
    `(() => { const tab = document.querySelector('.view-tab[data-view="items"]'); if (!tab) return false; tab.click(); return true })()`,
  )
  if (!checks.assert('存在并点击 .view-tab[data-view="items"]', tabClicked, '明细视图切换成功', '未找到 .view-tab[data-view="items"]')) {
    // 后续断言依赖明细视图，仍继续尝试（若已渲染明细也可通过）
  }
  await sleep(400)
  const itemRowCount = await client.evaluate(`document.querySelectorAll('.item-row').length`)
  const pageSize = expected.pageSizeDefault
  checks.assert(
    `明细视图 .item-row 数量等于当前页大小（${pageSize}）`,
    itemRowCount === Math.min(pageSize, expected.nonProtectedCount),
    `${itemRowCount} 行`,
    `.item-row=${itemRowCount}，期望 ${Math.min(pageSize, expected.nonProtectedCount)}（默认每页 ${pageSize}、默认排除 ${expected.protectedCount} 条 protected）`,
  )

  /* ---------- 4. 详情抽屉 ---------- */
  logStep('4. 明细行详情抽屉')
  // 实际 DOM：.item-detail-btn 位于操作列（与名称列的 .item-row 同级、不在其内部），
  // 因此按实际渲染用 .el-table__row .item-detail-btn（取首行）。
  const detailClicked = await client.evaluate(
    `(() => { const button = document.querySelector('.el-table__row .item-detail-btn') ?? document.querySelector('.item-detail-btn'); if (!button) return false; button.click(); return true })()`,
  )
  checks.assert('存在并点击明细行「详情」按钮（.item-detail-btn）', detailClicked, '详情按钮点击成功', '未找到 .el-table__row .item-detail-btn')
  await sleep(450)
  let drawer = { visible: false, text: '' }
  try {
    await client.waitFor('详情抽屉出现', async () => {
      drawer = await client.evaluate(`(() => {
        const el = document.querySelector('.detail-drawer')
        if (!el) return { visible: false, text: '' }
        const panel = el.closest('.el-drawer') ?? el
        const style = getComputedStyle(panel)
        const box = panel.getBoundingClientRect()
        const visible = style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0
        return { visible, text: el.innerText.replace(/\\s+/g, ' ').trim() }
      })()`)
      return drawer.visible ? drawer : undefined
    }, 8_000)
  } catch {
    drawer = { visible: false, text: '' }
  }
  checks.assert('.detail-drawer 打开且包含详情内容（el-drawer 内）', drawer.visible && drawer.text.length > 10, drawer.text.slice(0, 160), `detail-drawer 未出现或内容为空：${JSON.stringify(drawer)}`)
  // 关闭抽屉：先点 el-drawer 自带关闭按钮，ESC 兜底；等遮罩/抽屉不可见
  await client.evaluate(`(() => {
    const button = document.querySelector('.el-drawer__close-btn')
    if (button) { button.click(); return 'close-btn' }
    const scope = document.querySelector('.detail-drawer')
    const fallback = scope ? [...scope.closest('.el-drawer, .el-overlay')?.querySelectorAll('button') ?? []].find((item) => /关闭|取消/.test(item.textContent ?? '')) : null
    if (fallback) { fallback.click(); return 'text-btn' }
    return 'none'
  })()`).catch(() => {})
  await sleep(350)
  const drawerStillVisible = await client.evaluate(`(() => {
    const el = document.querySelector('.detail-drawer')
    if (!el) return false
    const panel = el.closest('.el-drawer') ?? el
    const box = panel.getBoundingClientRect()
    return getComputedStyle(panel).display !== 'none' && box.width > 0
  })()`)
  if (drawerStillVisible) {
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }).catch(() => {})
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }).catch(() => {})
    await sleep(450)
  }

  /* ---------- 5. 整组勾选 ---------- */
  logStep('5. 分组视图整组勾选')
  await client.evaluate(`(() => { const tab = document.querySelector('.view-tab[data-view="groups"]'); if (tab) tab.click() })()`)
  await sleep(400)
  const before = await readSelectedCount(client)
  const groupRows = await findGroupRowInfo(client)
  checks.assert('分组视图存在可勾选分组', groupRows.some((row) => row.hasCheckbox), `${groupRows.length} 个分组行`, '未找到 .group-checkbox')
  // 选一个部分选中（indeterminate/mixed）的分组；没有则退化为第一个
  const partial = groupRows.find((row) => /mixed|indeterminate|partial/i.test(row.state))
  const targetRow = partial ?? groupRows[0]
  // 新版分组行带 data-task-id，优先精确匹配；否则按行文本匹配任务/分类名
  const task = targetRow?.taskId ? fixture.tasks.find((item) => item.id === targetRow.taskId) : undefined
  const group = task ? { kind: 'task', id: task.id, name: task.name } : targetRow ? identifyGroup(targetRow.text) : undefined
  const groupStat = statsForGroup(group)
  if (targetRow) {
    logInfo(`目标分组：${group?.kind ?? '?'} ${group?.name ?? '?'}（row ${targetRow.index}，state=${targetRow.state || 'unknown'}）`)
    logInfo(`分组行文本：${targetRow.text}`)
  }
  const clicked = await client.evaluate(
    `(() => { const row = document.querySelectorAll('.group-row')[${targetRow?.index ?? 0}]; const checkbox = row?.querySelector('.group-checkbox'); if (!checkbox) return false; checkbox.click(); return true })()`,
  ).catch(() => false)
  checks.assert('点击第一个（部分选中的）分组勾选框', Boolean(clicked), `row ${targetRow?.index ?? 0}`, '分组勾选框点击失败')
  await sleep(500)
  const after = await readSelectedCount(client)
  const delta = typeof before.count === 'number' && typeof after.count === 'number' ? after.count - before.count : null
  let expectedDeltas = []
  if (groupStat) {
    // 勾选（或取消）方向都接受；候选：整组全选非保护项 / 跳过 risky 只选 caution
    expectedDeltas = [
      { label: '整组选中非保护项（含 risky）', value: groupStat.nonProtectedCount - groupStat.safeNonProtectedCount },
      { label: '整组选中但跳过 risky（仅 caution）', value: groupStat.cautionNonProtectedCount },
      { label: '取消整组选中（原为全选）', value: groupStat.nonProtectedCount },
    ].filter((candidate) => candidate.value > 0)
  }
  const matchedDelta = expectedDeltas.find((candidate) => Math.abs(delta ?? 0) === candidate.value)
  checks.assert(
    `整组勾选后选中数变化对应组非保护项数（分组：${group?.name ?? '未知'}）`,
    matchedDelta !== undefined,
    `${before.count} → ${after.count}（${delta > 0 ? '+' : ''}${delta}，${matchedDelta?.label}）`,
    `选中数 ${before.count} → ${after.count}（${delta}），期望变化量 ±${expectedDeltas.map((candidate) => `${candidate.value}（${candidate.label}）`).join(' 或 ±') || '无（无法识别分组）'}；分组行文本：${targetRow?.text ?? 'n/a'}`,
  )

  /* ---------- 6. 风险筛选 ---------- */
  logStep('6. 明细视图风险筛选')
  await client.evaluate(`(() => { const tab = document.querySelector('.view-tab[data-view="items"]'); if (tab) tab.click() })()`)
  await sleep(400)
  const riskyFilterClicked = await client.evaluate(
    `(() => { const filter = document.querySelector('.risk-filter[data-risk="risky"]'); if (!filter) return false; filter.click(); return true })()`,
  )
  checks.assert('存在并点击 .risk-filter[data-risk="risky"]', riskyFilterClicked, '风险筛选项点击成功', '未找到 .risk-filter[data-risk="risky"]')
  await sleep(500)
  const riskyState = await client.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.item-row')]
    return {
      rowCount: rows.length,
      allRisky: rows.length > 0 && rows.every((row) => /高风险/.test(row.innerText)),
      sample: rows.slice(0, 3).map((row) => row.innerText.replace(/\\s+/g, ' ').trim().slice(0, 100)),
      bodyText: document.body.innerText.replace(/\\s+/g, ' '),
    }
  })()`)
  const expectedRiskyRows = Math.min(pageSize, expected.riskyNonProtectedCount)
  checks.assert('风险筛选后明细仅显示高风险行', riskyState.allRisky, `${riskyState.rowCount} 行全部为高风险`, `筛选后存在非高风险行：${JSON.stringify(riskyState.sample)}`)
  checks.assert(
    `高风险筛选行数符合分页/数据（期望 ${expectedRiskyRows} 行，共 ${expected.riskyNonProtectedCount} 条）`,
    riskyState.rowCount === expectedRiskyRows,
    `${riskyState.rowCount} 行`,
    `.item-row=${riskyState.rowCount}，期望 ${expectedRiskyRows}；共 ${expected.riskyNonProtectedCount} 条非保护 risky 项`,
  )
  const riskyCountPattern = new RegExp(`(?:${expected.riskyNonProtectedCount}\\s*(?:项|条)|(?:共|Total)\\s*${expected.riskyNonProtectedCount})`)
  checks.assert(
    '高风险筛选后的计数与合成数据一致',
    riskyCountPattern.test(riskyState.bodyText),
    `页面显示 ${expected.riskyNonProtectedCount} 条`,
    `页面未找到高风险计数 ${expected.riskyNonProtectedCount}：${riskyState.bodyText.slice(0, 300)}`,
  )

  /* ---------- 7. 清理确认对话框 ---------- */
  logStep('7. 清理确认对话框')
  const beforeDialog = await readSelectedCount(client)
  const cleanButtonClicked = await client.evaluate(`(() => {
    const buttons = [...document.querySelectorAll('button')].filter((button) => !button.disabled)
    const target = buttons.find((button) => /开始清理|立即清理|^清理$|清理选中/.test((button.textContent ?? '').trim())) ?? buttons.find((button) => button.classList.contains('clean-btn'))
    if (!target) return false
    target.click()
    return true
  })()`)
  checks.assert('找到并点击「清理」按钮', cleanButtonClicked, `点击前已选 ${beforeDialog.count} 项`, '未找到可用的「清理/开始清理」按钮')
  let dialog = { visible: false, text: '' }
  try {
    await client.waitFor('确认对话框出现', async () => {
      dialog = await client.evaluate(`(() => {
        const el = document.querySelector('.confirm-dialog')
        if (!el) return { visible: false, text: '' }
        const style = getComputedStyle(el)
        return { visible: style.display !== 'none' && style.visibility !== 'hidden', text: el.innerText.replace(/\\s+/g, ' ').trim() }
      })()`)
      return dialog.visible ? dialog : undefined
    }, 6_000)
  } catch {
    dialog = { visible: false, text: '' }
  }
  const dialogCount = Number(/(\d[\d,]*)\s*项/.exec(dialog.text)?.[1]?.replace(/,/g, '') ?? NaN)
  const dialogSize = /\d+(?:\.\d+)?\s*(?:B|KB|MB|GB|TB)/.test(dialog.text)
  checks.assert('.confirm-dialog 打开', dialog.visible, dialog.text.slice(0, 180), `确认对话框未出现：${dialog.text}`)
  checks.assert(
    '确认摘要包含已选数量与大小',
    dialog.visible && dialogSize && Number.isFinite(dialogCount) && dialogCount > 0,
    `摘要：${dialog.text.slice(0, 160)}`,
    `摘要缺少数量/大小（count=${dialogCount}, size=${dialogSize}）：${dialog.text.slice(0, 200)}`,
  )
  checks.assert(
    '确认摘要数量等于当前选中数',
    Number.isFinite(dialogCount) && dialogCount === beforeDialog.count,
    `${dialogCount} 项`,
    `对话框 ${dialogCount} 项，当前已选 ${beforeDialog.count} 项`,
  )
  // 关闭确认框：点 el-dialog footer 的「取消」（.confirm-dialog 只是内容容器，
  // 按钮在 el-dialog 的 footer 中），ESC 兜底；不触发真正的清理。
  await client.evaluate(`(() => {
    const dialogEl = document.querySelector('.confirm-dialog')
    const panel = dialogEl?.closest('.el-dialog') ?? document.querySelector('.el-dialog') ?? document
    const cancel = [...panel.querySelectorAll('button')].find((button) => /取消|关闭/.test((button.textContent ?? '').trim()))
    if (cancel) { cancel.click(); return true }
    return false
  })()`).catch(() => {})
  await sleep(350)
  const dialogStillVisible = await client.evaluate(`(() => {
    const el = document.querySelector('.confirm-dialog')
    if (!el) return false
    const panel = el.closest('.el-dialog') ?? el
    const box = panel.getBoundingClientRect()
    return getComputedStyle(panel).display !== 'none' && box.width > 0
  })()`)
  if (dialogStillVisible) {
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }).catch(() => {})
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }).catch(() => {})
    await sleep(450)
  }
  const dialogClosed = await client.evaluate(`(() => {
    const el = document.querySelector('.confirm-dialog')
    if (!el) return true
    const panel = el.closest('.el-dialog') ?? el
    return getComputedStyle(panel).display === 'none' || panel.getBoundingClientRect().width === 0
  })()`)
  checks.assert('确认对话框可取消关闭（不执行清理）', dialogClosed, '已关闭', '取消后对话框仍然可见')

  /* ---------- 8. 亮/暗色全页截图 ---------- */
  logStep('8. 亮色 / 暗色全页截图')
  await client.evaluate(`(() => { const tab = document.querySelector('.view-tab[data-view="groups"]'); if (tab) tab.click() })()`)
  await setTheme(client, 'light')
  await sleep(300)
  const light = await captureFullPage(client, path.join(screenshotDir, 'scan-select-light.png'))
  logInfo(`亮色全页截图：${path.relative(ROOT, light.file)}（${light.width}×${light.height}, ${(light.bytes / 1024).toFixed(0)} KB）`)
  const darkState = await setTheme(client, 'dark')
  const dark = await captureFullPage(client, path.join(screenshotDir, 'scan-select-dark.png'))
  logInfo(`暗色全页截图：${path.relative(ROOT, dark.file)}（${dark.width}×${dark.height}, ${(dark.bytes / 1024).toFixed(0)} KB）`)
  await setTheme(client, 'light')
  checks.assert('亮/暗主题切换生效', darkState === true, `dark class=${darkState}`)
  checks.assert(
    '截图文件已生成（scan-select-light/dark.png）',
    light.bytes > 5_000 && dark.bytes > 5_000,
    `${(light.bytes / 1024).toFixed(0)} KB / ${(dark.bytes / 1024).toFixed(0)} KB`,
    `截图过小：${light.bytes} B / ${dark.bytes} B`,
  )

  /* ---------- 9. 无 JS 错误 ---------- */
  logStep('9. 页面错误检查')
  await sleep(400)
  checks.assert(
    '页面无 JS 异常 / console.error / Log.error',
    pageErrors.length === 0,
    '0 条错误',
    `${pageErrors.length} 条：${[...new Set(pageErrors)].slice(0, 10).join(' | ')}`,
  )
}

/* --------------------------- 启动与总控 --------------------------- */

async function main() {
  if (!existsSync(path.join(ROOT, 'packages', 'ui', 'dist', 'index.html'))) {
    throw new Error('缺少 packages/ui/dist/index.html，请先运行 pnpm build:ui')
  }
  mkdirSync(screenshotDir, { recursive: true })

  /* 1. 启动 mock server */
  logStep('启动 mock RPC 服务器')
  mockPort = await findFreePort(Number(options.port ?? DEFAULT_MOCK_PORT))
  mockChild = spawn(process.execPath, [MOCK_SCRIPT, `--port=${mockPort}`, `--items=${items}`, `--seed=${seed}`], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  mockLog = captureOutput(mockChild)
  mockChild.once('exit', (code, signal) => {
    if (!cleanedUp && code !== 0 && code !== null) logWarn(`mock server 提前退出（code=${code}, signal=${signal}）`)
  })
  const mockUrl = `http://127.0.0.1:${mockPort}/`
  await waitHttpReady(`${mockUrl}api/ping`, 25_000)
  const ping = await (await fetch(`${mockUrl}api/ping`)).json()
  logInfo(`mock: ${mockUrl}（${ping.items} 条 / ${ping.tasks} 任务）`)
  if (ping.items !== expected.items) throw new Error(`mock server 数据条数 ${ping.items} 与期望 ${expected.items} 不一致`)

  /* 2. 启动无头 Edge */
  logStep('启动无头 Edge（CDP）')
  const browserExecutable = resolveBrowserExecutable(options.edge)
  logInfo(`浏览器：${browserExecutable}`)
  cdpPort = await findFreePort(Number(options.cdpPort ?? DEFAULT_CDP_PORT))
  profileDir = mkdtempSync(path.join(os.tmpdir(), 'cordclean-verify-edge-'))
  const targetUrl = `${mockUrl}#clean`
  edgeChild = spawn(
    browserExecutable,
    [
      '--headless=new',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-extensions',
      '--disable-default-apps',
      '--disable-gpu',
      '--disable-breakpad',
      '--disable-crash-reporter',
      '--noerrdialogs',
      '--hide-scrollbars',
      '--mute-audio',
      '--no-sandbox',
      '--force-color-profile=srgb',
      '--window-size=1600,1000',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  )
  edgeLog = captureOutput(edgeChild)
  edgeChild.once('exit', (code) => {
    if (!cleanedUp && code !== 0 && code !== null) logWarn(`Edge 提前退出（code=${code}）：${edgeLog().slice(-600)}`)
  })

  const target = await waitForDebugTarget(cdpPort, targetUrl, 40_000)
  logInfo(`CDP target: ${target.url || target.id}`)
  cdp = await CdpClient.connect(target.webSocketDebuggerUrl)
  registerErrorCollectors(cdp)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })

  /* 3. 导航到清理页 */
  logStep('打开清理页（#clean）')
  await cdp.send('Page.navigate', { url: targetUrl })
  await cdp.waitFor('页面加载完成', async () => (await cdp.evaluate('document.readyState')) === 'complete', 30_000)
  await cdp.waitFor('Vue 应用挂载', () => cdp.evaluate("Boolean(document.querySelector('.sidebar'))"), 30_000)
  const bootState = await cdp.waitFor(
    '内核 RPC 初始化完成',
    async () => {
      const state = await cdp.evaluate(`(() => {
        if (document.body.innerText.includes('无法连接内核')) return 'boot-error'
        if (document.querySelector('.center-box')) return 'loading'
        return (document.querySelector('.content')?.children.length ?? 0) > 0 ? 'ready' : 'loading'
      })()`)
      if (state === 'boot-error') throw new Error(`界面启动失败（无法连接内核）：${(await cdp.evaluate('document.body.innerText')).slice(0, 500)}`)
      return state === 'ready' ? state : undefined
    },
    30_000,
  )
  logInfo(`应用就绪（${bootState}），hash=${await cdp.evaluate('location.hash')}`)

  /* 4. 等待 mock 扫描数据渲染 */
  const dataSnapshot = await cdp.waitFor(
    'mock 扫描数据渲染',
    async () => {
      const snapshot = await cdp.evaluate(`(() => {
        const text = document.body.innerText.replace(/\\s+/g, ' ')
        return {
          groupRows: document.querySelectorAll('.group-row').length,
          itemRows: document.querySelectorAll('.item-row').length,
          taskCards: document.querySelectorAll('.task-card').length,
          tableRows: document.querySelectorAll('.el-table__row').length,
          hasTotal: /(?:2,?960|3,?000)\\s*(?:项|条)/.test(text),
        }
      })()`)
      const ready = snapshot.groupRows > 0 || snapshot.taskCards > 0 || snapshot.tableRows > 0 || snapshot.hasTotal
      return ready ? snapshot : undefined
    },
    30_000,
  )
  logInfo(`数据渲染：groupRow=${dataSnapshot.groupRows} taskCard=${dataSnapshot.taskCards} tableRow=${dataSnapshot.tableRows} hasTotal=${dataSnapshot.hasTotal}`)

  const hasNewHooks = await cdp.evaluate(
    `document.querySelectorAll('.group-row, .recommend-banner, .view-tab, .item-row, .selected-count, .confirm-dialog, .detail-drawer').length > 0`,
  )
  const effectiveMode = mode === 'auto' ? (hasNewHooks ? 'final' : 'smoke') : mode
  if (mode === 'auto') logInfo(`自动探测：${hasNewHooks ? '检测到新版 CleanView 钩子' : '未检测到新版钩子（旧版 dist）'} → 使用 ${effectiveMode} 模式`)
  if (effectiveMode === 'final' && !hasNewHooks) {
    logWarn('未检测到新版 CleanView 钩子。当前 packages/ui/dist 可能仍是旧版构建。')
    logWarn('请先运行 pnpm build:ui（或 pnpm build）后再执行最终验收；本次按失败处理。')
  }

  /* 5. 执行断言 */
  if (effectiveMode === 'smoke') {
    checks.mode = 'smoke'
    await runSmokeAssertions(cdp)
  } else {
    checks.mode = 'final'
    if (!hasNewHooks) {
      checks.records.push({
        name: '新版 CleanView 已构建（.group-row / .recommend-banner / .view-tab 等钩子存在）',
        ok: false,
        detail: '未检测到任何新版钩子；请先 pnpm build:ui。当前页面可能仍是旧版界面。',
      })
      log(`  ${paint(ANSI.red, '✗ FAIL')}  新版 CleanView 已构建`)
      // 仍截图留证，便于确认当前 dist 状态
      try {
        const evidence = await captureFullPage(cdp, path.join(screenshotDir, 'scan-select-not-built.png'))
        logInfo(`当前页面截图：${path.relative(ROOT, evidence.file)}`)
      } catch {
        /* ignore */
      }
    } else {
      await runFinalAssertions(cdp)
    }
  }

  /* 6. 汇总 */
  log('')
  log('  ╭──────────────────────────────────────────────╮')
  const failedChecks = checks.failed
  const summaryText = failedChecks.length === 0 ? 'PASS' : 'FAIL'
  log(`  │  验收结果: ${summaryText.padEnd(33)}│`)
  log(`  │  通过 ${String(checks.passedCount).padEnd(4)} / 共 ${String(checks.records.length).padEnd(25)}│`)
  log('  ╰──────────────────────────────────────────────╯')
  if (pageWarnings.length) {
    logWarn(`页面 console.warn / log.warning：${pageWarnings.length} 条（不计入失败，供参考）`)
    for (const warning of [...new Set(pageWarnings)].slice(0, 6)) log(`     ${paint(ANSI.dim, warning.slice(0, 400))}`)
  }
  if (failedChecks.length) {
    log('')
    log(paint(ANSI.red, '  失败明细：'))
    for (const record of failedChecks) log(`   ✗ ${record.name}\n     ${record.detail}`)
  }
  const screenshotFiles = effectiveMode === 'smoke' ? ['scan-select-smoke-light.png', 'scan-select-smoke-dark.png'] : ['scan-select-light.png', 'scan-select-dark.png']
  const existingShots = screenshotFiles.map((name) => path.join(screenshotDir, name)).filter((file) => existsSync(file))
  if (existingShots.length) log(`\n  截图：${existingShots.map((file) => path.relative(ROOT, file)).join('  /  ')}`)
  log(`  页面错误：${pageErrors.length} 条`)
  return failedChecks.length === 0 ? 0 : 1
}

async function waitHttpReady(url, timeoutMs) {
  const startedAt = Date.now()
  let lastError
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) return response
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await sleep(250)
  }
  throw new Error(`等待 mock server 就绪超时：${url}（${lastError?.message ?? ''}）\n${mockLog().slice(-1500)}`)
}

async function waitForDebugTarget(port, targetUrl, timeoutMs) {
  const startedAt = Date.now()
  let lastError
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await response.json()
      const page = list.find((item) => item.type === 'page' && (!item.url || item.url === 'about:blank' || item.url.startsWith('http')))
      if (page) return page
    } catch (error) {
      lastError = error
    }
    await sleep(250)
  }
  throw new Error(`等待 Edge 调试端口超时（${port}）：${lastError?.message ?? ''}\n${edgeLog().slice(-1500)}`)
}

/* --------------------------- 入口 --------------------------- */

watchdog = setTimeout(async () => {
  log('')
  log(paint(ANSI.red, `  全局超时（${timeoutMs}ms），正在清理进程并退出`))
  try {
    await cleanup()
  } finally {
    process.exit(1)
  }
}, timeoutMs)

let exitCode = 1
try {
  exitCode = await main()
} catch (error) {
  log('')
  log(paint(ANSI.red, `  ❌ 验收执行失败：${error instanceof Error ? error.message : String(error)}`))
  if (pageErrors.length) {
    log('  页面错误：')
    for (const item of [...new Set(pageErrors)].slice(0, 10)) log(`   - ${item}`)
  }
  const mockTail = mockLog().trim()
  if (mockTail) log(`  mock server 输出（尾部）：\n${mockTail.slice(-1500)}`)
  const edgeTail = edgeLog().trim()
  if (edgeTail) log(`  Edge 输出（尾部）：\n${edgeTail.slice(-1200)}`)
  exitCode = 1
} finally {
  await cleanup()
}

// 等待短暂时间让 stdout flush 后退出
process.exit(exitCode)
