/**
 * TTS 统一入口：双引擎（系统语音兜底 + Edge TTS 增强）+ 自动降级
 *
 * - speak(text, cfg)：朗读一段文本；Edge 失败（网络/接口变动/超时）自动降级系统语音
 * - stopSpeaking()：立即停止
 * - ttsState：响应式播放状态（供 UI 显示「正在朗读/停止」）
 *
 * 朗读队列策略：单队列 + 新请求打断旧请求（小柴回复为 2~6 句短文本，无需复杂队列）。
 */

import { reactive } from 'vue'
import { EDGE_TTS_MAX_CHARS, edgeSynthesize, splitTextForTts } from './edge-tts'

export type TtsEngine = 'system' | 'edge'

export interface TtsConfig {
  engine: TtsEngine
  /** Edge TTS 声音名（如 zh-CN-XiaoxiaoNeural）；系统引擎自动匹配中文语音 */
  voice: string
  /** 语速，1 = 原速，范围 0.5 ~ 2 */
  rate: number
}

/** 响应式播放状态（组件直接引用显示播放中状态） */
export const ttsState = reactive({
  speaking: false,
  /** 正在朗读的消息 id（聊天面板高亮用），无关联时为 null */
  speakingMessageId: null as string | null,
  /** 实际使用的引擎（Edge 降级后为 system，供调试/提示） */
  engineUsed: null as TtsEngine | null,
})

let generation = 0 // 打断计数：新请求 +1，旧请求的回调发现代号不一致即放弃
let currentAudio: HTMLAudioElement | null = null

export function stopSpeaking(): void {
  generation += 1
  ttsState.speaking = false
  ttsState.speakingMessageId = null
  if (currentAudio) {
    try { currentAudio.pause() } catch { /* ignore */ }
    currentAudio = null
  }
  try {
    if (typeof speechSynthesis !== 'undefined' && speechSynthesis.speaking) {
      speechSynthesis.cancel()
    }
  } catch { /* ignore */ }
}

/** 朗读入口。返回实际使用的引擎。 */
export async function speak(
  text: string,
  cfg: TtsConfig,
  opts?: { messageId?: string | null },
): Promise<TtsEngine> {
  const clean = text.trim()
  if (!clean) return ttsState.engineUsed ?? cfg.engine
  stopSpeaking()
  const gen = generation
  ttsState.speaking = true
  ttsState.speakingMessageId = opts?.messageId ?? null

  try {
    if (cfg.engine === 'edge') {
      try {
        await edgeSpeakWithFallbackGuard(clean, cfg, gen)
        ttsState.engineUsed = 'edge'
        return 'edge'
      } catch (err) {
        if (gen !== generation) return ttsState.engineUsed ?? 'system' // 已被新请求打断
        console.warn('[TTS] Edge TTS 失败，自动降级为系统语音:', err)
      }
    }
    await systemSpeak(clean, cfg.rate, gen)
    ttsState.engineUsed = 'system'
    return 'system'
  } finally {
    if (gen === generation) {
      ttsState.speaking = false
      ttsState.speakingMessageId = null
    }
  }
}

/** Edge 引擎：分段合成 + 顺序播放；任一段失败抛错（触发整体降级） */
async function edgeSpeakWithFallbackGuard(text: string, cfg: TtsConfig, gen: number): Promise<void> {
  const chunks = splitTextForTts(text, EDGE_TTS_MAX_CHARS)
  for (const chunk of chunks) {
    if (gen !== generation) return // 被打断
    const blob = await edgeSynthesize(chunk, cfg.voice, cfg.rate)
    if (gen !== generation) return
    await playAudioBlob(blob)
  }
}

function playAudioBlob(blob: Blob): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    currentAudio = audio
    audio.onended = () => {
      if (currentAudio === audio) currentAudio = null
      URL.revokeObjectURL(url)
      resolve()
    }
    audio.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('音频播放失败'))
    }
    audio.play().catch(err => reject(err instanceof Error ? err : new Error('播放被拒绝')))
  })
}

/** 系统引擎：speechSynthesis，自动匹配中文语音 */
function systemSpeak(text: string, rate: number, gen: number): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      if (typeof speechSynthesis === 'undefined') {
        reject(new Error('当前环境不支持系统语音合成'))
        return
      }
      const utter = new SpeechSynthesisUtterance(text)
      utter.rate = Math.min(2, Math.max(0.5, rate))
      utter.lang = 'zh-CN'
      const zhVoice = pickChineseVoice()
      if (zhVoice) utter.voice = zhVoice
      utter.onend = () => resolve()
      utter.onerror = () => {
        // cancel 触发的 error（打断）不算失败
        if (gen === generation) resolve()
      }
      speechSynthesis.speak(utter)
    } catch (err) {
      reject(err instanceof Error ? err : new Error('系统语音合成失败'))
    }
  })
}

function pickChineseVoice(): SpeechSynthesisVoice | null {
  try {
    const voices = speechSynthesis.getVoices()
    if (!voices.length) return null
    return voices.find(v => v.lang === 'zh-CN')
      ?? voices.find(v => v.lang.startsWith('zh'))
      ?? null
  } catch {
    return null
  }
}
