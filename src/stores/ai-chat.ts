/**
 * 小柴：多会话线程管理
 *
 * - 每个线程是一条独立记录（仿 DeepSeek 会话列表）：可切换、可删除、退出重进不丢
 * - 持久化到 SQLite 的 ai_threads 表（IndexedDB + localStorage 双备份），
 *   写入后触发 sync-engine，线程随七牛云同步（线程级 LWW + tombstone）
 * - 线程可关联任务（focusTodoId）：从任务详情发起 → 恢复该任务最近的线程接着聊；
 *   侧边栏进入 → 「自由聊」线程；任务被删除（本地或他端同步删除）→ 级联删线程
 * - 防膨胀：单线程消息上限 60 条 + 滚动摘要；活跃线程上限 20 个，超出淘汰最久未更新的
 */

import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { useTodoStore, type Todo } from './todo'
import { useSettingsStore } from './settings'
import { getDataAccess, type AiThread } from '../services/data-access'
import { getSyncEngine } from '../services/sync-engine'
import { speakWithSettings } from '../services/tts'
import { chatCompletion, isAiConfigured, type AiClientConfig, type ChatMessage } from '../services/ai/ai-client'
import {
  DEFAULT_COACH_SYSTEM_PROMPT,
  buildContextSection,
  buildSummaryPrompt,
  parseAiReply,
  describeAction,
  type AiAction,
} from '../services/ai/coach-prompt'

export interface ChatBubble {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  /** assistant 消息携带的待确认操作（建议卡片） */
  actions?: AiAction[]
  /** 建议卡片逐条人类可读描述（生成时快照，应用后仍可回看） */
  actionLabels?: string[]
  actionsState?: 'pending' | 'applied' | 'dismissed'
  /** 请求失败的消息（不进入 AI 上下文） */
  error?: boolean
  time: string
}

// 旧版（单会话）localStorage key，仅用于一次性迁移
const LEGACY_CHAT_KEY = 'todo-ai-chat'
const MAX_MESSAGES_PER_THREAD = 60 // 单线程保留的消息条数
const HISTORY_LIMIT = 20 // 每次请求携带的原文窗口（最近 N 条）
const COMPRESS_BATCH = 10 // 窗口外旧消息积攒到该条数时，触发一次摘要压缩
const MAX_THREADS = 20 // 活跃线程上限，超出自动淘汰最久未更新的

let seq = 0
function genId(prefix: string): string {
  seq += 1
  return `${prefix}_${Date.now().toString(36)}_${seq}`
}

function nowTime(): string {
  return new Date().toISOString()
}

function byUpdatedAtDesc(a: AiThread, b: AiThread): number {
  return (b.updatedAt || '').localeCompare(a.updatedAt || '')
}

function safeParseMessages(json: string): ChatBubble[] {
  try {
    const arr = JSON.parse(json || '[]')
    return Array.isArray(arr) ? arr.filter((m: any) => m && typeof m.content === 'string' && m.role) : []
  } catch {
    return []
  }
}

function isDialogue(m: ChatBubble): boolean {
  return (m.role === 'user' || m.role === 'assistant') && !m.error && !!m.content.trim()
}

