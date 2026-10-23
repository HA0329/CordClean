<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type { UiContributionEntry, UiStatusItemContribution } from '@cordclean/shared'
import { fetchUiContributions, resolvePluginUi, state } from '../api/store.ts'

interface StatusView {
  pluginId: string
  pluginName: string
  item: UiStatusItemContribution
}

const entries = ref<UiContributionEntry[]>([])
const values = reactive<Record<string, string>>({})
let timer: ReturnType<typeof setInterval> | null = null

const items = computed<StatusView[]>(() =>
  entries.value.flatMap((entry) =>
    (entry.contributions.statusItems ?? []).map((item) => ({
      pluginId: entry.pluginId,
      pluginName: entry.pluginName,
      item,
    })),
  ),
)

function keyOf(view: StatusView): string {
  return `${view.pluginId}:${view.item.id}`
}

function labelOf(view: StatusView): string {
  // 兼容旧 AI 工坊产物把 label 写成 title 的情况
  return view.item.label ?? (view.item as unknown as { title?: string }).title ?? '状态'
}

function asText(value: unknown): string {
  if (value === undefined || value === null) return '—'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
    if (typeof record.value === 'string' || typeof record.value === 'number') return String(record.value)
  }
  return '—'
}

async function refresh(): Promise<void> {
  for (const view of items.value) {
    try {
      const value = await resolvePluginUi(view.pluginId, view.item.resolve ?? view.item.id)
      values[keyOf(view)] = asText(value)
    } catch {
      values[keyOf(view)] = '—'
    }
  }
}

async function load(): Promise<void> {
  try {
    entries.value = await fetchUiContributions()
    await refresh()
  } catch {
    entries.value = []
  }
}

watch(
  () => state.pluginEventSeq,
  () => void refresh(),
)
watch(
  () => state.plugins.map((plugin: any) => `${plugin.id}:${plugin.enabled}`).join('|'),
  () => void load(),
)

onMounted(() => {
  void load()
  timer = setInterval(() => void refresh(), 10_000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <span v-for="view in items" :key="keyOf(view)" class="cc-pill plugin-status" :class="`tone-${view.item.tone ?? 'neutral'}`">
    {{ labelOf(view) }}
    <b>{{ values[keyOf(view)] ?? '…' }}</b>
  </span>
</template>

<style scoped>
.plugin-status b {
  margin-left: 4px;
  font-weight: 600;
}

.tone-success {
  color: var(--cc-success, #22a06b);
}

.tone-warning {
  color: var(--cc-warning, #d97706);
}

.tone-danger {
  color: var(--cc-danger, #dc2626);
}
</style>
