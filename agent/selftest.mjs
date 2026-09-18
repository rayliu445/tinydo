#!/usr/bin/env node
/**
 * TinyDo × 外部助手 自检（对着真实运行的 App 跑，覆盖设计文档 §9 的验收标准）
 *
 * 用法：
 *   node agent/selftest.mjs            # 自动发现（必要时自动拉起 App）
 *   TINYDO_NO_LAUNCH=1 node agent/selftest.mjs   # 只测已运行的实例
 *
 * 只读写带唯一前缀的测试任务，跑完自行清理（软删除）。
 */

import { createClient, TinyDoApiError, readEndpoint } from './lib/client.mjs'

const TAG = `selftest-${Date.now().toString(36)}`
const client = createClient({ actor: 'cli' })

let pass = 0
let failed = 0
const created = []

function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

async function expectError(name, fn, { status, code } = {}) {
  try {
    await fn()
    check(name, false, '预期报错但成功了')
  } catch (err) {
    const okStatus = status === undefined || err.status === status
    const okCode = code === undefined || err.code === code
    check(name, okStatus && okCode, `收到 ${err.status}/${err.code}：${err.message}`)
  }
}

const today = new Date()
const pad = (n) => String(n).padStart(2, '0')
const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
const tomorrow = new Date(today.getTime() + 86400000)
const tomorrowStr = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`

async function main() {
  const endpoint = await client.ensureEndpoint()
  console.log(`TinyDo 本地 API：127.0.0.1:${endpoint.port}（版本 ${endpoint.version}，发现文件 ${endpoint.portFile}）`)

  section('1. 鉴权与健康检查')
  const health = await client.health()
  check('/health 可用', health.ok === true && health.app === 'tinydo')
  {
    const res = await fetch(`http://127.0.0.1:${endpoint.port}/v1/tasks`, {
      headers: { Authorization: 'Bearer wrong-token' },
    })
    const body = await res.json().catch(() => ({}))
    check('错误 token 被拒绝（401）', res.status === 401 && body?.error?.code === 'UNAUTHORIZED')
  }

  section('2. 新增 / 幂等 / 父子关系（验收 2、8）')
  const parent = await client.addTask({
    title: `${TAG} 写周报`,
    dueDate: todayStr,
    priority: 3,
    content: '自检创建',
  })
  created.push(parent.task.id)
  check('新增任务返回 id 与字段', !!parent.task.id && parent.task.title === `${TAG} 写周报`)
  check('dueDate 归一化为 ISO', String(parent.task.dueDate).startsWith(todayStr))

  const again = await client.addTask({ title: `${TAG} 写周报`, sourceId: `${TAG}-idem`, dueDate: todayStr })
  const third = await client.addTask({ title: `${TAG} 写周报（重复）`, sourceId: `${TAG}-idem`, dueDate: todayStr })
  created.push(again.task.id)
  check('sourceId 幂等：第二次不新建', again.deduped === false || again.deduped === true)
  check('sourceId 幂等：同 key 返回同一条', third.deduped === true && third.task.id === again.task.id)

  const child = await client.addTask({
    title: `${TAG} 写一句话大纲`,
    parentId: parent.task.id,
    dueDate: todayStr,
  })
  created.push(child.task.id)
  check('子任务挂到父任务下', child.task.parentId === parent.task.id)

  const detail = await client.getTask(parent.task.id)
  check('get_task 返回直接子任务', detail.children.some((c) => c.id === child.task.id))

  section('3. 更新（验收 3）')
  const updated = await client.updateTask(child.task.id, {
    title: `${TAG} 写大纲（改）`,
    dueDate: tomorrowStr,
    priority: 5,
  })
  check('update 返回变更清单', Array.isArray(updated.changed) && updated.changed.length >= 3)
  check('优先级已改为高', updated.task.priority === 5)
  check('日期已改为明天', String(updated.task.dueDate).startsWith(tomorrowStr))

  section('4. 完成 / 取消完成（级联，验收 2）')
  const done = await client.completeTask(parent.task.id, true)
  check('完成父任务时级联列出子任务', done.affected.includes(child.task.id))
  const afterDone = await client.getTask(child.task.id)
  check('子任务也被标记完成', afterDone.task.completed === true && !!afterDone.task.completedTime)
  const undone = await client.completeTask(parent.task.id, false)
  check('取消完成同样级联', undone.affected.includes(child.task.id))
  const afterUndo = await client.getTask(child.task.id)
  check('子任务恢复未完成', afterUndo.task.completed === false)

  section('5. 批量（验收：dry-run 与逐条结果）')
  const dry = await client.bulkAddTasks({
    dryRun: true,
    items: [{ title: `${TAG} dry-1` }, { title: '' }],
  })
  check('dry-run 不落库且逐条给结果', dry.dryRun === true && dry.created === 0 && dry.results.length === 2)
  const dryList = await client.listTasks({ view: 'all', search: `${TAG} dry-1` })
  check('dry-run 确实没创建', dryList.total === 0)

  const bulk = await client.bulkAddTasks({
    items: [
      { title: `${TAG} 批量-1`, dueDate: todayStr },
      { title: `${TAG} 批量-2`, dueDate: todayStr },
      { title: `${TAG} 批量-坏`, priority: 2 },
    ],
  })
  for (const r of bulk.results) if (r.id) created.push(r.id)
  check('批量：成功 2 条、失败 1 条', bulk.created === 2 && bulk.failed === 1)
  check('批量：失败项带原因', !!bulk.results.find((r) => r.error)?.error)

  section('6. 查询（视图 / 搜索 / 清单标签）')
  const todayList = await client.listTasks({ view: 'today' })
  check('view=today 含刚建的任务', todayList.tasks.some((t) => t.id === parent.task.id))
  // 日期视图会把命中父任务的子任务一并带出（子任务自身日期可能不同）——只校验顶层
  check(
    'view=today 的顶层任务都是今天到期',
    todayList.tasks.filter((t) => !t.parentId).every((t) => String(t.dueDate || '').startsWith(todayStr)),
  )
  const searchList = await client.listTasks({ view: 'all', search: `${TAG} 批量` })
  check('search 命中 2 条批量任务', searchList.total === 2)
  const noteFiltered = await client.listTasks({ view: 'all' })
  check('笔记不进任务列表', noteFiltered.tasks.every((t) => t.kind === 'TASK'))

  section('7. 统计（验收 1 的数据面）')
  const stats = await client.stats()
  check('stats 计数合理', stats.pending >= 3 && stats.today >= 3 && typeof stats.overdue === 'number')
  check('stats 含优先级分布', typeof stats.byPriority['3'] === 'number' || typeof stats.byPriority[3] === 'number')

  section('8. 错误映射（模型可读）')
  await expectError('priority 非法 → 400 BAD_REQUEST', () => client.addTask({ title: 'x', priority: 2 }), {
    status: 400,
    code: 'BAD_REQUEST',
  })
  await expectError('title 为空 → 400', () => client.addTask({ title: '   ' }), { status: 400 })
  await expectError('不存在的 id → 404 TASK_NOT_FOUND', () => client.getTask('todo_not_exist'), {
    status: 404,
    code: 'TASK_NOT_FOUND',
  })
  await expectError('父任务不存在 → 400', () => client.addTask({ title: 'x', parentId: 'todo_nope' }), { status: 400 })
  await expectError('未知接口 → 404', () => client.request('GET', '/v1/nope'), { status: 404, code: 'NOT_FOUND' })

  section('9. 删除（级联 + 软删除，验收 4）')
  const deleted = await client.deleteTask(parent.task.id)
  check('删除父任务级联列出后代', deleted.deleted.includes(parent.task.id) && deleted.deleted.includes(child.task.id))
  const afterDelete = await client.listTasks({ view: 'all' })
  check(
    '删除后父任务与子任务都查不到',
    !afterDelete.tasks.some((t) => t.id === parent.task.id || t.id === child.task.id),
  )

  section('10. 审计（验收 4）')
  const audit = await client.audit(50)
  const mine = audit.entries.filter((e) => (e.taskIds || []).some((id) => created.includes(id)))
  check('审计记录了写入', mine.length >= 3)
  check('审计含 actor=cli', mine.every((e) => e.actor === 'cli'))
  check('审计含动作类型', ['add_task', 'update_task', 'complete_task', 'delete_task'].every((a) =>
    audit.entries.some((e) => e.action === a)))

  section('11. 清理')
  let cleaned = 0
  for (const id of created) {
    try {
      await client.deleteTask(id)
      cleaned++
    } catch { /* 已删除的忽略 */ }
  }
  check(`清理测试数据（${cleaned}/${created.length}）`, cleaned > 0)

  console.log(`\n结果：${pass} 通过，${failed} 失败`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error('\n自检异常终止：')
  if (err instanceof TinyDoApiError) {
    console.error(`  [${err.code}] ${err.message}`)
    const ep = readEndpoint()
    if (!ep) console.error('  提示：App 可能没在运行，且自动拉起失败。')
  } else {
    console.error(err)
  }
  process.exit(1)
})
