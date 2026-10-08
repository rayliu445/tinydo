# 滴答清单编辑器逆向调研报告

> 调研方式：滴答清单是闭源商业软件，无公开源码。本报告基于对 **TickTick macOS 官方客户端 8.2.30 (923)**
> 安装包（dmg）的二进制静态分析——Swift 符号表、CI 源码路径、资源文件。非猜测，每条结论都有出处。

## 核心结论

**滴答清单的任务描述在所有端存储的都是 Markdown 纯文本，编辑器是「所见即所得的 Markdown 编辑器」——
底层是原生文本视图 + Markdown 语义模型，不是 HTML contenteditable，也不是 JSON 文档树。**

## 证据链

### 1. 数据层：content 就是 Markdown 字符串

- 官方 Open API（task 模型）：`content`（string）+ `desc`（string），均为纯文本字段。
- 官方 CSV 导出格式（TinyDo 仓库 `Dida_test.csv` 同款）：`Content` 列为纯文本，
  任务有 `Kind` 字段，枚举值 **TEXT / NOTE / CHECKLIST**（二进制符号 `TTTaskKind` 确认）。
- 笔记（NOTE）与任务（TEXT）共用同一个 Markdown 编辑器组件：
  符号 `detailMarkdownCellTaskIsNoteKind`。

### 2. 编辑器架构（来自 AppiestKit.framework 二进制符号 + CI 源码路径）

TickTick 母公司 Appest 的业务框架 `AppiestKit.framework` 内含完整的 Markdown 编辑器模块，
Swift 符号表暴露了 CI 机器上的源码目录结构：
`Markdown/Source/Public/{Semantic/Editor, Semantic/Exporter, Semantic/Paste, UI/Base}`

| 组件 | 符号 | 作用 |
|---|---|---|
| 编辑器主体 | `APMarkdownTextView` / `APMarkdownBaseTextView` | 原生文本视图（NSTextView/UITextView） |
| 渲染 | `APMarkdownLayoutManager` / `APMarkdownTypesetter` / `APMarkdownThemeConfiguration` | TextKit 层渲染 Markdown 样式 |
| 语义层（IR） | `MarkdownRichTextController` / `APMarkdownElementManager` | Markdown ↔ 显示样式双向映射 |
| **搜索** | `SemanticMarkdownSearchExporter` | 搜索时把 Markdown 剥成纯文本（说明他们也遇到了「搜索要处理格式」问题） |
| **粘贴** | `SemanticMarkdownRichPasteImporter` | 从网页/Word 粘贴富文本 → 转成 Markdown 语义 |
| 退格/换行 | `APMarkdownBaseTextView+Backspace` / `+ShouldChangeMarkdownText` | 列表项回车续写、退格退出列表等编辑行为 |

### 3. 支持的 Markdown 元素（`APMarkdown*` 符号全列表）

粗体、斜体、下划线、删除线、**高亮**（带颜色 popover）、行内代码、代码块（带语言菜单+复制按钮）、
标题、有序/无序列表、引用、链接（自动链接+附件链接）、水平分割线、复选框、
附件（文件/图片占位）、时间插入（`MarkdownDateTime`）。

### 4. 产品级细节（主程序二进制符号）

- **斜杠菜单**：`TTSlashMarkdownCandidatePopover`，菜单项含
  `md_slash_menu_associate`（关联任务）、`md_slash_menu_subtask`（**在描述里插子任务**）。
- **双模式**：`TTMarkdownModeRoundTripCoordinator` —— 富文本视图 ↔ Markdown 源码模式可往返切换。
- **沉浸模式**：`md_immersive_enter` / `md_immersive_exit`。
- **描述内 checklist 与子任务系统打通**：保存请求带
  `checklistItemsOverride` / `checklistDerivedStatusIntent` / `originalDescriptionAtChecklistMode`
  —— 描述里的 Markdown 复选框可以反向驱动任务子任务状态。
- **AI 也走 Markdown**：`AISuggestionMarkdownSavePreparation` —— AI 生成的建议以 Markdown 形态写回。
- **附件序列化进 Markdown**：`Quick add attachments failed to serialize markdown content` ——
  附件以某种占位/链接语法内嵌在 content 字符串里，不是独立字段。
- **草稿与确认机制**：`TTMarkdownDraftPreparation` / `TTMarkdownPersistenceAcknowledgement`。

### 5. Mac 端技术栈参考

原生 Swift（非 Electron）：GRDB（SQLite）、Highlightr（代码高亮）、dsBridge（局部 WebView 桥）、
SDWebImage、SwiftInject 等。Web 端与移动端架构本次未能取证（SPA 需登录态），但 CSV/Open API
证明了存储格式全端一致。

## 对 TinyDo 的直接推论

1. **「和滴答一样」= content 存 Markdown 字符串**。TinyDo 现有 `content` 字段无需迁移
   （纯文本天然是合法 Markdown）。
2. 搜索、AI 写入、外部 Agent API、CSV 导入四个下游在 Markdown 契约下全部继续工作，
   只需在搜索/预览时剥语法（滴答有专门的 `SemanticMarkdownSearchExporter` 干这事）。
3. 编辑器 UI 范式：工具栏 + Markdown 快捷输入 + 斜杠菜单 + 列表续写行为，
   渲染层所见即所得，可选源码模式。
4. 高级能力（描述内子任务驱动任务状态、附件内嵌、沉浸模式、AI 建议回写）
   都是建立在同一 Markdown 契约上的增量功能，可分期。

*（分析用副本在 /tmp/TT.app，镜像已卸载；重启后自动清理。）*
