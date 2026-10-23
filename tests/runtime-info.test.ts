import { describe, expect, it } from 'vitest'
import { detectElevated, elevationFromGroups } from '@cordclean/core'

describe('运行时信息与权限检测', () => {
  it('Windows 完整性级别：High/System 才视为管理员，Medium 为普通用户', () => {
    expect(elevationFromGroups('Mandatory Label\\Medium Mandatory Level Label S-1-16-8192')).toBe(false)
    expect(elevationFromGroups('Mandatory Label\\High Mandatory Level Label S-1-16-12288')).toBe(true)
    expect(elevationFromGroups('Mandatory Label\\System Mandatory Level Label S-1-16-16384')).toBe(true)
    expect(elevationFromGroups('no mandatory label')).toBeUndefined()
  })

  it('detectElevated 返回布尔值且本机可复现（不再用简单文件写权限误判）', () => {
    const elevated = detectElevated()
    expect(typeof elevated).toBe('boolean')
    // 同一进程内必须保持稳定，避免每次刷新闪烁
    expect(detectElevated()).toBe(elevated)
  })
})
