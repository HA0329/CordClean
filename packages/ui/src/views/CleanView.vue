<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { CATEGORIES, RISK_META, formatBytes, formatDuration, formatTime } from '@cordclean/shared'
import type { CleanItem } from '@cordclean/shared'
import { cancelClean, cancelScan, state, startClean, startScan, openPath } from '../api/store.ts'

const selectedTaskIds = ref<string[]>([])
const filterTask = ref<string>('all')
const search = ref('')
const onlyCleanable = ref(true)
const page = ref(1)
const pageSize = ref(60)
const selected = reactive(new Set<string>())
const dryRun = ref(false)
const showConfirm = ref(false)

const tasks = computed(() => state.tasks)
const scan = computed(() => state.scan)
const scanning = computed(() => state.scanning)
const cleaning = computed(() => state.cleaning)

const tasksByCategory = computed(() => {
  const groups = new Map<string, typeof state.tasks>()
  for (const task of state.tasks) {
    const list = groups.get(task.category) ?? []
    list.push(task)
    groups.set(task.category, list)
  }
  return [...groups.entries()].map(([category, list]) => ({
    category,
    meta: CATEGORIES[category as keyof typeof CATEGORIES],
    tasks: list,
  }))
})

const itemsByTask = computed(() => {
  const map = new Map<string, { count: number; bytes: number }>()
  for (const item of scan.value?.items ?? []) {
    const current = map.get(item.taskId) ?? { count: 0, bytes: 0 }
    current.count++
    current.bytes += item.size
    map.set(item.taskId, current)
  }
  return map
})

const filtered = computed(() => {
  let items = scan.value?.items ?? []
  if (filterTask.value !== 'all') items = items.filter((item) => item.taskId === filterTask.value)
  if (onlyCleanable.value) items = items.filter((item) => !item.protected)
  const keyword = search.value.trim().toLowerCase()
  if (keyword) items = items.filter((item) => item.path.toLowerCase().includes(keyword) || item.title.toLowerCase().includes(keyword))
  return items
})

const paged = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value))

const selectedItems = computed(() => (scan.value?.items ?? []).filter((item) => selected.has(item.id)))
const selectedBytes = computed(() => selectedItems.value.reduce((sum, item) => sum + item.size, 0))
const riskySelected = computed(() => selectedItems.value.filter((item) => item.risk !== 'safe').length)

const cleanableBytes = computed(() => (scan.value?.items ?? []).filter((item) => !item.protected).reduce((sum, item) => sum + item.size, 0))
const cleanableCount = computed(() => (scan.value?.items ?? []).filter((item) => !item.protected).length)
const protectedCount = computed(() => (scan.value?.items ?? []).filter((item) => item.protected).length)

function selectDefaults() {
  selected.clear()
  for (const item of scan.value?.items ?? []) {
    if (item.defaultSelected && !item.protected) selected.add(item.id)
  }
}

watch(scan, () => {
  selectDefaults()
  filterTask.value = 'all'
  page.value = 1
})

watch([search, filterTask, onlyCleanable], () => {
  page.value = 1
})

function toggleItem(item: CleanItem, value: boolean) {
  if (value) selected.add(item.id)
  else selected.delete(item.id)
}

function selectPage(value: boolean) {
  for (const item of paged.value) {
    if (item.protected) continue
    if (value) selected.add(item.id)
    else selected.delete(item.id)
  }
}

