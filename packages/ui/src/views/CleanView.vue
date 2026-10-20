<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  CATEGORIES,
  RISK_META,
  filterItems,
  formatBytes,
  formatDuration,
  formatTime,
  groupByCategory,
  recommendIds,
  selectionState,
  sortItems,
  summarizeSelection,
} from '@cordclean/shared'
import type {
  CleanItem,
  ItemFilter,
  ItemKind,
  ItemSort,
  RiskLevel,
  TaskDescriptor,
  TaskGroup,
} from '@cordclean/shared'
import { cancelClean, cancelScan, moveFiles, openPath, startClean, startScan, state } from '../api/store.ts'

/* ------------------------------------------------------------------ */
/* 扫描任务选择                                                         */
/* ------------------------------------------------------------------ */

const selectedTaskIds = ref<string[]>([])
const selectionReady = ref(false)

// 默认勾选安全任务，避免「不勾选=全扫」的误解
watch(
  () => state.tasks,
  (tasks) => {
    if (selectionReady.value || !tasks.length) return
    selectedTaskIds.value = tasks.filter((task) => task.defaultSelected).map((task) => task.id)
    selectionReady.value = true
  },
  { immediate: true },
)

function selectSafeTasks() {
  selectedTaskIds.value = state.tasks.filter((task) => task.risk === 'safe' && task.defaultSelected).map((task) => task.id)
  if (!selectedTaskIds.value.length) selectedTaskIds.value = state.tasks.filter((task) => task.risk === 'safe').map((task) => task.id)
}

function clearTaskSelection() {
  selectedTaskIds.value = []
}

/* ------------------------------------------------------------------ */
/* 结果视图、筛选与选择状态                                              */
/* ------------------------------------------------------------------ */

type ViewMode = 'groups' | 'items' | 'protected'
type RiskFilter = 'all' | RiskLevel
type SizeFilter = 'all' | '1mb' | '10mb' | '100mb'

const VIEW_KEY = 'cordclean.clean.view'
const PAGE_SIZE_KEY = 'cordclean.clean.pageSize'
const SORT_KEY = 'cordclean.clean.sort'
const POLICY_KEY = 'cordclean.clean.recommendPolicy'

function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

function savePref(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* 隐私模式忽略 */
  }
}

const loadedView = loadPref<ViewMode>(VIEW_KEY, 'groups')
const view = ref<ViewMode>(loadedView === 'items' || loadedView === 'protected' || loadedView === 'groups' ? loadedView : 'groups')
const loadedPageSize = loadPref<number>(PAGE_SIZE_KEY, 100)
const pageSize = ref([100, 200, 500].includes(loadedPageSize) ? loadedPageSize : 100)
const loadedSort = loadPref<ItemSort>(SORT_KEY, 'size-desc')
const SORTS: ItemSort[] = ['size-desc', 'size-asc', 'name', 'mtime-desc', 'risk-desc']
const sort = ref<ItemSort>(SORTS.includes(loadedSort) ? loadedSort : 'size-desc')

interface RecommendPolicy {
  minSize: number
  includeCaution: boolean
}
const loadedPolicy = loadPref<RecommendPolicy>(POLICY_KEY, { minSize: 0, includeCaution: false })
const ALLOWED_MIN_SIZE = [0, 1024 ** 2, 10 * 1024 ** 2, 100 * 1024 ** 2]
const recommendMinSize = ref(
  typeof loadedPolicy?.minSize === 'number' && ALLOWED_MIN_SIZE.includes(loadedPolicy.minSize) ? loadedPolicy.minSize : 0,
)
const recommendIncludeCaution = ref(loadedPolicy?.includeCaution === true)

watch([view], () => savePref(VIEW_KEY, view.value))
watch([pageSize], () => {
  savePref(PAGE_SIZE_KEY, pageSize.value)
  page.value = 1
})
watch([sort], () => savePref(SORT_KEY, sort.value))
watch([recommendMinSize, recommendIncludeCaution], () => {
  savePref(POLICY_KEY, { minSize: recommendMinSize.value, includeCaution: recommendIncludeCaution.value })
})

const search = ref('')
const riskFilter = ref<RiskFilter>('all')
const sizeFilter = ref<SizeFilter>('all')
const taskFilter = ref<string>('all')
const onlyRecommended = ref(false)
const page = ref(1)
const expanded = ref<Set<string>>(new Set())

const SIZE_OPTIONS: Array<{ value: SizeFilter; label: string; bytes: number }> = [
  { value: 'all', label: '全部大小', bytes: 0 },
  { value: '1mb', label: '≥ 1 MB', bytes: 1024 ** 2 },
  { value: '10mb', label: '≥ 10 MB', bytes: 10 * 1024 ** 2 },
  { value: '100mb', label: '≥ 100 MB', bytes: 100 * 1024 ** 2 },
]
const SORT_OPTIONS: Array<{ value: ItemSort; label: string }> = [
  { value: 'size-desc', label: '大小（从大到小）' },
  { value: 'size-asc', label: '大小（从小到大）' },
  { value: 'mtime-desc', label: '修改时间（最新）' },
  { value: 'name', label: '名称' },
  { value: 'risk-desc', label: '风险（高 → 低）' },
]

const tasks = computed(() => state.tasks)
const scan = computed(() => state.scan)
const scanning = computed(() => state.scanning)
const cleaning = computed(() => state.cleaning)
const allItems = computed<CleanItem[]>(() => scan.value?.items ?? [])

const taskMap = computed(() => {
  const map = new Map<string, TaskDescriptor>()
  for (const task of state.tasks) map.set(task.id, task)
  return map
})

const taskName = (taskId: string) => taskMap.value.get(taskId)?.name ?? taskId
const taskIcon = (taskId: string) => taskMap.value.get(taskId)?.icon ?? '🧹'

const protectedItems = computed(() => allItems.value.filter((item) => item.protected))
const protectedIdSet = computed(() => new Set(protectedItems.value.map((item) => item.id)))
/** 受保护视图只按搜索词过滤（风险/大小/任务筛选只在可清理视图有意义） */
const protectedFiltered = computed(() => {
  const query = search.value.trim()
  if (!query) return protectedItems.value
  return filterItems(protectedItems.value, { query, includeProtected: true })
})

const cleanableItems = computed(() => allItems.value.filter((item) => !item.protected))
const cleanableBytes = computed(() => cleanableItems.value.reduce((sum, item) => sum + item.size, 0))

