/**
 * 外部助手本地桥接（渲染层）
 *
 * 主进程收到 HTTP 请求 → IPC → 这里 → 调用现有 store（业务语义与 UI 点击完全一致）：
 * 级联完成、级联软删除、updatedAt、云同步、UI 实时刷新都自动生效。
 *
 * 这一层只做「参数校验 + 路由 + 审计摘要」，不复制任何业务逻辑。
 */

import { useTodoStore, type Todo } from '../stores/todo'
import { useSettingsStore } from '../stores/settings'
import { queryTasks, type TaskView } from './task-query'

export interface LocalApiRequest {
  id: string
  method: string
  path: string
  query: Record<string, string>
  body: any
  actor: string
}

export interface LocalApiAudit {
  action: string
  taskIds: string[]
  summary: string
  ok: boolean
}

export interface LocalApiResponse {
  status: number
  body: any
  audit?: LocalApiAudit
}

// ============ 数据层就绪 ============

let resolveReady: (() => void) | null = null
const readyPromise = new Promise<void>((resolve) => { resolveReady = resolve })

/** 由 main.ts 在数据层初始化完成后调用 */
export function markLocalApiDataReady(): void {
  resolveReady?.()
  resolveReady = null
}

export function isLocalApiDataReady(): boolean {
  return resolveReady === null
}

// ============ 工具 ============

const PRIORITY_LABEL: Record<number, string> = { 0: '无', 1: '低', 3: '中', 5: '高' }
const VALID_PRIORITIES = [0, 1, 3, 5]

function ok(body: any, audit?: LocalApiAudit): LocalApiResponse {
  return audit ? { status: 200, body, audit } : { status: 200, body }
}

function fail(status: number, code: string, message: string): LocalApiResponse {
  return { status, body: { error: { code, message } } }
}

function toDto(t: Todo) {
  return {
    id: t.id,
    title: t.title,
    completed: !!t.completed,
    priority: t.priority ?? 0,
    dueDate: t.dueDate ?? null,
    startDate: t.startDate ?? null,
    parentId: t.parentId ?? null,
    list: t.list ?? null,
    // 复制一层：store 里的 tasks 是 Vue 响应式代理，直接回传无法被 IPC 结构化克隆
    tags: Array.isArray(t.tags) ? [...t.tags] : [],
    content: t.content ?? null,
    kind: t.kind ?? 'TASK',
    createdAt: t.createdAt,
    updatedAt: t.updatedAt ?? null,
    completedTime: t.completedTime ?? null,
    sourceId: t.sourceId ?? null,
  }
}

/** 日期归一化：返回 ISO 字符串；null 表示清空；undefined 表示非法 */
function normalizeDate(value: unknown): string | null | undefined {
  if (value === null || value === '') return null
  if (typeof value !== 'string') return undefined
  const s = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(s)) return undefined
  const d = new Date(s)
  if (isNaN(d.getTime())) return undefined
  return d.toISOString()
}

function normalizePriority(value: unknown): number | undefined {
  const n = Number(value)
  return VALID_PRIORITIES.includes(n) ? n : undefined
}

function normalizeTags(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(/[,，]/).map(s => s.trim()).filter(Boolean)
  return undefined
}

function ymd(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : '（空）'
}

function collectDescendants(todos: Todo[], id: string): string[] {
  const out: string[] = []
  const walk = (pid: string) => {
    for (const t of todos) {
      if (t.parentId === pid) {
        out.push(t.id)
        walk(t.id)
      }
    }
  }
  walk(id)
  return out
}

function findTask(id: string): Todo | undefined {
  return (useTodoStore().todos as Todo[]).find(t => t.id === id)
}

// ============ 各操作 ============

function listTasks(q: Record<string, string>): LocalApiResponse {
  const { todos } = useTodoStore()
  const settings = useSettingsStore()
  const view = (q.view || 'inbox') as TaskView
  if (!['inbox', 'today', 'next7', 'completed', 'all'].includes(view)) {
    return fail(400, 'BAD_REQUEST', `view 取值非法：${q.view}（可用 inbox/today/next7/completed/all）`)
  }
  const limit = q.limit ? Number(q.limit) : 200
  if (q.limit && (!Number.isFinite(limit) || limit <= 0)) {
    return fail(400, 'BAD_REQUEST', `limit 非法：${q.limit}`)
  }
  const tasks = queryTasks(todos as Todo[], {
    view,
    search: q.search,
    list: q.list,
    tag: q.tag,
    parentId: q.parentId,
    includeNotes: q.includeNotes === '1',
    order: settings.settings.ui.sortOrder,
    limit: Math.min(limit, 1000),
  })
  return ok({ tasks: tasks.map(toDto), total: tasks.length, view, order: settings.settings.ui.sortOrder })
}

