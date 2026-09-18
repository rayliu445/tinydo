#!/usr/bin/env node
/**
 * tinydo —— TinyDo 命令行（人 / 脚本 / 任意 Agent 都能用）
 *
 * 走 agent/lib/client.mjs → App 本地桥接 API（127.0.0.1 + token）。
 * 能力的事实标准：DSH 插件挂掉时，Agent 仍可用 bash 调这里。
 *
 * 常用：
 *   tinydo list --today
 *   tinydo add "写周报" --due 明天 --priority high
 *   tinydo done <id>
 *   tinydo stats
 *   tinydo doctor
 * 全局参数：--json、--dry-run、--no-launch、--verbose
 */

import { createClient, TinyDoApiError, resolvePortFile } from './lib/client.mjs'

const PRIORITY_TO_NUM = { none: 0, low: 1, mid: 3, medium: 3, high: 5 }
const PRIORITY_LABEL = { 0: '无', 1: '低', 3: '中', 5: '高' }
const VALUE_FLAGS = new Set([
  'due', 'start', 'priority', 'parent', 'tags', 'list', 'content', 'source-id',
  'title', 'limit', 'file', 'actor', 'search', 'view',
])

function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1)
      } else {
        const key = arg.slice(2)
        if (VALUE_FLAGS.has(key)) {
          const next = argv[i + 1]
          if (next === undefined || next.startsWith('--')) throw new Error(`--${key} 需要一个值`)
          flags[key] = next
          i++
        } else {
          flags[key] = true
        }
      }
    } else {
      positional.push(arg)
    }
  }
  return { flags, positional }
}

// ============ 输出 ============

const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const c = {
  dim: (s) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
}

function out(obj, flags) {
  if (flags.json) {
    process.stdout.write(JSON.stringify(obj, null, 2) + '\n')
    return true
  }
  return false
}

function padEndWide(text, width) {
  // 中文字符按 2 个宽度计算，保证列对齐
  let len = 0
  for (const ch of String(text)) len += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1
  return String(text) + ' '.repeat(Math.max(0, width - len))
}

function localDateStr(d) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function formatDue(iso) {
  if (!iso) return ''
  const day = String(iso).slice(0, 10)
  const today = new Date()
  const todayStr = localDateStr(today)
  const tomorrow = new Date(today.getTime() + 86400000)
  if (day === todayStr) return c.yellow('今天')
  if (day === localDateStr(tomorrow)) return c.yellow('明天')
  const overdue = day < todayStr
  return overdue ? c.red(day) : day
}

function formatTaskLine(t, depth, flags) {
  const indent = '  '.repeat(depth)
  const box = t.completed ? c.dim('[✓]') : '[ ]'
  const title = t.completed ? c.dim(t.title) : t.title
  const parts = [formatDue(t.dueDate), t.priority ? c.dim(PRIORITY_LABEL[t.priority]) : '', c.dim(t.id)]
  return `  ${indent}${box} ${padEndWide(title, 34)} ${parts.filter(Boolean).join('  ')}`
}

function printTasks(tasks, flags) {
  if (tasks.length === 0) {
    console.log(c.dim('（没有匹配的任务）'))
    return
  }
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
  for (const t of tasks) console.log(formatTaskLine(t, depthOf(t), flags))
}

// ============ 输入归一化 ============

function parsePriority(value) {
  if (value === undefined) return undefined
  const key = String(value).toLowerCase()
  if (key in PRIORITY_TO_NUM) return PRIORITY_TO_NUM[key]
  const n = Number(value)
  if ([0, 1, 3, 5].includes(n)) return n
  throw new Error(`--priority 只支持 none/low/mid/high 或 0/1/3/5（收到 ${value}）`)
}

