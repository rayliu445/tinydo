<template>
  <div class="flex flex-col h-full overflow-hidden" :style="{ backgroundColor: 'var(--bg-app)' }">
    <!-- 页面头部 -->
    <div
      class="flex items-center justify-between px-6 h-14 border-b flex-shrink-0"
      :style="{ borderColor: 'var(--border-color)', backgroundColor: 'var(--bg-card)' }"
    >
      <div class="flex items-center gap-2">
        <button
          class="px-3 py-1.5 text-sm rounded-lg transition-all duration-150"
          :style="{
            backgroundColor: 'var(--bg-hover)',
            color: 'var(--text-primary)',
          }"
          @click="goToday"
        >今天</button>
        <button
          class="icon-btn w-7 h-7 flex items-center justify-center rounded-lg"
          :style="{ color: 'var(--text-secondary)' }"
          @click="prevPeriod"
        >
          <AppIcon name="chevronLeft" :size="16" />
        </button>
        <button
          class="icon-btn w-7 h-7 flex items-center justify-center rounded-lg"
          :style="{ color: 'var(--text-secondary)' }"
          @click="nextPeriod"
        >
          <AppIcon name="chevronRight" :size="16" />
        </button>
        <h2 class="text-lg font-semibold ml-2" :style="{ color: 'var(--text-primary)' }">{{ headerTitle }}</h2>
      </div>
      <div class="flex bg-gray-100 dark:bg-gray-800 rounded-lg p-0.5">
        <button
          class="px-3 py-1.5 text-xs font-medium rounded-md transition-all duration-150"
          :style="getViewBtnStyle('month')"
          @click="viewMode = 'month'"
        >月</button>
        <button
          class="px-3 py-1.5 text-xs font-medium rounded-md transition-all duration-150"
          :style="getViewBtnStyle('week')"
          @click="viewMode = 'week'"
        >周</button>
        <button
          class="px-3 py-1.5 text-xs font-medium rounded-md transition-all duration-150"
          :style="getViewBtnStyle('day')"
          @click="viewMode = 'day'"
        >日</button>
      </div>
    </div>

    <!-- 日历内容区域 -->
    <div class="flex-1 overflow-y-auto p-4">

    <!-- 视图切换 -->
    <CalendarMonth
      v-if="viewMode === 'month'"
      :current-date="currentDate"
      :todos="taskTodos"
      @select-date="selectDate"
      @add-todo="handleQuickAdd"
      @toggle-todo="handleToggleTodo"
      @move-todo="handleMoveTodo"
    />
    <CalendarWeek
      v-else-if="viewMode === 'week'"
      :current-date="currentDate"
      :todos="taskTodos"
      @select-date="selectDate"
      @add-todo="handleQuickAdd"
      @toggle-todo="handleToggleTodo"
      @move-todo="handleMoveTodo"
    />
    <CalendarDay
      v-else
      :current-date="currentDate"
      :todos="taskTodos"
      @add-todo="handleQuickAdd"
      @toggle-todo="handleToggleTodo"
    />

    <!-- 快速添加任务弹窗 -->
    <transition name="scale">
      <div
        v-if="showAddDialog"
        class="fixed inset-0 z-50 flex items-center justify-center"
        :style="{ backgroundColor: 'rgba(0,0,0,0.4)' }"
        @click.self="closeAddDialog"
      >
        <div
          class="w-full max-w-sm rounded-xl shadow-lg p-6"
          :style="{ backgroundColor: 'var(--bg-card)' }"
        >
          <h3 class="text-base font-semibold mb-4" :style="{ color: 'var(--text-primary)' }">添加任务</h3>
          <div class="space-y-3">
            <input
              v-model="quickAddTitle"
              type="text"
              placeholder="任务标题"
              class="w-full px-3 py-2 text-sm rounded-lg border outline-none transition-all duration-150"
              :style="{
                backgroundColor: 'var(--bg-app)',
                borderColor: 'var(--border-color)',
                color: 'var(--text-primary)',
              }"
              @keyup.enter="confirmQuickAdd"
            />
            <div>
              <label class="block text-xs font-medium mb-1" :style="{ color: 'var(--text-secondary)' }">优先级</label>
              <div class="flex gap-2">
                <button
                  v-for="p in priorityOptions"
                  :key="p.value"
                  class="flex-1 py-1.5 text-sm rounded-lg transition-all duration-150 font-medium"
                  :style="getPriorityBtnStyle(p.value, quickAddPriority === p.value)"
                  @click="quickAddPriority = p.value"
                >
                  {{ p.label }}
                </button>
              </div>
            </div>
            <p class="text-sm" :style="{ color: 'var(--text-secondary)' }">
              日期：{{ quickAddDateStr }}
            </p>
          </div>
          <div class="flex justify-end gap-2 mt-6">
            <button
              class="px-4 py-2 text-sm rounded-lg transition-all duration-150"
              :style="{
                backgroundColor: 'var(--bg-hover)',
                color: 'var(--text-secondary)',
              }"
              @click="closeAddDialog"
            >
              取消
            </button>
            <button
              class="px-4 py-2 text-sm rounded-lg transition-all duration-150"
              :style="{
                backgroundColor: 'var(--bg-hover)',
                color: 'var(--text-primary)',
                fontWeight: 500,
              }"
              @click="confirmQuickAdd"
            >
              添加
            </button>
          </div>
        </div>
      </div>
    </transition>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useTodoStore, type Todo } from '../stores/todo'
