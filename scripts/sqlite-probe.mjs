import { mkdtempSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir = mkdtempSync(path.join(os.tmpdir(), 'cc-sqlite-probe-'))
const db = path.join(dir, 'probe.db')
let available = true
let error = ''
try {
  const { DatabaseSync } = await import('node:sqlite')
  const handle = new DatabaseSync(db)
  handle.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
  handle.exec("INSERT INTO t (v) VALUES ('x')")
  handle.exec('DELETE FROM t')
  handle.close()
  const before = statSync(db).size
  const vacuum = new DatabaseSync(db)
  vacuum.exec('VACUUM')
  vacuum.close()
  const after = statSync(db).size
  console.log(JSON.stringify({ runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.versions.node}`, available, before, after, freed: before - after }))
} catch (err) {
  available = false
  error = String(err && err.message).slice(0, 120)
  console.log(JSON.stringify({ runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.versions.node}`, available, error }))
}
rmSync(dir, { recursive: true, force: true })
