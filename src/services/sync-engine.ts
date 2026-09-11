/**
 * 同步引擎
 * 
 * 核心同步逻辑，负责：
 * 1. 启动时从云存储加载并合并
 * 2. 本地变更后自动写入云存储
 * 3. 监听云文件变化并合并到本地
 * 4. 提供同步状态和错误处理
 */

import type { CloudProvider, SyncConfig, SyncState, SyncResult } from './providers/types'
import { DEFAULT_SYNC_CONFIG } from './providers/types'
import { getDataAccess, type Todo, type AiThread } from './data-access'
import { fromJS, loadDoc, saveDoc, getDocSnapshot } from './crdt-doc'

export class SyncEngine {
  private provider: CloudProvider | null = null
  private config: SyncConfig
  private state: SyncState
  private unwatch: (() => void) | null = null
  private syncTimer: number | null = null
  private writeTimer: number | null = null
  private stateListeners: Set<(state: SyncState) => void> = new Set()
  private _initialized = false
  // 重入锁：防止 autoSync / watch / scheduleWrite 并发触发多个 syncNow 叠加执行
  // （叠加的全量查询 + 全量重插 + export + 上传会让 GC 追不上，堆内存持续膨胀）
  private _syncing = false

  // 防抖：500ms 内多次写入只触发一次
  private pendingWrite = false
  private readonly WRITE_DEBOUNCE_MS = 500
  // 云文件路径：todos 用 CRDT 文档，AI 会话线程用 JSON（线程级 LWW + tombstone）
  private readonly CLOUD_FILE = 'data.automerge'
  private readonly AI_THREADS_FILE = 'ai-threads.json'

