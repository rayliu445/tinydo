const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')
const https = require('https')
const crypto = require('crypto')
const { execSync } = require('child_process')
const { setupLocalApi, cleanupLocalApi } = require('./local-api')

// 测试 / CI：允许用环境变量隔离用户数据目录，避免动到真实数据
if (process.env.TINYDO_USER_DATA) {
  app.setPath('userData', process.env.TINYDO_USER_DATA)
}

// 允许 file:// 协议加载 ES Module（解决 type="module" + file:// 的 CORS 限制）
app.commandLine.appendSwitch('--allow-file-access-from-files')

// 读取外部配置文件
const configPath = path.join(app.getAppPath(), 'config.json')
let appConfig = {
  enableLogging: true,
  logLevel: 'INFO',
  userDataPath: '~/Library/Application Support/tinydo',
}

if (fs.existsSync(configPath)) {
  try {
    const configContent = fs.readFileSync(configPath, 'utf-8')
    appConfig = { ...appConfig, ...JSON.parse(configContent) }
  } catch (error) {
    console.warn('Could not read config file, using defaults:', error.message)
  }
}

// 日志配置
const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
}

// 使用配置中的日志级别
const currentLogLevel = appConfig.logLevel || 'INFO'
const logLevelNum = LOG_LEVELS[currentLogLevel] ?? LOG_LEVELS.INFO

const logDir = path.join(app.getPath('userData'), 'logs')
const logFilePath = path.join(
  logDir,
  `app-${new Date().toISOString().slice(0, 10)}.log`,
)

// 确保日志目录存在
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true })
}

function log(level, message) {
  const levelNum = LOG_LEVELS[level] || LOG_LEVELS.INFO

  // 只有当启用了日志且日志级别高于或等于当前设置的日志级别时才记录
  if (appConfig.enableLogging && levelNum <= logLevelNum) {
    const timestamp = new Date().toISOString()
    const logMessage = `[${timestamp}] [${level}] ${message}\n`
    console.log(logMessage.trim())
    fs.appendFileSync(logFilePath, logMessage)
  }
}

function debug(message) {
  log('DEBUG', message)
}

function info(message) {
  log('INFO', message)
}

function warn(message) {
  log('WARN', message)
}

function error(message) {
  log('ERROR', message)
}

// 数据存储目录 (用户可见)
const DATA_DIR = path.join(app.getPath('userData'), 'data')
const dbPath = path.join(DATA_DIR, 'db.json')
const CRDT_PATH = path.join(DATA_DIR, 'todo.crdt')
const JSON_EXPORT_PATH = path.join(DATA_DIR, 'todo-data.json')

// 确保数据目录存在
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    info(`Created data directory: ${DATA_DIR}`)
  }
}

// 确保数据目录和文件存在
function ensureDbExists() {
  ensureDataDir()
  if (!fs.existsSync(dbPath)) {
    info('Database does not exist, creating new one')
    fs.writeFileSync(dbPath, JSON.stringify({ todos: [] }))
  }
}

// 读取数据
function readDb() {
  try {
    ensureDbExists()
    const data = fs.readFileSync(dbPath, 'utf-8')
    const parsedData = JSON.parse(data)
    debug(`Successfully read ${parsedData.todos.length} todos from database`)
    return parsedData
  } catch (error) {
    error(`Error reading database: ${error.message}`)
    return { todos: [] }
  }
}

// 写入数据
function writeDb(data) {
  try {
    ensureDataDir()
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2))
    // 同时写入用户可见的 JSON 文件
    const userFriendly = {
      version: 1,
      exportedAt: new Date().toISOString(),
      todos: data.todos || [],
    }
    fs.writeFileSync(JSON_EXPORT_PATH, JSON.stringify(userFriendly, null, 2))
    debug(`Successfully wrote ${data.todos.length} todos to database`)
  } catch (error) {
    error(`Error writing to database: ${error.message}`)
  }
}

