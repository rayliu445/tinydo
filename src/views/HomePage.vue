<template>
  <div class="flex flex-col h-full overflow-hidden" :style="{ backgroundColor: 'var(--bg-app)' }">
    <!-- ===== 页面头部 ===== -->
    <div
      class="flex items-center justify-between px-6 h-14 border-b flex-shrink-0"
      :style="{ borderColor: 'var(--border-color)', backgroundColor: 'var(--bg-card)' }"
    >
      <div class="flex items-center gap-3">
        <h1 class="text-lg font-semibold" :style="{ color: 'var(--text-primary)' }">
          {{ pageTitle }}
        </h1>
        <span
          v-if="filteredTodos.length > 0"
          class="text-xs px-2 py-0.5 rounded-full"
          :style="{ backgroundColor: 'var(--bg-hover)', color: 'var(--text-secondary)' }"
        >
          {{ filteredTodos.length }}
        </span>
      </div>
      <!-- 排序方向切换（新的在前 / 旧的在前） -->
      <SortOrderToggle />
    </div>

    <!-- ===== 搜索框（仅搜索视图，可搜所有已完成/未完成） ===== -->
    <div
      v-if="currentView === 'search'"
      class="px-6 py-3 border-b flex-shrink-0"
      :style="{ borderColor: 'var(--border-color)', backgroundColor: 'var(--bg-card)' }"
    >
      <div class="relative">
        <input
          ref="searchInputRef"
          v-model="searchQuery"
          type="text"
          placeholder="搜索所有任务（含已完成）..."
          class="w-full pl-9 pr-9 py-2 text-sm rounded-lg outline-none transition-all duration-150"
          :style="{
            backgroundColor: 'var(--bg-app)',
            color: 'var(--text-primary)',
            border: '1px solid var(--color-accent)',
          }"
        />
        <span class="absolute left-3 top-1/2 -translate-y-1/2 flex items-center" :style="{ color: 'var(--text-tertiary)' }">
          <AppIcon name="search" :size="14" />
        </span>
        <button
          v-if="searchQuery"
          class="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center justify-center w-6 h-6 rounded-full cursor-pointer"
          :style="{ color: 'var(--text-tertiary)', backgroundColor: 'var(--bg-hover)' }"
          title="清除搜索"
          @click="clearSearch"
        >
          <AppIcon name="delete" :size="12" />
        </button>
      </div>
    </div>

    <!-- ===== 添加任务条 (固定于头部下方，搜索视图不显示) ===== -->
    <div
      v-if="currentView !== 'search'"
      class="px-6 py-3 border-b flex-shrink-0"
      :style="{ borderColor: 'var(--border-color)', backgroundColor: 'var(--bg-card)' }"
    >
      <div class="flex items-center gap-2">
        <div
          class="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg transition-all duration-150 cursor-text"
          :style="{
            backgroundColor: 'var(--bg-app)',
            border: showAddOptions || newTodoTitle.trim() ? '1px solid var(--text-secondary)' : '1px solid transparent',
          }"
          @click="focusInput"
        >
          <span class="flex-shrink-0 flex items-center">
            <AppIcon name="add" :size="18" color="var(--text-secondary)" />
          </span>
          <input
            ref="addInputRef"
            v-model="newTodoTitle"
            type="text"
            placeholder="添加任务..."
            class="flex-1 bg-transparent text-sm outline-none"
            :style="{ color: 'var(--text-primary)' }"
            @keyup.enter="handleAddTodo"
            @focus="showAddOptions = true"
          />
          <button
            v-if="newTodoTitle.trim()"
            class="text-sm font-medium px-3 py-1 rounded-md transition-all duration-150"
            :style="{
              backgroundColor: 'var(--bg-hover)',
              color: 'var(--text-primary)',
            }"
            @click="handleAddTodo"
          >
            添加
          </button>
        </div>
      </div>
      <!-- 展开选项 -->
      <transition name="slide-down">
        <div v-if="showAddOptions || newTodoTitle.trim()" class="flex flex-wrap items-center gap-4 mt-3 ml-2">
          <div class="flex items-center gap-2">
            <span class="text-xs" :style="{ color: 'var(--text-secondary)' }">类型</span>
            <div class="flex gap-1">
              <button
                class="px-2.5 py-1 text-xs rounded-md transition-all duration-150 font-medium"
                :style="getTypeBtnStyle('TASK')"
                @click="newTodoKind = 'TASK'"
              >
                任务
              </button>
              <button
                class="px-2.5 py-1 text-xs rounded-md transition-all duration-150 font-medium"
                :style="getTypeBtnStyle('NOTE')"
                @click="newTodoKind = 'NOTE'"
              >
                笔记
              </button>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-xs" :style="{ color: 'var(--text-secondary)' }">优先级</span>
            <div class="flex gap-1">
              <button
                v-for="p in priorityOptions"
                :key="p.value"
                class="px-2.5 py-1 text-xs rounded-md transition-all duration-150 font-medium"
                :style="getPriorityBtnStyle(p.value)"
                @click="newTodoPriority = p.value"
              >
                {{ p.label }}
              </button>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-xs" :style="{ color: 'var(--text-secondary)' }">日期</span>
            <input
              v-model="newTodoDueDate"
              type="date"
              class="px-2 py-1 text-xs rounded-md border transition-all duration-150"
              :style="{
                backgroundColor: 'var(--bg-app)',
                borderColor: 'var(--border-color)',
                color: 'var(--text-primary)',
              }"
            />
          </div>
        </div>
      </transition>
    </div>

    <!-- ===== 任务列表 (可滚动) ===== -->
    <div class="flex-1 overflow-y-auto">
      <div v-if="displayRows.length > 0" class="py-2">
        <transition-group name="list" tag="div">
          <div
            v-for="row in displayRows"
            :key="row.kind === 'header' ? 'h-' + row.group : row.todo!.id"
          >
            <!-- 组头（今天/最近7天视图：未完成/已完成） -->
            <div
              v-if="row.kind === 'header'"
              class="flex items-center gap-2 px-6 py-1.5 cursor-pointer select-none"
              :style="{
                backgroundColor: 'var(--bg-hover)',
                borderBottom: '1px solid var(--border-color)',
              }"
              @click="toggleGroup(row.group!)"
            >
              <AppIcon
                :name="groupCollapsed[row.group!] ? 'chevronRight' : 'chevronDown'"
                :size="13"
              />
              <span class="text-xs font-medium" :style="{ color: 'var(--text-secondary)' }">
                {{ row.label }}
              </span>
              <span class="text-xs" :style="{ color: 'var(--text-tertiary)' }">
                {{ row.count }}
              </span>
            </div>
            <!-- 任务行 -->
            <div
              v-else
              class="group flex items-center gap-3 px-6 py-1.5 transition-all duration-150 cursor-pointer"
              :style="{
                backgroundColor: 'transparent',
                borderBottom: '1px solid var(--border-color)',
                paddingLeft: row.todo!.parentId ? '3.5rem' : '1.5rem',
              }"
              @contextmenu.prevent="onTodoContextMenu($event, row.todo!)"
            >
              <!-- 子任务标记 -->
              <span
                v-if="row.todo!.parentId"
                class="text-xs flex-shrink-0"
                :style="{ color: 'var(--text-tertiary)' }"
                title="子任务"
              >
                ↳
              </span>
              <!-- 折叠按钮（父任务有关联子任务时显示） -->
              <button
                v-if="hasChildren(row.todo!)"
                class="w-5 h-5 flex-shrink-0 flex items-center justify-center rounded cursor-pointer"
                :style="{ color: 'var(--text-tertiary)' }"
                :title="expandedParents.has(row.todo!.id) ? '收起子任务' : '展开子任务'"
                @click.stop="toggleExpand(row.todo!.id)"
              >
                <AppIcon
                  :name="expandedParents.has(row.todo!.id) ? 'chevronDown' : 'chevronRight'"
                  :size="13"
                />
              </button>
              <!-- 复选框 -->
              <input
                type="checkbox"
                :checked="row.todo!.completed"
                class="checkbox-tick"
                @change="todoStore.toggleTodo(row.todo!.id)"
              />

              <!-- 优先级圆点 -->
              <span
                class="priority-dot"
                :class="{
                  high: row.todo!.priority === 5,
                  medium: row.todo!.priority === 3,
                  low: row.todo!.priority === 1,
                  none: !row.todo!.priority,
                }"
              />

              <!-- 任务标题（点击打开详情） -->
              <div
                class="flex-1 min-w-0 text-sm truncate cursor-pointer"
                :class="{ 'line-through': row.todo!.completed }"
                :style="{
                  color: row.todo!.completed ? 'var(--text-tertiary)' : 'var(--text-primary)',
                  textDecorationColor: 'var(--text-tertiary)',
                }"
                @click="openDetail(row.todo!)"
              >
                {{ row.todo!.title }}
              </div>

              <!-- 截止日期 -->
              <span
                v-if="row.todo!.dueDate"
                class="text-xs flex-shrink-0"
                :style="{ color: 'var(--text-tertiary)' }"
              >
                {{ formatDate(row.todo!.dueDate) }}
              </span>

              <!-- 悬停操作按钮 -->
              <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                <button
                  class="icon-btn w-7 h-7 flex items-center justify-center rounded-lg"
                  :style="{ color: 'var(--text-tertiary)' }"
                  title="编辑"
                  @click="openDetail(row.todo!)"
                >
                  <AppIcon name="edit" :size="14" />
                </button>
                <button
                  class="icon-btn w-7 h-7 flex items-center justify-center rounded-lg"
                  :style="{ color: 'var(--text-tertiary)' }"
                  title="删除"
                  @click="deleteTodo(row.todo!.id)"
                >
                  <AppIcon name="delete" :size="14" />
                </button>
              </div>
            </div>
          </div>
        </transition-group>
      </div>

      <!-- 空状态 -->
      <EmptyState v-else :text="emptyMessage" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useTodoStore, sortWithHierarchy, type Todo } from '../stores/todo'