  constructor(config?: Partial<SyncConfig>) {
    this.config = { ...DEFAULT_SYNC_CONFIG, ...config }
    this.state = {
      status: 'idle',
      lastSyncTime: null,
      lastError: null,
      isOnline: navigator?.onLine ?? true,
    }

    // 监听网络状态
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        this.state.isOnline = true
        this.notifyState()
        if (this.config.autoSync) {
          this.syncNow().catch(console.error)
        }
      })
      window.addEventListener('offline', () => {
        this.state.isOnline = false
        this.state.status = 'offline'
        this.notifyState()
      })
    }
  }

  // ============ 初始化 ============

  /**
   * 设置云存储提供者并初始化同步
   */
  async setProvider(provider: CloudProvider): Promise<void> {
    // 清理旧的提供者
    this.destroy()

    this.provider = provider
    // 启用同步：连接成功后 scheduleWrite/syncNow/autoSync 才会真正执行
    this.config.enabled = true
    await provider.initialize()

    // 首次同步：从云加载并合并
    await this.initialSync()

    // 启动文件监听
    this.startWatching()

    // 启动定时同步
    if (this.config.autoSync) {
      this.startAutoSync()
    }

    this._initialized = true
    console.log('[SyncEngine] Initialized with provider:', provider.name)
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<SyncConfig>): void {
    this.config = { ...this.config, ...config }

    // 如果自动同步设置变化，重启定时器
    if (this.syncTimer !== null) {
      this.stopAutoSync()
    }
    if (this.config.autoSync && this._initialized) {
      this.startAutoSync()
    }
  }

  /**
   * 获取当前配置
   */
  getConfig(): SyncConfig {
    return { ...this.config }
  }

  // ============ 核心同步 ============

  /**
   * 手动触发同步
   */
  async syncNow(): Promise<SyncResult> {
    if (!this.provider || !this.config.enabled) {
      return {
        success: false,
        merged: false,
        changesIncoming: 0,
        changesOutgoing: 0,
        duration: 0,
        error: 'Sync not configured',
      }
    }
    // 重入保护：已有同步在进行中则稍后重试，避免并发叠加
    // （watch 轮询 / autoSync 定时器 / scheduleWrite 可能同时触发 syncNow，
    //   直接跳过会让用户的修改延迟到下一个 autoSync 周期才推送）
    if (this._syncing) {
      if (this.writeTimer === null) {
        this.writeTimer = window.setTimeout(async () => {
          this.writeTimer = null
          await this.syncNow()
        }, this.WRITE_DEBOUNCE_MS)
      }
      return {
        success: false,
        merged: false,
        changesIncoming: 0,
        changesOutgoing: 0,
        duration: 0,
        error: 'Sync already in progress',
      }
    }
    this._syncing = true

    const startTime = Date.now()
    this.state.status = 'syncing'
    this.notifyState()

    try {
      const dataAccess = getDataAccess()

      // 1. 本地数据（SQLite 是数据源）——含软删除标记（tombstone），
      //    否则云端残留的已删除任务会在 LWW 合并时“复活”
      const localAll = dataAccess.getAllTodos()
      const localLive = localAll.filter(t => !t.deleted)

      // 2. 云端数据（CRDT 文档，含 deleted 标记）
      let cloudTodos: Todo[] = []
      let cloudBytes: number | null = null
      let cloudDocBytes: Uint8Array | null = null
      try {
        const cloudData = await this.provider.read(this.CLOUD_FILE)
        if (cloudData) {
          cloudBytes = cloudData.length
          cloudDocBytes = cloudData
          const cloudDoc = loadDoc(cloudData)
          const snap = getDocSnapshot(cloudDoc)
          cloudTodos = Object.values(snap.todos) as Todo[]
          console.log('[SyncEngine] 云端读取成功，任务数:', cloudTodos.length, '字节:', cloudBytes)
        } else {
          console.log('[SyncEngine] 云端无文件（首次），将上传本地数据')
        }
      } catch (err) {
        // 关键保护：云端读取失败时绝不能继续用本地数据覆盖云端（会导致云端数据丢失）。
        // 直接报错返回，等待下次重试。
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[SyncEngine] 云端读取失败，已中止本次同步（防止覆盖云端）:', err)
        this.state.status = 'error'
        this.state.lastError = `云端读取失败：${msg}`
        this.state.lastSyncDetail = {
          time: new Date().toISOString(),
          cloudBytes,
          stage: 'read',
          error: this.state.lastError,
        }
        this.notifyState()
        this._syncing = false
        return {
          success: false,
          merged: false,
          changesIncoming: 0,
          changesOutgoing: 0,
          duration: Date.now() - startTime,
          error: this.state.lastError!,
        }
      }

      // 3. LWW 合并：updated_at 更晚者胜，各自独有的都保留（含 tombstone）
      const mergedAll = mergeTodosByUpdatedAt(localAll, cloudTodos)
      const mergedLive = mergedAll.filter(t => !t.deleted)
      const changesIncoming = Math.max(0, mergedLive.length - localLive.length)

      // 4. 合并结果写回本地 SQLite（保留 tombstone），并通知 UI 刷新。
      //    数据无变化时跳过，避免每次同步都全量 DELETE+INSERT：
      //    - SQLite 文件内部布局变化 → db.export() 字节每次不同
      //    - 上传字节不同 → 云端 etag 变化 → watch 误判为他人改动 → 再次同步（无限循环）
      if (!sameTodos(mergedAll, localAll)) {
        dataAccess.replaceAll(mergedAll)
        await dataAccess.save()
      }

      // 5. 合并结果上传云端（云端始终是权威副本，含 tombstone 传播删除）。
      //    内容与云端一致时跳过上传，避免 self-watch 死循环 + 浪费流量。
      const doc = fromJS({ todos: mergedAll })
      const docBytes = saveDoc(doc)
      if (!cloudDocBytes || !sameBytes(docBytes, cloudDocBytes)) {
        await this.provider.write(this.CLOUD_FILE, docBytes)
      }

      // 6. AI 会话线程同步（独立云文件；失败不影响 todo 同步结果）
      await this.syncAiThreads()

      // 更新状态
      this.state.status = 'idle'
      this.state.lastSyncTime = new Date().toISOString()
      this.state.lastError = null
      this.state.lastSyncDetail = {
        time: new Date().toISOString(),
        cloudBytes,
        cloudTodos: cloudTodos.length,
        localTodos: localAll.length,
        mergedTodos: mergedAll.length,
      }
      this.notifyState()

      return {
        success: true,
        merged: changesIncoming > 0,
        changesIncoming,
        changesOutgoing: 0, // 简化处理
        duration: Date.now() - startTime,
      }
    } catch (err) {
      this.state.status = 'error'
      this.state.lastError = err instanceof Error ? err.message : 'Unknown sync error'
      this.state.lastSyncDetail = {
        time: new Date().toISOString(),
        stage: 'sync',
        error: this.state.lastError,
      }
      this.notifyState()

      return {
        success: false,
        merged: false,
        changesIncoming: 0,
        changesOutgoing: 0,
        duration: Date.now() - startTime,
        error: this.state.lastError!,
      }
    } finally {
      this._syncing = false
    }
  }

  /**
   * 调度写入（用户编辑后调用，防抖）
   */
  scheduleWrite(): void {
    if (!this.config.enabled || !this.provider) return

    if (this.writeTimer !== null) {
      window.clearTimeout(this.writeTimer)
    }

    this.pendingWrite = true
    this.writeTimer = window.setTimeout(async () => {
      this.writeTimer = null
      this.pendingWrite = false
      await this.syncNow()
    }, this.WRITE_DEBOUNCE_MS)
  }

  // ============ 状态查询 ============

  /**
   * 获取当前同步状态
   */
  getState(): SyncState {
    return { ...this.state }
  }

  /**
   * 监听同步状态变化
   */
  onStateChange(callback: (state: SyncState) => void): () => void {
    this.stateListeners.add(callback)
    return () => this.stateListeners.delete(callback)
  }

  /**
   * 是否已初始化
   */
  get initialized(): boolean {
    return this._initialized
  }

  // ============ 销毁 ============

  /**
   * 停止同步，清理资源
   */
  destroy(): void {
    if (this.unwatch) {
      this.unwatch()
      this.unwatch = null
    }
    this.stopAutoSync()
    if (this.writeTimer !== null) {
      window.clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    if (this.provider) {
      this.provider.destroy()
      this.provider = null
    }
    this.config.enabled = false
    this._initialized = false
  }

  // ============ 私有方法 ============

  /**
   * AI 会话线程同步：独立云文件 ai-threads.json，线程级 LWW + tombstone。
   * 失败只记日志并跳过，不影响 todo 同步，也不得用本地覆盖云端。
   */
  private async syncAiThreads(): Promise<void> {
    if (!this.provider) return
    const dataAccess = getDataAccess()
    const localAll = dataAccess.getAiThreads() // 含 tombstone

    let cloudThreads: AiThread[] = []
    let cloudRaw: string | null = null
    try {
      const data = await this.provider.read(this.AI_THREADS_FILE)
      if (data) {
        cloudRaw = new TextDecoder().decode(data)
        const parsed = JSON.parse(cloudRaw)
        cloudThreads = Array.isArray(parsed?.threads) ? parsed.threads : []
      }
    } catch (err) {
      console.warn('[SyncEngine] ai-threads 云端读取失败，跳过本次线程同步（防止覆盖云端）:', err)
      return
    }

    // 线程级 LWW：updatedAt 更晚者胜，各自独有的都保留（含 tombstone）
    const merged = mergeTodosByUpdatedAt(localAll, cloudThreads)
    if (!sameAiThreads(merged, localAll)) {
      dataAccess.replaceAllAiThreads(merged)
    }

    // tombstone 瘦身：已删除线程不再携带消息体，控制云端文件大小
    const payload = merged.map(t => (t.deleted ? { ...t, messagesJson: '[]' } : t))
    const nextJson = JSON.stringify({ version: 1, threads: payload })
    const nextBytes = new TextEncoder().encode(nextJson)
    const cloudBytes = cloudRaw ? new TextEncoder().encode(cloudRaw) : null
    if (!cloudBytes || !sameBytes(nextBytes, cloudBytes)) {
      await this.provider.write(this.AI_THREADS_FILE, nextBytes)
    }
  }

  private async initialSync(): Promise<void> {
    if (!this.provider) return

    try {
      const dataAccess = getDataAccess()
      const localAll = dataAccess.getAllTodos()

      let cloudTodos: Todo[] = []
      let cloudBytes: number | null = null
      const cloudData = await this.provider.read(this.CLOUD_FILE)
      if (cloudData) {
        cloudBytes = cloudData.length
        const cloudDoc = loadDoc(cloudData)
        const snap = getDocSnapshot(cloudDoc)
        cloudTodos = Object.values(snap.todos) as Todo[]
        console.log('[SyncEngine] 首次同步：云端读取成功，任务数:', cloudTodos.length, '字节:', cloudBytes)
      } else {
        console.log('[SyncEngine] 首次同步：云端无文件，将上传本地数据')
      }

      // 与云端做 LWW 合并后写回本地（含 tombstone，删除可传播）。
      // 数据无变化时跳过 replaceAll，避免全量 DELETE+INSERT 改变 SQLite 文件布局
      // 导致后续每次 syncNow 的上传字节不同，触发 self-watch 同步死循环。
      const mergedAll = mergeTodosByUpdatedAt(localAll, cloudTodos)
      if (!sameTodos(mergedAll, localAll)) {
        dataAccess.replaceAll(mergedAll)
        await dataAccess.save()
      }
      // AI 会话线程：首次拉取/合并（失败不影响任务数据）
      await this.syncAiThreads()
      this.state.lastSyncDetail = {
        time: new Date().toISOString(),
        cloudBytes,
        cloudTodos: cloudTodos.length,
        localTodos: localAll.length,
        mergedTodos: mergedAll.length,
      }
      console.log('[SyncEngine] Initial sync completed, todos:', mergedAll.filter(t => !t.deleted).length)
    } catch (err) {
      // 关键：初始同步失败必须让用户可见（之前吞错误导致“同步正常却没数据”的假象）。
      // 不覆盖本地已有数据。
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[SyncEngine] 初始同步失败（不覆盖本地数据）:', err)
      this.state.status = 'error'
      this.state.lastError = `初始同步失败：${msg}`
      this.state.lastSyncDetail = {
        time: new Date().toISOString(),
        stage: 'initial-read',
        error: this.state.lastError,
      }
      this.notifyState()
    }
  }

  private startWatching(): void {
    if (!this.provider) return

    this.unwatch = this.provider.watch(this.CLOUD_FILE, async (event) => {
      if (event === 'change') {
        console.log('[SyncEngine] Cloud file changed, syncing...')
        await this.syncNow()
      }
    })
  }

  private startAutoSync(): void {
    if (this.syncTimer !== null) return

    this.syncTimer = window.setInterval(async () => {
      if (this.config.enabled && this.state.isOnline) {
        await this.syncNow()
      }
    }, this.config.syncIntervalMs)

    console.log('[SyncEngine] Auto sync started every', this.config.syncIntervalMs, 'ms')
  }

  private stopAutoSync(): void {
    if (this.syncTimer !== null) {
      window.clearInterval(this.syncTimer)
      this.syncTimer = null
    }
  }

  private notifyState(): void {
    this.stateListeners.forEach(cb => cb(this.state))
  }
}

