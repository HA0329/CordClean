/**
 * AI 工坊 → v2 插件包。
 *
 * 模型可以只给单文件代码（历史行为），也可以额外给 `manifest` + `files`（多文件）。
 * 本模块负责把两种形态都归一成「可安装的 v2 插件包」：
 *   - 合成/校验 plugin.json
 *   - 检查文件清单（路径安全、体积/数量上限、入口与客户端页面存在）
 *   - 入口源码静态契约 + 依赖约束（v2 包当前要求零第三方依赖）
 * 落盘后的安装复用 `PluginManager.installPackage()`（staging → commit → 登记 → 启用）。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  checkPluginSource,
  isSafePluginFsRoot,
  isSafeRelativePath,
  validatePluginManifest,
  type AiPluginDraft,
  type AiPluginFile,
  type PluginKind,
  type PluginManifest,
} from '@cordclean/shared'

const KNOWN_KINDS: readonly PluginKind[] = ['cleaner', 'widget', 'active', 'desktop', 'integration']
const MAX_FILES = 50
const MAX_FILE_BYTES = 256 * 1024
const MAX_TOTAL_BYTES = 4 * 1024 * 1024
const PLUGIN_ID_RE = /^(?=.{2,40}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

const KNOWN_PERMISSION_SERVICES = new Set([
  'ui', 'cleaner', 'window', 'settings', 'system', 'pathPolicy', 'rules', 'evaluator',
  'history', 'quarantine', 'compensate', 'executor', 'recycleBin', 'ai', 'aiContext', 'egress',
])

export interface AiPackageValidation {
  ok: boolean
  errors: string[]
  warnings: string[]
  manifest?: PluginManifest
  /** 相对路径 → 内容（不含 plugin.json） */
  files?: Record<string, string>
}

/** 把插件名/草稿名变成合法清单 id */
export function normalizePluginId(name: unknown): string {
  const raw = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const candidate = raw.length >= 2 ? raw : `ai-${raw || 'plugin'}`
  return PLUGIN_ID_RE.test(candidate) ? candidate : 'ai-plugin'
}

