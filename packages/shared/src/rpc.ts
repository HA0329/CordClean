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
  SystemLiveInfo,
  AiAnalysis,
  AiPluginDraft,
  AiPluginFile,
  AiRuleSuggestion,
  AiModelInfo,
  AiProbeResult,
  AiRuntimeStatus,
  AiWorkshopStatus,
  UiContributionEntry,
  PluginManifest,
  PluginManifestIssue,
  PluginPackageIssue,
  PluginPackageReview,
  PluginPermissions,
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
  'plugin/ui-event': import('./plugin-api.ts').PluginUiEvent
  'plugin/notify': import('./plugin-api.ts').PluginNotifyEvent
  'ai/stream': { kind: 'delta' | 'done'; text?: string; reasoning?: string }
  'scheduler/scan': { at: number; items?: number; bytes?: number; elapsedMs?: number; errors?: number; error?: string; blocked?: boolean; reason?: string; autoCleaned?: boolean; cleaned?: number; freedBytes?: number; recycledBytes?: number; mode?: string }
  log: { level: string; message: string; time: number; name?: string }
}

/** 方法参数 / 返回值类型表（客户端与服务端共用，保证类型安全） */
export interface ApiMap {
  'app/info': { params: void; result: AppInfo }
  'app/open-path': { params: { path: string }; result: void }
  'app/logs/info': { params: void; result: { file: string; bytes: number } }
  'app/logs/recent': { params: { limit?: number }; result: { lines: string[] } }
  'app/logs/open': { params: void; result: void }
  'app/logs/export': { params: void; result: { path: string } }
  'app/quit': { params: void; result: { ok: true } }
  'app/open-data-dir': { params: void; result: string }

  'system/info': { params: void; result: SystemInfo }
  'system/live': { params: void; result: SystemLiveInfo }
  'system/hotspots': { params: void; result: Array<{ label: string; path: string; bytes: number }> }

  'tasks/list': { params: void; result: TaskDescriptor[] }

  'scan/start': { params: { taskIds?: string[] }; result: ScanReport }
  'scan/cancel': { params: { scanId?: string }; result: void }
  'scan/last': { params: void; result: ScanReport | null }

  'files/move': { params: { paths: string[]; targetDir: string; link?: boolean }; result: { moved: Array<{ from: string; to: string; bytes: number }>; failed: Array<{ path: string; error: string }>; freedBytes: number } }
  'clean/undo-state': { params: void; result: { available: boolean; at?: number; quarantine: number; recycle: number; permanent: number } }
  'clean/undo': { params: void; result: { restored: number; recyclePending: number; permanent: number; failed: number } }
  'clean/start': {
    params: { itemIds?: string[]; dryRun?: boolean; forceQuarantine?: boolean }
    result: CleanReport
  }
  'clean/cancel': { params: { sessionId?: string }; result: void }

  'plugins/source': { params: { id: string }; result: { path: string } }
  /** 读取插件源码文件内容（内置源码查看器；最多 512 KB） */
  'plugins/source-content': {
    params: { id: string }
    result: { path: string; content: string; bytes: number; truncated: boolean }
  }
  'app/open-editor': { params: { path: string }; result: void }
  'scheduler/authorize': { params: { planId?: string; everyMinutes?: number; taskIds?: string[] }; result: { hash: string } }
  'scheduler/run': { params: { planId?: string }; result: { ok: true } }
  'scheduler/revoke': { params: { planId?: string }; result: { ok: true } }
  'plugins/install': { params: { path: string; allowCustomClean?: boolean }; result: void }
  'plugins/install-native': { params: { path: string }; result: { id: string } }
  'ui/contributions': { params: void; result: UiContributionEntry[] }
  'ui/resolve': { params: { pluginId: string; id: string; params?: Record<string, unknown> }; result: unknown }
  'ui/command': { params: { pluginId: string; id: string; params?: Record<string, unknown> }; result: unknown }
  'plugins/uninstall': { params: { id: string }; result: void }
  'plugins/list': { params: void; result: PluginRuntime[] }
  'plugins/enable': { params: { id: string }; result: void }
  'plugins/disable': { params: { id: string }; result: void }
  'plugins/reload': { params: { id: string }; result: void }
  'plugins/config': { params: { id: string; config: Record<string, unknown> }; result: void }
  'plugins/defaults': { params: { id: string }; result: Record<string, unknown> }
  /** v2 插件包：检查目录（不落盘），返回清单/权限/警告/错误供用户审阅 */
  'plugins/inspect-package': { params: { path: string }; result: PluginPackageReview }
  /** v2 插件包：审阅通过后安装（stage → commit → 登记 → 可选启用） */
  'plugins/install-package': {
    params: { path: string; enable?: boolean; upgrade?: boolean }
    result: { id: string; manifest: PluginManifest; warnings: PluginManifestIssue[] }
  }
  /** v2 插件包：卸载（目录移入 .trash） */
  'plugins/uninstall-package': { params: { id: string }; result: void }
  /** 启动扫描发现的插件包问题 */
  'plugins/package-problems': { params: void; result: PluginPackageIssue[] }
  /** v2 插件包客户端页面 URL（Web 走同源静态路由，Electron 走 cordclean-plugin:// 协议） */
  'plugins/client-url': { params: { id: string }; result: { url: string; entry: string } }

