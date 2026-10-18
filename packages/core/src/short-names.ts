/**
 * 8.3 短文件名解析。
 *
 * Windows 允许用 `PROGRA~1` 这样的短名访问 `Program Files`。
 * 若路径策略只比较长名，攻击者（或错误的插件）就能用短名绕过保护检查。
 * 这里在第一次路径校验时一次性把保护目录的短名也加入保护列表。
 *
 * 解析需要拉起一次 cmd.exe（约 30~40ms），因此结果按「原路径 → 短名」缓存在模块级：
 * 同一进程内多次创建内核（测试、快速重启）不会重复付出这个开销。
 */
import { execFileSync } from 'node:child_process'

/** 原路径 → 短名（空串表示该路径没有 8.3 短名） */
const shortNameCache = new Map<string, string>()

/**
 * 解析一批路径的 8.3 短名。
 * @returns 发生了缩短的短名路径（不含 `~` 的会被过滤）
 */
export function expandShortNames(paths: string[]): string[] {
  if (process.platform !== 'win32' || !paths.length) return []

  const missing = paths.filter((item) => /^[a-zA-Z]:\\/.test(item) && !shortNameCache.has(item))
  if (missing.length) {
    const quoted = missing.map((item) => `"${item.replace(/"/g, '')}"`).join(' ')
    try {
      const output = execFileSync('cmd.exe', ['/c', `for %A in (${quoted}) do @echo %~sA`], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      })
      const aliases = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^[a-zA-Z]:\\/.test(line))
      // cmd 按输入顺序输出，逐一对齐；缺失的按「无短名」处理
      for (let i = 0; i < missing.length; i++) {
        const alias = aliases[i] ?? ''
        shortNameCache.set(missing[i], alias && alias.includes('~') ? alias : '')
      }
    } catch {
      for (const item of missing) shortNameCache.set(item, '')
    }
  }

  const result: string[] = []
  for (const item of paths) {
    const alias = shortNameCache.get(item)
    if (alias && alias !== item) result.push(alias)
  }
  return [...new Set(result)]
}

/** 仅供测试：清空缓存 */
export function clearShortNameCache(): void {
  shortNameCache.clear()
}
