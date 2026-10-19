import { describe, expect, it } from 'vitest'
import { parseResponse } from '../packages/plugins/ai/src/adapters.ts'
import { normalizeConfig } from '../packages/plugins/ai/src/config.ts'

const base = normalizeConfig({ apiKey: 'k', model: 'mock' })

describe('工具调用解析', () => {
  it('chat 形态解析 tool_calls', () => {
    const parsed = parseResponse({ ...base, apiShape: 'chat' } as any, {
      choices: [{ message: { content: '', tool_calls: [{ function: { name: 'emit_plugin', arguments: '{"name":"x","code":"export default {}"}' } }] }, finish_reason: 'tool_calls' }],
    })
    expect(parsed.toolCalls?.[0]).toMatchObject({ name: 'emit_plugin', arguments: { name: 'x' } })
  })

  it('messages 形态解析 tool_use', () => {
    const parsed = parseResponse({ ...base, apiShape: 'messages' } as any, {
      content: [{ type: 'tool_use', name: 'emit_plugin', input: { name: 'y', code: 'export default {}' } }],
      stop_reason: 'tool_use',
    })
    expect(parsed.toolCalls?.[0]).toMatchObject({ name: 'emit_plugin', arguments: { name: 'y' } })
  })

  it('responses 形态解析 function_call', () => {
    const parsed = parseResponse({ ...base, apiShape: 'responses' } as any, {
      output: [{ type: 'function_call', name: 'emit_plugin', arguments: '{"name":"z","code":"export default {}"}' }],
      status: 'completed',
    })
    expect(parsed.toolCalls?.[0]).toMatchObject({ name: 'emit_plugin', arguments: { name: 'z' } })
  })
})
