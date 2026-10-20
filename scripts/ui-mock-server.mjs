/**
 * CordClean 大规模扫描结果 UI 验收工具 —— 本地 mock 服务器。
 *
 * 作用：不启动真实内核，用**固定种子生成的可复现合成扫描结果**把
 * `packages/ui/dist`（Vite 构建产物）跑起来，供 `scripts/verify-clean-ui.mjs`
 * 通过无头 Edge + CDP 做交互断言与截图。
 *
 * 与真实 host 服务器的差异（仅此三处）：
 * 1. 静态目录默认取 `packages/ui/dist`，并在 index.html 的 `<!--CORDCLEAN_BOOT-->`
 *    占位符处注入 `window.__CORDCLEAN__ = { token, wsUrl }`；
 * 2. 同一 HTTP 服务上挂 `/rpc` WebSocket，用内存里的合成数据实现界面初始化所需 RPC；
 * 3. 额外提供 `/api/ping`（就绪探测）与 `/api/mock/summary`（断言用期望值）两个调试端点。
 *
 * 用法：
 *   node scripts/ui-mock-server.mjs                       # 默认 127.0.0.1:7841，3000 条
 *   node scripts/ui-mock-server.mjs --port=7841 --items=3000 --seed=20251020
 *   node scripts/ui-mock-server.mjs --dist=packages/ui/dist
 *   node scripts/ui-mock-server.mjs --help
 *
 * 也可被 verify 脚本 import（`createFixture` 供其计算断言期望值）。
 * 环境变量：CORDCLEAN_MOCK_PORT / CORDCLEAN_MOCK_ITEMS / CORDCLEAN_MOCK_SEED /
 *          CORDCLEAN_UI_DIR（与 apps/web 一致）。
 *
 * 数据说明（默认 --items=3000）：
 * - 40 个清理任务、8 个分类（每类 5 个任务）；
 * - 约 1800 safe / 800 caution / 400 risky；约 40 条 protected；
 * - 大小覆盖 0 B ~ 3 GiB（含 0 B 与恰好 3 GiB 的边界项）；
 * - 每条都有 note / mtimeMs / meta；统一 itemId = `${taskId}:${hashString(path)}`；
 * - 固定时间基准 MOCK_NOW + 固定种子，多次运行结果完全一致。
 */
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WebSocketServer } from 'ws'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(HERE, '..')
export const DEFAULT_DIST_DIR = path.join(REPO_ROOT, 'packages', 'ui', 'dist')
export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 7841
export const DEFAULT_ITEMS = 3000
export const DEFAULT_SEED = 20251020
/** 界面通过 `wsUrl + '?token='` 连接；mock 固定令牌方便注入与校验 */
export const MOCK_TOKEN = 'mock'
/** 固定时间基准（2026-10-20T13:53:00+08:00），保证 mtime / startedAt 可复现 */
export const MOCK_NOW = Date.UTC(2026, 9, 20, 5, 53, 0)
const DAY = 86_400_000
const GIB = 1024 ** 3

/* ------------------------------------------------------------------ */
/* 分类 / 任务目录（与 packages/shared 的 CATEGORIES 顺序保持一致）        */
/* ------------------------------------------------------------------ */

const CATEGORY_ORDER = ['system', 'browser', 'privacy', 'disk', 'apps', 'startup', 'dev', 'ai']

const CATEGORY_META = {
  system: { name: '系统垃圾', color: '#4f8cff' },
  browser: { name: '浏览器', color: '#29c196' },
  privacy: { name: '隐私痕迹', color: '#a06bff' },
  disk: { name: '磁盘空间', color: '#ff9f43' },
  apps: { name: '应用残留', color: '#f06b8b' },
  startup: { name: '启动项', color: '#f5c542' },
  dev: { name: '开发缓存', color: '#3dd6d0' },
  ai: { name: 'AI 建议', color: '#6c7cff' },
}

