<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { state, init, openDataDir, quitApp } from './api/store.ts'
import { formatBytes } from '@cordclean/shared'
import OverviewView from './views/OverviewView.vue'
import CleanView from './views/CleanView.vue'
import PluginsView from './views/PluginsView.vue'
import HistoryView from './views/HistoryView.vue'
import AiView from './views/AiView.vue'
import SettingsView from './views/SettingsView.vue'

const nav = [
  { id: 'overview', label: '概览', icon: '🏠' },
  { id: 'clean', label: '清理', icon: '🧹' },
  { id: 'plugins', label: '插件', icon: '🧩' },
  { id: 'history', label: '历史与隔离区', icon: '🗂️' },
  { id: 'ai', label: 'AI 建议', icon: '🤖' },
  { id: 'settings', label: '设置', icon: '⚙️' },
]

const views: Record<string, any> = {
  overview: OverviewView,
  clean: CleanView,
  plugins: PluginsView,
  history: HistoryView,
  ai: AiView,
  settings: SettingsView,
}

const current = computed(() => views[state.page] ?? OverviewView)

// 用 URL hash 同步当前页面：便于深链接、刷新保持与自动化截图
const initialPage = (location.hash || '').replace('#', '')
if (nav.some((item) => item.id === initialPage)) state.page = initialPage
watch(() => state.page, (page) => {
  if (location.hash !== '#' + page) location.hash = page
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
// 侧边栏折叠（记忆）：折叠后为 64px 图标轨道，展开/收起按钮都在侧边栏内
const collapsed = ref(false)
function applySidebar(value: boolean) {
  collapsed.value = value
  document.documentElement.classList.toggle('sidebar-collapsed', value)
  const aside = document.querySelector('.sidebar') as HTMLElement | null
  if (aside) {
    aside.style.width = value ? '64px' : ''
    aside.style.flexBasis = value ? '64px' : ''
  }
}
function toggleSidebar() {
  applySidebar(!collapsed.value)
  try {
    localStorage.setItem('cordclean.sidebar', collapsed.value ? 'collapsed' : 'expanded')
  } catch {}
}
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
  try {
    applySidebar(localStorage.getItem('cordclean.sidebar') === 'collapsed')
  } catch {}
  bootstrap()
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

async function revealDataDir() {
  try {
    await openDataDir()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  }
}
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">CC</div>
        <div class="brand-text">
          <strong>CordClean</strong>
          <span>模块化清理工具</span>
        </div>
      </div>

      <nav class="nav">
        <button
          v-for="item in nav"
          :key="item.id"
          class="nav-item"
          :class="{ active: state.page === item.id }"
          @click="state.page = item.id"
        >
          <span class="nav-icon">{{ item.icon }}</span>
          <span class="nav-label">{{ item.label }}</span>
        </button>
      </nav>

      <div class="sidebar-footer">
        <div class="engine">
          <span class="dot" :class="{ on: state.ready }" />
          <div>
            <div class="engine-title">Cordis 内核</div>
            <div class="engine-sub">
              {{ state.ready ? `${state.tasks.length} 个清理任务` : '未连接' }}
            </div>
          </div>
        </div>
        <button class="link-btn" @click="revealDataDir">打开数据目录</button>
        <button class="sidebar-toggle" @click="toggleSidebar" :title="collapsed ? '展开侧边栏' : '折叠侧边栏'">{{ collapsed ? '»' : '«' }}<span v-if="!collapsed">收起侧边栏</span></button>
        <div class="version">v{{ state.app?.version ?? '0.1.0' }}</div>
      </div>
    </aside>


    <main class="main">
      <header class="topbar">
        <div class="topbar-left">
          <span class="cc-pill">{{ state.app?.platform === 'win32' ? 'Windows' : state.app?.platform }}</span>
          <span class="cc-pill" :class="{ 'status-active': state.app?.elevated }">
            {{ state.app?.elevated ? '管理员权限' : '普通用户' }}
          </span>
          <span class="cc-pill">Node {{ state.app?.node }}</span>
          <span class="cc-pill" v-if="state.transport?.kind === 'electron'">桌面外壳</span>
          <span class="cc-pill" v-else-if="state.transport">浏览器外壳</span>
        </div>
        <div class="topbar-right">
          <span class="cc-faint" v-if="state.app">启动耗时 {{ state.app.bootMs }} ms</span>
          <span class="cc-faint">累计释放 {{ formatBytes(state.totals.freedBytes) }}</span>
          <button class="theme-toggle" title="退出 CordClean" @click="quitCordClean">⏻</button>
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

        <component :is="current" v-else />
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

.sidebar {
  width: 224px;
  flex: 0 0 224px;
  display: flex;
  flex-direction: column;
  padding: 20px 14px;
  border-right: 1px solid var(--cc-border);
  background: var(--cc-sidebar-bg);
  gap: 18px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 8px;
}

.brand-mark {
  width: 38px;
  height: 38px;
  border-radius: 12px;
  display: grid;
  place-items: center;
  font-weight: 700;
  letter-spacing: 0.5px;
  background: linear-gradient(135deg, #4f8cff, #29c196);
  color: #06101c;
}

.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}

.brand-text strong {
  font-size: 15px;
  letter-spacing: 0.6px;
}

.brand-text span {
  font-size: 11.5px;
  color: var(--cc-text-faint);
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--cc-text-dim);
  font-size: 13.5px;
  cursor: pointer;
  text-align: left;
  transition: all 0.16s ease;
}

.nav-item:hover {
  background: var(--cc-hover-bg);
  color: var(--cc-text);
}

.nav-item.active {
  background: var(--cc-primary-soft);
  border-color: var(--cc-primary);
  color: var(--cc-primary);
}

.nav-icon {
  width: 18px;
  text-align: center;
  font-size: 15px;
}

.sidebar-footer {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 8px 0;
  border-top: 1px solid var(--cc-border);
}

.engine {
  display: flex;
  align-items: center;
  gap: 10px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #55617a;
}

.dot.on {
  background: var(--cc-success);
  box-shadow: 0 0 10px rgba(41, 193, 150, 0.8);
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

.version {
  font-size: 11px;
  color: var(--cc-text-faint);
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
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

<style scoped>
/* 折叠后彻底让出空间：宽度归零，仅保留浮动展开按钮 */
.sidebar.collapsed {
  width: 0;
  flex-basis: 0;
  padding: 0;
  border-right: none;
  overflow: hidden;
}
.sidebar-open {
  position: fixed;
  top: 14px;
  left: 14px;
  z-index: 30;
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  border: 1px solid var(--cc-border-strong);
  background: var(--cc-panel-solid);
  color: var(--cc-text);
  cursor: pointer;
  box-shadow: var(--cc-shadow);
  font-size: 16px;
}
.sidebar-open:hover { border-color: var(--cc-primary); color: var(--cc-primary); }
</style>
