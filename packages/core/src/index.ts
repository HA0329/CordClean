/**
 * @cordclean/core —— Cordis 内核与核心服务实现。
 *
 * 对外只暴露装配入口与各服务类，插件通过 `ctx.cleaner` 等上下文属性
 * 使用能力，而不直接 import 这些类（契约在 @cordclean/shared 中）。
 */
export * from './kernel.ts'
export * from './manifest.ts'
export * from './services/settings.ts'
export * from './services/path-policy.ts'
export * from './services/quarantine.ts'
export * from './services/history.ts'
export * from './services/system.ts'
export * from './services/cleaner.ts'
export * from './services/plugins.ts'
export * from './services/rules.ts'
export * from './services/evaluator.ts'
export * from './services/compensate.ts'
export * from './services/executor.ts'
export * from './services/recycle-bin.ts'
export * from './env.ts'
export * from './logger.ts'
