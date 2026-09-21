# TinyDo - 发布说明

## v0.1.25（2026-09-21）—— 修复 Dock 图标比其它 App 大一圈

### 问题

macOS 上 Dock 里的图标明显比其它 App 大：其它图标随 Dock 变窄一起缩小，TinyDo 始终"大一号"。

### 根因

图标源文件（`resources/icon.svg`）自绘了圆角方形，但**只留了 20px 透明边距**，
图形本体占画布 **96.88%**。而 macOS 图标网格是：1024 画布上图形本体 **824px**（四周各 100px 留白）、
圆角半径 **185**。也就是说我们的图形比原生图标大 **19%**，Dock 整体缩小时这种体积差一直存在。

同机实测对比：VS Code 80.08%、Chrome 83.59%、TinyDo（修复前）96.88%。

### 修复

- `resources/icon.svg`：整体 `translate(83.252 83.252) scale(0.837398)` 落到 macOS 网格上——
  图形外框正好 824、圆角正好 185；描边矩形内缩半个描边宽，避免外沿多出几像素。
  重新光栅化后实测：**图形 824px / 边距 100px / 占比 80.47%**，与网格逐像素一致。
- `scripts/generate-ios-icon.sh`：iOS 图标必须全出血，因此生成时先裁掉 macOS 留白再缩放到 1024
  （否则 iOS 图标会多出白边）。属于同一处改动的必要配套。

> 若更新后 Dock 里仍是旧图标，是系统图标缓存：`killall Dock`，或把 App 从 Dock 移除再拖回来。

## v0.1.24（2026-09-21）—— 任务行复选框对齐修复

### 修复：无子任务的行，复选框比同层其他行左移 32px

折叠按钮原为条件渲染（`v-if="hasChildren(todo)"`），因此**没有子任务的行**少了
`w-5` 图标位（20px）与父容器的 `gap-3`（12px）——复选框整体左移 2rem，
一个列表里就出现了参差不齐（实测 244 vs 276）。

改为**始终保留等宽占位**：有子任务时渲染折叠按钮，无子任务时渲染同宽的空 `span`
（带 `aria-hidden`，不引入不可聚焦元素）。任务列表页与「已完成」页同步修正。

验证：用 CDP 读真实排版坐标——顶层 3 行（含 1 行带折叠图标）复选框均为 `x=276`；
子任务层 2 行均为 `x=315.85`；层级缩进（24px / 56px）保持不变。

## v0.1.23（2026-09-18）—— 外部助手扩展：排期 / 撤销 / 批量整理 / 总览 / 笔记

配套客户端：**tinydo-agent v0.1.1**（`pnpm add github:rayliu445/tinydo-agent#v0.1.1`）

### 新增接口（协议 `api 2`，`GET /health` 可查）

- `GET /v1/overview`：清单 / 标签总览（未完成、逾期、已完成、未分配计数 + 笔记数）
- `POST /v1/tasks/bulk-update`：批量改字段（≤50，一次刷新 + 一次同步调度，避免逐条刷全量）
- `POST /v1/tasks/restore`：按完整快照还原任务，**可命中已软删除的 tombstone**（撤销删除的关键）
- `GET/POST /v1/notes`、`PATCH/DELETE /v1/notes/:id`：笔记读写（归档 = 标记完成，与 App 语义一致；
  笔记可搜正文，且不出现在任务列表里）

### 新增：结构化撤销载荷

审计条目带上 `undo` 字段（`delete_tasks` / `restore_fields` / `restore_tasks` + 字段快照），
客户端据此实现"撤销刚才那次写入"：新增→删掉、修改/完成→写回旧值、删除→整体还原。
快照超过 200 条时标记 `truncated`，客户端会拒绝自动撤销而不是做一半。撤销本身也写审计，再撤一次即 redo。

### 配套客户端（tinydo-agent v0.1.1）新增 7 个工具

