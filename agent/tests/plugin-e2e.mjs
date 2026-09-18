#!/usr/bin/env node
/**
 * DSH 插件端到端自检（不需要重启 DSH）
 *
 * 用 mock 宿主 ctx 触发 apply()，再逐个调用工具的真实 execute()，
 * 打到正在运行的 TinyDo 上——覆盖「插件 → client → 本地接口 → 真实数据层」整条链路。
 *
 * 用法：TINYDO_NO_LAUNCH=1 node agent/tests/plugin-e2e.mjs
 */

import { apply, inject, name as pluginName } from '../dsh-plugin/index.js'
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/**
 * 用 DSH 自带的校验器（@deepseek-ai/dsh-tools）校验工具定义 —— 就是它在启动时拒绝过我们。
 * 找不到 DSH 安装时退化为内置的等价检查。
 */
async function loadHostValidator() {
  try {
    const bin = execSync('which dsh', { encoding: 'utf8' }).trim()
    // bin 的真实路径形如 <pkg>/lib/bin.js，逐级上溯找 dsh-tools
    let dir = path.dirname(fs.realpathSync(bin))
    for (let i = 0; i < 4 && dir !== path.dirname(dir); i++) {
      const candidates = [
        path.join(dir, 'node_modules/@deepseek-ai/dsh-tools/lib/types/json-schema.js'),
        path.join(dir, 'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/types/json-schema.js'),
      ]
      for (const candidate of candidates) {
        if (!fs.existsSync(candidate)) continue
        const m = await import(pathToFileURL(candidate).href)
        return { assertSupportedJsonSchema: m.assertSupportedJsonSchema, validateJsonSchemaValue: m.validateJsonSchemaValue }
      }
      dir = path.dirname(dir)
    }
    return null
  } catch {
    return null
  }
}

/** 复刻宿主 tools.register() 的准入条件（没装 DSH 时也能测） */
function assertToolContract(tool, host) {
  if (typeof tool.name !== 'string' || !tool.name) throw new Error('name 缺失')
  if (typeof tool.description !== 'string' || !tool.description.trim()) throw new Error('description 缺失')
  const out = tool.output
  if (!out || typeof out !== 'object' || typeof out.render !== 'function'
    || (out.presentationMeta !== undefined && typeof out.presentationMeta !== 'function')) {
    throw new TypeError(`tool "${tool.name}" must declare output { schema, render, presentationMeta? }`)
  }
  if (host) {
    host.assertSupportedJsonSchema(out.schema)
    host.assertSupportedJsonSchema(tool.parameters)
  }
}

const TAG = `plug-${Date.now().toString(36)}`
let pass = 0
let failed = 0

