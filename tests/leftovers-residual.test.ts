/**
 * leftovers 目录残留判定回归测试。
 *
 * 覆盖需求里点名的四类纯逻辑（不依赖真实注册表/系统目录）：
 * 1. 已安装软件名称除重（同一发布者十几条卸载项只留一条）；
 * 2. 180 天年龄阈值（179 天不算、180 天算、未来时间不算）；
 * 3. 排除名单（系统目录 / Temp / 回收站 / 包管理器缓存 / CordClean 自身数据目录）；
 * 4. ProgramData 下「发布者目录」的匹配与不误报。
 * 最后用临时沙箱跑一遍 findSuspectDirectories，确认真实扫描路径与纯判定一致。
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { TaskEnv } from '@cordclean/shared'
import {
  SUSPECT_MAX_AGE_DAYS,
  ageDaysFromMtime,
  buildExclusionContext,
  buildInstalledSoftwareIndex,
  classifyExcludedName,
  classifyExcludedPath,
  defaultSuspectRoots,
  findInstalledSoftwareMatch,
  formatAgeDays,
  formatSuspectNote,
  isSuspectAge,
  judgeSuspectDirectory,
  normalizePublisher,
  normalizeSoftwareName,
  toSuspectDraft,
  type ExclusionContext,
  type InstalledSoftwareIndex,
} from '../packages/plugins/leftovers/src/residual-rules.ts'
import { findSuspectDirectories, type SuspectDirectoryStats } from '../packages/plugins/leftovers/src/index.ts'

const DAY = 86_400_000
const OLD = 200 * DAY
const NOW = 1_766_000_000_000

/** 构造卸载项（判定只需要 displayName/publisher/installLocation） */
function entry(displayName: string, publisher = '', installLocation = '') {
  return { displayName, publisher, installLocation }
}

/** 构造完整 UninstallEntry（findSuspectDirectories 的入参类型） */
function uninstallEntry(displayName: string, publisher = '', installLocation = '') {
  return {
    key: `HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${displayName}`,
    displayName,
    version: '',
    publisher,
    installLocation,
    uninstallString: '',
    displayIcon: '',
  }
}

/** 构造一个空索引上下文 */
function emptyIndex(): InstalledSoftwareIndex {
  return buildInstalledSoftwareIndex([])
}

/** 构造路径排除上下文（固定假环境，避免受本机环境变量影响） */
function fakeExclusions(overrides: Partial<ExclusionContext> = {}): ExclusionContext {
  return {
    ...buildExclusionContext({
      dataDir: 'C:\\Users\\me\\AppData\\Local\\CordClean',
      windowsDir: 'C:\\Windows',
      localAppData: 'C:\\Users\\me\\AppData\\Local',
      appData: 'C:\\Users\\me\\AppData\\Roaming',
      userProfile: 'C:\\Users\\me',
      systemDrive: 'C:',
      drives: ['C:', 'D:'],
    }),
    ...overrides,
  }
}

function judge(name: string, options: { mtimeMs?: number; path?: string; kind?: 'program-files' | 'program-data' | 'local-appdata' | 'local-programs' | 'roaming-appdata'; index?: InstalledSoftwareIndex; isLink?: boolean; exclusions?: ExclusionContext } = {}) {
  return judgeSuspectDirectory(
    {
      name,
      path: options.path,
      rootKind: options.kind ?? 'program-files',
      mtimeMs: options.mtimeMs ?? NOW - OLD,
      isLink: options.isLink,
    },
    { index: options.index ?? emptyIndex(), exclusions: options.exclusions ?? fakeExclusions(), now: NOW },
  )
}

/* ------------------------------------------------------------------ */
/* 1. 已安装软件名称除重                                                */
/* ------------------------------------------------------------------ */

