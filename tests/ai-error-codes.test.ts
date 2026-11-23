/**
 * AI 稳定错误码：宿主序列化 → 界面分类，不再依赖厂商文案。
 *
 * 覆盖三件事：
 * 1. 错误码载体：JSON-RPC data.aiCode 与 IPC message 的 [CODE] 前缀都能读；
 * 2. AI 顾问 / 工坊分类：码命中时不看文案，码缺失时退回旧文案规则；
 * 3. RPC 序列化：AiError 的码写进 message 前缀 + data，普通错误不受影响。
 */
import { describe, expect, it } from 'vitest'
import { aiErrorCodeOfRaw, codeFromMessage, stripAiErrorCodePrefix } from '../packages/ui/src/ai-error-codes.ts'
import { classifyAiError } from '../packages/ui/src/views/ai-view-model.ts'
import { classifyWorkshopFailure } from '../packages/ui/src/views/ai-workshop-view-model.ts'
import { serializeRpcError } from '../packages/host/src/rpc-error.ts'

function rpcError(message: string, aiCode: string): Error & { data: { aiCode: string; aiStatus?: number } } {
  return Object.assign(new Error(message), { data: { aiCode, aiStatus: 0 } })
}

describe('错误码提取', () => {
  it('优先读 data.aiCode', () => {
    expect(aiErrorCodeOfRaw(rpcError('boom', 'TIMEOUT'))).toBe('TIMEOUT')
  })

  it('IPC 场景读 message 的 [CODE] 前缀', () => {
    expect(aiErrorCodeOfRaw(new Error('[CANCELLED] 请求已取消'))).toBe('CANCELLED')
    expect(codeFromMessage('[RATE_LIMIT] 请求过于频繁')).toBe('RATE_LIMIT')
  })

  it('普通方括号文本/未知码不误判', () => {
    expect(codeFromMessage('[FOO] 普通日志')).toBeUndefined()
    expect(aiErrorCodeOfRaw(new Error('请求超时'))).toBeUndefined()
    expect(aiErrorCodeOfRaw(undefined)).toBeUndefined()
  })

  it('展示前去掉稳定码前缀，未知前缀保留原样', () => {
    expect(stripAiErrorCodePrefix('[TIMEOUT] 请求超时')).toBe('请求超时')
    expect(stripAiErrorCodePrefix('[FOO] 日志')).toBe('[FOO] 日志')
  })
})

describe('AI 顾问：码优先分类', () => {
  it('有码时不看文案：data.aiCode=TIMEOUT 即使文案是 boom 也归为超时', () => {
    const info = classifyAiError(rpcError('boom', 'TIMEOUT'))
    expect(info.kind).toBe('timeout')
    expect(info.detail).toBe('boom')
  })

  it('CANCELLED 码归为取消，且不残留码前缀', () => {
    const info = classifyAiError(new Error('[CANCELLED] 请求已取消'))
    expect(info.kind).toBe('cancelled')
    expect(info.detail).toBe('请求已取消')
  })

  it('无码时文案规则兜底（兼容旧内核）', () => {
    expect(classifyAiError(new Error('请求超时')).kind).toBe('timeout')
    expect(classifyAiError(new Error('接口返回 401 unauthorized')).kind).toBe('auth')
  })

  it('未知错误仍是 unknown 且默认可重试', () => {
    const info = classifyAiError(new Error('完全没见过的错误'))
    expect(info.kind).toBe('unknown')
    expect(info.retryable).toBe(true)
  })
})

describe('工坊：码优先分类', () => {
  it('AUTH 码 → auth（不依赖文案）', () => {
    const failure = classifyWorkshopFailure(rpcError('whatever', 'AUTH'))
    expect(failure.kind).toBe('auth')
    expect(failure.retryable).toBe(false)
  })

  it('CANCELLED 码 → cancelled，不展示技术细节', () => {
    const failure = classifyWorkshopFailure(rpcError('aborted', 'CANCELLED'))
    expect(failure.kind).toBe('cancelled')
    expect(failure.detail).toBe('')
  })

  it('TIMEOUT / INVALID_RESPONSE 码映射到对应分类', () => {
    expect(classifyWorkshopFailure(rpcError('x', 'TIMEOUT')).kind).toBe('timeout')
    expect(classifyWorkshopFailure(rpcError('x', 'INVALID_RESPONSE')).kind).toBe('invalid-json')
  })

  it('无码时文案规则兜底', () => {
    expect(classifyWorkshopFailure(new Error('输出被截断（length）')).kind).toBe('truncated')
    expect(classifyWorkshopFailure(new Error('插件代码未通过静态校验')).kind).toBe('validation')
  })
})

describe('RPC 错误序列化', () => {
  it('AiError：码写进 message 前缀与 data.aiCode', () => {
    const payload = serializeRpcError({ name: 'AiError', code: 'TIMEOUT', status: 0, message: '请求超时（超过 1000 ms）' }, -32603)
    expect(payload.message).toBe('[TIMEOUT] 请求超时（超过 1000 ms）')
    expect(payload.data).toEqual({ aiCode: 'TIMEOUT', aiStatus: 0 })
    expect(payload.code).toBe(-32603)
  })

  it('普通错误不加前缀、不伪造 data', () => {
    const payload = serializeRpcError(new Error('插件加载失败'), -32603)
    expect(payload.message).toBe('插件加载失败')
    expect(payload.data).toBeUndefined()
  })

  it('已有数字 code 时保留（不被 fallback 覆盖）', () => {
    const error = Object.assign(new Error('x'), { code: -32001 })
    expect(serializeRpcError(error, -32603).code).toBe(-32001)
  })
})
