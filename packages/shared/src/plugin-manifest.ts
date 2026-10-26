/**
 * v2 插件包清单（`plugin.json`）契约与校验。
 *
 * 设计目标（与 DSH 的 `package.json` + `dsh.client` 清单对齐，但保持零依赖）：
 * - 插件从「单文件」升级为「目录 + 清单」：目录里放 `plugin.json`、入口模块、
 *   可选的客户端资源与配置 schema；
 * - 清单在**安装前**就能回答三件事：它要什么权限、兼容哪个宿主版本、贡献了什么；
 * - 旧版单文件插件继续可用：扫描/安装端用 `createLegacyPluginManifest()` 合成
 *   一份 apiVersion=1 的清单，进入同一套管理流程。
 *
 * 本文件是纯函数 + 类型，不依赖 node 内置模块，浏览器端也能 import。
 */
import { validatePluginDependencies } from './plugin-code.ts'
import type { PluginKind } from './plugin-api.ts'

/** 插件目录里的清单文件名 */
export const PLUGIN_MANIFEST_FILE = 'plugin.json'

/** 当前插件包 API 版本；清单必须声明该值 */
export const PLUGIN_API_VERSION = 2

/** 旧版单文件插件（无清单）的隐式 API 版本 */
export const LEGACY_PLUGIN_API_VERSION = 1

/** 插件类型；与 `plugin-api.ts` 的 PluginKind 保持一致，这里提供运行时枚举 */
export const PLUGIN_KINDS = ['cleaner', 'widget', 'active', 'desktop', 'integration'] as const satisfies readonly PluginKind[]

/** 插件可声明的宿主服务（与 `plugin-code.ts` 的 inject 检查清单保持一致） */
export const PLUGIN_SERVICES = [
  'ui',
  'cleaner',
  'window',
  'settings',
  'system',
  'pathPolicy',
  'rules',
  'evaluator',
  'history',
  'quarantine',
  'compensate',
  'executor',
  'recycleBin',
  'ai',
  'aiContext',
  'egress',
] as const
export type PluginService = (typeof PLUGIN_SERVICES)[number]

/** 客户端资源的加载方式 */
export const PLUGIN_CLIENT_MODES = ['none', 'declarative', 'page'] as const
export type PluginClientMode = (typeof PLUGIN_CLIENT_MODES)[number]

export interface PluginEngines {
  /** 宿主（CordClean）版本范围，semver range，例如 ">=0.6.0 <0.7.0" */
  cordclean: string
}

export interface PluginPermissions {
  /** 需要注入的宿主服务；安装前展示给用户，运行时与 inject 对照 */
  services: PluginService[]
  /** 允许访问的目录根（worker/清理类插件用；支持 %TEMP% 等模板） */
  fsRoots?: string[]
  /** 是否声明需要发起网络请求；v2 默认不允许，true 会在安装时需要显式确认 */
  network: boolean
  /** 是否声明需要起子进程；v2 默认不允许，true 会在安装时需要显式确认 */
  subprocess: boolean
}

export interface PluginClientDeclaration {
  /**
   * none        无客户端资源
   * declarative 只通过 `ctx.ui` 注册声明式贡献（卡片/页面/状态项/命令）
   * page        包内自带客户端页面，由宿主用自定义协议加载
   */
  mode: PluginClientMode
  /** page 模式必填：相对包目录的入口（必须在 client/ 下，.html/.htm/.js） */
  entry?: string
}

/** 插件声明的贡献点；具体注册仍在代码里完成，这里用于安装前展示与一致性检查 */
export interface PluginContributions {
  tasks?: string[]
  overviewCards?: string[]
  pages?: string[]
  statusItems?: string[]
  commands?: string[]
}

export interface PluginManifest {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  license?: string
  homepage?: string
  apiVersion: number
  engines: PluginEngines
  kind: PluginKind
  /** 入口模块，相对包目录（.mjs/.js） */
  entry: string
  client?: PluginClientDeclaration
  /** 可选：配置 schema 的 JSON 文件（相对包目录） */
  configSchema?: string
  permissions: PluginPermissions
  contributes?: PluginContributions
  /** 可选：插件自己的 npm 依赖（名称 → semver 范围） */
  dependencies?: Record<string, string>
}

