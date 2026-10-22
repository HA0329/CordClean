<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { CATEGORIES, RISK_META } from '@cordclean/shared'
import type { PluginRuntime, UiContributionEntry, UiPageContribution } from '@cordclean/shared'
import {
  loadPluginDefaults,
  refreshPlugins,
  fetchLastScan,
  fetchUiContributions,
  reloadPlugin,
  pluginSource,
  openEditor,
  authorizeScheduler,
  revokeScheduler,
  runSchedulerNow,
  installPlugin,
  uninstallPlugin,
  savePluginConfig,
  setPluginEnabled,
  resolvePluginUi,
  startScan,
  state,
} from '../api/store.ts'

const editing = ref<PluginRuntime | null>(null)
const editorValue = ref('')
const configError = ref<string>()
const formMode = ref(true)
const editValues = ref<Record<string, any>>({})
const primitiveKeys = computed(() => Object.keys(editValues.value).filter((key) => { const v = editValues.value[key]; return typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string' }))
const complexCount = computed(() => Object.keys(editValues.value).length - primitiveKeys.value.length)
const saving = ref(false)
const expanded = ref<Record<string, boolean>>({})
const installOpen = ref(false)
const installPath = ref('')
const installing = ref(false)
const allowCustomClean = ref(false)

// 通用插件页面（P1.5）：声明式/iframe 贡献，iframe 用 sandbox 隔离
const uiEntries = ref<UiContributionEntry[]>([])
const pageOpen = ref(false)
const pageTitle = ref('插件页面')
const pagePluginId = ref('')
const pageHtml = ref('')
const pageSrc = computed(() =>
  pageHtml.value ? 'data:text/html;charset=utf-8,' + encodeURIComponent(pageHtml.value) : '',
)
const pageFrame = ref<HTMLIFrameElement>()

function pagesFor(plugin: PluginRuntime): UiPageContribution[] {
  return uiEntries.value.find((entry) => entry.pluginId === plugin.id)?.contributions.pages ?? []
}

function openPluginPage(plugin: PluginRuntime): void {
  const page = pagesFor(plugin)[0]
  if (!page) return
  pageTitle.value = page.title
  pagePluginId.value = plugin.id
  pageHtml.value = page.html ?? ''
  pageOpen.value = true
}

async function loadUiContributions(): Promise<void> {
  try {
    uiEntries.value = await fetchUiContributions()
  } catch {
    uiEntries.value = []
  }
}

function onPageMessage(event: MessageEvent): void {
  const frame = pageFrame.value
  if (!frame || event.source !== frame.contentWindow) return
  const data = event.data as
    | { type?: string; id?: string; method?: string; resolverId?: string; params?: Record<string, unknown> }
    | undefined
  if (!data || data.type !== 'cordclean/plugin-page' || data.method !== 'resolve') return
  const requestId = String(data.id ?? '')
  const resolverId = String(data.resolverId ?? '')
  if (!resolverId) return
  void resolvePluginUi(pagePluginId.value, resolverId, data.params)
    .then((value) => {
      frame.contentWindow?.postMessage({ type: 'cordclean/plugin-page-result', id: requestId, ok: true, value }, '*')
    })
    .catch((error: unknown) => {
      frame.contentWindow?.postMessage(
        {
          type: 'cordclean/plugin-page-result',
          id: requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        '*',
      )
    })
}

watch(
  () => state.plugins.map((plugin: PluginRuntime) => `${plugin.id}:${plugin.enabled}`).join('|'),
  () => {
    void loadUiContributions()
    if (pageOpen.value) pageOpen.value = false
  },
)
onMounted(() => {
  void loadUiContributions()
  window.addEventListener('message', onPageMessage)
})
onUnmounted(() => window.removeEventListener('message', onPageMessage))

async function doInstall() {
  if (!installPath.value.trim()) return
  installing.value = true
  try {
    await installPlugin(installPath.value.trim(), allowCustomClean.value)
    ElMessage.success('插件已加载（本次运行有效）')
    installOpen.value = false
    installPath.value = ''
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    installing.value = false
  }
}

function toggleExpanded(id: string) {
  expanded.value[id] = !expanded.value[id]
}

const lastScan = ref<any>(null)
const ruleOpen = ref(false)
const ruleHits = computed(() => {
  const map = new Map<string, { ruleId: string; name: string; items: number; bytes: number }>()
  for (const item of lastScan.value?.items ?? []) {
    const ruleId = item?.meta?.ruleId
    if (!ruleId) continue
    const entry = map.get(ruleId) ?? { ruleId, name: item.meta.ruleName ?? ruleId, items: 0, bytes: 0 }
    entry.items += 1
    entry.bytes += Number(item.size) || 0
    map.set(ruleId, entry)
  }
  return [...map.values()].sort((a, b) => b.items - a.items)
})
const scanStats = computed(() => {
  const map = new Map<string, { items: number; bytes: number }>()
  for (const task of lastScan.value?.tasks ?? []) {
    map.set(task.taskId, { items: task.items?.length ?? task.items ?? 0, bytes: task.bytes ?? 0 })
  }
  return map
})

function pluginStats(plugin: PluginRuntime) {
  let items = 0
  let bytes = 0
  for (const task of plugin.tasks ?? []) {
    const stat = scanStats.value.get(task.id)
    if (stat) { items += Number(stat.items) || 0; bytes += Number(stat.bytes) || 0 }
  }
  return { items, bytes }
}

const plugins = computed(() => state.plugins)
const enabledCount = computed(() => plugins.value.filter((plugin) => plugin.enabled).length)
const taskCount = computed(() => plugins.value.reduce((sum, plugin) => sum + plugin.taskCount, 0))

async function toggle(plugin: PluginRuntime, enabled: boolean) {
  try {
    await setPluginEnabled(plugin.id, enabled)
    ElMessage.success(`${plugin.name} 已${enabled ? '启用' : '停用'}`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function reload(plugin: PluginRuntime) {
  try {
    await reloadPlugin(plugin.id)
    ElMessage.success(`${plugin.name} 已热重载`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function uninstall(plugin: PluginRuntime) {
  try {
    if (plugin.id.startsWith('external:')) {
      await ElMessageBox.confirm(
        `卸载并删除「${plugin.name}」？这会删除工坊生成的插件文件与依赖目录，无法恢复；如果只是暂时不用，请关闭开关。`,
        '卸载并删除',
        { type: 'warning', confirmButtonText: '卸载并删除', cancelButtonText: '取消' },
      )
      await uninstallPlugin(plugin.id)
      ElMessage.success(plugin.name + ' 已卸载并删除工坊文件/依赖')
      return
    }
    await setPluginEnabled(plugin.id, false)
    ElMessage.success(plugin.name + ' 已停用：任务与辖区已释放，可随时重新启用')
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function install(plugin: PluginRuntime) {
  try {
    await setPluginEnabled(plugin.id, true)
    ElMessage.success(plugin.name + ' 已启用')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

/** 外部/工坊插件：只扫描该插件的任务，然后跳到清理页查看结果 */
async function runPluginTasks(plugin: PluginRuntime) {
  const taskIds = plugin.tasks.map((task) => task.id)
  if (!taskIds.length) {
    ElMessage.warning('该插件没有注册清理任务')
    return
  }
  state.page = 'clean'
  await nextTick()
  try {
    await startScan(taskIds)
    ElMessage.success(`已扫描「${plugin.name}」的 ${taskIds.length} 个任务，结果在清理页`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

/** 外部/工坊插件：把任务范围预选到设置里的定时任务，用户保存后生效 */
function addPluginToScheduler(plugin: PluginRuntime) {
  const taskIds = plugin.tasks.map((task) => task.id)
  if (!taskIds.length) {
    ElMessage.warning('该插件没有注册清理任务')
    return
  }
  localStorage.setItem('cordclean.scheduler.pendingTasks', JSON.stringify(taskIds))
  state.page = 'settings'
  ElMessage.info('已切换到定时任务：确认任务范围并保存后生效')
}

async function authorizeAutoClean(plugin: PluginRuntime) {
  try {
    await ElMessageBox.confirm(
      '授权后，定时任务会在扫描完成后自动清理 risk=safe 的项（仍走回收站/隔离区）。规则一旦变化，授权自动失效。',
      '授权自动清理',
      { type: 'warning', confirmButtonText: '授权' },
    )
  } catch { return }
  try {
    const hash = await authorizeScheduler({})
    ElMessage.success('已授权自动清理，规则指纹 ' + hash)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function revokeAutoClean() {
  try {
    await revokeScheduler()
    ElMessage.success('已改回「仅通知」并清除授权')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function runScheduler() {
  try {
    await runSchedulerNow()
    ElMessage.success('已触发一次定时任务，完成后会弹出通知')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function openSource(plugin: PluginRuntime) {
  try {
    const path = await pluginSource(plugin.id)
    await openEditor(path)
    ElMessage.success('已用编辑器打开：' + path)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function openConfig(plugin: PluginRuntime) {
  editing.value = plugin
  configError.value = undefined
  try {
    const defaults = plugin.configurable ? await loadPluginDefaults(plugin.id) : {}
    const merged = { ...defaults, ...(plugin.config ?? {}) }
    editValues.value = merged
    editorValue.value = JSON.stringify(merged, null, 2)
    formMode.value = true
  } catch {
    editValues.value = { ...(plugin.config ?? {}) }
    editorValue.value = JSON.stringify(plugin.config ?? {}, null, 2)
    formMode.value = true
  }
}

async function saveConfig() {
  if (!editing.value) return
  let parsed: Record<string, unknown>
  try {
    parsed = formMode.value ? { ...editValues.value } : JSON.parse(editorValue.value)
  } catch (error) {
    configError.value = 'JSON 格式错误：' + (error instanceof Error ? error.message : String(error))
    return
  }  saving.value = true
  try {
    await savePluginConfig(editing.value.id, parsed)
    ElMessage.success('配置已保存并重新加载插件')
    editing.value = null
  } catch (error) {
    configError.value = error instanceof Error ? error.message : String(error)
  } finally {
    saving.value = false
  }
}

function categoryName(id: string) {
  return (CATEGORIES as any)[id]?.name ?? id
}
</script>

<template>
  <div class="cc-page">
    <div class="cc-page-title">
      <div>
        <h1>插件</h1>
        <p>每个清理能力都是一个独立的 Cordis 插件：可启用、停用、热重载与独立配置。</p>
      </div>
      <div class="cc-actions">
        <span class="cc-pill status-active">{{ enabledCount }} 个已启用</span>
        <span class="cc-pill">{{ taskCount }} 个清理任务</span>
        <el-button @click="installOpen = true">添加插件</el-button>
        <el-button @click="refreshPlugins">刷新</el-button>
      </div>
    </div>

    <div class="plugin-grid">
      <div v-for="plugin in plugins" :key="plugin.id" class="plugin-card" :class="{ disabled: !plugin.enabled }">
        <div class="plugin-head">
          <div class="plugin-title">
            <strong>{{ plugin.name }}</strong>
            <span class="cc-faint">{{ plugin.id }} · v{{ plugin.version }}</span>
          </div>
          <el-switch :model-value="plugin.enabled" @change="(v: any) => toggle(plugin, !!v)" />
        </div>

        <p class="plugin-desc" :class="{ clamped: !expanded[plugin.id] }">{{ plugin.description }}</p>
        <button v-if="plugin.description" class="desc-toggle" @click="toggleExpanded(plugin.id)">
          {{ expanded[plugin.id] ? '收起' : '展开' }}
        </button>

        <div v-if="plugin.capabilities" class="cc-pill" :title="'允许目录：' + plugin.capabilities.fsRoots.join('；')">
          能力：目录×{{ plugin.capabilities.fsRoots.length }}
          <span v-if="plugin.capabilities.network"> · 网络</span>
          <span v-if="plugin.capabilities.childProcess"> · 子进程</span>
        </div>
        <div class="plugin-meta">
          <span class="cc-pill">{{ categoryName(plugin.category) }}</span>
          <span v-if="plugin.source === 'external'" class="cc-pill">工坊 / 外部</span>
          <span class="cc-pill" :class="`status-${plugin.status}`">{{ plugin.status === 'active' ? '运行中' : plugin.status === 'error' ? '异常' : plugin.status === 'loading' ? '加载中' : '已停止' }}</span>
          <span class="cc-pill">{{ plugin.taskCount }} 个任务</span>
          <el-button v-if="plugin.id === 'rule-pack'" size="small" @click="ruleOpen = true">规则命中</el-button>
          <span v-if="pluginStats(plugin).items" class="cc-pill">上次扫描 {{ pluginStats(plugin).items }} 项 · {{ (pluginStats(plugin).bytes / 1024 / 1024).toFixed(1) }} MB</span>
        </div>

        <div v-if="plugin.tasks.length" class="task-chips">
          <span v-for="task in plugin.tasks.slice(0, 6)" :key="task.id" class="chip">
            {{ task.name }}
            <em :style="{ color: RISK_META[task.risk].color }">{{ RISK_META[task.risk].name }}</em>
          </span>
        </div>

        <div v-if="plugin.error" class="plugin-error">
          <b>加载失败：</b>{{ plugin.error }}
        </div>

        <div class="plugin-spacer"></div>
        <div class="plugin-actions">
          <div class="plugin-action-group">
            <el-button size="small" :disabled="!plugin.enabled" @click="openConfig(plugin)">配置</el-button>
            <el-button v-if="plugin.source === 'external' && plugin.enabled && plugin.tasks.length" size="small" type="primary" plain @click="runPluginTasks(plugin)">扫描此插件</el-button>
            <el-button v-if="plugin.source === 'external' && plugin.enabled && plugin.tasks.length" size="small" @click="addPluginToScheduler(plugin)">加入定时任务</el-button>
            <el-button v-if="pagesFor(plugin).length" size="small" type="primary" plain @click="openPluginPage(plugin)">插件页面</el-button>
            <el-button v-if="!plugin.enabled" size="small" type="primary" plain @click="install(plugin)">启用</el-button>
            <el-button v-if="plugin.source === 'external'" size="small" type="danger" plain @click="uninstall(plugin)">卸载并删除</el-button>
            <el-button v-else-if="plugin.enabled" size="small" type="danger" plain @click="uninstall(plugin)">停用</el-button>
          </div>
          <div class="plugin-action-group secondary">
            <el-button size="small" @click="reload(plugin)">热重载</el-button>
            <el-button size="small" @click="openSource(plugin)">源码</el-button>
            <span class="cc-faint">{{ plugin.configurable ? '支持配置' : '无配置项' }}</span>
          </div>
        </div>
      </div>
    </div>

        <el-dialog v-model="ruleOpen" title="规则命中统计（最近一次扫描）" width="720px">
      <el-table :data="ruleHits.slice(0, 50)" size="small" max-height="420">
        <el-table-column prop="name" label="规则" min-width="220" show-overflow-tooltip />
        <el-table-column prop="items" label="命中项" width="90" />
        <el-table-column label="体积" width="110"><template #default="{ row }">{{ (row.bytes / 1024 / 1024).toFixed(1) }} MB</template></el-table-column>
      </el-table>
      <p v-if="!ruleHits.length" class="cc-faint">还没有扫描结果，先到清理页扫描一次。</p>
      <template #footer><el-button @click="ruleOpen = false">关闭</el-button></template>
    </el-dialog>

    <el-dialog v-model="installOpen" title="添加本地插件" width="600px">
      <el-alert type="warning" :closable="false" show-icon class="install-warning">
        <template #title>第三方插件以当前用户权限执行代码</template>
        <p>
          插件可能访问、修改或删除你的文件，读取环境变量，或发起网络请求。能力声明（capabilities）只在安装时做静态检查，
          不是运行时沙箱；请只加载你信任来源的 <code>.mjs</code> / <code>.js</code> 文件。
        </p>
      </el-alert>
      <p class="cc-hint">
        填写一个本地插件模块的绝对路径（<code>.mjs</code> / <code>.js</code>，需默认导出带 <code>apply()</code> 的 Cordis 插件，通常由 <code>defineCleanerPlugin</code> 生成）。
        插件只加载到本次运行，CordClean 不会复制插件文件；重启后需重新添加。注意插件代码自身在运行时仍可访问你的文件与环境变量。
      </p>
      <el-input v-model="installPath" placeholder="例如 D:\my-plugins\my-cleaner.mjs" />
      <template #footer>
        <el-button @click="installOpen = false">取消</el-button>
        <el-button type="primary" :loading="installing" @click="doInstall">加载插件</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="editing" :title="`配置 · ${editing?.name ?? ''}`" width="620px">
      <p class="cc-hint">
        插件配置以 JSON 表示，保存后会调用 Cordis 的 <code>fiber.update()</code> 重新校验配置并热重载插件。
      </p>
            <div class="mode-row">
        <el-radio-group v-model="formMode" size="small">
          <el-radio-button :value="true">表单</el-radio-button>
          <el-radio-button :value="false">JSON</el-radio-button>
        </el-radio-group>
        <span v-if="formMode && complexCount" class="cc-faint">有 {{ complexCount }} 个复杂字段需切到 JSON 编辑</span>
      </div>

      <div v-if="formMode" class="form-mode">
        <el-form label-position="left" label-width="180px" size="small">
          <el-form-item v-for="key in primitiveKeys" :key="key" :label="key">
            <el-switch v-if="typeof editValues[key] === 'boolean'" v-model="editValues[key]" />
            <el-input-number v-else-if="typeof editValues[key] === 'number'" v-model="editValues[key]" :step="1" />
            <el-input v-else v-model="editValues[key]" />
          </el-form-item>
        </el-form>
        <p v-if="!primitiveKeys.length" class="cc-faint">该插件没有可表单化的简单字段，请用 JSON 模式。</p>
      </div>
      <el-input v-else v-model="editorValue" type="textarea" :rows="16" class="cc-mono" spellcheck="false" />
      <p v-if="configError" class="error-text">{{ configError }}</p>
      <template #footer>
        <el-button @click="editing = null">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveConfig">保存并重载</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="pageOpen" :title="pageTitle" width="860px" destroy-on-close>
      <iframe
        v-if="pageSrc"
        ref="pageFrame"
        class="plugin-page-frame"
        sandbox="allow-scripts"
        :src="pageSrc"
      />
      <p v-else class="cc-faint">该插件页面没有提供自包含 HTML。</p>
      <template #footer>
        <el-button @click="pageOpen = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.plugin-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 14px;
}

.plugin-card {
  border: 1px solid var(--cc-border);
  border-radius: var(--cc-radius);
  padding: 16px 18px;
  background: var(--cc-panel);
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.plugin-card.disabled {
  opacity: 0.62;
}

.plugin-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.plugin-title {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.plugin-title strong {
  font-size: 14.5px;
}

.plugin-desc.clamped { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.plugin-desc {
  margin: 0;
  font-size: 12.5px;
  color: var(--cc-text-dim);
  line-height: 1.6;
  min-height: 40px;
}

.plugin-meta {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.task-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  font-size: 11.5px;
  padding: 3px 8px;
  border-radius: 7px;
  background: var(--cc-primary-soft);
  border: 1px solid var(--cc-border);
}

.chip em {
  font-style: normal;
  margin-left: 6px;
  font-size: 11px;
}

.plugin-error {
  font-size: 12px;
  color: var(--cc-danger);
  background: rgba(240, 80, 110, 0.08);
  border: 1px solid rgba(240, 80, 110, 0.3);
  border-radius: 8px;
  padding: 8px 10px;
  word-break: break-all;
}

.plugin-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--cc-border);
}

.plugin-action-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.plugin-action-group.secondary {
  margin-left: auto;
}

.plugin-action-group .el-button {
  margin-left: 0;
}

.plugin-action-group .cc-faint {
  margin-left: 2px;
}

.plugin-page-frame {
  width: 100%;
  height: min(68vh, 600px);
  border: 1px solid var(--cc-border);
  border-radius: 8px;
  background: #fff;
}

.plugin-spacer {
  flex: 1;
  min-height: 4px;
}

.error-text {
  color: var(--cc-danger);
  font-size: 12px;
}

code {
  background: rgba(255, 255, 255, 0.08);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 11.5px;
}
</style>

<style scoped>
.mode-row { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.form-mode { max-height: 420px; overflow: auto; }
.install-warning { margin-bottom: 12px; }
</style>
