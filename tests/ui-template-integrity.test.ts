/**
 * UI 模板完整性回归：防止「批量替换/正则片段」被误写进界面文案。
 *
 * 背景（2026-11-23 设置页乱码 bug）：设置区升级时，11 个分组卡片标题被写成
 * `<h3>[^<]*🧹\ 清理行为</h3>` —— 字面量正则片段 `[^<]*` 和转义反斜杠直接渲染到页面。
 * 单测兜底这类「模板里出现正则元字符」的回归，避免再次靠肉眼发现。
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const UI_SRC = path.resolve('packages/ui/src')

function walk(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(full))
    else files.push(full)
  }
  return files
}

const vueFiles = walk(UI_SRC).filter((file) => file.endsWith('.vue'))
const sourceFiles = walk(UI_SRC).filter((file) => file.endsWith('.vue') || file.endsWith('.ts'))

describe('UI 模板完整性', () => {
  it('能找到待检查的 Vue 文件（防止 glob 失效导致空跑）', () => {
    expect(vueFiles.length).toBeGreaterThan(10)
  })

  it('标题标签（h1-h4）里不得出现正则片段 `[^<]` 或转义反斜杠', () => {
    const problems: string[] = []
    for (const file of vueFiles) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/)
      lines.forEach((line, index) => {
        if (!/<h[1-4][\s>]/.test(line)) return
        if (line.includes('[^<') || /\\ /.test(line)) {
          problems.push(`${path.relative(process.cwd(), file)}:${index + 1}: ${line.trim()}`)
        }
      })
    }
    expect(problems, `标题里混入了正则/转义片段：\n${problems.join('\n')}`).toEqual([])
  })

  it('UI 源码里不得出现字面量 `[^<]*`（历史上由误替换写入模板产生）', () => {
    const problems: string[] = []
    for (const file of sourceFiles) {
      const text = readFileSync(file, 'utf8')
      if (text.includes('[^<]*')) problems.push(path.relative(process.cwd(), file))
    }
    expect(problems, `源码里出现字面量 [^<]*：${problems.join(', ')}`).toEqual([])
  })

  it('设置页 11 个分组标题均为纯文案（不含正则/反斜杠）', () => {
    const settings = readFileSync(path.join(UI_SRC, 'views', 'SettingsView.vue'), 'utf8')
    const titles = [...settings.matchAll(/<h3>([^<]*)<\/h3>/g)].map((match) => match[1].trim())
    expect(titles.length).toBeGreaterThanOrEqual(11)
    for (const title of titles) {
      expect(title).not.toMatch(/\[\^</)
      expect(title).not.toMatch(/\\ /)
      expect(title.length).toBeGreaterThan(0)
    }
  })
})
