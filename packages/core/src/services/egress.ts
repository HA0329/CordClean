/**
 * 外发出口（`ctx.egress`）—— 不变量 8。
 *
 * 所有离开本机的数据（在线 AI 分析、探测、模型列表、评估）都必须先经过这里：
 * 1. 总开关：`settings.privacy.onlineAi === false` 时一律拒绝；
 * 2. 发送前预览：保留最近几次请求体的脱敏片段，界面可查"将要发送什么"；
 * 3. 用量计数：请求数、字节数、token 数；
 * 4. 拒绝留痕：被拦截的请求同样记录。
 *
 * 注意：这里只做"放行与记账"，真正的 HTTP 仍由调用方（AI 插件）发起，
 * 目的是让"出口"成为可测试、可审计的唯一收口，而不是再造一层网络栈。
 */
import { Service, type Context } from 'cordis'
import type { EgressLike, EgressRecord } from '@cordclean/shared'

const MAX_RECORDS = 10
const PREVIEW_LIMIT = 2000

/** 去掉可能的敏感键（Key/Token），并截断 */
function buildPreview(body: unknown): string {
  if (body === undefined) return ''
  let text: string
  try {
    text = JSON.stringify(body, (key, value) => (/key|token|secret|authorization/i.test(key) ? '<redacted>' : value))
  } catch {
    text = String(body)
  }
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text
}

export class EgressService extends Service implements EgressLike {
  static inject = ['settings']

  private requests = 0
  private bytes = 0
  private tokens = 0
  private records: EgressRecord[] = []

  constructor(ctx: Context) {
    super(ctx, 'egress')
  }

  check(request: { purpose: string; url: string; body?: unknown }): { allowed: boolean; reason?: string } {
    const settings = this.ctx.settings.get()
    const preview = buildPreview(request.body)
    if (!settings.privacy.onlineAi) {
      const reason = '在线 AI 已在设置中关闭（隐私开关）'
      this.records.unshift({ at: Date.now(), purpose: request.purpose, url: request.url, bytes: 0, preview, blocked: reason })
      this.records = this.records.slice(0, MAX_RECORDS)
      this.ctx.logger.info('外发被拦截：%s（%s）', request.purpose, reason)
      return { allowed: false, reason }
    }
    const size = Buffer.byteLength(preview, 'utf8')
    this.requests++
    this.bytes += size
    this.records.unshift({ at: Date.now(), purpose: request.purpose, url: request.url, bytes: size, preview })
    this.records = this.records.slice(0, MAX_RECORDS)
    return { allowed: true }
  }

  recordUsage(usage?: { input?: number; output?: number }): void {
    this.tokens += Math.max(0, usage?.input ?? 0) + Math.max(0, usage?.output ?? 0)
  }

  stats(): { requests: number; bytes: number; tokens: number } {
    return { requests: this.requests, bytes: this.bytes, tokens: this.tokens }
  }

  preview(): EgressRecord[] {
    return [...this.records]
  }

  reset(): void {
    this.requests = 0
    this.bytes = 0
    this.tokens = 0
    this.records = []
  }
}
