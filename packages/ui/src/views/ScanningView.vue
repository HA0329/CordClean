<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { formatBytes, formatDuration } from '@cordclean/shared'
import WorkflowSteps from '../components/WorkflowSteps.vue'
import { cancelScan, state } from '../api/store.ts'

const scanning = computed(() => state.scanning)
const progress = computed(() => state.scanProgress)
const report = computed(() => state.scan)
const errorOpen = ref(false)

const isPermissionDenied = (message: string): boolean =>
  /EPERM|EACCES|Access is denied|拒绝访问|权限|受保护/i.test(String(message ?? ''))
const isBusySkipped = (message: string): boolean => /EBUSY|ENOTEMPTY|locked|正在使用|占用/i.test(String(message ?? ''))
const isSkipped = (message: string): boolean => isPermissionDenied(message) || isBusySkipped(message)
const deniedErrors = computed(() => (report.value?.errors ?? []).filter((error) => isPermissionDenied(error.message)))
const busyErrors = computed(() => (report.value?.errors ?? []).filter((error) => isBusySkipped(error.message)))
const realErrors = computed(() => (report.value?.errors ?? []).filter((error) => !isSkipped(error.message)))
const errorRows = computed(() =>
  (report.value?.errors ?? []).map((error) => ({
    kind: isPermissionDenied(error.message) ? '权限受限' : isBusySkipped(error.message) ? '占用跳过' : '错误',
    message: String(error.message ?? '').replace(/^Error:\s*/i, ''),
    path: error.path,
  })),
)

const taskName = computed(() => {
  const id = progress.value?.taskId
  return id ? state.tasks.find((task) => task.id === id)?.name ?? id : '准备中…'
})

const headline = computed(() => {
  if (scanning.value) return '正在扫描'
  if (report.value?.cancelled) return '扫描已取消'
  if (report.value) return '扫描完成'
  return '扫描进度'
})

