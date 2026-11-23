/**
 * 概览页展示模型（纯函数，可单测）。
 *
 * 把「磁盘占用/内存/运行时长/历史摘要/可操作性判断」从模板里抽出来，
 * 让页面只负责渲染，逻辑可以脱离 DOM 单测（也方便后续换 UI/加图表）。
 */

export interface DiskLike {
  mount: string
  total: number
  free: number
  used?: number
}

export type UsageTone = 'ok' | 'warn' | 'danger'

/** 已用字节：优先用宿主给的 used，否则 total - free */
export function diskUsedBytes(disk: DiskLike): number {
  const used = typeof disk.used === 'number' ? disk.used : disk.total - disk.free
  return Math.max(0, Math.min(disk.total, Math.round(used)))
}

/** 使用率（0-100 整数，total 非法时返回 0） */
export function diskUsagePercent(disk: DiskLike): number {
  if (!Number.isFinite(disk.total) || disk.total <= 0) return 0
  const percent = Math.round((diskUsedBytes(disk) / disk.total) * 100)
  return Math.max(0, Math.min(100, percent))
}

/** 阈值：≥90% 危险、≥75% 注意，其余正常 */
export function usageTone(percent: number): UsageTone {
  if (!Number.isFinite(percent)) return 'ok'
  if (percent >= 90) return 'danger'
  if (percent >= 75) return 'warn'
  return 'ok'
}

export interface DiskSummary {
  count: number
  totalBytes: number
  freeBytes: number
  /** 使用率 ≥90% 的磁盘 */
  lowDisks: DiskLike[]
  /** 剩余空间最少的磁盘（没有磁盘时为 undefined） */
  tightest?: DiskLike
  /** 给用户看的一句话提醒（无风险时为 undefined） */
  warning?: string
}

/** 汇总磁盘：总量、可用、空间紧张的盘与最紧的盘 */
export function summarizeDisks(disks: readonly DiskLike[]): DiskSummary {
  const valid = disks.filter((disk) => Number.isFinite(disk.total) && disk.total > 0)
  const totalBytes = valid.reduce((sum, disk) => sum + disk.total, 0)
  const freeBytes = valid.reduce((sum, disk) => sum + Math.max(0, disk.free), 0)
  const lowDisks = valid.filter((disk) => diskUsagePercent(disk) >= 90)
  const tightest = valid.length
    ? valid.reduce((min, disk) => (disk.free < min.free ? disk : min))
    : undefined
  let warning: string | undefined
  if (lowDisks.length) {
    warning = `${lowDisks.map((disk) => disk.mount).join('、')} 剩余空间不足 10%，建议尽快清理`
  }
  return { count: valid.length, totalBytes, freeBytes, lowDisks, tightest, warning }
}

/** 内存使用率（total 非法时返回 0） */
export function memoryPercent(total: number, free: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0
  const used = Math.max(0, Math.min(total, total - free))
  return Math.max(0, Math.min(100, Math.round((used / total) * 100)))
}

/**
 * 运行时长 = 采集时的 uptime + 本地走时，避免每秒请求宿主。
 * 采集时间在未来（时钟回拨）时按 0 处理，不显示负数。
 */
export function liveUptimeSeconds(uptimeSeconds: number, collectedAt: number, now: number): number {
  const base = Number.isFinite(uptimeSeconds) ? Math.max(0, uptimeSeconds) : 0
  const elapsed = Number.isFinite(collectedAt) && Number.isFinite(now) ? Math.max(0, Math.floor((now - collectedAt) / 1000)) : 0
  return base + elapsed
}

export type OverviewPhase = 'loading' | 'error' | 'ready'

export interface OverviewPhaseInput {
  /** 内核连接是否就绪 */
  ready: boolean
  /** 是否已有系统数据（有缓存时出错也不该白屏） */
  hasSystem: boolean
  /** 最近一次主动刷新/采样失败的原因 */
  error?: string
}

