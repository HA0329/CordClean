/**
 * 失效快捷方式插件 —— 误报回归测试（false positive）。
 *
 * 覆盖两类最容易误删的「不是死链的快捷方式」，以及新增的 .url 检测：
 * 1. MSI advertised（广告式）快捷方式：目标为空/指向安装器内部路径，但带
 *    HasDarwinID（bit11）或 DarwinDataBlock；文件系统查不到 != 失效，必须跳过；
 * 2. UWP/Store 快捷方式：目标是 `shell:AppsFolder\...`（或位于 WindowsApps），
 *    存在性由系统解释/受 ACL 保护，必须跳过；
 * 3. `.url`（Internet Shortcut）：只有 `URL=file:///...` 指向本地文件且目标确实
 *    不存在才上报；http/https、正常 file、UNC 一律不报。
 *
 * 判定层用注入的 exists 做纯函数测试；扫描层用临时目录验证上报项契约
 * （kind=file / risk=risky / defaultSelected=false，删除目标是快捷方式文件本身）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { CleanItemDraft } from '@cordclean/shared'
import {
  classifyInternetShortcut,
  classifyShortcut,
  scanShortcutDirs,
} from '../packages/plugins/shortcuts/src/index.ts'
import type { ShortcutScanSink } from '../packages/plugins/shortcuts/src/index.ts'
import { parseLnkTarget } from '../packages/plugins/shortcuts/src/lnk.ts'
import { parseInternetShortcut } from '../packages/plugins/shortcuts/src/url.ts'

/* ------------------------------------------------------------------ */
/* 构造 .lnk 字节流的最小工厂（与 tests/shortcuts.test.ts 同构）         */
/* ------------------------------------------------------------------ */

/** LinkFlags：HasLinkTargetIDList */
const FLAG_ID_LIST = 0x1
/** LinkFlags：HasLinkInfo */
const FLAG_LINK_INFO = 0x2
/** LinkFlags：HasName */
const FLAG_NAME = 0x4
/** LinkFlags：HasDarwinID（MSI 广告式快捷方式） */
const FLAG_DARWIN_ID = 1 << 11

/** Shell Link 的 LinkCLSID（小端字节序） */
const LINK_CLSID_BYTES = [
  0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46,
]

function header(flags: number): Buffer {
  const buffer = Buffer.alloc(0x4c)
  buffer.writeUInt32LE(0x4c, 0)
  Buffer.from(LINK_CLSID_BYTES).copy(buffer, 4)
  buffer.writeUInt32LE(flags, 0x14)
  return buffer
}

function utf16z(text: string): Buffer {
  return Buffer.concat([Buffer.from(text, 'utf16le'), Buffer.alloc(2)])
}

function ansiZ(text: string): Buffer {
  return Buffer.concat([Buffer.from(text, 'latin1'), Buffer.alloc(1)])
}

function idListOf(payloadSize: number): Buffer {
  const buffer = Buffer.alloc(2 + payloadSize)
  buffer.writeUInt16LE(payloadSize, 0)
  return buffer
}

/** DarwinDataBlock：Size=0x314，Signature=0xA0000006（MSI 广告式快捷方式标志） */
function darwinDataBlock(): Buffer {
  const block = Buffer.alloc(0x314)
  block.writeUInt32LE(0x314, 0)
  block.writeUInt32LE(0xa0000006, 4)
  return block
}

interface LnkSpec {
  flags: number
  idList?: Buffer
  base?: string
  suffix?: string
  /** 路径使用 UTF-16LE（可含中文） */
  unicode?: boolean
  /** 是否在文件尾部附加 DarwinDataBlock */
  darwinBlock?: boolean
}

