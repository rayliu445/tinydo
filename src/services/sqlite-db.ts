/**
 * SQLite 数据库服务
 * 
 * 基于 sql.js (SQLite WASM) 实现跨平台数据库存储。
 * 同一份代码在 Web / Electron / Capacitor 中均可运行。
 * 
 * 数据库文件通过 db.export() 导出为 Uint8Array，
 * 再持久化到 IndexedDB (浏览器) 或 fs (Electron)。
 */

import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js'

// ============ 类型 ============

export interface TodoRow {
  id: string
  title: string
  completed: number // 0 or 1
  priority: number // 0, 1, 3, 5
  due_date: string | null
  start_date: string | null
  content: string | null
  tags: string // JSON array
  list_name: string | null
  is_all_day: number // 0 or 1
  completed_time: string | null
  created_at: string
  updated_at: string
  parent_id: string | null // 父任务本地 id
  source_id: string | null // 原始系统（TickTick）taskId，用于稳定匹配
  deleted: number // 0 or 1，软删除标记（tombstone，用于同步删除传播）
  kind: string // 'TASK' | 'NOTE'，笔记类型（NOTE 不作为任务条目）
}

export interface TodoInput {
  title: string
  completed?: boolean
  priority?: number
  dueDate?: string
  startDate?: string
  content?: string
  tags?: string[]
  list?: string
  isAllDay?: boolean
  completedTime?: string
  createdAt?: string
  updatedAt?: string
  parentId?: string
  sourceId?: string
  deleted?: boolean // 软删除标记（tombstone）
  kind?: 'TASK' | 'NOTE' // 笔记类型，默认 TASK
}

/** 小柴会话线程行（messages 为 ChatBubble[] 的 JSON 序列化，数据层不感知聊天结构） */
export interface AiThreadRow {
  id: string
  title: string
  focus_todo_id: string | null
  summary: string
  summarized_count: number
  messages: string
  deleted: number // 0 or 1，软删除标记（tombstone，用于同步删除传播）
  created_at: string
  updated_at: string
}

export interface AiThreadInput {
  id: string
  title: string
  focusTodoId?: string | null
  summary?: string
  summarizedCount?: number
  messagesJson: string
  deleted?: boolean
  createdAt: string
  updatedAt: string
}

// ============ Schema ============

const SCHEMA = `
CREATE TABLE IF NOT EXISTS todos (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  completed     INTEGER NOT NULL DEFAULT 0,
  priority      INTEGER NOT NULL DEFAULT 0,
  due_date      TEXT,
  start_date    TEXT,
  content       TEXT,
  tags          TEXT NOT NULL DEFAULT '[]',
  list_name     TEXT,
  is_all_day    INTEGER NOT NULL DEFAULT 0,
  completed_time TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  parent_id     TEXT,
  source_id     TEXT,
  deleted       INTEGER NOT NULL DEFAULT 0,
  kind          TEXT NOT NULL DEFAULT 'TASK'
);

CREATE INDEX IF NOT EXISTS idx_todos_completed ON todos(completed);
CREATE INDEX IF NOT EXISTS idx_todos_due_date ON todos(due_date);
CREATE INDEX IF NOT EXISTS idx_todos_priority ON todos(priority);
CREATE INDEX IF NOT EXISTS idx_todos_created ON todos(created_at);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_threads (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL DEFAULT '',
  focus_todo_id    TEXT,
  summary          TEXT NOT NULL DEFAULT '',
  summarized_count INTEGER NOT NULL DEFAULT 0,
  messages         TEXT NOT NULL DEFAULT '[]',
  deleted          INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_threads_updated ON ai_threads(updated_at);
`

// ============ 数据库管理器 ============

export class TodoDatabase {
  private db: SqlJsDatabase | null = null
  private _ready = false

