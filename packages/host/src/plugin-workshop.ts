/**
 * AI 插件工坊的落盘、校验与依赖安装。
 *
 * 安全立场：
 * - Node 里没有真正的沙箱，插件一旦加载就是全权限，所以这里**只做静态检查**，
 *   最终必须由用户阅读代码、确认依赖后手动点「安装」；
 * - 生成的插件禁止直接删除文件 / 起子进程 / 退出进程：命中即拒绝；
 * - 依赖只允许用户在界面确认后安装，安装时禁用 lifecycle scripts；
 * - 语法用 `node --check` 验证（与运行时同一个解析器）；
 * - 零依赖插件写单文件；声明依赖的插件写独立目录（package.json + plugin.mjs + node_modules），
 *   让 Node 的 ESM 解析能正常工作。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkPluginSource, validatePluginDependencies } from '@cordclean/shared'

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

export async function validatePluginCode(
  code: string,
  dependencies: Record<string, string> = {},
  mode: 'worker' | 'native' = 'worker',
): Promise<PluginValidation> {
  const text = String(code ?? '')
  // 与生成端共用同一套契约检查，避免「生成能过、安装加载失败」
  const base = checkPluginSource(text, { dependencies, mode })
  const errors = [...base.errors]
  const warnings = [...base.warnings]
  if (!text.trim()) return { ok: false, errors: errors.length ? errors : ['代码为空'], warnings }

  const syntaxError = await checkSyntax(text)
  if (syntaxError) errors.push('语法错误：' + syntaxError)

  return { ok: errors.length === 0, errors, warnings }
}

/** 工坊插件最终路径（零依赖单文件；有依赖为目录内 plugin.mjs） */
export function generatedPluginPath(
  dataDir: string,
  name: string,
  dependencies: Record<string, string> = {},
): string {
  const safe = String(name || 'ai-plugin').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40) || 'ai-plugin'
  const baseDir = path.join(dataDir, 'generated-plugins')
  return Object.keys(dependencies).length
    ? path.join(baseDir, safe, 'plugin.mjs')
    : path.join(baseDir, `${safe}.mjs`)
}

/** 删除本次生成的插件文件/目录（失败回滚与卸载清理用） */
export function cleanupGeneratedPlugin(
  dataDir: string,
  name: string,
  dependencies: Record<string, string> = {},
): void {
  const file = generatedPluginPath(dataDir, name, dependencies)
  try {
    if (Object.keys(dependencies).length) rmSync(path.dirname(file), { recursive: true, force: true })
    else rmSync(file, { force: true })
  } catch {
    /* 清理失败不应掩盖原始安装错误 */
  }
}

/** 启动时清理上一次运行留下的工坊插件目录；持久化的插件路径要保留 */
export function cleanupGeneratedPlugins(dataDir: string, keepPaths: string[] = []): void {
  const base = path.resolve(path.join(dataDir, 'generated-plugins'))
  try {
    if (!existsSync(base)) return
    const keep = keepPaths.filter(Boolean).map((item) => path.resolve(item))
    for (const child of readdirSync(base)) {
      const childPath = path.join(base, child)
      const shouldKeep = keep.some((item) => item === childPath || item.startsWith(childPath + path.sep))
      if (!shouldKeep) rmSync(childPath, { recursive: true, force: true })
    }
    if (readdirSync(base).length === 0) rmSync(base, { recursive: true, force: true })
  } catch {
    /* 启动清理失败不影响主流程 */
  }
}

/** 判断路径是否是工坊生成的插件文件/目录（避免误删用户手工安装的外部插件） */
export function isGeneratedPluginPath(dataDir: string, target: string): boolean {
  const base = path.resolve(path.join(dataDir, 'generated-plugins'))
  const resolved = path.resolve(target)
  return resolved === base || resolved.startsWith(base + path.sep)
}

/** 把生成的插件写到数据目录；有依赖时写独立目录，零依赖保持单文件 */
export function saveGeneratedPlugin(
  dataDir: string,
  name: string,
  code: string,
  dependencies: Record<string, string> = {},
): string {
  const file = generatedPluginPath(dataDir, name, dependencies)
  const dir = path.dirname(file)
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, code, 'utf8')
  if (Object.keys(dependencies).length) {
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify(
        {
          name: 'cordclean-workshop-' + path.basename(dir),
          version: '0.0.0',
          private: true,
          type: 'module',
          dependencies,
        },
        null,
        2,
      ) + '\n',
      'utf8',
    )
  }
  return file
}

interface CommandResult {
  ok: boolean
  output: string
}

/** 在插件目录执行包管理器安装（禁用 lifecycle scripts）；不联网失败时给出可读错误 */
function runInstallCommand(command: string, args: string[], cwd: string, timeoutMs = 180_000): Promise<CommandResult> {
  return new Promise((resolve) => {
    let output = ''
    let settled = false
    // Windows 上 npm/pnpm 是 .cmd，需要经 cmd.exe 解析；命令与参数都是固定值，
    // 依赖名/版本来自已校验的 package.json，不拼接用户输入到命令行。
    const spawnCommand = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : command
    const spawnArgs = process.platform === 'win32' ? ['/d', '/s', '/c', [command, ...args].join(' ')] : args
    const child = spawn(spawnCommand, spawnArgs, {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        CI: '1',
        npm_config_ignore_scripts: 'true',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        npm_config_loglevel: 'error',
      },
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {}
      resolve({ ok: false, output: output + '\n依赖安装超时（180 秒）' })
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => {
      output += String(chunk)
      if (output.length > 20_000) output = output.slice(-20_000)
    })
    child.stderr?.on('data', (chunk) => {
      output += String(chunk)
      if (output.length > 20_000) output = output.slice(-20_000)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, output: '无法启动 ' + command + '：' + error.message })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: code === 0, output })
    })
  })
}

export interface DependencyInstallResult {
  manager: 'npm' | 'pnpm'
  output: string
}

/**
 * 安装插件声明的 npm 依赖。
 * 只用固定命令与固定参数，依赖名/版本来自已校验的 package.json，不拼接用户输入到命令行。
 */
export async function installPluginDependencies(pluginFile: string): Promise<DependencyInstallResult> {
  const dir = path.dirname(pluginFile)
  const pkgFile = path.join(dir, 'package.json')
  if (!existsSync(pkgFile)) return { manager: 'npm', output: '' }
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { dependencies?: Record<string, string> }
  const dependencyErrors = validatePluginDependencies(pkg.dependencies ?? {})
  if (dependencyErrors.length) throw new Error('依赖声明不合法：' + dependencyErrors.join('；'))
  const args = ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev', '--loglevel=error']
  const attempts: Array<{ manager: 'npm' | 'pnpm'; command: string; args: string[] }> = [
    { manager: 'npm', command: 'npm', args },
    { manager: 'pnpm', command: 'pnpm', args: ['install', '--ignore-scripts', '--prod', '--reporter=silent'] },
  ]
  const failures: string[] = []
  for (const attempt of attempts) {
    const result = await runInstallCommand(attempt.command, attempt.args, dir)
    if (result.ok) {
      if (!existsSync(path.join(dir, 'node_modules'))) {
        failures.push(`${attempt.manager} 退出码为 0 但没有生成 node_modules`)
        continue
      }
      return { manager: attempt.manager, output: result.output.slice(-4000) }
    }
    failures.push(`${attempt.manager}：${result.output.trim().slice(-800) || '未知错误'}`)
  }
  throw new Error('依赖安装失败（已禁用 lifecycle scripts）：' + failures.join(' | '))
}
