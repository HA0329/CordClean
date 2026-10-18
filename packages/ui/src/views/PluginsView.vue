<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { CATEGORIES, RISK_META } from '@cordclean/shared'
import type { PluginRuntime } from '@cordclean/shared'
import {
  loadPluginDefaults,
  refreshPlugins,
  reloadPlugin,
  savePluginConfig,
  setPluginEnabled,
  state,
} from '../api/store.ts'

const editing = ref<PluginRuntime | null>(null)
const editorValue = ref('')
const configError = ref<string>()
const saving = ref(false)
const expanded = ref<Record<string, boolean>>({})

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

async function openConfig(plugin: PluginRuntime) {
  editing.value = plugin
  configError.value = undefined
  try {
    const defaults = plugin.configurable ? await loadPluginDefaults(plugin.id) : {}
    const merged = { ...defaults, ...(plugin.config ?? {}) }
    editorValue.value = JSON.stringify(merged, null, 2)
  } catch {
    editorValue.value = JSON.stringify(plugin.config ?? {}, null, 2)
  }
}

async function saveConfig() {
  if (!editing.value) return
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(editorValue.value)
  } catch (error) {
    configError.value = 'JSON 格式错误：' + (error instanceof Error ? error.message : String(error))
    return
  }
  saving.value = true
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
          <span v-for="task in plugin.tasks" :key="task.id" class="chip">
            {{ task.name }}
            <em :style="{ color: RISK_META[task.risk].color }">{{ RISK_META[task.risk].name }}</em>
          </span>
        </div>

        <div v-if="plugin.error" class="plugin-error">
          <b>加载失败：</b>{{ plugin.error }}
        </div>

        <div class="plugin-actions">
          <el-button size="small" :disabled="!plugin.enabled" @click="openConfig(plugin)">配置</el-button>
          <el-button size="small" @click="reload(plugin)">热重载</el-button>
          <el-button v-if="plugin.enabled" size="small" type="danger" plain @click="uninstall(plugin)">卸载</el-button>
          <el-button v-else size="small" type="primary" plain @click="install(plugin)">安装</el-button>
          <span class="cc-faint" style="margin-left: auto">{{ plugin.configurable ? '支持配置' : '无配置项' }}</span>
        </div>
      </div>
    </div>

    <el-dialog v-model="editing" :title="`配置 · ${editing?.name ?? ''}`" width="620px">
      <p class="cc-hint">
        插件配置以 JSON 表示，保存后会调用 Cordis 的 <code>fiber.update()</code> 重新校验配置并热重载插件。
      </p>
      <el-input v-model="editorValue" type="textarea" :rows="16" class="cc-mono" spellcheck="false" />
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

.plugin-desc.clamped { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }`n`n.plugin-desc {
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
  padding-top: 4px;
  border-top: 1px solid var(--cc-border);
  margin-top: 2px;
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
