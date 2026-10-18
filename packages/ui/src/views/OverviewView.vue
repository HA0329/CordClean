<script setup lang="ts">
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import { formatBytes, formatDuration, formatTime } from '@cordclean/shared'
import { openDataDir, refreshSystem, startScan, state } from '../api/store.ts'

const system = computed(() => state.system)
const disks = computed(() => system.value?.disks ?? [])
const memoryUsed = computed(() => (system.value ? system.value.memoryTotal - system.value.memoryFree : 0))
const memoryPercent = computed(() => (system.value ? Math.round((memoryUsed.value / system.value.memoryTotal) * 100) : 0))

async function quickScan() {
  state.page = 'clean'
  try {
    await startScan()
    ElMessage.success('扫描完成')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function refresh() {
  try {
    await refreshSystem()
    ElMessage.success('已刷新')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}
</script>

<template>
  <div class="cc-page">
    <div class="cc-page-title">
      <div>
        <h1>概览</h1>
        <p>基于 Cordis 插件框架构建，清理能力以插件形式动态装载。</p>
      </div>
      <div class="cc-actions">
        <el-button @click="refresh">刷新</el-button>
        <el-button type="primary" @click="quickScan">一键扫描</el-button>
      </div>
    </div>

    <div class="cc-grid cc-grid-4">
      <div class="cc-card cc-stat">
        <div class="cc-stat-label">累计释放空间</div>
        <div class="cc-stat-value gradient">{{ formatBytes(state.totals.freedBytes) }}</div>
        <div class="cc-stat-sub">{{ state.totals.sessions }} 次清理 · {{ state.totals.cleaned }} 个项目</div>
      </div>
      <div class="cc-card cc-stat">
        <div class="cc-stat-label">已注册清理任务</div>
        <div class="cc-stat-value">{{ state.tasks.length }}</div>
        <div class="cc-stat-sub">来自 {{ state.plugins.filter((p: any) => p.enabled).length }} 个已启用插件</div>
      </div>
      <div class="cc-card cc-stat">
        <div class="cc-stat-label">磁盘可用</div>
        <div class="cc-stat-value">{{ formatBytes(disks.reduce((sum: number, d: any) => sum + d.free, 0)) }}</div>
        <div class="cc-stat-sub">共 {{ disks.length }} 个固定磁盘</div>
      </div>
      <div class="cc-card cc-stat">
        <div class="cc-stat-label">内存占用</div>
        <div class="cc-stat-value">{{ formatBytes(memoryUsed) }}</div>
        <div class="cc-stat-sub">{{ memoryPercent }}% · 共 {{ formatBytes(system?.memoryTotal ?? 0) }}</div>
      </div>
    </div>

    <div class="cc-grid cc-grid-2">
      <div class="cc-card">
        <div class="cc-card-title">
          <h3>💾 磁盘使用情况</h3>
          <span class="cc-faint">实时读取</span>
        </div>
        <div class="disk-list">
          <div v-for="disk in disks" :key="disk.mount" class="disk-row">
            <div class="disk-head">
              <strong>{{ disk.mount }}</strong>
              <span class="cc-faint">{{ formatBytes(disk.free) }} 可用 / 共 {{ formatBytes(disk.total) }}</span>
            </div>
            <div class="cc-bar">
              <span :style="{ width: `${disk.total ? Math.round((disk.used / disk.total) * 100) : 0}%` }" />
            </div>
          </div>
          <div v-if="!disks.length" class="cc-empty">未获取到磁盘信息</div>
        </div>
      </div>

      <div class="cc-card">
        <div class="cc-card-title">
          <h3>🖥️ 系统信息</h3>
          <span class="cc-pill" :class="{ 'status-active': system?.elevated }">
            {{ system?.elevated ? '管理员权限' : '普通用户' }}
          </span>
        </div>
        <div class="info-grid">
          <div class="info-row"><span>操作系统</span><b>Windows {{ system?.release }}</b></div>
          <div class="info-row"><span>处理器</span><b>{{ system?.cpuModel }}</b></div>
          <div class="info-row"><span>核心数</span><b>{{ system?.cpuCores }}</b></div>
          <div class="info-row"><span>主机名</span><b>{{ system?.hostname }}</b></div>
          <div class="info-row"><span>当前用户</span><b>{{ system?.username }}</b></div>
          <div class="info-row"><span>运行时长</span><b>{{ formatDuration((system?.uptimeSeconds ?? 0) * 1000) }}</b></div>
          <div class="info-row"><span>Node 版本</span><b>{{ system?.nodeVersion }}</b></div>
          <div class="info-row"><span>数据目录</span><button class="link" @click="openDataDir">{{ state.app?.dataDir }}</button></div>
        </div>
      </div>
    </div>

    <div class="cc-card">
      <div class="cc-card-title">
        <h3>🕘 最近清理</h3>
        <span class="cc-faint">共 {{ state.history.length }} 条记录</span>
      </div>
      <el-table :data="state.history.slice(0, 6)" size="small" :empty-text="'还没有清理记录，先来一次一键扫描吧'">
        <el-table-column label="时间" width="150">
          <template #default="{ row }">{{ formatTime(row.startedAt) }}</template>
        </el-table-column>
        <el-table-column label="释放" width="110" align="right">
          <template #default="{ row }"><span class="cc-mono">{{ formatBytes(row.freedBytes) }}</span></template>
        </el-table-column>
        <el-table-column label="清理项" width="90" align="right" prop="cleaned" />
        <el-table-column label="隔离" width="80" align="right" prop="quarantined" />
        <el-table-column label="耗时" width="100" align="right">
          <template #default="{ row }">{{ formatDuration(row.elapsedMs) }}</template>
        </el-table-column>
        <el-table-column label="任务">
          <template #default="{ row }">
            <span class="cc-faint">{{ row.taskIds.join('、') }}</span>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<style scoped>
.gradient {
  background: linear-gradient(120deg, #7fb0ff, #4fe0b8);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.disk-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.disk-head {
  display: flex;
  justify-content: space-between;
  margin-bottom: 6px;
  font-size: 13px;
}

.info-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 18px;
}

.info-row {
  min-width: 0;
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12.5px;
  padding-bottom: 8px;
  border-bottom: 1px dashed var(--cc-border);
}

.info-row span {
  color: var(--cc-text-faint);
  white-space: nowrap;
}

.info-row b {
  min-width: 0;
  font-weight: 500;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 60%;
}

.link {
  background: transparent;
  border: none;
  color: var(--cc-primary);
  font-size: 12px;
  cursor: pointer;
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