let mainWindow
function createWindow(options = {}) {
  const { hidden = false } = options
  info(`Creating browser window${hidden ? ' (hidden)' : ''}`)

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: !hidden,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: true,
      // 允许渲染进程跨域调用七牛云 API（rs.qiniu.com / up.qiniup.com 未返回 CORS 头）
      webSecurity: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  // 根据环境加载不同内容
  if (app.isPackaged) {
    const indexPath = path.join(app.getAppPath(), 'dist/index.html')
    info('Loading packaged app from: ' + indexPath)
    // 使用 file:// URL 加载以确保 asar 内的相对路径正确解析
    mainWindow.loadURL(`file://${indexPath}`)
  } else {
    info('Loading from development server: http://localhost:3000')
    mainWindow.loadURL('http://localhost:3000')
  }

  // 检查页面加载错误
  mainWindow.webContents.on(
    'did-fail-load',
    (event, errorCode, errorDescription, validatedURL) => {
      error(
        `Failed to load: ${errorCode} - ${errorDescription} at ${validatedURL}`,
      )
    },
  )

  // 监听控制台错误
  mainWindow.webContents.on(
    'console-message',
    (event, level, message, line, sourceId) => {
      const levels = ['verbose', 'info', 'warning', 'error']
      info(`Console [${levels[level]||level}]: ${message}`)
      if (level >= 2) debug(`Console detail: at ${sourceId}:${line}`)
    },
  )

  // 监听渲染进程未捕获错误
  mainWindow.webContents.on('preload-error', (event, preloadPath, error) => {
    error(`Preload error: ${error.message} at ${preloadPath}`)
  })

  mainWindow.webContents.on('crashed', (sender, killed) => {
    error(`Renderer process crashed: killed=${killed}`)
  })

  // 注入全局错误捕获
  mainWindow.webContents.on('dom-ready', () => {
    info('DOM is ready')
    mainWindow.webContents.executeJavaScript(`
      window.__capturedErrors = [];
      window.onerror = function(msg, url, line, col, err) {
        window.__capturedErrors.push({msg, url, line, col, stack: err?.stack});
        console.error('GLOBAL_ERROR:', msg, 'at', url, line, col);
        return true;
      };
      window.addEventListener('unhandledrejection', function(e) {
        window.__capturedErrors.push({reason: e.reason?.message || String(e.reason), stack: e.reason?.stack});
        console.error('UNHANDLED_REJECTION:', e.reason);
      });
    `).catch(e => {
      error('Failed to inject error handler: ' + e.message)
    })
  })

  // 仅在非打包环境（本地开发/测试）时打开 DevTools（隐藏窗口不弹）
  if (!app.isPackaged && !hidden) {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
    info('DevTools opened for local testing')
  }

  // 延迟检查页面 DOM 内容
  setTimeout(() => {
    // 检查 DOM 内容
    mainWindow.webContents.executeJavaScript('document.getElementById("app").innerHTML.length').then(len => {
      info('APP_CONTENT_LENGTH: ' + len)
      // 如果内容为空，检查是否有捕获的错误
      if (len === 0) {
        mainWindow.webContents.executeJavaScript('window.__capturedErrors || []').then(errors => {
          if (errors && errors.length > 0) {
            errors.forEach((e, i) => {
              info(`CAPTURED_ERROR[${i}]: ${JSON.stringify(e)}`)
            })
          } else {
            info('NO_CAPTURED_ERRORS')
          }
        }).catch(() => {})
      }
    }).catch(e => {
      info('APP_CHECK_ERR: ' + e.message)
    })

    // 检查 HTML 是否包含必要的元素
    mainWindow.webContents.executeJavaScript('document.querySelector("script") ? document.querySelector("script").src : "NO_SCRIPT"').then(src => {
      info('SCRIPT_SRC: ' + src)
    }).catch(e => {
      info('SCRIPT_CHECK_ERR: ' + e.message)
    })
  }, 10000)

  mainWindow.on('closed', () => {
    info('Window closed')
    mainWindow = null
  })

  return mainWindow
}

/**
 * 外部助手（本地 API）需要渲染层执行数据操作：
 * 窗口不在时（macOS 关窗但 App 仍存活）按需创建一个隐藏窗口并等它加载完。
 */
