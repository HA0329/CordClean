/**
 * 隔离区服务：把「删除」变成「可撤销的移动」。
 *
 * 清理项被移入 `%LOCALAPPDATA%\\CordClean\\quarantine\\<sessionId>\\`，
 * 并在同一目录维护 `manifest.jsonl` 记录原始路径，支持一键恢复。
 * 这是本工具与「直接删文件」的清理软件在安全性上的关键差异。
 */
import { appendFileSync, existsSync, mkdirSync, promises as fs, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Service, type Context } from 'cordis'
import type { QuarantineLike, QuarantineRecord } from '@cordclean/shared'
import { moveFile } from '@cordclean/utils'
import { basename } from '@cordclean/shared'
import { errorMessage } from '@cordclean/utils'

export interface QuarantineConfig {
  dataDir: string
}

/** 一次清理会话对应的隔离区 */
export interface QuarantineSession {
  readonly id: string
  readonly dir: string
  readonly moved: number
  readonly bytes: number
  /** 把一个文件移入隔离区 */
  move(source: string, taskId: string, expectedBytes?: number): Promise<QuarantineRecord>
  close(): Promise<void>
}

const MANIFEST = 'manifest.jsonl'

/** 文件名安全化（去掉 Windows 非法字符并限长） */
function safeName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '_')
  if (!cleaned) return 'file'
  if (cleaned.length <= 120) return cleaned
  const ext = path.extname(cleaned)
  return cleaned.slice(0, 100) + (ext.length < 20 ? ext : '')
}

export class QuarantineService extends Service implements QuarantineLike {
  static inject = ['settings']

  /** 隔离区根目录 */
  readonly directory: string

  constructor(ctx: Context, config: QuarantineConfig) {
    super(ctx, 'quarantine')
    this.directory = path.join(config.dataDir, 'quarantine')
    mkdirSync(this.directory, { recursive: true })
  }

  /** 开启一个隔离会话 */
  beginSession(sessionId: string): QuarantineSession {
    const dir = path.join(this.directory, sessionId)
    mkdirSync(dir, { recursive: true })
    const settings = this.ctx.settings.get()
    const maxBytes = settings.quarantine.maxBytes
    const maxFiles = settings.quarantine.maxFiles
    let moved = 0
    let bytes = 0
    let index = 0
    const manifest = path.join(dir, MANIFEST)

    return {
      id: sessionId,
      dir,
      get moved() {
        return moved
      },
      get bytes() {
        return bytes
      },
      async move(source: string, taskId: string, expectedBytes?: number): Promise<QuarantineRecord> {
        if (moved >= maxFiles) {
          throw new Error(`隔离区文件数已达上限（${maxFiles}），请先清理隔离区或关闭隔离功能`)
        }
        const size = expectedBytes ?? 0
        if (bytes + size > maxBytes) {
          throw new Error('隔离区容量已达上限，请先清理隔离区')
        }
        const storedName = `${String(++index).padStart(4, '0')}_${safeName(basename(source))}`
        const target = path.join(dir, storedName)
        await moveFile(source, target)
        const record: QuarantineRecord = {
          id: `${sessionId}/${storedName}`,
          sessionId,
          taskId,
          originalPath: source,
          storedName,
          bytes: size,
          createdAt: Date.now(),
        }
        appendFileSync(manifest, JSON.stringify(record) + '\n', 'utf8')
        moved++
        bytes += size
        return record
      },
      async close() {
        /* manifest 已实时写入，无需额外处理 */
      },
    }
  }

  /** 读取某个会话的清单 */
  private readManifest(dir: string): QuarantineRecord[] {
    const manifest = path.join(dir, MANIFEST)
    if (!existsSync(manifest)) return []
    const records: QuarantineRecord[] = []
    for (const line of readFileSync(manifest, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        records.push(JSON.parse(trimmed) as QuarantineRecord)
      } catch {
        /* 跳过损坏行 */
      }
    }
    return records
  }

