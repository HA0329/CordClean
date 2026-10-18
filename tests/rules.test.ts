/**
 * 规则层测试：规则注册表、清空白名单、评估器、规则包纯函数、规则目录完整性。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp, type App } from '@cordclean/core'
import { validateRules } from '@cordclean/shared'
import type { CleanRule } from '@cordclean/shared'
import { expandTemplate, matchSegment, matchSegments, ruleRoots } from '@cordclean/plugin-rule-pack'
import { createSandbox, manifestOf } from './helpers.ts'

const sandbox = createSandbox()
const apps: App[] = []

afterAll(async () => {
  for (const app of apps) await app.dispose()
  rmSync(sandbox.root, { recursive: true, force: true })
})

async function boot(name: string): Promise<App> {
  const app = await createApp({
    dataDir: path.join(sandbox.dataDir, name),
    logger: false,
    manifest: manifestOf([]),
  })
  apps.push(app)
  return app
}

const rule = (patch: Partial<CleanRule> = {}): CleanRule => ({
  id: 'r1',
  category: 'test',
  name: '测试规则',
  risk: 'safe',
  source: 'user',
  version: 1,
  target: { type: 'clear_dir', path: sandbox.root },
  ...patch,
})

describe('规则注册表', () => {
  it('登记后可见，注销后消失（副作用归属调用方）', async () => {
    const app = await boot('rules-basic')
    const dispose = app.ctx.rules.register(app.ctx, [rule({ id: 'a' }), rule({ id: 'b' })])
    expect(app.ctx.rules.list().map((item) => item.id)).toEqual(['a', 'b'])
    expect(app.ctx.rules.categories()[0].key).toBe('test')
    dispose()
    expect(app.ctx.rules.list()).toHaveLength(0)
  })

  it('结构非法的规则被拒绝，合法规则仍能登记', async () => {
    const app = await boot('rules-validate')
    const bad = rule({ id: 'bad', target: { type: 'glob_files', base: sandbox.root } })
    app.ctx.rules.register(app.ctx, [bad, rule({ id: 'good' })])
    expect(app.ctx.rules.list().map((item) => item.id)).toEqual(['good'])
  })

  it('分类风险取组内最高，统计按类型与风险分组', async () => {
    const app = await boot('rules-stats')
    app.ctx.rules.register(app.ctx, [
      rule({ id: 'safe-1', risk: 'safe' }),
      rule({ id: 'risky-1', risk: 'risky' }),
    ])
    expect(app.ctx.rules.categories()[0].risk).toBe('risky')
    const stats = app.ctx.rules.stats()
    expect(stats.rules).toBe(2)
    expect(stats.byRisk).toMatchObject({ safe: 1, risky: 1 })
  })

  it('校验器能发现缺少 pattern / maxDepth 等错误', () => {
    const issues = validateRules([
      rule({ id: 'x', target: { type: 'glob_files', base: sandbox.root } }),
      rule({ id: 'y', target: { type: 'find_dirs', bases: [sandbox.root], names: ['node_modules'] } }),
    ])
    expect(issues.filter((issue) => issue.level === 'error')).toHaveLength(2)
  })
})

describe('清空白名单', () => {
  it('受保护目录默认拒绝，登记 clearRoot 后允许清空', async () => {
    const app = await boot('clear-policy')
    const dir = path.join(sandbox.root, 'protected-like')
    mkdirSync(dir, { recursive: true })

    // 用一个"看起来受保护"的目录模拟：把 sandbox 作为允许根，但子目录不登记
    expect(app.ctx.pathPolicy.check(dir).allowed).toBe(false)
    const dispose = app.ctx.pathPolicy.addClearRoot(dir)
    expect(app.ctx.pathPolicy.check(dir).allowed).toBe(false) // 目录本身仍受保护
    expect(app.ctx.pathPolicy.checkClear(dir).allowed).toBe(true)
    expect(app.ctx.pathPolicy.checkClear(path.join(dir, 'child')).allowed).toBe(true)
    expect(app.ctx.pathPolicy.checkClear(sandbox.root).allowed).toBe(false)
    dispose()
    expect(app.ctx.pathPolicy.checkClear(dir).allowed).toBe(false)
  })

  it('清空只删内容，保留目录本身', async () => {
    const app = await boot('clear-engine')
    const dir = path.join(sandbox.root, 'cache')
    mkdirSync(path.join(dir, 'nested'), { recursive: true })
    writeFileSync(path.join(dir, 'a.bin'), Buffer.alloc(2048, 1))
    writeFileSync(path.join(dir, 'nested', 'b.bin'), Buffer.alloc(1024, 2))

    app.ctx.pathPolicy.addClearRoot(dir)
    app.ctx.cleaner.define({
      id: 'clear-task',
      name: '清空测试',
      category: 'system',
      risk: 'safe',
      icon: '🧪',
      defaultSelected: true,
      targets: [dir],
      async scan(scan) {
        scan.emit({ path: dir, kind: 'directory', size: 3072, meta: { action: 'clear' } })
      },
    })

    const report = await app.ctx.cleaner.scan({ taskIds: ['clear-task'] })
    expect(report.items).toHaveLength(1)

    const result = await app.ctx.cleaner.clean({ items: [report.items[0]] })
    expect(result.cleaned).toBe(1)
    expect(result.failed).toBe(0)
    expect(existsSync(dir)).toBe(true)
    expect(existsSync(path.join(dir, 'a.bin'))).toBe(false)
    expect(existsSync(path.join(dir, 'nested'))).toBe(false)
  })
})

describe('评估器', () => {
  it('heuristic：safe 建议清理，risky 不建议，受保护直接拒绝', async () => {
    const app = await boot('evaluator')
    const results = await app.ctx.evaluator.evaluate([
      { rule: rule({ risk: 'safe' }), path: 'C:/a', kind: 'file', size: 1, mtimeMs: Date.now() - 86_400_000 * 30 },
      { rule: rule({ risk: 'risky' }), path: 'C:/b', kind: 'file', size: 1, mtimeMs: Date.now() - 86_400_000 * 30 },
      { rule: rule({ risk: 'safe' }), path: 'C:/c', kind: 'file', size: 1, mtimeMs: Date.now(), protected: true },
    ])
    expect(results[0]).toMatchObject({ suggest: true, risk: 'safe' })
    expect(results[1]).toMatchObject({ suggest: false, risk: 'risky' })
    expect(results[2].suggest).toBe(false)
    expect(results[2].reason).toContain('受保护')
  })

  it('可替换策略：注册自定义评估器并切换，失败时回退启发式', async () => {
    const app = await boot('evaluator-strategy')
    expect(app.ctx.evaluator.current()).toBe('heuristic')
    const dispose = app.ctx.evaluator.register({
      id: 'mock',
      name: 'Mock 评估器',
      evaluate: (inputs) => inputs.map(() => ({ suggest: false, risk: 'caution' as const, reason: 'mock 判定' })),
    })
    app.ctx.evaluator.use('mock')
    const results = await app.ctx.evaluator.evaluate([
      { rule: rule(), path: 'C:/x', kind: 'file', size: 1, mtimeMs: 0 },
    ])
    expect(results[0].reason).toBe('mock 判定')
    expect(app.ctx.evaluator.strategies()).toContain('mock')

    // 策略抛错 → 回退启发式，不把异常抛给扫描
    app.ctx.evaluator.register({
      id: 'broken',
      name: '坏策略',
      evaluate: () => {
        throw new Error('boom')
      },
    })
    app.ctx.evaluator.use('broken')
    const fallback = await app.ctx.evaluator.evaluate([
      { rule: rule({ risk: 'safe' }), path: 'C:/x', kind: 'file', size: 1, mtimeMs: 0 },
    ])
    expect(fallback[0].strategy).toBe('heuristic')
    dispose()
  })
})

describe('规则包纯函数', () => {
  const env = {
    userProfile: 'C:\\Users\\tester',
    localAppData: 'C:\\Users\\tester\\AppData\\Local',
    appData: 'C:\\Users\\tester\\AppData\\Roaming',
    temp: 'C:\\Temp',
    get: (name: string) => {
      const map: Record<string, string> = {
        TEMP: 'C:\\Temp',
        LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
        APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
        USERPROFILE: 'C:\\Users\\tester',
      }
      return map[name.toUpperCase()]
    },
  } as any

  it('展开 %VAR% 与 ~/，未知变量返回空串', () => {
    expect(expandTemplate('%LOCALAPPDATA%/NVIDIA/DXCache', env)).toBe('C:\\Users\\tester\\AppData\\Local\\NVIDIA\\DXCache')
    expect(expandTemplate('~/Downloads', env)).toBe('C:\\Users\\tester\\Downloads')
    expect(expandTemplate('%NOPE%/x', env)).toBe('')
  })

  it('glob 分段匹配支持 * 与多段路径', () => {
    expect(matchSegment('thumbcache_*.db', 'thumbcache_256.db')).toBe(true)
    expect(matchSegment('*.db', 'a.png')).toBe(false)
    expect(matchSegments(['*', 'History'], ['Default', 'History'])).toBe(true)
    expect(matchSegments(['*', 'History'], ['Default', 'History', 'x'])).toBe(false)
  })

  it('ruleRoots 合并 path/paths/base/bases 并去重', () => {
    const single: CleanRule = rule({
      target: { type: 'clear_dir', path: '%TEMP%', paths: ['%TEMP%', '%APPDATA%/x'] },
    })
    const roots = ruleRoots(single, env)
    expect(roots).toEqual(['C:\\Temp', 'C:\\Users\\tester\\AppData\\Roaming\\x'])
  })
})

describe('规则目录（catalog.json）', () => {
  const catalogPath = path.resolve(import.meta.dirname, '../packages/plugins/rule-pack/rules/catalog.json')
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as {
    version: number
    categories: Array<{ key: string; label: string; risk: string; categoryId: string; rules: any[] }>
  }

  it('导入规模与分类覆盖达到预期', () => {
    expect(catalog.categories.length).toBeGreaterThanOrEqual(25)
    const total = catalog.categories.reduce((sum, category) => sum + category.rules.length, 0)
    expect(total).toBeGreaterThanOrEqual(260)
    // 每个分类都必须有界面归类
    for (const category of catalog.categories) {
      expect(category.categoryId).toBeTruthy()
      expect(category.label).toBeTruthy()
    }
  })

  it('所有规则通过结构校验（无 error）', () => {
    const rules: CleanRule[] = catalog.categories.flatMap((category) =>
      category.rules.map((item) => ({
        ...item,
        category: category.key,
        categoryLabel: category.label,
        categoryId: category.categoryId as any,
      })),
    )
    const errors = validateRules(rules).filter((issue) => issue.level === 'error')
    expect(errors.map((issue) => issue.message)).toEqual([])
  })
})
