import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getSyncEngine, type SyncEngine } from '../services/sync-engine'
import type { SyncConfig, SyncState } from '../services/providers/types'
import { DEFAULT_SYNC_CONFIG } from '../services/providers/types'
import { KodoProvider, type KodoConfig } from '../services/providers/kodo'

// ============ 类型 ============

export interface CloudProviderConfig {
  id: string
  name: string
  type: 'kodo'
  enabled: boolean
  config: Record<string, string>
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  lastError?: string
}

/** 小柴配置（OpenAI 兼容接口，API Key 与同步密钥同级存 localStorage） */
export interface AiSettings {
  baseUrl: string
  apiKey: string
  model: string
  /** 追加到默认系统提示词之后的用户自定义要求 */
  customPrompt: string
}

/** 朗读（TTS）配置 */
export interface TtsSettings {
  /** AI 回复后自动朗读（关闭时仍可点消息上的朗读按钮） */
  autoSpeak: boolean
  /** edge = Edge TTS（默认，云端神经网络语音，音质自然）；system = 系统语音（离线兜底） */
  engine: 'system' | 'edge'
  /** Edge TTS 声音名 */
  edgeVoice: string
  /** 语速 0.5 ~ 2，1 = 原速 */
  rate: number
}

export interface AppSettings {
  sync: SyncConfig
  providers: CloudProviderConfig[]
  ui: {
    defaultView: 'list' | 'calendar' | 'matrix'
    theme: 'light' | 'dark' | 'system'
  }
  ai: AiSettings
  tts: TtsSettings
}

const DEFAULT_SETTINGS: AppSettings = {
  sync: { ...DEFAULT_SYNC_CONFIG },
  providers: [
    {
      id: 'kodo-default',
      name: '七牛云 Kodo',
      type: 'kodo',
      enabled: false,
      config: {
        bucket: '',
        region: 'cn-east-1',
        accessKeyId: '',
        accessKeySecret: '',
      },
      status: 'disconnected',
    },
  ],
  ui: {
    defaultView: 'list',
    theme: 'system',
  },
  ai: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    customPrompt: '',
  },
  tts: {
    autoSpeak: false,
    engine: 'edge',
    edgeVoice: 'zh-CN-XiaoxiaoNeural',
    rate: 1,
  },
}