function parseDate(value) {
  if (value === undefined) return undefined
  const key = String(value).trim()
  const today = new Date()
  if (['今天', 'today'].includes(key)) return localDateStr(today)
  if (['明天', 'tomorrow'].includes(key)) return localDateStr(new Date(today.getTime() + 86400000))
  if (['后天'].includes(key)) return localDateStr(new Date(today.getTime() + 2 * 86400000))
  if (['昨天', 'yesterday'].includes(key)) return localDateStr(new Date(today.getTime() - 86400000))
  if (/^\d{4}-\d{2}-\d{2}/.test(key)) return key.slice(0, 10)
  if (/^\+\d+d$/.test(key)) return localDateStr(new Date(today.getTime() + Number(key.slice(1, -1)) * 86400000))
  throw new Error(`无法解析日期「${value}」（用 YYYY-MM-DD 或 今天/明天/后天/+3d）`)
}

// ============ 命令 ============

async function cmdList(client, { flags, positional }) {
  const view = flags.view || (flags.today ? 'today' : flags.next7 ? 'next7' : flags.completed ? 'completed' : flags.all ? 'all' : 'inbox')
  const data = await client.listTasks({
    view,
    search: flags.search || positional.join(' ').trim() || undefined,
    list: flags.list,
    tag: flags.tag,
    includeNotes: flags.notes ? '1' : undefined,
    limit: flags.limit,
  })
  if (out(data, flags)) return
  const label = { inbox: '收集箱（未完成）', today: '今天', next7: '最近7天', completed: '已完成', all: '全部' }[view] || view
  console.log(c.bold(`${label} · ${data.total} 条`))
  printTasks(data.tasks, flags)
}

async function cmdGet(client, { flags, positional }) {
  const id = positional[0]
  if (!id) throw new Error('用法：tinydo get <id>')
  const data = await client.getTask(id)
  if (out(data, flags)) return
  const t = data.task
  console.log(`${t.completed ? c.green('[✓]') : '[ ]'} ${c.bold(t.title)}`)
  console.log(`  id        ${t.id}`)
  console.log(`  截止      ${t.dueDate ? String(t.dueDate).slice(0, 10) : '（无）'}`)
  console.log(`  优先级    ${PRIORITY_LABEL[t.priority] ?? t.priority}`)
  console.log(`  父任务    ${t.parentId || '（顶层）'}`)
  console.log(`  清单/标签 ${t.list || '（无）'} / ${(t.tags || []).join(', ') || '（无）'}`)
  if (t.content) console.log(`  内容      ${t.content}`)
  if (data.children.length) {
    console.log(c.bold(`  子任务（${data.children.length}）`))
    printTasks(data.children, { ...flags, json: false })
  }
}

async function cmdAdd(client, { flags, positional }) {
  const title = flags.title || positional.join(' ').trim()
  if (!title) throw new Error('用法：tinydo add "任务标题" [--due 明天] [--priority high] [--parent <id>]')
  const body = {
    title,
    dueDate: parseDate(flags.due),
    startDate: parseDate(flags.start),
    priority: parsePriority(flags.priority),
    parentId: flags.parent,
    tags: flags.tags,
    list: flags.list,
    content: flags.content,
    sourceId: flags['source-id'],
  }
  if (flags['dry-run']) {
    const data = await client.bulkAddTasks({ items: [body], dryRun: true })
    if (out({ dryRun: true, ...data }, flags)) return
    console.log(c.dim(`[dry-run] 会新增：${title}`))
    return
  }
  const data = await client.addTask(body)
  if (out(data, flags)) return
  console.log(`${data.deduped ? c.dim('已存在（幂等命中）') : c.green('✓ 已新增')} ${c.bold(data.task.title)}  ${c.dim(data.task.id)}`)
  printTasks([data.task], { json: false })
}

async function cmdEdit(client, { flags, positional }) {
  const id = positional[0]
  if (!id) throw new Error('用法：tinydo edit <id> [--title x] [--due 明天] [--clear-due] [--priority high] [--parent <id>]')
  const body = {
    title: flags.title,
    dueDate: flags['clear-due'] ? null : parseDate(flags.due),
    startDate: flags['clear-start'] ? null : parseDate(flags.start),
    priority: parsePriority(flags.priority),
    parentId: flags.parent,
    content: flags.content,
    tags: flags.tags,
    list: flags.list,
  }
  if (flags['dry-run']) {
    const current = await client.getTask(id)
    if (out({ dryRun: true, id, changes: body, before: current.task }, flags)) return
    console.log(c.dim(`[dry-run] 会修改 ${current.task.title}`))
    return
  }
  const data = await client.updateTask(id, body)
  if (out(data, flags)) return
  if (!data.changed.length) {
    console.log(c.dim('没有变化'))
    return
  }
  console.log(c.green(`✓ 已修改 ${data.task?.title ?? id}`))
  for (const change of data.changed) console.log(`  · ${change}`)
}

