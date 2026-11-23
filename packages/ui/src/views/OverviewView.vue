<script setup lang="ts">
/**
 * 概览页（已按「独立完成」标准升级）。
 *
 * 交互原则：
 * - 三态齐全：骨架屏 / 错误重试 / 正常；有缓存时即使刷新失败也不白屏；
 * - 快捷动作统一：刷新 / 复制摘要 / 一键扫描，不可用一律给原因（disabled + tooltip）；
 * - 空状态有引导：没清理记录时给「一键扫描」和「去清理页」两个出口；
 * - 空间紧张主动提醒：任一磁盘 ≥90% 时置顶提示并直达清理页；
 * - 自动采样只在窗口可见时进行：内存 5s、磁盘/系统 60s，隐藏暂停、切回立即补采；
 * - 运行时长本地走秒，不为「秒级刷新」请求宿主。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { formatBytes, formatDuration, formatTime } from '@cordclean/shared'
import PluginOverviewCards from '../components/PluginOverviewCards.vue'
import { openDataDir, refreshAppInfo, refreshSystem, refreshSystemLive, startScan, state } from '../api/store.ts'
import {
  buildSystemSummary,
  diskUsagePercent,
  liveUptimeSeconds as computeLiveUptime,
  memoryPercent,
  overviewPhase,
  scanGate,
  summarizeDisks,
  summarizeHistory,
  usageTone,
  type DiskLike,
} from './overview-model.ts'

const system = computed(() => state.system)
const appInfo = computed(() => state.app)
const disks = computed<DiskLike[]>(() => (system.value?.disks ?? []) as DiskLike[])
const diskSummary = computed(() => summarizeDisks(disks.value))
const memoryUsed = computed(() => (system.value ? Math.max(0, system.value.memoryTotal - system.value.memoryFree) : 0))
const memoryPercentValue = computed(() => (system.value ? memoryPercent(system.value.memoryTotal, system.value.memoryFree) : 0))
const historySummary = computed(() =>
  summarizeHistory((state.history ?? []) as Array<{ startedAt: number; freedBytes: number; cleaned: number; taskIds?: string[] }>),
)
const enabledPluginCount = computed(() => (state.plugins ?? []).filter((plugin: any) => plugin.enabled).length)

const nowTick = ref(Date.now())
const refreshing = ref(false)
const loadError = ref<string>()
const phase = computed(() => overviewPhase({ ready: state.ready, hasSystem: Boolean(system.value), error: loadError.value }))
const scanAvailability = computed(() => scanGate({ ready: state.ready, scanning: state.scanning, cleaning: state.cleaning }))

let tickTimer: ReturnType<typeof setInterval> | null = null
let liveTimer: ReturnType<typeof setInterval> | null = null
let fullTimer: ReturnType<typeof setInterval> | null = null
let liveRefreshing = false
let fullRefreshing = false

const uptimeSeconds = computed(() =>
  system.value ? computeLiveUptime(system.value.uptimeSeconds, system.value.collectedAt, nowTick.value) : 0,
)

async function quickScan() {
  if (!scanAvailability.value.ok) {
    ElMessage.info(scanAvailability.value.reason ?? '当前不可扫描')
    return
  }
  state.page = 'scanning'
  try {
    if (!(await startScan())) {
      if (state.page === 'scanning') state.page = 'overview'
      ElMessage.info('已有扫描正在进行')
    }
  } catch (error) {
    if (state.page === 'scanning') state.page = 'overview'
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function refresh(): Promise<void> {
  if (refreshing.value) return
  refreshing.value = true
  try {
    // 系统信息里的 Node 版本/平台来自真实宿主检测，而不是启动时缓存的旧值
    await Promise.all([refreshSystem(), refreshAppInfo()])
    nowTick.value = Date.now()
    loadError.value = undefined
    ElMessage.success('已刷新')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    loadError.value = message
    // 有缓存时不清空页面，只在顶部提示；没有缓存时 phase 会切到错误页
    if (system.value) ElMessage.error('刷新失败：' + message)
  } finally {
    refreshing.value = false
  }
}

/** 短周期轻量采样：只刷新内存/运行时长，不枚举磁盘 */
async function refreshLiveSilently(): Promise<void> {
  if (liveRefreshing || !state.ready) return
  liveRefreshing = true
  try {
    await refreshSystemLive()
    nowTick.value = Date.now()
  } catch {
    /* 概览是只读展示，失败时保留上一次数据 */
  } finally {
    liveRefreshing = false
  }
}

