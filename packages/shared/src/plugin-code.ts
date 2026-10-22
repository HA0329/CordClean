/**
 * 外部清理插件源码与依赖声明的静态契约检查（纯函数，不依赖 Node API）。
 *
 * 背景：AI 插件工坊生成的插件运行在 worker 中，从
 * `<dataDir>/generated-plugins/<name>/plugin.mjs` 加载。
 * 它不能 import 项目内部包（`@cordclean/*`）或框架包（`@cordisjs/*`）；
 * 需要第三方能力时，必须在 `dependencies` 里声明，安装流程会把依赖装到插件目录，
 * 用户确认后才会下载。生成端、安装端、测试共用这套规则。
 */

export interface PluginCodeCheck {
  ok: boolean
  errors: string[]
  warnings: string[]
}

export interface PluginCodeOptions {
  /** 声明依赖：包名 → 版本范围（semver） */
  dependencies?: Record<string, string>
  /**
   * worker = 旧式零依赖 cleaner 外部插件；
   * native = 原生 Cordis 通用插件（apply(ctx)，P1 起 AI 工坊默认）。
   */
  mode?: 'worker' | 'native'
}

export type PluginDependencyMap = Record<string, string>

const MAX_DEPENDENCIES = 8
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const VERSION_RE = /^[~^]?\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?$/