export interface PluginManifestIssue {
  code: string
  message: string
}

/** 扫描/安装阶段发现的问题（供插件管理页展示） */
export interface PluginPackageIssue {
  target: string
  errors: PluginManifestIssue[]
  warnings: PluginManifestIssue[]
}

/** v2 插件包审阅结果（安装前的只读检查，不落盘） */
export interface PluginPackageReview {
  sourceDir: string
  /** 清单合法时才有；非法/不可读时为 undefined */
  manifest?: PluginManifest
  warnings: PluginManifestIssue[]
  errors: PluginManifestIssue[]
  /** 已安装同 id 的版本（安装将覆盖） */
  installedVersion?: string
}

export interface PluginManifestValidation {
  ok: boolean
  errors: PluginManifestIssue[]
  warnings: PluginManifestIssue[]
  manifest?: PluginManifest
}

export interface PluginCompatibilityContext {
  /** 宿主版本，例如 cordclean 的 package.json version */
  appVersion: string
  /** 宿主支持的插件 API 版本，默认 {@link PLUGIN_API_VERSION} */
  apiVersion?: number
}

/* ------------------------------------------------------------------ */
/* semver（子集）                                                      */
/* ------------------------------------------------------------------ */

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

const VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function parseVersion(input: string): ParsedVersion | null {
  const match = VERSION_RE.exec(String(input ?? '').trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

function comparePrerelease(a: string[], b: string[]): number {
  // 正式版大于同号预发布版
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i++) {
    const left = a[i]
    const right = b[i]
    if (left === undefined) return -1
    if (right === undefined) return 1
    if (left === right) continue
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) return Number(left) - Number(right)
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    return left < right ? -1 : 1
  }
  return 0
}

/** 比较两个 semver；任一非法返回 NaN */
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  if (!va || !vb) return Number.NaN
  const core = va.major - vb.major || va.minor - vb.minor || va.patch - vb.patch
  return core !== 0 ? core : comparePrerelease(va.prerelease, vb.prerelease)
}

type ComparatorOp = '>=' | '>' | '<=' | '<' | '='

interface Comparator {
  op: ComparatorOp
  version: ParsedVersion
}

function makeComparator(op: ComparatorOp, version: ParsedVersion): Comparator {
  return { op, version }
}

/** 解析单个 range 表达式；返回 null 表示非法 */
function parseRangeExpression(expression: string): Comparator[][] | null {
  const groups: Comparator[][] = []
  const alternatives = String(expression ?? '')
    .split('||')
    .map((item) => item.trim())

  for (const alternative of alternatives) {
    if (!alternative) continue
    if (alternative === '*' || alternative === 'x' || alternative === 'X') {
      groups.push([])
      continue
    }
    const tokens = alternative.split(/\s+/).filter(Boolean)
    const comparators: Comparator[] = []
    for (const token of tokens) {
      if (token === '*' || token === 'x' || token === 'X') continue
      const match = /^(>=|<=|>|<|=|\^|~)?(\d+\.\d+\.\d+)$/.exec(token)
      if (!match) return null
      const base = parseVersion(match[2])
      if (!base) return null
      const prefix = match[1] ?? '='
      if (prefix === '^') {
        if (base.major > 0) {
          comparators.push(makeComparator('>=', base))
          comparators.push(makeComparator('<', { major: base.major + 1, minor: 0, patch: 0, prerelease: [] }))
        } else if (base.minor > 0) {
          comparators.push(makeComparator('>=', base))
          comparators.push(makeComparator('<', { major: 0, minor: base.minor + 1, patch: 0, prerelease: [] }))
        } else {
          comparators.push(makeComparator('>=', base))
          comparators.push(makeComparator('<', { major: 0, minor: 0, patch: base.patch + 1, prerelease: [] }))
        }
      } else if (prefix === '~') {
        comparators.push(makeComparator('>=', base))
        comparators.push(makeComparator('<', { major: base.major, minor: base.minor + 1, patch: 0, prerelease: [] }))
      } else {
        comparators.push(makeComparator(prefix as ComparatorOp, base))
      }
    }
    groups.push(comparators)
  }

  return groups.length > 0 ? groups : null
}

