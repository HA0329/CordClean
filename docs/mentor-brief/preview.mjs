import { spawn } from 'node:child_process'
import fs from 'node:fs'

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const fileUrl = 'file:///D:/%E6%A1%8C%E9%9D%A2/deepseek-harness/CordClean-%E9%A1%B9%E7%9B%AE%E4%BB%8B%E7%BB%8D.html'
const port = 9333
const profile = 'D:/桌面/deepseek-harness/.edge-mentor-profile'
const shots = ['#hero', '#safety', '#gallery', '#defense']

const child = spawn(edge, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await sleep(2500)

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
if (!page) throw new Error('no page target')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })

let id = 0
const pending = new Map()
const events = []
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
  } else if (msg.method) {
    events.push(msg)
  }
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const next = ++id
    pending.set(next, { resolve, reject })
    ws.send(JSON.stringify({ id: next, method, params }))
  })
}

await send('Page.enable')
await send('Runtime.enable')
await send('Log.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: fileUrl })
await sleep(2500)

const errors = events
  .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error'))
  .map((e) => e.method + ': ' + JSON.stringify(e.params).slice(0, 400))
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none')

const evalJs = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return res.result?.value
}
console.log('title:', await evalJs('document.title'))
console.log('reveal total/in:', await evalJs("document.querySelectorAll('.reveal').length + '/' + document.querySelectorAll('.reveal.in').length"))
console.log('imgs:', await evalJs("[...document.querySelectorAll('.shot img')].map(i=>i.naturalWidth).join(',')"))
console.log('stats:', await evalJs("[...document.querySelectorAll('.stat-num')].map(e=>e.textContent).join(',')"))

await evalJs("document.querySelector('[data-scene=\"junction\"]').click(); 'ok'")
await sleep(2800)
console.log('chain fail:', await evalJs("(document.querySelector('.step.fail .sstate')||{}).textContent + ' | ' + (document.querySelector('#chainOutcome h4')||{}).textContent"))
await evalJs("document.querySelector('[data-filter=\"disabled\"]').click(); 'ok'")
console.log('plugins visible:', await evalJs("[...document.querySelectorAll('#pluginGrid .plugin')].filter(e=>e.style.display!=='none').length"))
await evalJs("document.querySelectorAll('.shot')[0].click(); 'ok'")
await sleep(400)
console.log('lightbox:', await evalJs("document.querySelector('#lightbox').classList.contains('open') + '|' + document.querySelector('#lbImg').naturalWidth"))
await evalJs("document.querySelector('#lbClose').click(); document.documentElement.setAttribute('data-theme','dark'); window.scrollTo(0,0); 'ok'")
await sleep(500)
const dark = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('D:/桌面/deepseek-harness/mentor-dark.png', Buffer.from(dark.data, 'base64'))
console.log('dark shot ok')

for (let i = 0; i < shots.length; i++) {
  const sel = shots[i]
  await evalJs(`document.querySelector('${sel}').scrollIntoView({block:'start'}); 'ok'`)
  await sleep(900)
  const res = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(`D:/桌面/deepseek-harness/mentor-shot-${i}.png`, Buffer.from(res.data, 'base64'))
  console.log('shot', sel, 'ok')
}

await send('Browser.close').catch(() => {})
ws.close()
child.kill()
await sleep(500)
try { fs.rmSync(profile, { recursive: true, force: true }) } catch {}
process.exit(0)
