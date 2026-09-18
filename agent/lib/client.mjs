/**
 * TinyDo 外部助手客户端（零依赖，node builtins only）
 *
 * 职责：发现本地 API（端口 + token）→ 必要时自动拉起 App → 发请求 → 统一错误。
 * CLI 与 DSH 插件都走这一层，所以业务之外的东西（重试/发现/拉起）只写一遍。
 *
 * 环境变量：
 * - TINYDO_API_PORT_FILE  发现文件位置（默认 ~/.tinydo/local-api.json）
 * - TINYDO_APP_PATH       App 可执行路径（打包版）
 * - TINYDO_NO_LAUNCH=1    禁止自动拉起（CI / 只想读状态时用）
 * - TINYDO_DEV=1          强制走开发态拉起（npm run dev + electron .）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REQUEST_TIMEOUT_MS = 20000
const HEALTH_TIMEOUT_MS = 2000
const LAUNCH_TIMEOUT_MS = 30000

export class TinyDoApiError extends Error {
  constructor(message, { status = 0, code = 'ERROR' } = {}) {
    super(message)
    this.name = 'TinyDoApiError'
    this.status = status
    this.code = code
  }
}

export function resolvePortFile() {
  return process.env.TINYDO_API_PORT_FILE || path.join(os.homedir(), '.tinydo', 'local-api.json')
}

/** 读取发现文件；不存在/损坏返回 null */
export function readEndpoint() {
  const portFile = resolvePortFile()
  try {
    const raw = fs.readFileSync(portFile, 'utf8')
    const data = JSON.parse(raw)
    if (!data || typeof data.port !== 'number' || typeof data.token !== 'string') return null
    return { ...data, portFile }
  } catch {
    return null
  }
}

function repoRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '..', '..')
}

