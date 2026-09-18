const { contextBridge, ipcRenderer } = require('electron')

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // ============ 基础 CRUD（向后兼容） ============
  getTodos: () => ipcRenderer.invoke('get-todos'),
  addTodo: (todo) => ipcRenderer.invoke('add-todo', todo),
  removeTodo: (id) => ipcRenderer.invoke('remove-todo', id),
  toggleTodo: (id) => ipcRenderer.invoke('toggle-todo', id),
  updateTodo: (id, updates) => ipcRenderer.invoke('update-todo', id, updates),
  bulkAddTodos: (items) => ipcRenderer.invoke('bulk-add-todos', items),

  // ============ CRDT 数据同步 ============
  exportCRDTFile: (data) => ipcRenderer.invoke('export-crdt-file', data),
  importCRDTFile: () => ipcRenderer.invoke('import-crdt-file'),
  exportJSON: (jsonData) => ipcRenderer.invoke('export-json', jsonData),

  // ============ 数据目录 ============
  getDataPath: () => ipcRenderer.invoke('get-data-path'),

  // ============ iCloud Drive 同步 ============
  getICloudPath: () => ipcRenderer.invoke('get-icloud-path'),
  readICloudFile: (relativePath) => ipcRenderer.invoke('read-icloud-file', relativePath),
  writeICloudFile: (relativePath, data) => ipcRenderer.invoke('write-icloud-file', relativePath, data),

  // ============ 软件更新 ============
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
  downloadAndInstall: (url) => ipcRenderer.invoke('download-and-install', url),
  onUpdateProgress: (cb) => ipcRenderer.on('update-progress', (_e, p) => cb(p)),

  // 小柴朗读：Edge TTS 合成（主进程带特征头直连，返回 MP3 base64）
  ttsEdgeSynthesize: (payload) => ipcRenderer.invoke('tts-edge-synthesize', payload),

  // ============ 外部助手（DSH / CLI）本地桥接 ============
  // 主进程收到 HTTP 请求 → 这里转给渲染层真实数据层执行 → 回结果
  onLocalApiRequest: (cb) => {
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on('local-api:request', handler)
    return () => ipcRenderer.removeListener('local-api:request', handler)
  },
  replyLocalApi: (id, payload) => ipcRenderer.send('local-api:reply', id, payload),
  localApiSetEnabled: (enabled) => ipcRenderer.invoke('local-api:set-enabled', enabled),
  localApiInfo: () => ipcRenderer.invoke('local-api:info'),
  localApiAudit: (limit) => ipcRenderer.invoke('local-api:audit', limit),
  localApiRevokeToken: () => ipcRenderer.invoke('local-api:revoke-token'),
})