`tinydo_overview` / `tinydo_reschedule` / `tinydo_bulk_update` / `tinydo_undo` /
`tinydo_list_notes` / `tinydo_add_note` / `tinydo_update_note`（共 16 个），CLI 同步新增
`overview` / `reschedule` / `undo` / `bulk update` / `notes` / `note add|edit|rm`。
老 App（api 1）调用扩展工具时会得到"请升级 TinyDo"的明确提示，其余能力不受影响。

### 修复

- `electron/local-api.js` 纳入打包白名单（`build.files`）——漏掉会导致打包版主进程 `require` 失败。

## v0.1.22（2026-09-18）—— 外部助手：让 DSH / CLI 直接驱动 TinyDo

### 新增：外部助手（本地桥接接口 + tinydo CLI + DSH 原生工具）

- **本地接口**：桌面端在 `127.0.0.1` 开放带 token 的 HTTP 接口（token 每次启动轮换、仅回环地址监听），
  请求经渲染层真实数据层执行——**App 始终是唯一写入者**：界面实时刷新、云同步照常、级联语义与手点完全一致。
- **`tinydo` 命令行**：`list / get / add / edit / done / rm / bulk / stats / log / doctor`，
  支持 `--json` / `--dry-run`；App 没运行时会自动拉起（实测冷启动约 7.5s）。
- **DSH 原生工具**（9 个）：`tinydo_list_tasks` / `get_task` / `add_task` / `update_task` /
  `complete_task` / `delete_task` / `bulk_add_tasks` / `stats` / `recent_changes`；
  随包附降级技能——插件失效时 DSH 仍可用 CLI 驱动（工具面变化不会让人没法干活）。
- **安全与可见**：仅监听回环地址、Bearer token 可随时吊销；设置页新增「外部助手」面板
  （开关 / 端口与 token / 最近写入记录 / DSH 安装指引）；所有外部写入记录在 `~/.tinydo/audit.jsonl`。
- 视图过滤与层级排序抽成单一实现（`src/services/task-query.ts`），UI 与外部助手共用，避免规则漂移。

### 修复：打包白名单漏了新文件（会导致打包版启动失败）

`package.json` 的 `build.files` 是白名单，新增的 `electron/local-api.js` 未被列入——按原样打包，
主进程 `require('./local-api')` 会失败。已加入白名单，并实测打包产物：桥接正常监听、数据层加载正常。

### 开发者

- 自检：`npm run selftest`（接口端到端 36 项）、`npm run selftest:plugin`（DSH 插件 28 项，
  其中会用 DSH 自带的 schema 校验器校验工具契约）、`npm run selftest:bridge`（桥接单元 13 项）。
- 设计/决策文档：`docs/agent-bridge-design.md`、`docs/adr/0004-external-agent-bridge.md`。

## v0.1.21（2026-09-16）—— 清单排序方向切换 + 小柴改成「直接执行」

### 新增：清单排序方向切换（新的在前 / 旧的在前）

- 任务列表（收集箱 / 今天 / 最近7天 / 搜索）与「已完成」页右上角新增排序方向按钮，一键切换。
- 规则在**每一层**生效：顶层任务、子任务、孙任务全部按创建时间同向排序，
  父任务始终在子任务上方；`倒序 = 新的在前`（默认，与升级前观感一致），`正序 = 旧的在前`。
- 任务详情面板的子任务列表跟随同一方向；方向持久化在本地设置（`ui.sortOrder`）。
- 顺带修复：同一毫秒批量创建（例如小柴一次拆出多条子任务）时顺序不确定的问题，
  现在以 `id` 兜底排序，顺序稳定可预期。

### 改动：小柴不再要确认，收到操作直接执行

- AI 回复里的 actions 现在**立即写入清单**：卡片显示「已调整清单（N 条）/ ✓ 已写入清单」，
  会话里再留一条回执，不再出现「应用到清单 / 忽略」的二次确认与中断。