async function runScan() {
  try {
    await startScan(selectedTaskIds.value.length ? selectedTaskIds.value : undefined)
    ElMessage.success('扫描完成')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function runScanSingle(taskId: string) {
  selectedTaskIds.value = [taskId]
  try {
    await startScan([taskId])
    ElMessage.success('扫描完成')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

function askClean() {
  if (!selected.size) {
    ElMessage.warning('请先勾选要清理的项目')
    return
  }
  showConfirm.value = true
}

async function confirmClean() {
  showConfirm.value = false
  try {
    const report = await startClean([...selected], { dryRun: dryRun.value })
    const modeLabel = report.mode === 'recycle' ? '回收站' : report.mode === 'quarantine' ? '隔离区' : '永久删除'
    const parts: string[] = []
    if (report.freedBytes > 0) parts.push(`释放 ${formatBytes(report.freedBytes)}`)
    if (report.recycledBytes > 0) parts.push(`${formatBytes(report.recycledBytes)} 已移入${modeLabel}`)
    if (report.quarantinedBytes > 0) parts.push(`${formatBytes(report.quarantinedBytes)} 已隔离（可恢复）`)
    if (report.vanished > 0) parts.push(`${report.vanished} 项扫描后已不存在`)
    if (report.skipped > 0) parts.push(`${report.skipped} 项按条件跳过`)
    if (report.freedBytes > 0 || report.cleaned > 0) {
      ElMessage.success(
        report.dryRun
          ? `预演完成：可释放 ${formatBytes(report.freedBytes)}`
          : `已处理 ${report.cleaned} 项${parts.length ? `：${parts.join('，')}` : ''}`,
      )
    } else if (parts.length) {
      ElMessage.warning(parts.join('，'))
    }
    if (report.failed) {
      ElMessage.warning(`${report.failed} 项未能清理，可在下方查看原因`)
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

const riskTag = (risk: keyof typeof RISK_META) => RISK_META[risk]
</script>

<template>
  <div class="cc-page">
    <div class="cc-page-title">
      <div>
        <h1>扫描与清理</h1>
        <p>每个能力都是一个独立的 Cordis 插件，可单独启用、配置与热重载。</p>
      </div>
      <div class="cc-actions">
        <el-switch v-model="dryRun" active-text="仅预演" />
        <el-button :disabled="scanning" @click="cancelScan">取消</el-button>
        <el-button type="primary" :loading="scanning" @click="runScan">
          {{ scanning ? '扫描中…' : '开始扫描' }}
        </el-button>
      </div>
    </div>

    <!-- 任务列表 -->
    <div class="cc-card">
      <div class="cc-card-title">
        <h3>🧩 清理能力（{{ tasks.length }}）</h3>
        <span class="cc-faint">可勾选以限定扫描范围；全不选表示扫描全部任务</span>
      </div>
      <el-checkbox-group v-model="selectedTaskIds" class="task-groups">
        <div v-for="group in tasksByCategory" :key="group.category" class="task-group">
          <div class="group-label">
            <span class="group-dot" :style="{ background: group.meta?.color }" />
            {{ group.meta?.name ?? group.category }}
          </div>
          <div class="task-grid">
            <div v-for="task in group.tasks" :key="task.id" class="task-card">
              <div class="task-head">
                <el-checkbox :value="task.id" />
                <span class="task-icon">{{ task.icon ?? '🧹' }}</span>
                <div class="task-title">
                  <div class="task-name">{{ task.name }}</div>
                  <div class="task-desc">{{ task.description }}</div>
                </div>
              </div>
              <div class="task-foot">
                <span class="cc-pill" :class="`risk-${task.risk}`">{{ RISK_META[task.risk].name }}</span>
                <span v-if="itemsByTask.get(task.id)" class="task-result">
                  {{ itemsByTask.get(task.id)!.count }} 项 · {{ formatBytes(itemsByTask.get(task.id)!.bytes) }}
                </span>
                <button class="mini-btn" @click.stop="runScanSingle(task.id)">单独扫描</button>
              </div>
            </div>
          </div>
        </div>
      </el-checkbox-group>

      <div v-if="scanning" class="progress-box">
        <el-progress :percentage="100" :indeterminate="true" :show-text="false" :stroke-width="6" />
        <div class="cc-faint">
          正在扫描 <b>{{ state.scanProgress?.current ?? '…' }}</b>
          · 已发现 {{ state.scanProgress?.items ?? 0 }} 项
          · {{ formatBytes(state.scanProgress?.bytes ?? 0) }}
        </div>
      </div>
    </div>

    <!-- 扫描结果 -->
    <template v-if="scan">
      <div class="cc-grid cc-grid-4">
        <div class="cc-card cc-stat">
          <div class="cc-stat-label">可清理项</div>
          <div class="cc-stat-value">{{ cleanableCount }}</div>
          <div class="cc-stat-sub">另有 {{ protectedCount }} 项受保护</div>
        </div>
        <div class="cc-card cc-stat">
          <div class="cc-stat-label">可释放空间</div>
          <div class="cc-stat-value">{{ formatBytes(cleanableBytes) }}</div>
          <div class="cc-stat-sub">含系统统计 {{ formatBytes(scan.stats.bytes) }}</div>
        </div>
        <div class="cc-card cc-stat">
          <div class="cc-stat-label">扫描耗时</div>
          <div class="cc-stat-value">{{ formatDuration(scan.elapsedMs) }}</div>
          <div class="cc-stat-sub">{{ scan.stats.files }} 个文件 / {{ scan.tasks.length }} 个任务</div>
        </div>
        <div class="cc-card cc-stat">
          <div class="cc-stat-label">跳过与错误</div>
          <div class="cc-stat-value">{{ scan.errors.length }}</div>
          <div class="cc-stat-sub">{{ scan.stats.truncated ? '结果已截断' : '无截断' }}</div>
        </div>
      </div>

      <div class="cc-card">
        <div class="cc-card-title">
          <h3>📋 清理项</h3>
          <div class="cc-actions">
            <el-select v-model="filterTask" style="width: 180px" size="small">
              <el-option label="全部任务" value="all" />
              <el-option v-for="task in tasks" :key="task.id" :label="task.name" :value="task.id" />
            </el-select>
            <el-input v-model="search" size="small" placeholder="搜索路径…" style="width: 220px" clearable />
            <el-checkbox v-model="onlyCleanable" size="small">只看可清理</el-checkbox>
          </div>
        </div>

        <div class="bulk-bar">
          <el-checkbox :model-value="paged.length > 0 && paged.filter((i) => !i.protected).every((i) => selected.has(i.id))" @change="(v: any) => selectPage(!!v)">
            本页全选
          </el-checkbox>
          <span class="cc-faint">已选 {{ selected.size }} 项 · {{ formatBytes(selectedBytes) }}</span>
          <el-button size="small" text @click="selectDefaults">恢复默认勾选</el-button>
          <el-button size="small" text @click="selected.clear()">清空选择</el-button>
        </div>

        <el-table
          :data="paged"
          size="small"
          :row-key="(row: CleanItem) => row.id"
          @row-click="(row: CleanItem) => !row.protected && toggleItem(row, !selected.has(row.id))"
          style="width: 100%"
          :empty-text="'没有匹配的清理项'"
        >
          <el-table-column width="46">
            <template #default="{ row }">
              <el-checkbox
                :model-value="selected.has(row.id)"
                :disabled="row.protected"
                @click.stop
                @change="(v: any) => toggleItem(row, !!v)"
              />
            </template>
          </el-table-column>
          <el-table-column label="名称" min-width="240">
            <template #default="{ row }">
              <div class="item-title">{{ row.title }}</div>
              <div class="cc-path" :title="row.path">{{ row.path }}</div>
            </template>
          </el-table-column>
          <el-table-column label="任务" width="130">
            <template #default="{ row }">
              <span class="cc-faint">{{ tasks.find((t: any) => t.id === row.taskId)?.name ?? row.taskId }}</span>
            </template>
          </el-table-column>
          <el-table-column label="大小" width="100" align="right">
            <template #default="{ row }">
              <span class="cc-mono">{{ row.size ? formatBytes(row.size) : '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="风险" width="90">
            <template #default="{ row }">
              <span class="cc-pill" :class="`risk-${row.risk}`">{{ riskTag(row.risk).name }}</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <span v-if="row.protected" class="cc-pill risk-risky">受保护</span>
              <button v-else class="link" @click.stop="openPath(row.path)">打开位置</button>
            </template>
          </el-table-column>
        </el-table>

        <div class="pager">
          <el-pagination
            v-model:current-page="page"
            :page-size="pageSize"
            :total="filtered.length"
            layout="prev, pager, next, total"
            background
            small
          />
        </div>
      </div>

      <!-- 清理结果 -->
      <div v-if="state.lastClean" class="cc-card">
        <div class="cc-card-title">
          <h3>✅ 上次清理结果</h3>
          <span class="cc-faint">{{ formatTime(state.lastClean.startedAt) }}</span>
        </div>
        <div class="cc-grid cc-grid-4">
          <div class="cc-stat">
            <div class="cc-stat-label">释放空间</div>
            <div class="cc-stat-value">{{ formatBytes(state.lastClean.freedBytes) }}</div>
          </div>
          <div class="cc-stat">
            <div class="cc-stat-label">清理项</div>
            <div class="cc-stat-value">{{ state.lastClean.cleaned }}</div>
          </div>
          <div class="cc-stat">
            <div class="cc-stat-label">隔离（可恢复）</div>
            <div class="cc-stat-value">{{ state.lastClean.quarantined }}</div>
          </div>
          <div class="cc-stat">
            <div class="cc-stat-label">失败</div>
            <div class="cc-stat-value" :style="{ color: state.lastClean.failed ? 'var(--cc-danger)' : undefined }">
              {{ state.lastClean.failed }}
            </div>
          </div>
        </div>
        <el-collapse v-if="state.lastClean.failures.length" class="failures">
          <el-collapse-item :title="`失败详情（${state.lastClean.failed}）`">
            <div v-for="failure in state.lastClean.failures.slice(0, 50)" :key="failure.itemId" class="failure-row">
              <span class="cc-path">{{ failure.path }}</span>
              <span class="cc-faint">{{ failure.message }}</span>
            </div>
          </el-collapse-item>
        </el-collapse>
      </div>
    </template>

    <!-- 底部操作栏 -->
    <div class="footer-bar">
      <div class="footer-info">
        <b>{{ selected.size }}</b> 项已选 · <b>{{ formatBytes(selectedBytes) }}</b>
        <span v-if="riskySelected" class="cc-pill risk-risky" style="margin-left: 8px">{{ riskySelected }} 项高风险</span>
      </div>
      <div class="cc-actions">
        <el-button v-if="cleaning" @click="cancelClean">取消清理</el-button>
        <el-button type="primary" size="large" :loading="cleaning" :disabled="!selected.size" @click="askClean">
          {{ dryRun ? '预演清理' : '开始清理' }}
        </el-button>
      </div>
    </div>

    <el-dialog v-model="showConfirm" title="确认清理" width="460px">
      <p>即将{{ dryRun ? '预演' : '' }}清理 <b>{{ selected.size }}</b> 项，预计释放 <b>{{ formatBytes(selectedBytes) }}</b>。</p>
      <p v-if="riskySelected" class="warn-text">其中 {{ riskySelected }} 项为谨慎/高风险项，将先放入隔离区，可随时恢复。</p>
      <p class="cc-faint">所有删除都会经过路径策略校验，系统关键目录与用户重要目录不会被动到。</p>
      <template #footer>
        <el-button @click="showConfirm = false">取消</el-button>
        <el-button type="primary" @click="confirmClean">确认</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.task-groups {
  display: block;
}

.task-group + .task-group {
  margin-top: 16px;
}

.group-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--cc-text-dim);
  margin-bottom: 8px;
}

.group-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.task-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 10px;
}

.task-card {
  border: 1px solid var(--cc-border);
  border-radius: 12px;
  padding: 12px 14px;
  background: var(--cc-primary-soft);
  display: flex;
  flex-direction: column;
  gap: 10px;
  transition: border-color 0.16s ease;
}

.task-card:hover {
  border-color: rgba(79, 140, 255, 0.4);
}

.task-head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.task-icon {
  font-size: 16px;
  line-height: 1.4;
}

.task-title {
  flex: 1;
  min-width: 0;
}

.task-name {
  font-size: 13.5px;
  font-weight: 550;
}

.task-desc {
  font-size: 11.5px;
  color: var(--cc-text-faint);
  margin-top: 2px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.task-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.task-result {
  color: var(--cc-success);
  font-size: 12px;
}

.mini-btn {
  margin-left: auto;
  background: transparent;
  border: none;
  color: var(--cc-primary);
  font-size: 11.5px;
  cursor: pointer;
}

.mini-btn:hover {
  text-decoration: underline;
}

.progress-box {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.bulk-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 2px 12px;
}

.item-title {
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pager {
  display: flex;
  justify-content: flex-end;
  padding-top: 12px;
}

.footer-bar {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 18px;
  border: 1px solid var(--cc-border);
  border-radius: 14px;
  background: var(--cc-panel-solid);
  backdrop-filter: blur(12px);
}

.footer-info {
  font-size: 13px;
  color: var(--cc-text-dim);
}

.footer-info b {
  color: var(--cc-text);
}

.link {
  background: transparent;
  border: none;
  color: var(--cc-primary);
  font-size: 12px;
  cursor: pointer;
}

.link:hover {
  text-decoration: underline;
}

.warn-text {
  color: var(--cc-warning);
}

.failure-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 0;
  border-bottom: 1px dashed var(--cc-border);
}

.failures {
  margin-top: 12px;
}
</style>