export function isValidVersionRange(expression: string): boolean {
  return parseRangeExpression(expression) !== null
}

function compareParsed(version: ParsedVersion, bound: ParsedVersion, op: ComparatorOp): boolean {
  const core = version.major - bound.major || version.minor - bound.minor || version.patch - bound.patch
  const result = core !== 0 ? core : comparePrerelease(version.prerelease, bound.prerelease)
  switch (op) {
    case '>=':
      return result >= 0
    case '>':
      return result > 0
    case '<=':
      return result <= 0
    case '<':
      return result < 0
    default:
      return result === 0
  }
}

export function satisfiesVersionRange(version: string, expression: string): boolean {
  const parsed = parseVersion(version)
  const groups = parseRangeExpression(expression)
  if (!parsed || !groups) return false
  return groups.some((comparators) => comparators.every((item) => compareParsed(parsed, item.version, item.op)))
}

/* ------------------------------------------------------------------ */
/* 路径与权限校验                                                      */
/* ------------------------------------------------------------------ */

const CONTROL_CHAR_RE = /[\u0000-\u001f]/
const INVALID_PATH_CHAR_RE = /[<>:"|?*]/

/**
 * 清单里的相对路径：必须用 `/` 分隔，不能是绝对路径/盘符，不能出现 `.`/`..`，
 * 不能含 Windows 非法字符；用于 entry、client.entry、configSchema。
 */
export function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (!text || text.length > 240) return false
  if (text.includes('\\') || CONTROL_CHAR_RE.test(text)) return false
  if (text.startsWith('/') || /^[a-zA-Z]:/.test(text)) return false
  const segments = text.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return false
  return segments.every((segment) => !INVALID_PATH_CHAR_RE.test(segment))
}

/** worker/清理类插件的目录根：绝对路径或 `%VAR%` 模板，不能是盘符根 */
export function isSafePluginFsRoot(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (!text || text.length > 260 || CONTROL_CHAR_RE.test(text)) return false
  if (text.split(/[\\/]/).includes('..')) return false
  const driveRoot = /^[a-zA-Z]:[\\/]?$/.test(text)
  const absolute = /^[a-zA-Z]:[\\/]/.test(text) || /^\\\\[^\\]+\\[^\\]+/.test(text)
  const templated = /^%[A-Za-z_][A-Za-z0-9_]*%([\\/]|$)/.test(text)
  return !driveRoot && (absolute || templated)
}

const TOP_LEVEL_KEYS = new Set([
  'id',
  'name',
  'version',
  'description',
  'author',
  'license',
  'homepage',
  'apiVersion',
  'engines',
  'kind',
  'entry',
  'client',
  'configSchema',
  'permissions',
  'contributes',
  'dependencies',
])

const CONTRIBUTION_KEYS = ['tasks', 'overviewCards', 'pages', 'statusItems', 'commands'] as const
const PERMISSION_KEYS = new Set(['services', 'fsRoots', 'network', 'subprocess'])
const PLUGIN_ID_RE = /^(?=.{2,40}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const CONTRIBUTION_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function issue(code: string, message: string): PluginManifestIssue {
  return { code, message }
}

function validateContributionIds(
  bucket: unknown,
  key: (typeof CONTRIBUTION_KEYS)[number],
  errors: PluginManifestIssue[],
  warnings: PluginManifestIssue[],
): string[] | undefined {
  if (bucket === undefined) return undefined
  if (!Array.isArray(bucket)) {
    errors.push(issue(`invalid-contributes-${key}`, `contributes.${key} 必须是字符串数组`))
    return undefined
  }
  if (bucket.length > 64) {
    errors.push(issue(`too-many-contributes-${key}`, `contributes.${key} 最多 64 项`))
  }
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of bucket) {
    if (typeof item !== 'string' || !CONTRIBUTION_ID_RE.test(item.trim())) {
      errors.push(issue(`invalid-contribute-id-${key}`, `contributes.${key} 含非法 id：${String(item)}`))
      continue
    }
    const id = item.trim()
    if (seen.has(id)) {
      warnings.push(issue(`duplicate-contribute-${key}`, `contributes.${key} 重复声明：${id}`))
      continue
    }
    seen.add(id)
    result.push(id)
  }
  return result
}

