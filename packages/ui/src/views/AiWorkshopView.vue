<script setup lang="ts">
/**
 * AI 插件工坊（独立页面 + 独立插件）。
 *
 * 与「AI 建议」分析页分开：本页只做 v2 插件包的生成、审阅与安装；
 * 接口配置保存在独立插件 ai-workshop 的 config 中，安装走 PluginManager.installPackage。
 *
 * 本页按「用户没有固定操作顺序」升级：
 * - 准备状态引导：插件未启用 / 未配置 Key / 无模型 → 明确原因 + 一键处理；
 * - 生成阶段以宿主 phase 为准（不再纯靠耗时猜），失败按截断/JSON/校验/凭据等结构化提示；
 * - 本地草稿历史（容错持久化）：回填需求、恢复编辑、重新生成；重复需求自动去重；
 * - 安装前校验摘要：按闸门展示通过/未通过，并列出危险 API 命中；
 * - 按钮门禁统一给原因（disabled + title + 页内提示），不静默失败。
 */
defineOptions({ name: 'AiWorkshopView' })
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { formatBytes, formatTime } from '@cordclean/shared'
import SectionIcon from '../components/SectionIcon.vue'
import type { AiModelInfo, AiPluginDraft, AiWorkshopStatus, PluginManifest } from '@cordclean/shared'
import {
  cancelAiWorkshopDraft,
  draftAiWorkshopPlugin,
  fetchAiWorkshopModels,
  fetchAiWorkshopStatus,
  installAiPlugin,
  refreshPlugins,
  savePluginConfig,
  setPluginEnabled,
  state,
  validateAiPlugin,
} from '../api/store.ts'
import {
  MAX_DRAFT_HISTORY,
  MAX_REQUIREMENT_LENGTH,
  WORKSHOP_DRAFTS_KEY,
  appendDraftHistory,
  classifyWorkshopFailure,
  draftHistoryItems,
  draftToSnapshot,
  generateGate,
  generationStageView,
  installGate,
  materializeSnapshot,
  normalizeRequirement,
  parseDraftHistory,
  sanitizeErrorMessage,
  scanRiskyApis,
  serializeDraftHistory,
  summarizeValidation,
  workshopReadiness,
  type Gate,
  type ValidationSummary,
  type WorkshopDraftSnapshot,
  type WorkshopFailure,
} from './ai-workshop-view-model.ts'

const EXAMPLES = [
  '写一个 cleaner 插件，清理 %TEMP% 下超过 7 天的 .log 文件',
  '写一个 widget 插件，在概览页显示当前时间和磁盘可用空间',
  '写一个带独立页面的插件：页面里显示磁盘占用表格（client/index.html）',
  '写一个 cleaner 插件，清理浏览器缓存目录里的旧版缓存（只读清单请写清楚）',
]

const SHAPES = [
  { value: 'chat', label: 'chat（OpenAI Chat Completions）' },
  { value: 'messages', label: 'messages（Anthropic Messages）' },
  { value: 'responses', label: 'responses（OpenAI Responses）' },
]

const requirement = ref('')
const draft = ref<AiPluginDraft | null>(null)
const validation = ref<{ ok: boolean; errors: string[]; warnings: string[]; manifest?: PluginManifest } | null>(null)
const effectiveManifest = computed<PluginManifest>(() => (validation.value?.manifest ?? draft.value?.manifest ?? {}) as PluginManifest)
const busy = ref(false)
const installing = ref(false)
const reviewed = ref(false)
const dependenciesAccepted = ref(false)
const elapsed = ref(0)
const activeFile = ref('')
const showAdvanced = ref(true)
const settingsOpen = ref(false)
const manifestText = ref('')
const manifestError = ref('')
const validating = ref(false)
/** 校验结果是否对应当前代码/清单：编辑后先置 false，防止用旧结果安装 */
const validationFresh = ref(true)
const generationError = ref<WorkshopFailure | null>(null)
const cancelledNotice = ref('')
const installError = ref('')
const draftHistory = ref<WorkshopDraftSnapshot[]>([])
let timer: ReturnType<typeof setInterval> | undefined
let validateSeq = 0
let validateTimer: ReturnType<typeof setTimeout> | undefined
let generateSeq = 0

const workshopStatus = ref<AiWorkshopStatus | null>(null)
const statusLoading = ref(true)
const statusError = ref('')
const workshopConfig = reactive({
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  apiShape: 'chat' as 'chat' | 'messages' | 'responses',
  chatPath: '',
  modelsPath: '/models',
  modelsUrl: '',
  model: 'deepseek-flash',
  maxTokens: 65_536,
  temperature: -1,
  timeoutMs: 180_000,
  retries: 1,
  systemPrompt: '',
  reasoningEffort: 'auto' as 'auto' | 'off' | 'low' | 'medium' | 'high' | 'max',
  jsonMode: 'auto' as 'auto' | 'on' | 'off',
  extraBodyText: '',
  extraHeadersText: '',
})
const workshopModels = ref<AiModelInfo[]>([])
const modelsSource = ref<'remote' | 'fallback'>('fallback')
const modelsLoading = ref(false)
const savingConfig = ref(false)
const enabling = ref(false)

const available = computed(() => workshopStatus.value?.available === true)
const configured = computed(() => workshopStatus.value?.configured === true)
const model = computed(() => workshopStatus.value?.model || workshopConfig.model || '未配置模型')
const shape = computed(() => workshopStatus.value?.shape || workshopConfig.apiShape)
const keySourceLabel = computed(() => {
  const source = workshopStatus.value?.apiKeySource
  if (source === 'config') return '工坊配置'
  if (source === 'env') return '环境变量'
  return '未配置'
})
const modelOptions = computed<Array<{ id: string; name?: string }>>(() => {
  const list: Array<{ id: string; name?: string }> = workshopModels.value.map((item) => (item.name ? { id: item.id, name: item.name } : { id: item.id }))
  if (workshopConfig.model && !list.some((item) => item.id === workshopConfig.model)) {
    list.unshift({ id: workshopConfig.model })
  }
  return list
})

const entryPath = computed(() => String(effectiveManifest.value.entry ?? 'index.mjs'))
const files = computed<Array<{ path: string; content: string }>>(() => {
  const list = draft.value?.files ?? []
  if (list.length) return list
  if (!draft.value) return []
  return [{ path: entryPath.value, content: draft.value.code }]
})
const activeContent = computed(() => files.value.find((item) => item.path === activeFile.value)?.content ?? '')
const activeSize = computed(() => new Blob([activeContent.value]).size)

function fileSizeText(content: string): string {
  return formatBytes(new Blob([content]).size)
}
const dependencies = computed(() => Object.entries(draft.value?.dependencies ?? {}))

function openPlugins(): void {
  state.page = 'plugins'
}

/* ------------------------------ 派生的展示状态 ------------------------------ */

const readiness = computed(() =>
  workshopReadiness({
    statusLoading: statusLoading.value,
    statusKnown: workshopStatus.value !== null,
    statusError: statusError.value,
    available: available.value,
    configured: configured.value,
    keySource: keySourceLabel.value,
    model: workshopStatus.value?.model || workshopConfig.model,
  }),
)

const modelReady = computed(() => Boolean(String(workshopStatus.value?.model || workshopConfig.model || '').trim()))

/**
 * 生成按钮门禁：先按「忙碌/需求/启用/Key」给出第一个真实原因，
 * 再补一条「没有可用模型」——只配了 Key 但没有模型时也不会生成。
 */
const generateAvailability = computed<Gate>(() => {
  const gate = generateGate({
    busy: busy.value,
    installing: installing.value,
    requirement: requirement.value,
    available: available.value,
    configured: configured.value,
  })
  if (!gate.ok) return gate
  if (!modelReady.value) {
    return { ok: false, reason: '工坊还没有可用模型：打开接口设置拉取模型列表或手动填写模型名（无模型时不会生成）' }
  }
  return gate
})

const generation = computed(() =>
  generationStageView({
    busy: busy.value,
    phase: state.workshopProgress?.phase,
    textLength: state.workshopProgress?.textLength,
    toolCalls: state.workshopProgress?.toolCalls,
    elapsedSeconds: elapsed.value,
  }),
)

