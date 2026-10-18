<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { CATEGORIES, RISK_META } from '@cordclean/shared'
import type { PluginRuntime } from '@cordclean/shared'
import {
  loadPluginDefaults,
  refreshPlugins,
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

async function doInstall() {
  if (!installPath.value.trim()) return
  installing.value = true
  try {
    await installPlugin(installPath.value.trim())
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
    await setPluginEnabled(plugin.id, false)
    ElMessage.success(plugin.name + ' 已卸载：任务与辖区已释放（内置插件可随时重新安装）')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function install(plugin: PluginRuntime) {
  try {
    await setPluginEnabled(plugin.id, true)
    ElMessage.success(plugin.name + ' 已安装并启用')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
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

        <div class="plugin-meta">
          <span class="cc-pill">{{ categoryName(plugin.category) }}</span>
          <span class="cc-pill" :class="`status-${plugin.status}`">{{ plugin.status === 'active' ? '运行中' : plugin.status === 'error' ? '异常' : plugin.status === 'loading' ? '加载中' : '已停止' }}</span>
          <span class="cc-pill">{{ plugin.taskCount }} 个任务</span>
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
          <el-button size="small" :disabled="!plugin.enabled" @click="openConfig(plugin)">配置</el-button>
          <el-button size="small" @click="reload(plugin)">热重载</el-button>
          <el-button size="small" @click="openSource(plugin)">源码</el-button>
          <template v-if="plugin.id === 'scheduler'">
            <el-button size="small" @click="runScheduler">立即运行</el-button>
            <el-button size="small" type="warning" plain @click="authorizeAutoClean(plugin)">授权自动清理</el-button>
            <el-button size="small" @click="revokeAutoClean">仅通知</el-button>
          </template>
          <el-button v-if="plugin.enabled" size="small" type="danger" plain @click="uninstall(plugin)">卸载</el-button>
          <el-button v-else size="small" type="primary" plain @click="install(plugin)">安装</el-button>
          <span class="cc-faint" style="margin-left: auto">{{ plugin.configurable ? '支持配置' : '无配置项' }}</span>
        </div>
      </div>
    </div>

        <el-dialog v-model="installOpen" title="添加本地插件" width="560px">
      <p class="cc-hint">
        填写一个本地插件模块的绝对路径（<code>.mjs</code> / <code>.js</code>，需默认导出带 <code>apply()</code> 的 Cordis 插件，通常由 <code>defineCleanerPlugin</code> 生成）。
        插件只加载到本次运行，不会复制或修改你的文件；重启后需重新添加。
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
  align-items: center;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--cc-border);
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
</style>
