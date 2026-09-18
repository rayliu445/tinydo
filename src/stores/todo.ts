import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getDataAccess } from '../services/data-access'
import type { CRDTTodo } from '../services/crdt-doc'
import { getSyncEngine } from '../services/sync-engine'

// Todo类型定义（保持向前兼容，与 CRDTTodo 等价）
export type Todo = CRDTTodo

/** 排序方向：desc = 新的在前（默认）；asc = 旧的在前 */
export type SortOrder = 'asc' | 'desc'

/**
 * 层级排序：每一层都按创建时间排序，且每个任务后紧跟其后代（子任务、孙任务…），
 * 保证父任务永远在子任务上方。用于列表/已完成/搜索视图。
 *
 * - order = 'desc'（默认）：新的在前，顶层与每一级子任务都是「新 → 旧」
 * - order = 'asc'：旧的在前，顶层与每一级子任务都是「旧 → 新」
 *
 * 创建时间相同（同一毫秒批量创建）时用 id 兜底比较：id 由时间戳 + 随机后缀生成，
 * 与创建顺序一致，避免 SQLite 对并列行顺序不保证导致同批子任务乱序。
 */
export function sortWithHierarchy<T extends { id: string; parentId?: string; createdAt?: string }>(
  list: T[],
  order: SortOrder = 'desc',
): T[] {
  const sign = order === 'asc' ? 1 : -1
  const sorted = list.slice().sort((a, b) => {
    const ta = a.createdAt || ''
    const tb = b.createdAt || ''
    if (ta !== tb) return (ta < tb ? -1 : 1) * sign
    if (a.id !== b.id) return (a.id < b.id ? -1 : 1) * sign
    return 0
  })
  const byId = new Map(sorted.map(t => [t.id, t]))
  const children = new Map<string, T[]>()
  const roots: T[] = []
  for (const t of sorted) {
    if (t.parentId && byId.has(t.parentId)) {
      const arr = children.get(t.parentId) ?? []
      arr.push(t)
      children.set(t.parentId, arr)
    } else {
      roots.push(t)
    }
  }
  const result: T[] = []
  // 递归：顶层任务后紧跟其所有后代（子任务、孙任务…），保证父在子上方
  const pushTree = (id: string) => {
    const subs = children.get(id)
    if (subs) {
      for (const s of subs) {
        result.push(s)
        pushTree(s.id)
      }
    }
  }
  for (const root of roots) {
    result.push(root)
    pushTree(root.id)
  }
  return result
}

// 数据层变化订阅标记（避免重复订阅）
let syncRefreshSubscribed = false

