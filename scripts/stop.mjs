import { execSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
const root = path.resolve(import.meta.dirname, '..')
const pidFile = path.join(root, '.run/cordclean.pid')
const killed = []
if (existsSync(pidFile)) {
  const v = readFileSync(pidFile, 'utf8').trim()
  if (/^\d+$/.test(v)) {
    try { execSync(`taskkill /PID ${v} /T /F`, { stdio: 'ignore' }) ; killed.push(`pid ${v}（含子进程）`) } catch {}
  }
  rmSync(pidFile, { force: true })
}
// 兜底：按端口找占用进程
const port = process.env.CORDCLEAN_PORT || '7801'
try {
  const out = execSync('netstat -ano -p tcp', { encoding: 'utf8' })
  const line = out.split(/\r?\n/).find((l) => l.includes(`:${port}`) && l.includes('LISTENING'))
  if (line) {
    const pid = line.trim().split(/\s+/).pop()
    if (pid && /^\d+$/.test(pid)) {
      try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); killed.push(`pid ${pid}（端口 ${port}）`) } catch {}
    }
  }
} catch {}
console.log('')
if (killed.length) {
  console.log('CordClean 已关闭：')
  for (const item of killed) console.log('  - ' + item)
} else {
  console.log('没有发现正在运行的 CordClean（可能已经退出）。')
}
console.log('浏览器页面可以直接关闭标签页。')