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

    'scan/start': async ({ taskIds }) => ctx.cleaner.scan({ taskIds }),
    'scan/cancel': () => {
      ctx.cleaner.cancelScan()
    },
    'scan/last': () => ctx.cleaner.lastScan() ?? null,

    'clean/start': async ({ itemIds, items, dryRun, forceQuarantine }) => {
      if (items?.length) {
        return ctx.cleaner.clean({ items: items.map(toCleanItem), dryRun, forceQuarantine })
      }
      return ctx.cleaner.clean({ itemIds, dryRun, forceQuarantine })
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