function getTask(id: string): LocalApiResponse {
  const { todos } = useTodoStore()
  const settings = useSettingsStore()
  const task = findTask(id)
  if (!task) return fail(404, 'TASK_NOT_FOUND', `任务不存在：${id}`)
  const children = queryTasks((todos as Todo[]).filter(t => t.parentId === id), {
    view: 'all',
    order: settings.settings.ui.sortOrder,
  })
  return ok({ task: toDto(task), children: children.map(toDto) })
}

async function createTask(body: any, actor: string): Promise<LocalApiResponse> {
  const todoStore = useTodoStore()
  const title = typeof body?.title === 'string' ? body.title.trim() : ''
  if (!title) return fail(400, 'BAD_REQUEST', 'title 不能为空')
  if (title.length > 500) return fail(400, 'BAD_REQUEST', 'title 过长（上限 500 字）')

  const priority = body.priority === undefined ? 0 : normalizePriority(body.priority)
  if (priority === undefined) return fail(400, 'BAD_REQUEST', `priority 取值非法：${body.priority}（可用 0/1/3/5）`)

  // 未传的字段保持 undefined（不写库）；传了才校验，非法直接 400
  let dueDate: string | null | undefined
  if (body.dueDate !== undefined) {
    dueDate = normalizeDate(body.dueDate)
    if (dueDate === undefined) return fail(400, 'BAD_REQUEST', `dueDate 非法：${body.dueDate}（用 YYYY-MM-DD）`)
  }
  let startDate: string | null | undefined
  if (body.startDate !== undefined) {
    startDate = normalizeDate(body.startDate)
    if (startDate === undefined) return fail(400, 'BAD_REQUEST', `startDate 非法：${body.startDate}`)
  }

  const tags = normalizeTags(body.tags)
  if (body.tags !== undefined && tags === undefined) return fail(400, 'BAD_REQUEST', 'tags 需为数组或逗号分隔字符串')

  let parentId: string | undefined
  if (body.parentId) {
    const parent = findTask(String(body.parentId))
    if (!parent) return fail(400, 'BAD_REQUEST', `父任务不存在：${body.parentId}`)
    parentId = parent.id
  }

  const sourceId = typeof body.sourceId === 'string' && body.sourceId.trim() ? body.sourceId.trim() : undefined
  if (sourceId) {
    const existing = (todoStore.todos as Todo[]).find(t => t.sourceId === sourceId && !t.deleted)
    if (existing) return ok({ task: toDto(existing), deduped: true })
  }

  const created = await todoStore.addTodo({
    title,
    priority: priority as Todo['priority'],
    dueDate: dueDate ?? undefined,
    startDate: startDate ?? undefined,
    content: typeof body.content === 'string' ? body.content : undefined,
    tags,
    list: typeof body.list === 'string' ? body.list : undefined,
    parentId,
    sourceId,
    kind: 'TASK',
  })
  if (!created) return fail(500, 'INTERNAL', '新增失败（数据层未就绪）')

  const parent = parentId ? findTask(parentId) : undefined
  return ok(
    { task: toDto(created as Todo), deduped: false },
    {
      action: 'add_task',
      taskIds: [(created as Todo).id],
      summary: parent
        ? `${actor} 在「${parent.title}」下新增子任务「${title}」`
        : `${actor} 新增任务「${title}」`,
      ok: true,
    },
  )
}