/** 构造最小 .lnk：Header [+ IDList] [+ LinkInfo] [+ DarwinDataBlock] */
function buildLnk(spec: LnkSpec): Buffer {
  const chunks: Buffer[] = [header(spec.flags)]
  if (spec.idList) chunks.push(spec.idList)
  if (spec.base || spec.suffix) {
    const encode = spec.unicode ? utf16z : ansiZ
    const headerSize = spec.unicode ? 0x24 : 0x1c
    const baseBytes = spec.base ? encode(spec.base) : Buffer.alloc(0)
    const suffixBytes = spec.suffix ? encode(spec.suffix) : Buffer.alloc(0)
    const baseOffset = baseBytes.length ? headerSize : 0
    const suffixOffset = suffixBytes.length ? headerSize + baseBytes.length : 0

    const info = Buffer.alloc(headerSize)
    info.writeUInt32LE(headerSize + baseBytes.length + suffixBytes.length, 0)
    info.writeUInt32LE(headerSize, 4)
    info.writeUInt32LE(0x1, 8) // VolumeIDAndLocalBasePath
    info.writeUInt32LE(0, 0x0c)
    info.writeUInt32LE(baseOffset, 0x10)
    info.writeUInt32LE(0, 0x14)
    info.writeUInt32LE(suffixOffset, 0x18)
    if (spec.unicode) {
      info.writeUInt32LE(baseOffset, 0x1c)
      info.writeUInt32LE(suffixOffset, 0x20)
    }
    chunks.push(info)
    if (baseBytes.length) chunks.push(baseBytes)
    if (suffixBytes.length) chunks.push(suffixBytes)
  }
  if (spec.darwinBlock) chunks.push(darwinDataBlock())
  return Buffer.concat(chunks)
}

/* ------------------------------------------------------------------ */
/* 测试注入：环境变量 / 存在性                                          */
/* ------------------------------------------------------------------ */

function envOf(map: Record<string, string> = {}) {
  return {
    get(name: string): string | undefined {
      return map[name] ?? map[name.toUpperCase()]
    },
  }
}

/** 只对列出的路径返回 true，并记录探测顺序 */
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

const LNK_PATH = 'C:\\Users\\tester\\Desktop\\demo.lnk'

/* ------------------------------------------------------------------ */
/* 1. MSI advertised：不得判成死链                                       */
/* ------------------------------------------------------------------ */

describe('MSI advertised（广告式）快捷方式：跳过，不探测文件系统', () => {
  it('HasDarwinID + 空目标：解析为 advertised，判定 skip/advertised', async () => {
    const buffer = buildLnk({ flags: FLAG_DARWIN_ID })
    const parsed = parseLnkTarget(buffer)
    expect(parsed.advertised).toBe(true)
    expect(parsed.target).toBeUndefined()

    const probe = existsOf([])
    const result = await classifyShortcut({ buffer, lnkPath: LNK_PATH, env: envOf(), exists: probe.fn })
    expect(result).toMatchObject({ verdict: 'skip', reason: 'advertised' })
    expect(probe.calls).toEqual([])
  })

  it('广告式快捷方式即使带「看起来像文件路径」的目标也不上报（回归）', async () => {
    // 没有 advertised 判定时，这条会被当成悬空 .lnk 上报为 broken/missing-target
    const buffer = buildLnk({
      flags: FLAG_LINK_INFO | FLAG_DARWIN_ID,
      base: 'C:\\Gone\\msi-advertised.exe',
      darwinBlock: true,
    })
    expect(parseLnkTarget(buffer)).toMatchObject({ kind: 'file', advertised: true })

    const probe = existsOf([])
    const result = await classifyShortcut({ buffer, lnkPath: LNK_PATH, env: envOf(), exists: probe.fn })
    expect(result).toMatchObject({ verdict: 'skip', reason: 'advertised' })
    expect(probe.calls).toEqual([])
  })

  it('LinkFlags 未置位但文件里确有 DarwinDataBlock：兜底识别为 advertised', async () => {
    const buffer = buildLnk({ flags: 0, darwinBlock: true })
    expect(parseLnkTarget(buffer).advertised).toBe(true)

    const probe = existsOf([])
    const result = await classifyShortcut({ buffer, lnkPath: LNK_PATH, env: envOf(), exists: probe.fn })
    expect(result).toMatchObject({ verdict: 'skip', reason: 'advertised' })
    expect(probe.calls).toEqual([])
  })
})

/* ------------------------------------------------------------------ */
/* 2. UWP / Store：不得判成死链                                         */
/* ------------------------------------------------------------------ */

