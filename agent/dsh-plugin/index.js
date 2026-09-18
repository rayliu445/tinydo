/**
 * TinyDo × DSH 插件：把任务清单变成 DSH 的原生工具
 *
 * 设计要点（见 docs/agent-bridge-design.md §8）：
 * - 薄壳：只用宿主一个方法 ctx.tools.register，业务逻辑全在 ../lib/client.mjs
 * - 只依赖 node builtins；不 import 宿主的任何内部模块
 * - 注册失败只打日志、绝不拖垮宿主（DSH 预览版可能改工具面）
 * - 同包附 skills/tinydo/SKILL.md 作为降级通道：工具没了还能用 CLI
 */

import { createClient, resolvePortFile } from '../lib/client.mjs'

export const name = 'tinydo'
export const inject = ['tools']

const PRIORITY_LABEL = { 0: '无', 1: '低', 3: '中', 5: '高' }
const TIMEOUT_MS = 30000

// ============ 输出格式化（紧凑文本，省 context） ============

function ymd(iso) {
  return iso ? String(iso).slice(0, 10) : ''
}

function localDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function dayLabel(iso) {
  const day = ymd(iso)
  if (!day) return ''
  if (day === localDate(0)) return '今天'
  if (day === localDate(1)) return '明天'
  if (day === localDate(-1)) return '昨天'
  if (day < localDate(0)) return `${day}（已逾期）`
  return day
}

function taskLine(t, depth = 0) {
  const box = t.completed ? '[x]' : '[ ]'
  const bits = [
    dayLabel(t.dueDate),
    t.priority ? PRIORITY_LABEL[t.priority] : '',
    t.parentId ? `父=${t.parentId}` : '',
    (t.tags || []).length ? `#${t.tags.join(' #')}` : '',
    t.list ? `清单=${t.list}` : '',
  ].filter(Boolean)
  return `${'  '.repeat(depth)}${box} ${t.title}${bits.length ? ` ｜ ${bits.join(' ｜ ')}` : ''} ｜ id=${t.id}`
}

function renderTasks(tasks) {
  if (!tasks.length) return '（没有匹配的任务）'
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const depthOf = (t) => {
    let depth = 0
    let cur = t
    const seen = new Set()
    while (cur?.parentId && byId.has(cur.parentId) && !seen.has(cur.id)) {
      seen.add(cur.id)
      depth++
      cur = byId.get(cur.parentId)
    }
    return depth
  }
  return tasks.map((t) => taskLine(t, depthOf(t))).join('\n')
}

function fail(err) {
  const code = err?.code ? `（${err.code}）` : ''
  const hint = {
    NOT_RUNNING: 'TinyDo 桌面端没有运行且自动拉起失败：请先打开 TinyDo 再重试。',
    NETWORK: '连不上 TinyDo 本地接口：确认 TinyDo 正在运行、设置里的「外部助手」是开启状态。',
    DISABLED: '用户在 TinyDo 设置里关闭了「外部助手」，请让用户开启后再试。',
    TASK_NOT_FOUND: '任务 id 不存在（可能已被删除）：先用 tinydo_list_tasks 拿到有效 id。',
    BAD_REQUEST: '参数不合法：检查日期用 YYYY-MM-DD、优先级用 0/1/3/5。',
    UNAUTHORIZED: 'token 失效：通常是 TinyDo 重启过，重试一次即可（会自动重读发现文件）。',
  }[err?.code]
  return `失败${code}：${err?.message || err}${hint ? `\n提示：${hint}` : ''}`
}

// ============ 工具定义 ============

/**
 * 宿主（@deepseek-ai/dsh-tools）要求每个工具**必须**声明 output：
 * - `schema` 用来校验 execute() 的返回值（我们统一返回紧凑文本 → type: 'string'）
 * - `render` 把返回值转成给模型读的 content blocks
 * 每次新建对象，避免多个工具共享同一份引用。
 */
function textOutput() {
  return {
    schema: { type: 'string', description: '工具结果：紧凑文本，直接读即可' },
    render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? '') }],
  }
}