const riskCounts = computed(() => {
  const counts: Record<RiskLevel, number> & { bytes: Record<RiskLevel, number> } = {
    safe: 0,
    caution: 0,
    risky: 0,
    bytes: { safe: 0, caution: 0, risky: 0 },
  }
  for (const item of cleanableItems.value) {
    counts[item.risk]++
    counts.bytes[item.risk] += item.size
  }
  return counts
})

const recommendOptions = computed(() => ({
  minSize: recommendMinSize.value,
  includeCaution: recommendIncludeCaution.value,
}))

/** 已应用到选择集的推荐策略；策略改动后提示用户手动「应用推荐」 */
const appliedPolicyKey = ref('')
const policyKey = computed(() => `${recommendMinSize.value}:${recommendIncludeCaution.value}`)
const policyStale = computed(() => appliedPolicyKey.value !== '' && appliedPolicyKey.value !== policyKey.value)

const recommendedIds = computed(() => recommendIds(allItems.value, recommendOptions.value))
const recommendedSet = computed(() => new Set(recommendedIds.value))
const recommendedBytes = computed(() => {
  let bytes = 0
  for (const item of allItems.value) if (recommendedSet.value.has(item.id)) bytes += item.size
  return bytes
})

/** 每个任务下被路径策略保护的项目数（用于总览里说明「为什么有些没出现」） */
const protectedByTask = computed(() => {
  const map = new Map<string, number>()
  for (const item of protectedItems.value) map.set(item.taskId, (map.get(item.taskId) ?? 0) + 1)
  return map
})

/* ------------------------------------------------------------------ */
/* 筛选（分组视图与明细视图共用）                                        */
/* ------------------------------------------------------------------ */

const activeSizeBytes = computed(() => SIZE_OPTIONS.find((option) => option.value === sizeFilter.value)?.bytes ?? 0)

const filter = computed<ItemFilter>(() => ({
  query: search.value,
  taskIds: taskFilter.value === 'all' ? undefined : [taskFilter.value],
  risks: riskFilter.value === 'all' ? undefined : [riskFilter.value],
  minSize: activeSizeBytes.value,
  onlyRecommended: onlyRecommended.value,
}))

/** 当前筛选后、按排序规则排列的全部项目（不含受保护项） */
const filtered = computed(() => sortItems(filterItems(allItems.value, filter.value), sort.value))

/** 分组总览：按分类 → 任务聚合当前筛选结果 */
const categoryGroups = computed(() =>
  groupByCategory(filtered.value, state.tasks, {
    sampleLimit: 3,
    recommend: recommendOptions.value,
  }),
)

const filteredBytes = computed(() => filtered.value.reduce((sum, item) => sum + item.size, 0))

const maxGroupBytes = computed(() => {
  let max = 1
  for (const category of categoryGroups.value) for (const group of category.tasks) max = Math.max(max, group.bytes)
  return max
})

const filtersActive = computed(
  () =>
    search.value.trim() !== '' ||
    riskFilter.value !== 'all' ||
    sizeFilter.value !== 'all' ||
    taskFilter.value !== 'all' ||
    onlyRecommended.value,
)

function resetFilters() {
  search.value = ''
  riskFilter.value = 'all'
  sizeFilter.value = 'all'
  taskFilter.value = 'all'
  onlyRecommended.value = false
}

const paged = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value))

watch([search, riskFilter, sizeFilter, taskFilter, onlyRecommended, sort], () => {
  page.value = 1
})
watch(view, () => {
  page.value = 1
})

function showTaskItems(taskId: string) {
  taskFilter.value = taskId
  view.value = 'items'
  page.value = 1
}

/* ------------------------------------------------------------------ */
/* 选择集                                                              */
/* ------------------------------------------------------------------ */

const selected = ref<Set<string>>(new Set())

const selectedItems = computed(() => allItems.value.filter((item) => selected.value.has(item.id) && !item.protected))
const selectedBytes = computed(() => selectedItems.value.reduce((sum, item) => sum + item.size, 0))
const selectedRisky = computed(() => selectedItems.value.filter((item) => item.risk === 'risky').length)
const selectedCaution = computed(() => selectedItems.value.filter((item) => item.risk === 'caution').length)
const summary = computed(() => summarizeSelection(allItems.value, selected.value, state.tasks))

function toggleItem(item: CleanItem, value: boolean) {
  if (item.protected) return
  const next = new Set(selected.value)
  if (value) next.add(item.id)
  else next.delete(item.id)
  selected.value = next
}

function addIds(ids: Iterable<string>) {
  const next = new Set(selected.value)
  for (const id of ids) if (!protectedIdSet.value.has(id)) next.add(id)
  selected.value = next
}

function removeIds(ids: Iterable<string>) {
  const next = new Set(selected.value)
  for (const id of ids) next.delete(id)
  selected.value = next
}

function clearSelection() {
  selected.value = new Set()
}

function applyRecommendation() {
  selected.value = new Set(recommendedIds.value)
  appliedPolicyKey.value = policyKey.value
  ElMessage.success(`已按推荐策略勾选 ${recommendedIds.value.length} 项内容`)
}

function selectSafeOnly() {
  recommendMinSize.value = 0
  recommendIncludeCaution.value = false
  selected.value = new Set(recommendedIds.value)
  appliedPolicyKey.value = policyKey.value
  ElMessage.success(`已勾选 ${selected.value.size} 项安全内容`)
}

function selectLargeFiles() {
  const ids: string[] = []
  for (const item of cleanableItems.value) {
    if (item.size >= 100 * 1024 ** 2 && item.risk !== 'risky') ids.push(item.id)
  }
  selected.value = new Set(ids)
  ElMessage.success(ids.length ? `已勾选 ${ids.length} 项大于 100 MB 的内容` : '没有大于 100 MB 的可清理内容')
}

function selectFiltered() {
  addIds(filtered.value.map((item) => item.id))
  ElMessage.success(`已勾选当前筛选的 ${filtered.value.length} 项`)
}

function invertFiltered() {
  const next = new Set(selected.value)
  for (const item of filtered.value) {
    if (next.has(item.id)) next.delete(item.id)
    else next.add(item.id)
  }
  selected.value = next
}

function selectPaged(value: boolean) {
  const ids = paged.value.filter((item) => !item.protected).map((item) => item.id)
  if (value) addIds(ids)
  else removeIds(ids)
}

