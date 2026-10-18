/**
 * 内核服务的「契约」定义 + Cordis Context 类型增强。
 *
 * 这些接口由 @cordclean/core 实现，但声明放在 shared 中，
 * 使得**清理插件只需依赖 @cordclean/shared**，而不必依赖内核实现包 ——
 * 这是本课题「插件与内核解耦」在工程上的具体落点：
 * 插件看到的是能力契约，不是具体实现。
 */
import type { Context } from 'cordis'
import type { CleanRule, RuleCategory, RuleIssue, RuleValidationReport } from './rules.ts'
import type {
  AiAnalysis,
  AiModelInfo,
  AiProbeResult,
  AiRuntimeStatus,
  AiSuggestion,
  CleanItem,
  CleanItemResult,
  CleanMode,
  CleanReport,
  DiskInfo,
  HistoryEntry,
  PluginInfo,
  QuarantineRecord,
  ScanReport,
  SystemInfo,
} from './index.ts'
import type {
  CleanProgressEvent,
  PathPolicyCheck,
  ScanProgressEvent,
  TaskDescriptor,
  TaskDefinition,
  TaskEnv,
} from './task.ts'

/** 全局配置结构（持久化为 JSON） */
export interface Settings {
  /** 隐私与外发 */
  /** 界面偏好 */
  privacy: {
    /** 是否允许在线 AI（总开关） */
    onlineAi: boolean
  }
  /** 隔离区设置 */
  quarantine: {
    /** 是否启用隔离区（关闭后高风险项将直接删除，仅建议高级用户关闭） */
    enabled: boolean
    /** 隔离区容量上限（字节） */
    maxBytes: number
    /** 单次会话最多隔离文件数 */
    maxFiles: number
    /** 自动清理超过 N 天的隔离文件，0 表示不自动清理 */
    retentionDays: number
  }
  /** 扫描设置 */
  scan: {
    /** 任务级并发度 */
    concurrency: number
    /** 单个任务最多产出的清理项 */
    maxItemsPerTask: number
    /** 单个任务遍历条目上限（防止全盘扫描卡死） */
    maxEntriesPerTask: number
    /** 默认最大递归深度 */
    maxDepth: number
    /** 大文件阈值（字节） */
    largeFileThreshold: number
    /** 重复文件最小体积（字节） */
    duplicateMinSize: number
    /** 重复文件最多参与哈希的候选数量 */
    duplicateMaxCandidates: number
  }
  /** 清理设置 */
  clean: {
    /** 仅预演（不真正删除） */
    dryRunDefault: boolean
    /** 高风险项需要二次确认 */
    confirmRisky: boolean
    /** 删除时忽略的错误重试次数 */
    retries: number
    /** 默认删除方式：回收站 / 隔离区 / 永久删除 */
    mode: CleanMode
    /** 高风险项强制进隔离区（不使用回收站） */
    highRiskQuarantine: boolean
    /** 回收站不可用时回落到隔离区 */
    quarantineFallback: boolean
    /** 单次清理预算 */
    budget: {
      maxFiles: number
      maxBytes: number
    }
  }
  /** 规则库设置 */
  rules: {
    /** 是否启用高风险分类（默认关闭） */
    includeRisky: boolean
    /** 是否启用深度规则 */
    includeDeep: boolean
    /** 是否加载用户自定义规则 */
    includeCustom: boolean
    /** 用户/AI 自定义规则（只有经过 importRules 管线的才允许写入） */
    custom: Array<Record<string, any>>
  }
  /** 分析范围 */
  analysis: {
    /** 用户自定义扫描根目录 */
    roots: string[]
    /** 是否包含系统目录（如 Windows\Temp） */
    includeSystem: boolean
    /** 排除的路径片段（不区分大小写） */
    excludes: string[]
  }
  /** 插件配置（enabled + 插件自有配置） */
  plugins: Record<string, { enabled?: boolean; config?: Record<string, any> }>
  /** 界面设置 */
  ui: {
    theme: 'dark' | 'light'
    lastPage: string
    /** 打开源码用的编辑器命令；留空则用系统默认程序 */
    editorCommand: string
  }
  /** 版本号，用于配置迁移 */
  version: number
}

/** 扫描选项 */
export interface ScanOptions {
  /** 指定任务 id；省略表示全部任务 */
  taskIds?: string[]
  signal?: AbortSignal
  onProgress?(event: ScanProgressEvent): void
}

/** 清理选项 */
export interface CleanOptions {
  /** 直接给出清理项（通常来自上一次扫描结果） */
  items?: CleanItem[]
  /** 或给出清理项 id，由内核从最近一次扫描结果中解析 */
  itemIds?: string[]
  /** 限定任务 id */
  taskIds?: string[]
  dryRun?: boolean
  /** 强制走隔离区 */
  forceQuarantine?: boolean
  signal?: AbortSignal
  onProgress?(event: CleanProgressEvent): void
}

