/**
 * 任务查询（视图过滤 + 层级排序）
 *
 * UI（HomePage / CompletedTodos）与外部助手（本地 API → CLI → DSH 插件）共用这一份语义，
 * 避免两处各写一套过滤规则、随后逐渐漂移。
 */

import { sortWithHierarchy, type Todo, type SortOrder } from '../stores/todo'

export type TaskView = 'inbox' | 'today' | 'next7' | 'completed' | 'all'

export interface TaskQuery {
  view?: TaskView
  /** 标题关键词（不区分大小写） */
  search?: string
  list?: string
  tag?: string
  parentId?: string
  /** 是否把笔记（kind=NOTE）也算进来；默认排除（笔记不属于任务域） */
  includeNotes?: boolean
  order?: SortOrder
  limit?: number
}

/** 本地日期字符串 YYYY-MM-DD（避免 UTC 跨日错位，与 UI 一致） */
export function toLocalDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 按视图过滤 + 层级排序。
 *
 * - today / next7：按截止日期过滤，**保留已完成**（由调用方分组），并让子任务跟随父任务
 *   （父任务命中时其后代一并显示，即使子任务自身没有日期——与 UI 行为一致）。
 * - inbox：未完成；completed：已完成；all：全部。
 * - 始终父任务在前、后代紧跟其后（sortWithHierarchy），方向由 order 决定。
 */
export function queryTasks(todos: Todo[], query: TaskQuery = {}): Todo[] {
  const view = query.view ?? 'inbox'
  const order = query.order ?? 'desc'

  let list = query.includeNotes ? todos.slice() : todos.filter(t => t.kind !== 'NOTE')

  const todayStr = toLocalDateStr(new Date())
  const next7 = new Date()
  next7.setDate(next7.getDate() + 7)
  const next7Str = toLocalDateStr(next7)

  let isDateView = false
  switch (view) {
    case 'today':
      isDateView = true
      list = list.filter(t => !!t.dueDate && t.dueDate.startsWith(todayStr))
      break
    case 'next7':
      isDateView = true
      list = list.filter(t => !!t.dueDate && t.dueDate >= todayStr && t.dueDate <= next7Str)
      break
    case 'completed':
      list = list.filter(t => t.completed)
      break
    case 'all':
      break
    default:
      list = list.filter(t => !t.completed)
  }

  if (query.search?.trim()) {
    const q = query.search.trim().toLowerCase()
    list = list.filter(t => t.title.toLowerCase().includes(q))
  }
  if (query.list) list = list.filter(t => t.list === query.list)
  if (query.tag) list = list.filter(t => (t.tags ?? []).includes(query.tag as string))
  if (query.parentId) list = list.filter(t => t.parentId === query.parentId)

  // 日期视图：子任务跟随父任务（递归展开后代）
  if (isDateView) {
    const ids = new Set(list.map(t => t.id))
    let changed = true
    while (changed) {
      changed = false
      for (const t of todos) {
        if (t.parentId && ids.has(t.parentId) && !ids.has(t.id)) {
          ids.add(t.id)
          list.push(t)
          changed = true
        }
      }
    }
  }

  const sorted = sortWithHierarchy(list, order)
  return query.limit && query.limit > 0 ? sorted.slice(0, query.limit) : sorted
}

// ============ 笔记（kind = NOTE） ============

export interface NoteQuery {
  /** true=已归档（App 里归档 = 标记完成）；false=未归档；'all'=全部。默认 false */
  archived?: boolean | 'all'
  /** 关键词：匹配标题 + 内容 */
  search?: string
  limit?: number
}

/**
 * 笔记查询（与 NotesView 语义一致）：
 * - 未归档按创建时间倒序；已归档按「归档时间（completedTime）→ 创建时间」倒序
 * - 笔记没有父子关系，不参与层级排序
 */
export function queryNotes(todos: Todo[], query: NoteQuery = {}): Todo[] {
  let list = todos.filter(t => t.kind === 'NOTE')
  if (query.archived === true) list = list.filter(t => t.completed)
  else if (query.archived !== 'all') list = list.filter(t => !t.completed)

  if (query.search?.trim()) {
    const q = query.search.trim().toLowerCase()
    list = list.filter(t =>
      t.title.toLowerCase().includes(q) || (t.content ?? '').toLowerCase().includes(q))
  }

  const timeKey = (t: Todo) => (query.archived === true ? (t.completedTime || t.createdAt) : t.createdAt) || ''
  const sorted = list.slice().sort((a, b) => timeKey(b).localeCompare(timeKey(a)))
  const limit = query.limit && query.limit > 0 ? query.limit : 200
  return sorted.slice(0, limit)
}
