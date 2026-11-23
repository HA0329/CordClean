/**
 * 大文件排除表：应用内部运行时/系统文件不当「可清理大文件」报告。
 *
 * 背景：真实扫描把微信 `flue.dll`（227MB 运行时库）当成可清理大文件，用户一键勾选
 * 可能直接破坏应用。这里按「运行时扩展名 + 应用/系统安装目录」双重排除，
 * 只保留缓存/归档/媒体这类相对安全的大文件。
 */
import path from 'node:path'
import type { TaskEnv } from '@cordclean/shared'

/** 运行库/程序/安装包：即使体积大也不是「垃圾」 */
const RUNTIME_EXTENSIONS = new Set(['.dll', '.exe', '.sys', '.drv', '.node', '.pdb', '.lib', '.so', '.dylib', '.msi', '.msix'])

/** 应用/系统安装目录：这些目录里的文件应由用户通过卸载程序管理 */
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

export function shouldExcludeLargeFile(target: string, env: Pick<TaskEnv, 'programFiles' | 'programFilesX86' | 'windowsDir' | 'programData' | 'userProfile' | 'localAppData'>): boolean {
  const resolved = path.resolve(target)
  const lower = resolved.toLowerCase()
  if (RUNTIME_EXTENSIONS.has(path.extname(lower))) return true
  return appPathPrefixes(env).some((prefix) => lower === prefix || lower.startsWith(prefix + path.sep))
}

export const LARGE_FILE_RUNTIME_EXTENSIONS = RUNTIME_EXTENSIONS