/** 清理引擎能力（`ctx.cleaner`） */
export interface CleanerLike {
  /** 注册一个清理任务，返回注销函数（建议配合 ctx.effect 使用） */
  define(task: TaskDefinition, pluginId?: string): () => void
  /** 当前已注册任务 */
  list(): TaskDescriptor[]
  /** 执行扫描 */
  scan(options?: ScanOptions): Promise<ScanReport>
  /** 执行清理 */
  clean(options?: CleanOptions): Promise<CleanReport>
  /** 最近一次扫描结果（供 UI 解析 itemIds） */
  lastScan(): ScanReport | undefined
  /** 取消当前扫描 */
  cancelScan(): void
  /** 取消当前清理 */
  cancelClean(): void
}

/** 设置服务能力（`ctx.settings`） */
export interface SettingsLike {
  get(): Settings
  /** 以点号路径写入，如 `set('scan.concurrency', 4)` */
  set(path: string, value: unknown): void
  /** 批量合并（深合并） */
  patch(patch: DeepPartial<Settings>): void
  /** 订阅变更，返回取消订阅函数 */
  onChange(listener: (settings: Settings) => void): () => void
  /** 配置文件路径 */
  file: string
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? (T[K] extends Array<infer U> ? U[] : DeepPartial<T[K]>) : T[K]
}

/** 一次清理会话对应的隔离区（可写入） */
export interface QuarantineSessionLike {
  readonly id: string
  readonly dir: string
  readonly moved: number
  readonly bytes: number
  move(source: string, taskId: string, expectedBytes?: number): Promise<QuarantineRecord>
  close(): Promise<void>
}

/** 隔离区能力（`ctx.quarantine`） */
export interface QuarantineLike {
  directory: string
  /** 列出未恢复的隔离项 */
  list(): Promise<QuarantineRecord[]>
  /** 恢复隔离项到原路径 */
  restore(ids: string[]): Promise<{ restored: number; failed: Array<{ id: string; message: string }> }>
  /** 彻底删除隔离项 */
  purge(ids?: string[]): Promise<number>
  /** 统计 */
  stats(): Promise<{ count: number; bytes: number }>
  /** 开启一个隔离会话 */
  beginSession(sessionId: string): QuarantineSessionLike
  /** 清理超过保留期的隔离文件 */
  purgeExpired(): Promise<number>
}

/** 历史记录能力（`ctx.history`） */
export interface HistoryLike {
  append(entry: HistoryEntry): void
  list(limit?: number): HistoryEntry[]
  totals(): { sessions: number; freedBytes: number; cleaned: number }
  clear(): void
}

/** 系统信息能力（`ctx.system`） */
export interface SystemLike {
  readonly env: TaskEnv
  info(): Promise<SystemInfo>
  disks(): Promise<DiskInfo[]>
  /** 关键目录占用 */
  hotspots(): Promise<Array<{ label: string; path: string; bytes: number }>>
}

/** 插件运行时描述（内核记录） */
export interface PluginRuntimeInfo extends PluginInfo {
  /** 插件的错误堆栈（若失败） */
  errorStack?: string
  /** 插件当前配置 */
  config: Record<string, any>
  /** 是否有可配置项 */
  configurable: boolean
}

/** 插件管理能力（`ctx.plugins`） */
export interface PluginManagerLike {
  list(): PluginRuntimeInfo[]
  enable(id: string): Promise<void>
  disable(id: string): Promise<void>
  reload(id: string): Promise<void>
  /** 插件源码文件/目录路径（内置或外部） */
  sourcePath(id: string): string | undefined
  /** 安装本地插件文件（.mjs/.js），会话内有效 */
  installExternal(filePath: string): Promise<void>
  /** 卸载外部插件（内置插件只能停用） */
  uninstallExternal(id: string): Promise<void>
  updateConfig(id: string, config: Record<string, any>): Promise<void>
  /** 获取插件默认配置（用于界面渲染） */
  defaults(id: string): Promise<Record<string, any>>
  /** 启动时加载全部已启用插件 */
  loadAll(): Promise<void>
}

/**
 * AI 能力（由 ai 插件注册，其它模块可选依赖）。
 *
 * 设计上刻意把「接口形态」「模型」「推理等级」都做成运行时可变的状态：
 * 模型列表从 `/models` 动态获取，请求体可通过 `extraBody` 任意扩展，
 * 因此厂商调整参数（如新增推理等级、新增接口形态）时，
 * 用户改配置即可适配，不需要重新编译插件。
 */
