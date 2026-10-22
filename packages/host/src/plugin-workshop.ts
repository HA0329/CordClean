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
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkPluginSource } from '@cordclean/shared'

export interface PluginValidation {
  ok: boolean
  errors: string[]
  warnings: string[]
}

export function validatePluginCode(code: string): PluginValidation {
  const text = String(code ?? '')
  // 与生成端共用同一套契约检查，避免「生成能过、安装加载失败」
  const base = checkPluginSource(text)
  const errors = [...base.errors]
  const warnings = [...base.warnings]
  if (!text.trim()) return { ok: false, errors: errors.length ? errors : ['代码为空'], warnings }

  // 语法检查：与运行时同一个解析器
  let dir = ''
  try {
    dir = mkdtempSync(path.join(os.tmpdir(), 'cordclean-plugin-'))
    const file = path.join(dir, 'check.mjs')
    writeFileSync(file, text, 'utf8')
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 10_000 })
    if (result.status !== 0) {
      const message = (result.stderr || result.stdout || '语法检查失败').split('\n').filter(Boolean).slice(0, 3).join(' ')
      errors.push('语法错误：' + message)
    }
  } catch (error) {
    errors.push('语法检查无法执行：' + String(error))
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true })
  }

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
