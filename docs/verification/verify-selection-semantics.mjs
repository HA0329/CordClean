/**
 * 独立验收脚本：清理选择体验 v2 的需求语义验证（verifier 编写，不改业务代码）。
 *
 * 与 scripts/verify-clean-ui.mjs 的关系：完全独立的断言实现。只复用团队工具
 * `scripts/ui-mock-server.mjs`（3000 条固定种子合成扫描数据 + mock RPC），
 * 通过无头 Edge CDP 在真实浏览器里逐项核对：
 *   1. 默认推荐 = safe 且非 protected（个数 / 字节 / 无 risky、protected 选中）；
 *   2. 千条级分组总览（类别→任务聚合顺序、组大小、推荐数、样例展开、明细下钻）；
 *   3. 三态勾选（整组勾选、受保护项混入组时的行为）；
 *   4. 筛选（搜索/风险/大小/任务）、排序、分页、跨页选择、本页全选、选中筛选结果/反选/清空；
 *   5. 明细列（说明/修改时间/风险）与详情抽屉内容（类型/大小/路径/说明/安全解释/打开位置）；
 *   6. 受保护只读视图 + 原因；
 *   7. 清理确认摘要（数量/大小/风险构成/任务分布/高风险隔离提示）；
 *   8. dryRun 预演、移动到（mock RPC）、上次清理结果面板、候选任务勾选；
 *   9. 边界：空扫描 / 全 protected / 0 字节 / 无 note / 超长路径 / 无 JS 异常；
 *  10. 3000 条下的交互耗时。
 *
 * 用法：node docs/verification/verify-selection-semantics.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { startMockServer, formatBytes, DEFAULT_SEED } from '../../scripts/ui-mock-server.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SHOT_DIR = path.join(HERE, 'screenshots')
mkdirSync(SHOT_DIR, { recursive: true })
const ITEMS = Number(process.env.ITEMS ?? 3000)
const SEED = Number(process.env.SEED ?? DEFAULT_SEED)
const CATEGORY_ORDER = ['system', 'browser', 'privacy', 'disk', 'apps', 'startup', 'dev', 'ai']
const CATEGORY_NAMES = {
  system: '系统垃圾',
  browser: '浏览器',
  privacy: '隐私痕迹',
  disk: '磁盘空间',
  apps: '应用残留',
  startup: '启动项',
  dev: '开发缓存',
  ai: 'AI 建议',
}

/* ------------------------------------------------------------------ */
/* 断言收集 / 输出                                                      */
/* ------------------------------------------------------------------ */
const results = []
const defects = []
const metrics = {}

function check(name, ok, okDetail = '', failDetail = '') {
  results.push({ name, ok: Boolean(ok), detail: ok ? okDetail : failDetail || okDetail })
  console.log(`  ${ok ? '✓ PASS' : '✗ FAIL'}  ${name}${ok ? (okDetail ? `  (${okDetail})` : '') : failDetail ? `  →  ${failDetail}` : ''}`)
}
function note(message) {
  console.log(`  · ${message}`)
}
function section(title) {
  console.log(`\n── ${title} ──`)
}
function defect(severity, title, file, detail) {
  defects.push({ severity, title, file, detail })
  console.log(`  ⚠ 缺陷[${severity}] ${title} @ ${file} —— ${detail}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ------------------------------------------------------------------ */
/* 浏览器 / CDP                                                        */
/* ------------------------------------------------------------------ */
function findFreePort(startPort, attempts = 20) {
  return new Promise((resolve) => {
    let offset = 0
    const tryPort = () => {
      if (offset >= attempts) throw new Error(`从 ${startPort} 起找不到空闲端口`)
      const port = startPort + offset++
      const probe = createNetServer()
      probe.once('error', () => tryPort())
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(port)))
    }
    tryPort()
  })
}

function resolveBrowser() {
  const candidates = [
    process.env.CORDCLEAN_EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean)
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) throw new Error('找不到 Edge/Chrome，可用 CORDCLEAN_EDGE_PATH 指定')
  return found
}

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 0
    this.pending = new Map()
    this.listeners = new Map()
    socket.on('message', (raw) => this.#handle(raw))
  }
  static async connect(url) {
    const socket = new WebSocket(url, { perMessageDeflate: false })
    await new Promise((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    return new Cdp(socket)
  }
  #handle(raw) {
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
      if (message.error) task.reject(new Error(`CDP 错误 ${task.method}: ${message.error.message}`))
      else task.resolve(message.result)
      return
    }
    if (message.method) {
      for (const listener of this.listeners.get(message.method) ?? []) {
        try {
          listener(message.params)
        } catch {
          /* ignore */
        }
      }
    }
  }
  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set())
    this.listeners.get(method).add(listener)
  }
  send(method, params = {}, timeoutMs = 30_000) {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP 超时 ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, method, timer })
      try {
        this.socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }
  async evaluate(expression, awaitPromise = true) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true })
    if (result.exceptionDetails) {
      throw new Error(`页面脚本异常：${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
    }
    return result.result?.value
  }
  async waitFor(description, fn, timeoutMs = 20_000, interval = 120) {
    const start = Date.now()
    let lastError
    while (Date.now() - start < timeoutMs) {
      try {
        const value = await fn()
        if (value) return value
      } catch (error) {
        lastError = error
      }
      await sleep(interval)
    }
    throw new Error(`等待超时：${description}${lastError ? `（最后错误：${lastError.message}）` : ''}`)
  }
  close() {
    try {
      this.socket.close()
    } catch {
      /* ignore */
    }
    for (const task of this.pending.values()) clearTimeout(task.timer)
    this.pending.clear()
  }
}

/* ------------------------------------------------------------------ */
/* 页面内辅助函数（注入 window.__t，页面重载后需重新注入）                 */
/* ------------------------------------------------------------------ */
const HELPERS = String.raw`
window.__t = {
  vis(el) {
    if (!el) return false
    const style = getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
  },
  txt(sel) {
    const el = document.querySelector(sel)
    return el ? el.innerText.replace(/\s+/g, ' ').trim() : ''
  },
  selected() {
    const el = document.querySelector('.selected-count')
    const text = el ? el.innerText.replace(/\s+/g, ' ') : ''
    const countMatch = /已选\s*([\d,]+)\s*项/.exec(text)
    const bytesMatch = /([\d.]+)\s*(B|KB|MB|GB|TB)/.exec(text)
    return {
      text,
      count: countMatch ? Number(countMatch[1].replace(/,/g, '')) : null,
      bytesText: bytesMatch ? bytesMatch[1] + ' ' + bytesMatch[2] : '',
    }
  },
  filterInfo() {
    const el = document.querySelector('.risk-filters')
    const text = el ? el.innerText.replace(/\s+/g, ' ') : ''
    const match = /当前筛选\s*([\d,]+)\s*项/.exec(text)
    return { text, count: match ? Number(match[1].replace(/,/g, '')) : null }
  },
  itemRows() {
    return [...document.querySelectorAll('.item-row')].map((row) => row.innerText.replace(/\s+/g, ' ').trim())
  },
  itemIds() {
    return [...document.querySelectorAll('.item-row')].map((row) => row.dataset.itemId || '')
  },
  groupRows() {
    return [...document.querySelectorAll('.group-row')].map((row) => ({
      taskId: row.dataset.taskId || '',
      text: row.innerText.replace(/\s+/g, ' ').trim(),
      checked: Boolean(row.querySelector('.group-checkbox.is-checked')),
      indeterminate: Boolean(row.querySelector('.group-checkbox.is-indeterminate')),
    }))
  },
  categories() {
    return [...document.querySelectorAll('.category-block')].map((block) => ({
      head: (block.querySelector('.category-head')?.innerText ?? '').replace(/\s+/g, ' ').trim(),
      tasks: [...block.querySelectorAll('.group-row')].map((row) => row.dataset.taskId || ''),
    }))
  },
  stats() {
    return [...document.querySelectorAll('.cc-card.cc-stat')].slice(0, 4).map((el) => el.innerText.replace(/\s+/g, ' ').trim())
  },
  riskFilterCounts() {
    return Object.fromEntries(
      [...document.querySelectorAll('.risk-filter')].map((el) => {
        const key = el.dataset.risk
        const match = /(\d[\d,]*)\s*$/.exec(el.innerText.replace(/\s+/g, ' ').trim())
        return [key, match ? Number(match[1].replace(/,/g, '')) : null]
      }),
    )
  },
  messages() {
    return [...document.querySelectorAll('.el-message')].map((el) => el.innerText.replace(/\s+/g, ' ').trim())
  },
  draw() {
    const drawer = document.querySelector('.detail-drawer')
    if (!drawer) return null
    return { text: drawer.innerText.replace(/\s+/g, ' ').trim(), html: drawer.innerHTML }
  },
  dialog() {
    const el = document.querySelector('.confirm-dialog')
    if (!el) return null
    // el-dialog 默认 destroy-on-close=false：关闭后内容仍在 DOM，只是面板隐藏，需要判断可见性
    const panel = el.closest('.el-dialog')
    if (panel) {
      const rect = panel.getBoundingClientRect()
      if (getComputedStyle(panel).display === 'none' || rect.width === 0 || rect.height === 0) return null
    } else if (!this.vis(el)) {
      return null
    }
    return {
      text: el.innerText.replace(/\s+/g, ' ').trim(),
      tasks: [...el.querySelectorAll('.confirm-task-row')].map((row) => row.innerText.replace(/\s+/g, ' ').trim()),
      riskPills: [...el.querySelectorAll('.confirm-risk .cc-pill')].map((pill) => pill.innerText.replace(/\s+/g, ' ').trim()),
    }
  },
  clickSelect(sel) {
    const root = document.querySelector(sel)
    if (!root) return false
    // Element Plus 2.14 的 toggleMenu 绑定在 .el-select__wrapper 上，点 root 不会展开
    const wrapper = root.querySelector('.el-select__wrapper') ?? root.querySelector('input') ?? root
    wrapper.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    wrapper.click()
    return true
  },
  clickText(text, scopeSel) {
    const root = scopeSel ? document.querySelector(scopeSel) : document
    if (!root) return false
    const candidates = [...root.querySelectorAll('button, li, a, .el-dropdown-item, .link')]
    const target = candidates.find((el) => this.vis(el) && el.textContent.replace(/\s+/g, '').includes(text))
    if (!target) return false
    target.click()
    return true
  },
  clickSel(sel) {
    const el = document.querySelector(sel)
    if (!el || !this.vis(el)) return false
    el.click()
    return true
  },
  setInput(sel, value) {
    const input = document.querySelector(sel)
    if (!input) return false
    const proto = Object.getPrototypeOf(input)
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
    if (!descriptor || !descriptor.set) return false
    descriptor.set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  },
  clickOption(label) {
    const items = [...document.querySelectorAll('.el-select-dropdown__item')]
    const wanted = label.replace(/\s+/g, '')
    const match = (el) => el.textContent.replace(/\s+/g, '').includes(wanted)
    const target = items.filter((el) => this.vis(el)).find(match) ?? [...items].reverse().find(match)
    if (!target) return false
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    target.click()
    return true
  },
  switchView(name) {
    const tab = document.querySelector('.view-tab[data-view="' + name + '"]')
    if (!tab) return false
    tab.click()
    return true
  },
  activeView() {
    return document.querySelector('.view-tab.active')?.dataset.view ?? ''
  },
  fullPageInfo() {
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      bodyText: document.body.innerText,
    }
  },
  rowCheckboxStates() {
    return [...document.querySelectorAll('.el-table__row')].map((row) => Boolean(row.querySelector('.el-checkbox.is-checked')))
  },
}
true
`

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

