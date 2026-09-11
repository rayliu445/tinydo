/**
 * Azure Speech 官方 TTS（REST）
 *
 * 与 Edge TTS 共用同一批神经网络音色（晓晓/云健等），但走官方 HTTP 接口：
 * - 稳定：无 WS 握手风控问题，三端（Web/Electron/Capacitor）均可直连
 * - 免费层 F0：每月 50 万神经语音字符（需自行注册 Azure 并创建 Speech 资源拿 Key）
 * - 文档：https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech
 *
 * 请求：POST https://{region}.tts.speech.microsoft.com/cognitiveservices/v1
 * 鉴权：Ocp-Apim-Subscription-Key 头（直接用 Key，无需先换 token）
 */

import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { buildSsml } from './edge-tts'

export interface AzureRegion {
  value: string
  label: string
}

/** 常用区域（选离用户近的，国内用户 eastasia 香港可达性最好） */
export const AZURE_REGIONS: AzureRegion[] = [
  { value: 'eastasia', label: '东亚（香港）' },
  { value: 'southeastasia', label: '东南亚（新加坡）' },
  { value: 'japaneast', label: '日本东部' },
  { value: 'koreacentral', label: '韩国中部' },
  { value: 'eastus', label: '美国东部' },
  { value: 'westus2', label: '美国西部 2' },
  { value: 'westeurope', label: '西欧' },
]

export interface AzureTtsConfig {
  region: string
  key: string
  voice: string
  rate: number
}

const IS_CAPACITOR_NATIVE = typeof Capacitor !== 'undefined' && Capacitor.isNativePlatform()

/**
 * 合成一段文本（≤1000 字符，超出请分段）为 MP3 Blob。
 * 失败抛 Error（含可读原因），由调用方降级到系统语音。
 */
export async function azureSynthesize(text: string, cfg: AzureTtsConfig): Promise<Blob> {
  if (!cfg.region || !cfg.key) {
    throw new Error('尚未配置 Azure 区域和密钥（设置 → AI 助手 → 朗读）')
  }
  const url = `https://${cfg.region}.tts.speech.microsoft.com/cognitiveservices/v1`
  const headers: Record<string, string> = {
    'Ocp-Apim-Subscription-Key': cfg.key.trim(),
    'Content-Type': 'application/ssml+xml',
    'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
    'User-Agent': 'TinyDo',
  }
  const body = buildSsml(cfg.voice, text, cfg.rate)

  // Capacitor 原生（iOS/Android）走 CapacitorHttp 绕过 WKWebView 的 CORS；其他环境标准 fetch
  if (IS_CAPACITOR_NATIVE) {
    const res = await CapacitorHttp.request({
      url,
      method: 'POST',
      headers,
      data: body,
      responseType: 'arraybuffer',
      connectTimeout: 15000,
      readTimeout: 60000,
    })
    if (res.status < 200 || res.status >= 300) {
      throw new Error(azureApiError(res.status))
    }
    const data = res.data
    if (data == null) throw new Error('Azure TTS 未返回音频')
    if (typeof data === 'string') {
      // CapacitorHttp 可能返回 base64
      const clean = data.startsWith('data:') && data.includes(',') ? data.slice(data.indexOf(',') + 1) : data
      return base64ToBlob(clean)
    }
    return new Blob([data as unknown as BlobPart], { type: 'audio/mpeg' })
  }

  let res: Response
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30000)
    try {
      res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') throw new Error('Azure TTS 请求超时（30 秒）')
    throw new Error('Azure TTS 网络请求失败（请检查网络）')
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(azureApiError(res.status))
  }
  return await res.blob()
}

function azureApiError(status: number): string {
  if (status === 401 || status === 403) return 'Azure 密钥无效或与区域不匹配（HTTP ' + status + '）'
  if (status === 429) return '超出 Azure 免费层请求频率/配额（HTTP 429），请稍后重试'
  if (status === 404) return 'Azure 区域不存在，请检查区域选择（HTTP 404）'
  return `Azure TTS 请求失败（HTTP ${status}）`
}

function base64ToBlob(b64: string): Blob {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: 'audio/mpeg' })
}
