/**
 * 清理任务契约（插件 ⇄ 内核）。
 *
 * 一个「清理插件」通过 `ctx.cleaner.define(task)` 注册一个或多个 `TaskDefinition`。
 * 内核负责：并发调度、进度聚合、去重、路径策略校验、隔离区、历史记录与事件广播；
 * 插件只需实现「如何找出可清理项」以及（可选）「如何清理」。
 */
import type {
  CategoryId,
  CleanItem,
  CleanItemDraft,
  CleanItemResult,
  RiskLevel,
  ScanError,
} from './index.ts'

/** 任务可用的环境信息（由内核注入，避免插件直接依赖 process） */
export interface TaskEnv {
  platform: NodeJS.Platform
  arch: string
  /** 是否以管理员权限运行 */
  elevated: boolean
  /** 当前用户名 */
  username: string
  /** 系统盘符，如 `C:` */
  systemDrive: string
  windowsDir: string
  programFiles: string
  programFilesX86: string
  programData: string
  appData: string
  localAppData: string
  userProfile: string
  /** 应用自身的数据目录 */
  dataDir: string
  /** 当前存在的固定磁盘盘符，如 `['C:', 'D:']` */
  drives: string[]
  /** 只读环境变量访问器 */
  get(name: string): string | undefined
}

/** 插件可用的最小日志接口（避免插件直接依赖 Cordis 的 logger） */
export interface TaskLogger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/** 路径策略检查结果 */
export interface PathPolicyCheck {
  allowed: boolean
  reason?: 'protected' | 'outside' | 'reparse' | 'name-denied'
  detail?: string
}

/** 路径策略服务的最小接口（内核实现，插件只读使用） */
export interface PathPolicyLike {
  check(path: string): PathPolicyCheck
  isProtected(path: string): boolean
  /** 当前允许的清理根目录（用于提示） */
  roots(): string[]
  /** 目录是否包含受保护子目录（删除目录前必须为 false） */
  containsProtected(path: string): boolean
  /** 路径命中的允许根（用于删除前检查链接祖先） */
  rootOf(path: string): string | undefined
  /**
   * 清空白名单校验：允许清空受保护目录的内容，但不删除目录本身。
   * 对应规则里的 action=clear（如 C:\Windows\System32\LogFiles）。
   */
  checkClear(path: string): PathPolicyCheck
}

/** 扫描上下文 */
export interface TaskScanContext {
  readonly signal: AbortSignal
  readonly config: Record<string, any>
  readonly logger: TaskLogger
  readonly pathPolicy: PathPolicyLike
  readonly env: TaskEnv
  /** 流式上报一个清理项（引擎会自动补全 id / category / risk 等字段） */
  emit(draft: CleanItemDraft): void
  /** 仅累计统计，不产出清理项（例如扫描到但不建议清理的大量文件） */
  count(kind: 'file' | 'directory', bytes?: number): void
  /** 记录一个非致命错误（权限不足、文件被占用等） */
  addError(error: { path: string; message: string; code?: string }): void
  /** 主动检查取消信号，已取消时抛出异常终止扫描 */
  throwIfAborted(): void
}

/** 清理上下文 */
export interface TaskCleanContext {
  readonly signal: AbortSignal
  readonly logger: TaskLogger
  readonly env: TaskEnv
  readonly pathPolicy: PathPolicyLike
  readonly dryRun: boolean
  /** 通用文件任务：删除还是移入隔离区 */
  readonly mode: 'delete' | 'quarantine'
  /** 本次清理会话的隔离目录（mode 为 quarantine 时存在） */
  readonly quarantineDir?: string
  throwIfAborted(): void
}

/** 任务定义：插件向内核注册的能力单元 */
export interface TaskDefinition<TConfig extends Record<string, any> = Record<string, any>> {
  /** 全局唯一 id，建议与插件 id 前缀一致，如 `temp`、`browser-cache` */
  id: string
  /** 展示名称 */
  name: string
  /** 一句话描述 */
  description?: string
  category: CategoryId
  /** 默认风险等级；单项可通过 draft.risk 覆盖 */
  risk: RiskLevel
  /** 界面图标（emoji 或内置图标名） */
  icon?: string
  /** 是否需要管理员权限才能完整清理 */
  requiresAdmin?: boolean
  /** 默认是否勾选 */
  defaultSelected?: boolean
  /** 展示用的扫描目标路径 */
  targets?: string[]
  /** 使用提示 */
  tips?: string[]
  /** 估算耗时（毫秒），用于界面进度提示 */
  estimatedMs?: number
  /**
   * 扫描：插件负责枚举可清理项。
   * 可通过 `ctx.emit()` 流式上报，也可以直接返回数组。
   */
  scan(ctx: TaskScanContext): Promise<CleanItemDraft[] | void> | CleanItemDraft[] | void
  /**
   * 自定义清理逻辑。缺省时内核使用通用文件删除引擎（适用于 kind 为 file/directory 的项）。
   * 适用于注册表、命令行等非文件系统对象。
   */
  clean?(items: CleanItem[], ctx: TaskCleanContext): Promise<CleanItemResult[]>
}

/** 任务静态描述（可序列化，供前端展示） */
export interface TaskDescriptor {
  id: string
  pluginId: string
  name: string
  description?: string
  category: CategoryId
  risk: RiskLevel
  icon?: string
  requiresAdmin?: boolean
  defaultSelected: boolean
  targets: string[]
  tips: string[]
  estimatedMs?: number
}

/** 扫描进度事件 */
export interface ScanProgressEvent {
  scanId: string
  taskId: string
  /** 已完成的扫描项数量 */
  items: number
  files: number
  dirs: number
  bytes: number
  /** 当前正在扫描的路径（可选） */
  current?: string
  done: boolean
}

/** 清理进度事件 */
export interface CleanProgressEvent {
  sessionId: string
  taskId: string
  total: number
  done: number
  bytes: number
  failed: number
  current?: string
  finished: boolean
}

/** 扫描错误（保留 ScanError 类型别名，方便插件书写） */
export type { ScanError }
