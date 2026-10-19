import { describe, expect, it } from 'vitest'
import { buildRequest } from '../packages/plugins/ai/src/adapters.ts'
import { normalizeConfig } from '../packages/plugins/ai/src/config.ts'

const image = { mime: 'image/png', data: 'AAAA' }

describe('Vision 图片输入', () => {
  it('chat 形态使用 image_url 内容块', () => {
    const req = buildRequest(normalizeConfig({ apiKey: 'k', apiShape: 'chat' }), 'k', 's', 'u', undefined, image)
    const content = (req.body as any).messages.at(-1).content
    expect(content[1]).toMatchObject({ type: 'image_url' })
    expect(content[1].image_url.url).toContain('data:image/png;base64,')
  })

  it('messages 形态使用 image 内容块', () => {
    const req = buildRequest(normalizeConfig({ apiKey: 'k', apiShape: 'messages' }), 'k', 's', 'u', undefined, image)
    const content = (req.body as any).messages.at(-1).content
    expect(content[1]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png' } })
  })

  it('responses 形态明确拒绝图片', () => {
    expect(() => buildRequest(normalizeConfig({ apiKey: 'k', apiShape: 'responses' }), 'k', 's', 'u', undefined, image)).toThrow(/不支持图片/)
  })
})
