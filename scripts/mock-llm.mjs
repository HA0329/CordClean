/**
 * 本地 Mock LLM 服务：用于开发期与自动化测试中模拟 DeepSeek 的
 * OpenAI 兼容接口（无需真实 API Key 即可演示 AI 建议界面）。
 *
 *   node scripts/mock-llm.mjs 7899
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 7899)

const reply = {
  summary:
    '本机 C 盘剩余 106 GB、D 盘剩余 157 GB，整体空间健康；可释放空间主要集中在系统临时文件、浏览器缓存与开发者包缓存三处，合计约 1.3 GB，建议优先清理这三类可重建数据。',
  observations: [
    '临时目录中约 53 MB 来自办公软件诊断日志，可安全清理',
    '开发者缓存约占 1.07 GB，删除后首次安装依赖会重新下载',
    '系统更新缓存 1.8 MB，清理后 Windows Update 会按需重新获取',
  ],
  suggestions: [
    {
      title: '清理系统临时文件',
      reason: '临时目录共发现 948 个文件、约 53 MB，其中多数为程序诊断日志，删除后不影响使用。',
      taskId: 'temp',
      targets: ['temp', '系统垃圾'],
      estimatedBytes: 55_000_000,
      confidence: 0.93,
      risk: 'safe',
    },
    {
      title: '清理开发者包缓存',
      reason: 'npm / pnpm / Gradle 等缓存合计约 1.07 GB，属于可再生成数据，适合在磁盘紧张时清理。',
      taskId: 'dev-cache',
      targets: ['dev-cache', '开发缓存'],
      estimatedBytes: 1_070_000_000,
      confidence: 0.85,
      risk: 'caution',
    },
    {
      title: '清理浏览器缓存',
      reason: 'Chrome / Edge 缓存约 234 MB，可随时重建；建议在关闭浏览器后清理以便释放更彻底。',
      taskId: 'browser-cache',
      targets: ['browser-cache', '浏览器缓存'],
      estimatedBytes: 234_000_000,
      confidence: 0.8,
      risk: 'safe',
    },
    {
      title: '检查重复文件',
      reason: '发现 11 个重复文件、合计约 44 MB，建议人工确认后再删除，避免误删仍在使用的素材。',
      taskId: 'duplicates',
      targets: ['duplicates', '磁盘空间'],
      estimatedBytes: 44_000_000,
      confidence: 0.6,
      risk: 'caution',
    },
  ],
}

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    console.log(`[mock-llm] ${req.method} ${req.url} (${body.length} bytes)`)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'mock-completion',
        model: 'deepseek-chat',
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(reply) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 512, completion_tokens: 380, total_tokens: 892 },
      }),
    )
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[mock-llm] listening on http://127.0.0.1:${port}`)
})
