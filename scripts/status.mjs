import { readFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
const root = path.resolve(import.meta.dirname, '..')
const pidFile = path.join(root, '.run/cordclean.pid')
const port = process.env.CORDCLEAN_PORT || '7801'
let pid = 0
try { const v = readFileSync(pidFile, 'utf8').trim(); if (/^\d+$/.test(v)) pid = Number(v) } catch {}
let running = false
if (pid) { try { process.kill(pid, 0); running = true } catch {} }
const respond = await new Promise((resolve) => {
  const req = http.get(`http://127.0.0.1:${port}/api/ping`, { timeout: 2000 }, (res) => { res.resume(); resolve(res.statusCode === 200) })
  req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false) })
})
console.log('')
if (running && respond) {
  console.log('状态：运行中')
  console.log(`界面：http://127.0.0.1:${port}/`)
  console.log('退出：双击 关闭.bat，或点界面右上角电源按钮')
} else if (running) {
  console.log('状态：正在启动（进程在，服务尚未就绪）')
} else {
  console.log('状态：未运行')
  console.log('启动：双击 启动.bat')
}
console.log('')