/**
 * 页面阶段：
 * - 没有数据且还没就绪 → 骨架屏；
 * - 没有数据且出错 → 错误页（可重试）；
 * - 有数据（哪怕刷新失败）→ 正常渲染，错误通过页内提示展示，不清空用户已看到的内容。
 */
export function overviewPhase(input: OverviewPhaseInput): OverviewPhase {
  if (input.hasSystem) return 'ready'
  if (input.error) return 'error'
  if (!input.ready) return 'loading'
  return 'ready'
}

export interface ScanGateInput {
  ready: boolean
  scanning: boolean
  cleaning: boolean
}

/** 一键扫描是否可用；不可用时给出原因（按钮 tooltip/提示共用） */
export function scanGate(input: ScanGateInput): { ok: boolean; reason?: string } {
  if (!input.ready) return { ok: false, reason: '内核尚未连接，请稍候' }
  if (input.cleaning) return { ok: false, reason: '正在清理中，完成后再扫描' }
  if (input.scanning) return { ok: false, reason: '正在扫描中，请查看实时进度' }
  return { ok: true }
}

export interface HistorySummary {
  count: number
  hasHistory: boolean
  lastAt?: number
  lastFreedBytes: number
  lastCleaned: number
  lastTaskIds: string[]
}

export interface HistoryLike {
  startedAt: number
  freedBytes: number
  cleaned: number
  taskIds?: string[]
}

/** 最近清理摘要：上次时间/释放量/项目数/任务，用于空状态与表格头部 */
export function summarizeHistory(history: readonly HistoryLike[]): HistorySummary {
  if (!history.length) {
    return { count: 0, hasHistory: false, lastFreedBytes: 0, lastCleaned: 0, lastTaskIds: [] }
  }
  const last = history.reduce((latest, item) => (item.startedAt > latest.startedAt ? item : latest))
  return {
    count: history.length,
    hasHistory: true,
    lastAt: last.startedAt,
    lastFreedBytes: last.freedBytes,
    lastCleaned: last.cleaned,
    lastTaskIds: last.taskIds ?? [],
  }
}

/** 系统摘要文本（「复制摘要」按钮用，不含任何隐私路径以外的敏感信息） */
export interface SummaryInput {
  platformLabel?: string
  release?: string
  cpuModel?: string
  cpuCores?: number
  hostname?: string
  username?: string
  memoryTotal: number
  memoryFree: number
  uptimeSeconds: number
  disks: readonly DiskLike[]
  version?: string
}

export function buildSystemSummary(input: SummaryInput): string {
  const lines: string[] = ['CordClean 系统摘要']
  if (input.version) lines.push(`版本：${input.version}`)
  lines.push(`系统：${input.platformLabel ?? 'Windows'} ${input.release ?? ''}`.trim())
  if (input.cpuModel) lines.push(`处理器：${input.cpuModel}（${input.cpuCores ?? '?'} 核）`)
  if (input.hostname) lines.push(`主机名：${input.hostname}`)
  if (input.username) lines.push(`当前用户：${input.username}`)
  const memUsed = Math.max(0, input.memoryTotal - input.memoryFree)
  lines.push(`内存：已用 ${formatMb(memUsed)} / 共 ${formatMb(input.memoryTotal)}（${memoryPercent(input.memoryTotal, input.memoryFree)}%）`)
  lines.push(`运行时长：${formatHours(input.uptimeSeconds)}`)
  for (const disk of input.disks) {
    lines.push(`磁盘 ${disk.mount}：可用 ${formatMb(Math.max(0, disk.free))} / 共 ${formatMb(disk.total)}（已用 ${diskUsagePercent(disk)}%）`)
  }
  return lines.join('\n')
}

function formatMb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const mb = bytes / 1024 / 1024
  if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB'
  return Math.round(mb) + ' MB'
}

function formatHours(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (days > 0) return `${days} 天 ${hours} 小时`
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  return `${minutes} 分钟`
}
