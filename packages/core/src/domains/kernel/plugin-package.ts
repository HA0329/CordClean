/**
 * v2 插件包扫描与装载（清单读取）。
 *
 * 与 `PluginManagerService` 的分工：
 * - 本文件只做「发现 + 读取 + 校验 + 路径安全检查」，不启动插件、不写设置；
 * - 安装事务（staging / 原子落盘 / 回滚）与启停仍由 PluginManager 负责（下一步接入）；
 * - 旧版单文件插件（`<dataDir>/generated-plugins/*.mjs` 或 `plugins/*.mjs`）
 *   作为 legacy 候选返回，由安装/管理流程合成 apiVersion=1 清单后统一处理。
 */
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import {
  PLUGIN_MANIFEST_FILE,
  PLUGIN_API_VERSION,
  checkPluginManifestCompatibility,
  parsePluginManifest,
  validatePluginManifest,
  type PluginManifest,
  type PluginManifestIssue,
  type PluginManifestValidation,
} from '@cordclean/shared'

/** 插件包目录名（相对 dataDir） */
export const PLUGIN_PACKAGES_DIR = 'plugins'
/** 安装事务的暂存目录名（扫描时忽略） */
export const PLUGIN_STAGING_DIR = '.staging'

const MAX_MANIFEST_BYTES = 256 * 1024

export interface ScannedPluginPackage {
  /** 包目录绝对路径 */
  dir: string
  manifestPath: string
  manifest: PluginManifest
  /** 入口模块绝对路径 */
  entryPath: string
  /** 客户端页面绝对路径（client.mode=page 时存在） */
  clientEntryPath?: string
  /** 配置 schema 绝对路径 */
  configSchemaPath?: string
}

export interface LegacyPluginCandidate {
  /** 旧版单文件插件绝对路径 */
  file: string
  /** 由文件名推导的候选 id（真实 name 以模块导出为准） */
  name: string
}

export interface PluginPackageProblem {
  /** 出问题的包目录或文件 */
  target: string
  errors: PluginManifestIssue[]
  warnings: PluginManifestIssue[]
}

export interface PluginPackageScan {
  pluginsDir: string
  packages: ScannedPluginPackage[]
  legacy: LegacyPluginCandidate[]
  problems: PluginPackageProblem[]
  warnings: PluginManifestIssue[]
}

export interface PluginPackageScanOptions {
  /** 宿主版本；传入时对每个包做 engines/apiVersion 兼容检查 */
  appVersion?: string
  /** 宿主支持的插件 API 版本，默认 {@link PLUGIN_API_VERSION} */
  apiVersion?: number
}

function issue(code: string, message: string): PluginManifestIssue {
  return { code, message }
}

async function readManifestFile(manifestPath: string): Promise<{ text?: string; error?: PluginManifestIssue }> {
  try {
    const info = await stat(manifestPath)
    if (!info.isFile()) return { error: issue('manifest-not-file', `${PLUGIN_MANIFEST_FILE} 不是文件`) }
    if (info.size > MAX_MANIFEST_BYTES) {
      return { error: issue('manifest-too-large', `${PLUGIN_MANIFEST_FILE} 超过 ${MAX_MANIFEST_BYTES} 字节上限`) }
    }
    return { text: await readFile(manifestPath, 'utf8') }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { error: issue('missing-manifest', `缺少 ${PLUGIN_MANIFEST_FILE}`) }
    return { error: issue('manifest-unreadable', `无法读取 ${PLUGIN_MANIFEST_FILE}：${(error as Error).message}`) }
  }
}

/** 把清单里的相对路径解析成包内绝对路径，并做 realpath 越界检查 */
export async function resolvePackageFile(
  packageDir: string,
  relative: string,
): Promise<{ path?: string; error?: PluginManifestIssue }> {
  const packageReal = await realpath(packageDir)
  const candidate = path.resolve(packageReal, relative)
  const prefix = packageReal.endsWith(path.sep) ? packageReal : packageReal + path.sep
  if (candidate !== packageReal && !candidate.startsWith(prefix)) {
    return { error: issue('path-escape', `路径越出插件包目录：${relative}`) }
  }
  let real: string
  try {
    real = await realpath(candidate)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return {
      error: issue('missing-file', `清单声明的文件不存在：${relative}${code === 'ENOENT' ? '' : '（' + (error as Error).message + '）'}`),
    }
  }
  if (real !== packageReal && !real.startsWith(prefix)) {
    return { error: issue('path-escape', `路径经符号链接越出插件包目录：${relative}`) }
  }
  const info = await stat(real)
  if (!info.isFile()) return { error: issue('not-a-file', `清单声明的路径不是文件：${relative}`) }
  return { path: real }
}

