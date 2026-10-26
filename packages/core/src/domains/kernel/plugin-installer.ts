/**
 * v2 插件包安装事务。
 *
 * 流程（与 `docs/plugin-package-v2.md` 第 8 节一致）：
 *
 * ```
 * 选择包目录
 *   → 读取并校验 plugin.json（语法 + 契约 + 兼容）
 *   → 检查入口源码（体积上限 + 静态契约）
 *   → 复制到 plugins/.staging/<id>-<ts>/（拒绝符号链接、限制文件数/体积/深度）
 *   → 复查暂存目录
 *   → 原子 rename 到 plugins/<id>/（同盘）
 *   → 任一步失败：清理暂存目录；升级失败恢复旧版本
 * ```
 *
 * 本文件只负责「目录层面的事务」，不启动插件、不写设置；
 * 依赖安装、用户审阅由宿主层（PluginManager / RPC / UI）在 stage 与 commit 之间完成。
 */
import { randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, rmdir, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  checkPluginManifestCompatibility,
  checkPluginSource,
  type PluginManifest,
  type PluginManifestIssue,
  type PluginPackageReview,
} from '@cordclean/shared'
import {
  PLUGIN_PACKAGES_DIR,
  PLUGIN_STAGING_DIR,
  readPluginManifest,
  resolvePackageFile,
} from './plugin-package.ts'

/** 被替换/卸载的旧版本移到该目录，便于回滚与人工排查 */
export const PLUGIN_TRASH_DIR = '.trash'

const SKIPPED_DIRS = new Set(['node_modules', '.git', PLUGIN_STAGING_DIR, PLUGIN_TRASH_DIR])

export interface PluginInstallLimits {
  /** 包内文件数上限 */
  maxFiles: number
  /** 包内总字节上限 */
  maxBytes: number
  /** 目录层级上限（相对包根） */
  maxDepth: number
  /** 入口源码体积上限 */
  maxEntryBytes: number
}

export const DEFAULT_PLUGIN_INSTALL_LIMITS: PluginInstallLimits = {
  maxFiles: 500,
  maxBytes: 50 * 1024 * 1024,
  maxDepth: 8,
  maxEntryBytes: 512 * 1024,
}

export class PluginInstallError extends Error {
  readonly code: string
  readonly issues: PluginManifestIssue[]

  constructor(code: string, message: string, issues: PluginManifestIssue[] = []) {
    super(message)
    this.name = 'PluginInstallError'
    this.code = code
    this.issues = issues
  }
}

export interface StagePluginPackageOptions {
  /** `dataDir/plugins` */
  pluginsDir: string
  /** 待安装的源目录 */
  sourceDir: string
  /** 宿主版本，用于 engines/apiVersion 兼容检查 */
  appVersion: string
  apiVersion?: number
  upgrade?: boolean
  limits?: Partial<PluginInstallLimits>
  /**
   * 可选：暂存完成后的准备工作（例如按 package.json 安装依赖、跑冒烟测试）。
   * 抛错即视为安装失败，暂存目录会被清理。
   */
  prepareStaging?: (stagingDir: string, manifest: PluginManifest) => Promise<void>
}

export interface StagedPluginPackage {
  id: string
  version: string
  manifest: PluginManifest
  stagingDir: string
  sourceDir: string
  warnings: PluginManifestIssue[]
}

export interface PluginInstallResult {
  id: string
  version: string
  dir: string
  manifest: PluginManifest
  warnings: PluginManifestIssue[]
  /** 升级安装时被替换的旧目录（在 .trash 下） */
  backupDir?: string
}

export interface CommitPluginPackageOptions {
  pluginsDir: string
  upgrade?: boolean
}

function stageTimestamp(): string {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target)
    return true
  } catch {
    return false
  }
}

