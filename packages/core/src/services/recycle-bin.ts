/**
 * 回收站服务（`ctx.recycleBin`）。
 *
 * 为什么不用 `fs.rm`：进入回收站的文件可以被用户还原，这是"删除"在体验上
 * 最接近"可回退"的手段，也是论文 5.5 / 补偿链第⑦步的落点。
 *
 * 实现方式：把待回收清单写成 JSON，交给 PowerShell 调用
 * `Microsoft.VisualBasic.FileIO.FileSystem` 的 SendToRecycleBin 语义批量处理，
 * 一次进程处理一整批（避免一文件一进程），返回逐项回执。
 *
 * 测试注记：`setRunnerForTests()` 可以注入假的执行器，避免测试真的往回收站扔东西。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Service, type Context } from 'cordis'
import { runCommand } from '@cordclean/utils'

export interface RecycleItem {
  path: string
  isDirectory: boolean
}

export interface RecycleReceipt {
  ok: string[]
  failed: Array<{ path: string; message: string }>
}

export type RecycleRunner = (items: RecycleItem[]) => Promise<RecycleReceipt>

/** 批量进入回收站的 PowerShell 脚本（UTF-8 写入临时文件后执行） */
const RECYCLE_SCRIPT = `param([Parameter(Mandatory=$true)][string]$ListFile)
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName Microsoft.VisualBasic | Out-Null
$items = Get-Content -LiteralPath $ListFile -Raw -Encoding UTF8 | ConvertFrom-Json
$ok = New-Object System.Collections.Generic.List[string]
$failed = New-Object System.Collections.Generic.List[object]
foreach ($item in @($items)) {
  try {
    if ($item.isDirectory) {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($item.path, 'OnlyErrorDialogs', 'SendToRecycleBin')
    } else {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($item.path, 'OnlyErrorDialogs', 'SendToRecycleBin')
    }
    $ok.Add($item.path)
  } catch {
    $failed.Add([pscustomobject]@{ path = $item.path; message = $_.Exception.Message })
  }
}
$result = [pscustomobject]@{ ok = $ok.ToArray(); failed = $failed.ToArray() }
$result | ConvertTo-Json -Depth 4 -Compress
`

export class RecycleBinService extends Service {
  static inject = ['system']

  private runner?: RecycleRunner
  private scriptPath?: string
  private availableCache = new Map<string, boolean>()
  private forcedAvailability?: boolean

  constructor(ctx: Context) {
    super(ctx, 'recycleBin')
  }

  /** 测试用：注入执行器（传 undefined 恢复真实实现） */
  setRunnerForTests(runner?: RecycleRunner): void {
    this.runner = runner
    this.availableCache.clear()
  }

  /** 测试用：强制可用性 */
  setAvailableForTests(value?: boolean): void {
    this.forcedAvailability = value
    this.availableCache.clear()
  }

  /** 某个路径所在卷的回收站是否可用（网络盘/部分移动盘没有回收站） */
  async available(target: string): Promise<boolean> {
    if (this.forcedAvailability !== undefined) return this.forcedAvailability
    if (this.runner) return true
    if (process.platform !== 'win32') return false
    const root = path.parse(path.resolve(target)).root
    const cached = this.availableCache.get(root)
    if (cached !== undefined) return cached
    // Windows 每个卷的回收站目录是 <卷>\\$Recycle.Bin，不存在说明该卷没有启用回收站
    let ok = existsSync(path.join(root, '$Recycle.Bin'))
    if (!ok) {
      // 某些系统盘符根目录读取受限，退一步：能解析到盘符就认为可用，失败时按回执降级
      ok = /^[a-z]:\\$/i.test(root) && existsSync(root)
    }
    this.availableCache.set(root, ok)
    return ok
  }

  /**
   * 批量移入回收站。
   * 单批上限 2000 条（避免命令行/JSON 过大），失败项原样返回，由调用方决定降级策略。
   */
  async recycle(items: RecycleItem[]): Promise<RecycleReceipt> {
    if (!items.length) return { ok: [], failed: [] }
    if (this.runner) return this.runner(items)
    if (process.platform !== 'win32') {
      return { ok: [], failed: items.map((item) => ({ path: item.path, message: '当前平台不支持回收站' })) }
    }

    const receipt: RecycleReceipt = { ok: [], failed: [] }
    for (let offset = 0; offset < items.length; offset += 2000) {
      const chunk = items.slice(offset, offset + 2000)
      const result = await this.recycleChunk(chunk)
      receipt.ok.push(...result.ok)
      receipt.failed.push(...result.failed)
    }
    return receipt
  }

  private async recycleChunk(chunk: RecycleItem[]): Promise<RecycleReceipt> {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cordclean-recycle-'))
    const listFile = path.join(dir, 'list.json')
    try {
      writeFileSync(listFile, JSON.stringify(chunk), 'utf8')
      const script = this.ensureScript()
      const result = await runCommand(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ListFile', listFile],
        { timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024 },
      )
      const parsed = parseReceipt(result.stdout)
      if (!parsed) {
        const message = (result.stderr || result.stdout || '回收站调用失败').slice(0, 200)
        return { ok: [], failed: chunk.map((item) => ({ path: item.path, message })) }
      }
      return parsed
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  private ensureScript(): string {
    if (this.scriptPath && existsSync(this.scriptPath)) return this.scriptPath
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cordclean-recycle-script-'))
    const script = path.join(dir, 'recycle.ps1')
    writeFileSync(script, RECYCLE_SCRIPT, 'utf8')
    this.scriptPath = script
    return script
  }
}

/** 解析 PowerShell 的 JSON 回执（stdout 可能带 BOM/额外输出） */
export function parseReceipt(stdout: string): RecycleReceipt | undefined {
  const text = stdout.replace(/^\uFEFF/, '').trim()
  if (!text) return undefined
  const start = text.lastIndexOf('{')
  if (start < 0) return undefined
  try {
    const payload = JSON.parse(text.slice(start)) as { ok?: string[]; failed?: Array<{ path: string; message: string }> }
    return {
      ok: Array.isArray(payload.ok) ? payload.ok : [],
      failed: Array.isArray(payload.failed) ? payload.failed : [],
    }
  } catch {
    return undefined
  }
}
