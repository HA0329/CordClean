<script setup lang="ts">
/**
 * 页面卡片标题图标：内联 SVG（currentColor），与侧边栏 AreaIcon 同一视觉规范。
 * 图标数据在 `section-icons.ts`，新增图标只需加一条 path。
 */
import { SECTION_ICON_PATHS, type SectionIconName } from './section-icons.ts'

withDefaults(defineProps<{ name: SectionIconName; size?: number }>(), { size: 17 })
</script>

<template>
  <svg
    class="section-icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.9"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path v-for="(d, index) in SECTION_ICON_PATHS[name]" :key="index" :d="d" />
  </svg>
</template>

<style scoped>
.section-icon {
  flex: 0 0 auto;
  vertical-align: -3px;
  margin-right: 6px;
  color: var(--cc-primary);
}
</style>
