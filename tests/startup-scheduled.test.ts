/**
 * startup 插件计划任务「禁用 / 恢复」与权限标记单测。
 *
 * 所有外部命令都经注入的假 `CommandRunner` 执行：**不会调用真实 schtasks 或注册表**，
 * 因此测试不会改动本机任何启动项 / 计划任务。
 */
import { describe, expect, it } from 'vitest'
import type { CleanItem, TaskCleanContext, TaskEnv, TaskLogger } from '@cordclean/shared'
import type { CommandResult } from '@cordclean/utils'
import {
  buildRegistryDraft,
  buildScheduledTaskDraft,
  buildStartupFolderDraft,
  changeScheduledTaskState,
  disableScheduledTaskItem,
  normalizeTaskPath,
  restoreScheduledTask,
  scheduledTaskFullName,
  scheduledTaskRefFromItem,
} from '../packages/plugins/startup/src/index.ts'
import type { CommandRunner } from '../packages/plugins/startup/src/index.ts'

/* ------------------------------------------------------------------ */
/* 测试辅助：假执行器 / 假环境 / 清理项                                 */
/* ------------------------------------------------------------------ */

interface RunnerCall {
  file: string
  args: string[]
  options?: unknown
}

/** 构造记录调用参数的假执行器：handler 决定每次返回的命令结果 */
function createRunner(
  handler?: (file: string, args: string[]) => Partial<CommandResult> | Promise<Partial<CommandResult>>,
): { runner: CommandRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = []
  const runner: CommandRunner = async (file, args, options) => {
    calls.push({ file, args, options })
    const partial = (await handler?.(file, args)) ?? {}
    const ok = partial.ok ?? true
    return {
      ok,
      code: partial.code ?? (ok ? 0 : 1),
      stdout: partial.stdout ?? '',
      stderr: partial.stderr ?? '',
    }
  }
  return { runner, calls }
}

/** 静默日志：测试不关心日志内容 */
const silentLogger: TaskLogger = { debug() {}, info() {}, warn() {}, error() {} }

/** 构造任务环境（只有 elevated 影响权限错误映射） */
function fakeEnv(elevated = false): TaskEnv {
  return {
    platform: 'win32',
    arch: 'x64',
    elevated,
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
    drives: ['C:'],
    get: () => undefined,
  }
}

/** 构造清理上下文的最小实现 */
function fakeCleanContext(dryRun: boolean, elevated = false): Pick<TaskCleanContext, 'dryRun' | 'env' | 'logger' | 'signal'> {
  return {
    dryRun,
    env: fakeEnv(elevated),
    logger: silentLogger,
    signal: new AbortController().signal,
  }
}

/** 构造一条计划任务清理项（默认名称含空格、路径含反斜杠） */
function taskItem(overrides: Partial<CleanItem> = {}): CleanItem {
  return {
    id: 'startup:task-1',
    taskId: 'startup',
    title: 'BitLocker Encrypt All Drives',
    path: 'task:\\Microsoft\\Windows\\BitLocker\\BitLocker Encrypt All Drives',
    kind: 'entry',
    size: 0,
    risk: 'risky',
    category: 'startup',
    defaultSelected: false,
    meta: {
      taskName: 'BitLocker Encrypt All Drives',
      taskPath: '\\Microsoft\\Windows\\BitLocker\\',
      taskFullName: '\\Microsoft\\Windows\\BitLocker\\BitLocker Encrypt All Drives',
      kind: 'scheduled-task',
      action: 'disable',
      restorable: true,
      requiresAdmin: true,
    },
    ...overrides,
  }
}

const STANDARD_SUCCESS: Partial<CommandResult> = {
  ok: true,
  code: 0,
  stdout: '成功: 已成功更改计划任务 "\Microsoft\Windows\BitLocker\BitLocker Encrypt All Drives"。',
}

/* ------------------------------------------------------------------ */
/* schtasks 禁用 / 恢复                                                 */
/* ------------------------------------------------------------------ */

