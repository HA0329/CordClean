/**
 * 补充 Electron E2E（verifier）：只覆盖旧功能回归中 e2e-ui.mjs 未触达的交互：
 *  1. 真实扫描的「取消」按钮：扫描中点击取消，确认扫描中止、无 JS 异常；
 *  2. 扫描完成后：仅预演开关 → 打开预演确认框（不执行清理）→ 取消；
 *  3. 「移动到…」弹窗打开（不执行移动）→ 取消；
 *  4. 上次清理结果面板：本轮不执行真实清理，跳过（由 mock 验收覆盖）。
 *
 * 用法：node docs/verification/e2e-regression-extra.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SHOT_DIR = path.join(HERE, 'screenshots')
mkdirSync(SHOT_DIR, { recursive: true })
const port = 9335
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cordclean-e2e-reg-'))
const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const mainFile = path.join(ROOT, 'apps', 'desktop', 'dist', 'main.mjs')

const pageErrors = []
let socket
let messageId = 0
const pending = new Map()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
function check(name, ok, okDetail = '', failDetail = '') {
  results.push({ name, ok: Boolean(ok), detail: ok ? okDetail : failDetail || okDetail })
  console.log(`  ${ok ? '✓ PASS' : '✗ FAIL'}  ${name}${ok ? (okDetail ? `  (${okDetail})` : '') : failDetail ? `  →  ${failDetail}` : ''}`)
}

function send(method, params = {}) {
  const id = ++messageId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP 超时 ${method}`))
    }, 40_000)
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      },
    })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression, awaitPromise = true) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, userGesture: true })
  if (result.exceptionDetails) throw new Error('页面脚本异常：' + (result.exceptionDetails.exception?.description ?? result.exceptionDetails.text))
  return result.result?.value
}

async function waitFor(description, fn, timeoutMs = 60_000, interval = 150) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const value = await fn()
    if (value) return value
    await sleep(interval)
  }
  throw new Error(`等待超时：${description}`)
}

async function capture(name) {
  const result = await send('Page.captureScreenshot', { format: 'png' })
  const file = path.join(SHOT_DIR, name)
  writeFileSync(file, Buffer.from(result.data, 'base64'))
  return file
}

const child = spawn(electronBin, [mainFile, `--remote-debugging-port=${port}`], {
  env: { ...process.env, CORDCLEAN_DATA: dataDir, CORDCLEAN_LOG: 'warn' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const mainLog = []
child.stdout.on('data', (chunk) => mainLog.push(String(chunk)))
child.stderr.on('data', (chunk) => mainLog.push(String(chunk)))

function shutdown(code) {
  try {
    socket?.close()
  } catch {
    /* ignore */
  }
  try {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15_000 })
  } catch {
    /* ignore */
  }
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  process.exit(code)
}

