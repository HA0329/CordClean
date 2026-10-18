<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { RISK_META, formatBytes, formatTime } from '@cordclean/shared'
import { analyzeAi, state } from '../api/store.ts'

const extra = ref('')
const running = ref(false)

const available = computed(() => state.aiStatus.available)
const configured = computed(() => state.aiStatus.configured)
const analysis = computed(() => state.ai)

async function run() {
  running.value = true
  try {
    await analyzeAi()
    ElMessage.success('AI 分析完成')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    running.value = false
  }
}
</script>

<template>
  <div class="cc-page">
    <div class="cc-page-title">
      <div>
        <h1>AI 清理顾问</h1>
        <p>把本机磁盘画像交给大模型（默认 DeepSeek），由模型给出针对性的清理建议。</p>
      </div>
      <div class="cc-actions">
        <el-button type="primary" :loading="running" :disabled="!available || !configured" @click="run">
          {{ analysis ? '重新分析' : '开始分析' }}
        </el-button>
      </div>
    </div>

    <el-alert v-if="!available" type="warning" :closable="false" show-icon>
      <template #title>AI 插件未启用</template>
      请到「插件」页面启用「AI 清理顾问」插件后返回本页。
    </el-alert>

    <el-alert v-else-if="!configured" type="info" :closable="false" show-icon>
      <template #title>尚未配置 API Key</template>
      在「插件 → AI 清理顾问 → 配置」中填写 <code>apiKey</code>（DeepSeek 平台申请）与模型名称，例如
      <code>deepseek-chat</code>。配置只保存在本机数据目录。
    </el-alert>

    <div class="cc-card" v-if="available && configured">
      <div class="cc-card-title">
        <h3>🧠 补充说明（可选）</h3>
        <span class="cc-faint">例如：这台机器主要用于视频剪辑，希望保留素材缓存</span>
      </div>
      <el-input v-model="extra" type="textarea" :rows="3" placeholder="告诉 AI 你的使用习惯，建议会更准确…" />
    </div>

    <template v-if="analysis">
      <div class="cc-card">
        <div class="cc-card-title">
          <h3>📌 分析摘要</h3>
          <span class="cc-pill">{{ analysis.model }} · {{ formatTime(analysis.createdAt) }}</span>
        </div>
        <p class="summary">{{ analysis.summary }}</p>
        <ul v-if="analysis.observations.length" class="observations">
          <li v-for="(item, index) in analysis.observations" :key="index">{{ item }}</li>
        </ul>
      </div>

      <div class="suggestions">
        <div v-for="suggestion in analysis.suggestions" :key="suggestion.id" class="suggestion-card">
          <div class="suggestion-head">
            <strong>{{ suggestion.title }}</strong>
            <span class="cc-pill" :class="`risk-${suggestion.risk}`">{{ RISK_META[suggestion.risk].name }}</span>
          </div>
          <p class="reason">{{ suggestion.reason }}</p>
          <div class="targets">
            <span v-for="target in suggestion.targets" :key="target" class="target">{{ target }}</span>
          </div>
          <div class="suggestion-foot">
            <span class="cc-faint">预估可释放 {{ formatBytes(suggestion.estimatedBytes) }}</span>
            <span class="cc-faint">置信度 {{ Math.round(suggestion.confidence * 100) }}%</span>
            <span v-if="suggestion.taskId" class="cc-pill">关联任务：{{ suggestion.taskId }}</span>
          </div>
        </div>
      </div>
    </template>

    <div v-else-if="available && configured" class="cc-card cc-empty">
      点击右上角「开始分析」，AI 会读取磁盘占用、清理任务分布与系统信息后给出建议。
    </div>

    <div class="cc-card">
      <div class="cc-card-title">
        <h3>🔒 隐私说明</h3>
      </div>
      <p class="cc-hint">
        发送给模型的内容仅包含：磁盘容量与占用、系统版本、CPU/内存、清理任务统计与关键目录体积，
        <b>不包含</b>文件名、路径、文档内容或任何个人文件信息。API Key 仅保存在本机
        <code>config.json</code> 中，不会上传到本工具以外的服务器。
      </p>
    </div>
  </div>
</template>

<style scoped>
.summary {
  margin: 0;
  line-height: 1.8;
  font-size: 13.5px;
  color: #d7deea;
}

.observations {
  margin: 12px 0 0;
  padding-left: 18px;
  color: var(--cc-text-dim);
  font-size: 12.5px;
  line-height: 1.8;
}

.suggestions {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
}

.suggestion-card {
  border: 1px solid var(--cc-border);
  border-radius: var(--cc-radius);
  background: var(--cc-panel);
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.suggestion-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.reason {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--cc-text-dim);
}

.targets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.target {
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 11px;
  background: rgba(79, 140, 255, 0.1);
  border: 1px solid rgba(79, 140, 255, 0.28);
  color: #b9cdff;
  padding: 2px 7px;
  border-radius: 6px;
  word-break: break-all;
}

.suggestion-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 11.5px;
  border-top: 1px dashed var(--cc-border);
  padding-top: 8px;
}

code {
  background: rgba(255, 255, 255, 0.08);
  padding: 1px 5px;
  border-radius: 4px;
}
</style>
