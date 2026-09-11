/**
 * Edge TTS 客户端（微软 Edge 朗读接口，非官方）
 *
 * 协议：wss 连接 → 发送 speech.config + SSML → 收集二进制音频帧（MP3）→ 拼成 Blob。
 * - 免费无 Key；需按社区逆向的算法生成 Sec-MS-GEC token（5 分钟时间窗 + SHA-256）
 * - 音频格式固定 audio-24khz-48kbitrate-mono-mp3，三端 WebView 播放兼容性最稳
 * - 非官方接口可能变动：调用方（tts/index.ts）必须捕获失败并降级到系统语音
 */

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const EDGE_TTS_WS_URL =
  'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
// 必须跟随较新的 Edge 版本，过旧版本号会被 403 拒绝（社区 edge-tts 项目同步维护）
const GEC_VERSION = '1-143.0.3650.75'
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3'
const CONNECT_TIMEOUT_MS = 10000
const STREAM_TIMEOUT_MS = 60000

export interface EdgeVoice {
  value: string
  label: string
}

/** 预设中文声音（设置页下拉） */
export const EDGE_VOICES: EdgeVoice[] = [
  { value: 'zh-CN-XiaoxiaoNeural', label: '晓晓（女·温柔）' },
  { value: 'zh-CN-XiaoyiNeural', label: '晓伊（女·活泼）' },
  { value: 'zh-CN-YunjianNeural', label: '云健（男·浑厚）' },
  { value: 'zh-CN-YunxiNeural', label: '云希（男·阳光）' },
  { value: 'zh-CN-YunyeNeural', label: '云野（男·沉稳）' },
  { value: 'zh-HK-HiuMaanNeural', label: '晓曼（女·粤语）' },
  { value: 'zh-TW-HsiaoChenNeural', label: '晓臻（女·台湾腔）' },
]

/** 单段合成上限（超过请按句切分后多次调用） */
export const EDGE_TTS_MAX_CHARS = 1000

/**
 * 生成 Sec-MS-GEC token：
 * (unix 秒 + Windows 纪元) 向下取 5 分钟窗口 × 1e7（转 100ns ticks）拼接 token 后 SHA-256 大写
 */
async function genSecMsGec(): Promise<string> {
  const WIN_EPOCH = 11644473600
  let ticks = Math.floor(Date.now() / 1000) + WIN_EPOCH
  ticks -= ticks % 300
  const str = `${ticks}0000000${TRUSTED_CLIENT_TOKEN}` // ticks × 1e7 = 秒级整数后拼 7 个 0
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function uuidNoDash(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('')
}

function timestamp(): string {
  return new Date().toISOString()
}

/** rate 倍速（1 = 原速）转 SSML 百分比 */
function rateToPercent(rate: number): string {
  const pct = Math.round((Math.min(2, Math.max(0.5, rate)) - 1) * 100)
  return `${pct >= 0 ? '+' : ''}${pct}%`
}

/**
 * 合成一段文本（≤ EDGE_TTS_MAX_CHARS 字符）为 MP3 Blob。
 * 失败（连接被拒 / 超时 / 无音频）抛 Error，由调用方降级。
 */
export function edgeSynthesize(text: string, voice: string, rate = 1): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    let settled = false
    const fail = (msg: string) => {
      if (settled) return
      settled = true
      try { ws.close() } catch { /* ignore */ }
      reject(new Error(msg))
    }
    const done = (blob: Blob) => {
      if (settled) return
      settled = true
      try { ws.close() } catch { /* ignore */ }
      resolve(blob)
    }

    const audioChunks: BlobPart[] = []
    let ws: WebSocket
    ;(async () => {
      try {
        const gec = await genSecMsGec()
        const url = `${EDGE_TTS_WS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${GEC_VERSION}`
        ws = new WebSocket(url)
        ws.binaryType = 'arraybuffer'
      } catch (err) {
        fail(`Edge TTS 连接创建失败: ${err instanceof Error ? err.message : err}`)
        return
      }

      const connectTimer = setTimeout(() => fail('Edge TTS 连接超时'), CONNECT_TIMEOUT_MS)
      const streamTimer = { id: 0 }
      const resetStreamTimer = () => {
        clearTimeout(streamTimer.id)
        streamTimer.id = window.setTimeout(() => fail('Edge TTS 音频流超时'), STREAM_TIMEOUT_MS)
      }

      ws.onopen = () => {
        clearTimeout(connectTimer)
        resetStreamTimer()
        // 1. speech.config：声明输出格式
        ws.send(
          `X-Timestamp:${timestamp()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
          `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"${OUTPUT_FORMAT}"}}}}`,
        )
        // 2. SSML
        const ssml =
          `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>` +
          `<voice name='${voice}'><prosody rate='${rateToPercent(rate)}' pitch='+0Hz' volume='+0%'>${xmlEscape(text)}</prosody></voice></speak>`
        ws.send(
          `X-RequestId:${uuidNoDash()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${timestamp()}\r\nPath:ssml\r\n\r\n${ssml}`,
        )
      }

      ws.onmessage = (ev: MessageEvent) => {
        resetStreamTimer()
        if (typeof ev.data === 'string') {
          // 文本消息：turn.end 表示本段音频发送完毕
          if (ev.data.includes('Path:turn.end')) {
            if (audioChunks.length === 0) {
              fail('Edge TTS 未返回音频（接口可能已变更）')
            } else {
              done(new Blob(audioChunks, { type: 'audio/mpeg' }))
            }
          }
          return
        }
        // 二进制消息：前 2 字节大端 = header 长度，其后为音频数据
        try {
          const buf = ev.data as ArrayBuffer
          const headerLen = new DataView(buf).getUint16(0)
          if (buf.byteLength > headerLen + 2) {
            audioChunks.push(buf.slice(headerLen + 2))
          }
        } catch {
          // 坏帧忽略
        }
      }

      ws.onerror = () => {
        clearTimeout(connectTimer)
        fail('Edge TTS 连接失败（网络不通或接口被拒）')
      }
      ws.onclose = () => {
        clearTimeout(connectTimer)
        fail('Edge TTS 连接被关闭')
      }
    })()
  })
}

/** 按句子把长文本切分为若干段（每段 ≤ maxChars），供分段合成 */
export function splitTextForTts(text: string, maxChars = 500): string[] {
  // 按句末标点手动切分（不用后行断言，兼容旧 WebView）
  const sentences: string[] = []
  let s = ''
  for (const ch of text.replace(/\s+/g, ' ')) {
    s += ch
    if ('。！？!?；;\n'.includes(ch)) {
      sentences.push(s.trim())
      s = ''
    }
  }
  if (s.trim()) sentences.push(s.trim())

  const chunks: string[] = []
  let cur = ''
  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      if (cur) { chunks.push(cur); cur = '' }
      for (let i = 0; i < sentence.length; i += maxChars) chunks.push(sentence.slice(i, i + maxChars))
      continue
    }
    if ((cur + sentence).length > maxChars) {
      if (cur) chunks.push(cur)
      cur = sentence
    } else {
      cur += sentence
    }
  }
  if (cur) chunks.push(cur)
  return chunks.length ? chunks : [text]
}
