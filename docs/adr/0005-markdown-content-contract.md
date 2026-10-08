# ADR-0005: 任务内容（content）契约升级为 Markdown + 滴答式所见即所得编辑器

## 状态

**已接受**（规划完成，未实施）

## 日期

2026-10-02

## 背景

- TinyDo 任务/笔记的「内容」目前是纯文本 `<textarea>`，`content` 字段以纯文本字符串贯穿
  搜索、笔记预览、小柴 AI（读+写）、外部 Agent 桥 API、CSV 导入、云同步六个下游。
- 产品目标：对齐滴答清单（TickTick）的任务描述编辑体验。
- 逆向取证结论（`docs/research/ticktick-editor-reverse-engineering.md`）：
  滴答全端以 **Markdown 纯文本** 为 content 的存储格式，编辑器为「Markdown 存储的所见即所得」，
  并为搜索（`SemanticMarkdownSearchExporter`）、粘贴（`SemanticMarkdownRichPasteImporter`）、
  AI 写回（`AISuggestionMarkdownSavePreparation`）配套了专门的 Markdown 处理模块。
- TinyDo 现有存量 content 全是纯文本；纯文本天然是合法 Markdown，零迁移成本。

## 决策

1. **content 字段契约升级**：自本 ADR 起，`content` 一律按 **Markdown 文本** 解释与渲染。
   存量纯文本数据不做迁移（合法 Markdown）；小柴 AI、外部 Agent、CSV 导入写入的纯文本
   同样视为合法 Markdown，无需改动。提示词层面可选引导 AI 输出 Markdown（非强制）。
2. **编辑器**：Tiptap（ProseMirror 系，Vue 3 官方支持）。首期功能集对齐滴答基础档：
   标题、粗/斜/下划线/删除线、高亮、链接、有序/无序列表、行内代码、代码块、引用、分割线，
   Markdown 快捷输入、列表续写/退格行为、富文本粘贴自动转 Markdown。
   编辑器只出现在详情面板；列表/日历等视图仅做只读渲染，点击进详情编辑（与滴答一致）。
3. **搜索与纯文本消费**：新增 Markdown→纯文本剥离层（对应滴答的 SearchExporter），
   任务搜索与列表行预览一律先剥离语法再匹配/截断。
4. **图片（第二期）**：图片以占位引用内嵌进 Markdown（`![](tinydo-attachment://<id>)`），
   **二进制存本地附件库，不进 content 字符串**；插入前客户端压缩
   （WebP，长边 ≤1600px，质量 ~0.8）；云同步时附件随 Kodo 一起上传
   （同步引擎从单文件扩展到 `TinyDo/attachments/` 前缀）。
   否决的备选：base64 data URI 内嵌（content 膨胀、污染搜索/AI）、
   直接写 Kodo 公网 URL（隐私、离线、迁移问题）。
5. **本期不做**（远期备选，滴答有）：Markdown 源码模式、斜杠菜单、
   描述内 checklist 反向驱动子任务状态、沉浸模式、附件文件（非图片）。

## 影响

- `content` 的**语义**变化对所有下游生效；字段类型（string）与同步协议不变。
- 新增依赖：`@tiptap/vue-3`、`@tiptap/starter-kit`、`@tiptap/extension-*`（高亮/下划线/图片）。
- 新增模块：Markdown 剥离层、附件存储层、同步引擎前缀同步。
- 回滚方式：编辑器组件替换回 `<textarea>` 即可；数据层面 Markdown 串仍可当纯文本读，
  附件占位符在纯文本视图下显示为引用文本，无数据不可逆问题。

## 参考

- `docs/research/ticktick-editor-reverse-engineering.md`（取证报告）
- `docs/adr/0003-automerge-data-layer.md`、`docs/sync-engine-design.md`（附件同步依赖其扩展）