let mock
let edge
let cdp
let profileDir
let cleanedUp = false
let finalExitCode = 1
const pageErrors = []
const cdpLog = []
const edgeLog = []

async function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  try {
    cdp?.close()
  } catch {
    /* ignore */
  }
  if (edge && edge.exitCode === null) {
    try {
      spawnSync('taskkill.exe', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15_000 })
    } catch {
      /* ignore */
    }
  }
  if (mock) {
    try {
      await mock.close()
    } catch {
      /* ignore */
    }
  }
  await sleep(300)
  if (profileDir) {
    try {
      rmSync(profileDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

process.on('uncaughtException', (error) => {
  console.log('\n❌ 脚本异常：', error)
  cleanup()
  process.exit(1)
})

async function installHelpers() {
  await cdp.evaluate(HELPERS)
}

async function reloadPage(cacheKey) {
  const url = `${mock.url}?case=${encodeURIComponent(cacheKey)}#clean`
  await cdp.send('Page.navigate', { url })
  await cdp.waitFor('页面加载完成', async () => (await cdp.evaluate('document.readyState')) === 'complete', 30_000)
  await cdp.waitFor('Vue 挂载', () => cdp.evaluate('Boolean(document.querySelector(".sidebar"))'), 30_000)
  await cdp.waitFor(
    '清理页数据就绪',
    async () => {
      const state = await cdp.evaluate(`(() => {
        if (document.body.innerText.includes('无法连接内核')) return 'boot-error'
        if (document.querySelector('.cc-card.cc-stat') || document.body.innerText.includes('还没有扫描结果')) return 'ready'
        return ''
      })()`)
      if (state === 'boot-error') throw new Error('界面无法连接内核')
      return state === 'ready' ? state : undefined
    },
    30_000,
  )
  await installHelpers()
}

async function resetFilters() {
  await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('.risk-filters button')].find((el) => el.textContent.includes('重置筛选'))
    if (button && !button.disabled) button.click()
    return true
  })()`)
  await sleep(250)
}

async function clearSelection() {
  await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('.risk-filters button')].find((el) => el.textContent.includes('清空选择'))
    if (button && !button.disabled) { button.click(); return true }
    return false
  })()`)
  await sleep(200)
}

async function switchView(name) {
  await cdp.evaluate(`window.__t.switchView(${JSON.stringify(name)})`)
  await sleep(300)
}

/** 选择 Element Plus el-select 的下拉选项（toggleMenu 绑定在 .el-select__wrapper 上） */
async function chooseOption(selectSel, label) {
  const opened = await cdp.evaluate(`window.__t.clickSelect(${JSON.stringify(selectSel)})`)
  await sleep(380)
  const picked = await cdp.evaluate(`window.__t.clickOption(${JSON.stringify(label)})`)
  await sleep(380)
  return { opened, picked }
}

async function captureFullPage(file) {
  const metricsLayout = await cdp.send('Page.getLayoutMetrics')
  const width = Math.max(1200, Math.min(1600, Math.ceil(metricsLayout.cssContentSize.width || 1600)))
  const height = Math.max(800, Math.min(9000, Math.ceil(metricsLayout.cssContentSize.height || 1000)))
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await sleep(250)
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  writeFileSync(file, Buffer.from(shot.data, 'base64'))
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
  await sleep(150)
  return file
}

async function openDetailAt(index = 0) {
  const clicked = await cdp.evaluate(`(() => {
    const row = document.querySelectorAll('.el-table__row')[${index}]
    const button = row ? row.querySelector('.item-detail-btn') : null
    if (!button) return false
    button.click()
    return true
  })()`)
  if (!clicked) return null
  await cdp.waitFor('详情抽屉', () => cdp.evaluate('Boolean(document.querySelector(".detail-drawer"))'), 8_000)
  await sleep(250)
  return cdp.evaluate('window.__t.draw()')
}

async function closeDetail() {
  await cdp.evaluate(`(() => { const button = document.querySelector('.el-drawer__close-btn'); if (button) { button.click(); return true } return false })()`)
  await cdp.waitFor('详情抽屉关闭', async () => (await cdp.evaluate('Boolean(document.querySelector(".detail-drawer"))')) === false, 8_000)
  await sleep(150)
}

function countItemsWithoutMtime(list) {
  return list.filter((item) => item.mtimeMs === undefined).length
}