// ============ Store ============

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<AppSettings>(loadSettings())
  const syncEngine = getSyncEngine()

  // ============ Getter ============

  const activeProvider = computed(() => {
    return settings.value.providers.find(p => p.enabled) ?? null
  })

  // 同步状态：必须订阅引擎变化保持响应式。
  // 之前用 computed(() => syncEngine.getState())——syncEngine.state 不是 Vue 响应式对象，
  // computed 只计算一次就缓存初始快照，导致设置页永远显示“同步正常”、看不到诊断/错误。
  const syncState = ref<SyncState>(syncEngine.getState())
  syncEngine.onStateChange((s) => {
    syncState.value = s
  })

  const isSyncEnabled = computed(() => {
    return settings.value.sync.enabled && activeProvider.value !== null
  })

  // ============ Actions ============

  /** 更新同步配置 */
  function updateSyncConfig(config: Partial<SyncConfig>) {
    settings.value.sync = { ...settings.value.sync, ...config }
    syncEngine.updateConfig(settings.value.sync)
    saveSettings(settings.value)
  }

  /** 更新云存储提供者配置 */
  function updateProvider(providerId: string, updates: Partial<CloudProviderConfig>) {
    const idx = settings.value.providers.findIndex(p => p.id === providerId)
    if (idx !== -1) {
      settings.value.providers[idx] = { ...settings.value.providers[idx], ...updates }
      saveSettings(settings.value)
    }
  }

  /** 启用/禁用提供者 */
  function toggleProvider(providerId: string) {
    const provider = settings.value.providers.find(p => p.id === providerId)
    if (!provider) return

    // 先禁用所有其他提供者
    settings.value.providers.forEach(p => {
      if (p.id !== providerId) p.enabled = false
    })

    provider.enabled = !provider.enabled
    settings.value.sync.enabled = provider.enabled

    if (provider.enabled) {
      connectProvider(provider).catch(console.error)
    } else {
      settings.value.sync.enabled = false
      syncEngine.updateConfig({ enabled: false, provider: 'none' })
    }

    saveSettings(settings.value)
  }

  /** 连接云存储提供者 */
  async function connectProvider(provider: CloudProviderConfig) {
    provider.status = 'connecting'
    saveSettings(settings.value)

    try {
      if (provider.type === 'kodo') {
        try {
          if (!provider.config.bucket || !provider.config.accessKeyId || !provider.config.accessKeySecret) {
            throw new Error('请填写 Bucket 名称和 AccessKey')
          }
          const kodoConfig: KodoConfig = {
            bucket: provider.config.bucket,
            region: provider.config.region || 'cn-east-1',
            accessKeyId: provider.config.accessKeyId,
            accessKeySecret: provider.config.accessKeySecret,
          }
          const kodoProvider = new KodoProvider(kodoConfig)
          const testResult = await kodoProvider.testConnection()
          if (!testResult.ok) {
            throw new Error(testResult.message)
          }
          await syncEngine.setProvider(kodoProvider)
          provider.status = 'connected'
        } catch (err) {
          provider.status = 'error'
          provider.lastError = err instanceof Error ? err.message : '七牛云连接失败'
        }
      }

      settings.value.sync.enabled = provider.status === 'connected'
      saveSettings(settings.value)
    } catch (err) {
      provider.status = 'error'
      provider.lastError = err instanceof Error ? err.message : '连接失败'
      saveSettings(settings.value)
    }
  }

  /** 断开云存储连接 */
  async function disconnectProvider() {
    syncEngine.destroy()
    settings.value.providers.forEach(p => {
      p.enabled = false
      p.status = 'disconnected'
    })
    settings.value.sync.enabled = false
    saveSettings(settings.value)
  }

  /** 测试 OSS 连接 */
  async function testKodoConnection(): Promise<{ ok: boolean; message: string }> {
    const provider = settings.value.providers.find(p => p.id === 'kodo-default')
    if (!provider) return { ok: false, message: '找不到七牛云配置' }
    if (!provider.config.bucket || !provider.config.accessKeyId || !provider.config.accessKeySecret) {
      return { ok: false, message: '请先填写 Bucket 名称和 AccessKey' }
    }
    try {
      const kodoConfig: KodoConfig = {
        bucket: provider.config.bucket,
        region: provider.config.region || 'cn-east-1',
        accessKeyId: provider.config.accessKeyId,
        accessKeySecret: provider.config.accessKeySecret,
      }
      const kodoProvider = new KodoProvider(kodoConfig)
      return await kodoProvider.testConnection()
    } catch (err: any) {
      return { ok: false, message: err.message || '连接测试失败' }
    }
  }

  /** 触发立即同步 */
  async function syncNow() {
    return syncEngine.syncNow()
  }

  /** 更新 UI 设置 */
  function updateUISettings(ui: Partial<AppSettings['ui']>) {
    settings.value.ui = { ...settings.value.ui, ...ui }
    saveSettings(settings.value)
  }

  /** 更新小柴配置 */
  function updateAiSettings(ai: Partial<AiSettings>) {
    settings.value.ai = { ...settings.value.ai, ...ai }
    saveSettings(settings.value)
  }

  /** 更新朗读（TTS）配置 */
  function updateTtsSettings(tts: Partial<TtsSettings>) {
    settings.value.tts = { ...settings.value.tts, ...tts }
    saveSettings(settings.value)
  }

  return {
    settings,
    activeProvider,
    syncState,
    isSyncEnabled,
    updateSyncConfig,
    updateProvider,
    toggleProvider,
    connectProvider,
    disconnectProvider,
    testKodoConnection,
    syncNow,
    updateUISettings,
    updateAiSettings,
    updateTtsSettings,
  }
})

// ============ 持久化 ============

const SETTINGS_KEY = 'todo-app-settings'

function loadSettings(): AppSettings {
  try {
    const saved = localStorage.getItem(SETTINGS_KEY)
    if (saved) {
      const parsed = JSON.parse(saved)
      // 合并 providers：保留已连接的 provider，但确保所有默认 provider 都存在
      const defaultProviders = DEFAULT_SETTINGS.providers.map(p => ({ ...p }))
      const savedProviders = parsed.providers || []
      const mergedProviders = defaultProviders.map(dp => {
        const saved = savedProviders.find((sp: any) => sp.id === dp.id)
        return saved ? { ...dp, ...saved } : dp
      })
      // ai / tts 配置浅合并：旧版本 localStorage 缺字段时补齐默认值
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        providers: mergedProviders,
        ai: { ...DEFAULT_SETTINGS.ai, ...(parsed.ai || {}) },
        tts: { ...DEFAULT_SETTINGS.tts, ...(parsed.tts || {}) },
      }
    }
  } catch {
    // ignore
  }
  return { ...DEFAULT_SETTINGS, providers: DEFAULT_SETTINGS.providers.map(p => ({ ...p })) }
}

function saveSettings(s: AppSettings) {
  try {
    // 敏感信息脱敏后存储（密码实际应该加密，当前简化处理）
    const toSave = {
      ...s,
      providers: s.providers.map(p => ({
        ...p,
        config: { ...p.config },
      })),
    }
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(toSave))
  } catch (err) {
    console.error('[Settings] Failed to save:', err)
  }
}