const riskyApis = computed(() => {
  const sources: string[] = []
  if (draft.value) {
    sources.push(draft.value.code)
    for (const file of draft.value.files ?? []) sources.push(file.content)
  }
  return scanRiskyApis(sources)
})

const validationSummary = computed<ValidationSummary>(() => {
  const base = summarizeValidation({
    validation: manifestError.value
      ? { ok: false, errors: [`清单 JSON 不合法：${manifestError.value}`] }
      : validation.value,
    validating: validating.value,
    risky: riskyApis.value,
  })
  if (!manifestError.value) return base
  return { ...base, status: 'failed', headline: '清单 JSON 不合法：修正后会自动重新校验' }
})

const installAvailability = computed<Gate>(() =>
  installGate({
    hasDraft: Boolean(draft.value),
    validationStatus: validationSummary.value.status,
    validationFresh: validationFresh.value,
    manifestError: manifestError.value,
    reviewed: reviewed.value,
    installing: installing.value,
    dependencyCount: dependencies.value.length,
    dependenciesAccepted: dependenciesAccepted.value,
  }),
)

const historyItems = computed(() => draftHistoryItems(draftHistory.value))

/** 生成端自动修复记录（工坊在安装前自检时补齐/修正清单字段）；只用于界面提示 */
const autoRepairNote = computed(() => {
  const notes = draft.value?.notes ?? ''
  const marker = notes.indexOf('[已自动修复]')
  if (marker < 0) return ''
  return notes.slice(marker).replace(/\s+/g, ' ').trim().slice(0, 280)
})

/* -------------------------------- 计时器 -------------------------------- */

const generationStage = computed(() => generation.value.headline)

function startTimer(): void {
  elapsed.value = 0
  stopTimer()
  timer = setInterval(() => {
    elapsed.value += 1
  }, 1000)
}

function stopTimer(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}

/* ------------------------------- 配置与状态 ------------------------------- */

function loadWorkshopConfig(): void {
  const plugin = state.plugins.find((item) => item.id === 'ai-workshop')
  const config = (plugin?.config ?? {}) as Record<string, unknown>
  workshopConfig.apiKey = String(config.apiKey ?? '')
  workshopConfig.baseUrl = String(config.baseUrl ?? 'https://api.deepseek.com')
  workshopConfig.apiShape = (['chat', 'messages', 'responses'] as const).includes(config.apiShape as any)
    ? (config.apiShape as 'chat' | 'messages' | 'responses')
    : 'chat'
  workshopConfig.chatPath = String(config.chatPath ?? '')
  workshopConfig.modelsPath = String(config.modelsPath ?? '/models')
  workshopConfig.modelsUrl = String(config.modelsUrl ?? '')
  workshopConfig.model = String(config.model ?? 'deepseek-flash')
  workshopConfig.maxTokens = Number(config.maxTokens ?? 65_536) || 65_536
  workshopConfig.temperature = Number(config.temperature ?? -1)
  workshopConfig.timeoutMs = Number(config.timeoutMs ?? 180_000) || 180_000
  workshopConfig.retries = Number(config.retries ?? 1)
  workshopConfig.systemPrompt = String(config.systemPrompt ?? '')
  workshopConfig.reasoningEffort = (['auto', 'off', 'low', 'medium', 'high', 'max'] as const).includes(
    config.reasoningEffort as any,
  )
    ? (config.reasoningEffort as typeof workshopConfig.reasoningEffort)
    : 'auto'
  workshopConfig.jsonMode = (['auto', 'on', 'off'] as const).includes(config.jsonMode as any)
    ? (config.jsonMode as typeof workshopConfig.jsonMode)
    : 'auto'
  workshopConfig.extraBodyText = String(config.extraBodyText ?? '')
  workshopConfig.extraHeadersText = String(config.extraHeadersText ?? '')
}

async function loadWorkshopStatus(silent = true): Promise<void> {
  statusLoading.value = true
  try {
    workshopStatus.value = await fetchAiWorkshopStatus()
    statusError.value = ''
    if (!silent && workshopStatus.value) {
      const status = workshopStatus.value
      ElMessage.info(
        `插件${status.available ? '已启用' : '未启用'} · API ${status.configured ? '已配置（' + keySourceLabel.value + '）' : '未配置'} · ${status.shape}/${status.model}`,
      )
    }
  } catch (err) {
    workshopStatus.value = null
    statusError.value = sanitizeErrorMessage(err) || '读取状态失败'
    if (!silent) ElMessage.error('刷新状态失败：' + statusError.value)
  } finally {
    statusLoading.value = false
  }
}

async function enableWorkshop(): Promise<void> {
  enabling.value = true
  try {
    await setPluginEnabled('ai-workshop', true)
    await refreshPlugins()
    await loadWorkshopStatus()
    loadWorkshopConfig()
    ElMessage.success('已启用「AI 插件工坊」插件')
  } catch (err) {
    ElMessage.error('启用失败：' + (sanitizeErrorMessage(err) || '未知原因'))
  } finally {
    enabling.value = false
  }
}

async function loadModels(showFeedback = true): Promise<void> {
  if (!available.value) {
    if (showFeedback) ElMessage.warning('工坊插件未启用：先启用插件再拉取模型')
    return
  }
  modelsLoading.value = true
  try {
    const result = await fetchAiWorkshopModels(true)
    workshopModels.value = result.models
    modelsSource.value = result.source
    if (!result.models.some((item) => item.id === workshopConfig.model) && result.models[0]) {
      workshopConfig.model = result.models[0].id
    }
    if (showFeedback) {
      if (result.source === 'remote') ElMessage.success(`已从接口拉取 ${result.models.length} 个模型`)
      else ElMessage.warning('接口没有返回模型列表，已使用内置候选（可检查 API Key / baseUrl / 模型列表路径）')
    }
  } catch (err) {
    ElMessage.error('拉取模型失败：' + (sanitizeErrorMessage(err) || '未知原因'))
  } finally {
    modelsLoading.value = false
  }
}

async function saveConfig(): Promise<void> {
  if (!available.value) {
    ElMessage.warning('工坊插件未启用：先启用插件再保存接口设置')
    return
  }
  savingConfig.value = true
  try {
    await savePluginConfig('ai-workshop', { ...workshopConfig, stream: false })
    await loadWorkshopStatus()
    ElMessage.success(`工坊接口设置已保存并热重载：${workshopConfig.apiShape} · ${workshopConfig.model}`)
  } catch (err) {
    ElMessage.error('保存设置失败：' + (sanitizeErrorMessage(err) || '未知原因'))
  } finally {
    savingConfig.value = false
  }
}

/* ------------------------------ 草稿历史（本地） ------------------------------ */

function loadDraftHistory(): void {
  try {
    draftHistory.value = parseDraftHistory(window.localStorage.getItem(WORKSHOP_DRAFTS_KEY))
  } catch {
    /* 隐私模式/存储被禁用：历史只是辅助功能，静默降级 */
    draftHistory.value = []
  }
}

function persistDraftHistory(): void {
  try {
    if (draftHistory.value.length === 0) {
      window.localStorage.removeItem(WORKSHOP_DRAFTS_KEY)
      return
    }
    window.localStorage.setItem(WORKSHOP_DRAFTS_KEY, serializeDraftHistory(draftHistory.value))
  } catch {
    /* 配额或存储不可用：不影响当前内存里的草稿 */
  }
}

function rememberDraft(text: string, value: AiPluginDraft): void {
  const snapshot = draftToSnapshot(text, value, Date.now())
  if (!snapshot) return
  draftHistory.value = appendDraftHistory(draftHistory.value, snapshot)
  persistDraftHistory()
}

function restoreDraft(id: string): void {
  if (busy.value || installing.value) {
    ElMessage.info('当前有生成/安装任务进行中，完成后再恢复草稿')
    return
  }
  const snapshot = draftHistory.value.find((item) => item.id === id)
  const restored = snapshot ? materializeSnapshot(snapshot) : undefined
  if (!restored) {
    ElMessage.warning('该草稿数据已损坏，已从本地历史移除')
    removeHistoryItem(id, false)
    return
  }
  draft.value = restored.draft
  requirement.value = restored.requirement
  generationError.value = null
  cancelledNotice.value = ''
  installError.value = ''
  resetReview()
  void revalidate()
  ElMessage.success('已恢复历史草稿：可继续编辑/校验，或直接安装')
}