const pagedState = computed(() => selectionState(paged.value.map((item) => item.id), selected.value))

function toggleGroup(group: TaskGroup, value: boolean) {
  if (value) addIds(group.ids)
  else removeIds(group.ids)
}

function groupState(group: TaskGroup) {
  return selectionState(group.ids, selected.value)
}

function toggleExpanded(taskId: string) {
  const next = new Set(expanded.value)
  if (next.has(taskId)) next.delete(taskId)
  else next.add(taskId)
  expanded.value = next
}

/* ------------------------------------------------------------------ */
/* 详情抽屉                                                             */
/* ------------------------------------------------------------------ */

const detail = ref<CleanItem | null>(null)
const detailVisible = ref(false)

const KIND_LABELS: Record<ItemKind, string> = {
  file: '文件',
  directory: '文件夹',
  registry: '注册表项',
  command: '命令',
  entry: '启动项',
}

const RISK_EXPLAIN: Record<RiskLevel, string> = {
  safe: '安全项：缓存、日志、临时文件等可自动重建的内容，删除后应用会重新生成，一般不影响正常使用。',
  caution: '谨慎项：可能影响某些功能，或需要重新下载 / 重新登录，默认不勾选。建议先「打开位置」核对用途再选。',
  risky: '高风险项：可能影响软件运行，或需要人工判断。默认不勾选；即使勾选，清理时也会先放入隔离区，可随时恢复。',
}

const META_LABELS: Record<string, string> = {
  browser: '浏览器',
  profile: '配置文件',
  app: '所属应用',
  publisher: '发布者',
  ruleId: '命中规则',
  rule: '命中规则',
  reason: '判断依据',
  lastUsed: '最近使用',
  version: '版本',
  key: '注册表键',
  command: '命令',
  target: '目标',
  userId: '用户',
  source: '来源',
  duplicateOf: '重复于',
}

function openDetail(item: CleanItem) {
  detail.value = item
  detailVisible.value = true
}

const detailMeta = computed(() => {
  const raw = detail.value?.meta
  if (!raw) return []
  const entries: Array<{ label: string; value: string }> = []
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined || typeof value === 'object') continue
    const text = typeof value === 'boolean' ? (value ? '是' : '否') : String(value)
    if (!text.trim()) continue
    entries.push({ label: META_LABELS[key] ?? key, value: text.length > 160 ? `${text.slice(0, 160)}…` : text })
    if (entries.length >= 10) break
  }
  return entries
})

const detailRiskText = computed(() => {
  if (!detail.value) return ''
  if (detail.value.protected) {
    return '受保护项：命中路径策略的保护名单（系统关键目录 / 用户重要目录），CordClean 不会删除。如确认无用，请自行在系统里处理。'
  }
  return RISK_EXPLAIN[detail.value.risk]
})

function detailSelected(item: CleanItem) {
  return selected.value.has(item.id)
}

function toggleDetailSelection() {
  if (!detail.value || detail.value.protected) return
  toggleItem(detail.value, !selected.value.has(detail.value.id))
}

/* ------------------------------------------------------------------ */
/* 扫描 / 清理动作                                                      */
/* ------------------------------------------------------------------ */

const dryRun = ref(false)
const showConfirm = ref(false)

const scanTaskName = computed(() => {
  const id = state.scanProgress?.taskId
  return id ? taskName(id) : ''
})

const scanTaskCount = computed(() => new Set(cleanableItems.value.map((item) => item.taskId)).size)

const itemsByTask = computed(() => {
  const map = new Map<string, { count: number; bytes: number }>()
  for (const item of allItems.value) {
    const current = map.get(item.taskId) ?? { count: 0, bytes: 0 }
    current.count++
    current.bytes += item.size
    map.set(item.taskId, current)
  }
  return map
})

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

