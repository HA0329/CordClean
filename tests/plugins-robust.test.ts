/**
 * 插件管理器健壮性测试：配置校验、重复启停、异常隔离、状态持久化。
 */
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import Schema from 'schemastery'
import { createApp } from '@cordclean/core'
import { defineCleanerPlugin } from '@cordclean/shared'
import { createSandbox, manifestOf } from './helpers.ts'

const sandbox = createSandbox()

afterAll(async () => {
  const { deletePath } = await import('@cordclean/utils')
  try {
    await deletePath(sandbox.root, { recursive: true })
  } catch {
    /* ignore */
  }
})

/** 带配置的插件：根据 includeA 注册不同任务 */
const configurablePlugin = defineCleanerPlugin<{ includeA: boolean; label: string }>({
  name: 'cfg',
  inject: ['cleaner'],
  Config: Schema.object({
    includeA: Schema.boolean().default(true),
    label: Schema.string().default('默认标签'),
  }),
  setup(ctx, config) {
    ctx.effect(() =>
      ctx.cleaner.define({
        id: config.includeA ? 'cfg-a' : 'cfg-b',
        name: `配置任务-${config.label}`,
        category: 'system',
        risk: 'safe',
        scan() {},
      }),
    )
  },
})

const asyncBrokenPlugin = defineCleanerPlugin({
  name: 'asyncbroken',
  setup() {
    return Promise.reject(new Error('异步启动失败')) as any
  },
})

describe('插件配置校验', () => {
  it('非法配置被拒绝，运行中的插件保持原状', async () => {
    const app = await createApp({
      dataDir: path.join(sandbox.root, 'cfg-data'),
      logger: false,
      manifest: manifestOf([{ id: 'cfg', plugin: configurablePlugin }]),
    })
    try {
      expect(app.ctx.cleaner.list().map((task) => task.id)).toEqual(['cfg-a'])
      await expect(app.ctx.plugins.updateConfig('cfg', { includeA: 'yes' })).rejects.toThrow(/配置校验失败/)
      // 插件仍在运行，任务未变
      expect(app.ctx.plugins.list()[0].status).toBe('active')
      expect(app.ctx.cleaner.list().map((task) => task.id)).toEqual(['cfg-a'])
      // 设置未被污染
      expect(app.ctx.settings.get().plugins.cfg?.config?.includeA).not.toBe('yes')
    } finally {
      await app.dispose()
    }
  })

  it('合法配置触发插件热重载并改变行为', async () => {
    const app = await createApp({
      dataDir: path.join(sandbox.root, 'cfg-data-2'),
      logger: false,
      manifest: manifestOf([{ id: 'cfg', plugin: configurablePlugin }]),
    })
    try {
      await app.ctx.plugins.updateConfig('cfg', { includeA: false, label: '改过的标签' })
      const tasks = app.ctx.cleaner.list()
      expect(tasks.map((task) => task.id)).toEqual(['cfg-b'])
      expect(tasks[0].name).toBe('配置任务-改过的标签')
      expect(app.ctx.plugins.list()[0].status).toBe('active')
    } finally {
      await app.dispose()
    }
  })

  it('defaults() 返回 schema 默认值（用于界面渲染）', async () => {
    const app = await createApp({
      dataDir: path.join(sandbox.root, 'cfg-data-3'),
      logger: false,
      manifest: manifestOf([{ id: 'cfg', plugin: configurablePlugin, defaultEnabled: false }]),
    })
    try {
      const defaults = await app.ctx.plugins.defaults('cfg')
      expect(defaults).toEqual({ includeA: true, label: '默认标签' })
    } finally {
      await app.dispose()
    }
  })
})

describe('启停与异常隔离', () => {
  it('对不存在的插件操作给出明确错误', async () => {
    const app = await createApp({
      dataDir: path.join(sandbox.root, 'ops-data'),
      logger: false,
      manifest: manifestOf([{ id: 'cfg', plugin: configurablePlugin }]),
    })
    try {
      await expect(app.ctx.plugins.enable('nope')).rejects.toThrow(/插件不存在/)
      await expect(app.ctx.plugins.disable('nope')).rejects.toThrow(/插件不存在/)
      await expect(app.ctx.plugins.updateConfig('nope', {})).rejects.toThrow(/插件不存在/)
      await expect(app.ctx.plugins.defaults('nope')).rejects.toThrow(/插件不存在/)
    } finally {
      await app.dispose()
    }
  })

  it('重复启用不会重复注册任务', async () => {
    const app = await createApp({
      dataDir: path.join(sandbox.root, 'ops-data-2'),
      logger: false,
      manifest: manifestOf([{ id: 'cfg', plugin: configurablePlugin }]),
    })
    try {
      await app.ctx.plugins.enable('cfg')
      await app.ctx.plugins.enable('cfg')
      expect(app.ctx.cleaner.list().filter((task) => task.id === 'cfg-a')).toHaveLength(1)
      // 重复停用也不报错
      await app.ctx.plugins.disable('cfg')
      await app.ctx.plugins.disable('cfg')
      expect(app.ctx.cleaner.list()).toHaveLength(0)
    } finally {
      await app.dispose()
    }
  })

  it('重载已停用的插件不会把它悄悄启动', async () => {
    const app = await createApp({
      dataDir: path.join(sandbox.root, 'ops-data-3'),
      logger: false,
      manifest: manifestOf([{ id: 'cfg', plugin: configurablePlugin }]),
    })
    try {
      await app.ctx.plugins.disable('cfg')
      await app.ctx.plugins.reload('cfg')
      expect(app.ctx.cleaner.list()).toHaveLength(0)
      expect(app.ctx.plugins.list()[0].status).toBe('stopped')
    } finally {
      await app.dispose()
    }
  })

  it('异步启动失败被捕获为 error 状态', async () => {
    const app = await createApp({
      dataDir: path.join(sandbox.root, 'async-data'),
      logger: false,
      manifest: manifestOf([{ id: 'asyncBroken', plugin: asyncBrokenPlugin }]),
    })
    try {
      const info = app.ctx.plugins.list()[0]
      expect(info.status).toBe('error')
      expect(info.error).toContain('异步启动失败')
      // 内核依旧可用
      expect(app.ctx.settings.get().version).toBeGreaterThan(0)
    } finally {
      await app.dispose()
    }
  })

  it('启用状态持久化到设置，重启后保持', async () => {
    const dataDir = path.join(sandbox.root, 'persist-data')
    const first = await createApp({
      dataDir,
      logger: false,
      manifest: manifestOf([{ id: 'cfg', plugin: configurablePlugin }]),
    })
    await first.ctx.plugins.disable('cfg')
    first.ctx.settings.flush()
    await first.dispose()

    const second = await createApp({
      dataDir,
      logger: false,
      manifest: manifestOf([{ id: 'cfg', plugin: configurablePlugin }]),
    })
    try {
      expect(second.ctx.plugins.list()[0].status).toBe('stopped')
      expect(second.ctx.cleaner.list()).toHaveLength(0)
    } finally {
      await second.dispose()
    }
  })
})