function fillRequirementFromHistory(id: string): void {
  const snapshot = draftHistory.value.find((item) => item.id === id)
  if (!snapshot) return
  requirement.value = snapshot.requirement
  ElMessage.success('已把历史需求回填到输入框，可修改后重新生成')
}

function removeHistoryItem(id: string, notify = true): void {
  draftHistory.value = draftHistory.value.filter((item) => item.id !== id)
  persistDraftHistory()
  if (notify) ElMessage.info('已从本地草稿历史移除')
}

async function clearDraftHistory(): Promise<void> {
  try {
    await ElMessageBox.confirm('清空本机保存的全部工坊草稿历史？（不影响已安装的插件）', '清空本地草稿历史', {
      type: 'warning',
    })
  } catch {
    return
  }
  draftHistory.value = []
  persistDraftHistory()
  ElMessage.success('本地草稿历史已清空')
}

/* -------------------------------- 校验流程 -------------------------------- */

function resetReview(): void {
  validation.value = null
  validationFresh.value = false
  reviewed.value = false
  dependenciesAccepted.value = false
  activeFile.value = draft.value?.manifest?.entry ?? files.value[0]?.path ?? 'index.mjs'
  manifestError.value = ''
  manifestText.value = JSON.stringify(draft.value?.manifest ?? {}, null, 2)
}

async function revalidate(): Promise<void> {
  if (!draft.value) return
  const seq = ++validateSeq
  const value = draft.value
  validating.value = true
  try {
    const result = await validateAiPlugin(value.code, value.dependencies ?? {}, value.mode === 'native', {
      format: value.format,
      manifest: value.manifest as any,
      files: value.files,
    })
    if (seq === validateSeq && draft.value?.code === value.code) {
      validation.value = result
      if (result.manifest && draft.value) {
        draft.value.manifest = result.manifest
        manifestText.value = JSON.stringify(result.manifest, null, 2)
      }
      validationFresh.value = true
    }
  } catch (err) {
    if (seq === validateSeq && draft.value?.code === value.code) {
      validation.value = {
        ok: false,
        errors: [sanitizeErrorMessage(err) || '校验请求失败'],
        warnings: [],
      }
      validationFresh.value = true
    }
  } finally {
    if (seq === validateSeq) validating.value = false
  }
}

function scheduleRevalidate(): void {
  validationFresh.value = false
  if (validateTimer) clearTimeout(validateTimer)
  validateTimer = setTimeout(() => void revalidate(), 350)
}

/* -------------------------------- 生成流程 -------------------------------- */

function applyExample(text: string): void {
  if (busy.value || installing.value) return
  requirement.value = text
}

/**
 * 生成失败归类：宿主错误码优先；但安装前校验/输出截断等失败在传输层会统一兜底成
 * INVALID_RESPONSE，界面按脱敏后的真实文案纠正分类，避免把「校验未通过」误报成「无法解析」。
 */
function classifyGenerationError(err: unknown): WorkshopFailure {
  const failure = classifyWorkshopFailure(err)
  const text = sanitizeErrorMessage(err)
  if (!text) return failure
  const refined = classifyWorkshopFailure(new Error(text))
  return refined.kind === 'unknown' ? failure : refined
}

/** 安装失败文案：保留宿主原始信息，并在后面补上可执行的下一步 */
function explainInstallFailure(raw: string): string {
  if (/同名|已安装|already/i.test(raw)) return `${raw}（到插件页卸载同名插件后再安装）`
  if (/校验|清单|入口源码|静态契约|bridge|client/i.test(raw)) {
    return `${raw}（安装前校验被宿主拒绝：上方校验闸门已重新校验，修正后再安装）`
  }
  if (/依赖|acknowledge/i.test(raw)) return `${raw}（插件声明了第三方依赖：先勾选依赖确认再安装）`
  if (/权限|acknowledgePermissions|已阅读/i.test(raw)) return `${raw}（先勾选「我已阅读清单与代码」再安装）`
  if (/EPERM|EACCES|ENOSPC|磁盘|空间|只读/i.test(raw)) return `${raw}（可能是磁盘空间/目录权限问题，可检查数据目录后重试）`
  return raw
}

async function generate(): Promise<void> {
  const gate = generateAvailability.value
  if (!gate.ok) {
    if (!busy.value) ElMessage.warning(gate.reason ?? '当前无法生成')
    return
  }
  const text = normalizeRequirement(requirement.value)
  if (!text) return
  requirement.value = text
  const seq = ++generateSeq
  generationError.value = null
  installError.value = ''
  cancelledNotice.value = ''
  // 保留旧草稿：新结果返回前不破坏用户已经审阅/编辑过的内容；失败时旧草稿仍在
  busy.value = true
  state.workshopProgress = undefined
  startTimer()
  try {
    const next = await draftAiWorkshopPlugin(text)
    if (seq !== generateSeq) return
    draft.value = next
    resetReview()
    await revalidate()
    rememberDraft(text, draft.value ?? next)
    ElMessage.success(
      next.notes?.includes('[已自动修复]')
        ? '已生成插件包草稿（部分清单字段已自动修复），请检查校验结果'
        : '已生成插件包草稿，请检查校验结果',
    )
  } catch (err) {
    if (seq !== generateSeq) return
    generationError.value = classifyGenerationError(err)
  } finally {
    if (seq === generateSeq) {
      busy.value = false
      stopTimer()
    }
  }
}

/**
 * 放弃本次生成：先让宿主真正中断 HTTP 请求（ai/workshop/cancel），
 * 再用序号丢弃可能迟到的结果，确保不覆盖当前草稿。
 */
async function cancelGenerate(): Promise<void> {
  if (!busy.value) return
  generateSeq += 1
  busy.value = false
  stopTimer()
  state.workshopProgress = undefined
  let interrupted = false
  try {
    interrupted = (await cancelAiWorkshopDraft()).cancelled
  } catch {
    /* 旧内核没有取消接口：退回「丢弃迟到结果」 */
  }
  cancelledNotice.value = interrupted
    ? '已请求中断本次生成：宿主 HTTP 请求已取消，迟到的结果会被丢弃，不会替换当前草稿。'
    : '已放弃本次生成：当前内核没有可中断的请求（或已结束），迟到的结果会被丢弃，不会替换当前草稿。'
}

function retryGenerate(): void {
  if (busy.value || installing.value) return
  void generate()
}

/* -------------------------------- 审阅编辑 -------------------------------- */

function discard(): void {
  draft.value = null
  validation.value = null
  reviewed.value = false
  dependenciesAccepted.value = false
  generationError.value = null
  cancelledNotice.value = ''
  installError.value = ''
  manifestError.value = ''
  activeFile.value = ''
}

function updateFileContent(path: string, value: string): void {
  if (!draft.value) return
  const file = draft.value.files?.find((item) => item.path === path)
  if (file) file.content = value
  if (path === entryPath.value) draft.value.code = value
  installError.value = ''
  scheduleRevalidate()
}

async function addFile(): Promise<void> {
  if (!draft.value) return
  try {
    const result = await ElMessageBox.prompt('输入相对包目录的路径，例如 client/index.html 或 lib/helper.mjs', '添加文件', {
      inputPattern: /^[A-Za-z0-9._/-]+$/,
      inputErrorMessage: '路径只能包含字母、数字、点、下划线、斜杠',
    })
    const path = String(result.value ?? '').replace(/^\/+/, '')
    if (!path || path.includes('..') || path === 'plugin.json') throw new Error('非法文件路径')
    if (files.value.some((item) => item.path === path)) throw new Error('文件已存在')
    if (!draft.value.files) draft.value.files = files.value.map((item) => ({ ...item }))
    draft.value.files.push({ path, content: '' })
    activeFile.value = path
    installError.value = ''
    scheduleRevalidate()
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') {
      ElMessage.error(sanitizeErrorMessage(err) || '添加文件失败')
    }
  }
}

async function removeFile(path: string): Promise<void> {
  if (!draft.value) return
  if (path === entryPath.value) {
    ElMessage.warning('入口文件不能删除；如需更换入口，请修改 manifest.entry')
    return
  }
  try {
    await ElMessageBox.confirm(`删除文件 ${path}？`, '删除文件', { type: 'warning' })
  } catch {
    return
  }
  if (!draft.value.files) return
  draft.value.files = draft.value.files.filter((item) => item.path !== path)
  if (activeFile.value === path) activeFile.value = entryPath.value
  installError.value = ''
  scheduleRevalidate()
}