export const useTodoStore = defineStore('todo', () => {
  // 状态
  const todos = ref<Todo[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  // 延迟获取数据访问层实例（可能在初始化之前被调用）
  function getOrInitDataAccess() {
    try {
      return getDataAccess()
    } catch {
      return null
    }
  }

  // 从数据层刷新 todos
  function refreshTodos() {
    const da = getOrInitDataAccess()
    if (!da) return
    todos.value = da.getTodos() as Todo[]
  }

  // 获取所有待办事项
  async function fetchTodos() {
    loading.value = true
    error.value = null
    
    try {
      const da = getOrInitDataAccess()
      if (da) {
        // 订阅数据层变化：云端同步拉取 / 数据导入后自动刷新界面
        if (!syncRefreshSubscribed) {
          syncRefreshSubscribed = true
          da.onChange(() => { refreshTodos() })
        }
        refreshTodos()
      }
    } catch (err) {
      console.error('获取待办事项失败:', err)
      error.value = err instanceof Error ? err.message : '获取待办事项失败'
    } finally {
      loading.value = false
    }
  }

  // 获取数据访问层（安全）
  function getDA() {
    const da = getOrInitDataAccess()
    if (!da) throw new Error('DataAccess not initialized yet')
    return da
  }

  // 添加待办事项（支持完整字段；kind='NOTE' 时为笔记，不作为任务条目）
  async function addTodo(data: { title: string; completed?: boolean; priority?: Todo['priority']; dueDate?: string; startDate?: string; content?: string; tags?: string[]; list?: string; isAllDay?: boolean; parentId?: string; sourceId?: string; kind?: 'TASK' | 'NOTE' }) {
    loading.value = true
    error.value = null
    
    try {
      const da = getDA()
      const newTodo = da.addTodo({
        title: data.title,
        completed: data.completed ?? false,
        priority: data.priority ?? 0,
        dueDate: data.dueDate,
        startDate: data.startDate,
        content: data.content,
        tags: data.tags,
        list: data.list,
        isAllDay: data.isAllDay,
        parentId: data.parentId,
        sourceId: data.sourceId,
        kind: data.kind ?? 'TASK',
        createdAt: new Date().toISOString(),
      })
      
      refreshTodos()
      
      // 触发同步
      getSyncEngine().scheduleWrite()
      
      return newTodo
    } catch (err) {
      console.error('添加待办事项失败:', err)
      error.value = err instanceof Error ? err.message : '添加待办事项失败'
      return null
    } finally {
      loading.value = false
    }
  }

  // 更新待办事项
  async function updateTodo(id: string, updates: Partial<Todo>) {
    loading.value = true
    error.value = null
    
    try {
      const da = getDA()
      da.updateTodo(id, updates)
      refreshTodos()
      getSyncEngine().scheduleWrite()
    } catch (err) {
      console.error('更新待办事项失败:', err)
      error.value = err instanceof Error ? err.message : '更新待办事项失败'
    } finally {
      loading.value = false
    }
  }

  // 切换待办事项完成状态
  // 级联规则：父任务完成/取消完成时，所有子任务同步（递归）；子任务单独操作不影响父任务
  async function toggleTodo(id: string) {
    try {
      const todo = todos.value.find((t) => t.id === id)
      if (!todo) return
      const da = getDA()
      const newCompleted = !todo.completed
      const completedTime = newCompleted ? new Date().toISOString() : null

      // 收集所有后代子任务 id（递归，支持多级父子）
      const descendantIds: string[] = []
      const collect = (pid: string) => {
        for (const t of todos.value) {
          if (t.parentId === pid) {
            descendantIds.push(t.id)
            collect(t.id)
          }
        }
      }
      collect(id)

      // 更新父任务本身
      da.updateTodo(id, { completed: newCompleted, completedTime } as any)
      // 级联更新子任务（父任务勾选完成 → 子任务一起完成；取消完成 → 一起取消）
      for (const cid of descendantIds) {
        da.updateTodo(cid, { completed: newCompleted, completedTime } as any)
      }
      refreshTodos()
      getSyncEngine().scheduleWrite()
    } catch (err) {
      console.error('切换待办事项失败:', err)
    }
  }

  // 删除待办事项（软删除 tombstone，便于同步删除传播）
  // - 标记 deleted=true 而不是物理删除：云端仍保留该任务时，
  //   物理删除会导致 LWW 合并把它“复活”。tombstone 会把删除同步到所有端。
  // - 删除父任务时级联删除所有后代子任务，避免产生孤立子任务。
  async function removeTodo(id: string) {
    loading.value = true
    error.value = null
    
    try {
      const da = getDA()
      // 级联收集所有后代（递归）
      const ids = [id]
      const collect = (pid: string) => {
        for (const t of todos.value) {
          if (t.parentId === pid) {
            ids.push(t.id)
            collect(t.id)
          }
        }
      }
      collect(id)
      // 标记软删除（deleted + updatedAt 更新，同步时 tombstone 传播）
      for (const i of ids) {
        da.updateTodo(i, { deleted: true } as any)
      }
      refreshTodos()
      getSyncEngine().scheduleWrite()

      todos.value = todos.value.filter((todo) => !ids.includes(todo.id))
    } catch (err) {
      console.error('删除待办事项失败:', err)
      error.value = err instanceof Error ? err.message : '删除待办事项失败'
    } finally {
      loading.value = false
    }
  }

  // 获取已完成的待办事项
  const completedTodos = computed(() => {
    return todos.value.filter((todo) => todo.completed)
  })

  // 获取未完成的待办事项
  const pendingTodos = computed(() => {
    return todos.value.filter((todo) => !todo.completed)
  })

  // 批量添加待办事项（用于导入）
  // 幂等逻辑：
  // - 按 sourceId（TickTick taskId）优先匹配，其次按标题匹配
  // - 已存在则补齐缺失字段（如内容/父子关系），不存在才新增
  // - 支持子任务关联：parentId（TickTick 父 taskId）→ 本地父任务 id
  async function bulkAddTodos(items: Array<{ title: string; completed?: boolean; priority?: Todo['priority']; dueDate?: string; startDate?: string; content?: string; tags?: string[]; list?: string; isAllDay?: boolean; createdAt?: string; completedTime?: string; taskId?: string; parentId?: string; kind?: 'TASK' | 'NOTE' }>) {
    loading.value = true
    error.value = null
    let successCount = 0

    try {
      const da = getDA()
      const existing = da.getTodos()

      // 索引：sourceId → todo；title → todo
      const bySource = new Map<string, Todo>()
      const byTitle = new Map<string, Todo>()
      for (const t of existing) {
        if (t.sourceId) bySource.set(t.sourceId, t)
        const key = (t.title || '').trim()
        if (key && !byTitle.has(key)) byTitle.set(key, t)
      }

      // 第一遍：为每条记录确定本地 id（新增分配新 id，已存在用现有 id），
      // 并注册 taskId → 本地 id 映射（供 parentId 关联解析）
      const resolved: Array<{ id: string; item: any; isNew: boolean }> = []
      const taskIdToLocalId = new Map<string, string>()

      for (const raw of items) {
        const item = raw as any
        const title = (item.title || '').trim()
        if (!title) continue
        const sourceId = (item.taskId || '').trim()

        let found: Todo | undefined
        if (sourceId && bySource.has(sourceId)) {
          found = bySource.get(sourceId)
        } else {
          found = byTitle.get(title)
        }

        if (found && found.id && found.id !== 'pending') {
          resolved.push({ id: found.id, item, isNew: false })
        } else {
          const newId = `todo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${resolved.length}`
          resolved.push({ id: newId, item, isNew: true })
          // 防止同一批导入中重复标题被重复添加
          if (title) byTitle.set(title, { id: 'pending', title } as Todo)
        }
        if (sourceId) taskIdToLocalId.set(sourceId, resolved[resolved.length - 1].id)
      }

      // 第二遍：解析 parentId（TickTick 父 taskId → 本地父任务 id）
      const resolveParentId = (item: any): string | undefined => {
        const p = (item.parentId || '').trim()
        if (!p) return undefined
        return taskIdToLocalId.get(p)
      }

      // 1. 新增（使用批量 API：一次性插入，仅触发一次 onChange 刷新。
      //    注意：不能逐条调用 da.addTodo()——每次都会 notify() → refreshTodos()
      //    全量查询 + 整体替换 todos.value，1000+ 条时会导致 UI 卡死。）
      const toAdd = resolved.filter(r => r.isNew)
      if (toAdd.length > 0) {
        // 必须传入分配的 id（r.id），否则 SQLite 会重新生成随机 id，
        // 导致子任务的 parentId 指向不存在的逻辑 id，父子关联断裂。
        da.bulkAddTodos(toAdd.map(r => ({
          id: r.id,
          title: r.item.title,
          completed: r.item.completed ?? false,
          priority: r.item.priority ?? 0,
          dueDate: r.item.dueDate,
          startDate: r.item.startDate,
          content: r.item.content,
          tags: r.item.tags,
          list: r.item.list,
          isAllDay: r.item.isAllDay,
          completedTime: r.item.completedTime,
          createdAt: r.item.createdAt || new Date().toISOString(),
          parentId: resolveParentId(r.item),
          sourceId: (r.item.taskId || '').trim() || undefined,
          kind: r.item.kind === 'NOTE' ? 'NOTE' : 'TASK',
        })))
      }

      // 2. 补齐已存在任务的缺失字段（幂等：只补空字段，不覆盖已有值）
      const toUpdate = resolved.filter(r => !r.isNew)
      for (const { id, item } of toUpdate) {
        const current = da.getTodoById(id)
        if (!current) continue
        const updates: Record<string, any> = {}
        if (!current.content && item.content) updates.content = item.content
        if (!current.dueDate && item.dueDate) updates.dueDate = item.dueDate
        if (!current.startDate && item.startDate) updates.startDate = item.startDate
        if (!current.priority && item.priority) updates.priority = item.priority
        if (!current.list && item.list) updates.list = item.list
        if ((!current.tags || current.tags.length === 0) && Array.isArray(item.tags) && item.tags.length > 0) updates.tags = item.tags
        const src = (item.taskId || '').trim()
        if (src && !current.sourceId) updates.sourceId = src
        if (!current.parentId) {
          const pid = resolveParentId(item)
          if (pid) updates.parentId = pid
        }
        // kind 单向升级：CSV 明确标注 NOTE 时，已有任务可转为笔记；
        // 但不降级（笔记不会被导回任务），避免导入误覆盖手动修改
        if (item.kind === 'NOTE' && current.kind !== 'NOTE') updates.kind = 'NOTE'
        if (Object.keys(updates).length > 0) {
          da.updateTodo(id, updates)
        }
      }

      successCount = resolved.length
      refreshTodos()
      getSyncEngine().scheduleWrite()
    } catch (err) {
      console.error('批量导入失败:', err)
      error.value = err instanceof Error ? err.message : '批量导入失败'
    } finally {
      loading.value = false
    }

    return { success: successCount, total: items.length }
  }

  // 按日期范围获取待办事项
  function getTodosByDateRange(start: string, end: string) {
    return todos.value.filter((todo) => {
      if (!todo.dueDate) return false
      return todo.dueDate >= start && todo.dueDate <= end
    })
  }

  // 按优先级获取待办事项
  function getTodosByPriority(priority: Todo['priority']) {
    return todos.value.filter((todo) => todo.priority === priority)
  }

  // ============ 详情选中状态（右侧第四列详情面板） ============
  // 在任意视图点击任务，都在右侧面板展示详情（替代弹窗）
  const selectedTodoId = ref<string | null>(null)

  function openDetail(id: string) {
    selectedTodoId.value = id
  }

  function closeDetail() {
    selectedTodoId.value = null
  }

  // ============ 类型转化（任务 ↔ 笔记） ============
  // 笔记不关联子任务：转笔记时解除自身父任务关系与所有子任务关系
  async function convertKind(id: string, kind: 'TASK' | 'NOTE') {
    try {
      const da = getDA()
      const todo = todos.value.find(t => t.id === id)
      if (!todo || todo.kind === kind) return
      const updates: Record<string, any> = { kind }
      if (kind === 'NOTE') {
        // 解除自身父任务关系
        if (todo.parentId) updates.parentId = null
        // 解除所有子任务关系（后代成为独立任务，避免笔记下隐藏子任务）
        const children = todos.value.filter(t => t.parentId === id)
        for (const c of children) {
          da.updateTodo(c.id, { parentId: null } as any)
        }
      }
      da.updateTodo(id, updates)
      refreshTodos()
      getSyncEngine().scheduleWrite()
    } catch (err) {
      console.error('类型转化失败:', err)
    }
  }

  // ============ 归档（笔记归档 = 标记已完成，归档日期为当天） ============
  async function setArchived(id: string, archived: boolean) {
    try {
      const da = getDA()
      const todo = todos.value.find(t => t.id === id)
      if (!todo) return
      const updates: Record<string, any> = { completed: archived }
      if (archived) {
        // 归档日期 = 今天（completedTime）
        updates.completedTime = new Date().toISOString()
      } else {
        // 恢复归档：取消完成
        updates.completedTime = null
      }
      da.updateTodo(id, updates)
      refreshTodos()
      getSyncEngine().scheduleWrite()
    } catch (err) {
      console.error('归档操作失败:', err)
    }
  }

  return {
    todos,
    loading,
    error,
    fetchTodos,
    addTodo,
    updateTodo,
    toggleTodo,
    removeTodo,
    bulkAddTodos,
    getTodosByDateRange,
    getTodosByPriority,
    completedTodos,
    pendingTodos,
    selectedTodoId,
    openDetail,
    closeDetail,
    convertKind,
    setArchived,
  }
})