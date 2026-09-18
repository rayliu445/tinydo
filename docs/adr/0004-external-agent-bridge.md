# ADR-0004: 为外部 Agent 开放「本地桥接 API + CLI + DSH 插件」

## 状态

**已接受并实施**（Phase 1 完成，74 项自检通过；Phase 2 headless 未做）

## 日期

2026-09-16

## 背景

- 小柴（App 内置 AI）受限于「单轮 prompt + actions 协议」：只能做拆解、改优先级/日期这类固定动作，
  没有工具循环、没有文件/终端/搜索能力，实际能力显著弱于 DSH 这类 Agent。
- 用户日常主力 Agent 是 DSH（DeepSeek Harness），希望「用 DSH 驱动 TinyDo」，而不是把 App 做成一个弱 Agent。
- TinyDo 追求 less is more，不应为了 AI 能力把 App 本身做重。

调研结论（决定了技术路线）：

1. **真正的数据源在渲染层**：`src/services/data-access.ts` 的 sql.js + IndexedDB（Electron 下同样是渲染层
   IndexedDB）。`electron/main.js` 里的 `db.json` + `get-todos/add-todo/...` IPC 是 SQLite 迁移前的遗留，
   渲染层已完全不调用，不能作为接入面。
2. **云端是单文件快照**：`data.automerge` 实为「JSON 快照 + `updatedAt` 级 LWW」
   （`automerge-replacement.ts` 是自研轻量实现），并非真 Automerge。
3. **DSH 是插件（cordis bundle）架构**：插件以 npm 包形式挂在 `~/.dsh/profiles/<p>/package.json` 的
   `dsh.profile.bundles`，通过 `dsh.bundle.patch` + `cordis.patch.yml` 注入；宿主提供
   `ctx.tools.register({ name, description, parameters, execute, presentCall, ... })` 注册原生工具
   （已逐一核对 `@liustack/modlens` 的实现）。当前 DSH 安装**不含 MCP 客户端**（README 中 MCP 属可选 overlay），
   因此走 MCP 不是今天可用的路径。

## 决策

1. **传输层：App 内本地桥接**。Electron 主进程监听 `127.0.0.1`，暴露 HTTP API；每次请求经 IPC 交给
   **渲染层真实数据层**执行。App 始终是唯一写入者 → UI 实时刷新、自动走现有云同步、离线可用、业务逻辑零重复。
2. **凭据与发现**：`~/.tinydo/local-api.json`（权限 0600）写入 `{ port, token, pid, version, startedAt }`；
   每次启动重新生成 token。CLI/插件读该文件；App 未运行时由 CLI 自动拉起并轮询健康检查。
3. **一个客户端，两个前端**（仓库内新增 `agent/`）：
   - `agent/lib/client.mjs`：零依赖（node builtins）HTTP 客户端 + 自动拉起；
   - `agent/cli.mjs`：`tinydo` CLI（人类/脚本/排错用，`--json`、`--dry-run`）；
   - `agent/dsh-plugin/`：DSH 插件，注册原生工具（**主要交付物**）。
4. **工具面（Phase 1 只做任务域）**：list / get / add / update / complete / delete / bulk_add / stats / recent_changes，
   共 9 个，冻结数量，避免工具过多导致模型选择困难。
5. **写权限全开**（用户确认）：含软删除（与 App 一致：删除父任务级联后代）；所有写入落审计
   （actor、时间、命令、任务 id、前后值摘要），App 设置页新增「外部助手」面板：总开关 + 活动日志 + 吊销 token。
6. **安全边界**：只监听 127.0.0.1；Bearer token；不提供远程访问；不在 App 里保存任何 DSH 侧凭据。

## 后果

**收益**：DSH 获得结构化、可组合的任务工具（真正的工具循环 + 分析能力）；App 保持轻；不引入第二份数据源；
不复制同步/合并逻辑。

**代价**：App 需在运行（由 CLI 自动拉起缓解）；请求路径包含渲染层，窗口被关闭时主进程需按需重建隐藏窗口；
插件与 DSH 版本存在兼容面。

**依赖是单向的：插件 → CLI 客户端 → 本地 HTTP API**，反向不成立。因此 DSH 侧无论怎么变，最坏结果都是
"退回手动挡"（用 CLI），不会伤到数据；删掉插件也不影响另外两层。插件按「薄壳 + 双保险」实现：
只用 `ctx.tools.register` 一个宿主方法、注册失败 try/catch 软失败、同包再附一份 `skills/tinydo/SKILL.md`
作为不依赖工具 API 的降级通道（生态既有做法：modlens 同样是工具 + 技能双份）。详见设计文档 §8.1。

**本期不做**：headless 云端直连（免 App 运行）、笔记/清单/标签管理、任务手动排序、把数据暴露给公网。

## 相关

- 设计细节与接口契约：`docs/agent-bridge-design.md`
- 数据层与同步：`docs/sync-engine-design.md`、`docs/adr/0003-automerge-data-layer.md`