import { storeToRefs } from 'pinia'
import CalendarMonth from '../components/calendar/CalendarMonth.vue'
import CalendarWeek from '../components/calendar/CalendarWeek.vue'
import CalendarDay from '../components/calendar/CalendarDay.vue'
import AppIcon from '../components/icons/AppIcon.vue'

const todoStore = useTodoStore()
const { todos } = storeToRefs(todoStore)
const { fetchTodos, addTodo, toggleTodo } = todoStore

// 日历只展示任务，笔记（kind=NOTE）不参与
const taskTodos = computed(() => todos.value.filter(t => t.kind !== 'NOTE'))

// 当前视图日期
const currentDate = ref(new Date())
const viewMode = ref<'month' | 'week' | 'day'>('month')

// 快速添加任务
const showAddDialog = ref(false)
const quickAddTitle = ref('')
const quickAddDate = ref('')
const quickAddPriority = ref<0 | 1 | 3 | 5>(3) // 默认中
const quickAddDateStr = computed(() => {
  if (!quickAddDate.value) return ''
  return quickAddDate.value
})

const priorityOptions = [
  { value: 0, label: '无' },
  { value: 1, label: '低' },
  { value: 3, label: '中' },
  { value: 5, label: '高' },
]

function getPriorityBtnStyle(value: number, isSelected: boolean) {
  return {
    backgroundColor: isSelected ? 'var(--color-accent-light)' : 'var(--bg-hover)',
    color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
    fontWeight: isSelected ? '600' : '400',
    border: isSelected ? '1px solid var(--border-color)' : '1px solid transparent',
  }
}

function getViewBtnStyle(mode: string) {
  const isActive = viewMode.value === mode
  return {
    backgroundColor: isActive ? 'var(--bg-card)' : 'transparent',
    color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
    boxShadow: isActive ? '0 1px 2px rgba(0,0,0,0.1)' : 'none',
  }
}

// 标题
const headerTitle = computed(() => {
  const year = currentDate.value.getFullYear()
  const month = currentDate.value.getMonth() + 1
  const day = currentDate.value.getDate()
  const weekdays = ['日', '一', '二', '三', '四', '五', '六']

  switch (viewMode.value) {
    case 'month':
      return `${year}年${month}月`
    case 'week': {
      const weekStart = getWeekStart(currentDate.value)
      const weekEnd = new Date(weekStart)
      weekEnd.setDate(weekEnd.getDate() + 6)
      return `${weekStart.getMonth() + 1}/${weekStart.getDate()} - ${weekEnd.getMonth() + 1}/${weekEnd.getDate()}`
    }
    case 'day':
      return `${year}年${month}月${day}日 周${weekdays[currentDate.value.getDay()]}`
    default:
      return ''
  }
})

function getWeekStart(date: Date) {
  const d = new Date(date)
  const day = d.getDay()
  d.setDate(d.getDate() - day)
  return d
}

function prevPeriod() {
  const d = new Date(currentDate.value)
  switch (viewMode.value) {
    case 'month':
      d.setMonth(d.getMonth() - 1)
      break
    case 'week':
      d.setDate(d.getDate() - 7)
      break
    case 'day':
      d.setDate(d.getDate() - 1)
      break
  }
  currentDate.value = d
}

function nextPeriod() {
  const d = new Date(currentDate.value)
  switch (viewMode.value) {
    case 'month':
      d.setMonth(d.getMonth() + 1)
      break
    case 'week':
      d.setDate(d.getDate() + 7)
      break
    case 'day':
      d.setDate(d.getDate() + 1)
      break
  }
  currentDate.value = d
}

function goToday() {
  currentDate.value = new Date()
}

function selectDate(dateStr: string) {
  quickAddDate.value = dateStr
  quickAddTitle.value = ''
  quickAddPriority.value = 3
  showAddDialog.value = true
}

function closeAddDialog() {
  showAddDialog.value = false
}

async function confirmQuickAdd() {
  if (!quickAddTitle.value.trim()) return
  await addTodo({
    title: quickAddTitle.value,
    priority: quickAddPriority.value,
    dueDate: quickAddDate.value,
  })
  quickAddTitle.value = ''
  closeAddDialog()
}

function handleQuickAdd(dateStr: string) {
  selectDate(dateStr)
}

function handleToggleTodo(id: string) {
  toggleTodo(id)
}

// 拖拽改期：只替换日期部分，保留原时间/时区（带时间的任务跨天拖动不丢时刻）
function handleMoveTodo(todoId: string, dateStr: string) {
  const t = todos.value.find(x => x.id === todoId)
  if (!t) return
  const old = t.dueDate ?? ''
  const dueDate = old.length > 10 && old.charAt(10) === 'T' ? dateStr + old.slice(10) : dateStr
  if (dueDate === old) return
  void todoStore.updateTodo(todoId, { dueDate })
}

onMounted(() => {
  fetchTodos()
})
</script>
