/**
 * registry 插件「孤儿卸载项」判定（纯逻辑）单测。
 *
 * 背景：本机真实注册表里的 79 个卸载项**全部**指向存在的目录/卸载程序（0 命中），
 * 因此真实扫描只能证明「没有误报」；阳性路径必须由本文件的注入式用例覆盖，
 * 不允许伪造真实命中。
 *
 * 覆盖点（对应任务要求）：
 * 1. 安装目录不存在（InstallLocation 命中）；
 * 2. 卸载程序 exe 不存在（UninstallString 命中，含引号 + 参数、未加引号形式）；
 * 3. 网络路径（UNC）跳过且不发起探测；环境变量可展开 / 不可展开两种情况；
 * 4. DisplayName 为空不判定（与 isJunkUninstall 的垃圾键判定不重叠）；
 * 5. 正常条目、存在性检查抛错、无法解析的命令一律不误报；
 * 6. 真实扫描的只读安全性：判定层只调用注入的 exists，不执行任何命令。
 */
import { describe, expect, it } from 'vitest'
import {
  describeOrphanFailure,
  detectOrphanUninstall,
  isJunkUninstall,
  isReliablyEncodedField,
  parseUninstallCommand,
  probeRegistryProblems,
  resolveRegistryPath,
} from '@cordclean/plugin-registry'
import type { UninstallEntrySnapshot } from '@cordclean/plugin-registry'
import type { TaskEnv } from '@cordclean/shared'

/* ------------------------------------------------------------------ */
/* 测试辅助                                                            */
/* ------------------------------------------------------------------ */

/** 只读环境变量替身（真实扫描里是 TaskEnv.get） */
const ENV: Record<string, string> = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  SystemRoot: 'C:\\Windows',
  USERPROFILE: 'C:\\Users\\tester',
}
const envLookup = (name: string): string | undefined => ENV[name]

/** 记录被探测路径的假存在性检查器（默认「不存在」） */
function recorder(result: boolean | ((target: string) => boolean) = false) {
  const calls: string[] = []
  const exists = (target: string): boolean => {
    calls.push(target)
    return typeof result === 'function' ? result(target) : result
  }
  return { calls, exists }
}

/** 构造一条卸载项快照 */
function entry(overrides: Partial<UninstallEntrySnapshot> = {}): UninstallEntrySnapshot {
  return {
    key: 'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Ghost',
    displayName: 'Ghost App 1.0',
    installLocation: 'C:\\Program Files\\Ghost',
    uninstallString: '"C:\\Program Files\\Ghost\\unins000.exe" /S',
    ...overrides,
  }
}

/* ------------------------------------------------------------------ */
/* 一、路径清洗                                                        */
/* ------------------------------------------------------------------ */

describe('resolveRegistryPath：可验证路径的保守清洗', () => {
  it('去尾部反斜杠 + 去掉包裹引号，得到规范化绝对路径', () => {
    expect(resolveRegistryPath('"C:\\Program Files\\App\\"')).toEqual({
      path: 'C:\\Program Files\\App',
      network: false,
    })
  })

  it('展开 %VAR% 环境变量', () => {
    expect(resolveRegistryPath('%ProgramFiles%\\App\\unins.exe', envLookup)).toEqual({
      path: 'C:\\Program Files\\App\\unins.exe',
      network: false,
    })
  })

  it('环境变量无法展开时判为不可验证（不能把 %X% 当空串）', () => {
    const resolved = resolveRegistryPath('%NOT_SET%\\App', envLookup)
    expect(resolved.path).toBe('')
    expect(resolved.reason).toBe('unresolved-variable')
  })

  it('网络路径（UNC）标记为 network 且不参与存在性检查', () => {
    const resolved = resolveRegistryPath('\\\\server\\share\\App', envLookup)
    expect(resolved.network).toBe(true)
    expect(resolved.reason).toBe('network-path')
    expect(resolved.path).toBe('\\\\server\\share\\App')
  })

  it('相对路径 / 设备路径一律判为不可验证', () => {
    expect(resolveRegistryPath('App\\unins.exe', envLookup).reason).toBe('not-absolute')
    expect(resolveRegistryPath('\\\\.\\C:\\App', envLookup).reason).toBe('not-absolute')
  })

  it('长路径前缀被还原为普通盘符路径（与 isAbsolutePath 语义一致）', () => {
    expect(resolveRegistryPath('\\\\?\\C:\\Program Files\\App', envLookup).path).toBe('C:\\Program Files\\App')
  })

  it('盘符不在当前磁盘列表时跳过（避免把断开的网络映射盘当孤儿）', () => {
    expect(resolveRegistryPath('E:\\Apps\\Ghost', envLookup, ['C:', 'D:']).reason).toBe('unknown-drive')
    expect(resolveRegistryPath('D:\\Apps\\Ghost', envLookup, ['C:', 'D:'])).toEqual({
      path: 'D:\\Apps\\Ghost',
      network: false,
    })
  })
})

