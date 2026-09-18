/**
 * 外部助手本地桥接（主进程）
 *
 * 只在 127.0.0.1 上监听，供 TinyDo CLI / DSH 插件读写任务：
 *   HTTP 请求 → 校验 token → 转发给渲染层真实数据层执行 → 回写审计 → 返回结果
 *
 * 设计约束（见 docs/agent-bridge-design.md）：
 * - App 是唯一写入者：这一层不做任何业务判断，只做鉴权/转发/审计/发现文件。
 * - 只监听回环地址；token 每次启动轮换，写在 ~/.tinydo/local-api.json（0600）。
 * - 渲染层窗口不在时按需创建隐藏窗口（macOS 关窗但 App 仍存活的场景）。
 */

const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const TINYDO_HOME = path.join(os.homedir(), '.tinydo')
const PORT_FILE = process.env.TINYDO_API_PORT_FILE || path.join(TINYDO_HOME, 'local-api.json')
const AUDIT_FILE = process.env.TINYDO_API_AUDIT_FILE || path.join(TINYDO_HOME, 'audit.jsonl')
const PREFERRED_PORT = Number(process.env.TINYDO_API_PORT || 45871)
/** 本地桥接协议版本：外部客户端（tinydo-agent 仓库的 CLI / DSH 插件）据此判断兼容性 */
const PROTOCOL_VERSION = 1
const MAX_BODY_BYTES = 1024 * 1024
const FORWARD_TIMEOUT_MS = 15000
const AUDIT_MAX_BYTES = 4 * 1024 * 1024
const AUDIT_KEEP_LINES = 2000

const state = {
  server: null,
  port: 0,
  token: '',
  enabled: false,
  pending: new Map(),
  seq: 0,
  startedAt: null,
}

let deps = {
  ensureWindow: async () => { throw new Error('ensureWindow 未注入') },
  version: '0.0.0',
  info: () => {},
  warn: () => {},
  error: () => {},
}

function ensureHome() {
  try {
    fs.mkdirSync(TINYDO_HOME, { recursive: true, mode: 0o700 })
  } catch { /* 已存在 */ }
}

function writePortFile(enabled = true, port = state.port, token = state.token) {
  ensureHome()
  const payload = {
    port,
    token,
    pid: process.pid,
    version: deps.version,
    enabled,
    startedAt: state.startedAt || new Date().toISOString(),
  }
  try {
    fs.writeFileSync(PORT_FILE, JSON.stringify(payload, null, 2), { mode: 0o600 })
  } catch (err) {
    deps.error('[LocalAPI] 写入发现文件失败: ' + err.message)
  }
}

function removePortFile() {
  try { fs.unlinkSync(PORT_FILE) } catch { /* 不存在 */ }
}

// ============ 审计（本地文件，不进同步） ============

function appendAudit(entry) {
  ensureHome()
  try {
    if (fs.existsSync(AUDIT_FILE) && fs.statSync(AUDIT_FILE).size > AUDIT_MAX_BYTES) {
      const lines = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean)
      fs.writeFileSync(AUDIT_FILE, lines.slice(-AUDIT_KEEP_LINES).join('\n') + '\n')
    }
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n')
  } catch (err) {
    deps.warn('[LocalAPI] 写审计失败: ' + err.message)
  }
}

function readAudit(limit) {
  try {
    if (!fs.existsSync(AUDIT_FILE)) return []
    const lines = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean)
    return lines.slice(-limit).reverse().map(line => {
      try { return JSON.parse(line) } catch { return { raw: line } }
    })
  } catch (err) {
    deps.warn('[LocalAPI] 读审计失败: ' + err.message)
    return []
  }
}

// ============ 渲染层转发 ============

function forwardToRenderer(payload) {
  return new Promise((resolve, reject) => {
    const id = `req_${++state.seq}`
    const timer = setTimeout(() => {
      state.pending.delete(id)
      reject(new Error('渲染层响应超时（TinyDo 界面可能未就绪）'))
    }, FORWARD_TIMEOUT_MS)
    state.pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value) },
    })
    deps.ensureWindow()
      .then((win) => win.webContents.send('local-api:request', { id, ...payload }))
      .catch((err) => {
        clearTimeout(timer)
        state.pending.delete(id)
        reject(err)
      })
  })
}

function registerRendererReply(ipcMain) {
  ipcMain.on('local-api:reply', (_event, id, payload) => {
    const pending = state.pending.get(id)
    if (!pending) return
    state.pending.delete(id)
    pending.resolve(payload)
  })
}

// ============ HTTP ============

function sendJson(res, status, body) {
  const text = JSON.stringify(body ?? {})
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

function authorized(req) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!state.token || !token) return false
  const a = Buffer.from(token)
  const b = Buffer.from(state.token)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大（上限 1MB）'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw.trim()) return resolve({})
      try { resolve(JSON.parse(raw)) } catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

