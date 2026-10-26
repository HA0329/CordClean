import { moveFiles, elevatedCheckedAt } from '@cordclean/core'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { folderSize } from '@cordclean/utils'
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import os from 'node:os'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
/**
 * RPC 方法实现。
 *
 * 这一层把内核服务「翻译」成面向界面的 API，不包含任何传输相关代码：
 * - Web 外壳：由 `server.ts` 通过 WebSocket 调用；
 * - 桌面外壳：由 Electron 主进程通过 ipcMain 调用。
 *
 * 外壳差异（打开资源管理器、退出应用等）通过 `ShellAdapter` 注入，
 * 因此同一个 API 层可以在浏览器与 Electron 中复用。
 */
import type { Context } from 'cordis'
import { PROTOCOL_VERSION } from '@cordclean/shared'
import type {
  AiLike,
  ApiMap,
  ApiMethod,
  ApiParams,
  ApiResult,
} from '@cordclean/shared'
import { dlog, exportDiagnostics, exportDiagnosticsJson, initDiagnostics, logDirPath, logFileStats, recentLogEntries, recentLogs } from './diagnostics.ts'
import {
  cleanupGeneratedPlugin,
  cleanupGeneratedPlugins,
  generatedPluginPath,
  installPluginDependencies,
  isGeneratedPluginPath,
  saveGeneratedPlugin,
  validatePluginCode,
} from './plugin-workshop.ts'
import { RpcError } from '@cordclean/shared'
import { validateAiPluginPackage, writeAiPluginPackage } from './ai-plugin-package.ts'

/** 读取系统 PATH 中的 Node 版本；Electron 内置 Node 与系统 Node 可能不同 */
let systemNodePromise: Promise<string | undefined> | null = null

function detectSystemNode(): Promise<string | undefined> {
  if (systemNodePromise) return systemNodePromise
  systemNodePromise = new Promise((resolve) => {
    if (!process.versions.electron) {
      resolve(process.versions.node)
      return
    }
    execFile('node', ['--version'], { timeout: 2000, windowsHide: true }, (error, stdout) => {
      resolve(error ? undefined : String(stdout).trim().replace(/^v/, ''))
    })
  })
  return systemNodePromise
}

function platformLabel(): string {
  if (process.platform === 'win32') {
    const parts = os.release().split('.')
    if (parts[0] === '10' && Number(parts[2] ?? 0) >= 22000) return 'Windows 11'
    if (parts[0] === '10') return 'Windows 10'
    return 'Windows ' + os.release()
  }
  return os.type() + ' ' + os.release()
}

/** 外壳能力适配器（不同运行环境的系统交互） */
export interface ShellAdapter {
  /** 是否运行在 Electron 中 */
  electron: boolean
  /** 用系统默认方式打开文件/目录 */
  openPath(target: string): Promise<void>
  /** 打开数据目录 */
  openDataDir(target: string): Promise<void>
}

export interface ApiContext {
  ctx: Context
  dataDir: string
  version: string
  bootMs: number
  shell: ShellAdapter
}

export type HandlerMap = { [M in ApiMethod]: (params: ApiParams<M>) => Promise<ApiResult<M>> | ApiResult<M> }

