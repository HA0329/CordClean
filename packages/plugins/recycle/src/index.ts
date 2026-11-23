/**
 * 回收站清理插件（recycle）。
 *
 * 为什么不用 `Clear-RecycleBin` 之类的系统命令？
 * 因为本产品的流程是「扫描 → 用户勾选 → 清理」，需要先把回收站里的内容
 * 还原成用户能看懂的原始文件名与大小；而系统命令只能一次性清空，无法与内核的
 * 清理项模型对接。
 *
 * 因此本插件直接解析每个盘符下的 `X:\$Recycle.Bin`：
 *
 *   SID 目录（每个用户账户一个，如 S-1-5-21-...-500）
 *     ├── $Ixxxxxx.ext   元数据：原始路径 / 原始大小 / 删除时间
 *     └── $Rxxxxxx.ext   真正的数据文件（与 $I 同名，仅前缀不同）
 *
 * 除了正常配对，本插件还识别「回收站配对异常」（超出系统自带清空能力的地方）：
 *
 * - **孤立 `$I`**：有元数据、没有 `$R` 数据文件。数据已不可恢复，元数据白占空间，
 *   多为上次清理中断留下；
 * - **孤立 `$R`**：有数据文件、没有 `$I` 元数据。原始路径/删除时间已不可知，
 *   系统自带工具通常也看不到它；
 * - **`$I` 损坏**：配对仍在，但原始路径/大小解析失败，按 `$R` 实际大小降级处理，
 *   并作为「配对异常」以 caution 上报（用户看不到原始路径，不能默认勾选）。
 *
 * 孤立残留与损坏配对一律 risk=caution、默认不勾选，清理时只删除孤立残留本身
 * （损坏配对则成对删除 `$R` 与损坏的 `$I`），且仍走内核 `deleteInternal` 内部通道
 * （执行器二次校验 `$Recycle.Bin\<SID>\$I*|$R*`）；
 * 删除失败（被占用/权限不足/策略拒绝）会带着具体原因逐条回报。
 *
 * 扫描结束时会输出「按盘统计」日志：每块磁盘的可清理项数与体积（孤立残留单独拆分），
 * 不需要改界面即可核对每块盘的情况。
 *
 * 解析与配对逻辑拆到同目录的 `recycle-info.ts`（`$I` 二进制解析）与
 * `pairing.ts`（配对/孤立检测/按盘统计/草稿构造），两者都有临时目录单测。
 */
import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import Schema from 'schemastery'
import { defineCleanerPlugin } from '@cordclean/shared'
import type { CleanItem, CleanItemResult, TaskCleanContext, TaskScanContext } from '@cordclean/shared'
import { describeDeleteError, errorCode, errorMessage, exists, safeLstat, toLongPath } from '@cordclean/utils'
import {
  analyzeRecycleSidDirectory,
  formatRecycleDriveStats,
  isSidDirectoryName,
  locateRecycleEntry,
  recycleOrphanToDraft,
  recyclePairToDraft,
  summarizeRecycleByDrive,
} from './pairing.ts'
import type { RecycleStatItem } from './pairing.ts'

/** 解析 / 配对 / 统计 / 草稿构造全部对外导出，供单测与自测脚本使用 */
export * from './recycle-info.ts'
export * from './pairing.ts'

export interface RecycleConfig {
  /** 是否扫描其它用户账户的回收站（需要管理员权限才能读取） */
  includeOtherUsers: boolean
}

const Config = Schema.object({
  includeOtherUsers: Schema.boolean()
    .default(false)
    .description('同时扫描其它用户账户的回收站（需要管理员权限，否则这些目录会被自动跳过）'),
})

/** 单次扫描最多上报的项目数（与内核 settings.scan.maxItemsPerTask 的默认值一致） */
const MAX_ITEMS = 20_000

/**
 * 查询当前账户的 SID，用于在 `includeOtherUsers=false` 时只扫描自己的回收站。
 * 查询失败时返回 `undefined`，此时不做过滤（非管理员本来也读不到别人的回收站）。
 */
let currentSidCache: Promise<string | undefined> | undefined

