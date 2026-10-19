import { z } from 'zod'

/** 关键 RPC 的入参 schema；未列出的方法只要求 params 是对象 */
const schemas: Record<string, z.ZodTypeAny> = {
  'settings/patch': z.object({ patch: z.record(z.string(), z.unknown()) }),
  'clean/start': z
    .object({
      itemIds: z.array(z.string()).optional(),
      items: z.array(z.record(z.string(), z.unknown())).optional(),
      dryRun: z.boolean().optional(),
      forceQuarantine: z.boolean().optional(),
    })
    .refine((value) => (value.itemIds?.length ?? 0) > 0 || (value.items?.length ?? 0) > 0, {
      message: 'itemIds 与 items 至少提供一个',
    }),
  'scan/start': z.object({ taskIds: z.array(z.string()).optional() }),
  'plugins/enable': z.object({ id: z.string().min(1) }),
  'plugins/disable': z.object({ id: z.string().min(1) }),
  'plugins/config': z.object({ id: z.string().min(1), config: z.record(z.string(), z.unknown()) }),
  'plugins/install': z.object({ path: z.string().min(1) }),
  'plugins/uninstall': z.object({ id: z.string().min(1) }),
  'quarantine/restore': z.object({ ids: z.array(z.string()) }),
  'history/list': z.object({ limit: z.number().int().positive().max(1000).optional() }).optional(),
  'ai/analyze': z
    .object({
      taskIds: z.array(z.string()).optional(),
      extraContext: z.string().max(4000).optional(),
      contextProviders: z.array(z.string()).max(20).optional(),
    })
    .optional(),
  'ai/rules/dry-run': z.object({ suggestion: z.record(z.string(), z.unknown()) }),
  'ai/plugin/draft': z.object({ requirement: z.string().min(1).max(2000) }),
  'ai/plugin/validate': z.object({ code: z.string().min(1).max(200_000) }),
  'ai/plugin/install': z.object({ name: z.string().min(1).max(80), code: z.string().min(1).max(200_000) }),
  'scheduler/authorize': z.object({ everyMinutes: z.number().int().min(15).max(1440).optional(), taskIds: z.array(z.string()).optional() }),
  'app/open-path': z.object({ path: z.string().min(1) }),
  'app/open-editor': z.object({ path: z.string().min(1) }),
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
