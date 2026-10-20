/**
 * rule-pack 评估器 protected 语义与引擎对齐（批次 1-D）。
 *
 * 背景：真实扫描里普通缓存目录的 clear 规则被写成「位于受保护目录，工具不会删除」，
 * 但引擎（`cleaner.pushItem`）其实允许清理、界面也能勾选 —— 评估器与引擎对
 * 「clear 语义」的判断不一致造成的误导。
 *
 * 本测试锁定两件事：
 * 1. `policyAllowsItem` 的纯函数语义与引擎逐条一致：
 *    - 普通缓存目录 clear：checkClear 拒绝后必须回落 check，最终允许；
 *    - 受保护目录 clear（不在清空白名单）：checkClear 与 check 都拒绝 ⇒ 仍 protected；
 *    - clear 白名单命中：直接允许，不再回落；
 *    - 文件 / 删除类目录：只用 check，不查清空白名单。
 * 2. 经过真实内核（rule-pack + pathPolicy + cleaner + evaluator）扫描时，
 *    protected / note / defaultSelected 与引擎能力一致、不回归。
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp, type App } from '@cordclean/core'
import rulePack, { policyAllowsItem } from '@cordclean/plugin-rule-pack'
import type { CleanRule, PathPolicyCheck } from '@cordclean/shared'
import { createSandbox, manifestOf } from './helpers.ts'

/* ------------------------------------------------------------------ */
/* 一、纯函数：与引擎 cleaner.pushItem 的路径策略判断对齐                */
/* ------------------------------------------------------------------ */

const ALLOWED: PathPolicyCheck = { allowed: true }
const CLEAR_DENIED: PathPolicyCheck = { allowed: false, reason: 'outside', detail: '不在清空白名单内' }
const PROTECTED: PathPolicyCheck = { allowed: false, reason: 'protected', detail: 'C:\\Windows\\System32' }

interface MockPolicy {
  /** 调用记录，用于断言 checkClear 与 check 的先后/是否被调用 */
  calls: string[]
  policy: {
    check(target: string): PathPolicyCheck
    checkClear(target: string): PathPolicyCheck
  }
}

/** 构造只实现 check / checkClear 的路径策略替身 */
function createMockPolicy(results: { clear?: PathPolicyCheck; check?: PathPolicyCheck } = {}): MockPolicy {
  const calls: string[] = []
  const policy = {
    check(target: string): PathPolicyCheck {
      calls.push(`check(${target})`)
      return results.check ?? ALLOWED
    },
    checkClear(target: string): PathPolicyCheck {
      calls.push(`checkClear(${target})`)
      return results.clear ?? CLEAR_DENIED
    },
  }
  return { calls, policy }
}

describe('policyAllowsItem：与引擎对齐的 clear 语义', () => {
  it('普通缓存目录 clear：checkClear 拒绝后回落 check，最终允许（旧实现会误判 protected）', () => {
    const target = 'D:\\Caches\\SomeApp'
    const { calls, policy } = createMockPolicy({ clear: CLEAR_DENIED, check: ALLOWED })
    expect(policyAllowsItem(policy, target, 'directory', 'clear')).toBe(true)
    // 关键：先查清空白名单，失败后必须回落普通允许根，且顺序与引擎一致
    expect(calls).toEqual([`checkClear(${target})`, `check(${target})`])
  })

  it('受保护目录 clear 且不在白名单：两处都拒绝 ⇒ 仍不允许（引擎会标 protected）', () => {
    const target = 'C:\\Windows\\System32\\LogFiles'
    const { calls, policy } = createMockPolicy({ clear: CLEAR_DENIED, check: PROTECTED })
    expect(policyAllowsItem(policy, target, 'directory', 'clear')).toBe(false)
    expect(calls).toEqual([`checkClear(${target})`, `check(${target})`])
  })

  it('清空白名单命中：直接允许，不再回落 check', () => {
    const target = 'C:\\Windows\\System32\\LogFiles'
    const { calls, policy } = createMockPolicy({ clear: ALLOWED, check: PROTECTED })
    expect(policyAllowsItem(policy, target, 'directory', 'clear')).toBe(true)
    expect(calls).toEqual([`checkClear(${target})`])
  })

  it('文件项即使规则 action=clear 也只查 check（引擎只在目录上走清空白名单）', () => {
    const target = 'D:\\Caches\\SomeApp\\cache.bin'
    const allowed = createMockPolicy({ clear: ALLOWED, check: ALLOWED })
    expect(policyAllowsItem(allowed.policy, target, 'file', 'clear')).toBe(true)
    expect(allowed.calls).toEqual([`check(${target})`])

    const denied = createMockPolicy({ clear: ALLOWED, check: PROTECTED })
    expect(policyAllowsItem(denied.policy, target, 'file', 'clear')).toBe(false)
    expect(denied.calls).toEqual([`check(${target})`])
  })

  it('删除类 / 普通目录动作只用 check，不查清空白名单', () => {
    const target = 'C:\\Windows\\System32\\LogFiles'
    const byCheck = createMockPolicy({ clear: ALLOWED, check: PROTECTED })
    expect(policyAllowsItem(byCheck.policy, target, 'directory', 'delete')).toBe(false)
    expect(byCheck.calls).toEqual([`check(${target})`])

    const noAction = createMockPolicy({ clear: ALLOWED, check: ALLOWED })
    expect(policyAllowsItem(noAction.policy, target, 'directory')).toBe(true)
    expect(noAction.calls).toEqual([`check(${target})`])
  })
})

