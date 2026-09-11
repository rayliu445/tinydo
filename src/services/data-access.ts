/**
 * 数据访问层
 *
 * 基于 SQLite (sql.js) 的持久化存储，跨平台统一。
 * 架构: SQLite (内存) → db.export() → Uint8Array → IndexedDB
 */

import { TodoDatabase } from './sqlite-db'

export interface Todo {
  id: string
  title: string
  completed: boolean
  createdAt: string
  priority: 0 | 1 | 3 | 5
  dueDate?: string
  startDate?: string
  content?: string
  tags?: string[]
  list?: string
  isAllDay?: boolean
  completedTime?: string
  updatedAt?: string
  parentId?: string
  sourceId?: string
  deleted?: boolean // 软删除标记（tombstone，用于同步删除传播）
  kind?: 'TASK' | 'NOTE' // 笔记类型，默认 TASK
}

/** 小柴会话线程（messagesJson 为消息数组的 JSON 序列化，数据层不感知聊天结构） */
export interface AiThread {
  id: string
  title: string
  focusTodoId?: string
  summary: string
  summarizedCount: number
  messagesJson: string
  deleted?: boolean
  createdAt: string
  updatedAt: string
}

export interface DataAccess {
  initialize(): Promise<void>
  getTodos(): Todo[]
  getAllTodos(): Todo[]
  getTodoById(id: string): Todo | undefined
  addTodo(todo: Partial<Todo> & { title: string }): Todo
  bulkAddTodos(todos: Partial<Todo>[]): Todo[]
  replaceAll(todos: Todo[]): void
  updateTodo(id: string, updates: Partial<Todo>): void
  removeTodo(id: string): void
  toggleTodo(id: string): void
  getAiThreads(): AiThread[]
  getAiThreadById(id: string): AiThread | undefined
  saveAiThread(thread: AiThread): void
  replaceAllAiThreads(threads: AiThread[]): void
  save(): Promise<void>
  exportJSON(): string
  importJSON(json: string): { count: number }
  importFromLegacy(data: { todos: any[] }): { count: number }
  onChange(cb: () => void): () => void
}

class SqliteDataAccess implements DataAccess {
  private db = new TodoDatabase()
  private listeners: Set<() => void> = new Set()
  private _initialized = false
  private persistTimer: number | null = null
  private storageKey = 'todo-sqlite-db'

  async initialize(): Promise<void> {
    if (this._initialized) return
    try {
      const existing = await this.loadFromStorage()
      await this.db.initialize(existing ?? undefined)
      this._initialized = true
      console.log('[DataAccess] SQLite ready,', this.getTodos().length, 'todos')
    } catch (err) {
      console.error('[DataAccess] Init error:', err)
      await this.db.initialize()
      this._initialized = true
    }
  }

  private notify(): void {
    this.listeners.forEach(cb => cb())
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = window.setTimeout(() => this.save(), 300)
  }

  getTodos(): Todo[] {
    // 过滤软删除（tombstone），UI 不显示已删除任务
    return this.db.getAllTodos().map(rowToTodo).filter(t => !t.deleted)
  }

  /** 获取全部任务（含软删除标记的 tombstone，供同步合并使用） */
  getAllTodos(): Todo[] {
    return this.db.getAllTodos().map(rowToTodo)
  }

  getTodoById(id: string): Todo | undefined {
    const row = this.db.getTodoById(id)
    return row ? rowToTodo(row) : undefined
  }

  addTodo(input: Partial<Todo> & { title: string }): Todo {
    const row = this.db.addTodo({
      id: input.id, title: input.title, completed: input.completed,
      priority: input.priority, dueDate: input.dueDate, startDate: input.startDate,
      content: input.content, tags: input.tags, list: input.list,
      isAllDay: input.isAllDay, completedTime: input.completedTime,
      createdAt: input.createdAt, parentId: input.parentId, sourceId: input.sourceId,
      deleted: input.deleted, kind: input.kind,
    })
    this.notify()
    return rowToTodo(row)
  }

