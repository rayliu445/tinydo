/**
 * 小柴：系统提示词 + 清单操作（actions）协议
 *
 * 职责：
 * - 内置「小柴」人设的系统提示词（用户可在设置里追加自定义要求）
 * - 把当前待办清单序列化为上下文文本，注入 system 消息
 * - 解析 AI 回复末尾的 actions JSON 块（宽松匹配，失败则按纯文本展示）
 *
 * 操作协议：AI 不直接改清单，而是输出待确认的操作列表（建议卡片），
 * 用户点「应用」后才写入 todoStore（自动进云同步链路）。
 */

import type { Todo } from '../../stores/todo'

// ============ Actions 协议类型 ============

export interface AiActionAddTodo {
  type: 'add_todo'
  title: string
  parentId?: string
  priority?: 0 | 1 | 3 | 5
  dueDate?: string // YYYY-MM-DD
  content?: string
}

export interface AiActionUpdateTodo {
  type: 'update_todo'
  id: string
  title?: string
  priority?: 0 | 1 | 3 | 5
  dueDate?: string // YYYY-MM-DD
  content?: string
}

export interface AiActionCompleteTodo {
  type: 'complete_todo'
  id: string
}

export interface AiActionRemoveTodo {
  type: 'remove_todo'
  id: string
}

export type AiAction = AiActionAddTodo | AiActionUpdateTodo | AiActionCompleteTodo | AiActionRemoveTodo

// ============ 默认系统提示词 ============

export const DEFAULT_COACH_SYSTEM_PROMPT = `你是 TinyDo（一个个人待办清单应用）内置的任务伙伴，名字叫「小柴」，用户会用这个名字称呼你。来找你的用户常常在任务面前感到畏难、拖延或迷茫，他们需要的是力量和方向。

# 你的使命
1. 接住情绪：用户畏难、焦虑、自责时，先真诚共情，再给予具体、可信的鼓励——不灌空鸡汤，不居高临下。
2. 化整为零：用户不知道怎么开始或继续时，把任务拆成「小到不可能失败」的第一步：5~30 分钟能完成、有明确的完成标志、从阻力最小的地方切入。
3. 动手整理：当用户明确想调整清单（拆解任务、修改、删除）时，按下方协议输出操作建议，由用户确认后生效。

# 鼓励原则
- 先共情再建议：用一句话点出用户的具体处境，让他感到被看见。
- 鼓励要具体：指出已经完成的部分、下一步为什么可行；避免「加油」「你可以的」这类空洞话。
- 语言简短自然：通常 2~6 句话，像朋友聊天，不说教、不列长篇大论。
- 不做心理诊断；若用户情绪持续低落，温和地建议寻求专业支持。
- 全程使用简体中文。

# 清单操作协议（仅在需要调整清单时使用）
当且仅当你建议调整清单时，在回复的最末尾输出一个 actions 代码块（\`\`\`actions 围栏），内容为 JSON：
{"actions":[
  {"type":"add_todo","title":"子任务标题","parentId":"父任务id","priority":0,"dueDate":"YYYY-MM-DD"},
  {"type":"update_todo","id":"任务id","title":"新标题","dueDate":"YYYY-MM-DD","priority":3},
  {"type":"complete_todo","id":"任务id"},
  {"type":"remove_todo","id":"任务id"}
]}
规则：
- 只能使用「当前任务上下文」里出现的真实任务 id，绝不编造 id。
- 拆解任务 = 输出多条 add_todo，并都带 parentId 挂到该任务下；子任务标题用动词开头、可执行的动作。
- dueDate 只用 YYYY-MM-DD 格式，依据「今天」的日期推算（如「明天」）。
- priority 取值：0 无 / 1 低 / 3 中 / 5 高。
- 单次输出不超过 8 条操作，宁少勿多；优先给出「下一步」，而不是一次拆完整个项目。
- 输出 actions 块时，正文里用一句话告诉用户这些是待确认的建议，确认后才会写入清单。
- 纯聊天、纯鼓励时不输出 actions 块。`

// ============ 上下文序列化 ============

const PRIORITY_LABEL: Record<number, string> = { 0: '无', 1: '低', 3: '中', 5: '高' }

function ymdOf(dateStr?: string): string {
  return dateStr ? dateStr.slice(0, 10) : ''
}

/** 生成发送给 AI 的动态上下文：今天日期 + （可选）当前打开的任务 + 未完成清单摘要 */
export function buildContextSection(todos: Todo[], focusTodoId?: string | null): string {
  const parts: string[] = []
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()]
  parts.push(`今天是 ${today}（星期${week}）。`)

  const focus = focusTodoId ? todos.find(t => t.id === focusTodoId && t.kind !== 'NOTE') : null
  if (focus) {
    parts.push(serializeFocusTodo(focus, todos))
  }

  parts.push(
    '【用户的待办清单】（仅未完成任务；方括号里的「任务id」供操作协议引用，不要向用户展示 id）\n' +
    serializePendingTodos(todos, focus?.id),
  )
  return parts.join('\n\n')
}

