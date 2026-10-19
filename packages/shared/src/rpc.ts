/**
 * 传输层协议：JSON-RPC 2.0 的一个小子集。
 *
 * Web 外壳（WebSocket）与桌面外壳（Electron IPC）复用**同一套报文格式**，
 * 因此界面层完全不感知自己运行在浏览器还是 Electron 中 ——
 * 这正是「内核与界面解耦、外壳可替换」的实现基础。
 */
import type {
  CleanReport,
  EgressRecord,
  HistoryEntry,
  PluginInfo,
  QuarantineRecord,
  ScanReport,
  Settings,
  SystemInfo,
  AiAnalysis,
  AiRuleSuggestion,
  AiModelInfo,
  AiProbeResult,
  AiRuntimeStatus,
} from './index.ts'
import type { CleanProgressEvent, ScanProgressEvent, TaskDescriptor } from './task.ts'

export type RpcId = number | string

export interface RpcRequest<P = unknown> {
  jsonrpc: '2.0'
  id: RpcId
  method: string
  params?: P
}

export interface RpcSuccess<R = unknown> {
  jsonrpc: '2.0'
  id: RpcId
  result: R
}

export interface RpcFailure {
  jsonrpc: '2.0'
  id: RpcId
  error: { code: number; message: string; data?: unknown }
}

/** 服务端 → 客户端的事件通知（无 id） */
export interface RpcNotification<P = unknown> {
  jsonrpc: '2.0'
  method: string
  params: P
}

export type RpcResponse = RpcSuccess | RpcFailure
export type RpcMessage = RpcResponse | RpcNotification

export const RPC_ERRORS = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  UNAUTHORIZED: -32001,
} as const

/** 服务端事件名（与内核事件一一对应） */
export type ServerEventMap = {
  'scan/progress': ScanProgressEvent
  'scan/done': ScanReport
  'clean/progress': CleanProgressEvent
  'clean/done': CleanReport
  'plugins/changed': Record<string, never>
  'history/changed': Record<string, never>
  'scheduler/scan': { at: number; items?: number; bytes?: number; elapsedMs?: number; errors?: number; error?: string; blocked?: boolean; reason?: string; autoCleaned?: boolean; cleaned?: number; freedBytes?: number; recycledBytes?: number; mode?: string }
  log: { level: string; message: string; time: number; name?: string }
}

/** 方法参数 / 返回值类型表（客户端与服务端共用，保证类型安全） */
export interface ApiMap {
  'app/info': { params: void; result: AppInfo }
  'app/open-path': { params: { path: string }; result: void }
  'app/logs/recent': { params: { limit?: number }; result: { lines: string[] } }
  'app/logs/open': { params: void; result: void }
  'app/logs/export': { params: void; result: { path: string } }
  'app/quit': { params: void; result: { ok: true } }
  'app/open-data-dir': { params: void; result: string }

  'system/info': { params: void; result: SystemInfo }
  'system/hotspots': { params: void; result: Array<{ label: string; path: string; bytes: number }> }

  'tasks/list': { params: void; result: TaskDescriptor[] }

  'scan/start': { params: { taskIds?: string[] }; result: ScanReport }
  'scan/cancel': { params: { scanId?: string }; result: void }
  'scan/last': { params: void; result: ScanReport | null }

  'clean/undo-state': { params: void; result: { available: boolean; at?: number; quarantine: number; recycle: number; permanent: number } }
  'clean/undo': { params: void; result: { restored: number; recyclePending: number; permanent: number; failed: number } }
  'clean/start': {
    params: { itemIds?: string[]; items?: CleanItemRef[]; dryRun?: boolean; forceQuarantine?: boolean }
    result: CleanReport
  }
  'clean/cancel': { params: { sessionId?: string }; result: void }

  'plugins/source': { params: { id: string }; result: { path: string } }
  'app/open-editor': { params: { path: string }; result: void }
  'scheduler/authorize': { params: { everyMinutes?: number; taskIds?: string[] }; result: { hash: string } }
  'scheduler/run': { params: void; result: { ok: true } }
  'scheduler/revoke': { params: void; result: { ok: true } }
  'plugins/install': { params: { path: string }; result: void }
  'plugins/uninstall': { params: { id: string }; result: void }
  'plugins/list': { params: void; result: PluginRuntime[] }
  'plugins/enable': { params: { id: string }; result: void }
  'plugins/disable': { params: { id: string }; result: void }
  'plugins/reload': { params: { id: string }; result: void }
  'plugins/config': { params: { id: string; config: Record<string, unknown> }; result: void }
  'plugins/defaults': { params: { id: string }; result: Record<string, unknown> }

