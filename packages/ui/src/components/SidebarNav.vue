<script setup lang="ts">
/**
 * 左侧功能区域导航（基底组件）。
 *
 * 目标：好用、耐用、方便以后加区域。
 * - 分组 + 搜索 + 快捷键（Alt+1..N、Ctrl/Cmd+K）+ 折叠；
 * - 任何页面都能看到「扫描中 / 清理中 / 插件异常 / 隔离区待恢复」；
 * - 扫描/清理进行中时，清理组下自动出现直达实时进度页的入口；
 * - 偏好（折叠、分组展开）持久化并且容错：localStorage 损坏也不影响启动。
 *
 * 组件只负责「展示 + 交互 → emit('navigate', pageId)」，路由/hash/标题由 App.vue 处理。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { openDataDir, state } from '../api/store.ts'
import AreaIcon from './AreaIcon.vue'
import {
  NAV_STORAGE_KEYS,
  TRANSIENT_PAGES,
  activeAreaId,
  areaForShortcut,
  badgeForArea,
  filterAreas,
  groupedAreas,
  isTypingTarget,
  nextAreaId,
  parseNavPreferences,
  serializeNavPreferences,
  shortcutLabel,
  type NavBadge,
  type NavStatus,
  type PageId,
} from '../navigation.ts'

const props = defineProps<{ page: string }>()
const emit = defineEmits<{ navigate: [page: PageId] }>()

function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const preferences = ref(parseNavPreferences(readPreference(NAV_STORAGE_KEYS.collapsed), readPreference(NAV_STORAGE_KEYS.groups)))
const collapsed = computed(() => preferences.value.collapsed)

const query = ref('')
const highlighted = ref(-1)
const searchFocused = ref(false)
const searchInput = ref<HTMLInputElement>()
const navRoot = ref<HTMLElement>()

const status = computed<NavStatus>(() => ({
  scanning: state.scanning,
  cleaning: state.cleaning,
  pluginErrors: state.plugins.filter((plugin) => String((plugin as { status?: string }).status) === 'error').length,
  quarantineCount: state.quarantineStats?.count ?? 0,
  aiConfigured: Boolean(state.aiStatus?.configured),
}))

const currentArea = computed(() => activeAreaId(props.page))
const filteredAreas = computed(() => filterAreas(query.value))
const grouped = computed(() => groupedAreas(filteredAreas.value))

/** 进行中的瞬态入口：搜索时隐藏，避免干扰过滤结果 */
const transientEntries = computed(() => {
  if (query.value.trim()) return []
  const entries: Array<{ id: 'cleaning' | 'scanning'; label: string; description: string }> = []
  if (state.cleaning) entries.push({ id: 'cleaning', ...TRANSIENT_PAGES.cleaning })
  if (state.scanning) entries.push({ id: 'scanning', ...TRANSIENT_PAGES.scanning })
  return entries
})

function badgeOf(areaId: string): NavBadge | undefined {
  return badgeForArea(areaId, status.value)
}

function isGroupCollapsed(groupId: string): boolean {
  return preferences.value.groups[groupId] === false
}

function toggleGroup(groupId: string): void {
  preferences.value.groups[groupId] = isGroupCollapsed(groupId)
}

function navigate(target: PageId | string): void {
  emit('navigate', target as PageId)
  // 跳转后清空搜索，避免用户下次打开侧边栏还停留在过滤态
  query.value = ''
  highlighted.value = -1
  searchFocused.value = false
  searchInput.value?.blur()
}

function toggleCollapsed(): void {
  preferences.value.collapsed = !preferences.value.collapsed
  if (!preferences.value.collapsed) void nextTick(() => searchInput.value?.focus())
}

/** 搜索框：↓ 进结果、↑ 进结果、Enter 打开、Esc 清空 */
function onSearchKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    if (query.value) query.value = ''
    else searchInput.value?.blur()
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    const target = filteredAreas.value[highlighted.value] ?? filteredAreas.value[0]
    if (target) navigate(target.id)
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const first = navRoot.value?.querySelector<HTMLElement>('.nav-item')
    if (first) {
      event.preventDefault()
      first.focus()
    }
  }
}

/** 侧边栏内的方向键：在可见区域间移动焦点（保持 Tab 顺序简单） */
function onNavKeydown(event: KeyboardEvent): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const items = Array.from(navRoot.value?.querySelectorAll<HTMLElement>('.nav-item') ?? [])
  if (!items.length) return
  const index = items.indexOf(document.activeElement as HTMLElement)
  if (index < 0) return
  event.preventDefault()
  if (event.key === 'Home') items[0].focus()
  else if (event.key === 'End') items[items.length - 1].focus()
  else if (event.key === 'ArrowDown') items[Math.min(items.length - 1, index + 1)].focus()
  else items[Math.max(0, index - 1)].focus()
}