export const useAiChatStore = defineStore('ai-chat', () => {
  const isOpen = ref(false)
  /** 当前线程关联的任务 id（= activeThread.focusTodoId） */
  const focusTodoId = ref<string | null>(null)
  /** 当前线程的消息（activeThread.messagesJson 的内存视图） */
  const messages = ref<ChatBubble[]>([])
  /** 当前线程的滚动摘要 */
  const summary = ref('')
  /** 当前线程中已压缩进摘要的可对话消息条数 */
  const summarizedCount = ref(0)
  /** 全部活跃线程（含各自 messagesJson，总量受上限约束） */
  const threads = ref<AiThread[]>([])
  const activeThreadId = ref<string | null>(null)
  const loading = ref(false)

  function activeThread(): AiThread | null {
    if (!activeThreadId.value) return null
    return threads.value.find(t => t.id === activeThreadId.value) ?? null
  }

  // ============ 初始化 / 数据层联动 ============

  let inited = false
  /** 订阅数据层变化 + 旧数据迁移（幂等；数据层未就绪时返回 false，下次再试） */
  function ensureInit(): boolean {
    if (inited) return true
    try {
      const da = getDataAccess()
      da.onChange(onDataChanged)
      migrateLegacyChat()
      refreshThreads()
      inited = true
      return true
    } catch {
      return false
    }
  }

  /** 旧版单会话（localStorage）迁移为一条「自由聊」线程入库 */
  function migrateLegacyChat(): void {
    try {
      const raw = localStorage.getItem(LEGACY_CHAT_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw)
      let msgs: ChatBubble[] = []
      let summaryVal = ''
      let summarized = 0
      if (Array.isArray(parsed)) {
        msgs = parsed
      } else if (parsed && Array.isArray(parsed.messages)) {
        msgs = parsed.messages
        summaryVal = typeof parsed.summary === 'string' ? parsed.summary : ''
        summarized = Number(parsed.summarizedCount) || 0
      }
      if (msgs.length > 0) {
        getDataAccess().saveAiThread({
          id: genId('thread'),
          title: '自由聊',
          summary: summaryVal,
          summarizedCount: summarized,
          messagesJson: JSON.stringify(msgs.slice(-MAX_MESSAGES_PER_THREAD)),
          createdAt: msgs[0]?.time || nowTime(),
          updatedAt: msgs[msgs.length - 1]?.time || nowTime(),
        })
      }
      localStorage.removeItem(LEGACY_CHAT_KEY)
      console.log('[AI] 旧版聊天记录已迁移到数据库')
    } catch (err) {
      console.warn('[AI] 旧版聊天记录迁移失败（忽略）:', err)
      try { localStorage.removeItem(LEGACY_CHAT_KEY) } catch { /* ignore */ }
    }
  }

  function refreshThreads(): void {
    try {
      threads.value = getDataAccess().getAiThreads().filter(t => !t.deleted)
    } catch {
      threads.value = []
    }
  }

  /**
   * 数据层变化后的统一联动（任务增删改 / 云同步写回 / 线程写入都会触发）：
   * 1) 级联清理孤儿线程（关联任务已删除，含他端同步删除）  2) 刷新线程列表
   * 3) 当前线程被云端更新时刷新内存消息；被删除时切换到最近线程
   */
  function onDataChanged(): void {
    purgeOrphanThreads()
    refreshThreads()
    const at = activeThread()
    if (!at) {
      if (activeThreadId.value) {
        // 当前线程已被清理 → 尝试切到最近线程
        const latest = threads.value.slice().sort(byUpdatedAtDesc)[0]
        if (latest) activateThread(latest.id)
        else {
          activeThreadId.value = null
          focusTodoId.value = null
          messages.value = []
          summary.value = ''
          summarizedCount.value = 0
        }
      }
      return
    }
    const fresh = threads.value.find(t => t.id === at.id)
    if (fresh && fresh.updatedAt > at.updatedAt) {
      // 云端合并带来了更新版本（本端没有的新消息）→ 刷新内存
      activateThread(fresh.id)
    }
  }

  /** 关联任务已不存在的活跃线程 → 软删除（tombstone 传播到云端） */
  function purgeOrphanThreads(): void {
    try {
      const da = getDataAccess()
      const validIds = new Set(da.getTodos().map(t => t.id))
      const now = nowTime()
      let changed = false
      for (const t of da.getAiThreads()) {
        if (!t.deleted && t.focusTodoId && !validIds.has(t.focusTodoId)) {
          da.saveAiThread({ ...t, messagesJson: '[]', deleted: true, updatedAt: now })
          changed = true
        }
      }
      if (changed) getSyncEngine().scheduleWrite()
    } catch {
      // 数据层未就绪，跳过
    }
  }

  // todoStore.todos 变化作为「数据层已就绪」的信号，补跑一次初始化
  const todoStoreRef = useTodoStore()
  watch(
    () => todoStoreRef.todos.length,
    () => { ensureInit() },
  )

  // ============ 线程管理 ============

  function activateThread(id: string): void {
    const t = threads.value.find(x => x.id === id)
    if (!t) return
    activeThreadId.value = id
    focusTodoId.value = t.focusTodoId ?? null
    messages.value = safeParseMessages(t.messagesJson)
    summary.value = t.summary || ''
    summarizedCount.value = t.summarizedCount || 0
  }

  function createThread(focusId: string | null): void {
    try {
      const title = focusId
        ? (todoStoreRef.todos as Todo[]).find(t => t.id === focusId)?.title || '对话'
        : '自由聊'
      const now = nowTime()
      const thread: AiThread = {
        id: genId('thread'),
        title,
        focusTodoId: focusId ?? undefined,
        summary: '',
        summarizedCount: 0,
        messagesJson: '[]',
        createdAt: now,
        updatedAt: now,
      }
      getDataAccess().saveAiThread(thread)
      refreshThreads()
      enforceThreadQuota()
      activateThread(thread.id)
    } catch (err) {
      // 数据层未就绪：面板可打开，等就绪后 open()/send() 会再兜底
      console.warn('[AI] 创建会话线程失败（数据层未就绪）:', err)
    }
  }

  /** 活跃线程超过上限时，淘汰最久未更新的（tombstone 传播删除到云端） */
  function enforceThreadQuota(): void {
    try {
      const da = getDataAccess()
      const live = da.getAiThreads().filter(t => !t.deleted).sort(byUpdatedAtDesc)
      const excess = live.slice(MAX_THREADS)
      if (excess.length === 0) return
      const now = nowTime()
      for (const t of excess) {
        da.saveAiThread({ ...t, messagesJson: '[]', deleted: true, updatedAt: now })
      }
      refreshThreads()
      getSyncEngine().scheduleWrite()
    } catch {
      // 数据层未就绪，跳过
    }
  }

  /** 打开面板：从任务详情发起 → 恢复该任务最近线程（没有则新建）；侧边栏 → 自由聊线程 */
  function open(focusId?: string | null) {
    ensureInit()
    purgeOrphanThreads()
    refreshThreads()
    const scope = focusId ?? null
    const candidates = threads.value
      .filter(t => (scope ? t.focusTodoId === scope : !t.focusTodoId))
      .sort(byUpdatedAtDesc)
    if (candidates.length > 0) {
      activateThread(candidates[0].id)
    } else {
      createThread(scope)
    }
    isOpen.value = true
  }

  function close() {
    isOpen.value = false
  }

  /** 切换到指定线程 */
  function switchThread(id: string) {
    if (id === activeThreadId.value) return
    activateThread(id)
  }

  /** 为当前上下文（关联任务 / 自由聊）开新线程，旧的留在列表里 */
  function newThread() {
    const scope = activeThread()?.focusTodoId ?? null
    createThread(scope)
  }

  /** 删除线程；删的是当前线程时自动切到最近的线程 */
  function deleteThread(id: string) {
    try {
      const da = getDataAccess()
      const t = da.getAiThreadById(id)
      if (!t || t.deleted) return
      da.saveAiThread({ ...t, messagesJson: '[]', deleted: true, updatedAt: nowTime() })
      getSyncEngine().scheduleWrite()
    } catch {
      // 数据层未就绪
    }
    refreshThreads()
    if (id === activeThreadId.value) {
      activeThreadId.value = null
      messages.value = []
      summary.value = ''
      summarizedCount.value = 0
      focusTodoId.value = null
      const latest = threads.value.slice().sort(byUpdatedAtDesc)[0]
      if (latest) activateThread(latest.id)
    }
  }

  /** 清空当前线程的消息与摘要（线程实体保留） */
  function clearChat() {
    messages.value = []
    summary.value = ''
    summarizedCount.value = 0
    persistActiveThread()
  }

  // ============ 持久化 ============

  /** 把内存中的当前线程状态写回数据库（触发 300ms 防抖持久化 + 云同步） */
  function persistActiveThread(): void {
    try {
      const da = getDataAccess()
      const at = activeThread()
      if (!at) return
      at.messagesJson = JSON.stringify(messages.value.slice(-MAX_MESSAGES_PER_THREAD))
      at.summary = summary.value
      at.summarizedCount = summarizedCount.value
      at.updatedAt = nowTime()
      da.saveAiThread(at)
      enforceThreadQuota()
      getSyncEngine().scheduleWrite()
    } catch (err) {
      console.error('[AI] 会话保存失败:', err)
    }
  }

  /** 组装发给 AI 的原文窗口（最近 N 条） */
  function historyForApi(): ChatMessage[] {
    return messages.value
      .filter(m => isDialogue(m))
      .slice(-HISTORY_LIMIT)
      .map(m => ({ role: m.role, content: m.content }) as ChatMessage)
  }

  /**
   * 滚动摘要压缩：原文窗口之外的旧消息积攒到阈值后，请求一次 LLM
   * 把它们增量并入当前线程的摘要。失败时静默降级（本轮沿用旧摘要，下次重试）。
   */
  async function maybeCompress(ai: AiClientConfig) {
    const eligible = messages.value.filter(m => isDialogue(m))
    const outsideCount = Math.max(0, eligible.length - HISTORY_LIMIT)
    const pending = eligible.slice(summarizedCount.value, outsideCount)
    if (pending.length < COMPRESS_BATCH) return
    try {
      const dialogues = pending
        .map(m => `${m.role === 'user' ? '用户' : '小柴'}：${m.content}`)
        .join('\n')
      const next = await chatCompletion(
        ai,
        [{ role: 'user', content: buildSummaryPrompt(summary.value, dialogues) }],
        { maxTokens: 700, temperature: 0.3, timeoutMs: 60000 },
      )
      if (next.trim()) {
        summary.value = next.trim()
        summarizedCount.value += pending.length
        persistActiveThread()
      }
    } catch (err) {
      console.warn('[AI] 上下文摘要更新失败（本轮沿用旧摘要，稍后自动重试）:', err)
    }
  }

  // ============ 对话 ============

  async function send(text: string) {
    const content = text.trim()
    if (!content || loading.value) return

    ensureInit()
    // 没有激活线程时兜底创建（正常由 open() 保证）
    if (!activeThread()) createThread(focusTodoId.value)

    const settingsStore = useSettingsStore()
    const ai = settingsStore.settings.ai

    // 未配置：不调 API，直接给引导提示
    if (!isAiConfigured(ai)) {
      messages.value.push({
        id: genId('msg'),
        role: 'system',
        content: '还没配置 AI 服务：请到「设置 → AI 助手」填写 Base URL、API Key 和模型名。',
        time: nowTime(),
      })
      persistActiveThread()
      return
    }

    messages.value.push({ id: genId('msg'), role: 'user', content, time: nowTime() })
    persistActiveThread()
    loading.value = true

    try {
      const todos = (useTodoStore().todos) as Todo[]

      // system = 默认人设 + 用户自定义追加 + 动态上下文（今天/清单/聚焦任务）
      const sections = [DEFAULT_COACH_SYSTEM_PROMPT]
      if (ai.customPrompt?.trim()) {
        sections.push(`# 用户对小柴的额外要求（优先级更高）\n${ai.customPrompt.trim()}`)
      }
      sections.push(buildContextSection(todos, focusTodoId.value))

      // 窗口外旧对话已压缩成摘要：先按需更新摘要，再随请求注入
      await maybeCompress(ai)
      const apiMessages: ChatMessage[] = [{ role: 'system', content: sections.join('\n\n') }]
      if (summary.value.trim()) {
        apiMessages.push({
          role: 'system',
          content: `# 此前对话摘要（更早的对话已压缩如下）\n${summary.value.trim()}`,
        })
      }
      apiMessages.push(...historyForApi())
      const raw = await chatCompletion(ai, apiMessages)

      // 幻觉防御：只认可当前清单里真实存在的任务 id
      const validIds = new Set(todos.map(t => t.id))
      const parsed = parseAiReply(raw, validIds)
      const resolveTitle = (id: string) => todos.find(t => t.id === id)?.title

      const assistantMsg: ChatBubble = {
        id: genId('msg'),
        role: 'assistant',
        content: parsed.content || (parsed.actions.length
          ? '我已经直接帮你把清单调整好了：'
          : '（AI 返回了空回复，请重试）'),
        actions: parsed.actions.length ? parsed.actions : undefined,
        actionLabels: parsed.actions.length
          ? parsed.actions.map(a => describeAction(a, resolveTitle))
          : undefined,
        // 直接执行：先标记为已应用，避免头像中间态闪出「应用到清单」按钮
        actionsState: parsed.actions.length ? 'applied' : undefined,
        time: nowTime(),
      }
      messages.value.push(assistantMsg)
      persistActiveThread()

      // 自动朗读（设置开启时）；Edge/Azure 失败已在 speak 内部降级，静默即可
      const ttsCfg = settingsStore.settings.tts
      if (ttsCfg.autoSpeak && parsed.content) {
        speakWithSettings(parsed.content, ttsCfg, { messageId: assistantMsg.id })
          .catch(err => console.warn('[AI] 自动朗读失败:', err))
      }

      // 清单操作直接执行，不再停下来等用户确认（用户不满意可以让小柴再改，或手动删）
      if (assistantMsg.actions?.length) {
        const done = await runActions(assistantMsg)
        finishActions(assistantMsg, done, true)
      }
    } catch (err) {
      messages.value.push({
        id: genId('msg'),
        role: 'assistant',
        content: err instanceof Error ? err.message : '请求失败，请稍后重试',
        error: true,
        time: nowTime(),
      })
      persistActiveThread()
    } finally {
      loading.value = false
    }
  }

  /** 执行一条消息携带的全部操作（逐条执行，失败的跳过），返回成功条数 */
  async function runActions(msg: ChatBubble): Promise<number> {
    const todoStore = useTodoStore()
    const todos = () => todoStore.todos as Todo[]
    const findTodo = (id: string) => todos().find(t => t.id === id)
    let done = 0

    for (const a of msg.actions ?? []) {
      try {
        if (a.type === 'add_todo') {
          const parent = a.parentId ? findTodo(a.parentId) : null
          await todoStore.addTodo({
            title: a.title,
            priority: a.priority ?? 0,
            // AI 未指定日期时继承父任务日期（与详情面板添加子任务行为一致）
            dueDate: a.dueDate ? new Date(a.dueDate).toISOString() : parent?.dueDate,
            startDate: parent?.startDate,
            parentId: parent?.id,
            content: a.content,
          })
        } else if (a.type === 'update_todo') {
          const updates: Record<string, any> = {}
          if (a.title !== undefined) updates.title = a.title
          if (a.priority !== undefined) updates.priority = a.priority
          if (a.dueDate !== undefined) updates.dueDate = new Date(a.dueDate).toISOString()
          if (a.content !== undefined) updates.content = a.content
          if (Object.keys(updates).length > 0) {
            await todoStore.updateTodo(a.id, updates)
          }
        } else if (a.type === 'complete_todo') {
          const t = findTodo(a.id)
          if (t && !t.completed) await todoStore.toggleTodo(a.id)
        } else if (a.type === 'remove_todo') {
          if (findTodo(a.id)) await todoStore.removeTodo(a.id)
        }
        done++
      } catch (err) {
        console.error('[AI] 应用建议操作失败:', a, err)
      }
    }
    return done
  }

  /** 执行完毕：标记状态 + 追加一条系统回执小字 */
  function finishActions(msg: ChatBubble, done: number, auto: boolean): void {
    msg.actionsState = 'applied'
    messages.value.push({
      id: genId('msg'),
      role: 'system',
      content: done > 0
        ? (auto ? `小柴已直接调整清单（${done} 条）✓` : `已按建议更新清单（${done} 条）✓`)
        : '没有可执行的操作',
      time: nowTime(),
    })
    persistActiveThread()
  }

  /** 手动应用一条建议卡片（兼容历史遗留的待确认卡片） */
  async function applyActions(msgId: string) {
    const msg = messages.value.find(m => m.id === msgId)
    if (!msg || !msg.actions || msg.actionsState !== 'pending') return
    const done = await runActions(msg)
    finishActions(msg, done, false)
  }

  function dismissActions(msgId: string) {
    const msg = messages.value.find(m => m.id === msgId)
    if (!msg || msg.actionsState !== 'pending') return
    msg.actionsState = 'dismissed'
    persistActiveThread()
  }

  return {
    isOpen,
    focusTodoId,
    messages,
    summary,
    threads,
    activeThreadId,
    loading,
    open,
    close,
    switchThread,
    newThread,
    deleteThread,
    send,
    applyActions,
    dismissActions,
    clearChat,
  }
})