import { queryTasks } from '../services/task-query'
import { storeToRefs } from 'pinia'
import AppIcon from '../components/icons/AppIcon.vue'
import EmptyState from '../components/EmptyState.vue'
import SortOrderToggle from '../components/SortOrderToggle.vue'
import { showContextMenu, type ContextMenuItem } from '../stores/context-menu'
import { useSettingsStore } from '../stores/settings'

const route = useRoute()
const router = useRouter()
const todoStore = useTodoStore()
const settingsStore = useSettingsStore()
const { todos } = storeToRefs(todoStore)
const { fetchTodos, removeTodo } = todoStore

// 排序方向（新的在前 / 旧的在前）：顶层与每一级子任务同时生效
const sortOrder = computed(() => settingsStore.settings.ui.sortOrder)

// ============ 页面标题和过滤器 ============
const currentView = computed(() => {
  const view = route.query.view as string | undefined
  if (view === 'today') return 'today'
  if (view === 'next7') return 'next7'
  if (view === 'search') return 'search'
  return 'inbox'
})

const pageTitle = computed(() => {
  switch (currentView.value) {
    case 'today': return '今天'
    case 'next7': return '最近7天'
    case 'search': return '搜索'
    default: return '收集箱'
  }
})

const emptyMessage = computed(() => {
  switch (currentView.value) {
    case 'today': return '今天没有待办任务'
    case 'next7': return '最近7天没有待办任务'
    case 'search': return '输入关键词搜索所有任务（含已完成）'
    default: return '还没有任务，添加一个吧'
  }
})

