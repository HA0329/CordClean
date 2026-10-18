/**
 * 缩略图与图标缓存清理插件（thumbnails）。
 *
 * Windows 资源管理器会把图片/视频缩略图、文件图标缓存到
 * `%LOCALAPPDATA%\Microsoft\Windows\Explorer` 目录下的 `thumbcache_*.db` /
 * `iconcache_*.db` 文件里，用于加速文件夹浏览。这些文件完全可再生，
 * 属于典型的「可安全清理的缓存」。
 *
 * 注意点：
 * 1. 缓存文件长期被 explorer.exe 打开着，删除时可能失败 —— 因此风险等级为
 *    `caution`，并在每一项上给出「重启资源管理器」的提示，而不是硬删；
 * 2. 本任务只上报文件、不自定义 clean，删除动作交给内核的通用文件删除引擎
 *    （它会自动遵守路径策略、隔离区与失败重试）；
 * 3. 目录或匹配文件不存在时正常返回 0 项，不抛错。
 */
import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import Schema from 'schemastery'
import { defineCleanerPlugin } from '@cordclean/shared'
import { errorMessage, exists, pathKey, safeLstat, toLongPath, walk } from '@cordclean/utils'

export interface ThumbnailsConfig {
  /** 是否同时清理图标缓存（iconcache_*.db） */
  includeIconCache: boolean
}

const Config = Schema.object({
  includeIconCache: Schema.boolean()
    .default(true)
    .description('同时清理图标缓存（iconcache_*.db）；删除后任务栏与开始菜单的图标会短暂重建'),
})

/** 所有缓存文件的统一提示（文件被 explorer.exe 占用是常态） */
const BUSY_NOTE = '资源管理器正在使用该文件，删除失败时请重启资源管理器'

/** 缓存文件分组：thumbcache_*.db / iconcache_*.db / 其它 *.db（兜底） */
type CacheGroup = 'thumbnail' | 'icon' | 'other'

interface CacheFile {
  path: string
  name: string
  group: CacheGroup
}

/** 判断一个文件名属于哪一类缓存；返回 undefined 表示不是清理目标 */
function classify(name: string): CacheGroup | undefined {
  if (!/\.db$/i.test(name)) return undefined
  if (/^thumbcache_/i.test(name)) return 'thumbnail'
  if (/^iconcache_/i.test(name)) return 'icon'
  // 兜底：Explorer 目录下其它 .db 缓存（例如未来版本新增的缓存文件）
  return 'other'
}

export default defineCleanerPlugin<ThumbnailsConfig>({
  name: 'thumbnails',
  version: '1.0.0',
  description: '清理 Windows 资源管理器的缩略图缓存与图标缓存',
  inject: ['cleaner', 'pathPolicy', 'system'],
  Config,
  setup(ctx, config) {
    const env = ctx.system.env
    /** 缓存目录：%LOCALAPPDATA%\Microsoft\Windows\Explorer */
    const cacheDir = `${env.localAppData}\\Microsoft\\Windows\\Explorer`

    // 声明清理辖区：只有 Explorer 缓存目录下的文件才允许被本插件删除
    ctx.effect(() => {
      const dispose = ctx.pathPolicy.addRoot(cacheDir, 'thumbnails')
      return () => dispose()
    })

    ctx.effect(() =>
      ctx.cleaner.define({
        id: 'thumbnails',
        name: '缩略图缓存',
        description: '清理资源管理器生成的缩略图与图标缓存文件（可自动重建）',
        category: 'system',
        risk: 'caution',
        icon: '🖼️',
        requiresAdmin: false,
        defaultSelected: true,
        estimatedMs: 600,
        targets: [cacheDir],
        tips: [
          '缓存删除后由资源管理器自动重建，首次浏览图片文件夹会略慢',
          '缓存文件常被 explorer.exe 占用，删除失败时请重启资源管理器后重试',
        ],
        async scan(scan) {
          scan.throwIfAborted()
          if (!(await exists(cacheDir))) return

          let children: Dirent[]
          try {
            children = await fs.readdir(toLongPath(cacheDir), { withFileTypes: true })
          } catch (error) {
            scan.addError({ path: cacheDir, message: `无法读取缓存目录：${errorMessage(error)}` })
            return
          }

          // ① 先用 readdir 归类候选（保证 thumbcache / iconcache / 兜底 .db 不会重复上报）
          const candidates = new Map<string, CacheFile>()
          for (const child of children) {
            if (!child.isFile()) continue
            const group = classify(child.name)
            if (!group) continue
            if (group === 'icon' && !config.includeIconCache) continue
            const full = `${cacheDir}\\${child.name}`
            candidates.set(pathKey(full), { path: full, name: child.name, group })
          }
          if (!candidates.size) return

          // ② 再用 walk 获取真实大小（只遍历缓存目录这一层，不进入子目录）
          for await (const entry of walk(cacheDir, {
            maxDepth: 1,
            signal: scan.signal,
            onError: (target, error) => scan.addError({ path: target, message: errorMessage(error) }),
          })) {
            if (entry.isDirectory) continue
            const key = pathKey(entry.path)
            const candidate = candidates.get(key)
            if (!candidate) continue
            candidates.delete(key)
            scan.emit({
              path: entry.path,
              title: candidate.name,
              kind: 'file',
              size: entry.size,
              // caution 项默认不勾选由内核按风险等级自动处理
              risk: 'caution',
              note: BUSY_NOTE,
              meta: { group: candidate.group, name: candidate.name },
            })
          }

          // ③ 兜底：walk 没有覆盖到的候选（例如被视为链接而跳过的文件）用 lstat 补报
          for (const candidate of candidates.values()) {
            const stat = await safeLstat(candidate.path)
            if (!stat) continue
            scan.emit({
              path: candidate.path,
              title: candidate.name,
              kind: 'file',
              size: stat.size,
              risk: 'caution',
              note: BUSY_NOTE,
              meta: { group: candidate.group, name: candidate.name },
            })
          }
        },
      }),
    )
  },
})
