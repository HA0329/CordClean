import path from 'node:path'
import { rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp, type App } from '@cordclean/core'
import { createSandbox, manifestOf } from './helpers.ts'

const sandbox = createSandbox()
const apps: App[] = []

afterAll(async () => {
  for (const app of apps) await app.dispose()
  rmSync(sandbox.root, { recursive: true, force: true })
})

async function boot(name: string): Promise<App> {
  const app = await createApp({ dataDir: path.join(sandbox.dataDir, name), logger: false, manifest: manifestOf([]) })
  apps.push(app)
  return app
}

describe('AI 上下文采集器', () => {
  it('内置采集器可列出，默认采集热点与已安装软件', async () => {
    const app = await boot('ai-context-default')
    const list = app.ctx.aiContext.list()
    expect(list.map((item) => item.id)).toEqual(expect.arrayContaining(['hotspots', 'installed-apps']))
    const sections = await app.ctx.aiContext.collect()
    expect(sections.length).toBeGreaterThan(0)
    expect(sections.map((section) => section.id)).toContain('hotspots')
  })

  it('只采集显式启用的采集器，且输出不含绝对路径', async () => {
    const app = await boot('ai-context-toggle')
    const sections = await app.ctx.aiContext.collect(['hotspots'])
    expect(sections.map((section) => section.id)).toEqual(['hotspots'])
    const text = sections.flatMap((section) => section.lines).join('\n')
    expect(text).not.toMatch(/[A-Za-z]:\\/)
    expect(text).not.toContain('\\\\')
    expect(text.length).toBeGreaterThan(0)
  })

  it('插件可注册自定义采集器，并随注销移除', async () => {
    const app = await boot('ai-context-custom')
    const dispose = app.ctx.aiContext.addProvider({
      id: 'custom-demo',
      name: '演示采集器',
      collect: () => ({ id: 'custom-demo', title: '演示', lines: ['示例段落'] }),
    })
    const sections = await app.ctx.aiContext.collect(['custom-demo'])
    expect(sections[0]?.lines).toEqual(['示例段落'])
    dispose()
    const after = await app.ctx.aiContext.collect(['custom-demo'])
    expect(after).toHaveLength(0)
  })
})