function validatePermissions(
  input: unknown,
  kind: PluginKind | undefined,
  errors: PluginManifestIssue[],
  warnings: PluginManifestIssue[],
): PluginPermissions | undefined {
  if (!isPlainObject(input)) {
    errors.push(issue('missing-permissions', '缺少 permissions（v2 清单必须显式声明权限）'))
    return undefined
  }
  for (const key of Object.keys(input)) {
    if (!PERMISSION_KEYS.has(key)) warnings.push(issue('unknown-permission', `未知权限字段：permissions.${key}`))
  }

  const servicesInput = input.services
  let services: PluginService[] | undefined
  if (!Array.isArray(servicesInput)) {
    errors.push(issue('invalid-permission-services', 'permissions.services 必须是数组（可为空数组）'))
  } else {
    const seen = new Set<string>()
    const list: PluginService[] = []
    for (const item of servicesInput) {
      if (typeof item !== 'string' || !(PLUGIN_SERVICES as readonly string[]).includes(item)) {
        errors.push(issue('unknown-service', `permissions.services 含未知服务：${String(item)}`))
        continue
      }
      if (seen.has(item)) {
        warnings.push(issue('duplicate-service', `permissions.services 重复声明：${item}`))
        continue
      }
      seen.add(item)
      list.push(item as PluginService)
    }
    services = list
  }
  if (kind === 'cleaner' && services && !services.includes('cleaner')) {
    warnings.push(issue('cleaner-without-service', 'kind 为 cleaner 但 permissions.services 未声明 cleaner'))
  }

  let fsRoots: string[] | undefined
  if (input.fsRoots !== undefined) {
    if (!Array.isArray(input.fsRoots)) {
      errors.push(issue('invalid-fs-roots', 'permissions.fsRoots 必须是字符串数组'))
    } else if (input.fsRoots.length > 20) {
      errors.push(issue('too-many-fs-roots', 'permissions.fsRoots 最多 20 项'))
    } else {
      const list: string[] = []
      for (const item of input.fsRoots) {
        if (!isSafePluginFsRoot(item)) {
          errors.push(
            issue(
              'invalid-fs-root',
              `permissions.fsRoots 含非法目录：${String(item)}（必须是绝对路径或 %VAR% 模板，且不能是盘符根）`,
            ),
          )
          continue
        }
        list.push(item.trim())
      }
      fsRoots = list
    }
  }

  let network: boolean | undefined
  if (typeof input.network !== 'boolean') {
    errors.push(issue('invalid-permission-network', 'permissions.network 必须是布尔值'))
  } else {
    network = input.network
    if (network) {
      warnings.push(issue('network-permission', '插件声明需要网络请求；v2 默认不允许，安装时需用户显式确认'))
    }
  }

  let subprocess: boolean | undefined
  if (typeof input.subprocess !== 'boolean') {
    errors.push(issue('invalid-permission-subprocess', 'permissions.subprocess 必须是布尔值'))
  } else {
    subprocess = input.subprocess
    if (subprocess) {
      warnings.push(issue('subprocess-permission', '插件声明需要子进程；v2 默认不允许，安装时需用户显式确认'))
    }
  }

  if (services === undefined || network === undefined || subprocess === undefined) return undefined
  return { services, fsRoots, network, subprocess }
}

