/**
 * Shell Link（.lnk）二进制解析器 —— 纯函数，不依赖 COM、不依赖第三方库。
 *
 * ## 为什么手工解析
 * 1. 判定「死链」必须在目标不存在时也能拿到目标路径；而 `IShellLink::GetPath`
 *    这类 COM 接口在目标缺失时恰恰最容易返回失败（或直接弹出租户级对话框），
 *    拿不到路径就没法告诉用户「它指向哪里没了」；
 * 2. Electorn / Node 进程里没有开箱可用的 ShellLink 绑定，引入 native 依赖会破坏
 *    「插件只依赖 shared + utils」的分层约定；
 * 3. 我们真正需要的字段只有三个块：Header、LinkTargetIDList、LinkInfo，
 *    其余块（StringData、ExtraData）与死链判定无关，直接跳过即可。
 *
 * ## 文件结构（MS-SHLLINK）
 * ```
 * 0x00  HeaderSize              uint32，必须为 0x4C（76 字节）
 * 0x04  LinkCLSID               16 字节，00021401-0000-0000-C000-000000000046
 * 0x14  LinkFlags               uint32 LE（含义见下）
 * 0x18  FileAttributes / 时间戳 / 文件大小 / 图标 / 显示方式等
 * 0x4C  LinkTargetIDList        （可选，HasLinkTargetIdList 时存在）
 *       结构为 uint16 长度 + IDList 内容，长度只统计 IDList 内容本身（不含这 2 字节长度字段）
 * ...   LinkInfo                （可选，HasLinkInfo 时存在）
 * ...   StringData / ExtraData  （本解析器不读取）
 * ```
 *
 * ## LinkFlags 每一位的含义（只列前 8 位，本解析器只关心 bit0 / bit1 / bit2）
 * - bit0 HasLinkTargetIdList：目标以「Shell 项目 ID 列表」形式保存。它描述的是
 *   Shell 命名空间里的对象（此电脑、回收站、控制面板、库……），**不是文件系统路径**，
 *   因此无法用 fs 判断存在性，也不能当成死链；
 * - bit1 HasLinkInfo：存在 LinkInfo 结构，本地/网络目标的真实路径存放在这里，
 *   这是本解析器取路径的主来源；
 * - bit2 HasName：存在 NAME_STRING（显示名，通常是目标文件名），仅用于界面展示；
 * - bit3 HasRelativePath：存在 RELATIVE_PATH（相对于 .lnk 所在目录的路径）；
 * - bit4 HasWorkingDir：存在 WORKING_DIR（启动时的工作目录）；
 * - bit5 HasArguments：存在 COMMAND_LINE_ARGUMENTS（启动参数）；
 * - bit6 HasIconLocation：存在 ICON_LOCATION（自定义图标路径）；
 * - bit7 IsUnicode：以上 StringData 使用 UTF-16LE 编码（置 0 时为 ANSI 代码页）。
 *
 * ## 为什么 `shell` / `url` 必须跳过（而不是判成死链）
 * - `shell`：目标是 Shell 命名空间项（此电脑、回收站、某个 UWP 应用入口），
 *   它「存不存在」由 Shell 解释，文件系统永远查不到；按查不到就删会误删系统入口；
 * - `url`：目标是网址（http/https/ftp/mailto），网络暂时不可达 != 快捷方式失效，
 *   离线误判会直接删掉用户的书签式快捷方式，代价远大于收益；
 * - `unknown`：结构损坏、被截断或使用了本解析器不认识的存储方式，无法确证目标，
 *   一律按「不判定」处理。
 *
 * 解析器对任何输入（空 Buffer、乱码、截断文件）都**不抛异常**，最差返回 `kind: 'unknown'`。
 */

/** 解析出的目标类型 */
export type LnkTargetKind = 'file' | 'url' | 'shell' | 'unknown'

/** 解析结果里对外暴露的关键 flag（其余 flag 的含义见文件头注释） */
export interface LnkFlagsInfo {
  /** bit0：目标以 Shell 项目 ID 列表存储（命名空间对象，无文件系统路径） */
  hasLinkTargetIdList: boolean
  /** bit1：存在 LinkInfo，路径从这里读 */
  hasLinkInfo: boolean
  /** bit2：存在 NAME_STRING（显示名） */
  hasName: boolean
}

