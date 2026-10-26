<script setup lang="ts">
/**
 * AI 插件工坊（独立页面 + 独立插件）。
 *
 * 与「AI 建议」分析页分开：本页只做 v2 插件包的生成、审阅与安装；
 * 接口配置保存在独立插件 ai-workshop 的 config 中，安装走 PluginManager.installPackage。
 */
defineOptions({ name: 'AiWorkshopView' })
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { AiModelInfo, AiPluginDraft, AiWorkshopStatus } from '@cordclean/shared'
import {
  cancelAi,
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
const validation = ref<{ ok: boolean; errors: string[]; warnings: string[] } | null>(null)
const busy = ref(false)
const installing = ref(false)
const error = ref('')
const reviewed = ref(false)
const dependenciesAccepted = ref(false)
const elapsed = ref(0)
const activeFile = ref('')
const showAdvanced = ref(true)
const settingsOpen = ref(false)
const manifestText = ref('')
const manifestError = ref('')
let timer: ReturnType<typeof setInterval> | undefined
let validateSeq = 0
let validateTimer: ReturnType<typeof setTimeout> | undefined

const workshopStatus = ref<AiWorkshopStatus | null>(null)
const statusLoading = ref(false)
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

const entryPath = computed(() => draft.value?.manifest?.entry ?? 'index.mjs')
const files = computed<Array<{ path: string; content: string }>>(() => {
  const list = draft.value?.files ?? []
  if (list.length) return list
  if (!draft.value) return []
  return [{ path: entryPath.value, content: draft.value.code }]
})
const activeContent = computed(() => files.value.find((item) => item.path === activeFile.value)?.content ?? '')
const activeSize = computed(() => new Blob([activeContent.value]).size)

function fileSizeText(content: string): string {
  return `${Math.max(1, Math.round(new Blob([content]).size / 1024))}KB`
}
const dependencies = computed(() => Object.entries(draft.value?.dependencies ?? {}))

function openPlugins(): void {
  state.page = 'plugins'
}

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
    if (!silent && workshopStatus.value) {
      const status = workshopStatus.value
      ElMessage.info(
        `插件${status.available ? '已启用' : '未启用'} · API ${status.configured ? '已配置（' + keySourceLabel.value + '）' : '未配置'} · ${status.shape}/${status.model}`,
      )
    }
  } catch (err) {
    workshopStatus.value = null
    if (!silent) ElMessage.error('刷新状态失败：' + (err instanceof Error ? err.message : String(err)))
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
    ElMessage.error(err instanceof Error ? err.message : String(err))
  } finally {
    enabling.value = false
  }
}

async function loadModels(showFeedback = true): Promise<void> {
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
    ElMessage.error('拉取模型失败：' + (err instanceof Error ? err.message : String(err)))
  } finally {
    modelsLoading.value = false
  }
}

async function saveConfig(): Promise<void> {
  savingConfig.value = true
  try {
    await savePluginConfig('ai-workshop', { ...workshopConfig, stream: false })
    await loadWorkshopStatus()
    ElMessage.success(`工坊接口设置已保存并热重载：${workshopConfig.apiShape} · ${workshopConfig.model}`)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
  } finally {
    savingConfig.value = false
  }
}

function resetReview(): void {
  validation.value = null
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
  try {
    const result = await validateAiPlugin(value.code, value.dependencies ?? {}, value.mode === 'native', {
      format: value.format,
      manifest: value.manifest as any,
      files: value.files,
    })
    if (seq === validateSeq && draft.value?.code === value.code) validation.value = result
  } catch (err) {
    if (seq === validateSeq && draft.value?.code === value.code) {
      validation.value = { ok: false, errors: [err instanceof Error ? err.message : String(err)], warnings: [] }
    }
  }
}

function scheduleRevalidate(): void {
  if (validateTimer) clearTimeout(validateTimer)
  validateTimer = setTimeout(() => void revalidate(), 350)
}

