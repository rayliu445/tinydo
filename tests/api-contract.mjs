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
const PROTOCOL_VERSION = 1

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

  console.log('\n6. 清理')
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
