# TinyDo × 外部 Agent 桥接设计（Phase 1）

> 状态：**Phase 1 已实现并验证通过**（74 项自检全绿，见文末「实施结果」）。
> 决策记录见 `docs/adr/0004-external-agent-bridge.md`。
> 目标读者：后续维护者 / 未来的自己。

## 1. 目标与非目标

**目标**

1. 让 DSH 这类 Agent 能**结构化地读写 TinyDo 的任务**：查询、拆解、改期、改优先级、完成、删除、批量、统计。
2. DSH 侧是**原生工具**（模型每次请求都能看到工具 schema），不是「拼 shell 命令碰运气」。
3. App 保持 less is more：不新增第二个数据源、不复制同步逻辑、不把小柴做成 Agent。

**非目标（本期）**

- App 未运行时的 headless 云端直连（免进程依赖）→ Phase 2。
- 笔记 NOTE / 清单 list / 标签 tags 的读写；任务手动排序；多人协作。
- 把接口暴露到局域网/公网。

**已确认的产品边界（用户决策）**

- 运行前提：桌面端可常驻，**允许 CLI 自动拉起 App**。
- 写权限：**全开，含删除**（软删除 + 级联，与 App 行为一致），全部落审计。
- 范围：任务域闭环（增删改查 + 完成 + 批量 + 统计 + 今天/最近7天查询）。

## 2. 架构

```
┌────────────────────────┐        ┌──────────────────────────────────────────────┐
│ DSH (Agent)            │        │ TinyDo Desktop (Electron)                    │
│  dsh-plugin: tinydo    │        │                                              │
│   ctx.tools.register   │        │  main process                                │
│        │               │        │   ├─ HTTP server  127.0.0.1:<port>           │
│        ▼               │        │   │    Bearer token 校验 / 审计写盘          │
│  agent/lib/client.mjs  │──HTTP──▶   └─ IPC bridge ─┐                           │
└────────────────────────┘        │                  ▼                           │
┌────────────────────────┐        │  renderer (唯一写入者)                        │
│ tinydo CLI (人/脚本)   │──HTTP──▶   ├─ todoStore / data-access (sql.js+IDB)    │
└────────────────────────┘        │   ├─ sortWithHierarchy / 级联语义            │
                                  │   └─ sync-engine → 七牛云 data.automerge     │
                                  └──────────────────────────────────────────────┘
```

关键点：**HTTP 只负责传输，业务语义全部复用渲染层现有代码**（`todoStore.addTodo/updateTodo/toggleTodo/removeTodo`），
因此行为与 UI 点击完全一致：级联完成、级联软删除、`updatedAt` 更新、`getSyncEngine().scheduleWrite()`、UI 实时刷新。

### 2.1 三层各自干什么（职责边界）

| 层 | 一句话 | 面向谁 | 解决了什么 | 如果它挂了 |
| --- | --- | --- | --- | --- |
| **本地桥接 API**（App 内） | 给 TinyDo 装一个只对本机开放的「插座」：把读/写任务变成标准 HTTP 接口 | 所有外部程序 | 安全地碰到真实数据：App 仍是唯一写入者，UI 实时刷新、云同步照常、业务逻辑零复制 | 不存在（它就是 App 的一部分），最多是开关被关掉 |
| **`tinydo` CLI** | 「手动挡 + 万能钥匙」：把插座包成命令行，人和任何 Agent 都能用 | 人、脚本、任意 Agent（含只会 bash 的） | 能力的事实标准与排错入口（`doctor`/`log`/`--json`）；**不依赖 DSH 任何内部 API** | 基本不会；它是我们自己的代码 |
| **DSH 原生插件** | 「原厂配件」：让 DSH 把 TinyDo 能力当成自己的工具（schema 每次请求都进模型上下文） | DSH 模型 | 体验最好：模型不用猜命令怎么拼，参数有约束、错误有文案 | 工具消失，但**数据通路仍在**（退回 CLI 通道即可继续干活） |

依赖方向是单向的：**插件 → CLI 客户端 → HTTP API**。反过来不成立，所以任何一层出问题都不会伤到数据本身。

## 3. 文件布局（本仓库新增）

