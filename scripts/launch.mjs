import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, openSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import http from 'node:http'
import path from 'node:path'

import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const mode = args.includes('desktop') ? 'desktop' : 'web'
const hidden = args.includes('--hidden')
const root = path.resolve(import.meta.dirname, '..')
process.chdir(root)
const runDir = path.join(root, '.run')
mkdirSync(runDir, { recursive: true })
const pidFile = path.join(runDir, 'cordclean.pid')
const logFile = path.join(runDir, 'launch.log')
const port = process.env.CORDCLEAN_PORT || '7801'
const url = `http://127.0.0.1:${port}/`

// --detach：再生成一个隐藏的自身，然后立刻退出（无窗口常驻）
if (args.includes('--detach')) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), mode, '--hidden'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: root,
  })
  child.unref()
  process.exit(0)
}
const log = (...m) => { if (!hidden) console.log(...m) }
const fail = (m) => { console.error(m); process.exitCode = 1 }

function readPid() {
  try {
    const v = readFileSync(pidFile, 'utf8').trim()
    return /^\d+$/.test(v) ? Number(v) : 0
  } catch { return 0 }
}
function alive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}
function ping(timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(`${url}api/ping`, { timeout: timeoutMs }, (res) => { res.resume(); resolve(res.statusCode === 200) })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}
function openBrowser() {
  if (process.env.CORDCLEAN_NO_OPEN === '1') return
  spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

log('')
log(' ============================================')
log('   CordClean 模块化电脑清理工具 - 一键启动')
log(' ============================================')
log('')

const pid = readPid()
if (alive(pid)) {
  log('CordClean 已经在运行，正在打开界面...')
  openBrowser()
  process.exit(0)
}

// Node 版本（当前进程本身就是证据）
const major = Number(process.versions.node.split('.')[0])
if (major < 20) fail(`[错误] Node.js 版本过低：v${process.versions.node}（需要 20+）`)
else log(`[1/3] Node.js v${process.versions.node}  OK`)

// pnpm
function run(cmd, argv, opts = {}) {
  return spawnSync(cmd, argv, { stdio: hidden ? 'ignore' : 'inherit', shell: true, encoding: 'utf8', ...opts })
}
let probe = run('pnpm', ['-v'], { stdio: 'ignore' })
if (probe.status !== 0) {
  log('[提示] 未检测到 pnpm，尝试 corepack enable...')
  run('corepack', ['enable'], { stdio: 'ignore' })
  probe = run('pnpm', ['-v'], { stdio: 'ignore' })
  if (probe.status !== 0) {
    log('[提示] corepack 不可用，改用 npm 安装 pnpm...')
    run('npm', ['install', '-g', 'pnpm'])
    probe = run('pnpm', ['-v'], { stdio: 'ignore' })
  }
  if (probe.status !== 0) fail('[错误] pnpm 不可用，请手动执行：npm install -g pnpm')
}
log('[2/3] pnpm 就绪  OK')

// 依赖
const needInstall = !existsSync('node_modules/.bin/tsx.cmd') || !existsSync('node_modules/.bin/vite.cmd')
const needElectron = mode === 'desktop' && !existsSync('node_modules/electron/dist/electron.exe')
if (needInstall || needElectron) {
  log('[3/3] 首次运行或依赖缺失：安装依赖（只需一次）...')
  const result = run('pnpm', ['install', '--prefer-offline'], {
    env: { ...process.env, ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/' },
  })
  if (result.status !== 0) fail('[错误] 依赖安装失败：请设置代理后重试')
} else {
  log('[3/3] 依赖已就绪，跳过 pnpm install')
}

writeFileSync(pidFile, String(process.pid), 'ascii')
let out = 'inherit'
if (hidden) {
  const fd = openSync(logFile, 'a')
  out = ['ignore', fd, fd]
}

log('')
log(mode === 'desktop' ? '正在启动桌面版... 窗口出现即表示已启动' : `正在启动浏览器版... 浏览器将自动打开 ${url}`)
log('状态：双击 6-查看运行状态.bat；退出：界面右上角电源按钮或 7-关闭CordClean.bat')

const child = spawn('pnpm', [mode === 'desktop' ? 'start:desktop' : 'start:web'], {
  stdio: out,
  shell: true,
  windowsHide: hidden,
  env: process.env,
})

if (mode === 'web') {
  // 等内核起来再打开浏览器，避免 404
  for (let i = 0; i < 120; i++) {
    if (await ping(1000)) { openBrowser(); break }
    if (child.exitCode !== null) break
    await sleep(500)
  }
}

const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c ?? 0)))
try { rmSync(pidFile, { force: true }) } catch {}
process.exit(code)