async function updateTask(id: string, body: any): Promise<LocalApiResponse> {
  const todoStore = useTodoStore()
  const before = findTask(id)
  if (!before) return fail(404, 'TASK_NOT_FOUND', `任务不存在：${id}`)

  const updates: Record<string, any> = {}
  const changed: string[] = []

  if (body.title !== undefined) {
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    if (!title) return fail(400, 'BAD_REQUEST', 'title 不能为空')
    if (title !== before.title) { updates.title = title; changed.push(`title: ${before.title} → ${title}`) }
  }
  if (body.priority !== undefined) {
    const priority = normalizePriority(body.priority)
    if (priority === undefined) return fail(400, 'BAD_REQUEST', `priority 取值非法：${body.priority}`)
    if (priority !== before.priority) {
      updates.priority = priority
      changed.push(`priority: ${PRIORITY_LABEL[before.priority] ?? before.priority} → ${PRIORITY_LABEL[priority]}`)
    }
  }
  for (const [field, key] of [['dueDate', 'dueDate'], ['startDate', 'startDate']] as const) {
    if (body[field] === undefined) continue
    const next = normalizeDate(body[field])
    if (next === undefined) return fail(400, 'BAD_REQUEST', `${field} 非法：${body[field]}`)
    const prev = (before as any)[key] ?? null
    if (next !== prev) { updates[key] = next; changed.push(`${field}: ${ymd(prev)} → ${ymd(next)}`) }
  }
  if (body.content !== undefined) {
    const content = typeof body.content === 'string' ? body.content : null
    if (content !== (before.content ?? null)) { updates.content = content; changed.push('content 已更新') }
  }
  if (body.tags !== undefined) {
    const tags = normalizeTags(body.tags)
    if (tags === undefined) return fail(400, 'BAD_REQUEST', 'tags 需为数组或逗号分隔字符串')
    if (JSON.stringify(tags) !== JSON.stringify(before.tags ?? [])) {
      updates.tags = tags
      changed.push(`tags: ${(before.tags ?? []).join('/') || '（空）'} → ${tags.join('/') || '（空）'}`)
    }
  }
  if (body.list !== undefined) {
    const list = body.list === null ? null : String(body.list)
    if (list !== (before.list ?? null)) { updates.list = list; changed.push('list 已更新') }
  }
  if (body.parentId !== undefined) {
    if (body.parentId === null || body.parentId === '') {
      if (before.parentId) { updates.parentId = null; changed.push('已移出父任务') }
    } else {
      const parent = findTask(String(body.parentId))
      if (!parent) return fail(400, 'BAD_REQUEST', `父任务不存在：${body.parentId}`)
      if (parent.id === id) return fail(400, 'BAD_REQUEST', '不能把任务挂到自己下面')
      if (before.parentId !== parent.id) { updates.parentId = parent.id; changed.push(`父任务 → 「${parent.title}」`) }
    }
  }
  if (typeof body.completed === 'boolean' && body.completed !== before.completed) {
    updates.completed = body.completed
    updates.completedTime = body.completed ? new Date().toISOString() : null
    changed.push(body.completed ? '标记完成' : '取消完成')
  }

  if (changed.length === 0) return ok({ task: toDto(before), changed: [] })

  await todoStore.updateTodo(id, updates as Partial<Todo>)
  const after = findTask(id)
  return ok(
    { task: after ? toDto(after) : null, changed },
    { action: 'update_task', taskIds: [id], summary: `${before.title}：${changed.join('；')}`, ok: true },
  )
}

async function completeTask(id: string, body: any): Promise<LocalApiResponse> {
  const todoStore = useTodoStore()
  const task = findTask(id)
  if (!task) return fail(404, 'TASK_NOT_FOUND', `任务不存在：${id}`)
  const target = typeof body?.completed === 'boolean' ? body.completed : true
  const descendants = collectDescendants(todoStore.todos as Todo[], id)

  if (task.completed === target) {
    return ok({ task: toDto(task), affected: [id, ...descendants], changed: false })
  }
  await todoStore.toggleTodo(id) // 与 UI 勾选一致：级联所有后代
  const after = findTask(id)
  return ok(
    { task: after ? toDto(after) : null, affected: [id, ...descendants], changed: true },
    {
      action: target ? 'complete_task' : 'uncomplete_task',
      taskIds: [id, ...descendants],
      summary: `${target ? '完成' : '取消完成'}「${task.title}」${descendants.length ? `（含 ${descendants.length} 个子任务）` : ''}`,
      ok: true,
    },
  )
}

async function deleteTask(id: string): Promise<LocalApiResponse> {
  const todoStore = useTodoStore()
  const task = findTask(id)
  if (!task) return fail(404, 'TASK_NOT_FOUND', `任务不存在：${id}`)
  const descendants = collectDescendants(todoStore.todos as Todo[], id)

  await todoStore.removeTodo(id) // 软删除 + 级联后代
  return ok(
    { deleted: [id, ...descendants] },
    {
      action: 'delete_task',
      taskIds: [id, ...descendants],
      summary: `删除「${task.title}」${descendants.length ? `（含 ${descendants.length} 个子任务）` : ''}`,
      ok: true,
    },
  )
}

async function bulkTasks(body: any, actor: string): Promise<LocalApiResponse> {
  const items = Array.isArray(body?.items) ? body.items : null
  if (!items) return fail(400, 'BAD_REQUEST', 'items 需为数组')
  if (items.length === 0) return fail(400, 'BAD_REQUEST', 'items 不能为空')
  if (items.length > 50) return fail(400, 'BAD_REQUEST', `单次批量上限 50 条（收到 ${items.length}）`)

  const dryRun = body?.dryRun === true
  const results: Array<{ index: number; id?: string; deduped?: boolean; error?: string; title?: string }> = []
  const createdIds: string[] = []

  for (let i = 0; i < items.length; i++) {
    const item = items[i] ?? {}
    if (dryRun) {
      const title = typeof item.title === 'string' ? item.title.trim() : ''
      if (!title) results.push({ index: i, error: 'title 不能为空' })
      else results.push({ index: i, title, deduped: false })
      continue
    }
    const res = await createTask(item, actor)
    if (res.status !== 200) {
      results.push({ index: i, error: res.body?.error?.message ?? '失败' })
      continue
    }
    const id = res.body?.task?.id
    results.push({ index: i, id, deduped: !!res.body?.deduped, title: res.body?.task?.title })
    if (id && !res.body?.deduped) createdIds.push(id)
  }

  const failed = results.filter(r => r.error).length
  return ok(
    { results, created: createdIds.length, failed, dryRun },
    dryRun
      ? undefined
      : {
          action: 'bulk_add_tasks',
          taskIds: createdIds,
          summary: `${actor} 批量新增 ${createdIds.length} 条${failed ? `（${failed} 条失败）` : ''}`,
          ok: failed === 0,
        },
  )
}

