/**
 * AI 插件工坊：v2 插件包「生成输出契约」+「安装前自检」（纯函数，可单测）。
 *
 * 为什么需要这一层：
 * - 模型输出直接进宿主安装事务，安装时才会做清单/文件/入口源码/client 校验；
 *   一旦不通过，用户拿到的是「能生成、装不上」的草稿。
 * - 这里在生成端复用与宿主**同一套共享校验器**（validatePluginManifest /
 *   checkPluginSource / isSafeRelativePath …）做安装前自检：
 *     · 能自动修的（缺清单字段、entry、inject、permissions.services、client 声明、
 *       文件路径分隔符）直接修，并记录可展示的修复说明；
 *     · 修不了的（危险 API、框架内部包 import、未声明依赖、bridge 协议错误、
 *       路径越界）作为**可读错误**回喂给模型重试。
 * - 只做数据变换，不读文件、不发请求；即使输入是任意 unknown 也不会抛异常。
 *
 * 注意：本模块的自检范围与宿主安装校验对齐（入口源码 + 清单 + 文件 + client），
 * 不额外放宽任何安全限制；宿主安装事务仍会独立再校验一次。
 */
import {
  PLUGIN_CLIENT_MODES,
  PLUGIN_KINDS,
  PLUGIN_SERVICES,
  checkPluginSource,
  isSafePluginFsRoot,
  isSafeRelativePath,
  isValidVersionRange,
  parseVersion,
  validatePluginDependencies,
  validatePluginManifest,
  type AiPluginDraft,
  type AiPluginFile,
  type PluginClientDeclaration,
  type PluginContributions,
  type PluginKind,
  type PluginManifest,
  type PluginService,
} from '@cordclean/shared'

/** 与宿主安装事务一致的文件/体积/依赖上限 */
const MAX_FILES = 50
const MAX_FILE_BYTES = 256 * 1024
const MAX_TOTAL_BYTES = 4 * 1024 * 1024
const MAX_DEPENDENCIES = 8

/** 宿主无法提供版本时的保守兼容范围（安装时会按当前宿主版本重新修正） */
const DEFAULT_ENGINE_RANGE = '>=0.6.0 <1.0.0'

/** 清单 contributes 允许的桶（与 v2 规范一致） */
const CONTRIBUTION_KEYS = ['tasks', 'overviewCards', 'pages', 'statusItems', 'commands'] as const
const CONTRIBUTION_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** 允许 import 的 Node 内置模块（与共享静态契约一致） */
const NODE_BUILTINS = new Set([
  'node:fs',
  'node:fs/promises',
  'node:path',
  'node:os',
  'node:url',
  'node:util',
  'node:crypto',
])

const KNOWN_SERVICES = new Set<string>(PLUGIN_SERVICES)
const KNOWN_KINDS = new Set<string>(PLUGIN_KINDS)

/**
 * 追加到工坊 system prompt 的 v2 包输出契约。
 * 与 PLUGIN_SYSTEM_PROMPT 互补：后者描述插件怎么写，这里强调「安装前校验会检查什么」。
 */
