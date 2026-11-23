/**
 * large-files / duplicates 排除表回归：
 * 应用运行时库（.dll/.onnx 等）与 Program Files/ProgramData/Windows/用户安装目录不参与
 * 「大文件清理」「重复文件删除」；普通缓存/媒体文件仍参与。
 */
import { describe, expect, it } from 'vitest'
import { shouldExcludeLargeFile } from '../packages/plugins/large-files/src/exclude.ts'
import { shouldExcludeDuplicateFile } from '../packages/plugins/duplicates/src/exclude.ts'

const env = {
  userProfile: 'C:\\Users\\me',
  localAppData: 'C:\\Users\\me\\AppData\\Local',
  programFiles: 'C:\\Program Files',
  programFilesX86: 'C:\\Program Files (x86)',
  windowsDir: 'C:\\Windows',
  programData: 'C:\\ProgramData',
}

describe('large-files 排除表', () => {
  it('微信运行时 flue.dll 这类 .dll 不再作为可清理大文件', () => {
    expect(shouldExcludeLargeFile('C:\\Users\\me\\AppData\\Roaming\\Tencent\\xwechat\\xplugin\\flue.dll', env)).toBe(true)
  })

  it('程序/系统目录里的文件被排除', () => {
    expect(shouldExcludeLargeFile('C:\\Program Files\\App\\data.bin', env)).toBe(true)
    expect(shouldExcludeLargeFile('C:\\ProgramData\\App\\big.dat', env)).toBe(true)
    expect(shouldExcludeLargeFile('C:\\Windows\\Temp\\big.dat', env)).toBe(true)
    expect(shouldExcludeLargeFile('C:\\Users\\me\\AppData\\Local\\Programs\\App\\big.bin', env)).toBe(true)
  })

  it('缓存/归档/媒体文件仍可上报', () => {
    expect(shouldExcludeLargeFile('C:\\Users\\me\\AppData\\Local\\NVIDIA\\DXCache\\a.nvph', env)).toBe(false)
    expect(shouldExcludeLargeFile('C:\\Users\\me\\AppData\\Local\\electron\\Cache\\electron.zip', env)).toBe(false)
    expect(shouldExcludeLargeFile('D:\\Videos\\movie.mp4', env)).toBe(false)
  })

  it('扩展名大小写不敏感，前缀边界不误判', () => {
    expect(shouldExcludeLargeFile('C:\\Users\\me\\x.DLL', env)).toBe(true)
    expect(shouldExcludeLargeFile('C:\\Program Files2\\big.bin', env)).toBe(false)
  })
})

describe('duplicates 排除表', () => {
  it('应用内部 DLL / onnx 模型 / 系统数据库被排除', () => {
    expect(shouldExcludeDuplicateFile('C:\\Users\\me\\AppData\\Local\\NVIDIA Corporation\\x\\Ontology64.dll', env)).toBe(true)
    expect(shouldExcludeDuplicateFile('C:\\Users\\me\\AppData\\Local\\Programs\\Python\\site-packages\\m.onnx', env)).toBe(true)
    expect(shouldExcludeDuplicateFile('C:\\Users\\me\\AppData\\Local\\Comms\\UnistoreDB\\USSres.jrs', env)).toBe(true)
  })

  it('普通缓存/媒体重复项仍参与比较', () => {
    expect(shouldExcludeDuplicateFile('C:\\Users\\me\\AppData\\Local\\Steam\\htmlcache\\BrowserMetrics-spare.pma', env)).toBe(false)
    expect(shouldExcludeDuplicateFile('D:\\Downloads\\a.jpg', env)).toBe(false)
  })

  it('程序目录与大小写边界', () => {
    expect(shouldExcludeDuplicateFile('C:\\Program Files\\App\\setup.exe', env)).toBe(true)
    expect(shouldExcludeDuplicateFile('C:\\Program Files2\\x.bin', env)).toBe(false)
  })
})