async function inspectPackageDir(
  dir: string,
  options: PluginPackageScanOptions,
  seenIds: Map<string, string>,
  scan: PluginPackageScan,
  dirName: string,
): Promise<void> {
  const manifestPath = path.join(dir, PLUGIN_MANIFEST_FILE)
  const loaded = await readManifestFile(manifestPath)
  if (!loaded.text) {
    scan.problems.push({ target: dir, errors: [loaded.error!], warnings: [] })
    return
  }

  const validation: PluginManifestValidation = parsePluginManifest(loaded.text)
  const errors = [...validation.errors]
  const warnings = [...validation.warnings]

  if (options.appVersion && validation.manifest) {
    const compatibility = checkPluginManifestCompatibility(validation.manifest, {
      appVersion: options.appVersion,
      apiVersion: options.apiVersion ?? PLUGIN_API_VERSION,
    })
    errors.push(...compatibility.errors)
    warnings.push(...compatibility.warnings)
  }

  const manifest = validation.manifest
  if (!manifest || errors.length > 0) {
    scan.problems.push({ target: dir, errors, warnings })
    return
  }

  if (manifest.id !== dirName) {
    warnings.push(issue('id-directory-mismatch', `id（${manifest.id}）与目录名（${dirName}）不一致；建议保持一致便于管理`))
  }

  const seen = seenIds.get(manifest.id)
  if (seen) {
    scan.problems.push({
      target: dir,
      errors: [issue('duplicate-id', `插件 id 重复：${manifest.id}（已存在：${seen}）`)],
      warnings,
    })
    return
  }

  const entry = await resolvePackageFile(dir, manifest.entry)
  if (!entry.path) {
    errors.push(entry.error!)
  }

  let clientEntryPath: string | undefined
  if (manifest.client?.mode === 'page' && manifest.client.entry) {
    const client = await resolvePackageFile(dir, manifest.client.entry)
    if (!client.path) errors.push(client.error!)
    else clientEntryPath = client.path
  }

  let configSchemaPath: string | undefined
  if (manifest.configSchema) {
    const schema = await resolvePackageFile(dir, manifest.configSchema)
    if (!schema.path) errors.push(schema.error!)
    else configSchemaPath = schema.path
  }

  if (errors.length > 0 || !entry.path) {
    scan.problems.push({ target: dir, errors, warnings })
    return
  }

  seenIds.set(manifest.id, dir)
  scan.packages.push({
    dir,
    manifestPath,
    manifest,
    entryPath: entry.path,
    clientEntryPath,
    configSchemaPath,
  })
  scan.warnings.push(...warnings)
}

/**
 * 扫描插件包目录。
 *
 * - 目录不存在时返回空结果（首次启动/未安装任何插件是正常状态）；
 * - 子目录必须含合法 `plugin.json`，否则记为 problem；
 * - 顶层 `.mjs/.js` 文件记为 legacy 候选（旧版单文件插件）；
 * - 所有清单路径都做「包内 realpath 包含」检查，防止符号链接越界。
 */
export async function scanPluginPackages(
  pluginsDir: string,
  options: PluginPackageScanOptions = {},
): Promise<PluginPackageScan> {
  const root = path.resolve(pluginsDir)
  const scan: PluginPackageScan = { pluginsDir: root, packages: [], legacy: [], problems: [], warnings: [] }

  let entries: Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return scan
    scan.problems.push({
      target: root,
      errors: [issue('plugins-dir-unreadable', `无法读取插件目录：${(error as Error).message}`)],
      warnings: [],
    })
    return scan
  }

  entries.sort((left, right) => left.name.localeCompare(right.name))
  const seenIds = new Map<string, string>()

  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.name.startsWith('.')) continue
    if (entry.name === 'node_modules') continue

    if (entry.isDirectory()) {
      await inspectPackageDir(full, options, seenIds, scan, entry.name)
      continue
    }

    if (entry.isFile() && /\.(mjs|js)$/i.test(entry.name)) {
      scan.legacy.push({
        file: full,
        name: path.basename(entry.name, path.extname(entry.name)),
      })
    }
  }

  return scan
}

/** 单独读取并校验一个包目录的清单（安装/启用复查用） */
export async function readPluginManifest(
  packageDir: string,
): Promise<{ manifestPath: string; validation: PluginManifestValidation; text?: string }> {
  const manifestPath = path.join(packageDir, PLUGIN_MANIFEST_FILE)
  const loaded = await readManifestFile(manifestPath)
  if (!loaded.text) {
    return {
      manifestPath,
      validation: { ok: false, errors: [loaded.error!], warnings: [] },
    }
  }
  return { manifestPath, validation: parsePluginManifest(loaded.text), text: loaded.text }
}