/** 构造 RPC 处理方法表 */
export function createHandlers(api: ApiContext): HandlerMap {
  initDiagnostics(api.dataDir)
  // 源码按钮：优先返回可打开/可读取的源码文件；只有目录时才退回目录
  const resolveSourceFile = (id: string): string => {
    const source = ctx.plugins.sourcePath(id)
    if (!source) throw new Error('找不到该插件的源码路径（可能来自打包文件）')
    const candidates = /\.(mjs|js|ts)$/i.test(source)
      ? [source]
      : [path.join(source, 'src', 'index.ts'), path.join(source, 'index.mjs'), path.join(source, 'index.js'), source]
    return candidates.find((item) => existsSync(item)) ?? source
  }
  // 外部插件不是跨进程持久加载的旧行为已修复：settings 里记录了 externalPath，
  // 启动加载后只清理真正没有持久化记录的工坊残留。
  const persistedExternalPaths = Object.values(api.ctx.settings.get().plugins ?? {})
    .map((item) => item?.externalPath)
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
  cleanupGeneratedPlugins(api.dataDir, persistedExternalPaths)
  const UNDO_FILE = path.join(api.dataDir, '.undo', 'last-clean.json')
  const saveUndo = (report: any): void => {
    if (report.dryRun || !Array.isArray(report.undo) || !report.undo.length) return
    mkdirSync(path.dirname(UNDO_FILE), { recursive: true })
    writeFileSync(UNDO_FILE, JSON.stringify({ at: Date.now(), sessionId: report.sessionId, items: report.undo }), 'utf8')
  }
  const readUndo = (): any | null => {
    try {
      return JSON.parse(readFileSync(UNDO_FILE, 'utf8'))
    } catch {
      return null
    }
  }

  const { ctx } = api

  const requireAi = (): AiLike => {
    const ai = (ctx as any).ai as AiLike | undefined
    if (!ai) throw new RpcError(-32002, 'AI 插件未启用，请先在「插件」页面启用 AI 清理顾问')
    return ai
  }

  return {
    'app/info': async () => {
      const systemNode = await detectSystemNode()
      const runtimeNode = process.versions.node
      return {
        name: 'CordClean',
        version: api.version,
        node: runtimeNode,
        nodeRuntime: process.versions.electron ? ('electron' as const) : ('node' as const),
        systemNode: systemNode && systemNode !== runtimeNode ? systemNode : undefined,
        platform: process.platform,
        platformLabel: platformLabel(),
        osRelease: os.release(),
        osVersion: typeof os.version === 'function' ? os.version() : undefined,
        arch: process.arch,
        electron: api.shell.electron ? process.versions.electron : undefined,
        shell: api.shell.electron ? ('desktop' as const) : ('web' as const),
        dataDir: api.dataDir,
        elevated: ctx.system.env.elevated,
        elevatedCheckedAt: elevatedCheckedAt(),
        bootMs: api.bootMs,
        protocolVersion: PROTOCOL_VERSION,
      }
    },

    'app/open-path': async ({ path }) => {
      await api.shell.openPath(path)
    },

    'app/open-editor': async ({ path: target }) => {
      const command = ctx.settings.get().ui.editorCommand.trim()
      if (!command) {
        await api.shell.openPath(target)
        return
      }
      // 编辑器命令可能是 GUI 程序（常驻）也可能是错命令（立刻非 0 退出）。
      // 等 spawn / error / 早期 exit：失败时回退到系统默认方式，避免“提示已打开但什么也没发生”。
      const child = spawn(command, [target], { detached: true, stdio: 'ignore', windowsHide: true })
      const fallback = await new Promise<boolean>((resolve) => {
        let settled = false
        const finish = (needFallback: boolean) => {
          if (settled) return
          settled = true
          resolve(needFallback)
        }
        child.once('error', () => finish(true))
        child.once('spawn', () => setTimeout(() => finish(false), 300))
        child.once('exit', (code) => {
          if (code !== 0) finish(true)
        })
        setTimeout(() => finish(false), 800)
      })
      if (fallback) {
        dlog('warn', 'open-editor', '编辑器命令不可用，回退系统默认打开', { command, target })
        await api.shell.openPath(target)
      }
    },
    'plugins/source': ({ id }) => ({ path: resolveSourceFile(id) }),
    'plugins/source-content': ({ id }) => {
      const target = resolveSourceFile(id)
      const info = statSync(target)
      if (!info.isFile()) throw new Error('该插件源码是目录，请在资源管理器中打开')
      const limit = 512 * 1024
      const raw = readFileSync(target)
      return {
        path: target,
        content: raw.subarray(0, limit).toString('utf8'),
        bytes: raw.length,
        truncated: raw.length > limit,
      }
    },
    'app/logs/recent': ({ limit }) => ({ lines: recentLogs(limit ?? 200) }),
    'app/logs/info': () => logFileStats(),
    'app/logs/entries': ({ limit }) => recentLogEntries(limit ?? 500),
    'app/logs/open': async () => {
      await api.shell.openPath(logDirPath())
    },
    'app/logs/export-json': async () => {
      const file = exportDiagnosticsJson({
        version: api.version,
        dataDir: api.dataDir,
        platform: process.platform,
        node: process.versions.node,
        electron: process.versions.electron ?? null,
        shell: api.shell.electron ? 'desktop' : 'web',
        plugins: ctx.plugins.list().map((plugin) => ({ id: plugin.id, enabled: plugin.enabled, status: plugin.status, error: plugin.error })),
        tasks: ctx.cleaner.list().length,
        logging: ctx.settings.get().logging,
      })
      return { path: file }
    },
    'app/logs/export': async () => {
      const file = exportDiagnostics({
        version: api.version,
        dataDir: api.dataDir,
        platform: process.platform,
        node: process.versions.node,
        electron: process.versions.electron ?? null,
        plugins: ctx.plugins.list().map((plugin) => ({ id: plugin.id, enabled: plugin.enabled, status: plugin.status, error: plugin.error })),
        tasks: ctx.cleaner.list().length,
        settings: {
          clean: ctx.settings.get().clean,
          scan: ctx.settings.get().scan,
          rules: ctx.settings.get().rules.includeRisky,
          privacy: ctx.settings.get().privacy,
        },
      })
      return { path: file }
    },
    'scheduler/authorize': async (patch) => {
      let next: Record<string, any> | undefined
      ;(ctx as any).emit('scheduler/authorize', patch ?? {}, (config: Record<string, any>) => { next = config })
      if (!next) throw new Error('请先在插件页启用「定时扫描」')
      await ctx.plugins.updateConfig('scheduler', next)
      return { hash: String(next.authorizedHash ?? '') }
    },
    'scheduler/run': ({ planId } = {}) => {
      ;(ctx as any).emit('scheduler/run', planId)
      return { ok: true as const }
    },
    'scheduler/revoke': async ({ planId } = {}) => {
      // 交给插件处理：必须同时清空 plans[] 里的授权，否则多计划配置下会“撤销不了”
      let next: Record<string, any> | undefined
      ;(ctx as any).emit('scheduler/revoke', planId, (config: Record<string, any>) => { next = config })
      if (!next) throw new Error('请先在插件页启用「定时扫描」')
      await ctx.plugins.updateConfig('scheduler', next)
      return { ok: true as const }
    },
    'app/quit': async () => {
      setTimeout(() => process.exit(0), 300)
      return { ok: true as const }
    },
    'app/open-data-dir': async () => {
      await api.shell.openDataDir(api.dataDir)
      return api.dataDir
    },

    'system/info': () => ctx.system.info(),
    'system/live': () => ctx.system.live(),
    'system/hotspots': () => ctx.system.hotspots(),

    'tasks/list': () => ctx.cleaner.list(),

    'scan/start': async ({ taskIds }) => {
      dlog('info', 'scan', '开始扫描', { taskIds: taskIds ?? 'all' })
      const report = await ctx.cleaner.scan({ taskIds })
      dlog('info', 'scan', '扫描完成', { items: report.items.length, bytes: report.stats.bytes, errors: report.errors.length, ms: report.elapsedMs })
      return report
    },
    'scan/cancel': () => {
      ctx.cleaner.cancelScan()
    },
    'scan/last': () => ctx.cleaner.lastScan() ?? null,

    'files/move': ({ paths, targetDir, link }) =>
      moveFiles(
        { paths, targetDir },
        {
          check: (target) => ctx.pathPolicy.check(target),
          isProtected: (target) => ctx.pathPolicy.isProtected(target),
          link: link === true,
        },
      ),
    'clean/undo-state': () => {
      const state = readUndo()
      if (!state?.items?.length) return { available: false, quarantine: 0, recycle: 0, permanent: 0 }
      const quarantine = state.items.filter((item: any) => item.mode === 'quarantine').length
      return {
        // 只有「隔离区项」才可通过本接口真正恢复；回收站/永久删除项不能在这里撤销
        available: quarantine > 0,
        at: state.at,
        quarantine,
        recycle: state.items.filter((item: any) => item.mode === 'recycle').length,
        permanent: state.items.filter((item: any) => item.mode === 'delete').length,
      }
    },
    'clean/undo': async () => {
      const state = readUndo()
      if (!state?.items?.length) return { restored: 0, recyclePending: 0, permanent: 0, failed: 0 }
      const quarantinePaths = new Set(state.items.filter((item: any) => item.mode === 'quarantine').map((item: any) => item.path))
      const entries = (await ctx.quarantine.list()).filter((entry) => quarantinePaths.has(entry.originalPath))
      const result = await ctx.quarantine.restore(entries.map((entry) => entry.id))
      const recyclePending = state.items.filter((item: any) => item.mode === 'recycle').length
      const permanent = state.items.filter((item: any) => item.mode === 'delete').length
      // 只有全部隔离项都恢复成功才清空撤销凭据；部分失败时保留，允许用户重试
      if (result.failed.length === 0) rmSync(UNDO_FILE, { force: true })
      else dlog('warn', 'undo', '部分隔离项恢复失败，保留撤销凭据', { failed: result.failed.length })
      return { restored: result.restored, recyclePending, permanent, failed: result.failed.length }
    },
    // 只接受 itemIds：从最近一次扫描结果解析清理项，绝不信任界面回传的路径/大小/风险
    'clean/start': async ({ itemIds, dryRun, forceQuarantine }) => {
      const result = await ctx.cleaner.clean({ itemIds, dryRun, forceQuarantine })
      saveUndo(result)
      dlog('info', 'clean', '清理完成', { mode: result.mode, cleaned: result.cleaned, freed: result.freedBytes, recycled: result.recycledBytes, failed: result.failed })
      return result
    },
    'clean/cancel': () => {
      ctx.cleaner.cancelClean()
    },

    'plugins/list': () => ctx.plugins.list(),
    'plugins/enable': async ({ id }) => {
      await ctx.plugins.enable(id)
    },
    'plugins/disable': async ({ id }) => {
      await ctx.plugins.disable(id)
    },
    'plugins/install': ({ path, allowCustomClean }) => ctx.plugins.installExternal(path, { allowCustomClean: allowCustomClean === true }),
    'plugins/install-native': async ({ path }) => {
      if (typeof ctx.plugins.installNativePlugin !== 'function') throw new Error('当前插件管理器不支持原生外部插件')
      return ctx.plugins.installNativePlugin(path)
    },
    'ui/contributions': () => ctx.ui.list(),
    'ui/resolve': ({ pluginId, id, params }) => ctx.ui.resolveValue(pluginId, id, params),
    'ui/command': ({ pluginId, id, params }) => ctx.ui.runCommand(pluginId, id, params),
    'plugins/uninstall': async ({ id }) => {
      const source = ctx.plugins.sourcePath(id)
      await ctx.plugins.uninstallExternal(id)
      if (source && isGeneratedPluginPath(api.dataDir, source)) {
        try {
          // 有依赖时 source 是 .../<name>/plugin.mjs，需要删除整个 <name> 目录
          const dir = path.dirname(source)
          if (path.basename(source) === 'plugin.mjs') rmSync(dir, { recursive: true, force: true })
          else rmSync(source, { force: true })
        } catch {
          /* 插件卸载已成功，删除文件失败只影响残留 */
        }
      }
    },
  'plugins/reload': async ({ id }) => {
      await ctx.plugins.reload(id)
    },
    'plugins/config': async ({ id, config }) => {
      await ctx.plugins.updateConfig(id, config)
    },
    'plugins/defaults': ({ id }) => ctx.plugins.defaults(id),
    'plugins/inspect-package': async ({ path: sourceDir }) => {
      if (typeof ctx.plugins.inspectPackage !== 'function') throw new Error('当前插件管理器不支持 v2 插件包')
      return ctx.plugins.inspectPackage(String(sourceDir ?? ''))
    },
    'plugins/install-package': async ({ path: sourceDir, enable, upgrade }) => {
      if (typeof ctx.plugins.installPackage !== 'function') throw new Error('当前插件管理器不支持 v2 插件包')
      return ctx.plugins.installPackage(String(sourceDir ?? ''), { enable, upgrade })
    },
    'plugins/uninstall-package': async ({ id }) => {
      if (typeof ctx.plugins.uninstallPackage !== 'function') throw new Error('当前插件管理器不支持 v2 插件包')
      await ctx.plugins.uninstallPackage(id)
    },
    'plugins/package-problems': () => ctx.plugins.packageProblems?.() ?? [],
    'plugins/client-url': ({ id }) => {
      const page = ctx.plugins.clientPage?.(id)
      if (!page) throw new Error('该插件没有客户端页面（client.mode=page）')
      const segments = page.entry
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/')
      // Web 外壳与界面同源，走宿主 HTTP 静态路由；Electron 走主进程注册的自定义协议
      const url = api.shell.electron
        ? `cordclean-plugin://${page.pluginId}/${segments}`
        : `/plugin-assets/${page.pluginId}/${segments}`
      return { url, entry: page.entry }
    },

    'settings/get': () => ctx.settings.get(),
    'settings/patch': ({ patch }) => {
      ctx.settings.patch(patch as any)
      return ctx.settings.get()
    },
    'settings/set': ({ path, value }) => {
      ctx.settings.set(path, value)
      return ctx.settings.get()
    },

    'history/sessions': () => ctx.history.sessions(),
    'history/list': ({ limit }) => ctx.history.list(limit ?? 50),
    'history/totals': () => ctx.history.totals(),
    'history/clear': () => {
      ctx.history.clear()
    },

    'quarantine/list': () => ctx.quarantine.list(),
    'quarantine/restore': ({ ids }) => ctx.quarantine.restore(ids),
    'quarantine/purge': ({ ids }) => ctx.quarantine.purge(ids),
    'quarantine/stats': () => ctx.quarantine.stats(),

    'ai/cancel': () => { ctx.ai?.cancelAnalyze?.() },
    'ai/analyze': async (params) => requireAi().analyze(params),
    'ai/last': () => {
      const ai = (ctx as any).ai
      return ai?.last?.() ?? null
    },
    'ai/status': () => {
      const ai = (ctx as any).ai
      if (!ai) {
        return {
          available: false,
          configured: false,
          shape: 'chat',
          baseUrl: '',
          model: '',
          effort: 'auto',
          jsonMode: 'auto',
          models: [],
        }
      }
      return ai.status()
    },
    'ai/models': async ({ refresh }) => requireAi().models({ refresh }),
    'ai/probe': () => requireAi().probe(),
    'ai/plugin/draft': async ({ requirement }) => {
      // 兼容旧入口：优先走独立的「AI 插件工坊」插件
      const workshop = (ctx as unknown as { aiWorkshop?: { draftPlugin?(text: string): Promise<any> } }).aiWorkshop
      if (workshop?.draftPlugin) return workshop.draftPlugin(String(requirement ?? ''))
      if (!ctx.ai?.draftPlugin) throw new Error('AI 插件未启用或版本过旧')
      return ctx.ai.draftPlugin(String(requirement ?? ''))
    },
    'ai/workshop/status': () => {
      const workshop = (
        ctx as unknown as { aiWorkshop?: { status?(): import('@cordclean/shared').AiWorkshopStatus } }
      ).aiWorkshop
      if (!workshop?.status) {
        return {
          available: false,
          configured: false,
          model: '',
          aiModel: '',
          inheritsModel: false,
          shape: '',
          baseUrl: '',
          maxTokens: 65_536,
          retries: 1,
          timeoutMs: 180_000,
          systemPromptExtra: '',
          apiKeySource: 'none',
          effort: 'auto',
          jsonMode: 'auto',
        }
      }
      return workshop.status()
    },
    'ai/workshop/draft': async ({ requirement }) => {
      const workshop = (ctx as unknown as { aiWorkshop?: { draftPlugin?(text: string): Promise<any> } }).aiWorkshop
      if (!workshop?.draftPlugin) {
        throw new Error('「AI 插件工坊」插件未启用：请在插件页启用它')
      }
      return workshop.draftPlugin(String(requirement ?? ''))
    },
    'ai/workshop/models': async ({ refresh }) => {
      const workshop = (
        ctx as unknown as { aiWorkshop?: { models?(refresh: boolean): Promise<{ source: 'remote' | 'fallback'; models: any[] }> } }
      ).aiWorkshop
      if (!workshop?.models) return { source: 'fallback', models: [] }
      return workshop.models(refresh === true)
    },
    'ai/plugin/validate': async ({ code, dependencies, native, format, manifest, files }) => {
      const wantsPackage = format === 'package' || Boolean(manifest) || Boolean(files?.length)
      if (!wantsPackage) {
        return validatePluginCode(String(code ?? ''), dependencies ?? {}, native === true ? 'native' : 'worker')
      }
      const validation = await validateAiPluginPackage(
        {
          name: manifest?.id ?? 'ai-plugin',
          code: String(code ?? ''),
          notes: '',
          dependencies: dependencies ?? {},
          mode: 'native',
          format: 'package',
          manifest,
          files,
        },
        api.version,
      )
      return { ok: validation.ok, errors: validation.errors, warnings: validation.warnings }
    },
    'ai/plugin/install': async (params) => {
      const {
        name,
        code,
        dependencies,
        acknowledgeDependencies,
        native,
        format,
        manifest,
        files,
        acknowledgePermissions,
      } = params
      const deps = dependencies ?? {}
      const wantsPackage = format === 'package' || Boolean(manifest) || Boolean(files?.length)
      if (wantsPackage) {
        const draft = {
          name: String(name ?? ''),
          code: String(code ?? ''),
          notes: '',
          dependencies: deps,
          mode: 'native' as const,
          format: 'package' as const,
          manifest,
          files,
        }
        const validation = await validateAiPluginPackage(draft, api.version)
        if (!validation.ok) {
          throw new Error('插件包校验未通过：' + validation.errors.slice(0, 3).join('；'))
        }
        if (acknowledgePermissions !== true) {
          throw new Error('该插件包以宿主用户权限运行，需要先确认清单与权限（acknowledgePermissions）')
        }
        const dependencyCount = Object.keys(validation.manifest!.dependencies ?? {}).length
        if (dependencyCount > 0 && acknowledgeDependencies !== true) {
          throw new Error(`该插件包声明了 ${dependencyCount} 个第三方依赖，需要先确认依赖清单并勾选“允许下载依赖”`)
        }
        if (typeof ctx.plugins.installPackage !== 'function') throw new Error('当前插件管理器不支持 v2 插件包')
        const installedId = 'external:' + validation.manifest!.id
        if (ctx.plugins.list().some((item) => item.id === installedId)) {
          throw new Error('同名插件已安装，请先在插件页卸载后再安装')
        }
        const tempDir = path.join(
          api.dataDir,
          '.ai-packages',
          `${validation.manifest!.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        )
        try {
          await writeAiPluginPackage(tempDir, validation)
          const result = await ctx.plugins.installPackage(tempDir, {
            enable: true,
            ...(dependencyCount > 0
              ? {
                  prepareStaging: async (stagingDir: string, stagingManifest: typeof validation.manifest) => {
                    writeFileSync(
                      path.join(stagingDir, 'package.json'),
                      JSON.stringify(
                        {
                          name: 'cordclean-ai-' + stagingManifest!.id,
                          version: '0.0.0',
                          private: true,
                          type: 'module',
                          dependencies: stagingManifest!.dependencies,
                        },
                        null,
                        2,
                      ) + '\n',
                      'utf8',
                    )
                    await installPluginDependencies(path.join(stagingDir, stagingManifest!.entry))
                  },
                }
              : {}),
          })
          return {
            path: path.join(api.dataDir, 'plugins', result.manifest.id),
            id: result.id,
            manifest: result.manifest,
          }
        } finally {
          await rm(tempDir, { recursive: true, force: true }).catch(() => {})
        }
      }
      const mode = native === true ? 'native' : 'worker'
      const checked = await validatePluginCode(String(code ?? ''), deps, mode)
      if (!checked.ok) throw new Error(checked.errors[0] ?? '校验未通过')
      const dependencyCount = Object.keys(deps).length
      if (dependencyCount > 0 && acknowledgeDependencies !== true) {
        throw new Error(`该插件声明了 ${dependencyCount} 个第三方依赖，需要先确认依赖清单并勾选“允许下载依赖”`)
      }
      const target = generatedPluginPath(api.dataDir, name, deps)
      const targetDir = path.dirname(target)
      // 已加载的同名插件不能覆盖；先让用户在插件页卸载
      const loaded = ctx.plugins.list().find((plugin) => {
        const source = ctx.plugins.sourcePath(plugin.id)
        if (!source) return false
        return dependencyCount > 0
          ? path.resolve(source).startsWith(path.resolve(targetDir) + path.sep)
          : path.resolve(source) === path.resolve(target)
      })
      if (loaded) throw new Error('同名插件已安装，请先在插件页卸载后再安装')
      // 清理上一次失败留下的残留，再写本次文件
      cleanupGeneratedPlugin(api.dataDir, name, deps)
      const file = saveGeneratedPlugin(api.dataDir, name, String(code), deps)
      let installedId = 'external:' + String(name).replace(/[^a-zA-Z0-9_-]/g, '-')
      try {
        if (dependencyCount > 0) await installPluginDependencies(file)
        if (mode === 'native') {
          if (typeof ctx.plugins.installNativePlugin !== 'function') throw new Error('当前插件管理器不支持原生插件')
          const result = await ctx.plugins.installNativePlugin(file)
          installedId = result.id
        } else {
          await ctx.plugins.installExternal(file)
        }
      } catch (error) {
        // 失败回滚：如果插件已被部分注册则卸载，再删除本次生成的插件目录/文件
        try {
          for (const plugin of ctx.plugins.list()) {
            const source = ctx.plugins.sourcePath(plugin.id)
            if (!source) continue
            const resolved = path.resolve(source)
            if (resolved === path.resolve(target) || (dependencyCount > 0 && resolved.startsWith(path.resolve(targetDir) + path.sep))) {
              await ctx.plugins.uninstallExternal(plugin.id)
            }
          }
        } catch {
          /* 回滚失败不掩盖原始错误 */
        }
        cleanupGeneratedPlugin(api.dataDir, name, deps)
        throw new Error('插件安装失败（已清理本次生成的插件文件）：' + (error instanceof Error ? error.message : String(error)))
      }
      return { path: file, id: installedId }
    },    'ai/rules/dry-run': async ({ suggestion }) => {
      // 只读演练：不写规则库、不删除，只报告会命中什么
      const env = ctx.system.env
      const expand = (value: string) =>
        String(value)
          .replace(/^~[\\/]/, env.userProfile + '\\')
          .replace(/%([^%]+)%/g, (whole, name: string) => env.get(name) ?? whole)
      const target: any = suggestion.target ?? {}
      const bases: string[] = [target.path, ...(target.paths ?? []), target.base, ...(target.bases ?? [])]
        .filter(Boolean)
        .map((item: unknown) => expand(String(item)))
      const isGlob = String(target.type ?? '').includes('glob')
      const samples: Array<{ path: string; bytes: number; kind: string }> = []
      const missing: string[] = []
      let bytes = 0
      let count = 0
      for (const base of bases.slice(0, 8)) {
        try {
          if (isGlob && /[*?]/.test(base)) {
            const dir = path.dirname(base)
            const pattern = path.basename(base)
            const escaped = pattern.replace(/[.+^|[\\]\\\\]/g, '\\\\$&')
            const regex = new RegExp('^' + escaped.replace(/\\*/g, '.*').replace(/\\?/g, '.') + '$', 'i')
            for (const entry of await readdir(dir, { withFileTypes: true })) {
              if (!regex.test(entry.name)) continue
              const full = path.join(dir, entry.name)
              const size = entry.isDirectory() ? (await folderSize(full, { maxEntries: 5000 })).bytes : (await stat(full)).size
              count += 1
              bytes += size
              if (samples.length < 30) samples.push({ path: full, bytes: size, kind: entry.isDirectory() ? 'dir' : 'file' })
            }
            continue
          }
          const info = await stat(base)
          const size = info.isDirectory() ? (await folderSize(base, { maxEntries: 20000 })).bytes : info.size
          count += 1
          bytes += size
          if (samples.length < 30) samples.push({ path: base, bytes: size, kind: info.isDirectory() ? 'dir' : 'file' })
        } catch {
          missing.push(base)
        }
      }
      return { ok: count > 0, reason: count > 0 ? undefined : '没有命中任何文件或目录', count, bytes, samples, missing }
    },
  'ai/apply-rule': async ({ suggestion }) => {
    const rule: any = {
      id: 'ai-' + Date.now().toString(36),
      category: suggestion.category || 'ai-custom',
      categoryLabel: suggestion.categoryLabel ?? suggestion.category ?? 'AI 建议',
      categoryId: 'apps',
      name: suggestion.name,
      risk: suggestion.risk,
      source: 'ai',
      version: 1,
      target: suggestion.target,
      note: suggestion.reason,
    }
    const errors = ctx.rules.validate([rule]).filter((issue) => issue.level === 'error')
    if (errors.length) return { applied: false as const, reason: errors[0].message }
    const roots = [rule.target.path, ...(rule.target.paths ?? []), rule.target.base, ...(rule.target.bases ?? [])].filter(Boolean).map(String)
    const clear = rule.target.type === 'clear_dir' || (rule.target.type === 'glob_dirs' && rule.target.action !== 'delete')
    for (const root of roots) {
      if (!clear && ctx.pathPolicy.isProtected(root)) return { applied: false as const, reason: '目标位于受保护目录：' + root }
    }
    const current = ctx.settings.get().rules.custom ?? []
    ctx.settings.patch({ rules: { custom: [...current, rule] } })
    await ctx.plugins.reload('rule-pack').catch(() => undefined)
    return { applied: true as const, ruleId: rule.id }
  },
  'ai/egress': async ({ limit }) => ({
    stats: ctx.egress.stats(),
    records: ctx.egress.preview().slice(0, Math.max(1, Math.min(20, limit ?? 5))),
  }),
  'ai/egress/clear': () => {
    ctx.egress.reset()
    return { ok: true as const }
  },
  }
}
