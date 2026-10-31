/**
 * 插件 iframe 页面 bridge 兼容层。
 *
 * 新协议：{ type:'cordclean/plugin-page', method:'resolve', id, resolverId, params }
 * 旧工坊产物：{ type:'cordclean/plugin-page', action:'resolve', id, key, dataId, requestId }
 * 旧页面已经安装在用户机器上，无法要求用户重新生成；宿主在这里兼容两种请求/回包。
 */

export interface ParsedPluginPageRequest {
  legacy: boolean
  requestId: string
  resolverId: string
  params?: Record<string, unknown>
}

export function parsePluginPageRequest(data: unknown): ParsedPluginPageRequest | null {
  if (!data || typeof data !== 'object') return null
  const message = data as Record<string, unknown>
  if (message.type !== 'cordclean/plugin-page') return null
  const modern = message.method === 'resolve'
  const legacy = message.action === 'resolve'
  if (!modern && !legacy) return null
  const resolverId = String(
    (modern ? message.resolverId : (message.resolverId ?? message.dataId ?? message.key ?? message.id)) ?? '',
  )
  if (!resolverId) return null
  const requestId = String(
    (modern ? message.id : (message.requestId ?? message.requestID ?? message.reqId ?? message.id)) ?? '',
  )
  if (!requestId) return null
  const params =
    message.params && typeof message.params === 'object'
      ? (message.params as Record<string, unknown>)
      : undefined
  return { legacy, requestId, resolverId, params }
}

export function buildPluginPageResponse(
  request: ParsedPluginPageRequest,
  result: { ok: true; value: unknown } | { ok: false; error: string },
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type: 'cordclean/plugin-page-result',
    id: request.requestId,
    ok: result.ok,
    ...(result.ok ? { value: result.value } : { error: result.error }),
  }
  if (request.legacy) {
    // 旧页面按 requestId/requestID 关联；没有 requestId 时还有“唯一 pending”兜底
    base.requestId = request.requestId
    base.requestID = request.requestId
    base.replyTo = request.requestId
    base.reqId = request.requestId
  }
  return base
}
