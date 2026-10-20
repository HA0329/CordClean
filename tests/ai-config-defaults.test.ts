import { describe, expect, it } from 'vitest'
import { normalizeConfig } from '@cordclean/plugin-ai'

describe('AI 默认模型与旧模型名迁移', () => {
  it('默认模型是 deepseek-flash', () => {
    expect(normalizeConfig({}).model).toBe('deepseek-flash')
  })

  it('旧默认 deepseek-chat / deepseek-reasoner / coder 自动迁移到 flash', () => {
    expect(normalizeConfig({ model: 'deepseek-chat' }).model).toBe('deepseek-flash')
    expect(normalizeConfig({ model: 'DeepSeek-Reasoner' }).model).toBe('deepseek-flash')
    expect(normalizeConfig({ model: 'deepseek-coder' }).model).toBe('deepseek-flash')
  })

  it('其他模型名保持原样（可手填任意模型）', () => {
    expect(normalizeConfig({ model: 'my-custom-model' }).model).toBe('my-custom-model')
    expect(normalizeConfig({ model: 'deepseek-v4-pro' }).model).toBe('deepseek-v4-pro')
  })
})
