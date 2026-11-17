## Purpose

让宿主拥有「未来某刻再叫醒这张工单」的持久状态：schedule 在到点前只占一行 due 记录，
到点后以一条 Input 走既有投递路径恢复 worker；重启、暂停、错过、取消和已结束工单都有确定行为。

## ADDED Requirements

### Requirement: 未来唤醒持久化

The system SHALL 在 `orchestrator_schedule` 返回前，把一次未来唤醒持久化为 `effect` 表中
`kind = "agenda"` 的一行，`key` 为 `ticket:<ticket_id>:<key>`，`due` 为请求时刻归一化后的
UTC ISO 8601 字符串（`...Z`）。

#### Scenario: 排一次两小时后的复查

- **GIVEN** 一张 `liveTicket` 为真的工单，当前时刻为 `T`
- **WHEN** 主会话调用 `orchestrator_schedule(ticket_id, "ci", "T+2h", "确认 CI 结果")`
- **THEN** `effect` 表中存在一行 `kind = "agenda"`、`key = "ticket:<ticket_id>:ci"`、
  `due = "T+2h"`，且到点前该工单没有新增 assignment、没有新的 worker turn

#### Scenario: 同一 key 只保留一行

- **GIVEN** 工单已有一条 `key = "ticket:<ticket_id>:ci"`、`due = "T+2h"` 的 agenda
- **WHEN** 主会话再次调用 `orchestrator_schedule(ticket_id, "ci", "T+3h", "再看一次 CI")`
- **THEN** 该工单仍只有一行 agenda，`due = "T+3h"`、理由为新理由，`T+2h` 不产生 Input

### Requirement: 到点投递一条 Input

When an `agenda` row becomes due and the ticket is live, the host SHALL append exactly one
TicketInput of kind `agenda` and deliver it through the existing `tickets.addInput` path
(`executor.deliver` when running, `executor.start` when a pending assignment can start);
the row MUST be removed after the Input is recorded.

#### Scenario: 到点恰好唤醒一次

- **GIVEN** 工单有一条 `due = "T"` 的 agenda，`T` 之前没有投递
- **WHEN** Passes 在 `T` 或之后扫描到该行
- **THEN** 工单的 `inputs` 恰好新增一条 `kind = "agenda"` 的 Input，
  `undelivered` 或 worker 会话收到它，agenda 行被删除；下一次扫描不再产生第二条 Input

#### Scenario: 等待期间不产生模型调用

- **GIVEN** 距 `due` 还有两小时
- **WHEN** Passes 连续扫描
- **THEN** 该工单没有新的 assignment、没有新的 worker 会话消息，agenda 行仍然只被读取

### Requirement: 重启后仍然触发

A persisted agenda row MUST survive a host restart, and an agenda whose `due` passed while
the host was down SHALL fire once after restart.

#### Scenario: 重启跨过到期时刻

- **GIVEN** agenda 行已落盘，`due = "T"`
- **WHEN** 宿主在 `T` 之前停止、在 `T` 之后重启
- **THEN** 新宿主第一次扫描时投递一条 `agenda` Input，且只投递一条

#### Scenario: Worker 会话不存在时重新建立

- **GIVEN** agenda 到点时工单仍有 running assignment，但 worker 会话已被外部删除
- **WHEN** `deliverQueued` 处理该 Input
- **THEN** executor 按现有逻辑重建 worker 会话并投递，不丢弃 agenda Input

### Requirement: 暂停与错过策略

While `policy.paused` is true, the host MUST NOT deliver any due agenda. On resume the host
SHALL deliver at most the latest agenda per key, never one Input per missed interval.

#### Scenario: 暂停三天后恢复

- **GIVEN** 一条 `due = "T"` 的 agenda，宿主在 `T` 前暂停并在三天后恢复
- **WHEN** 恢复后的第一次扫描
- **THEN** 工单收到一条 `agenda` Input，而不是每天一条；agenda 行被删除

#### Scenario: 暂停期间不唤醒

