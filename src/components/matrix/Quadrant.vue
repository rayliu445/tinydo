<template>
  <div
    class="rounded-xl p-3 min-h-[180px] flex flex-col transition-all duration-200"
    :style="{
      border: isDragOver ? `2px dashed var(--text-secondary)` : `2px solid var(--border-color)`,
      backgroundColor: isDragOver ? 'var(--bg-hover)' : 'var(--bg-card)',
      boxShadow: isDragOver ? 'var(--shadow-md)' : 'var(--shadow-sm)',
    }"
    @dragover.prevent="onDragOver"
    @dragenter.prevent="onDragEnter"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- 象限标题 -->
    <div
      class="flex items-center justify-between mb-2 pb-2"
      :style="{ borderBottom: '1px solid var(--border-color)' }"
    >
      <div>
        <h3 class="font-semibold text-sm" :style="{ color: 'var(--text-primary)' }">{{ label.title }}</h3>
        <p class="text-xs" :style="{ color: 'var(--text-tertiary)' }">{{ label.subtitle }}</p>
      </div>
      <span
        class="text-xs font-medium px-2 py-0.5 rounded-full"
        :style="{ backgroundColor: 'var(--bg-hover)', color: 'var(--text-secondary)' }"
      >{{ todos.length }}</span>
    </div>

    <!-- 任务列表 -->
    <div class="flex-1 flex flex-col gap-1 overflow-y-auto">
      <div
        v-for="todo in todos"
        :key="todo.id"
        class="group flex items-center gap-2 px-2 py-1.5 rounded-lg transition-all duration-150 cursor-grab active:cursor-grabbing"
        :class="{ 'opacity-50': draggingId === todo.id }"
        :style="{
          backgroundColor: 'var(--bg-app)',
        }"
        draggable="true"
        @dragstart="onDragStart($event, todo.id)"
        @dragend="onDragEnd"
      >
        <input
          type="checkbox"
          :checked="todo.completed"
          class="checkbox-tick"
          style="width: 14px; height: 14px;"
          :style="{ '--prio-border': prioBorderColor(todo.priority) }"
          @change="handleToggle(todo.id)"
        />
        <span
          class="priority-dot"
          :class="{
            high: todo.priority === 5,
            medium: todo.priority === 3,
            low: todo.priority === 1,
            none: !todo.priority || todo.priority === 0,
          }"
          style="width: 6px; height: 6px;"
        />
        <span class="text-sm flex-1 truncate" :style="{ color: 'var(--text-primary)' }">{{ todo.title }}</span>
        <span v-if="todo.dueDate" class="text-xs flex-shrink-0" :style="{ color: 'var(--text-tertiary)' }">
          {{ formatDate(todo.dueDate) }}
        </span>
        <button
          class="opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded text-xs transition-all duration-150 hover:scale-110"
          :style="{ color: 'var(--text-tertiary)' }"
          @click="handleDelete(todo.id)"
        >
          ✕
        </button>
      </div>
      <div
        v-if="todos.length === 0"
        class="flex-1 flex items-center justify-center text-sm"
        :style="{ color: 'var(--text-tertiary)' }"
      >
        拖拽任务到此处
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { Todo } from '../../stores/todo'
import type { QuadrantId } from '../../stores/matrix'
import { prioBorderColor } from '../../services/priority-style'

const props = defineProps<{
  quadrantId: QuadrantId
  label: { title: string; subtitle: string; color: string }
  todos: Todo[]
  borderColor: string
  bgColor: string
}>()

const emit = defineEmits<{
  (e: 'drop', todoId: string, quadrantId: QuadrantId): void
  (e: 'toggle', todoId: string): void
  (e: 'delete', todoId: string): void
}>()

// 拖拽悬停状态（视觉反馈）
const isDragOver = ref(false)
let dragEnterCount = 0

// 当前正在拖拽的任务 ID（用于半透明效果）
const draggingId = ref<string | null>(null)

function formatDate(dateStr: string) {
  const d = new Date(dateStr)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

const DRAG_DATA_KEY = 'application/todo-id'

function onDragStart(event: DragEvent, todoId: string) {
  if (!event.dataTransfer) return
  draggingId.value = todoId
  event.dataTransfer.setData(DRAG_DATA_KEY, todoId)
  event.dataTransfer.effectAllowed = 'move'
}

function onDragEnd() {
  draggingId.value = null
  isDragOver.value = false
  dragEnterCount = 0
}

function onDragOver(event: DragEvent) {
  if (!event.dataTransfer) return
  event.dataTransfer.dropEffect = 'move'
}

function onDragEnter() {
  dragEnterCount++
  isDragOver.value = true
}

function onDragLeave() {
  dragEnterCount--
  if (dragEnterCount <= 0) {
    dragEnterCount = 0
    isDragOver.value = false
  }
}

function onDrop(event: DragEvent) {
  isDragOver.value = false
  dragEnterCount = 0
  if (!event.dataTransfer) return
  const todoId = event.dataTransfer.getData(DRAG_DATA_KEY)
  if (!todoId) return
  emit('drop', todoId, props.quadrantId)
  event.dataTransfer.clearData()
}

function handleToggle(todoId: string) {
  emit('toggle', todoId)
}

function handleDelete(todoId: string) {
  emit('delete', todoId)
}
</script>
