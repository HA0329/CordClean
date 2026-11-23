/**
 * empty-dirs 白名单：这些位置里的「空目录」不能当可清理项上报。
 *
 * 为什么需要：默认扫描根是用户目录，`AppData\Local` 下有大量应用刻意保留的占位目录
 * （Microsoft\PowerPoint、pip、VirtualStore…），甚至包括 CordClean 自己的隔离区目录。
 * 它们确实「空」，但删除可能让应用报错或删掉工具自身的数据目录。
 */
import path from 'node:path'
import type { TaskEnv } from '@cordclean/shared'

/** 需要整体排除的目录（绝对路径前缀，命中后连同其子目录都不进入） */
export function buildSkipPrefixes(env: Pick<TaskEnv, 'dataDir' | 'userProfile' | 'programData' | 'windowsDir' | 'programFiles' | 'programFilesX86'>): string[] {
  // 整个 %USERPROFILE%\AppData（含 Roaming/Local/LocalLow）都属于应用数据，不做空目录清理
  const appDataRoot = env.userProfile ? path.join(env.userProfile, 'AppData') : undefined
  return [env.dataDir, appDataRoot, env.programData, env.windowsDir, env.programFiles, env.programFilesX86]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => path.resolve(value).toLowerCase())
}

/** 目标是否位于白名单目录（或等于其本身）之下 */
export function isWhitelistedPath(target: string, prefixes: readonly string[]): boolean {
  if (!prefixes.length) return false
  const normalized = path.resolve(target).toLowerCase()
  return prefixes.some((prefix) => {
    if (normalized === prefix) return true
    return normalized.startsWith(prefix.endsWith(path.sep) ? prefix : prefix + path.sep)
  })
}