/* ------------------------------------------------------------------ */
/* 二、集成：真实内核扫描时 protected / note / defaultSelected 一致     */
/* ------------------------------------------------------------------ */

const sandbox = createSandbox()
const apps: App[] = []

afterAll(async () => {
  for (const app of apps) await app.dispose()
  rmSync(sandbox.root, { recursive: true, force: true })
})

const RULE_CATEGORY = 'eval-align'
const RULE_TASK = `rule:${RULE_CATEGORY}`

/** 构造一条 clear_dir 自定义规则（经 settings.rules.custom 注入） */
function makeRule(id: string, targetPath: string, risk: CleanRule['risk'] = 'safe'): CleanRule {
  return {
    id,
    category: RULE_CATEGORY,
    categoryLabel: '评估器对齐测试',
    categoryId: 'system',
    name: `评估器对齐规则 ${id}`,
    risk,
    source: 'user',
    version: 1,
    target: { type: 'clear_dir', path: targetPath },
  }
}

/** 启动一个只挂载 rule-pack 的测试内核（真实 pathPolicy / cleaner / evaluator） */
async function bootApp(name: string, custom: CleanRule[]): Promise<App> {
  const app = await createApp({
    dataDir: path.join(sandbox.dataDir, name),
    logger: false,
    manifest: manifestOf([{ id: 'rule-pack', plugin: rulePack }]),
    settingsOverrides: { rules: { custom } },
  })
  apps.push(app)
  return app
}

/** Windows 安装目录（受保护目录都挂在其下） */
const WINDOWS_ROOT = process.env.SystemRoot ?? 'C:\\Windows'
/** 真实受保护目录：System32\drivers 在 pathPolicy 保护列表里，且该目录小而稳定存在 */
const PROTECTED_DIR = path.join(WINDOWS_ROOT, 'System32', 'drivers', 'etc')

describe('rule-pack 扫描集成：普通缓存目录 vs 受保护目录', () => {
  it('普通缓存目录的 clear 规则：引擎允许 ⇒ 不标 protected，note 不再输出误导说明', async () => {
    const dir = sandbox.dir('eval-normal')
    writeFileSync(path.join(dir, 'cache.bin'), 'x'.repeat(2048))
    const app = await bootApp('app-normal', [makeRule('align-normal', dir)])
    expect(app.ctx.cleaner.list().map((task) => task.id)).toContain(RULE_TASK)

    const report = await app.ctx.cleaner.scan({ taskIds: [RULE_TASK] })
    expect(report.items).toHaveLength(1)
    const item = report.items[0]!

    // 引擎确实允许处理：不是受保护项、默认勾选、说明来自评估器的正向原因
    expect(item.protected).toBe(false)
    expect(item.risk).toBe('safe')
    expect(item.defaultSelected).toBe(true)
    expect(item.note).toContain('命中规则')
    // 回归点：不得再出现「位于受保护目录，工具不会删除」这类与引擎矛盾的说明
    expect(item.note).not.toContain('位于受保护目录')
    expect(item.note).not.toContain('工具不会删除')
  })

  it.skipIf(!existsSync(PROTECTED_DIR))(
    '受保护目录（不在 clear 白名单）的 clear 规则：仍标 protected 并保留真实原因',
    async () => {
      const app = await bootApp('app-protected', [makeRule('align-protected', PROTECTED_DIR)])

      const report = await app.ctx.cleaner.scan({ taskIds: [RULE_TASK] })
      expect(report.items).toHaveLength(1)
      const item = report.items[0]!

      expect(item.protected).toBe(true)
      expect(item.defaultSelected).toBe(false)
      // 该项引擎确实拒绝删除 ⇒ 说明里保留真实原因，与引擎能力一致（不是误导）
      expect(item.note).toContain('位于受保护目录')
      expect(item.note).toContain('工具不会删除')
    },
  )

  it('caution 规则：suggest=false 时保留评估器原因、defaultSelected=false（不回归）', async () => {
    const dir = sandbox.dir('eval-caution')
    writeFileSync(path.join(dir, 'app.log'), 'y'.repeat(512))
    const app = await bootApp('app-caution', [makeRule('align-caution', dir, 'caution')])

    const report = await app.ctx.cleaner.scan({ taskIds: [RULE_TASK] })
    expect(report.items).toHaveLength(1)
    const item = report.items[0]!

    expect(item.protected).toBe(false)
    expect(item.risk).toBe('caution')
    expect(item.defaultSelected).toBe(false)
    expect(item.note).toContain('需人工确认')
    expect(item.note).not.toContain('工具不会删除')
  })
})
