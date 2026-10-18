/**
 * AI 上下文采集器（`ctx.aiContext`）。
 *
 * 目的：让 AI 不只是看到磁盘数字，还能拿到"哪些区域最占空间""装了什么软件"这类结构化摘要。
 * 约束：
 * - 采集器只能输出**脱敏摘要**（软件名、分区标签、体积、数量），不输出完整路径与文件名；
 * - 注册即副作用：通过 `ctx.effect` 绑到插件生命周期；
 * - 采集结果按段落（section）组织，界面可以逐段开关。
 */
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { Service, type Context } from 'cordis'
import type { AiContextLike, AiContextProviderInfo, AiContextSection } from '@cordclean/shared'
import { formatBytes } from '@cordclean/shared'
import { folderSize, mapLimit } from '@cordclean/utils'

export interface AiContextProvider {
  id: string
  name: string
  description?: string
  defaultEnabled?: boolean
  collect(ctx: Context): Promise<AiContextSection> | AiContextSection
}

/** 常见系统缓存目录的体积（只报标签和体积，不报路径） */
const HOTSPOT_MAX = 12

function cleanLines(lines: string[]): string[] {
  return lines.map((line) => line.trim()).filter(Boolean).slice(0, 40)
}

export class AiContextService extends Service implements AiContextLike {
  static inject = ['system']

  private providers = new Map<string, AiContextProvider>()
  private appsCache?: { at: number; lines: string[] }

  constructor(ctx: Context) {
    super(ctx, 'aiContext')
    // 内置采集器：热点体积、已安装软件（后续可继续加）
    this.providers.set('hotspots', {
      id: 'hotspots',
      name: '磁盘热点',
      description: '最占空间的缓存/临时目录（只报标签与体积）',
      defaultEnabled: true,
      async collect(serviceCtx: Context) {
        const hotspots = await serviceCtx.system.hotspots()
        const top = [...hotspots].sort((a, b) => b.bytes - a.bytes).slice(0, HOTSPOT_MAX)
        return {
          id: 'hotspots',
          title: '磁盘热点（可清理候选）',
          lines: cleanLines(top.map((item) => `${item.label}：${formatBytes(item.bytes)}`)),
        }
      },
    })
    this.providers.set('installed-apps', {
      id: 'installed-apps',
      name: '已安装软件',
      description: '从常见安装目录统计软件名与体积（不含路径、不含用户数据）',
      defaultEnabled: true,
      collect: async (serviceCtx: Context) => {
        const now = Date.now()
        if (this.appsCache && now - this.appsCache.at < 10 * 60_000) {
          return { id: 'installed-apps', title: '已安装软件（部分，按体积）', lines: this.appsCache.lines }
        }
        const env = serviceCtx.system.env
        const roots = [
          env.get('ProgramFiles'),
          env.get('ProgramFiles(x86)'),
          env.get('ProgramW6432'),
          path.join(env.localAppData, 'Programs'),
        ].filter((value): value is string => !!value)
        const entries: Array<{ name: string; dir: string }> = []
        const seen = new Set<string>()
        for (const root of roots) {
          try {
            for (const entry of await readdir(root, { withFileTypes: true })) {
              if (!entry.isDirectory()) continue
              if (entry.name.startsWith('.') || seen.has(entry.name.toLowerCase())) continue
              if (/^(Windows|Common Files|WindowsApps|Microsoft|Temp|Package Cache)$/i.test(entry.name)) continue
              seen.add(entry.name.toLowerCase())
              entries.push({ name: entry.name, dir: path.join(root, entry.name) })
            }
          } catch {
            /* 忽略不可读目录 */
          }
        }
        const measured = await mapLimit(entries.slice(0, 40), 4, async (entry) => {
          const size = await folderSize(entry.dir, { maxEntries: 4000 }).catch(() => ({ bytes: 0 }))
          return { name: entry.name, bytes: size.bytes ?? 0 }
        })
        const lines = measured
          .filter((item) => item.bytes > 1024 * 1024)
          .sort((a, b) => b.bytes - a.bytes)
          .slice(0, 15)
          .map((item) => `${item.name}：${formatBytes(item.bytes)}`)
        this.appsCache = { at: now, lines }
        return { id: 'installed-apps', title: '已安装软件（部分，按体积）', lines }
      },
    })
  }

  /** 注册采集器（插件用）；返回注销函数 */
  addProvider(provider: AiContextProvider): () => void {
    if (!provider?.id) throw new Error('采集器必须提供 id')
    this.providers.set(provider.id, provider)
    return () => {
      this.providers.delete(provider.id)
    }
  }

  /** 当前可用采集器（供界面渲染开关） */
  list(): AiContextProviderInfo[] {
    return [...this.providers.values()].map((provider) => ({
      id: provider.id,
      name: provider.name,
      description: provider.description,
      defaultEnabled: provider.defaultEnabled !== false,
    }))
  }

  /** 采集；enabled 为空时使用各采集器的默认开关 */
  async collect(enabled?: string[]): Promise<AiContextSection[]> {
    const selected = enabled?.length ? new Set(enabled) : undefined
    const sections: AiContextSection[] = []
    for (const provider of this.providers.values()) {
      if (selected && !selected.has(provider.id)) continue
      if (!selected && provider.defaultEnabled === false) continue
      try {
        const section = await provider.collect(this.ctx)
        const lines = cleanLines(section.lines ?? [])
        if (lines.length) sections.push({ ...section, lines })
      } catch (error) {
        this.ctx.logger.warn('采集器 %s 失败：%s', provider.id, String(error))
      }
    }
    return sections
  }
}
