# autoloop 尚缺的四块能力

记录当前 SuperAgent 与 agent-autoloop v1.8.5 的差距，供后续补齐；本文只登记，不含实施计划。
现有 SQLite（`~/.dsh/state/superagent/orchestrator.sqlite`）继续承载工单、问题、回执与一次性
唤醒，不需要换成 agent-autoloop 的 `hub.db`。

## 1. 运行时间线

**现状**：报告、结束原因、投递状态会覆盖旧值；`OutboundMessage` 没有时间戳
（`src/core/ports.ts:72`），排障只能翻会话记录。

**缺口**：没有「这张工单为什么走到这里」的按时间排列的事实链，也没有 `why` / `runs` 入口。

**建议**：新增 append-only 的工单事实表，与业务写入同事务；覆盖触发、评估、建单、派工、
报告、问题与答复、投递、策略变更、结束。面板加折叠时间线，CLI 提供
`why <ticket-id> [--json]`。旧工单按需回填，缺失时间戳留空，不伪造。

**依赖**：无，可先做；后面三块都可以用它记录原因。

## 2. 定时事件源

**现状**：只有工单内的一次性 `agenda` 唤醒（`openspec/changes/ticket-agenda`），没有
「每天 9 点」「每小时」这类事件源；该提案也明确把 cron 留给后续。

**缺口**：窗口外没有时间维度，定时任务只能靠系统 cron 或人工触发。

**建议**：内置 `schedule` Source，配置 `{id, enabled, cron, timezone, title, text}`；5 段
cron + IANA 时区；到点产生 Trigger（`source=schedule`、`type=schedule.fire`、线程
`schedule:<job>`、无发送者），只补最近一次错过的触发；只产 Trigger，不直接派工。

**依赖**：无；与工单内 `agenda` 互补，不替代。

## 3. 按规则派工

**现状**：窗口事件必须先由模型评估才能建工单；`!dispatch` 只是人手打的前缀。

**缺口**：CI 失败、Issue 打开这类确定性事件仍要消耗一次模型判断，也无法用配置声明
「什么事件交给谁、做什么」。

**建议**：独立 `dispatch.rules` 配置块（不要混进给模型看的 `policy.rules`）。规则含
`when{source,types}`、`brief`、`to`、`maxActive`、`tell`；只匹配非人类触发，恰好一条命中时
机械建单，Mandate 固定 `inferred` 并记录规则版本；零条回退模型评估，多条记歧义后回退；
到容量上限时可见地不接、保留触发待人 requeue，不静默丢弃。

**依赖**：定时事件源提供 `schedule.fire`；GitHub Source 先补事件类型。

## 4. 卡片点选

**现状**：问题已经能带 `options` / `recommend`，但面板只显示纯文本横幅
（`src/client/ticket.tsx:144`），人要在会话里重打选项。

**缺口**：结构化的选项没有变成可点的按钮，也没有「同一问题只答一次」的界面约束。

**建议**：只在工单详情页把选项渲染成按钮，推荐项只标记不自动选；新增面板接口
`POST /orchestrator/api/tickets/:id/questions/:qid/answer`，`{option? | text?}` 二选一，
loopback + same-origin，第一次答复生效并写回 `question-answer:<id>` Input；重复同答幂等，
改答/已结案返回 409。飞书仍是纯文本，不做互动卡片。

**依赖**：`orchestrator-consult` 先落地；所有者明确「先不加」，确认后再实施。

## 建议顺序

`运行时间线` → `定时事件源` → `按规则派工` → `卡片点选`。

## 明确不做

- 不引入 agent-autoloop 的 `rules.json` 作为第二套运行时，也不替换现有 SQLite。
- 不把编排整体换成纯规则引擎；人类请求与歧义事件仍由模型评估。
- 不做飞书互动卡片、系统 cron/launchd、任意 shell/HTTP 定时任务。
- 不做同组串行、按 subject 分道、暂停/重放/手动运行等 autoloop 运维面。
- 本文件不承诺排期，每块能力实施前再单独定方案。