/** 复制包目录到暂存区：拒绝符号链接/特殊文件，限制文件数、体积与深度 */
async function copyPackageTree(
  sourceDir: string,
  targetDir: string,
  limits: PluginInstallLimits,
): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0

  async function walk(from: string, to: string, depth: number): Promise<void> {
    if (depth > limits.maxDepth) {
      throw new PluginInstallError('package-too-deep', `插件包目录层级超过上限（${limits.maxDepth}）`)
    }
    const entries = await readdir(from, { withFileTypes: true })
    await mkdir(to, { recursive: true })
    for (const entry of entries) {
      if (SKIPPED_DIRS.has(entry.name)) continue
      const source = path.join(from, entry.name)
      const target = path.join(to, entry.name)
      const info = await lstat(source)
      if (info.isSymbolicLink()) {
        throw new PluginInstallError('symlink-not-allowed', `插件包内不允许符号链接：${path.relative(sourceDir, source)}`)
      }
      if (info.isDirectory()) {
        await walk(source, target, depth + 1)
        continue
      }
      if (!info.isFile()) {
        throw new PluginInstallError('unsupported-file', `插件包内存在不支持的文件类型：${path.relative(sourceDir, source)}`)
      }
      files += 1
      bytes += info.size
      if (files > limits.maxFiles) {
        throw new PluginInstallError('package-too-many-files', `插件包文件数超过上限（${limits.maxFiles}）`)
      }
      if (bytes > limits.maxBytes) {
        throw new PluginInstallError('package-too-large', `插件包体积超过上限（${limits.maxBytes} 字节）`)
      }
      await copyFile(source, target)
    }
  }

  await walk(sourceDir, targetDir, 0)
  return { files, bytes }
}

async function assertEntrySource(
  packageDir: string,
  manifest: PluginManifest,
  limits: PluginInstallLimits,
): Promise<void> {
  const entry = await resolvePackageFile(packageDir, manifest.entry)
  if (!entry.path) {
    throw new PluginInstallError('invalid-entry', entry.error?.message ?? `入口不存在：${manifest.entry}`, [
      entry.error ?? { code: 'missing-file', message: `入口不存在：${manifest.entry}` },
    ])
  }
  const info = await stat(entry.path)
  if (info.size > limits.maxEntryBytes) {
    throw new PluginInstallError('entry-too-large', `入口源码超过 ${limits.maxEntryBytes} 字节上限`)
  }
  const source = await readFile(entry.path, 'utf8')
  const check = checkPluginSource(source, { mode: 'native', allowRelativeImports: true })
  if (!check.ok) {
    throw new PluginInstallError(
      'entry-check-failed',
      '入口源码未通过静态契约检查：' + check.errors.join('；'),
      check.errors.map((message) => ({ code: 'entry-check', message })),
    )
  }
}

/**
 * 只读检查一个插件包目录（不复制、不落盘）。
 * 供管理页「检查 → 展示权限/警告 → 用户确认」流程使用；错误以列表返回而不是抛异常。
 */
export interface InspectPluginPackageOptions {
  sourceDir: string
  appVersion: string
  apiVersion?: number
  limits?: Partial<PluginInstallLimits>
}

export async function inspectPluginPackage(options: InspectPluginPackageOptions): Promise<PluginPackageReview> {
  const limits: PluginInstallLimits = { ...DEFAULT_PLUGIN_INSTALL_LIMITS, ...options.limits }
  const requested = path.resolve(options.sourceDir)
  const errors: PluginManifestIssue[] = []
  const warnings: PluginManifestIssue[] = []

  let sourceDir: string
  try {
    sourceDir = await realpath(requested)
  } catch (error) {
    return {
      sourceDir: requested,
      errors: [{ code: 'source-missing', message: `插件源目录不存在或不可访问：${(error as Error).message}` }],
      warnings,
    }
  }
  const info = await stat(sourceDir).catch(() => undefined)
  if (!info?.isDirectory()) {
    return { sourceDir, errors: [{ code: 'source-not-directory', message: '插件源必须是目录' }], warnings }
  }

  const read = await readPluginManifest(sourceDir)
  warnings.push(...read.validation.warnings)
  if (!read.validation.ok || !read.validation.manifest) {
    return { sourceDir, errors: read.validation.errors, warnings }
  }

  const manifest = read.validation.manifest
  const compatibility = checkPluginManifestCompatibility(manifest, {
    appVersion: options.appVersion,
    apiVersion: options.apiVersion,
  })
  errors.push(...compatibility.errors)
  warnings.push(...compatibility.warnings)

  if (manifest.client?.mode === 'page' && manifest.client.entry) {
    const client = await resolvePackageFile(sourceDir, manifest.client.entry)
    if (!client.path) errors.push(client.error ?? { code: 'invalid-client-entry', message: '客户端页面不存在' })
  }
  if (manifest.configSchema) {
    const schema = await resolvePackageFile(sourceDir, manifest.configSchema)
    if (!schema.path) errors.push(schema.error ?? { code: 'invalid-config-schema', message: '配置 schema 不存在' })
  }

  const entry = await resolvePackageFile(sourceDir, manifest.entry)
  if (!entry.path) {
    errors.push(entry.error ?? { code: 'invalid-entry', message: `入口不存在：${manifest.entry}` })
  } else {
    const entryInfo = await stat(entry.path)
    if (entryInfo.size > limits.maxEntryBytes) {
      errors.push({ code: 'entry-too-large', message: `入口源码超过 ${limits.maxEntryBytes} 字节上限` })
    } else {
      const source = await readFile(entry.path, 'utf8')
      const check = checkPluginSource(source, { mode: 'native', allowRelativeImports: true })
      for (const message of check.errors) errors.push({ code: 'entry-check-failed', message })
    }
  }

  return { sourceDir, manifest, errors, warnings }
}