export const WORKSHOP_PACKAGE_CONTRACT = [
  '【工坊追加要求：输出必须能通过宿主安装前校验，否则会带错误自动重试】',
  '1. 必须调用 emit_plugin 输出完整 JSON：name（kebab-case）、kind、manifest、files、dependencies、notes；不要用 Markdown 围栏、不要输出解释文字。',
  '2. files 必填且必须包含入口文件 index.mjs（manifest.entry 必须指向 files 内的 .mjs/.js 文件，默认 index.mjs）；files 内不能出现 plugin.json；路径用 / 分隔，不能以 / 开头、不能含 .. 或反斜杠。',
  '3. manifest 必须齐全且字段合法：id（2-40 位小写字母/数字/连字符）、name（≤64 字符）、version（严格 semver，如 1.0.0）、apiVersion: 2、engines.cordclean（合法 semver range，如 ">=0.6.0 <1.0.0"）、kind（cleaner/widget/active/desktop/integration）、entry、permissions{services,network:false,subprocess:false}。',
  '4. permissions.services 只能列出插件真正 inject 的宿主服务（cleaner/ui/window/settings/system/pathPolicy/rules/evaluator/history/quarantine/compensate/executor/recycleBin/ai/aiContext/egress）；不要声明没 inject 的服务，也不要注入不存在的服务。',
  '5. inject 必须与 ctx 使用一致：用 ctx.cleaner 就 export const inject = ["cleaner"]；用 ctx.ui 就加 "ui"；禁止 if (ctx.xxx) 探测未声明的服务，禁止臆造宿主 API。',
  '6. 只允许 import node:fs、node:fs/promises、node:path、node:os、node:url、node:util、node:crypto，以及 dependencies 中声明的 npm 包；禁止 import @cordisjs/*、@cordclean/* 或未声明包，不要臆造包名。零依赖时 dependencies 输出 {}。',
  '7. 禁止 child_process、process.exit、fs.rm/rmSync/unlink/rmdir、直接删除文件、fetch/axios/XMLHttpRequest/任何网络请求、process.env 读取密钥、eval/new Function；删除一律交给内核（scan 只 emit 候选）。',
  '8. kind=cleaner 的插件必须在 apply 中用 ctx.effect(() => ctx.cleaner.define({...})) 注册任务，scan 只读取目录并 scan.emit({path, kind, size})。',
  '9. 需要独立页面时必须输出 client/index.html，并写 manifest.client = {"mode":"page","entry":"client/index.html"}；页面只能通过 {type:"cordclean/plugin-page",method:"resolve",id,resolverId,params} 取数、监听 cordclean/plugin-page-result 回包，禁止自定义字段；不需要页面时 client 写 {"mode":"declarative"}。',
  '10. 代码必须完整、括号配对、没有省略号占位；任何校验失败都会把具体错误原因回喂给你，请逐条修正后重新输出完整插件包。',
].join('\n')

/** 模型一次 emit_plugin 的原始输出（未知结构，内部做防御式归一化） */
export interface WorkshopDraftInput {
  name?: unknown
  code?: unknown
  files?: unknown
  manifest?: unknown
  dependencies?: unknown
  kind?: unknown
  notes?: unknown
}

