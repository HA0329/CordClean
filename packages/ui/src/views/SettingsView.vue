<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { state, patchSettings, refreshSettings, openDataDir } from '../api/store.ts'

const form = reactive({
  concurrency: 3,
  maxDepth: 32,
  maxItemsPerTask: 20000,
  largeFileThresholdMb: 100,
  duplicateMinSizeMb: 1,
  dryRunDefault: false,
  cleanMode: 'recycle' as 'recycle' | 'quarantine' | 'delete',
  onlineAi: true,
  highRiskQuarantine: true,
  confirmRisky: true,
  retries: 2,
  quarantineEnabled: true,
  quarantineMaxMb: 2048,
  quarantineMaxFiles: 20000,
  retentionDays: 0,
  roots: [] as string[],
  excludes: [] as string[],
  includeSystem: true,
})

const newRoot = ref('')
const newExclude = ref('')
const saving = ref(false)

function syncFromSettings() {
  const settings = state.settings
  if (!settings) return
  form.concurrency = settings.scan.concurrency
  form.maxDepth = settings.scan.maxDepth
  form.maxItemsPerTask = settings.scan.maxItemsPerTask
  form.largeFileThresholdMb = Math.round(settings.scan.largeFileThreshold / 1024 / 1024)
  form.duplicateMinSizeMb = Math.round(settings.scan.duplicateMinSize / 1024 / 1024)
  form.dryRunDefault = settings.clean.dryRunDefault
  form.confirmRisky = settings.clean.confirmRisky
  form.retries = settings.clean.retries
  form.cleanMode = settings.clean.mode
  form.onlineAi = settings.privacy.onlineAi
  form.highRiskQuarantine = settings.clean.highRiskQuarantine
  form.quarantineEnabled = settings.quarantine.enabled
  form.quarantineMaxMb = Math.round(settings.quarantine.maxBytes / 1024 / 1024)
  form.quarantineMaxFiles = settings.quarantine.maxFiles
  form.retentionDays = settings.quarantine.retentionDays
  form.roots = [...settings.analysis.roots]
  form.excludes = [...settings.analysis.excludes]
  form.includeSystem = settings.analysis.includeSystem
}

watch(() => state.settings, syncFromSettings, { immediate: true })

function addRoot() {
  const value = newRoot.value.trim()
  if (!value) return
  if (!/^[a-zA-Z]:[\\/]/.test(value) && !value.startsWith('\\\\')) {
    ElMessage.warning('请输入绝对路径，例如 D:\\Videos')
    return
  }
  if (!form.roots.includes(value)) form.roots.push(value)
  newRoot.value = ''
}

function addExclude() {
  const value = newExclude.value.trim()
  if (!value) return
  if (!form.excludes.includes(value)) form.excludes.push(value)
  newExclude.value = ''
}

async function save() {
  saving.value = true
  try {
    await patchSettings({
      scan: {
        concurrency: form.concurrency,
        maxDepth: form.maxDepth,
        maxItemsPerTask: form.maxItemsPerTask,
        largeFileThreshold: form.largeFileThresholdMb * 1024 * 1024,
        duplicateMinSize: form.duplicateMinSizeMb * 1024 * 1024,
      },
      clean: {
        dryRunDefault: form.dryRunDefault,
    clean: { mode: form.cleanMode, highRiskQuarantine: form.highRiskQuarantine },
    privacy: { onlineAi: form.onlineAi },
        confirmRisky: form.confirmRisky,
        retries: form.retries,
      },
      quarantine: {
        enabled: form.quarantineEnabled,
        maxBytes: form.quarantineMaxMb * 1024 * 1024,
        maxFiles: form.quarantineMaxFiles,
        retentionDays: form.retentionDays,
      },
      analysis: {
        roots: form.roots,
        excludes: form.excludes,
        includeSystem: form.includeSystem,
      },
    })
    ElMessage.success('设置已保存')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    saving.value = false
  }
}

