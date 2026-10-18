/**
 * 临时文件清理插件（官方参考实现）。
 *
 * 这个文件同时充当「插件开发模板」：演示了插件如何
 * 1. 声明依赖的服务（inject）；
 * 2. 用 Schemastery 声明可配置项（Config）；
 * 3. 在 apply 中声明自己的清理辖区（pathPolicy.addRoot）；
 * 4. 注册清理任务并流式上报清理项（cleaner.define + scan.emit）；
 * 5. 用 ctx.effect 保证插件卸载时资源自动回收。
 */
import path from 'node:path'
import Schema from 'schemastery'
import { defineCleanerPlugin } from '@cordclean/shared'
import type { RiskLevel } from '@cordclean/shared'
import { errorMessage, exists, walk } from '@cordclean/utils'

export interface TempConfig {
  userTemp: boolean
  systemTemp: boolean
  prefetch: boolean
  recent: boolean
  minAgeHours: number
  maxFiles: number
}

const Config = Schema.object({
  userTemp: Schema.boolean().default(true).description('清理用户临时目录（%LOCALAPPDATA%\\Temp）'),
  systemTemp: Schema.boolean().default(true).description('清理系统临时目录（%windir%\\Temp，需管理员权限才能清空被占用的文件）'),
  prefetch: Schema.boolean().default(true).description('清理 Windows 预读文件（Prefetch）'),
  recent: Schema.boolean().default(false).description('清理「最近使用的文件」记录（会清空资源管理器快速访问历史）'),
  minAgeHours: Schema.number().default(0).description('只清理 N 小时之前修改过的文件（0 表示不限制）'),
  maxFiles: Schema.number().default(5000).description('单个目录最多上报的文件数量'),
})

interface Source {
  key: keyof Pick<TempConfig, 'userTemp' | 'systemTemp' | 'prefetch' | 'recent'>
  label: string
  path: string
  risk: RiskLevel
  note?: string
  maxDepth: number
}

export default defineCleanerPlugin<TempConfig>({
  name: 'temp',
  version: '1.0.0',
  description: '用户/系统临时目录、Prefetch 预读文件与最近使用记录',
  inject: ['cleaner', 'pathPolicy', 'system'],
  Config,
  setup(ctx, config) {
    const env = ctx.system.env

    /** 根据配置解析当前生效的清理源 */
    const sources = (): Source[] => {
      const list: Source[] = []
      if (config.userTemp) {
        list.push({
          key: 'userTemp',
          label: '用户临时文件',
          path: path.join(env.localAppData, 'Temp'),
          risk: 'safe',
          maxDepth: 2,
        })
      }
      if (config.systemTemp) {
        list.push({
          key: 'systemTemp',
          label: '系统临时文件',
          path: path.join(env.windowsDir, 'Temp'),
          risk: 'safe',
          note: env.elevated ? undefined : '部分文件需要管理员权限',
          maxDepth: 2,
        })
      }
      if (config.prefetch) {
        list.push({
          key: 'prefetch',
          label: '预读文件（Prefetch）',
          path: path.join(env.windowsDir, 'Prefetch'),
          risk: 'caution',
          note: '删除后系统会重新生成，首次开机可能略慢',
          maxDepth: 1,
        })
      }
      if (config.recent) {
        list.push({
          key: 'recent',
          label: '最近使用记录',
          path: path.join(env.appData, 'Microsoft', 'Windows', 'Recent'),
          risk: 'caution',
          note: '会清空快速访问中的最近文件列表',
          maxDepth: 1,
        })
      }
      return list
    }

    // 声明清理辖区：只有这些目录下的文件才允许被本插件删除
    ctx.effect(() => {
      const disposers = sources().map((source) => ctx.pathPolicy.addRoot(source.path, 'temp'))
      return () => disposers.forEach((dispose) => dispose())
    })

    ctx.effect(() =>
      ctx.cleaner.define({
        id: 'temp',
        name: '临时文件',
        description: '清理系统与应用程序运行过程中产生的临时文件',
        category: 'system',
        risk: 'safe',
        icon: '🧹',
        defaultSelected: true,
        estimatedMs: 2500,
        targets: sources().map((source) => source.path),
        tips: ['正在被程序占用的临时文件会跳过，不影响使用', 'Prefetch 属于可再生成文件，清理后系统会自动重建'],
        async scan(scan) {
          const cutoff = config.minAgeHours > 0 ? Date.now() - config.minAgeHours * 3_600_000 : 0
          for (const source of sources()) {
            scan.throwIfAborted()
            if (!(await exists(source.path))) continue
            let emitted = 0
            for await (const entry of walk(source.path, {
              signal: scan.signal,
              maxDepth: source.maxDepth,
              maxEntries: Math.max(config.maxFiles * 20, 20_000),
              onError: (target, error) => scan.addError({ path: target, message: errorMessage(error) }),
            })) {
              if (entry.isDirectory) {
                scan.count('directory')
                continue
              }
              if (cutoff && entry.mtimeMs > cutoff) continue
              if (emitted >= config.maxFiles) {
                scan.addError({ path: source.path, message: `文件数量超过上限（${config.maxFiles}），已截断` })
                break
              }
              emitted++
              scan.emit({
                path: entry.path,
                size: entry.size,
                risk: source.risk,
                meta: { source: source.key, label: source.label, mtime: entry.mtimeMs },
                note: source.note,
              })
            }
          }
        },
      }),
    )
  },
})