```
agent/
├── lib/client.mjs        # 零依赖客户端：发现端口/token、自动拉起、fetch 封装、统一错误
├── cli.mjs               # tinydo CLI（薄封装 client）
├── dsh-plugin/
│   ├── package.json      # dsh.bundle.patch 指向 cordis.patch.yml
│   ├── cordis.patch.yml  # insert: { id: tinydo, name: 'tinydo-dsh-plugin' }
│   ├── index.js          # 零依赖 ESM：ctx.tools.register(...) × 9（薄壳，≤200 行）
│   ├── skills/tinydo/    # ★ 降级通道：SKILL.md 教模型用 `tinydo` CLI（不依赖工具 API）
│   └── README.md         # 安装到 DSH profile 的步骤 + DSH 升级后的自检清单
└── README.md
```

Electron / 渲染层改动：

| 文件 | 改动 |
| --- | --- |
| `electron/main.js` | 启动本地 API server；token/port 文件；按需创建隐藏窗口；审计写盘 |
| `electron/preload.js` | 新增 `onApiRequest(cb)` / `apiReply(id, payload)` 两个 contextBridge 方法 |
| `src/services/local-api.ts`（新） | 渲染层：接收 API 请求 → 调用 store → 返回结果（业务语义集中在此） |
| `src/main.ts` | 数据层就绪后注册渲染层 API handler，并汇报 `dataReady` |
| `src/stores/settings.ts` | 新增 `externalAgent: { enabled: boolean }`（默认开启，可一键关闭） |
| `src/views/SettingsView.vue` | 新增「外部助手（DSH）」面板：开关 / 端口 token / 活动日志 / 吊销 / 安装指引 |

## 4. 本地 HTTP API 契约

- Base：`http://127.0.0.1:<port>`，全部 `application/json`。
- 鉴权：`Authorization: Bearer <token>`；除 `GET /health` 外全部需要。
- 任务对象（紧凑 DTO）：

```json
{
  "id": "todo_1757992000000_ab12cd",
  "title": "写周报",
  "completed": false,
  "priority": 3,
  "dueDate": "2026-09-18T00:00:00.000Z",
  "startDate": null,
  "parentId": null,
  "list": "工作",
  "tags": ["周"],
  "content": null,
  "kind": "TASK",
  "createdAt": "2026-09-16T02:11:00.000Z",
  "updatedAt": "2026-09-16T02:11:00.000Z",
  "completedTime": null,
  "sourceId": "dsh:9f2c…"
}
```

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | `{ ok, version, dataReady, pid, syncEnabled }`，无需鉴权（仅本地） |
| GET | `/v1/tasks` | 查询。query：`view=inbox\|today\|next7\|completed\|all`、`search`、`list`、`tag`、`parentId`、`includeCompleted=0\|1`、`limit`（默认 200，上限 1000）。返回顺序＝App 当前显示顺序（`sortWithHierarchy` + `ui.sortOrder`），并附 `hierarchy: true` 标记 |
| GET | `/v1/tasks/:id` | 单条（含 `children` 直接子任务） |
| POST | `/v1/tasks` | 新增。body：`title`(必填)、`dueDate`(YYYY-MM-DD 或 ISO)、`startDate`、`priority`(0/1/3/5)、`parentId`、`content`、`tags`、`list`、`sourceId`。带 `sourceId` 时**幂等**：已存在则返回原任务并置 `deduped: true` |
| PATCH | `/v1/tasks/:id` | 局部更新：`title`/`dueDate`/`startDate`/`priority`/`content`/`tags`/`list`/`parentId`；`dueDate: null` 表示清空。返回 `{ task, changed: ["dueDate", …] }` |
| POST | `/v1/tasks/:id/complete` | body `{ completed: boolean }`；级联后代（与 App 勾选一致），返回 `{ task, affected: [id…] }` |
| DELETE | `/v1/tasks/:id` | 软删除 + 级联后代，返回 `{ deleted: [id…] }` |
| POST | `/v1/tasks/bulk` | body `{ items: [...≤50], dryRun?: boolean }`，逐条返回 `{ index, id?, error? }` |
| GET | `/v1/stats` | `{ pending, completed, today, next7, overdue, byPriority: {0,1,3,5}, byList: {...}, notes }` |
| GET | `/v1/audit?limit=50` | 最近的写入审计（见 §7） |

