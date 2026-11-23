<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { state, init, quitApp, refreshAppInfo } from './api/store.ts'
import { formatBytes } from '@cordclean/shared'
import SidebarNav from './components/SidebarNav.vue'
import OverviewView from './views/OverviewView.vue'
import CleanView from './views/CleanView.vue'
import PluginsView from './views/PluginsView.vue'
import HistoryView from './views/HistoryView.vue'
import AiView from './views/AiView.vue'
import AiWorkshopView from './views/AiWorkshopView.vue'
import SettingsView from './views/SettingsView.vue'
import CleaningView from './views/CleaningView.vue'
import ScanningView from './views/ScanningView.vue'
import PluginStatusItems from './components/PluginStatusItems.vue'
import {
  NAV_STORAGE_KEYS,
  activeAreaId,
  initialPage,
  pageHash,
  pageTitle,
  resolvePage,
  type PageId,
} from './navigation.ts'

const views: Record<string, any> = {
  overview: OverviewView,
  clean: CleanView,
  plugins: PluginsView,
  history: HistoryView,
  ai: AiView,
  workshop: AiWorkshopView,
  settings: SettingsView,
  cleaning: CleaningView,
  scanning: ScanningView,
}

const current = computed(() => views[state.page] ?? OverviewView)

/* ------------------------------------------------------------------ */
/* 路由：hash 深链接 + 浏览器前进/后退 + 上次停留页 + 标题               */
/* ------------------------------------------------------------------ */

function readLastPage(): string | null {
  try {
    return localStorage.getItem(NAV_STORAGE_KEYS.lastPage)
  } catch {
    return null
  }
}

state.page = initialPage(location.hash, {
  scanning: state.scanning,
  cleaning: state.cleaning,
  lastPage: readLastPage(),
})

function navigate(target: PageId | string): void {
  state.page = resolvePage(target, { scanning: state.scanning, cleaning: state.cleaning })
}

function onHashChange(): void {
  const next = initialPage(location.hash, { scanning: state.scanning, cleaning: state.cleaning })
  if (next !== state.page) state.page = next
}

watch(
  () => state.page,
  (page) => {
    const hash = pageHash(page)
    if (location.hash !== hash) location.hash = hash
    document.title = `CordClean · ${pageTitle(page)}`
    try {
      // 只记稳定区：刷新后回到「清理页」而不是某个瞬态进度页也合理
      localStorage.setItem(NAV_STORAGE_KEYS.lastPage, activeAreaId(page))
    } catch {
      /* 存储不可用不影响导航 */
    }
    // 换区域时回到内容顶部，避免长页面残留滚动位置（不规则使用下的常见困惑）
    const content = document.querySelector<HTMLElement>('.content')
    if (content) content.scrollTop = 0
  },
  { immediate: true },
)

// 顶栏运行时信息：来自 app/info，不在前端硬编码
const platformText = computed(() => {
  const app = state.app
  if (!app) return '检测中…'
  return app.platformLabel ?? (app.platform === 'win32' ? 'Windows' : app.platform)
})
const platformTitle = computed(() => {
  const app = state.app
  if (!app) return ''
  return [app.osVersion, app.osRelease, app.arch].filter(Boolean).join(' · ')
})
const nodeText = computed(() => {
  const app = state.app
  if (!app) return 'Node 检测中…'
  if (app.systemNode) return `Node ${app.systemNode}（系统）`
  return `Node ${app.node}${app.nodeRuntime === 'electron' ? '（内置）' : ''}`
})
const nodeTitle = computed(() => {
  const app = state.app
  if (!app) return ''
  const runtime = app.nodeRuntime === 'electron' ? 'Electron 内置 Node' : '当前 Node 进程'
  const lines = [`应用运行时：${runtime} ${app.node}`]
  if (app.systemNode) lines.push(`系统 PATH Node：${app.systemNode}`)
  if (app.electron) lines.push(`Electron ${app.electron}`)
  return lines.join('\n')
})
const elevationTitle = computed(() => {
  const app = state.app
  if (!app) return ''
  const at = app.elevatedCheckedAt ? new Date(app.elevatedCheckedAt).toLocaleTimeString() : '启动时'
  return `Windows Mandatory Label 检测（${at}）：${app.elevated ? 'High/System 完整性' : 'Medium/未提升'}`
})
const shellText = computed(() => {
  if (state.app?.shell) return state.app.shell === 'desktop' ? '桌面外壳' : '浏览器外壳'
  return state.transport?.kind === 'electron' ? '桌面外壳' : '浏览器外壳'
})
const shellTitle = computed(() => {
  if (state.app?.shell === 'desktop' || state.transport?.kind === 'electron') {
    return `Electron ${state.app?.electron ?? ''} · IPC`.trim()
  }
  return 'HTTP + WebSocket'
})