describe('已安装软件名除重', () => {
  it('同一发布者的多条卸载项只保留一条发布者/软件名/安装目录', () => {
    const index = buildInstalledSoftwareIndex([
      entry('NVIDIA 图形驱动程序 621.24', 'NVIDIA Corporation', 'C:\\Program Files\\NVIDIA Corporation\\Installer2'),
      entry('NVIDIA App 11.0.9.585', 'NVIDIA Corporation', 'C:\\Program Files\\NVIDIA Corporation\\Installer2'),
      entry('NVIDIA PhysX 系统软件', 'nvidia corporation', 'C:\\Program Files\\NVIDIA Corporation\\Installer2'),
      entry('Adobe Acrobat', 'Adobe Inc.', 'C:\\Program Files\\Adobe\\Acrobat'),
    ])
    expect(index.publishers).toEqual(['adobe', 'nvidia'])
    expect(index.displayNames).toHaveLength(4)
    // 相同安装目录只保留一条
    expect(index.installDirs).toEqual(['acrobat', 'installer2'])
  })

  it('大小写/多余空白/商标符号归一化后视为同一名称', () => {
    expect(normalizeSoftwareName('  NVIDIA   Corporation ')).toBe('nvidia corporation')
    expect(normalizeSoftwareName('NVIDIA® Corporation™')).toBe('nvidia corporation')
    expect(normalizeSoftwareName('ＮＶＩＤＩＡ')).toBe('nvidia')
    expect(normalizePublisher('NVIDIA Corporation')).toBe('nvidia')
    expect(normalizePublisher('Adobe Inc.')).toBe('adobe')
    expect(normalizePublisher('Acme Co., Ltd.')).toBe('acme')
  })

  it('空条目被忽略，空索引不会误匹配', () => {
    const index = buildInstalledSoftwareIndex([entry('', '', ''), entry('  ', '', 'C:\\')])
    expect(index.displayNames).toEqual([])
    expect(index.publishers).toEqual([])
    expect(index.installDirs).toEqual([])
    expect(findInstalledSoftwareMatch('Some App', index)).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ */
/* 2. 180 天年龄阈值                                                   */
/* ------------------------------------------------------------------ */

describe('180 天年龄阈值', () => {
  it('179 天不算残留，恰好 180 天开始算', () => {
    const age179 = ageDaysFromMtime(NOW - 179 * DAY, NOW)
    const age180 = ageDaysFromMtime(NOW - 180 * DAY, NOW)
    const age181 = ageDaysFromMtime(NOW - 181 * DAY, NOW)
    expect(age179).toBe(179)
    expect(isSuspectAge(age179)).toBe(false)
    expect(SUSPECT_MAX_AGE_DAYS).toBe(180)
    expect(age180).toBe(180)
    expect(isSuspectAge(age180)).toBe(true)
    expect(isSuspectAge(age181)).toBe(true)
  })

  it('未来时间/非法时间视为异常，不当作残留', () => {
    expect(ageDaysFromMtime(NOW + DAY, NOW)).toBeUndefined()
    expect(isSuspectAge(undefined)).toBe(false)
    expect(isSuspectAge(Number.NaN)).toBe(false)
    expect(judge('Old But Future', { mtimeMs: NOW + DAY }).skipReason).toBe('invalid-age')
  })

  it('judgeSuspectDirectory 用同一阈值：179 天跳过、200 天命中', () => {
    expect(judge('Some Stale App', { mtimeMs: NOW - 179 * DAY })).toMatchObject({ suspect: false, skipReason: 'too-new' })
    expect(judge('Some Stale App', { mtimeMs: NOW - OLD })).toMatchObject({ suspect: true, ageDays: 200 })
  })

  it('年龄格式化可读', () => {
    expect(formatAgeDays(20)).toBe('20 天')
    expect(formatAgeDays(180)).toBe('6 个月（180 天）')
    expect(formatAgeDays(221)).toBe('7 个月（221 天）')
    expect(formatAgeDays(966)).toBe('2.6 年（966 天）')
  })
})

/* ------------------------------------------------------------------ */
/* 3. 排除名单                                                         */
/* ------------------------------------------------------------------ */

describe('排除名单', () => {
  it('系统 / 临时 / 回收站 / 包管理器 / 开发目录都被排除', () => {
    expect(classifyExcludedName('Temp')).toBe('temporary')
    expect(classifyExcludedName('$Recycle.Bin')).toBe('recycle-bin')
    expect(classifyExcludedName('WindowsPowerShell')).toBe('windows')
    expect(classifyExcludedName('WindowsApps')).toBe('windows')
    expect(classifyExcludedName('System32')).toBe('windows')
    expect(classifyExcludedName('Microsoft')).toBe('system-directory')
    expect(classifyExcludedName('Microsoft Office')).toBe('system-directory')
    // 本机 ProgramData 里真实存在的 Windows Update Orchestrator 系统目录（>180 天，必须排除）
    expect(classifyExcludedName('USOPrivate')).toBe('system-directory')
    expect(classifyExcludedName('USOShared')).toBe('system-directory')
    expect(classifyExcludedName('node_modules')).toBe('package-manager-cache')
    expect(classifyExcludedName('.pnpm')).toBe('package-manager-cache')
    expect(classifyExcludedName('Package Cache')).toBe('package-manager-cache')
    expect(classifyExcludedName('chocolatey')).toBe('package-manager-cache')
    expect(classifyExcludedName('.git')).toBe('development')
    expect(classifyExcludedName('dist')).toBe('development')
  })

  it('正常的软件目录名不会被排除', () => {
    for (const name of ['Acme Widgets', 'Mozilla Firefox', 'Docker', 'Code', '7-Zip', 'Old Publisher']) {
      expect(classifyExcludedName(name)).toBeUndefined()
    }
  })

  it('路径排除：CordClean 数据目录 / Windows/System32 / Temp / 回收站', () => {
    const exclusions = fakeExclusions()
    expect(classifyExcludedPath('C:\\Users\\me\\AppData\\Local\\CordClean\\backups', exclusions)).toBe('cordclean-data')
    expect(classifyExcludedPath('C:\\Windows\\System32\\DriverStore', exclusions)).toBe('windows')
    expect(classifyExcludedPath('C:\\Users\\me\\AppData\\Local\\Temp\\crashpad', exclusions)).toBe('temporary')
    expect(classifyExcludedPath('D:\\$Recycle.Bin\\S-1-5-21', exclusions)).toBe('recycle-bin')
    expect(classifyExcludedPath('C:\\ProgramData\\Old Publisher', exclusions)).toBeUndefined()
  })

  it('前缀边界不误判（CordClean2 / WindowsAppsData 不是受保护位置）', () => {
    const exclusions = fakeExclusions()
    expect(classifyExcludedPath('C:\\Users\\me\\AppData\\Local\\CordClean2\\x', exclusions)).toBeUndefined()
    expect(classifyExcludedPath('C:\\WindowsAppsData\\x', exclusions)).toBeUndefined()
  })

  it('即使目录名正常，命中受保护路径也不上报', () => {
    expect(judge('Old Publisher', { path: 'C:\\Windows\\System32\\Old Publisher' })).toMatchObject({
      suspect: false,
      skipReason: 'excluded-path',
      exclusion: 'windows',
    })
    expect(judge('backups', { path: 'C:\\Users\\me\\AppData\\Local\\CordClean\\backups' })).toMatchObject({
      suspect: false,
      skipReason: 'excluded-path',
      exclusion: 'cordclean-data',
    })
  })

  it('链接目录直接跳过', () => {
    expect(judge('Some Stale App', { isLink: true })).toMatchObject({ suspect: false, skipReason: 'link' })
  })
})

/* ------------------------------------------------------------------ */
/* 4. ProgramData 发布者目录匹配与不误报                               */
/* ------------------------------------------------------------------ */

describe('ProgramData 发布者目录匹配与不误报', () => {
  const index = buildInstalledSoftwareIndex([
    entry('NVIDIA 图形驱动程序 621.24', 'NVIDIA Corporation', 'C:\\Program Files\\NVIDIA Corporation\\Installer2'),
    entry('NVIDIA App 11.0.9.585', 'NVIDIA Corporation', 'C:\\Program Files\\NVIDIA Corporation\\Installer2'),
    entry('Toolbar X', 'Acme Widgets GmbH', 'C:\\Program Files\\Toolbar X'),
    entry('Acrobat Reader DC', 'Adobe Inc.', 'C:\\Program Files\\Adobe\\Acrobat'),
    entry('Mozilla Firefox', 'Mozilla', 'C:\\Program Files\\Mozilla Firefox'),
    entry('Acme Launcher', '', 'C:\\Program Files\\Acme Widgets Pro'),
  ])

  it('已安装软件的发布者目录不会被误报（NVIDIA / Adobe / Acme）', () => {
    expect(judge('NVIDIA Corporation', { kind: 'program-data', index })).toMatchObject({
      suspect: false,
      skipReason: 'installed-match',
    })
    expect(judge('NVIDIA', { kind: 'program-data', index }).skipReason).toBe('installed-match')
    expect(judge('Adobe', { kind: 'program-data', index }).match).toMatchObject({ basis: 'publisher' })
    expect(judge('Acme Widgets', { kind: 'program-data', index }).suspect).toBe(false)
  })

  it('发布者匹配大小写不敏感，且能去掉法律后缀后匹配', () => {
    expect(judge('ACME WIDGETS GMBH', { kind: 'program-data', index }).suspect).toBe(false)
    expect(judge('Adobe Inc.', { kind: 'program-data', index }).suspect).toBe(false)
  })

  it('显示名 / 安装目录末段同样能匹配', () => {
    // 显示名匹配（Mozilla）
    expect(judge('Mozilla Firefox', { kind: 'program-data', index }).suspect).toBe(false)
    // 安装目录末段匹配：InstallLocation 为 ...\Acme Widgets Pro
    const installDirMatch = judge('Acme Widgets Pro', { kind: 'program-files', index })
    expect(installDirMatch.suspect).toBe(false)
    expect(installDirMatch.match?.basis).toBe('install-dir')
  })

  it('真正对不上的旧发布者目录仍会被识别为疑似残留', () => {
    const decision = judge('Totally Unrelated', { kind: 'program-data', index })
    expect(decision.suspect).toBe(true)
    expect(decision.ageDays).toBe(200)
  })

  it('ProgramData 命中发布者时 note 语义与默认勾选状态正确', () => {
    const detail = {
      path: 'C:\\ProgramData\\Totally Unrelated',
      name: 'Totally Unrelated',
      rootLabel: '%PROGRAMDATA%',
      rootKind: 'program-data' as const,
      ageDays: 966,
    }
    const note = formatSuspectNote(detail, 76)
    expect(note).toContain('Totally Unrelated')
    expect(note).toContain('76 个已安装软件')
    expect(note).toContain('发布者目录层')
    expect(note).toContain('2.6 年（966 天）')
    expect(note).toContain('仅提示，不会自动删除')

    const draft = toSuspectDraft(detail, 76)
    expect(draft).toMatchObject({ kind: 'directory', size: 0, risk: 'risky', defaultSelected: false, recommended: false })
    expect(draft.meta).toMatchObject({ root: '%PROGRAMDATA%', ageDays: 966, reason: 'no-installed-software-match' })
  })
})

/* ------------------------------------------------------------------ */
/* 5. 扫描根                                                           */
/* ------------------------------------------------------------------ */

describe('扫描根', () => {
  it('默认根包含原有 4 个 + LOCALAPPDATA\\Programs + PROGRAMDATA', () => {
    const roots = defaultSuspectRoots({
      programFiles: 'C:\\Program Files',
      programFilesX86: 'C:\\Program Files (x86)',
      localAppData: 'C:\\Users\\me\\AppData\\Local',
      appData: 'C:\\Users\\me\\AppData\\Roaming',
      programData: 'C:\\ProgramData',
    })
    expect(roots.map((root) => root.label)).toEqual([
      'Program Files',
      'Program Files (x86)',
      '%LOCALAPPDATA%',
      '%APPDATA%',
      '%LOCALAPPDATA%\\Programs',
      '%PROGRAMDATA%',
    ])
    expect(roots.find((root) => root.label === '%LOCALAPPDATA%\\Programs')?.path).toBe('C:\\Users\\me\\AppData\\Local\\Programs')
    expect(roots.find((root) => root.label === '%PROGRAMDATA%')?.kind).toBe('program-data')
  })

  it('缺失的环境目录不会拼出空/重复根', () => {
    const roots = defaultSuspectRoots({ programFiles: 'C:\\Program Files', programFilesX86: '', localAppData: '', appData: '' })
    expect(roots.map((root) => root.label)).toEqual(['Program Files'])
  })
})

/* ------------------------------------------------------------------ */
/* 6. findSuspectDirectories 临时沙箱真实扫描                           */
/* ------------------------------------------------------------------ */

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'cc-leftovers-residual-'))
afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

describe('findSuspectDirectories 真实扫描（临时沙箱）', () => {
  const localAppData = path.join(sandbox, 'Local')
  const appData = path.join(sandbox, 'Roaming')
  const programData = path.join(sandbox, 'ProgramData')
  const programs = path.join(localAppData, 'Programs')
  const missingRoot = path.join(sandbox, 'NotExists')
  const oldDate = new Date(Date.now() - OLD)

  function makeOldDir(target: string): string {
    mkdirSync(target, { recursive: true })
    utimesSync(target, oldDate, oldDate)
    return target
  }

  const staleApp = makeOldDir(path.join(programs, 'Stale App'))
  const oldPublisher = makeOldDir(path.join(programData, 'Old Publisher'))
  const acmeWidgets = makeOldDir(path.join(programData, 'Acme Widgets'))
  const cordCleanData = makeOldDir(path.join(localAppData, 'CordClean', 'backups'))
  makeOldDir(path.join(localAppData, 'Temp', 'x'))
  makeOldDir(path.join(localAppData, 'node_modules'))
  const freshApp = path.join(programData, 'Fresh App')
  mkdirSync(freshApp, { recursive: true })

  const fakeEnv: TaskEnv = {
    platform: 'win32',
    arch: 'x64',
    elevated: false,
    username: 'tester',
    systemDrive: 'C:',
    windowsDir: 'C:\\Windows',
    // 指向沙箱内不存在的路径，保证测试不依赖 / 不触碰真实 Program Files
    programFiles: path.join(sandbox, 'PF'),
    programFilesX86: path.join(sandbox, 'PF86'),
    programData,
    appData,
    localAppData,
    userProfile: path.join(sandbox, 'User'),
    dataDir: path.join(localAppData, 'CordClean'),
    drives: ['C:', 'D:'],
    // 关键：返回 undefined，避免真实 %TEMP% 让沙箱路径被误排除
    get: () => undefined,
  }

  const entries = [
    uninstallEntry('Toolbar X', 'Acme Widgets GmbH', 'C:\\Program Files\\Toolbar X'),
    uninstallEntry('Acme Widgets Pro', '', 'C:\\Program Files\\Acme Widgets Pro'),
  ]

  it('只上报真正老且对不上的顶层目录，并给出完整统计', async () => {
    let stats: SuspectDirectoryStats | undefined
    const suspects = await findSuspectDirectories({
      env: fakeEnv,
      entries,
      roots: [
        { label: '%LOCALAPPDATA%', path: localAppData, kind: 'local-appdata' },
        { label: '%LOCALAPPDATA%\\Programs', path: programs, kind: 'local-programs' },
        { label: '%PROGRAMDATA%', path: programData, kind: 'program-data' },
        { label: '%MISSING%', path: missingRoot, kind: 'program-data' },
      ],
      onStats: (value) => {
        stats = value
      },
    })

    const names = suspects.map((suspect) => suspect.name).sort()
    expect(names).toEqual(['Old Publisher', 'Stale App'])
    // 真实扫描与单目录判定一致：年龄从 mtime 算出、根标签透传
    expect(suspects.find((suspect) => suspect.name === 'Stale App')).toMatchObject({
      path: staleApp,
      root: '%LOCALAPPDATA%\\Programs',
      rootKind: 'local-programs',
    })
    expect(suspects.find((suspect) => suspect.name === 'Old Publisher')).toMatchObject({
      path: oldPublisher,
      root: '%PROGRAMDATA%',
      rootKind: 'program-data',
    })

    // 统计证明新根确实被扫描、旧系统目录/自身目录被排除、发布者目录匹配生效
    expect(stats).toBeDefined()
    // 索引已除重：2 个显示名、1 个发布者、2 个安装目录
    expect(stats!.index).toEqual({ displayNames: 2, publishers: 1, installDirs: 2 })
    expect(stats!.roots).toHaveLength(4)
    expect(stats!.roots.find((root) => root.label === '%MISSING%')).toMatchObject({ readable: false, candidates: 0 })
    const programDataStat = stats!.roots.find((root) => root.label === '%PROGRAMDATA%')
    expect(programDataStat).toMatchObject({ readable: true, candidates: 3, suspects: 1 })
    expect(stats!.matched).toBeGreaterThanOrEqual(1)
    expect(stats!.skipped['excluded-path']).toBeGreaterThanOrEqual(1)
    expect(stats!.skipped['excluded-name']).toBeGreaterThanOrEqual(1)
    expect(stats!.skipped['too-new']).toBeGreaterThanOrEqual(1)
    expect(stats!.suspectTotal).toBe(2)
  })

  it('扫描结果可以生成带 note 的只提示草稿', async () => {
    const suspects = await findSuspectDirectories({ env: fakeEnv, entries })
    // 默认根里的 Program Files 等不存在时静默跳过，但沙箱里的 %LOCALAPPDATA% 仍会命中 Stale App
    expect(suspects.map((suspect) => suspect.name)).toContain('Stale App')
    // Acme Widgets 来自发布者匹配，不应出现在残留里
    expect(suspects.some((suspect) => suspect.name === 'Acme Widgets')).toBe(false)
    // CordClean 自身目录 / Temp / node_modules 不应出现
    for (const excluded of ['CordClean', 'Temp', 'node_modules']) {
      expect(suspects.some((suspect) => suspect.name === excluded)).toBe(false)
    }

    const draft = toSuspectDraft(
      {
        path: staleApp,
        name: 'Stale App',
        rootLabel: '%LOCALAPPDATA%\\Programs',
        rootKind: 'local-programs',
        ageDays: 200,
      },
      entries.length,
    )
    expect(draft.defaultSelected).toBe(false)
    expect(draft.recommended).toBe(false)
    expect(draft.note).toContain('Stale App')
    expect(draft.note).toContain('200 天')
    expect(draft.note).toContain('%LOCALAPPDATA%\\Programs')
  })

  // 沙箱夹具引用，避免“声明了但没用”的噪声
  it('沙箱夹具就位（用于证明扫描真的读了目录）', () => {
    expect(cordCleanData).toContain('CordClean')
    expect(acmeWidgets).toContain('Acme Widgets')
  })
})
