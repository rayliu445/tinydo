<template>
  <div>
    <!-- 周视图：7天横向排列 -->
    <div class="grid grid-cols-7 gap-1">
      <div
        v-for="day in weekDays"
        :key="day.dateStr"
        class="border border-base-300 rounded-lg min-h-[300px] transition-colors"
        :class="{
          'bg-primary/5': day.isToday,
          'ring-2 ring-inset ring-primary bg-primary/10': dragOverDate === day.dateStr,
        }"
        @dragover.prevent="dragOverDate = day.dateStr"
        @dragleave="clearDragOver(day.dateStr)"
        @drop.prevent="onDrop(day.dateStr)"
      >
        <!-- 日期头 -->
        <div
          class="text-center py-2 border-b border-base-300 cursor-pointer hover:bg-base-200"
          :class="{ 'bg-primary/10': day.isToday }"
          @click="$emit('add-todo', day.dateStr)"
        >
          <div class="text-xs text-base-content/60">{{ day.weekName }}</div>
          <div
            class="text-lg font-bold w-8 h-8 flex items-center justify-center mx-auto rounded-full"
            :class="{ 'bg-primary text-primary-content': day.isToday }"
          >
            {{ day.dayNum }}
          </div>
        </div>

        <!-- 任务列表 -->
        <div class="p-1 flex flex-col gap-1">
          <div
            v-for="todo in day.todos"
            :key="todo.id"
            class="text-xs px-1.5 py-1 rounded cursor-grab active:cursor-grabbing hover:opacity-80 flex items-center gap-1"
            :class="[getPriorityClass(todo.priority), { 'opacity-40': draggingId === todo.id }]"
            draggable="true"
            @dragstart="onDragStart($event, todo.id)"
            @dragend="onDragEnd"
            @click.stop="$emit('toggle-todo', todo.id)"
          >
            <span :class="{ 'line-through': todo.completed }" class="truncate">
              {{ todo.title }}
            </span>
          </div>
          <div
            v-if="day.todos.length === 0"
            class="text-xs text-base-content/30 text-center py-4"
          >
            点击添加
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

// 拖拽改期：任务条目可拖动，日列（含日期头与空白区）为放置目标（桌面端 HTML5 DnD）
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

const weekNames = ['日', '一', '二', '三', '四', '五', '六']

function getPriorityClass(priority?: number) {
  if (!priority || priority === 0) return 'bg-base-300 text-base-content'
  switch (priority) {
    case 5: return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
    case 3: return 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300'
    case 1: return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
    default: return 'bg-base-300 text-base-content'
  }
}

function formatDateStr(date: Date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function getWeekStart(date: Date) {
  const d = new Date(date)
  d.setDate(d.getDate() - d.getDay())
  return d
}

const weekDays = computed(() => {
  const today = new Date()
  const todayStr = formatDateStr(today)
  const start = getWeekStart(props.currentDate)
  const days = []

  // 构建日期->任务映射
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

  for (let i = 0; i < 7; i++) {
    const d = new Date(start)
    d.setDate(d.getDate() + i)
    const dateStr = formatDateStr(d)
    days.push({
      dateStr,
      weekName: weekNames[i],
      dayNum: d.getDate(),
      isToday: dateStr === todayStr,
      todos: todoMap.get(dateStr) || [],
    })
  }

  return days
})
</script>
