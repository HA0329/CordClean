/**
 * @cordclean/core —— Cordis 内核与核心服务实现。
 *
 * 对外只暴露装配入口与各服务类，插件通过 `ctx.cleaner` 等上下文属性
 * 使用能力，而不直接 import 这些类（契约在 @cordclean/shared 中）。
 */
export * from './kernel.ts'
export * from './manifest.ts'
export * from './domains/kernel/settings.ts'
export * from './domains/safety/path-policy.ts'
export * from './domains/safety/quarantine.ts'
export * from './domains/engine/history.ts'
export * from './domains/engine/system.ts'
export * from './domains/engine/cleaner.ts'
export * from './domains/kernel/plugins.ts'
export * from './domains/kernel/ui.ts'
export * from './domains/rules/rules.ts'
export * from './domains/engine/evaluator.ts'
export * from './domains/engine/egress.ts'
export * from './domains/kernel/ai-context.ts'
export * from './domains/safety/compensate.ts'
export * from './domains/safety/executor.ts'
export * from './domains/safety/recycle-bin.ts'
export * from './env.ts'
export * from './logger.ts'

export * from './domains/kernel/worker-host.ts'

export * from './domains/kernel/external-proxy.ts'

export * from './domains/engine/mover.ts'
