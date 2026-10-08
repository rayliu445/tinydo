<template>
  <div>
    <!-- 星期头 -->
    <div class="grid grid-cols-7 mb-2">
      <div
        v-for="day in weekDays"
        :key="day"
        class="text-center text-sm font-medium text-base-content/60 py-2"
        :class="{ 'text-error': day === '日' || day === '六' }"
      >
        {{ day }}
      </div>
    </div>

    <!-- 日期网格 -->
    <div class="grid grid-cols-7 border border-base-300 rounded-lg overflow-hidden">
      <div
        v-for="(cell, index) in calendarCells"
        :key="index"
        class="min-h-[100px] border-b border-r border-base-300 p-1 transition-colors cursor-pointer hover:bg-base-200"
        :class="{
          'bg-base-200/50': !cell.isCurrentMonth,
          'bg-primary/5': cell.isToday,
          'ring-2 ring-inset ring-primary bg-primary/10': dragOverDate === cell.dateStr,
        }"
        @click="$emit('add-todo', cell.dateStr)"
        @dragover.prevent="dragOverDate = cell.dateStr"
        @dragleave="clearDragOver(cell.dateStr)"
        @drop.prevent="onDrop(cell.dateStr)"
      >
        <!-- 日期 -->
        <div class="flex items-center justify-between mb-1">
          <span
            class="text-xs font-medium w-6 h-6 flex items-center justify-center rounded-full"
            :class="{
              'text-base-content/40': !cell.isCurrentMonth,
              'bg-primary text-primary-content': cell.isToday,
            }"
          >
            {{ cell.day }}
          </span>
        </div>

        <!-- 任务列表 -->
        <div class="flex flex-col gap-0.5">
          <div
            v-for="todo in cell.todos"
            :key="todo.id"
            class="text-xs px-1 py-0.5 rounded truncate flex items-center gap-1 cursor-grab active:cursor-grabbing hover:opacity-80"
            :class="[getPriorityClass(todo.priority), { 'opacity-40': draggingId === todo.id }]"
            draggable="true"
            @dragstart="onDragStart($event, todo.id)"
            @dragend="onDragEnd"
            @click.stop="$emit('toggle-todo', todo.id)"
          >
            <span :class="{ 'line-through': todo.completed }">
              {{ todo.title }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Todo } from '../../stores/todo'

const props = defineProps<{
  currentDate: Date
  todos: Todo[]
}>()

const emit = defineEmits<{
  (e: 'select-date', dateStr: string): void
  (e: 'add-todo', dateStr: string): void
  (e: 'toggle-todo', id: string): void
  (e: 'move-todo', todoId: string, dateStr: string): void
}>()

// 拖拽改期：任务条目可拖动，日期格为放置目标（桌面端 HTML5 DnD）
const draggingId = ref<string | null>(null)
const dragOverDate = ref('')

function onDragStart(e: DragEvent, todoId: string) {
  draggingId.value = todoId
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', todoId)
  }
}

function onDragEnd() {
  draggingId.value = null
  dragOverDate.value = ''
}

function clearDragOver(dateStr: string) {
  if (dragOverDate.value === dateStr) dragOverDate.value = ''
}

function onDrop(dateStr: string) {
  const todoId = draggingId.value
  onDragEnd()
  if (todoId) emit('move-todo', todoId, dateStr)
}

const weekDays = ['日', '一', '二', '三', '四', '五', '六']

function getPriorityClass(priority?: number) {
  if (!priority || priority === 0) return 'bg-base-300 text-base-content'
  switch (priority) {
    case 5: return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
    case 3: return 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300'
    case 1: return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
    default: return 'bg-base-300 text-base-content'
  }
}

const calendarCells = computed(() => {
  const year = props.currentDate.getFullYear()
  const month = props.currentDate.getMonth()
  const today = new Date()
  const todayStr = formatDateStr(today)

  // 当月第一天和最后一天
  const firstDay = new Date(year, month, 1)
  const lastDay = new Date(year, month + 1, 0)

  // 日历开始日期（上月补白）
  const startDate = new Date(firstDay)
  startDate.setDate(startDate.getDate() - startDate.getDay())

  // 日历结束日期（下月补白）
  const endDate = new Date(lastDay)
  endDate.setDate(endDate.getDate() + (6 - endDate.getDay()))

  const cells = []
  const current = new Date(startDate)

  // 构建日期 -> 任务映射
  const todoMap = new Map<string, Todo[]>()
  for (const todo of props.todos) {
    if (todo.dueDate) {
      const dateKey = todo.dueDate.slice(0, 10)
      if (!todoMap.has(dateKey)) {
        todoMap.set(dateKey, [])
      }
      todoMap.get(dateKey)!.push(todo)
    }
  }

  while (current <= endDate) {
    const dateStr = formatDateStr(current)
    const day = current.getDate()
    const isCurrentMonth = current.getMonth() === month
    const isToday = dateStr === todayStr
    const dayTodos = todoMap.get(dateStr) || []

    cells.push({
      dateStr,
      day,
      isCurrentMonth,
      isToday,
      todos: dayTodos.slice(0, 4), // 最多显示4个
      hasMore: dayTodos.length > 4,
    })

    current.setDate(current.getDate() + 1)
  }

  return cells
})

function formatDateStr(date: Date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
</script>