/** 解析结果 */
export interface LnkParseResult {
  kind: LnkTargetKind
  /** 解析出的目标（`shell` / `unknown` 时缺省）；尚未展开环境变量 */
  target?: string
  flags: LnkFlagsInfo
}

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/** Header 固定长度：0x4C（76 字节） */
const HEADER_SIZE = 0x4c

/** Header 中 LinkFlags 的偏移 */
const LINK_FLAGS_OFFSET = 0x14

/** Shell Link 的 LinkCLSID：00021401-0000-0000-C000-000000000046（小端字节序） */
const LINK_CLSID = Buffer.from([
  0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46,
])

/* LinkFlags 各 bit 的掩码 */
/** bit0：HasLinkTargetIDList */
const FLAG_HAS_LINK_TARGET_ID_LIST = 1 << 0
/** bit1：HasLinkInfo */
const FLAG_HAS_LINK_INFO = 1 << 1
/** bit2：HasName */
const FLAG_HAS_NAME = 1 << 2
/** bit7：IsUnicode（StringData 使用 UTF-16LE；此处仅作文档说明，解析 LinkInfo 时以结构内部为准） */
const FLAG_IS_UNICODE = 1 << 7

/* LinkInfo 结构内部常量 */
/** LinkInfo 头部固定长度（无 Unicode 偏移时） */
const LINK_INFO_HEADER_SIZE_ANSI = 0x1c
/** LinkInfo 头部长度达到该值时，额外存在 Unicode 路径偏移字段 */
const LINK_INFO_HEADER_SIZE_UNICODE = 0x24
/** LinkInfo.flags bit0：VolumeIDAndLocalBasePath（本地目标，LocalBasePath 有效） */
const LINK_INFO_FLAG_LOCAL_BASE_PATH = 0x1
/** LinkInfo.flags bit1：CommonNetworkRelativeLinkAndPathSuffix（网络目标，路径在 CNRL 里） */
const LINK_INFO_FLAG_COMMON_NETWORK_PATH = 0x2

/** 常见 URL 协议前缀（大小写不敏感） */
const URL_PREFIXES = ['http://', 'https://', 'ftp://', 'mailto:']

/* ------------------------------------------------------------------ */
/* 底层读取（全部带越界保护）                                           */
/* ------------------------------------------------------------------ */

/** 读 uint32 LE；越界返回 undefined */
function readUInt32(buffer: Buffer, offset: number): number | undefined {
  if (offset < 0 || offset + 4 > buffer.length) return undefined
  return buffer.readUInt32LE(offset)
}

/** 读 uint16 LE；越界返回 undefined */
function readUInt16(buffer: Buffer, offset: number): number | undefined {
  if (offset < 0 || offset + 2 > buffer.length) return undefined
  return buffer.readUInt16LE(offset)
}

/**
 * 读以 `\0` 结尾的 UTF-16LE 字符串，最多读到 `end`（不含）。
 * 返回 undefined 表示区间非法；返回 '' 表示合法区间内是空串。
 */
function readUtf16z(buffer: Buffer, start: number, end: number): string | undefined {
  if (start < 0 || start + 1 >= end) return undefined
  let text = ''
  for (let cursor = start; cursor + 1 < end; cursor += 2) {
    const unit = buffer.readUInt16LE(cursor)
    if (unit === 0) break
    // 逐 UTF-16 码元拼接：代理对的两半会按原顺序追加，结果仍是合法字符串
    text += String.fromCharCode(unit)
  }
  return text
}

/**
 * 读以 `\0` 结尾的 ANSI（单字节）字符串。
 *
 * 返回值：
 * - `undefined`：区间非法，或字符串含非 ASCII 字节（当前代码页不可信）；
 * - 其它：纯 ASCII 文本（latin1 与 UTF-8 解码结果一致）。
 *
 * 之所以对非 ASCII 直接放弃：中文系统的 ANSI 路径多为 GBK 编码，Node 没有可靠的
 * 按代码页解码手段，按 UTF-8 解出来是乱码，会让「目标不存在」的判断出现假阳性。
 * 这类快捷方式按 unknown 跳过，宁可不报也不误删。
 */
