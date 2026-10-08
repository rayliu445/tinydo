# Markdown 编辑器（滴答式）设计与任务规划

> 状态：规划完成，待实施 · 决策依据：`docs/adr/0005-markdown-content-contract.md`
> 取证依据：`docs/research/ticktick-editor-reverse-engineering.md`

## 一、目标

把任务/笔记详情面板的 `<textarea>` 换成滴答清单同款的所见即所得 Markdown 编辑器，
`content` 契约升级为 Markdown，第二期支持图片（压缩 + 本地附件库 + 随云同步上传）。

## 二、架构

```
                    ┌─ 详情面板 TaskDetailPanel ─┐
用户编辑 ──────────▶│  Tiptap 编辑器（WYSIWYG）   │──保存──▶ content = Markdown 字符串
                    └────────────────────────────┘              │（同步协议不变）
                                                                ▼
只读消费 ◀── 剥离层 markdownText() ────────────── SQLite（sql.js）
  任务搜索：剥离后子串匹配（滴答 SemanticMarkdownSearchExporter 同款）
  列表行预览：剥离后截断纯文本
  笔记视图：Markdown 渲染（富文本预览）
  小柴/Agent/CSV 导入：写入纯文本 = 合法 Markdown，零改动
```

图片（二期）：

```
选图/粘贴/拖拽 ──▶ 压缩（WebP，长边≤1600，质量0.8）──▶ 附件库（IndexedDB / userData）
                                                        │
content 中插入占位 ![](tinydo-attachment://<id>)         │
                                                        ▼
渲染时占位解析为本地图片 ◀────────────── 同步引擎扩展：Kodo 前缀 TinyDo/attachments/*
```

## 三、任务分解

### Phase 0 — 契约地基（约 0.5 天）

| # | 任务 | 产出 | 验收 |
|---|------|------|------|
| 0.1 | Markdown 剥离层 | `src/services/markdown-text.ts`：markdown→纯文本 + 截断预览，附单测 | 含代码块/链接/图片/列表样例的用例全过 |
| 0.2 | 搜索接线 | `task-query.ts` 的 content 匹配改走剥离层 | 搜「加粗」能命中 `**加粗**` |
| 0.3 | 只读渲染 | 笔记视图改 Markdown 渲染；列表行预览改用剥离层 | 笔记显示富文本；列表行无语法符号 |

### Phase 1 — 编辑器（约 2–3 天）

| # | 任务 | 产出 | 验收 |
|---|------|------|------|
| 1.1 | Tiptap 引入 | 依赖 + 主题对齐（CSS 变量、亮/暗色） | 编辑器样式与现有面板一致 |
| 1.2 | 详情面板替换 | `TaskDetailPanel.vue` 内容区换 Tiptap；工具栏（标题/粗斜下删/高亮/链接/列表/引用/代码/分割线）；保存仍走现有按钮 | 现有内容打开可编辑、保存后重开一致 |
| 1.3 | 编辑行为 | Markdown 快捷输入（`**`、`- `、`#`）；列表回车续写、退格退出；序列化存 Markdown | 对齐滴答手感 |
| 1.4 | 粘贴转换 | 从网页/Word 粘贴富文本 → 自动转 Markdown（对应滴答 RichPasteImporter） | 粘贴带样式段落不产生 HTML 标签 |
| 1.5 | 下游回归 | 小柴拆任务写入 content；`tinydo` CLI/Agent 桥更新 content；Dida CSV 导入 | 三条路径写入的纯文本在编辑器中正常显示 |

### Phase 2 — 图片（约 2–3 天）

| # | 任务 | 产出 | 验收 |
|---|------|------|------|
| 2.1 | 附件库 | `src/services/attachments.ts`：存取（IndexedDB / Electron userData），内容 id 索引 | 存取删全通过 |
| 2.2 | 压缩管线 | canvas → WebP，长边 ≤1600，质量 ~0.8 | 5MB 照片压到数百 KB |
| 2.3 | 插入流程 | 工具栏按钮 + 粘贴图 + 拖拽 → 压缩 → 入库 → content 插入占位 | 三种入口都能插图 |
| 2.4 | 占位渲染 | 编辑器与只读视图中 `tinydo-attachment://` 解析为本地图片 | 离线可显示 |
| 2.5 | 同步扩展 | Kodo 从单文件扩展为前缀同步（`TinyDo/data.automerge` + `TinyDo/attachments/*`）；附件按内容 id 幂等，无冲突 | 两端互传图片可见 |
| 2.6 | 孤儿清理 | 任务删除/图片移除后回收附件 | 无悬挂二进制 |

### Phase 3 — 远期（不排期，滴答有、本期不做）

源码模式切换、斜杠菜单、描述内 checklist 反向驱动子任务、沉浸模式、非图片附件。

## 四、风险与对策

| 风险 | 对策 |
|------|------|
| Tiptap 与 Vue 3.2（旧）兼容 | 锁定 Tiptap 2.x（Vue 3.2 支持），实施第一步先做依赖冒烟 |
| 移动端 WebView 键盘/光标问题 | Phase 1 仅桌面验证；移动端问题单独建任务，不在本规划内修 |
| 大图同步流量 | 压缩管线前置；WebP 兜底 JPEG |
| 同步引擎前缀扩展动核心 | 附件按内容 id 幂等（内容寻址），天然无冲突；先本地用，同步扩展灰度 |

## 五、明确不做

- content 存 HTML 或 Tiptap JSON（破坏契约，ADR-0005 已否决）
- 把图片 base64 内嵌 content（搜索/AI 污染，ADR-0005 已否决）