async function cmdDone(client, { flags, positional }) {
  const id = positional[0]
  if (!id) throw new Error('用法：tinydo done <id> [--undo]')
  const data = await client.completeTask(id, !flags.undo)
  if (out(data, flags)) return
  if (!data.changed) {
    console.log(c.dim('状态没有变化'))
    return
  }
  console.log(c.green(`✓ 已${flags.undo ? '取消完成' : '完成'} ${data.task?.title ?? id}${data.affected.length > 1 ? `（连带 ${data.affected.length - 1} 个子任务）` : ''}`))
}

async function cmdRemove(client, { flags, positional }) {
  const id = positional[0]
  if (!id) throw new Error('用法：tinydo rm <id> --yes')
  const detail = await client.getTask(id)
  if (!flags.yes) {
    console.log(`将删除：${c.bold(detail.task.title)}${detail.children.length ? `（含 ${detail.children.length} 个子任务）` : ''}`)
    console.log(c.dim('确认请加 --yes（软删除，可在审计日志里看到记录）'))
    process.exitCode = 2
    return
  }
  const data = await client.deleteTask(id)
  if (out(data, flags)) return
  console.log(c.green(`✓ 已删除 ${detail.task.title}（连带 ${data.deleted.length - 1} 个子任务）`))
}

async function cmdBulk(client, { flags, positional }) {
  const sub = positional[0]
  if (sub !== 'add') throw new Error('用法：tinydo bulk add --file tasks.json [--dry-run]')
  if (!flags.file) throw new Error('缺少 --file tasks.json')
  const { readFileSync } = await import('node:fs')
  let items
  try {
    const parsed = JSON.parse(readFileSync(flags.file, 'utf8'))
    items = Array.isArray(parsed) ? parsed : parsed.items
  } catch (err) {
    throw new Error(`读取 ${flags.file} 失败：${err.message}`)
  }
  if (!Array.isArray(items)) throw new Error('文件内容需为任务数组，或 { "items": [...] }')
  const data = await client.bulkAddTasks({ items, dryRun: !!flags['dry-run'] })
  if (out(data, flags)) return
  console.log(`${flags['dry-run'] ? c.dim('[dry-run] ') : ''}成功 ${data.created} 条，失败 ${data.failed} 条`)
  for (const r of data.results) {
    if (r.error) console.log(`  ${c.red('✗')} #${r.index} ${r.error}`)
    else console.log(`  ${c.green('✓')} #${r.index} ${r.title || ''} ${c.dim(r.id || '')}`)
  }
}

async function cmdStats(client, { flags }) {
  const data = await client.stats()
  if (out(data, flags)) return
  console.log(c.bold('TinyDo 概览'))
  console.log(`  未完成    ${data.pending}（顶层 ${data.topLevelPending}）`)
  console.log(`  已完成    ${data.completed}`)
  console.log(`  今天      ${data.today}`)
  console.log(`  最近7天   ${data.next7}`)
  console.log(`  已逾期    ${data.overdue > 0 ? c.red(data.overdue) : 0}`)
  console.log(`  优先级    高 ${data.byPriority['5'] ?? 0} / 中 ${data.byPriority['3'] ?? 0} / 低 ${data.byPriority['1'] ?? 0} / 无 ${data.byPriority['0'] ?? 0}`)
  const lists = Object.entries(data.byList || {})
  if (lists.length) console.log(`  清单      ${lists.map(([k, v]) => `${k} ${v}`).join('，')}`)
}