/** 从代码的 export const inject 粗略提取宿主服务（仅用于清单展示，运行时以代码为准） */
export function extractInjectServices(code: string): string[] {
  const match = /export\s+const\s+inject\s*=\s*\[([^\]]*)\]/.exec(code)
  if (!match) return []
  const found: string[] = []
  for (const item of match[1].matchAll(/['"]([a-zA-Z][\w]*)['"]/g)) {
    if (item[1] && !found.includes(item[1])) found.push(item[1])
  }
  return found
}

function kindOf(draft: AiPluginDraft): PluginKind {
  return KNOWN_KINDS.includes(draft.kind as PluginKind) ? (draft.kind as PluginKind) : 'cleaner'
}

function collectFiles(draft: AiPluginDraft): Record<string, string> {
  const files: Record<string, string> = {}
  for (const file of draft.files ?? []) {
    files[file.path] = file.content
  }
  // 单文件草稿：入口内容就是 code
  if (!files['index.mjs'] && draft.code) files['index.mjs'] = draft.code
  return files
}

/** 由单文件/多文件草稿合成 v2 清单（模型没给 manifest 时使用） */
export function synthesizePluginManifest(
  draft: AiPluginDraft,
  appVersion: string,
  files: Record<string, string> = collectFiles(draft),
): PluginManifest {
  const id = normalizePluginId(draft.name)
  const entry = files['index.mjs'] ? 'index.mjs' : (Object.keys(files)[0] ?? 'index.mjs')
  const entryCode = files[entry] ?? draft.code ?? ''
  const injectServices = extractInjectServices(entryCode)
  const services = injectServices.filter((service) =>
    ['ui', 'cleaner', 'window', 'settings', 'system', 'pathPolicy', 'rules', 'evaluator', 'history', 'quarantine', 'compensate', 'executor', 'recycleBin', 'ai', 'aiContext', 'egress'].includes(service),
  )
  const hasClientPage = Boolean(files['client/index.html'])
  return {
    id,
    name: String(draft.name || id).slice(0, 64),
    version: '1.0.0',
    description: 'AI 工坊生成的插件包',
    apiVersion: 2,
    engines: { cordclean: `^${appVersion}` },
    kind: kindOf(draft),
    entry,
    ...(hasClientPage
      ? { client: { mode: 'page' as const, entry: 'client/index.html' } }
      : { client: { mode: 'declarative' as const } }),
    permissions: {
      services: services as PluginManifest['permissions']['services'],
      fsRoots: [],
      network: false,
      subprocess: false,
    },
    dependencies: { ...(draft.dependencies ?? {}) },
  }
}

/** 校验草稿 → 可安装的 v2 插件包（不落盘） */
export async function validateAiPluginPackage(
  draft: AiPluginDraft,
  appVersion: string,
): Promise<AiPackageValidation> {
  const errors: string[] = []
  const warnings: string[] = []
  const files = collectFiles(draft)

  const entries = Object.entries(files)
  if (entries.length === 0) errors.push('插件包没有任何文件')
  if (entries.length > MAX_FILES) errors.push(`插件包文件数超过上限（${MAX_FILES}）`)
  let totalBytes = 0
  for (const [filePath, content] of entries) {
    if (filePath === 'plugin.json') {
      errors.push('files 不能包含 plugin.json（清单由宿主生成或使用 manifest 字段）')
      continue
    }
    if (!isSafeRelativePath(filePath)) errors.push(`非法文件路径：${filePath}`)
    const bytes = Buffer.byteLength(content, 'utf8')
    totalBytes += bytes
    if (bytes > MAX_FILE_BYTES) errors.push(`文件过大（>${MAX_FILE_BYTES} 字节）：${filePath}`)
  }
  if (totalBytes > MAX_TOTAL_BYTES) errors.push(`插件包总体积超过上限（${MAX_TOTAL_BYTES} 字节）`)

  let rawManifest = draft.manifest ?? synthesizePluginManifest(draft, appVersion, files)
  if (draft.manifest) {
    // AI 生成包面向当前应用，且模型清单字段经常不完整：
    // 统一补齐 id/name/version/entry/kind/permissions，修正 engines，丢弃不可信的 contributes。
    const expectedEngine = `^${appVersion}`
    const repaired: Record<string, any> = { ...draft.manifest }
    repaired.id = typeof repaired.id === 'string' && repaired.id.trim() ? repaired.id.trim() : normalizePluginId(draft.name)
    repaired.name = typeof repaired.name === 'string' && repaired.name.trim() ? repaired.name.trim() : String(draft.name || repaired.id)
    repaired.version = typeof repaired.version === 'string' && repaired.version.trim() ? repaired.version.trim() : '1.0.0'
    repaired.description = typeof repaired.description === 'string' && repaired.description.trim() ? repaired.description : 'AI 工坊生成的插件包'
    repaired.apiVersion = 2
    repaired.engines = { cordclean: expectedEngine }
    repaired.kind = repaired.kind ?? draft.kind ?? 'cleaner'
    repaired.entry =
      typeof repaired.entry === 'string' && repaired.entry.trim()
        ? repaired.entry
        : files['index.mjs']
          ? 'index.mjs'
          : Object.keys(files)[0] ?? 'index.mjs'
    if (!repaired.permissions || typeof repaired.permissions !== 'object') {
      repaired.permissions = { services: [], fsRoots: [], network: false, subprocess: false }
    }
    const permissions = repaired.permissions as Record<string, any>
    permissions.services = Array.isArray(permissions.services)
      ? permissions.services.filter(
          (service: unknown) => typeof service === 'string' && KNOWN_PERMISSION_SERVICES.has(service),
        )
      : []
    permissions.fsRoots = Array.isArray(permissions.fsRoots)
      ? permissions.fsRoots.filter((root: unknown) => isSafePluginFsRoot(root))
      : []
    permissions.network = permissions.network === true
    permissions.subprocess = permissions.subprocess === true
    const clientValue = repaired.client
    if (
      clientValue !== undefined &&
      (clientValue === null ||
        typeof clientValue !== 'object' ||
        Array.isArray(clientValue) ||
        !['declarative', 'page'].includes(String((clientValue as any).mode ?? '')))
    ) {
      repaired.client = files['client/index.html']
        ? { mode: 'page', entry: 'client/index.html' }
        : { mode: 'declarative' }
      warnings.push('已修正清单 client 字段')
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(String(repaired.id))) {
      repaired.id = normalizePluginId(draft.name)
      warnings.push('已修正清单 id')
    }
    if (files['client/index.html'] && !repaired.client) {
      repaired.client = { mode: 'page', entry: 'client/index.html' }
    }
    if (Object.keys(draft.dependencies ?? {}).length) repaired.dependencies = draft.dependencies
    delete repaired.contributes
    rawManifest = repaired as typeof rawManifest
    warnings.push(`已自动补齐 AI 清单必需字段（id/name/version/entry/engines 等）`)
  }
  const manifestValidation = validatePluginManifest(rawManifest)
  if (!manifestValidation.ok) {
    for (const issue of manifestValidation.errors) errors.push(`清单校验失败：${issue.message}`)
  }
  warnings.push(...manifestValidation.warnings.map((issue) => issue.message))
  const manifest = manifestValidation.manifest
  const declaredDependencies = manifest?.dependencies ?? draft.dependencies ?? {}

  if (manifest) {
    const entryContent = files[manifest.entry]
    if (!entryContent) {
      errors.push(`缺少入口文件：${manifest.entry}`)
    } else {
      const check = checkPluginSource(entryContent, {
        mode: 'native',
        allowRelativeImports: true,
        dependencies: declaredDependencies,
      })
      for (const message of check.errors) errors.push(`入口源码：${message}`)
      warnings.push(...check.warnings)
    }
    if (manifest.client?.mode === 'page' && manifest.client.entry) {
      if (!files[manifest.client.entry]) errors.push(`缺少客户端页面：${manifest.client.entry}`)
      else if (!manifest.client.entry.startsWith('client/')) errors.push('客户端页面必须在 client/ 目录下')
    }
    if (manifest.configSchema && !files[manifest.configSchema]) {
      errors.push(`缺少配置 schema：${manifest.configSchema}`)
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    ...(manifest ? { manifest } : {}),
    ...(errors.length === 0 ? { files } : {}),
  }
}

/** 把校验通过的插件包写到目录（调用方负责临时目录与清理） */
export async function writeAiPluginPackage(
  targetDir: string,
  validation: AiPackageValidation,
): Promise<void> {
  if (!validation.manifest || !validation.files) throw new Error('插件包尚未通过校验，不能落盘')
  await mkdir(targetDir, { recursive: true })
  await writeFile(path.join(targetDir, 'plugin.json'), JSON.stringify(validation.manifest, null, 2) + '\n', 'utf8')
  for (const [filePath, content] of Object.entries(validation.files)) {
    const target = path.resolve(targetDir, filePath)
    const root = path.resolve(targetDir)
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`插件包文件路径越界：${filePath}`)
    }
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
}

/** 供 RPC 层复用的草稿规范化（保持向后兼容的字段） */
export function validateDraftPackageFiles(files: AiPluginFile[] | undefined): string[] {
  const errors: string[] = []
  for (const file of files ?? []) {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') {
      errors.push('files 项必须是 { path, content }')
    }
  }
  return errors
}
