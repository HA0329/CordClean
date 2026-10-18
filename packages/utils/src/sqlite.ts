/**
 * SQLite 压缩（VACUUM）：只整理空闲页，不删除任何数据。
 *
 * 用途：浏览器 History / Web Data 等数据库长期使用后会产生大量空闲页，
 * VACUUM 会把它们回收。**必须先退出对应程序**（浏览器会独占锁定数据库）。
 *
 * 优先使用 Node 内置的 `node:sqlite`（Node 22.5+，24 默认可用）；
 * 运行时不支持时明确报错，绝不假装成功。
 */
import { stat } from 'node:fs/promises'

export interface CompactResult {
  before: number
  after: number
  freed: number
}

type SqliteModule = { DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void } }

let sqliteModule: SqliteModule | undefined | null

async function loadSqlite(): Promise<SqliteModule | undefined> {
  if (sqliteModule !== undefined) return sqliteModule ?? undefined
  try {
    // 动态导入：不支持的运行时会在这里失败，而不是在模块加载期
    const module = (await import('node:sqlite')) as unknown as SqliteModule
    sqliteModule = module
    return module
  } catch {
    sqliteModule = null
    return undefined
  }
}

/**
 * 对单个 SQLite 数据库执行 VACUUM。
 * @throws 数据库被占用 / 运行时不支持 / 不是有效的 SQLite 文件
 */
export async function compactSqlite(target: string): Promise<CompactResult> {
  const before = await stat(target).then((info) => info.size).catch(() => 0)
  if (!before) throw new Error('数据库不存在或无法读取')
  const sqlite = await loadSqlite()
  if (!sqlite) {
    throw new Error('当前运行时不支持 SQLite VACUUM（需要 Node 22.5+ 的 node:sqlite）')
  }
  const database = new sqlite.DatabaseSync(target)
  try {
    database.exec('VACUUM')
  } finally {
    database.close()
  }
  const after = await stat(target).then((info) => info.size).catch(() => before)
  return { before, after, freed: Math.max(0, before - after) }
}

/** 当前运行时是否支持 SQLite 压缩（界面/规则可据此提示） */
export async function sqliteAvailable(): Promise<boolean> {
  return !!(await loadSqlite())
}
