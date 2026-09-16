<template>
  <div
    class="flex flex-col overflow-hidden"
    :class="overlay ? 'fixed inset-0 z-50 w-full' : 'w-[400px] flex-shrink-0 border-l'"
    :style="{ borderColor: 'var(--border-color)', backgroundColor: 'var(--bg-card)' }"
  >
    <!-- ===== 头部 ===== -->
    <div
      class="flex items-center justify-between px-4 h-12 border-b flex-shrink-0"
      :style="{ borderColor: 'var(--border-color)' }"
    >
      <div class="flex items-center gap-2">
        <span class="text-sm font-semibold" :style="{ color: 'var(--text-primary)' }">详情</span>
        <span
          v-if="isNote"
          class="text-xs px-1.5 py-0.5 rounded-full"
          :style="{ backgroundColor: 'var(--bg-hover)', color: 'var(--text-tertiary)' }"
        >笔记</span>
      </div>
      <button
        class="icon-btn w-7 h-7 flex items-center justify-center rounded-lg"
        :style="{ color: 'var(--text-tertiary)' }"
        title="关闭"
        @click="close"
      >
        ✕
      </button>
    </div>

    <!-- ===== 内容滚动区（有选中任务时展示详情） ===== -->
    <div v-if="target" class="flex-1 overflow-y-auto p-4 space-y-3">
      <!-- 标题 -->
      <div>
        <label class="block text-xs font-medium mb-1" :style="{ color: 'var(--text-secondary)' }">标题</label>
        <input
          v-model="editTitle"
          type="text"
          class="w-full px-3 py-2 text-base font-medium rounded-lg border outline-none transition-all duration-150"
          :style="{
            backgroundColor: 'var(--bg-app)',
            borderColor: 'var(--border-color)',
            color: 'var(--text-primary)',
          }"
        />
      </div>
      <!-- 内容（主要编辑区域，占大空间） -->
      <div>
        <label class="block text-xs font-medium mb-1" :style="{ color: 'var(--text-secondary)' }">内容</label>
        <textarea
          v-model="editContent"
          rows="14"
          placeholder="任务详细内容..."
          class="w-full px-3 py-2 text-sm rounded-lg border outline-none transition-all duration-150 resize-y min-h-[300px] leading-relaxed"
          :style="{
            backgroundColor: 'var(--bg-app)',
            borderColor: 'var(--border-color)',
            color: 'var(--text-primary)',
          }"
        ></textarea>
      </div>
      <!-- 完成状态 + 优先级（笔记不显示任务属性） -->
      <div v-if="!isNote" class="flex items-center gap-4">
        <label class="flex items-center gap-2 text-sm cursor-pointer whitespace-nowrap" :style="{ color: 'var(--text-secondary)' }">
          <input
            v-model="editCompleted"
            type="checkbox"
            class="checkbox-tick"
          />
          已完成
        </label>
        <div class="flex-1 flex gap-1.5">
          <button
            v-for="p in priorityOptions"
            :key="p.value"
            class="flex-1 py-1.5 text-xs rounded-lg transition-all duration-150 font-medium"
            :style="getPriorityBtnStyle(p.value, editPriority === p.value)"
            @click="editPriority = p.value"
          >
            {{ p.label }}
          </button>
        </div>
      </div>
      <!-- 截止/开始日期（笔记不显示） -->
      <div v-if="!isNote" class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-xs font-medium mb-1" :style="{ color: 'var(--text-secondary)' }">截止日期</label>
          <input
            v-model="editDueDate"
            type="date"
            class="w-full px-3 py-1.5 text-sm rounded-lg border outline-none transition-all duration-150"
            :style="{ backgroundColor: 'var(--bg-app)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }"
          />
        </div>
        <div>
          <label class="block text-xs font-medium mb-1" :style="{ color: 'var(--text-secondary)' }">开始日期</label>
          <input
            v-model="editStartDate"
            type="date"
            class="w-full px-3 py-1.5 text-sm rounded-lg border outline-none transition-all duration-150"
            :style="{ backgroundColor: 'var(--bg-app)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }"
          />
        </div>
      </div>
      <!-- 标签 -->
      <div>
        <label class="block text-xs font-medium mb-1" :style="{ color: 'var(--text-secondary)' }">标签</label>
        <input
          v-model="editTags"
          type="text"
          placeholder="多个标签用逗号分隔"
          class="w-full px-3 py-1.5 text-sm rounded-lg border outline-none transition-all duration-150"
          :style="{ backgroundColor: 'var(--bg-app)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }"
        />
      </div>
      <!-- 只读信息 -->
      <div v-if="editList || editCreatedAt" class="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs" :style="{ color: 'var(--text-tertiary)' }">
        <span v-if="editList">清单：{{ editList }}</span>
        <span v-if="editCreatedAt">创建时间：{{ formatFullDate(editCreatedAt) }}</span>
      </div>
      <!-- 子任务（笔记不关联子任务） -->
      <div v-if="!isNote">
        <label class="block text-xs font-medium mb-1" :style="{ color: 'var(--text-secondary)' }">子任务</label>
        <div v-if="subTasks.length > 0" class="space-y-1">
          <div
            v-for="st in subTasks"
            :key="st.id"
            class="flex items-center gap-2 px-2 py-1.5 rounded"
            :style="{ backgroundColor: 'var(--bg-hover)' }"
          >
            <input
              type="checkbox"
              :checked="st.completed"
              class="checkbox-tick"
              @change="todoStore.toggleTodo(st.id)"
            />
            <span
              class="flex-1 text-sm truncate cursor-pointer"
              :style="{
                color: 'var(--text-primary)',
                textDecoration: st.completed ? 'line-through' : 'none',
              }"
              @click="openSub(st)"
            >
              {{ st.title }}
            </span>
            <button
              class="icon-btn w-6 h-6 flex items-center justify-center rounded"
              :style="{ color: 'var(--text-tertiary)' }"
              title="删除子任务"
              @click="deleteSubTask(st)"
            >
              ✕
            </button>
          </div>
        </div>
        <div v-else class="text-xs" :style="{ color: 'var(--text-tertiary)' }">暂无子任务</div>
        <div class="flex gap-2 mt-2">
          <input
            v-model="newSubTaskTitle"
            type="text"
            placeholder="添加子任务..."
            class="flex-1 px-3 py-1.5 text-sm rounded-lg border outline-none transition-all duration-150"
            :style="{
              backgroundColor: 'var(--bg-app)',
              borderColor: 'var(--border-color)',
              color: 'var(--text-primary)',
            }"
            @keyup.enter="addSubTask"
          />
          <button
            class="px-3 py-1.5 text-sm rounded-lg font-medium transition-all duration-150"
            :style="{ backgroundColor: 'var(--color-accent-light)', color: 'var(--text-primary)' }"
            @click="addSubTask"
          >
            添加
          </button>
        </div>
      </div>
    </div>

    <!-- ===== 空状态（未选中任务时占位显示） ===== -->
    <div v-else class="flex-1 flex items-center justify-center">
      <div class="flex flex-col items-center gap-2 select-none">
        <span :style="{ color: 'var(--text-tertiary)' }">
          <AppIcon name="edit" :size="40" />
        </span>
        <p class="text-sm" :style="{ color: 'var(--text-tertiary)' }">选择一个任务查看详情</p>
      </div>
    </div>

    <!-- ===== 底部操作 ===== -->
    <div
      v-if="target"
      class="flex justify-between gap-2 px-4 py-3 border-t flex-shrink-0"
      :style="{ borderColor: 'var(--border-color)' }"
    >
      <button
        class="px-4 py-2 text-sm rounded-lg transition-all duration-150"
        :style="{ backgroundColor: 'var(--bg-hover)', color: '#e74c3c' }"
        @click="deleteFromDetail"
      >
        删除
      </button>
      <div class="flex gap-2">
        <button
          class="px-3 py-2 text-sm rounded-lg transition-all duration-150 flex items-center gap-1.5"
          :style="{ backgroundColor: 'var(--bg-hover)', color: 'var(--text-secondary)' }"
          title="感觉难？让小柴帮你拆解这个任务"
          @click="openCoach"
        >
          <AppIcon name="ai" :size="15" color="var(--text-secondary)" />
          问小柴
        </button>
        <button
          class="px-5 py-2 text-sm rounded-lg transition-all duration-150"
          :style="{
            backgroundColor: 'var(--color-accent-light)',
            color: 'var(--text-primary)',
            fontWeight: 500,
          }"
          @click="confirmEdit"
        >
          保存
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useTodoStore, sortWithHierarchy } from '../stores/todo'
import { useAiChatStore } from '../stores/ai-chat'
import { useSettingsStore } from '../stores/settings'
import { storeToRefs } from 'pinia'
import AppIcon from './icons/AppIcon.vue'

