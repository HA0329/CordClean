/**
 * 失效快捷方式插件（`packages/plugins/shortcuts`）测试。
 *
 * 说明：内核的 `TaskEnv` 由 createApp 探测真实环境生成、不可覆盖，因此无法把
 * 「用户桌面」指向测试沙箱，真实目录扫描不做集成测试。相应地：
 * 1. 用自造的 .lnk 字节流测试 `parseLnkTarget`（file / url / shell / 畸形输入）；
 * 2. 用注入的 `env` / `exists` 测试 `classifyShortcut` 的四档判定；
 * 3. 用 createApp + manifestOf 验证插件能被装载并注册任务（不触发 scan，
 *    避免触碰真实用户目录）。
 */
import { rmSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp, type App } from '@cordclean/core'
import shortcutsPlugin, { classifyShortcut } from '../packages/plugins/shortcuts/src/index.ts'
import { parseLnkTarget } from '../packages/plugins/shortcuts/src/lnk.ts'
import { createSandbox, manifestOf } from './helpers.ts'

/* ------------------------------------------------------------------ */
/* 构造 .lnk 字节流的最小工厂                                           */
/* ------------------------------------------------------------------ */

/** LinkFlags：HasLinkTargetIDList */
const FLAG_ID_LIST = 0x1
/** LinkFlags：HasLinkInfo */
const FLAG_LINK_INFO = 0x2
/** LinkFlags：HasName */
const FLAG_NAME = 0x4

/** Shell Link 的 LinkCLSID（小端字节序） */
const LINK_CLSID_BYTES = [
  0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46,
]

/** 构造 76 字节 Header（HeaderSize + CLSID + LinkFlags） */
function header(flags: number): Buffer {
  const buffer = Buffer.alloc(0x4c)
  buffer.writeUInt32LE(0x4c, 0)
  Buffer.from(LINK_CLSID_BYTES).copy(buffer, 4)
  buffer.writeUInt32LE(flags, 0x14)
  return buffer
}

/** UTF-16LE 字符串 + \0 结尾 */
function utf16z(text: string): Buffer {
  return Buffer.concat([Buffer.from(text, 'utf16le'), Buffer.alloc(2)])
}

/** ASCII 字符串 + \0 结尾 */
function ansiZ(text: string): Buffer {
  return Buffer.concat([Buffer.from(text, 'latin1'), Buffer.alloc(1)])
}

/** 构造一个 IDList（2 字节长度字段 + 内容，长度只统计内容本身，不含长度字段） */
function idListOf(payloadSize: number): Buffer {
  const buffer = Buffer.alloc(2 + payloadSize)
  buffer.writeUInt16LE(payloadSize, 0)
  return buffer
}

interface LnkSpec {
  /** Header 的 LinkFlags */
  flags: number
  /** LinkTargetIDList（完整字节，含 2 字节长度字段） */
  idList?: Buffer
  /** LinkInfo 的本地基础路径 */
  base?: string
  /** LinkInfo 的公共路径后缀 */
  suffix?: string
  /** 路径使用 UTF-16LE（此时 base/suffix 都按 Unicode 字段写入） */
  unicode?: boolean
}

/**
 * 构造一个最小 .lnk：Header [+ IDList] [+ LinkInfo]。
 * 这是「刚好够解析器工作」的合成文件，不是 100% 符合 MS-SHLLINK 的完整样本
 * （VolumeID 结构省略，Unicode 字段只在需要时写入）。
 */
