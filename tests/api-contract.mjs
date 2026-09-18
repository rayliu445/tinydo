#!/usr/bin/env node
/**
 * 本地桥接「协议契约测试」（App 侧，自包含）
 *
 * 只用 fetch + 发现文件，**不依赖任何客户端代码**——客户端（tinydo CLI / DSH 插件）已经
 * 搬到独立仓库 tinydo-agent，这里只验证 App 这一侧的契约没退化：
 *   鉴权、增删改查、级联、批量 dry-run、查询、统计、审计、错误码、协议版本。
 *
 * 用法：TINYDO_NO_LAUNCH 无关（本脚本不拉起 App）；先确保 TinyDo 在运行。
 *   node tests/api-contract.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PORT_FILE = process.env.TINYDO_API_PORT_FILE || path.join(os.homedir(), '.tinydo', 'local-api.json')
const TAG = `contract-${Date.now().toString(36)}`
const PROTOCOL_VERSION = 2

let pass = 0
let failed = 0
const created = []

function check(label, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function endpoint() {
  const raw = JSON.parse(fs.readFileSync(PORT_FILE, 'utf8'))
  if (raw.enabled === false) throw new Error('外部助手已在设置里关闭（发现文件标记 enabled=false）')
  return raw
}

const ep = endpoint()
const BASE = `http://127.0.0.1:${ep.port}`

async function api(method, apiPath, body) {
  const res = await fetch(BASE + apiPath, {
    method,
    headers: { Authorization: `Bearer ${ep.token}`, 'X-TinyDo-Actor': 'contract-test', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : {} }
}

const localDate = (offset = 0) => {
  const d = new Date(Date.now() + offset * 86400000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

async function main() {
  console.log(`TinyDo 本地接口：${BASE}（App 版本 ${ep.version}，发现文件 ${PORT_FILE}）`)

  console.log('\n1. 协议版本与鉴权')
  const health = await (await fetch(`${BASE}/health`)).json()
  check('/health 无需鉴权且带 app 标识', health.ok === true && health.app === 'tinydo')
  // 前向兼容：字段缺失 = 老版本 App（该字段自 v0.1.23 起提供）；存在则必须与本文档一致
  check(`/health 的协议版本兼容（缺失视为 1）`, health.api === undefined || health.api === PROTOCOL_VERSION,
    `实得 ${health.api}`)
  const noAuth = await fetch(`${BASE}/v1/tasks`)
  check('缺 token → 401', noAuth.status === 401)

  console.log('\n2. 增删改查 + 级联')
  const parent = await api('POST', '/v1/tasks', { title: `${TAG} 写周报`, dueDate: localDate(0), priority: 3 })
  check('POST /v1/tasks 新增成功', parent.status === 200 && !!parent.body.task?.id, JSON.stringify(parent.body).slice(0, 120))
  const pid = parent.body.task.id
  created.push(pid)

  const child = await api('POST', '/v1/tasks', { title: `${TAG} 写大纲`, parentId: pid, dueDate: localDate(0) })
  check('子任务挂父任务', child.body.task?.parentId === pid)
  created.push(child.body.task.id)

  const detail = await api('GET', `/v1/tasks/${pid}`)
  check('GET /v1/tasks/:id 返回子任务', detail.body.children?.some((c) => c.id === child.body.task.id))

  const upd = await api('PATCH', `/v1/tasks/${child.body.task.id}`, { priority: 5, dueDate: localDate(1) })
  check('PATCH 返回变更清单', Array.isArray(upd.body.changed) && upd.body.changed.length >= 2, JSON.stringify(upd.body.changed))

  const done = await api('POST', `/v1/tasks/${pid}/complete`, { completed: true })
  check('完成父任务级联子任务', done.body.affected?.includes(child.body.task.id))
  const undone = await api('POST', `/v1/tasks/${pid}/complete`, { completed: false })
  check('取消完成同样级联', undone.body.affected?.includes(child.body.task.id))

  console.log('\n3. 查询 / 批量 / 统计')
  const today = await api('GET', '/v1/tasks?view=today')
  check('view=today 含刚建任务且顶层都是今天到期',
    today.body.tasks?.some((t) => t.id === pid) &&
    today.body.tasks.filter((t) => !t.parentId).every((t) => String(t.dueDate || '').startsWith(localDate(0))))
  const search = await api('GET', `/v1/tasks?view=all&search=${encodeURIComponent(TAG)}`)
  check('search 命中', (search.body.total ?? 0) >= 2)

  const dry = await api('POST', '/v1/tasks/bulk', { dryRun: true, items: [{ title: `${TAG} dry` }, { title: '' }] })
  check('bulk dryRun 不落库且逐条返回', dry.body.dryRun === true && dry.body.created === 0 && dry.body.results?.length === 2)
  const bulk = await api('POST', '/v1/tasks/bulk', {
    items: [{ title: `${TAG} 批量-1`, dueDate: localDate(0) }, { title: `${TAG} 批量-坏`, priority: 2 }],
  })
  check('bulk 成功 1 失败 1', bulk.body.created === 1 && bulk.body.failed === 1)
  for (const r of bulk.body.results || []) if (r.id) created.push(r.id)

  const stats = await api('GET', '/v1/stats')
  check('stats 结构完整', typeof stats.body.pending === 'number' && typeof stats.body.overdue === 'number'
    && typeof stats.body.byPriority === 'object')

  console.log('\n4. 错误码（模型可读）')
  const badPriority = await api('POST', '/v1/tasks', { title: 'x', priority: 2 })
  check('priority 非法 → 400 BAD_REQUEST', badPriority.status === 400 && badPriority.body.error?.code === 'BAD_REQUEST')
  const notFound = await api('GET', '/v1/tasks/todo_not_exist')
  check('id 不存在 → 404 TASK_NOT_FOUND', notFound.status === 404 && notFound.body.error?.code === 'TASK_NOT_FOUND')
  const badParent = await api('POST', '/v1/tasks', { title: 'x', parentId: 'todo_nope' })
  check('父任务不存在 → 400', badParent.status === 400)
  const unknown = await api('GET', '/v1/nope')
  check('未知接口 → 404 NOT_FOUND', unknown.status === 404 && unknown.body.error?.code === 'NOT_FOUND')

  console.log('\n5. 审计与删除')
  const audit = await api('GET', '/v1/audit?limit=50')
  const mine = (audit.body.entries || []).filter((e) => (e.taskIds || []).some((id) => created.includes(id)))
  check('审计记录了写入且 actor 正确', mine.length >= 3 && mine.every((e) => e.actor === 'contract-test'))
  check('审计含动作类型', ['add_task', 'update_task', 'complete_task'].every((a) =>
    (audit.body.entries || []).some((e) => e.action === a)))

  const del = await api('DELETE', `/v1/tasks/${pid}`)
  check('删除父任务级联后代', del.body.deleted?.includes(pid) && del.body.deleted.includes(child.body.task.id))
  const after = await api('GET', `/v1/tasks?view=all&search=${encodeURIComponent(TAG)}`)
  check('删除后查不到', !(after.body.tasks || []).some((t) => t.id === pid || t.id === child.body.task.id))

  console.log('\n6. 扩展能力：总览 / 批量更新 / 撤销载荷 / 还原 / 笔记（协议 api 2）')
  // 6.1 清单 / 标签总览
  const tagged = await api('POST', '/v1/tasks', {
    title: `${TAG} 带清单标签`, list: '工作', tags: ['周报'], dueDate: localDate(-1),
  })
  created.push(tagged.body.task.id)
  const ov = await api('GET', '/v1/overview')
  check('overview 返回清单/标签聚合', Array.isArray(ov.body.lists) && Array.isArray(ov.body.tags)
    && ov.body.lists.some((l) => l.name === '工作' && l.pending >= 1 && l.overdue >= 1)
    && ov.body.tags.some((t) => t.name === '周报' && t.pending >= 1))
  check('overview 含笔记计数', typeof ov.body.notes?.active === 'number' && typeof ov.body.notes?.archived === 'number')

  // 6.2 批量更新（一次刷新改多条）
  const bulkA = await api('POST', '/v1/tasks', { title: `${TAG} 批量甲` })
  const bulkB = await api('POST', '/v1/tasks', { title: `${TAG} 批量乙` })
  created.push(bulkA.body.task.id, bulkB.body.task.id)
  const bulkUpd = await api('POST', '/v1/tasks/bulk-update', {
    updates: [
      { id: bulkA.body.task.id, priority: 5, tags: ['批量'] },
      { id: bulkB.body.task.id, dueDate: localDate(3) },
    ],
  })
  check('bulk-update 一次改多条', bulkUpd.body.updated === 2 && bulkUpd.body.results.length === 2)
  const bulkAafter = await api('GET', `/v1/tasks/${bulkA.body.task.id}`)
  check('bulk-update 字段生效', bulkAafter.body.task.priority === 5 && bulkAafter.body.task.tags.includes('批量'))
  const bulkBad = await api('POST', '/v1/tasks/bulk-update', { updates: [{ id: 'todo_nope', priority: 5 }] })
  check('bulk-update 对不存在的 id 逐条报错', bulkBad.body.updated === 0 && !!bulkBad.body.results[0]?.error)

  // 6.3 审计里的结构化撤销载荷
  const audit2 = await api('GET', '/v1/audit?limit=30')
  const entries = audit2.body.entries || []
  check('审计带结构化 undo：新增一条', entries.some((e) => e.undo?.op === 'delete_tasks' && (e.undo.ids || []).length > 0))
  check('审计带结构化 undo：批量改字段', entries.some((e) => e.undo?.op === 'restore_fields' && Array.isArray(e.undo.before) && e.undo.before.length > 0))

  // 6.4 删除 → 用审计快照还原
  const victim = await api('POST', '/v1/tasks', {
    title: `${TAG} 待还原`, dueDate: localDate(1), priority: 3, tags: ['还原'], content: '快照测试',
  })
  const victimId = victim.body.task.id
  const victimDel = await api('DELETE', `/v1/tasks/${victimId}`)
  check('删除任务', victimDel.body.deleted?.includes(victimId))
  const gone = await api('GET', `/v1/tasks/${victimId}`)
  check('删除后查询 404', gone.status === 404)
  const audit3 = await api('GET', '/v1/audit?limit=5')
  const undoPayload = (audit3.body.entries || []).find((e) => e.action === 'delete_task' && (e.taskIds || []).includes(victimId))?.undo
  check('删除的审计载荷含完整快照', undoPayload?.op === 'restore_tasks' && undoPayload.before?.[0]?.id === victimId
    && undoPayload.before[0].title === `${TAG} 待还原`
    && undoPayload.before[0].content === '快照测试'
    && Array.isArray(undoPayload.before[0].tags))
  const restored = await api('POST', '/v1/tasks/restore', { tasks: undoPayload.before })
  check('restore 还原软删除任务', restored.body.restored >= 1)
  const back = await api('GET', `/v1/tasks/${victimId}`)
  check('还原后字段保留', back.status === 200 && back.body.task.title === `${TAG} 待还原`
    && back.body.task.content === '快照测试' && back.body.task.tags.includes('还原'))
  created.push(victimId)

  // 6.5 笔记（kind=NOTE）：不进任务列表，独立归档语义
  const note = await api('POST', '/v1/notes', { title: `${TAG} 随想`, content: '第一版内容' })
  const noteId = note.body.note?.id
  check('新增笔记（kind=NOTE）', note.status === 200 && note.body.note.kind === 'NOTE', JSON.stringify(note.body).slice(0, 120))
  const activeNotes = await api('GET', '/v1/notes')
  check('未归档笔记列表包含它', (activeNotes.body.notes || []).some((n) => n.id === noteId))
  const noteSearch = await api('GET', `/v1/notes?search=${encodeURIComponent('第一版')}`)
  check('笔记可搜内容（不只是标题）', (noteSearch.body.notes || []).some((n) => n.id === noteId))
  const noteUpd = await api('PATCH', `/v1/notes/${noteId}`, { content: '第二版内容', archived: true })
  check('更新内容并归档', noteUpd.body.note.completed === true && noteUpd.body.note.content === '第二版内容')
  const archivedNotes = await api('GET', '/v1/notes?archived=1')
  check('归档列表包含它', (archivedNotes.body.notes || []).some((n) => n.id === noteId && n.completed === true))
  const activeAfter = await api('GET', '/v1/notes')
  check('归档后不在未归档列表', !(activeAfter.body.notes || []).some((n) => n.id === noteId))
  const tasksAll = await api('GET', '/v1/tasks?view=all')
  check('笔记不进任务列表', !(tasksAll.body.tasks || []).some((t) => t.id === noteId))
  const note404 = await api('PATCH', '/v1/notes/todo_not_exist', { content: 'x' })
  check('不存在的笔记 → 404 NOTE_NOT_FOUND', note404.status === 404 && note404.body.error?.code === 'NOTE_NOT_FOUND')
  const noteDel = await api('DELETE', `/v1/notes/${noteId}`)
  check('删除笔记', noteDel.status === 200 && noteDel.body.deleted?.includes(noteId))

  console.log('\n7. 清理')
  let cleaned = 0
  for (const id of created) {
    const res = await api('DELETE', `/v1/tasks/${id}`)
    if (res.status === 200) cleaned++
  }
  check(`清理测试数据（${cleaned}/${created.length}）`, cleaned > 0)

  console.log(`\n结果：${pass} 通过，${failed} 失败`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error('\n契约测试异常终止：', err.message)
  if (/ENOENT/.test(err.message)) console.error('提示：没找到发现文件，请先打开 TinyDo（设置 → 外部助手 需开启）')
  process.exit(1)
})