async function runScan() {
  try {
    const ids = selectedTaskIds.value.filter((id) => state.tasks.some((task) => task.id === id))
    if (!ids.length) {
      ElMessage.warning('请先勾选要扫描的清理项（默认已勾选安全项）')
      return
    }
    await startScan(ids)
    if (state.scan?.cancelled) ElMessage.warning('扫描已取消，已显示部分结果')
    else ElMessage.success('扫描完成')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function runScanSingle(taskId: string) {
  selectedTaskIds.value = [taskId]
  try {
    await startScan([taskId])
    if (state.scan?.cancelled) ElMessage.warning('扫描已取消，已显示部分结果')
    else ElMessage.success('扫描完成')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

// 新扫描结果：应用推荐策略、重置筛选与选择（首次加载已有扫描结果时同样适用）
watch(
  scan,
  () => {
    selected.value = new Set(recommendedIds.value)
    appliedPolicyKey.value = policyKey.value
    expanded.value = new Set()
    resetFilters()
    page.value = 1
  },
  { immediate: true },
)

function askClean() {
  if (!selected.value.size) {
    ElMessage.warning('请先勾选要清理的项目')
    return
  }
  showConfirm.value = true
}

async function confirmClean() {
  showConfirm.value = false
  try {
    const report = await startClean([...selected.value], { dryRun: dryRun.value })
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

/** 移动到指定文件夹（不删除、可回退），完成后重新扫描刷新列表 */
async function askMove() {
  if (!selectedItems.value.length) {
    ElMessage.warning('请先勾选要移动的项目')
    return
  }
  try {
    const result = await ElMessageBox.prompt(
      `将所选 ${selected.value.size} 项移动到目标文件夹（不删除，可手动移回）。`,
      '移动到…',
      {
        confirmButtonText: '开始移动',
        cancelButtonText: '取消',
        inputPlaceholder: '例如 D:\\CordClean-backup',
        inputValidator: (value: string) => (value && value.trim() ? true : '请输入目标文件夹的绝对路径'),
      },
    )
    const target = result.value.trim()
    const moved = await moveFiles(selectedItems.value.map((item) => item.path), target)
    if (moved.moved.length) {
      ElMessage.success(`已移动 ${moved.moved.length} 项（${formatBytes(moved.freedBytes)}）到 ${target}`)
      await runScan()
    } else {
      ElMessage.warning('没有项目被移动')
    }
    if (moved.failed.length) ElMessage.warning(`${moved.failed.length} 项移动失败`)
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}

async function handleBulkCommand(command: string) {
  if (command === 'recommend') applyRecommendation()
  else if (command === 'safe') selectSafeOnly()
  else if (command === 'large') selectLargeFiles()
  else if (command === 'filtered') selectFiltered()
  else if (command === 'invert') invertFiltered()
  else if (command === 'clear') clearSelection()
}
</script>

<template>
  <div class="cc-page clean-view">
    <div class="cc-page-title">
      <div>
        <h1>扫描与清理</h1>
        <p>扫描后先看分组总览：安全项已自动勾选，谨慎 / 高风险项需要你确认；看不明白的项可以展开说明或打开位置。</p>
      </div>
      <div class="cc-actions">
        <el-switch v-model="dryRun" active-text="仅预演" />
        <el-button :disabled="!scanning" @click="cancelScan">取消</el-button>
        <el-button type="primary" :loading="scanning" @click="runScan">
          {{ scanning ? '扫描中…' : '开始扫描' }}
        </el-button>
      </div>
    </div>

    <!-- 任务列表 -->
    <div class="cc-card">
      <div class="cc-card-title">
        <h3>🧩 清理能力（{{ tasks.length }}）</h3>
        <div class="cc-actions">
          <span class="cc-faint">已选 {{ selectedTaskIds.length }} 个任务</span>
          <el-button size="small" text @click="selectSafeTasks">全选安全任务</el-button>
          <el-button size="small" text @click="clearTaskSelection">清空</el-button>
        </div>
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
                <el-checkbox :value="task.id" :disabled="scanning" />
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
          正在扫描 <b>{{ scanTaskName || '…' }}</b>
          · 已发现 {{ state.scanProgress?.items ?? 0 }} 项
          · {{ formatBytes(state.scanProgress?.bytes ?? 0) }}
        </div>
      </div>
    </div>

    <!-- 尚无扫描结果：引导 -->
    <div v-if="!scan" class="cc-card empty-guide">
      <h3>还没有扫描结果</h3>
      <div class="guide-steps">
        <div class="guide-step"><span class="step-no">1</span><div><b>勾选能力并扫描</b><p>默认已勾选安全任务，点击右上角「开始扫描」。</p></div></div>
        <div class="guide-step"><span class="step-no">2</span><div><b>看分组总览</b><p>按类别和任务汇总大小，安全项自动推荐；整组勾选比逐条翻更省事。</p></div></div>
        <div class="guide-step"><span class="step-no">3</span><div><b>微调后清理</b><p>展开样例或切到「逐项明细」核对；高风险项会先放隔离区，可恢复。</p></div></div>
      </div>
    </div>

    <!-- 扫描结果 -->
    <template v-else>
      <div class="cc-grid cc-grid-4">
        <div class="cc-card cc-stat">
          <div class="cc-stat-label">可清理项</div>
          <div class="cc-stat-value">{{ cleanableItems.length.toLocaleString('zh-CN') }}</div>
          <div class="cc-stat-sub">{{ formatBytes(cleanableBytes) }} · {{ scanTaskCount }} 个任务</div>
        </div>
        <div class="cc-card cc-stat">
          <div class="cc-stat-label">推荐清理（安全项）</div>
          <div class="cc-stat-value">{{ recommendedIds.length.toLocaleString('zh-CN') }}</div>
          <div class="cc-stat-sub">{{ formatBytes(recommendedBytes) }} · 可一键应用</div>
        </div>
        <div class="cc-card cc-stat">
          <div class="cc-stat-label">需要你确认</div>
          <div class="cc-stat-value">{{ (riskCounts.caution + riskCounts.risky).toLocaleString('zh-CN') }}</div>
          <div class="cc-stat-sub">谨慎 {{ riskCounts.caution }} 项 · 高风险 {{ riskCounts.risky }} 项</div>
        </div>
        <div class="cc-card cc-stat">
          <div class="cc-stat-label">受保护（不可清理）</div>
          <div class="cc-stat-value">{{ protectedItems.length.toLocaleString('zh-CN') }}</div>
          <div class="cc-stat-sub">命中路径策略，扫描已跳过</div>
        </div>
      </div>

      <!-- 推荐策略横幅 -->
      <div class="cc-card recommend-banner">
        <div class="banner-main">
          <div class="banner-icon">✨</div>
          <div class="banner-text">
            <b>智能推荐</b>
            <p>
              已按推荐策略（安全项{{ recommendIncludeCaution ? ' + 谨慎项' : '' }}）勾选 <b>{{ recommendedIds.length }}</b> 项（{{ formatBytes(recommendedBytes) }}）；
              谨慎 {{ riskCounts.caution }} 项、高风险 {{ riskCounts.risky }} 项、受保护 {{ protectedItems.length }} 项默认不勾选。
              看不明白的项目可展开「说明」或打开位置核对。
            </p>
            <p v-if="policyStale" class="policy-stale">推荐策略已变更，点击「应用推荐」重新勾选。</p>
          </div>
        </div>
        <div class="banner-actions">
          <label class="policy-field">
            <span>推荐阈值</span>
            <el-select v-model="recommendMinSize" size="small" style="width: 116px" class="recommend-min-size">
              <el-option v-for="option in SIZE_OPTIONS" :key="option.value" :label="option.value === 'all' ? '不限大小' : option.label" :value="option.bytes" />
            </el-select>
          </label>
          <label class="policy-field">
            <el-switch v-model="recommendIncludeCaution" size="small" class="recommend-caution" />
            <span>包含谨慎项</span>
          </label>
          <el-button size="small" @click="selectSafeOnly">只选安全项</el-button>
          <el-button size="small" type="primary" @click="applyRecommendation">应用推荐</el-button>
        </div>
      </div>

      <!-- 结果面板 -->
      <div class="cc-card result-card">
        <div class="result-head">
          <div class="view-tabs">
            <button class="view-tab" :class="{ active: view === 'groups' }" data-view="groups" @click="view = 'groups'">分组总览</button>
            <button class="view-tab" :class="{ active: view === 'items' }" data-view="items" @click="view = 'items'">逐项明细</button>
            <button class="view-tab" :class="{ active: view === 'protected' }" data-view="protected" @click="view = 'protected'">受保护（{{ protectedItems.length }}）</button>
          </div>
          <div class="result-actions">
            <el-input v-model="search" size="small" placeholder="搜索名称 / 路径 / 说明…" clearable class="search-input" style="width: 220px" />
            <el-select v-if="view !== 'protected'" v-model="sizeFilter" size="small" style="width: 118px" class="size-filter">
              <el-option v-for="option in SIZE_OPTIONS" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
            <el-select v-if="view !== 'protected'" v-model="taskFilter" size="small" style="width: 150px" class="task-filter">
              <el-option label="全部任务" value="all" />
              <el-option v-for="task in tasks.filter((t) => itemsByTask.has(t.id))" :key="task.id" :label="task.name" :value="task.id" />
            </el-select>
            <el-select v-if="view !== 'protected'" v-model="sort" size="small" style="width: 150px" class="sort-select">
              <el-option v-for="option in SORT_OPTIONS" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
            <el-checkbox v-if="view !== 'protected'" v-model="onlyRecommended" size="small" class="only-recommended">只看推荐</el-checkbox>
          </div>
        </div>

        <div v-if="view !== 'protected'" class="risk-filters">
          <button class="risk-filter" :class="{ active: riskFilter === 'all' }" data-risk="all" @click="riskFilter = 'all'">全部 {{ cleanableItems.length }}</button>
          <button class="risk-filter" :class="{ active: riskFilter === 'safe' }" data-risk="safe" @click="riskFilter = 'safe'">安全 {{ riskCounts.safe }}</button>
          <button class="risk-filter" :class="{ active: riskFilter === 'caution' }" data-risk="caution" @click="riskFilter = 'caution'">谨慎 {{ riskCounts.caution }}</button>
          <button class="risk-filter" :class="{ active: riskFilter === 'risky' }" data-risk="risky" @click="riskFilter = 'risky'">高风险 {{ riskCounts.risky }}</button>
          <span class="filter-sep" />
          <span class="cc-faint">{{ formatTime(scan.startedAt) }} 扫描 · 耗时 {{ formatDuration(scan.elapsedMs) }}</span>
          <span v-if="scan.stats.truncated" class="cc-pill risk-caution">结果已截断</span>
          <span class="cc-faint">当前筛选 {{ filtered.length.toLocaleString('zh-CN') }} 项 · {{ formatBytes(filteredBytes) }}</span>
          <span class="filter-spacer" />
          <el-button size="small" text :disabled="!filtered.length" @click="selectFiltered">选中筛选结果</el-button>
          <el-button size="small" text :disabled="!filtered.length" @click="invertFiltered">反选</el-button>
          <el-button size="small" text :disabled="!selected.size" @click="clearSelection">清空选择</el-button>
          <el-button size="small" text :disabled="!filtersActive" @click="resetFilters">重置筛选</el-button>
        </div>

        <!-- 分组总览 -->
        <div v-if="view === 'groups'" class="group-list">
          <div v-for="category in categoryGroups" :key="category.category" class="category-block">
            <div class="category-head">
              <span class="category-dot" :style="{ background: category.color }" />
              <b>{{ category.name }}</b>
              <span class="cc-faint">{{ category.tasks.reduce((sum, group) => sum + group.count, 0) }} 项 · {{ formatBytes(category.bytes) }}</span>
              <span class="cc-faint">推荐 {{ category.recommendCount }}</span>
            </div>

            <div v-for="group in category.tasks" :key="group.taskId" class="group-row" :data-task-id="group.taskId">
              <el-checkbox
                class="group-checkbox"
                :model-value="groupState(group) === 'all'"
                :indeterminate="groupState(group) === 'partial'"
                @change="(value: any) => toggleGroup(group, !!value)"
              />
              <div class="group-main">
                <div class="group-title">
                  <span class="task-icon">{{ taskIcon(group.taskId) }}</span>
                  <b>{{ group.name }}</b>
                  <span class="cc-pill" :class="`risk-${group.risk}`">{{ RISK_META[group.risk].name }}</span>
                  <span v-if="group.recommendCount" class="recommend-tag">推荐 {{ group.recommendCount }}</span>
                  <span v-if="protectedByTask.get(group.taskId)" class="protected-tag">另有 {{ protectedByTask.get(group.taskId) }} 项受保护</span>
                </div>
                <div class="group-desc">
                  {{ taskMap.get(group.taskId)?.description ?? '点击「明细」查看具体项目' }}
                </div>
                <div class="group-bar">
                  <span :style="{ width: `${Math.max(2, (group.bytes / maxGroupBytes) * 100)}%` }" />
                </div>
              </div>
              <div class="group-stats">
                <div class="group-size">{{ formatBytes(group.bytes) }}</div>
                <div class="cc-faint">{{ group.count }} 项</div>
              </div>
              <div class="group-actions">
                <button class="mini-btn" @click="toggleExpanded(group.taskId)">
                  {{ expanded.has(group.taskId) ? '收起' : `说明 / 样例（${group.samples.length}）` }}
                </button>
                <button class="mini-btn" @click="showTaskItems(group.taskId)">明细 →</button>
              </div>

              <div v-if="expanded.has(group.taskId)" class="group-samples">
                <div v-for="sample in group.samples" :key="sample.id" class="sample-row">
                  <div class="sample-main">
                    <div class="sample-title">
                      {{ sample.title }}
                      <span class="cc-pill" :class="`risk-${sample.risk}`">{{ RISK_META[sample.risk].name }}</span>
                    </div>
                    <div class="cc-path" :title="sample.path">{{ sample.path }}</div>
                    <div v-if="sample.note" class="sample-note">说明：{{ sample.note }}</div>
                  </div>
                  <div class="sample-size">{{ formatBytes(sample.size) }}</div>
                  <div class="sample-actions">
                    <button class="link" @click="openDetail(sample)">详情</button>
                    <button class="link" @click="openPath(sample.path)">打开位置</button>
                  </div>
                </div>
                <div v-if="group.count > group.samples.length" class="sample-more">
                  还有 {{ group.count - group.samples.length }} 项，点「明细 →」查看全部（按大小排序）
                </div>
              </div>
            </div>
          </div>

          <div v-if="!categoryGroups.length" class="cc-empty">
            当前筛选没有匹配项。
            <el-button v-if="filtersActive" size="small" text @click="resetFilters">重置筛选</el-button>
          </div>
        </div>

        <!-- 逐项明细 -->
        <div v-else-if="view === 'items'" class="item-list">
          <div class="bulk-bar">
            <el-checkbox
              :model-value="pagedState === 'all'"
              :indeterminate="pagedState === 'partial'"
              @change="(value: any) => selectPaged(!!value)"
            >
              本页全选
            </el-checkbox>
            <span class="cc-faint">本页 {{ paged.length }} 项</span>
            <span class="cc-faint">已选 {{ selected.size }} 项 · {{ formatBytes(selectedBytes) }}</span>
            <span class="filter-spacer" />
            <span class="cc-faint">按当前排序，共 {{ filtered.length.toLocaleString('zh-CN') }} 项</span>
          </div>

          <el-table
            :data="paged"
            size="small"
            :row-key="(row: CleanItem) => row.id"
            @row-click="(row: CleanItem) => toggleItem(row, !selected.has(row.id))"
            style="width: 100%"
            :empty-text="'没有匹配的清理项'"
          >
            <el-table-column width="46">
              <template #default="{ row }">
                <el-checkbox
                  :model-value="selected.has(row.id)"
                  :disabled="row.protected"
                  @click.stop
                  @change="(value: any) => toggleItem(row, !!value)"
                />
              </template>
            </el-table-column>
            <el-table-column label="名称 / 说明" min-width="320">
              <template #default="{ row }">
                <div class="item-row" :data-item-id="row.id">
                  <div class="item-title">{{ row.title }}</div>
                  <div v-if="row.note" class="item-note">{{ row.note }}</div>
                  <div class="cc-path" :title="row.path">{{ row.path }}</div>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="任务" width="130">
              <template #default="{ row }">
                <span class="cc-faint">{{ taskName(row.taskId) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="大小" width="92" align="right">
              <template #default="{ row }">
                <span class="cc-mono">{{ row.size ? formatBytes(row.size) : '—' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="修改时间" width="132">
              <template #default="{ row }">
                <span class="cc-faint">{{ row.mtimeMs ? formatTime(row.mtimeMs) : '—' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="风险" width="82">
              <template #default="{ row }">
                <span class="cc-pill" :class="`risk-${row.risk}`">{{ RISK_META[row.risk as RiskLevel].name }}</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="132">
              <template #default="{ row }">
                <button class="link item-detail-btn" @click.stop="openDetail(row)">详情</button>
                <button
                  v-if="row.kind === 'file' || row.kind === 'directory' || row.kind === 'entry'"
                  class="link"
                  @click.stop="openPath(row.path)"
                >
                  打开位置
                </button>
              </template>
            </el-table-column>
          </el-table>

          <div class="pager">
            <el-pagination
              v-model:current-page="page"
              v-model:page-size="pageSize"
              :page-sizes="[100, 200, 500]"
              :total="filtered.length"
              layout="total, sizes, prev, pager, next, jumper"
              background
              size="small"
            />
          </div>
        </div>

        <!-- 受保护项 -->
        <div v-else class="protected-list">
          <div class="protected-tip">
            🛡️ 这些项目命中路径策略的保护名单（系统关键目录 / 用户重要目录），CordClean 不会删除，也不会出现在可清理列表里。
          </div>
          <div v-for="item in protectedFiltered" :key="item.id" class="protected-row">
            <div class="protected-main">
              <div class="sample-title">
                {{ item.title }}
                <span class="cc-pill" :class="`risk-${item.risk}`">{{ RISK_META[item.risk].name }}</span>
                <span class="protected-tag">受保护</span>
              </div>
              <div class="cc-path" :title="item.path">{{ item.path }}</div>
              <div v-if="item.note" class="sample-note">{{ item.note }}</div>
            </div>
            <div class="sample-size">{{ item.size ? formatBytes(item.size) : '—' }}</div>
            <div class="sample-actions">
              <button class="link" @click="openDetail(item)">详情</button>
              <button class="link" @click="openPath(item.path)">打开位置</button>
            </div>
          </div>
          <div v-if="!protectedItems.length" class="cc-empty">本次扫描没有受保护项。</div>
          <div v-else-if="!protectedFiltered.length" class="cc-empty">
            没有匹配「{{ search }}」的受保护项。
            <el-button size="small" text @click="search = ''">清除搜索</el-button>
          </div>
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
    <div v-if="scan" class="footer-bar">
      <div class="footer-info">
        <span class="selected-count">已选 <b>{{ selected.size }}</b> 项 · <b>{{ formatBytes(selectedBytes) }}</b></span>
        <span v-if="selectedCaution" class="cc-pill risk-caution">{{ selectedCaution }} 项谨慎</span>
        <span v-if="selectedRisky" class="cc-pill risk-risky">{{ selectedRisky }} 项高风险 · 将隔离</span>
        <span v-if="summary.byTask.length" class="cc-faint">涉及 {{ summary.byTask.length }} 个任务</span>
      </div>
      <div class="cc-actions">
        <el-dropdown trigger="click" @command="handleBulkCommand">
          <el-button size="small">批量选择 ▾</el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="recommend">应用推荐（智能勾选）</el-dropdown-item>
              <el-dropdown-item command="safe">只选安全项</el-dropdown-item>
              <el-dropdown-item command="large">选 ≥ 100 MB 的内容</el-dropdown-item>
              <el-dropdown-item command="filtered" divided>选中当前筛选结果</el-dropdown-item>
              <el-dropdown-item command="invert">反选当前筛选结果</el-dropdown-item>
              <el-dropdown-item command="clear">清空选择</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-button v-if="cleaning" @click="cancelClean">取消清理</el-button>
        <el-button size="large" :disabled="!selected.size || cleaning || scanning" @click="askMove">移动到…</el-button>
        <el-button type="primary" size="large" :loading="cleaning" :disabled="!selected.size || scanning || cleaning" @click="askClean">
          {{ dryRun ? '预演清理' : '开始清理' }}
        </el-button>
      </div>
    </div>

    <!-- 详情抽屉 -->
    <el-drawer v-model="detailVisible" title="清理项详情" size="440px" @closed="detail = null">
      <div v-if="detail" class="detail-drawer">
        <div class="detail-head">
          <div class="detail-title">{{ detail.title }}</div>
          <span class="cc-pill" :class="`risk-${detail.risk}`">{{ RISK_META[detail.risk].name }}</span>
        </div>
        <div class="cc-path detail-path">{{ detail.path }}</div>

        <el-descriptions :column="1" border size="small" class="detail-desc">
          <el-descriptions-item label="类型">{{ KIND_LABELS[detail.kind] ?? detail.kind }}</el-descriptions-item>
          <el-descriptions-item label="大小">{{ detail.size ? formatBytes(detail.size) : '—' }}</el-descriptions-item>
          <el-descriptions-item label="修改时间">{{ detail.mtimeMs ? formatTime(detail.mtimeMs) : '—' }}</el-descriptions-item>
          <el-descriptions-item label="所属任务">{{ taskName(detail.taskId) }}</el-descriptions-item>
          <el-descriptions-item label="分类">{{ CATEGORIES[detail.category]?.name ?? detail.category }}</el-descriptions-item>
        </el-descriptions>

        <div v-if="detail.note" class="detail-block">
          <div class="detail-block-title">说明</div>
          <p>{{ detail.note }}</p>
        </div>

        <div class="detail-block" :class="detail.protected ? 'detail-safety protected' : `detail-safety risk-${detail.risk}`">
          <div class="detail-block-title">{{ detail.protected ? '受保护原因' : '安全说明' }}</div>
          <p>{{ detailRiskText }}</p>
        </div>

        <div v-if="detailMeta.length" class="detail-block">
          <div class="detail-block-title">附加信息</div>
          <div v-for="entry in detailMeta" :key="entry.label" class="meta-row">
            <span class="cc-faint">{{ entry.label }}</span>
            <span class="meta-value">{{ entry.value }}</span>
          </div>
        </div>

        <div class="detail-actions">
          <el-button size="small" @click="openPath(detail.path)">打开位置</el-button>
          <el-button v-if="!detail.protected" size="small" type="primary" @click="toggleDetailSelection">
            {{ detailSelected(detail) ? '取消选择' : '选中此项' }}
          </el-button>
          <span v-if="detail.protected" class="cc-faint">受保护项不可清理</span>
        </div>
      </div>
    </el-drawer>

    <!-- 清理确认 -->
    <el-dialog v-model="showConfirm" title="确认清理" width="520px">
      <div class="confirm-dialog">
        <p>
          即将{{ dryRun ? '预演' : '' }}清理 <b>{{ selected.size }}</b> 项，合计 <b>{{ formatBytes(selectedBytes) }}</b>。
        </p>
        <div class="confirm-risk">
          <span v-if="summary.byRisk.safe.count" class="cc-pill risk-safe">安全 {{ summary.byRisk.safe.count }}</span>
          <span v-if="summary.byRisk.caution.count" class="cc-pill risk-caution">谨慎 {{ summary.byRisk.caution.count }}</span>
          <span v-if="summary.byRisk.risky.count" class="cc-pill risk-risky">高风险 {{ summary.byRisk.risky.count }}</span>
        </div>
        <div v-if="summary.byTask.length" class="confirm-tasks">
          <div v-for="task in summary.byTask.slice(0, 8)" :key="task.taskId" class="confirm-task-row">
            <span>{{ task.name }}</span>
            <span class="cc-faint">{{ task.count }} 项 · {{ formatBytes(task.bytes) }}</span>
          </div>
          <div v-if="summary.byTask.length > 8" class="cc-faint">还有 {{ summary.byTask.length - 8 }} 个任务未列出</div>
        </div>
        <p v-if="summary.byRisk.risky.count" class="warn-text">
          其中 {{ summary.byRisk.risky.count }} 项为高风险项，将先放入隔离区，可随时恢复。
        </p>
        <p class="cc-faint">所有删除都会经过路径策略校验与删除前复核，系统关键目录与用户重要目录不会被动到。</p>
      </div>
      <template #footer>
        <el-button @click="showConfirm = false">取消</el-button>
        <el-button type="primary" @click="confirmClean">{{ dryRun ? '开始预演' : '确认清理' }}</el-button>
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
  background: var(--cc-bg-soft);
  display: flex;
  flex-direction: column;
  gap: 12px;
  transition: border-color 0.16s ease, box-shadow 0.16s ease;
}

.task-card:hover {
  border-color: var(--cc-primary);
  box-shadow: 0 6px 18px rgba(15, 23, 42, 0.06);
}

.task-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.task-icon {
  width: 22px;
  text-align: center;
  font-size: 17px;
  line-height: 1;
  flex: 0 0 auto;
}

.task-title {
  flex: 1;
  min-width: 0;
}

.task-name {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
  flex-wrap: wrap;
  font-size: 12px;
  margin-top: auto;
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
  padding: 0;
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

/* ---------- 无结果引导 ---------- */
.empty-guide h3 {
  margin: 0 0 12px;
  font-size: 15px;
}

.guide-steps {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}

.guide-step {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 14px;
  border: 1px dashed var(--cc-border-strong);
  border-radius: 12px;
  background: var(--cc-bg-soft);
}

.guide-step p {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--cc-text-faint);
  line-height: 1.6;
}

.step-no {
  width: 22px;
  height: 22px;
  flex: 0 0 auto;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--cc-primary-soft);
  color: var(--cc-primary);
  font-size: 12px;
  font-weight: 600;
}

/* ---------- 推荐横幅 ---------- */
.recommend-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  flex-wrap: wrap;
  border-color: rgba(47, 107, 255, 0.28);
  background:
    linear-gradient(90deg, rgba(47, 107, 255, 0.10), rgba(41, 193, 150, 0.08)),
    var(--cc-panel);
}

.banner-main {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  min-width: 320px;
  flex: 1;
}

.banner-icon {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  background: var(--cc-primary-soft);
  font-size: 17px;
  flex: 0 0 auto;
}

.banner-text p {
  margin: 4px 0 0;
  font-size: 12.5px;
  color: var(--cc-text-dim);
  line-height: 1.7;
}

.policy-stale {
  color: var(--cc-warning) !important;
  font-size: 12px !important;
}

.banner-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.policy-field {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--cc-text-dim);
}

/* ---------- 结果面板 ---------- */
.result-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.result-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}

.view-tabs {
  display: flex;
  gap: 6px;
  background: var(--cc-hover-bg);
  padding: 3px;
  border-radius: 10px;
}

.view-tab {
  border: none;
  background: transparent;
  color: var(--cc-text-dim);
  font-size: 13px;
  padding: 7px 14px;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.view-tab.active {
  background: var(--cc-panel-solid);
  color: var(--cc-primary);
  font-weight: 600;
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.08);
}

.result-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.risk-filters {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding-top: 2px;
}

.risk-filter {
  border: 1px solid var(--cc-border);
  background: var(--cc-bg-soft);
  color: var(--cc-text-dim);
  font-size: 12px;
  padding: 4px 11px;
  border-radius: 999px;
  cursor: pointer;
}

.risk-filter:hover {
  border-color: var(--cc-primary);
  color: var(--cc-primary);
}

.risk-filter.active {
  border-color: var(--cc-primary);
  color: var(--cc-primary);
  background: var(--cc-primary-soft);
  font-weight: 600;
}

.filter-sep {
  width: 1px;
  height: 16px;
  background: var(--cc-border);
  margin: 0 4px;
}

.filter-spacer {
  flex: 1;
}

.bulk-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 2px 2px 10px;
}

/* ---------- 分组总览 ---------- */
.group-list {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.category-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.category-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.category-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.group-row {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr) 110px 120px;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--cc-border);
  border-radius: 12px;
  background: var(--cc-bg-soft);
  transition: border-color 0.15s ease;
}

.group-row:hover {
  border-color: var(--cc-border-strong);
}

.group-main {
  min-width: 0;
}

.group-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13.5px;
}

.group-desc {
  margin-top: 3px;
  font-size: 11.5px;
  color: var(--cc-text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group-bar {
  margin-top: 7px;
  height: 5px;
  border-radius: 999px;
  background: var(--cc-border);
  overflow: hidden;
}

.group-bar > span {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #4f8cff, #29c196);
  transition: width 0.3s ease;
}

.group-stats {
  text-align: right;
}

.group-size {
  font-size: 15px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}

.group-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}

.group-actions .mini-btn {
  margin-left: 0;
}

.recommend-tag {
  font-size: 11px;
  color: var(--cc-success);
  border: 1px solid rgba(41, 193, 150, 0.35);
  background: rgba(41, 193, 150, 0.1);
  padding: 1px 8px;
  border-radius: 999px;
}

.protected-tag {
  font-size: 11px;
  color: var(--cc-text-faint);
  border: 1px dashed var(--cc-border-strong);
  padding: 1px 8px;
  border-radius: 999px;
}

.group-samples {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--cc-hover-bg);
}

.sample-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 90px 132px;
  align-items: center;
  gap: 12px;
  padding: 6px 4px;
  border-bottom: 1px dashed var(--cc-border);
}

.sample-row:last-of-type {
  border-bottom: none;
}

.sample-main {
  min-width: 0;
}

.sample-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  font-weight: 500;
}

.sample-note {
  margin-top: 2px;
  font-size: 11.5px;
  color: var(--cc-text-faint);
  line-height: 1.5;
}

.sample-size {
  text-align: right;
  font-family: 'Cascadia Code', 'JetBrains Mono', Consolas, monospace;
  font-size: 12px;
}

.sample-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.sample-more {
  padding: 4px;
  font-size: 11.5px;
  color: var(--cc-text-faint);
}

/* ---------- 明细 ---------- */
.item-list .el-table :deep(.cell) {
  overflow: visible;
}

.item-row {
  cursor: pointer;
  padding: 2px 0;
}

.item-title {
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item-note {
  font-size: 11.5px;
  color: var(--cc-text-dim);
  margin: 2px 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pager {
  display: flex;
  justify-content: flex-end;
  padding-top: 12px;
}

/* ---------- 受保护 ---------- */
.protected-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.protected-tip {
  font-size: 12.5px;
  color: var(--cc-text-dim);
  background: var(--cc-hover-bg);
  border-radius: 10px;
  padding: 10px 12px;
  line-height: 1.6;
}

.protected-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 90px 132px;
  align-items: center;
  gap: 12px;
  padding: 9px 12px;
  border: 1px solid var(--cc-border);
  border-radius: 10px;
  background: var(--cc-bg-soft);
}

.protected-main {
  min-width: 0;
}

/* ---------- 底部栏 ---------- */
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
  z-index: 10;
}

.footer-info {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--cc-text-dim);
  flex-wrap: wrap;
}

.footer-info b {
  color: var(--cc-text);
}

/* ---------- 详情抽屉 ---------- */
.detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.detail-title {
  font-size: 16px;
  font-weight: 650;
  word-break: break-all;
}

.detail-path {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--cc-hover-bg);
  white-space: normal;
  word-break: break-all;
}

.detail-desc {
  margin-top: 16px;
}

.detail-block {
  margin-top: 16px;
}

.detail-block-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--cc-text-dim);
  margin-bottom: 6px;
}