/** 便捷入口：校验一份清单对象（供 RPC/AI 工坊在落盘前使用） */
export async function validatePluginManifestObject(
  input: unknown,
): Promise<PluginManifestValidation> {
  return validatePluginManifest(input)
}

/* ------------------------------------------------------------------ */
/* v2 插件包客户端资源（client.mode=page）                              */
/* ------------------------------------------------------------------ */

/** 客户端资源 MIME（自定义协议 / HTTP 静态路由共用） */
export const PLUGIN_CLIENT_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

/** client.entry 相对 `client/` 目录的路径（例如 client/index.html → index.html） */
export function pluginClientEntryRelative(manifest: PluginManifest): string | undefined {
  if (manifest.client?.mode !== 'page' || !manifest.client.entry) return undefined
  const entry = manifest.client.entry
  if (!entry.startsWith('client/')) return undefined
  return entry.slice('client/'.length)
}

/** 客户端页面/资源的 CSP：默认禁止外联，清单声明 network 才放开 */
export function pluginClientCsp(network: boolean): string {
  const connect = network ? 'http: https: ws: wss:' : "'none'"
  return [
    "default-src 'self' data: blob:",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src ${connect}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
}

export interface PluginClientAsset {
  /** 磁盘上的绝对路径（已 realpath 校验在 client/ 内） */
  file: string
  contentType: string
  csp: string
  network: boolean
  pluginId: string
}

export interface PluginClientAssetError {
  status: number
  message: string
}

export interface ResolvePluginClientAssetOptions {
  /** 用户数据目录（内部会拼 plugins/<id>） */
  dataDir: string
  /** 清单里的插件 id（也是包目录名） */
  pluginId: string
  /** 相对 `client/` 的请求路径；空则回退到 client.entry */
  requestPath?: string
}

/**
 * 把自定义协议 / HTTP 路由的请求路径解析为插件包 `client/` 下的真实文件。
 *
 * 安全检查：id 合法 → 读清单确认 `client.mode=page` → 解码路径 → 拒绝 `..`/反斜杠/控制字符
 * → realpath 必须仍在 `client/` 内（防符号链接越界）→ 必须是文件。
 */
export async function resolvePluginClientAsset(
  options: ResolvePluginClientAssetOptions,
): Promise<{ asset?: PluginClientAsset; error?: PluginClientAssetError }> {
  if (!/^(?=.{2,40}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(String(options.pluginId ?? ''))) {
    return { error: { status: 400, message: '非法插件 id' } }
  }
  const packageDir = path.join(path.resolve(options.dataDir), 'plugins', options.pluginId)
  const read = await readPluginManifest(packageDir)
  if (!read.validation.ok || !read.validation.manifest) {
    return { error: { status: 404, message: '插件包不存在或清单无效' } }
  }
  const manifest = read.validation.manifest
  if (manifest.client?.mode !== 'page') {
    return { error: { status: 404, message: '该插件没有客户端页面' } }
  }

  const clientDir = path.join(packageDir, 'client')
  let realClientDir: string
  try {
    realClientDir = await realpath(clientDir)
  } catch {
    return { error: { status: 404, message: '客户端目录不存在' } }
  }

  let relative = String(options.requestPath ?? '').replace(/^[/\\]+/, '')
  if (!relative) relative = pluginClientEntryRelative(manifest) ?? 'index.html'
  let decoded: string
  try {
    decoded = decodeURIComponent(relative)
  } catch {
    return { error: { status: 400, message: '路径编码不合法' } }
  }
  if (
    !decoded ||
    decoded.includes('\\') ||
    /[\u0000-\u001f]/.test(decoded) ||
    decoded.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    return { error: { status: 403, message: '路径不安全' } }
  }

  const prefix = realClientDir.endsWith(path.sep) ? realClientDir : realClientDir + path.sep
  const candidate = path.resolve(realClientDir, decoded)
  if (candidate !== realClientDir && !candidate.startsWith(prefix)) {
    return { error: { status: 403, message: '路径越界' } }
  }
  let real: string
  try {
    real = await realpath(candidate)
  } catch {
    return { error: { status: 404, message: '资源不存在' } }
  }
  if (real !== realClientDir && !real.startsWith(prefix)) {
    return { error: { status: 403, message: '路径越界' } }
  }
  const info = await stat(real)
  if (!info.isFile()) return { error: { status: 404, message: '资源不存在' } }

  const network = manifest.permissions.network === true
  return {
    asset: {
      file: real,
      contentType: PLUGIN_CLIENT_MIME[path.extname(real).toLowerCase()] ?? 'application/octet-stream',
      csp: pluginClientCsp(network),
      network,
      pluginId: manifest.id,
    },
  }
}