/** [id, 名称, 描述, risk, requiresAdmin, icon, 典型扫描目标] */
// 说明：本文件是 UI 压测用的合成数据，40 个 taskId 中多数是「合成 id」以便覆盖不同分类形态；
// 已退役插件（temp/system-logs/update-cache/thumbnails，commit 43cc831）的旧 id 已改成
// 真实 rule-pack 任务 id（`rule:<categoryKey>`），避免与真实 tasks/list 数据混淆。
const TASK_BLUEPRINTS = [
  // system（0-4）
  ['rule:system_temp', '临时文件', '系统与用户临时目录中超过 7 天未修改的文件', 'safe', true, '🧹', ['C:\\Windows\\Temp', 'C:\\Users\\mock\\AppData\\Local\\Temp']],
  ['rule:system_logs', '系统日志', 'Windows 事件日志与组件日志的过期副本', 'caution', true, '📜', ['C:\\Windows\\Logs', 'C:\\Windows\\System32\\LogFiles']],
  ['rule:system_admin', 'Windows 更新缓存', '已安装更新留下的下载缓存，清理后不影响已装补丁', 'caution', true, '🪟', ['C:\\Windows\\SoftwareDistribution\\Download']],
  ['recycle', '回收站', '各磁盘回收站中等待清空的文件（清空后不可恢复）', 'safe', false, '🗑️', ['C:\\$Recycle.Bin', 'D:\\$Recycle.Bin']],
  ['rule:extra_windows', '缩略图缓存', '资源管理器为图片/视频生成的缩略图数据库', 'safe', false, '🖼️', ['C:\\Users\\mock\\AppData\\Local\\Microsoft\\Windows\\Explorer']],
  // browser（5-9）
  ['chrome-cache', 'Chrome 缓存', 'Chrome 网页缓存与代码缓存，清理后首次加载略慢', 'safe', false, '🌐', ['C:\\Users\\mock\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache']],
  ['chrome-history', 'Chrome 历史记录', 'Chrome 浏览历史数据库，属于隐私痕迹', 'caution', false, '🕘', ['C:\\Users\\mock\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\History']],
  ['edge-cache', 'Edge 缓存', 'Edge 网页缓存与 Service Worker 缓存', 'safe', false, '🧭', ['C:\\Users\\mock\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Cache']],
  ['firefox-cache', 'Firefox 缓存', 'Firefox 缓存目录与离线页面副本', 'safe', false, '🦊', ['C:\\Users\\mock\\AppData\\Local\\Mozilla\\Firefox\\Profiles']],
  ['download-history', '浏览器下载记录', '浏览器下载历史与已失效的下载条目', 'caution', false, '⬇️', ['C:\\Users\\mock\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Download Metadata']],
  // privacy（10-14）
  ['recent-docs', '最近文档', '最近打开文件列表，属于使用痕迹', 'caution', false, '📄', ['C:\\Users\\mock\\AppData\\Roaming\\Microsoft\\Windows\\Recent']],
  ['clipboard-history', '剪贴板历史', 'Windows 剪贴板历史与固定条目', 'caution', false, '📋', ['C:\\Users\\mock\\AppData\\Local\\Microsoft\\Windows\\Clipboard']],
  ['run-history', '运行历史', 'Win+R 运行对话框的历史记录', 'caution', false, '⌨️', ['C:\\Users\\mock\\AppData\\Roaming\\Microsoft\\Windows\\Recent']],
  ['search-history', '搜索历史', '任务栏搜索与开始菜单的搜索记录', 'caution', false, '🔍', ['C:\\Users\\mock\\AppData\\Local\\Packages\\Microsoft.Windows.Search']],
  ['credential-cache', '凭据缓存', '系统与应用缓存的登录凭据（需显式授权）', 'risky', true, '🔐', ['C:\\Users\\mock\\AppData\\Local\\Microsoft\\Credentials']],
  // disk（15-19）
  ['large-files', '大文件', '用户目录下超过 1 GB 且 90 天未访问的大文件', 'caution', false, '🐘', ['C:\\Users\\mock\\Downloads', 'D:\\Backups']],
  ['duplicate-files', '重复文件', '内容哈希相同的重复文件（保留一份）', 'caution', false, '🧬', ['C:\\Users\\mock\\Documents', 'D:\\Media']],
  ['empty-dirs', '空目录', '长期存在的空目录，清理后目录结构更整洁', 'safe', false, '📁', ['C:\\Users\\mock\\Projects', 'D:\\Work']],
  ['old-installers', '旧安装包', '已安装软件的旧版本安装包与校验文件', 'caution', false, '📦', ['C:\\Users\\mock\\Downloads\\Installers']],
  ['downloads-folder', '下载文件夹', '下载目录中 30 天未变化的文件', 'risky', false, '📥', ['C:\\Users\\mock\\Downloads']],
  // apps（20-24）
  ['app-caches', '应用缓存', '常见桌面应用产生的可重建缓存', 'safe', false, '🧱', ['C:\\Users\\mock\\AppData\\Local\\Packages']],
  ['crash-dumps', '崩溃转储', '应用崩溃时生成的 dump 与错误报告', 'safe', false, '💥', ['C:\\Users\\mock\\AppData\\Local\\CrashDumps']],
  ['app-logs', '应用日志', '应用运行日志的滚动副本', 'safe', false, '🧾', ['C:\\Users\\mock\\AppData\\Local\\Temp\\Logs']],
  ['update-leftovers', '更新残留', '应用自动更新下载后遗留的安装缓存', 'caution', false, '🔄', ['C:\\Users\\mock\\AppData\\Local\\Temp\\Updates']],
  ['uninstall-leftovers', '卸载残留', '已卸载应用留下的配置与缓存目录', 'caution', false, '🧽', ['C:\\ProgramData\\Package Cache']],
  // startup（25-29）
  ['startup-entries', '启动项', '开机自启的第三方程序注册项', 'risky', false, '🚀', ['C:\\Users\\mock\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup']],
  ['scheduled-tasks', '计划任务', '第三方软件创建且长期未触发的计划任务', 'risky', true, '⏰', ['C:\\Windows\\System32\\Tasks']],
  ['boot-cache', '开机缓存', '系统启动时生成的预读缓存，可自动重建', 'safe', false, '⚡', ['C:\\Windows\\Prefetch']],
  ['broken-shortcuts', '失效快捷方式', '指向已不存在目标的快捷方式', 'safe', false, '🔗', ['C:\\Users\\mock\\Desktop', 'C:\\Users\\mock\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu']],
  ['delayed-startup', '延迟启动项', '延迟启动队列中的过期条目', 'caution', false, '🕰️', ['C:\\Users\\mock\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu']],
  // dev（30-34）
  ['npm-cache', 'npm 缓存', 'npm 全局缓存（_cacache）中的压缩包', 'safe', false, '📗', ['C:\\Users\\mock\\AppData\\Local\\npm-cache']],
  ['pnpm-store', 'pnpm 存储', 'pnpm 内容寻址存储中的历史版本文件', 'safe', false, '📘', ['C:\\Users\\mock\\AppData\\Local\\pnpm\\store']],
  ['yarn-cache', 'Yarn 缓存', 'Yarn 全局缓存与离线镜像', 'safe', false, '📙', ['C:\\Users\\mock\\AppData\\Local\\Yarn\\Cache']],
  ['docker-cache', 'Docker 缓存', 'Docker 构建缓存与悬空镜像层', 'caution', true, '🐳', ['C:\\ProgramData\\Docker']],
  ['build-artifacts', '构建产物', '本地项目中的 esbuild/vite 构建缓存与临时产物', 'safe', false, '🏗️', ['C:\\Users\\mock\\Projects']],
  // ai（35-39）
  ['ai-sessions', 'AI 会话缓存', 'AI 清理顾问的历史会话与上下文快照', 'caution', false, '🤖', ['C:\\Users\\mock\\AppData\\Local\\CordClean\\ai-sessions']],
  ['vector-index', '向量索引', 'AI 检索使用的本地向量索引（可重建）', 'safe', false, '🧠', ['C:\\Users\\mock\\AppData\\Local\\CordClean\\vector']],
  ['model-cache', '模型缓存', '本地模型下载缓存与分片文件', 'caution', false, '🛰️', ['C:\\Users\\mock\\AppData\\Local\\CordClean\\models']],
  ['prompt-history', '提示词历史', '输入过的提示词与附件元数据', 'caution', false, '💬', ['C:\\Users\\mock\\AppData\\Local\\CordClean\\prompts']],
  ['ai-temp', 'AI 临时数据', 'AI 分析过程中产生的临时文件与推理草稿', 'risky', false, '✨', ['C:\\Users\\mock\\AppData\\Local\\CordClean\\tmp']],
]