统一错误体：

```json
{ "error": { "code": "TASK_NOT_FOUND", "message": "任务不存在：todo_xxx" } }
```

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | 参数不合法（如 `priority: 2`、`dueDate: "明天"`） |
| 401 | `UNAUTHORIZED` | token 缺失/失效（App 重启后 token 会变，客户端应重读 port 文件重试一次） |
| 403 | `DISABLED` | 用户在设置里关了「外部助手」 |
| 404 | `TASK_NOT_FOUND` | id 不存在 |
| 409 | `CONFLICT` | 幂等命中（同时返回既有任务） |
| 503 | `DATA_NOT_READY` | 数据层尚未初始化（启动瞬间），客户端指数退避重试 |

### 4.1 扩展接口（协议 `api 2`，TinyDo ≥ 0.1.23）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/overview` | 清单 / 标签聚合：`[{name, pending, overdue, completed, total}]` + 未归清单/无标签计数 + 笔记数 |
| POST | `/v1/tasks/bulk-update` | 批量改字段（≤50）：`{ updates: [{id, dueDate?, priority?, tags?, list?, completed?}] }`，**一次刷新、一次同步调度** |
| POST | `/v1/tasks/restore` | 按完整快照还原（≤200，可命中已软删除的 tombstone）：`{ tasks: [snapshot] }` |
| GET | `/v1/notes` | 笔记列表：`archived=0\|1\|all`、`search`（匹配标题+正文）、`limit` |
| POST | `/v1/notes` | 新增笔记（`kind=NOTE`，不进任务列表） |
| PATCH | `/v1/notes/:id` | 改标题 / 正文 / 标签 / `archived`（归档 = 标记完成） |
| DELETE | `/v1/notes/:id` | 软删除笔记 |

**结构化撤销载荷**：审计条目新增 `undo` 字段，供客户端实现"撤销刚才那次写入"：

```json
{ "op": "delete_tasks",   "ids": ["todo_…"] }              // 撤销「新增」：删掉刚建的
{ "op": "restore_fields", "before": [{ /* 任务快照 */ }] }  // 撤销「修改/完成」：写回旧字段
{ "op": "restore_tasks",  "before": [{ /* 任务快照 */ }] }  // 撤销「删除」：还原（含 tombstone）
```

快照含 `id/title/completed/priority/dueDate/startDate/parentId/list/tags/content/kind/deleted/completedTime`；
超过 200 条时带 `truncated: true`（客户端应拒绝自动撤销而不是做一半）。
撤销通过 `POST /v1/tasks/restore` 执行，因此**撤销本身也会产生审计条目**——再撤销一次就等价于 redo。

## 5. 发现、凭据与自动拉起

- 文件：`~/.tinydo/local-api.json`，权限 `0600`：

```json
{ "port": 45871, "token": "…64hex…", "pid": 12345, "version": "0.1.22", "startedAt": "2026-09-16T02:00:00.000Z" }
```

- 端口优先取 45871，被占用则随机；token 每次启动重新生成（文件是唯一真相，客户端每次调用前重读，收到 401 后强制重读）。
- 客户端流程：读文件 → `GET /health` → 失败或文件不存在 → 拉起 App：

```bash
open -a TinyDo                      # 打包版
npx electron .                      # 开发版（TINYDO_DEV=1 且仓库存在时）
```

然后 20s 内轮询（250ms 起，指数退避），超时给出可执行文案：
`TinyDo 未运行且自动拉起失败：请先打开 TinyDo，或设置 TINYDO_APP_PATH 指向 app 路径`。
环境变量：`TINYDO_APP_PATH`（自定义可执行路径）、`TINYDO_API_PORT_FILE`（自定义 port 文件位置，测试用）、`TINYDO_NO_LAUNCH=1`（禁止自动拉起）。

- **窗口不在时**：主进程收到 API 请求但 `mainWindow` 为 null（用户关了窗口、macOS 下 App 仍存活）→ 创建隐藏窗口
  （`show:false`）→ 等 `did-finish-load` + 渲染层 `dataReady` → 再转发请求（最坏 ~3s，客户端超时 15s）。