function onGlobalKeydown(event: KeyboardEvent): void {
  // Ctrl/Cmd+K：聚焦搜索（输入框里也允许再次聚焦搜索框）
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    if (collapsed.value) preferences.value.collapsed = false
    void nextTick(() => searchInput.value?.focus())
    return
  }
  if (isTypingTarget(event.target as { tagName?: string; isContentEditable?: boolean })) return
  const area = areaForShortcut(event)
  if (area) {
    event.preventDefault()
    navigate(area)
    return
  }
  // Alt+↑/↓：按区域顺序切换（不规则使用时也能纯键盘逛完）
  if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault()
    navigate(nextAreaId(props.page, event.key === 'ArrowDown' ? 1 : -1))
  }
}

function revealDataDir(): void {
  void openDataDir().catch((error: unknown) => {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  })
}

watch(
  preferences,
  (value) => {
    try {
      const serialized = serializeNavPreferences(value)
      localStorage.setItem(NAV_STORAGE_KEYS.collapsed, serialized.collapsed)
      localStorage.setItem(NAV_STORAGE_KEYS.groups, serialized.groups)
    } catch {
      /* 私密模式/存储被禁用：偏好不持久化但不影响使用 */
    }
  },
  { deep: true },
)

onMounted(() => window.addEventListener('keydown', onGlobalKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKeydown))
</script>

<template>
  <aside ref="navRoot" class="sidebar" :class="{ collapsed, 'is-collapsed': collapsed }" aria-label="功能区域导航">
    <div class="sidebar-inner">
      <button class="brand" type="button" title="回到概览" aria-label="回到概览" @click="navigate('overview')">
        <span class="brand-mark" aria-hidden="true">CC</span>
        <span v-if="!collapsed" class="brand-text">
          <strong>CordClean</strong>
          <span>安全清理 · 可审计</span>
        </span>
      </button>

      <div v-if="!collapsed" class="nav-search" :class="{ focused: searchFocused }">
        <AreaIcon name="scan" :size="15" class="nav-search-icon" />
        <input
          ref="searchInput"
          v-model="query"
          class="nav-search-input"
          type="search"
          placeholder="搜索功能区域"
          aria-label="搜索功能区域"
          autocomplete="off"
          spellcheck="false"
          @focus="searchFocused = true"
          @blur="searchFocused = false"
          @keydown="onSearchKeydown"
        />
        <kbd v-if="!query" class="nav-kbd">Ctrl K</kbd>
        <button v-else class="nav-search-clear" type="button" aria-label="清除搜索" @click="query = ''">×</button>
      </div>

      <nav class="nav" aria-label="功能区域" @keydown="onNavKeydown">
        <template v-for="entry in grouped" :key="entry.group.id">
          <button
            v-if="!collapsed && grouped.length > 1"
            class="nav-group-label"
            type="button"
            :aria-expanded="!isGroupCollapsed(entry.group.id)"
            @click="toggleGroup(entry.group.id)"
          >
            <span>{{ entry.group.label }}</span>
            <span class="nav-group-caret" aria-hidden="true">{{ isGroupCollapsed(entry.group.id) ? '▸' : '▾' }}</span>
          </button>
          <template v-if="collapsed || !isGroupCollapsed(entry.group.id)">
            <button
              v-for="area in entry.areas"
              :key="area.id"
              class="nav-item"
              :class="{ active: currentArea === area.id }"
              :data-area="area.id"
              :aria-current="currentArea === area.id ? 'page' : undefined"
              :aria-label="collapsed ? area.label : undefined"
              :title="area.description"
              type="button"
              @click="navigate(area.id)"
            >
              <AreaIcon :name="area.icon" />
              <span v-if="!collapsed" class="nav-label">{{ area.label }}</span>
              <span v-if="!collapsed && badgeOf(area.id)" class="nav-badge" :class="`tone-${badgeOf(area.id)?.tone}`">
                {{ badgeOf(area.id)?.text }}
              </span>
              <kbd v-if="!collapsed && shortcutLabel(area.id) && !badgeOf(area.id)" class="nav-kbd" aria-hidden="true">
                {{ shortcutLabel(area.id)?.replace('Alt+', '⌥') }}
              </kbd>
            </button>
          </template>
        </template>

        <template v-if="transientEntries.length">
          <div v-if="!collapsed" class="nav-divider" aria-hidden="true" />
          <button
            v-for="entry in transientEntries"
            :key="entry.id"
            class="nav-item nav-transient"
            :class="{ active: page === entry.id }"
            :data-area="entry.id"
            :aria-current="page === entry.id ? 'page' : undefined"
            :aria-label="collapsed ? entry.label : undefined"
            :title="entry.description"
            type="button"
            @click="navigate(entry.id)"
          >
            <span class="nav-pulse" aria-hidden="true" />
            <AreaIcon :name="entry.id === 'cleaning' ? 'broom' : 'scan'" />
            <span v-if="!collapsed" class="nav-label">{{ entry.label }}</span>
            <span v-if="!collapsed" class="nav-badge tone-warn">进行中</span>
          </button>
        </template>

        <div v-if="!collapsed && !filteredAreas.length && !transientEntries.length" class="nav-empty">
          <p>没有匹配「{{ query }}」的功能区域</p>
          <button type="button" @click="query = ''">清除搜索</button>
        </div>
      </nav>

      <div class="sidebar-footer">
        <div class="engine" :title="state.ready ? '内核已连接' : '内核未连接'">
          <span class="dot" :class="{ on: state.ready }" />
          <div v-if="!collapsed" class="engine-text">
            <div class="engine-title">Cordis 内核</div>
            <div class="engine-sub">{{ state.ready ? `${state.tasks.length} 个清理任务` : '未连接' }}</div>
          </div>
        </div>
        <button v-if="!collapsed" class="link-btn" type="button" @click="revealDataDir">打开数据目录</button>
        <div class="sidebar-bottom">
          <button
            class="sidebar-toggle"
            type="button"
            :aria-label="collapsed ? '展开侧边栏' : '折叠侧边栏'"
            :title="collapsed ? '展开侧边栏' : '折叠侧边栏'"
            @click="toggleCollapsed"
          >
            <span aria-hidden="true">{{ collapsed ? '»' : '«' }}</span>
            <span v-if="!collapsed" class="sidebar-toggle-label">收起</span>
          </button>
          <span v-if="!collapsed" class="version">v{{ state.app?.version ?? '—' }}</span>
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  --sidebar-width: 232px;
  width: var(--sidebar-width);
  flex: 0 0 var(--sidebar-width);
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--cc-border);
  background: var(--cc-sidebar-bg);
  transition: width 0.18s ease, flex-basis 0.18s ease;
  overflow: hidden;
}