function buildLnk(spec: LnkSpec): Buffer {
  const chunks: Buffer[] = [header(spec.flags)]
  if (spec.idList) chunks.push(spec.idList)
  if (!spec.base && !spec.suffix) return Buffer.concat(chunks)

  const encode = spec.unicode ? utf16z : ansiZ
  const headerSize = spec.unicode ? 0x24 : 0x1c
  const baseBytes = spec.base ? encode(spec.base) : Buffer.alloc(0)
  const suffixBytes = spec.suffix ? encode(spec.suffix) : Buffer.alloc(0)
  const baseOffset = baseBytes.length ? headerSize : 0
  const suffixOffset = suffixBytes.length ? headerSize + baseBytes.length : 0

  const info = Buffer.alloc(headerSize)
  info.writeUInt32LE(headerSize + baseBytes.length + suffixBytes.length, 0) // size
  info.writeUInt32LE(headerSize, 4) // headerSize
  info.writeUInt32LE(0x1, 8) // flags: VolumeIDAndLocalBasePath
  info.writeUInt32LE(0, 0x0c) // volumeIDOffset
  info.writeUInt32LE(baseOffset, 0x10) // localBasePathOffset
  info.writeUInt32LE(0, 0x14) // commonNetworkRelativeLinkOffset
  info.writeUInt32LE(suffixOffset, 0x18) // commonPathSuffixOffset
  if (spec.unicode) {
    info.writeUInt32LE(baseOffset, 0x1c) // localBasePathOffsetUnicode
    info.writeUInt32LE(suffixOffset, 0x20) // commonPathSuffixOffsetUnicode
  }
  chunks.push(info)
  if (baseBytes.length) chunks.push(baseBytes)
  if (suffixBytes.length) chunks.push(suffixBytes)
  return Buffer.concat(chunks)
}

/* ------------------------------------------------------------------ */
/* 测试用的环境变量 / 存在性注入                                        */
/* ------------------------------------------------------------------ */

/** 固定映射的环境变量访问器（模拟 TaskEnv.get 的大小写不敏感） */
function envOf(map: Record<string, string> = {}) {
  return {
    get(name: string): string | undefined {
      return map[name] ?? map[name.toUpperCase()]
    },
  }
}

/** 记录探测顺序的存在性检查：只有列出的路径返回 true */
function existsOf(known: string[]) {
  const calls: string[] = []
  return {
    calls,
    fn: async (target: string): Promise<boolean> => {
      calls.push(target)
      return known.includes(target)
    },
  }
}

/* ------------------------------------------------------------------ */
/* 1. 解析器                                                           */
/* ------------------------------------------------------------------ */

describe('parseLnkTarget：三种目标形态', () => {
  it('file：从 ANSI LocalBasePath 读出本地路径', () => {
    const buffer = buildLnk({ flags: FLAG_LINK_INFO, base: 'C:\\Program Files\\Demo\\demo.exe' })
    const parsed = parseLnkTarget(buffer)
    expect(parsed.kind).toBe('file')
    expect(parsed.target).toBe('C:\\Program Files\\Demo\\demo.exe')
    expect(parsed.flags).toEqual({ hasLinkTargetIdList: false, hasLinkInfo: true, hasName: false })
  })

  it('file：优先使用 Unicode LocalBasePath（中文路径）', () => {
    const buffer = buildLnk({ flags: FLAG_LINK_INFO, base: 'C:\\工具\\演示程序.exe', unicode: true })
    expect(parseLnkTarget(buffer)).toMatchObject({ kind: 'file', target: 'C:\\工具\\演示程序.exe' })
  })

  it('file：拼接 CommonPathSuffix 得到完整目标', () => {
    const buffer = buildLnk({ flags: FLAG_LINK_INFO, base: 'C:\\Tools', suffix: 'bin\\demo.exe' })
    expect(parseLnkTarget(buffer)).toMatchObject({ kind: 'file', target: 'C:\\Tools\\bin\\demo.exe' })
  })

  it('url：http/https/ftp/mailto 目标识别为网址', () => {
    const urls = ['https://example.com/setup', 'http://example.com/a', 'ftp://files.example.com/x', 'mailto:a@b.c']
    for (const url of urls) {
      const parsed = parseLnkTarget(buildLnk({ flags: FLAG_LINK_INFO, base: url }))
      expect(parsed.kind).toBe('url')
      expect(parsed.target).toBe(url)
    }
  })

  it('shell：只有 IDList、没有 LinkInfo 时识别为 Shell 命名空间项', () => {
    const buffer = buildLnk({ flags: FLAG_ID_LIST, idList: idListOf(6) })
    const parsed = parseLnkTarget(buffer)
    expect(parsed.kind).toBe('shell')
    expect(parsed.target).toBeUndefined()
    expect(parsed.flags).toEqual({ hasLinkTargetIdList: true, hasLinkInfo: false, hasName: false })
  })

  it('HasName 等其余 flag 只做记录，不影响目标解析', () => {
    const buffer = buildLnk({ flags: FLAG_LINK_INFO | FLAG_NAME, base: 'C:\\Tools\\demo.exe' })
    const parsed = parseLnkTarget(buffer)
    expect(parsed.kind).toBe('file')
    expect(parsed.flags.hasName).toBe(true)
  })
})