try {
  console.log('== 补充 Electron E2E：扫描取消 / 预演弹窗 / 移动到弹窗 ==')
  const target = await waitFor(
    'DevTools 端口',
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`)
        const list = await response.json()
        return list.find((item) => item.type === 'page' && /index\.html|localhost/.test(item.url))
      } catch {
        return undefined
      }
    },
    40_000,
  )
  socket = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false })
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw))
    if (message.id && pending.has(message.id)) {
      const task = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) task.reject(new Error(message.error.message))
      else task.resolve(message.result)
      return
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const detail = message.params.exceptionDetails
      pageErrors.push(`[exception] ${detail.exception?.description ?? detail.text}`)
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      pageErrors.push(`[console.error] ${message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ')}`)
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error' && !/favicon/i.test(message.params.entry.url ?? '')) {
      pageErrors.push(`[log] ${message.params.entry.text}`)
    }
  })
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.enable')
  await waitFor('界面挂载', () => evaluate('!!document.querySelector(".sidebar")'), 40_000)
  await evaluate(`document.querySelectorAll('.nav-item')[1].click()`)
  await waitFor('清理页渲染', async () => (await evaluate('document.querySelector(".cc-page-title h1")?.textContent?.trim()')) === '扫描与清理', 20_000)
  console.log('  · 清理页已打开')

  const cancelDisabledBefore = await evaluate(`(() => { const b = [...document.querySelectorAll('.cc-actions button')].find((el) => el.textContent.trim() === '取消'); return b ? b.disabled : null })()`)
  check('未扫描时「取消」按钮为禁用态', cancelDisabledBefore === true, `disabled=${cancelDisabledBefore}`)

  // 安装页面内轮询：扫描按钮进入 loading 后立即点「取消」，尽可能压缩时序
  await evaluate(`(() => {
    window.__cancelProbe = { clicked: false, at: -1, buttonFound: false }
    const started = performance.now()
    window.__cancelTimer = setInterval(() => {
      const label = [...document.querySelectorAll('.cc-actions button')].find((el) => el.textContent.trim().startsWith('扫描中'))
      if (!label) return
      const cancel = [...document.querySelectorAll('.cc-actions button')].find((el) => el.textContent.trim() === '取消')
      if (cancel) {
        window.__cancelProbe.buttonFound = true
        if (!cancel.disabled) {
          cancel.click()
          window.__cancelProbe.clicked = true
          window.__cancelProbe.at = Math.round(performance.now() - started)
          clearInterval(window.__cancelTimer)
        }
      }
    }, 5)
    const start = [...document.querySelectorAll('.cc-actions button')].find((el) => /开始扫描/.test(el.textContent))
    start.click()
    return true
  })()`)
  const scanFinished = await waitFor(
    '扫描结束（按钮回到「开始扫描」）',
    async () => {
      const state = await evaluate(`(() => ({
        scanning: [...document.querySelectorAll('.cc-actions button')].some((el) => el.textContent.trim().startsWith('扫描中')),
        probe: window.__cancelProbe,
        groupRows: document.querySelectorAll('.group-row').length,
        messages: [...document.querySelectorAll('.el-message')].map((el) => el.innerText.replace(/\\s+/g, ' ').trim()),
      }))()`)
      return state.scanning === false ? state : undefined
    },
    120_000,
    100,
  )
  const probe = scanFinished.probe
  check('扫描中「取消」按钮可点击并触发取消', probe?.clicked === true, probe?.clicked ? `扫描开始后 ${probe.at} ms 点击取消` : '', `未捕获到可点击的取消时机：${JSON.stringify(probe)}`)
  check('取消后扫描结束且界面未报错', scanFinished.messages.every((text) => !/失败|异常|错误/.test(text)), `消息：${scanFinished.messages.join(' / ') || '无'}`)
  check(
    '取消后提示「扫描已取消，已显示部分结果」而非「扫描完成」',
    scanFinished.messages.some((text) => text.includes('扫描已取消')) && !scanFinished.messages.includes('扫描完成'),
    scanFinished.messages.join(' / '),
    `消息：${scanFinished.messages.join(' / ')}`,
  )
  const cancelledShot = await capture('e2e-regression-after-cancel.png')
  console.log(`  · 取消后截图：${path.relative(ROOT, cancelledShot)}`)
  console.log(`  · 取消时页面消息：${scanFinished.messages.join(' / ') || '（无）'}`)

  // 再跑一次完整扫描（用于后续弹窗检查；不清理）
  await evaluate(`(() => { const b = [...document.querySelectorAll('.cc-actions button')].find((el) => /开始扫描/.test(el.textContent)); if (b) b.click(); return true })()`)
  // 取消后界面会先展示部分结果，必须等第二次扫描真正结束（按钮回到「开始扫描」）再继续
  const fullScanState = await waitFor(
    '完整扫描结束',
    async () => {
      const state = await evaluate(`(() => ({
        scanning: [...document.querySelectorAll('.cc-actions button')].some((el) => el.textContent.trim().startsWith('扫描中')),
        groups: document.querySelectorAll('.group-row').length,
        selected: document.querySelector('.selected-count')?.innerText?.replace(/\\s+/g, ' ') ?? '',
      }))()`)
      return !state.scanning && state.groups > 0 && /\d+\s*项/.test(state.selected) && !/已选\s*0\s*项/.test(state.selected) ? state : undefined
    },
    120_000,
    300,
  )
  console.log(`  · 完整扫描完成：分组 ${fullScanState.groups} 行 / ${fullScanState.selected}`)
  await evaluate(`document.querySelector('.result-card')?.scrollIntoView({ block: 'start' }); 'ok'`)
  await sleep(500)
  const resultShot = await capture('e2e-regression-scan-result.png')
  console.log(`  · 结果截图：${path.relative(ROOT, resultShot)}`)

  // 仅预演 → 打开预演确认框 → 取消（不执行清理）
  await evaluate(`(() => { const sw = document.querySelector('.cc-page-title .el-switch'); if (!sw) return false; sw.click(); return true })()`)
  await sleep(250)
  const dryRunLabel = await evaluate(`(() => { const b = [...document.querySelectorAll('.footer-bar button')].find((el) => /预演清理|开始清理/.test(el.textContent)); return b ? b.textContent.trim() : '' })()`)
  check('「仅预演」开关把清理按钮文案切为预演', /预演/.test(dryRunLabel), dryRunLabel)
  await evaluate(`(() => { const b = [...document.querySelectorAll('.footer-bar button')].find((el) => /预演清理/.test(el.textContent) && !el.disabled); if (b) { b.click(); return true } return false })()`)
  const dialogText = await waitFor('预演确认框', async () => {
    const text = await evaluate(`(() => {
      const el = document.querySelector('.confirm-dialog')
      if (!el) return ''
      const panel = el.closest('.el-dialog')
      if (panel && (getComputedStyle(panel).display === 'none' || panel.getBoundingClientRect().width === 0)) return ''
      return el.innerText.replace(/\\s+/g, ' ').trim()
    })()`)
    return text || undefined
  }, 10_000)
  check('真实 Electron 中预演确认框显示「即将预演清理」等摘要', /即将预演清理/.test(dialogText) && /项/.test(dialogText) && /(B|KB|MB|GB|TB)/.test(dialogText), dialogText.slice(0, 140), dialogText.slice(0, 220))
  await evaluate(`(() => { const panel = document.querySelector('.el-dialog__footer'); const b = panel ? [...panel.querySelectorAll('button')].find((el) => /取消/.test(el.textContent)) : null; if (b) b.click(); return true })()`)
  await sleep(500)
  const dialogClosed = await evaluate(`(() => {
    const el = document.querySelector('.confirm-dialog')
    if (!el) return true
    const panel = el.closest('.el-dialog')
    return !panel || getComputedStyle(panel).display === 'none' || panel.getBoundingClientRect().width === 0
  })()`)
  check('预演确认框可取消（未执行清理）', dialogClosed === true, '已取消')
  await evaluate(`document.querySelector('.cc-page-title .el-switch')?.click()`)
  await sleep(250)

  // 移动到：打开弹窗 → 取消（不移动任何真实文件）
  await evaluate(`(() => { const b = [...document.querySelectorAll('.footer-bar button')].find((el) => /移动到/.test(el.textContent) && !el.disabled); if (b) { b.click(); return true } return false })()`)
  const moveBox = await waitFor('移动到弹窗', async () => {
    const text = await evaluate(`(() => { const box = document.querySelector('.el-message-box'); return box && box.getBoundingClientRect().width > 0 ? box.innerText.replace(/\\s+/g, ' ').trim() : '' })()`)
    return text || undefined
  }, 10_000)
  check('真实 Electron 中「移动到…」弹窗可打开（目标目录输入框）', /目标文件夹/.test(moveBox) && /开始移动/.test(moveBox), moveBox.slice(0, 140))
  await evaluate(`(() => { const box = document.querySelector('.el-message-box'); const b = box ? [...box.querySelectorAll('button')].find((el) => /取消/.test(el.textContent)) : null; if (b) b.click(); return true })()`)
  await sleep(500)
  const moveClosed = await evaluate(`(() => { const box = document.querySelector('.el-message-box'); return !box || box.getBoundingClientRect().width === 0 || getComputedStyle(box).display === 'none' })()`)
  check('移动到弹窗可取消（未移动任何文件）', moveClosed === true, '已取消')

  check('补充 E2E 全过程无 JS 异常 / console.error', pageErrors.length === 0, '0 条错误', `${pageErrors.length} 条：${[...new Set(pageErrors)].slice(0, 8).join(' | ')}`)

  const failed = results.filter((entry) => !entry.ok)
  console.log(`\n════ 补充 E2E：通过 ${results.length - failed.length} / ${results.length} ════`)
  if (failed.length) for (const entry of failed) console.log(`  ✗ ${entry.name} → ${entry.detail}`)
  shutdown(failed.length ? 1 : 0)
} catch (error) {
  console.log('\n❌ 补充 E2E 失败：', error instanceof Error ? error.message : error)
  if (mainLog.length) console.log('主进程输出尾部：\n' + mainLog.join('').slice(-1500))
  if (pageErrors.length) console.log('页面错误：', [...new Set(pageErrors)].slice(0, 10))
  shutdown(1)
}
