<script setup lang="ts">
/**
 * AI 插件工坊（独立页面）。
 *
 * 与「AI 建议」分析页分开：本页只做 v2 插件包的生成、审阅与安装，
 * 安装统一走 PluginManager.installPackage（staging → 校验 → 原子落盘 → 启用）。
 */
defineOptions({ name: 'AiWorkshopView' })
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { AiModelInfo, AiPluginDraft, AiWorkshopStatus } from '@cordclean/shared'
import {
  cancelAi,
  draftAiWorkshopPlugin,
  fetchAiWorkshopModels,
  fetchAiWorkshopStatus,
  installAiPlugin,
  refreshAiStatus,
  refreshPlugins,
  savePluginConfig,
  setPluginEnabled,
  state,
  validateAiPlugin,
} from '../api/store.ts'

const EXAMPLES = [
  '写一个 cleaner 插件，清理 %TEMP% 下超过 7 天的 .log 文件',
  '写一个 widget 插件，在概览页显示当前时间和磁盘可用空间',
  '写一个 active 插件，每 30 分钟推送一次「该清理缓存了」的提醒',
  '写一个 cleaner 插件，清理浏览器缓存目录里的旧版缓存（只读清单请写清楚）',
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
let timer: ReturnType<typeof setInterval> | undefined
let validateSeq = 0
let validateTimer: ReturnType<typeof setTimeout> | undefined

const workshopStatus = ref<AiWorkshopStatus | null>(null)
const statusLoading = ref(false)
const available = computed(() => workshopStatus.value?.available === true)
const configured = computed(() => workshopStatus.value?.configured === true)
const model = computed(() => workshopStatus.value?.model || workshopConfig.model || '未配置模型')
const shape = computed(() => workshopStatus.value?.shape || workshopConfig.apiShape)

/** 工坊独立接口配置（保存在插件 ai-workshop 的 config 中，与 AI 清理顾问互不影响） */
const workshopConfig = reactive({
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  apiShape: 'chat' as 'chat' | 'messages' | 'responses',
  model: 'deepseek-flash',
  maxTokens: 65_536,
  temperature: -1,
  timeoutMs: 180_000,
  retries: 1,
  systemPrompt: '',
})
const workshopModels = ref<AiModelInfo[]>([])
const modelsSource = ref<'remote' | 'fallback'>('fallback')
const savingConfig = ref(false)
const enabling = ref(false)

function loadWorkshopConfig(): void {
  const plugin = state.plugins.find((item) => item.id === 'ai-workshop')
  const config = (plugin?.config ?? {}) as Record<string, unknown>
  workshopConfig.apiKey = String(config.apiKey ?? '')
  workshopConfig.baseUrl = String(config.baseUrl ?? 'https://api.deepseek.com')
  workshopConfig.apiShape = (['chat', 'messages', 'responses'] as const).includes(config.apiShape as any)
    ? (config.apiShape as 'chat' | 'messages' | 'responses')
    : 'chat'
  workshopConfig.model = String(config.model ?? 'deepseek-flash')
  workshopConfig.maxTokens = Number(config.maxTokens ?? 65_536) || 65_536
  workshopConfig.temperature = Number(config.temperature ?? -1)
  workshopConfig.timeoutMs = Number(config.timeoutMs ?? 180_000) || 180_000
  workshopConfig.retries = Number(config.retries ?? 1)
  workshopConfig.systemPrompt = String(config.systemPrompt ?? '')
}

async function loadWorkshopStatus(): Promise<void> {
  statusLoading.value = true
  try {
    workshopStatus.value = await fetchAiWorkshopStatus()
  } catch {
    workshopStatus.value = null
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

async function loadModels(): Promise<void> {
  try {
    const result = await fetchAiWorkshopModels(true)
    workshopModels.value = result.models
    modelsSource.value = result.source
    if (!result.models.some((item) => item.id === workshopConfig.model) && result.models[0]) {
      workshopConfig.model = result.models[0].id
    }
  } catch (err) {
    ElMessage.error('拉取模型失败：' + (err instanceof Error ? err.message : String(err)))
  }
}

async function saveConfig(): Promise<void> {
  savingConfig.value = true
  try {
    await savePluginConfig('ai-workshop', {
      ...workshopConfig,
      stream: false,
    })
    await refreshPlugins()
    await loadWorkshopStatus()
    ElMessage.success('工坊接口设置已保存（已生效）')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
  } finally {
    savingConfig.value = false
  }
}
const entryPath = computed(() => draft.value?.manifest?.entry ?? 'index.mjs')
const files = computed<Array<{ path: string; content: string }>>(() => {
  const list = draft.value?.files ?? []
  if (list.length) return list
  if (!draft.value) return []
  return [{ path: entryPath.value, content: draft.value.code }]
})
const activeContent = computed(() => {
  const file = files.value.find((item) => item.path === activeFile.value)
  return file?.content ?? ''
})
const canEditActive = computed(() => activeFile.value === entryPath.value)
const dependencies = computed(() => Object.entries(draft.value?.dependencies ?? {}))

function openAiSettings(): void {
  state.page = 'ai'
}

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

function resetReview(): void {
  validation.value = null
  reviewed.value = false
  dependenciesAccepted.value = false
  activeFile.value = draft.value?.manifest?.entry ?? files.value[0]?.path ?? 'index.mjs'
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
  error.value = ''
  draft.value = null
  validation.value = null
  reviewed.value = false
  dependenciesAccepted.value = false
  busy.value = true
  startTimer()
  try {
    const result = await draftAiWorkshopPlugin(requirement.value.trim())
    draft.value = result
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

function updateEntry(value: string): void {
  if (!draft.value) return
  draft.value.code = value
  const file = draft.value.files?.find((item) => item.path === entryPath.value)
  if (file) file.content = value
  scheduleRevalidate()
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
  void loadModels().catch(() => {})
  void refreshAiStatus().catch(() => {})
})
onUnmounted(stopTimer)
</script>

<template>
  <div class="workshop-page">
    <div class="workshop-head cc-card">
      <div>
        <h2>🧪 AI 插件工坊</h2>
        <p class="cc-hint">
          用一句话描述 → 生成 <b>v2 插件包</b>（清单 + 入口 + 可选 <code>client/</code> 页面）→ 静态校验 → 审阅权限与代码 → 通过
          staging 安装事务落盘（失败自动回滚）。安装前必须人工确认：插件以完整 Node 权限运行。
        </p>
      </div>
      <div class="workshop-meta">
        <span class="cc-pill" :class="{ 'is-ok': available, 'is-warn': !available }">
          插件 {{ available ? '已启用' : '未启用' }}
        </span>
        <span class="cc-pill" :class="{ 'is-ok': configured, 'is-warn': !configured }">
          {{ !available ? '等待启用插件' : (configured ? 'API 已配置' : 'API 未配置') }}
        </span>
        <span class="cc-pill">{{ shape }} · {{ model }}</span>
        <span class="cc-pill">v2 插件包</span>
      </div>
    </div>

    <el-alert v-if="workshopStatus && !available" type="warning" :closable="false" show-icon class="workshop-alert">
      「AI 插件工坊」插件还没有启用：工坊是独立插件，启用后即可使用它自己的接口设置。
      <el-button link type="primary" :loading="enabling" @click="enableWorkshop">立即启用</el-button>
      <el-button link type="primary" @click="openPlugins">去插件页</el-button>
    </el-alert>
    <el-alert v-else-if="available && !configured" type="warning" :closable="false" show-icon class="workshop-alert">
      还没有配置工坊自己的 API Key：请在下面的「接口设置」中填写（或设置环境变量 DEEPSEEK_API_KEY）。
    </el-alert>

    <div class="workshop-grid">
      <section class="cc-card">
        <div class="cc-card-title">
          <h3>1. 描述你想要的插件</h3>
          <span class="cc-faint">越具体越好：清理目标 / 触发方式 / UI 形态</span>
        </div>
        <el-input
          v-model="requirement"
          type="textarea"
          :rows="6"
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
          生成的插件包包含 <code>plugin.json</code> 清单（apiVersion / engines / 权限 / client）、入口源码与可选客户端页面；
          第三方依赖会在暂存目录安装 <code>node_modules</code>（安装时需再次确认）。
        </p>
      </section>

      <section class="cc-card">
        <div class="cc-card-title">
          <h3>接口设置（工坊独立）</h3>
          <span class="cc-faint">与「AI 建议」互不影响；保存后立即生效</span>
        </div>
        <div class="config-grid">
          <label class="config-field">
            <span>接口形态</span>
            <el-select v-model="workshopConfig.apiShape" size="small">
              <el-option label="chat（OpenAI 兼容）" value="chat" />
              <el-option label="messages（Anthropic 兼容）" value="messages" />
              <el-option label="responses（OpenAI Responses）" value="responses" />
            </el-select>
          </label>
          <label class="config-field">
            <span>接口根地址</span>
            <el-input v-model="workshopConfig.baseUrl" size="small" placeholder="https://api.deepseek.com" />
          </label>
          <label class="config-field">
            <span>API Key</span>
            <el-input v-model="workshopConfig.apiKey" size="small" type="password" show-password placeholder="留空则读取环境变量 DEEPSEEK_API_KEY" />
          </label>
          <label class="config-field">
            <span>模型</span>
            <el-select v-model="workshopConfig.model" size="small" filterable allow-create default-first-option>
              <el-option v-for="item in workshopModels" :key="item.id" :label="item.id" :value="item.id" />
            </el-select>
            <small class="cc-faint">列表来源：{{ modelsSource === 'remote' ? '接口 /models' : '内置兜底' }}</small>
          </label>
          <label class="config-field">
            <span>最大输出 token</span>
            <el-input-number v-model="workshopConfig.maxTokens" size="small" :min="0" :max="1000000" :step="8192" />
          </label>
          <label class="config-field">
            <span>失败重试</span>
            <el-input-number v-model="workshopConfig.retries" size="small" :min="0" :max="5" />
          </label>
          <label class="config-field">
            <span>超时（毫秒）</span>
            <el-input-number v-model="workshopConfig.timeoutMs" size="small" :min="0" :max="600000" :step="10000" />
          </label>
          <label class="config-field">
            <span>温度</span>
            <el-input-number v-model="workshopConfig.temperature" size="small" :min="-1" :max="2" :step="0.1" />
          </label>
        </div>
        <label class="config-full">
          <span>追加提示词（可选）</span>
          <el-input v-model="workshopConfig.systemPrompt" type="textarea" :rows="2" placeholder="例如：入口固定 index.mjs；需要页面时输出 client/index.html；遵循团队编码规范" />
        </label>
        <div class="workshop-actions">
          <el-button type="primary" size="small" :loading="savingConfig" :disabled="!available" @click="saveConfig">保存接口设置</el-button>
          <el-button size="small" :disabled="!available" @click="loadModels">拉取模型列表</el-button>
          <el-button size="small" link @click="loadWorkshopStatus">刷新状态</el-button>
          <el-button v-if="!available" size="small" type="primary" plain :loading="enabling" @click="enableWorkshop">启用插件</el-button>
        </div>
        <p class="cc-hint">这些配置保存在插件 <code>ai-workshop</code> 的 config 中，与「AI 建议」页的 AI 接口配置完全独立。</p>
      </section>

      <section class="cc-card">
        <div class="cc-card-title">
          <h3>2. 审阅插件包</h3>
          <span class="cc-faint">清单、权限、文件、校验结果与安装</span>
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
            </div>
          </div>
          <p class="cc-hint">
            权限：{{ (draft.manifest?.permissions?.services ?? []).join(', ') || '无服务' }}
            <span v-if="draft.manifest?.permissions?.network"> · 网络</span>
            <span v-if="draft.manifest?.permissions?.subprocess"> · 子进程</span>
            <span v-if="draft.manifest?.client?.mode"> · client {{ draft.manifest.client.mode }}</span>
            · 完整权限运行，无法沙箱隔离
          </p>

          <div v-if="validation">
            <p v-if="validation.errors.length" class="error-text">校验未通过：{{ validation.errors.join('；') }}</p>
            <p v-else class="cc-hint">✓ 清单、语法与静态契约校验通过</p>
            <p v-if="validation.warnings.length" class="cc-faint">提示：{{ validation.warnings.join('；') }}</p>
          </div>

          <div class="file-tabs">
            <button
              v-for="file in files"
              :key="file.path"
              type="button"
              class="file-tab"
              :class="{ active: file.path === activeFile }"
              @click="activeFile = file.path"
            >
              {{ file.path }}
            </button>
          </div>
          <el-input
            :model-value="activeContent"
            type="textarea"
            :rows="16"
            class="cc-mono"
            spellcheck="false"
            @update:model-value="updateFileContent(activeFile, $event)"
          />
          <p class="cc-hint">所有文件都可直接编辑；修改入口文件会同步为草稿代码并自动重新校验。</p>

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
        <p v-else class="cc-faint">生成后在这里展示清单、权限、文件与校验结果；不会自动安装。</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.workshop-page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.workshop-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  flex-wrap: wrap;
}
.workshop-head h2 {
  margin: 0 0 6px;
  font-size: 20px;
}
.workshop-meta {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.workshop-meta .is-ok {
  color: #1f9d55;
}
.workshop-meta .is-warn {
  color: #c07a00;
}
.workshop-alert {
  margin-top: -2px;
}
.workshop-grid {
  display: grid;
  grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
  gap: 16px;
  align-items: start;
}
@media (max-width: 1150px) {
  .workshop-grid {
    grid-template-columns: 1fr;
  }
}
.workshop-examples {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 10px 0;
}
.workshop-examples .example {
  cursor: pointer;
  font-size: 11.5px;
}
.workshop-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.pkg-head {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.pkg-chips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.file-tabs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin: 10px 0 8px;
}
.file-tab {
  border: 1px solid var(--cc-border);
  background: transparent;
  color: var(--cc-text-dim);
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 11.5px;
  cursor: pointer;
}
.file-tab.active {
  border-color: var(--cc-accent, #4f7cff);
  color: var(--cc-text);
}
.deps-box {
  margin: 10px 0;
  padding: 10px;
  border: 1px solid var(--cc-border);
  border-radius: 8px;
}
.config-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 12px;
  margin: 8px 0;
}
.config-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--cc-text-dim);
}
.config-full {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--cc-text-dim);
}
.deps-box ul {
  margin: 6px 0;
  padding-left: 20px;
}
</style>