  'settings/get': { params: void; result: Settings }
  'settings/patch': { params: { patch: Record<string, unknown> }; result: Settings }
  'settings/set': { params: { path: string; value: unknown }; result: Settings }

  'history/list': { params: { limit?: number }; result: HistoryEntry[] }
  'history/totals': { params: void; result: { sessions: number; freedBytes: number; cleaned: number } }
  'history/clear': { params: void; result: void }

  'quarantine/list': { params: void; result: QuarantineRecord[] }
  'quarantine/restore': { params: { ids: string[] }; result: { restored: number; failed: Array<{ id: string; message: string }> } }
  'quarantine/purge': { params: { ids?: string[] }; result: number }
  'quarantine/stats': { params: void; result: { count: number; bytes: number } }

  'ai/analyze': { params: { taskIds?: string[]; extraContext?: string; contextProviders?: string[] }; result: AiAnalysis }
  'ai/last': { params: void; result: AiAnalysis | null }
  'ai/status': { params: void; result: AiRuntimeStatus }
  'ai/models': { params: { refresh?: boolean }; result: { source: 'remote' | 'fallback'; models: AiModelInfo[] } }
  'ai/probe': { params: void; result: AiProbeResult }
  'ai/plugin/draft': { params: { requirement: string }; result: { name: string; code: string; notes: string } }
  'ai/plugin/validate': { params: { code: string }; result: { ok: boolean; errors: string[]; warnings: string[] } }
  'ai/plugin/install': { params: { name: string; code: string }; result: { path: string; id: string } }
  'ai/rules/dry-run': {
    params: { suggestion: AiRuleSuggestion }
    result: { ok: boolean; reason?: string; count: number; bytes: number; samples: Array<{ path: string; bytes: number; kind: string }>; missing: string[] }
  }
  'ai/apply-rule': { params: { suggestion: AiRuleSuggestion }; result: { applied: boolean; ruleId?: string; reason?: string } }
  'ai/egress': { params: { limit?: number }; result: { stats: { requests: number; bytes: number; tokens: number }; records: EgressRecord[] } }
  'ai/egress/clear': { params: void; result: { ok: true } }
}

/** 清理项引用（界面回传选中项时使用的精简结构） */
export interface CleanItemRef {
  id: string
  taskId: string
  path: string
  kind: CleanItemRefKind
  size: number
  risk: 'safe' | 'caution' | 'risky'
  category: string
  title: string
  note?: string
  meta?: Record<string, unknown>
}

export type CleanItemRefKind = 'file' | 'directory' | 'registry' | 'command' | 'entry'

export const PROTOCOL_VERSION = 1

export interface AppInfo {
  name: string
  version: string
  node: string
  platform: string
  electron?: string
  /** 数据目录 */
  dataDir: string
  /** 是否管理员权限 */
  elevated: boolean
  /** 内核启动耗时（毫秒） */
  bootMs: number
  protocolVersion: number
}

/** 插件运行时信息（提供给界面） */
export interface PluginRuntime extends PluginInfo {
  errorStack?: string
  config: Record<string, unknown>
  configurable: boolean
}

export type ApiMethod = keyof ApiMap

export type ApiParams<M extends ApiMethod> = ApiMap[M]['params']
export type ApiResult<M extends ApiMethod> = ApiMap[M]['result']

/** 事件名 */
export type ServerEvent = keyof ServerEventMap

/** 客户端传输层接口 */
export interface RpcTransport {
  request<M extends ApiMethod>(method: M, params: ApiParams<M>): Promise<ApiResult<M>>
  on<E extends ServerEvent>(event: E, listener: (payload: ServerEventMap[E]) => void): () => void
  /** 连接是否就绪 */
  readonly ready: boolean
  close(): void
}

/** 统一的 RpcError */
export class RpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message)
    this.name = 'RpcError'
  }
}
