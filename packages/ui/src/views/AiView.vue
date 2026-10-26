<script setup lang="ts">
defineOptions({ name: 'AiView' })
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue"
import { ElMessage } from 'element-plus'
import { RISK_META, formatBytes, formatTime } from '@cordclean/shared'
import {
  analyzeAi,
  cancelAi,
  startClean,
  refreshHistory,
  refreshQuarantine,
  applyAiRule,
  aiPluginConfig,
  enableAiPlugin,
  fetchAiModels,
  fetchEgress,
  probeAi,
  refreshAiStatus,
  refreshPlugins,
  saveAiConfig,
  dryRunAiRule,
  draftAiPlugin,
  validateAiPlugin,
  installAiPlugin,
  patchSettings,
  state,
} from '../api/store.ts'

/** 推荐地址：切换形态时一键填入 */
const RECOMMENDED_BASE: Record<string, string> = {
  chat: 'https://api.deepseek.com',
  messages: 'https://api.deepseek.com/anthropic',
  responses: 'https://api.deepseek.com',
}

const SHAPES = [
  { value: 'chat', label: 'chat（OpenAI Chat Completions）', hint: 'POST /chat/completions，DeepSeek 默认形态' },
  { value: 'messages', label: 'messages（Anthropic Messages）', hint: 'POST /anthropic/v1/messages' },
  { value: 'responses', label: 'responses（OpenAI Responses）', hint: 'POST /responses' },
]
const EFFORTS = [
  { value: 'auto', label: 'auto（不干预，用接口默认值）' },
  { value: 'off', label: 'off（关闭思考，最快）' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium（映射为 high）' },
  { value: 'high', label: 'high' },
  { value: 'max', label: 'max' },
]
const JSON_MODES = [
  { value: 'auto', label: 'auto（接口支持就启用）' },
  { value: 'on', label: 'on' },
  { value: 'off', label: 'off' },
]

const extra = ref('')
const running = computed(() => state.busy)
const saving = ref(false)
const probing = ref(false)
const loadingModels = ref(false)
const showAdvanced = ref(false)
const showReasoning = ref(false)
const formError = ref('')

const form = reactive({
  apiShape: 'chat',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  effort: 'auto',
  stream: true,
  jsonMode: 'auto',
  maxTokens: 3000,
  timeoutMs: 90000,
  apiKey: '',
  asEvaluator: false,
  contextProviders: [] as string[],
  extraBody: '',
  extraHeaders: '',
})

/**
 * 表单是否被用户改动过。
 * 用于避免「分析完成后刷新 aiStatus / 插件列表」触发的配置回填把未保存的配置覆盖回默认值。
 * 使用 sync 刷新：syncFromConfig 的写入靠 syncingForm 抑制，不会误标脏。
 */
const formDirty = ref(false)
/** syncFromConfig 写入表单期间抑制 dirty 标记 */
let syncingForm = false
watch(
  form,
  () => {
    if (!syncingForm) formDirty.value = true
  },
  { deep: true, flush: 'sync' },
)

const onlineAi = computed(() => (state.settings as any).privacy?.onlineAi !== false)
const egress = ref<{ stats: { requests: number; bytes: number; tokens: number }; records: any[] } | null>(null)
const egressOpen = ref(false)
const available = computed(() => state.aiStatus.available)
const configured = computed(() => state.aiStatus.configured)
const analysis = computed(() => state.ai)
const probe = computed(() => state.aiProbe ?? state.aiStatus.lastProbe)
const modelOptions = computed(() => state.aiModels)
const currentModel = computed(() => modelOptions.value.find((model) => model.id === form.model))
/** 模型名手动输入模式：候选列表不可用/想用任意模型名时切换成普通输入框 */
const manualModel = ref(false)

/** 已自动拉取模型列表的配置指纹：同一配置只自动拉一次（手动「获取模型」不受限） */
let autoModelsKey = ''

/** 当前 AI 配置指纹（形态 / 地址 / 模型 / 是否已有凭据） */
function aiConfigFingerprint(): string {
  const config = aiPluginConfig()
  const status = state.aiStatus
  const shape = String(config.apiShape ?? status.shape ?? 'chat')
  const baseUrl = String(config.baseUrl ?? status.baseUrl ?? '')
  const model = String(config.model ?? status.model ?? '')
  return `${shape}|${baseUrl}|${model}|${configured.value}`
}

/**
 * 静默自动拉取模型候选（进页面 / 插件启用 / 凭据就绪时各一次）。
 * - 加载期间不清空已有候选（fetchAiModels 只在成功后整体替换）；
 * - 失败静默回退内置目录，不打扰用户；手动「获取模型」仍可强制刷新。
 */
async function autoLoadModels(): Promise<void> {
  if (!configured.value || loadingModels.value) return
  const fingerprint = aiConfigFingerprint()
  if (fingerprint === autoModelsKey) return
  autoModelsKey = fingerprint
  loadingModels.value = true
  try {
    await fetchAiModels(false)
  } catch {
    /* 静默失败：保留现有候选与内置目录 */
  } finally {
    loadingModels.value = false
  }
}

/* ------------------------------------------------------------------ */
/* 生命周期：状态刷新与自动预取                                        */
/* ------------------------------------------------------------------ */

// 打开页面：刷新 AI 状态；凭据已就绪则静默预取一次模型候选（失败回退内置目录）
onMounted(() => {
  refreshAiStatus().catch(() => undefined)
  if (configured.value) void autoLoadModels()
})

// 插件启用状态变化：刷新运行时状态；首次启用时无条件用已保存配置回填表单并预取模型
watch(
  () => state.plugins?.find((plugin) => plugin.id === 'ai')?.enabled === true,
  (enabled, previous) => {
    if (!enabled) return
    refreshAiStatus().catch(() => undefined)
    if (!previous) {
      formDirty.value = false
      syncFromConfig()
    }
    void autoLoadModels()
  },
)

// 凭据从「无」到「有」时自动拉一次模型候选（provider 列表不用等第一次分析）
watch(configured, (value, previous) => {
  if (value && !previous) void autoLoadModels()
})

/**
 * 用插件配置回填表单。
 * 写入期间抑制 dirty 标记（回填不是用户改动）；回填完成后视为「表单与已保存配置一致」。
 */
function syncFromConfig() {
  syncingForm = true
  try {
    const config = aiPluginConfig()
    const status = state.aiStatus
    form.apiShape = String(config.apiShape ?? status.shape ?? 'chat')
    form.baseUrl = String(config.baseUrl ?? status.baseUrl ?? RECOMMENDED_BASE[form.apiShape] ?? '')
    form.model = String(config.model ?? status.model ?? 'deepseek-flash')
    form.effort = String(config.reasoningEffort ?? status.effort ?? 'auto')
    form.stream = config.stream !== false
    form.jsonMode = String(config.jsonMode ?? status.jsonMode ?? 'auto')
    // 旧默认 1200 / 2048 统一提升到 3000：未设置（0/NaN）用 3000，已保存的更小值在界面上显示 3000（保存后生效）
    const savedMaxTokens = Number(config.maxTokens)
    form.maxTokens = savedMaxTokens > 0 ? (savedMaxTokens < 3000 ? 3000 : savedMaxTokens) : 3000
    form.timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 90000
    form.apiKey = String(config.apiKey ?? '')
    form.asEvaluator = config.asEvaluator === true
    const configuredContext = Array.isArray(config.contextProviders) ? [...config.contextProviders] : []
    const defaultContext = (state.aiStatus.contextAvailable ?? []).filter((item) => item.defaultEnabled).map((item) => item.id)
    let savedContext: string[] = []
    try {
      const raw = localStorage.getItem('cordclean.ai.context')
      savedContext = Array.isArray(JSON.parse(raw ?? '[]')) ? JSON.parse(raw ?? '[]') : []
    } catch {}
    form.contextProviders = savedContext.length ? savedContext : (configuredContext.length ? configuredContext : defaultContext)
    form.extraBody = config.extraBody && Object.keys(config.extraBody).length ? JSON.stringify(config.extraBody, null, 2) : ''
    form.extraHeaders = config.extraHeaders && Object.keys(config.extraHeaders).length ? JSON.stringify(config.extraHeaders, null, 2) : ''
  } finally {
    syncingForm = false
    formDirty.value = false
  }
}

// 插件/运行时状态刷新时的回填：仅在表单未脏时进行。
// 关键修复：analyzeAi 结束后会刷新 aiStatus，此时绝不能把用户未保存的表单覆盖回默认值。
watch(
  () => [state.plugins, state.aiStatus] as const,
  () => {
    if (!formDirty.value) syncFromConfig()
  },
  { immediate: true, deep: true },
)

// 切换形态时，如果当前地址还是「某个推荐地址」，就顺手换成新形态的推荐地址
watch(
  () => form.apiShape,
  (shape) => {
    const defaults = Object.values(RECOMMENDED_BASE)
    if (!form.baseUrl || defaults.includes(form.baseUrl)) {
      form.baseUrl = RECOMMENDED_BASE[shape] ?? form.baseUrl
    }
  },
)

function applyRecommendedBase() {
  form.baseUrl = RECOMMENDED_BASE[form.apiShape] ?? form.baseUrl
}

async function enablePlugin() {
  try {
    await enableAiPlugin()
    ElMessage.success('AI 插件已启用')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function loadModels() {
  loadingModels.value = true
  try {
    const result = await fetchAiModels(true)
    // 手动刷新成功即视为「当前配置已拉取过」，避免自动预取重复请求
    autoModelsKey = aiConfigFingerprint()
    ElMessage.success(`获取到 ${result.count} 个模型（来源：${result.source === 'remote' ? '接口' : '内置目录'}）`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    loadingModels.value = false
  }
}

/**
 * 校验并保存表单到插件配置（热重载）。
 * @param silent 静默模式（分析前自动保存）：成功不弹提示、不刷新模型列表；失败给出错误提示
 * @returns 是否保存成功（额外参数 JSON 非法或请求失败返回 false）
 */
async function saveForm(silent = false): Promise<boolean> {
  formError.value = ''
  let extraBody: Record<string, unknown> = {}
  let extraHeaders: Record<string, unknown> = {}
  try {
    extraBody = form.extraBody.trim() ? JSON.parse(form.extraBody) : {}
    extraHeaders = form.extraHeaders.trim() ? JSON.parse(form.extraHeaders) : {}
  } catch (error) {
    formError.value = '额外参数必须是合法 JSON：' + (error instanceof Error ? error.message : String(error))
    return false
  }
  saving.value = true
  try {
    await saveAiConfig({
      apiShape: form.apiShape,
      baseUrl: form.baseUrl.trim(),
      model: form.model.trim(),
      reasoningEffort: form.effort,
      stream: form.stream,
      jsonMode: form.jsonMode,
      maxTokens: Number(form.maxTokens),
      timeoutMs: Number(form.timeoutMs),
      apiKey: form.apiKey.trim(),
      asEvaluator: form.asEvaluator,
      contextProviders: form.contextProviders,
      extraBody,
      extraHeaders,
    })
    // 已落盘：之后的状态刷新可以安全回填，且表单值等于已保存配置
    formDirty.value = false
    syncFromConfig()
    if (!silent) {
      ElMessage.success('接口配置已保存，插件已热重载')
      await loadModels()
    }
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    formError.value = message
    ElMessage.error('接口配置保存失败：' + message)
    return false
  } finally {
    saving.value = false
  }
}

/** 「保存并热重载」按钮 */
async function save(): Promise<void> {
  await saveForm(false)
}

async function doProbe() {
  probing.value = true
  try {
    const result = await probeAi()
    if (result.ok) ElMessage.success(`连通正常：${result.latencyMs} ms（${result.shape} / ${result.model}）`)
    else ElMessage.error(`连通失败：${result.error ?? '未知错误'}`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    probing.value = false
  }
}

async function loadEgress() {
  try {
    egress.value = await fetchEgress(10)
    egressOpen.value = true
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function run() {
  if (running.value || saving.value) return
  // 表单有未保存改动时先自动保存并热重载：保证内核使用的配置与界面一致，
  // 也避免分析完成后的状态刷新把未保存配置覆盖回默认值。
  if (formDirty.value) {
    const saved = await saveForm(true)
    if (!saved) return
  }
  // running 是 state.busy 的只读派生值，由 analyzeAi 内部维护，这里不再手动赋值
  try {
    await analyzeAi(
      undefined,
      [...form.contextProviders],
      visionImage.value ? { ...visionImage.value } : undefined,
      extra.value.trim() || undefined,
    )
    ElMessage.success('AI 分析完成')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function adoptRule(rule: any, index: number) {
  try {
    const result = await applyAiRule(rule)
    if (result.applied) {
      ElMessage.success('规则已加入规则库并生效')
      analysis.value?.ruleSuggestions?.splice(index, 1)
    } else {
      ElMessage.warning(result.reason ?? '规则被拒绝')
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

watch(
  () => form.contextProviders,
  (value) => {
    try {
      localStorage.setItem('cordclean.ai.context', JSON.stringify(value))
    } catch {}
  },
  { deep: true },
)

const visionImage = ref<{ mime: string; data: string; name: string } | null>(null)

function onVisionFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  if (file.size > 3 * 1024 * 1024) { ElMessage.warning('图片请小于 3MB'); return }
  const reader = new FileReader()
  reader.onload = () => {
    const url = String(reader.result)
    const mime = url.match(/data:([^;]+);base64/)?.[1] ?? 'image/png'
    const data = url.split(',')[1] ?? ''
    visionImage.value = { mime, data, name: file.name }
  }
  reader.readAsDataURL(file)
}

const rootSuggestions = computed(() => analysis.value?.rootSuggestions ?? [])

async function addSuggestedRoots() {
  const existing = state.settings?.analysis.roots ?? []
  const roots = [...existing]
  for (const suggestion of rootSuggestions.value) {
    if (!roots.includes(suggestion.path)) roots.push(suggestion.path)
  }
  try {
    await patchSettings({ analysis: { roots } })
    ElMessage.success(`已添加 ${rootSuggestions.value.length} 个扫描根，下次扫描生效`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

const workshopOpen = ref(false)
const workshopRequirement = ref('')
const workshopDraft = ref<{
  name: string
  code: string
  notes: string
  dependencies: Record<string, string>
  mode?: 'native' | 'worker'
  kind?: string
  format?: 'single-file' | 'package'
  manifest?: {
    id?: string
    name?: string
    version?: string
    apiVersion?: number
    engines?: { cordclean?: string }
    entry?: string
    permissions?: { services?: string[]; network?: boolean; subprocess?: boolean }
    client?: { mode?: string; entry?: string }
  }
  files?: Array<{ path: string; content: string }>
} | null>(null)
const workshopValidation = ref<{ ok: boolean; errors: string[]; warnings: string[] } | null>(null)
const workshopReviewed = ref(false)
const workshopDependenciesAccepted = ref(false)
const workshopBusy = ref(false)
const workshopInstalling = ref(false)
const workshopError = ref('')
const workshopElapsed = ref(0)
let workshopElapsedTimer: ReturnType<typeof setInterval> | null = null
let workshopRequest = 0
let workshopValidateTimer: ReturnType<typeof setTimeout> | null = null

function startWorkshopElapsed(): void {
  if (workshopElapsedTimer) clearInterval(workshopElapsedTimer)
  workshopElapsed.value = 0
  workshopElapsedTimer = setInterval(() => {
    workshopElapsed.value += 1
  }, 1000)
}

function stopWorkshopElapsed(): void {
  if (workshopElapsedTimer) {
    clearInterval(workshopElapsedTimer)
    workshopElapsedTimer = null
  }
}

onUnmounted(() => {
  stopWorkshopElapsed()
  if (workshopValidateTimer) {
    clearTimeout(workshopValidateTimer)
    workshopValidateTimer = null
  }
})

function cancelWorkshopGeneration(): void {
  if (!workshopBusy.value) return
  // 客户端取消等待：使当前请求结果失效；模型 HTTP 请求可能已发出，不能保证服务端立刻停止
  workshopRequest += 1
  workshopBusy.value = false
  stopWorkshopElapsed()
  workshopOpen.value = false
  ElMessage.info('已取消等待生成；模型请求可能仍在后台完成，但不会自动安装')
}

function discardWorkshopDraft(): void {
  workshopOpen.value = false
  workshopDraft.value = null
  workshopValidation.value = null
  workshopReviewed.value = false
  workshopDependenciesAccepted.value = false
  workshopError.value = ''
}

async function generateWorkshopDraft() {
  if (!workshopRequirement.value.trim()) {
    ElMessage.warning('先写一句需求')
    return
  }
  const requestId = ++workshopRequest
  // 立即打开弹窗显示进度，避免“点了没反应直到草稿出现”的错觉
  workshopOpen.value = true
  workshopBusy.value = true
  workshopElapsed.value = 0
  startWorkshopElapsed()
  workshopError.value = ''
  workshopDraft.value = null
  workshopValidation.value = null
  workshopReviewed.value = false
  workshopDependenciesAccepted.value = false
  try {
    const draft = await draftAiPlugin(workshopRequirement.value.trim())
    if (requestId !== workshopRequest) return
    workshopDraft.value = draft
    const validation = await validateAiPlugin(
      draft.code,
      draft.dependencies ?? {},
      draft.mode === 'native',
      { format: draft.format, manifest: draft.manifest as any, files: draft.files },
    )
    // 校验也可能是慢 RPC：用户在校验期间点了取消，就不能再把弹窗/草稿写回来
    if (requestId !== workshopRequest) return
    workshopValidation.value = validation
    workshopReviewed.value = false
    // 即使用户之前把弹窗关掉，结果到了也重新打开，避免草稿“生成好了就没了”
    workshopOpen.value = true
  } catch (error) {
    if (requestId === workshopRequest) {
      workshopError.value = error instanceof Error ? error.message : String(error)
      workshopOpen.value = true
    }
  } finally {
    if (requestId === workshopRequest) {
      workshopBusy.value = false
      stopWorkshopElapsed()
    }
  }
}

/** 编辑代码时防抖校验，避免每敲一个字都发一次宿主校验请求 */
function scheduleRevalidateWorkshopDraft() {
  if (!workshopDraft.value) return
  // 代码一改就立即视为“未校验/未重新审阅”，防止用旧校验结果误装
  workshopValidation.value = null
  workshopReviewed.value = false
  if (workshopValidateTimer) clearTimeout(workshopValidateTimer)
  workshopValidateTimer = setTimeout(() => {
    workshopValidateTimer = null
    void revalidateWorkshopDraft()
  }, 400)
}

let workshopValidateSeq = 0

async function revalidateWorkshopDraft() {
  if (!workshopDraft.value) return
  const seq = ++workshopValidateSeq
  const draft = workshopDraft.value
  try {
    const validation = await validateAiPlugin(draft.code, draft.dependencies ?? {}, draft.mode === 'native', {
      format: draft.format,
      manifest: draft.manifest as any,
      files: draft.files,
    })
    // 只接受最后一次编辑对应的校验结果，避免旧校验覆盖新代码
    if (seq === workshopValidateSeq && workshopDraft.value?.code === draft.code) {
      workshopValidation.value = validation
    }
  } catch (error) {
    if (seq === workshopValidateSeq && workshopDraft.value?.code === draft.code) {
      workshopValidation.value = {
        ok: false,
        errors: [error instanceof Error ? error.message : String(error)],
        warnings: [],
      }
    }
  }
}

async function installWorkshopDraft() {
  if (workshopInstalling.value) return
  if (!workshopDraft.value || !workshopValidation.value?.ok || !workshopReviewed.value) return
  const dependencies = workshopDraft.value.dependencies ?? {}
  const hasDependencies = Object.keys(dependencies).length > 0
  if (hasDependencies && !workshopDependenciesAccepted.value) return
  workshopInstalling.value = true
  try {
    const result = await installAiPlugin(
      workshopDraft.value.name,
      workshopDraft.value.code,
      dependencies,
      workshopDependenciesAccepted.value,
      workshopDraft.value.mode === 'native',
      {
        format: workshopDraft.value.format,
        manifest: workshopDraft.value.manifest as any,
        files: workshopDraft.value.files,
        acknowledgePermissions: true,
      },
    )
    workshopOpen.value = false
    workshopDraft.value = null
    workshopValidation.value = null
    workshopReviewed.value = false
    workshopDependenciesAccepted.value = false
    workshopRequirement.value = ''
    // 安装后刷新插件列表，用户能立刻在「插件」页看到新插件与任务
    await refreshPlugins()
    ElMessage.success('已安装并启用：' + result.id + '（重启后自动加载，可在插件页查看）')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    workshopInstalling.value = false
  }
}

const dryRunOpen = ref(false)
const dryRunResult = ref<any>(null)
const dryRunLoading = ref(false)

async function previewRule(rule: any) {
  dryRunLoading.value = true
  dryRunOpen.value = true
  dryRunResult.value = null
  try {
    dryRunResult.value = await dryRunAiRule(rule)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    dryRunLoading.value = false
  }
}

const selectionOpen = ref(false)
const applyingSelection = ref(false)
const selectionRows = computed(() => {
  const items = new Map((state.scan?.items ?? []).map((item) => [item.id, item]))
  return (analysis.value?.selection ?? []).map((entry) => {
    const item = items.get(entry.itemId)
    return {
      id: entry.itemId,
      path: item?.path ?? '(不在当前扫描结果中，已失效)',
      size: item?.size ?? 0,
      task: item?.taskId ?? '',
      reason: entry.reason,
    }
  })
})

async function applyAiSelection() {
  if (applyingSelection.value) return
  const ids = selectionRows.value.filter((row) => row.size > 0).map((row) => row.id)
  if (!ids.length) {
    ElMessage.warning('这些项已不在当前扫描结果中，请重新扫描后再试')
    return
  }
  applyingSelection.value = true
  try {
    const report = await startClean(ids)
    await Promise.all([refreshHistory(), refreshQuarantine()])
    selectionOpen.value = false
    if (report.cancelled) {
      ElMessage.warning(`清理已取消，已处理 ${report.cleaned} 项`)
    } else {
      ElMessage.success(`已按 AI 建议清理 ${report.cleaned} 项，释放 ${formatBytes(report.freedBytes)}`)
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    applyingSelection.value = false
  }
}

const shapeLabel = computed(() => SHAPES.find((item) => item.value === form.apiShape)?.value ?? form.apiShape)
const effortLabel = computed(() => EFFORTS.find((item) => item.value === form.effort)?.value ?? form.effort)
</script>

<template>
  <div class="cc-page">
    <div class="cc-page-title">
      <div>
        <h1>AI 清理顾问</h1>
        <p>支持 chat / messages / responses 三种接口形态，模型、推理等级与请求参数都可以现场修改。</p>
      </div>
      <div class="cc-actions">
        <el-button :loading="loadingModels" :disabled="!available" @click="loadModels">获取模型</el-button>
        <el-button :disabled="!available" @click="loadEgress">外发记录</el-button>
        <el-button v-if="running" type="danger" plain @click="cancelAi()">取消生成</el-button>
        <el-button :loading="probing" :disabled="!available || !configured" @click="doProbe">测试连接</el-button>
        <el-button type="primary" :loading="running" :disabled="!available || !configured" @click="run">
          {{ analysis ? '重新分析' : '开始分析' }}
        </el-button>
      </div>
    </div>

    <el-alert v-if="!available" type="warning" :closable="false" show-icon>
      <template #title>AI 插件未启用</template>
      <div class="alert-body">
        请先启用「AI 清理顾问」插件；启用后会读取环境变量 <code>DEEPSEEK_API_KEY</code> 或在下方填写 Key。
        <el-button size="small" type="primary" plain @click="enablePlugin">立即启用</el-button>
      </div>
    </el-alert>

    <template v-else>
      <!-- 运行状态：全部来自当前表单/实时状态，避免“固定的无用信息” -->
      <div class="status-bar">
        <span class="cc-pill" :class="{ 'status-active': configured }">
          {{ configured ? '凭据已配置' : '未配置 API Key' }}
        </span>
        <span class="cc-pill" :class="{ 'status-active': !formDirty, 'status-error': formDirty }">
          {{ formDirty ? '有未保存修改（分析前会自动保存）' : '配置已保存' }}
        </span>
        <span class="cc-pill">将使用：{{ form.apiShape }} · {{ form.model || '—' }}</span>
        <span class="cc-pill">推理：{{ form.effort }}</span>
        <span class="cc-pill">JSON：{{ form.jsonMode }}</span>
        <span class="cc-pill">最大输出：{{ form.maxTokens }} tokens</span>
        <span v-if="probe" class="cc-pill" :class="{ 'status-active': probe.ok, 'status-error': !probe.ok }">
          探测：{{ probe.ok ? `${probe.latencyMs} ms` : '失败' }}
        </span>
        <span v-if="state.aiModelsSource" class="cc-pill">
          模型来源：{{ state.aiModelsSource === 'remote' ? '接口' : '内置目录' }}
        </span>
      </div>

      <!-- 接口设置 -->
    <div class="cc-card">
        <div class="cc-card-title">
          <h3>⚙️ 接口设置</h3>
          <div class="cc-actions">
            <el-button size="small" text @click="showAdvanced = !showAdvanced">
              {{ showAdvanced ? '收起高级参数' : '高级参数（extraBody / extraHeaders）' }}
            </el-button>
          </div>
        </div>

        <el-form label-position="top" class="setting-form">
          <el-form-item label="接口形态">
            <el-select v-model="form.apiShape" style="width: 100%">
              <el-option v-for="item in SHAPES" :key="item.value" :label="item.label" :value="item.value">
                <span>{{ item.label }}</span>
                <span class="option-hint">{{ item.hint }}</span>
              </el-option>
            </el-select>
          </el-form-item>

          <el-form-item>
            <template #label>
              <span>接口地址 baseUrl</span>
              <el-button text size="small" class="inline-btn" @click="applyRecommendedBase">填入推荐地址</el-button>
            </template>
            <el-input v-model="form.baseUrl" placeholder="https://api.deepseek.com" />
          </el-form-item>

          <el-form-item label="模型">
            <template v-if="manualModel">
              <el-input v-model="form.model" placeholder="直接输入模型名，例如 deepseek-flash" />
            </template>
            <el-select
              v-else
              v-model="form.model"
              filterable
              allow-create
              default-first-option
              style="width: 100%"
              placeholder="选择或直接输入模型名（回车确认）"
            >
              <el-option v-for="model in modelOptions" :key="model.id" :label="model.id" :value="model.id">
                <span>{{ model.id }}</span>
                <span class="option-hint">
                  {{ model.name ?? '' }}
                  <template v-if="model.contextWindow">· {{ Math.round(model.contextWindow / 1000) }}k</template>
                </span>
              </el-option>
              <!-- 手动输入 / 已保存但不在候选里的模型名也要能正常显示 -->
              <el-option
                v-if="form.model && !modelOptions.some((model) => model.id === form.model)"
                :key="`manual:${form.model}`"
                :label="form.model"
                :value="form.model"
              />
            </el-select>
            <div class="cc-hint">
              候选来自接口或内置目录（「获取模型」失败时自动回退）；默认使用 <code>deepseek-flash</code>。
              <el-button text size="small" @click="manualModel = !manualModel">
                {{ manualModel ? '从候选列表选择' : '手动输入模型名' }}
              </el-button>
            </div>
            <div v-if="!manualModel && form.model && modelOptions.length" class="cc-hint">
              <template v-if="currentModel">
                当前模型版本：{{ currentModel.name || '官方未提供显示名' }}
                <template v-if="currentModel.contextWindow">· 上下文 {{ Math.round(currentModel.contextWindow / 1000) }}k</template>
              </template>
              <template v-else>自定义模型名（官方 /models 未返回该 ID），会原样发送给接口。</template>
            </div>
          </el-form-item>

          <el-form-item label="推理等级">
            <el-select v-model="form.effort" style="width: 100%">
              <el-option v-for="item in EFFORTS" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>

          <el-form-item label="JSON 输出">
            <el-select v-model="form.jsonMode" style="width: 100%">
              <el-option v-for="item in JSON_MODES" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>

          <el-form-item label="最大输出 token">
            <el-input-number v-model="form.maxTokens" :min="128" :max="65536" :step="512" style="width: 100%" />
          </el-form-item>

          <el-form-item label="超时（毫秒）">
            <el-input-number v-model="form.timeoutMs" :min="3000" :max="600000" :step="5000" style="width: 100%" />
          </el-form-item>

          <el-form-item label="作为规则评估器">
            <el-switch v-model="form.asEvaluator" />
            <div class="cc-hint">开启后扫描时用 AI 判断每类规则的风险与默认勾选；关闭则用内置启发式</div>
          </el-form-item>
          <el-form-item label="API Key">
            <el-input
              v-model="form.apiKey"
              type="password"
              show-password
              placeholder="留空则读取环境变量 DEEPSEEK_API_KEY"
            />
          </el-form-item>
        </el-form>

        <div v-if="showAdvanced" class="advanced">
          <div class="advanced-item">
            <label>额外请求体 extraBody（深合并，优先级最高）</label>
            <el-input
              v-model="form.extraBody"
              type="textarea"
              :rows="4"
              spellcheck="false"
              placeholder='例如 {"top_p": 0.95, "thinking": {"type": "disabled"}}'
            />
            <div class="cc-hint">
              厂商以后新增参数（新的推理字段、工具、缓存策略等）时，直接写在这里即可，不需要升级插件。
            </div>
          </div>
          <div class="advanced-item">
            <label>额外请求头 extraHeaders</label>
            <el-input
              v-model="form.extraHeaders"
              type="textarea"
              :rows="3"
              spellcheck="false"
              placeholder='例如 {"x-api-key": "...", "anthropic-beta": "..."}'
            />
          </div>
        </div>

        <p v-if="formError" class="error-text">{{ formError }}</p>

        <div class="cc-actions">
          <el-button type="primary" :loading="saving" @click="save">保存并热重载</el-button>
          <span class="cc-faint">
            保存会写入插件配置并调用 Cordis 的 fiber.update 热重载；Key 只存在本机 config.json。
          </span>
        </div>
      </div>

      <!-- 分析输入 -->

      <div class="cc-card">
        <div class="cc-card-title">
          <h3>🔍 分析范围（上下文采集器）</h3>
          <span class="cc-faint">勾选即生效（分析时按当前勾选发送）；采集器只输出脱敏摘要</span>
        </div>
        <el-checkbox-group v-model="form.contextProviders">
          <el-checkbox
            v-for="provider in state.aiStatus.contextAvailable ?? []"
            :key="provider.id"
            :value="provider.id"
            :title="provider.description"
          >
            {{ provider.name }}
            <span class="cc-faint">{{ provider.description }}</span>
          </el-checkbox>
        </el-checkbox-group>
        <p v-if="!(state.aiStatus.contextAvailable ?? []).length" class="cc-faint">暂无采集器（需要 AI 插件处于启用状态）</p>
      </div>

      <div class="cc-card">
        <div class="cc-card-title">
          <h3>🖼️ 截图诊断（可选）</h3>
          <span class="cc-faint">仅 deepseek-flash 支持；截图会发送给模型，请勿包含隐私</span>
        </div>
        <input type="file" accept="image/png,image/jpeg" @change="onVisionFile" />
        <div v-if="visionImage" style="margin-top: 8px">
          <el-tag closable @close="visionImage = null">{{ visionImage.name }}</el-tag>
          <img :src="'data:' + visionImage.mime + ';base64,' + visionImage.data" style="max-height: 160px; margin-top: 8px; border-radius: 8px" />
        </div>
      </div>

    <div class="cc-card">
        <div class="cc-card-title">
          <h3>🧠 补充说明（可选）</h3>
          <span class="cc-faint">例如：这台机器主要用于视频剪辑，希望保留素材缓存</span>
        </div>
        <el-input v-model="extra" type="textarea" :rows="2" placeholder="告诉 AI 你的使用习惯，建议会更准确…" />
      </div>

      <div v-if="state.busy && state.aiStream" class="cc-card">
        <div class="cc-card-title"><h3>⏳ 正在生成…</h3><span class="cc-faint">流式输出，完成后自动解析</span></div>
        <pre class="stream-box">{{ state.aiStream }}</pre>
      </div>

      <div class="cc-card">
        <div class="cc-card-title"><h3>🧪 AI 插件工坊</h3><span class="cc-faint">已独立为单独页面</span></div>
        <p class="cc-hint">
          生成原生 Cordis 插件、产出 v2 插件包（清单 + 入口 + 可选 client 页面）与安装审阅已移到「AI 插件工坊」页面；
          本页只负责清理建议分析。两页都可以直接使用，不需要先分析。
        </p>
        <el-button type="primary" plain @click="state.page = 'workshop'">前往 AI 插件工坊</el-button>
      </div>

      <!-- 分析结果 -->
      <template v-if="analysis">
    <div class="cc-card">
          <div class="cc-card-title">
            <h3>📌 分析摘要</h3>
            <div class="meta-chips">
              <span class="cc-pill">{{ analysis.model }}</span>
              <span v-if="analysis.shape" class="cc-pill">{{ analysis.shape }}</span>
              <span v-if="analysis.latencyMs" class="cc-pill">{{ (analysis.latencyMs / 1000).toFixed(1) }} s</span>
              <span v-if="analysis.usage" class="cc-pill">
                token {{ analysis.usage.inputTokens }} → {{ analysis.usage.outputTokens }}（思维链 {{ analysis.usage.reasoningTokens }}）
              </span>
              <span class="cc-pill">{{ formatTime(analysis.createdAt) }}</span>
            </div>
          </div>
          <p class="summary">{{ analysis.summary }}</p>
          <ul v-if="analysis.observations.length" class="observations">
            <li v-for="(item, index) in analysis.observations" :key="index">{{ item }}</li>
          </ul>
          <el-collapse v-if="analysis.reasoning" class="reasoning">
            <el-collapse-item :title="`查看思维链（${analysis.reasoning.length} 字）`">
              <pre class="reasoning-text">{{ analysis.reasoning }}</pre>
            </el-collapse-item>
          </el-collapse>
        </div>

        <div v-if="analysis.ruleSuggestions?.length" class="cc-card">
          <div class="cc-card-title"><h3>🧩 AI 建议的新规则</h3><span class="cc-faint">采纳后会经过校验并热加载，立即可用</span></div>
          <div v-for="(rule, index) in analysis.ruleSuggestions" :key="index" class="rule-suggestion">
            <div>
              <strong>{{ rule.name }}</strong>
              <span class="cc-pill">{{ rule.category }}</span>
              <span class="cc-pill" :class="'risk-' + rule.risk">{{ rule.risk }}</span>
              <p class="cc-faint">{{ rule.reason }}</p>
              <code>{{ rule.target.type }} · {{ rule.target.path || rule.target.base || rule.target.pattern }}</code>
            </div>
            <div class="rule-actions">
              <el-button size="small" @click="previewRule(rule)">试运行</el-button>
              <el-button size="small" type="primary" plain @click="adoptRule(rule, index)">采纳</el-button>
            </div>
          </div>
        </div>

        <div v-if="rootSuggestions.length" class="cc-card">
        <div class="cc-card-title">
          <h3>📁 AI 建议新增的扫描根</h3>
          <span class="cc-faint">只来自用户目录一级目录，确认后才写入设置</span>
        </div>
        <div v-for="suggestion in rootSuggestions" :key="suggestion.path" class="root-suggestion">
          <div>
            <div class="root-path">{{ suggestion.path }}</div>
            <div class="cc-faint">{{ formatBytes(suggestion.sizeBytes) }} · {{ suggestion.reason }}</div>
          </div>
        </div>
        <el-button type="primary" plain @click="addSuggestedRoots">添加这些扫描根</el-button>
      </div>

      <div v-if="analysis.selection?.length" class="cc-card">
        <div class="cc-card-title">
          <h3>✅ AI 推荐的清理项</h3>
          <span class="cc-faint">
            共 {{ analysis.selectionSummary?.count ?? analysis.selection.length }} 项 ·
            {{ formatBytes(analysis.selectionSummary?.bytes ?? 0) }} · 只能来自本次扫描结果
          </span>
        </div>
        <p class="cc-hint">确认后会调用补偿链（路径策略 / 预算 / 预览一致性 / 回收站），与手动清理完全同一条路径。</p>
        <el-button type="primary" @click="selectionOpen = true">对比并应用</el-button>
      </div>

    <el-dialog v-model="dryRunOpen" title="规则试运行（只读，不会删除）" width="720px">
      <p v-if="dryRunLoading" class="cc-faint">正在统计命中项…</p>
      <template v-else-if="dryRunResult">
        <p>
          命中 <strong>{{ dryRunResult.count }}</strong> 项，约 <strong>{{ formatBytes(dryRunResult.bytes) }}</strong>
          <span v-if="!dryRunResult.ok" class="cc-faint">· {{ dryRunResult.reason }}</span>
        </p>
        <p v-if="dryRunResult.missing?.length" class="cc-faint">不存在的路径：{{ dryRunResult.missing.join('、') }}</p>
        <el-table :data="dryRunResult.samples" size="small" max-height="320">
          <el-table-column prop="path" label="路径" min-width="300" show-overflow-tooltip />
          <el-table-column label="大小" width="100">
            <template #default="{ row }">{{ formatBytes(row.bytes) }}</template>
          </el-table-column>
          <el-table-column prop="kind" label="类型" width="80" />
        </el-table>
      </template>
      <template #footer><el-button @click="dryRunOpen = false">关闭</el-button></template>
    </el-dialog>

    <el-dialog v-model="selectionOpen" title="确认清理 AI 推荐的项" width="720px">
        <p class="cc-hint">共 {{ selectionRows.length }} 项，合计 {{ formatBytes(analysis?.selectionSummary?.bytes ?? 0) }}。风险项仍会走隔离区/回收站。</p>
        <el-table :data="selectionRows" size="small" max-height="360">
          <el-table-column prop="path" label="路径" min-width="260" show-overflow-tooltip />
          <el-table-column label="大小" width="100">
            <template #default="{ row }">{{ formatBytes(row.size) }}</template>
          </el-table-column>
          <el-table-column prop="reason" label="AI 理由" min-width="160" show-overflow-tooltip />
        </el-table>
        <template #footer>
          <el-button @click="selectionOpen = false">取消</el-button>
          <el-button type="primary" :loading="applyingSelection" :disabled="applyingSelection" @click="applyAiSelection">确认清理</el-button>
        </template>
      </el-dialog>

      <div class="suggestions">
          <div v-for="suggestion in analysis.suggestions" :key="suggestion.id" class="suggestion-card">
            <div class="suggestion-head">
              <strong>{{ suggestion.title }}</strong>
              <span class="cc-pill" :class="`risk-${suggestion.risk}`">{{ RISK_META[suggestion.risk].name }}</span>
            </div>
            <p class="reason">{{ suggestion.reason }}</p>
            <div class="targets">
              <span v-for="target in suggestion.targets" :key="target" class="target">{{ target }}</span>
            </div>
            <div class="suggestion-foot">
              <span class="cc-faint">预估可释放 {{ formatBytes(suggestion.estimatedBytes) }}</span>
              <span class="cc-faint">置信度 {{ Math.round(suggestion.confidence * 100) }}%</span>
              <span v-if="suggestion.taskId" class="cc-pill">关联任务：{{ suggestion.taskId }}</span>
            </div>
          </div>
        </div>
      </template>

      <div v-else class="cc-card cc-empty">
        点击右上角「开始分析」，AI 会读取磁盘占用、清理任务分布与系统信息后给出建议。
      </div>
    <el-dialog v-model="egressOpen" title="外发记录（不变量 8）" width="760px">
      <p class="cc-faint">
        累计：{{ egress?.stats.requests ?? 0 }} 次请求 / {{ egress?.stats.bytes ?? 0 }} 字节 / token {{ egress?.stats.tokens ?? 0 }}
      </p>
      <div v-for="(record, index) in egress?.records ?? []" :key="index" class="egress-item">
        <div class="cc-faint">
          {{ new Date(record.at).toLocaleString() }} · {{ record.purpose }} · {{ record.url }}
          <span v-if="record.blocked" class="risk-risky">已拦截：{{ record.blocked }}</span>
        </div>
        <pre class="reasoning-text">{{ record.preview || '(无请求体)' }}</pre>
      </div>
      <p v-if="!(egress?.records?.length)" class="cc-empty">还没有外发记录：发起一次分析或测试连接后即可看到。</p>
    </el-dialog>



    </template>
    <div class="cc-card">
      <div class="cc-card-title">
        <h3>🔒 隐私说明</h3>
      </div>
      <p class="cc-hint">
        发送给模型的内容仅包含：磁盘容量与占用、系统版本、CPU/内存、清理任务统计与关键目录体积，
        <b>不包含</b>文件名、路径、文档内容或任何个人文件信息。API Key 仅保存在本机
        <code>config.json</code> 或环境变量中，不会上传到本工具以外的服务器。
      </p>
    </div>
  </div>
</template>

<style scoped>
.rule-suggestion { display: flex; justify-content: space-between; gap: 12px; padding: 10px 0; border-bottom: 1px dashed var(--cc-border); }
.rule-suggestion p { margin: 4px 0; }
.alert-body {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 4px;
}

.status-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.setting-form {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0 16px;
}

@media (max-width: 1280px) {
  .setting-form {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.option-hint {
  float: right;
  color: var(--cc-text-faint);
  font-size: 11px;
  margin-left: 12px;
}

.inline-btn {
  margin-left: 8px;
  padding: 0;
  height: auto;
  font-size: 11.5px;
}

.advanced {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  padding: 12px 0;
  border-top: 1px dashed var(--cc-border);
  margin-bottom: 8px;
}

.advanced-item label {
  display: block;
  font-size: 12px;
  color: var(--cc-text-dim);
  margin-bottom: 6px;
}

@media (max-width: 1100px) {
  .advanced {
    grid-template-columns: 1fr;
  }
}

.error-text {
  color: var(--cc-danger);
  font-size: 12px;
}

.meta-chips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.summary {
  margin: 0;
  line-height: 1.8;
  font-size: 13.5px;
  color: var(--cc-text);
}

.observations {
  margin: 12px 0 0;
  padding-left: 18px;
  color: var(--cc-text-dim);
  font-size: 12.5px;
  line-height: 1.8;
}

.reasoning {
  margin-top: 12px;
}

.reasoning-text {
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--cc-text-dim);
  max-height: 320px;
  overflow: auto;
  margin: 0;
}

.suggestions {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
}

.suggestion-card {
  border: 1px solid var(--cc-border);
  border-radius: var(--cc-radius);
  background: var(--cc-panel);
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.suggestion-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.reason {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--cc-text-dim);
}

.targets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.target {
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 11px;
  background: rgba(79, 140, 255, 0.1);
  border: 1px solid rgba(79, 140, 255, 0.28);
  color: var(--cc-primary);
  padding: 2px 7px;
  border-radius: 6px;
  word-break: break-all;
}

.suggestion-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 11.5px;
  border-top: 1px dashed var(--cc-border);
  padding-top: 8px;
}

code {
  background: var(--cc-primary-soft);
  padding: 1px 5px;
  border-radius: 4px;
}

.workshop-pending {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 14px;
}

.workshop-pending p {
  margin: 4px 0 0;
}
</style>