describe('parseLnkTarget：畸形输入不抛异常', () => {
  const fileLnk = buildLnk({ flags: FLAG_LINK_INFO, base: 'C:\\Tools\\demo.exe' })
  const brokenIdList = buildLnk({ flags: FLAG_ID_LIST, idList: idListOf(6) })
  brokenIdList.writeUInt16LE(0xffff, 0x4c)
  const wrongClsid = buildLnk({ flags: FLAG_LINK_INFO, base: 'C:\\x.exe' })
  wrongClsid[4] = 0x00

  const cases: Array<[string, Buffer]> = [
    ['空 Buffer', Buffer.alloc(0)],
    ['只有 4 字节 HeaderSize', Buffer.from([0x4c, 0x00, 0x00, 0x00])],
    ['纯随机字节', Buffer.alloc(128, 0xab)],
    ['Header 被截断', fileLnk.subarray(0, 0x30)],
    ['LinkInfo 尾部被截断', fileLnk.subarray(0, fileLnk.length - 4)],
    ['IDList 长度越界', brokenIdList],
    ['CLSID 不匹配', wrongClsid],
  ]

  for (const [name, buffer] of cases) {
    it(name, () => {
      expect(() => parseLnkTarget(buffer)).not.toThrow()
      expect(parseLnkTarget(buffer).kind).toBe('unknown')
    })
  }
})

/* ------------------------------------------------------------------ */
/* 2. 四档判定                                                         */
/* ------------------------------------------------------------------ */

