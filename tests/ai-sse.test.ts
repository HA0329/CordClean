import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { requestSse } from '../packages/plugins/ai/src/http.ts'
import { parseSseDelta } from '../packages/plugins/ai/src/adapters.ts'

describe('AI 流式输出（SSE）', () => {
  it('chat 增量可拼接成完整文本', async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"你"}}]}\n\n')
      res.write('data: {"choices":[{"delta":{"content":"好"}}]}\n\n')
      res.end('data: [DONE]\n\n')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as any).port
    let text = ''
    try {
      await requestSse(`http://127.0.0.1:${port}/chat`, {
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }, (payload) => { text += parseSseDelta('chat', payload).text ?? '' })
      expect(text).toBe('你好')
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('messages / responses 增量解析', () => {
    expect(parseSseDelta('messages', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'A' } })).toEqual({ text: 'A' })
    expect(parseSseDelta('messages', { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'R' } })).toEqual({ reasoning: 'R' })
    expect(parseSseDelta('responses', { type: 'response.output_text.delta', delta: 'B' })).toEqual({ text: 'B' })
  })
it('外部 AbortSignal 可中止流式请求', async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"x"}}]}\n\n')
      // 故意不结束响应
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as any).port
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    try {
      await expect(requestSse(`http://127.0.0.1:${port}/chat`, {
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: controller.signal,
      }, () => {})).rejects.toThrow()
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })})