  bulkAddTodos(inputs: Partial<Todo>[]): Todo[] {
    const rows = this.db.bulkAddTodos(inputs.map(i => ({
      id: i.id, title: i.title!, completed: i.completed, priority: i.priority,
      dueDate: i.dueDate, startDate: i.startDate, content: i.content,
      tags: i.tags, list: i.list, isAllDay: i.isAllDay,
      completedTime: i.completedTime, createdAt: i.createdAt,
      parentId: i.parentId, sourceId: i.sourceId, deleted: i.deleted, kind: i.kind,
    })))
    this.notify()
    return rows.map(rowToTodo)
  }

  /**
   * 整体替换所有 todo（同步合并后写回）
   * 保留每个 todo 的 updatedAt，供多端 LWW 冲突解决使用
   */
  replaceAll(todos: Todo[]): void {
    this.db.replaceAllTodos(todos.map(t => ({
      id: t.id, title: t.title, completed: t.completed, priority: t.priority,
      dueDate: t.dueDate, startDate: t.startDate, content: t.content,
      tags: t.tags, list: t.list, isAllDay: t.isAllDay,
      completedTime: t.completedTime, createdAt: t.createdAt, updatedAt: t.updatedAt,
      parentId: t.parentId, sourceId: t.sourceId, deleted: t.deleted, kind: t.kind,
    })))
    this.notify()
  }

  updateTodo(id: string, updates: Partial<Todo>): void {
    this.db.updateTodo(id, {
      title: updates.title, completed: updates.completed, priority: updates.priority,
      dueDate: updates.dueDate, startDate: updates.startDate, content: updates.content,
      tags: updates.tags, list: updates.list, isAllDay: updates.isAllDay,
      completedTime: updates.completedTime, parentId: updates.parentId,
      sourceId: updates.sourceId, deleted: updates.deleted, kind: updates.kind,
    })
    this.notify()
  }

  removeTodo(id: string): void { this.db.removeTodo(id); this.notify() }
  toggleTodo(id: string): void { this.db.toggleTodo(id); this.notify() }

  // --- AI 会话线程 ---

  /** 获取全部线程（含 tombstone，供同步合并使用） */
  getAiThreads(): AiThread[] {
    return this.db.getAllAiThreads().map(rowToAiThread)
  }

  getAiThreadById(id: string): AiThread | undefined {
    const row = this.db.getAllAiThreads().find(r => r.id === id)
    return row ? rowToAiThread(row) : undefined
  }

  saveAiThread(thread: AiThread): void {
    this.db.upsertAiThread({
      id: thread.id, title: thread.title, focusTodoId: thread.focusTodoId ?? null,
      summary: thread.summary, summarizedCount: thread.summarizedCount,
      messagesJson: thread.messagesJson, deleted: thread.deleted,
      createdAt: thread.createdAt, updatedAt: thread.updatedAt,
    })
    this.notify()
  }

  /** 整体替换所有线程（同步合并后写回） */
  replaceAllAiThreads(threads: AiThread[]): void {
    this.db.replaceAllAiThreads(threads.map(t => ({
      id: t.id, title: t.title, focusTodoId: t.focusTodoId ?? null,
      summary: t.summary, summarizedCount: t.summarizedCount,
      messagesJson: t.messagesJson, deleted: t.deleted,
      createdAt: t.createdAt, updatedAt: t.updatedAt,
    })))
    this.notify()
  }

  async save(): Promise<void> {
    try { await this.saveToStorage(this.db.export()) }
    catch (err) { console.error('[DataAccess] Save error:', err) }
  }

