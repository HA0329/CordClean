/**
 * 文档口径检查：确保 README、架构文档、论文大纲、测试设计、性能基准与
 * docs/project-facts.json 使用同一套数字和术语。
 *
 *   pnpm docs:check
 *
 * 只检查“当前口径”文档；release notes、verification、defect-log 等历史快照
 * 保留发布时数字，不在本脚本的检查范围内。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const facts = JSON.parse(read('docs/project-facts.json'))
const n = {
  plugins: facts.plugins.total,
  enabled: facts.plugins.defaultEnabled,
  tasks: facts.tasks,
  rpc: facts.rpcMethods,
  testFiles: facts.tests.files,
  testCases: facts.tests.cases,
  rules: facts.rules.totalRules,
}

const failures = []
const checked = []

function requireFile(relative) {
  checked.push(relative)
  if (!existsSync(path.join(root, relative))) {
    failures.push(`${relative}: 文件不存在`)
    return ''
  }
  return read(relative)
}

function requireText(file, text, label) {
  if (!file.includes(text)) failures.push(`${label}: 缺少 “${text}”`)
}

function forbidden(file, regex, label, description) {
  if (regex.test(file)) failures.push(`${label}: 仍包含旧口径 ${description}`)
}

/* ------------------------------------------------------------------ */
/* README                                                              */
/* ------------------------------------------------------------------ */
const readme = requireFile('README.md')
requireText(readme, '基于 Cordis 插件架构的 Windows 安全清理工具', 'README 题目')
requireText(readme, `${n.plugins} 个内置插件`, 'README 插件数')
requireText(readme, `${n.rpc} 个 RPC`, 'README RPC 数')
requireText(readme, `${n.testFiles} 个测试文件 / ${n.testCases} 个用例`, 'README 测试数')
requireText(readme, 'docs/project-facts.md', 'README 事实表链接')
forbidden(readme, /11 个内置插件|11 个清理插件/, 'README', '11 个插件')
forbidden(readme, /69 个 RPC|55 个 RPC/, 'README', '69/55 个 RPC')
forbidden(readme, /53 个测试文件|377 个用例|487 个用例/, 'README', '53/377/487 测试数')
forbidden(readme, /5\.4 ms|162\.6 ms|26 770|2 178|1\.84 s/, 'README', '旧 benchmark 数字')

/* ------------------------------------------------------------------ */
/* 架构文档                                                            */
/* ------------------------------------------------------------------ */
const architecture = requireFile('docs/architecture.md')
requireText(architecture, `${n.plugins} 个内置插件`, 'architecture 插件数')
requireText(architecture, `${n.rpc} 个 RPC 方法`, 'architecture RPC 数')
requireText(architecture, `${n.testFiles} 个测试文件 / **${n.testCases} 个用例**`, 'architecture 测试数')
requireText(architecture, 'project-facts.md', 'architecture 事实表链接')
forbidden(architecture, /55 个 RPC|69 个 RPC/, 'architecture', '55/69 个 RPC')
forbidden(architecture, /11 个插件|11 个清理插件/, 'architecture', '11 个插件')
forbidden(architecture, /487 个用例/, 'architecture', '487 个用例')
forbidden(architecture, /162\.6 ms|2 178 文件|1\.84 s/, 'architecture', '旧 benchmark 数字')

/* ------------------------------------------------------------------ */
/* 论文大纲                                                            */
/* ------------------------------------------------------------------ */
const thesis = requireFile('docs/thesis-outline.md')
requireText(thesis, '基于 Cordis 插件架构的 Windows 安全清理工具', 'thesis 题目')
requireText(thesis, `${n.plugins} 个内置插件`, 'thesis 插件数')
requireText(thesis, `${n.testCases} 个自动化用例`, 'thesis 测试数')
requireText(thesis, '六层删除安全链', 'thesis 安全模型')
requireText(thesis, 'docs/benchmark.md', 'thesis benchmark 链接')
forbidden(thesis, /11 个内置插件|11 个插件/, 'thesis', '11 个插件')
forbidden(thesis, /487 个自动化用例|487 个测试/, 'thesis', '487 个用例')
forbidden(thesis, /三层安全模型/, 'thesis', '三层安全模型')
forbidden(thesis, /5\.4 ms|162\.6 ms|26 770|2 178|1\.84 s/, 'thesis', '旧 benchmark 数字')
forbidden(thesis, /共 29 个|D-01~D-29/, 'thesis', '旧缺陷数')