.sidebar.collapsed {
  --sidebar-width: 68px;
}

.sidebar-inner {
  display: flex;
  flex-direction: column;
  gap: 14px;
  height: 100%;
  padding: 18px 12px;
  min-height: 0;
}

/* 品牌：折叠时只留标志 */
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 6px;
  border: none;
  background: transparent;
  cursor: pointer;
  text-align: left;
  border-radius: 12px;
  color: inherit;
}
.brand:hover {
  background: var(--cc-hover-bg);
}
.brand:focus-visible {
  outline: 2px solid var(--cc-primary);
  outline-offset: 2px;
}

.brand-mark {
  width: 38px;
  height: 38px;
  flex: 0 0 38px;
  border-radius: 12px;
  display: grid;
  place-items: center;
  font-weight: 700;
  letter-spacing: 0.5px;
  background: linear-gradient(135deg, #4f8cff, #29c196);
  color: #06101c;
  box-shadow: 0 6px 16px rgba(47, 107, 255, 0.28);
}

.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
  min-width: 0;
}
.brand-text strong {
  font-size: 15px;
  letter-spacing: 0.6px;
}
.brand-text span {
  font-size: 11.5px;
  color: var(--cc-text-faint);
  white-space: nowrap;
}

/* 搜索 */
.nav-search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 9px;
  border-radius: 10px;
  border: 1px solid var(--cc-border);
  background: var(--cc-panel);
  color: var(--cc-text-faint);
  transition: border-color 0.16s ease, box-shadow 0.16s ease;
}
.nav-search.focused {
  border-color: var(--cc-primary);
  box-shadow: 0 0 0 3px var(--cc-primary-soft);
}
.nav-search-icon {
  flex: 0 0 auto;
  opacity: 0.8;
}
.nav-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--cc-text);
  font-size: 12.5px;
}
.nav-search-input::placeholder {
  color: var(--cc-text-faint);
}
.nav-search-input::-webkit-search-cancel-button {
  display: none;
}
.nav-search-clear {
  border: none;
  background: transparent;
  color: var(--cc-text-faint);
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
  padding: 0 2px;
}
.nav-search-clear:hover {
  color: var(--cc-text);
}

/* 导航列表 */
.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: thin;
  padding-right: 2px;
}

.nav-group-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 10px 4px 4px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--cc-text-faint);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 1.1px;
  cursor: pointer;
  text-transform: uppercase;
}
.nav-group-label:hover {
  color: var(--cc-text-dim);
}
.nav-group-caret {
  font-size: 10px;
  opacity: 0.7;
}

