<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { formatBytes, formatDuration, formatTime } from '@cordclean/shared'
import {
  clearHistory,
  openPath,
  purgeQuarantine,
  refreshHistory,
  refreshQuarantine,
  restoreQuarantine,
  state,
  fetchUndoState,
  fetchSessions,
  undoLastClean,
} from '../api/store.ts'

const tab = ref<'history' | 'quarantine'>('history')
const undoState = ref<{ available: boolean; quarantine: number; recycle: number; permanent: number }>({
  available: false,
  quarantine: 0,
  recycle: 0,
  permanent: 0,
})
loadInterrupted()
onMounted(() => void loadUndoState())
const selectedQuarantine = ref<string[]>([])
const interrupted = ref<Array<{ sessionId: string; startedAt: number }>>([])

async function loadInterrupted() {
  try {
    const list = await fetchSessions()
    interrupted.value = list.filter((item) => item.status === 'interrupted')
  } catch {}
}

async function loadUndoState() {
  try {
    undoState.value = await fetchUndoState()
  } catch {
    /* 状态读取失败时保守地禁用撤销入口 */
    undoState.value = { available: false, quarantine: 0, recycle: 0, permanent: 0 }
  }
}

async function undoLast() {
  try {
    await loadUndoState()
    if (!undoState.value.available) {
      ElMessage.info(
        undoState.value.recycle > 0
          ? '本次记录进入了回收站，CordClean 不提供回收站一键还原；请在 Windows 回收站中手动还原'
          : '没有可恢复的隔离项（只保留最近一次）',
      )
      return
    }
    await ElMessageBox.confirm(
      '可恢复：隔离区 ' + undoState.value.quarantine + ' 项；回收站 ' + undoState.value.recycle + ' 项（需手动还原）；永久删除 ' + undoState.value.permanent + ' 项（不可恢复）。',
      '撤销上次清理',
      { type: 'warning', confirmButtonText: '恢复隔离区' },
    )
    const result = await undoLastClean()
    ElMessage.success('已恢复 ' + result.restored + ' 项；回收站 ' + result.recyclePending + ' 项请手动还原；永久删除 ' + result.permanent + ' 项不可恢复')
    await loadUndoState()
  } catch (error) {
    if (error !== 'cancel') ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

function taskLabels(taskIds: string[]): string {
  return taskIds.map((taskId) => state.tasks.find((task) => task.id === taskId)?.name ?? taskId).join('、')
}

async function refreshAll() {
  try {
    await Promise.all([refreshHistory(), refreshQuarantine(), loadUndoState()])
    ElMessage.success('已刷新')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function clearAll() {
  try {
    await ElMessageBox.confirm('确定清空全部清理历史吗？该操作不可撤销。', '清空历史', { type: 'warning' })
    await clearHistory()
    ElMessage.success('历史已清空')
  } catch {
    /* 用户取消 */
  }
}

async function restore(ids: string[]) {
  if (!ids.length) return
  try {
    const result = await restoreQuarantine(ids)
    if (result.failed.length) ElMessage.warning(`已恢复 ${result.restored} 项，失败 ${result.failed.length} 项`)
    else ElMessage.success(`已恢复 ${result.restored} 项`)
    selectedQuarantine.value = []
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function purge(ids?: string[]) {
  try {
    await ElMessageBox.confirm(
      ids?.length ? `确定彻底删除选中的 ${ids.length} 个隔离项吗？` : '确定清空整个隔离区吗？删除后不可恢复。',
      '彻底删除',
      { type: 'warning' },
    )
    const count = await purgeQuarantine(ids)
    ElMessage.success(`已删除 ${count} 个隔离项`)
    selectedQuarantine.value = []
  } catch {
    /* 用户取消 */
  }
}
</script>

<template>
  <div class="cc-page">
    <el-alert v-if="interrupted.length" type="warning" :closable="false" show-icon style="margin-bottom: 12px" :title="'检测到 ' + interrupted.length + ' 个上次未完成的清理会话（已标记中断，未自动继续）'" />
    <div class="cc-page-title">
      <div>
        <h1>历史与隔离区</h1>
        <p>修复误删的最后一道防线：高风险的清理项会先进入隔离区，可随时恢复。</p>
      </div>
      <div class="cc-actions">
        <el-button @click="refreshAll">刷新</el-button>
        <el-tooltip
          :disabled="undoState.available"
          content="当前没有可恢复的隔离项（回收站记录不支持一键撤销）"
          placement="bottom"
        >
          <span>
            <el-button type="warning" plain :disabled="!undoState.available" @click="undoLast">撤销上次清理</el-button>
          </span>
        </el-tooltip>
        <span v-if="!undoState.available && state.history.length" class="cc-faint undo-hint">暂无隔离项可撤销</span>
      </div>
    </div>

    <div class="cc-grid cc-grid-3">
      <div class="cc-card cc-stat">
        <div class="cc-stat-label">累计释放</div>
        <div class="cc-stat-value">{{ formatBytes(state.totals.freedBytes) }}</div>
        <div class="cc-stat-sub">{{ state.totals.sessions }} 次清理</div>
      </div>
      <div class="cc-card cc-stat">
        <div class="cc-stat-label">隔离区文件</div>
        <div class="cc-stat-value">{{ state.quarantineStats.count }}</div>
        <div class="cc-stat-sub">占用 {{ formatBytes(state.quarantineStats.bytes) }}</div>
      </div>
      <div class="cc-card cc-stat">
        <div class="cc-stat-label">历史记录</div>
        <div class="cc-stat-value">{{ state.history.length }}</div>
        <div class="cc-stat-sub">最多保留 1000 条</div>
      </div>
    </div>

    <div class="cc-card">
      <el-tabs v-model="tab">
        <el-tab-pane label="清理历史" name="history">
          <div class="cc-card-title">
            <h3>🕘 清理记录</h3>
            <el-button size="small" text type="danger" @click="clearAll">清空历史</el-button>
          </div>
          <el-table :data="state.history" size="small" :empty-text="'暂无清理记录'">
            <el-table-column type="expand" width="40">
              <template #default="{ row }">
                <div class="history-detail">
                  <span><b>模式</b>{{ row.dryRun ? '预演' : '实际清理' }}</span>
                  <span><b>回收站</b>{{ formatBytes(row.recycledBytes) }}</span>
                  <span><b>隔离区</b>{{ formatBytes(row.quarantinedBytes) }}</span>
                  <span><b>外部消失</b>{{ row.vanished }} 项</span>
                  <span><b>条件跳过</b>{{ row.skipped }} 项</span>
                  <span><b>失败</b>{{ row.failed }} 项</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="时间" width="150">
              <template #default="{ row }">{{ formatTime(row.startedAt) }}</template>
            </el-table-column>
            <el-table-column label="释放空间" width="110" align="right">
              <template #default="{ row }"><span class="cc-mono">{{ formatBytes(row.freedBytes) }}</span></template>
            </el-table-column>
            <el-table-column label="清理项" width="90" align="right" prop="cleaned" />
            <el-table-column label="隔离" width="80" align="right" prop="quarantined" />
            <el-table-column label="失败" width="80" align="right" prop="failed" />
            <el-table-column label="耗时" width="100" align="right">
              <template #default="{ row }">{{ formatDuration(row.elapsedMs) }}</template>
            </el-table-column>
            <el-table-column label="任务" min-width="160">
              <template #default="{ row }">
                <span class="cc-faint">{{ taskLabels(row.taskIds) }}</span>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane label="隔离区" name="quarantine">
          <div class="cc-card-title">
            <h3>🛡️ 隔离区（可恢复）</h3>
            <div class="cc-actions">
              <el-button size="small" :disabled="!selectedQuarantine.length" @click="restore(selectedQuarantine)">
                恢复选中
              </el-button>
              <el-button size="small" :disabled="!selectedQuarantine.length" type="danger" plain @click="purge(selectedQuarantine)">
                彻底删除选中
              </el-button>
              <el-button size="small" type="danger" text @click="purge()">清空隔离区</el-button>
            </div>
          </div>
          <el-table
            :data="state.quarantine"
            size="small"
            :empty-text="'隔离区是空的'"
            @selection-change="(rows: any[]) => (selectedQuarantine = rows.map((row) => row.id))"
          >
            <el-table-column type="selection" width="44" />
            <el-table-column label="原始路径" min-width="320">
              <template #default="{ row }">
                <div class="cc-path" :title="row.originalPath">{{ row.originalPath }}</div>
              </template>
            </el-table-column>
            <el-table-column label="任务" width="120" prop="taskId" />
            <el-table-column label="大小" width="100" align="right">
              <template #default="{ row }"><span class="cc-mono">{{ formatBytes(row.bytes) }}</span></template>
            </el-table-column>
            <el-table-column label="隔离时间" width="150">
              <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="150">
              <template #default="{ row }">
                <el-button size="small" text @click="restore([row.id])">恢复</el-button>
                <el-button size="small" text @click="openPath(row.originalPath)">位置</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </div>
  </div>
</template>

<style scoped>
.history-detail {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 22px;
  padding: 6px 18px;
  color: var(--cc-text-dim);
  font-size: 12px;
}
.history-detail b {
  color: var(--cc-text);
  margin-right: 6px;
  font-weight: 500;
}
.undo-hint {
  align-self: center;
}
</style>