// ============ 多端合并工具 ============

/**
 * 判断两组 todos 内容是否一致（忽略顺序，按 id 排序后比较）。
 * 用于同步时跳过无变化的 replaceAll / upload，避免 self-watch 死循环。
 */
function sameTodos(a: Todo[], b: Todo[]): boolean {
  if (a.length !== b.length) return false
  const sig = (list: Todo[]) =>
    list.map(t => [t.id, JSON.stringify(t)] as const)
      .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
      .map(([, s]) => s)
      .join('\u0001')
  return sig(a) === sig(b)
}

/** 判断两个字节数组内容是否一致 */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** 判断两组会话线程内容是否一致（忽略顺序，按 id 排序后比较） */
function sameAiThreads(a: AiThread[], b: AiThread[]): boolean {
  if (a.length !== b.length) return false
  const sig = (list: AiThread[]) =>
    list.map(t => [t.id, JSON.stringify(t)] as const)
      .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
      .map(([, s]) => s)
      .join('\u0001')
  return sig(a) === sig(b)
}

/**
 * LWW（Last-Write-Wins，后写覆盖）合并：
 * - 只在一端存在的任务：直接保留（合并）
 * - 两端都存在的同一任务：updated_at 更晚者胜（后写覆盖）
 *
 * ISO 时间字符串可直接按字典序比较。
 */
function mergeTodosByUpdatedAt<T extends { id: string; updatedAt?: string }>(
  local: T[],
  cloud: T[],
): T[] {
  const byId = new Map<string, T>()
  for (const t of local) byId.set(t.id, t)
  for (const t of cloud) {
    const existing = byId.get(t.id)
    if (!existing) {
      byId.set(t.id, t)
    } else if ((t.updatedAt || '') > (existing.updatedAt || '')) {
      byId.set(t.id, t)
    }
  }
  return Array.from(byId.values())
}

// ============ 单例 ============

let syncEngineInstance: SyncEngine | null = null

export function getSyncEngine(config?: Partial<SyncConfig>): SyncEngine {
  if (!syncEngineInstance) {
    syncEngineInstance = new SyncEngine(config)
  }
  return syncEngineInstance
}

export function resetSyncEngine(): void {
  if (syncEngineInstance) {
    syncEngineInstance.destroy()
    syncEngineInstance = null
  }
}
