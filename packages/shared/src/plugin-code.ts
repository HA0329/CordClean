/**
 * 外部清理插件源码的静态契约检查（纯函数，不依赖 Node API）。
 *
 * 背景：AI 插件工坊生成的是「单文件、零依赖」的外部插件，运行在 worker 中。
 * 它不能 import 项目内部包（`@cordclean/*`）或框架包（`@cordisjs/*`）：
 * 这些包在生成文件所在目录解析不到，装进去只会在加载时抛 ERR_MODULE_NOT_FOUND。
 * 因此这里把「可安装的代码形状」写成明确规则，生成端与安装端共用。
 */

export interface PluginCodeCheck {
  ok: boolean
  errors: string[]
  warnings: string[]
}

const FORBIDDEN: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /child_process/, message: '禁止使用 child_process（不能起子进程）' },
  { pattern: /process\.exit/, message: '禁止调用 process.exit' },
  { pattern: /\b(fs|require\(['"]node:fs['"]\))\.(rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\b/, message: '禁止直接删除文件，删除必须交给内核' },
  { pattern: /\b(rmSync|unlinkSync|rmdirSync)\s*\(/, message: '禁止直接删除文件，删除必须交给内核' },
  { pattern: /\b(fetch|axios|XMLHttpRequest)\b|from ['"]node:https?['"]/, message: '禁止插件内发起网络请求' },
  { pattern: /\bexecSync\b|\bspawnSync\b|\bshell\s*:/, message: '禁止起子进程或 shell' },
]

/** 生成插件允许 import 的 Node 内置模块（单文件外部插件只应依赖这些） */
const ALLOWED_NODE_MODULES = new Set([
  'node:fs',
  'node:fs/promises',
  'node:path',
  'node:os',
  'node:url',
  'node:util',
  'node:crypto',
])

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
export function checkPluginSource(code: string): PluginCodeCheck {
  const errors: string[] = []
  const warnings: string[] = []
  const text = String(code ?? '')

  if (!text.trim()) return { ok: false, errors: ['代码为空'], warnings }

  if (!/export\s+default\b/.test(text)) {
    errors.push('缺少 export default（外部插件必须默认导出一个插件对象）')
  }
  if (!/\bsetup\s*\(/.test(text)) {
    errors.push('缺少 setup(ctx, config)（外部插件必须提供 setup 函数）')
  }
  if (!/\bname\s*:/.test(text)) {
    errors.push('缺少 name（插件必须有 kebab-case 名称）')
  }

  // 外部插件契约：直接导出对象，不能使用项目内部 helper
  if (/\bdefineCleanerPlugin\b/.test(text)) {
    errors.push(
      '外部插件不能使用 defineCleanerPlugin（该 helper 来自 @cordclean/shared，生成文件无法解析）；请直接 export default { name, version, capabilities, Config, setup }',
    )
  }

  // import 画像：只允许 Node 内置白名单；内部包/第三方/相对路径一律拒绝
  for (const specifier of importSpecifiers(text)) {
    if (ALLOWED_NODE_MODULES.has(specifier)) continue
    if (specifier.startsWith('@cordisjs/') || specifier.startsWith('@cordclean/')) {
      errors.push(
        `不能 import "${specifier}"：外部插件是单文件零依赖，生成目录解析不到框架包；请用普通对象契约，不要使用 defineCleanerPlugin`,
      )
      continue
    }
    if (specifier.startsWith('.')) {
      errors.push(`不能 import 相对路径 "${specifier}"：外部插件必须是单文件，不能引用其它文件`)
      continue
    }
    errors.push(
      `不能 import 第三方包 "${specifier}"：外部插件是单文件零依赖，只允许 node:fs / node:path / node:os 等内置模块`,
    )
  }

  for (const rule of FORBIDDEN) {
    if (rule.pattern.test(text)) errors.push(rule.message)
  }

  if (!/\bcapabilities\s*:/.test(text)) {
    warnings.push('建议在插件对象中声明 capabilities.fsRoots（支持 %TEMP% 等模板），否则目标路径无法通过辖区校验')
  }
  if (!/\b(ctx|scanCtx)\.cleaner\.define\s*\(/.test(text) && !/\bctx\.cleaner\.define\s*\(/.test(text)) {
    warnings.push('没有找到 ctx.cleaner.define(...)，插件可能不会注册清理任务')
  }
  if (/\bprocess\.env\b/.test(text)) {
    warnings.push('建议用 ctx.system.env.get(...) 读取环境变量，而不是 process.env')
  }
  if (!/\bscan\s*\(/.test(text)) {
    warnings.push('没有找到 scan(...)，插件不会产生可清理项')
  }

  return { ok: errors.length === 0, errors, warnings }
}