  private listSessions(): string[] {
    try {
      return readdirSync(this.directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      return []
    }
  }

  async list(): Promise<QuarantineRecord[]> {
    const sessions = this.listSessions()
    const result: QuarantineRecord[] = []
    for (const session of sessions) {
      const dir = path.join(this.directory, session)
      for (const record of this.readManifest(dir)) {
        const storedName = this.safeStoredName(record.storedName)
        if (storedName && existsSync(path.join(dir, storedName))) result.push(record)
      }
    }
    return result.sort((a, b) => b.createdAt - a.createdAt)
  }

  async stats(): Promise<{ count: number; bytes: number }> {
    const records = await this.list()
    return { count: records.length, bytes: records.reduce((sum, item) => sum + item.bytes, 0) }
  }

  /** 只接受隔离区根目录下的单层会话目录，防止 `/` 拼接穿越 */
  private resolveSessionDir(sessionId: string): string | undefined {
    if (!sessionId || sessionId === '.' || sessionId === '..' || !/^[A-Za-z0-9._-]+$/.test(sessionId)) return undefined
    const root = path.resolve(this.directory)
    const dir = path.resolve(root, sessionId)
    const prefix = root.endsWith(path.sep) ? root : root + path.sep
    return dir.startsWith(prefix) ? dir : undefined
  }

  private safeStoredName(value: string): string | undefined {
    if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) return undefined
    return path.basename(value) === value ? value : undefined
  }

  /** 恢复隔离项到原始位置 */
  async restore(ids: string[]): Promise<{ restored: number; failed: Array<{ id: string; message: string }> }> {
    const failed: Array<{ id: string; message: string }> = []
    let restored = 0
    // 只信任 list() 中实际存在的记录，不能把任意 id 拆成 session/name 后拼路径
    const known = new Map((await this.list()).map((record) => [record.id, record]))
    const bySession = new Map<string, Set<string>>()
    for (const id of ids) {
      const record = known.get(id)
      if (!record) {
        failed.push({ id, message: '无效的隔离项 id' })
        continue
      }
      if (!bySession.has(record.sessionId)) bySession.set(record.sessionId, new Set())
      bySession.get(record.sessionId)!.add(id)
    }

    for (const [session, idSet] of bySession) {
      const dir = this.resolveSessionDir(session)
      if (!dir) {
        for (const id of idSet) failed.push({ id, message: '无效的隔离会话 id' })
        continue
      }
      const records = this.readManifest(dir)
      const remaining: QuarantineRecord[] = []
      for (const record of records) {
        if (!idSet.has(record.id)) {
          remaining.push(record)
          continue
        }
        const storedName = this.safeStoredName(record.storedName)
        if (!storedName) {
          failed.push({ id: record.id, message: '无效的隔离项文件名' })
          remaining.push(record)
          continue
        }
        const source = path.join(dir, storedName)
        try {
          if (!existsSync(source)) throw new Error('隔离文件已不存在')
          if (existsSync(record.originalPath)) {
            throw new Error('原路径已存在同名文件')
          }
          mkdirSync(path.dirname(record.originalPath), { recursive: true })
          await moveFile(source, record.originalPath)
          restored++
        } catch (error) {
          failed.push({ id: record.id, message: errorMessage(error) })
          remaining.push(record)
        }
      }
      writeFileSync(path.join(dir, MANIFEST), remaining.map((item) => JSON.stringify(item)).join('\n') + (remaining.length ? '\n' : ''), 'utf8')
      if (!remaining.length) {
        // 会话已清空：只删除已经解析到隔离区内部的目录
        try {
          await fs.rm(dir, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
      }
    }
    return { restored, failed }
  }

  /** 彻底删除隔离项（不传 ids 表示清空全部） */
  async purge(ids?: string[]): Promise<number> {
    const target = new Set(ids ?? [])
    let removed = 0
    for (const session of this.listSessions()) {
      const dir = path.join(this.directory, session)
      const records = this.readManifest(dir)
      const remaining: QuarantineRecord[] = []
      for (const record of records) {
        const shouldRemove = !ids || target.has(record.id)
        if (!shouldRemove) {
          remaining.push(record)
          continue
        }
        try {
          await fs.rm(path.join(dir, record.storedName), { force: true })
          removed++
        } catch {
          remaining.push(record)
        }
      }
      if (remaining.length !== records.length) {
        writeFileSync(
          path.join(dir, MANIFEST),
          remaining.map((item) => JSON.stringify(item)).join('\n') + (remaining.length ? '\n' : ''),
          'utf8',
        )
      }
      if (!remaining.length) {
        try {
          await fs.rm(dir, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
      }
    }
    return removed
  }

  /** 清理超过保留期的隔离文件 */
  async purgeExpired(): Promise<number> {
    const days = this.ctx.settings.get().quarantine.retentionDays
    if (!days) return 0
    const deadline = Date.now() - days * 86400_000
    const records = await this.list()
    const expired = records.filter((item) => item.createdAt < deadline).map((item) => item.id)
    return expired.length ? this.purge(expired) : 0
  }
}