async function generate(): Promise<void> {
  if (busy.value || !requirement.value.trim()) return
  if (!available.value) {
    ElMessage.warning('请先启用「AI 插件工坊」插件')
    return
  }
  error.value = ''
  draft.value = null
  validation.value = null
  busy.value = true
  startTimer()
  try {
    draft.value = await draftAiWorkshopPlugin(requirement.value.trim())
    resetReview()
    await revalidate()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
    stopTimer()
  }
}

function cancel(): void {
  void cancelAi().catch(() => {})
  busy.value = false
  stopTimer()
}

function discard(): void {
  draft.value = null
  validation.value = null
  reviewed.value = false
  dependenciesAccepted.value = false
  error.value = ''
}

function updateFileContent(path: string, value: string): void {
  if (!draft.value) return
  const file = draft.value.files?.find((item) => item.path === path)
  if (file) file.content = value
  if (path === entryPath.value) draft.value.code = value
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
    scheduleRevalidate()
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') {
      ElMessage.error(err instanceof Error ? err.message : String(err))
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
    scheduleRevalidate()
  } catch (err) {
    manifestError.value = err instanceof Error ? err.message : String(err)
  }
}

async function install(): Promise<void> {
  if (!draft.value || !validation.value?.ok || !reviewed.value || installing.value) return
  if (dependencies.value.length > 0 && !dependenciesAccepted.value) return
  installing.value = true
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
        manifest: draft.value.manifest as any,
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
    ElMessage.error(err instanceof Error ? err.message : String(err))
  } finally {
    installing.value = false
  }
}

onMounted(async () => {
  await refreshPlugins().catch(() => {})
  loadWorkshopConfig()
  await loadWorkshopStatus()
  void loadModels(false).catch(() => {})
})
onUnmounted(stopTimer)
</script>

