#!/usr/bin/env node
/**
 * 本地桥接「主进程层」单元自检（不需要 Electron）
 *
 * 覆盖：开关 → 监听/停止、发现文件生命周期、鉴权、转发与审计、客户端对「已关闭」的识别。
 * 用法：node agent/tests/bridge-unit.mjs
 */

import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const PORT_FILE = '/tmp/tinydo-test/bridge-unit.json'
const AUDIT_FILE = '/tmp/tinydo-test/bridge-unit-audit.jsonl'
process.env.TINYDO_API_PORT_FILE = PORT_FILE
process.env.TINYDO_API_AUDIT_FILE = AUDIT_FILE

const require = createRequire(import.meta.url)
const bridge = require('../../electron/local-api.js')
const { createClient, TinyDoApiError } = await import('../lib/client.mjs')

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const readPortFile = () => JSON.parse(fs.readFileSync(PORT_FILE, 'utf8'))

// ---- mock 宿主 ----
const handlers = {}
let canned = { status: 200, body: { tasks: [], total: 0 } }
const replyListeners = []
const ipcMain = {
  handle: (channel, fn) => { handlers[channel] = fn },
  on: (channel, fn) => { if (channel === 'local-api:reply') replyListeners.push(fn) },
}
const ensureWindow = async () => ({
  webContents: {
    send: (_channel, payload) => {
      queueMicrotask(() => replyListeners.forEach((fn) => fn({}, payload.id, canned)))
    },
  },
})

bridge.setupLocalApi({
  ipcMain,
  version: 'test-version',
  appPath: '/tmp/fake-app',
  info: () => {},
  warn: () => {},
  error: (m) => console.error('[bridge]', m),
  ensureWindow,
})

async function waitForPortFile(deadlineMs = 5000) {
  const end = Date.now() + deadlineMs
  while (Date.now() < end) {
    if (fs.existsSync(PORT_FILE)) return true
    await sleep(100)
  }
  return false
}

async function main() {
  fs.rmSync(PORT_FILE, { force: true })
  fs.rmSync(AUDIT_FILE, { force: true })

  console.log('1. 开启：监听 + 发现文件')
  handlers['local-api:set-enabled'](null, true)
  check('发现文件已生成', await waitForPortFile())
  const info = readPortFile()
  check('发现文件 enabled=true 且带 port/token', info.enabled === true && info.port > 0 && info.token.length === 64)
  check('发现文件权限 0600', (fs.statSync(PORT_FILE).mode & 0o777) === 0o600)

  const base = `http://127.0.0.1:${info.port}`
  const health = await (await fetch(`${base}/health`)).json()
  check('/health 无需鉴权且 ok', health.ok === true && health.app === 'tinydo' && health.version === 'test-version')

  console.log('\n2. 鉴权')
  const noAuth = await fetch(`${base}/v1/tasks`)
  check('缺 token → 401', noAuth.status === 401)
  const badAuth = await fetch(`${base}/v1/tasks`, { headers: { Authorization: 'Bearer nope' } })
  check('错 token → 401', badAuth.status === 401)
  const good = await fetch(`${base}/v1/tasks`, { headers: { Authorization: `Bearer ${info.token}` } })
  check('正确 token → 200（转发到渲染层）', good.status === 200 && (await good.json()).total === 0)

  console.log('\n3. 转发与审计')
  canned = { status: 200, body: { task: { id: 'todo_x' } }, audit: { action: 'add_task', taskIds: ['todo_x'], summary: '测试写入', ok: true } }
  const withAudit = await fetch(`${base}/v1/tasks`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json', 'X-TinyDo-Actor': 'dsh' },
    body: JSON.stringify({ title: 'x' }),
  })
  check('POST 转发成功且回包不含 audit 内部字段', withAudit.status === 200 && !(await withAudit.json()).audit)
  const audit = bridge.readAudit(5)
  check('审计已落盘且记下 actor=dsh', audit.length === 1 && audit[0].actor === 'dsh' && audit[0].action === 'add_task')

  console.log('\n4. 关闭开关（保留关闭标记，便于客户端给出明确原因）')
  handlers['local-api:set-enabled'](null, false)
  await sleep(300)
  const disabled = readPortFile()
  check('发现文件变为 enabled=false', disabled.enabled === false && disabled.port === 0)
  let refused = false
  try {
    await fetch(`${base}/v1/tasks`, { headers: { Authorization: `Bearer ${info.token}` } })
  } catch {
    refused = true
  }
  check('端口已停止监听（连接被拒）', refused)

  console.log('\n5. 客户端识别「已关闭」')
  const client = createClient({ autoLaunch: false })
  let code = ''
  try {
    await client.listTasks({ view: 'today' })
  } catch (err) {
    code = err instanceof TinyDoApiError ? err.code : 'UNEXPECTED'
  }
  check('客户端报 DISABLED 而不是 NOT_RUNNING', code === 'DISABLED', `实得 ${code}`)

  console.log('\n6. 退出清理')
  bridge.cleanupLocalApi()
  check('发现文件已删除', !fs.existsSync(PORT_FILE))

  console.log(`\n结果：${pass} 通过，${failed} 失败`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error('自检异常终止：', err)
  process.exit(1)
})