function readAnsiZ(buffer: Buffer, start: number, end: number): string | undefined {
  if (start < 0 || start >= end) return undefined
  let cursor = start
  while (cursor < end && buffer[cursor] !== 0) cursor++
  const bytes = buffer.subarray(start, cursor)
  for (const byte of bytes) {
    if (byte > 0x7f) return undefined
  }
  return bytes.toString('latin1')
}

/* ------------------------------------------------------------------ */
/* LinkInfo                                                            */
/* ------------------------------------------------------------------ */

/** LinkInfo 中取到的路径片段 */
interface LinkInfoPaths {
  /** 本地基础路径（LocalBasePath）；网络目标时为空 */
  base: string
  /** 公共路径后缀（CommonPathSuffix），可能为空 */
  suffix: string
}

/**
 * 解析 LinkInfo 结构（位于 `offset`，长度为自身 size 字段）。
 *
 * 结构布局（相对 LinkInfo 起点）：
 * ```
 * 0x00 size                           结构总长度（含头部）
 * 0x04 headerSize                     头部长度，1.0 版本为 0x1C，含 Unicode 字段时为 0x24
 * 0x08 flags                          bit0 VolumeIDAndLocalBasePath / bit1 CommonNetworkRelativeLinkAndPathSuffix
 * 0x0C volumeIDOffset                 VolumeID 的偏移（本解析器不读）
 * 0x10 localBasePathOffset            ANSI 本地基础路径
 * 0x14 commonNetworkRelativeLinkOffset CNRL 的偏移（本解析器不读）
 * 0x18 commonPathSuffixOffset         ANSI 公共路径后缀
 * 0x1C localBasePathOffsetUnicode     （headerSize >= 0x24 时存在）UTF-16 本地基础路径
 * 0x20 commonPathSuffixOffsetUnicode  （headerSize >= 0x24 时存在）UTF-16 公共路径后缀
 * ```
 * 所有偏移都是相对 LinkInfo 起点、且都包含结尾 `\0` 的绝对位置。
 *
 * 返回 undefined 表示结构非法或路径编码不可信（调用方按 unknown 处理）。
 */
function parseLinkInfo(buffer: Buffer, offset: number): LinkInfoPaths | undefined {
  const size = readUInt32(buffer, offset)
  const headerSize = readUInt32(buffer, offset + 4)
  const flags = readUInt32(buffer, offset + 8)
  if (size === undefined || headerSize === undefined || flags === undefined) return undefined
  // size 必须能容纳头部；同时不能超出文件剩余长度
  if (headerSize < LINK_INFO_HEADER_SIZE_ANSI || size < headerSize) return undefined
  const end = offset + size
  if (end > buffer.length) return undefined

  // Unicode 偏移字段是否存在，由 headerSize 决定（老工具生成的 LinkInfo 只有 ANSI 版）
  const hasUnicodeOffsets = headerSize >= LINK_INFO_HEADER_SIZE_UNICODE
  const field = (fieldOffset: number): number => readUInt32(buffer, offset + fieldOffset) ?? 0
  const localBasePathOffset = field(0x10)
  const commonPathSuffixOffset = field(0x18)
  const localBasePathOffsetUnicode = hasUnicodeOffsets ? field(0x1c) : 0
  const commonPathSuffixOffsetUnicode = hasUnicodeOffsets ? field(0x20) : 0

  /**
   * 取一个字符串字段：优先 Unicode 版本，退回 ANSI 版本。
   * 返回 '' 表示该字段不存在（偏移为 0），undefined 表示编码不可信。
   */
  const pick = (unicodeOffset: number, ansiOffset: number): string | undefined => {
    if (unicodeOffset) {
      const text = readUtf16z(buffer, offset + unicodeOffset, end)
      if (text) return text
    }
    if (ansiOffset) return readAnsiZ(buffer, offset + ansiOffset, end)
    return ''
  }

  const base = pick(localBasePathOffsetUnicode, localBasePathOffset)
  const suffix = pick(commonPathSuffixOffsetUnicode, commonPathSuffixOffset)
  if (base === undefined || suffix === undefined) return undefined

  // bit0 未置位时 LocalBasePath 无效（目标可能是网络路径，路径在 CNRL 的 NetName 里；
  // 本解析器不读 CNRL，此时只保留后缀，交由调用方按「无法判定」跳过）
  const hasLocalBasePath = (flags & LINK_INFO_FLAG_LOCAL_BASE_PATH) !== 0
  // bit1（CommonNetworkRelativeLinkAndPathSuffix）同样会带 CommonPathSuffix，
  // 因此后缀在两种情形下都要拼接，不需要额外分支
  return { base: hasLocalBasePath ? base : '', suffix }
}