  exportJSON(): string {
    return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), todos: this.getTodos() }, null, 2)
  }

  importJSON(json: string): { count: number } {
    try {
      const data = JSON.parse(json)
      const items = data.todos || (Array.isArray(data) ? data : [])
      let count = 0
      for (const item of items) {
        this.db.addTodo({
          id: item.id, title: item.title || '',
          completed: item.completed, priority: item.priority,
          dueDate: item.dueDate || item.due_date,
          startDate: item.startDate || item.start_date,
          content: item.content, tags: item.tags,
          list: item.list || item.list_name,
          isAllDay: item.isAllDay || item.is_all_day,
          completedTime: item.completedTime || item.completed_time,
          createdAt: item.createdAt || item.created_at,
        })
        count++
      }
      this.notify()
      return { count }
    } catch (err) {
      console.error('[DataAccess] JSON import error:', err)
      throw new Error('Invalid JSON format')
    }
  }

  importFromLegacy(data: { todos: any[] }): { count: number } {
    if (!data.todos) return { count: 0 }
    let count = 0
    for (const t of data.todos) {
      this.db.addTodo({
        id: t.id, title: t.title ?? '', completed: t.completed ?? false,
        priority: t.priority ?? 0, dueDate: t.dueDate, startDate: t.startDate,
        content: t.content, tags: t.tags, list: t.list,
        isAllDay: t.isAllDay, completedTime: t.completedTime, createdAt: t.createdAt,
      })
      count++
    }
    this.notify()
    return { count }
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  // --- IndexedDB 持久化 ---
  private async loadFromStorage(): Promise<Uint8Array | null> {
    try {
      if (typeof indexedDB !== 'undefined') {
        const data = await idbRead(this.storageKey)
        if (data) return data
      }
      const raw = localStorage.getItem(this.storageKey)
      if (raw) {
        const bin = atob(raw)
        const b = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i)
        return b
      }
    } catch {}
    return null
  }

  private async saveToStorage(data: Uint8Array): Promise<void> {
    try { if (typeof indexedDB !== 'undefined') await idbWrite(this.storageKey, data) } catch {}
    try {
      let s = ''
      for (let i = 0; i < data.length; i++) s += String.fromCharCode(data[i])
      localStorage.setItem(this.storageKey, btoa(s))
    } catch {}
  }
}

function idbRead(key: string): Promise<Uint8Array | null> {
  return new Promise(r => {
    const req = indexedDB.open('todo-app', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('sqlite')
    req.onsuccess = () => {
      const tx = req.result.transaction('sqlite', 'readonly')
      const g = tx.objectStore('sqlite').get(key)
      g.onsuccess = () => r(g.result ? new Uint8Array(g.result) : null)
      g.onerror = () => r(null)
    }
    req.onerror = () => r(null)
  })
}

function idbWrite(key: string, data: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('todo-app', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('sqlite')
    req.onsuccess = () => {
      const tx = req.result.transaction('sqlite', 'readwrite')
      tx.objectStore('sqlite').put(data, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    }
    req.onerror = () => reject(req.error)
  })
}

function rowToTodo(row: any): Todo {
  return {
    id: row.id, title: row.title, completed: row.completed === 1,
    createdAt: row.created_at, priority: row.priority as 0 | 1 | 3 | 5,
    dueDate: row.due_date ?? undefined, startDate: row.start_date ?? undefined,
    content: row.content ?? undefined, tags: JSON.parse(row.tags || '[]'),
    list: row.list_name ?? undefined, isAllDay: row.is_all_day === 1,
    completedTime: row.completed_time ?? undefined,
    updatedAt: row.updated_at ?? undefined,
    parentId: row.parent_id ?? undefined,
    sourceId: row.source_id ?? undefined,
    deleted: row.deleted === 1,
    kind: row.kind === 'NOTE' ? 'NOTE' : 'TASK',
  }
}

function rowToAiThread(row: any): AiThread {
  return {
    id: row.id, title: row.title,
    focusTodoId: row.focus_todo_id ?? undefined,
    summary: row.summary ?? '',
    summarizedCount: Number(row.summarized_count) || 0,
    messagesJson: row.messages ?? '[]',
    deleted: row.deleted === 1,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

let instance: DataAccess | null = null

export function createDataAccess(): DataAccess {
  if (!instance) instance = new SqliteDataAccess()
  return instance
}

export function resetDataAccess(): void { instance = null }

export function getDataAccess(): DataAccess {
  if (!instance) throw new Error('DataAccess not initialized')
  return instance
}