/**
 * 第一阶段：校验源目录并复制到 `plugins/.staging/`。
 * 成功返回暂存信息；失败抛 {@link PluginInstallError}，且不会留下暂存目录。
 */
export async function stagePluginPackage(options: StagePluginPackageOptions): Promise<StagedPluginPackage> {
  const limits: PluginInstallLimits = { ...DEFAULT_PLUGIN_INSTALL_LIMITS, ...options.limits }
  let sourceDir: string
  try {
    sourceDir = await realpath(path.resolve(options.sourceDir))
  } catch (error) {
    throw new PluginInstallError('source-missing', `插件源目录不存在：${(error as Error).message}`)
  }
  const sourceInfo = await stat(sourceDir)
  if (!sourceInfo.isDirectory()) throw new PluginInstallError('source-not-directory', '插件源必须是目录')

  const read = await readPluginManifest(sourceDir)
  if (!read.validation.ok || !read.validation.manifest) {
    throw new PluginInstallError(
      'invalid-manifest',
      'plugin.json 校验失败：' + read.validation.errors.map((item) => item.message).join('；'),
      read.validation.errors,
    )
  }
  const manifest = read.validation.manifest
  const warnings = [...read.validation.warnings]

  const compatibility = checkPluginManifestCompatibility(manifest, {
    appVersion: options.appVersion,
    apiVersion: options.apiVersion,
  })
  if (!compatibility.ok) {
    throw new PluginInstallError(
      'incompatible-plugin',
      compatibility.errors.map((item) => item.message).join('；'),
      compatibility.errors,
    )
  }
  warnings.push(...compatibility.warnings)

  if (manifest.client?.mode === 'page' && manifest.client.entry) {
    const client = await resolvePackageFile(sourceDir, manifest.client.entry)
    if (!client.path) throw new PluginInstallError('invalid-client-entry', client.error?.message ?? '客户端页面不存在')
  }
  if (manifest.configSchema) {
    const schema = await resolvePackageFile(sourceDir, manifest.configSchema)
    if (!schema.path) throw new PluginInstallError('invalid-config-schema', schema.error?.message ?? '配置 schema 不存在')
  }

  await assertEntrySource(sourceDir, manifest, limits)

  const stagingRoot = path.join(path.resolve(options.pluginsDir), PLUGIN_STAGING_DIR)
  await mkdir(stagingRoot, { recursive: true })
  const stagingDir = path.join(stagingRoot, `${manifest.id}-${stageTimestamp()}`)
  try {
    await copyPackageTree(sourceDir, stagingDir, limits)
    // 复查暂存副本，防止复制过程中源目录变化
    const staged = await readPluginManifest(stagingDir)
    if (!staged.validation.ok || !staged.validation.manifest) {
      throw new PluginInstallError(
        'staged-manifest-invalid',
        '暂存副本的 plugin.json 校验失败：' + staged.validation.errors.map((item) => item.message).join('；'),
        staged.validation.errors,
      )
    }
    const entry = await resolvePackageFile(stagingDir, staged.validation.manifest.entry)
    if (!entry.path) {
      throw new PluginInstallError('staged-entry-missing', '暂存副本缺少入口文件')
    }
    if (options.prepareStaging) await options.prepareStaging(stagingDir, staged.validation.manifest)
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }

  return {
    id: manifest.id,
    version: manifest.version,
    manifest,
    stagingDir,
    sourceDir,
    warnings,
  }
}

