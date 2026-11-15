# 工单 95a77ca9 生产验收证据（local-dispatch-source 验收项 4–11 + 出厂核对）

采集环境：宿主实例 `superagent`（http://127.0.0.1:3082 ，spawner 面板 `host.version=0.9.12`，宿主进程 2026-11-15 22:34:00 起）。所有请求 `GET/PUT /orchestrator/api/*`，带头 `x-orchestrator-request: 1`。时间为本地（Asia/Shanghai）。

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 4 | `GET /sources` 含 local，state=ready | ✅ | `2026-11-15-2237-sources-post-restart.json`：local ready，health `Main-session intake: 1 ingested, 1 filtered` |
| 5 | `GET /settings` 含 source:local，`policy.sources.local.allowed` 含所有者 | ✅ | 同目录 `…-settings-post-restart.json`：sources 含 `local`（rev 0，enabled，fields 含 allowed 行）；`blocks.policy.value.sources.local = {allowed:[{id:"owner",name:"Owner"}],admission:{}}`。提案原文写 open_id `ou_b0cfd…`，实现为固定 `id:"owner"`（design.md Open Question #4 结论），行为等价：主会话 GUI 用户即部署所有者。feishu 条目存在且可空（enabled:false） |
| 6 | 无 @ 显式候选 | ✅ | 本工单自身：source trigger `21abc7ea…` 来自 thread `local:orchestrator-066e…`，owner 消息「就这么办」无任何 @ 即成为派单候选并建单。`…-tickets.json` 为证 |
| 7 | Apply 即派工、无按钮 | ✅ | 同上：owner 的 Apply（「就这么办」）直接产出本 working 工单，全程无按钮；后续「done」等消息作为同线程 follow-up 到达既有工单 |
| 8 | 重复 Apply 幂等 | ✅ | `…-tickets.json`：该工作只有一张工单、无重复；后续多条主会话消息均落在同一工单（accept 按 trigger_id 幂等，prompts/dispatch.md 明文） |
| 9 | 回声不自建单 | ✅ | local health `1 ingested, 1 filtered`：worker 报告/回显计入 filtered，不建单；ticket 列表无自发工单 |
| 10 | feishu off 非 error + 重复 6–7 | ✅ | 22:30 `PUT /settings/source:feishu` `enabled:false`（rev3→4，saved）；`2026-11-15-2231-sources-after-feishu-off.json` 与重启后 `…-2237-sources-post-restart.json`：feishu=off（非 error）、github/local=ready；其后 6–7 类消息继续正常建单/跟进（本工单即例） |
| 11 | prompts 含 Apply→accept 段与不扩写约束 | ✅（实现位置差异，如实记录） | `2026-11-15-2237-prompts-post-restart.json`：`current` rev 19，`defaultChanged: []`；`parts` 中 `runtime/dispatch`（8070 字符）含「The main session's own GUI is the local Source … 落盘, Apply, 就这么做, go ahead — route kind accept …」与「Do not expand a request's scope, add implementation plans, acceptance criteria or policy checklists」。该段位于仓库默认 `prompts/dispatch.md`（runtime part），不在 `current.config` overlay（overlay 仅 communication/scope/delivery/skills）——提案字面写 current.config，实现落在 runtime 默认，效果等同且可审计（全文见 `…-dispatch-part.txt`） |

## 出厂核对（新实例 factory-check，2026-11-15 22:37–22:41）

面板 `POST /dsh-superagent-spawner/api?action=create` `{"name":"factory-check","repository":"","feishuChat":""}` → 实例起在 :3151，`settingsPushedAt` 有值、`inheritWarning:null`。首次 `GET /settings`（`…-2239-child-*.json`）：

- `blocks.policy.value.sources.local = {allowed:[{id:"owner",name:"Owner"}],admission:{}}` —— **模板直出**（spawner 0.9.12，PR spawner#14），无需运行期预置补救；
- executor 块 = `zai-coding-cn/glm-5.3`（高推理，maxWorkers 3）——模板快照跟进宿主 rev 22；
- `GET /prompts` `current.config` 与宿主完全相等（rev 19 内容），`defaultChanged: []`，runtime/dispatch 默认含 Apply→accept 段；
- github 条目 repository 为空 → 面板按设计 deferred（不推送、不告警），source 状态 `error/detail: Waiting for the deployment check`。

补全 repository（临时私有库 seabiscuit-agent/factory-check-95a77ca9，事后已归档）后 `GET /sources`（`…-2241-child-sources-final.json`）：**github ready**（0 notifications）、**local ready**（intake 计数 0/0，新实例主会话未开属正常）。

已知无害噪音：子实例自带 spawner 插件的「shared layer self-heal on mount failed: … set superagentSource」日志（子实例不需要自派工，不影响设置继承）。

## 相关文件

- `2026-11-15-2231-*`：feishu 关闭当时（sources/settings/prompts/dispatch-part）
- `2026-11-15-2237-*`：宿主重启后（sources/settings/prompts/tickets）
- `2026-11-15-2239-child-*`：新实例出厂首查（settings/sources/prompts）
- `2026-11-15-2241-child-*`：新实例接上 repository 后终态
- spawner 侧改动：seabiscuit-agent/dsh-superagent-spawner PR #14（已合并 cac8b50）