/* ------------------------------------------------------------------ */
/* 二、UninstallString 解析（只解析字符串，绝不执行）                    */
/* ------------------------------------------------------------------ */

describe('parseUninstallCommand：引号/参数/命令形式的正确解析', () => {
  it('引号包裹的 exe + 参数：参数原样保留，不作为路径验证', () => {
    expect(parseUninstallCommand('"C:\\Program Files\\App\\unins000.exe" /S')).toEqual({
      executable: 'C:\\Program Files\\App\\unins000.exe',
      args: '/S',
    })
  })

  it('引号内的环境变量会先展开再解析', () => {
    expect(parseUninstallCommand('"%ProgramFiles%\\App\\unins.exe" /SILENT', envLookup)).toEqual({
      executable: 'C:\\Program Files\\App\\unins.exe',
      args: '/SILENT',
    })
  })

  it('未加引号、无参数：整串即 exe', () => {
    expect(parseUninstallCommand('C:\\Program Files\\DAUM\\PotPlayer\\uninstall.exe', envLookup)).toEqual({
      executable: 'C:\\Program Files\\DAUM\\PotPlayer\\uninstall.exe',
      args: '',
    })
  })

  it('未加引号、带参数：取到首个 .exe 边界，参数原文保留', () => {
    expect(parseUninstallCommand('C:\\App\\unins000.exe --mode=uninstall /S')).toEqual({
      executable: 'C:\\App\\unins000.exe',
      args: '--mode=uninstall /S',
    })
  })

  it('MsiExec.exe 这类依赖 PATH 的命令无法确认绝对路径 ⇒ 跳过，不发存在性检查', () => {
    const parsed = parseUninstallCommand('MsiExec.exe /X{010792BA-551A-3AC0-A7EF-0FAB4156C382}')
    expect(parsed.executable).toBeUndefined()
    expect(parsed.reason).toBe('not-absolute')
  })

  it('引号不闭合 / 空字符串 / UNC 网络 exe ⇒ 一律不可验证', () => {
    expect(parseUninstallCommand('"C:\\App\\unins.exe').reason).toBe('unparseable-command')
    expect(parseUninstallCommand('   ').reason).toBe('no-path-fields')
    expect(parseUninstallCommand('"\\\\server\\share\\unins.exe" /S').reason).toBe('network-path')
  })

  it('真实 NVIDIA 形式：rundll32.exe + DLL 参数，只把 exe 当可验证路径', () => {
    const parsed = parseUninstallCommand(
      '"C:\\Windows\\SysWOW64\\RunDll32.EXE" "C:\\Program Files\\NVIDIA Corporation\\Installer2\\InstallerCore\\NVI2.DLL",UninstallPackage Display.Driver',
      envLookup,
    )
    expect(parsed.executable).toBe('C:\\Windows\\SysWOW64\\RunDll32.EXE')
    expect(parsed.args).toContain('NVI2.DLL')
  })
})

/* ------------------------------------------------------------------ */
/* 三、孤儿判定：阳性用例（注入存在性检查）                              */
/* ------------------------------------------------------------------ */