describe('计划任务禁用 / 恢复（注入 command runner）', () => {
  it('成功禁用：调用 schtasks /Change /TN <完整任务名> /DISABLE', async () => {
    const { runner, calls } = createRunner(() => STANDARD_SUCCESS)
    const change = await changeScheduledTaskState(
      runner,
      { taskName: 'NvDriverUpdateCheckDaily_{B2FE1952-0186-46C3-BAEC-A80AA35AC5B8}', taskPath: '\\' },
      'disable',
    )

    expect(change.ok).toBe(true)
    expect(change.taskName).toBe('\\NvDriverUpdateCheckDaily_{B2FE1952-0186-46C3-BAEC-A80AA35AC5B8}')
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('schtasks.exe')
    expect(calls[0].args).toEqual([
      '/Change',
      '/TN',
      '\\NvDriverUpdateCheckDaily_{B2FE1952-0186-46C3-BAEC-A80AA35AC5B8}',
      '/DISABLE',
    ])
  })

  it('任务名含空格、路径含反斜杠时 /TN 始终是单个参数（不拆词、无需手工加引号）', async () => {
    const { runner, calls } = createRunner(() => STANDARD_SUCCESS)
    // 故意省略首尾反斜杠，验证规范化后再交给 schtasks
    const change = await changeScheduledTaskState(
      runner,
      { taskName: 'Scheduled Start', taskPath: 'Microsoft\\Windows\\Windows Update' },
      'disable',
    )

    expect(change.ok).toBe(true)
    expect(change.taskName).toBe('\\Microsoft\\Windows\\Windows Update\\Scheduled Start')
    expect(calls[0].args).toEqual(['/Change', '/TN', '\\Microsoft\\Windows\\Windows Update\\Scheduled Start', '/DISABLE'])
    expect(calls[0].args[2]).toContain(' ')
    expect(calls[0].args[2]).toContain('\\')
    // 除 /TN 的值以外没有额外参数被拆出来
    expect(calls[0].args).toHaveLength(4)
  })

  it('权限不足：返回可读的管理员权限错误（带原始输出）', async () => {
    const { runner } = createRunner(() => ({
      ok: false,
      code: 1,
      stdout: '',
      stderr: 'ERROR: Access is denied.',
    }))
    const change = await changeScheduledTaskState(runner, { taskName: 'Foo Bar', taskPath: '\\Microsoft\\Windows\\' }, 'disable')

    expect(change.ok).toBe(false)
    expect(change.code).toBe(1)
    expect(change.error).toContain('需要管理员权限')
    expect(change.error).toContain('Access is denied')
    expect(change.detail).toContain('Access is denied')
  })

  it('任务不存在：返回可读的「不存在」错误', async () => {
    const { runner } = createRunner(() => ({
      ok: false,
      code: 1,
      stdout: '',
      stderr: 'ERROR: The system cannot find the file specified.',
    }))
    const change = await changeScheduledTaskState(runner, { taskName: 'Ghost Task', taskPath: '\\' }, 'disable')

    expect(change.ok).toBe(false)
    expect(change.error).toContain('计划任务不存在')
    expect(change.error).toContain('Ghost Task')
  })

  it('其它退出码：错误包含退出码与原始输出，不吞失败', async () => {
    const { runner } = createRunner(() => ({
      ok: false,
      code: 5,
      stdout: '',
      stderr: 'ERROR: The operation completed with errors.',
    }))
    const change = await changeScheduledTaskState(runner, { taskName: 'Foo', taskPath: '\\' }, 'disable')

    expect(change.ok).toBe(false)
    expect(change.code).toBe(5)
    expect(change.error).toContain('退出码 5')
    expect(change.error).toContain('The operation completed with errors')
  })

  it('执行器自身抛异常：返回可读错误而不是崩溃', async () => {
    const runner: CommandRunner = async () => {
      throw new Error('spawn schtasks.exe ENOENT')
    }
    const change = await changeScheduledTaskState(runner, { taskName: 'Foo', taskPath: '\\' }, 'disable')

    expect(change.ok).toBe(false)
    expect(change.code).toBe(-1)
    expect(change.error).toContain('无法执行 schtasks')
    expect(change.error).toContain('ENOENT')
  })

  it('enable 恢复：传 /ENABLE（清理动作的逆操作）', async () => {
    const { runner, calls } = createRunner(() => STANDARD_SUCCESS)
    const change = await restoreScheduledTask(runner, { taskName: 'Scheduled Start', taskPath: '\\Microsoft\\Windows\\Windows Update\\' })

    expect(change.ok).toBe(true)
    expect(calls[0].args).toEqual(['/Change', '/TN', '\\Microsoft\\Windows\\Windows Update\\Scheduled Start', '/ENABLE'])
  })

  it('dryRun：只返回 ok，绝不调用执行器（无副作用）', async () => {
    const { runner, calls } = createRunner()
    const result = await disableScheduledTaskItem(taskItem(), fakeCleanContext(true), runner)

    expect(result).toMatchObject({ ok: true, itemId: 'startup:task-1', bytes: 0 })
    expect(calls).toHaveLength(0)
  })

  it('真实清理路径：禁用成功返回 ok，调用 /DISABLE', async () => {
    const { runner, calls } = createRunner(() => STANDARD_SUCCESS)
    const result = await disableScheduledTaskItem(taskItem(), fakeCleanContext(false), runner)

    expect(result).toMatchObject({ ok: true, bytes: 0 })
    expect(calls).toHaveLength(1)
    expect(calls[0].args.at(-1)).toBe('/DISABLE')
  })

  it('真实清理路径：权限不足时返回可读错误并提示管理员', async () => {
    const { runner } = createRunner(() => ({ ok: false, code: 1, stdout: '', stderr: 'ERROR: Access is denied.' }))
    const result = await disableScheduledTaskItem(taskItem(), fakeCleanContext(false), runner)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('需要管理员权限')
  })

  it('清理项缺少任务名时返回可读失败，不执行命令', async () => {
    const { runner, calls } = createRunner()
    const result = await disableScheduledTaskItem(
      taskItem({ path: 'task:', meta: {} }),
      fakeCleanContext(false),
      runner,
    )

    expect(result.ok).toBe(false)
    expect(result.error).toContain('无法解析计划任务名称')
    expect(calls).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ */
/* 路径规范化与清理项还原                                              */
/* ------------------------------------------------------------------ */

describe('计划任务名称规范化', () => {
  it('normalizeTaskPath / scheduledTaskFullName 处理缺省首尾反斜杠', () => {
    expect(normalizeTaskPath('\\')).toBe('\\')
    expect(normalizeTaskPath(undefined)).toBe('\\')
    expect(normalizeTaskPath('/Microsoft/Windows')).toBe('\\Microsoft\\Windows\\')
    expect(normalizeTaskPath('Microsoft\\Windows\\')).toBe('\\Microsoft\\Windows\\')
    expect(scheduledTaskFullName({ taskName: 'Foo', taskPath: '\\' })).toBe('\\Foo')
    expect(scheduledTaskFullName({ taskName: 'Scheduled Start', taskPath: '\\Microsoft\\Windows\\Windows Update' })).toBe(
      '\\Microsoft\\Windows\\Windows Update\\Scheduled Start',
    )
  })

  it('scheduledTaskRefFromItem 兼容 meta 字段与旧版 path: task:', () => {
    expect(
      scheduledTaskRefFromItem({
        path: 'task:\\Microsoft\\Windows\\Foo Bar',
        meta: { taskName: 'Foo Bar', taskPath: '\\Microsoft\\Windows' },
      }),
    ).toEqual({ taskName: 'Foo Bar', taskPath: '\\Microsoft\\Windows\\' })
    expect(scheduledTaskRefFromItem({ path: 'task:\\Microsoft\\Windows\\Foo Bar' })).toEqual({
      taskName: 'Foo Bar',
      taskPath: '\\Microsoft\\Windows\\',
    })
    expect(scheduledTaskRefFromItem({ path: 'task:\\Foo', meta: { taskFullName: '\\Foo' } })).toEqual({
      taskName: 'Foo',
      taskPath: '\\',
    })
    expect(scheduledTaskRefFromItem({ path: 'task:' })).toBeUndefined()
    expect(scheduledTaskRefFromItem({ path: 'C:\\no-task.txt' })).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ */
/* 清理项标记：禁用语义与 requiresAdmin                                 */
/* ------------------------------------------------------------------ */

describe('计划任务清理项标记', () => {
  it('标注 action=disable、可恢复、risky、默认不勾选、需要管理员', () => {
    const draft = buildScheduledTaskDraft(
      { taskName: 'BitLocker Encrypt All Drives', taskPath: '\\Microsoft\\Windows\\BitLocker\\' },
      '就绪',
    )

    expect(draft.kind).toBe('entry')
    expect(draft.risk).toBe('risky')
    expect(draft.defaultSelected).toBe(false)
    expect(draft.path).toBe('task:\\Microsoft\\Windows\\BitLocker\\BitLocker Encrypt All Drives')
    expect(draft.note).toContain('可恢复')
    expect(draft.note).toContain('管理员权限')
    expect(draft.meta).toMatchObject({
      kind: 'scheduled-task',
      action: 'disable',
      restorable: true,
      requiresAdmin: true,
      taskName: 'BitLocker Encrypt All Drives',
      taskPath: '\\Microsoft\\Windows\\BitLocker\\',
      taskFullName: '\\Microsoft\\Windows\\BitLocker\\BitLocker Encrypt All Drives',
    })
  })
})

describe('HKLM / 公共启动文件夹的权限标记', () => {
  const hklm: Parameters<typeof buildRegistryDraft>[0] = {
    alias: 'HKLM-Run',
    keyPath: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run',
    psPath: 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run',
    label: '所有用户启动（Run）',
    machine: true,
  }
  const hkcu: Parameters<typeof buildRegistryDraft>[0] = {
    ...hklm,
    alias: 'HKCU-Run',
    keyPath: 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    psPath: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    label: '当前用户启动（Run）',
    machine: false,
  }

  it('HKLM Run 项标记 requiresAdmin，note 提示管理员权限', () => {
    const draft = buildRegistryDraft(hklm, { name: 'TranslucentTB', value: '"C:\\Program Files\\TranslucentTB.exe"' })
    expect(draft.meta).toMatchObject({ kind: 'registry', requiresAdmin: true })
    expect(draft.note).toContain('管理员权限')
  })

  it('HKCU Run 项不要求管理员', () => {
    const draft = buildRegistryDraft(hkcu, { name: 'OneDrive', value: '"C:\\OneDrive.exe"' })
    expect(draft.meta).toMatchObject({ kind: 'registry', requiresAdmin: false })
    expect(draft.note).not.toContain('管理员')
  })

  it('所有用户启动文件夹项标记 requiresAdmin；当前用户文件夹不要求', () => {
    const common = buildStartupFolderDraft(
      { key: 'common-startup', label: '所有用户启动文件夹', path: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Startup' },
      { path: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\demo.lnk', size: 12, name: 'demo.lnk' },
      true,
    )
    expect(common.meta).toMatchObject({ kind: 'startup-folder', requiresAdmin: true })
    expect(common.note).toContain('管理员权限')

    const user = buildStartupFolderDraft(
      { key: 'user-startup', label: '当前用户启动文件夹', path: 'C:\\Users\\tester\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup' },
      { path: 'C:\\Users\\tester\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\demo.lnk', size: 12, name: 'demo.lnk' },
      false,
    )
    expect(user.meta).toMatchObject({ kind: 'startup-folder', requiresAdmin: false })
    expect(user.note).toContain('受内核路径保护')
  })
})