function ensureRendererWindow() {
  return new Promise((resolve, reject) => {
    if (mainWindow && !mainWindow.isDestroyed()) return resolve(mainWindow)
    createWindow({ hidden: true })
    const win = mainWindow
    const timer = setTimeout(() => reject(new Error('渲染层窗口加载超时')), 20000)
    win.webContents.once('did-finish-load', () => {
      clearTimeout(timer)
      resolve(win)
    })
  })
}

// IPC handlers for todo operations
ipcMain.handle('get-todos', async () => {
  debug('Handling get-todos request')
  const db = readDb()
  return db.todos
})

// 获取数据目录路径（用户可见的文件夹）
ipcMain.handle('get-data-path', async () => {
  ensureDataDir()
  return {
    dir: DATA_DIR,
    dbFile: dbPath,
    jsonExport: JSON_EXPORT_PATH,
    crdtFile: CRDT_PATH,
  }
})

ipcMain.handle('add-todo', async (event, todo) => {
  debug(`Handling add-todo request: ${JSON.stringify(todo)}`)
  const db = readDb()
  const newTodo = {
    id: Date.now().toString(),
    title: todo.title,
    completed: todo.completed ?? false,
    priority: todo.priority ?? 0,
    dueDate: todo.dueDate || null,
    startDate: todo.startDate || null,
    content: todo.content || null,
    tags: todo.tags || [],
    list: todo.list || null,
    isAllDay: todo.isAllDay ?? false,
    completedTime: todo.completedTime || null,
    createdAt: todo.createdAt || new Date().toISOString(),
  }

  db.todos.push(newTodo)
  writeDb(db)
  info(`Added new todo with id: ${newTodo.id}`)
  return newTodo
})

ipcMain.handle('remove-todo', async (event, id) => {
  debug(`Handling remove-todo request for id: ${id}`)
  const db = readDb()
  const initialCount = db.todos.length
  db.todos = db.todos.filter((todo) => todo.id !== id)
  writeDb(db)
  info(
    `Removed todo with id: ${id}. Count went from ${initialCount} to ${db.todos.length}`,
  )
  return { success: true }
})

ipcMain.handle('toggle-todo', async (event, id) => {
  debug(`Handling toggle-todo request for id: ${id}`)
  const db = readDb()
  const todoIndex = db.todos.findIndex((todo) => todo.id === id)

  if (todoIndex !== -1) {
    db.todos[todoIndex].completed = !db.todos[todoIndex].completed
    writeDb(db)
    info(
      `Toggled todo with id: ${id}. New status: ${db.todos[todoIndex].completed}`,
    )
    return db.todos[todoIndex]
  }

  warn(`Todo with id ${id} not found for toggle`)
  return null
})

ipcMain.handle('update-todo', async (event, id, updates) => {
  debug(
    `Handling update-todo request for id: ${id} with updates: ${JSON.stringify(
      updates,
    )}`,
  )
  const db = readDb()
  const todoIndex = db.todos.findIndex((todo) => todo.id === id)

  if (todoIndex !== -1) {
    // 如果标记完成，记录完成时间
    if (updates.completed === true && !db.todos[todoIndex].completedTime) {
      updates.completedTime = new Date().toISOString()
    }
    db.todos[todoIndex] = { ...db.todos[todoIndex], ...updates }
    writeDb(db)
    info(`Updated todo with id: ${id}`)
    return db.todos[todoIndex]
  }

  warn(`Todo with id ${id} not found for update`)
  return null
})

// 批量添加待办事项
ipcMain.handle('bulk-add-todos', async (event, items) => {
  debug(`Handling bulk-add-todos request with ${items.length} items`)
  const db = readDb()
  let successCount = 0

  for (const todo of items) {
    try {
      const newTodo = {
        id: Date.now().toString() + '-' + Math.random().toString(36).slice(2, 8),
        title: todo.title,
        completed: todo.completed ?? false,
        priority: todo.priority ?? 0,
        dueDate: todo.dueDate || null,
        startDate: todo.startDate || null,
        content: todo.content || null,
        tags: todo.tags || [],
        list: todo.list || null,
        isAllDay: todo.isAllDay ?? false,
        completedTime: todo.completedTime || null,
        createdAt: todo.createdAt || new Date().toISOString(),
      }
      db.todos.push(newTodo)
      successCount++
    } catch (err) {
      error(`Error adding todo in bulk: ${err.message}`)
    }
  }

  writeDb(db)
  info(`Bulk added ${successCount}/${items.length} todos`)
  return { success: successCount, total: items.length }
})