function updateManifest(text: string): void {
  manifestText.value = text
  if (!draft.value) return
  try {
    const data = JSON.parse(text)
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('清单必须是 JSON 对象')
    draft.value.manifest = data
    manifestError.value = ''
    installError.value = ''
    scheduleRevalidate()
  } catch (err) {
    manifestError.value = err instanceof Error ? err.message : String(err)
    validationFresh.value = false
  }
}

/* -------------------------------- 安装流程 -------------------------------- */

async function install(): Promise<void> {
  const gate = installAvailability.value
  if (!gate.ok || !draft.value) {
    if (draft.value) ElMessage.warning(gate.reason ?? '当前无法安装')
    return
  }
  installing.value = true
  installError.value = ''
  const name = draft.value.name
  try {
    const result = await installAiPlugin(
      name,
      draft.value.code,
      draft.value.dependencies ?? {},
      dependenciesAccepted.value,
      draft.value.mode === 'native',
      {
        format: draft.value.format,
        manifest: effectiveManifest.value as any,
        files: draft.value.files,
        acknowledgePermissions: true,
      },
    )
    ElMessage.success(`插件包已安装并启用：${result.manifest?.id ?? result.id}`)
    draft.value = null
    validation.value = null
    reviewed.value = false
    dependenciesAccepted.value = false
  } catch (err) {
    installError.value = explainInstallFailure(sanitizeErrorMessage(err) || '安装失败（未知原因）')
    ElMessage.error('安装失败：' + installError.value)
    // 宿主的安装前校验与界面校验同源；失败后重新校验一次，让上方闸门显示最新问题
    void revalidate()
  } finally {
    installing.value = false
  }
}

onMounted(async () => {
  await refreshPlugins().catch(() => {})
  loadDraftHistory()
  loadWorkshopConfig()
  await loadWorkshopStatus()
  void loadModels(false).catch(() => {})
})
onUnmounted(() => {
  stopTimer()
  if (validateTimer) clearTimeout(validateTimer)
})
</script>

