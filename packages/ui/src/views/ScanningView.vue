<script setup lang="ts">
import { computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { formatBytes, formatDuration } from '@cordclean/shared'
import { cancelScan, state } from '../api/store.ts'

const scanning = computed(() => state.scanning)
const progress = computed(() => state.scanProgress)
const report = computed(() => state.scan)

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
        <p>{{ scanning ? '扫描在后台进行；切换侧边栏不会中断，可以随时回到这里查看。' : '扫描已结束，可以返回清理页查看结果。' }}</p>
      </div>
      <div class="cc-actions">
        <el-button v-if="scanning" type="danger" plain @click="cancel">取消扫描</el-button>
        <el-button v-if="scanning" @click="back">返回清理页</el-button>
        <el-button v-else type="primary" @click="back">查看扫描结果</el-button>
      </div>
    </div>

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
        <div><span>错误</span><b :class="{ 'has-error': report.stats.errors > 0 }">{{ report.stats.errors }}</b></div>
      </div>
      <el-button type="primary" class="scan-return" @click="back">返回清理页查看结果</el-button>
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
  grid-template-columns: repeat(4, minmax(0, 1fr));
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

.scan-return {
  margin-top: 20px;
}

@media (max-width: 900px) {
  .scan-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
