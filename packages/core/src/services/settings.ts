/**
 * 设置服务：JSON 持久化 + 深合并 + 变更订阅。
 *
 * 采用「写时防抖 + 临时文件重命名」的原子写入策略，
 * 避免进程崩溃时产生半截配置文件。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Service, type Context } from 'cordis'
import type { DeepPartial, Settings, SettingsLike } from '@cordclean/shared'

const SETTINGS_VERSION = 1

/** 默认设置 */
export const DEFAULT_SETTINGS: Settings = {
  quarantine: {
    enabled: true,
    maxBytes: 2 * 1024 ** 3,
    maxFiles: 20000,
    retentionDays: 0,
  },
  scan: {
    concurrency: 3,
    maxItemsPerTask: 20000,
    maxEntriesPerTask: 400000,
    maxDepth: 32,
    largeFileThreshold: 100 * 1024 ** 2,
    duplicateMinSize: 1024 ** 2,
    duplicateMaxCandidates: 4000,
  },
  clean: {
    dryRunDefault: false,
    confirmRisky: true,
    retries: 2,
  },
  analysis: {
    roots: [],
    includeSystem: true,
    excludes: ['\\node_modules\\', '\\.git\\', '\\$Recycle.Bin\\', '\\System Volume Information\\'],
  },
  plugins: {},
  ui: {
    theme: 'dark',
    lastPage: 'overview',
  },
  version: SETTINGS_VERSION,
}

export interface SettingsConfig {
  dataDir: string
  /** 启动时的覆盖项（测试或便携模式使用） */
  overrides?: DeepPartial<Settings>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** 深合并（数组整体替换） */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : (patch as T))
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch)) {
    const current = result[key]
    if (isPlainObject(current) && isPlainObject(value)) {
      result[key] = deepMerge(current, value)
    } else if (value !== undefined) {
      result[key] = value
    }
  }
  return result as T
}

export class SettingsService extends Service implements SettingsLike {
  /** 配置文件绝对路径 */
  readonly file: string
  private data: Settings
  private listeners = new Set<(settings: Settings) => void>()
  private saveTimer: NodeJS.Timeout | undefined
  private dirty = false

  constructor(ctx: Context, config: SettingsConfig) {
    super(ctx, 'settings')
    mkdirSync(config.dataDir, { recursive: true })
    this.file = path.join(config.dataDir, 'config.json')
    this.data = this.load(config.overrides)
    // 随插件 fiber 卸载时落盘
    ctx.effect(() => () => this.flush())
  }

  private load(overrides?: DeepPartial<Settings>): Settings {
    let stored: unknown = {}
    if (existsSync(this.file)) {
      try {
        stored = JSON.parse(readFileSync(this.file, 'utf8'))
      } catch (error) {
        // 配置损坏：备份后回退到默认值，避免阻塞启动
        try {
          renameSync(this.file, `${this.file}.broken-${Date.now()}`)
        } catch {
          /* ignore */
        }
        this.ctx.logger?.warn?.('配置文件解析失败，已重置：%s', String(error))
        stored = {}
      }
    }
    const merged = deepMerge(deepMerge(DEFAULT_SETTINGS, stored), overrides ?? {})
    return this.sanitize(merged)
  }

  /** 数值范围与枚举校正，防止用户手改配置导致越界 */
  private sanitize(input: Settings): Settings {
    const settings = input
    const clamp = (value: unknown, min: number, max: number, fallback: number) => {
      const num = Number(value)
      if (!Number.isFinite(num)) return fallback
      return Math.min(max, Math.max(min, Math.round(num)))
    }
    settings.scan.concurrency = clamp(settings.scan.concurrency, 1, 8, 3)
    settings.scan.maxDepth = clamp(settings.scan.maxDepth, 1, 128, 32)
    settings.scan.maxItemsPerTask = clamp(settings.scan.maxItemsPerTask, 100, 500000, 20000)
    settings.scan.maxEntriesPerTask = clamp(settings.scan.maxEntriesPerTask, 1000, 5_000_000, 400000)
    settings.scan.largeFileThreshold = clamp(settings.scan.largeFileThreshold, 1024 ** 2, 1024 ** 4, 100 * 1024 ** 2)
    settings.scan.duplicateMinSize = clamp(settings.scan.duplicateMinSize, 1024, 1024 ** 3, 1024 ** 2)
    settings.quarantine.maxBytes = clamp(settings.quarantine.maxBytes, 0, 1024 ** 5, 2 * 1024 ** 3)
    settings.quarantine.maxFiles = clamp(settings.quarantine.maxFiles, 0, 1_000_000, 20000)
    settings.quarantine.retentionDays = clamp(settings.quarantine.retentionDays, 0, 3650, 0)
    settings.clean.retries = clamp(settings.clean.retries, 0, 5, 2)
    if (!Array.isArray(settings.analysis.roots)) settings.analysis.roots = []
    if (!Array.isArray(settings.analysis.excludes)) settings.analysis.excludes = []
    if (!isPlainObject(settings.plugins)) settings.plugins = {}
    if (settings.ui.theme !== 'light') settings.ui.theme = 'dark'
    settings.version = SETTINGS_VERSION
    return settings
  }

  get(): Settings {
    return this.data
  }

  set(keyPath: string, value: unknown): void {
    const keys = keyPath.split('.').filter(Boolean)
    if (!keys.length) return
    let cursor: Record<string, any> = this.data as any
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i]
      if (!isPlainObject(cursor[key])) cursor[key] = {}
      cursor = cursor[key]
    }
    cursor[keys[keys.length - 1]] = value
    this.data = this.sanitize(this.data)
    this.commit()
  }

  patch(patch: DeepPartial<Settings>): void {
    this.data = this.sanitize(deepMerge(this.data, patch))
    this.commit()
  }

  onChange(listener: (settings: Settings) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private commit(): void {
    this.dirty = true
    for (const listener of this.listeners) {
      try {
        listener(this.data)
      } catch (error) {
        this.ctx.logger?.warn?.('settings listener error: %s', String(error))
      }
    }
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.flush(), 200)
  }

  /** 立即落盘（进程退出前调用） */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
    }
    if (!this.dirty) return
    this.dirty = false
    const temp = `${this.file}.tmp`
    try {
      writeFileSync(temp, JSON.stringify(this.data, null, 2), 'utf8')
      renameSync(temp, this.file)
    } catch (error) {
      this.ctx.logger?.error?.('写入配置文件失败：%s', String(error))
    }
  }
}
