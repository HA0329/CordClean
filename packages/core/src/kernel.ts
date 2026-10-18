/**
 * 内核装配（Kernel）。
 *
 * 这里是 Cordis 框架真正「发力」的地方：整个应用由一个根 Context 装配，
 * 每个服务都是一个插件（fiber），彼此通过 `inject` 声明依赖，
 * 卸载某个 fiber 时它注册的服务、事件监听、清理任务会被框架自动回收。
 */
import { Context } from 'cordis'
import type { DeepPartial, Settings } from '@cordclean/shared'
import { createTaskEnv, defaultDataDir } from './env.ts'
import { setupLogger } from './logger.ts'
import { BUILTIN_MANIFEST } from './manifest.ts'
import { CleanerService } from './services/cleaner.ts'
import { CompensateService } from './services/compensate.ts'
import { EvaluatorService } from './services/evaluator.ts'
import { ExecutorService } from './services/executor.ts'
import { RecycleBinService } from './services/recycle-bin.ts'
import { HistoryService } from './services/history.ts'
import { PathPolicyService } from './services/path-policy.ts'
import { PluginManagerService, type PluginManifestEntry } from './services/plugins.ts'
import { QuarantineService } from './services/quarantine.ts'
import { RulesService } from './services/rules.ts'
import { SettingsService } from './services/settings.ts'
import { SystemService } from './services/system.ts'

export const APP_NAME = 'CordClean'
export const APP_VERSION = '0.1.0'

export interface AppOptions {
  /** 数据目录，默认 `%LOCALAPPDATA%\\CordClean` */
  dataDir?: string
  /** 插件清单（测试可注入假插件） */
  manifest?: PluginManifestEntry[]
  /** 是否自动加载已启用的插件 */
  loadPlugins?: boolean
  /** 设置覆盖项（测试/便携模式） */
  settingsOverrides?: DeepPartial<Settings>
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
  /** 是否把日志转发到界面 */
  logForward?: boolean
  /** 是否启用日志（测试中可关闭） */
  logger?: boolean
}

export interface App {
  ctx: Context
  dataDir: string
  bootMs: number
  version: string
  dispose(): Promise<void>
}

/** 创建并启动内核 */
export async function createApp(options: AppOptions = {}): Promise<App> {
  const bootAt = Date.now()
  const dataDir = options.dataDir ?? process.env.CORDCLEAN_DATA ?? defaultDataDir()
  const env = await createTaskEnv(dataDir)
  const ctx = new Context()

  if (options.logger !== false) {
    setupLogger(ctx, {
      dataDir,
      level: options.logLevel ?? 'info',
      forward: options.logForward,
    })
  }

  // 依次装配核心服务：顺序即依赖顺序
  await ctx.plugin(SettingsService, { dataDir, overrides: options.settingsOverrides })
  await ctx.plugin(SystemService, { env })
  await ctx.plugin(PathPolicyService, {})
  await ctx.plugin(QuarantineService, { dataDir })
  await ctx.plugin(HistoryService, { dataDir })
  await ctx.plugin(RecycleBinService)
  await ctx.plugin(RulesService)
  await ctx.plugin(EvaluatorService)
  await ctx.plugin(CompensateService)
  await ctx.plugin(ExecutorService)
  await ctx.plugin(CleanerService)
  await ctx.plugin(PluginManagerService, { manifest: options.manifest ?? BUILTIN_MANIFEST })

  if (options.loadPlugins !== false) {
    await ctx.plugins.loadAll()
  }

  // 过期隔离文件清理放到后台，不阻塞启动
  void ctx.quarantine.purgeExpired().catch(() => {})

  const app: App = {
    ctx,
    dataDir,
    version: APP_VERSION,
    bootMs: Date.now() - bootAt,
    async dispose() {
      await ctx.fiber.dispose()
    },
  }

  ctx.logger.info('%s 内核启动完成，用时 %d ms，已加载 %d 个清理任务', APP_NAME, app.bootMs, ctx.cleaner.list().length)
  return app
}
