/**
 * 插件内「纯逻辑」的单元测试（不需要真实系统环境）。
 *
 * 重点覆盖两处最容易出错、也最影响安全的地方：
 * 1. 回收站 `$I` 元数据解析（二进制结构，错一位就会把错误路径展示给用户）；
 * 2. 注册表「垃圾卸载项」判定（误判会删掉系统组件的卸载登记）。
 */
import { describe, expect, it } from 'vitest'
import { filetimeToUnix, parseRecycleInfo } from '@cordclean/plugin-recycle'
import { isJunkUninstall } from '@cordclean/plugin-registry'

/** 构造一个标准的 Windows $I 缓冲区 */
function buildInfoFile(options: { size: number; unixMs: number; name: string; version?: number }): Buffer {
  const nameBuffer = Buffer.from(options.name + '\u0000', 'utf16le')
  const filetime = BigInt(options.unixMs + 11_644_473_600_000) * 10_000n
  const header = Buffer.alloc(28)
  header.writeBigUInt64LE(BigInt(options.version ?? 2), 0)
  header.writeBigUInt64LE(BigInt(options.size), 8)
  header.writeBigUInt64LE(filetime, 16)
  header.writeUInt32LE(nameBuffer.length / 2, 24)
  return Buffer.concat([header, nameBuffer])
}

describe('回收站 $I 解析', () => {
  it('FILETIME 正确转换为 Unix 毫秒', () => {
    // 2024-01-01T00:00:00Z
    const unixMs = Date.UTC(2024, 0, 1)
    const filetime = BigInt(unixMs + 11_644_473_600_000) * 10_000n
    expect(filetimeToUnix(filetime)).toBe(unixMs)
    expect(filetimeToUnix(0n)).toBe(0)
  })

  it('解析出原始路径、体积与删除时间', () => {
    const name = 'D:\\我的资料\\报告 2024.docx'
    const unixMs = Date.UTC(2025, 5, 15, 8, 30, 0)
    const buffer = buildInfoFile({ size: 12_345, unixMs, name })
    const info = parseRecycleInfo(buffer)
    expect(info).not.toBeNull()
    expect(info!.size).toBe(12_345)
    expect(info!.original).toBe(name)
    expect(info!.deletedAt).toBe(unixMs)
  })

  it('兼容 Windows 10 的目录型变体（名字偏移 36）', () => {
    const name = 'C:\\Temp\\folder\\file.bin'
    const nameBuffer = Buffer.from(name + '\u0000', 'utf16le')
    const header = Buffer.alloc(36)
    header.writeBigUInt64LE(2n, 0)
    header.writeBigUInt64LE(0n, 8)
    header.writeBigUInt64LE(BigInt(Date.UTC(2025, 0, 1) + 11_644_473_600_000) * 10_000n, 16)
    header.writeUInt32LE(0, 24)
    header.writeBigUInt64LE(4096n, 24) // 目录型变体：24..32 为目录体积
    header.writeUInt32LE(nameBuffer.length / 2, 32)
    const info = parseRecycleInfo(Buffer.concat([header, nameBuffer]))
    expect(info?.original).toBe(name)
    expect(info?.size).toBeGreaterThan(0)
  })

  it('截断/损坏的元数据不抛错，返回可降级结果', () => {
    expect(parseRecycleInfo(Buffer.alloc(0))).toBeNull()
    expect(parseRecycleInfo(Buffer.alloc(10))).toBeNull()
    const broken = Buffer.alloc(28)
    broken.writeBigUInt64LE(2n, 0)
    const info = parseRecycleInfo(broken)
    expect(info).not.toBeNull()
    expect(info!.original).toBe('')
  })

  it('名字长度字段被人为放大时不会越界读取', () => {
    const buffer = buildInfoFile({ size: 1, unixMs: Date.UTC(2025, 0, 1), name: 'C:\\a.txt' })
    buffer.writeUInt32LE(4096, 24)
    const info = parseRecycleInfo(buffer)
    expect(info).not.toBeNull()
    expect(info!.original.length).toBeLessThan(200)
  })
})

describe('注册表垃圾卸载项判定（保守策略）', () => {
  it('完全空的键判定为垃圾', () => {
    expect(isJunkUninstall([])).toBe(true)
    expect(isJunkUninstall([], 0)).toBe(true)
  })

  it('仅有 SystemComponent 的系统组件登记不算垃圾', () => {
    // 真实案例：HKLM\\...\\Uninstall\\Connection Manager 只有一个 SystemComponent=1
    expect(isJunkUninstall(['SystemComponent'])).toBe(false)
  })

  it('更新器登记（NoModify/NoRepair/DisplayVersion/Version）不算垃圾', () => {
    // 真实案例：Microsoft Edge Update
    expect(isJunkUninstall(['NoModify', 'NoRepair', 'DisplayVersion', 'Version'])).toBe(false)
  })

  it('正常产品登记（DisplayName / UninstallString / Publisher）不算垃圾', () => {
    expect(isJunkUninstall(['DisplayName', 'UninstallString', 'Publisher'])).toBe(false)
    expect(isJunkUninstall(['InstallLocation', 'EstimatedSize'])).toBe(false)
  })

  it('少量无效值判定为垃圾', () => {
    expect(isJunkUninstall(['SomethingWeird'])).toBe(true)
    expect(isJunkUninstall(['xx', 'yy', 'zz'])).toBe(true)
  })

  it('值较多时一律保守跳过', () => {
    expect(isJunkUninstall(['a', 'b', 'c', 'd'])).toBe(false)
  })
})