/**
 * 校验一份清单（未知对象）。返回的错误与警告都带稳定 code，供安装/扫描/UI 共用。
 */
export function validatePluginManifest(input: unknown): PluginManifestValidation {
  const errors: PluginManifestIssue[] = []
  const warnings: PluginManifestIssue[] = []

  if (!isPlainObject(input)) {
    return { ok: false, errors: [issue('invalid-manifest', 'plugin.json 必须是对象')], warnings }
  }

  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_KEYS.has(key)) warnings.push(issue('unknown-field', `未知字段：${key}`))
  }

  const id = asTrimmedString(input.id)
  if (!id) errors.push(issue('missing-id', '缺少 id'))
  else if (!PLUGIN_ID_RE.test(id)) errors.push(issue('invalid-id', `id 必须是 2-40 位小写字母/数字/连字符：${id}`))

  const name = asTrimmedString(input.name)
  if (!name) errors.push(issue('missing-name', '缺少 name'))
  else if (name.length > 64) errors.push(issue('invalid-name', 'name 最长为 64 个字符'))

  const version = asTrimmedString(input.version)
  if (!version) errors.push(issue('missing-version', '缺少 version'))
  else if (!parseVersion(version)) errors.push(issue('invalid-version', `version 不是合法 semver：${version}`))

  const description = input.description === undefined ? undefined : asTrimmedString(input.description)
  if (description !== undefined && description.length > 512) {
    errors.push(issue('invalid-description', 'description 最长为 512 个字符'))
  }

  const author = input.author === undefined ? undefined : asTrimmedString(input.author)
  if (author !== undefined && author.length > 120) errors.push(issue('invalid-author', 'author 最长为 120 个字符'))
  const license = input.license === undefined ? undefined : asTrimmedString(input.license)
  if (license !== undefined && license.length > 40) errors.push(issue('invalid-license', 'license 最长为 40 个字符'))
  const homepage = input.homepage === undefined ? undefined : asTrimmedString(input.homepage)
  if (homepage !== undefined && homepage && !/^https?:\/\/\S+$/i.test(homepage)) {
    errors.push(issue('invalid-homepage', 'homepage 必须是 http(s) URL'))
  }

  if (typeof input.apiVersion !== 'number' || !Number.isInteger(input.apiVersion)) {
    errors.push(issue('missing-api-version', 'apiVersion 必须是整数'))
  } else if (input.apiVersion !== PLUGIN_API_VERSION) {
    errors.push(
      issue(
        'unsupported-api-version',
        `apiVersion=${input.apiVersion} 不受支持；v2 插件清单必须声明 apiVersion=${PLUGIN_API_VERSION}（旧版单文件插件走兼容模式）`,
      ),
    )
  }

  let engines: PluginEngines | undefined
  if (!isPlainObject(input.engines)) {
    errors.push(issue('missing-engines', '缺少 engines.cordclean（v2 清单必须声明兼容范围）'))
  } else {
    const range = asTrimmedString(input.engines.cordclean)
    if (!range) errors.push(issue('missing-engines-range', '缺少 engines.cordclean'))
    else if (!isValidVersionRange(range)) {
      errors.push(issue('invalid-engines-range', `engines.cordclean 不是合法 semver range：${range}`))
    } else {
      engines = { cordclean: range }
    }
    for (const key of Object.keys(input.engines)) {
      if (key !== 'cordclean') warnings.push(issue('unknown-engines-field', `未知字段：engines.${key}`))
    }
  }

  let kind: PluginKind | undefined
  if (typeof input.kind !== 'string' || !(PLUGIN_KINDS as readonly string[]).includes(input.kind)) {
    errors.push(issue('invalid-kind', `kind 必须是 ${PLUGIN_KINDS.join(' / ')} 之一`))
  } else {
    kind = input.kind as PluginKind
  }

  let entry: string | undefined
  if (typeof input.entry !== 'string' || !isSafeRelativePath(input.entry)) {
    errors.push(issue('invalid-entry', 'entry 必须是包内相对路径（使用 / 分隔，不能越出包目录）'))
  } else {
    entry = input.entry.trim()
    if (!/\.(mjs|js)$/i.test(entry)) {
      errors.push(issue('invalid-entry-ext', 'entry 必须是 .mjs/.js 模块'))
    }
    if (entry.startsWith('client/')) {
      errors.push(issue('entry-in-client', 'entry 不能指向 client/ 目录（客户端资源请用 client.entry 声明）'))
    }
  }

  let client: PluginClientDeclaration | undefined
  if (input.client !== undefined) {
    if (!isPlainObject(input.client)) {
      errors.push(issue('invalid-client', 'client 必须是对象'))
    } else {
      const mode = asTrimmedString(input.client.mode)
      if (!(PLUGIN_CLIENT_MODES as readonly string[]).includes(mode)) {
        errors.push(issue('invalid-client-mode', `client.mode 必须是 ${PLUGIN_CLIENT_MODES.join(' / ')} 之一`))
      } else if (mode === 'page') {
        const clientEntry = typeof input.client.entry === 'string' ? input.client.entry.trim() : ''
        if (!clientEntry || !isSafeRelativePath(clientEntry)) {
          errors.push(issue('missing-client-entry', 'client.mode=page 时必须提供合法的 client.entry'))
        } else if (!clientEntry.startsWith('client/')) {
          errors.push(issue('client-entry-outside', 'client.entry 必须位于 client/ 目录下'))
        } else if (!/\.(html|htm|js)$/i.test(clientEntry)) {
          errors.push(issue('invalid-client-entry-ext', 'client.entry 必须是 .html/.htm/.js'))
        } else {
          client = { mode: 'page', entry: clientEntry }
        }
        for (const key of Object.keys(input.client)) {
          if (key !== 'mode' && key !== 'entry') warnings.push(issue('unknown-client-field', `未知字段：client.${key}`))
        }
      } else {
        if (input.client.entry !== undefined) {
          warnings.push(issue('ignored-client-entry', `client.mode=${mode} 时不会加载 client.entry`))
        }
        client = { mode: mode as PluginClientMode }
      }
    }
  }

  let configSchema: string | undefined
  if (input.configSchema !== undefined) {
    if (typeof input.configSchema !== 'string' || !isSafeRelativePath(input.configSchema)) {
      errors.push(issue('invalid-config-schema', 'configSchema 必须是包内相对路径（使用 / 分隔）'))
    } else {
      configSchema = input.configSchema.trim()
      if (!/\.json$/i.test(configSchema)) errors.push(issue('invalid-config-schema-ext', 'configSchema 必须是 .json 文件'))
    }
  }

  const permissions = validatePermissions(input.permissions, kind, errors, warnings)

  let contributes: PluginContributions | undefined
  if (input.contributes !== undefined) {
    if (!isPlainObject(input.contributes)) {
      errors.push(issue('invalid-contributes', 'contributes 必须是对象'))
    } else {
      const parsed: PluginContributions = {}
      for (const key of Object.keys(input.contributes)) {
        if (!(CONTRIBUTION_KEYS as readonly string[]).includes(key)) {
          warnings.push(issue('unknown-contribute', `未知贡献字段：contributes.${key}`))
        }
      }
      for (const key of CONTRIBUTION_KEYS) {
        const value = validateContributionIds(input.contributes[key], key, errors, warnings)
        if (value !== undefined) parsed[key] = value
      }
      contributes = parsed
    }
  }

  let dependencies: Record<string, string> | undefined
  if (input.dependencies !== undefined) {
    if (!isPlainObject(input.dependencies)) {
      errors.push(issue('invalid-dependencies', 'dependencies 必须是 { 包名: 版本 } 对象'))
    } else {
      const dependencyErrors = validatePluginDependencies(input.dependencies)
      for (const message of dependencyErrors) errors.push(issue('invalid-dependency', message))
      if (dependencyErrors.length === 0) dependencies = input.dependencies as Record<string, string>
    }
  }

  if (client && client.mode === 'none' && contributes && Object.values(contributes).some((list) => list && list.length > 0)) {
    warnings.push(issue('contributes-without-ui', 'client.mode=none 但声明了 UI 贡献'))
  }

  if (errors.length > 0) return { ok: false, errors, warnings }

  const manifest: PluginManifest = {
    id,
    name,
    version,
    apiVersion: PLUGIN_API_VERSION,
    engines: engines!,
    kind: kind!,
    entry: entry!,
    permissions: permissions!,
    ...(description ? { description } : {}),
    ...(author ? { author } : {}),
    ...(license ? { license } : {}),
    ...(homepage ? { homepage } : {}),
    ...(client ? { client } : {}),
    ...(configSchema ? { configSchema } : {}),
    ...(contributes ? { contributes } : {}),
    ...(dependencies ? { dependencies } : {}),
  }
  return { ok: true, errors, warnings, manifest }
}

