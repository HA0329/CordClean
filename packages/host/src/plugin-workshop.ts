/**
 * AI 插件工坊的落盘与校验。
 *
 * 安全立场：
 * - Node 里没有真正的沙箱，插件一旦加载就是全权限，所以这里**只做静态检查**，
 *   最终必须由用户阅读代码后手动点「安装」；
 * - 生成的插件禁止直接删除文件 / 起子进程 / 退出进程：命中即拒绝；
 * - 语法用 `node --check` 验证（与运行时同一个解析器）；
 * - 文件写到 <dataDir>/generated-plugins/，不污染仓库，也不覆盖用户文件。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkPluginSource } from '@cordclean/shared'

export interface PluginValidation {
  ok: boolean
  errors: string[]
  warnings: string[]
}

/** 用与运行时同一个解析器做语法检查；异步执行，避免阻塞宿主主线程 */
function checkSyntax(text: string): Promise<string | null> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cordclean-plugin-'))
  const file = path.join(dir, 'check.mjs')
  writeFileSync(file, text, 'utf8')
  return new Promise((resolve) => {
    let stderr = ''
    let stdout = ''
    let settled = false
    const child = spawn(process.execPath, ['--check', file], {
      windowsHide: true,
      // Electron 主进程里 process.execPath 是 electron.exe；不设这个变量会启动一个
      // 完整的 Electron 窗口而不是执行 Node 的 --check，最终表现为 10 秒超时。
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {}
      resolve('语法检查超时（10 秒）')
    }, 10_000)
    child.stderr?.on('data', (chunk) => (stderr += String(chunk)))
    child.stdout?.on('data', (chunk) => (stdout += String(chunk)))
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve('语法检查无法执行：' + error.message)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {}
      if (code === 0) return resolve(null)
      const raw = (stderr || stdout || 'node --check 返回非零退出码').trim()
      // 只保留关键行，避免把整段 Node 堆栈塞进界面
      const message = raw.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 4).join(' ')
      resolve(message || 'node --check 返回非零退出码')
    })
  })
}

export async function validatePluginCode(code: string): Promise<PluginValidation> {
  const text = String(code ?? '')
  // 与生成端共用同一套契约检查，避免「生成能过、安装加载失败」
  const base = checkPluginSource(text)
  const errors = [...base.errors]
  const warnings = [...base.warnings]
  if (!text.trim()) return { ok: false, errors: errors.length ? errors : ['代码为空'], warnings }

  const syntaxError = await checkSyntax(text)
  if (syntaxError) errors.push('语法错误：' + syntaxError)

  return { ok: errors.length === 0, errors, warnings }
}

/** 把生成的插件写到数据目录；返回绝对路径 */
export function saveGeneratedPlugin(dataDir: string, name: string, code: string): string {
  const safe = String(name || 'ai-plugin').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40) || 'ai-plugin'
  const dir = path.join(dataDir, 'generated-plugins')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${safe}.mjs`)
  writeFileSync(file, code, 'utf8')
  return file
}
