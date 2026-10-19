/** 内核域：插件生命周期、设置、AI 上下文注册（不依赖清理引擎实现细节） */
export { PluginManagerService, validateCapabilities } from './kernel/plugins.ts'
export { SettingsService } from './kernel/settings.ts'
export { AiContextService } from './kernel/ai-context.ts'
