/**
 * 规则库参考 PC-Cleaner v0.9.19 的扩展回归：
 * - 新增规则必须有来源标注、安全目标（非驱动器根/Program Files/用户下载目录）；
 * - 风险等级按来源校正（system_logs/database_compact 不再是 safe）；
 * - 新规则能通过唯一入库管线（0 拒绝）并被默认任务加载。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from '@cordclean/core'

const catalog = JSON.parse(await (await import('node:fs/promises')).readFile('packages/plugins/rule-pack/rules/catalog.json', 'utf8'))
const extra = JSON.parse(await (await import('node:fs/promises')).readFile('packages/plugins/rule-pack/rules/extra.json', 'utf8'))
const categories = [...catalog.categories, ...extra.categories]
const allRules = categories.flatMap((category: any) => category.rules.map((rule: any) => ({ ...rule, categoryKey: category.key })))

describe('PC-Cleaner v0.9.19 规则扩展', () => {
  const added = allRules.filter((rule: any) => String(rule.note ?? '').includes('PC-Cleaner v0.9.19'))

  it('新增规则均有来源标注，且不是垃圾数量堆叠', () => {
    expect(added.length).toBe(10)
    for (const rule of added) {
      expect(rule.source).toBe('imported')
      expect(String(rule.note)).toMatch(/PC-Cleaner v0\.9\.19/)
      expect(rule.name).toBeTruthy()
    }
    const names = added.map((rule: any) => rule.name)
    for (const expected of ['NVIDIA 计算缓存(ComputeCache)', 'QQ 浏览器缓存', '搜狗浏览器缓存', 'Slack 缓存', 'Microsoft Teams 缓存', '飞书/Lark 缓存', '传递优化跟踪日志', '系统级 WER 临时文件', '设备元数据缓存']) {
      expect(names).toContain(expected)
    }
  })

  it('风险等级按来源校正：system_logs/database_compact 不再标 safe', () => {
    const logs = categories.find((category: any) => category.key === 'system_logs')
    const compact = categories.find((category: any) => category.key === 'database_compact')
    expect(logs.risk).toBe('caution')
    expect(logs.rules.every((rule: any) => rule.risk === 'caution' && rule.target.requiresAdmin !== false)).toBe(true)
    expect(compact.risk).toBe('caution')
    expect(compact.rules.every((rule: any) => rule.risk === 'caution')).toBe(true)
  })

  it('安全边界：新增规则不碰驱动器根/Program Files/用户下载目录', () => {
    const roots = (rule: any) => [rule.target?.path, ...(rule.target?.paths ?? []), ...(rule.target?.bases ?? []), rule.target?.base].filter(Boolean).map((item: string) => String(item).toLowerCase())
    for (const rule of added) {
      for (const root of roots(rule)) {
        expect(root).not.toMatch(/^[a-z]:\\?$/)
        expect(root).not.toMatch(/%programfiles%/i)
        expect(root).not.toMatch(/^~\/downloads/i)
      }
      expect(rule.target.type).not.toBe('broken_shortcuts')
      expect(rule.target.type).not.toBe('delete_dir')
    }
  })

  it('新增规则通过唯一入库管线，默认任务数不变', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cc-pc-rules-test-'))
    const app = await createApp({ dataDir, logLevel: 'error' })
    try {
      const ctx = app.ctx as any
      const loaded = ctx.rules.list()
      expect(loaded.length).toBe(306)
      for (const rule of added) expect(loaded.some((item: any) => item.id === rule.id)).toBe(true)
      const ruleTasks = ctx.cleaner.list().filter((task: any) => String(task.id).startsWith('rule:'))
      expect(ruleTasks.length).toBe(31)
    } finally {
      await app.dispose()
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  })
})