  /** 初始化：加载 WASM + 创建 Schema */
  async initialize(existingData?: Uint8Array): Promise<void> {
    // 根据运行环境定位 sql.js WASM 文件
    // 【关键】WASM 文件放在 public/sql-wasm.wasm（已入库），构建后位于 dist 根目录。
    // 这里使用相对路径 './sql-wasm.wasm'，跨平台均可正确解析：
    //   - Web dev：Vite 从 public/ 提供 /sql-wasm.wasm
    //   - Electron（file://）：相对 dist/index.html → dist/sql-wasm.wasm
    //   - iOS/Android（Capacitor，http://localhost）：相对 app 根 → sql-wasm.wasm
    // 之前用 '/node_modules/sql.js/dist/' 路径，但 public/node_modules 被 .gitignore
    // 忽略、CI 构建的 app 里根本没有 wasm 文件 → iOS 上 404 → 数据库初始化失败。
    const locateFile = (file: string) => {
      return './' + file
    }

    // 【关键修复】iOS/Android (Capacitor) 下，本地服务器对 .wasm 返回的
    // Content-Type 不是 application/wasm，WebAssembly.instantiateStreaming 会因
    // MIME 不符直接失败，导致 sql.js 初始化失败（本地数据库不可用 →
    // 所有数据操作抛 "Database not initialized" → 同步数据写不进去）。
    // 修复：手动 fetch WASM 为 ArrayBuffer，通过 wasmBinary 传入 initSqlJs，
    // 走 WebAssembly.instantiate(ArrayBuffer) 路径，不校验 MIME，跨平台可靠。
    // fetch 失败时回退到原 locateFile 方式（streaming）。
    let sqlConfig: Record<string, unknown> = { locateFile }
    try {
      const wasmUrl = locateFile('sql-wasm.wasm')
      const wasmRes = await fetch(wasmUrl)
      if (wasmRes.ok) {
        const wasmBinary = await wasmRes.arrayBuffer()
        sqlConfig = { wasmBinary }
        console.log('[Sqlite] WASM 加载成功（fetch ArrayBuffer）:', wasmBinary.byteLength, 'bytes')
      } else {
        console.warn('[Sqlite] WASM fetch 失败 (HTTP', wasmRes.status, ')，回退 locateFile')
      }
    } catch (err) {
      console.warn('[Sqlite] WASM fetch 异常，回退 locateFile:', err)
    }
    const SQL = await initSqlJs(sqlConfig as any)

    if (existingData && existingData.length > 0) {
      this.db = new SQL.Database(existingData)
    } else {
      this.db = new SQL.Database()
    }

    // 执行 Schema
    this.db.run(SCHEMA)
    // 迁移：为旧数据库补充新增列（列已存在时忽略报错）
    try { this.db.run('ALTER TABLE todos ADD COLUMN parent_id TEXT') } catch { /* already exists */ }
    try { this.db.run('ALTER TABLE todos ADD COLUMN source_id TEXT') } catch { /* already exists */ }
    try { this.db.run('ALTER TABLE todos ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0') } catch { /* already exists */ }
    try { this.db.run("ALTER TABLE todos ADD COLUMN kind TEXT NOT NULL DEFAULT 'TASK'") } catch { /* already exists */ }
    this._ready = true
  }

  /** 数据库是否就绪 */
  get ready(): boolean {
    return this._ready
  }

  /** 导出数据库为二进制 */
  export(): Uint8Array {
    if (!this.db) throw new Error('Database not initialized')
    return this.db.export()
  }

  /** 关闭数据库 */
  close(): void {
    this.db?.close()
    this.db = null
    this._ready = false
  }

  // ============ CRUD ============