<template>
  <div class="workshop-page">
    <div class="workshop-head cc-card">
      <div>
        <h2><SectionIcon name="flask" /> AI 插件工坊</h2>
        <p class="cc-hint">
          用一句话描述 → 生成 <b>v2 插件包</b>（清单 + 多文件 + 可选 <code>client/</code> 页面）→ 静态校验 → 审阅与编辑 → 通过
          staging 安装事务落盘（失败自动回滚）。安装前必须人工确认：插件以完整 Node 权限运行。
        </p>
      </div>
      <div class="workshop-meta">
        <span class="cc-pill" :class="{ 'is-ok': available, 'is-warn': !available }">
          插件 {{ available ? '已启用' : '未启用' }}
        </span>
        <span class="cc-pill" :class="{ 'is-ok': configured, 'is-warn': !configured }" :title="readiness.headline">
          {{ available ? (configured ? `API 已配置（${keySourceLabel}）` : 'API 未配置') : '等待启用插件' }}
        </span>
        <span class="cc-pill">{{ shape }} · {{ model }}</span>
        <span class="cc-pill">思考 {{ workshopConfig.reasoningEffort }}</span>
        <span v-if="draftHistory.length" class="cc-pill">本地草稿 {{ draftHistory.length }}</span>
        <span v-if="statusError" class="cc-pill is-warn" :title="statusError">状态读取失败</span>
      </div>
    </div>

    <!-- 准备状态引导：按「缺什么 → 去哪里补」列出，不静默失败 -->
    <section
      v-if="statusLoading && !workshopStatus"
      class="cc-card workshop-guide"
      aria-busy="true"
      aria-label="正在读取工坊状态"
    >
      <div class="cc-card-title">
        <h3>正在读取工坊状态…</h3>
        <span class="cc-faint">准备完成后即可生成插件包</span>
      </div>
      <div class="guide-loading">
        <span class="skeleton-line w60" />
        <span class="skeleton-line w40" />
      </div>
    </section>
    <section v-else-if="readiness.blockers.length" class="cc-card workshop-guide" aria-live="polite">
      <div class="cc-card-title">
        <h3>开始前还有 {{ readiness.blockers.length }} 项准备</h3>
        <span class="cc-faint">配置 → 生成 → 审阅安装，顺序不限；补齐后按钮会自动可用</span>
      </div>
      <div class="guide-list">
        <div v-for="blocker in readiness.blockers" :key="blocker.id" class="guide-item">
          <span class="guide-dot" aria-hidden="true"></span>
          <div class="guide-copy">
            <b>{{ blocker.title }}</b>
            <p>{{ blocker.detail }}</p>
          </div>
          <el-button v-if="blocker.action === 'enable'" type="primary" :loading="enabling" @click="enableWorkshop">
            {{ blocker.actionLabel }}
          </el-button>
          <el-button v-else-if="blocker.action === 'settings'" type="primary" @click="settingsOpen = true">
            {{ blocker.actionLabel }}
          </el-button>
          <el-button v-else-if="blocker.action === 'refresh'" :loading="statusLoading" @click="loadWorkshopStatus(false)">
            {{ blocker.actionLabel }}
          </el-button>
          <el-button v-else @click="openPlugins">{{ blocker.actionLabel }}</el-button>
        </div>
      </div>
    </section>

    <div class="workshop-grid">
      <div class="workshop-controls">
        <section class="cc-card">
          <div class="cc-card-title">
            <h3>1. 描述你想要的插件</h3>
            <span class="cc-faint">越具体越好：清理目标 / 触发方式 / UI 形态</span>
          </div>
          <el-input
            v-model="requirement"
            type="textarea"
            :rows="5"
            :maxlength="MAX_REQUIREMENT_LENGTH"
            show-word-limit
            placeholder="例如：写一个 cleaner 插件，清理 %TEMP% 下超过 7 天的 .log 文件，只扫描不自动删除…"
            aria-label="插件需求描述"
            :disabled="busy || installing"
          />
          <div class="workshop-examples" role="group" aria-label="示例需求（点击填入）">
            <button
              v-for="item in EXAMPLES"
              :key="item"
              type="button"
              class="cc-pill example"
              :disabled="busy || installing"
              :title="item"
              @click="applyExample(item)"
            >
              {{ item }}
            </button>
          </div>
          <div class="workshop-actions">
            <el-button
              type="primary"
              :loading="busy"
              :disabled="!generateAvailability.ok"
              :title="generateAvailability.ok ? '' : generateAvailability.reason"
              @click="generate"
            >
              生成 v2 插件包草稿
            </el-button>
            <span v-if="!generateAvailability.ok && requirement.trim() && !busy" class="gate-hint" role="status">
              {{ generateAvailability.reason }}
            </span>
          </div>
          <p v-if="!readiness.ready && readiness.blockers.length && !busy" class="cc-hint setup-blocked-note" role="status">
            生成必须使用工坊自己的 AI 接口：{{ readiness.blockers.map((item) => item.title).join('；') }}。
            未配置 Key / 无模型时工坊不可用（预期行为），不提供离线模板或其它绕过方式；请先按上方准备步骤补齐。
          </p>

          <div v-if="busy" class="generation-progress" role="status" aria-live="polite">
            <div class="generation-head">
              <span>⏳ {{ generationStage }}</span>
              <span class="cc-faint">已等待 {{ elapsed }} 秒</span>
            </div>
            <el-progress :percentage="generation.percent" :show-text="false" :stroke-width="6" :duration="3" />
            <p v-if="generation.detail" class="cc-faint">{{ generation.detail }}</p>
            <div class="generation-stages" aria-label="生成阶段">
              <span v-for="stage in generation.stages" :key="stage.id" :class="stage.state">{{ stage.label }}</span>
            </div>
            <div class="workshop-actions">
              <el-button size="small" @click="cancelGenerate">放弃本次生成</el-button>
              <span class="cc-faint">放弃会请求中断宿主 HTTP 请求；即使取消失败，迟到结果也会被丢弃，不会替换当前草稿。</span>
            </div>
          </div>

          <p v-if="cancelledNotice && !busy" class="cancelled-notice" role="status">⏹ {{ cancelledNotice }}</p>

          <div v-if="generationError && !busy" class="generation-failure" role="alert">
            <div class="failure-head">
              <b>生成失败：{{ generationError.title }}</b>
              <span class="cc-faint">{{ generationError.kind }}</span>
            </div>
            <p v-if="generationError.detail" class="failure-detail" :title="generationError.detail">
              {{ generationError.detail }}
            </p>
            <p class="cc-faint">{{ generationError.hint }}</p>
            <div class="workshop-actions">
              <el-button
                v-if="generationError.retryable"
                type="primary"
                plain
                size="small"
                :disabled="!generateAvailability.ok"
                :title="generateAvailability.ok ? '' : generateAvailability.reason"
                @click="retryGenerate"
              >
                重试生成
              </el-button>
              <el-button v-if="generationError.actions.includes('settings')" size="small" @click="settingsOpen = true">
                打开接口设置
              </el-button>
              <el-button v-if="generationError.actions.includes('enable')" size="small" :loading="enabling" @click="enableWorkshop">
                启用插件
              </el-button>
              <el-button v-if="generationError.actions.includes('refresh')" size="small" :loading="statusLoading" @click="loadWorkshopStatus(false)">
                刷新状态
              </el-button>
              <el-button v-if="generationError.actions.includes('plugins')" size="small" @click="openPlugins">去插件页</el-button>
            </div>
          </div>

          <p class="cc-hint" style="margin-top: 10px">
            输出默认是多文件 v2 插件包（manifest + files）；需要页面时模型会输出 <code>client/index.html</code>。第三方依赖会在暂存目录安装
            <code>node_modules</code>（安装时需再次确认）。生成期间可以切走页面，完成后回来结果仍在。
          </p>
        </section>

        <section class="cc-card workflow-card">
          <div class="cc-card-title">
            <h3>工作流</h3>
            <span class="cc-faint">配置 → 生成 → 审阅安装</span>
          </div>
          <p v-if="readiness.ready" class="guide-ready" role="status">✓ {{ readiness.headline }}</p>
          <div class="workflow-steps">
            <div class="workflow-step" :class="{ done: available && configured }">
              <b>1</b><span>接口设置</span><small>{{ available ? (configured ? '已配置（' + keySourceLabel + '）' : '待配置 Key') : '插件未启用' }}</small>
            </div>
            <div class="workflow-step" :class="{ done: draft && !busy }">
              <b>2</b><span>生成草稿</span><small>{{ busy ? '生成中…' : (draft ? '已生成，待审阅' : '描述需求后生成') }}</small>
            </div>
            <div class="workflow-step" :class="{ done: Boolean(draft) && validationSummary.status === 'passed' }">
              <b>3</b><span>审阅安装</span>
              <small>{{ draft ? (validationSummary.status === 'passed' ? '校验通过，可安装' : validationSummary.status === 'failed' ? '校验未通过，待修正' : '等待校验') : '右侧工作区：编辑 / 校验 / 安装' }}</small>
            </div>
          </div>
          <div class="workshop-actions">
            <el-button type="primary" plain @click="settingsOpen = true">打开接口设置</el-button>
            <el-button :loading="statusLoading" @click="loadWorkshopStatus(false)">刷新状态</el-button>
            <el-button v-if="!available" type="primary" :loading="enabling" @click="enableWorkshop">启用插件</el-button>
          </div>
          <p class="cc-hint">设置保存在独立插件 <code>ai-workshop</code> 中；生成结果进入右侧审阅区，不会自动安装。</p>

          <el-collapse v-if="draftHistory.length" class="history-collapse">
            <el-collapse-item :title="`本地草稿历史（${draftHistory.length} / ${MAX_DRAFT_HISTORY}）`" name="drafts">
              <ul class="draft-history">
                <li v-for="item in historyItems" :key="item.id" class="draft-item">
                  <button
                    type="button"
                    class="draft-restore"
                    :disabled="busy || installing"
                    :title="`恢复草稿「${item.requirement}」`"
                    @click="restoreDraft(item.id)"
                  >
                    <span class="draft-title">{{ item.requirement }}</span>
                    <span class="draft-meta">
                      {{ item.name }} · {{ item.kind }} · {{ item.fileCount }} 文件 ·
                      {{ formatBytes(item.totalBytes) }}
                      <template v-if="item.dependencyCount"> · {{ item.dependencyCount }} 依赖</template>
                      · {{ formatTime(item.savedAt) }}
                    </span>
                  </button>
                  <div class="draft-actions">
                    <el-button
                      text
                      size="small"
                      :disabled="busy || installing"
                      title="只把需求填入左侧输入框，不恢复草稿内容"
                      @click="fillRequirementFromHistory(item.id)"
                    >
                      回填需求
                    </el-button>
                    <el-button
                      text
                      size="small"
                      type="danger"
                      :aria-label="`从本地历史删除草稿：${item.requirement}`"
                      title="从本机历史删除（不影响已安装插件）"
                      @click="removeHistoryItem(item.id)"
                    >
                      删除
                    </el-button>
                  </div>
                </li>
              </ul>
              <div class="workshop-actions">
                <el-button size="small" text type="danger" @click="clearDraftHistory">清空本地草稿历史</el-button>
                <span class="cc-faint">草稿只保存在本机浏览器存储（最多 {{ MAX_DRAFT_HISTORY }} 份），不会上传。</span>
              </div>
            </el-collapse-item>
          </el-collapse>
          <p v-else class="cc-faint history-empty">生成成功的草稿会自动记入本机历史（最多 {{ MAX_DRAFT_HISTORY }} 份），可回填需求或恢复编辑。</p>
        </section>
      </div>

      <section class="cc-card review-card" :aria-busy="busy">
        <div class="cc-card-title">
          <h3>2. 审阅插件包</h3>
          <span class="cc-faint">清单 / 权限 / 多文件编辑 / 校验与安装</span>
        </div>

        <div v-if="busy && !draft" class="review-skeleton" aria-busy="true" aria-label="正在生成插件包">
          <span class="skeleton-line w30" />
          <span class="skeleton-line w90" />
          <span class="skeleton-line w70" />
          <span class="skeleton-line w80" />
          <p class="cc-faint">正在生成插件包，完成后会自动进入审阅区并做静态校验。</p>
        </div>

        <template v-else-if="draft">
          <div v-if="busy" class="review-busy-banner" role="status">
            正在生成新草稿…当前草稿在新结果返回前保持不变；
            <el-button text size="small" @click="cancelGenerate">放弃本次生成</el-button>
          </div>
          <div class="pkg-head">
            <div>
              <strong>{{ effectiveManifest?.name ?? draft.name }}</strong>
              <span class="cc-faint"> · v{{ effectiveManifest?.version ?? '1.0.0' }} · {{ draft.kind ?? 'cleaner' }}</span>
            </div>
            <div class="pkg-chips">
              <span class="cc-pill">id {{ effectiveManifest?.id ?? draft.name }}</span>
              <span class="cc-pill">兼容 {{ effectiveManifest?.engines?.cordclean ?? '—' }}</span>
              <span class="cc-pill">文件 {{ files.length }}</span>
              <span class="cc-pill">client {{ effectiveManifest?.client?.mode ?? 'declarative' }}</span>
            </div>
          </div>
          <p class="cc-hint">
            权限：{{ (effectiveManifest?.permissions?.services ?? []).join(', ') || '无服务' }}
            <span v-if="effectiveManifest?.permissions?.network"> · 网络</span>
            <span v-if="effectiveManifest?.permissions?.subprocess"> · 子进程</span>
            · 完整权限运行，无法沙箱隔离
          </p>
          <p v-if="autoRepairNote" class="cc-hint repair-note" :title="draft.notes">🛠 {{ autoRepairNote }}</p>

          <!-- 安装前校验摘要：闸门通过/未通过 + 危险 API 命中 -->
          <div class="validation-summary" :class="'is-' + validationSummary.status" aria-live="polite">
            <div class="validation-head">
              <b>{{ validationSummary.headline }}</b>
              <span v-if="validating" class="cc-faint">重新校验中…</span>
              <el-button v-else-if="validationSummary.status === 'failed'" text size="small" @click="revalidate()">
                重新校验
              </el-button>
            </div>
            <div class="gate-grid" role="list" aria-label="校验闸门">
              <div
                v-for="gate in validationSummary.gates"
                :key="gate.id"
                class="gate-item"
                :class="{ ok: gate.ok }"
                role="listitem"
                :aria-label="`${gate.label}：${gate.ok ? '通过' : '未通过（' + gate.errors.length + ' 个错误）'}`"
                :title="gate.ok ? `${gate.label}：通过` : gate.errors.join('；')"
              >
                <span class="gate-icon" aria-hidden="true">{{ gate.ok ? '✓' : '✗' }}</span>
                <span class="gate-label">{{ gate.label }}</span>
                <span v-if="!gate.ok" class="gate-count">{{ gate.errors.length }}</span>
              </div>
            </div>
            <div v-if="validationSummary.risky.length" class="risk-list">
              <p class="risk-title">危险 / 敏感 API 命中（{{ validationSummary.risky.length }}）</p>
              <ul>
                <li v-for="hit in validationSummary.risky" :key="hit.id" :class="'risk-' + hit.level">
                  <b>{{ hit.label }}</b>
                  <span>{{ hit.hint }}</span>
                </li>
              </ul>
            </div>
            <el-collapse v-if="validationSummary.errors.length || validationSummary.warnings.length" class="validation-raw">
              <el-collapse-item
                :title="`原始校验信息（错误 ${validationSummary.errors.length} · 提示 ${validationSummary.warningCount}）`"
              >
                <p v-if="!validationSummary.errors.length" class="cc-hint">✓ 没有错误</p>
                <p v-for="(item, index) in validationSummary.errors" :key="'err-' + index" class="error-text">{{ item }}</p>
                <p v-for="(item, index) in validationSummary.warnings" :key="'warn-' + index" class="cc-faint">提示：{{ item }}</p>
              </el-collapse-item>
            </el-collapse>
          </div>

          <div class="review-body">
            <aside class="file-sidebar" aria-label="插件包文件列表">
              <div class="file-sidebar-head">文件（{{ files.length }}）</div>
              <button
                v-for="file in files"
                :key="file.path"
                type="button"
                class="file-item"
                :class="{ active: file.path === activeFile }"
                :aria-current="file.path === activeFile ? 'true' : undefined"
                :title="file.path"
                @click="activeFile = file.path"
              >
                <span class="file-item-path">{{ file.path }}</span>
                <span class="file-item-size">{{ fileSizeText(file.content) }}</span>
                <span v-if="file.path === entryPath" class="file-item-tag">入口</span>
              </button>
              <div class="file-sidebar-actions">
                <el-button size="small" :disabled="installing" @click="addFile">添加文件</el-button>
                <el-button
                  size="small"
                  :disabled="activeFile === entryPath || installing"
                  :title="activeFile === entryPath ? '入口文件不能删除；如需更换入口，请修改 manifest.entry' : ''"
                  @click="removeFile(activeFile)"
                >
                  删除
                </el-button>
              </div>
            </aside>
            <div class="editor-pane">
              <div class="file-meta cc-faint">
                {{ activeFile }} · {{ activeSize }} 字节
                {{ activeFile === entryPath ? '（入口文件，编辑会同步草稿代码）' : '' }}
              </div>
              <el-input
                :model-value="activeContent"
                type="textarea"
                :rows="20"
                class="cc-mono"
                spellcheck="false"
                :disabled="installing"
                @update:model-value="updateFileContent(activeFile, $event)"
              />
              <el-collapse class="manifest-editor">
                <el-collapse-item title="plugin.json 清单（可直接编辑，保存前会重新校验）">
                  <el-input v-model="manifestText" type="textarea" :rows="12" class="cc-mono" spellcheck="false" @update:model-value="updateManifest" />
                  <p v-if="manifestError" class="error-text">清单 JSON 不合法：{{ manifestError }}</p>
                  <p v-else class="cc-hint">清单修改后会重新校验；client / permissions / entry 都在这里调整。</p>
                </el-collapse-item>
              </el-collapse>
            </div>
          </div>

          <div v-if="dependencies.length" class="deps-box">
            <p class="cc-hint">该插件包声明了第三方依赖（在 staging 内安装，禁用 lifecycle scripts）：</p>
            <ul>
              <li v-for="[name, version] in dependencies" :key="name"><code>{{ name }}</code> · {{ version }}</li>
            </ul>
            <el-checkbox v-model="dependenciesAccepted">我确认下载并运行这些第三方依赖（它们拥有与插件相同的完整 Node 权限）</el-checkbox>
          </div>

          <el-checkbox v-model="reviewed" style="margin-top: 10px" :disabled="installing">
            我已阅读上述清单与代码，理解它会以完整权限运行
          </el-checkbox>
          <p class="cc-hint install-check-hint">
            安装前宿主会再用与安装同一套校验器检查清单 / 入口源码 / client 页面；任一项不通过都会拒绝安装且不写入文件。
          </p>
          <div class="workshop-actions">
            <el-button
              type="primary"
              :loading="installing"
              :disabled="!installAvailability.ok"
              :title="installAvailability.ok ? '' : installAvailability.reason"
              @click="install"
            >
              {{ installing ? '正在安装插件包…' : '安装并启用' }}
            </el-button>
            <el-button :disabled="installing" @click="discard">放弃草稿</el-button>
            <el-button
              :disabled="!generateAvailability.ok"
              :title="generateAvailability.ok ? '' : generateAvailability.reason"
              @click="retryGenerate"
            >
              用当前需求重新生成
            </el-button>
            <span v-if="!installAvailability.ok" class="gate-hint" role="status">{{ installAvailability.reason }}</span>
          </div>
          <p v-if="installError" class="error-text" role="alert">安装失败：{{ installError }}</p>
        </template>

        <div v-else class="review-empty">
          <div class="review-empty-icon" aria-hidden="true">🧩</div>
          <h4>插件包会显示在这里</h4>
          <p>左侧描述需求并生成后，这里会展示清单、权限、多文件内容与校验结果；你可以添加、删除、编辑任意文件，确认无误后再安装。</p>
          <div class="review-empty-grid">
            <div><b>清单</b><span>apiVersion / engines / 权限 / client</span></div>
            <div><b>多文件</b><span>入口 + client/index.html + 其它资源</span></div>
            <div><b>校验</b><span>静态契约 / 语法 / 清单结构</span></div>
            <div><b>安装</b><span>staging → 原子落盘 → 失败回滚</span></div>
          </div>
          <p class="cc-faint">
            不会自动安装；安装前必须勾选「已阅读代码」。
            <template v-if="!readiness.ready">先按上方准备步骤补齐配置，再生成草稿。</template>
          </p>
        </div>
      </section>
    </div>

    <el-drawer v-model="settingsOpen" title="接口设置（工坊独立）" size="560px" :close-on-click-modal="false">
      <p class="cc-hint" style="margin-top: 0">
        这些配置保存在插件 <code>ai-workshop</code> 的 config 中，与「AI 建议」页的 AI 接口配置完全独立。
      </p>
        <el-form label-position="top" class="setting-form">
          <div class="form-section-title">连接与凭据</div>
          <el-form-item label="接口形态">
            <el-select v-model="workshopConfig.apiShape" style="width: 100%">
              <el-option v-for="item in SHAPES" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
          <el-form-item>
            <template #label>
              <span>接口地址 baseUrl</span>
              <el-button text size="small" class="inline-btn" @click="workshopConfig.baseUrl = 'https://api.deepseek.com'">填入推荐地址</el-button>
            </template>
            <el-input v-model="workshopConfig.baseUrl" placeholder="https://api.deepseek.com" />
          </el-form-item>
          <el-form-item label="API Key">
            <el-input v-model="workshopConfig.apiKey" type="password" show-password placeholder="留空则读取环境变量 DEEPSEEK_API_KEY / OPENAI_API_KEY" />
            <div class="cc-hint">当前 Key 来源：{{ keySourceLabel }}</div>
          </el-form-item>
          <el-form-item>
            <template #label>
              <span>模型</span>
              <el-button
                text
                size="small"
                class="inline-btn"
                :loading="modelsLoading"
                :disabled="!available || modelsLoading"
                :title="!available ? '工坊插件未启用，先启用插件' : ''"
                @click="loadModels(true)"
              >
                获取模型
              </el-button>
            </template>
            <el-select v-model="workshopConfig.model" filterable allow-create default-first-option style="width: 100%" placeholder="选择或输入模型名">
              <el-option v-for="item in modelOptions" :key="item.id" :label="item.id" :value="item.id">
                <span>{{ item.id }}</span>
                <span v-if="item.name" class="option-hint">{{ item.name }}</span>
              </el-option>
            </el-select>
            <div class="cc-hint">候选来源：{{ modelsSource === 'remote' ? '接口 /models' : '内置兜底列表' }}；生成长代码建议 deepseek-flash。</div>
          </el-form-item>
          <div class="form-section-title">生成参数</div>
          <div class="config-grid">
            <el-form-item label="思考等级">
              <el-select v-model="workshopConfig.reasoningEffort" style="width: 100%">
                <el-option label="auto（不干预）" value="auto" />
                <el-option label="off（关闭思考）" value="off" />
                <el-option label="low（低）" value="low" />
                <el-option label="medium（中）" value="medium" />
                <el-option label="high（高）" value="high" />
                <el-option label="max（最高）" value="max" />
              </el-select>
            </el-form-item>
            <el-form-item label="JSON 输出">
              <el-select v-model="workshopConfig.jsonMode" style="width: 100%">
                <el-option label="auto（接口支持时）" value="auto" />
                <el-option label="on（开启）" value="on" />
                <el-option label="off（关闭）" value="off" />
              </el-select>
            </el-form-item>
            <el-form-item label="最大输出 token">
              <el-input-number v-model="workshopConfig.maxTokens" :min="4096" :max="131072" :step="8192" style="width: 100%" />
            </el-form-item>
            <el-form-item label="失败重试">
              <el-input-number v-model="workshopConfig.retries" :min="0" :max="5" style="width: 100%" />
            </el-form-item>
            <el-form-item label="超时（毫秒）">
              <el-input-number v-model="workshopConfig.timeoutMs" :min="0" :max="600000" :step="10000" style="width: 100%" />
            </el-form-item>
            <el-form-item label="温度">
              <el-input-number v-model="workshopConfig.temperature" :min="-1" :max="2" :step="0.1" style="width: 100%" />
            </el-form-item>
          </div>
          <div class="form-section-title">提示词与高级参数</div>
          <el-form-item label="追加提示词（可选）">
            <el-input v-model="workshopConfig.systemPrompt" type="textarea" :rows="2" placeholder="例如：入口固定 index.mjs；需要页面时输出 client/index.html；遵循团队编码规范" />
          </el-form-item>
          <el-form-item>
            <el-button text size="small" @click="showAdvanced = !showAdvanced">
              {{ showAdvanced ? '收起高级参数' : '高级参数（路径 / extraBody / extraHeaders）' }}
            </el-button>
          </el-form-item>
          <template v-if="showAdvanced">
            <el-form-item label="聊天路径 chatPath（可空）">
              <el-input v-model="workshopConfig.chatPath" placeholder="留空按接口形态取默认值" />
            </el-form-item>
            <el-form-item label="模型列表路径 modelsPath">
              <el-input v-model="workshopConfig.modelsPath" placeholder="/models" />
            </el-form-item>
            <el-form-item label="模型列表完整 URL modelsUrl（可空）">
              <el-input v-model="workshopConfig.modelsUrl" placeholder="便于代理/反代场景" />
            </el-form-item>
            <el-form-item label="额外请求体 extraBody（JSON 文本）">
              <el-input v-model="workshopConfig.extraBodyText" type="textarea" :rows="3" class="cc-mono" spellcheck="false" placeholder='例如 {"top_p":0.95,"thinking":{"type":"disabled"}}' />
            </el-form-item>
            <el-form-item label="额外请求头 extraHeaders（JSON 文本）">
              <el-input v-model="workshopConfig.extraHeadersText" type="textarea" :rows="2" class="cc-mono" spellcheck="false" placeholder='例如 {"X-Custom-Header":"value"}' />
            </el-form-item>
          </template>
        </el-form>
        <div class="workshop-actions">
          <el-button
            type="primary"
            :loading="savingConfig"
            :disabled="!available || savingConfig"
            :title="available ? '' : '工坊插件未启用，先启用插件再保存设置'"
            @click="saveConfig"
          >
            保存接口设置
          </el-button>
          <el-button :loading="statusLoading" @click="loadWorkshopStatus(false)">刷新状态</el-button>
          <el-button v-if="!available" type="primary" plain :loading="enabling" @click="enableWorkshop">启用插件</el-button>
          <span v-if="!available" class="gate-hint">插件未启用：保存按钮需要先启用插件</span>
        </div>
        <p class="cc-hint">配置保存在插件 <code>ai-workshop</code> 的 config 中，与「AI 建议」页的 AI 接口配置完全独立。</p>
    </el-drawer>
  </div>