/**
 * 第二阶段：从暂存区原子落盘。
 * 已存在同 id 时：`upgrade !== true` 报 `already-installed`；升级时旧目录先移到 `.trash`，
 * 新目录 rename 失败会恢复旧目录。
 */
export async function commitPluginPackage(
  staged: StagedPluginPackage,
  options: CommitPluginPackageOptions,
): Promise<PluginInstallResult> {
  const pluginsDir = path.resolve(options.pluginsDir)
  const targetDir = path.join(pluginsDir, staged.id)
  await mkdir(pluginsDir, { recursive: true })

  let backupDir: string | undefined
  if (await pathExists(targetDir)) {
    if (!options.upgrade) {
      await rm(staged.stagingDir, { recursive: true, force: true }).catch(() => {})
      throw new PluginInstallError('already-installed', `插件 ${staged.id} 已安装；升级请显式传入 upgrade`)
    }
    backupDir = path.join(pluginsDir, PLUGIN_TRASH_DIR, `${staged.id}-${stageTimestamp()}`)
    await mkdir(path.dirname(backupDir), { recursive: true })
    await rename(targetDir, backupDir)
  }

  try {
    await rename(staged.stagingDir, targetDir)
  } catch (error) {
    if (backupDir) {
      await rename(backupDir, targetDir).catch(() => {})
    }
    await rm(staged.stagingDir, { recursive: true, force: true }).catch(() => {})
    throw new PluginInstallError('commit-failed', `插件落盘失败：${(error as Error).message}`)
  }
  // 暂存根目录为空时顺手移除；还有其它进行中的安装时 rmdir 失败即可
  await rmdir(path.dirname(staged.stagingDir)).catch(() => {})

  return {
    id: staged.id,
    version: staged.version,
    dir: targetDir,
    manifest: staged.manifest,
    warnings: staged.warnings,
    backupDir,
  }
}

/** 一步式安装：stage + commit，失败自动清理暂存目录 */
export async function installPluginPackage(options: StagePluginPackageOptions): Promise<PluginInstallResult> {
  const staged = await stagePluginPackage(options)
  return commitPluginPackage(staged, {
    pluginsDir: options.pluginsDir,
    upgrade: options.upgrade === true,
  })
}

export interface RemovePluginPackageOptions {
  /** true（默认）移到 `.trash` 保留旧版本，false 直接删除 */
  backup?: boolean
}

/** 卸载插件包：默认移入 `.trash` 而不是直接删除，便于回滚与排查 */
export async function removePluginPackage(
  pluginsDir: string,
  id: string,
  options: RemovePluginPackageOptions = {},
): Promise<{ dir: string; backupDir?: string }> {
  if (!/^(?=.{2,40}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(id)) {
    throw new PluginInstallError('invalid-id', `非法插件 id：${id}`)
  }
  const root = path.resolve(pluginsDir)
  const targetDir = path.join(root, id)
  if (!(await pathExists(targetDir))) throw new PluginInstallError('not-installed', `插件 ${id} 未安装`)
  if (options.backup === false) {
    await rm(targetDir, { recursive: true, force: true })
    return { dir: targetDir }
  }
  const backupDir = path.join(root, PLUGIN_TRASH_DIR, `${id}-${stageTimestamp()}`)
  await mkdir(path.dirname(backupDir), { recursive: true })
  await rename(targetDir, backupDir)
  return { dir: targetDir, backupDir }
}

/** 启动时清理上次中断留下的暂存目录（不影响已安装插件） */
export async function cleanupPluginStaging(pluginsDir: string): Promise<void> {
  await rm(path.join(path.resolve(pluginsDir), PLUGIN_STAGING_DIR), { recursive: true, force: true })
}

/** 插件包目录默认位置（相对 dataDir） */
export function pluginPackagesDir(dataDir: string): string {
  return path.join(path.resolve(dataDir), PLUGIN_PACKAGES_DIR)
}