// ============ CRDT 数据同步相关 IPC ============

/**
 * 导出 CRDT 数据文件（让用户选择保存位置）
 * 用于备份或手动传输到其他设备
 */
ipcMain.handle('export-crdt-file', async (event, data) => {
  debug('Handling export-crdt-file request')
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出数据备份',
      defaultPath: `todo-backup-${new Date().toISOString().slice(0, 10)}.automerge`,
      filters: [
        { name: 'Automerge 数据', extensions: ['automerge'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })

    if (!result.canceled && result.filePath) {
      // data 是 base64 编码的 Uint8Array
      const buffer = Buffer.from(data, 'base64')
      fs.writeFileSync(result.filePath, buffer)
      info(`Exported CRDT data to ${result.filePath}`)
      return { success: true, filePath: result.filePath }
    }
    return { success: false, canceled: true }
  } catch (err) {
    error(`Error exporting CRDT file: ${err.message}`)
    return { success: false, error: err.message }
  }
})

/**
 * 导入 CRDT 数据文件（让用户选择要导入的文件）
 */
ipcMain.handle('import-crdt-file', async () => {
  debug('Handling import-crdt-file request')
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入数据备份',
      filters: [
        { name: 'Automerge 数据', extensions: ['automerge'] },
        { name: '所有文件', extensions: ['*'] },
      ],
      properties: ['openFile'],
    })

    if (!result.canceled && result.filePaths.length > 0) {
      const filePath = result.filePaths[0]
      const buffer = fs.readFileSync(filePath)
      info(`Importing CRDT data from ${filePath}`)
      return {
        success: true,
        data: buffer.toString('base64'),
        filePath,
      }
    }
    return { success: false, canceled: true }
  } catch (err) {
    error(`Error importing CRDT file: ${err.message}`)
    return { success: false, error: err.message }
  }
})

/**
 * 导出为 JSON（人类可读格式，用于查看/备份）
 */