describe('detectOrphanUninstall：安装目录 / 卸载程序缺失的阳性判定', () => {
  it('InstallLocation 目录不存在 ⇒ install-location-missing，且只探测该目录', async () => {
    const { calls, exists } = recorder(false)
    const result = await detectOrphanUninstall([entry({ uninstallString: '' })], { exists, env: envLookup })

    expect(result.orphans).toHaveLength(1)
    const orphan = result.orphans[0]!
    expect(orphan.reason).toBe('install-location-missing')
    expect(orphan.targetPath).toBe('C:\\Program Files\\Ghost')
    expect(orphan.displayName).toBe('Ghost App 1.0')
    expect(result.checkedPaths).toBe(1)
    // 只探测解析后的目录，不探测参数、不执行任何命令
    expect(calls).toEqual(['C:\\Program Files\\Ghost'])
  })

  it('UninstallString 指向的 exe 不存在 ⇒ uninstall-exe-missing', async () => {
    const result = await detectOrphanUninstall(
      [entry({ installLocation: '', uninstallString: '"C:\\Program Files\\Ghost\\unins000.exe" /S' })],
      { exists: () => false, env: envLookup },
    )
    expect(result.orphans).toHaveLength(1)
    expect(result.orphans[0]!.reason).toBe('uninstall-exe-missing')
    expect(result.orphans[0]!.targetPath).toBe('C:\\Program Files\\Ghost\\unins000.exe')
    expect(result.checkedPaths).toBe(1)
  })

  it('目录存在但 exe 不存在 / 目录不存在但 exe 存在 ⇒ 都能单独命中', async () => {
    const onlyExeMissing = await detectOrphanUninstall(
      [entry({ installLocation: 'C:\\Program Files\\App' })],
      { exists: (target) => target.endsWith('.exe') ? false : true, env: envLookup },
    )
    expect(onlyExeMissing.orphans.map((item) => item.reason)).toEqual(['uninstall-exe-missing'])

    const onlyDirMissing = await detectOrphanUninstall(
      [entry({ installLocation: 'C:\\Program Files\\App', uninstallString: '"C:\\Program Files\\App\\unins.exe"' })],
      { exists: (target) => target.endsWith('.exe') ? true : false, env: envLookup },
    )
    expect(onlyDirMissing.orphans.map((item) => item.reason)).toEqual(['install-location-missing'])
  })

  it('两条证据同时命中：failures 保留两条，主原因优先 exe 缺失', async () => {
    const result = await detectOrphanUninstall([entry()], { exists: () => false, env: envLookup })
    const orphan = result.orphans[0]!
    expect(orphan.reason).toBe('uninstall-exe-missing')
    expect(orphan.failures.map((failure) => failure.reason)).toEqual([
      'install-location-missing',
      'uninstall-exe-missing',
    ])
    expect(describeOrphanFailure(orphan.failures[0]!)).toContain('C:\\Program Files\\Ghost')
    expect(describeOrphanFailure(orphan.failures[1]!)).toContain('unins000.exe')
  })

  it('环境变量展开后再检查存在性（%ProgramFiles% → C:\\Program Files）', async () => {
    const { calls, exists } = recorder(false)
    const result = await detectOrphanUninstall(
      [entry({ installLocation: '%ProgramFiles%\\Ghost', uninstallString: '' })],
      { exists, env: envLookup },
    )
    expect(result.orphans).toHaveLength(1)
    expect(calls).toEqual(['C:\\Program Files\\Ghost'])
  })

  it('支持异步存在性检查注入', async () => {
    const result = await detectOrphanUninstall([entry()], {
      exists: async () => false,
      env: envLookup,
    })
    expect(result.orphans).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------ */
/* 四、孤儿判定：阴性 / 不误报用例                                       */
/* ------------------------------------------------------------------ */

describe('detectOrphanUninstall：不误报与安全跳过', () => {
  it('正常条目（目录与 exe 都存在）不命中', async () => {
    const { calls, exists } = recorder(true)
    const result = await detectOrphanUninstall([entry()], { exists, env: envLookup })
    expect(result.orphans).toHaveLength(0)
    expect(result.skipped).toHaveLength(0)
    expect(result.checkedPaths).toBe(2)
    expect(calls).toHaveLength(2)
  })

  it('DisplayName 为空不判定（垃圾键由 isJunkUninstall 负责，两类判定不重叠）', async () => {
    expect(isJunkUninstall([], 0)).toBe(true) // 现有垃圾键判定
    const { calls, exists } = recorder(false)
    const result = await detectOrphanUninstall(
      [entry({ displayName: '   ', installLocation: 'C:\\Program Files\\Ghost', uninstallString: '' })],
      { exists, env: envLookup },
    )
    expect(result.orphans).toHaveLength(0)
    expect(result.skipped).toEqual([
      expect.objectContaining({ field: 'entry', reason: 'display-name-empty' }),
    ])
    expect(calls).toHaveLength(0)
  })

  it('两个路径字段都为空 ⇒ 跳过，不发起任何探测', async () => {
    const { calls, exists } = recorder(false)
    const result = await detectOrphanUninstall(
      [entry({ installLocation: '', uninstallString: '' })],
      { exists, env: envLookup },
    )
    expect(result.orphans).toHaveLength(0)
    expect(result.skipped[0]!.reason).toBe('no-path-fields')
    expect(calls).toHaveLength(0)
  })

  it('网络路径（UNC）⇒ 跳过且绝不访问网络位置', async () => {
    const { calls, exists } = recorder(false)
    const result = await detectOrphanUninstall(
      [entry({ installLocation: '\\\\server\\share\\Ghost', uninstallString: '"\\\\server\\share\\unins.exe" /S' })],
      { exists, env: envLookup },
    )
    expect(result.orphans).toHaveLength(0)
    expect(result.checkedPaths).toBe(0)
    expect(result.skipped.map((item) => item.reason)).toEqual(['network-path', 'network-path'])
    expect(calls).toHaveLength(0)
  })

  it('无法展开的环境变量 ⇒ 跳过，不把空串当路径探测', async () => {
    const { calls, exists } = recorder(false)
    const result = await detectOrphanUninstall(
      [entry({ installLocation: '%NOT_SET%\\Ghost', uninstallString: '' })],
      { exists, env: envLookup },
    )
    expect(result.orphans).toHaveLength(0)
    expect(result.skipped[0]!.reason).toBe('unresolved-variable')
    expect(calls).toHaveLength(0)
  })

  it('盘符不在已知磁盘列表 ⇒ 跳过（断开映射盘不误报）', async () => {
    const { calls, exists } = recorder(false)
    const result = await detectOrphanUninstall(
      [entry({ installLocation: 'E:\\Ghost', uninstallString: '' })],
      { exists, env: envLookup, knownDrives: ['C:', 'D:'] },
    )
    expect(result.orphans).toHaveLength(0)
    expect(result.skipped[0]!.reason).toBe('unknown-drive')
    expect(calls).toHaveLength(0)
  })

  it('存在性检查抛错 ⇒ 保守视为存在，不产生误报', async () => {
    const result = await detectOrphanUninstall([entry()], {
      exists: () => {
        throw Object.assign(new Error('拒绝访问'), { code: 'EACCES' })
      },
      env: envLookup,
    })
    expect(result.orphans).toHaveLength(0)
    expect(result.checkedPaths).toBe(2)
  })

  it('MsiExec 形式 / 无法解析的命令 ⇒ 跳过，不探测也不命中', async () => {
    const { calls, exists } = recorder(false)
    const result = await detectOrphanUninstall(
      [entry({ installLocation: '', uninstallString: 'MsiExec.exe /X{010792BA-551A-3AC0-A7EF-0FAB4156C382}' })],
      { exists, env: envLookup },
    )
    expect(result.orphans).toHaveLength(0)
    expect(result.skipped[0]!.field).toBe('uninstallString')
    expect(result.skipped[0]!.reason).toBe('not-absolute')
    expect(calls).toHaveLength(0)
  })

  it('空 key 条目被忽略（不会产生无路径的清理项）', async () => {
    const result = await detectOrphanUninstall([entry({ key: '  ' })], { exists: () => false, env: envLookup })
    expect(result.orphans).toHaveLength(0)
    expect(result.skipped).toHaveLength(0)
    expect(result.checkedPaths).toBe(0)
  })

  it('多条条目保持输入顺序，只输出命中的孤儿项', async () => {
    const appA = entry({
      key: 'HKEY_LOCAL_MACHINE\\A',
      displayName: 'App A',
      installLocation: 'C:\\Program Files\\A',
      uninstallString: '"C:\\Program Files\\A\\unins.exe"',
    })
    const appB = entry({
      key: 'HKEY_LOCAL_MACHINE\\B',
      displayName: 'App B',
      installLocation: 'C:\\Program Files\\B',
      uninstallString: '"C:\\Program Files\\B\\unins.exe"',
    })
    const appC = entry({
      key: 'HKEY_LOCAL_MACHINE\\C',
      displayName: 'App C',
      installLocation: 'C:\\Program Files\\C',
      uninstallString: '',
    })
    // 只有 B 的目录与 exe 存在；A（目录+exe 缺失）与 C（目录缺失）应命中
    const result = await detectOrphanUninstall([appA, appB, appC], {
      exists: (target: string) => target.startsWith('C:\\Program Files\\B'),
      env: envLookup,
    })
    expect(result.orphans.map((item) => item.key)).toEqual(['HKEY_LOCAL_MACHINE\\A', 'HKEY_LOCAL_MACHINE\\C'])
  })
})

/* ------------------------------------------------------------------ */
/* 五、reg.exe 回退编码防护（真实误报回归）                              */
/* ------------------------------------------------------------------ */

describe('isReliablyEncodedField：reg.exe 回退 GBK 乱码防护', () => {
  it('纯 ASCII 字段（含空值）可信', () => {
    expect(isReliablyEncodedField('')).toBe(true)
    expect(isReliablyEncodedField('C:\\Program Files\\7-Zip\\Uninstall.exe')).toBe(true)
    expect(isReliablyEncodedField('"C:\\Program Files\\App\\unins.exe" /S')).toBe(true)
  })

  it('中文 / UTF-8 替换字符（GBK 输出被按 UTF-8 解码的乱码）不可信', () => {
    // 真实案例：HKLM\...\WOW6432Node\...\Uninstall\{a9be7c93-...}（完美世界竞技平台）
    expect(isReliablyEncodedField('D:\\Program Files (x86)\\perfectworldarena\\Uninstall 完美世界竞技平台.exe')).toBe(
      false,
    )
    expect(isReliablyEncodedField('D:\\Program Files (x86)\\perfectworldarena\\Uninstall ���������ƽ̨.exe')).toBe(false)
  })

  it('乱码路径若未过滤会被误判为孤儿（所以回退路径必须先过滤）', async () => {
    const result = await detectOrphanUninstall(
      [
        entry({
          displayName: '完美世界竞技平台 1.0.26111211',
          installLocation: '',
          uninstallString: '"D:\\Program Files (x86)\\perfectworldarena\\Uninstall ���������ƽ̨.exe" /allusers',
        }),
      ],
      { exists: () => false, env: envLookup },
    )
    expect(result.orphans).toHaveLength(1)
    // 该条目的字段不可信，回退扫描会先被 isReliablyEncodedField 过滤掉，不会上报
    expect(isReliablyEncodedField(result.orphans[0]!.uninstallString)).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* 六、真实探测入口的只读安全形状                                       */
/* ------------------------------------------------------------------ */

describe('probeRegistryProblems：关闭检查时不触碰注册表且返回新字段', () => {
  it('checkUninstall/checkAppPaths 都关闭 → 直接返回空结果（不执行 PowerShell/reg.exe）', async () => {
    const fakeEnv: TaskEnv = {
      platform: 'win32',
      arch: 'x64',
      elevated: false,
      username: 'tester',
      systemDrive: 'C:',
      windowsDir: 'C:\\Windows',
      programFiles: 'C:\\Program Files',
      programFilesX86: 'C:\\Program Files (x86)',
      programData: 'C:\\ProgramData',
      appData: 'C:\\Users\\tester\\AppData\\Roaming',
      localAppData: 'C:\\Users\\tester\\AppData\\Local',
      userProfile: 'C:\\Users\\tester',
      dataDir: 'C:\\Users\\tester\\AppData\\Local\\CordClean',
      drives: ['C:', 'D:'],
      get: () => undefined,
    }
    const probe = await probeRegistryProblems(fakeEnv, { checkUninstall: false, checkAppPaths: false })
    expect(probe.junkUninstall).toEqual([])
    expect(probe.orphanUninstall).toEqual([])
    expect(probe.brokenAppPaths).toEqual([])
    expect(probe.checkedUninstall).toBe(0)
    expect(probe.checkedAppPaths).toBe(0)
    expect(probe.checkedOrphanPaths).toBe(0)
    expect(probe.skippedOrphanFields).toBe(0)
    expect(probe.warnings).toEqual([])
  })
})
