<template>
  <div class="flex flex-col h-full overflow-hidden" :style="{ backgroundColor: 'var(--bg-app)' }">
    <!-- 页面头部 -->
    <div
      class="flex items-center justify-between px-6 h-14 border-b flex-shrink-0"
      :style="{ borderColor: 'var(--border-color)', backgroundColor: 'var(--bg-card)' }"
    >
      <div class="flex items-center gap-3">
        <h1 class="text-lg font-semibold" :style="{ color: 'var(--text-primary)' }">已完成</h1>
        <span
          class="text-xs px-2 py-0.5 rounded-full"
          :style="{ backgroundColor: 'var(--bg-hover)', color: 'var(--text-secondary)' }"
        >
          {{ completedTodos.length }}
        </span>
      </div>
      <!-- 排序方向切换（新的在前 / 旧的在前） -->
      <SortOrderToggle />
    </div>

    <!-- 已完成任务列表 -->
    <div class="flex-1 overflow-y-auto">
      <div v-if="completedTodos.length > 0" class="py-2">
        <div
          v-for="todo in completedTodos"
          :key="todo.id"
          class="flex items-center gap-3 px-6 py-1.5 transition-all duration-150 cursor-pointer"
          :style="{
            borderBottom: '1px solid var(--border-color)',
            paddingLeft: todo.parentId ? '3.5rem' : '1.5rem',
          }"
          @click="openDetail(todo)"
          @contextmenu.prevent="onTodoContextMenu($event, todo)"
        >
          <span
            v-if="todo.parentId"
            class="text-xs flex-shrink-0"
            :style="{ color: 'var(--text-tertiary)' }"
            title="子任务"
          >
            ↳
          </span>
          <!-- 折叠按钮（父任务有关联子任务时显示） -->
          <button
            v-if="hasChildren(todo)"
            class="w-5 h-5 flex-shrink-0 flex items-center justify-center rounded cursor-pointer"
            :style="{ color: 'var(--text-tertiary)' }"
            :title="expandedParents.has(todo.id) ? '收起子任务' : '展开子任务'"
            @click.stop="toggleExpand(todo.id)"
          >
            <AppIcon
              :name="expandedParents.has(todo.id) ? 'chevronDown' : 'chevronRight'"
              :size="13"
            />
          </button>
          <input
            type="checkbox"
            :checked="todo.completed"
            class="checkbox-tick"
            @click.stop
            @change="handleToggle(todo.id)"
          />
          <span
            class="priority-dot"
            :class="{
              high: todo.priority === 5,
              medium: todo.priority === 3,
              low: todo.priority === 1,
              none: !todo.priority,
            }"
          />
          <span
            class="flex-1 text-sm truncate line-through"
            :style="{ color: 'var(--text-tertiary)' }"
          >
            {{ todo.title }}
          </span>
          <span
            v-if="todo.completedTime"
            class="text-xs flex-shrink-0"
            :style="{ color: 'var(--text-tertiary)' }"
          >
            {{ formatDate(todo.completedTime) }}
          </span>
          <button
            class="icon-btn w-7 h-7 flex items-center justify-center rounded-lg"
            :style="{ color: 'var(--text-tertiary)' }"
            title="删除"
            @click="deleteTodo(todo.id)"
          >
            <AppIcon name="delete" :size="14" />
          </button>
        </div>
      </div>

      <!-- 空状态 -->
      <EmptyState v-else text="还没有已完成的任务或笔记" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useTodoStore, sortWithHierarchy, type Todo } from '../stores/todo'
import { storeToRefs } from 'pinia'
import AppIcon from '../components/icons/AppIcon.vue'
import { showContextMenu, type ContextMenuItem } from '../stores/context-menu'
import EmptyState from '../components/EmptyState.vue'
import SortOrderToggle from '../components/SortOrderToggle.vue'
import { useSettingsStore } from '../stores/settings'

const todoStore = useTodoStore()
const settingsStore = useSettingsStore()
const { todos } = storeToRefs(todoStore)
const { fetchTodos, removeTodo, toggleTodo } = todoStore

// 排序方向（新的在前 / 旧的在前）：与清单页共用同一设置
const sortOrder = computed(() => settingsStore.settings.ui.sortOrder)

// 子任务折叠（默认折叠，父任务有子任务时才显示折叠按钮）
const expandedParents = ref<Set<string>>(new Set())

function hasChildren(todo: Todo): boolean {
  return todos.value.some(t => t.parentId === todo.id)
}

function toggleExpand(id: string) {
  const next = new Set(expandedParents.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedParents.value = next
}

// 折叠过滤：父任务在列表中且未展开时，隐藏其子任务
function applyCollapse<T extends { id: string; parentId?: string }>(sorted: T[]): T[] {
  return sorted.filter(t => {
    if (!t.parentId) return true
    const parentInList = sorted.some(p => p.id === t.parentId)
    if (!parentInList) return true
    return expandedParents.value.has(t.parentId)
  })
}

const completedTodos = computed(() => {
  // 显示所有已完成：任务 + 归档笔记（归档=标记完成，算作完成项）；层级排序：父任务在前，已完成子任务紧跟其后
  return applyCollapse(sortWithHierarchy(todos.value.filter(todo => todo.completed), sortOrder.value))
})

// 任务详情（右侧第四列面板，全局共享）
function openDetail(todo: { id: string }) {
  todoStore.openDetail(todo.id)
}

// 右键快捷菜单（已完成条目）：任务/笔记动态显示转化方向
function onTodoContextMenu(e: MouseEvent, todo: Todo) {
  const items: ContextMenuItem[] = []
  if (todo.kind === 'NOTE') {
    // 已归档笔记：可恢复归档（标记未完成）、转为任务
    items.push(
      { label: '恢复归档', icon: 'restore', handler: () => todoStore.setArchived(todo.id, false) },
      {
        label: '转为任务',
        icon: 'today',
        handler: () => todoStore.convertKind(todo.id, 'TASK'),
      },
    )
  } else {
    items.push(
      {
        label: '转为笔记',
        icon: 'notes',
        handler: () => todoStore.convertKind(todo.id, 'NOTE'),
      },
      { label: '标记未完成', icon: 'star', handler: () => toggleTodo(todo.id) },
    )
  }
  items.push(
    { label: '编辑', icon: 'edit', handler: () => openDetail(todo) },
    { label: '删除', icon: 'delete', danger: true, handler: () => deleteTodo(todo.id) },
  )
  showContextMenu(e, items)
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr)
  const month = d.getMonth() + 1
  const day = d.getDate()
  const today = new Date()
  if (dateStr.startsWith(today.toISOString().slice(0, 10))) return '今天'
  return `${month}/${day}`
}

async function deleteTodo(id: string) {
  if (confirm('确定要删除这个任务吗？')) {
    await removeTodo(id)
  }
}

function handleToggle(id: string) {
  toggleTodo(id)
}

onMounted(() => {
  if (todos.value.length === 0) {
    fetchTodos()
  }
})
</script>