/** 把基础路径与公共后缀拼成一个目标路径 */
function joinTarget(base: string, suffix: string): string {
  if (!base) return suffix
  if (!suffix) return base
  const separator = base.endsWith('\\') || base.endsWith('/') ? '' : '\\'
  return base + separator + suffix
}

/* ------------------------------------------------------------------ */
/* 对外 API                                                            */
/* ------------------------------------------------------------------ */

/** 目标是否是一个网址（http/https/ftp/mailto） */
export function isUrlTarget(target: string): boolean {
  const lower = target.trim().toLowerCase()
  return URL_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

/**
 * 解析 .lnk 二进制内容。
 *
 * 返回 `kind: 'file'` 时 `target` 为尚未展开环境变量的目标路径；
 * 返回 `kind: 'url'` 时 `target` 为网址；`shell` / `unknown` 时没有可信目标。
 *
 * 该函数不访问文件系统、不抛异常，可以安全地用于任何用户提供的字节流。
 */
export function parseLnkTarget(buffer: Buffer): LnkParseResult {
  const flags: LnkFlagsInfo = { hasLinkTargetIdList: false, hasLinkInfo: false, hasName: false }
  try {
    // ① 校验 Header：长度至少 0x4C，HeaderSize == 0x4C，CLSID 匹配
    if (!Buffer.isBuffer(buffer) || buffer.length < HEADER_SIZE) return { kind: 'unknown', flags }
    if (readUInt32(buffer, 0) !== HEADER_SIZE) return { kind: 'unknown', flags }
    if (!buffer.subarray(4, 20).equals(LINK_CLSID)) return { kind: 'unknown', flags }

    // ② 读 LinkFlags
    const linkFlags = readUInt32(buffer, LINK_FLAGS_OFFSET)
    if (linkFlags === undefined) return { kind: 'unknown', flags }
    flags.hasLinkTargetIdList = (linkFlags & FLAG_HAS_LINK_TARGET_ID_LIST) !== 0
    flags.hasLinkInfo = (linkFlags & FLAG_HAS_LINK_INFO) !== 0
    flags.hasName = (linkFlags & FLAG_HAS_NAME) !== 0

    // ③ 跳过 LinkTargetIDList：uint16 长度（只统计 IDList 内容，不含长度字段自身）
    let cursor = HEADER_SIZE
    if (flags.hasLinkTargetIdList) {
      const idListSize = readUInt16(buffer, cursor)
      if (idListSize === undefined || idListSize < 2) return { kind: 'unknown', flags }
      cursor += 2 + idListSize
      if (cursor > buffer.length) return { kind: 'unknown', flags }
    }

    // ④ 解析 LinkInfo（本地/网络目标的路径来源）
    let target = ''
    if (flags.hasLinkInfo) {
      const paths = parseLinkInfo(buffer, cursor)
      if (!paths) return { kind: 'unknown', flags }
      target = joinTarget(paths.base, paths.suffix)
    }

    // ⑤ 分类
    if (target) {
      return { kind: isUrlTarget(target) ? 'url' : 'file', target, flags }
    }
    // 有 IDList 但没有 LinkInfo：目标是 Shell 命名空间对象（此电脑 / 回收站等），
    // 拿不到文件系统路径，只能标记为 shell，绝不参与死链判定
    if (flags.hasLinkTargetIdList && !flags.hasLinkInfo) return { kind: 'shell', flags }
    return { kind: 'unknown', flags }
  } catch {
    // 任何意外（畸形长度、索引越界）都退化为 unknown：解析器不允许把异常抛给扫描流程
    return { kind: 'unknown', flags }
  }
}