/** 各分类典型的文件扩展名 / 目录名前缀，让合成路径看起来像真的 */
const CATEGORY_FILE_EXTS = {
  system: ['tmp', 'log', 'etl', 'dmp', 'old'],
  browser: ['cache', 'dat', 'bin', 'json', 'sqlite'],
  privacy: ['tmp', 'log', 'json', 'bin', 'dat'],
  disk: ['iso', 'msi', 'zip', '7z', 'exe'],
  apps: ['dmp', 'log', 'tmp', 'bak', 'old'],
  startup: ['lnk', 'task', 'xml', 'reg', 'dat'],
  dev: ['tgz', 'tar', 'bin', 'pack', 'cache'],
  ai: ['json', 'bin', 'db', 'tmp', 'log'],
}

/* ------------------------------------------------------------------ */
/* 可复现随机数 / 工具函数                                                */
/* ------------------------------------------------------------------ */

/** mulberry32：固定种子的 32 位 PRNG，跨平台结果一致 */
export function createRng(seed) {
  let state = seed >>> 0
  return function rng() {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** FNV-1a 32 位哈希（与 packages/shared 的 hashString 完全一致） */
export function hashString(input) {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 与 packages/shared 的 itemId 一致 */
export function itemId(taskId, itemPath) {
  return `${taskId}:${hashString(itemPath)}`
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/** 与 packages/shared 的 formatBytes 一致（断言数据展示时复用） */
export function formatBytes(bytes, digits = 1) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  const fixed = unit === 0 ? String(Math.round(value)) : value.toFixed(digits)
  return `${Number(fixed)} ${UNITS[unit]}`
}

function shuffle(list, rng) {
  for (let index = list.length - 1; index > 0; index--) {
    const swap = Math.floor(rng() * (index + 1))
    ;[list[index], list[swap]] = [list[swap], list[index]]
  }
  return list
}

/* ------------------------------------------------------------------ */
/* 合成数据工厂                                                          */
/* ------------------------------------------------------------------ */

function buildTasks() {
  const tasks = []
  let page = 0
  for (const category of CATEGORY_ORDER) {
    for (let slot = 0; slot < 5; slot++, page++) {
      const [id, name, description, risk, requiresAdmin, icon, targets] = TASK_BLUEPRINTS[page]
      tasks.push({
        id,
        pluginId: `mock-${category}`,
        name,
        description,
        category,
        risk,
        icon,
        requiresAdmin,
        defaultSelected: risk === 'safe',
        targets: [...targets],
        tips: [
          `mock 合成任务：${description}`,
          risk === 'risky' ? '高风险任务：批量选择时永远不推荐，需要逐项确认' : '可通过分组视图整组勾选',
        ],
        estimatedMs: 600 + page * 37,
        /** 归一化到该任务的第几个（供 protected 分配使用），非协议字段，仅生成时使用 */
        _slot: slot,
      })
    }
  }
  return tasks
}

function riskNote(risk) {
  switch (risk) {
    case 'safe':
      return '属于可安全清理的缓存 / 临时数据，删除后由应用自动重建。'
    case 'caution':
      return '请确认后清理：该项可能影响最近的使用记录或下一次启动速度。'
    default:
      return '高风险项：清理时强制放入隔离区，可在「历史与隔离区」中恢复。'
  }
}

function taskBaseFolder(task) {
  const base = task.targets[0] ?? 'C:\\Users\\mock\\AppData\\Local\\Temp'
  return `${base}\\${task.id}`
}

/** 大小分布：多数是小碎文件，少量大文件；额外保证 0 B 与 3 GiB 边界项 */
function pickSize(index, rng) {
  if (index === 0) return 0
  if (index === 7) return 3 * GIB
  const roll = rng()
  if (roll < 0.03) return 0
  const bucket = rng()
  if (bucket < 0.82) return 1024 + Math.floor(rng() * (1024 * 1024 - 1024))
  if (bucket < 0.96) return 1024 * 1024 + Math.floor(rng() * (50 * 1024 * 1024 - 1024 * 1024))
  if (bucket < 0.995) return 50 * 1024 * 1024 + Math.floor(rng() * (500 * 1024 * 1024 - 50 * 1024 * 1024))
  return Math.floor(500 * 1024 * 1024 + rng() * (3 * GIB - 500 * 1024 * 1024))
}

function buildItems(tasks, requestedItems, seed) {
  const rng = createRng(seed)
  const itemCount = Math.max(tasks.length, Math.floor(requestedItems))
  const taskCount = tasks.length
  const perTask = Math.floor(itemCount / taskCount)
  const remainder = itemCount % taskCount
  const protectedTotal = Math.max(1, Math.round((itemCount / DEFAULT_ITEMS) * tasks.length))
  const items = []
  let globalIndex = 0

  for (let taskIndex = 0; taskIndex < taskCount; taskIndex++) {
    const task = tasks[taskIndex]
    const taskItems = perTask + (taskIndex < remainder ? 1 : 0)
    const safeCount = Math.round(taskItems * 0.6)
    const riskyCount = Math.round(taskItems * (400 / DEFAULT_ITEMS))
    const cautionCount = taskItems - safeCount - riskyCount
    const riskLabels = shuffle(
      [
        ...Array.from({ length: safeCount }, () => 'safe'),
        ...Array.from({ length: Math.max(0, cautionCount) }, () => 'caution'),
        ...Array.from({ length: Math.max(0, riskyCount) }, () => 'risky'),
      ],
      rng,
    )
    const exts = CATEGORY_FILE_EXTS[task.category]
    const folder = taskBaseFolder(task)
    // 每个分类里第 0/1/2 个任务保护 safe 项，第 3 个保护 caution 项，第 4 个保护 risky 项
    // → 默认 3000 条时恰好 40 条 protected（每任务 1 条，8 类 × 5 任务），且 8 类都含保护项
    const protectedRisk = ['safe', 'safe', 'safe', 'caution', 'risky'][task._slot]
    let protectedAssigned = false
    const wantProtected = taskIndex < protectedTotal

    for (let localIndex = 0; localIndex < taskItems; localIndex++) {
      const risk = riskLabels[localIndex]
      const isDirectory = globalIndex % 13 === 0
      const ext = exts[globalIndex % exts.length]
      const filename = isDirectory
        ? `${task.id}-cache-${String(globalIndex).padStart(5, '0')}`
        : `${task.id}-${String(globalIndex).padStart(5, '0')}.${ext}`
      const depth = 1 + (globalIndex % 4)
      const itemPath =
        task.category === 'disk'
          ? `${task.targets[globalIndex % Math.max(1, task.targets.length)]}\\${task.id}\\${filename}`
          : `${folder}\\${'sub\\'.repeat(depth)}${filename}`
      const item = {
        id: itemId(task.id, itemPath),
        taskId: task.id,
        title: filename,
        path: itemPath,
        kind: isDirectory ? 'directory' : 'file',
        size: pickSize(globalIndex, rng),
        mtimeMs: MOCK_NOW - Math.floor(rng() * 730 * DAY),
        risk,
        category: task.category,
        defaultSelected: risk === 'safe',
        meta: {
          ruleId: `${task.id}-rule-${String(1 + (globalIndex % 5)).padStart(2, '0')}`,
          pluginId: task.pluginId,
          taskId: task.id,
          category: task.category,
          depth,
          lastAccessDays: Math.floor(rng() * 365),
          source: 'ui-mock-server',
          tags: [task.category, risk],
        },
        note: riskNote(risk),
      }
      if (wantProtected && !protectedAssigned && risk === protectedRisk) {
        protectedAssigned = true
        item.protected = true
        item.defaultSelected = false
        item.note = `受保护：命中系统关键目录策略，界面中不可勾选。${riskNote(risk)}`
      }
      items.push(item)
      globalIndex++
    }

    // 兜底：任务内没有目标风险（只可能出现在 --items 很小的场景），保护第一条
    if (wantProtected && !protectedAssigned && items.length) {
      const fallback = items[items.length - 1]
      fallback.protected = true
      fallback.defaultSelected = false
      fallback.note = `受保护：命中系统关键目录策略，界面中不可勾选。${riskNote(fallback.risk)}`
    }
  }

  return items
}

function buildReport(items, tasks) {
  const taskMap = new Map()
  for (const item of items) {
    const current = taskMap.get(item.taskId) ?? { items: 0, bytes: 0 }
    current.items++
    current.bytes += item.size
    taskMap.set(item.taskId, current)
  }
  const bytes = items.reduce((sum, item) => sum + item.size, 0)
  const files = items.filter((item) => item.kind === 'file').length
  const dirs = items.filter((item) => item.kind === 'directory').length
  const taskResults = tasks
    .filter((task) => taskMap.has(task.id))
    .map((task, index) => ({
      taskId: task.id,
      status: 'ok',
      items: taskMap.get(task.id).items,
      bytes: taskMap.get(task.id).bytes,
      elapsedMs: 180 + ((index * 137) % 1_400),
    }))
  return {
    scanId: 'mock-scan-' + String(items.length),
    startedAt: MOCK_NOW - 61_234,
    elapsedMs: 61_234,
    items,
    stats: { files, dirs, bytes, errors: 0, truncated: false },
    errors: [],
    tasks: taskResults,
    cancelled: false,
  }
}

/** 统计分组 / 推荐策略的期望值，供 verify 脚本断言使用（与界面无关，纯数据） */
function summarize(report, tasks) {
  const riskCounts = { safe: 0, caution: 0, risky: 0 }
  let totalBytes = 0
  let protectedCount = 0
  let nonProtectedCount = 0
  let nonProtectedBytes = 0
  const recommend = { count: 0, bytes: 0 }
  const perTask = new Map()
  const perCategory = new Map()

  for (const task of tasks) {
    perTask.set(task.id, {
      taskId: task.id,
      name: task.name,
      category: task.category,
      declaredRisk: task.risk,
      count: 0,
      bytes: 0,
      riskCounts: { safe: 0, caution: 0, risky: 0 },
      protectedCount: 0,
      nonProtectedCount: 0,
      nonProtectedBytes: 0,
      safeNonProtectedCount: 0,
      safeNonProtectedBytes: 0,
      cautionNonProtectedCount: 0,
      cautionNonProtectedBytes: 0,
      riskyNonProtectedCount: 0,
      riskyNonProtectedBytes: 0,
      recommendCount: 0,
      recommendBytes: 0,
    })
  }
  for (const category of CATEGORY_ORDER) {
    perCategory.set(category, {
      category,
      name: CATEGORY_META[category].name,
      color: CATEGORY_META[category].color,
      count: 0,
      bytes: 0,
      riskCounts: { safe: 0, caution: 0, risky: 0 },
      protectedCount: 0,
      nonProtectedCount: 0,
      nonProtectedBytes: 0,
      safeNonProtectedCount: 0,
      safeNonProtectedBytes: 0,
      cautionNonProtectedCount: 0,
      cautionNonProtectedBytes: 0,
      riskyNonProtectedCount: 0,
      riskyNonProtectedBytes: 0,
      recommendCount: 0,
      recommendBytes: 0,
    })
  }

  for (const item of report.items) {
    riskCounts[item.risk]++
    totalBytes += item.size
    const taskStat = perTask.get(item.taskId)
    const categoryStat = perCategory.get(item.category)
    for (const stat of [taskStat, categoryStat]) {
      if (!stat) continue
      stat.count++
      stat.bytes += item.size
      stat.riskCounts[item.risk]++
    }
    if (item.protected) {
      protectedCount++
      taskStat && taskStat.protectedCount++
      categoryStat && categoryStat.protectedCount++
      continue
    }
    nonProtectedCount++
    nonProtectedBytes += item.size
    for (const stat of [taskStat, categoryStat]) {
      if (!stat) continue
      stat.nonProtectedCount++
      stat.nonProtectedBytes += item.size
    }
    const key = `${item.risk}NonProtected`
    taskStat[key + 'Count']++
    taskStat[key + 'Bytes'] += item.size
    categoryStat[key + 'Count']++
    categoryStat[key + 'Bytes'] += item.size
    // 默认推荐策略（与 docs/scan-selection-design.md 3.2 一致）：safe 且未受保护
    if (item.risk === 'safe') {
      recommend.count++
      recommend.bytes += item.size
      taskStat.recommendCount++
      taskStat.recommendBytes += item.size
      categoryStat.recommendCount++
      categoryStat.recommendBytes += item.size
    }
  }

  const totals = { safe: 0, caution: 0, risky: 0 }
  for (const stat of perTask.values()) {
    totals.safe += stat.safeNonProtectedCount
    totals.caution += stat.cautionNonProtectedCount
    totals.risky += stat.riskyNonProtectedCount
  }

  return {
    items: report.items.length,
    tasks: tasks.length,
    totalBytes,
    riskCounts,
    protectedCount,
    nonProtectedCount,
    nonProtectedBytes,
    safeNonProtectedCount: totals.safe,
    cautionNonProtectedCount: totals.caution,
    riskyNonProtectedCount: totals.risky,
    recommend,
    pageSizeDefault: 100,
    perTask: [...perTask.values()],
    perCategory: [...perCategory.values()],
  }
}

const SETTINGS = {
  privacy: { onlineAi: false },
  quarantine: { enabled: true, maxBytes: 20 * GIB, maxFiles: 20_000, retentionDays: 30 },
  scan: {
    concurrency: 4,
    maxItemsPerTask: 5_000,
    maxEntriesPerTask: 200_000,
    maxDepth: 8,
    largeFileThreshold: 1024 ** 3,
    duplicateMinSize: 1024 * 1024,
    duplicateMaxCandidates: 500,
  },
  clean: {
    dryRunDefault: false,
    confirmRisky: true,
    retries: 2,
    mode: 'recycle',
    highRiskQuarantine: true,
    quarantineFallback: true,
    budget: { maxFiles: 5_000, maxBytes: 5 * GIB },
  },
  rules: { includeRisky: false, includeDeep: true, includeCustom: true, custom: [] },
  analysis: {
    roots: ['C:\\Users\\mock'],
    includeSystem: true,
    excludes: ['C:\\Windows\\System32', 'C:\\Windows\\WinSxS'],
  },
  plugins: {},
  scheduler: { lastRuns: {} },
  ui: { theme: 'light', lastPage: 'clean', editorCommand: '' },
  version: 1,
}

function buildSystemInfo() {
  const disks = [
    { mount: 'C:', label: 'System', filesystem: 'NTFS', total: 512 * GIB, free: 86 * GIB, used: 426 * GIB },
    { mount: 'D:', label: 'Data', filesystem: 'NTFS', total: 1024 * GIB, free: 640 * GIB, used: 384 * GIB },
  ]
  return {
    platform: 'win32',
    release: '10.0.26100',
    arch: 'x64',
    hostname: 'CORDCLEAN-MOCK',
    cpuModel: 'Mock 8-Core CPU @ 3.60GHz',
    cpuCores: 8,
    memoryTotal: 32 * GIB,
    memoryFree: 12 * GIB,
    uptimeSeconds: 123_456,
    nodeVersion: process.version,
    elevated: false,
    username: 'mock',
    disks,
    hotspots: [
      { label: '用户目录', path: 'C:\\Users\\mock', bytes: 42 * GIB },
      { label: '临时目录', path: 'C:\\Users\\mock\\AppData\\Local\\Temp', bytes: 6 * GIB },
      { label: '下载目录', path: 'C:\\Users\\mock\\Downloads', bytes: 9 * GIB },
    ],
    collectedAt: MOCK_NOW,
  }
}

function buildPlugins(tasks) {
  return CATEGORY_ORDER.map((category) => {
    const categoryTasks = tasks.filter((task) => task.category === category)
    return {
      id: `mock-${category}`,
      name: `${CATEGORY_META[category].name}清理`,
      description: `mock 合成插件：提供 ${categoryTasks.length} 个${CATEGORY_META[category].name}相关清理任务`,
      category,
      source: 'builtin',
      version: '1.0.0-mock',
      taskCount: categoryTasks.length,
      status: 'active',
      enabled: true,
      tasks: categoryTasks.map((task) => ({ id: task.id, name: task.name, risk: task.risk, description: task.description })),
      config: {},
      configurable: true,
    }
  })
}

function buildHistory() {
  return [0, 1, 2].map((index) => ({
    sessionId: `mock-session-${index + 1}`,
    startedAt: MOCK_NOW - (index + 1) * DAY,
    elapsedMs: 3_200 + index * 800,
    taskIds: ['rule:system_temp', 'rule:web_cache', 'rule:dev_caches'],
    freedBytes: (index + 1) * 1.5 * GIB,
    recycledBytes: 0,
    quarantinedBytes: index * 220 * 1024 * 1024,
    cleaned: 120 + index * 40,
    quarantined: 6 + index * 3,
    vanished: 0,
    skipped: 0,
    failed: 1,
    dryRun: false,
  }))
}

/* ------------------------------------------------------------------ */
/* fixture / RPC 实现                                                   */
/* ------------------------------------------------------------------ */

/**
 * 生成完整 fixture（任务、合成报告、期望统计、其余 RPC 返回值）。
 * 同一组参数多次调用结果完全一致（固定种子 + 固定时间基准）。
 */
export function createFixture(options = {}) {
  const items = Math.max(1, Number(options.items ?? DEFAULT_ITEMS) || DEFAULT_ITEMS)
  const seed = Number(options.seed ?? DEFAULT_SEED) >>> 0
  const tasks = buildTasks()
  const cleanTasks = tasks.map(({ _slot, ...task }) => task)
  const report = buildReport(buildItems(tasks, items, seed), cleanTasks)
  const summary = summarize(report, cleanTasks)
  return {
    options: { items: report.items.length, seed },
    tasks: cleanTasks,
    plugins: buildPlugins(cleanTasks),
    report,
    summary,
    settings: SETTINGS,
    systemInfo: buildSystemInfo(),
    history: buildHistory(),
  }
}

const RPC_ERRORS = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INTERNAL: -32603,
}

/** 为 UI 初始化与清理流程提供 RPC 实现；未实现的方法统一 -32601 */
export function createRpcHandlers(fixture) {
  const state = { lastClean: null }
  const handlers = {
    /* ---------------- 初始化（store.init 需要的 9 个 + 后续 2 个） ---------------- */
    'app/info': () => ({
      name: 'CordClean',
      version: '0.2.0',
      node: process.version,
      platform: 'win32',
      dataDir: 'C:\\Users\\mock\\AppData\\Local\\CordClean',
      elevated: false,
      bootMs: 42,
      protocolVersion: 1,
    }),
    'system/info': () => fixture.systemInfo,
    'tasks/list': () => fixture.tasks,
    'plugins/list': () => fixture.plugins,
    'settings/get': () => fixture.settings,
    'history/totals': () => ({ sessions: 5, freedBytes: 12.4 * GIB, cleaned: 1_234 }),
    'history/list': () => fixture.history,
    'ai/status': () => ({
      contextAvailable: [],
      contextUsed: [],
      available: false,
      configured: false,
      shape: 'chat',
      baseUrl: '',
      model: '',
      effort: 'auto',
      jsonMode: 'auto',
      models: [],
    }),
    'ai/last': () => null,
    'quarantine/list': () => [],
    'quarantine/stats': () => ({ count: 0, bytes: 0 }),

    /* ---------------- 扫描 ---------------- */
    'scan/last': () => fixture.report,
    'scan/start': () => fixture.report,
    'scan/cancel': () => null,

    /* ---------------- 清理 ---------------- */
    'clean/start': (params = {}) => {
      const requestedIds = new Set(
        Array.isArray(params.itemIds)
          ? params.itemIds
          : Array.isArray(params.items)
            ? params.items.map((item) => item?.id).filter(Boolean)
            : [],
      )
      const picked = fixture.report.items.filter((item) => requestedIds.has(item.id))
      const dryRun = params.dryRun === true
      const hasWarnOrRisky = picked.some((item) => item.risk !== 'safe')
      const mode = dryRun ? 'delete' : hasWarnOrRisky || params.forceQuarantine ? 'quarantine' : 'recycle'
      const bytes = picked.reduce((sum, item) => sum + item.size, 0)
      const perTaskMap = new Map()
      for (const item of picked) {
        const current = perTaskMap.get(item.taskId) ?? { taskId: item.taskId, cleaned: 0, bytes: 0, failed: 0 }
        current.cleaned++
        current.bytes += item.size
        perTaskMap.set(item.taskId, current)
      }
      const report = {
        sessionId: `mock-clean-${state.lastClean ? 2 : 1}`,
        mode,
        taskIds: [...new Set(picked.map((item) => item.taskId))],
        dryRun,
        startedAt: MOCK_NOW,
        elapsedMs: 1_200 + picked.length,
        freedBytes: mode === 'delete' || mode === 'recycle' ? bytes : 0,
        recycledBytes: mode === 'recycle' ? bytes : 0,
        quarantinedBytes: mode === 'quarantine' ? bytes : 0,
        cleaned: dryRun ? 0 : picked.filter((item) => item.risk === 'safe').length,
        quarantined: dryRun ? 0 : picked.filter((item) => item.risk !== 'safe').length,
        vanished: 0,
        skipped: 0,
        failed: 0,
        cancelled: false,
        perTask: [...perTaskMap.values()],
        failures: [],
        undo: picked
          .filter((item) => item.risk === 'safe')
          .map((item) => ({ path: item.path, mode, action: mode === 'quarantine' ? 'restore' : 'recycle' })),
      }
      state.lastClean = report
      return report
    },
    'clean/cancel': () => null,
    'clean/undo-state': () => ({
      available: Boolean(state.lastClean),
      at: state.lastClean?.startedAt,
      quarantine: state.lastClean?.quarantined ?? 0,
      recycle: state.lastClean?.recycledBytes ? state.lastClean.cleaned : 0,
      permanent: 0,
    }),
    'clean/undo': () => ({ restored: 0, recyclePending: 0, permanent: 0, failed: 0 }),

    /* ---------------- 其它界面可能顺手调用的方法（避免额外报错） ---------------- */
    'app/open-path': () => null,
    'app/open-data-dir': () => 'C:\\Users\\mock\\AppData\\Local\\CordClean',
    'app/logs/recent': () => ({ lines: ['[mock] CordClean mock server ready', '[mock] 合成扫描数据已加载'] }),
    'app/logs/open': () => null,
    'app/logs/export': () => ({ path: 'C:\\Users\\mock\\AppData\\Local\\CordClean\\diagnostics.zip' }),
    'app/quit': () => ({ ok: true }),
    'system/hotspots': () => fixture.systemInfo.hotspots,
    'history/sessions': () => [],
    'history/clear': () => null,
    'quarantine/restore': () => ({ restored: 0, failed: [] }),
    'quarantine/purge': () => 0,
    'ai/models': () => ({ source: 'fallback', models: [] }),
    'ai/probe': () => ({ ok: false, latencyMs: 0, model: '', shape: 'chat', status: 0, text: '', error: 'mock 不连接真实模型' }),
    'ai/egress': () => ({ stats: { requests: 0, bytes: 0, tokens: 0 }, records: [] }),
    'ai/egress/clear': () => ({ ok: true }),
    'files/move': () => ({ moved: [], failed: [], freedBytes: 0 }),
  }
  return handlers
}

/* ------------------------------------------------------------------ */
/* HTTP + WebSocket 服务                                                */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

function bootScript(host, port) {
  const boot = {
    token: MOCK_TOKEN,
    wsUrl: `ws://${host}:${port}/rpc`,
    version: '0.2.0-mock',
  }
  return `<script>window.__CORDCLEAN__=${JSON.stringify(boot)}</script>`
}

function injectBoot(html, host, port) {
  const script = bootScript(host, port)
  if (html.includes('<!--CORDCLEAN_BOOT-->')) return html.replace('<!--CORDCLEAN_BOOT-->', script)
  if (html.includes('</head>')) return html.replace('</head>', `  ${script}\n  </head>`)
  return script + html
}

function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/**
 * 启动 mock 服务器。
 * @param {object} [options]
 * @param {number} [options.port] 0 表示随机端口
 * @param {string} [options.host]
 * @param {number} [options.items] 合成 CleanItem 条数
 * @param {number} [options.seed] 随机种子
 * @param {string} [options.distDir] 静态目录（默认 packages/ui/dist）
 */
export async function startMockServer(options = {}) {
  const host = options.host ?? DEFAULT_HOST
  const items = Number(options.items ?? DEFAULT_ITEMS) || DEFAULT_ITEMS
  const seed = Number(options.seed ?? DEFAULT_SEED) >>> 0
  const distDir = path.resolve(options.distDir ?? DEFAULT_DIST_DIR)
  if (!existsSync(path.join(distDir, 'index.html'))) {
    throw new Error(`找不到界面构建产物：${path.join(distDir, 'index.html')}（请先运行 pnpm build:ui）`)
  }

  const fixture = createFixture({ items, seed })
  const handlers = createRpcHandlers(fixture)
  const startedAt = Date.now()
  let port = Number(options.port ?? DEFAULT_PORT)

  const dispatch = async (request) => {
    if (!request || typeof request !== 'object' || typeof request.method !== 'string' || request.jsonrpc !== '2.0') {
      return { jsonrpc: '2.0', id: request?.id ?? null, error: { code: RPC_ERRORS.INVALID_REQUEST, message: '无效的 JSON-RPC 请求' } }
    }
    const handler = handlers[request.method]
    if (!handler) {
      return { jsonrpc: '2.0', id: request.id ?? null, error: { code: RPC_ERRORS.METHOD_NOT_FOUND, message: `未知方法：${request.method}` } }
    }
    try {
      const result = await handler(request.params)
      return { jsonrpc: '2.0', id: request.id ?? null, result: result ?? null }
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id: request.id ?? null,
        error: { code: RPC_ERRORS.INTERNAL, message: error instanceof Error ? error.message : String(error) },
      }
    }
  }

  const clients = new Set()
  const indexFile = path.join(distDir, 'index.html')
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`)
      try {
        if (url.pathname === '/api/ping') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(
            JSON.stringify({
              ok: true,
              name: 'CordClean mock server',
              port,
              url: `http://${host}:${port}/`,
              wsUrl: `ws://${host}:${port}/rpc`,
              items: fixture.report.items.length,
              tasks: fixture.tasks.length,
              uptimeMs: Date.now() - startedAt,
            }),
          )
          return
        }
        if (url.pathname === '/api/mock/summary') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(JSON.stringify(fixture.summary))
          return
        }
        if (url.pathname === '/api/rpc' && req.method === 'POST') {
          try {
            const request = await readJsonBody(req)
            const response = await dispatch(request)
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(response))
          } catch (error) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: RPC_ERRORS.PARSE, message: String(error?.message ?? error) } }))
          }
          return
        }
        if (url.pathname === '/favicon.ico') {
          res.writeHead(204).end()
          return
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405).end('Method Not Allowed')
          return
        }

        // ---- 静态资源（Vite 产物；SPA 回退到 index.html） ----
        const pathname = decodeURIComponent(url.pathname)
        const base = path.resolve(distDir)
        const resolved = path.resolve(base, '.' + (pathname === '/' ? '/index.html' : pathname))
        if (resolved !== base && !resolved.startsWith(base + path.sep)) {
          res.writeHead(403).end('Forbidden')
          return
        }
        let target = resolved
        try {
          const info = await stat(target)
          if (info.isDirectory()) target = path.join(target, 'index.html')
          else if (!info.isFile()) target = indexFile
        } catch {
          target = indexFile
        }
        let content
        try {
          content = await readFile(target)
        } catch {
          res.writeHead(404).end('Not Found')
          return
        }
        if (target === indexFile) content = Buffer.from(injectBoot(content.toString('utf8'), host, port), 'utf8')
        const type = MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream'
        res.writeHead(200, {
          'Content-Type': type,
          'Cache-Control': 'no-store',
          'Cross-Origin-Opener-Policy': 'same-origin',
        })
        if (req.method === 'HEAD') res.end()
        else res.end(content)
      } catch (error) {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('mock server error: ' + (error instanceof Error ? error.message : String(error)))
      }
    })()
  })

  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`)
    if (url.pathname !== '/rpc') {
      socket.destroy()
      return
    }
    if (url.searchParams.get('token') !== MOCK_TOKEN) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (socketClient) => wss.emit('connection', socketClient, req))
  })

  wss.on('connection', (socket) => {
    clients.add(socket)
    socket.on('close', () => clients.delete(socket))
    socket.on('error', () => clients.delete(socket))
    socket.on('message', (raw) => {
      void (async () => {
        let request
        try {
          request = JSON.parse(String(raw))
        } catch {
          socket.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: RPC_ERRORS.PARSE, message: 'JSON 解析失败' } }))
          return
        }
        const response = await dispatch(request)
        try {
          socket.send(JSON.stringify(response))
        } catch {
          /* 客户端已断开，忽略 */
        }
      })()
    })
  })

  port = await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : port)
    })
  })

  const close = async () => {
    for (const socket of clients) {
      try {
        socket.terminate()
      } catch {
        /* ignore */
      }
    }
    clients.clear()
    wss.close()
    await new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }

  return {
    port,
    host,
    url: `http://${host}:${port}/`,
    wsUrl: `ws://${host}:${port}/rpc`,
    token: MOCK_TOKEN,
    fixture,
    close,
  }
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const options = {}
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg)
    if (!match) continue
    const [, rawKey, rawValue] = match
    const key = rawKey.trim()
    const value = rawValue?.trim()
    if (key === 'help' || key === 'h') options.help = true
    else if (key === 'port') options.port = Number(value)
    else if (key === 'items') options.items = Number(value)
    else if (key === 'seed') options.seed = Number(value)
    else if (key === 'dist') options.dist = value
    else if (key === 'host') options.host = value
    else options.unknown = [...(options.unknown ?? []), arg]
  }
  return options
}