function spawnDetached(cmd, args, cwd) {
  const child = spawn(cmd, args, { cwd, detached: true, stdio: 'ignore' })
  child.unref()
  return child
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 等发现文件出现且 /health 可用 */
async function waitForHealth(deadline) {
  while (Date.now() < deadline) {
    const endpoint = readEndpoint()
    if (endpoint && endpoint.enabled !== false) {
      try {
        const res = await fetch(`http://127.0.0.1:${endpoint.port}/health`, {
          signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        })
        if (res.ok) return endpoint
      } catch { /* 还没起来 */ }
    }
    await sleep(500)
  }
  return null
}

/**
 * App 没在跑时自动拉起：
 * 1) TINYDO_APP_PATH 指定的打包版 → open <path>
 * 2) /Applications/TinyDo.app → open -a TinyDo
 * 3) 开发态：npm run dev（vite，若未在跑）+ npx electron .
 */
export async function launchApp({ log = () => {} } = {}) {
  if (process.env.TINYDO_NO_LAUNCH) {
    throw new TinyDoApiError(
      'TinyDo 未运行（已设置 TINYDO_NO_LAUNCH=1，不自动拉起）。请先打开 TinyDo。',
      { code: 'NOT_RUNNING' },
    )
  }

  const root = repoRoot()
  const appPath = process.env.TINYDO_APP_PATH
  const forceDev = process.env.TINYDO_DEV === '1'

  if (!forceDev && appPath) {
    log(`启动 App：open ${appPath}`)
    spawnDetached('open', [appPath])
  } else if (!forceDev && fs.existsSync('/Applications/TinyDo.app')) {
    log('启动 App：open -a TinyDo')
    spawnDetached('open', ['-a', 'TinyDo'])
  } else if (fs.existsSync(path.join(root, 'electron', 'main.js'))) {
    log(`开发态启动：${root}（vite + electron）`)
    try {
      const res = await fetch('http://localhost:3000/', { signal: AbortSignal.timeout(1500) })
      if (!res.ok) throw new Error('bad status')
    } catch {
      spawnDetached('npm', ['run', 'dev'], root)
    }
    // 等 vite 起来再拉起 Electron（dev 下渲染层从 localhost:3000 加载）
    const viteDeadline = Date.now() + 20000
    while (Date.now() < viteDeadline) {
      try {
        const res = await fetch('http://localhost:3000/', { signal: AbortSignal.timeout(1500) })
        if (res.ok) break
      } catch { /* 继续等 */ }
      await sleep(500)
    }
    spawnDetached('npx', ['electron', '.'], root)
  } else {
    throw new TinyDoApiError(
      'TinyDo 未运行，且未找到可启动的 App（可用 TINYDO_APP_PATH 指定路径）',
      { code: 'NOT_RUNNING' },
    )
  }

  const endpoint = await waitForHealth(Date.now() + LAUNCH_TIMEOUT_MS)
  if (!endpoint) {
    throw new TinyDoApiError(
      '已尝试启动 TinyDo，但 30 秒内没等到本地 API。常见原因：App 是本次更新前的旧版本（不含「外部助手」）——请更新 TinyDo 后重试；或设置里关掉了该开关。',
      { code: 'LAUNCH_TIMEOUT' },
    )
  }
  return endpoint
}

async function readBody(res) {
  const text = await res.text()
  if (!text) return {}
  try { return JSON.parse(text) } catch { return { raw: text } }
}

export function createClient(options = {}) {
  const actor = options.actor || 'cli'
  const autoLaunch = options.autoLaunch !== false
  const log = options.log || (() => {})
  let endpoint = null

  async function ensureEndpoint() {
    if (endpoint) return endpoint
    const found = readEndpoint()
    if (found) {
      if (found.enabled === false) {
        throw new TinyDoApiError(
          '外部助手已在 TinyDo「设置 → 外部助手」里关闭：请打开开关后重试。',
          { code: 'DISABLED' },
        )
      }
      endpoint = found
      return endpoint
    }
    if (!autoLaunch) {
      throw new TinyDoApiError(
        `TinyDo 本地 API 未就绪（未找到 ${resolvePortFile()}）。请先打开 TinyDo。`,
        { code: 'NOT_RUNNING' },
      )
    }
    endpoint = await launchApp({ log })
    return endpoint
  }

  async function rawRequest(method, apiPath, { query, body, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const ep = await ensureEndpoint()
    const url = new URL(`http://127.0.0.1:${ep.port}${apiPath}`)
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
    }
    const init = {
      method,
      headers: {
        Authorization: `Bearer ${ep.token}`,
        'X-TinyDo-Actor': actor,
      },
      signal: AbortSignal.timeout(timeoutMs),
    }
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    const res = await fetch(url, init)
    const data = await readBody(res)
    return { res, data }
  }

  /** 发请求：网络失败自动拉起并重试一次；401 重新读 token 重试一次 */
  async function request(method, apiPath, opts = {}) {
    let lastError = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { res, data } = await rawRequest(method, apiPath, opts)
        if (res.status === 401 && attempt === 0) {
          log('token 已失效（App 可能重启过），重读发现文件后重试')
          endpoint = null
          continue
        }
        if (!res.ok) {
          const err = data?.error || {}
          throw new TinyDoApiError(err.message || `请求失败（HTTP ${res.status}）`, {
            status: res.status,
            code: err.code || 'HTTP_ERROR',
          })
        }
        return data
      } catch (err) {
        lastError = err
        const isNetwork = err?.name === 'TimeoutError' || err?.cause?.code === 'ECONNREFUSED' ||
          /fetch failed|ECONNREFUSED|socket hang up/i.test(String(err?.message))
        if (attempt === 0 && isNetwork) {
          log('连接本地 API 失败，尝试自动拉起 TinyDo…')
          endpoint = null
          if (autoLaunch) await launchApp({ log })
          continue
        }
        if (err instanceof TinyDoApiError) throw err
        if (isNetwork) {
          throw new TinyDoApiError(
            `无法连接 TinyDo 本地 API：${err.message}（App 可能在启动中，稍后重试）`,
            { code: 'NETWORK' },
          )
        }
        throw err
      }
    }
    throw lastError || new TinyDoApiError('请求失败', { code: 'UNKNOWN' })
  }

  return {
    actor,
    ensureEndpoint,
    request,
    health: () => request('GET', '/health'),

    listTasks: (q = {}) => request('GET', '/v1/tasks', { query: q }),
    getTask: (id) => request('GET', `/v1/tasks/${encodeURIComponent(id)}`),
    addTask: (body) => request('POST', '/v1/tasks', { body }),
    updateTask: (id, body) => request('PATCH', `/v1/tasks/${encodeURIComponent(id)}`, { body }),
    completeTask: (id, completed = true) =>
      request('POST', `/v1/tasks/${encodeURIComponent(id)}/complete`, { body: { completed } }),
    deleteTask: (id) => request('DELETE', `/v1/tasks/${encodeURIComponent(id)}`),
    bulkAddTasks: (body) => request('POST', '/v1/tasks/bulk', { body }),
    stats: () => request('GET', '/v1/stats'),
    audit: (limit = 50) => request('GET', '/v1/audit', { query: { limit } }),

    /** 自检：发现文件 / App / 端口 / token / 数据层 / 同步 一眼可见 */
    async doctor() {
      const report = { portFile: resolvePortFile(), endpoint: null, health: null, stats: null, problems: [] }
      const found = readEndpoint()
      if (!found) {
        report.problems.push(`未找到发现文件（${resolvePortFile()}）→ App 未运行或外部助手被关闭`)
      } else {
        report.endpoint = { port: found.port, enabled: found.enabled !== false, pid: found.pid, version: found.version }
        if (found.enabled === false) report.problems.push('外部助手已在 TinyDo 设置里关闭（打开后可立即使用）')
      }
      try {
        report.health = await request('GET', '/health')
      } catch (err) {
        report.problems.push(`/health 失败：${err.message}`)
      }
      try {
        report.stats = await request('GET', '/v1/stats')
      } catch (err) {
        report.problems.push(`/v1/stats 失败：${err.message}`)
      }
      return report
    },
  }
}
