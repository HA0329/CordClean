<script setup lang="ts">
defineProps<{
  /** scan=正在扫描；select=扫描结果/选择清理项；clean=正在清理 */
  active: 'scan' | 'select' | 'clean'
}>()
</script>

<template>
  <div class="workflow-steps" aria-label="清理流程">
    <span class="step" :class="{ active: active === 'scan', done: active !== 'scan' }">
      <b>1</b> 扫描
    </span>
    <i class="arrow">→</i>
    <span class="step" :class="{ active: active === 'select', done: active === 'clean' }">
      <b>2</b> 选择
    </span>
    <i class="arrow">→</i>
    <span class="step" :class="{ active: active === 'clean' }">
      <b>3</b> 清理
    </span>
  </div>
</template>

<style scoped>
.workflow-steps {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
  color: var(--cc-text-faint);
  font-size: 13px;
}

.step {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--cc-border);
  border-radius: 999px;
  background: var(--cc-panel-solid);
}

.step b {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--cc-hover-bg);
  font-size: 11px;
}

.step.active {
  color: var(--cc-primary);
  border-color: var(--cc-primary);
}

.step.active b {
  color: #fff;
  background: var(--cc-primary);
}

.step.done {
  color: var(--cc-success, #2e9b62);
  border-color: var(--cc-success, #2e9b62);
}

.arrow {
  font-style: normal;
  opacity: 0.5;
}
</style>
