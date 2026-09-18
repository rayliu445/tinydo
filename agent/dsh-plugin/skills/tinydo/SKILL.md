---
name: tinydo
description: "操作本机 TinyDo 任务清单（读写待办、拆任务、改日期优先级、统计）。当用户让你查看/整理/新增/完成/删除待办，或问“今天还有什么没做”“帮我规划这周”这类需要真实任务数据的问题时使用。优先使用 tinydo_* 工具；若这些工具不存在（插件未加载或 DSH 升级后失效），改用本技能里的 tinydo CLI（bash 调用，能力等价）。"
compatibility: 需要本机 TinyDo 桌面端（可自动拉起）与 Node 18+；接口只监听 127.0.0.1。
allowed-tools: Bash
---

# TinyDo 任务清单技能

TinyDo 是用户本机的待办清单应用（SQLite + 云同步）。这份技能让 Agent 读写它——**App 始终是唯一写入者**，
所以外部改动会立刻出现在用户界面上并照常同步。

## 优先：用原生工具

如果下方工具可用，直接用，不要绕 CLI：

- `tinydo_list_tasks`（视图/关键词/清单/标签过滤）
- `tinydo_get_task` / `tinydo_add_task` / `tinydo_update_task`
- `tinydo_complete_task`（级联子任务）/ `tinydo_delete_task`（软删除，级联）
- `tinydo_bulk_add_tasks`（≤50 条，拆解任务主力）
- `tinydo_stats` / `tinydo_recent_changes`

## 降级：用 CLI（工具不可用时）

DSH 升级后插件可能暂时失效（预览版工具面会变）。此时**不要放弃**，用 bash 调 CLI：

```bash
# 若 tinydo 已在 PATH：
tinydo list --today
# 否则用仓库里的启动脚本（<skill-dir> 是本 SKILL.md 所在目录）：
bash <skill-dir>/../../../tinydo list --today --json
```

常用命令：

```bash
tinydo list --today                # 今天到期（含已完成）
tinydo list --next7                # 最近 7 天
tinydo list --search 周报 --json    # 关键词搜索，机器可读
tinydo add "写周报" --due 明天 --priority high
tinydo add "写大纲" --parent <父任务id> --due 2026-09-20
tinydo edit <id> --due 2026-09-25 --priority mid
tinydo done <id>                   # 完成（级联子任务）；--undo 取消完成
tinydo rm <id> --yes               # 软删除（级联）；不加 --yes 只预览
tinydo bulk add --file tasks.json --dry-run   # 批量新增，先预览
tinydo stats
tinydo log --limit 20              # 谁改了什么（审计）
tinydo doctor                      # App/端口/token/数据层自检
```

## 硬规则

1. **先查再写**：任何 update/complete/delete 之前，先用 `tinydo_list_tasks`（或 `tinydo get`）确认 id 真实存在。
   工具会拒绝不存在的 id，别猜。
2. **写操作后如实汇报**：说清楚改了哪条、从什么改成什么；用户问“你刚才动了什么”就用 `tinydo_recent_changes` / `tinydo log`。
3. **删除要谨慎**：只在用户明确指向某条任务时删除；删除会连带子任务，且工具层面不可撤销（软删除可在 App 里恢复）。
4. **日期只用 YYYY-MM-DD**；优先级 0 无 / 1 低 / 3 中 / 5 高（CLI 里也可写 none/low/mid/high）。
5. **批量优先**：拆解任务用 `tinydo_bulk_add_tasks`（或 `tinydo bulk add`），别一条条发几十次。
6. **失败不要瞎猜**：CLI 的报错已带原因和提示（例如 `TASK_NOT_FOUND` → 先 list 拿有效 id）。
   如果报 App 未运行，运行 `tinydo doctor` 看自检结果，而不是反复重试。
