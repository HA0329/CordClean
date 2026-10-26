/**
 * @cordclean/utils —— 与宿主平台相关的通用工具层。
 *
 * 分层约定：
 *   shared（纯类型/纯函数）
 *     ↳ utils（Node/Windows 相关的路径、遍历、进程、哈希工具）
 *       ↳ core（Cordis 内核与服务）
 *         ↳ plugins（清理能力插件）
 *
 * 插件只依赖 utils + shared，因此不会反向依赖内核实现。
 */
export * from './paths.ts'
export * from './walk.ts'
export * from './utils.ts'
export * from './fs-ops.ts'
export * from './sqlite.ts'
export * from './proc.ts'
export * from './hash.ts'
export * from './log-file.ts'
