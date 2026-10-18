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

const FORBIDDEN: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /child_process/, message: '禁止使用 child_process（不能起子进程）' },
  { pattern: /process\.exit/, message: '禁止调用 process.exit' },
  { pattern: /fs\.(rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\b/, message: '禁止直接删除文件，删除必须交给内核' },
  { pattern: /from ['"]node:http['"]|from ['"]axios['"]/, message: '禁止插件内发起网络请求' },
]

export interface PluginValidation {
  ok: boolean
  errors: string[]
  warnings: string[]
}

export function validatePluginCode(code: string): PluginValidation {
  const errors: string[] = []
  const warnings: string[] = []
  const text = String(code ?? '')
  if (!text.trim()) return { ok: false, errors: ['代码为空'], warnings }

  if (!/defineCleanerPlugin/.test(text)) errors.push('缺少 defineCleanerPlugin（必须使用项目插件契约）')
  if (!/export\s+default/.test(text)) errors.push('缺少 export default')
  for (const rule of FORBIDDEN) {
    if (rule.pattern.test(text)) errors.push(rule.message)
  }
  if (!/ctx\.cleaner\.define\s*\(/.test(text)) warnings.push('没有找到 ctx.cleaner.define(...)，插件可能不会注册清理任务')
  if (!/inject\s*:/.test(text)) warnings.push('建议显式声明 inject（如 ["cleaner"]）')

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
