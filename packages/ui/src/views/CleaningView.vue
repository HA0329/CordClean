<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { formatBytes, formatDuration } from '@cordclean/shared'
import { cancelClean, state } from '../api/store.ts'

const cleaning = computed(() => state.cleaning)
const progress = computed(() => state.cleanProgress)
const report = computed(() => state.lastClean)

/**
 * 清理当前路径变化极快（每个文件一次）；直接把它渲染成单行会导致整行文字
 * 高频替换，看起来像页面在闪。这里保留最近处理文件列表，作为稳定的滚动日志。
 */
const recentPaths = ref<Array<{ seq: number; path: string }>>([])
let pathSeq = 0
let lastSession = ''
let lastLoggedPath = ''
watch(
  () => state.cleanProgress,
  (event) => {
    if (!event) return
    if (event.sessionId !== lastSession) {
      lastSession = event.sessionId
      recentPaths.value = []
      lastLoggedPath = ''
    }
    const current = event.current
    if (!current || current === lastLoggedPath) return
    lastLoggedPath = current
    recentPaths.value.push({ seq: ++pathSeq, path: current })
    if (recentPaths.value.length > 8) recentPaths.value.splice(0, recentPaths.value.length - 8)
  },
)

const percent = computed(() => {
  if (!cleaning.value && report.value) return 100
  const p = progress.value
  if (!p || !p.total) return cleaning.value ? 0 : 100
  return Math.max(0, Math.min(100, Math.round((p.done / p.total) * 100)))
})

const taskName = computed(() => {
  const id = progress.value?.taskId
  return id ? state.tasks.find((task) => task.id === id)?.name ?? id : '准备中…'
})

const modeLabel = computed(() => {
  const mode = report.value?.mode
  return mode === 'recycle' ? '回收站' : mode === 'quarantine' ? '隔离区' : '永久删除'
})

const headline = computed(() => {
  if (cleaning.value) return '正在清理'
  if (!report.value) return '清理进度'
  return report.value.cancelled ? '清理已取消' : report.value.dryRun ? '预演完成' : '清理完成'
})

async function cancel(): Promise<void> {
  try {
    await ElMessageBox.confirm('取消后，已经处理的项不会回滚；确认取消本次清理？', '取消清理', {
      type: 'warning',
      confirmButtonText: '取消清理',
      cancelButtonText: '继续清理',
    })
  } catch {
    return
  }
  try {
    await cancelClean()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

function backToClean(): void {
  state.page = 'clean'
}
function openHistory(): void {
  state.page = 'history'
}

/** 回收站回执解析失败时后端可能把整段 JSON 当 message；优先展示内部真实 message */
function failureMessage(message: string): string {
  const text = String(message ?? '')
  // Windows 回收站对正在被系统占用的缓存文件常返回 ERROR_INVALID_LEVEL；
  // 不要把 .NET 反射式异常文案直接丢给用户。
  if (/系统调用级别不正确|DeleteFile/i.test(text)) return '文件正被系统占用或受保护，无法放入回收站，已跳过'
  if (/EBUSY|被占用|另一个程序/i.test(text)) return '文件正在被占用，已跳过'
  if (!text.trim().startsWith('{')) return text
  try {
    const data = JSON.parse(text) as { failed?: Array<{ message?: string }> }
    const inner = data.failed?.[0]?.message
    if (typeof inner === 'string' && inner.trim()) return inner
  } catch {
    /* 不是 JSON，按原文显示 */
  }
  return text
}
</script>

<template>
  <div class="cc-page cleaning-page">
    <div class="cc-page-title">
      <div>
        <h1>{{ headline }}</h1>
        <p>{{ cleaning ? '清理在后台进行；切换侧边栏不会中断，可以随时回到这里查看。' : '本次清理已经结束，以下为结果摘要。' }}</p>
      </div>
      <div class="cc-actions">
        <el-button v-if="cleaning" type="danger" plain @click="cancel">取消清理</el-button>
        <el-button v-if="cleaning" @click="backToClean">返回清理页</el-button>
        <el-button v-else type="primary" @click="backToClean">返回清理页</el-button>
        <el-button v-if="!cleaning && report" @click="openHistory">查看历史</el-button>
      </div>
    </div>

    <div v-if="cleaning" class="cc-card cleaning-running">
      <div class="cleaning-head">
        <div class="cleaning-title"><span class="cleaning-spinner" /> 正在清理：<b>{{ taskName }}</b></div>
        <span class="cc-mono">{{ progress?.done ?? 0 }} / {{ progress?.total ?? 0 }}</span>
      </div>
      <el-progress :percentage="percent" :stroke-width="10" :show-text="false" status="success" />
      <div class="cleaning-stats">
        <div><span>已处理</span><b>{{ progress?.done ?? 0 }}</b></div>
        <div><span>已释放</span><b>{{ formatBytes(progress?.bytes ?? 0) }}</b></div>
        <div><span>失败</span><b :class="{ 'has-failure': (progress?.failed ?? 0) > 0 }">{{ progress?.failed ?? 0 }}</b></div>
        <div><span>总项数</span><b>{{ progress?.total ?? '—' }}</b></div>
      </div>
      <div class="cleaning-current">
        <div class="cleaning-log-title">正在处理（最近 {{ recentPaths.length }} 项）</div>
        <div v-if="recentPaths.length" class="cleaning-log-list">
          <div v-for="item in recentPaths" :key="item.seq" class="cleaning-log-row">
            <code>{{ item.path }}</code>
          </div>
        </div>
        <p v-else class="cc-faint cleaning-log-empty">等待第一个文件…</p>
      </div>
      <p class="cc-hint cleaning-tip">
        可以切换侧边栏做别的事，清理不会中断；如果回到清理页，页面会提示“正在清理”，避免重复点击。
      </p>
    </div>

    <div v-else-if="report" class="cc-card cleaning-result">
      <div class="result-title">
        <span class="result-icon">{{ report.cancelled ? '⏹' : report.dryRun ? '🧪' : '✅' }}</span>
        <div>
          <h2>{{ report.cancelled ? '本次清理已取消' : report.dryRun ? '预演结果' : '清理完成' }}</h2>
          <p class="cc-faint">耗时 {{ formatDuration(report.elapsedMs) }} · 模式 {{ modeLabel }}</p>
        </div>
      </div>

      <div class="result-stats">
        <div><span>处理项</span><b>{{ report.cleaned }}</b></div>
        <div><span>释放空间</span><b>{{ formatBytes(report.freedBytes) }}</b></div>
        <div><span>进入回收站</span><b>{{ formatBytes(report.recycledBytes) }}</b></div>
        <div><span>隔离区</span><b>{{ formatBytes(report.quarantinedBytes) }}</b></div>
        <div><span>失败</span><b :class="{ 'has-failure': report.failed > 0 }">{{ report.failed }}</b></div>
      </div>

      <div v-if="report.perTask.length" class="result-tasks">
        <h3>按任务统计</h3>
        <div v-for="item in report.perTask" :key="item.taskId" class="result-task-row">
          <span>{{ state.tasks.find((task) => task.id === item.taskId)?.name ?? item.taskId }}</span>
          <span class="cc-faint">{{ item.cleaned }} 项 · {{ formatBytes(item.bytes) }}<template v-if="item.failed"> · 失败 {{ item.failed }}</template></span>
        </div>
      </div>

      <div v-if="report.failures.length" class="result-failures">
        <h3>未能清理（{{ report.failures.length }}）</h3>
        <div v-for="failure in report.failures.slice(0, 20)" :key="failure.itemId" class="result-failure-row">
          <code>{{ failure.path }}</code>
          <span class="error-text">{{ failureMessage(failure.message) }}</span>
        </div>
      </div>

      <div v-if="!report.cancelled" class="result-actions">
        <el-button type="primary" @click="backToClean">继续清理</el-button>
        <el-button @click="openHistory">查看清理历史</el-button>
      </div>
    </div>

    <div v-else class="cc-card cc-empty">
      <p>当前没有正在进行的清理。</p>
      <el-button type="primary" @click="backToClean">去清理页</el-button>
    </div>
  </div>
</template>

<style scoped>
.cleaning-running {
  max-width: 980px;
}

.cleaning-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.cleaning-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
}

.cleaning-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--cc-border);
  border-top-color: var(--cc-primary);
  border-radius: 50%;
  animation: cleaning-spin 0.8s linear infinite;
}