<template>
  <div class="workshop-page">
    <div class="workshop-head cc-card">
      <div>
        <h2>🧪 AI 插件工坊</h2>
        <p class="cc-hint">
          用一句话描述 → 生成 <b>v2 插件包</b>（清单 + 多文件 + 可选 <code>client/</code> 页面）→ 静态校验 → 审阅与编辑 → 通过
          staging 安装事务落盘（失败自动回滚）。安装前必须人工确认：插件以完整 Node 权限运行。
        </p>
      </div>
      <div class="workshop-meta">
        <span class="cc-pill" :class="{ 'is-ok': available, 'is-warn': !available }">
          插件 {{ available ? '已启用' : '未启用' }}
        </span>
        <span class="cc-pill" :class="{ 'is-ok': configured, 'is-warn': !configured }">
          {{ available ? (configured ? `API 已配置（${keySourceLabel}）` : 'API 未配置') : '等待启用插件' }}
        </span>
        <span class="cc-pill">{{ shape }} · {{ model }}</span>
        <span class="cc-pill">思考 {{ workshopConfig.reasoningEffort }}</span>
        <span class="cc-pill">v2 多文件插件包</span>
      </div>
    </div>

    <el-alert v-if="workshopStatus && !available" type="warning" :closable="false" show-icon class="workshop-alert">
      「AI 插件工坊」是独立插件，还没有启用；启用后即可使用它自己的 API 接口设置。
      <el-button link type="primary" :loading="enabling" @click="enableWorkshop">立即启用</el-button>
      <el-button link type="primary" @click="openPlugins">去插件页</el-button>
    </el-alert>
    <el-alert v-else-if="available && !configured" type="warning" :closable="false" show-icon class="workshop-alert">
      还没有配置工坊自己的 API Key：打开接口设置填写，或设置环境变量 DEEPSEEK_API_KEY。
      <el-button link type="primary" @click="settingsOpen = true">打开接口设置</el-button>
    </el-alert>

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
          placeholder="例如：写一个 cleaner 插件，清理 %TEMP% 下超过 7 天的 .log 文件，只扫描不自动删除…"
          :disabled="busy || installing"
        />
        <div class="workshop-examples">
          <span v-for="item in EXAMPLES" :key="item" class="cc-pill example" @click="requirement = item">{{ item }}</span>
        </div>
        <div class="workshop-actions">
          <el-button type="primary" :loading="busy" :disabled="busy || installing || !requirement.trim() || !available" @click="generate">
            生成 v2 插件包草稿
          </el-button>
          <el-button v-if="busy" @click="cancel">取消生成</el-button>
        </div>
        <p v-if="busy" class="cc-hint">已等待 {{ elapsed }} 秒；生成后还会做静态契约与语法校验，大模型慢时可能需要 30~90 秒。</p>
        <p v-if="error" class="error-text">生成失败：{{ error }}</p>
        <p class="cc-hint" style="margin-top: 10px">
          输出默认是多文件 v2 插件包（manifest + files）；需要页面时模型会输出 <code>client/index.html</code>。第三方依赖会在暂存目录安装
          <code>node_modules</code>（安装时需再次确认）。
        </p>
      </section>

      <section class="cc-card workflow-card">
        <div class="cc-card-title">
          <h3>工作流</h3>
          <span class="cc-faint">配置 → 生成 → 审阅安装</span>
        </div>
        <div class="workflow-steps">
          <div class="workflow-step" :class="{ done: configured }">
            <b>1</b><span>接口设置</span><small>{{ available ? (configured ? '已配置（' + keySourceLabel + '）' : '待配置 Key') : '插件未启用' }}</small>
          </div>
          <div class="workflow-step">
            <b>2</b><span>生成草稿</span><small>{{ busy ? '生成中…' : (draft ? '已生成，待审阅' : '描述需求后生成') }}</small>
          </div>
          <div class="workflow-step">
            <b>3</b><span>审阅安装</span><small>右侧工作区：编辑 / 校验 / 安装</small>
          </div>
        </div>
        <div class="workshop-actions">
          <el-button type="primary" plain @click="settingsOpen = true">打开接口设置</el-button>
          <el-button :loading="statusLoading" @click="loadWorkshopStatus(false)">刷新状态</el-button>
          <el-button v-if="!available" type="primary" :loading="enabling" @click="enableWorkshop">启用插件</el-button>
        </div>
        <p class="cc-hint">设置保存在独立插件 <code>ai-workshop</code> 中；生成结果进入右侧审阅区，不会自动安装。</p>
      </section>
      </div>

      <section class="cc-card review-card">
        <div class="cc-card-title">
          <h3>2. 审阅插件包</h3>
          <span class="cc-faint">清单 / 权限 / 多文件编辑 / 校验与安装</span>
        </div>
        <template v-if="draft">
          <div class="pkg-head">
            <div>
              <strong>{{ draft.manifest?.name ?? draft.name }}</strong>
              <span class="cc-faint"> · v{{ draft.manifest?.version ?? '1.0.0' }} · {{ draft.kind ?? 'cleaner' }}</span>
            </div>
            <div class="pkg-chips">
              <span class="cc-pill">id {{ draft.manifest?.id ?? draft.name }}</span>
              <span class="cc-pill">兼容 {{ draft.manifest?.engines?.cordclean ?? '—' }}</span>
              <span class="cc-pill">文件 {{ files.length }}</span>
              <span class="cc-pill">client {{ draft.manifest?.client?.mode ?? 'declarative' }}</span>
            </div>
          </div>
          <p class="cc-hint">
            权限：{{ (draft.manifest?.permissions?.services ?? []).join(', ') || '无服务' }}
            <span v-if="draft.manifest?.permissions?.network"> · 网络</span>
            <span v-if="draft.manifest?.permissions?.subprocess"> · 子进程</span>
            · 完整权限运行，无法沙箱隔离
          </p>

          <div v-if="validation">
            <p v-if="validation.errors.length" class="error-text">校验未通过：{{ validation.errors.join('；') }}</p>
            <p v-else class="cc-hint">✓ 清单、语法与静态契约校验通过</p>
            <p v-if="validation.warnings.length" class="cc-faint">提示：{{ validation.warnings.join('；') }}</p>
          </div>

          <div class="review-body">
            <aside class="file-sidebar">
              <div class="file-sidebar-head">文件（{{ files.length }}）</div>
              <button
                v-for="file in files"
                :key="file.path"
                type="button"
                class="file-item"
                :class="{ active: file.path === activeFile }"
                @click="activeFile = file.path"
              >
                <span class="file-item-path">{{ file.path }}</span>
                <span class="file-item-size">{{ fileSizeText(file.content) }}</span>
                <span v-if="file.path === entryPath" class="file-item-tag">入口</span>
              </button>
              <div class="file-sidebar-actions">
                <el-button size="small" @click="addFile">添加文件</el-button>
                <el-button size="small" :disabled="activeFile === entryPath" @click="removeFile(activeFile)">删除</el-button>
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

          <el-checkbox v-model="reviewed" style="margin-top: 10px">我已阅读上述清单与代码，理解它会以完整权限运行</el-checkbox>
          <div class="workshop-actions">
            <el-button
              type="primary"
              :loading="installing"
              :disabled="installing || !validation?.ok || !reviewed || (dependencies.length > 0 && !dependenciesAccepted)"
              @click="install"
            >{{ installing ? '正在安装插件包…' : '安装并启用' }}</el-button>
            <el-button :disabled="installing" @click="discard">放弃草稿</el-button>
          </div>
        </template>
        <div v-else class="review-empty">
          <div class="review-empty-icon">🧩</div>
          <h4>插件包会显示在这里</h4>
          <p>左侧描述需求并生成后，这里会展示清单、权限、多文件内容与校验结果；你可以添加、删除、编辑任意文件，确认无误后再安装。</p>
          <div class="review-empty-grid">
            <div><b>清单</b><span>apiVersion / engines / 权限 / client</span></div>
            <div><b>多文件</b><span>入口 + client/index.html + 其它资源</span></div>
            <div><b>校验</b><span>静态契约 / 语法 / 清单结构</span></div>
            <div><b>安装</b><span>staging → 原子落盘 → 失败回滚</span></div>
          </div>
          <p class="cc-faint">不会自动安装；安装前必须勾选「已阅读代码」。</p>
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
              <el-button text size="small" class="inline-btn" :loading="modelsLoading" @click="loadModels(true)">获取模型</el-button>
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
          <el-button type="primary" :loading="savingConfig" :disabled="!available" @click="saveConfig">保存接口设置</el-button>
          <el-button :loading="statusLoading" @click="loadWorkshopStatus(false)">刷新状态</el-button>
          <el-button v-if="!available" type="primary" plain :loading="enabling" @click="enableWorkshop">启用插件</el-button>
        </div>
        <p class="cc-hint">配置保存在插件 <code>ai-workshop</code> 的 config 中，与「AI 建议」页的 AI 接口配置完全独立。</p>    </el-drawer>
  </div>
</template>

<style scoped>
.workshop-page { display: flex; flex-direction: column; gap: 14px; }
.workshop-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
.workshop-head h2 { margin: 0 0 6px; font-size: 20px; }
.workshop-meta { display: flex; gap: 8px; flex-wrap: wrap; }
.workshop-meta .is-ok { color: #1f9d55; }
.workshop-meta .is-warn { color: #c07a00; }
.workshop-alert { margin-top: -2px; }
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
.workshop-examples .example { cursor: pointer; font-size: 11.5px; }
.workshop-actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; align-items: center; }
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
.review-empty-icon {
  font-size: 40px;
  line-height: 1;
  opacity: 0.85;
}
.review-empty h4 {
  margin: 0;
  font-size: 16px;
}
.review-empty p {
  margin: 0;
  max-width: 560px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--cc-text-dim);
}
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
.review-empty-grid b {
  color: var(--cc-text);
  font-size: 12.5px;
}
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
</style>
