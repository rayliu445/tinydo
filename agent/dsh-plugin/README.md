# tinydo-dsh-plugin

把 TinyDo 任务清单变成 **DSH 原生工具**：Agent 可以直接查任务、拆任务、改日期/优先级、完成、删除、统计。

数据通路：插件 → `agent/lib/client.mjs` → TinyDo 本地接口（`127.0.0.1` + token）→ App 真实数据层。
**App 是唯一写入者**，所以外部改动会立刻反映在界面上并照常云同步。

## 安装

```bash
cd ~/.dsh/profiles/web
pnpm add link:/path/to/tinydo/agent/dsh-plugin
```

> 必须用 `link:` 而不是 `file:`：`file:` 会把插件目录**拷贝**进 node_modules，
> 插件里的 `../lib/client.mjs`（唯一真相的客户端）就找不到了；`link:` 是符号链接，
> 插件与仓库里的客户端始终同版本，改完即时生效。

然后把包名加进同目录 `package.json` 的 `dsh.profile.bundles`：

```json
"dsh": { "profile": { "bundles": [ "...", "tinydo-dsh-plugin" ] } }
```

重启 DSH。启动时会打印一行 `[tinydo] 已注册 9 个工具`。

前提：TinyDo 桌面端已安装（`/Applications/TinyDo.app`）或在同一台机器上可启动；
「设置 → 外部助手」保持开启（默认开启）。

## 提供的工具

| 工具 | 类型 | 说明 |
| --- | --- | --- |
| `tinydo_list_tasks` | read | 视图/关键词/清单/标签过滤，返回层级清单（含 id） |
| `tinydo_get_task` | read | 单任务详情 + 直接子任务 |
| `tinydo_add_task` | write | 新增（`parentId` 挂子任务，幂等保护） |
| `tinydo_update_task` | write | 改标题/日期/优先级/内容/标签/父任务 |
| `tinydo_complete_task` | write | 完成/取消完成（级联子任务） |
| `tinydo_delete_task` | write | 软删除（级联子任务，不可撤销） |
| `tinydo_bulk_add_tasks` | write | 一次 ≤50 条（拆解任务主力） |
| `tinydo_stats` | read | 今天/最近7天/逾期/优先级/清单分布 |
| `tinydo_recent_changes` | read | 最近的写入审计 |

## 卸载

```bash
cd ~/.dsh/profiles/web
pnpm remove tinydo-dsh-plugin     # 并从 package.json 的 bundles 里删掉该行
```

删掉插件不影响其它两层：`tinydo` CLI 与本地接口照常工作（DSH 仍可用 bash 驱动）。

## DSH 升级后的自检（30 秒）

DSH 仍是预览版，工具注册面**可能变化**。每次升级 DSH 后：

1. `npm run selftest:plugin`（在 TinyDo 仓库里）→ 这一步会**直接 import DSH 自带的
   `@deepseek-ai/dsh-tools` schema 校验器**来验 9 个工具定义，所以"工具面变了"不必等重启才发现。
2. `tinydo doctor` → App / 端口 / token / 数据层是否正常。
3. 重启 DSH，问一句「tinydo 有哪些工具」→ 应看到 9 个 `tinydo_*`。
4. 没看到？看 DSH 日志里的 `[tinydo] … 注册失败`：
   - 只影响注册：插件内置的 `skills/tinydo/SKILL.md` 仍能让 DSH 用 CLI 完成同样的事（降级通道）；
   - 按报错改 `index.js`，通常只改一个文件、十几行。

### 已知的宿主硬性要求（v0.1.21 实测踩过一次）

- `ctx.tools.register(tool)` 要求 **`tool.output` 必填**：`output.render` 必须是函数，
  否则抛 `tool "x" must declare output { schema, render, presentationMeta? }` 并拒绝注册。
- `execute()` 的**返回值**会用 `output.schema` 校验（`validateJsonSchemaValue`）；
  `render(args, value)` 的返回值被当作 content blocks（我们是 `[{ type:'text', text }]`）。
- `parameters` / `output.schema` 只支持 JSON Schema 子集：
  `type/properties/required/items/enum/const/description/title/default/additionalProperties/oneOf`。

插件刻意做成**薄壳**：零依赖、只用宿主 `ctx.tools.register` 一个方法、注册失败只打日志不拖垮宿主，
所以升级成本是"偶尔改几行"，而不是"维护一个插件"。
