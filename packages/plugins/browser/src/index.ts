/**
 * 浏览器缓存插件。
 *
 * 覆盖 Chrome / Edge / Firefox 三类浏览器，分为两个清理任务：
 * - `browser-cache`：纯缓存（Cache、Code Cache、GPUCache、Service Worker 等），可随时重建；
 * - `browser-privacy`：隐私痕迹（历史、会话、下载记录、Cookie、LocalStorage），默认不勾选。
 *
 * 实现要点：
 * - 逐个 profile 识别（只认带 `Preferences`/`prefs.js` 的目录），避免误伤其它目录；
 * - 缓存目录整体作为「目录清理项」上报（内部文件动辄上万，逐个上报没有意义）；
 * - 检测浏览器是否正在运行，在提示中告知「关闭浏览器后清理更彻底」。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import Schema from 'schemastery'
import { defineCleanerPlugin } from '@cordclean/shared'
import type { RiskLevel } from '@cordclean/shared'
import { errorMessage, folderSize, powershell } from '@cordclean/utils'

export interface BrowserConfig {
  chrome: boolean
  edge: boolean
  firefox: boolean
  includePrivacy: boolean
  includeCookies: boolean
  includeLocalStorage: boolean
  /** 单个缓存目录体积上报上限（MB），0 表示不限制 */
  maxDirMb: number
}

const Config = Schema.object({
  chrome: Schema.boolean().default(true).description('清理 Google Chrome'),
  edge: Schema.boolean().default(true).description('清理 Microsoft Edge'),
  firefox: Schema.boolean().default(true).description('清理 Mozilla Firefox'),
  includePrivacy: Schema.boolean().default(false).description('同时清理浏览历史、会话与下载记录（隐私痕迹）'),
  includeCookies: Schema.boolean().default(false).description('清理 Cookie（会导致网站登录状态失效，风险较高）'),
  includeLocalStorage: Schema.boolean().default(false).description('清理 LocalStorage / IndexedDB（会丢失本地网页数据）'),
  maxDirMb: Schema.number().default(0).description('单个缓存目录上报的体积上限（MB），0 表示不限制'),
})

/** 浏览器 profile */
interface BrowserProfile {
  browser: 'chrome' | 'edge' | 'firefox'
  label: string
  dir: string
  /** 缓存目录（名称 → 是否默认勾选） */
  caches: Array<{ dir: string; label: string }>
  /** 隐私文件 */
  privacy: Array<{ file: string; label: string }>
}

const BROWSER_LABEL: Record<string, string> = {
  chrome: 'Chrome',
  edge: 'Edge',
  firefox: 'Firefox',
}

