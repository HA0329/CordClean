/**
 * UI 模板完整性回归：防止「批量替换/正则片段」被误写进界面文案，
 * 同时守住页面级标题的图标规范（内联 SVG `SectionIcon`，不再用 emoji 当标题图标）。
 *
 * 背景（2026-11-23）：
 * 1) 设置区升级时 11 个分组标题被写成 `<h3>[^<]*🧹\ 清理行为</h3>`，正则片段直接渲染；
 * 2) 侧边栏已换成内联 SVG 图标后，设置/概览/清理/历史页的卡片标题仍是 emoji 旧样式。
 * 这两类问题都靠静态单测兜底，避免再次靠肉眼发现。
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SETTINGS_GROUPS } from '../packages/ui/src/views/settings-view-model.ts'
import { SECTION_ICON_PATHS, type SectionIconName } from '../packages/ui/src/components/section-icons.ts'

const UI_SRC = path.resolve('packages/ui/src')
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u
const SECTION_ICON_TAG = /<SectionIcon\s+name="([a-z-]+)"/g

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

  it('设置页分组标题用 SectionIcon + 纯文案（无 emoji / 正则 / 反斜杠）', () => {
    const settings = readFileSync(path.join(UI_SRC, 'views', 'SettingsView.vue'), 'utf8')
    const blocks = [...settings.matchAll(/<h3>([\s\S]*?)<\/h3>/g)].map((match) => match[1])
    const iconBlocks = blocks.filter((block) => block.includes('<SectionIcon'))
    expect(iconBlocks.length).toBeGreaterThanOrEqual(12)
    for (const block of iconBlocks) {
      const text = block.replace(/<SectionIcon[^>]*\/>/g, '').trim()
      expect(text.length).toBeGreaterThan(0)
      expect(text).not.toMatch(EMOJI)
      expect(text).not.toContain('[^<')
      expect(text).not.toContain('\\ ')
    }
  })

  it('常规页（概览/清理/历史/设置）的卡片标题不再用 emoji 当图标', () => {
    const problems: string[] = []
    for (const view of ['OverviewView.vue', 'CleanView.vue', 'HistoryView.vue', 'SettingsView.vue']) {
      const file = path.join(UI_SRC, 'views', view)
      readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .forEach((line, index) => {
          if (/<h[23][\s>]/.test(line) && EMOJI.test(line)) {
            problems.push(`${view}:${index + 1}: ${line.trim()}`)
          }
        })
    }
    expect(problems, `常规页标题仍有 emoji：\n${problems.join('\n')}`).toEqual([])
  })

  it('设置分组图标都在 SectionIcon 路径表里，且路径数据非空', () => {
    expect(SETTINGS_GROUPS.length).toBe(12)
    const known = SECTION_ICON_PATHS as Record<string, readonly string[]>
    for (const group of SETTINGS_GROUPS) {
      expect(typeof group.icon).toBe('string')
      const paths = known[group.icon]
      expect(paths, `分组「${group.title}」的图标 ${group.icon} 未在 SectionIcon 中定义`).toBeTruthy()
      expect(paths.length).toBeGreaterThan(0)
      for (const d of paths) {
        expect(d.startsWith('M')).toBe(true)
        expect(d.length).toBeGreaterThan(3)
      }
    }
  })

  it('模板里用到的 SectionIcon 名称都有路径定义', () => {
    const known = SECTION_ICON_PATHS as Record<string, readonly string[]>
    const missing: string[] = []
    for (const file of vueFiles) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(SECTION_ICON_TAG)) {
        if (!known[match[1]]) missing.push(`${path.relative(process.cwd(), file)}: ${match[1]}`)
      }
    }
    expect(missing, `模板引用了未定义的 SectionIcon：${missing.join(', ')}`).toEqual([])
  })
})