const FORBIDDEN: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /child_process/, message: '禁止使用 child_process（不能起子进程）' },
  { pattern: /process\.exit/, message: '禁止调用 process.exit' },
  { pattern: /\b(fs|require\(['"]node:fs['"]\))\.(rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\b/, message: '禁止直接删除文件，删除必须交给内核' },
  { pattern: /\b(rmSync|unlinkSync|rmdirSync)\s*\(/, message: '禁止直接删除文件，删除必须交给内核' },
  { pattern: /\b(fetch|axios|XMLHttpRequest)\b|from ['"]node:https?['"]/, message: '禁止插件内发起网络请求' },
  { pattern: /\bexecSync\b|\bspawnSync\b|\bshell\s*:/, message: '禁止起子进程或 shell' },
]

/** 生成插件允许 import 的 Node 内置模块 */
const ALLOWED_NODE_MODULES = new Set([
  'node:fs',
  'node:fs/promises',
  'node:path',
  'node:os',
  'node:url',
  'node:util',
  'node:crypto',
])

/** 校验依赖声明：包名合法、版本是 semver 范围、数量受限，禁止 file/git/URL 规格 */
export function validatePluginDependencies(input: unknown): string[] {
  const errors: string[] = []
  if (input === undefined || input === null) return errors
  if (typeof input !== 'object' || Array.isArray(input)) return ['dependencies 必须是 { 包名: 版本 } 对象']
  const entries = Object.entries(input as Record<string, unknown>)
  if (entries.length > MAX_DEPENDENCIES) errors.push(`依赖最多 ${MAX_DEPENDENCIES} 个，当前 ${entries.length} 个`)
  for (const [name, version] of entries) {
    if (!PACKAGE_NAME_RE.test(name)) {
      errors.push(`非法依赖包名：${name}（只允许 npm 包名，不能是路径/URL/git 规格）`)
      continue
    }
    if (name.startsWith('@cordisjs/') || name.startsWith('@cordclean/')) {
      errors.push(`不允许依赖框架内部包：${name}`)
      continue
    }
    if (typeof version !== 'string' || !VERSION_RE.test(version.trim())) {
      errors.push(`依赖 ${name} 的版本必须是 semver 范围（如 ^1.2.3），当前：${String(version)}`)
    }
  }
  return errors
}

function dependencyPackageName(specifier: string): string {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/')
  return specifier.split('/')[0]
}

function isDeclaredDependency(specifier: string, dependencies: PluginDependencyMap): boolean {
  const pkg = dependencyPackageName(specifier)
  return Object.prototype.hasOwnProperty.call(dependencies, pkg)
}

function importSpecifiers(code: string): string[] {
  const found: string[] = []
  const patterns = [
    /^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      if (match[1]) found.push(match[1])
    }
  }
  return [...new Set(found)]
}

/**
 * 检查插件源码是否满足「可安装的外部插件」契约。
 * 只做文本/语法形状检查，不执行代码；执行层面的验证由安装流程在 worker 里完成。
 */
export function checkPluginSource(code: string, options: PluginCodeOptions = {}): PluginCodeCheck {
  const errors: string[] = []
  const warnings: string[] = []
  const text = String(code ?? '')
  const dependencies = options.dependencies ?? {}
  const mode = options.mode ?? 'worker'

  if (!text.trim()) return { ok: false, errors: ['代码为空'], warnings }

  errors.push(...validatePluginDependencies(dependencies))

  if (mode === 'native') {
    // 原生 Cordis 插件契约：apply(ctx) / 命名导出 name；可直接使用 ctx 服务
    if (!/export\s+(?:async\s+)?function\s+apply\s*\(/.test(text) && !(/export\s+default\b/.test(text) && /\bapply\s*\(/.test(text))) {
      errors.push('缺少 apply(ctx)（原生 Cordis 插件必须导出 apply 函数）')
    }
    if (!/export\s+const\s+name\s*=/.test(text) && !/\bname\s*:/.test(text)) {
      errors.push('缺少 name（请使用 export const name = "kebab-case"）')
    }
    if (/\bsetup\s*\(/.test(text)) {
      warnings.push('原生 Cordis 插件应使用 apply(ctx)，setup 是旧式 worker 插件字段')
    }
    if (/\bctx\.ui\b/.test(text) && !/export\s+const\s+inject\s*=\s*\[[^\]]*['"]ui['"]/.test(text)) {
      warnings.push('使用了 ctx.ui，请在插件中声明 export const inject = ["ui"]')
    }
  } else {
    if (!/export\s+default\b/.test(text)) {
      errors.push('缺少 export default（外部插件必须默认导出一个插件对象）')
    }
    if (!/\bsetup\s*\(/.test(text)) {
      errors.push('缺少 setup(ctx, config)（外部插件必须提供 setup 函数）')
    }
    if (!/\bname\s*:/.test(text)) {
      errors.push('缺少 name（插件必须有 kebab-case 名称）')
    }
    if (options.dependencies && Object.keys(dependencies).length === 0) {
      warnings.push('dependencies 为空对象；如果不需要第三方包，可以省略该字段')
    }
  }

  // 外部插件契约：直接导出对象/模块，不能使用项目内部 helper
  if (/\bdefineCleanerPlugin\b/.test(text)) {
    errors.push(
      '外部插件不能使用 defineCleanerPlugin（该 helper 来自 @cordclean/shared，生成文件无法解析）；原生插件直接 export function apply(ctx)，worker 插件直接 export default { name, capabilities, Config, setup }',
    )
  }

  // import 画像：Node 内置白名单 + 已声明依赖；框架包/未声明包/相对路径一律拒绝
  for (const specifier of importSpecifiers(text)) {
    if (ALLOWED_NODE_MODULES.has(specifier)) continue
    if (specifier.startsWith('@cordisjs/') || specifier.startsWith('@cordclean/')) {
      errors.push(
        `不能 import "${specifier}"：外部插件不能依赖框架内部包；请用普通对象契约，不要使用 defineCleanerPlugin`,
      )
      continue
    }
    if (specifier.startsWith('.')) {
      errors.push(`不能 import 相对路径 "${specifier}"：外部插件必须是单文件，不能引用本地其它文件`)
      continue
    }
    if (!isDeclaredDependency(specifier, dependencies)) {
      errors.push(
        `不能 import "${specifier}"：请在 dependencies 中声明它（例如 "${dependencyPackageName(specifier)}": "^x.y.z"），安装时会下载并放到插件目录`,
      )
    }
  }

  for (const rule of FORBIDDEN) {
    if (rule.pattern.test(text)) errors.push(rule.message)
  }

  if (mode === 'worker') {
    if (!/\bcapabilities\s*:/.test(text)) {
      warnings.push('建议在插件对象中声明 capabilities.fsRoots（支持 %TEMP% 等模板），否则目标路径无法通过辖区校验')
    }
    if (!/\b(ctx|scanCtx)\.cleaner\.define\s*\(/.test(text) && !/\bctx\.cleaner\.define\s*\(/.test(text)) {
      warnings.push('没有找到 ctx.cleaner.define(...)，插件可能不会注册清理任务')
    }
    if (!/\bscan\s*\(/.test(text)) {
      warnings.push('没有找到 scan(...)，插件不会产生可清理项')
    }
  }
  if (/\bprocess\.env\b/.test(text)) {
    warnings.push('建议用 ctx.system.env.get(...) 读取环境变量，而不是 process.env')
  }
  for (const dep of Object.keys(dependencies)) {
    const imported = importSpecifiers(text).some((specifier) => dependencyPackageName(specifier) === dep)
    if (!imported) warnings.push(`依赖 ${dep} 已声明但代码里没有 import，安装后可能用不到`)
  }

  return { ok: errors.length === 0, errors, warnings }
}