/** 长周期完整采样：磁盘可用空间、热点目录等变化较慢 */
async function refreshFullSilently(): Promise<void> {
  if (fullRefreshing || !state.ready) return
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

function onVisibilityChange(): void {
  // 从后台切回：立即补采一次，避免展示「几分钟前」的旧数据
  if (document.visibilityState === 'visible') {
    nowTick.value = Date.now()
    void refreshLiveSilently()
  }
}

/** 复制系统摘要：优先 Clipboard API，失败回退到 textarea + execCommand */
async function copySummary(): Promise<void> {
  const info = system.value
  if (!info) {
    ElMessage.warning('系统信息尚未就绪')
    return
  }
  const text = buildSystemSummary({
    platformLabel: appInfo.value?.platformLabel,
    release: info.release,
    cpuModel: info.cpuModel,
    cpuCores: info.cpuCores,
    hostname: info.hostname,
    username: info.username,
    memoryTotal: info.memoryTotal,
    memoryFree: info.memoryFree,
    uptimeSeconds: uptimeSeconds.value,
    disks: disks.value,
    version: appInfo.value?.version,
  })
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success('系统摘要已复制')
    return
  } catch {
    /* 回退方案 */
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    if (ok) ElMessage.success('系统摘要已复制')
    else ElMessage.warning('当前环境不允许复制，可手动选择文本')
  } catch {
    ElMessage.warning('当前环境不允许复制，可手动选择文本')
  }
}

function goClean(): void {
  state.page = 'clean'
}

function goHistory(): void {
  state.page = 'history'
}

function openDataDirectory(): void {
  void openDataDir().catch((error: unknown) => {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  })
}

onMounted(() => {
  // 每次进入概览都重新采样一次，避免长时间运行后展示启动时的旧信息
  void Promise.all([refreshSystem(), refreshAppInfo()])
    .then(() => {
      nowTick.value = Date.now()
      loadError.value = undefined
    })
    .catch((error: unknown) => {
      loadError.value = error instanceof Error ? error.message : String(error)
    })
  // 运行时长由本地走秒；内存 5 秒；磁盘/完整系统信息 60 秒；窗口隐藏时暂停
  tickTimer = setInterval(() => {
    nowTick.value = Date.now()
  }, 1_000)
  liveTimer = setInterval(() => {
    if (document.visibilityState !== 'hidden') void refreshLiveSilently()
  }, 5_000)
  fullTimer = setInterval(() => {
    if (document.visibilityState !== 'hidden') void refreshFullSilently()
  }, 60_000)
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer)
  if (liveTimer) clearInterval(liveTimer)
  if (fullTimer) clearInterval(fullTimer)
  tickTimer = null
  liveTimer = null
  fullTimer = null
  document.removeEventListener('visibilitychange', onVisibilityChange)
})
</script>