.detail-block p {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--cc-text-dim);
}

.detail-safety {
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--cc-border);
  background: var(--cc-hover-bg);
}

.detail-safety.risk-safe {
  border-color: rgba(41, 193, 150, 0.35);
  background: rgba(41, 193, 150, 0.08);
}

.detail-safety.risk-caution {
  border-color: rgba(255, 159, 67, 0.4);
  background: rgba(255, 159, 67, 0.08);
}

.detail-safety.risk-risky {
  border-color: rgba(240, 80, 110, 0.4);
  background: rgba(240, 80, 110, 0.08);
}

.detail-safety.protected {
  border-color: var(--cc-border-strong);
}

.meta-row {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  padding: 5px 0;
  border-bottom: 1px dashed var(--cc-border);
  font-size: 12.5px;
}

.meta-value {
  text-align: right;
  word-break: break-all;
}

.detail-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 20px;
}

/* ---------- 确认框 ---------- */
.confirm-risk {
  display: flex;
  gap: 8px;
  margin: 10px 0;
}

.confirm-tasks {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 200px;
  overflow: auto;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--cc-hover-bg);
}

.confirm-task-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12.5px;
  padding: 3px 0;
}

/* ---------- 通用 ---------- */
.link {
  background: transparent;
  border: none;
  color: var(--cc-primary);
  font-size: 12px;
  cursor: pointer;
  padding: 0;
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

@media (max-width: 1100px) {
  .guide-steps {
    grid-template-columns: 1fr;
  }

  .group-row {
    grid-template-columns: 26px minmax(0, 1fr) 100px;
  }

  .group-actions {
    grid-column: 2 / -1;
    justify-content: flex-start;
  }

  .sample-row,
  .protected-row {
    grid-template-columns: minmax(0, 1fr) 90px;
  }

  .sample-actions {
    grid-column: 1 / -1;
    justify-content: flex-start;
  }
}
</style>