async function handleRequest(req, res) {
  let url
  try {
    url = new URL(req.url, 'http://127.0.0.1')
  } catch {
    return sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: 'URL 非法' } })
  }
  const actor = String(req.headers['x-tinydo-actor'] || 'external').slice(0, 32)

  // 无需鉴权：仅用于发现/自检，不暴露数据
  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, {
      ok: !!(state.server && state.enabled),
      app: 'tinydo',
      api: PROTOCOL_VERSION,
      version: deps.version,
      port: state.port,
      pid: process.pid,
      startedAt: state.startedAt,
    })
  }

  if (!state.enabled) {
    return sendJson(res, 403, { error: { code: 'DISABLED', message: '外部助手已在 TinyDo 设置里关闭' } })
  }
  if (!authorized(req)) {
    return sendJson(res, 401, {
      error: {
        code: 'UNAUTHORIZED',
        message: `token 无效或已失效；请重读 ${PORT_FILE}（App 每次启动都会轮换 token）`,
      },
    })
  }

  // 审计读取由主进程直接处理（渲染层不碰本地文件）
  if (req.method === 'GET' && url.pathname === '/v1/audit') {
    const limitRaw = Number(url.searchParams.get('limit') || 50)
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 50
    return sendJson(res, 200, { entries: readAudit(limit) })
  }

  let body = {}
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      body = await readBody(req)
    } catch (err) {
      return sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: err.message } })
    }
  }

  try {
    const response = await forwardToRenderer({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      body,
      actor,
    })
    if (response && response.audit) {
      appendAudit({ ts: new Date().toISOString(), actor, ...response.audit })
    }
    return sendJson(res, response?.status ?? 500, response?.body ?? {
      error: { code: 'INTERNAL', message: '渲染层返回了空结果' },
    })
  } catch (err) {
    return sendJson(res, 503, { error: { code: 'BRIDGE_ERROR', message: err.message } })
  }
}

// ============ 生命周期 ============

function listen(port) {
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      deps.error('[LocalAPI] 未捕获错误: ' + err.message)
      try { sendJson(res, 500, { error: { code: 'INTERNAL', message: err.message } }) } catch { /* 已发送 */ }
    })
  })
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && port !== 0) {
      deps.warn(`[LocalAPI] ${port} 被占用，改用随机端口`)
      listen(0)
      return
    }
    deps.error('[LocalAPI] 监听失败: ' + err.message)
  })
  server.listen(port, '127.0.0.1', () => {
    state.server = server
    state.port = server.address().port
    writePortFile()
    deps.info(`[LocalAPI] 已监听 http://127.0.0.1:${state.port}`)
  })
}

function start() {
  if (state.server || !state.enabled) return
  if (!state.token) state.token = crypto.randomBytes(32).toString('hex')
  if (!state.startedAt) state.startedAt = new Date().toISOString()
  listen(state.port || PREFERRED_PORT)
}

/**
 * 停止监听。
 * keepMarker=true（用户关了开关）：留下 enabled:false 的发现文件，
 *   这样 CLI/插件能明确报「已被关闭」，而不是含糊的「App 未运行」。
 * keepMarker=false（App 退出）：直接删掉发现文件。
 */
function stop({ keepMarker = true } = {}) {
  if (state.server) {
    try { state.server.close() } catch { /* ignore */ }
    state.server = null
    state.port = 0
  }
  if (keepMarker) writePortFile(false, 0, '')
  else removePortFile()
  deps.info(`[LocalAPI] 已停止监听${keepMarker ? '（保留关闭标记）' : ''}`)
}

/** App 退出：停服务并清掉发现文件 */
function cleanup() {
  if (state.server) {
    try { state.server.close() } catch { /* ignore */ }
    state.server = null
    state.port = 0
  }
  removePortFile()
}

function setEnabled(enabled) {
  state.enabled = !!enabled
  if (state.enabled) start()
  else stop()
  return getInfo()
}

function revokeToken() {
  state.token = crypto.randomBytes(32).toString('hex')
  if (state.server) writePortFile()
  deps.info('[LocalAPI] token 已重新生成')
  return getInfo()
}

function getInfo() {
  return {
    enabled: state.enabled,
    port: state.port,
    token: state.token,
    portFile: PORT_FILE,
    auditFile: AUDIT_FILE,
    startedAt: state.startedAt,
    version: deps.version,
    appPath: deps.appPath || '',
  }
}

function setupLocalApi(options) {
  deps = { ...deps, ...options }
  registerRendererReply(options.ipcMain)
  options.ipcMain.handle('local-api:set-enabled', (_e, enabled) => setEnabled(enabled))
  options.ipcMain.handle('local-api:info', () => getInfo())
  options.ipcMain.handle('local-api:revoke-token', () => revokeToken())
  options.ipcMain.handle('local-api:audit', (_e, limit) => readAudit(Number(limit) || 20))
  deps.info(`[LocalAPI] 就绪（发现文件：${PORT_FILE}）`)
  return { start, stop, setEnabled, revokeToken, getInfo }
}

module.exports = {
  setupLocalApi,
  stopLocalApi: stop,
  cleanupLocalApi: cleanup,
  getLocalApiInfo: getInfo,
  readAudit,
  PORT_FILE,
  AUDIT_FILE,
}
