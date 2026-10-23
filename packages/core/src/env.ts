/**
 * 运行时环境探测：把 Node/Windows 的零散信息收敛为一个不可变对象，
 * 供内核服务与插件只读使用（插件不直接读 process.env，便于测试与替换）。
 */
import { accessSync, constants, promises as fs } from 'node:fs'
import { execFileSync } from 'node:child_process'
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

/** 判断当前进程是否具备管理员权限（Windows 看 Mandatory Label；POSIX 看 uid） */
let cachedElevated: boolean | null = null
let cachedElevatedAt = 0

export function detectElevated(): boolean {
  if (cachedElevated !== null) return cachedElevated
  cachedElevated = detectElevatedUncached()
  cachedElevatedAt = Date.now()
  return cachedElevated
}

/** 权限检测发生的时间；用于界面如实展示，而不是每次 RPC 伪造“刚刚检测” */
export function elevatedCheckedAt(): number | undefined {
  return cachedElevatedAt || undefined
}

/** 从 `whoami /groups` 输出解析 Windows 完整性级别；无法识别返回 undefined */
export function elevationFromGroups(output: string): boolean | undefined {
  if (/S-1-16-(12288|16384)\b/.test(output)) return true
  if (/S-1-16-8192\b/.test(output)) return false
  return undefined
}

function detectElevatedUncached(): boolean {
  if (process.platform === 'win32') {
    // 关键：不能只探测 hosts 是否可写。Administrator 账号在 UAC 过滤令牌下
    // 仍是 Medium Integrity，access(W_OK) 可能返回 true，从而误报“管理员权限”。
    // whoami /groups 的 Mandatory Label SID 才是进程令牌的真实完整性级别：
    // High = 12288，System = 16384；Medium = 8192（未提升）。
    try {
      const output = execFileSync('whoami.exe', ['/groups'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 2000,
      })
      const parsed = elevationFromGroups(output)
      if (parsed !== undefined) return parsed
    } catch {
      /* whoami 不可用时退回写权限探测 */
    }
    try {
      const target = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
      accessSync(target, constants.W_OK)
      return true
    } catch {
      return false
    }
  }
  return typeof process.getuid === 'function' ? process.getuid() === 0 : false
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