describe('classifyShortcut：死链 / 跳过判定', () => {
  const lnkPath = 'C:\\Users\\tester\\Desktop\\demo.lnk'

  it('url：跳过，且完全不去探测文件系统', async () => {
    const probe = existsOf([])
    const buffer = buildLnk({ flags: FLAG_LINK_INFO, base: 'https://example.com/download' })
    const result = await classifyShortcut({ buffer, lnkPath, env: envOf(), exists: probe.fn })
    expect(result).toMatchObject({ verdict: 'skip', reason: 'url', kind: 'url' })
    expect(probe.calls).toEqual([])
  })

  it('shell：跳过（此电脑 / 回收站等系统入口没有文件系统路径）', async () => {
    const probe = existsOf([])
    const buffer = buildLnk({ flags: FLAG_ID_LIST, idList: idListOf(6) })
    const result = await classifyShortcut({ buffer, lnkPath, env: envOf(), exists: probe.fn })
    expect(result).toMatchObject({ verdict: 'skip', reason: 'shell', kind: 'shell' })
    expect(probe.calls).toEqual([])
  })

  it('目标存在：跳过', async () => {
    const target = 'C:\\Tools\\demo.exe'
    const probe = existsOf(['C:\\', target])
    const buffer = buildLnk({ flags: FLAG_LINK_INFO, base: target })
    const result = await classifyShortcut({ buffer, lnkPath, env: envOf(), exists: probe.fn })
    expect(result).toMatchObject({ verdict: 'skip', reason: 'target-exists', target })
    expect(probe.calls).toEqual(['C:\\', target])
  })

  it('目标不存在：判定为死链', async () => {
    const target = 'C:\\Gone\\demo.exe'
    const probe = existsOf(['C:\\'])
    const buffer = buildLnk({ flags: FLAG_LINK_INFO, base: target })
    const result = await classifyShortcut({ buffer, lnkPath, env: envOf(), exists: probe.fn })
    expect(result).toMatchObject({ verdict: 'broken', reason: 'missing-target', target })
    // 只探测过盘符根与目标本身，说明判定逻辑没有额外副作用
    expect(probe.calls).toEqual(['C:\\', target])
  })

  it('离线盘（盘符根不存在）：跳过，绝不判定为死链', async () => {
    const target = 'Z:\\Gone\\demo.exe'
    const probe = existsOf([])
    const buffer = buildLnk({ flags: FLAG_LINK_INFO, base: target })
    const result = await classifyShortcut({ buffer, lnkPath, env: envOf(), exists: probe.fn })
    expect(result).toMatchObject({ verdict: 'skip', reason: 'offline-drive', target })
    expect(probe.calls).toEqual(['Z:\\'])
  })

  it.runIf(process.platform === 'win32')('默认存在性检查：在线盘符根不会被误判为离线盘（回归）', async () => {
    // 不注入 exists，走 defaultExists：盘符根必须用不带长路径前缀的方式探测，
    // 否则 `\\?\C:\` 会被 Windows 判为 EISDIR，导致所有在线磁盘都被当成离线盘。
    const drive = (process.env.SystemDrive || 'C:').toUpperCase()
    const target = `${drive}\\CordClean-missing-dir\\demo.exe`
    const buffer = buildLnk({ flags: FLAG_LINK_INFO, base: target })
    const result = await classifyShortcut({ buffer, lnkPath, env: envOf() })
    expect(result).toMatchObject({ verdict: 'broken', reason: 'missing-target', target })
  })

  it('UNC 网络路径：跳过，不探测网络位置', async () => {
    const target = '\\\\fileserver\\share\\demo.exe'
    const probe = existsOf([])
    const buffer = buildLnk({ flags: FLAG_LINK_INFO, base: target })
    const result = await classifyShortcut({ buffer, lnkPath, env: envOf(), exists: probe.fn })
    expect(result).toMatchObject({ verdict: 'skip', reason: 'network', target })
    expect(probe.calls).toEqual([])
  })

  it('展开 %VAR% 后再判定目标是否存在', async () => {
    const target = 'C:\\Program Files\\Demo\\demo.exe'
    const probe = existsOf(['C:\\'])
    const buffer = buildLnk({ flags: FLAG_LINK_INFO, base: '%ProgramFiles%\\Demo\\demo.exe' })
    const result = await classifyShortcut({
      buffer,
      lnkPath,
      env: envOf({ ProgramFiles: 'C:\\Program Files' }),
      exists: probe.fn,
    })
    expect(result).toMatchObject({ verdict: 'broken', reason: 'missing-target', target })
  })

  it('含未知环境变量：跳过（路径不可信，避免误判）', async () => {
    const probe = existsOf([])
    const buffer = buildLnk({ flags: FLAG_LINK_INFO, base: '%CORDCLEAN_UNKNOWN_VAR%\\demo.exe' })
    const result = await classifyShortcut({ buffer, lnkPath, env: envOf(), exists: probe.fn })
    expect(result).toMatchObject({ verdict: 'skip', reason: 'unresolved-env' })
    expect(probe.calls).toEqual([])
  })

  it('无法解析的内容：跳过', async () => {
    const probe = existsOf([])
    const result = await classifyShortcut({ buffer: Buffer.alloc(64, 0xab), lnkPath, env: envOf(), exists: probe.fn })
    expect(result).toMatchObject({ verdict: 'skip', reason: 'unknown', kind: 'unknown', target: '' })
    expect(probe.calls).toEqual([])
  })
})

/* ------------------------------------------------------------------ */
/* 3. 插件装载                                                         */
/* ------------------------------------------------------------------ */

describe('插件装载', () => {
  const sandbox = createSandbox()
  let app: App | undefined

  afterAll(async () => {
    if (app) await app.dispose()
    rmSync(sandbox.root, { recursive: true, force: true })
  })

  it('注册 broken-shortcuts 任务：高风险、默认不勾选、不需要管理员权限', async () => {
    app = await createApp({
      dataDir: path.join(sandbox.dataDir, 'shortcuts'),
      logger: false,
      manifest: manifestOf([{ id: 'shortcuts', plugin: shortcutsPlugin }]),
    })
    const plugin = app.ctx.plugins.list().find((item) => item.id === 'shortcuts')
    expect(plugin?.status).toBe('active')
    expect(plugin?.version).toBe('2.0.0')
    expect(plugin?.tasks.map((task) => task.id)).toEqual(['broken-shortcuts'])

    const task = app.ctx.cleaner.list().find((item) => item.id === 'broken-shortcuts')
    expect(task).toMatchObject({
      name: '失效快捷方式',
      category: 'apps',
      risk: 'risky',
      icon: '🔗',
      defaultSelected: false,
      requiresAdmin: false,
    })
  })
})