// 主题：默认亮色，手动切换并记忆（index.html 已做首屏防闪）
type Theme = 'light' | 'dark'
const theme = ref<Theme>('light')
try {
  if (localStorage.getItem('cordclean.theme') === 'dark') theme.value = 'dark'
} catch {}
function applyTheme(value: Theme) {
  document.documentElement.classList.toggle('dark', value === 'dark')
  try {
    localStorage.setItem('cordclean.theme', value)
  } catch {}
}
watch(theme, applyTheme)
onMounted(() => applyTheme(theme.value))
function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
}

const bootError = ref<string>()
const loading = ref(true)

async function bootstrap() {
  loading.value = true
  bootError.value = undefined
  try {
    await init()
  } catch (error) {
    bootError.value = error instanceof Error ? error.message : String(error)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  window.addEventListener('hashchange', onHashChange)
  bootstrap()
  // 切回窗口时重新检查一次真实运行时信息（Node/OS/权限/外壳）
  window.addEventListener('focus', () => void refreshAppInfo().catch(() => {}))
})

async function quitCordClean() {
  try {
    await ElMessageBox.confirm('退出后后台服务/桌面进程会立即结束，正在进行的扫描或清理会被中断。', '退出 CordClean', {
      type: 'warning',
      confirmButtonText: '退出',
    })
  } catch {
    return
  }
  try {
    await quitApp()
    ElMessage.success('CordClean 已退出，可以关闭此页面')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}
</script>

<template>
  <div class="shell">
    <a class="skip-link" href="#cc-main">跳到主内容</a>

    <SidebarNav :page="state.page" @navigate="navigate" />

    <main id="cc-main" class="main" tabindex="-1">
      <header class="topbar">
        <div class="topbar-left">
          <span class="cc-pill runtime-pill" :title="platformTitle" @click="refreshAppInfo">{{ platformText }}</span>
          <span class="cc-pill runtime-pill" :class="{ 'status-active': state.app?.elevated }" :title="elevationTitle" @click="refreshAppInfo">
            {{ state.app?.elevated ? '管理员权限' : '普通用户' }}
          </span>
          <span class="cc-pill runtime-pill" :title="nodeTitle" @click="refreshAppInfo">{{ nodeText }}</span>
          <span class="cc-pill runtime-pill" :title="shellTitle" @click="refreshAppInfo">{{ shellText }}</span>
          <button v-if="state.cleaning" class="cleaning-back" title="查看实时清理进度" @click="navigate('cleaning')">
            🧹 清理中 · 查看进度
          </button>
          <button v-else-if="state.scanning" class="cleaning-back" title="查看实时扫描进度" @click="navigate('scanning')">
            🔍 扫描中 · 查看进度
          </button>
          <PluginStatusItems />
        </div>
        <div class="topbar-right">
          <span class="cc-faint" v-if="state.app">启动耗时 {{ state.app.bootMs }} ms</span>
          <span class="cc-faint">累计释放 {{ formatBytes(state.totals.freedBytes) }}</span>
          <button class="quit-btn" title="退出 CordClean" @click="quitCordClean">⏻</button>
          <button class="theme-toggle" :title="theme === 'dark' ? '切换到亮色' : '切换到暗色'" @click="toggleTheme">
            {{ theme === 'dark' ? '☀️' : '🌙' }}
          </button>
        </div>
      </header>

      <div class="content">
        <div v-if="loading" class="center-box">
          <el-progress type="circle" :percentage="100" :status="'success'" :width="72" :show-text="false" />
          <p class="cc-muted">正在连接 CordClean 内核…</p>
        </div>

        <div v-else-if="bootError" class="center-box">
          <h2>无法连接内核</h2>
          <p class="cc-muted">{{ bootError }}</p>
          <el-button type="primary" @click="bootstrap">重试</el-button>
        </div>

        <KeepAlive v-else include="AiView">
          <component :is="current" />
        </KeepAlive>
      </div>
    </main>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  height: 100%;
  min-height: 100vh;
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  outline: none;
}

.skip-link {
  position: fixed;
  top: -48px;
  left: 16px;
  z-index: 100;
  padding: 8px 14px;
  border-radius: 8px;
  background: var(--cc-primary);
  color: #fff;
  font-size: 13px;
  text-decoration: none;
  transition: top 0.16s ease;
}
.skip-link:focus {
  top: 10px;
}

.topbar {
  height: 56px;
  flex: 0 0 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 26px;
  border-bottom: 1px solid var(--cc-border);
  background: var(--cc-topbar-bg);
  backdrop-filter: blur(10px);
}

.topbar-left,
.topbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.runtime-pill {
  cursor: help;
}

.cleaning-back {
  padding: 6px 10px;
  border: 1px solid var(--cc-primary);
  border-radius: 999px;
  background: var(--cc-primary-soft);
  color: var(--cc-primary);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

.cleaning-back:hover {
  filter: brightness(0.96);
}

.content {
  flex: 1;
  overflow: auto;
  padding: 22px 26px 40px;
}

.center-box {
  height: 60vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
}
</style>