ipcMain.handle('export-json', async (event, jsonData) => {
  debug('Handling export-json request')
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出 JSON 备份',
      defaultPath: `todos-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [
        { name: 'JSON 文件', extensions: ['json'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })

    if (!result.canceled && result.filePath) {
      fs.writeFileSync(result.filePath, jsonData, 'utf-8')
      info(`Exported JSON to ${result.filePath}`)
      return { success: true, filePath: result.filePath }
    }
    return { success: false, canceled: true }
  } catch (err) {
    error(`Error exporting JSON: ${err.message}`)
    return { success: false, error: err.message }
  }
})

/**
 * 获取 iCloud Drive 路径（macOS）
 */
ipcMain.handle('get-icloud-path', async () => {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const icloudPath = path.join(
    home,
    'Library/Mobile Documents/com~apple~CloudDocs',
  )
  const exists = fs.existsSync(icloudPath)
  return { path: icloudPath, exists }
})

/**
 * 读取/写入 iCloud Drive 中的同步文件
 */
ipcMain.handle('read-icloud-file', async (event, relativePath) => {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const fullPath = path.join(
    home,
    'Library/Mobile Documents/com~apple~CloudDocs',
    relativePath,
  )
  try {
    if (!fs.existsSync(fullPath)) return { success: true, data: null }
    const buffer = fs.readFileSync(fullPath)
    return { success: true, data: buffer.toString('base64') }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('write-icloud-file', async (event, relativePath, base64Data) => {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const fullPath = path.join(
    home,
    'Library/Mobile Documents/com~apple~CloudDocs',
    relativePath,
  )
  try {
    const dir = path.dirname(fullPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    const buffer = Buffer.from(base64Data, 'base64')
    fs.writeFileSync(fullPath, buffer)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ============ 软件更新 ============
const UPDATE_REPO = 'rayliu445/tinydo'

/** 版本号比较：a > b 返回 >0 */
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0
    const nb = pb[i] || 0
    if (na !== nb) return na - nb
  }
  return 0
}

/** HTTPS GET 返回文本 */
function httpsGetText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'TinyDo' } }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve(body))
    }).on('error', reject)
  })
}

/** 下载文件（带进度回调 0-1，手动跟随重定向 + 流式下载）。
 *  用 Node 原生 http/https 而非 fetch/undici：undici 下载大文件存在间歇性 bug
 *  （assert(!this.paused) / 数据静默丢失，导致下载的 DMG 大小正确但内容损坏、
 *  hdiutil 挂载失败），Node 原生流式下载最稳定。
 *  同时手动跟随 GitHub release 的 302 重定向（跳到 release-assets 签名 URL）。 */
function downloadFile(url, dest, onProgress, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    const doRequest = (currentUrl) => {
      const lib = currentUrl.startsWith('https:') ? https : http
      lib.get(currentUrl, { headers: { 'User-Agent': 'TinyDo', 'Accept-Encoding': 'identity' } }, (res) => {
        // 302 重定向：手动跟随
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          if (redirectsLeft <= 0) {
            file.destroy()
            reject(new Error('重定向次数过多'))
            return
          }
          const next = new URL(res.headers.location, currentUrl).toString()
          doRequest(next)
          return
        }
        if (res.statusCode !== 200) {
          file.destroy()
          reject(new Error('下载失败 HTTP ' + res.statusCode))
          return
        }
        const total = parseInt(res.headers['content-length'] || '0', 10)
        let received = 0
        res.on('data', (chunk) => {
          received += chunk.length
          if (onProgress && total) onProgress(received / total)
        })
        res.pipe(file)
        file.on('finish', () => { if (onProgress) onProgress(1); resolve(dest) })
        file.on('error', (err) => { try { fs.unlinkSync(dest) } catch {} reject(err) })
        res.on('error', (err) => { try { fs.unlinkSync(dest) } catch {} reject(err) })
      }).on('error', (err) => { try { fs.unlinkSync(dest) } catch {} reject(err) })
    }
    doRequest(url)
  })
}

/** 检查更新：读取仓库最新版本号。
 *  用 raw.githubusercontent.com（CDN，无 GitHub API 限流），
 *  避免未认证 API 60次/小时限流（403 时拿不到版本号会误判"已是最新"）。 */
ipcMain.handle('check-for-update', async () => {
  const currentVersion = app.getVersion()
  try {
    // 默认读 GitHub 仓库 package.json；可通过环境变量覆盖（本地端到端测试用）
    const checkUrl = process.env.TINYDO_UPDATE_CHECK_URL || `https://raw.githubusercontent.com/${UPDATE_REPO}/main/package.json`
    const pkgText = await httpsGetText(checkUrl)
    const pkg = JSON.parse(pkgText)
    const latestVersion = String(pkg.version || '').replace(/^v/, '')
    const base = process.env.TINYDO_UPDATE_DMG_BASE || `https://github.com/${UPDATE_REPO}/releases/download`
    const downloadUrl = `${base}/v${latestVersion}/TinyDo-mac-arm64.dmg`
    return {
      currentVersion,
      latestVersion,
      hasUpdate: !!(latestVersion && compareVersions(latestVersion, currentVersion) > 0),
      downloadUrl,
    }
  } catch (err) {
    info('[Update] check failed: ' + err.message)
    return { error: err.message }
  }
})

/** 校验 DMG 完整性（数据损坏时 hdiutil verify 会失败并抛错） */
function verifyDmg(dmgPath) {
  execSync(`hdiutil verify "${dmgPath}"`, { stdio: ['ignore', 'pipe', 'pipe'] })
}

/** 下载最新版并覆盖安装（保留用户数据与配置，位于 ~/Library/Application Support/tinydo）。
 *  网络传输可能导致 DMG 数据损坏（大小对但 CRC 校验失败），
 *  因此下载后先用 hdiutil verify 校验完整性，损坏则自动重试下载。 */
