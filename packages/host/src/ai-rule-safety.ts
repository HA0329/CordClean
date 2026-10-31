/**
 * AI 规则安全评估（P0-1）。
 *
 * AI 可以建议规则，但不能绕过规则库的安全边界：
 * - 广域目录（AppData / Temp / 用户目录 / Windows / 盘符根）直接拒绝；
 * - 已知会破坏运行中工具的父缓存（npm-cache）直接拒绝；
 * - 较浅的 AppData 直系子目录降级为 caution，并由规则包保持“不默认选中”；
 * - 返回 warnings，交给界面展示。
 */
import path from 'node:path'
import type { AiRuleSuggestion, RiskLevel, TaskEnv } from '@cordclean/shared'
import { normalizePath, pathKey } from '@cordclean/utils'

export interface AiRuleSafetyAssessment {
  /** 命中硬拦截时给出可读原因 */
  blocked?: string
  /** 评估后的风险等级（可能被降级） */
  risk: RiskLevel
  warnings: string[]
}

function expandPath(value: string, env: TaskEnv): string {
  let text = String(value ?? '').trim()
  if (!text) return ''
  text = text.replace(/^~[\\/]/, env.userProfile + '\\')
  text = text.replace(/%([^%]+)%/g, (whole, name: string) => env.get(name) ?? whole)
  return normalizePath(text)
}

function rootKey(value: string, env: TaskEnv): string {
  const expanded = expandPath(value, env)
  return expanded ? pathKey(expanded) : ''
}

/** 从规则目标里提取所有候选根（不含通配 pattern） */
function targetRoots(target: AiRuleSuggestion['target']): string[] {
  const values: unknown[] = [target.path, ...(target.paths ?? []), target.base, ...(target.bases ?? [])]
  return [...new Set(values.filter((item): item is string => typeof item === 'string' && item.trim().length > 0))]
}

const BLOCKED_BASENAMES = new Set(['npm-cache', 'npm'])
const BROAD_ROOTS = [
  'localAppData',
  'appData',
  'userProfile',
  'windowsDir',
  'programFiles',
  'programFilesX86',
  'programData',
  'dataDir',
] as const

export function assessAiRuleSuggestion(suggestion: AiRuleSuggestion, env: TaskEnv): AiRuleSafetyAssessment {
  const warnings: string[] = []
  let risk: RiskLevel = suggestion.risk === 'risky' ? 'risky' : suggestion.risk === 'caution' ? 'caution' : 'safe'
  const roots = targetRoots(suggestion.target ?? ({} as AiRuleSuggestion['target']))
  if (!roots.length) return { blocked: '规则缺少目标路径', risk, warnings }

  // 盘符根 / 项目根目录
  const driveRoots = new Set<string>()
  for (const letter of 'abcdefghijklmnopqrstuvwxyz') driveRoots.add(`${letter}:\\`)

  const broadKeys = new Map<string, string>()
  for (const field of BROAD_ROOTS) {
    const value = (env as unknown as Record<string, unknown>)[field]
    if (typeof value === 'string' && value.trim()) broadKeys.set(pathKey(normalizePath(value)), field)
  }
  const tempValues = [env.get('TEMP'), env.get('TMP')].filter(Boolean) as string[]
  for (const value of tempValues) broadKeys.set(pathKey(normalizePath(value)), 'TEMP/TMP')

  for (const root of roots) {
    const expanded = expandPath(root, env)
    if (!expanded) continue
    const key = pathKey(expanded)
    if (driveRoots.has(key) || /^[a-z]:$/.test(key)) {
      return { blocked: 'AI 规则不能以盘符根为清理目标', risk, warnings }
    }
    const broad = broadKeys.get(key)
    if (broad) {
      return { blocked: `AI 规则不能直接清理整个 ${broad} 目录；请缩小到具体应用/缓存子目录`, risk, warnings }
    }
    const base = path.basename(expanded).toLowerCase()
    // 整个 npm-cache 会连带清掉正在运行的 npx/AI 工具；rules.json 已明确移除该父规则
    if (BLOCKED_BASENAMES.has(base)) {
      return {
        blocked: `AI 规则不能整体清理 ${path.basename(expanded)}；其中包含正在运行的 npx/AI 工具，请改用 _cacache/_logs/_npx 等具体子目录`,
        risk,
        warnings,
      }
    }
    // 直接子目录（LocalAppData/AppData/ProgramData 下一层）范围仍然很大，降级为谨慎
    for (const [parentKey, label] of broadKeys) {
      if (!parentKey) continue
      if (key === parentKey) continue
      const parent = parentKey.endsWith('\\') ? parentKey : parentKey + '\\'
      if (key.startsWith(parent)) {
        const relative = key.slice(parent.length)
        if (relative && !relative.includes('\\')) {
          warnings.push(`目标 ${path.basename(expanded)} 是 ${label} 的直接子目录，范围较大，已降级为谨慎`)
          if (risk === 'safe') risk = 'caution'
        }
        break
      }
    }
  }

  return { risk, warnings }
}