/** 当前打开的任务全文（标题/内容/属性/子任务），让小柴围绕它展开 */
function serializeFocusTodo(focus: Todo, todos: Todo[]): string {
  const lines: string[] = ['【用户当前打开的任务】']
  lines.push(`任务id：${focus.id}`)
  lines.push(`标题：${focus.title}`)
  if (focus.content?.trim()) lines.push(`内容：${focus.content.trim().slice(0, 600)}`)
  const attrs: string[] = []
  if (focus.dueDate) attrs.push(`截止 ${ymdOf(focus.dueDate)}`)
  if (focus.priority) attrs.push(`优先级 ${PRIORITY_LABEL[focus.priority] ?? '无'}`)
  if (attrs.length) lines.push(`属性：${attrs.join('，')}`)
  const subs = todos.filter(t => t.parentId === focus.id && !t.deleted)
  if (subs.length) {
    lines.push('已有子任务：')
    for (const s of subs) lines.push(`  - [${s.id}] ${s.title}${s.completed ? '（已完成）' : ''}`)
  } else {
    lines.push('暂无子任务。')
  }
  return lines.join('\n')
}

/** 未完成清单摘要：父任务后紧跟子任务（缩进），限制总条数避免 token 爆炸 */
function serializePendingTodos(todos: Todo[], skipRootId?: string, maxCount = 50): string {
  const pending = todos.filter(t => t.kind !== 'NOTE' && !t.completed && !t.deleted)
  const childrenOf = new Map<string, Todo[]>()
  const roots: Todo[] = []
  for (const t of pending) {
    if (t.parentId && pending.some(p => p.id === t.parentId)) {
      const arr = childrenOf.get(t.parentId) ?? []
      arr.push(t)
      childrenOf.set(t.parentId, arr)
    } else {
      roots.push(t)
    }
  }

  const lines: string[] = []
  let count = 0
  const walk = (t: Todo, depth: number) => {
    if (count >= maxCount || depth > 2) return
    count++
    const attrs: string[] = []
    if (t.dueDate) attrs.push(`截止 ${ymdOf(t.dueDate)}`)
    if (t.priority) attrs.push(`优先级 ${PRIORITY_LABEL[t.priority] ?? '无'}`)
    lines.push(`${'  '.repeat(depth)}- [${t.id}] ${t.title}${attrs.length ? `（${attrs.join('，')}）` : ''}`)
    for (const c of childrenOf.get(t.id) ?? []) walk(c, depth + 1)
  }

  for (const root of roots) {
    if (skipRootId && (root.id === skipRootId || isDescendantOf(root, skipRootId, pending))) continue
    walk(root, 0)
  }
  if (count >= maxCount) lines.push(`（其余 ${pending.length - count} 条略）`)
  return lines.length ? lines.join('\n') : '（清单里没有未完成任务）'
}

function isDescendantOf(t: Todo, ancestorId: string, all: Todo[]): boolean {
  let cur = t
  const seen = new Set<string>()
  while (cur.parentId && !seen.has(cur.id)) {
    seen.add(cur.id)
    if (cur.parentId === ancestorId) return true
    const parent = all.find(x => x.id === cur.parentId)
    if (!parent) return false
    cur = parent
  }
  return false
}

// ============ 旧对话滚动摘要（Summary Buffer 模式） ============

/**
 * 滚动摘要请求的提示词：超出原文窗口的旧对话不直接丢弃，
 * 而是让模型压缩成摘要（增量融入已有摘要），随后续请求注入。
 */
export function buildSummaryPrompt(prevSummary: string, dialogues: string): string {
  const base = '请把下面的对话压缩成一份摘要，供 AI 助手在后续对话中回忆更早的上下文。要求：\n' +
    '- 400 字以内，用第三人称叙述\n' +
    '- 保留：讨论过的任务及其标题与状态、用户的情绪和困扰、双方达成的共识与约定（如「先做X再做Y」）、小柴给过的关键建议\n' +
    '- 省略寒暄和重复内容，直接输出摘要正文，不要任何前后缀'
  if (prevSummary.trim()) {
    return `${base}\n\n这是已有的摘要，请把新对话融入进去，输出更新后的完整摘要：\n${prevSummary.trim()}\n\n=== 新增对话 ===\n${dialogues}`
  }
  return `${base}\n\n=== 对话 ===\n${dialogues}`
}

// ============ AI 回复解析 ============

export interface ParsedAiReply {
  /** 展示给用户的正文（已剥离 actions 块） */
  content: string
  /** 校验通过的待确认操作 */
  actions: AiAction[]
}

/**
 * 解析 AI 回复：
 * 1. 优先找 ```actions / ```json 围栏块（内容含 "actions"）
 * 2. 退化找裸 JSON 对象 {"actions": [...]}
 * 3. 校验字段（type 合法、add_todo 有 title、其余有 id、priority/dueDate 格式），
 *    并剔除指向不存在任务的 id（AI 幻觉防御）
 */