async function resolveCurrentSid(): Promise<string | undefined> {
  if (!currentSidCache) {
    currentSidCache = (async () => {
      const result = await import('@cordclean/utils').then(({ runCommand }) =>
        runCommand('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { timeout: 5_000 }),
      )
      if (!result.ok) return undefined
      const match = /S-1-5-\d+(?:-\d+)+/i.exec(result.stdout)
      return match ? match[0].toUpperCase() : undefined
    })()
  }
  const sid = await currentSidCache
  // 解析失败不缓存，下次扫描时重试
  if (!sid) currentSidCache = undefined
  return sid
}

/* ------------------------------------------------------------------ */
/* 清理                                                                */
/* ------------------------------------------------------------------ */

/**
 * 静默删除配对文件（正常配对里 $I/$R 的另一半）：
 * 失败只记警告——数据已经删掉了，元数据残留下次扫描会作为孤立项重新出现。
 */
async function unlinkQuietly(target: string, cleanCtx: TaskCleanContext): Promise<void> {
  if (!cleanCtx.deleteInternal) {
    cleanCtx.logger.warn('内核未提供统一删除入口，配对文件无法清理：%s', target)
    return
  }
  const result = await cleanCtx.deleteInternal(target, 'recycle-bin')
  if (!result.ok) {
    cleanCtx.logger.warn('删除配对文件失败：%s（%s）', target, result.error ?? '未知错误')
  }
}

/** 清理项上的孤立残留标记（由扫描阶段写入，清理阶段据此放行 $I 目标） */
function orphanMarkerOf(item: CleanItem): 'info' | 'data' | undefined {
  const value = item.meta?.orphan
  return value === 'info' || value === 'data' ? value : undefined
}

/** 构造一条失败结果（error 里必须带可读原因） */
function failResult(item: CleanItem, error: string): CleanItemResult {
  return { itemId: item.id, path: item.path, ok: false, bytes: 0, error }
}

/**
 * 自定义清理：
 * - 正常配对：先删 `$R`（数据）再删 `$I`（元数据），任何一步失败都还能靠 `$I`
 *   在下次扫描中把这一项重新识别出来，保证幂等、可重试；
 * - 孤立 `$I`：先确认配对的 `$R` 仍不存在，再只删这条元数据（防止把刚补全的配对打散）；
 * - 孤立 `$R`：只删这条数据文件。
 *
 * 所有删除都走内核 `deleteInternal(..., 'recycle-bin')` 内部通道；失败时把
 * 执行器返回的原因（如 EBUSY 被占用、EPERM 权限不足、策略拒绝）原样交给内核展示。
 * 导出出来便于自测脚本用 dryRun 检查安全阀。
 */
export async function cleanRecycleItems(items: CleanItem[], cleanCtx: TaskCleanContext): Promise<CleanItemResult[]> {
  const results: CleanItemResult[] = []
  for (const item of items) {
    if (cleanCtx.signal.aborted) {
      results.push({ itemId: item.id, path: item.path, ok: false, bytes: 0, error: '清理已取消' })
      continue
    }

    // 安全阀 ①：只碰 X:\$Recycle.Bin\<SID>\ 下的 $I/$R 直接子项
    const entry = locateRecycleEntry(item.path)
    if (!entry) {
      results.push(failResult(item, '不是回收站目录内的 $I/$R 维护文件，已跳过'))
      continue
    }

    // 安全阀 ②：$I 只能作为「扫描标记过的孤立元数据」被清理。
    // 不能仅凭路径就删 $I：万一配对 $R 还在，删掉 $I 会让 $R 变成永久不可识别的孤儿。
    const orphan = orphanMarkerOf(item)
    if (entry.role === 'info' && orphan !== 'info') {
      results.push(failResult(item, '孤立 $I 元数据项缺少扫描标记（meta.orphan=info），已跳过'))
      continue
    }
    if (entry.role === 'data' && orphan === 'info') {
      results.push(failResult(item, '扫描标记与目标类型不一致（meta.orphan=info 但目标是 $R），已跳过'))
      continue
    }

    // 安全阀 ③：再走一遍内核路径策略（扫描后用户可能改过设置）
    const policy = cleanCtx.pathPolicy.check(entry.path)
    if (!policy.allowed) {
      results.push(failResult(item, `路径被安全策略拒绝（${policy.reason ?? 'unknown'}）`))
      continue
    }

    // 预演：只统计，不落盘
    if (cleanCtx.dryRun) {
      results.push({ itemId: item.id, path: item.path, ok: true, bytes: item.size })
      continue
    }

    try {
      if (entry.role === 'info') {
        // 孤立 $I：清理前再确认配对 $R 仍不存在，避免打散扫描后才补全的配对
        const pairedData = await safeLstat(entry.pairPath)
        if (pairedData) {
          results.push(failResult(item, '配对的 $R 数据文件已出现，为避免打散正常配对，已跳过孤立元数据清理'))
          continue
        }
        if (!cleanCtx.deleteInternal) throw new Error('内核未提供统一删除入口')
        const removed = await cleanCtx.deleteInternal(entry.path, 'recycle-bin')
        if (!removed.ok) {
          results.push(failResult(item, `删除孤立 $I 元数据失败：${removed.error ?? '未知错误'}`))
          continue
        }
        results.push({ itemId: item.id, path: item.path, ok: true, bytes: removed.bytes })
        continue
      }

      // 以下是 $R 数据文件（正常配对项或孤立数据项）
      const stat = await safeLstat(entry.path)
      if (!stat) {
        // 数据文件已不存在（例如上次清理被打断）：顺手清掉配对 $I，按 0 字节计
        await unlinkQuietly(entry.pairPath, cleanCtx)
        results.push({ itemId: item.id, path: item.path, ok: true, bytes: 0 })
        continue
      }
      if (!cleanCtx.deleteInternal) throw new Error('内核未提供统一删除入口')
      const removed = await cleanCtx.deleteInternal(item.path, 'recycle-bin')
      if (!removed.ok) {
        const action = orphan === 'data' ? '删除孤立 $R 数据' : '删除 $R 数据'
        results.push(failResult(item, `${action}失败：${removed.error ?? '未知错误'}`))
        continue
      }
      // 数据删掉后再清元数据（若在扫描后被补出 $I，也一并回收，避免产生新的孤立元数据）
      await unlinkQuietly(entry.pairPath, cleanCtx)
      results.push({ itemId: item.id, path: item.path, ok: true, bytes: removed.bytes })
    } catch (error) {
      // 单条失败不影响整批：把中文原因交给内核展示
      results.push({
        itemId: item.id,
        path: item.path,
        ok: false,
        bytes: 0,
        error: `删除失败：${describeDeleteError(error)}（文件可能正被占用，或需要管理员权限）`,
      })
    }
  }
  return results
}

/* ------------------------------------------------------------------ */
/* 插件定义                                                            */
/* ------------------------------------------------------------------ */

export default defineCleanerPlugin<RecycleConfig>({
  name: 'recycle',
  version: '1.1.0',
  description: '解析各磁盘回收站（$Recycle.Bin）中的 $I/$R 文件对，还原原始路径后清理，并检测孤立残留',
  inject: ['cleaner', 'pathPolicy', 'system'],
  Config,
  setup(ctx, config) {
    const env = ctx.system.env

    /** 本次要处理的回收站目录（每个固定磁盘一个） */
    const bins = () => env.drives.map((drive) => ({ drive, bin: `${drive}\\$Recycle.Bin` }))

    // 声明清理辖区：只有这些回收站目录下的文件才允许被本插件删除
    ctx.effect(() => {
      const disposers = bins().map((entry) => ctx.pathPolicy.addRoot(entry.bin, 'recycle'))
      return () => disposers.forEach((dispose) => dispose())
    })

    ctx.effect(() =>
      ctx.cleaner.define({
        id: 'recycle',
        name: '回收站',
        description: '清空各磁盘回收站中等待删除的文件，并检测 $I/$R 配对异常（孤立元数据/孤立数据）',
        category: 'system',
        risk: 'safe',
        icon: '🗑️',
        requiresAdmin: false,
        defaultSelected: true,
        estimatedMs: 1500,
        targets: bins().map((entry) => entry.bin),
        tips: [
          '回收站中的文件删除后无法恢复，请确认勾选项确实不再需要',
          '默认只扫描当前账户的回收站；其它账户的回收站需要管理员权限（可在插件配置中开启 includeOtherUsers）',
          '「回收站配对异常」（孤立 $I 元数据 / 孤立 $R 数据 / $I 损坏）风险为谨慎且默认不勾选；扫描日志会按盘给出可清理项数与体积',
        ],
        async scan(scan) {
          // 当前用户 SID：用于在 includeOtherUsers=false 时过滤掉别人的回收站
          const sid = await resolveCurrentSid()
          let emitted = 0
          let truncatedNotified = false
          const statItems: RecycleStatItem[] = []
          const scannedDrives: string[] = []

          // 按盘统计日志：无论命中多少项都会输出，空盘显示 0 项 / 0 B，便于核对扫描覆盖范围
          const finish = (): void => {
            if (!scannedDrives.length) {
              scan.logger.debug('回收站按盘统计：未找到可读取的 $Recycle.Bin 目录')
              return
            }
            scan.logger.info(
              '回收站按盘统计（可清理项数/体积）：%s',
              formatRecycleDriveStats(summarizeRecycleByDrive(statItems, scannedDrives)),
            )
          }
          const notifyTruncated = (bin: string): void => {
            if (truncatedNotified) return
            truncatedNotified = true
            scan.addError({ path: bin, message: `回收站项目超过 ${MAX_ITEMS} 项，本次仅上报前 ${MAX_ITEMS} 项` })
          }

          for (const { drive, bin } of bins()) {
            scan.throwIfAborted()
            if (!(await exists(bin))) continue

            let children: Dirent[]
            try {
              children = await fs.readdir(toLongPath(bin), { withFileTypes: true })
            } catch (error) {
              scan.addError({ path: bin, message: `无法读取回收站目录：${errorMessage(error)}`, code: errorCode(error) })
              continue
            }
            scannedDrives.push(drive)

            for (const child of children) {
              scan.throwIfAborted()
              // 只处理 SID 子目录；回收站根目录下的 desktop.ini 等文件直接忽略
              if (!child.isDirectory() || child.isSymbolicLink() || !isSidDirectoryName(child.name)) continue
              if (!config.includeOtherUsers && sid && child.name.toUpperCase() !== sid) continue

              const sidDir = `${bin}\\${child.name}`
              let names: string[]
              try {
                names = await fs.readdir(toLongPath(sidDir))
              } catch (error) {
                const code = errorCode(error)
                // 别人的回收站默认只有管理员可读：非管理员时静默跳过，避免给用户刷错误
                if (config.includeOtherUsers || (code !== 'EPERM' && code !== 'EACCES')) {
                  scan.addError({ path: sidDir, message: `无法读取回收站目录：${errorMessage(error)}`, code })
                }
                continue
              }

              const remaining = MAX_ITEMS - emitted
              if (remaining <= 0) {
                notifyTruncated(bin)
                finish()
                return
              }

              // 配对 + 孤立残留一次性分析（临时目录可完整单测，见 tests/recycle-orphans.test.ts）
              const result = await analyzeRecycleSidDirectory(sidDir, drive, child.name, names, {
                signal: scan.signal,
                logger: scan.logger,
                addError: (error) => scan.addError(error),
                limit: remaining,
              })
              if (result.ignored > 0) {
                scan.logger.debug('%s 中忽略 %d 个非 $I/$R 文件（如 desktop.ini）', sidDir, result.ignored)
              }
              if (result.pairs.length || result.orphanInfos.length || result.orphanDatas.length) {
                scan.logger.debug(
                  '扫描 %s：正常配对 %d（其中 $I 损坏 %d），孤立 $I %d，孤立 $R %d',
                  sidDir,
                  result.pairs.length,
                  result.pairs.filter((pair) => pair.broken).length,
                  result.orphanInfos.length,
                  result.orphanDatas.length,
                )
              }

              for (const record of result.pairs) {
                emitted++
                statItems.push({ drive, size: record.size })
                scan.emit(recyclePairToDraft(record))
              }
              for (const record of result.orphanInfos) {
                emitted++
                statItems.push({ drive, size: 0, orphan: true })
                scan.emit(recycleOrphanToDraft(record))
              }
              for (const record of result.orphanDatas) {
                emitted++
                statItems.push({ drive, size: record.size, orphan: true })
                scan.emit(recycleOrphanToDraft(record))
              }

              if (result.truncated) {
                notifyTruncated(bin)
                finish()
                return
              }
            }
          }
          finish()
        },
        clean: cleanRecycleItems,
      }),
    )
  },
})
