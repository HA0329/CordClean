import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const parts = ['01-head.html', '02-body-a.html', '03-body-b.html', '04-body-c.html', '05-script.html']
const shotDir = path.resolve(here, '../../docs/screenshots')
const out = 'D:/桌面/deepseek-harness/CordClean-项目介绍.html'

const SHOTS = {
  SHOT_OVERVIEW: 'ui-overview.png',
  SHOT_CLEAN: 'ui-clean-result.png',
  SHOT_PLUGINS: 'ui-plugins.png',
  SHOT_AI: 'ui-ai.png',
  SHOT_SETTINGS: 'ui-settings.png',
  SHOT_DARK: 'ui-theme-dark.png',
  SHOT_SELECT: 'scan-select-overview.png',
}

let html = parts.map((file) => fs.readFileSync(path.join(here, file), 'utf8')).join('\n')

for (const [key, file] of Object.entries(SHOTS)) {
  const full = path.join(shotDir, file)
  if (!fs.existsSync(full)) throw new Error('missing screenshot: ' + full)
  const data = fs.readFileSync(full).toString('base64')
  const token = `__${key}__`
  if (!html.includes(token)) throw new Error('missing token: ' + token)
  html = html.split(token).join(`data:image/png;base64,${data}`)
}

const left = html.match(/__SHOT_[A-Z]+__/g)
if (left) throw new Error('unreplaced shot tokens: ' + left.join(', '))

fs.writeFileSync(out, html, 'utf8')
console.log('built:', out)
console.log('size:', (fs.statSync(out).size / 1024 / 1024).toFixed(2), 'MB')


