// ============ 新任务输入 ============
const addInputRef = ref<HTMLInputElement | null>(null)
const newTodoTitle = ref('')
const newTodoPriority = ref<0 | 1 | 3 | 5>(3)
const newTodoDueDate = ref(getTodayStr())
const newTodoKind = ref<'TASK' | 'NOTE'>('TASK')
const showAddOptions = ref(false)

function getTodayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function focusInput() {
  addInputRef.value?.focus()
}

// 监听左列按钮：添加任务聚焦输入框 / 搜索聚焦搜索框
onMounted(() => {
  window.addEventListener('tinydo-focus-add', () => {
    nextTick(() => addInputRef.value?.focus())
  })
  window.addEventListener('tinydo-focus-search', () => {
    nextTick(() => searchInputRef.value?.focus())
  })
})

// 进入搜索视图时确保自动聚焦搜索框（不依赖事件时序）
watch(() => route.query.view, (v) => {
  if (v === 'search') {
    nextTick(() => nextTick(() => searchInputRef.value?.focus()))
  }
})

const priorityOptions = [
  { value: 0, label: '无' },
  { value: 1, label: '低' },
  { value: 3, label: '中' },
  { value: 5, label: '高' },
] as const

function getPriorityBtnStyle(value: number, isSelected?: boolean) {
  const selected = isSelected !== undefined ? isSelected : newTodoPriority.value === value
  return {
    backgroundColor: selected ? 'var(--color-accent-light)' : 'var(--bg-hover)',
    color: selected ? 'var(--text-primary)' : 'var(--text-secondary)',
    fontWeight: selected ? '600' : '400',
    border: '1px solid ' + (selected ? 'var(--border-color)' : 'transparent'),
  }
}