@keyframes cleaning-spin {
  to { transform: rotate(360deg); }
}

.cleaning-stats,
.result-stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-top: 18px;
}

.result-stats {
  grid-template-columns: repeat(5, minmax(0, 1fr));
}

.cleaning-stats > div,
.result-stats > div {
  padding: 12px;
  border: 1px solid var(--cc-border);
  border-radius: var(--cc-radius);
  background: var(--cc-panel-solid);
}

.cleaning-stats span,
.result-stats span {
  display: block;
  font-size: 12px;
  color: var(--cc-text-faint);
}

.cleaning-stats b,
.result-stats b {
  display: block;
  margin-top: 6px;
  font-size: 19px;
  font-weight: 600;
}

.has-failure {
  color: var(--cc-danger);
}

.cleaning-current {
  margin-top: 14px;
  padding: 10px 12px;
  border: 1px solid var(--cc-border);
  border-radius: 8px;
  background: var(--cc-hover-bg);
  overflow: hidden;
}

.cleaning-log-title {
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--cc-text-faint);
}

.cleaning-log-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  height: 118px;
  overflow: hidden;
}

.cleaning-log-row {
  min-width: 0;
  font-size: 12px;
  line-height: 1.5;
}

.cleaning-log-row code {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cleaning-log-empty {
  margin: 0;
  font-size: 12px;
}

.cleaning-tip {
  margin-top: 14px;
}

.cleaning-result {
  max-width: 980px;
}

.result-title {
  display: flex;
  align-items: center;
  gap: 12px;
}

.result-title h2 {
  margin: 0 0 4px;
}

.result-icon {
  font-size: 34px;
}

.result-tasks,
.result-failures {
  margin-top: 20px;
}

.result-tasks h3,
.result-failures h3 {
  margin: 0 0 8px;
  font-size: 14px;
}

.result-task-row,
.result-failure-row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 8px 0;
  border-bottom: 1px dashed var(--cc-border);
  font-size: 13px;
}

.result-task-row > span {
  min-width: 0;
  overflow-wrap: anywhere;
}

.result-failure-row {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
  align-items: start;
}

.result-failure-row code {
  min-width: 0;
  overflow-wrap: anywhere;
  word-break: break-all;
  white-space: pre-wrap;
}

.result-failure-row .error-text {
  min-width: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
  white-space: normal;
}

.result-actions {
  display: flex;
  gap: 10px;
  margin-top: 22px;
}

@media (max-width: 900px) {
  .cleaning-stats,
  .result-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