const todoStore = useTodoStore()
const aiChat = useAiChatStore()
const settingsStore = useSettingsStore()
const { todos, selectedTodoId } = storeToRefs(todoStore)

// 子任务排序方向与清单页共用同一设置
const sortOrder = computed(() => settingsStore.settings.ui.sortOrder)

// 窄屏浮层模式：由父组件传入（宽屏为右侧栏，窄屏全屏覆盖）
const props = defineProps<{ overlay?: boolean }>()
const overlay = computed(() => props.overlay ?? false)

// 当前编辑目标：优先内部切换（点击子任务），否则为全局选中任务
const overrideId = ref<string | null>(null)
const effectiveId = computed(() => overrideId.value ?? selectedTodoId.value)
const target = computed(() =>
  effectiveId.value ? todos.value.find(t => t.id === effectiveId.value) ?? null : null,
)

// 是否为笔记（kind=NOTE）：隐藏任务属性
const isNote = computed(() => target.value?.kind === 'NOTE')

// 编辑字段
const editTitle = ref('')
const editContent = ref('')
const editPriority = ref<0 | 1 | 3 | 5>(0)
const editDueDate = ref('')
const editStartDate = ref('')
const editTags = ref('')
const editCompleted = ref(false)
const editList = ref('')
const editCreatedAt = ref('')
const newSubTaskTitle = ref('')