async function reset() {
  try {
    await refreshSettings()
    syncFromSettings()
    ElMessage.success('已重新载入当前设置')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}
</script>

<template>
  <div class="cc-page">
    <div class="cc-page-title">
      <div>
        <h1>设置</h1>
        <p>设置保存在数据目录的 config.json 中；扫描与清理参数会被所有插件共享。</p>
      </div>
      <div class="cc-actions">
        <el-button @click="reset">重新载入</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存设置</el-button>
      </div>
    </div>

    <div class="cc-grid cc-grid-2">
      <div class="cc-card">
        <div class="cc-card-title"><h3>🔍 扫描</h3></div>
        <el-form label-position="left" label-width="150px" size="small">
          <el-form-item label="任务并发度">
            <el-slider v-model="form.concurrency" :min="1" :max="8" show-stops />
          </el-form-item>
          <el-form-item label="最大递归深度">
            <el-input-number v-model="form.maxDepth" :min="1" :max="128" />
          </el-form-item>
          <el-form-item label="单任务项数上限">
            <el-input-number v-model="form.maxItemsPerTask" :min="100" :step="1000" />
          </el-form-item>
          <el-form-item label="大文件阈值（MB）">
            <el-input-number v-model="form.largeFileThresholdMb" :min="1" :step="50" />
          </el-form-item>
          <el-form-item label="重复文件最小（MB）">
            <el-input-number v-model="form.duplicateMinSizeMb" :min="1" :step="1" />
          </el-form-item>
        </el-form>
      </div>

      <div class="cc-card">
        <div class="cc-card-title"><h3>🧹 清理与隔离</h3></div>
        <el-form label-position="left" label-width="150px" size="small">
          <el-form-item label="默认仅预演">
            <el-switch v-model="form.dryRunDefault" />
          </el-form-item>
          <el-form-item label="高风险需确认">
            <el-switch v-model="form.confirmRisky" />
          </el-form-item>
          <el-form-item label="默认删除方式">
            <el-select v-model="form.cleanMode" style="width: 180px">
              <el-option label="回收站（可还原）" value="recycle" />
              <el-option label="隔离区（可恢复）" value="quarantine" />
              <el-option label="永久删除" value="delete" />
            </el-select>
          </el-form-item>
          <el-form-item label="允许在线 AI">
            <el-switch v-model="form.onlineAi" />
            <span class="cc-faint">关闭后 AI 请求一律拒绝，工具完全离线可用</span>
          </el-form-item>
          <el-form-item label="高风险项进隔离区">
            <el-switch v-model="form.highRiskQuarantine" />
          </el-form-item>
          <el-form-item label="失败重试次数">
            <el-input-number v-model="form.retries" :min="0" :max="5" />
          </el-form-item>
          <el-form-item label="启用隔离区">
            <el-switch v-model="form.quarantineEnabled" />
          </el-form-item>
          <el-form-item label="隔离区上限（MB）">
            <el-input-number v-model="form.quarantineMaxMb" :min="0" :step="256" />
          </el-form-item>
          <el-form-item label="隔离文件数上限">
            <el-input-number v-model="form.quarantineMaxFiles" :min="0" :step="1000" />
          </el-form-item>
          <el-form-item label="保留天数（0=永久）">
            <el-input-number v-model="form.retentionDays" :min="0" :max="365" />
          </el-form-item>
        </el-form>
      </div>
    </div>

    <div class="cc-card">
      <div class="cc-card-title">
        <h3>📂 分析范围</h3>
        <span class="cc-faint">大文件、重复文件、空目录等插件默认在这些目录内工作</span>
      </div>
      <el-form label-position="left" label-width="150px" size="small">
        <el-form-item label="自定义扫描目录">
          <div class="tag-editor">
            <el-tag v-for="root in form.roots" :key="root" closable @close="form.roots = form.roots.filter((item) => item !== root)">
              {{ root }}
            </el-tag>
            <div class="tag-input">
              <el-input v-model="newRoot" placeholder="D:\Videos" size="small" @keyup.enter="addRoot" />
              <el-button size="small" @click="addRoot">添加</el-button>
            </div>
          </div>
        </el-form-item>
        <el-form-item label="排除路径片段">
          <div class="tag-editor">
            <el-tag v-for="item in form.excludes" :key="item" closable type="info" @close="form.excludes = form.excludes.filter((x) => x !== item)">
              {{ item }}
            </el-tag>
            <div class="tag-input">
              <el-input v-model="newExclude" placeholder="\node_modules\" size="small" @keyup.enter="addExclude" />
              <el-button size="small" @click="addExclude">添加</el-button>
            </div>
          </div>
        </el-form-item>
        <el-form-item label="包含系统目录">
          <el-switch v-model="form.includeSystem" />
        </el-form-item>
      </el-form>
    </div>

    <div class="cc-card">
      <div class="cc-card-title"><h3>ℹ️ 关于</h3></div>
      <div class="about">
        <div><span class="cc-faint">产品</span><b>CordClean {{ state.app?.version }}</b></div>
        <div><span class="cc-faint">内核</span><b>Cordis 4 (cordis@4.0.0-rc.11)</b></div>
        <div><span class="cc-faint">数据目录</span><button class="link" @click="openDataDir">{{ state.app?.dataDir }}</button></div>
        <div><span class="cc-faint">运行环境</span><b>{{ state.app?.platform }} · Node {{ state.app?.node }}</b></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tag-editor {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  width: 100%;
}

.tag-input {
  display: flex;
  gap: 6px;
  width: 320px;
}

.about {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 18px;
  font-size: 12.5px;
}

.about div {
  display: flex;
  gap: 10px;
  justify-content: space-between;
  border-bottom: 1px dashed var(--cc-border);
  padding-bottom: 8px;
}

.link {
  background: transparent;
  border: none;
  color: var(--cc-primary);
  font-size: 12px;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 60%;
}
</style>