ipcMain.handle('download-and-install', async (event, downloadUrl) => {
  if (!downloadUrl) return { success: false, error: '缺少下载地址' }
  const tmpDmg = path.join(os.tmpdir(), `tinydo-update-${Date.now()}.dmg`)
  const mount = path.join(os.tmpdir(), `tinydo-mount-${Date.now()}`)
  const MAX_ATTEMPTS = 3
  try {
    // 下载 + 校验，损坏自动重试（最多 3 次）
    let ok = false
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        info(`[Update] downloading (attempt ${attempt}/${MAX_ATTEMPTS}): ${downloadUrl}`)
        await downloadFile(downloadUrl, tmpDmg, (p) => {
          event.sender.send('update-progress', Math.round(p * 100))
        })
        verifyDmg(tmpDmg) // 校验 DMG 完整性，损坏会抛错
        ok = true
        break
      } catch (err) {
        info(`[Update] download/verify failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${err.message}`)
        try { fs.unlinkSync(tmpDmg) } catch {}
        if (attempt >= MAX_ATTEMPTS) {
          throw new Error(`下载文件损坏，已自动重试 ${MAX_ATTEMPTS} 次仍失败，请稍后再试`)
        }
        // 重试前重置进度提示
        event.sender.send('update-progress', 0)
      }
    }
    if (!ok) return { success: false, error: '下载失败' }

    fs.mkdirSync(mount, { recursive: true })
    execSync(`hdiutil attach "${tmpDmg}" -mountpoint "${mount}" -nobrowse -quiet`)
    const srcApp = path.join(mount, 'TinyDo.app')
    if (!fs.existsSync(srcApp)) throw new Error('DMG 内未找到 TinyDo.app')
    const target = '/Applications/TinyDo.app'

    // 重命名替换（而非删除再复制）：应用运行时删除自身 bundle 会触发
    // ENOTDIR（rmSync 递归删除运行中的 app.asar 时文件系统竞争）。
    // 先把旧 app 原子重命名走（运行中的目录允许 rename，进程继续用旧 inode），
    // 再把新版复制到位，最后清理备份；复制失败则回滚恢复旧 app。
    // 复制必须用 ditto：fs.cpSync 会把 app 内相对 symlink（Electron Framework
    // 等）改写为绝对路径指向临时挂载点，卸载后 app 无法启动；ditto 保留原样。
    const staging = path.join(os.tmpdir(), `tinydo-staging-${Date.now()}`)
    const stagedApp = path.join(staging, 'TinyDo.app')
    fs.mkdirSync(staging, { recursive: true })
    execSync(`ditto "${srcApp}" "${stagedApp}"`) // 先复制到 staging，缩短替换窗口

    const backup = path.join(os.tmpdir(), `tinydo-old-${Date.now()}.app`)
    let replaced = false
    try {
      if (fs.existsSync(target)) fs.renameSync(target, backup)
      execSync(`ditto "${stagedApp}" "${target}"`)
      replaced = true
    } catch (err) {
      // 安装失败：回滚恢复旧 app
      try {
        if (!replaced && !fs.existsSync(target) && fs.existsSync(backup)) fs.renameSync(backup, target)
      } catch {}
      throw err
    }

    execSync(`xattr -cr "${target}"`)
    execSync(`hdiutil detach "${mount}" -quiet`)
    try { fs.unlinkSync(tmpDmg) } catch {}
    // 清理临时目录与备份（旧进程仍映射备份文件时删除可能失败，忽略即可，tmp 会自清）
    try { fs.rmSync(staging, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(backup, { recursive: true, force: true }) } catch {}
    info('[Update] installed new version')
    // 安装完成后短暂停留让界面展示完成状态，再自动重启应用生效。
    // 若不自动重启，运行中的旧进程仍是旧版本，用户手动替换又会被
    // Finder 以"应用正在使用中"拒绝，只能被迫删除旧应用后重装。
    event.sender.send('update-progress', 100)
    setTimeout(() => {
      info('[Update] relaunching app to apply new version')
      app.relaunch()
      app.quit()
    }, 2000)
    return { success: true }
  } catch (err) {
    info('[Update] install failed: ' + err.message)
    try { fs.unlinkSync(tmpDmg) } catch {}
    try { execSync(`hdiutil detach "${mount}" -quiet`) } catch {}
    return { success: false, error: err.message }
  }
})