export function parseAiReply(raw: string, knownIds?: Set<string>): ParsedAiReply {
  let content = raw
  let actions: AiAction[] = []

  const fencedRe = /```([a-zA-Z]*)[ \t]*\r?\n?([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = fencedRe.exec(raw)) !== null) {
    const lang = (m[1] || '').toLowerCase()
    const body = m[2].trim()
    if (!body.includes('"actions"')) continue
    if (lang && lang !== 'actions' && lang !== 'json') continue
    const parsed = tryParseActions(body, knownIds)
    if (parsed) {
      actions = parsed
      content = content.replace(m[0], '')
    }
  }

  // 无围栏块时退化：裸 JSON
  if (actions.length === 0) {
    const idx = raw.indexOf('{"actions"')
    if (idx !== -1) {
      const end = raw.lastIndexOf('}')
      if (end > idx) {
        const parsed = tryParseActions(raw.slice(idx, end + 1), knownIds)
        if (parsed) {
          actions = parsed
          content = raw.slice(0, idx) + raw.slice(end + 1)
        }
      }
    }
  }

  return { content: content.replace(/\n{3,}/g, '\n\n').trim(), actions }
}

function tryParseActions(text: string, knownIds?: Set<string>): AiAction[] | null {
  let obj: any
  try {
    obj = JSON.parse(text)
  } catch {
    return null
  }
  if (!obj || !Array.isArray(obj.actions)) return null
  const valid: AiAction[] = []
  for (const a of obj.actions) {
    const v = validateAction(a, knownIds)
    if (v) valid.push(v)
  }
  return valid
}

function normalizePriority(v: any): 0 | 1 | 3 | 5 | undefined {
  const n = Number(v)
  return n === 0 || n === 1 || n === 3 || n === 5 ? n : undefined
}

function normalizeDueDate(v: any): string | undefined {
  if (typeof v !== 'string') return undefined
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v
  // 容忍完整 ISO 时间戳，取日期部分
  if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return v.slice(0, 10)
  return undefined
}

function validateAction(a: any, knownIds?: Set<string>): AiAction | null {
  if (!a || typeof a !== 'object') return null
  switch (a.type) {
    case 'add_todo': {
      const title = typeof a.title === 'string' ? a.title.trim() : ''
      if (!title) return null
      // parentId 指向不存在的任务时降级为顶层任务
      const parentId = typeof a.parentId === 'string' && a.parentId && (!knownIds || knownIds.has(a.parentId))
        ? a.parentId
        : undefined
      const action: AiActionAddTodo = { type: 'add_todo', title }
      if (parentId) action.parentId = parentId
      const priority = normalizePriority(a.priority)
      if (priority !== undefined) action.priority = priority
      const dueDate = normalizeDueDate(a.dueDate)
      if (dueDate) action.dueDate = dueDate
      if (typeof a.content === 'string' && a.content.trim()) action.content = a.content.trim()
      return action
    }
    case 'update_todo': {
      if (typeof a.id !== 'string' || !a.id || (knownIds && !knownIds.has(a.id))) return null
      const action: AiActionUpdateTodo = { type: 'update_todo', id: a.id }
      if (typeof a.title === 'string' && a.title.trim()) action.title = a.title.trim()
      const priority = normalizePriority(a.priority)
      if (priority !== undefined) action.priority = priority
      const dueDate = normalizeDueDate(a.dueDate)
      if (dueDate) action.dueDate = dueDate
      if (typeof a.content === 'string' && a.content.trim()) action.content = a.content.trim()
      return Object.keys(action).length > 2 ? action : null
    }
    case 'complete_todo':
    case 'remove_todo': {
      if (typeof a.id !== 'string' || !a.id || (knownIds && !knownIds.has(a.id))) return null
      return { type: a.type, id: a.id }
    }
    default:
      return null
  }
}

// ============ 操作描述（建议卡片文案） ============

/** 生成单条操作的人类可读描述；resolveTitle 用于把 id 还原为任务标题 */
export function describeAction(a: AiAction, resolveTitle: (id: string) => string | undefined): string {
  switch (a.type) {
    case 'add_todo': {
      const parent = a.parentId ? resolveTitle(a.parentId) : undefined
      const due = a.dueDate ? `（${a.dueDate}）` : ''
      return parent ? `在「${parent}」下新增子任务：${a.title}${due}` : `新增任务：${a.title}${due}`
    }
    case 'update_todo': {
      const t = resolveTitle(a.id)
      const changes: string[] = []
      if (a.title) changes.push(`重命名为「${a.title}」`)
      if (a.dueDate) changes.push(`截止改为 ${a.dueDate}`)
      if (a.priority !== undefined) changes.push(`优先级改为 ${PRIORITY_LABEL[a.priority] ?? a.priority}`)
      if (a.content) changes.push('更新内容')
      return `修改${t ? `「${t}」` : '任务'}：${changes.join('、')}`
    }
    case 'complete_todo':
      return `标记完成「${resolveTitle(a.id) ?? a.id}」`
    case 'remove_todo':
      return `删除「${resolveTitle(a.id) ?? a.id}」`
  }
}