describe('UWP/Store 快捷方式：跳过，不探测文件系统', () => {
  it('shell:AppsFolder 目标：解析为 shell，判定 skip/uwp', async () => {
    const target = 'shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App'
    const buffer = buildLnk({ flags: FLAG_LINK_INFO, base: target })
    const parsed = parseLnkTarget(buffer)
    expect(parsed.kind).toBe('shell')
    expect(parsed.target).toBe(target)

    const probe = existsOf([])
    const result = await classifyShortcut({ buffer, lnkPath: LNK_PATH, env: envOf(), exists: probe.fn })
    expect(result).toMatchObject({ verdict: 'skip', reason: 'uwp', kind: 'shell', target })
    expect(probe.calls).toEqual([])
  })

  it('WindowsApps 目录下的目标：ACL 不可靠，判定 skip/uwp', async () => {
    const target = 'C:\\Program Files\\WindowsApps\\Microsoft.Demo_1.0.0.0_x64__8wekyb3d8bbwe\\demo.exe'
    const buffer = buildLnk({ flags: FLAG_LINK_INFO, base: target })

    const probe = existsOf([])
    const result = await classifyShortcut({ buffer, lnkPath: LNK_PATH, env: envOf(), exists: probe.fn })
    expect(result).toMatchObject({ verdict: 'skip', reason: 'uwp', target })
    expect(probe.calls).toEqual([])
  })

  it('只有 IDList、没有 LinkInfo 的 Shell 入口：跳过（reason=shell）', async () => {
    const buffer = buildLnk({ flags: FLAG_ID_LIST | FLAG_NAME, idList: idListOf(6) })
    const probe = existsOf([])
    const result = await classifyShortcut({ buffer, lnkPath: LNK_PATH, env: envOf(), exists: probe.fn })
    expect(result).toMatchObject({ verdict: 'skip', reason: 'shell', kind: 'shell' })
    expect(probe.calls).toEqual([])
  })
})

/* ------------------------------------------------------------------ */
/* 3. 基线：正常 .lnk / 悬空 .lnk / UNC / 离线盘                        */
/* ------------------------------------------------------------------ */

describe('普通 .lnk 判定（注入 exists）', () => {
  it('正常 lnk：目标存在 → 不报', async () => {
    const target = 'C:\\Tools\\demo.exe'
    const buffer = buildLnk({ flags: FLAG_LINK_INFO, base: target })
    const probe = existsOf(['C:\\', target])
    const result = await classifyShortcut({ buffer, lnkPath: LNK_PATH, env: envOf(), exists: probe.fn })
    expect(result).toMatchObject({ verdict: 'skip', reason: 'target-exists', target })
    expect(probe.calls).toEqual(['C:\\', target])
  })

  it('悬空 lnk：盘符在线 + 目标不存在 → broken/missing-target', async () => {
    const target = 'C:\\Gone\\demo.exe'
    const buffer = buildLnk({ flags: FLAG_LINK_INFO, base: target })
    const probe = existsOf(['C:\\'])
    const result = await classifyShortcut({ buffer, lnkPath: LNK_PATH, env: envOf(), exists: probe.fn })
    expect(result).toMatchObject({ verdict: 'broken', reason: 'missing-target', kind: 'file', target })
    expect(probe.calls).toEqual(['C:\\', target])
  })

  it('UNC 网络路径 → skip/network，不探测网络位置', async () => {
    const target = '\\\\fileserver\\share\\demo.exe'
    const buffer = buildLnk({ flags: FLAG_LINK_INFO, base: target })
    const probe = existsOf([])
    const result = await classifyShortcut({ buffer, lnkPath: LNK_PATH, env: envOf(), exists: probe.fn })
    expect(result).toMatchObject({ verdict: 'skip', reason: 'network', target })
    expect(probe.calls).toEqual([])
  })

  it('可移动盘离线（盘符根不存在）→ skip/offline-drive，不判死链', async () => {
    const target = 'Z:\\Backup\\demo.exe'
    const buffer = buildLnk({ flags: FLAG_LINK_INFO, base: target })
    const probe = existsOf([])
    const result = await classifyShortcut({ buffer, lnkPath: LNK_PATH, env: envOf(), exists: probe.fn })
    expect(result).toMatchObject({ verdict: 'skip', reason: 'offline-drive', target })
    expect(probe.calls).toEqual(['Z:\\'])
  })
})

/* ------------------------------------------------------------------ */
/* 4. .url（Internet Shortcut）                                        */
/* ------------------------------------------------------------------ */