  'settings/get': { params: void; result: Settings }
  'settings/patch': { params: { patch: Record<string, unknown> }; result: Settings }
  'settings/set': { params: { path: string; value: unknown }; result: Settings }

  'history/sessions': { params: void; result: Array<{ sessionId: string; startedAt: number; status: string; taskIds: string[] }> }
  'history/list': { params: { limit?: number }; result: HistoryEntry[] }
  'history/totals': { params: void; result: { sessions: number; freedBytes: number; cleaned: number } }
  'history/clear': { params: void; result: void }

  'quarantine/list': { params: void; result: QuarantineRecord[] }
  'quarantine/restore': { params: { ids: string[] }; result: { restored: number; failed: Array<{ id: string; message: string }> } }
  'quarantine/purge': { params: { ids?: string[] }; result: number }
  'quarantine/stats': { params: void; result: { count: number; bytes: number } }

  'ai/cancel': { params: void; result: void }
  'ai/analyze': { params: { taskIds?: string[]; extraContext?: string; contextProviders?: string[]; image?: { mime: string; data: string } }; result: AiAnalysis }
  'ai/last': { params: void; result: AiAnalysis | null }
  'ai/status': { params: void; result: AiRuntimeStatus }
  'ai/models': { params: { refresh?: boolean }; result: { source: 'remote' | 'fallback'; models: AiModelInfo[] } }
  'ai/probe': { params: void; result: AiProbeResult }
  'ai/plugin/draft': { params: { requirement: string }; result: AiPluginDraft }
  /** AI 插件工坊（独立插件）运行时状态 */
  'ai/workshop/status': { params: void; result: AiWorkshopStatus }
  /** AI 插件工坊生成 v2 插件包草稿（走独立的 ai-workshop 插件） */
  'ai/workshop/draft': { params: { requirement: string }; result: AiPluginDraft }
  /** AI 插件工坊自己的模型列表（独立接口配置） */
  'ai/workshop/models': { params: { refresh?: boolean }; result: { source: 'remote' | 'fallback'; models: AiModelInfo[] } }
  'ai/plugin/validate': {
    params: {
      code: string
      dependencies?: Record<string, string>
      native?: boolean
      format?: 'single-file' | 'package'
      manifest?: PluginManifest
      files?: AiPluginFile[]
    }
    result: { ok: boolean; errors: string[]; warnings: string[] }
  }
  'ai/plugin/install': {
    params: {
      name: string
      code: string
      dependencies?: Record<string, string>
      acknowledgeDependencies?: boolean
      acknowledgePermissions?: boolean
      native?: boolean
      format?: 'single-file' | 'package'
      manifest?: PluginManifest
      files?: AiPluginFile[]
    }
    result: { path: string; id: string; manifest?: PluginManifest }
  }
  'ai/rules/dry-run': {
    params: { suggestion: AiRuleSuggestion }
    result: { ok: boolean; reason?: string; count: number; bytes: number; samples: Array<{ path: string; bytes: number; kind: string }>; missing: string[] }
  }
  'ai/apply-rule': { params: { suggestion: AiRuleSuggestion }; result: { applied: boolean; ruleId?: string; reason?: string } }
  'ai/egress': { params: { limit?: number }; result: { stats: { requests: number; bytes: number; tokens: number }; records: EgressRecord[] } }
  'ai/egress/clear': { params: void; result: { ok: true } }
}

export const PROTOCOL_VERSION = 1

export interface AppInfo {
  name: string
  version: string
  /** 当前进程实际使用的 Node 版本（Electron 外壳下是 Electron 内置 Node） */
  node: string
  /** electron=Electron 内置 Node；node=独立 Node 进程 */
  nodeRuntime?: 'electron' | 'node'
  /** 系统 PATH 中的 Node（桌面外壳下与内置 Node 可能不同） */
  systemNode?: string
  platform: string
  /** 给界面显示的短平台名，例如 Windows 11 */
  platformLabel?: string
  osRelease?: string
  osVersion?: string
  arch?: string
  electron?: string
  /** desktop=Electron IPC；web=HTTP+WebSocket */
  shell?: 'desktop' | 'web'
  /** 数据目录 */
  dataDir: string
  /** 是否管理员权限（Windows 依据 Mandatory Label，不是简单文件可写探测） */
  elevated: boolean
  /** 权限检测时间（毫秒时间戳） */
  elevatedCheckedAt?: number
  /** 内核启动耗时（毫秒） */
  bootMs: number
  protocolVersion: number
}

/** 插件运行时信息（提供给界面） */
export interface PluginRuntime extends PluginInfo {
  errorStack?: string
  config: Record<string, unknown>
  configurable: boolean
  /** v2 插件包的清单（外部包插件才有） */
  manifest?: PluginManifest
  /** v2 插件包的权限声明（外部包插件才有） */
  permissions?: PluginPermissions
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