<template>
  <div class="cc-page">
    <div class="cc-page-title">
      <div>
        <h1>概览</h1>
        <p>基于 Cordis 插件框架构建，清理能力以插件形式动态装载；所有数据来自本机真实采样。</p>
      </div>
      <div class="cc-actions">
        <el-button :loading="refreshing" :disabled="!state.ready" @click="refresh">刷新</el-button>
        <el-button :disabled="!system" @click="copySummary">复制摘要</el-button>
        <el-tooltip :content="scanAvailability.reason ?? '扫描可清理项并进入选择流程'" placement="bottom">
          <span>
            <el-button type="primary" :disabled="!scanAvailability.ok" @click="quickScan">
              {{ state.scanning ? '扫描中…' : '一键扫描' }}
            </el-button>
          </span>
        </el-tooltip>
      </div>
    </div>

    <!-- 骨架屏：首次连接内核、还没有系统数据时 -->
    <div v-if="phase === 'loading'" class="overview-skeleton" aria-busy="true" aria-label="正在加载概览数据">
      <div class="cc-grid cc-grid-4">
        <div v-for="index in 4" :key="index" class="cc-card sk-stat">
          <span class="sk sk-line sk-w40" />
          <span class="sk sk-line sk-value" />
          <span class="sk sk-line sk-w60" />
        </div>
      </div>
      <div class="cc-grid cc-grid-2">
        <div class="cc-card sk-panel"><span class="sk sk-line sk-w30" /><span class="sk sk-line sk-w90" /><span class="sk sk-line sk-w80" /><span class="sk sk-line sk-w85" /></div>
        <div class="cc-card sk-panel"><span class="sk sk-line sk-w30" /><span class="sk sk-line sk-w90" /><span class="sk sk-line sk-w70" /><span class="sk sk-line sk-w95" /></div>
      </div>
    </div>

    <!-- 错误态：没有缓存且采集失败 -->
    <div v-else-if="phase === 'error'" class="cc-card overview-error">
      <div class="overview-error-icon" aria-hidden="true">⚠️</div>
      <h3>暂时拿不到系统信息</h3>
      <p class="cc-muted">{{ loadError || '内核没有返回系统数据' }}</p>
      <div class="cc-actions">
        <el-button type="primary" :loading="refreshing" @click="refresh">重试</el-button>
        <el-button @click="openDataDirectory">打开数据目录</el-button>
      </div>
    </div>

    <template v-else>
      <!-- 刷新失败但有缓存：页内提示，不清空已看到的页面 -->
      <el-alert
        v-if="loadError"
        class="overview-alert"
        type="warning"
        show-icon
        :closable="false"
        :title="'刷新失败：' + loadError"
        description="当前展示的是上一次成功采样的数据，可点右上角「刷新」重试。"
      />

      <!-- 磁盘空间紧张：主动提醒并直达清理 -->
      <el-alert
        v-if="diskSummary.warning"
        class="overview-alert"
        type="error"
        show-icon
        :closable="false"
        :title="diskSummary.warning"
      >
        <div class="alert-actions">
          <el-button size="small" type="primary" @click="goClean">去清理</el-button>
        </div>
      </el-alert>

      <div class="cc-grid cc-grid-4">
        <div class="cc-card cc-stat">
          <div class="cc-stat-label">累计释放空间</div>
          <div class="cc-stat-value gradient">{{ formatBytes(state.totals.freedBytes) }}</div>
          <div class="cc-stat-sub">
            {{ state.totals.sessions }} 次清理 · {{ state.totals.cleaned }} 个项目
            <template v-if="historySummary.hasHistory"> · 上次 {{ formatTime(historySummary.lastAt ?? 0) }}</template>
          </div>
        </div>
        <div class="cc-card cc-stat">
          <div class="cc-stat-label">已注册清理任务</div>
          <div class="cc-stat-value">{{ state.tasks.length }}</div>
          <div class="cc-stat-sub">来自 {{ enabledPluginCount }} 个已启用插件</div>
        </div>
        <div class="cc-card cc-stat">
          <div class="cc-stat-label">磁盘可用</div>
          <div class="cc-stat-value">{{ formatBytes(diskSummary.freeBytes) }}</div>
          <div class="cc-stat-sub">
            共 {{ diskSummary.count }} 个固定磁盘
            <span v-if="diskSummary.lowDisks.length" class="stat-warn">· {{ diskSummary.lowDisks.length }} 个空间紧张</span>
          </div>
        </div>
        <div class="cc-card cc-stat">
          <div class="cc-stat-label">内存占用</div>
          <div class="cc-stat-value">{{ formatBytes(memoryUsed) }}</div>
          <div class="cc-stat-sub">{{ memoryPercentValue }}% · 共 {{ formatBytes(system?.memoryTotal ?? 0) }}</div>
          <div class="cc-bar mini">
            <span :class="'tone-' + usageTone(memoryPercentValue)" :style="{ width: memoryPercentValue + '%' }" />
          </div>
        </div>
      </div>

      <PluginOverviewCards />

      <div class="cc-grid cc-grid-2">
        <div class="cc-card">
          <div class="cc-card-title">
            <h3>💾 磁盘使用情况</h3>
            <span class="cc-faint">每 60 秒自动采样 · 更新于 {{ formatTime(system?.collectedAt ?? 0) }}</span>
          </div>
          <div v-if="disks.length" class="disk-list">
            <div v-for="disk in disks" :key="disk.mount" class="disk-row">
              <div class="disk-head">
                <strong>
                  {{ disk.mount }}
                  <span v-if="diskUsagePercent(disk) >= 90" class="disk-tag">空间紧张</span>
                </strong>
                <span class="cc-faint">{{ formatBytes(Math.max(0, disk.free)) }} 可用 / 共 {{ formatBytes(disk.total) }}</span>
              </div>
              <div class="cc-bar">
                <span
                  :class="'tone-' + usageTone(diskUsagePercent(disk))"
                  :style="{ width: diskUsagePercent(disk) + '%' }"
                />
              </div>
              <div class="disk-foot cc-faint">
                <span>已用 {{ diskUsagePercent(disk) }}%</span>
                <span v-if="diskUsagePercent(disk) >= 90" class="disk-warn">剩余空间不足 10%</span>
              </div>
            </div>
          </div>
          <div v-else class="cc-empty">
            <p>未获取到磁盘信息</p>
            <el-button size="small" :loading="refreshing" @click="refresh">重新采样</el-button>
          </div>
        </div>

        <div class="cc-card">
          <div class="cc-card-title">
            <h3>🖥️ 系统信息</h3>
            <div class="cc-actions">
              <span
                v-if="system"
                class="cc-faint"
                title="运行时长每秒本地走时；内存每 5 秒自动刷新；磁盘/系统信息每 60 秒自动刷新；窗口隐藏时暂停"
              >采样于 {{ formatTime(system.collectedAt) }}</span>
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
            <div class="info-row"><span>运行时长</span><b>{{ formatDuration(uptimeSeconds * 1000) }}</b></div>
            <div class="info-row">
              <span>Node 版本</span>
              <b :title="appInfo?.systemNode && appInfo.systemNode !== appInfo.node ? `Electron 内置 Node：${appInfo.node}` : ''">
                {{ appInfo?.systemNode ?? appInfo?.node ?? system?.nodeVersion }}<span v-if="appInfo?.systemNode" class="cc-faint">（系统 Node）</span>
              </b>
            </div>
            <div v-if="state.app?.shell === 'desktop' && appInfo?.node && appInfo.node !== appInfo.systemNode" class="info-row">
              <span>Electron Node</span><b>{{ appInfo.node }}</b>
            </div>
            <div class="info-row"><span>数据目录</span><button class="link" :title="state.app?.dataDir" @click="openDataDirectory">{{ state.app?.dataDir }}</button></div>
          </div>
        </div>
      </div>

      <div class="cc-card">
        <div class="cc-card-title">
          <h3>🕘 最近清理</h3>
          <div class="cc-actions">
            <span v-if="historySummary.hasHistory" class="cc-faint">
              上次 {{ formatTime(historySummary.lastAt ?? 0) }} · 释放 {{ formatBytes(historySummary.lastFreedBytes) }} · {{ historySummary.lastCleaned }} 项
            </span>
            <el-button v-if="historySummary.hasHistory" size="small" text @click="goHistory">查看全部</el-button>
          </div>
        </div>
        <el-table v-if="historySummary.hasHistory" :data="state.history.slice(0, 6)" size="small">
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
        <div v-else class="overview-empty">
          <div class="overview-empty-icon" aria-hidden="true">🧹</div>
          <div>
            <h4>还没有清理记录</h4>
            <p class="cc-muted">先扫描一次，看看本机能清出多少空间；清理与隔离区都支持撤销/恢复。</p>
          </div>
          <div class="cc-actions">
            <el-button type="primary" :disabled="!scanAvailability.ok" @click="quickScan">一键扫描</el-button>
            <el-button @click="goClean">去清理页</el-button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.gradient {
  background: linear-gradient(120deg, #7fb0ff, #4fe0b8);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.overview-alert {
  margin-bottom: 14px;
}

.alert-actions {
  margin-top: 8px;
}

.stat-warn {
  color: var(--cc-warning);
}

.disk-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* 进度条色调：覆盖全局 .cc-bar > span 的默认渐变 */
.tone-ok {
  background: linear-gradient(90deg, #4f8cff, #29c196);
}
.tone-warn {
  background: linear-gradient(90deg, #f6c35a, #f0a33a);
}
.tone-danger {
  background: linear-gradient(90deg, #ff8a6a, #f0506e);
}
.cc-bar.mini {
  height: 5px;
  margin-top: 6px;
}

.disk-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 6px;
  font-size: 13px;
}

.disk-tag {
  margin-left: 6px;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--cc-warning);
  border: 1px solid color-mix(in srgb, var(--cc-warning) 35%, transparent);
  border-radius: 999px;
  padding: 0 6px;
}

.disk-foot {
  display: flex;
  justify-content: space-between;
  margin-top: 5px;
  font-size: 11.5px;
}

.disk-warn {
  color: var(--cc-danger);
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

/* 空状态 */
.overview-empty {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 18px 8px;
  flex-wrap: wrap;
}
.overview-empty-icon {
  width: 52px;
  height: 52px;
  flex: 0 0 52px;
  display: grid;
  place-items: center;
  font-size: 24px;
  border-radius: 16px;
  background: var(--cc-primary-soft);
}
.overview-empty h4 {
  margin: 0 0 4px;
}
.overview-empty p {
  margin: 0;
}
.overview-empty .cc-actions {
  margin-left: auto;
}

/* 错误态 */
.overview-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 48px 24px;
  text-align: center;
}
.overview-error h3 {
  margin: 0;
}
.overview-error p {
  margin: 0;
  max-width: 520px;
}
.overview-error-icon {
  font-size: 34px;
}

/* 骨架屏 */
.overview-skeleton {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.sk-stat {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.sk-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.sk {
  display: block;
  height: 12px;
  border-radius: 6px;
  background: linear-gradient(90deg, var(--cc-hover-bg), color-mix(in srgb, var(--cc-primary) 12%, transparent), var(--cc-hover-bg));
  background-size: 200% 100%;
  animation: sk-shimmer 1.4s ease-in-out infinite;
}
.sk-value {
  height: 26px;
  width: 60%;
  border-radius: 8px;
}
.sk-line + .sk-line {
  margin-top: 0;
}
.sk-w30 { width: 30%; }
.sk-w40 { width: 40%; }
.sk-w60 { width: 60%; }
.sk-w70 { width: 70%; }
.sk-w80 { width: 80%; }
.sk-w85 { width: 85%; }
.sk-w90 { width: 90%; }
.sk-w95 { width: 95%; }

@keyframes sk-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

@media (max-width: 980px) {
  .info-grid {
    grid-template-columns: 1fr;
  }
  .overview-empty .cc-actions {
    margin-left: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .sk {
    animation: none;
  }
}
</style>