/* ------------------------------------------------------------------ */
/* 测试设计                                                            */
/* ------------------------------------------------------------------ */
const testPlan = requireFile('docs/test-plan.md')
requireText(testPlan, `${n.testFiles} 个测试文件 / ${n.testCases} 个用例`, 'test-plan 测试数')
requireText(testPlan, 'docs/project-facts.md', 'test-plan 事实表链接')
forbidden(testPlan, /487 个用例/, 'test-plan', '487 个用例')

/* ------------------------------------------------------------------ */
/* 性能基准                                                            */
/* ------------------------------------------------------------------ */
const benchmark = requireFile('docs/benchmark.md')
requireText(benchmark, '本文件由 `pnpm bench` 自动生成', 'benchmark 生成标记')
requireText(benchmark, `${n.tasks} 个任务`, 'benchmark 任务数')
requireText(benchmark, 'docs/benchmark.json', 'benchmark JSON 说明')

/* ------------------------------------------------------------------ */
/* 导师简报（HTML 片段）                                               */
/* ------------------------------------------------------------------ */
const mentorHtml = []
for (const file of ['01-head.html', '02-body-a.html', '03-body-b.html', '04-body-c.html', '05-script.html']) {
  const relative = `docs/mentor-brief/${file}`
  const html = requireFile(relative)
  mentorHtml.push(html)
  forbidden(html, /487/, relative, '487')
  forbidden(html, /11 个内置插件|11 个插件|11 个\b|全部 11|显示 11 \/ 11/, relative, '11 个插件')
  forbidden(html, /55 个 RPC|55 个方法/, relative, '55 个 RPC')
  forbidden(html, /39 个清理任务|39 个任务|39 个清理能力/, relative, '39 个任务')
  forbidden(html, /271 条规则/, relative, '271 条规则')
  forbidden(html, /2591 次提交|151<small>次|14<small>个/, relative, '旧提交/缺陷数')
  forbidden(html, /5\.4 ms|162\.6 ms|26,?770|2,?178|1\.84 s|35\.9k|1\.29 ms|366 MB|132\.2 MB/, relative, '旧 benchmark 数字')
}
requireText(mentorHtml.join('\n'), `${n.testCases}`, 'mentor-brief 测试数')

/* ------------------------------------------------------------------ */
/* 开题对齐表与 benchmark JSON                                         */
/* ------------------------------------------------------------------ */
const alignment = requireFile('docs/proposal-alignment.md')
requireText(alignment, '开题报告', 'alignment 标题')
requireText(alignment, 'CleanTicket', 'alignment 术语')
requireText(alignment, 'D1', 'alignment 待补差异')

const benchmarkJson = JSON.parse(requireFile('docs/benchmark.json'))
if (!Array.isArray(benchmarkJson.rows) || benchmarkJson.rows.length === 0) {
  failures.push('docs/benchmark.json: rows 为空')
}

/* ------------------------------------------------------------------ */
/* package.json 描述                                                   */
/* ------------------------------------------------------------------ */
const pkg = JSON.parse(requireFile('package.json'))
requireText(pkg.description ?? '', '基于 Cordis 插件架构的 Windows 安全清理工具', 'package.json 描述')

if (failures.length) {
  console.error('\n文档口径检查失败：')
  for (const failure of failures) console.error('  - ' + failure)
  console.error(`\n共检查 ${checked.length} 个文件；请先运行 pnpm facts，再按 docs/project-facts.md 修改文档。`)
  process.exit(1)
}
console.log(`docs:check 通过（${checked.length} 个文件）：${n.plugins} 插件 / ${n.tasks} 任务 / ${n.rpc} RPC / ${n.testFiles} 文件 / ${n.testCases} 用例 / ${n.rules} 条规则`)