async function cancel(): Promise<void> {
  try {
    await ElMessageBox.confirm('取消扫描会保留已发现的部分结果，确认取消？', '取消扫描', {
      type: 'warning',
      confirmButtonText: '取消扫描',
      cancelButtonText: '继续扫描',
    })
  } catch {
    return
  }
  try {
    await cancelScan()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

function back(): void {
  state.page = 'clean'
}
</script>

<template>
  <div class="cc-page scan-page">
    <div class="cc-page-title">
      <div>
        <h1>{{ headline }}</h1>
        <p>{{ scanning ? '扫描在后台进行；切换侧边栏不会中断，可以随时回到这里查看。' : '扫描已结束，可以先查看结果和错误明细，再去选择要清理的项目。' }}</p>
      </div>
      <div class="cc-actions">
        <el-button v-if="scanning" type="danger" plain @click="cancel">取消扫描</el-button>
        <el-button v-if="scanning" @click="back">返回清理页</el-button>
        <el-button v-else type="primary" @click="back">去选择可清理项</el-button>
      </div>
    </div>

    <WorkflowSteps :active="scanning ? 'scan' : 'select'" />

    <div v-if="scanning" class="cc-card scan-running">
      <div class="scan-head">
        <div class="scan-title"><span class="scan-spinner" /> 正在扫描：<b>{{ taskName }}</b></div>
        <span class="cc-faint">已发现 {{ progress?.items ?? 0 }} 项</span>
      </div>
      <el-progress :percentage="100" :indeterminate="true" :show-text="false" :stroke-width="10" />
      <div class="scan-stats">
        <div><span>候选项目</span><b>{{ progress?.items ?? 0 }}</b></div>
        <div><span>文件</span><b>{{ progress?.files ?? 0 }}</b></div>
        <div><span>目录</span><b>{{ progress?.dirs ?? 0 }}</b></div>
        <div><span>发现体积</span><b>{{ formatBytes(progress?.bytes ?? 0) }}</b></div>
      </div>
      <div v-if="progress?.current" class="scan-current">
        <span class="cc-faint">当前：</span><code>{{ progress.current }}</code>
      </div>
      <p class="cc-hint scan-tip">
        可以切换侧边栏做别的事，扫描不会中断；回到清理页时会提示“正在扫描”，避免重复点击。
      </p>
    </div>

    <div v-else-if="report" class="cc-card scan-result">
      <h2>{{ report.cancelled ? '扫描已取消' : '扫描完成' }}</h2>
      <p class="cc-faint">耗时 {{ formatDuration(report.elapsedMs) }} · 发现 {{ report.items.length }} 个可清理项 · {{ formatBytes(report.stats.bytes) }}</p>
      <div class="scan-stats">
        <div><span>文件</span><b>{{ report.stats.files }}</b></div>
        <div><span>目录</span><b>{{ report.stats.dirs }}</b></div>
        <div><span>发现体积</span><b>{{ formatBytes(report.stats.bytes) }}</b></div>
        <div v-if="deniedErrors.length"><span>权限受限</span><b class="scan-denied">{{ deniedErrors.length }}</b></div>
        <div v-if="busyErrors.length"><span>占用跳过</span><b class="scan-denied">{{ busyErrors.length }}</b></div>
        <div><span>错误</span><b :class="{ 'has-error': realErrors.length > 0 }">{{ realErrors.length }}</b></div>
      </div>

      <el-alert v-if="deniedErrors.length || busyErrors.length" type="info" :closable="false" show-icon class="scan-alert">
        <template #title>
          <span v-if="deniedErrors.length">其中 {{ deniedErrors.length }} 项因系统/浏览器缓存权限限制被跳过</span>
          <span v-if="deniedErrors.length && busyErrors.length">，</span>
          <span v-if="busyErrors.length">{{ busyErrors.length }} 项因文件被占用被跳过</span>
          <span>；这些是扫描时的正常保护行为，不影响已发现的可清理项。</span>
        </template>
      </el-alert>
      <el-alert v-if="realErrors.length" type="warning" :closable="false" show-icon class="scan-alert">
        <template #title>有 {{ realErrors.length }} 项扫描错误，可查看错误详情定位原因。</template>
      </el-alert>

      <div class="scan-actions">
        <el-button type="primary" @click="back">去选择可清理项</el-button>
        <el-button v-if="report.errors.length" @click="errorOpen = true">查看错误详情（{{ report.errors.length }}）</el-button>
        <span v-if="report.errors.length >= 200" class="cc-faint">已展示前 200 条（达到显示上限）</span>
      </div>

      <el-dialog
        v-model="errorOpen"
        title="扫描错误详情"
        width="min(860px, 92vw)"
        top="6vh"
        append-to-body
        class="scan-error-dialog"
      >
        <p class="cc-hint">
          共 {{ report.errors.length }} 条；同路径、同原因的错误已去重。EPERM/EACCES 通常是系统或浏览器缓存的访问限制。
        </p>
        <el-table :data="errorRows" size="small" max-height="260" class="scan-error-table">
          <el-table-column type="expand">
            <template #default="{ row }">
              <div class="scan-error-expand">
                <p><b>路径：</b><span>{{ row.path }}</span></p>
                <p><b>原因：</b><span>{{ row.message }}</span></p>
              </div>
            </template>
          </el-table-column>
          <el-table-column prop="kind" label="类型" width="88" />
          <el-table-column label="路径" min-width="260">
            <template #default="{ row }"><span class="scan-error-ellipsis">{{ row.path }}</span></template>
          </el-table-column>
          <el-table-column label="原因" min-width="280">
            <template #default="{ row }"><span class="scan-error-ellipsis">{{ row.message }}</span></template>
          </el-table-column>
        </el-table>
        <template #footer><el-button @click="errorOpen = false">关闭</el-button></template>
      </el-dialog>
    </div>

    <div v-else class="cc-card cc-empty">
      <p>当前没有正在进行的扫描。</p>
      <el-button type="primary" @click="back">去清理页</el-button>
    </div>
  </div>
</template>

<style scoped>
.scan-running,
.scan-result {
  max-width: 980px;
}

.scan-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.scan-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
}

.scan-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--cc-border);
  border-top-color: var(--cc-primary);
  border-radius: 50%;
  animation: scan-spin 0.8s linear infinite;
}

@keyframes scan-spin {
  to { transform: rotate(360deg); }
}

.scan-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 10px;
  margin-top: 18px;
}

.scan-stats > div {
  padding: 12px;
  border: 1px solid var(--cc-border);
  border-radius: var(--cc-radius);
  background: var(--cc-panel-solid);
}

.scan-stats span {
  display: block;
  font-size: 12px;
  color: var(--cc-text-faint);
}

.scan-stats b {
  display: block;
  margin-top: 6px;
  font-size: 19px;
  font-weight: 600;
}

.has-error {
  color: var(--cc-danger);
}

.scan-denied {
  color: var(--cc-text-faint);
}

.scan-alert {
  margin-top: 14px;
}

.scan-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 20px;
}

.scan-error-table {
  table-layout: fixed;
}

:deep(.scan-error-dialog .el-dialog__body) {
  max-height: 62vh;
  overflow-y: auto;
}

@media (max-height: 720px) {
  :deep(.scan-error-dialog .el-dialog__body) {
    max-height: 55vh;
  }
}

.scan-error-ellipsis {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scan-error-expand {
  padding: 8px 16px;
  background: var(--cc-hover-bg);
  word-break: break-all;
}

.scan-error-expand p {
  margin: 4px 0;
  line-height: 1.6;
}

.scan-current {
  margin-top: 14px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--cc-hover-bg);
  overflow: hidden;
}

.scan-current code {
  word-break: break-all;
}

.scan-tip {
  margin-top: 14px;
}

@media (max-width: 900px) {
  .scan-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