.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 10px;
  border-radius: 10px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--cc-text-dim);
  font-size: 13.5px;
  cursor: pointer;
  text-align: left;
  transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease;
}
.nav-item:hover {
  background: var(--cc-hover-bg);
  color: var(--cc-text);
}
.nav-item:focus-visible {
  outline: 2px solid var(--cc-primary);
  outline-offset: 1px;
}
.nav-item.active {
  background: var(--cc-primary-soft);
  border-color: var(--cc-primary);
  color: var(--cc-primary);
  font-weight: 600;
}
.nav-item.active::before {
  content: '';
  position: absolute;
  left: -12px;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 18px;
  border-radius: 0 3px 3px 0;
  background: var(--cc-primary);
}

.nav-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nav-kbd {
  flex: 0 0 auto;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 10px;
  color: var(--cc-text-faint);
  border: 1px solid var(--cc-border);
  border-radius: 5px;
  padding: 1px 4px;
  opacity: 0.75;
}

.nav-badge {
  flex: 0 0 auto;
  font-size: 10.5px;
  line-height: 1.5;
  border-radius: 999px;
  padding: 0 7px;
  border: 1px solid transparent;
  font-weight: 600;
}
.nav-badge.tone-info {
  color: var(--cc-primary);
  background: var(--cc-primary-soft);
  border-color: color-mix(in srgb, var(--cc-primary) 35%, transparent);
}
.nav-badge.tone-warn {
  color: var(--cc-warning);
  background: color-mix(in srgb, var(--cc-warning) 14%, transparent);
  border-color: color-mix(in srgb, var(--cc-warning) 35%, transparent);
}
.nav-badge.tone-danger {
  color: var(--cc-danger);
  background: color-mix(in srgb, var(--cc-danger) 14%, transparent);
  border-color: color-mix(in srgb, var(--cc-danger) 35%, transparent);
}

.nav-divider {
  height: 1px;
  margin: 8px 4px;
  background: var(--cc-border);
}

.nav-transient .nav-pulse {
  width: 7px;
  height: 7px;
  flex: 0 0 7px;
  border-radius: 50%;
  background: var(--cc-warning);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--cc-warning) 22%, transparent);
  animation: nav-pulse 1.6s ease-in-out infinite;
}

@keyframes nav-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}

.nav-empty {
  padding: 14px 10px;
  color: var(--cc-text-faint);
  font-size: 12.5px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.nav-empty p {
  margin: 0;
}
.nav-empty button {
  align-self: flex-start;
  border: 1px solid var(--cc-border);
  background: var(--cc-panel);
  color: var(--cc-primary);
  border-radius: 8px;
  padding: 4px 10px;
  cursor: pointer;
  font-size: 12px;
}

/* 页脚 */
.sidebar-footer {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 6px 0;
  border-top: 1px solid var(--cc-border);
  margin-top: auto;
}
.engine {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: default;
}
.dot {
  width: 8px;
  height: 8px;
  flex: 0 0 8px;
  border-radius: 50%;
  background: #55617a;
}
.dot.on {
  background: var(--cc-success);
  box-shadow: 0 0 10px rgba(41, 193, 150, 0.8);
}
.engine-text {
  min-width: 0;
}
.engine-title {
  font-size: 12.5px;
}
.engine-sub {
  font-size: 11.5px;
  color: var(--cc-text-faint);
}
.link-btn {
  background: transparent;
  border: none;
  color: var(--cc-primary);
  font-size: 12px;
  cursor: pointer;
  padding: 0;
  text-align: left;
}
.link-btn:hover {
  text-decoration: underline;
}
.sidebar-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.sidebar-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--cc-border);
  background: var(--cc-panel);
  color: var(--cc-text-dim);
  border-radius: 8px;
  padding: 4px 8px;
  font-size: 12px;
  cursor: pointer;
}
.sidebar-toggle:hover {
  border-color: var(--cc-primary);
  color: var(--cc-primary);
}
.sidebar-toggle:focus-visible {
  outline: 2px solid var(--cc-primary);
  outline-offset: 1px;
}
.sidebar-toggle-label {
  font-size: 11.5px;
}
.version {
  font-size: 11px;
  color: var(--cc-text-faint);
  white-space: nowrap;
}

/* 折叠态：窄轨，图标居中，隐藏文字 */
.sidebar.collapsed .sidebar-inner {
  padding: 18px 10px;
  align-items: center;
}
.sidebar.collapsed .brand {
  padding: 4px;
}
.sidebar.collapsed .nav {
  width: 100%;
  align-items: center;
}
.sidebar.collapsed .nav-item {
  justify-content: center;
  padding: 10px 0;
  gap: 0;
}
.sidebar.collapsed .nav-item.active::before {
  left: -10px;
}
.sidebar.collapsed .sidebar-footer {
  width: 100%;
  align-items: center;
  padding-left: 0;
  padding-right: 0;
}

@media (prefers-reduced-motion: reduce) {
  .sidebar,
  .nav-item,
  .nav-search {
    transition: none;
  }
  .nav-transient .nav-pulse {
    animation: none;
  }
}
</style>
