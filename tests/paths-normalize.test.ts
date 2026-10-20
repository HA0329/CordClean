/**
 * Windows 路径规范化的单元测试（批次1-C）。
 *
 * 这些用例锁定长路径（`\\?\`）与 UNC 的新语义，防止再次出现
 * 「先折叠重复反斜杠、后判断前缀」导致 `\\?\C:\x` / `\\srv\sh` 全部失效的回归。
 *
 * 安全立场：设备/卷路径（`\\?\GLOBALROOT\...`、`\\.\C:`）必须 fail-closed，
 * 即 `isAbsolutePath() === false`，由路径策略统一拒绝，绝不放行。
 */
import { describe, expect, it } from 'vitest'
import {
  canonicalizePath,
  driveOf,
  isAbsolutePath,
  isSubPath,
  normalizePath,
  pathKey,
  toLongPath,
} from '@cordclean/utils'

describe('长路径前缀 \\\\?\\', () => {
  it('盘符长路径等价于普通盘符路径', () => {
    expect(normalizePath('\\\\?\\C:\\a')).toBe('C:\\a')
    expect(normalizePath('\\\\?\\C:\\a\\b')).toBe('C:\\a\\b')
    expect(isAbsolutePath('\\\\?\\C:\\a')).toBe(true)
    expect(pathKey('\\\\?\\C:\\a\\b')).toBe(pathKey('C:\\a\\b'))
    expect(pathKey('\\\\?\\C:\\A\\B')).toBe(pathKey('c:/a/b'))
  })

  it('长路径内部的 . 与 .. 段被正确解析', () => {
    expect(normalizePath('\\\\?\\C:\\a\\.\\b')).toBe('C:\\a\\b')
    expect(normalizePath('\\\\?\\C:\\a\\..\\b')).toBe('C:\\b')
    expect(canonicalizePath('\\\\?\\C:\\a\\.\\b')).toBe('C:\\a\\b')
    expect(pathKey('\\\\?\\C:\\a\\.\\b')).toBe(pathKey('C:\\a\\b'))
  })

  it('长路径的盘符根与结尾分隔符', () => {
    expect(normalizePath('\\\\?\\C:\\')).toBe('C:\\')
    expect(normalizePath('\\\\?\\C:\\a\\')).toBe('C:\\a')
    expect(isAbsolutePath('\\\\?\\C:\\')).toBe(true)
    // 长路径前缀不重复叠加
    expect(toLongPath('\\\\?\\C:\\a')).toBe('\\\\?\\C:\\a')
    expect(toLongPath('C:\\a')).toBe('\\\\?\\C:\\a')
    expect(toLongPath('C:\\')).toBe('\\\\?\\C:\\')
  })
})

describe('UNC 路径', () => {
  it('普通 UNC 保留双斜杠且判定为绝对路径', () => {
    expect(normalizePath('\\\\srv\\sh\\a')).toBe('\\\\srv\\sh\\a')
    expect(isAbsolutePath('\\\\srv\\sh\\a')).toBe(true)
    expect(isAbsolutePath('\\\\srv\\sh')).toBe(true)
    expect(pathKey('\\\\SRV\\SH\\A')).toBe('\\\\srv\\sh\\a')
    expect(driveOf('\\\\srv\\sh\\a')).toBe('')
    expect(isSubPath('\\\\srv\\sh', '\\\\srv\\sh\\a')).toBe(true)
    expect(isSubPath('\\\\srv\\share', '\\\\srv\\share2\\a')).toBe(false)
  })

  it('长路径 UNC 还原为普通 UNC，两者 pathKey 等价', () => {
    expect(normalizePath('\\\\?\\UNC\\srv\\sh\\a')).toBe('\\\\srv\\sh\\a')
    expect(normalizePath('\\\\?\\unc\\srv\\sh\\a')).toBe('\\\\srv\\sh\\a')
    expect(isAbsolutePath('\\\\?\\UNC\\srv\\sh\\a')).toBe(true)
    expect(pathKey('\\\\?\\UNC\\srv\\sh\\a')).toBe(pathKey('\\\\srv\\sh\\a'))
    expect(toLongPath('\\\\srv\\sh\\a')).toBe('\\\\?\\UNC\\srv\\sh\\a')
    expect(toLongPath('\\\\?\\UNC\\srv\\sh\\a')).toBe('\\\\?\\UNC\\srv\\sh\\a')
  })

  it('UNC 的重复分隔符被折叠，但仍保留开头的双斜杠', () => {
    expect(normalizePath('\\\\\\\\srv\\\\sh\\\\a')).toBe('\\\\srv\\sh\\a')
    expect(normalizePath('//srv/share/a')).toBe('\\\\srv\\share\\a')
    expect(isAbsolutePath('//srv/share/a')).toBe(true)
  })

  it('只有服务器名、没有共享名的畸形 UNC 判非绝对（fail-closed）', () => {
    expect(normalizePath('\\\\srv')).toBe('\\\\srv')
    expect(isAbsolutePath('\\\\srv')).toBe(false)
    // 不伪造 `\\?\UNC\srv` 这种缺共享名的长路径
    expect(toLongPath('\\\\srv')).toBe('\\\\srv')
  })
})

