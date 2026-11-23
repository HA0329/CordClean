/**
 * 重复文件排除表：应用内部运行时/系统数据库不当「可删除副本」报告。
 *
 * 背景：真实扫描把 NVIDIA App 的 `Ontology64.dll`、Python 站点包里的 onnx 模型、
 * Windows USN 日志等当作重复项；删掉应用内部的「副本」可能破坏应用。
 * 与大文件插件保持同一套运行时扩展名 + 应用/系统目录排除。
 */
import path from 'node:path'
import type { TaskEnv } from '@cordclean/shared'

const RUNTIME_EXTENSIONS = new Set([
  '.dll',
  '.exe',
  '.sys',
  '.drv',
  '.node',
  '.pdb',
  '.lib',
  '.so',
  '.dylib',
  '.msi',
  '.msix',
  '.onnx',
  // 系统数据库/日志（USN 日志、ESE 数据库等）不是用户可清理副本
  '.jrs',
  '.edb',
])

function appPathPrefixes(env: Pick<TaskEnv, 'programFiles' | 'programFilesX86' | 'windowsDir' | 'programData' | 'userProfile' | 'localAppData'>): string[] {
  const values = [
    env.programFiles,
    env.programFilesX86,
    env.windowsDir,
    env.programData,
    env.localAppData ? path.join(env.localAppData, 'Programs') : undefined,
    env.userProfile ? path.join(env.userProfile, 'AppData', 'Local', 'Programs') : undefined,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  return [...new Set(values.map((value) => path.resolve(value).toLowerCase()))]
}

export function shouldExcludeDuplicateFile(target: string, env: Pick<TaskEnv, 'programFiles' | 'programFilesX86' | 'windowsDir' | 'programData' | 'userProfile' | 'localAppData'>): boolean {
  const resolved = path.resolve(target)
  const lower = resolved.toLowerCase()
  if (RUNTIME_EXTENSIONS.has(path.extname(lower))) return true
  return appPathPrefixes(env).some((prefix) => lower === prefix || lower.startsWith(prefix + path.sep))
}

export const DUPLICATE_RUNTIME_EXTENSIONS = RUNTIME_EXTENSIONS