## 6. CLI（`tinydo`）

```
tinydo list [--today|--next7|--all|--completed] [--search Q] [--list L] [--tag T] [--tree] [--json]
tinydo get <id> [--json]
tinydo add "标题" [--due 2026-09-20] [--start …] [--priority high|mid|low|none]
                  [--parent <id>] [--tags a,b] [--list L] [--content "…"] [--source-id K] [--json]
tinydo edit <id> [--title "…"] [--due 2026-09-20|--clear-due] [--priority mid] [--parent <id>]
                  [--content "…"] [--tags a,b] [--json]
tinydo done <id> [--undo]          # 完成 / 取消完成（级联后代）
tinydo rm <id> [--yes]             # 软删除 + 级联；默认要求 --yes 或交互确认
tinydo bulk add --file tasks.json [--dry-run] [--json]
tinydo stats [--json]
tinydo log [--limit 50] [--json]   # 审计记录
tinydo doctor                      # App 是否运行 / 端口 / token / 版本 / dataReady / 同步状态
```

约定：默认输出人类可读（`--today` 用与 App 一致的日期分组），`--json` 输出稳定结构供脚本/Agent 兜底使用；
所有写命令支持 `--dry-run`（走 `POST /v1/tasks/bulk` 的 `dryRun` 或本地校验）。

## 7. 审计与设置面板

- 审计文件：`~/.tinydo/audit.jsonl`（本地、不同步），每行一条：

```json
{ "ts": "2026-09-16T02:31:44.100Z", "actor": "dsh", "action": "update_task",
  "taskIds": ["todo_…"], "summary": "dueDate: 2026-09-18 → 2026-09-25", "ok": true }
```

`actor` 由请求头 `X-TinyDo-Actor: dsh|cli` 决定（缺省 `external`）。写盘在**主进程**（渲染层只返回结果），
避免把本地日志混进同步数据；滚动：保留最近 30 天或 5000 行。

- 设置页「外部助手（DSH）」面板：总开关（写 `settings.externalAgent.enabled`）、当前端口、token（掩码 + 复制）、
  最近 50 条活动日志、`吊销并重新生成 token`、以及一段可直接执行的 DSH 插件安装指引（见 §8）。

## 8. DSH 插件

安装（本地开发路径，改完即时生效）：

```bash
cd ~/.dsh/profiles/web
pnpm add link:/Users/liulei/frontProjects/tinydo/agent/dsh-plugin
# 然后把 "tinydo-dsh-plugin" 加进 package.json 的 dsh.profile.bundles
```

> 注意用 `link:` 而非 `file:`：`file:` 会把插件目录拷进 node_modules，插件里的
> `../lib/client.mjs` 就解析不到（已实测）；`link:` 是符号链接，插件与仓库里的客户端同源同版本。

`agent/dsh-plugin/package.json`：

```json
{
  "name": "tinydo-dsh-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "exports": { ".": "./index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`agent/dsh-plugin/cordis.patch.yml`：

```yaml
- insert:
    - id: tinydo
      name: 'tinydo-dsh-plugin'
```

`agent/dsh-plugin/index.js`（骨架，零依赖，只用 node builtins + `ctx.tools`）：

```js
import { createClient } from '../lib/client.mjs'

export const name = 'tinydo'
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const client = createClient({ appPath: config.appPath })
  for (const tool of tools(client)) {
    try { ctx.tools.register(tool) }
    catch (err) { console.error(`[tinydo] ${tool.name} 注册失败：`, err) }
  }
}