// ============ 搜索（从侧边栏共享） ============
import { useGlobalSearch } from '../stores/search'
const { searchQuery, setSearch } = useGlobalSearch()
const searchInputRef = ref<HTMLInputElement | null>(null)

function clearSearch() {
  setSearch('')
  nextTick(() => searchInputRef.value?.focus())
}

// ============ 子任务折叠 ============
const expandedParents = ref<Set<string>>(new Set())

// 任务是否有关联子任务（决定是否显示折叠按钮）
function hasChildren(todo: Todo): boolean {
  return todos.value.some(t => t.parentId === todo.id)
}

function toggleExpand(id: string) {
  const next = new Set(expandedParents.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedParents.value = next
}

// 折叠过滤：父任务在列表中且未展开时，隐藏其子任务；
// 父任务不在列表（孤立子任务）时始终显示。
function applyCollapse<T extends { id: string; parentId?: string }>(sorted: T[]): T[] {
  return sorted.filter(t => {
    if (!t.parentId) return true
    const parentInList = sorted.some(p => p.id === t.parentId)
    if (!parentInList) return true
    return expandedParents.value.has(t.parentId)
  })
}

// ============ 任务过滤 ============
const filteredTodos = computed(() => {
  // 搜索视图：全量搜索（含已完成），并按父子层级排序
  if (currentView.value === 'search') {
    const query = searchQuery.value.toLowerCase().trim()
    if (!query) return []
    return applyCollapse(sortWithHierarchy(todos.value.filter(t => t.title.toLowerCase().includes(query)), sortOrder.value))
  }

  // 其他视图：与外部助手（本地 API → CLI → DSH 插件）共用同一份查询语义（services/task-query.ts），
  // 避免两处各写一套过滤规则而逐渐漂移。
  // 今天/最近7天含已完成（由 displayRows 分组显示）；收集箱只看未完成；笔记不进任务列表。
  const tasks = queryTasks(todos.value, {
    view: currentView.value as 'inbox' | 'today' | 'next7',
    order: sortOrder.value,
  })

  // 折叠过滤：父任务在前、子任务紧跟其后，未展开时隐藏子任务
  return applyCollapse(tasks)
})

// ============ 今天/最近7天视图分组（未完成 / 已完成） ============
const groupCollapsed = ref<{ pending: boolean; completed: boolean }>({
  pending: false,
  completed: true,
})

function toggleGroup(g: 'pending' | 'completed') {
  groupCollapsed.value = { ...groupCollapsed.value, [g]: !groupCollapsed.value[g] }
}

interface DisplayRow {
  kind: 'header' | 'todo'
  group?: 'pending' | 'completed'
  label?: string
  count?: number
  todo?: Todo
}

// 统一渲染行：今天/最近7天视图为「未完成/已完成」分组 + 组头；其他视图为平铺任务
const displayRows = computed<DisplayRow[]>(() => {
  const isGrouped = currentView.value === 'today' || currentView.value === 'next7'
  if (!isGrouped) {
    return filteredTodos.value.map(t => ({ kind: 'todo' as const, todo: t }))
  }
  const pending = applyCollapse(sortWithHierarchy(filteredTodos.value.filter(t => !t.completed), sortOrder.value))
  const completed = applyCollapse(sortWithHierarchy(filteredTodos.value.filter(t => t.completed), sortOrder.value))
  const rows: DisplayRow[] = []
  if (pending.length > 0) {
    rows.push({ kind: 'header', group: 'pending', label: '未完成', count: pending.length })
    if (!groupCollapsed.value.pending) rows.push(...pending.map(t => ({ kind: 'todo' as const, todo: t })))
  }
  if (completed.length > 0) {
    rows.push({ kind: 'header', group: 'completed', label: '已完成', count: completed.length })
    if (!groupCollapsed.value.completed) rows.push(...completed.map(t => ({ kind: 'todo' as const, todo: t })))
  }
  return rows
})

// ============ 操作 ============
// 添加任务/笔记（类型切换：任务 TASK / 笔记 NOTE）
async function handleAddTodo() {
  if (!newTodoTitle.value.trim()) return
  const isNote = newTodoKind.value === 'NOTE'
  await todoStore.addTodo({
    title: newTodoTitle.value,
    priority: newTodoPriority.value,
    dueDate: newTodoDueDate.value ? new Date(newTodoDueDate.value).toISOString() : undefined,
    kind: newTodoKind.value,
  })
  newTodoTitle.value = ''
  newTodoPriority.value = 3
  newTodoDueDate.value = getTodayStr()
  newTodoKind.value = 'TASK'
  showAddOptions.value = false
  // 添加的是笔记：跳到笔记视图（笔记不显示在任务列表）
  if (isNote) {
    router.push('/notes')
  }
}

function getTypeBtnStyle(type: 'TASK' | 'NOTE') {
  const selected = newTodoKind.value === type
  return {
    backgroundColor: selected ? 'var(--color-accent-light)' : 'var(--bg-hover)',
    color: selected ? 'var(--text-primary)' : 'var(--text-secondary)',
    fontWeight: selected ? '600' : '400',
    border: '1px solid ' + (selected ? 'var(--border-color)' : 'transparent'),
  }
}

// 删除任务
async function deleteTodo(id: string) {
  if (confirm('确定要删除这个任务吗？')) {
    await removeTodo(id)
  }
}

// 右键快捷菜单（任务行）
function onTodoContextMenu(e: MouseEvent, todo: Todo) {
  const items: ContextMenuItem[] = [
    {
      label: todo.kind === 'NOTE' ? '转为任务' : '转为笔记',
      icon: 'notes',
      handler: () => todoStore.convertKind(todo.id, todo.kind === 'NOTE' ? 'TASK' : 'NOTE'),
    },
  ]
  // 任务支持标记完成/未完成（笔记没有完成概念）
  if (todo.kind !== 'NOTE') {
    items.push({
      label: todo.completed ? '标记未完成' : '标记完成',
      icon: 'star',
      handler: () => todoStore.toggleTodo(todo.id),
    })
  }
  items.push(
    { label: '编辑', icon: 'edit', handler: () => openDetail(todo) },
    { label: '删除', icon: 'delete', danger: true, handler: () => deleteTodo(todo.id) },
  )
  showContextMenu(e, items)
}

// ============ 任务详情（右侧第四列面板，全局共享） ============
function openDetail(todo: Todo) {
  todoStore.openDetail(todo.id)
}

// ============ 工具函数 ============
function toLocalDateStr(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr)
  const month = d.getMonth() + 1
  const day = d.getDate()
  const todayStr = toLocalDateStr(new Date())
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const tomorrowStr = toLocalDateStr(tomorrow)
  
  if (dateStr.startsWith(todayStr)) return '今天'
  if (dateStr.startsWith(tomorrowStr)) return '明天'
  return `${month}/${day}`
}

// 初始化
onMounted(() => {
  fetchTodos()
})
</script>

<style scoped>
.slide-down-enter-active,
.slide-down-leave-active {
  transition: all 200ms ease;
}
.slide-down-enter-from,
.slide-down-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
</style>
