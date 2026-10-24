/**
 * 系统信息服务：提供 CPU/内存/磁盘/关键目录占用等只读快照。
 * 所有结果都带缓存，避免界面频繁刷新时重复探测磁盘。
 */
import { promises as fs } from 'node:fs'
import { statfs } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Service, type Context } from 'cordis'
import type { DiskInfo, SystemInfo, SystemLike, SystemLiveInfo, TaskEnv } from '@cordclean/shared'
import { folderSize } from '@cordclean/utils'

export interface SystemConfig {
  env: TaskEnv
}

export class SystemService extends Service implements SystemLike {
  readonly env: TaskEnv
  private infoCache?: { at: number; value: SystemInfo }
  private diskCache?: { at: number; value: DiskInfo[] }
  private hotspotCache?: { at: number; value: Array<{ label: string; path: string; bytes: number }> }

  constructor(ctx: Context, config: SystemConfig) {
    super(ctx, 'system')
    this.env = config.env
  }

  /** 磁盘列表与占用 */
  async disks(): Promise<DiskInfo[]> {
    if (this.diskCache && Date.now() - this.diskCache.at < 10_000) return this.diskCache.value
    const drives = this.env.drives.length ? this.env.drives : [this.env.systemDrive]
    const value = await Promise.all(
      drives.map(async (mount): Promise<DiskInfo> => {
        try {
          const stat = await statfs(`${mount}\\`)
          const total = stat.blocks * stat.bsize
          const free = stat.bavail * stat.bsize
          return { mount, total, free, used: total - free }
        } catch {
          return { mount, total: 0, free: 0, used: 0 }
        }
      }),
    )
    this.diskCache = { at: Date.now(), value }
    return value
  }

  /** 轻量系统采样：概览页按秒/5 秒刷新时不需要枚举磁盘 */
  live(): SystemLiveInfo {
    return {
      memoryTotal: os.totalmem(),
      memoryFree: os.freemem(),
      uptimeSeconds: Math.round(os.uptime()),
      collectedAt: Date.now(),
    }
  }

  /** 系统概览 */
  async info(): Promise<SystemInfo> {
    if (this.infoCache && Date.now() - this.infoCache.at < 5_000) return this.infoCache.value
    const cpus = os.cpus()
    const value: SystemInfo = {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      hostname: os.hostname(),
      cpuModel: cpus[0]?.model ?? '未知',
      cpuCores: cpus.length,
      memoryTotal: os.totalmem(),
      memoryFree: os.freemem(),
      uptimeSeconds: Math.round(os.uptime()),
      nodeVersion: process.versions.node,
      elevated: this.env.elevated,
      username: this.env.username,
      disks: await this.disks(),
      hotspots: this.hotspotCache?.value ?? [],
      collectedAt: Date.now(),
    }
    this.infoCache = { at: Date.now(), value }
    return value
  }

  /** 关键目录占用（用于概览与 AI 分析） */
  async hotspots(): Promise<Array<{ label: string; path: string; bytes: number }>> {
    if (this.hotspotCache && Date.now() - this.hotspotCache.at < 60_000) return this.hotspotCache.value
    const env = this.env
    const targets: Array<{ label: string; path: string }> = [
      { label: '用户临时目录', path: path.join(env.localAppData, 'Temp') },
      { label: '系统临时目录', path: path.join(env.windowsDir, 'Temp') },
      { label: 'Chrome 缓存', path: path.join(env.localAppData, 'Google', 'Chrome', 'User Data') },
      { label: 'Edge 缓存', path: path.join(env.localAppData, 'Microsoft', 'Edge', 'User Data') },
      { label: 'npm 缓存', path: path.join(env.localAppData, 'npm-cache') },
      { label: '下载目录', path: path.join(env.userProfile, 'Downloads') },
    ]
    const value = await Promise.all(
      targets.map(async (target) => {
        const size = await folderSize(target.path, { maxEntries: 60_000 }).catch(() => ({ bytes: 0 }))
        return { label: target.label, path: target.path, bytes: 'bytes' in size ? size.bytes : 0 }
      }),
    )
    const filtered = value.filter((item) => item.bytes > 0)
    this.hotspotCache = { at: Date.now(), value: filtered }
    return filtered
  }

  /** 探测器：目录是否存在 */
  async exists(target: string): Promise<boolean> {
    try {
      await fs.access(target)
      return true
    } catch {
      return false
    }
  }
}