app.whenReady().then(() => {
  info('App is ready')
  createWindow()

  // 外部助手（CLI / DSH 插件）本地桥接：只在 127.0.0.1 监听，
  // 是否真正开监听由渲染层按「设置 → 外部助手」开关同步过来。
  setupLocalApi({
    ipcMain,
    version: app.getVersion(),
    appPath: app.getAppPath(),
    info,
    warn,
    error,
    ensureWindow: ensureRendererWindow,
  })

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', function () {
  cleanupLocalApi()
})

app.on('window-all-closed', function () {
  info('All windows closed, quitting app')
  if (process.platform !== 'darwin') app.quit()
})

// 记录应用启动
info('Application started with log level: ' + currentLogLevel)
debug('Debug mode enabled')

// ============ 小柴朗读：Edge TTS 合成（主进程直连，自定义全套特征头） ============
// 浏览器 WS 无法自定义 Origin/UA 等头，直连微软会被风控 403；
// 主进程用 ws 库带完整特征头（与官方 edge-tts 库一致），桌面端稳定可用。

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const EDGE_WS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
const EDGE_GEC_VERSION = '1-143.0.3650.75'

function edgeGenSecMsGec() {
  let ticks = Math.floor(Date.now() / 1000) + 11644473600
  ticks -= ticks % 300
  return crypto.createHash('sha256').update(ticks + '0000000' + TRUSTED_CLIENT_TOKEN).digest('hex').toUpperCase()
}

function edgeXmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function edgeBuildSsml(voice, text, rate) {
  const pct = Math.round((Math.min(2, Math.max(0.5, rate)) - 1) * 100)
  const rateStr = (pct >= 0 ? '+' : '') + pct + '%'
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>` +
    `<voice name='${edgeXmlEscape(voice)}'><prosody rate='${rateStr}' pitch='+0Hz' volume='+0%'>${edgeXmlEscape(text)}</prosody></voice></speak>`
}

ipcMain.handle('tts-edge-synthesize', async (_event, payload) => {
  const { text, voice, rate } = payload || {}
  if (!text || !voice) throw new Error('参数缺失')
  const WebSocket = (await import('ws')).default
  const gec = edgeGenSecMsGec()
  const connectionId = crypto.randomBytes(16).toString('hex')
  const url = `${EDGE_WS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${EDGE_GEC_VERSION}&ConnectionId=${connectionId}`

  return new Promise((resolve, reject) => {
    const chunks = []
    let settled = false
    const done = (err, b64) => {
      if (settled) return
      settled = true
      try { ws.close() } catch (e) { /* ignore */ }
      clearTimeout(connectTimer)
      clearTimeout(streamTimer)
      if (err) reject(new Error(err))
      else resolve(b64)
    }
    const ws = new WebSocket(url, {
      headers: {
        'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      // permessage-deflate 关闭：微软对异常扩展组合敏感，官方客户端行为最稳
      perMessageDeflate: false,
    })
    const ts = new Date().toISOString()
    const connectTimer = setTimeout(() => done('Edge TTS 连接超时'), 10000)
    const streamTimer = setTimeout(() => done('Edge TTS 音频流超时'), 60000)

    ws.on('open', () => {
      ws.send(`X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`)
      const requestId = crypto.randomBytes(16).toString('hex')
      ws.send(`X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}\r\nPath:ssml\r\n\r\n${edgeBuildSsml(voice, text, rate || 1)}`)
    })
    ws.on('message', (data, isBinary) => {
      clearTimeout(connectTimer)
      clearTimeout(streamTimer)
      streamTimer.setTimeout = streamTimer.setTimeout // noop 保持引用
      if (isBinary) {
        const headerLen = data.readUInt16BE(0)
        if (data.length > headerLen + 2) chunks.push(data.slice(headerLen + 2))
      } else if (data.toString().includes('Path:turn.end')) {
        if (chunks.length === 0) done('Edge TTS 未返回音频（接口可能已变更）')
        else done(null, Buffer.concat(chunks).toString('base64'))
      }
    })
    ws.on('error', (err) => done('Edge TTS 连接失败：' + err.message))
    ws.on('close', () => { if (!settled) done('Edge TTS 连接被关闭') })
  })
})