  /** 获取所有 Todo */
  getAllTodos(): TodoRow[] {
    if (!this.db) return []
    const stmt = this.db.prepare('SELECT * FROM todos ORDER BY created_at DESC')
    const rows: TodoRow[] = []
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as unknown as TodoRow)
    }
    stmt.free()
    return rows
  }

  /** 按 ID 获取 Todo */
  getTodoById(id: string): TodoRow | undefined {
    if (!this.db) return
    const stmt = this.db.prepare('SELECT * FROM todos WHERE id = ?')
    stmt.bind([id])
    if (stmt.step()) {
      const row = stmt.getAsObject() as unknown as TodoRow
      stmt.free()
      return row
    }
    stmt.free()
    return undefined
  }

  /** 添加 Todo */
  addTodo(input: TodoInput & { id?: string }): TodoRow {
    if (!this.db) throw new Error('Database not initialized')
    const now = new Date().toISOString()
    const id = input.id ?? `todo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const row: TodoRow = {
      id,
      title: input.title,
      completed: input.completed ? 1 : 0,
      priority: input.priority ?? 0,
      due_date: input.dueDate ?? null,
      start_date: input.startDate ?? null,
      content: input.content ?? null,
      tags: JSON.stringify(input.tags ?? []),
      list_name: input.list ?? null,
      is_all_day: input.isAllDay ? 1 : 0,
      completed_time: input.completedTime ?? null,
      created_at: input.createdAt ?? now,
      updated_at: input.updatedAt ?? now,
      parent_id: input.parentId ?? null,
      source_id: input.sourceId ?? null,
      deleted: input.deleted ? 1 : 0,
      kind: input.kind ?? 'TASK',
    }
    this.db.run(
      `INSERT INTO todos (id, title, completed, priority, due_date, start_date, content, tags, list_name, is_all_day, completed_time, created_at, updated_at, parent_id, source_id, deleted, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.title, row.completed, row.priority, row.due_date, row.start_date,
       row.content, row.tags, row.list_name, row.is_all_day, row.completed_time,
       row.created_at, row.updated_at, row.parent_id, row.source_id, row.deleted, row.kind],
    )
    return row
  }

  /** 批量添加 */
  bulkAddTodos(inputs: TodoInput[]): TodoRow[] {
    return inputs.map(input => this.addTodo(input))
  }

  /**
   * 整体替换所有 todo（用于同步合并后写回）
   * 保留每个 todo 的 updated_at，避免 LWW 冲突解决被破坏
   */
  replaceAllTodos(todos: Array<TodoInput & { id: string }>): TodoRow[] {
    if (!this.db) throw new Error('Database not initialized')
    this.db.run('DELETE FROM todos')
    return this.bulkAddTodos(todos)
  }

  /** 更新 Todo */
  updateTodo(id: string, updates: Partial<TodoInput>): boolean {
    if (!this.db) return false
    const existing = this.getTodoById(id)
    if (!existing) return false

    const fields: string[] = []
    const values: any[] = []

    if (updates.title !== undefined) { fields.push('title = ?'); values.push(updates.title) }
    if (updates.completed !== undefined) { fields.push('completed = ?'); values.push(updates.completed ? 1 : 0) }
    if (updates.priority !== undefined) { fields.push('priority = ?'); values.push(updates.priority) }
    if (updates.dueDate !== undefined) { fields.push('due_date = ?'); values.push(updates.dueDate ?? null) }
    if (updates.startDate !== undefined) { fields.push('start_date = ?'); values.push(updates.startDate ?? null) }
    if (updates.content !== undefined) { fields.push('content = ?'); values.push(updates.content ?? null) }
    if (updates.tags !== undefined) { fields.push('tags = ?'); values.push(JSON.stringify(updates.tags)) }
    if (updates.list !== undefined) { fields.push('list_name = ?'); values.push(updates.list ?? null) }
    if (updates.isAllDay !== undefined) { fields.push('is_all_day = ?'); values.push(updates.isAllDay ? 1 : 0) }
    if (updates.completedTime !== undefined) { fields.push('completed_time = ?'); values.push(updates.completedTime ?? null) }
    if (updates.parentId !== undefined) { fields.push('parent_id = ?'); values.push(updates.parentId ?? null) }
    if (updates.sourceId !== undefined) { fields.push('source_id = ?'); values.push(updates.sourceId ?? null) }
    if (updates.deleted !== undefined) { fields.push('deleted = ?'); values.push(updates.deleted ? 1 : 0) }
    if (updates.kind !== undefined) { fields.push('kind = ?'); values.push(updates.kind) }

    fields.push('updated_at = ?')
    values.push(new Date().toISOString())
    values.push(id)

    this.db.run(`UPDATE todos SET ${fields.join(', ')} WHERE id = ?`, values)
    return true
  }

  /** 切换完成状态 */
  toggleTodo(id: string): boolean {
    if (!this.db) return false
    const todo = this.getTodoById(id)
    if (!todo) return false
    const newCompleted = todo.completed ? 0 : 1
    const completedTime = newCompleted ? new Date().toISOString() : null
    this.db.run(
      'UPDATE todos SET completed = ?, completed_time = ?, updated_at = ? WHERE id = ?',
      [newCompleted, completedTime, new Date().toISOString(), id],
    )
    return true
  }

  /** 删除 Todo */
  removeTodo(id: string): boolean {
    if (!this.db) return false
    this.db.run('DELETE FROM todos WHERE id = ?', [id])
    return true
  }

  /** 按日期范围查询 */
  getTodosByDateRange(start: string, end: string): TodoRow[] {
    if (!this.db) return []
    const stmt = this.db.prepare(
      'SELECT * FROM todos WHERE due_date >= ? AND due_date <= ? ORDER BY due_date ASC',
    )
    stmt.bind([start, end])
    const rows: TodoRow[] = []
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as unknown as TodoRow)
    }
    stmt.free()
    return rows
  }

  /** 按优先级查询 */
  getTodosByPriority(priority: number): TodoRow[] {
    if (!this.db) return []
    const stmt = this.db.prepare('SELECT * FROM todos WHERE priority = ? ORDER BY created_at DESC')
    stmt.bind([priority])
    const rows: TodoRow[] = []
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as unknown as TodoRow)
    }
    stmt.free()
    return rows
  }

  /** 获取已完成 Todo */
  getCompletedTodos(): TodoRow[] {
    if (!this.db) return []
    const stmt = this.db.prepare('SELECT * FROM todos WHERE completed = 1 ORDER BY updated_at DESC')
    const rows: TodoRow[] = []
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as unknown as TodoRow)
    }
    stmt.free()
    return rows
  }

  /** 搜索 Todo */
  searchTodos(query: string): TodoRow[] {
    if (!this.db) return []
    const stmt = this.db.prepare(
      'SELECT * FROM todos WHERE title LIKE ? ORDER BY created_at DESC',
    )
    stmt.bind([`%${query}%`])
    const rows: TodoRow[] = []
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as unknown as TodoRow)
    }
    stmt.free()
    return rows
  }

  /** 获取统计信息 */
  getStats() {
    if (!this.db) return { total: 0, completed: 0, pending: 0 }
    const result = this.db.exec('SELECT COUNT(*) as total, SUM(completed) as completed FROM todos')
    if (result.length > 0) {
      const row = result[0].values[0]
      return {
        total: Number(row[0]),
        completed: Number(row[1]),
        pending: Number(row[0]) - Number(row[1]),
      }
    }
    return { total: 0, completed: 0, pending: 0 }
  }

  // ============ AI 会话线程 ============

  /** 获取所有会话线程（含 tombstone，供同步合并使用） */
  getAllAiThreads(): AiThreadRow[] {
    if (!this.db) return []
    const stmt = this.db.prepare('SELECT * FROM ai_threads ORDER BY updated_at DESC')
    const rows: AiThreadRow[] = []
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as unknown as AiThreadRow)
    }
    stmt.free()
    return rows
  }

  /** 新增或覆盖线程（updatedAt 由调用方维护，用于多端 LWW 合并） */
  upsertAiThread(input: AiThreadInput): AiThreadRow {
    if (!this.db) throw new Error('Database not initialized')
    const row: AiThreadRow = {
      id: input.id,
      title: input.title,
      focus_todo_id: input.focusTodoId ?? null,
      summary: input.summary ?? '',
      summarized_count: input.summarizedCount ?? 0,
      messages: input.messagesJson,
      deleted: input.deleted ? 1 : 0,
      created_at: input.createdAt,
      updated_at: input.updatedAt,
    }
    this.db.run(
      `INSERT OR REPLACE INTO ai_threads (id, title, focus_todo_id, summary, summarized_count, messages, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.title, row.focus_todo_id, row.summary, row.summarized_count, row.messages, row.deleted, row.created_at, row.updated_at],
    )
    return row
  }

  /** 整体替换所有线程（同步合并后写回，保留各自 updatedAt） */
  replaceAllAiThreads(inputs: AiThreadInput[]): void {
    if (!this.db) throw new Error('Database not initialized')
    this.db.run('DELETE FROM ai_threads')
    for (const input of inputs) this.upsertAiThread(input)
  }

  // ============ 设置 ============

  getSetting(key: string): string | null {
    if (!this.db) return null
    const stmt = this.db.prepare('SELECT value FROM settings WHERE key = ?')
    stmt.bind([key])
    if (stmt.step()) {
      const row = stmt.getAsObject() as { value: string }
      stmt.free()
      return row.value
    }
    stmt.free()
    return null
  }

  setSetting(key: string, value: string): void {
    if (!this.db) return
    this.db.run(
      'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
      [key, value],
    )
  }
}