function buildTools(client, nextSourceId) {
  const read = (name, description, parameters, run) => ({
    name,
    description,
    parameters,
    output: textOutput(),
    timeoutMs: TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: name, kind: 'read', rawInput: args }),
    async execute(args = {}) {
      try {
        return await run(args)
      } catch (err) {
        return fail(err)
      }
    },
  })

  const write = (name, description, parameters, run) => ({
    name,
    description,
    parameters,
    output: textOutput(),
    timeoutMs: TIMEOUT_MS,
    // 写操作串行执行，避免同一批操作互相踩到
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: name, kind: 'write', rawInput: args }),
    async execute(args = {}) {
      try {
        return await run(args)
      } catch (err) {
        return fail(err)
      }
    },
  })

  return [
    read(
      'tinydo_list_tasks',
      '列出 TinyDo 任务（可按视图/关键词/清单/标签过滤）。返回层级顺序的清单，含任务 id 供后续读写引用。',
      {
        type: 'object',
        properties: {
          view: {
            type: 'string',
            enum: ['inbox', 'today', 'next7', 'completed', 'all'],
            description: 'inbox=未完成（默认）；today=今天到期；next7=最近7天；completed=已完成；all=全部',
          },
          search: { type: 'string', description: '标题关键词，不区分大小写' },
          list: { type: 'string', description: '按清单名过滤' },
          tag: { type: 'string', description: '按单个标签过滤' },
          limit: { type: 'number', description: '最多返回条数（默认 200，上限 1000）' },
        },
      },
      async (args) => {
        const data = await client.listTasks(args)
        const shown = Math.min(data.tasks.length, 80)
        const head = `共 ${data.total} 条（视图 ${data.view}，排序 ${data.order === 'asc' ? '旧的在前' : '新的在前'}）`
        const body = renderTasks(data.tasks.slice(0, shown))
        const more = data.tasks.length > shown ? `\n…其余 ${data.tasks.length - shown} 条已省略（用 search/limit 收窄）` : ''
        return `${head}\n${body}${more}`
      },
    ),

    read(
      'tinydo_get_task',
      '读取单个任务的完整信息（含直接子任务）。',
      {
        type: 'object',
        properties: { id: { type: 'string', description: '任务 id（形如 todo_xxx）' } },
        required: ['id'],
      },
      async ({ id }) => {
        const data = await client.getTask(id)
        const t = data.task
        const lines = [
          taskLine(t),
          `内容：${t.content || '（无）'}`,
          `开始：${ymd(t.startDate) || '（无）'} ｜ 创建：${ymd(t.createdAt)} ｜ 完成：${ymd(t.completedTime) || '（未完成）'}`,
        ]
        if (data.children.length) {
          lines.push(`子任务（${data.children.length}）：`)
          lines.push(renderTasks(data.children))
        }
        return lines.join('\n')
      },
    ),

    write(
      'tinydo_add_task',
      '新增一个任务；带 parentId 时作为子任务挂在父任务下。重复调用同一条会被幂等保护（不会产生重复任务）。',
      {
        type: 'object',
        properties: {
          title: { type: 'string', description: '任务标题（动词开头、可执行）' },
          dueDate: { type: 'string', description: '截止日期 YYYY-MM-DD' },
          startDate: { type: 'string', description: '开始日期 YYYY-MM-DD' },
          priority: { type: 'number', enum: [0, 1, 3, 5], description: '0 无 / 1 低 / 3 中 / 5 高' },
          parentId: { type: 'string', description: '父任务 id（必须真实存在）' },
          content: { type: 'string', description: '备注内容' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签' },
          list: { type: 'string', description: '清单名' },
        },
        required: ['title'],
      },
      async (args) => {
        const data = await client.addTask({ ...args, sourceId: args.sourceId || nextSourceId() })
        return data.deduped
          ? `已存在同一条任务（幂等命中，未重复创建）：\n${taskLine(data.task)}`
          : `已新增：\n${taskLine(data.task)}`
      },
    ),

    write(
      'tinydo_update_task',
      '修改任务字段（只传要改的字段）。clearDue=true 可清空截止日期。',
      {
        type: 'object',
        properties: {
          id: { type: 'string', description: '任务 id' },
          title: { type: 'string' },
          dueDate: { type: 'string', description: '新的截止日期 YYYY-MM-DD' },
          clearDue: { type: 'boolean', description: '清空截止日期' },
          startDate: { type: 'string' },
          priority: { type: 'number', enum: [0, 1, 3, 5] },
          parentId: { type: 'string', description: '移到另一个父任务下' },
          content: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          list: { type: 'string' },
        },
        required: ['id'],
      },
      async (args) => {
        const { id, clearDue, ...rest } = args
        const body = { ...rest }
        if (clearDue) body.dueDate = null
        const data = await client.updateTask(id, body)
        if (!data.changed.length) return `没有变化：${data.task?.title || id}`
        return `已修改「${data.task?.title || id}」：\n- ${data.changed.join('\n- ')}`
      },
    ),

    write(
      'tinydo_complete_task',
      '标记任务完成或取消完成。与 TinyDo 界面一致：会级联所有子任务。',
      {
        type: 'object',
        properties: {
          id: { type: 'string', description: '任务 id' },
          completed: { type: 'boolean', description: 'true 完成（默认）/ false 取消完成' },
        },
        required: ['id'],
      },
      async ({ id, completed }) => {
        const data = await client.completeTask(id, completed !== false)
        if (!data.changed) return `状态本来就是目标状态：${data.task?.title || id}`
        const kids = data.affected.length - 1
        return `已${completed === false ? '取消完成' : '完成'}「${data.task?.title || id}」${kids > 0 ? `（连带 ${kids} 个子任务）` : ''}`
      },
    ),

    write(
      'tinydo_delete_task',
      '删除任务（软删除，可在审计里追溯）。注意：会同时删除它的所有子任务；不可通过工具撤销。',
      {
        type: 'object',
        properties: { id: { type: 'string', description: '任务 id' } },
        required: ['id'],
      },
      async ({ id }) => {
        const before = await client.getTask(id)
        const data = await client.deleteTask(id)
        return `已删除「${before.task.title}」${data.deleted.length > 1 ? `（连带 ${data.deleted.length - 1} 个子任务）` : ''}`
      },
    ),

    write(
      'tinydo_bulk_add_tasks',
      '一次新增多条任务（≤50），逐条返回结果。适合把一个大任务拆成一组子任务：给每条带 parentId。',
      {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: '任务数组，字段同 tinydo_add_task（title 必填）',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                dueDate: { type: 'string' },
                priority: { type: 'number', enum: [0, 1, 3, 5] },
                parentId: { type: 'string' },
                content: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
                list: { type: 'string' },
              },
              required: ['title'],
            },
          },
          dryRun: { type: 'boolean', description: '只校验不写入' },
        },
        required: ['items'],
      },
      async ({ items, dryRun }) => {
        const withIds = items.map((item) => ({ ...item, sourceId: item.sourceId || nextSourceId() }))
        const data = await client.bulkAddTasks({ items: withIds, dryRun: !!dryRun })
        if (dryRun) return `[dry-run] 将新增 ${data.results.filter((r) => !r.error).length} 条，校验失败 ${data.failed} 条`
        const created = data.results.filter((r) => r.id)
        const lines = created.map((r) => `- ${r.title} ｜ id=${r.id}${r.deduped ? '（幂等命中）' : ''}`)
        const errors = data.results.filter((r) => r.error).map((r) => `- #${r.index} 失败：${r.error}`)
        return `已新增 ${data.created} 条，失败 ${data.failed} 条${lines.length ? `\n${lines.join('\n')}` : ''}${errors.length ? `\n失败明细：\n${errors.join('\n')}` : ''}`
      },
    ),

    read(
      'tinydo_stats',
      '任务概览：未完成/已完成、今天、最近7天、逾期、按优先级与清单分布。回答“我最近怎么样”这类问题前先看它。',
      { type: 'object', properties: {} },
      async () => {
        const d = await client.stats()
        const lists = Object.entries(d.byList || {}).map(([k, v]) => `${k} ${v}`).join('，')
        return [
          `未完成 ${d.pending}（顶层 ${d.topLevelPending}）｜已完成 ${d.completed}`,
          `今天 ${d.today}｜最近7天 ${d.next7}｜已逾期 ${d.overdue}`,
          `优先级：高 ${d.byPriority['5'] ?? 0} / 中 ${d.byPriority['3'] ?? 0} / 低 ${d.byPriority['1'] ?? 0} / 无 ${d.byPriority['0'] ?? 0}`,
          lists ? `清单：${lists}` : '',
        ].filter(Boolean).join('\n')
      },
    ),

    read(
      'tinydo_recent_changes',
      '最近的写入审计（谁改的、改了什么）。用户问“刚才你动了哪些任务”时用它回答。',
      {
        type: 'object',
        properties: { limit: { type: 'number', description: '返回条数（默认 20，上限 200）' } },
      },
      async ({ limit }) => {
        const data = await client.audit(Math.min(Math.max(Number(limit) || 20, 1), 200))
        if (!data.entries.length) return '（还没有外部写入记录）'
        return data.entries
          .map((e) => `${new Date(e.ts).toLocaleString('zh-CN', { hour12: false })} ｜ ${e.actor || 'external'} ｜ ${e.summary || e.action}`)
          .join('\n')
      },
    ),
  ]
}

// ============ 插件入口（cordis） ============

export function apply(ctx, config = {}) {
  if (!ctx?.tools?.register) {
    console.error('[tinydo] 宿主没有 ctx.tools.register，跳过注册（可用 skills/tinydo 里的 CLI 方式）')
    return
  }

  const client = createClient({
    actor: config.actor || 'dsh',
    appPath: config.appPath,
    log: (msg) => console.error(`[tinydo] ${msg}`),
  })

  let seq = 0
  const nextSourceId = () => `dsh:${Date.now().toString(36)}:${++seq}`

  let ok = 0
  for (const tool of buildTools(client, nextSourceId)) {
    try {
      ctx.tools.register(tool)
      ok++
    } catch (err) {
      // 预览版工具面变化时：大声降级，绝不拖垮宿主
      console.error(`[tinydo] ${tool.name} 注册失败（DSH 工具面可能变了）：${err?.message || err}`)
    }
  }
  console.error(`[tinydo] 已注册 ${ok} 个工具（发现文件：${resolvePortFile()}）`)
}