function stats(): LocalApiResponse {
  const { todos } = useTodoStore()
  const tasks = (todos as Todo[]).filter(t => t.kind !== 'NOTE')
  const todayStr = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const today = `${todayStr.getFullYear()}-${pad(todayStr.getMonth() + 1)}-${pad(todayStr.getDate())}`
  const next7Date = new Date()
  next7Date.setDate(next7Date.getDate() + 7)
  const next7 = `${next7Date.getFullYear()}-${pad(next7Date.getMonth() + 1)}-${pad(next7Date.getDate())}`

  const pending = tasks.filter(t => !t.completed)
  const byPriority: Record<string, number> = { 0: 0, 1: 0, 3: 0, 5: 0 }
  const byList: Record<string, number> = {}
  for (const t of pending) {
    byPriority[String(t.priority ?? 0)] = (byPriority[String(t.priority ?? 0)] ?? 0) + 1
    const key = t.list || '（无清单）'
    byList[key] = (byList[key] ?? 0) + 1
  }
  return ok({
    pending: pending.length,
    completed: tasks.length - pending.length,
    today: pending.filter(t => t.dueDate?.startsWith(today)).length,
    next7: pending.filter(t => !!t.dueDate && t.dueDate >= today && t.dueDate <= next7).length,
    overdue: pending.filter(t => !!t.dueDate && t.dueDate.slice(0, 10) < today).length,
    byPriority,
    byList,
    notes: (todos as Todo[]).filter(t => t.kind === 'NOTE').length,
    topLevelPending: pending.filter(t => !t.parentId).length,
  })
}

// ============ 路由 ============

export async function handleLocalApiRequest(req: LocalApiRequest): Promise<LocalApiResponse> {
  const settingsStore = useSettingsStore()
  if (settingsStore.settings.externalAgent?.enabled === false) {
    return fail(403, 'DISABLED', '外部助手已在 TinyDo「设置 → 外部助手」里关闭')
  }

  // 数据层可能还在初始化（刚启动）：最多等 8 秒
  if (!isLocalApiDataReady()) {
    const timedOut = await Promise.race([
      readyPromise.then(() => false),
      new Promise<boolean>(resolve => setTimeout(() => resolve(true), 8000)),
    ])
    if (timedOut) return fail(503, 'DATA_NOT_READY', 'TinyDo 数据层尚未就绪，请稍后重试')
  }

  const segments = req.path.replace(/^\/+|\/+$/g, '').split('/')
  const actor = req.actor || 'external'

  try {
    // GET /v1/tasks
    if (req.method === 'GET' && segments.join('/') === 'v1/tasks') {
      return listTasks(req.query)
    }
    // POST /v1/tasks
    if (req.method === 'POST' && segments.join('/') === 'v1/tasks') {
      return await createTask(req.body ?? {}, actor)
    }
    // POST /v1/tasks/bulk
    if (req.method === 'POST' && segments.join('/') === 'v1/tasks/bulk') {
      return await bulkTasks(req.body ?? {}, actor)
    }
    // GET /v1/stats
    if (req.method === 'GET' && segments.join('/') === 'v1/stats') {
      return stats()
    }
    // /v1/tasks/:id
    if (segments[0] === 'v1' && segments[1] === 'tasks' && segments[2]) {
      const id = decodeURIComponent(segments[2])
      if (segments.length === 3 && req.method === 'GET') return getTask(id)
      if (segments.length === 3 && (req.method === 'PATCH' || req.method === 'PUT')) {
        return await updateTask(id, req.body ?? {})
      }
      if (segments.length === 3 && req.method === 'DELETE') return await deleteTask(id)
      if (segments.length === 4 && segments[3] === 'complete' && req.method === 'POST') {
        return await completeTask(id, req.body ?? {})
      }
    }
    return fail(404, 'NOT_FOUND', `未知接口：${req.method} /${segments.join('/')}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[LocalAPI] 处理失败:', err)
    return fail(500, 'INTERNAL', `执行失败：${message}`)
  }
}
