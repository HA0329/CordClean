/**
 * empty-dirs 白名单回归：AppData / Program Files / Windows / ProgramData / CordClean 自身数据目录
 * 下的空目录不得上报；普通用户目录（Documents/Downloads 等）仍可上报。
 */
import { describe, expect, it } from 'vitest'
import { buildSkipPrefixes, isWhitelistedPath } from '../packages/plugins/empty-dirs/src/whitelist.ts'

const env = {
  userProfile: 'C:\\Users\\me',
  dataDir: 'C:\\Users\\me\\AppData\\Local\\CordClean',
  appData: 'C:\\Users\\me\\AppData\\Roaming',
  localAppData: 'C:\\Users\\me\\AppData\\Local',
  programData: 'C:\\ProgramData',
  windowsDir: 'C:\\Windows',
  programFiles: 'C:\\Program Files',
  programFilesX86: 'C:\\Program Files (x86)',
}
const prefixes = buildSkipPrefixes(env)

describe('empty-dirs 白名单', () => {
  it('AppData 下的应用占位目录被排除', () => {
    expect(isWhitelistedPath('C:\\Users\\me\\AppData\\Local\\Microsoft\\PowerPoint', prefixes)).toBe(true)
    expect(isWhitelistedPath('C:\\Users\\me\\AppData\\Local\\pip', prefixes)).toBe(true)
    expect(isWhitelistedPath('C:\\Users\\me\\AppData\\Roaming\\Tencent', prefixes)).toBe(true)
  })

  it('CordClean 自身数据目录（隔离区）被排除', () => {
    expect(isWhitelistedPath('C:\\Users\\me\\AppData\\Local\\CordClean\\quarantine', prefixes)).toBe(true)
  })

  it('Program Files / ProgramData / Windows 被排除', () => {
    expect(isWhitelistedPath('C:\\Program Files\\SomeApp\\empty', prefixes)).toBe(true)
    expect(isWhitelistedPath('C:\\Program Files (x86)\\SomeApp', prefixes)).toBe(true)
    expect(isWhitelistedPath('C:\\ProgramData\\SomeApp', prefixes)).toBe(true)
    expect(isWhitelistedPath('C:\\Windows\\Temp\\empty', prefixes)).toBe(true)
  })

  it('普通用户目录仍会上报（不被白名单误杀）', () => {
    expect(isWhitelistedPath('C:\\Users\\me\\Documents\\empty-dir', prefixes)).toBe(false)
    expect(isWhitelistedPath('C:\\Users\\me\\Downloads\\empty', prefixes)).toBe(false)
    expect(isWhitelistedPath('D:\\备份\\空目录', prefixes)).toBe(false)
  })

  it('前缀边界不误判（Program Files2 不是 Program Files 的子目录）', () => {
    expect(isWhitelistedPath('C:\\Program Files2\\x', prefixes)).toBe(false)
  })
})