export interface AiLike {
  analyze(options?: { taskIds?: string[]; extraContext?: string }): Promise<AiAnalysis>
  last(): AiAnalysis | undefined
  configured(): boolean
  /** 拉取可用模型列表（失败时返回内置兜底列表） */
  models(options?: { refresh?: boolean }): Promise<{ source: 'remote' | 'fallback'; models: AiModelInfo[] }>
  /** 连通性探测：发一条最小请求，验证 Key / 地址 / 模型 / 参数是否可用 */
  probe(): Promise<AiProbeResult>
  /** 当前运行时状态（供界面展示与配置界面回填） */
  status(): AiRuntimeStatus
}

/** AI 上下文段落（脱敏摘要） */
export interface AiContextSection {
  id: string
  title: string
  lines: string[]
}

export interface AiContextProviderInfo {
  id: string
  name: string
  description?: string
  defaultEnabled: boolean
}

/** AI 上下文采集器服务（`ctx.aiContext`） */
export interface AiContextLike {
  addProvider(provider: {
    id: string
    name: string
    description?: string
    defaultEnabled?: boolean
    collect(ctx: unknown): AiContextSection | Promise<AiContextSection>
  }): () => void
  list(): AiContextProviderInfo[]
  collect(enabled?: string[]): Promise<AiContextSection[]>
}

/** AI 上下文段落（脱敏摘要） */
declare module 'cordis' {
  interface Context {
    /** AI 上下文采集器 */
    aiContext: AiContextLike
  }
}
declare module 'cordis' {
  interface Context {
    cleaner: CleanerLike
    /** 规则注册表：插件登记清理规则，卸载时自动注销 */
    rules: RulesLike
    /** 规则评估器：可为每条候选给出建议与风险（可替换实现） */
    evaluator: EvaluatorLike
    settings: SettingsLike
    pathPolicy: {
      check(path: string): PathPolicyCheck
      isProtected(path: string): boolean
      roots(): string[]
      /** 判断某目录是否包含受保护子目录（删除该目录前必须检查） */
      containsProtected(path: string): boolean
      /** 找出路径命中的允许根（用于删除前检查链接祖先） */
      rootOf(path: string): string | undefined
      /** 清空白名单：允许清空受保护目录的内容（不删除目录本身） */
      checkClear(path: string): PathPolicyCheck
      /** 登记清空白名单（插件在 apply 阶段调用，卸载即撤销） */
      addClearRoot(path: string, source?: string): () => void
      addRoot(path: string, source?: string): () => void
      addUserRoot(path: string): () => void
    }
    quarantine: QuarantineLike
    /** 回收站（批量、逐项回执） */
    recycleBin: RecycleLike
    /** 补偿链（签发删除令牌） */
    compensate: CompensateLike
    /** 唯一删除入口（只接受补偿链令牌） */
    executor: ExecutorLike
    history: HistoryLike
    system: SystemLike
    plugins: PluginManagerLike
    /** 由 AI 插件提供，未安装时不可用 */
    ai?: AiLike
    /** 外发出口（不变量 8）：在线请求统一放行、计数与预览 */
    egress: EgressLike
  }

  interface Events {
    'rules/changed'(): void
    'cleaner/scan-progress'(event: ScanProgressEvent): void
    'cleaner/scan-done'(report: ScanReport): void
    'cleaner/clean-progress'(event: CleanProgressEvent): void
    'cleaner/clean-done'(report: CleanReport): void
    'plugins/changed'(): void
    'history/changed'(): void
    'system/log'(entry: { level: string; message: string; time: number; name?: string }): void
  }
}

/** 插件模块导出形状（清理插件的标准写法） */
export interface CleanerPluginModule<TConfig = any> {
  name: string
  version?: string
  description?: string
  /** 插件声明的清理任务 id（可选，仅用于界面展示） */
  tasks?: string[]
  Config?: any
  inject?: string[]
  /** 返回值会交给 Cordis 处理：返回 Promise 时其拒绝会使插件进入 error 状态 */
  apply(ctx: Context, config: TConfig): void | Promise<void>
}

/** 定义清理插件的参数 */
export interface CleanerPluginOptions<TConfig = any> {
  name: string
  version?: string
  description?: string
  tasks?: string[]
  /** 依赖的内核服务，例如 ['cleaner', 'pathPolicy'] */
  inject?: string[]
  /** Schemastery 配置模式，用于配置校验与「设置」界面自动生成 */
  Config?: any
  /** 插件主体：在这里注册清理任务、声明清理辖区（允许 async，异常会被内核捕获为 error 状态） */
  setup(ctx: Context, config: TConfig): void | Promise<void>
}

