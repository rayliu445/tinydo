<template>
  <!-- 清单排序方向：新的在前（默认）/ 旧的在前；对顶层与每一级子任务同时生效 -->
  <button
    class="icon-btn flex items-center gap-1.5 h-8 px-2.5 rounded-lg border transition-all duration-150"
    :style="{
      backgroundColor: 'var(--bg-app)',
      borderColor: 'var(--border-color)',
      color: 'var(--text-secondary)',
    }"
    :title="isDesc ? '排序：新的在前（点击切换为旧的在前）' : '排序：旧的在前（点击切换为新的在前）'"
    @click="toggle"
  >
    <AppIcon :name="isDesc ? 'sortDesc' : 'sortAsc'" :size="14" color="var(--text-secondary)" />
    <span class="text-xs font-medium whitespace-nowrap">{{ isDesc ? '新的在前' : '旧的在前' }}</span>
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useSettingsStore } from '../stores/settings'
import AppIcon from './icons/AppIcon.vue'

const settingsStore = useSettingsStore()

// 默认倒序（新的在前）；持久化在 settings.ui.sortOrder
const isDesc = computed(() => settingsStore.settings.ui.sortOrder !== 'asc')

function toggle() {
  settingsStore.updateUISettings({ sortOrder: isDesc.value ? 'asc' : 'desc' })
}
</script>
