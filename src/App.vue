<template>
  <MainLayout>
    <router-view />
  </MainLayout>
</template>

<script setup lang="ts">
import { watch } from 'vue'
import { storeToRefs } from 'pinia'
import MainLayout from './components/layouts/MainLayout.vue'
import { useTodoStore } from './stores/todo'

const todoStore = useTodoStore()
const { todos } = storeToRefs(todoStore)

// 桌面状态栏图标（macOS 菜单栏 / Windows 托盘）的「今日未完成」计数：
// 任务列表任何变化都推给主进程刷新菜单；web / 移动端没有 electronAPI，静默跳过
function todayLocalStr() {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

watch(todos, (list) => {
  const api = (window as any).electronAPI
  if (!api?.setTrayCount) return
  const today = todayLocalStr()
  const n = list.filter(t =>
    !t.completed && t.kind !== 'NOTE' &&
    t.dueDate && t.dueDate.slice(0, 10) === today,
  ).length
  api.setTrayCount(n)
}, { immediate: true })
</script>