const URL_PATH = 'C:\\Users\\tester\\Desktop\\demo.url'

describe('.url 解析', () => {
  it('识别 URL= 行并解码 file:/// 的百分号编码', () => {
    const parsed = parseInternetShortcut(
      Buffer.from('[InternetShortcut]\r\nURL=file:///C:/Gone/%E6%8A%A5%E5%91%8A.txt\r\nIconIndex=0\r\n', 'utf8'),
    )
    expect(parsed).toEqual({ kind: 'file', target: 'C:\\Gone\\报告.txt' })
  })

  it('http/https 识别为网络目标；file://server 解析为 UNC', () => {
    expect(parseInternetShortcut('[InternetShortcut]\nURL=https://example.com/x')).toMatchObject({
      kind: 'url',
      target: 'https://example.com/x',
    })
    expect(parseInternetShortcut('[InternetShortcut]\nURL=file://fileserver/share/x.txt')).toMatchObject({
      kind: 'file',
      target: '\\\\fileserver\\share\\x.txt',
    })
  })

  it('没有 URL 行 / 非法百分号转义 → unknown', () => {
    expect(parseInternetShortcut('[InternetShortcut]\nIconIndex=0')).toMatchObject({ kind: 'unknown' })
    expect(parseInternetShortcut('[InternetShortcut]\nURL=file:///C:/bad%ZZ/x')).toMatchObject({
      kind: 'unknown',
    })
  })
})

describe('.url 判定（注入 exists）', () => {
  it('悬空 file:// .url：目标不存在 → broken/missing-target', async () => {
    const content = '[InternetShortcut]\r\nURL=file:///C:/Gone/report.txt\r\n'
    const probe = existsOf(['C:\\'])
    const result = await classifyInternetShortcut({ content, urlPath: URL_PATH, env: envOf(), exists: probe.fn })
    expect(result).toMatchObject({
      verdict: 'broken',
      reason: 'missing-target',
      kind: 'file',
      target: 'C:\\Gone\\report.txt',
    })
    expect(probe.calls).toEqual(['C:\\', 'C:\\Gone\\report.txt'])
  })

  it('正常 http/https .url → skip/url，不探测文件系统', async () => {
    for (const url of ['https://example.com/a', 'http://example.com/b']) {
      const probe = existsOf([])
      const content = `[InternetShortcut]\r\nURL=${url}\r\n`
      const result = await classifyInternetShortcut({ content, urlPath: URL_PATH, env: envOf(), exists: probe.fn })
      expect(result).toMatchObject({ verdict: 'skip', reason: 'url', kind: 'url', target: url })
      expect(probe.calls).toEqual([])
    }
  })

  it('正常 file:// .url（目标存在）→ 不报', async () => {
    const probe = existsOf(['C:\\', 'C:\\Tools\\report.txt'])
    const content = '[InternetShortcut]\r\nURL=file:///C:/Tools/report.txt\r\n'
    const result = await classifyInternetShortcut({ content, urlPath: URL_PATH, env: envOf(), exists: probe.fn })
    expect(result).toMatchObject({ verdict: 'skip', reason: 'target-exists', kind: 'file', target: 'C:\\Tools\\report.txt' })
  })

  it('UNC / 相对路径 .url → 跳过且不探测', async () => {
    const unc = existsOf([])
    const uncResult = await classifyInternetShortcut({
      content: '[InternetShortcut]\nURL=file://fileserver/share/x.txt',
      urlPath: URL_PATH,
      env: envOf(),
      exists: unc.fn,
    })
    expect(uncResult).toMatchObject({ verdict: 'skip', reason: 'network' })
    expect(unc.calls).toEqual([])

    const relative = existsOf([])
    const relativeResult = await classifyInternetShortcut({
      content: '[InternetShortcut]\nURL=file:relative/doc.txt',
      urlPath: URL_PATH,
      env: envOf(),
      exists: relative.fn,
    })
    expect(relativeResult).toMatchObject({ verdict: 'skip', reason: 'relative-target' })
    expect(relative.calls).toEqual([])
  })
})

/* ------------------------------------------------------------------ */
/* 5. 扫描上报契约：真实临时目录 + 假 sink                               */
/* ------------------------------------------------------------------ */

interface FakeSink {
  sink: ShortcutScanSink
  drafts: CleanItemDraft[]
  errors: Array<{ path: string; message: string }>
}