</template>

<style scoped>
.workshop-page { display: flex; flex-direction: column; gap: 14px; }
.workshop-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
.workshop-head h2 { margin: 0 0 6px; font-size: 20px; }
.workshop-meta { display: flex; gap: 8px; flex-wrap: wrap; }
.workshop-meta .is-ok { color: #1f9d55; }
.workshop-meta .is-warn { color: #c07a00; }
.workshop-grid { display: grid; grid-template-columns: minmax(0, 430px) minmax(0, 1fr); gap: 16px; align-items: start; }
.workflow-card { display: flex; flex-direction: column; gap: 6px; }
.workflow-steps { display: flex; flex-direction: column; gap: 8px; margin: 6px 0; }
.workflow-step {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px;
  border: 1px solid var(--cc-border); border-radius: 8px; font-size: 12.5px; color: var(--cc-text-dim);
}
.workflow-step b {
  width: 22px; height: 22px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
  background: var(--cc-panel-2, rgba(79,124,255,0.08)); color: var(--cc-text); font-size: 11.5px; flex: none;
}
.workflow-step span { color: var(--cc-text); font-weight: 600; }
.workflow-step small { margin-left: auto; color: var(--cc-text-faint); font-size: 11px; text-align: right; }
.workflow-step.done b { background: rgba(31,157,85,0.15); color: #1f9d55; }
.workshop-controls { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.review-card { min-height: 580px; }
.review-body { display: grid; grid-template-columns: 210px minmax(0, 1fr); gap: 12px; align-items: start; margin-top: 8px; }
.workshop-examples { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0; }
.workshop-examples .example {
  cursor: pointer; font-size: 11.5px; font-family: inherit; background: var(--cc-bg-soft, transparent); line-height: 1.4;
  text-align: left; white-space: normal;
}
.workshop-examples .example:hover:not(:disabled) { color: var(--cc-primary); border-color: var(--cc-primary); }
.workshop-examples .example:disabled { cursor: not-allowed; opacity: 0.55; }
.workshop-examples .example:focus-visible,
.file-item:focus-visible,
.draft-restore:focus-visible { outline: 2px solid var(--cc-primary); outline-offset: 1px; }
.workshop-actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; align-items: center; }
.gate-hint { font-size: 12px; color: var(--cc-warning, #b45309); }
.setup-blocked-note {
  margin: 8px 0 0;
  padding: 8px 10px;
  border: 1px dashed var(--cc-border);
  border-radius: 8px;
  color: var(--cc-warning, #b45309);
}
.repair-note { color: var(--cc-warning, #b45309); }
.install-check-hint { margin: 6px 0 0; }
.guide-ready { margin: 0 0 6px; font-size: 12.5px; color: var(--cc-success, #1f9d55); }
.workshop-guide .cc-card-title { margin-bottom: 10px; }
.guide-list { display: flex; flex-direction: column; gap: 8px; }
.guide-item {
  display: flex; align-items: center; gap: 10px; padding: 10px 12px;
  border: 1px solid var(--cc-border); border-radius: 9px;
  background: var(--cc-panel-2, rgba(0, 0, 0, 0.015));
}
.guide-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--cc-warning, #d97706); flex: none; }
.guide-copy { flex: 1; min-width: 0; }
.guide-copy b { font-size: 13px; }
.guide-copy p { margin: 2px 0 0; font-size: 12px; line-height: 1.6; color: var(--cc-text-dim); }
.guide-loading { display: flex; flex-direction: column; gap: 8px; }
.setting-form { margin-top: 4px; }
.form-section-title {
  margin: 10px 0 6px;
  padding-bottom: 4px;
  border-bottom: 1px dashed var(--cc-border);
  font-size: 12px;
  font-weight: 600;
  color: var(--cc-text-dim);
  letter-spacing: 0.02em;
}
.review-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 8px;
  padding: 46px 20px 30px;
  min-height: 440px;
}
.review-empty-icon { font-size: 40px; line-height: 1; opacity: 0.85; }
.review-empty h4 { margin: 0; font-size: 16px; }
.review-empty p { margin: 0; max-width: 560px; font-size: 12.5px; line-height: 1.7; color: var(--cc-text-dim); }
.review-empty-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 18px;
  margin: 14px 0 6px;
  text-align: left;
  width: min(560px, 100%);
}
.review-empty-grid div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid var(--cc-border);
  border-radius: 8px;
  font-size: 12px;
  color: var(--cc-text-dim);
}
.review-empty-grid b { color: var(--cc-text); font-size: 12.5px; }
@media (max-width: 760px) {
  .review-empty-grid { grid-template-columns: 1fr; }
}
.setting-form :deep(.el-form-item) { margin-bottom: 12px; }
.config-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 12px; }
.inline-btn { margin-left: 6px; }
.option-hint { float: right; color: var(--cc-text-faint); font-size: 11.5px; }
.pkg-head { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
.pkg-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.file-sidebar { display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--cc-border); border-radius: 10px; padding: 10px; background: var(--cc-panel-2, rgba(0,0,0,0.015)); }
.file-sidebar-head { font-size: 12px; color: var(--cc-text-dim); margin-bottom: 2px; }
.file-item {
  display: flex; align-items: center; gap: 6px; width: 100%; text-align: left;
  border: 1px solid transparent; background: transparent; color: var(--cc-text-dim);
  border-radius: 7px; padding: 6px 8px; font-size: 12px; cursor: pointer;
}
.file-item:hover { background: var(--cc-hover, rgba(79,124,255,0.06)); }
.file-item.active { border-color: var(--cc-accent, #4f7cff); color: var(--cc-text); background: var(--cc-panel, #fff); }
.file-item-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.file-item-size { font-size: 10.5px; color: var(--cc-text-faint); }
.file-item-tag { font-size: 10px; border-radius: 4px; padding: 1px 4px; background: rgba(79,124,255,0.12); color: var(--cc-accent, #4f7cff); }
.file-sidebar-actions { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
.editor-pane { min-width: 0; }
.file-meta { font-size: 11.5px; margin-bottom: 6px; }
.manifest-editor { margin-top: 10px; }
.deps-box { margin: 10px 0; padding: 10px; border: 1px solid var(--cc-border); border-radius: 8px; }
.deps-box ul { margin: 6px 0; padding-left: 20px; }
@media (max-width: 1280px) { .workshop-grid { grid-template-columns: minmax(0, 380px) minmax(0, 1fr); } }
@media (max-width: 1100px) { .workshop-grid { grid-template-columns: 1fr; } .review-body { grid-template-columns: 180px minmax(0, 1fr); } }
@media (max-width: 760px) { .review-body { grid-template-columns: 1fr; } .file-sidebar { flex-direction: row; flex-wrap: wrap; } }

/* ---------- 生成进度 / 失败 ---------- */
.generation-progress { margin: 10px 0; padding: 10px 12px; border: 1px solid var(--cc-border); border-radius: 8px; background: var(--cc-panel-2, rgba(0,0,0,0.02)); }
.generation-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
.generation-stages { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 6px; font-size: 12px; color: var(--cc-text-faint); }
.generation-stages .done { color: var(--cc-success, #2e9b62); }
.generation-stages .active { color: var(--cc-primary); font-weight: 500; }
.cancelled-notice { margin: 10px 0 0; font-size: 12.5px; color: var(--cc-text-dim); }
.generation-failure {
  margin: 10px 0 0; padding: 10px 12px; border: 1px solid rgba(220, 47, 79, 0.35);
  border-radius: 8px; background: rgba(220, 47, 79, 0.06);
}
.failure-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; }
.failure-detail { margin: 6px 0 4px; font-size: 12px; color: var(--cc-text-dim); word-break: break-word; }
.review-skeleton { display: flex; flex-direction: column; gap: 10px; padding: 16px 0; }
.review-skeleton p { margin: 6px 0 0; }
.skeleton-line {
  display: block; height: 12px; border-radius: 6px;
  background: linear-gradient(90deg, var(--cc-border) 25%, var(--cc-hover-bg, rgba(0,0,0,0.06)) 37%, var(--cc-border) 63%);
  background-size: 400% 100%;
  animation: workshop-skeleton 1.4s ease infinite;
}
.skeleton-line.w30 { width: 30%; }
.skeleton-line.w40 { width: 40%; }
.skeleton-line.w60 { width: 60%; }
.skeleton-line.w70 { width: 70%; }
.skeleton-line.w80 { width: 80%; }
.skeleton-line.w90 { width: 90%; height: 180px; }
@keyframes workshop-skeleton {
  0% { background-position: 100% 50%; }
  100% { background-position: 0 50%; }
}
@media (prefers-reduced-motion: reduce) {
  .skeleton-line { animation: none; }
}
.review-busy-banner {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin: 0 0 8px; padding: 8px 10px; border-radius: 8px;
  border: 1px solid var(--cc-border); background: var(--cc-primary-soft);
  font-size: 12.5px; color: var(--cc-text-dim);
}

/* ---------- 校验摘要 ---------- */
.validation-summary {
  margin: 10px 0; padding: 10px 12px; border: 1px solid var(--cc-border); border-radius: 8px;
  background: var(--cc-panel-2, rgba(0,0,0,0.015));
}
.validation-summary.is-passed { border-color: rgba(31, 157, 85, 0.35); }
.validation-summary.is-failed { border-color: rgba(220, 47, 79, 0.35); }
.validation-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; font-size: 13px; }
.gate-grid { display: flex; flex-wrap: wrap; gap: 6px; }
.gate-item {
  display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px;
  border: 1px solid rgba(220, 47, 79, 0.35); border-radius: 999px;
  font-size: 11.5px; color: var(--cc-danger, #c2334f); background: rgba(220, 47, 79, 0.06);
}
.gate-item.ok { border-color: rgba(31, 157, 85, 0.35); color: var(--cc-success, #1f9d55); background: rgba(31, 157, 85, 0.07); }
.gate-icon { font-weight: 700; }
.gate-count { font-size: 10.5px; opacity: 0.85; }
.risk-list { margin-top: 10px; padding-top: 8px; border-top: 1px dashed var(--cc-border); }
.risk-title { margin: 0 0 4px; font-size: 12px; font-weight: 600; color: var(--cc-warning, #b45309); }
.risk-list ul { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }
.risk-list li { font-size: 12px; color: var(--cc-text-dim); }
.risk-list li b { color: var(--cc-text); margin-right: 6px; }
.risk-list li.risk-danger b { color: var(--cc-danger, #c2334f); }
.risk-list li.risk-warn b { color: var(--cc-warning, #b45309); }
.validation-raw { margin-top: 8px; }
.error-text { color: var(--cc-danger, #c2334f); font-size: 12.5px; margin: 4px 0; word-break: break-word; }

/* ---------- 本地草稿历史 ---------- */
.history-collapse { margin-top: 12px; }
.history-empty { margin: 8px 0 0; }
.draft-history { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.draft-item {
  display: flex; flex-direction: column; gap: 2px;
  border: 1px solid var(--cc-border); border-radius: 8px; padding: 6px 8px;
}
.draft-restore {
  display: flex; flex-direction: column; gap: 2px; align-items: flex-start;
  border: none; background: transparent; padding: 2px 0; text-align: left;
  cursor: pointer; color: var(--cc-text); font-family: inherit;
}
.draft-restore:hover:not(:disabled) .draft-title { color: var(--cc-primary); }
.draft-restore:disabled { cursor: not-allowed; opacity: 0.6; }
.draft-title { font-size: 12.5px; font-weight: 600; line-height: 1.5; }
.draft-meta { font-size: 11px; color: var(--cc-text-faint); line-height: 1.5; }
.draft-actions { display: flex; gap: 2px; }
</style>