/** 解析 `plugin.json` 文本并做语法 + 契约校验 */
export function parsePluginManifest(text: string): PluginManifestValidation {
  let parsed: unknown
  try {
    parsed = JSON.parse(String(text ?? ''))
  } catch (error) {
    return {
      ok: false,
      errors: [issue('invalid-json', 'plugin.json 不是合法 JSON：' + (error as Error).message)],
      warnings: [],
    }
  }
  return validatePluginManifest(parsed)
}

/**
 * 对照宿主版本检查兼容性：apiVersion 与 engines.cordclean。
 * 安装前（还没有 manifest 实例）用 validatePluginManifest 的错误即可；
 * 这里用于启动/启用时对已安装包复查。
 */
export function checkPluginManifestCompatibility(
  manifest: PluginManifest,
  context: PluginCompatibilityContext,
): PluginManifestValidation {
  const errors: PluginManifestIssue[] = []
  const warnings: PluginManifestIssue[] = []
  const apiVersion = context.apiVersion ?? PLUGIN_API_VERSION

  if (manifest.apiVersion !== apiVersion) {
    errors.push(
      issue(
        'api-version-mismatch',
        `插件 ${manifest.id} 要求 apiVersion=${manifest.apiVersion}，当前宿主支持 ${apiVersion}`,
      ),
    )
  }

  if (!parseVersion(context.appVersion)) {
    warnings.push(issue('invalid-app-version', `无法识别宿主版本：${context.appVersion}`))
  } else if (!isValidVersionRange(manifest.engines.cordclean)) {
    errors.push(issue('invalid-engines-range', `插件 ${manifest.id} 的 engines.cordclean 非法：${manifest.engines.cordclean}`))
  } else if (!satisfiesVersionRange(context.appVersion, manifest.engines.cordclean)) {
    errors.push(
      issue(
        'engines-mismatch',
        `插件 ${manifest.id} 要求 CordClean ${manifest.engines.cordclean}，当前版本 ${context.appVersion}`,
      ),
    )
  }

  return { ok: errors.length === 0, errors, warnings }
}

/**
 * 为旧版单文件插件合成一份 apiVersion=1 的清单，让扫描/管理流程可以统一处理。
 * 真实元数据（name/description 等）仍从模块导出读取；这里只提供占位与安全默认值。
 */
export interface LegacyPluginManifestOptions {
  id: string
  name?: string
  version?: string
  kind?: PluginKind
  entry: string
}

export function createLegacyPluginManifest(options: LegacyPluginManifestOptions): PluginManifest {
  const id = String(options.id ?? '').trim() || 'legacy-plugin'
  return {
    id,
    name: options.name?.trim() || id,
    version: options.version?.trim() || '0.0.0',
    apiVersion: LEGACY_PLUGIN_API_VERSION,
    engines: { cordclean: '*' },
    kind: options.kind ?? 'integration',
    entry: options.entry,
    permissions: { services: [], network: false, subprocess: false },
  }
}