async function cmdLog(client, { flags }) {
  const data = await client.audit(Number(flags.limit) || 20)
  if (out(data, flags)) return
  if (!data.entries.length) {
    console.log(c.dim('（还没有外部写入记录）'))
    return
  }
  for (const e of data.entries) {
    const when = new Date(e.ts).toLocaleString('zh-CN', { hour12: false })
    console.log(`${c.dim(when)}  ${c.bold(e.actor || 'external')}  ${e.action}  ${e.summary || ''}${e.ok === false ? c.red('（部分失败）') : ''}`)
  }
}

async function cmdDoctor(client, { flags }) {
  const report = await client.doctor()
  if (out(report, flags)) return
  const ok = (v) => (v ? c.green('✓') : c.red('✗'))
  console.log(c.bold('tinydo doctor'))
  console.log(`  ${ok(report.endpoint)} 发现文件    ${report.portFile}`)
  if (report.endpoint) {
    console.log(`      App        pid ${report.endpoint.pid}，版本 ${report.endpoint.version}，端口 ${report.endpoint.port}`)
    console.log(`      外部助手   ${report.endpoint.enabled ? c.green('已开启') : c.red('已关闭')}`)
  }
  console.log(`  ${ok(report.health)} 健康检查    ${report.health ? '正常' : '失败'}`)
  console.log(`  ${ok(report.stats)} 数据层      ${report.stats ? `未完成 ${report.stats.pending} / 今天 ${report.stats.today}` : '未就绪'}`)
  if (report.problems.length) {
    console.log(c.red('\n问题：'))
    for (const p of report.problems) console.log(`  · ${p}`)
    process.exitCode = 1
  }
}

// ============ 入口 ============

const HELP = `tinydo —— TinyDo 命令行

用法：
  tinydo list [--today|--next7|--all|--completed] [--search 关键词] [--list 清单] [--tag 标签]
  tinydo get <id>
  tinydo add "标题" [--due 明天] [--priority high|mid|low|none] [--parent <id>] [--tags a,b] [--content 文本]
  tinydo edit <id> [--title 新标题] [--due 2026-09-20] [--clear-due] [--priority mid] [--parent <id>] [--tags a,b]
  tinydo done <id> [--undo]
  tinydo rm <id> --yes
  tinydo bulk add --file tasks.json [--dry-run]
  tinydo stats
  tinydo log [--limit 20]
  tinydo doctor

全局：--json 机器可读 · --dry-run 只预览 · --no-launch 不自动拉起 App · --verbose 打印过程
`

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv[0] === 'help' || argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP)
    return
  }
  const { flags, positional } = parseArgs(argv)
  const command = positional.shift()
  const verbose = !!flags.verbose
  const client = createClient({
    actor: flags.actor || 'cli',
    autoLaunch: !flags['no-launch'] && !process.env.TINYDO_NO_LAUNCH,
    log: verbose ? (msg) => console.error(c.dim(`· ${msg}`)) : () => {},
  })

  switch (command) {
    case 'list': return cmdList(client, { flags, positional })
    case 'get': return cmdGet(client, { flags, positional })
    case 'add': return cmdAdd(client, { flags, positional })
    case 'edit': return cmdEdit(client, { flags, positional })
    case 'done': return cmdDone(client, { flags, positional })
    case 'rm':
    case 'remove': return cmdRemove(client, { flags, positional })
    case 'bulk': return cmdBulk(client, { flags, positional })
    case 'stats': return cmdStats(client, { flags })
    case 'log': return cmdLog(client, { flags })
    case 'doctor': return cmdDoctor(client, { flags })
    default:
      console.error(`未知命令：${command}\n`)
      console.log(HELP)
      process.exitCode = 1
  }
}

main().catch((err) => {
  if (err instanceof TinyDoApiError) {
    console.error(c.red(`✗ [${err.code}] ${err.message}`))
    if (err.code === 'NOT_RUNNING' || err.code === 'NETWORK') {
      console.error(c.dim(`  提示：先打开 TinyDo，或运行 tinydo doctor 自检（发现文件：${resolvePortFile()}）`))
    }
  } else {
    console.error(c.red(`✗ ${err.message}`))
    if (process.env.TINYDO_DEBUG) console.error(err)
  }
  process.exitCode = 1
})