/** 安全读取目录列表 */
function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** 是否为目录 */
function isDir(target: string): boolean {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

/** 探测 Chromium 系浏览器的 profile */
function chromiumProfiles(userDataDir: string, browser: 'chrome' | 'edge'): BrowserProfile[] {
  if (!isDir(userDataDir)) return []
  const profiles: BrowserProfile[] = []
  for (const entry of safeReaddir(userDataDir)) {
    if (entry !== 'Default' && !/^Profile \d+$/.test(entry) && entry !== 'Guest Profile') continue
    const dir = path.join(userDataDir, entry)
    if (!existsSync(path.join(dir, 'Preferences'))) continue
    profiles.push({
      browser,
      label: `${BROWSER_LABEL[browser]} · ${entry}`,
      dir,
      caches: [
        { dir: path.join(dir, 'Cache', 'Cache_Data'), label: '网页缓存' },
        { dir: path.join(dir, 'Cache'), label: '网页缓存（旧版）' },
        { dir: path.join(dir, 'Code Cache'), label: 'JavaScript 代码缓存' },
        { dir: path.join(dir, 'GPUCache'), label: 'GPU 着色器缓存' },
        { dir: path.join(dir, 'Service Worker', 'CacheStorage'), label: 'Service Worker 缓存' },
        { dir: path.join(dir, 'Service Worker', 'ScriptCache'), label: 'Service Worker 脚本缓存' },
        { dir: path.join(dir, 'Media Cache'), label: '媒体缓存' },
        { dir: path.join(dir, 'DawnCache'), label: 'Dawn 图形缓存' },
        { dir: path.join(dir, 'GrShaderCache'), label: '图形着色器缓存' },
        { dir: path.join(dir, 'ShaderCache'), label: '着色器缓存' },
      ],
      privacy: [
        { file: path.join(dir, 'History'), label: '浏览历史' },
        { file: path.join(dir, 'History-journal'), label: '历史日志' },
        { file: path.join(dir, 'Top Sites'), label: '常访问站点' },
        { file: path.join(dir, 'Visited Links'), label: '已访问链接' },
        { file: path.join(dir, 'Sessions'), label: '会话记录' },
        { file: path.join(dir, 'Network', 'Cookies'), label: 'Cookie' },
        { file: path.join(dir, 'Local Storage'), label: 'LocalStorage' },
        { file: path.join(dir, 'Session Storage'), label: 'SessionStorage' },
      ],
    })
  }
  return profiles
}

/** 探测 Firefox profile */
function firefoxProfiles(appDataDir: string): BrowserProfile[] {
  const profilesDir = path.join(appDataDir, 'Mozilla', 'Firefox', 'Profiles')
  if (!isDir(profilesDir)) return []
  const profiles: BrowserProfile[] = []
  for (const entry of safeReaddir(profilesDir)) {
    const dir = path.join(profilesDir, entry)
    if (!existsSync(path.join(dir, 'prefs.js'))) continue
    profiles.push({
      browser: 'firefox',
      label: `Firefox · ${entry.replace(/^[a-z0-9]+\./, '')}`,
      dir,
      caches: [
        { dir: path.join(dir, 'cache2'), label: '网页缓存' },
        { dir: path.join(dir, 'startupCache'), label: '启动缓存' },
        { dir: path.join(dir, 'shader-cache'), label: '着色器缓存' },
      ],
      privacy: [
        { file: path.join(dir, 'places.sqlite'), label: '历史与书签数据库' },
        { file: path.join(dir, 'sessionstore-backups'), label: '会话备份' },
        { file: path.join(dir, 'cookies.sqlite'), label: 'Cookie' },
        { file: path.join(dir, 'storage'), label: '网页存储' },
      ],
    })
  }
  return profiles
}

/** 浏览器进程是否在运行 */
async function detectRunning(): Promise<Set<string>> {
  const running = new Set<string>()
  try {
    const result = await powershell(
      `Get-Process -Name chrome,msedge,firefox -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessName -Unique`,
      { timeout: 15_000 },
    )
    for (const line of result.stdout.split(/\r?\n/)) {
      const name = line.trim().toLowerCase()
      if (name) running.add(name)
    }
  } catch {
    // 探测失败不影响扫描
  }
  return running
}

export default defineCleanerPlugin<BrowserConfig>({
  name: 'browser',
  version: '1.0.0',
  description: 'Chrome / Edge / Firefox 的缓存与隐私痕迹',
  inject: ['cleaner', 'pathPolicy', 'system'],
  Config,
  setup(ctx, config) {
    const env = ctx.system.env

    const profiles = (): BrowserProfile[] => {
      const list: BrowserProfile[] = []
      if (config.chrome) list.push(...chromiumProfiles(path.join(env.localAppData, 'Google', 'Chrome', 'User Data'), 'chrome'))
      if (config.edge) list.push(...chromiumProfiles(path.join(env.localAppData, 'Microsoft', 'Edge', 'User Data'), 'edge'))
      if (config.firefox) list.push(...firefoxProfiles(env.appData))
      return list
    }

    // 声明辖区：只允许清理已探测到的缓存/隐私目标，绝不包含 profile 根目录
    ctx.effect(() => {
      const disposers: Array<() => void> = []
      for (const profile of profiles()) {
        for (const cache of profile.caches) disposers.push(ctx.pathPolicy.addRoot(cache.dir, 'browser'))
        for (const item of profile.privacy) disposers.push(ctx.pathPolicy.addRoot(item.file, 'browser'))
      }
      return () => disposers.forEach((dispose) => dispose())
    })

    ctx.effect(() =>
      ctx.cleaner.define({
        id: 'browser-cache',
        name: '浏览器缓存',
        description: '网页缓存、脚本缓存、GPU 着色器缓存等可重建数据',
        category: 'browser',
        risk: 'safe',
        icon: '🌐',
        defaultSelected: true,
        estimatedMs: 1500,
        targets: profiles().flatMap((profile) => profile.caches.map((cache) => cache.dir)),
        tips: ['缓存会在浏览网页时自动重建', '浏览器运行中部分缓存文件可能被占用，关闭浏览器后清理更彻底'],
        async scan(scan) {
          const running = await detectRunning()
          const maxBytes = config.maxDirMb > 0 ? config.maxDirMb * 1024 * 1024 : 0
          for (const profile of profiles()) {
            scan.throwIfAborted()
            const browserRunning = running.has(`${profile.browser === 'edge' ? 'msedge' : profile.browser}.exe`) || running.has(profile.browser)
            const seen = new Set<string>()
            for (const cache of profile.caches) {
              if (seen.has(cache.dir)) continue
              seen.add(cache.dir)
              if (!isDir(cache.dir)) continue
              const size = await folderSize(cache.dir, { maxEntries: 200_000 })
              if (!size.bytes) continue
              if (maxBytes && size.bytes > maxBytes) {
                scan.addError({ path: cache.dir, message: `体积超过 ${config.maxDirMb} MB 上限，已跳过` })
                continue
              }
              scan.emit({
                path: cache.dir,
                kind: 'directory',
                title: `${profile.label} · ${cache.label}`,
                size: size.bytes,
                risk: 'safe',
                meta: { browser: profile.browser, profile: profile.label, files: size.files, target: cache.label },
                note: browserRunning ? '浏览器正在运行，部分文件可能被占用' : undefined,
              })
            }
          }
        },
      }),
    )

    ctx.effect(() =>
      ctx.cleaner.define({
        id: 'browser-privacy',
        name: '浏览器隐私痕迹',
        description: '浏览历史、会话、下载记录、Cookie 与本地存储',
        category: 'privacy',
        risk: 'caution',
        icon: '🕵️',
        defaultSelected: false,
        estimatedMs: 800,
        targets: profiles().flatMap((profile) => profile.privacy.map((item) => item.file)),
        tips: [
          '历史记录与会话文件清理后不可恢复',
          'Cookie 与本地存储会导致网站登录状态失效，请谨慎勾选',
        ],
        async scan(scan) {
          for (const profile of profiles()) {
            scan.throwIfAborted()
            for (const item of profile.privacy) {
              if (!existsSync(item.file)) continue
              const isCookie = /cookie/i.test(item.label)
              const isStorage = /storage/i.test(item.label)
              if (isCookie && !config.includeCookies) continue
              if (isStorage && !config.includeLocalStorage) continue
              if (!isCookie && !isStorage && !config.includePrivacy) continue
              const risk: RiskLevel = isCookie ? 'risky' : isStorage ? 'caution' : 'caution'
              let size = 0
              let isDirectory = false
              try {
                const stat = statSync(item.file)
                isDirectory = stat.isDirectory()
                size = isDirectory ? (await folderSize(item.file, { maxEntries: 100_000 })).bytes : stat.size
              } catch (error) {
                scan.addError({ path: item.file, message: errorMessage(error) })
                continue
              }
              if (!size) continue
              scan.emit({
                path: item.file,
                kind: isDirectory ? 'directory' : 'file',
                title: `${profile.label} · ${item.label}`,
                size,
                risk,
                meta: { browser: profile.browser, profile: profile.label, target: item.label },
                note: isCookie ? '清理后需要重新登录网站' : isStorage ? '将清除网页本地数据' : undefined,
              })
            }
          }
        },
      }),
    )
  },
})
