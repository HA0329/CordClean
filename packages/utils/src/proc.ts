/**
 * 外部命令调用（PowerShell / reg.exe）。
 *
 * 清理工具不可避免要借助系统命令完成部分操作（清空回收站、读写注册表、
 * 查询计划任务等），本模块统一处理：超时、错误码、UTF-8 输出、
 * 以及「执行失败但不致命」的降级语义。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface CommandResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
}

export interface CommandOptions {
  timeout?: number
  maxBuffer?: number
  cwd?: string
}

/** 执行任意可执行文件 */
export async function runCommand(file: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      timeout: options.timeout ?? 30_000,
      maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
      cwd: options.cwd,
      windowsHide: true,
      encoding: 'utf8',
    })
    return { ok: true, code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string }
    return {
      ok: false,
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? err.message ?? ''),
    }
  }
}

/** 执行 PowerShell 脚本，自动设置 UTF-8 输出 */
export async function powershell(script: string, options: CommandOptions = {}): Promise<CommandResult> {
  const wrapped = `$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;${script}`
  return runCommand(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', wrapped],
    { timeout: options.timeout ?? 60_000, maxBuffer: options.maxBuffer, cwd: options.cwd },
  )
}

/** 执行 reg.exe */
export async function reg(args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  return runCommand('reg.exe', args, { timeout: options.timeout ?? 15_000, ...options })
}

/** 查询注册表键（返回 reg.exe 的原始文本） */
export async function regQuery(key: string, valueName?: string): Promise<string> {
  const args = ['query', key]
  if (valueName) args.push('/v', valueName)
  const result = await reg(args)
  return result.ok ? result.stdout : ''
}

/** 导出注册表键到 .reg 文件（用于清理前的备份） */
export async function regExport(key: string, file: string): Promise<boolean> {
  const result = await reg(['export', key, file, '/y'])
  return result.ok
}

/** 删除注册表项 */
export async function regDeleteKey(key: string): Promise<boolean> {
  const result = await reg(['delete', key, '/f'])
  return result.ok
}

/** 删除注册表值 */
export async function regDeleteValue(key: string, valueName: string): Promise<boolean> {
  const result = await reg(['delete', key, '/v', valueName, '/f'])
  return result.ok
}

/** 写入注册表值 */
export async function regAddValue(key: string, valueName: string, type: string, value: string): Promise<boolean> {
  const result = await reg(['add', key, '/v', valueName, '/t', type, '/d', value, '/f'])
  return result.ok
}

/**
 * 解析 `reg query` 的输出为 { 值名: 值 } 映射。
 * 输出形如：
 *   HKEY_CURRENT_USER\...\Run
 *       WeChat    REG_SZ    "C:\Program Files\WeChat\WeChat.exe"
 */
export function parseRegValues(output: string): Array<{ name: string; type: string; value: string }> {
  const result: Array<{ name: string; type: string; value: string }> = []
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || /^HKEY_/i.test(line)) continue
    const match = /^(.+?)\s{2,}(REG_[A-Z_]+)\s{2,}(.*)$/.exec(line)
    if (match) {
      result.push({ name: match[1].trim(), type: match[2], value: match[3].trim() })
    }
  }
  return result
}

/** 列出注册表子键（返回完整键路径） */
export function parseRegSubKeys(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^HKEY_/i.test(line))
}