- **GIVEN** `policy.paused` 为真，agenda 已到期
- **WHEN** Passes 扫描
- **THEN** 没有 `agenda` Input、没有 worker turn，agenda 行保留到恢复

### Requirement: 不打断人的问题

The host SHALL defer a due agenda Input while the ticket is waiting for a person's answer (the
current `attention`, or a blocking person Question after `orchestrator-consult`), until that
answer arrives; it MUST NOT resume the worker or bypass the question to deliver the agenda.

#### Scenario: 工单正在等人答复

- **GIVEN** 工单正在等待人的答复（attention，consult 后为 blocking person Question），agenda
  在等待期间到期
- **WHEN** Passes 扫描到 agenda
- **THEN** 没有 `agenda` Input、没有新的 worker turn；人答完后，下一次扫描投递恰好一条
  `agenda` Input

#### Scenario: 没有阻塞等待

- **GIVEN** 工单没有 attention、也没有阻塞的 person Question，agenda 到期
- **WHEN** Passes 扫描到 agenda
- **THEN** 立即投递 `agenda` Input，不额外等待

### Requirement: 已结束工单不复活

A due agenda for an ended or stopped ticket SHALL be discarded without resuming the ticket,
and the main session SHALL receive one `agenda.dropped` notice naming the ticket and key.

#### Scenario: 工单先被停止

- **GIVEN** 工单已 `ended`（`by: "human"`），仍有一条未来 agenda
- **WHEN** agenda 到期
- **THEN** 工单保持 ended，没有 `agenda` Input，主会话收到一条 `agenda.dropped` notice

#### Scenario: 丢弃只通知一次

- **GIVEN** 已结束工单的 agenda 已被丢弃
- **WHEN** 后续 Passes 扫描
- **THEN** 不再产生第二条 notice

### Requirement: 取消

`orchestrator_schedule` with `cancel: true` SHALL delete the pending agenda row and MUST NOT
deliver any Input for it.

#### Scenario: 取消后不唤醒

- **GIVEN** 工单有一条未到期的 agenda
- **WHEN** 主会话调用 `orchestrator_schedule(ticket_id, key, at, reason, true)`
- **THEN** 返回 `{ "cancelled": true }`，`effect` 表中该行不存在，之后到点也不产生 Input

### Requirement: 工具校验

The `orchestrator_schedule` tool MUST reject an unknown ticket, an ended ticket, an invalid
`at`, an empty `reason`, and a `key` outside `[a-z0-9][a-z0-9_-]{0,63}` with a structured
error code (`notFound`, `ticketEnded`, `invalidTime`, `invalidReason`, `invalidKey`) and MUST
create no row. An `at` in the past MUST be accepted and fire on the next scan.

#### Scenario: 非法输入不落盘

- **GIVEN** 主会话调用 `orchestrator_schedule`，`key` 为 `"CI 结果"` 或 `at` 为 `"明天"`
- **WHEN** 工具执行
- **THEN** 返回对应错误码，`effect` 表没有新增行，工单没有新 Input

#### Scenario: 过去时刻立即到期

- **GIVEN** 工单 live，`at` 为当前时刻之前一分钟
- **WHEN** 工具返回后的第一次 Passes 扫描
- **THEN** 投递一条 `agenda` Input，不返回错误

### Requirement: 可观察的待办 schedule

`orchestrator_read ticket/<id>` and `GET tickets/<id>` SHALL list pending schedules with
`key`, `at`, and `reason`; a fired or cancelled schedule MUST NOT appear.

#### Scenario: 读取工单看到待办

- **GIVEN** 工单有一条未到期 agenda
- **WHEN** 主会话读取 `ticket/<id>`
- **THEN** 返回的 `agenda` 数组包含该 `key`、`at`、`reason`

#### Scenario: 触发后不再列出

- **GIVEN** agenda 已投递或被取消
- **WHEN** 再次读取工单
- **THEN** `agenda` 数组不含该 key