- 提示词同步调整：正文只说做了什么，禁止「待确认 / 确认后才会写入 / 需要我帮你加上吗」
  这类话术，也不要停下来等回复；删除类操作只在用户明确指定目标时才输出。
- 历史会话里遗留的待确认建议卡片仍保留手动「应用」入口，不会变成无法处理的数据。

---

## v0.1.13（2026-08-06）—— ★★★ iOS 同步问题的最终修复

### 修复：WASM 文件从未打包进 iOS app（真正完整根因）

- **根因（完整链条）**：`public/node_modules/sql.js/`（含 sql-wasm.wasm）被
  `.gitignore` 的 `node_modules` 规则忽略，**从未提交到 git** → CI（GitHub
  Actions）构建的 app 里**根本没有 WASM 文件** → iOS 上加载 `/node_modules/
  sql.js/dist/sql-wasm.wasm` 返回 **404** → sql.js 初始化失败 → 本地数据库
  永远是 null（"Database not initialized"）→ **云端 1204 个任务下载成功也
  写不进本地 → 任务永远显示不出来**。
- **修复（两步）**：
  1. WASM 文件复制到 **`public/sql-wasm.wasm`**（正式入库，随构建进 app）
  2. `sqlite-db.ts` 的 `locateFile` 改为相对路径 **`./sql-wasm.wasm`**，
     并改用 **`wasmBinary`** 方式加载（fetch ArrayBuffer → initSqlJs，
     不依赖 MIME 类型），跨 Web / Electron / iOS 全部可用
- **验证**：构建产物 `dist/sql-wasm.wasm` 存在；浏览器中 wasm 可访问（200）
  + 加载真实 `sqlite-db.ts` 初始化成功（ready=true）。
- 此前的 MIME 判断是误导——真正问题是文件压根没进包。

---

## 历史版本

### v0.1.12（2026-08-06）

- sql.js 改用 wasmBinary 方式加载（fetch ArrayBuffer，规避 MIME 问题）

### v0.1.11（2026-08-06）

- 修复设置页同步状态"假正常"：syncState 改为响应式订阅，设置页实时显示真实状态
- 新增「同步诊断」面板（云端文件大小、云端/本地任务数、失败阶段与错误）

### v0.1.10（2026-08-06）

- 修复启动自动同步（initialSync）失败被静默吞掉的问题：失败时明确报错
- 新增「同步诊断」数据结构（云端/本地任务数、失败阶段与错误）

### v0.1.9（2026-08-06）

- 原生平台下载改为 64KB 分片 Range，规避超大 base64 响应问题；失败回退一次性下载
- `read()` 失败不再静默返回 null（区分云端无文件 612 与读取失败）
- `syncNow` 云端读取失败时中止同步，绝不用本地数据覆盖云端（防数据丢失）

### v0.1.8（2026-08-05）

- 修复 iOS 同步大文件 base64 解码分块（避免 atob 栈溢出）。

### v0.1.7（2026-08-05）

- 七牛云同步 iOS/Android 直连（CapacitorHttp 绕过 CORS）。

### v0.1.6（2026-08-05）

- 窄屏侧边栏响应式 + 添加栏日期换行修复。

### v0.1.5（2026-08-05）

- 详情面板布局修复 + iOS 更新检查 + 安装文档更新。

### v0.1.4（2026-08-05）

- iOS 移动端布局适配。

### v0.1.3（2026-08-05）

- 空状态教学收尾 + 类型清理。

---

## 早期版本（0.0.x）

- 版本号：0.0.3
- 发布日期：2026 年 7 月 27 日
- 平台：macOS (ARM64)

## 应用简介

TinyDo 是一个现代化的待办事项管理应用，基于 Vue 3、TypeScript 和 Electron 构建，包含完整的前后端架构。该应用提供了一个美观且功能完善的界面，帮助用户管理日常任务。

## 功能特点

- 添加、编辑、删除待办事项
- 标记任务完成状态
- 搜索过滤功能
- 数据本地持久化存储
- 响应式界面设计
- 内置多级别日志功能，便于调试问题