async function main() {
  /* ---------- 启动 mock server ---------- */
  section('0. 启动 mock 数据服务（3000 条固定种子）')
  mock = await startMockServer({ port: 0, items: ITEMS, seed: SEED })
  const items = mock.fixture.report.items
  const tasks = mock.fixture.tasks
  const taskMap = new Map(tasks.map((task) => [task.id, task]))
  note(`mock: ${mock.url} · ${items.length} 条 / ${tasks.length} 任务 / ${mock.fixture.summary.protectedCount} protected / 推荐 ${mock.fixture.summary.recommend.count} 项`)

  /* ---------- 独立计算的期望值（不复用 selection.ts） ---------- */
  const nonProtected = items.filter((item) => !item.protected)
  const protectedItems = items.filter((item) => item.protected)
  const safeNonProtected = nonProtected.filter((item) => item.risk === 'safe')
  const caNonProtected = nonProtected.filter((item) => item.risk === 'caution')
  const riskyNonProtected = nonProtected.filter((item) => item.risk === 'risky')
  const totalBytes = (list) => list.reduce((sum, item) => sum + item.size, 0)
  const expected = {
    allCount: items.length,
    protectedCount: protectedItems.length,
    nonProtectedCount: nonProtected.length,
    nonProtectedBytes: totalBytes(nonProtected),
    recommendCount: safeNonProtected.length,
    recommendBytes: totalBytes(safeNonProtected),
    safe: safeNonProtected.length,
    caution: caNonProtected.length,
    risky: riskyNonProtected.length,
    zeroByteCount: items.filter((item) => item.size === 0).length,
    noMtimeCount: countItemsWithoutMtime(items),
    taskCountWithData: new Set(items.map((item) => item.taskId)).size,
  }
  const taskStats = new Map()
  for (const item of nonProtected) {
    const entry = taskStats.get(item.taskId) ?? { taskId: item.taskId, count: 0, bytes: 0, recommendCount: 0 }
    entry.count++
    entry.bytes += item.size
    if (item.risk === 'safe') entry.recommendCount++
    taskStats.set(item.taskId, entry)
  }
  const globalTaskOrderBySize = [...taskStats.values()]
    .sort((a, b) => b.bytes - a.bytes || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0))
    .map((entry) => entry.taskId)
  const categoryStats = new Map()
  for (const category of CATEGORY_ORDER) categoryStats.set(category, { category, count: 0, bytes: 0, recommendCount: 0, tasks: [] })
  for (const taskId of globalTaskOrderBySize) {
    const category = taskMap.get(taskId)?.category
    const stat = categoryStats.get(category)
    if (!stat || !taskStats.has(taskId)) continue
    const taskStat = taskStats.get(taskId)
    stat.tasks.push(taskId)
    stat.count += taskStat.count
    stat.bytes += taskStat.bytes
    stat.recommendCount += taskStat.recommendCount
  }
  const expectedCategories = CATEGORY_ORDER.filter((category) => categoryStats.get(category).tasks.length > 0)
  // 分组总览 DOM 顺序 = 分类声明顺序优先，类别内按 bytes 降序
  const expectedGroupOrder = expectedCategories.flatMap((category) => categoryStats.get(category).tasks)
  const expectedGrouped = [...nonProtected]
  expectedGrouped.sort((a, b) => b.size - a.size)
  const selectedRecommendByTask = new Map()
  for (const item of safeNonProtected) {
    const entry = selectedRecommendByTask.get(item.taskId) ?? { taskId: item.taskId, name: taskMap.get(item.taskId)?.name ?? item.taskId, count: 0, bytes: 0 }
    entry.count++
    entry.bytes += item.size
    selectedRecommendByTask.set(item.taskId, entry)
  }
  const expectedConfirmTasks = [...selectedRecommendByTask.values()].sort((a, b) => b.bytes - a.bytes || (a.taskId < b.taskId ? -1 : 1))
  note(
    `独立期望值：可清理 ${expected.nonProtectedCount} 项 / 推荐 ${expected.recommendCount} 项（${formatBytes(expected.recommendBytes)}）` +
      ` / safe ${expected.safe} · caution ${expected.caution} · risky ${expected.risky} / 0 字节 ${expected.zeroByteCount} 条 / 无 mtime ${expected.noMtimeCount} 条`,
  )
  if (expected.zeroByteCount < 1) throw new Error('mock 数据缺少 0 字节边界项，数据前提不成立')

  /* ---------- 启动无头 Edge ---------- */
  section('0.1 启动无头 Edge + CDP')
  const browser = resolveBrowser()
  note(`浏览器：${browser}`)
  const cdpPort = await findFreePort(9454)
  profileDir = mkdtempSync(path.join(os.tmpdir(), 'cordclean-verifier-edge-'))
  edge = spawn(
    browser,
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
      '--hide-scrollbars',
      '--mute-audio',
      '--no-sandbox',
      '--force-color-profile=srgb',
      '--window-size=1600,1000',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  )
  edge.stdout.on('data', (chunk) => edgeLog.push(String(chunk)))
  edge.stderr.on('data', (chunk) => edgeLog.push(String(chunk)))

  const target = await (async () => {
    const start = Date.now()
    while (Date.now() - start < 40_000) {
      try {
        const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
        const list = await response.json()
        const page = list.find((entry) => entry.type === 'page')
        if (page?.webSocketDebuggerUrl) return page
      } catch {
        /* not ready */
      }
      await sleep(300)
    }
    throw new Error('等待 Edge CDP 端口超时')
  })()
  cdp = await Cdp.connect(target.webSocketDebuggerUrl)
  cdp.on('Runtime.exceptionThrown', (params) => {
    const detail = params.exceptionDetails
    pageErrors.push(`[exception] ${detail.exception?.description ?? detail.text}`)
  })
  cdp.on('Runtime.consoleAPICalled', (params) => {
    if (params.type === 'error') pageErrors.push(`[console.error] ${params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ')}`)
  })
  cdp.on('Log.entryAdded', (params) => {
    if (params.entry.level === 'error' && !/favicon/i.test(params.entry.url ?? '')) pageErrors.push(`[log] ${params.entry.text}`)
  })
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
  note(`CDP 就绪：127.0.0.1:${cdpPort}`)

  /* ---------- 打开清理页 ---------- */
  section('1. 打开清理页并等待 3000 条结果渲染')
  const renderStart = Date.now()
  await reloadPage('main')
  await cdp.waitFor('分组总览渲染', async () => (await cdp.evaluate('document.querySelectorAll(".group-row").length')) > 0, 60_000, 150)
  metrics.renderMsToFirstGroups = Date.now() - renderStart
  note(`首屏渲染到出现分组行：${metrics.renderMsToFirstGroups} ms`)

  /* ---------- 1. 推荐默认选择 ---------- */
  section('2. 默认推荐策略（绝不含 risky / protected）')
  const initialSelected = await cdp.evaluate('window.__t.selected()')
  note(`footer：${initialSelected.text}`)
  check(
    '首屏默认选中数 = safe 且非 protected 的项数',
    initialSelected.count === expected.recommendCount,
    `${initialSelected.count} / ${expected.recommendCount}`,
    `实际 ${initialSelected.count}，期望 ${expected.recommendCount}`,
  )
  check(
    '首屏默认选中大小 = 推荐项字节合计',
    initialSelected.bytesText === formatBytes(expected.recommendBytes),
    `${initialSelected.bytesText}`,
    `实际 ${initialSelected.bytesText}，期望 ${formatBytes(expected.recommendBytes)}`,
  )
  const footerPills = await cdp.evaluate(`(() => {
    const footer = document.querySelector('.footer-info')
    return footer ? [...footer.querySelectorAll('.cc-pill')].map((el) => el.innerText.replace(/\\s+/g, ' ').trim()) : []
  })()`)
  check('默认选择不含高风险/谨慎项标记', footerPills.every((text) => !/高风险|谨慎/.test(text)), footerPills.join(' / ') || '无风险 pill', `footer 出现风险标记：${footerPills.join(' / ')}`)
  // 额外语义核对：受保护项不在“可清理/推荐”统计里，且“只看推荐”在 risky 筛选下应为 0 项。
  const riskyOnlyRecommended = await cdp.evaluate(`(() => {
    const risky = document.querySelector('.risk-filter[data-risk="risky"]')
    if (risky) risky.click()
    return true
  })()`)
  if (riskyOnlyRecommended) {
    await sleep(300)
    const onlyRec = await cdp.evaluate(`(() => { const box = document.querySelector('.only-recommended input'); if (!box) return false; box.click(); return true })()`)
    await sleep(350)
    const riskyRecommendedCount = await cdp.evaluate('window.__t.filterInfo()')
    check('高风险筛选 + 只看推荐：推荐集不含 risky', riskyRecommendedCount.count === 0, `推荐∩risky = ${riskyRecommendedCount.count} 项`, `推荐∩risky = ${riskyRecommendedCount.count} 项，期望 0`)
    void onlyRec
    await resetFilters()
    await sleep(200)
  }

  /* 修复 4：推荐策略文案 / 策略变更提示 / 应用推荐消息 */
  const bannerBefore = await cdp.evaluate('window.__t.txt(".recommend-banner")')
  check('推荐横幅默认文案为「已按推荐策略（安全项）」', bannerBefore.includes('已按推荐策略（安全项）'), bannerBefore.slice(0, 90), `横幅：${bannerBefore.slice(0, 160)}`)
  await cdp.evaluate(`document.querySelector('.recommend-caution').click()`)
  await sleep(400)
  const bannerCaution = await cdp.evaluate('window.__t.txt(".recommend-banner")')
  const staleHint = await cdp.evaluate('window.__t.txt(".policy-stale")')
  const selectedAfterPolicyToggle = await cdp.evaluate('window.__t.selected()')
  check('开启「包含谨慎项」后横幅文案变为「安全项 + 谨慎项」', bannerCaution.includes('安全项 + 谨慎项'), bannerCaution.slice(0, 100), `横幅：${bannerCaution.slice(0, 160)}`)
  check(
    '策略变更后显示「推荐策略已变更」提示且不自动改选择集',
    staleHint.includes('推荐策略已变更') && selectedAfterPolicyToggle.count === expected.recommendCount,
    `${staleHint} · 已选未变 ${selectedAfterPolicyToggle.count} 项`,
    `提示「${staleHint}」；已选 ${selectedAfterPolicyToggle.count}，期望保持 ${expected.recommendCount}`,
  )
  const includeCautionExpectedCount = expected.safe + expected.caution
  const includeCautionExpectedBytes = totalBytes(nonProtected.filter((item) => item.risk !== 'risky'))
  await cdp.evaluate(`window.__t.clickText('应用推荐', '.banner-actions')`)
  await sleep(500)
  const afterApplyCaution = await cdp.evaluate('window.__t.selected()')
  const messagesAfterApply = await cdp.evaluate('window.__t.messages()')
  check(
    '「应用推荐」按含谨慎项策略勾选并提示「已按推荐策略勾选 N 项内容」',
    afterApplyCaution.count === includeCautionExpectedCount &&
      afterApplyCaution.bytesText === formatBytes(includeCautionExpectedBytes) &&
      messagesAfterApply.some((text) => text.includes(`已按推荐策略勾选 ${includeCautionExpectedCount} 项内容`)),
    `${afterApplyCaution.count} 项 · ${afterApplyCaution.bytesText}`,
    `实际 ${afterApplyCaution.count} 项 / ${afterApplyCaution.bytesText}，期望 ${includeCautionExpectedCount} 项 / ${formatBytes(includeCautionExpectedBytes)}；消息：${messagesAfterApply.slice(-3).join(' || ')}`,
  )
  const staleAfterApply = await cdp.evaluate('window.__t.txt(".policy-stale")')
  check('应用推荐后策略变更提示消失', staleAfterApply === '', staleAfterApply || '（已消失）')
  await cdp.evaluate(`document.querySelector('.recommend-caution').click()`)
  await sleep(350)
  await cdp.evaluate(`window.__t.clickText('应用推荐', '.banner-actions')`)
  await sleep(450)
  const restoredSelected = await cdp.evaluate('window.__t.selected()')
  check('还原默认策略后再次应用推荐回到「安全项」集合', restoredSelected.count === expected.recommendCount, `${restoredSelected.count} 项`)

  /* ---------- 2. 分组总览 ---------- */
  section('3. 千条级分组总览：类别 → 任务聚合')
  const renderedCategories = await cdp.evaluate('window.__t.categories()')
  check(
    '类别分组顺序与 CATEGORIES 声明顺序一致',
    JSON.stringify(
      renderedCategories.map((entry) => {
        const found = expectedCategories.find((category) => entry.head.startsWith(CATEGORY_NAMES[category]))
        return found ? CATEGORY_NAMES[found] : entry.head.split(' ')[0]
      }),
    ) === JSON.stringify(expectedCategories.map((category) => CATEGORY_NAMES[category])),
    renderedCategories.map((entry) => entry.head.split(' ')[0]).join(' → '),
    `实际 ${renderedCategories.map((entry) => entry.head).join(' / ')}；期望 ${expectedCategories.map((category) => CATEGORY_NAMES[category]).join(' / ')}`,
  )
  const renderedGroupRows = await cdp.evaluate('window.__t.groupRows()')
  check('分组行数 = 有数据的任务数', renderedGroupRows.length === expected.taskCountWithData, `${renderedGroupRows.length} / ${expected.taskCountWithData}`)
  check(
    '任务分组按「分类声明顺序 + 类别内字节降序」排列（同字节按 taskId）',
    JSON.stringify(renderedGroupRows.map((row) => row.taskId)) === JSON.stringify(expectedGroupOrder),
    `前 5：${renderedGroupRows.slice(0, 5).map((row) => row.taskId).join(', ')}`,
    `顺序不符；实际前 5：${renderedGroupRows.slice(0, 5).map((row) => row.taskId).join(', ')}`,
  )
  let categoryMismatch = []
  for (const category of expectedCategories) {
    const rendered = renderedCategories.find((entry) => entry.head.startsWith(CATEGORY_NAMES[category]))
    const expectedTasks = categoryStats.get(category).tasks
    if (!rendered || JSON.stringify(rendered.tasks) !== JSON.stringify(expectedTasks)) {
      categoryMismatch.push(`${CATEGORY_NAMES[category]}（期望 ${expectedTasks.length} 任务）`)
    }
  }
  check('每个类别内的任务聚合顺序正确', categoryMismatch.length === 0, `${expectedCategories.length} 个类别`, `不一致：${categoryMismatch.join(' / ')}`)
  const firstGroup = renderedGroupRows[0]
  const firstTaskStat = taskStats.get(firstGroup.taskId)
  check(
    '分组行展示的项数/大小与独立聚合一致',
    firstGroup.text.includes(`${firstTaskStat.count} 项`) && firstGroup.text.includes(formatBytes(firstTaskStat.bytes)),
    `${firstGroup.taskId}：${firstTaskStat.count} 项 / ${formatBytes(firstTaskStat.bytes)}`,
    `行文本：${firstGroup.text.slice(0, 160)}；期望 ${firstTaskStat.count} 项 / ${formatBytes(firstTaskStat.bytes)}`,
  )
  const firstCategoryStat = categoryStats.get(expectedCategories[0])
  const firstCategoryHead = renderedCategories[0].head
  check(
    '类别行汇总（项数/大小/推荐数）正确',
    firstCategoryHead.includes(`${firstCategoryStat.count} 项`) && firstCategoryHead.includes(formatBytes(firstCategoryStat.bytes)) && firstCategoryHead.includes(`推荐 ${firstCategoryStat.recommendCount}`),
    firstCategoryHead,
    `期望含 ${firstCategoryStat.count} 项 / ${formatBytes(firstCategoryStat.bytes)} / 推荐 ${firstCategoryStat.recommendCount}`,
  )
  const bannerText = await cdp.evaluate('window.__t.txt(".recommend-banner")')
  check(
    '推荐横幅展示推荐项数/大小/未选风险项数',
    bannerText.includes(`勾选 ${expected.recommendCount} 项`) &&
      bannerText.includes(formatBytes(expected.recommendBytes)) &&
      bannerText.includes(`谨慎 ${expected.caution} 项`) &&
      bannerText.includes(`高风险 ${expected.risky} 项`) &&
      bannerText.includes(`受保护 ${expected.protectedCount} 项`),
    bannerText.slice(0, 150),
    `横幅：${bannerText.slice(0, 200)}`,
  )
  const stats = await cdp.evaluate('window.__t.stats()')
  const statsNorm = stats.map((text) => text.replace(/,/g, ''))
  check(
    '顶部 4 个统计卡片数值正确',
    statsNorm.length === 4 &&
      statsNorm[0].includes(String(expected.nonProtectedCount)) &&
      statsNorm[1].includes(String(expected.recommendCount)) &&
      statsNorm[2].includes(String(expected.caution + expected.risky)) &&
      statsNorm[3].includes(String(expected.protectedCount)),
    stats.join(' | '),
    stats.join(' | '),
  )
  const riskFilterCounts = await cdp.evaluate('window.__t.riskFilterCounts()')
  check(
    '风险筛选按钮计数与独立统计一致',
    riskFilterCounts.all === expected.nonProtectedCount && riskFilterCounts.safe === expected.safe && riskFilterCounts.caution === expected.caution && riskFilterCounts.risky === expected.risky,
    `全部 ${riskFilterCounts.all} / safe ${riskFilterCounts.safe} / caution ${riskFilterCounts.caution} / risky ${riskFilterCounts.risky}`,
    `实际 ${JSON.stringify(riskFilterCounts)}，期望 all=${expected.nonProtectedCount} safe=${expected.safe} caution=${expected.caution} risky=${expected.risky}`,
  )

  /* 展开样例 */
  const expandClicked = await cdp.evaluate(`(() => { const first = document.querySelector('.group-row'); const button = [...first.querySelectorAll('.mini-btn')].find((el) => el.textContent.includes('说明')); if (!button) return false; button.click(); return true })()`)
  check('分组行可展开「说明 / 样例」', expandClicked)
  await sleep(250)
  const sampleInfo = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.group-samples .sample-row')]
    return { count: rows.length, texts: rows.map((row) => row.innerText.replace(/\\s+/g, ' ').trim().slice(0, 140)), more: document.querySelector('.group-samples .sample-more')?.innerText ?? '' }
  })()`)
  const firstTaskItems = nonProtected.filter((item) => item.taskId === firstGroup.taskId).sort((a, b) => b.size - a.size)
  check(
    '展开样例默认前 3 大项且内容含名称/路径',
    sampleInfo.count === Math.min(3, firstTaskItems.length) && sampleInfo.texts.every((text) => text.length > 20),
    `${sampleInfo.count} 条样例`,
    `样例 ${sampleInfo.count} 条 / 期望 ${Math.min(3, firstTaskItems.length)} 条`,
  )
  check(
    '样例展示「还有 N 项」下钻提示',
    firstTaskItems.length <= 3 || sampleInfo.more.includes(`还有 ${firstTaskItems.length - 3} 项`),
    sampleInfo.more.trim() || '（组内不足 4 项）',
  )
  const drillClicked = await cdp.evaluate(`(() => { const first = document.querySelector('.group-row'); const button = [...first.querySelectorAll('.mini-btn')].find((el) => el.textContent.includes('明细')); if (!button) return false; button.click(); return true })()`)
  await sleep(400)
  const drillInfo = await cdp.evaluate(`({
    view: window.__t.activeView(),
    taskFilter: document.querySelector('.task-filter input')?.value ?? '',
    filter: window.__t.filterInfo(),
    rows: document.querySelectorAll('.item-row').length,
  })`)
  check(
    '分组「明细 →」可下钻到该任务明细',
    drillClicked && drillInfo.view === 'items' && drillInfo.rows === Math.min(100, firstTaskItems.length) && drillInfo.filter.count === firstTaskItems.length,
    `视图 ${drillInfo.view} / ${drillInfo.rows} 行 / 筛选 ${drillInfo.filter.count} 项`,
    `下钻状态异常：${JSON.stringify(drillInfo)}`,
  )
  await resetFilters()
  await switchView('groups')

  /* ---------- 3. 三态勾选 ---------- */
  section('4. 组内三态勾选（含受保护项混入的组）')
  await clearSelection()
  const cleared = await cdp.evaluate('window.__t.selected()')
  check('「清空选择」后已选为 0', cleared.count === 0, cleared.text)
  const plainGroupIndex = await cdp.evaluate(`(() => { const rows = [...document.querySelectorAll('.group-row')]; return rows.findIndex((row) => !row.querySelector('.protected-tag')) })()`)
  const plainGroup = renderedGroupRows[plainGroupIndex >= 0 ? plainGroupIndex : 0]
  await cdp.evaluate(`document.querySelectorAll('.group-row')[${plainGroupIndex >= 0 ? plainGroupIndex : 0}].querySelector('.group-checkbox').click()`)
  await sleep(300)
  const afterGroupSelect = await cdp.evaluate('window.__t.selected()')
  const plainExpected = taskStats.get(plainGroup.taskId)
  check(
    '整组勾选后选中数 = 该组项数（无保护项组）',
    afterGroupSelect.count === plainExpected.count && afterGroupSelect.bytesText === formatBytes(plainExpected.bytes),
    `${afterGroupSelect.count} 项 · ${afterGroupSelect.bytesText} / 期望 ${plainExpected.count} 项 · ${formatBytes(plainExpected.bytes)}`,
    `实际 ${afterGroupSelect.count} 项 · ${afterGroupSelect.bytesText}，期望 ${plainExpected.count} 项 · ${formatBytes(plainExpected.bytes)}`,
  )
  await cdp.evaluate(`document.querySelectorAll('.group-row')[${plainGroupIndex >= 0 ? plainGroupIndex : 0}].querySelector('.group-checkbox').click()`)
  await sleep(300)
  const afterGroupUnselect = await cdp.evaluate('window.__t.selected()')
  check('整组勾选可再次点击取消', afterGroupUnselect.count === 0, `${afterGroupUnselect.count} 项`)

  const protectedGroupIndex = await cdp.evaluate(`(() => { const rows = [...document.querySelectorAll('.group-row')]; return rows.findIndex((row) => row.querySelector('.protected-tag')) })()`)
  if (protectedGroupIndex >= 0) {
    const protectedGroupRow = await cdp.evaluate(`(() => { const row = document.querySelectorAll('.group-row')[${protectedGroupIndex}]; return { taskId: row.dataset.taskId, text: row.innerText.replace(/\\s+/g, ' ').trim(), hasProtected: Boolean(row.querySelector('.protected-tag')) } })()`)
    const protectedGroupStat = taskStats.get(protectedGroupRow.taskId)
    await clearSelection()
    await cdp.evaluate(`document.querySelectorAll('.group-row')[${protectedGroupIndex}].querySelector('.group-checkbox').click()`)
    await sleep(350)
    const afterProtectedGroup = await cdp.evaluate('window.__t.selected()')
    check(
      '含受保护项的组：整组勾选只选中可清理项，数量正确',
      afterProtectedGroup.count === protectedGroupStat.count,
      `${afterProtectedGroup.count} 项 / 可清理 ${protectedGroupStat.count} 项`,
      `实际 ${afterProtectedGroup.count} 项，期望 ${protectedGroupStat.count} 项（组内受保护项不可选）`,
    )
    const groupState = await cdp.evaluate(`(() => { const row = document.querySelectorAll('.group-row')[${protectedGroupIndex}]; const box = row.querySelector('.group-checkbox'); return { className: box.className, indeterminate: box.classList.contains('is-indeterminate'), checked: box.classList.contains('is-checked') } })()`)
    if (groupState.indeterminate && !groupState.checked) {
      defect(
        '中',
        '含受保护项的组，勾选框永远处于“部分选中”无法变成全选',
        'packages/ui/src/views/CleanView.vue:334-341（toggleGroup/groupState）、:757-761（:model-value/:indeterminate）',
        `taskId=${protectedGroupRow.taskId} 组内 ${protectedGroupStat.count} 项可清理项已全部选中，但勾选框仍为 indeterminate（class=${groupState.className}）。原因：group.ids 含 protected 项，addIds 会跳过 protected，selectionState 永远只能到 partial。用户点击两次也不会变成“全选”。`,
      )
      check('含受保护项的组：全选可清理项后勾选框应为全选态', false, '', `点击后仍为 indeterminate（class=${groupState.className}）；独立复现：该组可清理 ${protectedGroupStat.count} 项已全选`)
    } else {
      check('含受保护项的组：全选可清理项后勾选框为全选态', true, `class=${groupState.className}`)
    }
  } else {
    note('mock 数据中没有含受保护项的分组，跳过该项检查')
  }
  await clearSelection()

  /* ---------- 4. 明细视图/列/详情 ---------- */
  section('5. 逐项明细：分页、列、说明、详情抽屉')
  await switchView('items')
  const itemRowCount = await cdp.evaluate('document.querySelectorAll(".item-row").length')
  check('明细视图默认每页 100 行', itemRowCount === Math.min(100, expected.nonProtectedCount), `${itemRowCount} 行`)
  const headers = await cdp.evaluate(`[...document.querySelectorAll('.el-table__header th')].map((th) => th.innerText.replace(/\\s+/g, ' ').trim())`)
  const headerText = headers.join(' | ')
  check(
    '明细列包含 名称/说明、任务、大小、修改时间、风险',
    /名称/.test(headerText) && /任务/.test(headerText) && /大小/.test(headerText) && /修改时间/.test(headerText) && /风险/.test(headerText),
    headerText,
    `表头：${headerText}`,
  )
  const noteCount = await cdp.evaluate('document.querySelectorAll(".item-list .item-note").length')
  const noteExpected = nonProtected.slice(0, 100).filter((item) => item.note).length
  check('明细行展示规则说明（note）', noteCount === noteExpected, `${noteCount} 行`, `实际 ${noteCount}，期望 ${noteExpected}`)
  const columnCells = await cdp.evaluate(`(() => [...document.querySelectorAll('.el-table__row')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.innerText.replace(/\\s+/g, ' ').trim())))()`)
  const mtimeCells = columnCells.map((cells) => cells[4] ?? '')
  const riskCells = columnCells.map((cells) => cells[5] ?? '')
  const sizeCells = columnCells.map((cells) => cells[3] ?? '')
  check(
    '明细「修改时间」列有值（mock 全部有 mtime）',
    mtimeCells.length > 0 && mtimeCells.every((text) => text !== '' && text !== '—'),
    mtimeCells.slice(0, 3).join(' / '),
    `存在空/— 的修改时间：${mtimeCells.filter((text) => !text || text === '—').length} 行`,
  )
  check(
    '明细「风险」列取值为 安全/谨慎/高风险',
    riskCells.length > 0 && riskCells.every((text) => ['安全', '谨慎', '高风险'].includes(text)),
    riskCells.slice(0, 3).join(' / '),
    `异常风险列：${[...new Set(riskCells)].join(' / ')}`,
  )
  check(
    '明细「大小」列按格式展示（含 0 字节项显示 —）',
    sizeCells.length > 0 && sizeCells.every((text) => /^(—|\d+(\.\d+)? (B|KB|MB|GB|TB))$/.test(text)),
    sizeCells.slice(0, 3).join(' / '),
    `异常大小列：${[...new Set(sizeCells.filter((text) => !/^(—|\d+(\.\d+)? (B|KB|MB|GB|TB))$/.test(text)))].slice(0, 5).join(' / ')}`,
  )
  const firstExpectedItem = expectedGrouped[0]
  const drawer = await openDetailAt(0)
  const drawerText = drawer?.text ?? ''
  check('.detail-drawer 打开且内容非空', Boolean(drawer) && drawerText.length > 20, drawerText.slice(0, 120))
  check(
    '详情抽屉包含类型/大小/修改时间/所属任务/分类',
    /类型/.test(drawerText) && /大小/.test(drawerText) && /修改时间/.test(drawerText) && /所属任务/.test(drawerText) && /分类/.test(drawerText),
    drawerText.slice(0, 140),
    `抽屉：${drawerText.slice(0, 220)}`,
  )
  check('详情抽屉包含标题与完整路径', drawerText.includes(firstExpectedItem.title) && drawerText.includes(firstExpectedItem.path), `${firstExpectedItem.title}`)
  check('详情抽屉包含说明与安全解释', /说明/.test(drawerText) && /安全说明/.test(drawerText), drawerText.includes('安全说明') ? '包含说明 + 安全说明' : '缺少说明/安全说明')
  check('详情抽屉包含「打开位置」操作', drawerText.includes('打开位置'), '包含打开位置')
  check(
    '详情抽屉含选中/取消选择操作（受保护项除外）',
    drawerText.includes('选中此项') || drawerText.includes('取消选择'),
    drawerText.includes('取消选择') ? '当前为已选状态' : '当前为未选状态',
  )
  const drawerScreenshot = path.join(SHOT_DIR, 'detail-drawer-3000.png')
  await captureFullPage(drawerScreenshot)
  note(`详情抽屉截图：${path.relative(ROOT, drawerScreenshot)}`)
  await closeDetail()

  /* ---------- 5. 搜索 / 风险 / 大小 / 任务筛选 / 排序 ---------- */
  section('6. 筛选、排序（搜索/风险/大小/任务）')
  await cdp.evaluate(`window.__t.clickText('应用推荐', '.banner-actions')`)
  await sleep(400)
  const beforeSearchSelected = await cdp.evaluate('window.__t.selected()')
  check('应用推荐后选中数 = 推荐集（搜索前基线）', beforeSearchSelected.count === expected.recommendCount, beforeSearchSelected.text)
  const searchToken = firstExpectedItem.taskId
  const searchExpected = nonProtected.filter(
    (item) => item.title.toLowerCase().includes(searchToken.toLowerCase()) || item.path.toLowerCase().includes(searchToken.toLowerCase()) || (item.note ?? '').toLowerCase().includes(searchToken.toLowerCase()),
  ).length
  const searchOk = await cdp.evaluate(`window.__t.setInput('.search-input input', ${JSON.stringify(searchToken)})`)
  await sleep(400)
  const searchState = await cdp.evaluate(`({ filter: window.__t.filterInfo(), rows: document.querySelectorAll('.item-row').length, selected: window.__t.selected() })`)
  check(
    '搜索名称/路径/说明：结果数与独立统计一致',
    searchOk && searchState.filter.count === searchExpected && searchState.rows === Math.min(100, searchExpected),
    `${searchToken} → ${searchState.filter.count} 项 / 本页 ${searchState.rows} 行`,
    `实际 ${JSON.stringify(searchState.filter)} / ${searchState.rows} 行，期望 ${searchExpected} 项`,
  )
  check('搜索不丢失已选（跨筛选保留选择）', searchState.selected.count === beforeSearchSelected.count, `${searchState.selected.count} 项`)
  await cdp.evaluate(`window.__t.setInput('.search-input input', '')`)
  await sleep(300)

  await cdp.evaluate(`window.__t.clickSel('.risk-filter[data-risk="risky"]')`)
  await sleep(400)
  const riskyRows = await cdp.evaluate('window.__t.itemRows()')
  const riskyFilterInfo = await cdp.evaluate('window.__t.filterInfo()')
  check(
    '风险筛选 risky：只显示高风险行且数量正确',
    riskyRows.length === Math.min(100, expected.risky) && riskyRows.every((text) => text.includes('高风险')) && riskyFilterInfo.count === expected.risky,
    `${riskyRows.length} 行 / 共 ${riskyFilterInfo.count} 项`,
    `行数 ${riskyRows.length}，筛选计数 ${riskyFilterInfo.count}，期望 ${expected.risky}`,
  )
  await resetFilters()

  const sizePick = await chooseOption('.size-filter', '≥ 100 MB')
  const sizeExpected = nonProtected.filter((item) => item.size >= 100 * 1024 ** 2).length
  const sizeState = await cdp.evaluate(`({ filter: window.__t.filterInfo(), rows: document.querySelectorAll('.item-row').length })`)
  check(
    '大小筛选 ≥100 MB：结果数正确',
    sizePick.opened && sizePick.picked && sizeState.filter.count === sizeExpected,
    `${sizeState.filter.count} 项`,
    `实际 ${sizeState.filter.count}，期望 ${sizeExpected}（展开=${sizePick.opened} 选项=${sizePick.picked}）`,
  )
  await resetFilters()

  const filterTaskEntry = [...taskStats.values()].sort((a, b) => b.count - a.count)[0]
  const filterTaskName = taskMap.get(filterTaskEntry.taskId)?.name ?? filterTaskEntry.taskId
  const taskPick = await chooseOption('.task-filter', filterTaskName)
  const taskFilterState = await cdp.evaluate(`({ filter: window.__t.filterInfo(), rows: document.querySelectorAll('.item-row').length })`)
  check(
    '任务筛选：结果数正确',
    taskPick.opened && taskPick.picked && taskFilterState.filter.count === filterTaskEntry.count,
    `${filterTaskName} → ${taskFilterState.filter.count} 项`,
    `实际 ${taskFilterState.filter.count}，期望 ${filterTaskEntry.count}（${filterTaskName}；展开=${taskPick.opened} 选项=${taskPick.picked}）`,
  )
  await resetFilters()

  const riskPick = await chooseOption('.sort-select', '风险（高')
  const riskSortedRows = await cdp.evaluate('window.__t.itemRows()')
  check(
    '排序「风险（高 → 低）」：前 N 行均为高风险',
    riskPick.opened && riskPick.picked && riskSortedRows.length > 0 && riskSortedRows.slice(0, Math.min(riskySortedCount(), 100)).every((text) => text.includes('高风险')),
    `前 ${Math.min(riskySortedCount(), 100)} 行高风险`,
    `展开=${riskPick.opened} 选项=${riskPick.picked}；首行：${riskSortedRows.slice(0, 3).join(' || ').slice(0, 200)}`,
  )
  function riskySortedCount() {
    return expected.risky
  }
  const ascPick = await chooseOption('.sort-select', '大小（从小到大）')
  await sleep(400)
  const ascSizeTexts = await cdp.evaluate(`(() => [...document.querySelectorAll('.el-table__row')].map((tr) => (tr.querySelectorAll('td')[3]?.innerText ?? '').trim()))()`)
  const HUMAN_UNITS = { B: 0, KB: 1, MB: 2, GB: 3, TB: 4 }
  const parseHumanBytes = (text) => {
    if (text === '—') return 0 // 0 字节在界面上显示为 —
    const match = /^([\d.]+)\s*(B|KB|MB|GB|TB)$/.exec(text)
    return match ? Number(match[1]) * 1024 ** HUMAN_UNITS[match[2]] : NaN
  }
  const ascSizes = ascSizeTexts.map(parseHumanBytes)
  check(
    '排序「大小（从小到大）」：本页大小单调不减',
    ascPick.opened &&
      ascPick.picked &&
      ascSizes.length > 1 &&
      ascSizes.every(Number.isFinite) &&
      ascSizes.every((size, index) => index === 0 || size >= ascSizes[index - 1]),
    `${ascSizeTexts.slice(0, 3).join(' / ')} …`,
    `展开=${ascPick.opened} 选项=${ascPick.picked}；前 3 个大小：${ascSizeTexts.slice(0, 3).join(' / ')}`,
  )
  await chooseOption('.sort-select', '大小（从大到小）')

  /* ---------- 6. 分页 / 跨页选择 / 本页全选 ---------- */
  section('7. 分页、跨页选择、本页全选、批量助手')
  await clearSelection()
  const page1First = (await cdp.evaluate('window.__t.itemIds()'))[0]
  await cdp.evaluate(`window.__t.clickSel('.pager .btn-next')`)
  await sleep(450)
  const page2Ids = await cdp.evaluate('window.__t.itemIds()')
  check('下一页可翻页且内容变化', page2Ids.length === Math.min(100, expected.nonProtectedCount - 100) && page2Ids[0] !== page1First, `第 2 页 ${page2Ids.length} 行`)
  await cdp.evaluate(`(() => { const row = document.querySelectorAll('.el-table__row')[0]; const title = row?.querySelector('.item-title'); if (title) title.click(); return true })()`)
  await sleep(300)
  const crossPageSelected = await cdp.evaluate('window.__t.selected()')
  check('明细行可点击选中（第 2 页选中 1 项）', crossPageSelected.count === 1, crossPageSelected.text)
  await cdp.evaluate(`window.__t.clickSel('.pager .btn-prev')`)
  await sleep(400)
  const backPageSelected = await cdp.evaluate('window.__t.selected()')
  check('跨页切换后选择保留', backPageSelected.count === 1, backPageSelected.text)
  await cdp.evaluate(`window.__t.clickSel('.pager .btn-next')`)
  await sleep(400)
  const page2CheckboxStates = await cdp.evaluate('window.__t.rowCheckboxStates()')
  check('返回第 2 页后该行仍为选中态', page2CheckboxStates[0] === true && page2CheckboxStates.filter(Boolean).length === 1, `${page2CheckboxStates.filter(Boolean).length} 行已选`)

  await clearSelection()
  await cdp.evaluate(`(() => { const row = document.querySelectorAll('.el-table__row')[0]; const title = row?.querySelector('.item-title'); if (title) title.click(); return true })()`)
  await sleep(250)
  await cdp.evaluate(`window.__t.clickSel('.bulk-bar .el-checkbox')`)
  await sleep(350)
  const bulkSelected = await cdp.evaluate('window.__t.selected()')
  check('「本页全选」选中当前页全部 100 项', bulkSelected.count === Math.min(100, expected.nonProtectedCount), bulkSelected.text)
  await switchView('groups')
  const groupsViewSelected = await cdp.evaluate('window.__t.selected()')
  check('切换视图不丢失选择', groupsViewSelected.count === bulkSelected.count, `${groupsViewSelected.count} 项`)
  await switchView('items')
  await sleep(250)

  const pagerPick = await chooseOption('.pager .el-select', '500')
  const page500Rows = await cdp.evaluate('document.querySelectorAll(".item-row").length')
  const totalPages = Math.ceil(expected.nonProtectedCount / 500)
  const lastPageRows = expected.nonProtectedCount - 500 * (totalPages - 1)
  check(
    '分页大小可切换到 500/页',
    pagerPick.opened && pagerPick.picked && page500Rows === Math.min(500, expected.nonProtectedCount),
    `${page500Rows} 行`,
    `实际 ${page500Rows} 行，期望 ${Math.min(500, expected.nonProtectedCount)}（展开=${pagerPick.opened}，选项=${pagerPick.picked}）`,
  )
  const lastPageClicked = await cdp.evaluate(`(() => {
    const pages = [...document.querySelectorAll('.el-pager li.number')]
    const last = pages[pages.length - 1]
    if (!last) return false
    last.click()
    return true
  })()`)
  await sleep(500)
  const lastPageRowCount = await cdp.evaluate('document.querySelectorAll(".item-row").length')
  check(
    '最后一页行数正确（分页边界）',
    lastPageClicked && lastPageRowCount === lastPageRows,
    `第 ${totalPages} 页 ${lastPageRowCount} 行`,
    `实际 ${lastPageRowCount} 行，期望 ${lastPageRows} 行`,
  )
  await chooseOption('.pager .el-select', '100')

  /* 选中筛选结果 / 反选 / 清空 */
  await resetFilters()
  await clearSelection()
  await cdp.evaluate(`window.__t.clickSel('.risk-filter[data-risk="risky"]')`)
  await sleep(350)
  const selectFilteredClicked = await cdp.evaluate(`window.__t.clickText('选中筛选结果', '.risk-filters')`)
  await sleep(400)
  const afterSelectFiltered = await cdp.evaluate('window.__t.selected()')
  const footerRiskPills = await cdp.evaluate(`(() => { const footer = document.querySelector('.footer-info'); return footer ? [...footer.querySelectorAll('.cc-pill')].map((el) => el.innerText.replace(/\\s+/g, ' ').trim()) : [] })()`)
  check(
    '「选中筛选结果」按当前筛选选中全部高风险项',
    selectFilteredClicked && afterSelectFiltered.count === expected.risky,
    `${afterSelectFiltered.count} 项`,
    `实际 ${afterSelectFiltered.count}，期望 ${expected.risky}（按钮点击=${selectFilteredClicked}）`,
  )
  check('底部出现高风险隔离提示', footerRiskPills.some((text) => /高风险/.test(text) && /隔离/.test(text)), footerRiskPills.join(' / '), footerRiskPills.join(' / '))
  const invertClicked = await cdp.evaluate(`window.__t.clickText('反选', '.risk-filters')`)
  await sleep(450)
  const afterInvert = await cdp.evaluate('window.__t.selected()')
  // 当前已选集合恰好等于当前筛选结果（risky 392 项），反选 = 全部取消
  check(
    '「反选当前筛选结果」：已选=筛选集时反选后归零',
    invertClicked && afterInvert.count === 0,
    `${afterInvert.count} 项`,
    `实际 ${afterInvert.count}，期望 0（反选点击=${invertClicked}）`,
  )
  const invertAgainClicked = await cdp.evaluate(`window.__t.clickText('反选', '.risk-filters')`)
  await sleep(450)
  const afterInvertAgain = await cdp.evaluate('window.__t.selected()')
  check(
    '再次反选恢复为当前筛选结果（risky 全部选中）',
    invertAgainClicked && afterInvertAgain.count === expected.risky,
    `${afterInvertAgain.count} 项`,
    `实际 ${afterInvertAgain.count}，期望 ${expected.risky}（反选点击=${invertAgainClicked}）`,
  )
  await clearSelection()
  const afterClear = await cdp.evaluate('window.__t.selected()')
  check('「清空选择」归零', afterClear.count === 0, afterClear.text)
  await resetFilters()

  /* ---------- 7. 确认摘要 ---------- */
  section('8. 清理确认摘要（数量/大小/风险构成/任务分布/高风险隔离提示）')
  await resetFilters()
  const applyClicked = await cdp.evaluate(`window.__t.clickText('应用推荐', '.banner-actions')`)
  await sleep(400)
  const applied = await cdp.evaluate('window.__t.selected()')
  check('「应用推荐」恢复默认推荐选择', applyClicked && applied.count === expected.recommendCount && applied.bytesText === formatBytes(expected.recommendBytes), applied.text)
  const openConfirm = await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('.footer-bar button')].find((el) => /开始清理|预演清理/.test(el.textContent) && !el.disabled)
    if (!button) return false
    button.click()
    return true
  })()`)
  await cdp.waitFor('确认清理对话框', async () => Boolean(await cdp.evaluate('window.__t.dialog()')), 8_000)
  await sleep(300)
  const confirm = await cdp.evaluate('window.__t.dialog()')
  const confirmCountMatch = /即将清理\s*([\d,]+)\s*项/.exec(confirm?.text ?? '')
  check('清理按钮打开确认摘要对话框', Boolean(openConfirm) && Boolean(confirm), confirm ? confirm.text.slice(0, 150) : '')
  check(
    '确认摘要包含数量与大小',
    Boolean(confirmCountMatch) && Number(confirmCountMatch[1].replace(/,/g, '')) === expected.recommendCount && /合计\s*[\d.]+\s*(B|KB|MB|GB|TB)/.test(confirm.text),
    `${confirmCountMatch?.[1]} 项 / ${formatBytes(expected.recommendBytes)}`,
    `摘要：${confirm?.text.slice(0, 220)}`,
  )
  check(
    '确认摘要含风险构成（安全 N 项）',
    confirm.riskPills.some((pill) => pill.includes('安全') && pill.includes(String(expected.recommendCount))),
    confirm.riskPills.join(' / '),
    `风险 pill：${confirm.riskPills.join(' / ')}`,
  )
  check(
    '确认摘要含任务分布（按大小排序、最多 8 行 + 其余提示）',
    confirm.tasks.length === Math.min(8, expectedConfirmTasks.length) &&
      confirm.tasks[0].includes(expectedConfirmTasks[0].name) &&
      (expectedConfirmTasks.length <= 8 || /还有\s*\d+\s*个任务未列出/.test(confirm.text)),
    `${confirm.tasks.length} 行 / 共 ${expectedConfirmTasks.length} 个任务`,
    `行数 ${confirm.tasks.length} / 期望 ${Math.min(8, expectedConfirmTasks.length)}；首行 ${confirm.tasks[0] ?? '无'}`,
  )
  check('推荐选择无高风险，摘要不出现高风险隔离提示', !/高风险项，将先放入隔离区/.test(confirm.text), '无高风险提示')
  await cdp.evaluate(`(() => { const panel = document.querySelector('.el-dialog__footer'); const button = panel ? [...panel.querySelectorAll('button')].find((el) => /取消/.test(el.textContent)) : null; if (button) { button.click(); return true } return false })()`)
  await cdp.waitFor('确认框关闭', async () => (await cdp.evaluate('window.__t.dialog()')) === null, 8_000)

  await clearSelection()
  await cdp.evaluate(`window.__t.clickSel('.risk-filter[data-risk="risky"]')`)
  await sleep(350)
  await cdp.evaluate(`window.__t.clickText('选中筛选结果', '.risk-filters')`)
  await sleep(400)
  await cdp.evaluate(`(() => { const button = [...document.querySelectorAll('.footer-bar button')].find((el) => /开始清理/.test(el.textContent) && !el.disabled); if (button) button.click(); return true })()`)
  await cdp.waitFor('高风险确认对话框', async () => Boolean(await cdp.evaluate('window.__t.dialog()')), 8_000)
  await sleep(300)
  const riskyConfirm = await cdp.evaluate('window.__t.dialog()')
  check(
    '选中高风险项时摘要含高风险隔离提示',
    /高风险项，将先放入隔离区，可随时恢复/.test(riskyConfirm?.text ?? '') && riskyConfirm.riskPills.some((pill) => pill.includes('高风险')),
    riskyConfirm?.text?.slice(0, 160),
    `摘要：${riskyConfirm?.text?.slice(0, 240)}`,
  )
  await cdp.evaluate(`(() => { const panel = document.querySelector('.el-dialog__footer'); const button = panel ? [...panel.querySelectorAll('button')].find((el) => /取消/.test(el.textContent)) : null; if (button) { button.click(); return true } return false })()`)
  await cdp.waitFor('高风险确认框关闭', async () => (await cdp.evaluate('window.__t.dialog()')) === null, 8_000)
  await resetFilters()

  /* ---------- 8. dryRun 预演 / 移动到 / 上次清理面板 ---------- */
  section('9. 旧功能：预演（dryRun）、移动到、上次清理结果、候选任务勾选')
  const taskCardCount = await cdp.evaluate('document.querySelectorAll(".task-card").length')
  const taskFooterText = await cdp.evaluate(`(() => { const el = [...document.querySelectorAll('.cc-card-title .cc-faint')].find((x) => x.textContent.includes('个任务')); return el ? el.textContent.replace(/\\s+/g, ' ').trim() : '' })()`)
  const defaultTaskIds = tasks.filter((task) => task.defaultSelected).map((task) => task.id)
  check(
    '候选任务卡片渲染且默认勾选 defaultSelected 任务',
    taskCardCount === tasks.length && taskFooterText.includes(`已选 ${defaultTaskIds.length} 个任务`),
    `${taskCardCount} 张任务卡片 / ${taskFooterText}`,
    `卡片 ${taskCardCount} / 期望 ${tasks.length}；${taskFooterText}`,
  )
  const taskChecked = await cdp.evaluate(`(() => { const boxes = [...document.querySelectorAll('.task-card .el-checkbox')]; const box = boxes.find((el) => !el.classList.contains('is-checked')); if (!box) return false; box.click(); return true })()`)
  await sleep(300)
  const taskFooterAfter = await cdp.evaluate(`(() => { const el = [...document.querySelectorAll('.cc-card-title .cc-faint')].find((x) => x.textContent.includes('个任务')); return el ? el.textContent.replace(/\\s+/g, ' ').trim() : '' })()`)
  check('候选任务可勾选/取消（勾选后计数 +1）', taskChecked && taskFooterAfter.includes(`已选 ${defaultTaskIds.length + 1} 个任务`), taskFooterAfter, `勾选=${taskChecked}，${taskFooterAfter}`)
  await cdp.evaluate(`window.__t.clickText('全选安全任务', '.cc-card-title')`)
  await sleep(250)

  await cdp.evaluate(`window.__t.clickText('应用推荐', '.banner-actions')`)
  await sleep(300)
  const beforeDryRun = await cdp.evaluate('window.__t.selected()')
  await cdp.evaluate(`window.__t.clickSel('.cc-page-title .el-switch')`)
  await sleep(250)
  const dryRunButtonText = await cdp.evaluate(`(() => { const button = [...document.querySelectorAll('.footer-bar button')].find((el) => /预演清理|开始清理/.test(el.textContent)); return button ? button.innerText.replace(/\\s+/g, ' ').trim() : '' })()`)
  check('「仅预演」开关切换后清理按钮变为预演', /预演/.test(dryRunButtonText), dryRunButtonText)
  await cdp.evaluate(`(() => { const button = [...document.querySelectorAll('.footer-bar button')].find((el) => /预演清理/.test(el.textContent) && !el.disabled); if (button) button.click(); return true })()`)
  await cdp.waitFor('预演确认对话框', async () => Boolean(await cdp.evaluate('window.__t.dialog()')), 8_000)
  await sleep(250)
  const dryRunConfirm = await cdp.evaluate('window.__t.dialog()')
  check('预演确认摘要显示「即将预演清理」', /即将预演清理/.test(dryRunConfirm?.text ?? ''), dryRunConfirm?.text?.slice(0, 120))
  await cdp.evaluate(`(() => { const panel = document.querySelector('.el-dialog__footer'); const button = panel ? [...panel.querySelectorAll('button')].find((el) => /开始预演/.test(el.textContent)) : null; if (button) { button.click(); return true } return false })()`)
  const dryRunMessage = await cdp.waitFor('预演完成消息', async () => {
    const messages = await cdp.evaluate('window.__t.messages()')
    return messages.find((text) => text.includes('预演完成')) ?? undefined
  }, 15_000)
  check('预演执行后提示「预演完成：可释放 …」', Boolean(dryRunMessage), dryRunMessage)
  const lastCleanPanel = await cdp.evaluate(`(() => { const titles = [...document.querySelectorAll('.cc-card-title h3')].map((el) => el.innerText.trim()); return { has: titles.some((title) => title.includes('上次清理结果')), titles } })()`)
  check('上次清理结果面板出现', lastCleanPanel.has, lastCleanPanel.titles.join(' / '))
  await cdp.evaluate(`window.__t.clickSel('.cc-page-title .el-switch')`)
  await sleep(250)

  const moveClicked = await cdp.evaluate(`window.__t.clickText('移动到', '.footer-bar')`)
  await cdp.waitFor('移动到对话框', () => cdp.evaluate(`Boolean(document.querySelector('.el-message-box'))`), 8_000)
  const moveBoxText = await cdp.evaluate(`(() => { const box = document.querySelector('.el-message-box'); return box ? box.innerText.replace(/\\s+/g, ' ').trim() : '' })()`)
  check('「移动到…」弹出目标目录输入框', moveClicked && /移动到/.test(moveBoxText) && /目标文件夹/.test(moveBoxText), moveBoxText.slice(0, 140), `弹窗：${moveBoxText.slice(0, 200)}`)
  const moveInputOk = await cdp.evaluate(`window.__t.setInput('.el-message-box__input input', 'D:\\\\CordClean-backup')`)
  await sleep(200)
  await cdp.evaluate(`(() => { const box = document.querySelector('.el-message-box'); const button = box ? [...box.querySelectorAll('button')].find((el) => /开始移动/.test(el.textContent)) : null; if (button) { button.click(); return true } return false })()`)
  const moveMessage = await cdp.waitFor('移动到结果消息', async () => {
    const messages = await cdp.evaluate('window.__t.messages()')
    return messages.find((text) => text.includes('移动')) ?? undefined
  }, 15_000)
  check('移动到 RPC 调用完成且无未定义函数异常（mock 返回 0 项）', Boolean(moveInputOk) && Boolean(moveMessage), moveMessage)

  /* ---------- 9. 受保护视图 ---------- */
  section('10. 受保护项只读视图（原因 + 详情）')
  await switchView('protected')
  const protectedRows = await cdp.evaluate('document.querySelectorAll(".protected-row").length')
  const protectedTip = await cdp.evaluate('window.__t.txt(".protected-tip")')
  const protectedHasCheckbox = await cdp.evaluate('Boolean(document.querySelector(".protected-row input[type=checkbox]"))')
  check('受保护视图行数 = protected 数量', protectedRows === expected.protectedCount, `${protectedRows} / ${expected.protectedCount}`)
  check('受保护视图有原因说明且每项不可勾选', Boolean(protectedTip) && !protectedHasCheckbox, protectedTip.slice(0, 100))
  const protectedDetailClicked = await cdp.evaluate(`(() => { const button = document.querySelector('.protected-row .sample-actions .link'); if (!button) return false; button.click(); return true })()`)
  await cdp.waitFor('受保护详情抽屉', () => cdp.evaluate('Boolean(document.querySelector(".detail-drawer"))'), 8_000)
  await sleep(250)
  const protectedDrawer = await cdp.evaluate('window.__t.draw()')
  check(
    '受保护项详情展示「受保护原因」，无选中按钮',
    protectedDetailClicked && /受保护原因/.test(protectedDrawer?.text ?? '') && /受保护项不可清理/.test(protectedDrawer?.text ?? '') && !/选中此项/.test(protectedDrawer?.text ?? ''),
    protectedDrawer?.text?.slice(0, 140),
    `抽屉：${protectedDrawer?.text?.slice(0, 240)}`,
  )
  await closeDetail()

  /* 修复 1：受保护视图搜索生效 */
  const firstProtected = protectedItems[0]
  const protectedSearchExpected = protectedItems.filter(
    (item) =>
      item.title.toLowerCase().includes(firstProtected.title.toLowerCase()) ||
      item.path.toLowerCase().includes(firstProtected.title.toLowerCase()) ||
      (item.note ?? '').toLowerCase().includes(firstProtected.title.toLowerCase()),
  ).length
  await cdp.evaluate(`window.__t.setInput('.search-input input', ${JSON.stringify(firstProtected.title)})`)
  await sleep(450)
  const filteredProtectedRows = await cdp.evaluate('document.querySelectorAll(".protected-row").length')
  check(
    '受保护视图搜索：按名称/路径/说明过滤受保护项',
    filteredProtectedRows === protectedSearchExpected && protectedSearchExpected < expected.protectedCount,
    `搜「${firstProtected.title}」→ ${filteredProtectedRows} 行（共 ${expected.protectedCount}）`,
    `实际 ${filteredProtectedRows} 行，期望 ${protectedSearchExpected}`,
  )
  await cdp.evaluate(`window.__t.setInput('.search-input input', 'no-such-protected-xyz')`)
  await sleep(450)
  const noMatchRows = await cdp.evaluate('document.querySelectorAll(".protected-row").length')
  const noMatchHint = await cdp.evaluate('window.__t.txt(".protected-list .cc-empty")')
  check(
    '受保护视图搜索无匹配时显示提示与「清除搜索」',
    noMatchRows === 0 && noMatchHint.includes('没有匹配') && noMatchHint.includes('清除搜索'),
    noMatchHint || `行数 ${noMatchRows}`,
    `行数 ${noMatchRows}；提示「${noMatchHint}」`,
  )
  const clearProtectedSearch = await cdp.evaluate(`window.__t.clickText('清除搜索', '.protected-list')`)
  await sleep(450)
  const restoredProtectedRows = await cdp.evaluate('document.querySelectorAll(".protected-row").length')
  const restoredSearchValue = await cdp.evaluate(`document.querySelector('.search-input input')?.value ?? ''`)
  check(
    '「清除搜索」恢复受保护列表与搜索框',
    clearProtectedSearch && restoredProtectedRows === expected.protectedCount && restoredSearchValue === '',
    `${restoredProtectedRows} 行 / 搜索框「${restoredSearchValue}」`,
    `行数 ${restoredProtectedRows}，搜索框「${restoredSearchValue}」`,
  )
  await switchView('groups')
  section('11. 全页截图与 3000 条交互耗时')
  await resetFilters()
  await cdp.evaluate(`window.__t.clickText('应用推荐', '.banner-actions')`)
  await sleep(300)
  await cdp.evaluate(`document.querySelector('.result-card')?.scrollIntoView({ block: 'start' }); 'ok'`)
  await sleep(500)
  const lightShot = path.join(SHOT_DIR, 'scan-selection-3000-light.png')
  await captureFullPage(lightShot)
  note(`亮色全页截图（结果面板）：${path.relative(ROOT, lightShot)}`)
  await switchView('items')
  await cdp.evaluate(`document.querySelector('.result-card')?.scrollIntoView({ block: 'start' }); 'ok'`)
  await sleep(500)
  const itemsShot = path.join(SHOT_DIR, 'scan-selection-3000-items.png')
  await captureFullPage(itemsShot)
  note(`明细视图截图：${path.relative(ROOT, itemsShot)}`)
  await switchView('groups')
  await cdp.evaluate(`document.querySelector('.result-card')?.scrollIntoView({ block: 'start' }); 'ok'`)
  await sleep(400)
  const themeDark = await cdp.evaluate(`(() => { const toggle = document.querySelector('.theme-toggle'); if (!toggle) return false; toggle.click(); return true })()`)
  await sleep(500)
  const darkApplied = await cdp.evaluate(`document.documentElement.classList.contains('dark')`)
  const darkShot = path.join(SHOT_DIR, 'scan-selection-3000-dark.png')
  await captureFullPage(darkShot)
  note(`暗色全页截图：${path.relative(ROOT, darkShot)}`)
  check('亮/暗主题切换生效', themeDark && darkApplied, `dark class=${darkApplied}`)
  await cdp.evaluate(`document.querySelector('.theme-toggle')?.click()`)
  await sleep(400)

  const perf = await cdp.evaluate(`(async () => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const findButton = (text, scopeSel) => {
      const root = scopeSel ? document.querySelector(scopeSel) : document
      return root ? [...root.querySelectorAll('button')].find((el) => el.textContent.includes(text) && !el.disabled) : undefined
    }
    const groupRows0 = document.querySelectorAll('.group-row').length
    const t0 = performance.now()
    findButton('清空选择', '.risk-filters')?.click()
    await frame()
    const t1 = performance.now()
    document.querySelector('.risk-filter[data-risk="caution"]')?.click()
    await frame()
    const t2 = performance.now()
    findButton('重置筛选', '.risk-filters')?.click()
    await frame()
    const t3 = performance.now()
    findButton('应用推荐', '.banner-actions')?.click()
    await frame()
    const t4 = performance.now()
    return { clearMs: t1 - t0, cautionFilterMs: t2 - t1, resetMs: t3 - t2, applyRecommendMs: t4 - t3, groupRows: groupRows0 }
  })()`)
  metrics.interaction = perf
  note(`交互耗时：清空 ${perf.clearMs.toFixed(1)} ms / 谨慎筛选 ${perf.cautionFilterMs.toFixed(1)} ms / 重置 ${perf.resetMs.toFixed(1)} ms / 应用推荐 ${perf.applyRecommendMs.toFixed(1)} ms`)
  check(
    '3000 条下筛选/选择交互均在 1 s 内（目测流畅）',
    [perf.clearMs, perf.cautionFilterMs, perf.resetMs, perf.applyRecommendMs].every((value) => value < 1000),
    `最大 ${Math.max(perf.clearMs, perf.cautionFilterMs, perf.resetMs, perf.applyRecommendMs).toFixed(1)} ms`,
  )
  check('3000 条分组总览仍渲染 40 个任务行', perf.groupRows === expected.taskCountWithData, `${perf.groupRows} 行`)

  /* ---------- 11. 边界数据 ---------- */
  section('12. 边界数据：全 protected / 空扫描 / 0 字节 / 无 note / 超长路径')
  const baseReport = mock.fixture.report
  const edgeTask = taskMap.get('temp') ?? tasks[0]
  const makeItem = (id, overrides) => ({
    id,
    taskId: edgeTask.id,
    title: id,
    path: `C:\\Users\\mock\\edge\\${id}`,
    kind: 'file',
    size: 1024,
    mtimeMs: Date.now(),
    risk: 'safe',
    category: edgeTask.category,
    defaultSelected: true,
    note: '边界测试项',
    ...overrides,
  })

  // 12.1 全 protected
  mock.fixture.report = {
    ...baseReport,
    scanId: 'edge-all-protected',
    items: [
      makeItem('edge:p-safe', { risk: 'safe', protected: true, defaultSelected: false, size: 10 * 1024 ** 2 }),
      makeItem('edge:p-caution', { risk: 'caution', protected: true, defaultSelected: false, size: 20 * 1024 ** 2 }),
      makeItem('edge:p-risky', { risk: 'risky', protected: true, defaultSelected: false, size: 30 * 1024 ** 2 }),
    ],
    stats: { files: 3, dirs: 0, bytes: 60 * 1024 ** 2, errors: 0, truncated: false },
  }
  await reloadPage('all-protected')
  const allProtectedStats = await cdp.evaluate('window.__t.stats()')
  const allProtectedGroups = await cdp.evaluate('document.querySelectorAll(".group-row").length')
  const allProtectedEmpty = await cdp.evaluate('window.__t.txt(".cc-empty")')
  const allProtectedSelected = await cdp.evaluate('window.__t.selected()')
  await switchView('protected')
  const allProtectedRows = await cdp.evaluate('document.querySelectorAll(".protected-row").length')
  await switchView('groups')
  check(
    '全 protected 扫描：可清理/推荐/需要确认/任务数均为 0，无分组，受保护 3 行',
    allProtectedStats[0].includes('0 个任务') &&
      allProtectedStats[1].includes(' 0 ') &&
      allProtectedStats[2].includes(' 0 ') &&
      allProtectedGroups === 0 &&
      allProtectedRows === 3 &&
      allProtectedSelected.count === 0,
    `${allProtectedStats.slice(0, 3).join(' | ')} · 分组 ${allProtectedGroups} · protected 行 ${allProtectedRows}`,
    `统计 ${allProtectedStats.join(' | ')} / 分组 ${allProtectedGroups} / protected ${allProtectedRows} / 已选 ${allProtectedSelected.count}（可清理任务数应为 0 个任务）`,
  )
  check('全 protected 扫描：空态提示友好', Boolean(allProtectedEmpty), allProtectedEmpty.slice(0, 80))
  await captureFullPage(path.join(SHOT_DIR, 'edge-all-protected.png'))

  // 12.2 空扫描
  mock.fixture.report = {
    ...baseReport,
    scanId: 'edge-empty',
    items: [],
    stats: { files: 0, dirs: 0, bytes: 0, errors: 0, truncated: false },
  }
  await reloadPage('empty-scan')
  const emptyStats = await cdp.evaluate('window.__t.stats()')
  const emptyBanner = await cdp.evaluate('window.__t.txt(".recommend-banner")')
  const emptyGroupRows = await cdp.evaluate('document.querySelectorAll(".group-row").length')
  const emptyFooter = await cdp.evaluate('window.__t.selected()')
  const emptyText = await cdp.evaluate('window.__t.txt(".cc-empty")')
  check(
    '空扫描：统计全 0、推荐 0、无分组、已选 0、无异常',
    emptyStats.length === 4 && emptyStats.every((text) => /(^|\s)0(\s|$|[项B])/.test(text)) && /勾选 0 项/.test(emptyBanner) && emptyGroupRows === 0 && emptyFooter.count === 0,
    `${emptyStats.join(' | ')} / ${emptyBanner.slice(0, 70)}`,
    `统计 ${emptyStats.join(' | ')} / banner ${emptyBanner.slice(0, 120)} / 分组 ${emptyGroupRows}`,
  )
  check('空扫描：展示空态文案', Boolean(emptyText), emptyText.slice(0, 80))
  await captureFullPage(path.join(SHOT_DIR, 'edge-empty-scan.png'))

  // 12.3 0 字节 / 无 note / 超长路径
  const longName = 'long-name-' + 'x'.repeat(180) + '.log'
  const longPath = 'C:\\Users\\mock\\' + ('deep-folder\\'.repeat(30)) + longName
  const longNote = '说明：' + '很长的规则说明。'.repeat(40)
  mock.fixture.report = {
    ...baseReport,
    scanId: 'edge-fields',
    items: [
      makeItem('edge:zero-safe', { size: 0, note: undefined, title: 'zero-byte-safe.log', path: 'C:\\Users\\mock\\zero\\zero-byte-safe.log', risk: 'safe' }),
      makeItem('edge:zero-caution', { size: 0, note: undefined, title: 'zero-byte-caution.log', path: 'C:\\Users\\mock\\zero\\zero-byte-caution.log', risk: 'caution', defaultSelected: false }),
      makeItem('edge:long', { size: 5 * 1024 ** 2, title: longName, path: longPath, note: longNote, risk: 'safe' }),
      makeItem('edge:risky', { size: 3 * 1024 ** 2, title: 'risky-item.bin', path: 'C:\\Users\\mock\\risky\\risky-item.bin', risk: 'risky', defaultSelected: false }),
    ],
    stats: { files: 4, dirs: 0, bytes: 8 * 1024 ** 2, errors: 0, truncated: false },
  }
  await reloadPage('edge-fields')
  await switchView('items')
  const edgeRows = await cdp.evaluate('window.__t.itemRows()')
  const bodyText = await cdp.evaluate('document.body.innerText')
  const overflow = await cdp.evaluate('window.__t.fullPageInfo()')
  check(
    '0 字节 / 无 note / 超长路径数据可渲染，无 undefined/NaN 文本',
    edgeRows.length === 4 && !/undefined|NaN/.test(bodyText),
    `${edgeRows.length} 行，无 undefined/NaN`,
    `行数 ${edgeRows.length}；body 含 ${/undefined/.test(bodyText) ? 'undefined' : ''}${/NaN/.test(bodyText) ? ' NaN' : ''}`,
  )
  const edgeCells = await cdp.evaluate(`(() => [...document.querySelectorAll('.el-table__row')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.innerText.replace(/\\s+/g, ' ').trim())))()`)
  const zeroByteCells = edgeCells.filter((cells) => (cells[1] ?? '').includes('zero-byte'))
  check(
    '0 字节项大小列显示「—」，无 note 项不渲染说明行',
    zeroByteCells.length === 2 &&
      zeroByteCells.every((cells) => cells[3] === '—') &&
      !edgeRows.some((text) => text.includes('zero-byte-') && text.includes('说明')) &&
      (await cdp.evaluate('document.querySelectorAll(".item-list .item-note").length')) === 2,
    `${zeroByteCells.length} 个零字节项大小列显示 —；note 行数 2`,
    `大小列：${JSON.stringify(zeroByteCells.map((cells) => cells[3]))}；note 行数 ${await cdp.evaluate('document.querySelectorAll(".item-list .item-note").length')}（期望 2）`,
  )
  const zeroRowIndex = await cdp.evaluate(`(() => { const rows = [...document.querySelectorAll('.el-table__row')]; return rows.findIndex((row) => row.innerText.includes('zero-byte-safe')) })()`)
  if (zeroRowIndex >= 0) {
    const zeroDrawer = await openDetailAt(zeroRowIndex)
    check(
      '0 字节 + 无 note 项详情：大小显示「—」，不出现空说明块',
      Boolean(zeroDrawer) && zeroDrawer.text.includes('—') && !/说明：/.test(zeroDrawer.text),
      zeroDrawer?.text.slice(0, 120),
      `抽屉：${zeroDrawer?.text.slice(0, 200)}`,
    )
    await closeDetail()
  }
  check('超长路径不破坏横向布局（无横向滚动条）', overflow.scrollWidth <= overflow.clientWidth + 2, `scrollWidth=${overflow.scrollWidth} / clientWidth=${overflow.clientWidth}`)
  const longRowIndex = await cdp.evaluate(`(() => { const rows = [...document.querySelectorAll('.el-table__row')]; return rows.findIndex((row) => row.innerText.includes('long-name-')) })()`)
  if (longRowIndex >= 0) {
    const longDrawer = await openDetailAt(longRowIndex)
    check(
      '超长路径在详情抽屉中完整展示（可换行不截断）',
      Boolean(longDrawer) && longDrawer.text.includes(longPath.slice(-60)) && /说明/.test(longDrawer.text),
      `抽屉长度 ${longDrawer?.text.length ?? 0} 字符`,
      `抽屉未包含完整路径尾段：${longDrawer?.text.slice(0, 160)}`,
    )
    await closeDetail()
  } else {
    check('超长路径在详情抽屉中完整展示（可换行不截断）', false, '', '未找到超长路径行')
  }
  await switchView('groups')
  await captureFullPage(path.join(SHOT_DIR, 'edge-long-path.png'))

  /* 修复 2：扫描取消提示（mock 返回 cancelled 报告） */
  mock.fixture.report = {
    ...baseReport,
    scanId: 'edge-cancelled',
    cancelled: true,
    items: baseReport.items.slice(0, 500),
    stats: { ...baseReport.stats, files: 500, bytes: baseReport.items.slice(0, 500).reduce((sum, item) => sum + item.size, 0) },
  }
  await reloadPage('cancelled-scan')
  await cdp.evaluate(`(() => { const b = [...document.querySelectorAll('.cc-actions button')].find((el) => /开始扫描/.test(el.textContent)); if (b) { b.click(); return true } return false })()`)
  const cancelledMessage = await cdp.waitFor(
    '取消扫描提示',
    async () => {
      const messages = await cdp.evaluate('window.__t.messages()')
      return messages.find((text) => text.includes('扫描已取消')) ?? undefined
    },
    15_000,
  )
  const messagesAfterCancel = await cdp.evaluate('window.__t.messages()')
  check(
    '扫描返回 cancelled 时提示「扫描已取消，已显示部分结果」而非「扫描完成」',
    Boolean(cancelledMessage) && !messagesAfterCancel.some((text) => text === '扫描完成'),
    cancelledMessage ?? messagesAfterCancel.join(' / '),
    `消息：${messagesAfterCancel.join(' / ')}`,
  )
  await cdp.evaluate(`window.__t.clickText('单独扫描', '.task-grid')`)
  const singleCancelled = await cdp.waitFor(
    '单独扫描取消提示',
    async () => {
      const messages = await cdp.evaluate('window.__t.messages()')
      return messages.filter((text) => text.includes('扫描已取消')).length >= 2 ? true : undefined
    },
    15_000,
  )
  check('「单独扫描」返回 cancelled 时同样提示已取消', Boolean(singleCancelled), '两次「扫描已取消」提示')
  mock.fixture.report = { ...baseReport, scanId: 'edge-normal' }
  await reloadPage('normal-scan')
  await cdp.evaluate(`(() => { const b = [...document.querySelectorAll('.cc-actions button')].find((el) => /开始扫描/.test(el.textContent)); if (b) { b.click(); return true } return false })()`)
  const normalScanMessage = await cdp.waitFor(
    '正常扫描完成提示',
    async () => {
      const messages = await cdp.evaluate('window.__t.messages()')
      return messages.find((text) => text === '扫描完成') ?? undefined
    },
    15_000,
  )
  check('未取消的扫描仍提示「扫描完成」', Boolean(normalScanMessage), normalScanMessage)

  /* 还原 mock 数据，避免影响后续观察 */
  mock.fixture.report = baseReport

  /* ---------- 12. 无 JS 异常 ---------- */
  section('13. 页面 JS 异常检查（全流程）')
  check('全流程无 JS 异常 / console.error / Log.error', pageErrors.length === 0, '0 条错误', `${pageErrors.length} 条：${[...new Set(pageErrors)].slice(0, 8).join(' | ')}`)

  /* ---------- 汇总 ---------- */
  const failed = results.filter((entry) => !entry.ok)
  console.log(`\n════════ 验收结果：通过 ${results.length - failed.length} / ${results.length}，失败 ${failed.length}，缺陷 ${defects.length} ════════`)
  if (failed.length) {
    console.log('\n失败项：')
    for (const entry of failed) console.log(`  ✗ ${entry.name}\n     ${entry.detail}`)
  }
  if (defects.length) {
    console.log('\n缺陷清单：')
    for (const entry of defects) console.log(`  [${entry.severity}] ${entry.title}\n     ${entry.file}\n     ${entry.detail}`)
  }
  writeFileSync(path.join(HERE, 'semantics-results.json'), JSON.stringify({ results, defects, metrics, pageErrors, expected, timestamp: new Date().toISOString() }, null, 2))
  finalExitCode = failed.length > 0 ? 1 : 0
}

try {
  await main()
} catch (error) {
  console.log('\n❌ 验证脚本执行失败：', error)
  if (pageErrors.length) console.log('页面错误：', [...new Set(pageErrors)].slice(0, 10))
  console.log('Edge 日志尾部：', edgeLog.join('').slice(-1200))
  finalExitCode = 1
} finally {
  await cleanup()
  process.exit(finalExitCode)
}
