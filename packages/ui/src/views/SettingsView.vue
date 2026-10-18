<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  clearEgress,
  clearHistory,
  openDataDir,
  patchSettings,
  purgeQuarantine,
  state,
} from '../api/store.ts'

const form = reactive({
  cleanMode: 'recycle' as 'recycle' | 'quarantine' | 'delete',
  highRiskQuarantine: true,
  quarantineFallback: false,
  dryRunDefault: false,
  confirmRisky: true,
  retries: 2,
  budgetFiles: 50_000,
  budgetGb: 20,
  concurrency: 4,
  maxItemsPerTask: 20_000,
  maxEntriesPerTask: 200_000,
  maxDepth: 32,
  largeFileThresholdMb: 100,
  duplicateMinSizeMb: 1,
  roots: [] as string[],
  excludes: [] as string[],
  includeSystem: true,
  includeRisky: false,
  includeDeep: false,
  includeCustom: true,
  quarantineEnabled: true,
  quarantineMaxMb: 2048,
  quarantineMaxFiles: 20_000,
  retentionDays: 0,
  onlineAi: true,
})

const newRoot = ref('')
const newExclude = ref('')
const saving = ref(false)
const importText = ref('')
const importOpen = ref(false)

function syncFromSettings() {
  const s = state.settings
  if (!s) return
  form.cleanMode = s.clean.mode
  form.highRiskQuarantine = s.clean.highRiskQuarantine
  form.quarantineFallback = s.clean.quarantineFallback
  form.dryRunDefault = s.clean.dryRunDefault
  form.confirmRisky = s.clean.confirmRisky
  form.retries = s.clean.retries
  form.budgetFiles = s.clean.budget.maxFiles
  form.budgetGb = Math.round((s.clean.budget.maxBytes / 1024 / 1024 / 1024) * 10) / 10

  form.concurrency = s.scan.concurrency
  form.maxItemsPerTask = s.scan.maxItemsPerTask
  form.maxEntriesPerTask = s.scan.maxEntriesPerTask
  form.maxDepth = s.scan.maxDepth
  form.largeFileThresholdMb = Math.round(s.scan.largeFileThreshold / 1024 / 1024)
  form.duplicateMinSizeMb = Math.round(s.scan.duplicateMinSize / 1024 / 1024)
  form.roots = [...s.analysis.roots]
  form.excludes = [...s.analysis.excludes]
  form.includeSystem = s.analysis.includeSystem

  form.includeRisky = s.rules.includeRisky
  form.includeDeep = s.rules.includeDeep
  form.includeCustom = s.rules.includeCustom

  form.quarantineEnabled = s.quarantine.enabled
  form.quarantineMaxMb = Math.round(s.quarantine.maxBytes / 1024 / 1024)
  form.quarantineMaxFiles = s.quarantine.maxFiles
  form.retentionDays = s.quarantine.retentionDays

  form.onlineAi = s.privacy.onlineAi
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

function buildPatch() {
  return {
    scan: {
      concurrency: form.concurrency,
      maxItemsPerTask: form.maxItemsPerTask,
      maxEntriesPerTask: form.maxEntriesPerTask,
      maxDepth: form.maxDepth,
      largeFileThreshold: form.largeFileThresholdMb * 1024 * 1024,
      duplicateMinSize: form.duplicateMinSizeMb * 1024 * 1024,
    },
    clean: {
      mode: form.cleanMode,
      highRiskQuarantine: form.highRiskQuarantine,
      quarantineFallback: form.quarantineFallback,
      dryRunDefault: form.dryRunDefault,
      confirmRisky: form.confirmRisky,
      retries: form.retries,
      budget: {
        maxFiles: form.budgetFiles,
        maxBytes: Math.round(form.budgetGb * 1024 * 1024 * 1024),
      },
    },
    rules: {
      includeRisky: form.includeRisky,
      includeDeep: form.includeDeep,
      includeCustom: form.includeCustom,
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
    privacy: { onlineAi: form.onlineAi },
  }
}

async function save() {
  saving.value = true
  try {
    await patchSettings(buildPatch())
    ElMessage.success('设置已保存')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    saving.value = false
  }
}

async function resetDefaults() {
  try {
    await ElMessageBox.confirm('恢复默认设置不会删除历史、隔离区或规则文件，只重置本页参数。', '恢复默认设置', { type: 'warning' })
  } catch {
    return
  }
  form.concurrency = 4
  form.maxItemsPerTask = 20_000
  form.maxEntriesPerTask = 200_000
  form.maxDepth = 32
  form.largeFileThresholdMb = 100
  form.duplicateMinSizeMb = 1
  form.cleanMode = 'recycle'
  form.highRiskQuarantine = true
  form.quarantineFallback = false
  form.dryRunDefault = false
  form.confirmRisky = true
  form.retries = 2
  form.budgetFiles = 50_000
  form.budgetGb = 20
  form.includeRisky = false
  form.includeDeep = false
  form.includeCustom = true
  form.quarantineEnabled = true
  form.quarantineMaxMb = 2048
  form.quarantineMaxFiles = 20_000
  form.retentionDays = 0
  form.includeSystem = true
  form.onlineAi = true
  await save()
}

function exportSettings() {
  const blob = new Blob([JSON.stringify(state.settings, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'cordclean-settings.json'
  link.click()
  URL.revokeObjectURL(url)
  ElMessage.success('设置已导出为 cordclean-settings.json')
}

function openImport() {
  importText.value = ''
  importOpen.value = true
}

async function doImport() {
  try {
    const parsed = JSON.parse(importText.value)
    if (!parsed || typeof parsed !== 'object') throw new Error('不是合法的设置 JSON')
    await patchSettings(parsed)
    importOpen.value = false
    ElMessage.success('设置已导入并生效')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function pickImportFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  importText.value = await file.text()
}

async function revealDataDir() {
  try {
    const dir = await openDataDir()
    ElMessage.success(`已打开数据目录：${dir}`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function doClearHistory() {
  try {
    await ElMessageBox.confirm('清空历史记录不会删除回收站/隔离区里的文件。', '清空历史', { type: 'warning' })
    await clearHistory()
    ElMessage.success('历史已清空')
  } catch (error) {
    if (error !== 'cancel') ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function doPurgeQuarantine() {
  try {
    await ElMessageBox.confirm('将永久删除隔离区里的所有文件，且不可恢复。', '清空隔离区', { type: 'error' })
    await purgeQuarantine()
    ElMessage.success('隔离区已清空')
  } catch (error) {
    if (error !== 'cancel') ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function doClearEgress() {
  try {
    await clearEgress()
    ElMessage.success('外发记录已清空')
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
        <p>清理行为、扫描性能、规则库、隔离区与隐私开关都在这里集中管理。</p>
      </div>
      <div class="cc-actions">
        <el-button @click="resetDefaults">恢复默认</el-button>
        <el-button @click="exportSettings">导出</el-button>
        <el-button @click="openImport">导入</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存设置</el-button>
      </div>
    </div>

    <div class="settings-grid">
      <div class="cc-card">
        <div class="cc-card-title"><h3>🧹 清理行为</h3><span class="cc-faint">删除方式与安全边界</span></div>
        <el-form label-position="left" label-width="170px" size="small">
          <el-form-item label="默认删除方式">
            <el-select v-model="form.cleanMode" style="width: 220px">
              <el-option label="回收站（可还原）" value="recycle" />
              <el-option label="隔离区（可恢复）" value="quarantine" />
              <el-option label="永久删除" value="delete" />
            </el-select>
          </el-form-item>
          <el-form-item label="高风险项进隔离区"><el-switch v-model="form.highRiskQuarantine" /></el-form-item>
          <el-form-item label="回收站不可用时回落隔离区"><el-switch v-model="form.quarantineFallback" /></el-form-item>
          <el-form-item label="默认仅预演"><el-switch v-model="form.dryRunDefault" /></el-form-item>
          <el-form-item label="高风险需确认"><el-switch v-model="form.confirmRisky" /></el-form-item>
          <el-form-item label="失败重试次数"><el-input-number v-model="form.retries" :min="0" :max="5" /></el-form-item>
          <el-form-item label="单次清理项上限"><el-input-number v-model="form.budgetFiles" :min="100" :step="1000" /></el-form-item>
          <el-form-item label="单次容量上限（GB）"><el-input-number v-model="form.budgetGb" :min="1" :max="500" :step="1" /></el-form-item>
        </el-form>
      </div>

      <div class="cc-card">
        <div class="cc-card-title"><h3>⚡ 扫描与性能</h3><span class="cc-faint">并发与上限影响速度与内存</span></div>
        <el-form label-position="left" label-width="170px" size="small">
          <el-form-item label="任务并发度"><el-input-number v-model="form.concurrency" :min="1" :max="8" /></el-form-item>
          <el-form-item label="单任务最多清理项"><el-input-number v-model="form.maxItemsPerTask" :min="100" :step="1000" /></el-form-item>
          <el-form-item label="单任务遍历条目上限"><el-input-number v-model="form.maxEntriesPerTask" :min="1000" :step="10000" /></el-form-item>
          <el-form-item label="最大递归深度"><el-input-number v-model="form.maxDepth" :min="1" :max="128" /></el-form-item>
          <el-form-item label="大文件阈值（MB）"><el-input-number v-model="form.largeFileThresholdMb" :min="1" :step="10" /></el-form-item>
          <el-form-item label="重复文件最小体积（MB）"><el-input-number v-model="form.duplicateMinSizeMb" :min="0" :step="1" /></el-form-item>
          <el-form-item label="包含系统级目录"><el-switch v-model="form.includeSystem" /></el-form-item>
        </el-form>
      </div>

      <div class="cc-card">
        <div class="cc-card-title"><h3>📚 规则库</h3><span class="cc-faint">修改后需在插件页热重载规则库</span></div>
        <el-form label-position="left" label-width="170px" size="small">
          <el-form-item label="启用高风险分类">
            <el-switch v-model="form.includeRisky" />
            <span class="row-hint">密码/Cookie、Windows.old 等，默认关闭</span>
          </el-form-item>
          <el-form-item label="启用深度规则">
            <el-switch v-model="form.includeDeep" />
            <span class="row-hint">更彻底但更慢的 deep_only 规则</span>
          </el-form-item>
          <el-form-item label="加载自定义规则">
            <el-switch v-model="form.includeCustom" />
            <span class="row-hint">用户手写与 AI 采纳的规则</span>
          </el-form-item>
        </el-form>
      </div>

      <div class="cc-card">
        <div class="cc-card-title"><h3>🗃️ 隔离区</h3><span class="cc-faint">高风险项的回收站</span></div>
        <el-form label-position="left" label-width="150px" size="small">
          <el-form-item label="启用隔离区"><el-switch v-model="form.quarantineEnabled" /></el-form-item>
          <el-form-item label="容量上限（MB）"><el-input-number v-model="form.quarantineMaxMb" :min="0" :step="256" /></el-form-item>
          <el-form-item label="文件数上限"><el-input-number v-model="form.quarantineMaxFiles" :min="0" :step="1000" /></el-form-item>
          <el-form-item label="保留天数（0=永久）"><el-input-number v-model="form.retentionDays" :min="0" :max="365" /></el-form-item>
        </el-form>
      </div>

      <div class="cc-card">
        <div class="cc-card-title"><h3>🔒 隐私与在线 AI</h3><span class="cc-faint">出网开关</span></div>
        <el-form label-position="left" label-width="150px" size="small">
          <el-form-item label="允许在线 AI">
            <el-switch v-model="form.onlineAi" />
            <span class="row-hint">关闭后完全离线，AI 请求一律拒绝</span>
          </el-form-item>
          <el-form-item label="外发记录">
            <el-button size="small" @click="doClearEgress">清空外发记录</el-button>
          </el-form-item>
        </el-form>
      </div>

      <div class="cc-card">
        <div class="cc-card-title"><h3>🗂️ 扫描范围</h3><span class="cc-faint">额外纳入或排除的目录</span></div>
        <div class="roots">
          <div class="roots-title">额外扫描根</div>
          <div class="chips">
            <span v-for="(root, index) in form.roots" :key="root" class="cc-pill">
              {{ root }}
              <button class="chip-x" @click="form.roots.splice(index, 1)">×</button>
            </span>
            <span v-if="!form.roots.length" class="cc-faint">未添加</span>
          </div>
          <div class="add-row">
            <el-input v-model="newRoot" placeholder="例如 D:\\Videos" size="small" @keyup.enter="addRoot" />
            <el-button size="small" @click="addRoot">添加</el-button>
          </div>
        </div>
        <div class="roots" style="margin-top: 14px">
          <div class="roots-title">始终排除</div>
          <div class="chips">
            <span v-for="(item, index) in form.excludes" :key="item" class="cc-pill">
              {{ item }}
              <button class="chip-x" @click="form.excludes.splice(index, 1)">×</button>
            </span>
            <span v-if="!form.excludes.length" class="cc-faint">未添加</span>
          </div>
          <div class="add-row">
            <el-input v-model="newExclude" placeholder="例如 D:\\Projects" size="small" @keyup.enter="addExclude" />
            <el-button size="small" @click="addExclude">添加</el-button>
          </div>
        </div>
      </div>

      <div class="cc-card">
        <div class="cc-card-title"><h3>🧰 数据维护</h3><span class="cc-faint">不会删除你的文件</span></div>
        <div class="data-actions">
          <div class="data-row">
            <div>
              <div class="data-title">数据目录</div>
              <div class="cc-faint">{{ state.app?.dataDir ?? '（未获取）' }}</div>
            </div>
            <el-button size="small" @click="revealDataDir">打开</el-button>
          </div>
          <div class="data-row">
            <div><div class="data-title">历史记录</div><div class="cc-faint">清理历史与统计</div></div>
            <el-button size="small" type="warning" plain @click="doClearHistory">清空历史</el-button>
          </div>
          <div class="data-row">
            <div><div class="data-title">隔离区</div><div class="cc-faint">永久删除隔离文件（不可恢复）</div></div>
            <el-button size="small" type="danger" plain @click="doPurgeQuarantine">清空隔离区</el-button>
          </div>
        </div>
      </div>

      <div class="cc-card">
        <div class="cc-card-title"><h3>ℹ️ 关于</h3></div>
        <p class="cc-hint">
          CordClean v{{ state.app?.version ?? '0.1.0' }} · Node {{ state.app?.node }} · {{ state.app?.platform }}
          <span v-if="state.transport"> · {{ state.transport.kind === 'electron' ? '桌面外壳' : '浏览器外壳' }}</span>
          <br />
          内核基于 Cordis 4 插件框架；清理规则来自内置规则库（PC-Cleaner 迁移 + 自定义）。
        </p>
      </div>
    </div>

    <el-dialog v-model="importOpen" title="导入设置（JSON）" width="620px">
      <p class="cc-hint">粘贴导出的 JSON，或选择一个 cordclean-settings.json 文件。</p>
      <input type="file" accept="application/json" @change="pickImportFile" />
      <el-input v-model="importText" type="textarea" :rows="10" style="margin-top: 10px" />
      <template #footer>
        <el-button @click="importOpen = false">取消</el-button>
        <el-button type="primary" @click="doImport">导入并生效</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
@media (max-width: 1200px) {
  .settings-grid {
    grid-template-columns: 1fr;
  }
}
.row-hint {
  margin-left: 10px;
  color: var(--cc-text-faint);
  font-size: 11.5px;
}
.roots-title {
  font-size: 12.5px;
  color: var(--cc-text-dim);
  margin-bottom: 6px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 24px;
}
.chip-x {
  border: none;
  background: transparent;
  color: var(--cc-text-faint);
  cursor: pointer;
  padding: 0 0 0 2px;
  font-size: 13px;
  line-height: 1;
}
.chip-x:hover {
  color: var(--cc-danger);
}
.add-row {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.data-actions {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.data-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.data-title {
  font-size: 13px;
  font-weight: 550;
}
</style>
