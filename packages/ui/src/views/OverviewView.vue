<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { formatBytes, formatDuration, formatTime } from '@cordclean/shared'
import PluginOverviewCards from '../components/PluginOverviewCards.vue'
import { openDataDir, refreshAppInfo, refreshSystem, refreshSystemLive, startScan, state } from '../api/store.ts'

const system = computed(() => state.system)
const appInfo = computed(() => state.app)
const disks = computed(() => system.value?.disks ?? [])
const memoryUsed = computed(() => (system.value ? system.value.memoryTotal - system.value.memoryFree : 0))
const memoryPercent = computed(() => (system.value ? Math.round((memoryUsed.value / system.value.memoryTotal) * 100) : 0))
const nowTick = ref(Date.now())
let tickTimer: ReturnType<typeof setInterval> | null = null
let liveTimer: ReturnType<typeof setInterval> | null = null
let fullTimer: ReturnType<typeof setInterval> | null = null
let liveRefreshing = false
let fullRefreshing = false

/** 本地每秒走时，叠加最近一次采集的 uptime，避免为了运行时长每秒请求宿主 */
const liveUptimeSeconds = computed(() => {
  if (!system.value) return 0
  const elapsed = Math.max(0, Math.floor((nowTick.value - system.value.collectedAt) / 1000))
  return system.value.uptimeSeconds + elapsed
})

async function quickScan() {
  if (state.scanning || state.cleaning) {
    ElMessage.info('正在扫描或清理中，请稍候')
    return
  }
  state.page = 'clean'
  try {
    if (!(await startScan())) {
      ElMessage.info('已有扫描正在进行')
      return
    }
    ElMessage.success('扫描完成')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function refresh() {
  try {
    // 系统信息里的 Node 版本/平台来自真实宿主检测，而不是启动时缓存的旧值
    await Promise.all([refreshSystem(), refreshAppInfo()])
    nowTick.value = Date.now()
    ElMessage.success('已刷新')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

/** 短周期轻量采样：只刷新内存/运行时长，不枚举磁盘 */
async function refreshLiveSilently(): Promise<void> {
  if (liveRefreshing) return
  liveRefreshing = true
  try {
    await refreshSystemLive()
  } catch {
    /* 概览是只读展示，失败时保留上一次数据 */
  } finally {
    liveRefreshing = false
  }
}

/** 长周期完整采样：磁盘可用空间、热点目录等变化较慢 */
async function refreshFullSilently(): Promise<void> {
  if (fullRefreshing) return
  fullRefreshing = true
  try {
    await refreshSystem()
    nowTick.value = Date.now()
  } catch {
    /* 保留上一次数据 */
  } finally {
    fullRefreshing = false
  }
}

onMounted(() => {
  // 每次进入概览都重新采样一次，避免长时间运行后展示启动时的旧信息
  void Promise.all([refreshSystem(), refreshAppInfo()]).then(() => (nowTick.value = Date.now())).catch(() => {})
  // 运行时长由本地走秒；内存 5 秒；磁盘/完整系统信息 60 秒
  tickTimer = setInterval(() => {
    nowTick.value = Date.now()
  }, 1000)
  liveTimer = setInterval(() => {
    if (document.visibilityState !== 'hidden') void refreshLiveSilently()
  }, 5_000)
  fullTimer = setInterval(() => {
    if (document.visibilityState !== 'hidden') void refreshFullSilently()
  }, 60_000)
})

onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer)
  if (liveTimer) clearInterval(liveTimer)
  if (fullTimer) clearInterval(fullTimer)
  tickTimer = null
  liveTimer = null
  fullTimer = null
})
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

    <PluginOverviewCards />

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
          <div class="cc-actions">
            <span
              v-if="system"
              class="cc-faint"
              title="运行时长每秒本地走时；内存每 5 秒自动刷新；磁盘/系统信息每 60 秒自动刷新；也可点上方「刷新」立即更新"
            >采样于 {{ formatTime(system.collectedAt) }} · 自动刷新</span>
            <span class="cc-pill" :class="{ 'status-active': system?.elevated }">
              {{ system?.elevated ? '管理员权限' : '普通用户' }}
            </span>
          </div>
        </div>
        <div class="info-grid">
          <div class="info-row"><span>操作系统</span><b>{{ appInfo?.platformLabel ?? 'Windows' }} <span class="cc-faint">({{ system?.release }})</span></b></div>
          <div class="info-row"><span>处理器</span><b :title="system?.cpuModel">{{ system?.cpuModel }}</b></div>
          <div class="info-row"><span>核心数</span><b>{{ system?.cpuCores }}</b></div>
          <div class="info-row"><span>主机名</span><b :title="system?.hostname">{{ system?.hostname }}</b></div>
          <div class="info-row"><span>当前用户</span><b>{{ system?.username }}</b></div>
          <div class="info-row"><span>运行时长</span><b>{{ formatDuration(liveUptimeSeconds * 1000) }}</b></div>
          <div class="info-row">
            <span>Node 版本</span>
            <b :title="appInfo?.systemNode && appInfo.systemNode !== appInfo.node ? `Electron 内置 Node：${appInfo.node}` : ''">
              {{ appInfo?.systemNode ?? appInfo?.node ?? system?.nodeVersion }}<span v-if="appInfo?.systemNode" class="cc-faint">（系统 Node）</span>
            </b>
          </div>
          <div v-if="appInfo?.node && appInfo.node !== appInfo.systemNode" class="info-row">
            <span>Electron Node</span><b>{{ appInfo.node }}</b>
          </div>
          <div class="info-row"><span>数据目录</span><button class="link" :title="state.app?.dataDir" @click="openDataDir">{{ state.app?.dataDir }}</button></div>
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
