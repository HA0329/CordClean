/** 日志级别（与 Cordis logger 保持一致） */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** 一条结构化日志（JSONL 文件中的一行，也是界面/实时通道的数据结构） */
export interface LogEntry {
  /** ISO 时间戳 */
  ts: string
  level: LogLevel
  /** 来源：rpc / app / scan / clean / 插件名 / kernel */
  scope: string
  message: string
  /** 结构化附加字段（已脱敏、已截断） */
  fields?: Record<string, unknown>
  /** 同一次 RPC 请求的关联 ID */
  requestId?: string
  /** 插件来源（插件日志自动填插件名） */
  pluginId?: string
}

/** 日志相关设置（可在界面运行时调整） */
export interface LoggingSettings {
  /** 文件/界面最低级别：debug 最详细，error 最安静 */
  level: LogLevel
  /** 单文件上限（字节） */
  maxBytes: number
  /** 轮转保留份数 */
  keep: number
  /** 旧日志/旧 app-*.log 保留天数；0 表示不自动清理 */
  retainDays: number
}
