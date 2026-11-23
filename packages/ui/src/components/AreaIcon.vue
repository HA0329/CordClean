<script setup lang="ts">
/**
 * 功能区域图标：内联 SVG（currentColor），不依赖字体/图片，缩放不糊。
 * 图标名由 `navigation.ts` 的 AreaIcon 类型约束，新增区域时这里补一个分支即可。
 */
import type { AreaIcon } from '../navigation.ts'

withDefaults(defineProps<{ name: AreaIcon; size?: number }>(), { size: 18 })
</script>

<template>
  <svg
    class="area-icon"
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
    <template v-if="name === 'home'">
      <path d="M4 11.2 12 4l8 7.2" />
      <path d="M6.5 9.8V20h11V9.8" />
      <path d="M10 20v-5h4v5" />
    </template>
    <template v-else-if="name === 'broom'">
      <path d="M14.5 3 8 13" />
      <path d="M5.6 13h7.2l2.6 8H3l2.6-8Z" />
      <path d="M8.5 16.4h4.2" />
    </template>
    <template v-else-if="name === 'puzzle'">
      <path d="M9 4.5h3.5a1.5 1.5 0 0 1 0 3H14a1.5 1.5 0 0 1 0 3h1.2v3.4a1.5 1.5 0 0 1-3 0V15H9.8a1.5 1.5 0 0 1 0 3H6.4V6a1.5 1.5 0 0 1 1.5-1.5H9Z" />
    </template>
    <template v-else-if="name === 'flask'">
      <path d="M9 3h6" />
      <path d="M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6A2 2 0 0 0 19 18l-5-9V3" />
      <path d="M7.5 15h9" />
    </template>
    <template v-else-if="name === 'sparkles'">
      <path d="M12 3l1.7 4.6L18.5 9l-4.8 1.4L12 15l-1.7-4.6L5.5 9l4.8-1.4L12 3Z" />
      <path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2Z" />
    </template>
    <template v-else-if="name === 'clock'">
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 7.6V12l3.1 1.9" />
    </template>
    <template v-else-if="name === 'scan'">
      <path d="M4 8.5V6a2 2 0 0 1 2-2h2.5" />
      <path d="M15.5 4H18a2 2 0 0 1 2 2v2.5" />
      <path d="M20 15.5V18a2 2 0 0 1-2 2h-2.5" />
      <path d="M8.5 20H6a2 2 0 0 1-2-2v-2.5" />
      <path d="M5.5 12h13" />
    </template>
    <template v-else>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.6v3M12 18.4v3M2.6 12h3M18.4 12h3M5.1 5.1l2.1 2.1M16.8 16.8l2.1 2.1M18.9 5.1l-2.1 2.1M7.2 16.8l-2.1 2.1" />
    </template>
  </svg>
</template>

<style scoped>
.area-icon {
  display: block;
  flex: 0 0 auto;
}
</style>
