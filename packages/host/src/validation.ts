import { z } from 'zod'

/** 插件工坊依赖声明：包名 → semver；具体合法性由 shared 静态校验再检查 */
const pluginDependencies = z.record(z.string().min(1).max(100), z.string().min(1).max(40)).optional()

/** 关键 RPC 的入参 schema；未列出的方法只要求 params 是对象 */
const schemas: Record<string, z.ZodTypeAny> = {
  'settings/patch': z.object({ patch: z.record(z.string(), z.unknown()) }).strict(),
  'settings/set': z.object({ path: z.string().min(1).max(200), value: z.unknown() }).strict(),
  'clean/start': z
    .object({
      itemIds: z.array(z.string()).optional(),
      dryRun: z.boolean().optional(),
      forceQuarantine: z.boolean().optional(),
    })
    .strict()
    .refine((value) => (value.itemIds?.length ?? 0) > 0, {
      message: 'itemIds 至少提供一个（不支持界面回传清理项）',
    }),
  'scan/start': z.object({ taskIds: z.array(z.string()).optional() }).strict(),
  'files/move': z
    .object({
      paths: z.array(z.string().min(1)).min(1).max(10_000),
      targetDir: z.string().min(1),
      link: z.boolean().optional(),
    })
    .strict(),
  'plugins/enable': z.object({ id: z.string().min(1) }).strict(),
  'plugins/disable': z.object({ id: z.string().min(1) }).strict(),
  'plugins/reload': z.object({ id: z.string().min(1) }).strict(),
  'plugins/config': z.object({ id: z.string().min(1), config: z.record(z.string(), z.unknown()) }).strict(),
  'plugins/install': z.object({ path: z.string().min(1), allowCustomClean: z.boolean().optional() }).strict(),
  'plugins/install-native': z.object({ path: z.string().min(1).max(500) }).strict(),
  'ui/contributions': z.void().optional(),
  'ui/resolve': z
    .object({
      pluginId: z.string().min(1).max(120),
      id: z.string().min(1).max(120),
      params: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
  'ui/command': z
    .object({
      pluginId: z.string().min(1).max(120),
      id: z.string().min(1).max(120),
      params: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
  'plugins/uninstall': z.object({ id: z.string().min(1) }).strict(),
  'quarantine/restore': z.object({ ids: z.array(z.string()).max(10_000) }).strict(),
  'quarantine/purge': z.object({ ids: z.array(z.string()).max(10_000).optional() }).strict(),
  'history/list': z.object({ limit: z.number().int().positive().max(1000).optional() }).strict().optional(),
  'app/open-path': z.object({ path: z.string().min(1) }).strict(),
  'app/open-editor': z.object({ path: z.string().min(1) }).strict(),
  'app/logs/recent': z.object({ limit: z.number().int().positive().max(2000).optional() }).strict().optional(),
  'ai/analyze': z
    .object({
      taskIds: z.array(z.string()).optional(),
      extraContext: z.string().max(4000).optional(),
      contextProviders: z.array(z.string()).max(20).optional(),
      image: z.object({ mime: z.string().min(1).max(100), data: z.string().min(1).max(8 * 1024 * 1024) }).optional(),
    })
    .strict()
    .optional(),
  'ai/rules/dry-run': z.object({ suggestion: z.record(z.string(), z.unknown()) }).strict(),
  'ai/plugin/draft': z.object({ requirement: z.string().min(1).max(2000) }).strict(),
  'ai/plugin/validate': z
    .object({ code: z.string().min(1).max(200_000), dependencies: pluginDependencies, native: z.boolean().optional() })
    .strict(),
  'ai/plugin/install': z
    .object({
      name: z.string().min(1).max(80),
      code: z.string().min(1).max(200_000),
      dependencies: pluginDependencies,
      acknowledgeDependencies: z.boolean().optional(),
      native: z.boolean().optional(),
    })
    .strict(),
  'scheduler/authorize': z
    .object({
      planId: z.string().min(1).optional(),
      everyMinutes: z.number().int().min(15).max(1440).optional(),
      taskIds: z.array(z.string()).optional(),
    })
    .strict(),
  'scheduler/run': z.object({ planId: z.string().min(1).optional() }).strict().optional(),
  'scheduler/revoke': z.object({ planId: z.string().min(1).optional() }).strict().optional(),
}

export interface ValidationResult {
  ok: boolean
  message?: string
}

export function validateParams(method: string, params: unknown): ValidationResult {
  const schema = schemas[method]
  if (!schema) {
    if (params === undefined || params === null) return { ok: true }
    if (typeof params !== 'object' || Array.isArray(params)) return { ok: false, message: '参数必须是对象' }
    return { ok: true }
  }
  const result = schema.safeParse(params ?? {})
  if (result.success) return { ok: true }
  const first = result.error.issues[0]
  return { ok: false, message: `${first?.path?.join('.') || 'params'}: ${first?.message ?? '参数不合法'}` }
}