function printUsage() {
  console.log(
    [
      'CordClean UI 验收 mock 服务器',
      '',
      '用法：node scripts/ui-mock-server.mjs [选项]',
      '',
      '选项：',
      `  --port=<端口>    监听端口，默认 ${DEFAULT_PORT}`,
      `  --items=<条数>   合成 CleanItem 条数，默认 ${DEFAULT_ITEMS}`,
      `  --seed=<整数>    随机种子，默认 ${DEFAULT_SEED}`,
      '  --dist=<目录>    界面静态目录，默认 packages/ui/dist',
      `  --host=<地址>    监听地址，默认 ${DEFAULT_HOST}`,
      '  --help           显示本帮助',
      '',
      '环境变量：CORDCLEAN_MOCK_PORT / CORDCLEAN_MOCK_ITEMS / CORDCLEAN_MOCK_SEED / CORDCLEAN_UI_DIR',
    ].join('\n'),
  )
}

const invokedFile = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
const isMain = invokedFile === import.meta.url

if (isMain) {
  const cli = parseArgs(process.argv.slice(2))
  if (cli.help) {
    printUsage()
    process.exit(0)
  }
  const port = Number(cli.port ?? process.env.CORDCLEAN_MOCK_PORT ?? DEFAULT_PORT)
  const items = Number(cli.items ?? process.env.CORDCLEAN_MOCK_ITEMS ?? DEFAULT_ITEMS)
  const seed = Number(cli.seed ?? process.env.CORDCLEAN_MOCK_SEED ?? DEFAULT_SEED)
  const distDir = cli.dist ?? process.env.CORDCLEAN_UI_DIR ?? DEFAULT_DIST_DIR
  try {
    const mock = await startMockServer({ port, host: cli.host, items, seed, distDir })
    const { summary } = mock.fixture
    console.log('')
    console.log('  ╭──────────────────────────────────────────────╮')
    console.log('  │  CordClean UI 验收 mock 服务器已启动          │')
    console.log('  ╰──────────────────────────────────────────────╯')
    console.log(`  清理页地址: ${mock.url}#clean`)
    console.log(`  RPC 地址:   ${mock.wsUrl}`)
    console.log(`  静态目录:   ${path.resolve(distDir)}`)
    console.log(
      `  合成数据:   ${summary.items} 条 / ${summary.tasks} 个任务 / ${summary.riskCounts.safe} safe · ${summary.riskCounts.caution} caution · ${summary.riskCounts.risky} risky / ${summary.protectedCount} protected`,
    )
    console.log(`  推荐选择:   ${summary.recommend.count} 项 · ${formatBytes(summary.recommend.bytes)}`)
    console.log('')
    console.log('  Ctrl+C 退出')
    let closing = false
    const shutdown = async (signal) => {
      if (closing) return
      closing = true
      console.log(`\n收到 ${signal}，正在关闭 mock 服务器 ...`)
      try {
        await mock.close()
      } catch {
        /* ignore */
      }
      process.exit(0)
    }
    process.on('SIGINT', () => void shutdown('SIGINT'))
    process.on('SIGTERM', () => void shutdown('SIGTERM'))
  } catch (error) {
    console.error(`\n❌ mock 服务器启动失败：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