function tools(client) {
  return [
    {
      name: 'tinydo_list_tasks',
      description: '查询 TinyDo 任务清单。按视图/关键词/清单/标签过滤，返回任务 id 与关键字段，供后续读写引用。',
      parameters: {
        type: 'object',
        properties: {
          view: { type: 'string', enum: ['inbox', 'today', 'next7', 'completed', 'all'] },
          search: { type: 'string' },
          list: { type: 'string' },
          tag: { type: 'string' },
          limit: { type: 'number' }
        }
      },
      timeoutMs: 20000,
      isConcurrencySafe: () => true,
      presentCall: (args) => ({ card: 'generic', title: 'tinydo_list_tasks', kind: 'read', rawInput: args }),
      // 宿主强制要求：schema 用于校验返回值，render 负责转成 content blocks
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value ?? '') }]
      },
      async execute(args) { return await client.listTasks(args) }
    }
    // …add_task / update_task / complete_task / delete_task / bulk_add_tasks / stats / recent_changes
  ]
}
```

工具清单（Phase 1 冻结 9 个）：

| 工具 | 类型 | 说明 |
| --- | --- | --- |
| `tinydo_list_tasks` | read | 视图/关键词/清单/标签过滤，返回紧凑列表（含层级顺序） |
| `tinydo_get_task` | read | 单任务 + 直接子任务 |
| `tinydo_add_task` | write | 新增（支持 `parentId` 挂子任务、`sourceId` 幂等键） |
| `tinydo_update_task` | write | 改标题/日期/优先级/内容/标签/父任务 |
| `tinydo_complete_task` | write | 完成 / 取消完成（级联后代） |
| `tinydo_delete_task` | write | 软删除 + 级联（不可逆，工具描述里明确写清） |
| `tinydo_bulk_add_tasks` | write | 一次 ≤50 条，返回逐条结果（拆解任务的主力） |
| `tinydo_stats` | read | 今天/最近7天/逾期/按优先级/按清单计数 |
| `tinydo_recent_changes` | read | 最近写入审计（回答"我刚让你改了什么"） |

设计约束：

- **幂等**：`add_task` 若调用方未给 `sourceId`，插件生成 `dsh:<sessionId>:<seq>` 并复用同一值时重试安全；
  Agent 重试/网络抖动不会产生重复任务。
- **错误即文案**：把 §4 的错误码翻译成模型能懂的一句话（如「任务不存在，请先 `tinydo_list_tasks` 确认 id」），
  避免模型拿 404 硬猜。
- **写工具必须 `kind: 'write'`**，让 DSH 的 UI 卡片如实展示；`description` 保持一句话、写清副作用。
- 不让模型自由拼 shell（CLI 只是人/排错入口，插件走 client，不 fork 进程）。

### 8.1 依赖面、降级与维护成本（DSH 预览版风险）

DSH 仍处预览阶段，破坏性变更是真实存在的——生态里的现成证据：`@liustack/modlens` 在 `package.json` 里维护
`dsh.compatibility.dshReleases`，逐个 DSH 版本标注 `compatible` / `unknown`，其源码注释也直说
「same-layer duplicate … or a **preview-era surface change**: degrade loudly instead of taking the whole plugin down」。
所以正确的做法不是"赌它不变"，而是**把爆炸半径压到最小 + 修不好也能继续干活**。

**我们实际耦合的 DSH 内部面（全部清单）**

```js
export const name = 'tinydo'          // 插件名
export const inject = ['tools']       // 声明依赖的宿主能力
export function apply(ctx, config)    // 入口
ctx.tools.register(tool)             // 唯一用到的宿主方法
// tool = { name, description, parameters,
//          output: { schema, render },        // ★ 必填（见下方说明）
//          execute(args, exec), presentCall?, timeoutMs?, isConcurrencySafe? }
```

> ⚠️ **`output` 是必填，不是可选**（v0.1.21 重启实测踩到）：宿主 `@deepseek-ai/dsh-tools` 的
> `tools.register()` 要求 `output` 为对象且 `output.render` 是函数，否则抛
> `tool "x" must declare output { schema, render, presentationMeta? }` 并**拒绝注册**；
> 注册成功后，`execute()` 的返回值还会用 `output.schema` 校验（`validateJsonSchemaValue`），
> `render(args, value)` 的返回值被当作 content blocks 快照。
> 我们统一返回紧凑文本，所以 `schema: { type: 'string' }`、`render` 直接包一个 text block。
> **这条已经内建进自检**：`npm run selftest:plugin` 会直接 import DSH 自带的
> `dsh-tools` schema 校验器来验工具定义，因此"工具面变了"不用等到重启 DSH 才发现。

除此之外**零依赖、零内部导入、不碰 DSH 的 llm/webServer/settings 等其它能力**。所有业务逻辑都在
`agent/lib/client.mjs`（我们自己的代码）里，插件只是把 9 个函数翻译成工具清单。

**三层降级链（任何一层断掉都不影响干活）**

| 断掉的东西 | 后果 | 恢复手段 |
| --- | --- | --- |
| `ctx.tools.register` 形状变了 | 工具不出现（**注册失败被 try/catch 吞掉并打日志，绝不拖垮宿主**） | 打开 `skills/tinydo/SKILL.md`：模型改用 bash 调 `tinydo` 命令，能力几乎不降 |
| 工具 API 与 skill 都失效（bundle/patch 机制大改） | 该插件不加载 | 直接对话里说"用 `tinydo` 命令帮我…"；或按 README 修 1 个文件 |
| 完全不想维护插件了 | —— | 删掉 `agent/dsh-plugin/`，API + CLI 原样保留，DSH 仍可通过 bash 驱动 |

**维护成本的真实量级**

- 多数 DSH 版本：**0 改动**（我们只用一个注册方法）。
- 工具面参数微调：**改十几行、一个文件**，通常一眼能看出（`tinydo doctor` + 问 DSH 一句"tinydo_list_tasks 有哪些参数"即可判定）。
- bundle/patch 机制大改：会同时打断你 profile 里全部 13 个 bundle，那是 DSH 官方迁移说明级别的事，不是 TinyDo 特有的负担。
- 明确边界：**API 与 CLI 永远不依赖 DSH**，所以最坏情况也只是"手动挡"，不会出现"数据用不了"。

**自检清单（写进 `agent/dsh-plugin/README.md`，DSH 升级后 30 秒跑一遍）**

1. `tinydo doctor` → App / 端口 / token / dataReady 正常。
2. 重启 DSH，问一句「tinydo 有哪些工具」→ 9 个工具都在。
3. 若不在：看 `~/.dsh` 日志里的 `[tinydo] … registration skipped` 行 → 按 §8 形状对照修 `index.js`；
   修之前先靠 skill 通道继续用。

## 9. 实施步骤与验收

**1a 本地 API（App 侧）**
1. `electron/main.js`：HTTP server（`127.0.0.1`、仅 `node:http`，无新依赖）+ token/port 文件 + 按需隐藏窗口 + 审计写盘。
2. `electron/preload.js`：`onApiRequest` / `apiReply` 两个桥方法。
3. `src/services/local-api.ts`：请求分发 → `todoStore` 动作；`list` 复用 `sortWithHierarchy` + `ui.sortOrder`。
4. `src/stores/settings.ts` + `SettingsView.vue`：开关 + 面板。
5. 自测：`curl -H "Authorization: Bearer $TOKEN" localhost:45871/v1/stats`。

**1b CLI**：`agent/lib/client.mjs`（发现/拉起/重试/错误映射）+ `agent/cli.mjs`（§6 命令表）+ `tinydo doctor`。

**1c DSH 插件**：§8 三个文件 + **`skills/tinydo/SKILL.md`（降级通道，与插件同包分发）** + 安装到 profile + 端到端验收。

**验收标准（全部可复现）**

1. 在 DSH 里说「帮我看看今天还有什么没做完」→ 调用 `tinydo_list_tasks`，回答内容与 App「今天」视图一致。
2. 「把『写周报』拆成 3 个子任务，都挂在它下面」→ `add_task`×3（`parentId`）→ **App 窗口未聚焦也实时出现**，无刷新。
3. 「把这周没做的挪到下周」→ list + update 批量 → 日期在 App 与云端同步后一致。
4. 「删掉刚才那个」→ `delete_task` → App 里消失，`tinydo log` 能看到审计；云端 tombstone 正常传播。
5. **App 未启动**时执行 `tinydo list --today` → 自动拉起 App 并返回结果
   （实测开发态冷启动 7.5s；打包版更快。注意：拉起的是已安装的 TinyDo，
   若那份安装包早于本功能，则不会有本地 API——报错文案已提示更新）。
6. 关掉设置里的「外部助手」开关 → 所有工具立刻返回 403 且错误文案明确，DSH 不会静默失败。
7. `tinydo doctor` 能一眼看出：App 在跑、端口/token 有效、dataReady、同步是否启用、插件版本。
8. **降级通道有效**：临时把 `index.js` 里的 `ctx.tools.register` 改成抛错（模拟 DSH 破坏性升级）→ DSH 仍能读
   `skills/tinydo/SKILL.md` 并**通过 bash 调 `tinydo` CLI 完成同一个操作**，宿主不报崩溃。

## 10. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 窗口被关闭导致桥断 | 主进程按需创建隐藏窗口，等 `did-finish-load` + `dataReady` 再转发（§5） |
| App 与外部同时改同一条任务 | 沿用现有 `updatedAt` LWW，不引入新语义；PATCH 只改传入字段，避免整条覆盖 |
| DSH 插件与宿主版本漂移 | 插件零依赖、只用 `ctx.tools.register`；`dsh.compatibility` 声明支持区间；注册失败只打日志不影响宿主；必要时退化为「CLI + skill」 |
| 工具太多模型乱选 | Phase 1 冻结 9 个工具，全部一句话描述、参数面收窄 |
| 误删 | 软删除（tombstone）+ 级联提示 + 审计可查；设置面板可一键关闭外部写入 |
| token 泄漏 | 文件 0600、只监听 127.0.0.1、每次启动轮换、可手动吊销 |
| 启动瞬间数据未就绪 | `/health` 暴露 `dataReady`，503 + 指数退避；客户端最多重试 ~5s |

## 11. 后续（不在本期）

- **Phase 2**：headless 模式——CLI 直接作为同步端读写云端 `data.automerge`（复用 `updatedAt` LWW 合并），
  免 App 常驻；需单独存放七牛密钥，仍走同一 client 接口，插件零改动。
- **Phase 3**：把 App 内小柴的 actions 也接到这层工具上（同一个 `local-api` 分发），让小柴与 DSH 共享能力，
  同时保留"必须确认"的差异（小柴面向不确定用户，DSH 面向明确指令）。
- 笔记 / 清单 / 标签工具；`tinydo plan`（按负载重排一周）；`/v1/undo`（基于审计回滚一次写入）。

## 12. 实施结果（2026-09-18）

**交付物**

| 位置 | 内容 |
| --- | --- |
| `electron/local-api.js` | 本地 HTTP 服务：`127.0.0.1` + token 轮换 + 发现文件（0600）+ 审计 JSONL + 转发与按需隐藏窗口 |
| `electron/main.js` / `preload.js` | 桥接挂载、`local-api:*` IPC、`TINYDO_USER_DATA`（测试隔离） |
| `src/services/task-query.ts` | 视图过滤 + 层级排序的**单一真相**（UI 与外部助手共用；HomePage 已改为调用它） |
| `src/services/local-api.ts` | 渲染层分发：9 个操作、参数校验、级联语义复用 store、审计摘要 |
| `src/views/SettingsView.vue` | 「外部助手」面板：开关 / 端口 token / 活动日志 / 吊销 / 安装指引 |
| `agent/lib/client.mjs` | 零依赖客户端：发现 / 自动拉起（`open -a TinyDo`，开发态 vite+electron）/ 401 重试 / 错误映射 |
| `agent/cli.mjs` + `agent/tinydo` | `tinydo` CLI：list/get/add/edit/done/rm/bulk/stats/log/doctor，支持 `--json`/`--dry-run` |
| `agent/dsh-plugin/` | DSH 插件（9 工具）+ `skills/tinydo/SKILL.md` 降级通道 + 自检清单 README |
| `agent/selftest.mjs`、`agent/tests/*` | 三套自检（见下） |

**验证（对着真实运行的 App，隔离 profile，未触碰真实数据）**

| 套件 | 命令 | 结果 |
| --- | --- | --- |
| 接口端到端 | `node agent/selftest.mjs` | **36/36**：鉴权、幂等、父子、更新、级联完成、批量 dry-run、视图/搜索、统计、错误映射、级联删除、审计 |
| 插件端到端 | `node agent/tests/plugin-e2e.mjs` | **25/25**：9 工具注册契约、全部工具真实读写、幂等键、`actor=dsh` 审计、可读错误、注册失败不崩 |
| 桥接单元 | `node agent/tests/bridge-unit.mjs` | **13/13**：开关→监听/停止、发现文件生命周期与 0600、鉴权 401、转发与审计、关闭后客户端报 `DISABLED` |

**被验证推翻、已修正的三处**

1. `createTask` 把「未传的字段」当作非法值 → 缺 `startDate` 时 400（自检抓到）。
2. IPC 回包带 Vue 响应式代理 → `An object could not be cloned`（tags 数组）→ `toDto` 复制数组 + 主进程侧纯数据化。
3. 关掉开关后直接删发现文件 → CLI 只会说「App 未运行」，含糊；改为留 `enabled:false` 标记，客户端明确报 `DISABLED`。
4. 安装方式：`file:` 会拷贝插件目录，插件的 `../lib/client.mjs` 解析失败 → 改用 `link:`（文档与设置面板指引均已更正）。

**已知边界**：App 需在运行（CLI 自动拉起兜底）；工具注册需重启 DSH 才生效；
DSH 预览版升级后若工具面变化，跑一次 `tinydo-agent` 的 `npm test`（内含宿主 schema 校验器）或按它的
README 自检，期间可用 skill 降级通道。

**仓库拆分（2026-09-18）**：客户端 / CLI / DSH 插件已迁到独立仓库 **`tinydo-agent`**
（`lib/client.mjs` + `cli.mjs` + `index.js` + `skills/` + 自有自检），并补齐了可发布元数据
（`bin` / `files` / `dsh.bundle.patch` / `engines.dsh` / `dshhub` / `keywords` / `license` / `repository`）。

- **本仓库（App 侧）只保留**：`electron/local-api.js`、`src/services/local-api.ts`、
  `src/services/task-query.ts`、设置面板、以及**自包含的协议契约测试** `tests/api-contract.mjs`
  与桥接单元测试 `tests/bridge-unit.mjs`（都不再依赖客户端代码）。
- **跨仓库的接口只有 HTTP 协议**：`GET /health` 返回 `api: 1`；客户端声明「需要 TinyDo ≥ 0.1.22」。
  两边独立发版，谁升级都不拖累对方；协议变更时同步改 `PROTOCOL_VERSION` 与契约测试。
- 迁移前的形态（插件作为 App 仓库子目录）无法发布：跨目录 `import '../lib/client.mjs'` 使其不自包含，
  且缺市场收录所需元数据。

**自动拉起实测**：清空发现文件、App 未运行时执行 `tinydo list --today` →
自动启动（vite + electron）→ 7.5 秒内返回结果。打包版路径走 `open -a TinyDo`，
`open` 不继承调用方环境变量，因此 `TINYDO_*` 隔离变量只对开发态拉起生效（测试用）。

**8 条验收标准的落地情况**

| # | 标准 | 状态 |
| --- | --- | --- |
| 1 | 「今天还有什么没做完」→ 与 App 视图一致 | ✅ `queryTasks` 单一真相 + 自检/插件测试覆盖 |
| 2 | 拆成 3 个子任务挂父任务，界面实时出现 | ✅ 写入走同一 store（`addTask`+`parentId`），UI 与同步链路不变 |
| 3 | 「这周没做的挪到下周」→ 批量改期 | ✅ `update_task` / `tinydo edit`（含日期、优先级） |
| 4 | 删除 → App 消失 + 审计可查 | ✅ 级联软删除 + `tinydo log` / `recent_changes` |
| 5 | App 未运行时自动拉起 | ✅ 实测 7.5s（开发态）；旧版安装包会提示更新 |
| 6 | 关掉开关 → 明确报错不静默 | ✅ 留 `enabled:false` 标记，客户端报 `DISABLED`（bridge-unit 覆盖） |
| 7 | `tinydo doctor` 一眼可见 | ✅ 发现文件/健康/数据层/问题列表 |
| 8 | 降级通道（插件失效仍能用 CLI） | ✅ CLI 全链路独立可用；skill 随插件分发；注册失败不崩（测试覆盖）。**注意**：DSH 内实际看到 9 个工具需重启 DSH 一次 |