/**
 * 定义一个清理插件（所有官方插件的统一入口）。
 *
 * ```ts
 * export default defineCleanerPlugin({
 *   name: 'temp',
 *   inject: ['cleaner', 'pathPolicy'],
 *   Config: Schema.object({ ... }),
 *   setup(ctx, config) {
 *     ctx.effect(() => ctx.cleaner.define({ ... }))
 *   },
 * })
 * ```
 */
export function defineCleanerPlugin<TConfig = any>(options: CleanerPluginOptions<TConfig>): CleanerPluginModule<TConfig> {
  const plugin: CleanerPluginModule<TConfig> = {
    name: options.name,
    version: options.version ?? '1.0.0',
    description: options.description,
    tasks: options.tasks,
    Config: options.Config,
    inject: options.inject ?? ['cleaner'],
    apply(ctx, config) {
      // 必须把 setup 的返回值交还 Cordis：异步 setup 的拒绝会转变为插件启动失败，
      // 否则会变成「悬空的 Promise 拒绝」，在 Node 中可能直接终止进程。
      return options.setup(ctx, config)
    },
  }
  return plugin
}

/** 回收站能力（`ctx.recycleBin`） */
export interface RecycleLike {
  /** 该路径所在卷的回收站是否可用 */
  available(target: string): Promise<boolean>
  recycle(items: Array<{ path: string; isDirectory: boolean }>): Promise<{
    ok: string[]
    failed: Array<{ path: string; message: string }>
  }>
}

/** 补偿链能力（`ctx.compensate`） */
export interface CompensateLike {
  issue(request: { items: CleanItem[]; mode: CleanMode; signal?: AbortSignal }): Promise<any>
  recheck(item: any): Promise<{ itemId: string; path: string; reason: string; message: string } | undefined>
}

/** 执行器能力（`ctx.executor`） */
export interface ExecutorLike {
  execute(ticket: unknown, options?: any): Promise<{
    results: CleanItemResult[]
    freedBytes: number
    recycledBytes: number
    quarantinedBytes: number
    vanished: number
    skipped: number
    failed: number
  }>
}

/** 规则注册表能力（`ctx.rules`） */
export interface RulesLike {
  /** 登记规则：副作用归属调用方 scope，卸载即注销 */
  register(scope: Context, rules: CleanRule[] | CleanRule): () => void
  /** 唯一入库管线：结构 + 受保护目标校验，返回被拒绝的规则 */
  importRules(
    scope: Context,
    rules: CleanRule[],
    resolveRoots?: (rule: CleanRule) => string[],
  ): { accepted: CleanRule[]; rejected: Array<{ ruleId: string; reason: string }> }
  list(): CleanRule[]
  categories(): RuleCategory[]
  get(id: string): CleanRule | undefined
  /** 结构校验（不访问文件系统） */
  validate(rules: CleanRule[]): RuleIssue[]
  stats(): RuleValidationReport['stats']
}

/** 评估输入：一行候选 */
export interface EvalInput {
  rule: CleanRule
  path: string
  kind: 'file' | 'directory'
  size: number
  mtimeMs: number
  /** 是否被判定为受保护 */
  protected?: boolean
}

/** 评估输出 */
export interface EvalResult {
  suggest: boolean
  risk: import('./index.ts').RiskLevel
  reason: string
  /** 命中的评估策略 */
  strategy?: string
}

/** 可替换的评估策略 */
export interface EvaluatorStrategy {
  id: string
  name: string
  evaluate(inputs: EvalInput[]): Promise<EvalResult[]> | EvalResult[]
}

/** 规则评估能力（`ctx.evaluator`） */
export interface EvaluatorLike {
  evaluate(inputs: EvalInput[]): Promise<EvalResult[]>
  /** 注册评估策略（如 AI 适配器） */
  register(strategy: EvaluatorStrategy): () => void
  strategies(): string[]
  current(): string
  use(id: string): void
}

/** 外发记录（预览用，已脱敏截断） */
export interface EgressRecord {
  at: number
  purpose: string
  url: string
  bytes: number
  preview: string
  blocked?: string
}

/** 外发出口能力（`ctx.egress`） */
export interface EgressLike {
  check(request: { purpose: string; url: string; body?: unknown }): { allowed: boolean; reason?: string }
  recordUsage(usage?: { input?: number; output?: number }): void
  stats(): { requests: number; bytes: number; tokens: number }
  preview(): EgressRecord[]
  reset(): void
}

/** AI 建议的补类型导出，方便插件复用 */
export type { AiAnalysis, AiModelInfo, AiProbeResult, AiRuntimeStatus, AiSuggestion }
