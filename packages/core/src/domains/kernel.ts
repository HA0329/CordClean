/** 内核域：插件生命周期、设置、AI 上下文注册（不依赖清理引擎实现细节） */
export { PluginManagerService, validateCapabilities } from '../services/plugins.ts'
export { SettingsService } from '../services/settings.ts'
export { AiContextService } from '../services/ai-context.ts'