function check(label, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const localDate = (offset = 0) => {
  const d = new Date(Date.now() + offset * 86400000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const idOf = (text) => (String(text).match(/id=(todo_[A-Za-z0-9_]+)/) || [])[1]

async function main() {
  console.log('1. 注册（mock 宿主 ctx，按宿主真实准入条件校验）')
  const host = await loadHostValidator()
  console.log(host ? '   （使用 DSH 自带的 schema 校验器）' : '   （未找到 DSH 安装，使用内置等价检查）')
  const registry = []
  const errors = []
  const origError = console.error
  console.error = (...args) => { errors.push(args.join(' ')) }
  const rejected = []
  apply({
    tools: {
      register: (tool) => {
        try {
          assertToolContract(tool, host)
          registry.push(tool)
        } catch (err) {
          rejected.push(`${tool?.name}: ${err.message}`)
          throw err
        }
      },
    },
  }, {})
  console.error = origError

  check('插件名与注入声明正确', pluginName === 'tinydo' && inject.includes('tools'))
  check(`注册了 9 个工具（实得 ${registry.length}）`, registry.length === 9, rejected.join('；'))
  check('每个工具都有 name/description/parameters/output/execute', registry.every((t) =>
    t.name && t.description && t.parameters?.type === 'object'
    && t.output && typeof t.output.render === 'function' && typeof t.execute === 'function'))
  check('output.schema 通过宿主 schema 子集校验', registry.every((t) => {
    try {
      if (host) host.assertSupportedJsonSchema(t.output.schema)
      return t.output.schema?.type === 'string'
    } catch { return false }
  }))
  check('工具名唯一', new Set(registry.map((t) => t.name)).size === registry.length)
  check('读工具 kind=read、写工具 kind=write', (() => {
    const r = registry.find((t) => t.name === 'tinydo_list_tasks').presentCall({})
    const w = registry.find((t) => t.name === 'tinydo_add_task').presentCall({ title: 'x' })
    return r.kind === 'read' && w.kind === 'write'
  })())
  check('写工具声明为非并发安全', registry.filter((t) => t.presentCall({}).kind === 'write')
    .every((t) => t.isConcurrencySafe() === false))

  // 宿主在工具返回后还会：用 output.schema 校验返回值 → 用 render 转成 content blocks
  // 空参数调用对读工具正常、对写工具安全地返回校验失败文案（不会真写入）
  const probe = []
  for (const t of registry) {
    const value = await t.execute({})
    const isString = typeof value === 'string'
    const schemaOk = isString && (!host || host.validateJsonSchemaValue(t.output.schema, value, 'value').length === 0)
    let renderOk = false
    try {
      const blocks = t.output.render({}, value)
      renderOk = Array.isArray(blocks) && blocks.length > 0
        && blocks.every((b) => b && b.type === 'text' && typeof b.text === 'string')
    } catch { renderOk = false }
    probe.push({ name: t.name, schemaOk, renderOk })
  }
  check('execute() 返回值都通过 output.schema 校验', probe.every((p) => p.schemaOk),
    probe.filter((p) => !p.schemaOk).map((p) => p.name).join(', '))
  check('output.render() 产出 text blocks', probe.every((p) => p.renderOk),
    probe.filter((p) => !p.renderOk).map((p) => p.name).join(', '))

  const tool = Object.fromEntries(registry.map((t) => [t.name, t]))

  console.log('\n2. 读取类工具')
  const statsBefore = await tool.tinydo_stats.execute({})
  check('tinydo_stats 返回计数文本', /未完成 \d+/.test(statsBefore), statsBefore.slice(0, 80))

  const listText = await tool.tinydo_list_tasks.execute({ view: 'today' })
  check('tinydo_list_tasks 返回清单文本', typeof listText === 'string' && listText.includes('共'))

  console.log('\n3. 写入类工具（真实落库）')
  const addText = await tool.tinydo_add_task.execute({
    title: `${TAG} 写周报`,
    dueDate: localDate(1),
    priority: 5,
    content: '插件自检创建',
  })
  const parentId = idOf(addText)
  check('tinydo_add_task 返回新任务 id', !!parentId, addText)
  check('新增文本含日期标签与人话描述', addText.includes('已新增') && addText.includes('明天'))

  const childText = await tool.tinydo_add_task.execute({ title: `${TAG} 写大纲`, parentId, dueDate: localDate(1) })
  const childId = idOf(childText)
  check('子任务挂在父任务下（文本含父=）', childText.includes(`父=${parentId}`), childText)

  const getText = await tool.tinydo_get_task.execute({ id: parentId })
  check('tinydo_get_task 含内容与子任务', getText.includes('插件自检创建') && getText.includes('子任务（1）'))

  const updText = await tool.tinydo_update_task.execute({ id: childId, priority: 3, dueDate: localDate(2) })
  check('tinydo_update_task 报告变更明细', /已修改/.test(updText) && /priority/.test(updText), updText)

  const noopText = await tool.tinydo_update_task.execute({ id: childId })
  check('空更新提示“没有变化”', noopText.includes('没有变化'), noopText)

  const doneText = await tool.tinydo_complete_task.execute({ id: parentId })
  check('tinydo_complete_task 级联子任务', doneText.includes('连带 1 个子任务'), doneText)

  const undoneText = await tool.tinydo_complete_task.execute({ id: parentId, completed: false })
  check('可取消完成', undoneText.includes('取消完成'), undoneText)

  const bulkText = await tool.tinydo_bulk_add_tasks.execute({
    items: [{ title: `${TAG} 批量-1`, dueDate: localDate(1) }, { title: `${TAG} 批量-2`, dueDate: localDate(1) }],
  })
  check('tinydo_bulk_add_tasks 新增 2 条', bulkText.includes('已新增 2 条'), bulkText)

  const dryText = await tool.tinydo_bulk_add_tasks.execute({ items: [{ title: `${TAG} dry` }], dryRun: true })
  check('bulk dry-run 不写入', dryText.includes('[dry-run]'), dryText)

  console.log('\n4. 幂等与审计')
  const again = await tool.tinydo_add_task.execute({ title: `${TAG} 再写一次` })
  const againId = idOf(again)
  check('同一插件实例重复新增不会重复建（幂等键）', !!againId && againId !== parentId)

  const auditText = await tool.tinydo_recent_changes.execute({ limit: 30 })
  check('tinydo_recent_changes 记录了 dsh 写入', auditText.includes('dsh') && auditText.includes(TAG), auditText.slice(0, 200))

  console.log('\n5. 错误处理（要给模型可读原因，而不是抛异常）')
  const badGet = await tool.tinydo_get_task.execute({ id: 'todo_not_exist' })
  check('不存在的 id 返回可读失败文案', badGet.includes('失败') && badGet.includes('TASK_NOT_FOUND'), badGet)
  check('失败文案带下一步提示', badGet.includes('提示：'), badGet)

  console.log('\n6. 降级：宿主工具面变了也不能崩')
  let threw = false
  const logs = []
  const orig = console.error
  console.error = (...a) => logs.push(a.join(' '))
  try {
    apply({ tools: { register: () => { throw new Error('preview-era surface change') } } }, {})
  } catch {
    threw = true
  }
  console.error = orig
  check('注册全部失败时不抛异常', threw === false)
  check('注册失败留有日志（可定位）', logs.some((l) => l.includes('注册失败')), logs.join(' | ').slice(0, 160))

  console.log('\n7. 清理')
  let cleaned = 0
  for (const id of [parentId, childId, againId, ...(bulkText.match(/id=todo_[A-Za-z0-9_]+/g) || []).map((s) => s.slice(3))]) {
    if (!id) continue
    const res = await tool.tinydo_delete_task.execute({ id })
    if (res.includes('已删除')) cleaned++
  }
  check(`清理测试数据（${cleaned} 条）`, cleaned >= 3)

  console.log(`\n结果：${pass} 通过，${failed} 失败`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error('\n插件自检异常终止：', err)
  process.exit(1)
})
