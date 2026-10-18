import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { folderSize } from '@cordclean/utils'
import { spawn } from 'node:child_process'
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
import type {
  AiLike,
  ApiMap,
  ApiMethod,
  ApiParams,
  ApiResult,
  CleanItem,
  CleanItemRef,
} from '@cordclean/shared'
import { dlog, exportDiagnostics, initDiagnostics, logDirPath, recentLogs } from './diagnostics.ts'
import { RpcError } from '@cordclean/shared'

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

/** 把界面回传的精简项补全为完整 CleanItem */
function toCleanItem(ref: CleanItemRef): CleanItem {
  return {
    id: ref.id,
    taskId: ref.taskId,
    path: ref.path,
    title: ref.title,
    kind: ref.kind,
    size: ref.size,
    risk: ref.risk,
    category: ref.category as CleanItem['category'],
    defaultSelected: true,
    note: ref.note,
    meta: ref.meta,
  }
}

/** 构造 RPC 处理方法表 */
export function createHandlers(api: ApiContext): HandlerMap {
  initDiagnostics(api.dataDir)
  const { ctx } = api

  const requireAi = (): AiLike => {
    const ai = (ctx as any).ai as AiLike | undefined
    if (!ai) throw new RpcError(-32002, 'AI 插件未启用，请先在「插件」页面启用 AI 清理顾问')
    return ai
  }

  return {
    'app/info': () => ({
      name: 'CordClean',
      version: api.version,
      node: process.versions.node,
      platform: process.platform,
      electron: api.shell.electron ? process.versions.electron : undefined,
      dataDir: api.dataDir,
      elevated: ctx.system.env.elevated,
      bootMs: api.bootMs,
    }),

    'app/open-path': async ({ path }) => {
      await api.shell.openPath(path)
    },

    'app/open-editor': async ({ path: target }) => {
      const command = ctx.settings.get().ui.editorCommand.trim()
      if (!command) {
        await api.shell.openPath(target)
        return
      }
      const child = spawn(command, [target], { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
    },
    'plugins/source': ({ id }) => {
      const source = ctx.plugins.sourcePath(id)
      if (!source) throw new Error('找不到该插件的源码路径（可能来自打包文件）')
      return { path: source }
    },
    'app/logs/recent': ({ limit }) => ({ lines: recentLogs(limit ?? 200) }),
    'app/logs/open': async () => {
      await api.shell.openPath(logDirPath())
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
      ;(ctx as any).emit('scheduler/authorize', patch, (config: Record<string, any>) => { next = config })
      if (!next) throw new Error('请先在插件页启用「定时扫描」')
      await ctx.plugins.updateConfig('scheduler', next)
      return { hash: String(next.authorizedHash ?? '') }
    },
    'scheduler/run': () => {
      ;(ctx as any).emit('scheduler/run')
      return { ok: true as const }
    },
    'scheduler/revoke': async () => {
      const plugin = ctx.plugins.list().find((item) => item.id === 'scheduler')
      const config = { ...(plugin?.config ?? {}), mode: 'scan', authorizedHash: '' }
      await ctx.plugins.updateConfig('scheduler', config)
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

    'clean/start': async ({ itemIds, items, dryRun, forceQuarantine }) => {
      if (items?.length) {
        return ctx.cleaner.clean({ items: items.map(toCleanItem), dryRun, forceQuarantine })
      }
      const result = await ctx.cleaner.clean({ itemIds, dryRun, forceQuarantine })
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
    'plugins/install': ({ path }) => ctx.plugins.installExternal(path),
  'plugins/uninstall': ({ id }) => ctx.plugins.uninstallExternal(id),
  'plugins/reload': async ({ id }) => {
      await ctx.plugins.reload(id)
    },
    'plugins/config': async ({ id, config }) => {
      await ctx.plugins.updateConfig(id, config)
    },
    'plugins/defaults': ({ id }) => ctx.plugins.defaults(id),

    'settings/get': () => ctx.settings.get(),
    'settings/patch': ({ patch }) => {
      ctx.settings.patch(patch as any)
      return ctx.settings.get()
    },
    'settings/set': ({ path, value }) => {
      ctx.settings.set(path, value)
      return ctx.settings.get()
    },

    'history/list': ({ limit }) => ctx.history.list(limit ?? 50),
    'history/totals': () => ctx.history.totals(),
    'history/clear': () => {
      ctx.history.clear()
    },

    'quarantine/list': () => ctx.quarantine.list(),
    'quarantine/restore': ({ ids }) => ctx.quarantine.restore(ids),
    'quarantine/purge': ({ ids }) => ctx.quarantine.purge(ids),
    'quarantine/stats': () => ctx.quarantine.stats(),

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
    'ai/rules/dry-run': async ({ suggestion }) => {
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
