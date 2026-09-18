import { createApp, watch } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import { createPinia } from 'pinia'
import App from './App.vue'
import { routes } from './routes'
import { createDataAccess } from './services/data-access'
import { getSyncEngine } from './services/sync-engine'
import { handleLocalApiRequest, markLocalApiDataReady } from './services/local-api'
import { initTheme } from './stores/theme'
import './index.css'

// ============ 创建 Vue 应用（先挂载，不阻塞 UI） ============
const app = createApp(App)
const pinia = createPinia()

const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

app.use(pinia)
app.use(router)
app.mount('#app')

// 初始化主题
initTheme()

// ============ 外部助手（DSH / CLI）本地桥接 ============
// 主进程在 127.0.0.1 起 HTTP 服务，请求经 IPC 到这里 → services/local-api.ts → 真实数据层。
// 这一层只做「接活 → 交给 local-api → 回结果」，业务语义全部复用现有 store。
function setupExternalAgentBridge() {
  const api = (window as any).electronAPI
  if (!api?.onLocalApiRequest || !api?.replyLocalApi || !api?.localApiSetEnabled) {
    return // Web / 预览环境没有本地桥接
  }

  api.onLocalApiRequest(async (req: any) => {
    let res: any
    try {
      res = await handleLocalApiRequest(req)
    } catch (err) {
      res = {
        status: 500,
        body: { error: { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) } },
      }
    }
    try {
      // IPC 只能传结构化可克隆的数据：这里做一次纯数据化，避免 Vue 响应式代理导致回包失败
      api.replyLocalApi(req.id, JSON.parse(JSON.stringify(res)))
    } catch (err) {
      console.error('[LocalAPI] 回包失败:', err)
    }
  })

  // 开关状态同步给主进程：关闭时是真的停止监听端口（而不是只在应用层拦截）
  import('./stores/settings').then(({ useSettingsStore }) => {
    try {
      const settingsStore = useSettingsStore()
      const sync = (enabled: unknown) => api.localApiSetEnabled(enabled !== false)
      sync(settingsStore.settings.externalAgent?.enabled !== false)
      watch(() => settingsStore.settings.externalAgent?.enabled, (v) => sync(v !== false))
    } catch (err) {
      console.warn('[LocalAPI] 开关同步失败（不影响 App 使用）:', err)
    }
  })
}

setupExternalAgentBridge()

// ============ 异步初始化数据层（不阻塞渲染） ============
async function initializeDataLayer() {
  try {
    const dataAccess = createDataAccess()
    await dataAccess.initialize()
    console.log('[App] CRDT data layer initialized')

    // 通知 store 刷新数据
    const { useTodoStore } = await import('./stores/todo')
    const store = useTodoStore()
    store.fetchTodos()
    console.log('[App] Todos refreshed after data layer init')

    // 数据层就绪：放行外部助手（本地 API）等待中的请求
    markLocalApiDataReady()
  } catch (err) {
    console.error('[App] Data layer init failed (app still works):', err)
  }
}

// ============ 启动时重连云端同步 ============
// 之前只在用户手动点"连接"时才建立 provider，应用重启后同步引擎的
// provider 为 null，导致：不拉取云端数据、不监听云端变化、不自动同步。
// 这里根据已保存的设置，在启动时自动重建连接并完成首次拉取合并。
async function initializeSync() {
  try {
    const { useSettingsStore } = await import('./stores/settings')
    const settingsStore = useSettingsStore()
    const provider = settingsStore.settings.providers.find(p => p.enabled)
    if (
      provider &&
      provider.type === 'kodo' &&
      provider.config.bucket &&
      provider.config.accessKeyId &&
      provider.config.accessKeySecret
    ) {
      console.log('[App] 启动时恢复云端同步连接...')
      await settingsStore.connectProvider(provider)
      console.log('[App] 云端同步已恢复，首次拉取完成')
    }
  } catch (err) {
    console.warn('[App] 启动时同步重连失败（不影响本地使用）:', err)
  }
}

initializeDataLayer().finally(() => {
  initializeSync()
})
