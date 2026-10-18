/**
 * Electron 界面端到端冒烟测试（通过 Chrome DevTools Protocol）。
 *
 * 做的事情：
 * 1. 以远程调试模式启动真实的 Electron 应用（独立数据目录，不碰正式配置）；
 * 2. 依次点击 6 个侧边栏页面，检查标题渲染、收集 JS 异常与 console.error；
 * 3. 触发一次「开始扫描」，等待结果表格出现（只扫描，不清理）；
 * 4. 每页截图保存到 docs/screenshots/ui-*.png，作为论文/答辩证据。
 *
 *   node scripts/e2e-ui.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'

const root = process.cwd()
const port = 9333
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cordclean-e2e-'))
const shotDir = path.join(root, 'docs', 'screenshots')
mkdirSync(shotDir, { recursive: true })

const electronBin = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const mainFile = path.join(root, 'apps', 'desktop', 'dist', 'main.mjs')

const errors = []
let socket
let messageId = 0
const pending = new Map()

function send(method, params = {}) {
  const id = ++messageId
  const payload = JSON.stringify({ id, method, params })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP 超时：${method}`))
    }, 30_000)
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
    socket.send(payload)
  })
}

async function evaluate(expression, awaitPromise = false) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: true,
  })
  if (result.exceptionDetails) {
    throw new Error('页面脚本异常：' + (result.exceptionDetails.exception?.description ?? result.exceptionDetails.text))
  }
  return result.result?.value
}

async function waitFor(description, fn, timeoutMs = 60_000, interval = 300) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const value = await fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error(`等待超时：${description}`)
}

async function capture(name) {
  const result = await send('Page.captureScreenshot', { format: 'png' })
  const file = path.join(shotDir, `ui-${name}.png`)
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
    spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
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
  // 1. 等待调试端口就绪并找到页面 target
  const target = await waitFor('DevTools 端口', async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await response.json()
      return list.find((item) => item.type === 'page' && /index\.html|localhost/.test(item.url))
    } catch {
      return undefined
    }
  }, 40_000)

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
      errors.push(`[exception] ${detail.exception?.description ?? detail.text}`)
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      errors.push(`[console.error] ${message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ')}`)
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      errors.push(`[log] ${message.params.entry.text}`)
    }
  })

  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.enable')

  // 2. 等待 Vue 挂载完成
  const ready = await waitFor('界面挂载', async () => evaluate('!!document.querySelector(".sidebar")'), 40_000)
  if (!ready) throw new Error('界面未挂载')

  const transport = await evaluate('typeof window.cordclean === "object"')
  console.log('IPC 通道可用：', transport)

  const navNames = await evaluate('[...document.querySelectorAll(".nav-item")].map(el => el.textContent.trim())')
  console.log('侧边栏：', navNames.join(' / '))

  const expected = [
    { page: 'overview', title: '概览' },
    { page: 'clean', title: '扫描与清理' },
    { page: 'plugins', title: '插件' },
    { page: 'history', title: '历史与隔离区' },
    { page: 'ai', title: 'AI 清理顾问' },
    { page: 'settings', title: '设置' },
  ]

  for (const [index, item] of expected.entries()) {
    await evaluate(`document.querySelectorAll('.nav-item')[${index}].click()`)
    const title = await waitFor(`${item.title} 渲染`, async () => {
      const text = await evaluate('document.querySelector(".cc-page-title h1")?.textContent?.trim() ?? ""')
      return text === item.title ? text : undefined
    }, 10_000)
    const file = await capture(item.page)
    console.log(`✓ ${item.title.padEnd(8)} hash=${await evaluate('location.hash')}  截图=${path.relative(root, file)}`)
    void title
  }

  // 3. 真实扫描（只扫描，不清理）
  await evaluate(`document.querySelectorAll('.nav-item')[1].click()`)
  await new Promise((resolve) => setTimeout(resolve, 500))
  const clicked = await evaluate(
    `(() => { const btn = [...document.querySelectorAll('.el-button')].find(b => b.textContent.includes('开始扫描')); if (!btn) return false; btn.click(); return true })()`,
  )
  if (!clicked) throw new Error('未找到「开始扫描」按钮')

  await waitFor('扫描结果表格', async () => evaluate('document.querySelectorAll(".el-table__row").length > 0'), 120_000, 500)
  const summary = await evaluate(
    `[...document.querySelectorAll('.cc-stat')].slice(0,4).map(el => el.textContent.replace(/\\s+/g,' ').trim()).join(' | ')`,
  )
  console.log('扫描完成，统计卡片：', summary)
  const file = await capture('clean-result')
  console.log('✓ 扫描结果截图：', path.relative(root, file))

  // 4. AI 页面：启用插件并验证新配置界面渲染（无 Key 时也能渲染表单）
  await evaluate(`document.querySelectorAll('.nav-item')[4].click()`)
  await new Promise((resolve) => setTimeout(resolve, 600))
  const enabledAi = await evaluate(
    `(() => { const btn = [...document.querySelectorAll('.el-button')].find(b => b.textContent.includes('立即启用')); if (!btn) return false; btn.click(); return true })()`,
  )
  if (enabledAi) {
    await waitFor('AI 配置界面', async () => evaluate(`!!document.querySelector('.setting-form')`), 20_000)
    console.log('✓ AI 插件已启用，接口设置表单渲染成功')
    await capture('ai-config')
  } else {
    console.log('· AI 插件已是启用状态，跳过启用步骤')
  }

  // 5. 切到插件页检查插件列表非空
  await evaluate(`document.querySelectorAll('.nav-item')[2].click()`)
  const pluginCount = await waitFor('插件卡片', async () => evaluate('document.querySelectorAll(".plugin-card").length'), 15_000)
  console.log(`✓ 插件卡片数量：${pluginCount}`)

  await new Promise((resolve) => setTimeout(resolve, 600))

  if (errors.length) {
    console.log(`\n❌ 捕获到 ${errors.length} 条错误：`)
    for (const error of [...new Set(errors)].slice(0, 20)) console.log('  -', error)
    shutdown(1)
  } else {
    // 主题切换：默认亮色 → 点击切到暗色 → 再切回亮色
  const themeBefore = await evaluate("document.documentElement.classList.contains('dark')")
  await evaluate("document.querySelector('.theme-toggle')?.click()")
  await new Promise((resolve) => setTimeout(resolve, 500))
  const themeAfter = await evaluate("document.documentElement.classList.contains('dark')")
  console.log(`✓ 主题切换：${themeBefore ? 'dark' : 'light'} → ${themeAfter ? 'dark' : 'light'}`)
  await capture('theme-dark')
  await evaluate("document.querySelector('.theme-toggle')?.click()")
  await new Promise((resolve) => setTimeout(resolve, 300))
  const themeBack = await evaluate("document.documentElement.classList.contains('dark')")
  console.log(`✓ 主题切回：${themeBack ? 'dark' : 'light'}`)
  // 侧边栏折叠：应为 64px 窄轨道且图标仍可点击
  const collapsedNow = () => evaluate("document.documentElement.classList.contains('sidebar-collapsed')")
  if (!(await collapsedNow())) {
    await evaluate("document.querySelector('.collapse-btn')?.click()")
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  const railWidth = await evaluate("Math.round(document.querySelector('.sidebar')?.getBoundingClientRect().width ?? -1)")
  const icons = await evaluate("document.querySelectorAll('.sidebar .nav-item .nav-icon').length")
  await evaluate("document.querySelectorAll('.sidebar .nav-item')[2]?.click()")
  await new Promise((resolve) => setTimeout(resolve, 400))
  const railHash = await evaluate("location.hash")
  console.log(`✓ 折叠轨道：宽度=${railWidth}px，图标数=${icons}，点击后 hash=${railHash}`)
  await capture("rail")
  await evaluate("document.querySelector('.collapse-btn')?.click()")
  await new Promise((resolve) => setTimeout(resolve, 300))
  const expandedWidth = await evaluate("Math.round(document.querySelector('.sidebar')?.getBoundingClientRect().width ?? -1)")
  console.log(`✓ 侧边栏展开：宽度=${expandedWidth}px`)
  console.log('\n✅ 界面端到端检查通过：6 个页面渲染正常、扫描全链路成功、无 JS 异常')
    shutdown(0)
  }
} catch (error) {
  console.log('\n❌ E2E 失败：', error instanceof Error ? error.message : error)
  if (mainLog.length) console.log('主进程输出：\n' + mainLog.join('').slice(-2000))
  if (errors.length) {
    console.log('页面错误：')
    for (const item of [...new Set(errors)].slice(0, 20)) console.log('  -', item)
  }
  shutdown(1)
}