/** 安装前自检结果：errors 非空表示不能交给用户安装 */
export interface WorkshopDraftPrep {
  /** 归一化 + 自动修复后的草稿（对齐宿主 install 期望的 AiPluginDraft 结构） */
  draft: AiPluginDraft
  /** 阻断性错误（已转成可读中文，用于反馈给模型重试/展示） */
  errors: string[]
  /** 提示（不阻断） */
  warnings: string[]
  /** 自动修复记录（供界面/日志展示） */
  repairs: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

function utf8Bytes(value: string): number {
  try {
    return new TextEncoder().encode(value).length
  } catch {
    return value.length
  }
}

function pushUnique(target: string[], message: string): void {
  if (!target.includes(message)) target.push(message)
}

/** 插件 id 规范化（与宿主安装端 normalizePluginId 行为一致） */
export function normalizeWorkshopPluginId(name: unknown): string {
  const raw = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const candidate = raw.length >= 2 ? raw : `ai-${raw || 'plugin'}`
  return /^(?=.{2,40}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(candidate) ? candidate : 'ai-plugin'
}

/* ------------------------------------------------------------------ */
/* 文件归一化                                                          */
/* ------------------------------------------------------------------ */

interface NormalizedFiles {
  files: AiPluginFile[]
  errors: string[]
  repairs: string[]
}

function normalizeDraftFiles(raw: unknown): NormalizedFiles {
  const errors: string[] = []
  const repairs: string[] = []
  const list: AiPluginFile[] = []
  const seen = new Set<string>()
  if (!Array.isArray(raw)) {
    return { files: list, errors, repairs }
  }
  for (const [index, item] of raw.slice(0, MAX_FILES * 2).entries()) {
    if (!isRecord(item)) {
      errors.push(`files 第 ${index + 1} 项不是 { path, content } 对象`)
      continue
    }
    const originalPath = textOf(item.path)
    let filePath = originalPath.replace(/\\/g, '/')
    if (filePath.startsWith('./')) filePath = filePath.slice(2)
    const content = typeof item.content === 'string' ? item.content : ''
    if (!filePath) {
      errors.push(`files 第 ${index + 1} 项缺少 path`)
      continue
    }
    if (filePath !== originalPath) repairs.push(`文件路径分隔符已规范化为 /：${filePath}`)
    if (filePath === 'plugin.json') {
      errors.push('files 不能包含 plugin.json（清单请放在 manifest 字段，由宿主生成）')
      continue
    }
    if (!isSafeRelativePath(filePath)) {
      errors.push(`非法文件路径：${originalPath || filePath}（必须是包内相对路径，用 / 分隔且不能越界）`)
      continue
    }
    if (!content.trim()) {
      errors.push(`文件内容为空：${filePath}`)
      continue
    }
    if (utf8Bytes(content) > MAX_FILE_BYTES) {
      errors.push(`文件过大（>${MAX_FILE_BYTES} 字节）：${filePath}`)
      continue
    }
    if (seen.has(filePath)) {
      repairs.push(`重复文件路径已合并（保留后一条）：${filePath}`)
      const existingIndex = list.findIndex((file) => file.path === filePath)
      if (existingIndex >= 0) list.splice(existingIndex, 1)
    }
    seen.add(filePath)
    list.push({ path: filePath, content })
    if (list.length >= MAX_FILES) {
      errors.push(`插件包文件数超过上限（${MAX_FILES}）`)
      break
    }
  }
  const totalBytes = list.reduce((sum, file) => sum + utf8Bytes(file.content), 0)
  if (totalBytes > MAX_TOTAL_BYTES) errors.push(`插件包总体积超过上限（${MAX_TOTAL_BYTES} 字节）`)
  return { files: list, errors, repairs }
}

/** 可作为入口的包内模块候选（client/ 下的资源不算入口） */
function isEntryCandidate(filePath: string): boolean {
  return /\.(mjs|js)$/i.test(filePath) && !filePath.startsWith('client/')
}

/**
 * 选出入口文件：
 * 1. 优先 index.mjs（与宿主合成清单的行为一致，避免 code 字段被重复包成第二个文件）；
 * 2. 其次 manifest.entry（必须是包内存在的 .mjs/.js）；
 * 3. 最后取第一个包内模块文件。
 */
function resolveEntryPath(files: AiPluginFile[], manifestEntry: string): string | undefined {
  if (files.some((file) => file.path === 'index.mjs')) return 'index.mjs'
  const declared = textOf(manifestEntry).replace(/\\/g, '/').replace(/^\.\//, '')
  if (isSafeRelativePath(declared) && declared && files.some((file) => file.path === declared) && isEntryCandidate(declared)) {
    return declared
  }
  return files.find((file) => isEntryCandidate(file.path))?.path
}

/* ------------------------------------------------------------------ */
/* inject / contributes 自动补全（与运行时的 Cordis 契约对齐）          */
/* ------------------------------------------------------------------ */

/** 从入口源码解析 export const inject 声明的服务 */
export function extractInjectServices(code: string): string[] {
  const matched = /export\s+const\s+inject\s*=\s*\[([^\]]*)\]/.exec(String(code ?? ''))
  if (!matched) return []
  const services: string[] = []
  for (const item of matched[1].matchAll(/['"]([^'"]+)['"]/g)) {
    if (KNOWN_SERVICES.has(item[1]) && !services.includes(item[1])) services.push(item[1])
  }
  return services
}

/** 从源码里扫描实际使用的 ctx.<service>（只关注已知宿主服务） */
function detectCtxServices(code: string): string[] {
  const used: string[] = []
  for (const match of String(code ?? '').matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) {
    const service = match[1]
    if (KNOWN_SERVICES.has(service) && !used.includes(service)) used.push(service)
  }
  return used
}

/** 按宿主服务声明顺序排序，输出稳定 */
function orderServices(services: readonly string[]): PluginService[] {
  const set = new Set(services.filter((service): service is PluginService => KNOWN_SERVICES.has(service)))
  return PLUGIN_SERVICES.filter((service) => set.has(service))
}

/**
 * 自动补全 `export const inject = [...]`：
 * 模型偶尔用了 ctx.cleaner 却忘记声明 inject，Cordis 运行时会直接抛错。
 * 返回修复后的源码与新增服务；无法安全插入时原样返回。
 */
export function repairInjectDeclarations(code: string): { code: string; added: string[] } {
  const source = String(code ?? '')
  const used = detectCtxServices(source)
  if (!used.length) return { code: source, added: [] }
  const injectMatch = /export\s+const\s+inject\s*=\s*\[([^\]]*)\]/.exec(source)
  const existing = injectMatch
    ? orderServices([...injectMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]))
    : []
  const merged = orderServices([...existing, ...used])
  const added = merged.filter((service) => !existing.includes(service))
  if (!added.length) return { code: source, added: [] }
  const declaration = 'export const inject = ' + JSON.stringify(merged) + ';'
  let fixed = source
  if (injectMatch) {
    fixed = source.replace(injectMatch[0], declaration)
  } else if (/export\s+function\s+apply\s*\(/.test(source)) {
    fixed = source.replace(/(export\s+function\s+apply\s*\()/, declaration + '\n\n$1')
  } else {
    return { code: source, added: [] }
  }
  return { code: fixed, added }
}

/** 规范化清单 contributes（丢弃非法 id/未知字段，避免清单校验直接失败） */
function sanitizeContributions(raw: unknown, repairs: string[]): PluginContributions | undefined {
  if (!isRecord(raw)) return undefined
  const parsed: PluginContributions = {}
  for (const key of CONTRIBUTION_KEYS) {
    const bucket = raw[key]
    if (bucket === undefined) continue
    if (!Array.isArray(bucket)) {
      repairs.push(`manifest.contributes.${key} 不是数组，已移除`)
      continue
    }
    const ids: string[] = []
    for (const item of bucket) {
      const id = textOf(item)
      if (!id || !CONTRIBUTION_ID_RE.test(id) || ids.includes(id)) continue
      ids.push(id)
    }
    if (ids.length !== bucket.length) repairs.push(`manifest.contributes.${key} 含非法/重复 id，已过滤`)
    if (ids.length) parsed[key] = ids.slice(0, 64)
  }
  for (const key of Object.keys(raw)) {
    if (!(CONTRIBUTION_KEYS as readonly string[]).includes(key)) repairs.push(`manifest.contributes 未知字段已移除：${key}`)
  }
  return Object.keys(parsed).length ? parsed : undefined
}

/** 从入口代码里的 `ctx.ui.command(插件名, "命令id", handler)` 调用提取命令 id */
export function extractCommandContributionIds(code: string): string[] {
  const ids: string[] = []
  for (const match of String(code ?? '').matchAll(
    /ctx\.ui\.command\(\s*[^,()]+?,\s*['"]([a-z0-9][a-z0-9-]{0,63})['"]/g,
  )) {
    if (!ids.includes(match[1])) ids.push(match[1])
  }
  return ids
}

/**
 * 模型有时注册了 `ctx.ui.command(...)` 却忘记 `export const contributes`；
 * 宿主运行时读取的是模块导出，缺了它插件页就没有手动按钮。
 * 这里只补 `commands` 这一个形状确定的 UI 贡献桶（{ id, title }），不伪造卡片/数据。
 */
export function repairCodeContributions(
  code: string,
  commandIds: readonly string[],
): { code: string; added: string[] } {
  const source = String(code ?? '')
  const ids = [...new Set(commandIds.filter((id) => CONTRIBUTION_ID_RE.test(id)))]
  if (!ids.length) return { code: source, added: [] }
  if (/export\s+const\s+contributes\s*=/.test(source)) return { code: source, added: [] }
  if (!/export\s+function\s+apply\s*\(/.test(source)) return { code: source, added: [] }
  const declaration = 'export const contributes = ' + JSON.stringify({ commands: ids.map((id) => ({ id, title: id })) }) + ';\n\n'
  return {
    code: source.replace(/(export\s+function\s+apply\s*\()/, declaration + '$1'),
    added: ids,
  }
}

/* ------------------------------------------------------------------ */
/* 依赖与清单构建                                                      */
/* ------------------------------------------------------------------ */

function normalizeDraftDependencies(raw: unknown, repairs: string[]): Record<string, string> {
  if (!isRecord(raw)) return {}
  const dependencies: Record<string, string> = {}
  for (const [name, version] of Object.entries(raw)) {
    const packageName = String(name).trim()
    const range = typeof version === 'string' ? version.trim() : ''
    if (!packageName || !range) {
      repairs.push(`依赖声明 ${packageName || '(空包名)'} 缺少版本，已移除`)
      continue
    }
    const issues = validatePluginDependencies({ [packageName]: range })
    if (issues.length) {
      repairs.push(`依赖声明已移除非法的 ${packageName}@${range}（${issues[0]}）`)
      continue
    }
    dependencies[packageName] = range
  }
  const names = Object.keys(dependencies)
  if (names.length > MAX_DEPENDENCIES) {
    for (const name of names.slice(MAX_DEPENDENCIES)) delete dependencies[name]
    repairs.push(`依赖超过 ${MAX_DEPENDENCIES} 个，已保留前 ${MAX_DEPENDENCIES} 个`)
  }
  return dependencies
}

function validSemver(value: string): boolean {
  return Boolean(parseVersion(value))
}

function buildManifest(options: {
  raw: Record<string, unknown> | undefined
  nameHint: unknown
  kindHint: unknown
  entry: string
  files: AiPluginFile[]
  inject: string[]
  dependencies: Record<string, string>
  repairs: string[]
}): PluginManifest {
  const { raw = {}, files, inject, dependencies, repairs } = options
  const rawId = textOf(raw.id)
  const id = normalizeWorkshopPluginId(rawId || textOf(options.nameHint) || 'ai-plugin')
  if (rawId !== id) repairs.push(`manifest.id 缺失或非法，已规范化为 ${id}`)

  const name = clip(textOf(raw.name) || id, 64)
  if (textOf(raw.name) !== name) repairs.push(`manifest.name 缺失或超长，已修正为 ${name}`)

  const rawVersion = textOf(raw.version)
  const version = validSemver(rawVersion) ? rawVersion : '1.0.0'
  if (rawVersion !== version) repairs.push(`manifest.version 不是合法 semver，已修正为 ${version}`)

  if (raw.apiVersion !== 2) repairs.push(`manifest.apiVersion 已修正为 2（当前 ${String(raw.apiVersion ?? '缺失')}）`)

  const engines = isRecord(raw.engines) ? raw.engines : {}
  const rawRange = textOf(engines.cordclean)
  const range = rawRange && isValidVersionRange(rawRange) ? rawRange : DEFAULT_ENGINE_RANGE
  if (rawRange !== range) repairs.push(`manifest.engines.cordclean 缺失或非法，已修正为 ${range}`)

  const kind: PluginKind = KNOWN_KINDS.has(textOf(raw.kind))
    ? (textOf(raw.kind) as PluginKind)
    : KNOWN_KINDS.has(textOf(options.kindHint))
      ? (textOf(options.kindHint) as PluginKind)
      : 'cleaner'
  if (textOf(raw.kind) !== kind) repairs.push(`manifest.kind 缺失或非法，已修正为 ${kind}`)

  if (textOf(raw.entry) !== options.entry) repairs.push(`manifest.entry 已修正为 ${options.entry}`)

  // client：以包内实际页面文件为准；声明 page 但没有页面时降级，避免安装校验失败
  const pageFile = files.find((file) => /^client\/.*\.(html|htm)$/i.test(file.path))
  const rawClient = isRecord(raw.client) ? raw.client : undefined
  const declaredMode = textOf(rawClient?.mode)
  let client: PluginClientDeclaration
  if (pageFile) {
    const declaredEntry = textOf(rawClient?.entry).replace(/\\/g, '/')
    if (declaredMode === 'page' && declaredEntry === pageFile.path) {
      client = { mode: 'page', entry: pageFile.path }
    } else {
      client = { mode: 'page', entry: pageFile.path }
      repairs.push(`检测到客户端页面，已把 manifest.client 修正为 page/entry=${pageFile.path}`)
    }
  } else if (declaredMode === 'page') {
    client = { mode: 'declarative' }
    repairs.push('manifest.client 声明了 page 但包内没有 client/*.html，已降级为 declarative')
  } else {
    const mode = (PLUGIN_CLIENT_MODES as readonly string[]).includes(declaredMode) && declaredMode !== 'page'
      ? (declaredMode as PluginClientDeclaration['mode'])
      : 'declarative'
    client = { mode }
    if (declaredMode !== mode) repairs.push(`manifest.client.mode 缺失或非法，已修正为 ${mode}`)
  }

  const rawConfigSchema = textOf(raw.configSchema)
  let configSchema: string | undefined
  if (rawConfigSchema) {
    const filePath = rawConfigSchema.replace(/\\/g, '/')
    if (isSafeRelativePath(filePath) && /\.json$/i.test(filePath) && files.some((file) => file.path === filePath)) {
      configSchema = filePath
    } else {
      repairs.push(`manifest.configSchema 指向不存在的文件，已移除：${rawConfigSchema}`)
    }
  }

  // permissions：按 inject + 清单声明合并；非法服务/目录/布尔值一律修正（宿主会拒绝非法值）
  const rawPermissions = isRecord(raw.permissions) ? raw.permissions : {}
  const rawServices = Array.isArray(rawPermissions.services) ? rawPermissions.services : []
  const declaredServices = rawServices.filter(
    (service): service is string => typeof service === 'string' && KNOWN_SERVICES.has(service),
  )
  if (rawServices.length !== declaredServices.length) repairs.push('permissions.services 含未知服务，已过滤')
  const services = orderServices([...declaredServices, ...inject])
  if (services.length !== declaredServices.length || declaredServices.some((service) => !services.includes(service as PluginService))) {
    repairs.push(`permissions.services 已按代码 inject 对齐：${services.join(', ') || '无'}`)
  }
  const rawRoots = Array.isArray(rawPermissions.fsRoots) ? rawPermissions.fsRoots : []
  const fsRoots = rawRoots
    .filter((root): root is string => isSafePluginFsRoot(root))
    .map((root) => root.trim())
    .slice(0, 20)
  if (fsRoots.length !== rawRoots.length) repairs.push('permissions.fsRoots 含非法目录，已过滤')
  const network = typeof rawPermissions.network === 'boolean' ? rawPermissions.network : false
  if (rawPermissions.network !== undefined && typeof rawPermissions.network !== 'boolean') {
    repairs.push('permissions.network 非布尔值，已修正为 false')
  }
  const subprocess = typeof rawPermissions.subprocess === 'boolean' ? rawPermissions.subprocess : false
  if (rawPermissions.subprocess !== undefined && typeof rawPermissions.subprocess !== 'boolean') {
    repairs.push('permissions.subprocess 非布尔值，已修正为 false')
  }

  const contributions = sanitizeContributions(raw.contributes, repairs)
  const description = clip(textOf(raw.description), 512)

  return {
    id,
    name,
    version,
    apiVersion: 2,
    engines: { cordclean: range },
    kind,
    entry: options.entry,
    client,
    ...(configSchema ? { configSchema } : {}),
    permissions: { services, fsRoots, network, subprocess },
    ...(contributions ? { contributes: contributions } : {}),
    ...(Object.keys(dependencies).length ? { dependencies } : {}),
    ...(description ? { description } : {}),
  }
}

/* ------------------------------------------------------------------ */
/* 客户端页面 bridge（与宿主安装校验同一套规则）                        */
/* ------------------------------------------------------------------ */

/** 页面 bridge 协议检查：与 packages/host 的 inspectClientPageBridge 规则一致 */
export function inspectClientPageBridge(html: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  const source = String(html ?? '')
  const usesBridge = /cordclean\/plugin-page|postMessage/.test(source)
  if (!usesBridge) {
    warnings.push('client 页面未使用宿主 bridge；如果页面需要数据，将无法取得宿主数据')
    return { errors, warnings }
  }
  const hasType = /cordclean\/plugin-page['"]/.test(source)
  const hasMethod = /method\s*:\s*['"]resolve['"]/.test(source)
  const hasResolver = /resolverId/.test(source)
  if (!hasType || !hasMethod || !hasResolver) {
    errors.push(
      'client 页面 bridge 协议不匹配：必须发送 {type:"cordclean/plugin-page", method:"resolve", id, resolverId, params}，不要使用 action/key/dataId/requestId/channel/source 等字段',
    )
  }
  if (!/cordclean\/plugin-page-result/.test(source)) {
    warnings.push('client 页面未监听 cordclean/plugin-page-result，可能收不到数据')
  }
  return { errors, warnings }
}

/* ------------------------------------------------------------------ */
/* 安装前自检主流程                                                    */
/* ------------------------------------------------------------------ */

/**
 * 把模型输出归一化成「可直接交给宿主 ai/plugin/install 的 v2 草稿」：
 * 自动补齐/修正清单与 inject，并用共享静态契约检查入口源码与页面 bridge。
 *
 * 返回 errors 为空时，调用方可以安全地把 draft 交给用户审阅/安装
 * （宿主安装事务仍会独立再校验一次，这里只是把失败提前到生成阶段）。
 */
export function prepareWorkshopDraft(input: WorkshopDraftInput): WorkshopDraftPrep {
  const errors: string[] = []
  const warnings: string[] = []
  const repairs: string[] = []
  const rawManifest = isRecord(input.manifest) ? input.manifest : undefined

  // 1) 依赖归一化：工具顶层 dependencies 优先；模型只写在 manifest.dependencies 时也能识别
  const inputDependencies = isRecord(input.dependencies) ? input.dependencies : undefined
  const manifestDependencies = isRecord(rawManifest?.dependencies) ? rawManifest.dependencies : undefined
  const dependencies = normalizeDraftDependencies(
    inputDependencies && Object.keys(inputDependencies).length ? inputDependencies : manifestDependencies,
    repairs,
  )

  // 2) 文件归一化；单文件 code 自动包装为 index.mjs
  const normalized = normalizeDraftFiles(input.files)
  errors.push(...normalized.errors)
  repairs.push(...normalized.repairs)
  let files = normalized.files
  const fallbackCode = textOf(input.code)
  if (!files.length && fallbackCode) {
    files = [{ path: 'index.mjs', content: fallbackCode }]
    repairs.push('单文件代码已包装为插件包入口 files/index.mjs')
  }

  // 3) 入口解析；缺入口但给了 code 时用 manifest.entry/index.mjs 补齐
  const declaredEntry = textOf(rawManifest?.entry).replace(/\\/g, '/').replace(/^\.\//, '')
  let entry = resolveEntryPath(files, declaredEntry)
  if (!entry && fallbackCode) {
    const candidate = isSafeRelativePath(declaredEntry) && isEntryCandidate(declaredEntry) ? declaredEntry : 'index.mjs'
    files = [{ path: candidate, content: fallbackCode }, ...files]
    entry = candidate
    repairs.push(`入口文件缺失，已用生成的代码补齐 ${candidate}`)
  }
  if (!entry) {
    errors.push('插件包缺少入口文件：请提供 index.mjs（或 manifest.entry 指向的 .mjs/.js 文件）')
    entry = 'index.mjs'
  }

  // 4) inject 自动补全（只改入口，helper 相对 import 由宿主放行）
  const entryIndex = files.findIndex((file) => file.path === entry)
  if (entryIndex >= 0) {
    const repairedInject = repairInjectDeclarations(files[entryIndex].content)
    if (repairedInject.added.length) {
      files[entryIndex] = { path: entry, content: repairedInject.code }
      repairs.push(`已自动补全 inject：${repairedInject.added.join(', ')}`)
    }
  }
  const entrySource = files[entryIndex]?.content ?? ''
  const inject = extractInjectServices(entrySource)
  // 清单/manifest 缺失时，kind 从代码的 export const kind 兜底（模型常常只在代码里写）
  const codeKind = /export\s+const\s+kind\s*=\s*['"]([a-zA-Z-]+)['"]/.exec(entrySource)?.[1]

  // 5) 清单（先做基础清单，contributes 补进代码后再定稿）
  let manifest = buildManifest({
    raw: rawManifest,
    nameHint: input.name ?? rawManifest?.id,
    kindHint: input.kind ?? codeKind ?? rawManifest?.kind,
    entry,
    files,
    inject,
    dependencies,
    repairs,
  })
  // 6) UI 贡献自动补全：代码注册了 ctx.ui.command 或清单声明了 commands 但忘了模块导出 contributes
  if (entryIndex >= 0 && !/export\s+const\s+contributes\s*=/.test(entrySource)) {
    const manifestCommands = Array.isArray(manifest.contributes?.commands) ? manifest.contributes!.commands! : []
    const commandIds = [...new Set([...extractCommandContributionIds(entrySource), ...manifestCommands])]
    const repairedContrib = repairCodeContributions(entrySource, commandIds)
    if (repairedContrib.added.length) {
      files[entryIndex] = { path: entry, content: repairedContrib.code }
      manifest.contributes = { ...(manifest.contributes ?? {}), commands: commandIds }
      repairs.push(`已自动补全 UI 贡献 contributes.commands：${repairedContrib.added.join(', ')}`)
    }
  }
  const entryContent = files[entryIndex]?.content ?? ''

  // 7) 清单契约校验（与宿主安装同一校验器）
  const manifestValidation = validatePluginManifest(manifest)
  for (const issue of manifestValidation.errors) errors.push(`清单校验失败：${issue.message}`)
  for (const issue of manifestValidation.warnings) pushUnique(warnings, issue.message)
  if (manifestValidation.manifest) manifest = manifestValidation.manifest

  // 8) 入口源码静态契约（与宿主安装同一校验器；v2 包允许包内相对 import）
  if (!entryContent.trim()) {
    errors.push(`入口文件内容为空：${entry}`)
  } else {
    const check = checkPluginSource(entryContent, {
      dependencies,
      mode: 'native',
      allowRelativeImports: true,
    })
    for (const message of check.errors) errors.push(`入口源码：${message}`)
    for (const message of check.warnings) pushUnique(warnings, message)
  }

  // 9) 客户端页面：文件存在 + bridge 协议（宿主安装会硬校验）
  if (manifest.client?.mode === 'page' && manifest.client.entry) {
    const pagePath = manifest.client.entry
    const page = files.find((file) => file.path === pagePath)
    if (!page) {
      errors.push(`缺少客户端页面：${pagePath}`)
    } else if (!pagePath.startsWith('client/')) {
      errors.push('客户端页面必须在 client/ 目录下')
    } else {
      const bridge = inspectClientPageBridge(page.content)
      errors.push(...bridge.errors)
      for (const message of bridge.warnings) pushUnique(warnings, message)
    }
  }

  // 10) 声明了但用不到的依赖只提示（不阻断安装，宿主的 worker 同样如此）
  if (Object.keys(dependencies).length) {
    const importUsage = entryContent.match(/^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm) ?? []
    for (const dep of Object.keys(dependencies)) {
      const used = importUsage.some((line) => line.includes(`'${dep}`) || line.includes(`"${dep}`))
      if (!used) pushUnique(warnings, `依赖 ${dep} 已声明但入口代码没有 import，安装后可能用不到`)
    }
  }
  for (const file of files) {
    if (/^client\//.test(file.path) || !/\.(mjs|js)$/i.test(file.path)) continue
    if (file.path === entry) continue
    // helper 模块不要求 apply/name，但禁止直接使用危险能力（与入口同一条底线）
    if (/\bchild_process\b|\bprocess\.exit\b|\bfetch\s*\(|\brequire\s*\(/.test(file.content)) {
      pushUnique(warnings, `辅助文件 ${file.path} 出现敏感 API，请确认不违反插件安全契约`)
    }
    for (const specifier of file.content.matchAll(/import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g)) {
      const target = specifier[1]
      if (!target || target.startsWith('.')) continue
      if (NODE_BUILTINS.has(target)) continue
      if (target.startsWith('@cordisjs/') || target.startsWith('@cordclean/')) {
        errors.push(`文件 ${file.path} 不能 import "${target}"：外部插件不能依赖框架内部包`)
        continue
      }
      const packageName = target.startsWith('@') ? target.split('/').slice(0, 2).join('/') : target.split('/')[0]
      if (!Object.prototype.hasOwnProperty.call(dependencies, packageName)) {
        errors.push(`文件 ${file.path} import "${target}" 未在 dependencies 中声明`)
      }
    }
  }

  const notes = [textOf(input.notes), repairs.length ? `[已自动修复] ${repairs.join('；')}` : '']
    .filter(Boolean)
    .join('\n')
    .slice(0, 2_000)

  const draft: AiPluginDraft = {
    name: manifest.id,
    code: entryContent,
    notes,
    dependencies,
    mode: 'native',
    kind: manifest.kind,
    format: 'package',
    manifest,
    files,
  }
  return { draft, errors, warnings, repairs }
}