describe('盘符根与相对路径（保持原有语义）', () => {
  it('盘符根保留反斜杠', () => {
    expect(normalizePath('C:\\')).toBe('C:\\')
    expect(normalizePath('C:/')).toBe('C:\\')
    expect(isAbsolutePath('C:\\')).toBe(true)
    expect(driveOf('C:\\')).toBe('C:')
    expect(pathKey('C:\\')).toBe('c:\\')
  })

  it('普通相对路径不被当成绝对路径', () => {
    expect(normalizePath('a\\b')).toBe('a\\b')
    expect(normalizePath('.\\a')).toBe('a')
    expect(normalizePath('..\\a')).toBe('..\\a')
    expect(isAbsolutePath('a\\b')).toBe(false)
    expect(isAbsolutePath('.\\a')).toBe(false)
    expect(isAbsolutePath('..\\a')).toBe(false)
    expect(isAbsolutePath('C:')).toBe(false) // 盘符相对，非绝对
    expect(toLongPath('a\\b')).toBe('a\\b')
  })

  it('重复分隔符与混合斜杠被统一', () => {
    expect(normalizePath('C:\\\\a///b\\\\')).toBe('C:\\a\\b')
    expect(normalizePath(' C:\\a\\b ')).toBe('C:\\a\\b')
    // 段内空格是合法字符，只有段末空格（Windows 静默忽略）才由 canonicalize 去掉
    expect(normalizePath('C:\\a \\b')).toBe('C:\\a \\b')
    expect(canonicalizePath('C:\\a \\b')).toBe('C:\\a\\b')
  })

  it('空输入保持空串（由策略按「空路径」拒绝）', () => {
    expect(normalizePath('')).toBe('')
    expect(normalizePath('   ')).toBe('')
    expect(isAbsolutePath('')).toBe(false)
    expect(pathKey('')).toBe('')
    expect(toLongPath('')).toBe('')
  })
})

describe('设备/卷路径 fail-closed', () => {
  it('\\\\.\\ 设备路径不判为绝对路径', () => {
    expect(normalizePath('\\\\.\\C:')).toBe('\\\\.\\C:')
    expect(normalizePath('\\\\.\\C:\\a')).toBe('\\\\.\\C:\\a')
    expect(isAbsolutePath('\\\\.\\C:')).toBe(false)
    expect(isAbsolutePath('\\\\.\\C:\\Windows\\System32')).toBe(false)
    expect(toLongPath('\\\\.\\C:')).toBe('\\\\.\\C:')
  })

  it('\\\\.\\UNC\\ 设备重定向也不判为绝对路径', () => {
    expect(isAbsolutePath('\\\\.\\UNC\\srv\\sh')).toBe(false)
    expect(isAbsolutePath('\\\\.\\UNC\\srv\\sh\\a')).toBe(false)
  })

  it('\\?\GLOBALROOT 与 \\?\Volume 保持设备形态且不判为绝对路径', () => {
    const globalRoot = '\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1'
    expect(normalizePath(globalRoot)).toBe(globalRoot)
    expect(isAbsolutePath(globalRoot)).toBe(false)
    expect(isAbsolutePath('\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1\\a.txt')).toBe(false)

    const volume = '\\\\?\\Volume{b75e2c83-0000-0000-0000-602f00000000}\\a'
    expect(normalizePath(volume)).toBe(volume)
    expect(isAbsolutePath(volume)).toBe(false)
    expect(isAbsolutePath('\\\\?\\PIPE\\name')).toBe(false)
  })

  it('fail-closed 路径的 canonicalize 不会把它变成合法绝对路径', () => {
    const device = '\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1'
    expect(isAbsolutePath(canonicalizePath(device))).toBe(false)
    expect(isAbsolutePath(canonicalizePath('\\\\.\\C:\\a'))).toBe(false)
  })
})

describe('尾点 / 尾空格（Windows 静默忽略的写法）', () => {
  it('canonicalizePath 去掉每段末尾的 . 与空格', () => {
    expect(canonicalizePath('C:\\Windows\\System32. ')).toBe('C:\\Windows\\System32')
    expect(canonicalizePath('C:\\Windows\\System32 \\drivers\\etc\\hosts')).toBe(
      'C:\\Windows\\System32\\drivers\\etc\\hosts',
    )
    expect(canonicalizePath('C:\\a.\\b. .\\c')).toBe('C:\\a\\b\\c')
    expect(canonicalizePath('C:\\a\\.\\b')).toBe('C:\\a\\b')
  })

  it('长路径前缀同样不影响尾点清理', () => {
    expect(canonicalizePath('\\\\?\\C:\\Windows\\System32.')).toBe('C:\\Windows\\System32')
    expect(isAbsolutePath('\\\\?\\C:\\Windows\\System32.')).toBe(true)
  })
})

describe('超过 260 字符的长路径', () => {
  const deep = 'C:\\' + Array.from({ length: 20 }, (_, index) => `deep${index}`.padEnd(12, 'x')).join('\\')

  it('超长路径保持可规范化、可判定为绝对路径', () => {
    expect(deep.length).toBeGreaterThan(260)
    expect(normalizePath(deep)).toBe(deep)
    expect(isAbsolutePath(deep)).toBe(true)
    expect(pathKey(deep)).toBe(deep.toLowerCase())
  })

  it('超长路径的 toLongPath 正确加前缀且幂等', () => {
    const long = toLongPath(deep)
    expect(long).toBe('\\\\?\\' + deep)
    expect(long.length).toBeGreaterThan(260)
    expect(toLongPath(long)).toBe(long)
    expect(normalizePath(long)).toBe(deep)
    expect(pathKey(long)).toBe(pathKey(deep))
  })

  it('普通路径与长路径写法 pathKey 完全等价（去重/策略比较的基础）', () => {
    const a = 'C:\\Users\\someone\\AppData\\Local\\Temp\\file.tmp'
    expect(pathKey('\\\\?\\' + a)).toBe(pathKey(a))
    expect(pathKey('c:/Users/someone/AppData/Local/Temp/FILE.TMP')).toBe(pathKey(a))
    expect(canonicalizePath('\\\\?\\' + a)).toBe(a)
  })
})
