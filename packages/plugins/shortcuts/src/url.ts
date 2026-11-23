/**
 * Internet Shortcut（`.url`）解析器 —— 纯函数，不访问文件系统。
 *
 * ## 文件格式
 * `.url` 是 Windows 的「Internet 快捷方式」，本质是一段 INI 文本：
 * ```
 * [InternetShortcut]
 * URL=file:///C:/Users/me/Desktop/report.txt
 * IconIndex=0
 * ```
 * 与 `.lnk` 不同，它只有文本，不存在二进制解析风险；但**判定边界完全一致**：
 * 只有「URL 明确指向本地绝对文件路径 + 目标确实不存在」才可上报。
 *
 * ## 哪些不判定
 * - `http` / `https` / `ftp` / `mailto` 等任何网络协议：网络不可达 != 快捷方式失效；
 * - `file:` 里的 UNC 目标（`file://server/share/x`）：网络盘离线不可靠判定，
 *   解析成 UNC 路径后由上层按 network 跳过；
 * - 相对路径（`file:relative/x`）、无法解码的百分号转义、含 NUL 的路径：
 *   路径不可信，按 unknown 跳过；
 * - 文本编码含非法 UTF-8（如 GBK 中文路径）：无法可靠还原路径，按 unknown 跳过。
 *
 * ## 与 .lnk 扫描的关系
 * 桌面 / 开始菜单里的 `.url` 与 `.lnk` 一样只是「指针文件」，删除它不会影响目标
 * 文件本身；上层把解析出的 target 交给同一套存在性判定，避免两套逻辑出现分歧。
 */

/** 解析出的目标类型 */
export type InternetShortcutKind = 'file' | 'url' | 'unknown'

/** `.url` 解析结果 */
export interface InternetShortcutParseResult {
  kind: InternetShortcutKind
  /**
   * `file`：本地 / UNC 文件系统路径（已百分号解码、已转反斜杠，尚未展开环境变量）；
   * `url`：原始 URL 文本；`unknown`：空串。
   */
  target: string
}

/** INI 里的 URL 行（允许 `URL = ...` 这类空白写法，大小写不敏感） */
const URL_LINE_PATTERN = /^URL\s*=/i

/** 任意 URI scheme（`http:` / `file:` / `mailto:` …） */
const SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):/

/**
 * 解码 `.url` 文本。
 *
 * - 支持 UTF-8（可带 BOM）与 UTF-16LE（BOM），覆盖 Windows 常见保存方式；
 * - 出现 U+FFFD 说明原始字节不是合法 UTF-8（通常是 GBK/ANSI 中文），
 *   路径不可信，返回 undefined 交由上层按 unknown 跳过。
 */
function decodeText(content: Buffer | string): string | undefined {
  if (typeof content === 'string') return content
  if (content.length >= 2 && content[0] === 0xff && content[1] === 0xfe) {
    return content.subarray(2).toString('utf16le')
  }
  const text = content.toString('utf8')
  if (text.includes('\uFFFD')) return undefined
  return text.replace(/^\uFEFF/, '')
}

/**
 * 解析 `file:` URL。
 *
 * 支持 Windows 上的常见写法：
 * - `file:///C:/a/b.txt`（标准，三斜杠）；
 * - `file://localhost/C:/a/b.txt`（显式本机主机名）；
 * - `file:/C:/a/b.txt` / `file:C:\a\b.txt`（IE 兼容写法）；
 * - `file://server/share/a.txt`（UNC，解析为 `\\server\share\a.txt`，上层按网络跳过）。
 */
function parseFileUrl(value: string): InternetShortcutParseResult {
  const rest = value.slice('file:'.length)
  let host = ''
  let pathPart = rest
  if (rest.startsWith('//')) {
    const after = rest.slice(2)
    const slash = after.indexOf('/')
    host = slash === -1 ? after : after.slice(0, slash)
    pathPart = slash === -1 ? '' : after.slice(slash)
  }

  let decodedHost: string
  let decodedPath: string
  try {
    // 路径里的空格/中文在 .url 中通常以 UTF-8 百分号编码保存，必须解码后再查存在性
    decodedHost = decodeURIComponent(host)
    decodedPath = decodeURIComponent(pathPart)
  } catch {
    // 非法百分号转义：路径不可信
    return { kind: 'unknown', target: '' }
  }
  if (decodedHost.includes('\0') || decodedPath.includes('\0')) return { kind: 'unknown', target: '' }

  // UNC：file://server/share/x → \\server\share\x（上层按 network 跳过）
  if (decodedHost && decodedHost.toLowerCase() !== 'localhost') {
    return { kind: 'file', target: `\\\\${decodedHost}${decodedPath.replace(/\//g, '\\')}` }
  }

  // 本地：去掉 URL 路径开头的 `/`，`/C:/x` → `C:\x`
  let local = decodedPath.replace(/\//g, '\\')
  if (/^\\[a-zA-Z]:/.test(local)) local = local.slice(1)
  return { kind: 'file', target: local }
}

/**
 * 解析 `.url` 内容。
 *
 * 返回 `kind: 'file'` 时 target 为本地/UNC 路径（尚未展开环境变量）；
 * 返回 `kind: 'url'` 时 target 为 URL 原文（上层一律跳过）；
 * 没有 URL 行、编码不可信或 scheme 无法识别时返回 `kind: 'unknown'`。
 *
 * 该函数不访问文件系统、不抛异常。
 */
export function parseInternetShortcut(content: Buffer | string): InternetShortcutParseResult {
  const text = decodeText(content)
  if (text === undefined) return { kind: 'unknown', target: '' }

  // URL= 必须出现在 [InternetShortcut] 段内；这里按行找第一条 URL= 即可，
  // 因为 .url 文件只有一个 URL（其它段如 {000214A0-...} 不含 URL= 键）。
  let urlValue = ''
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!URL_LINE_PATTERN.test(trimmed)) continue
    urlValue = trimmed.slice(trimmed.indexOf('=') + 1).trim()
    break
  }
  if (!urlValue) return { kind: 'unknown', target: '' }

  if (/^file:/i.test(urlValue)) return parseFileUrl(urlValue)

  const scheme = SCHEME_PATTERN.exec(urlValue)?.[1]?.toLowerCase()
  // 任何网络协议（http/https/ftp/mailto…）都不判定：网络不可达 != 死链
  if (scheme) return { kind: 'url', target: urlValue }
  return { kind: 'unknown', target: urlValue }
}
