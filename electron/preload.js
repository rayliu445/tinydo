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
})