const priorityOptions = [
  { value: 0, label: '无' },
  { value: 1, label: '低' },
  { value: 3, label: '中' },
  { value: 5, label: '高' },
] as const

function getPriorityBtnStyle(value: number, isSelected: boolean) {
  return {
    backgroundColor: isSelected ? 'var(--color-accent-light)' : 'var(--bg-hover)',
    color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
    fontWeight: isSelected ? '600' : '400',
    border: '1px solid ' + (isSelected ? 'var(--border-color)' : 'transparent'),
  }
}

// 目标变化时初始化编辑字段
watch(
  () => effectiveId.value,
  () => {
    if (target.value) initFields(target.value)
  },
  { immediate: true },
)

function initFields(todo: any) {
  editTitle.value = todo.title ?? ''
  editContent.value = todo.content ?? ''
  editPriority.value = (todo.priority ?? 0) as 0 | 1 | 3 | 5
  editDueDate.value = todo.dueDate ? todo.dueDate.slice(0, 10) : ''
  editStartDate.value = todo.startDate ? todo.startDate.slice(0, 10) : ''
  editTags.value = (todo.tags ?? []).join(', ')
  editCompleted.value = !!todo.completed
  editList.value = todo.list ?? ''
  editCreatedAt.value = todo.createdAt ?? ''
  newSubTaskTitle.value = ''
}

function close() {
  overrideId.value = null
  todoStore.closeDetail()
}

async function confirmEdit() {
  const t = target.value
  if (!t || !editTitle.value.trim()) return
  const updates: Record<string, any> = {
    title: editTitle.value.trim(),
    // 空内容传 null：真正清空 content
    content: editContent.value.trim() || null,
    priority: editPriority.value,
    dueDate: editDueDate.value ? new Date(editDueDate.value).toISOString() : undefined,
    startDate: editStartDate.value ? new Date(editStartDate.value).toISOString() : undefined,
    tags: editTags.value.split(/[,，]/).map(s => s.trim()).filter(Boolean),
    completed: editCompleted.value,
  }
  if (editCompleted.value && !t.completed) {
    updates.completedTime = new Date().toISOString()
  } else if (!editCompleted.value && t.completed) {
    updates.completedTime = undefined
  }
  await todoStore.updateTodo(t.id, updates)
  // 面板保留：保存后继续编辑
}

async function deleteFromDetail() {
  const t = target.value
  if (!t) return
  if (confirm('确定要删除这个任务吗？')) {
    await todoStore.removeTodo(t.id)
    close()
  }
}

// 子任务
const subTasks = computed(() => {
  const t = target.value
  if (!t) return []
  return sortWithHierarchy(todos.value.filter(x => x.parentId === t.id), sortOrder.value)
})

async function addSubTask() {
  const t = target.value
  if (!t || !newSubTaskTitle.value.trim()) return
  await todoStore.addTodo({
    title: newSubTaskTitle.value.trim(),
    priority: 0,
    // 继承父任务日期：保证子任务与父任务出现在同一视图
    dueDate: t.dueDate,
    startDate: t.startDate,
    parentId: t.id,
  })
  newSubTaskTitle.value = ''
}

async function deleteSubTask(st: any) {
  if (confirm('确定要删除这个子任务吗？')) {
    await todoStore.removeTodo(st.id)
  }
}

function openSub(st: any) {
  // 面板内切换到子任务详情
  overrideId.value = st.id
}

// 找小柴：携带当前任务打开聊天浮层（畏难/拆任务求助）
function openCoach() {
  const t = target.value
  if (!t) return
  aiChat.open(t.id)
}

function formatFullDate(dateStr: string) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return dateStr
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
</script>