function fakeSink(): FakeSink {
  const drafts: CleanItemDraft[] = []
  const errors: Array<{ path: string; message: string }> = []
  const sink: ShortcutScanSink = {
    emit(draft) {
      drafts.push(draft)
    },
    addError(error) {
      errors.push({ path: error.path, message: error.message })
    },
    throwIfAborted() {},
  }
  return { sink, drafts, errors }
}

describe('扫描上报契约：.lnk 与 .url 失效项字段一致', () => {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'cc-shortcuts-fp-'))
  const drive = (process.env.SystemDrive || 'C:').replace(/\\$/, '')
  const missingLnkTarget = `${drive}\\CordClean-missing-shortcut\\demo.exe`
  const missingUrlTarget = `${drive}\\CordClean-missing-url\\报告.txt`
  const presentFile = path.join(sandbox, 'present.txt')

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  it('只上报失效项；kind=file、risk=risky、defaultSelected=false、删除目标是快捷方式文件本身', async () => {
    writeFileSync(presentFile, 'present')

    // 1) 悬空 .lnk（Unicode LinkInfo，允许沙箱路径含非 ASCII）
    writeFileSync(
      path.join(sandbox, 'dangling.lnk'),
      buildLnk({ flags: FLAG_LINK_INFO, unicode: true, base: missingLnkTarget }),
    )
    // 2) 正常 .lnk（指向真实存在的文件）
    writeFileSync(
      path.join(sandbox, 'present.lnk'),
      buildLnk({ flags: FLAG_LINK_INFO, unicode: true, base: presentFile }),
    )
    // 3) 悬空 .url（file:/// 指向不存在的本地文件，含中文百分号编码）
    const encodedMissing = encodeURI(missingUrlTarget.replace(/\\/g, '/'))
    writeFileSync(
      path.join(sandbox, 'dangling.url'),
      `[InternetShortcut]\r\nURL=file:///${encodedMissing}\r\nIconIndex=0\r\n`,
    )
    // 4) 正常 http .url（不报）
    writeFileSync(path.join(sandbox, 'website.url'), '[InternetShortcut]\r\nURL=https://example.com/x\r\n')
    // 5) 正常 file .url（目标存在，不报）
    const encodedPresent = encodeURI(presentFile.replace(/\\/g, '/'))
    writeFileSync(path.join(sandbox, 'present.url'), `[InternetShortcut]\r\nURL=file:///${encodedPresent}\r\n`)

    const { sink, drafts, errors } = fakeSink()
    const stats = await scanShortcutDirs(sink, {
      dirs: [sandbox],
      includeStartup: false,
      env: envOf(),
    })

    expect(errors).toEqual([])
    expect(stats.broken).toBe(2)
    expect(stats.skipped.url).toBe(1)
    expect(stats.skipped['target-exists']).toBe(2)
    expect(drafts).toHaveLength(2)

    const bySuffix = new Map(drafts.map((draft) => [path.extname(draft.path).toLowerCase(), draft]))
    const lnkDraft = bySuffix.get('.lnk')!
    const urlDraft = bySuffix.get('.url')!
    expect(lnkDraft).toMatchObject({
      path: path.join(sandbox, 'dangling.lnk'),
      kind: 'file',
      risk: 'risky',
      defaultSelected: false,
      meta: { target: missingLnkTarget, action: 'delete' },
    })
    expect(urlDraft).toMatchObject({
      path: path.join(sandbox, 'dangling.url'),
      kind: 'file',
      risk: 'risky',
      defaultSelected: false,
      meta: { target: missingUrlTarget, action: 'delete' },
    })
    expect(lnkDraft.note).toContain(missingLnkTarget)
    expect(urlDraft.note).toContain(missingUrlTarget)
    // 删除目标必须是快捷方式文件本身，绝不是解析出来的目标路径
    expect(lnkDraft.path.toLowerCase()).toMatch(/\.lnk$/)
    expect(urlDraft.path.toLowerCase()).toMatch(/\.url$/)
    expect(drafts.some((draft) => /website\.url$/i.test(draft.path))).toBe(false)
    expect(drafts.some((draft) => /present\.(lnk|url)$/i.test(draft.path))).toBe(false)
  })
})
