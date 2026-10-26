/**
 * 提示词与本机画像。
 *
 * 隐私边界：画像里只有容量、占用、任务统计与「目录类别标签」，
 * **不含任何真实路径、文件名、用户名**；这一点由单元测试断言保证。
 */
import type { AiConfig } from './config.ts'

/** 发送给模型的系统画像（已脱敏） */
export interface SystemProfile {
  os: { release: string; arch: string; elevated: boolean }
  cpu: { model: string; cores: number }
  memory: { totalGb: number; freeGb: number }
  disks: Array<{ mount: string; totalGb: number; freeGb: number; usedPercent: number }>
  hotspots: Array<{ label: string; gb: number }>
  tasks: Array<{ id: string; name: string; category: string; risk: string; items: number; mb: number; elapsedMs: number }>
  topItems: Array<{ category: string; count: number; mb: number }>
  userNote?: string
}

export const DEFAULT_SYSTEM_PROMPT = `你是一名 Windows 系统清理专家，服务于一款名为 CordClean 的清理工具。
用户会给你一份**脱敏**的本机画像（只有容量、占用、任务统计，没有文件名和个人路径）。
请基于画像给出可执行的清理建议。

严格要求：
1. 只输出一个 JSON 对象，不要输出 Markdown 代码块或解释文字。
2. JSON 结构：
{
  "summary": "一段 60~120 字的中文总结，指出最值得处理的空间占用来源",
  "observations": ["其它观察，最多 4 条"],
  "suggestions": [
    {
      "title": "建议标题（不超过 16 字）",
      "reason": "为什么建议这么做（不超过 80 字，结合画像中的具体数字）",
      "taskId": "关联的内置任务 id，可为空字符串",
      "targets": ["建议的处理对象，只能是任务 id、分类名或目录类别，例如 temp / 浏览器缓存 / 开发缓存"],
      "estimatedBytes": 估算可释放字节数（整数，没有依据时填 0）,
      "confidence": 0 到 1 之间的小数,
      "risk": "safe" | "caution" | "risky"
    }
  ]
}
3. suggestions 给出 3~5 条，按可释放空间从大到小排序。
4. 不要在 targets 中出现任何真实路径、文件名或用户名。
5. 风险判断要保守：涉及系统组件、注册表、启动项的，risk 至少为 caution。
6. 用户可能在「补充说明」或截图中给出明确指令。若用户要求「只回复看到的内容」「不要分析」「看到补充说明回复」等，必须严格遵守：只回答用户要求的内容，不要输出清理建议或额外分析。`

/** 允许通过配置覆盖 system prompt（面向前沿模型/新格式） */
export function buildSystemPrompt(config: AiConfig): string {
  const custom = config.systemPrompt?.trim()
  return custom || DEFAULT_SYSTEM_PROMPT
}

/** 组装用户消息 */
export function buildUserPrompt(profile: SystemProfile, extraContext?: string): string {
  const note = extraContext?.trim() || profile.userNote
  const payload = { ...profile, userNote: note }
  return '本机画像如下（JSON）：\n' + JSON.stringify(payload, null, 2)
}
