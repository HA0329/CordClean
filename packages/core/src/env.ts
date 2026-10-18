/**
 * 运行时环境探测：把 Node/Windows 的零散信息收敛为一个不可变对象，
 * 供内核服务与插件只读使用（插件不直接读 process.env，便于测试与替换）。
 */
import { accessSync, constants, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { TaskEnv } from '@cordclean/shared'

const DRIVE_LETTERS = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

/** 缓存磁盘列表，避免每次扫描都探测 */
let cachedDrives: { at: number; drives: string[] } | null = null

/** 探测当前存在的固定磁盘盘符（A/B 软驱不探测） */
export async function listDrives(): Promise<string[]> {
  if (cachedDrives && Date.now() - cachedDrives.at < 60_000) return cachedDrives.drives
  const probes = await Promise.all(
    DRIVE_LETTERS.map(async (letter) => {
      try {
        const stat = await fs.statfs(`${letter}:\\`)
        return stat.blocks > 0 ? `${letter}:` : ''
      } catch {
        return ''
      }
    }),
  )
  const drives = probes.filter(Boolean)
  cachedDrives = { at: Date.now(), drives }
  return drives
}

/** 判断当前进程是否具备管理员权限（对系统盘 hosts 文件尝试写入探测） */
export function detectElevated(): boolean {
  try {
    const target = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
    // 只做 access 检查，不修改文件内容
    accessSync(target, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** 构造环境对象 */
export async function createTaskEnv(dataDir: string): Promise<TaskEnv> {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const env: TaskEnv = {
    platform: process.platform,
    arch: process.arch,
    elevated: detectElevated(),
    username: process.env.USERNAME || os.userInfo().username,
    systemDrive: (process.env.SystemDrive || 'C:').toUpperCase(),
    windowsDir: systemRoot,
    programFiles: process.env.ProgramFiles || 'C:\\Program Files',
    programFilesX86: process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    programData: process.env.ProgramData || 'C:\\ProgramData',
    appData: process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    localAppData: process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    userProfile: process.env.USERPROFILE || os.homedir(),
    dataDir,
    drives: await listDrives(),
    get(name: string) {
      return process.env[name]
    },
  }
  return env
}

/** 默认数据目录：%LOCALAPPDATA%\\CordClean */
export function defaultDataDir(): string {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(base, 'CordClean')
}
