/**
 * 清理历史服务：以 JSONL 追加写入，天然支持「只追加、按行读取」，
 * 即使进程异常退出也不会破坏已有记录。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Service, type Context } from 'cordis'
import type { CleanSessionRecord, HistoryEntry, HistoryLike } from '@cordclean/shared'

export interface HistoryConfig {
  dataDir: string
  /** 内存中保留的最近记录条数 */
  capacity?: number
}

export class HistoryService extends Service implements HistoryLike {
  readonly file: string
  readonly sessionsFile: string
  private sessionList: CleanSessionRecord[] = []
  private entries: HistoryEntry[] = []
  private capacity: number

  constructor(ctx: Context, config: HistoryConfig) {
    super(ctx, 'history')
    mkdirSync(config.dataDir, { recursive: true })
    this.file = path.join(config.dataDir, 'history.jsonl')
    this.capacity = config.capacity ?? 1000
    this.sessionsFile = path.join(config.dataDir, 'sessions.json')
    this.load()
    this.loadSessions()
  }

  /** 读取会话状态；进程重启后把残留的 running 标记为 interrupted */
  private loadSessions(): void {
    if (existsSync(this.sessionsFile)) {
      try {
        const parsed = JSON.parse(readFileSync(this.sessionsFile, 'utf8'))
        if (Array.isArray(parsed)) this.sessionList = parsed
      } catch {
        this.sessionList = []
      }
    }
    let changed = false
    for (const session of this.sessionList) {
      if (session.status === 'running') {
        session.status = 'interrupted'
        session.finishedAt = Date.now()
        changed = true
      }
    }
    if (changed) this.saveSessions()
  }

  private saveSessions(): void {
    try {
      writeFileSync(this.sessionsFile, JSON.stringify(this.sessionList.slice(-200)), 'utf8')
    } catch (error) {
      this.ctx.logger?.warn?.('写入会话状态失败：%s', String(error))
    }
  }

  beginSession(sessionId: string, taskIds: string[]): void {
    this.sessionList.push({ sessionId, startedAt: Date.now(), status: 'running', taskIds })
    this.saveSessions()
  }

  finishSession(sessionId: string, cleaned: number): void {
    const session = this.sessionList.find((item) => item.sessionId === sessionId)
    if (!session) return
    session.status = 'done'
    session.finishedAt = Date.now()
    session.cleaned = cleaned
    this.saveSessions()
  }

  sessions(): CleanSessionRecord[] {
    return [...this.sessionList].reverse()
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const lines = readFileSync(this.file, 'utf8').split('\n')
      for (const line of lines.slice(-this.capacity)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          this.entries.push(JSON.parse(trimmed) as HistoryEntry)
        } catch {
          /* 跳过损坏行 */
        }
      }
    } catch (error) {
      this.ctx.logger?.warn?.('读取历史记录失败：%s', String(error))
    }
  }

  append(entry: HistoryEntry): void {
    this.entries.push(entry)
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity)
    try {
      appendFileSync(this.file, JSON.stringify(entry) + '\n', 'utf8')
    } catch (error) {
      this.ctx.logger?.warn?.('写入历史记录失败：%s', String(error))
    }
    this.ctx.emit('history/changed')
  }

  list(limit = 50): HistoryEntry[] {
    return this.entries.slice(-Math.max(1, limit)).reverse()
  }

  totals(): { sessions: number; freedBytes: number; cleaned: number } {
    let freedBytes = 0
    let cleaned = 0
    for (const entry of this.entries) {
      if (entry.dryRun) continue
      freedBytes += entry.freedBytes
      cleaned += entry.cleaned
    }
    return { sessions: this.entries.filter((item) => !item.dryRun).length, freedBytes, cleaned }
  }

  clear(): void {
    this.entries = []
    try {
      writeFileSync(this.file, '', 'utf8')
    } catch {
      /* ignore */
    }
    this.ctx.emit('history/changed')
  }
}