## 安装说明

1. 双击 `TinyDo.dmg` 文件以挂载安装镜像
2. 将 "TinyDo" 图标拖拽至 "Applications" 文件夹
3. 打开 "Applications" 文件夹，双击 "TinyDo" 启动应用

## 系统要求

- macOS 10.12 或更高版本
- 至少 2GB 可用存储空间

## 项目结构

```
project-root/
├── electron/           # Electron 主进程和预加载脚本
│   ├── main.js       # 主进程代码
│   └── preload.js    # 预加载脚本
├── server/             # 后端服务代码
│   └── server.js     # JSON Server 后端服务
├── src/                # 前端源代码
│   ├── components/   # Vue 组件
│   ├── views/        # 页面视图
│   ├── stores/       # Pinia 状态管理
│   └── router/       # Vue Router 路由
├── dist/               # 构建后的前端资源
└── db.json             # 本地数据文件
```

## 架构说明

- 前端：使用 Vue 3 + TypeScript + Tailwind CSS + daisyUI
- 后端：使用 json-server 提供 REST API 服务
- 桌面应用：使用 Electron 将 Web 应用封装为桌面应用
- 数据存储：本地 db.json 文件存储

## 日志配置

应用运行时会根据配置文件设置日志行为：

- 默认启用日志记录，日志级别为 `INFO`
- 可通过外部 `config.json` 文件控制日志行为：
  - `enableLogging`: 是否启用日志 (true/false)
  - `logLevel`: 日志级别 (ERROR, WARN, INFO, DEBUG)
- 日志文件保存在: `~/Library/Application Support/tinydo/logs/app-[YYYY-MM-DD].log`

## 重新构建说明

要重新构建应用，可以使用项目根目录下的 `rebuild-dmg.sh` 脚本：

1. 确保已在项目根目录
2. 运行 `chmod +x rebuild-dmg.sh` 给脚本添加执行权限
3. 运行 `./rebuild-dmg.sh` 开始构建流程

该脚本将自动执行以下步骤：

- 构建前端项目
- 更新资源引用
- 复制必要文件
- 创建新的 DMG 文件
- 将 DMG 文件保存到 release 目录

## 注意事项

- 首次运行时，系统可能会提示您确认安装来源，请按提示操作
- 应用数据将保存在本地，不会上传到云端
- 如遇权限问题，请在系统偏好设置 > 安全性与隐私中允许应用运行

## 技术说明

- 使用 Electron 构建，可在 macOS 上原生运行
- 内置 json-server 后端服务，提供 REST API
- 数据存储使用本地文件系统，无需网络连接
- 前端使用 Vue 3 + TypeScript + Tailwind CSS + daisyUI
- 内置多级别日志记录功能，便于调试问题

## 已知问题

- 应用首次启动可能需要几秒钟的加载时间（等待后端服务器启动）
- 在某些 macOS 版本上可能需要额外的安全许可

## 更新日志

- v0.0.3 (2026-07-27): 品牌重命名 + 架构重构
  - 应用正式更名为 TinyDo
  - 数据引擎从 CRDT 重构为 SQLite (sql.js) + IndexedDB 持久化
  - 云同步从 WebDAV 切换为七牛云 Kodo（10GB 免费额度）
  - 新增日历视图（月视图/周视图/日视图）
  - 新增四象限视图（重要/紧急矩阵）
  - 新增搜索功能
  - 主题系统支持自定义 CSS 变量
  - SVG 图标组件化重构
  - 路由从 History 模式改为 Hash 模式
  - 全新首页界面设计
  - 设置页面全面升级
  - 完善文档体系（ADR、术语表、实施路线图）

- v0.0.0 (2026-01-31): 前后端完整版
  - 保留前端后端完整架构
  - 修复白屏问题
  - 后端服务在打包后自动启动
  - 添加多级别日志功能，便于调试
  - 优化用户界面和交互体验
  - 恢复正确的项目目录结构
