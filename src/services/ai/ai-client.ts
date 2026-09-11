/**
 * AI 客户端：OpenAI 兼容 /chat/completions 请求封装
 *
 * 跨环境策略（与 kodo.ts 同思路）：
 * - Capacitor 原生（iOS/Android）：CapacitorHttp 走原生网络栈（绕过 WKWebView 的 CORS），
 *   注意其只支持完整缓冲响应，因此本模块统一非流式请求。
 * - Electron：fetch 直连（webSecurity: false 无 CORS 限制）。
 * - 浏览器：fetch 直连（OpenAI/DeepSeek 等主流接口带 CORS 头；个别不带的中转站在
 *   Web 端会失败，原生/桌面端不受影响，错误信息中已提示）。
 *
 * Base URL 约定：填到 /v1 这一层（如 https://api.deepseek.com/v1），本模块自动拼 /chat/completions。
 */

import { Capacitor, CapacitorHttp } from '@capacitor/core'

export interface AiClientConfig {
  baseUrl: string
  apiKey: string
  model: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

const CONNECT_TIMEOUT = 15000
const READ_TIMEOUT = 120000

// ============ 环境判断 ============

function isElectronEnv(): boolean {
  if (typeof window === 'undefined') return false
  if ((window as any).electronAPI) return true
  if (typeof location !== 'undefined' && location.protocol === 'file:') return true
  return false
}

const IS_CAPACITOR_NATIVE = typeof Capacitor !== 'undefined' && Capacitor.isNativePlatform()

// ============ 对外 API ============

export function isAiConfigured(cfg: AiClientConfig): boolean {
  return !!(cfg.baseUrl?.trim() && cfg.apiKey?.trim() && cfg.model?.trim())
}

/**
 * 发起一次对话补全（非流式），返回第一条回复文本。
 * 抛出的 Error 均为可直接展示给用户的友好文案。
 */
export async function chatCompletion(
  cfg: AiClientConfig,
  messages: ChatMessage[],
  opts?: { temperature?: number; maxTokens?: number; timeoutMs?: number },
): Promise<string> {
  if (!isAiConfigured(cfg)) throw new Error('AI 服务未配置')
  const url = cfg.baseUrl.trim().replace(/\/+$/, '') + '/chat/completions'
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey.trim()}`,
  }
  const body = JSON.stringify({
    model: cfg.model.trim(),
    messages,
    stream: false,
    temperature: opts?.temperature ?? 0.8,
    ...(opts?.maxTokens ? { max_tokens: opts.maxTokens } : {}),
  })

  let status = 0
  let text = ''
  try {
    if (IS_CAPACITOR_NATIVE) {
      const res = await CapacitorHttp.request({
        url,
        method: 'POST',
        headers,
        data: body,
        responseType: 'text',
        connectTimeout: CONNECT_TIMEOUT,
        readTimeout: opts?.timeoutMs ?? READ_TIMEOUT,
      })
      status = res.status
      text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '')
    } else {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? READ_TIMEOUT)
      try {
        const res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal })
        status = res.status
        text = await res.text()
      } finally {
        clearTimeout(timer)
      }
    }
  } catch (err: any) {
    throw new Error(friendlyNetworkError(err))
  }

  if (status < 200 || status >= 300) {
    throw new Error(apiError(status, text))
  }

  let data: any
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('AI 接口返回了无法解析的内容，请检查 Base URL 是否指向 OpenAI 兼容接口')
  }
  const msg = data?.choices?.[0]?.message
  const content = typeof msg?.content === 'string' && msg.content.trim()
    ? msg.content
    : (typeof msg?.reasoning_content === 'string' ? msg.reasoning_content : '')
  if (!content.trim()) throw new Error('AI 未返回回复内容，请重试或更换模型')
  return content
}

/** 用一条极短请求验证配置是否可用（设置页「测试连接」） */
export async function testAiConnection(cfg: AiClientConfig): Promise<{ ok: boolean; message: string }> {
  if (!isAiConfigured(cfg)) return { ok: false, message: '请先填写 Base URL、API Key 和模型名' }
  try {
    await chatCompletion(
      cfg,
      [{ role: 'user', content: '请只回复两个字：好的' }],
      { maxTokens: 16, temperature: 0, timeoutMs: 30000 },
    )
    return { ok: true, message: `连接成功，模型 ${cfg.model} 已正常响应` }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : '连接失败' }
  }
}

// ============ 错误友好化 ============

function extractServerMessage(body: string): string {
  try {
    const msg = JSON.parse(body)?.error?.message
    if (typeof msg === 'string') return msg
  } catch {
    // ignore
  }
  return ''
}

function apiError(status: number, body: string): string {
  const detail = extractServerMessage(body)
  const suffix = detail ? `（${detail.slice(0, 120)}）` : ''
  if (status === 401) return `API Key 无效或已过期${suffix}`
  if (status === 403) return `没有访问该模型的权限${suffix}`
  if (status === 404) return `接口不存在，请检查 Base URL（一般需以 /v1 结尾）${suffix}`
  if (status === 429) return `请求太频繁或额度不足${suffix}`
  if (status >= 500) return `AI 服务暂时不可用（HTTP ${status}）${suffix}`
  return `请求失败（HTTP ${status}）${suffix}`
}

function friendlyNetworkError(err: any): string {
  if (err?.name === 'AbortError') return '请求超时，请检查网络后重试'
  return '网络请求失败：请检查网络；若在浏览器中使用，也可能是该接口不允许跨域直连（iOS/桌面端不受此限制）'
}
