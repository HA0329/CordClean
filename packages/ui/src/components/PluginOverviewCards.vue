<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type { UiCardContribution, UiContributionEntry } from '@cordclean/shared'
import { fetchUiContributions, resolvePluginUi, state } from '../api/store.ts'

interface CardView {
  pluginId: string
  pluginName: string
  kind: string
  card: UiCardContribution
}

const entries = ref<UiContributionEntry[]>([])
const values = reactive<Record<string, unknown>>({})
const errors = reactive<Record<string, boolean>>({})
const timers = new Map<string, ReturnType<typeof setInterval>>()

const cards = computed<CardView[]>(() =>
  entries.value.flatMap((entry) =>
    (entry.contributions.overviewCards ?? []).map((card) => ({
      pluginId: entry.pluginId,
      pluginName: entry.pluginName,
      kind: entry.kind,
      card,
    })),
  ),
)

function keyOf(item: CardView): string {
  return `${item.pluginId}:${item.card.id}`
}

function resolverId(item: CardView): string {
  return item.card.resolve ?? item.card.id
}

async function refreshCard(item: CardView): Promise<void> {
  const key = keyOf(item)
  try {
    values[key] = await resolvePluginUi(item.pluginId, resolverId(item))
    errors[key] = false
  } catch {
    errors[key] = true
  }
}

function stopTimers(): void {
  for (const timer of timers.values()) clearInterval(timer)
  timers.clear()
}

function scheduleTimers(): void {
  stopTimers()
  for (const item of cards.value.slice(0, 12)) {
    const interval = Math.max(1000, Number(item.card.refreshMs ?? 5000))
    timers.set(keyOf(item), setInterval(() => void refreshCard(item), interval))
  }
}

async function reload(): Promise<void> {
  try {
    entries.value = await fetchUiContributions()
    await Promise.all(cards.value.map((item) => refreshCard(item)))
    scheduleTimers()
  } catch {
    entries.value = []
  }
}

function displayValue(item: CardView): unknown {
  const key = keyOf(item)
  return key in values ? values[key] : item.card.fallback
}

function asText(value: unknown): string {
  if (value === undefined || value === null) return '—'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
    if (typeof record.value === 'string' || typeof record.value === 'number') return String(record.value)
  }
  return '—'
}

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value && typeof value === 'object' && 'value' in value) {
    const inner = Number((value as Record<string, unknown>).value)
    if (Number.isFinite(inner)) return inner
  }
  return 0
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? item : asText(item))).slice(0, 8)
  }
  if (value && typeof value === 'object' && Array.isArray((value as any).items)) {
    return (value as any).items.map((item: unknown) => asText(item)).slice(0, 8)
  }
  return []
}

watch(
  () => state.plugins.map((plugin: any) => `${plugin.id}:${plugin.enabled}`).join('|'),
  () => void reload(),
)

onMounted(() => {
  void reload()
})
onUnmounted(() => stopTimers())
</script>

<template>
  <div v-if="cards.length" class="cc-card plugin-cards">
    <div class="cc-card-title">
      <h3>🧩 插件卡片</h3>
      <span class="cc-faint">由通用插件贡献 · {{ cards.length }} 项</span>
    </div>
    <div class="plugin-card-grid">
      <div v-for="item in cards" :key="keyOf(item)" class="plugin-metric">
        <div class="plugin-metric-head">
          <strong>{{ item.card.title }}</strong>
          <span class="cc-faint">{{ item.pluginName }}</span>
        </div>
        <p v-if="item.card.description" class="cc-faint">{{ item.card.description }}</p>

        <template v-if="item.card.type === 'metric' || item.card.type === 'progress'">
          <div class="plugin-metric-value">
            {{ asText(displayValue(item)) }}<span v-if="item.card.unit" class="plugin-unit">{{ item.card.unit }}</span>
          </div>
          <div v-if="item.card.type === 'progress'" class="cc-bar">
            <span
              :style="{
                width: `${Math.max(0, Math.min(100, item.card.max ? (asNumber(displayValue(item)) / item.card.max) * 100 : asNumber(displayValue(item))))}%`,
              }"
            />
          </div>
        </template>
        <template v-else-if="item.card.type === 'list'">
          <ul class="plugin-list">
            <li v-for="(line, index) in asList(displayValue(item))" :key="index">{{ line }}</li>
          </ul>
        </template>
        <p v-else class="plugin-text">{{ asText(displayValue(item)) }}</p>

        <div v-if="errors[keyOf(item)]" class="cc-faint">读取失败，将在下次刷新重试</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.plugin-card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 12px;
}

.plugin-metric {
  min-width: 0;
  padding: 12px 14px;
  border: 1px solid var(--cc-border);
  border-radius: var(--cc-radius);
  background: var(--cc-panel-solid);
}

.plugin-metric-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
}

.plugin-metric-value {
  margin-top: 8px;
  font-size: 22px;
  font-weight: 600;
  color: var(--cc-text);
}

.plugin-unit {
  margin-left: 4px;
  font-size: 12px;
  color: var(--cc-text-faint);
}

.plugin-text {
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 1.6;
  word-break: break-word;
}

.plugin-list {
  margin: 8px 0 0;
  padding-left: 18px;
  font-size: 12.5px;
  line-height: 1.7;
}

.plugin-metric p {
  margin: 4px 0 0;
}
</style>
