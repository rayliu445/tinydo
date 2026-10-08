# 术语表 (Glossary)

## 架构与数据

| 术语 | 英文 | 定义 |
|------|------|------|
| **本地优先** | Local-First | 所有数据操作优先在本地设备完成，网络仅用于同步。用户在网络不可用时仍可完整使用应用。 |
| **SQLite** | — | 轻量级嵌入式关系数据库。本项目使用 sql.js (SQLite WASM) 作为核心数据存储引擎。 |
| **sql.js** | — | SQLite 编译为 WebAssembly 的 JavaScript 版本，可在浏览器和 Node.js 中运行。 |
| **IndexedDB** | — | 浏览器内置的 NoSQL 数据库，用于持久化存储 SQLite 数据库文件的二进制快照。 |
| **localStorage** | — | 浏览器同步存储，作为 IndexedDB 的备用持久化方案。 |
| **七牛云 Kodo** | — | 七牛云提供的对象存储服务，用于可选的云同步。用户自行配置 Bucket 后实现多端数据同步。 |

## 平台

| 术语 | 英文 | 定义 |
|------|------|------|
| **Electron** | — | 当前 macOS 桌面端的运行时框架。将 Vue 3 Web 应用打包为原生桌面应用。 |
| **Capacitor** | — | 将 Web 应用打包为 iOS/Android 原生应用的框架。由 Ionic 团队维护。 |
| **WebView** | — | 移动端应用中用于渲染 Web 内容的原生组件。Capacitor 应用本质上是一个全屏 WebView。 |

## 应用功能

| 术语 | 英文 | 定义 |
|------|------|------|
| **四象限** | Eisenhower Matrix | 根据重要性和紧急性将任务分为四个象限的管理方法：重要且紧急、重要不紧急、紧急不重要、不重要不紧急。 |
| **日历视图** | Calendar View | 在日历上按日期展示任务的可视化视图，支持月/周/日三种粒度。 |
| **清单** | List / Project | 任务的分类集合。类似文件夹，一个清单包含多个任务。 |
| **标签** | Tag | 用于对任务进行多维度分类的标记。一个任务可以有多个标签。 |
| **全天任务** | All-Day Task | 没有具体时间、仅绑定到某一天的任务。 |
| **提醒** | Reminder | 在指定时间通知用户处理任务的机制。 |

## 编辑器（ADR-0005）

| 术语 | 英文 | 定义 |
|------|------|------|
| **Markdown 契约** | Markdown Contract | ADR-0005 决策：`content` 字段一律按 Markdown 文本解释。纯文本是合法 Markdown 的子集，因此存量数据与 AI/导入写入零迁移。 |
| **所见即所得编辑器** | WYSIWYG Editor | 编辑时直接呈现最终渲染效果（看到样式而非 Markdown 语法符号），底层仍以 Markdown 字符串为数据源。滴答清单同款范式。 |
| **Tiptap** | — | 本项目选用的富文本编辑器框架（ProseMirror 系，Vue 3 官方支持），负责编辑交互，序列化输出 Markdown。 |
| **剥离层** | Plain-Text Exporter | 把 Markdown 剥成纯文本的工具层，供任务搜索与列表预览使用（对应滴答的 `SemanticMarkdownSearchExporter`）。 |
| **附件占位引用** | Attachment Placeholder | 图片在 content 中的存在形式：`![](tinydo-attachment://<id>)`。字符串本体不含图片数据，二进制存附件库，同步时上传 Kodo。 |
| **附件库** | Attachment Store | 本地存储图片二进制的模块（Web: IndexedDB / Electron: userData 文件），以内容 id 索引，配合同步引擎上传云端。 |

## 同步

| 术语 | 英文 | 定义 |
|------|------|------|
| **同步引擎** | Sync Engine | 负责检测数据变更、读写云存储、同步数据库文件的模块。 |
| **离线优先** | Offline-First | 应用设计原则：所有功能在无网络连接时仍可完整使用。 |
| **对象存储** | Object Storage | 云存储服务（如七牛云 Kodo），以文件形式存储数据，通过 HTTP API 读写。 |
| **CRDT** | Conflict-Free Replicated Data Type | 无冲突复制数据类型。本项目用于云端文件的序列化格式（`TinyDo/data.automerge`），本地读写仍以 SQLite 为准。 |
| **LWW 合并** | Last Write Wins | 冲突解决策略：同一任务在多个设备被修改时，以 `updatedAt` 较晚的版本为准。 |
