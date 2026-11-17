## Purpose

让工单的可见消息由 host 从结构化 receipt 合成，而不是由模型自由写正文；空回合、内部载荷、
重复回复在 host 层被拒绝或去重，普通讨论不受影响。

## ADDED Requirements

### Requirement: 结构化回复 receipt

`orchestrator_reply` SHALL 接受 `purpose`（`"result"`、`"attention"`、`"answer"`）以及该用途
所需的结构化字段；MUST 返回 `receipt_id` 和 `status`（`"sent"`、`"queued"`、`"rejected"`）。
`result` MUST 引用 `ticket_id`；`attention` MUST 引用 `question_id`；`answer` MUST 引用原始
人类问题（`reply_to_trigger_id` 或 `trigger_id`）。

#### Scenario: 完成结果不写正文

- **GIVEN** 工单有一份 `ready` 报告，主会话调用
  `orchestrator_reply(purpose="result", ticket_id="t1")`
- **WHEN** 工具执行
- **THEN** host 从报告合成一条可见结果（含 state、summary、PR 链接），返回
  `status: "sent"` 和 `receipt_id`，模型没有提供正文

#### Scenario: 缺少引用被拒

- **GIVEN** 主会话调用 `purpose="attention"` 但没有 `question_id`
- **WHEN** 工具执行
- **THEN** 返回 `status: "rejected"`、`reason: "missingQuestion"`，outbox 没有新消息

### Requirement: Host 合成 result 正文

For `purpose="result"`, the host SHALL 从工单最新报告合成正文：至少包含报告 `state` 的
用户可读标签、报告 `summary`、以及存在的 PR 链接；MUST NOT 要求模型提供正文；MUST 对
`summary` 做内部载荷过滤。模型可提供可选 `note`（≤2 句），host MUST 过滤/限长后才拼入。

#### Scenario: 报告摘要含内部标记

- **GIVEN** 报告 summary 含 `||DSML||` 或 `"kind":"worker_report"`
- **WHEN** host 合成 result
- **THEN** 可见正文移除这些标记，只保留用户可读文字；消息仍只发一条

#### Scenario: 模型附注

- **GIVEN** 主会话给 result 传 `note: "需要你合并"`
- **WHEN** host 合成
- **THEN** 正文在报告摘要后包含该附注（过滤后），不超过 IM 字数

### Requirement: Host 合成 attention 正文

For `purpose="attention"`, the host SHALL 从存储的 Question 合成正文：问题文本、`options`、
`recommend`、`blocking`、升级理由（若有）；MUST NOT 接受模型另写的问题正文；MUST 使用
`attention-reply:<question_id>` 作为幂等 id。

#### Scenario: 升级问题带选项

- **GIVEN** 一条 `to: "person"` 的 Question，`options: ["v1", "v2"]`，
  `recommend: "v2"`，`context: "公开接口需人决定"`
- **WHEN** host 合成 attention
- **THEN** 正文包含问题、两个选项、推荐 v2 和升级理由；outbox id 为
  `attention-reply:<question_id>`

#### Scenario: 同一问题只发一条

- **GIVEN** 同一 Question 的 attention 已发送
- **WHEN** 再次调用 `purpose="attention"`
- **THEN** 不产生第二条 outbox 消息，返回 `status: "sent"` 且 `receipt_id` 相同

### Requirement: Answer 正文的校验

For `purpose="answer"`, the host SHALL 接受自由文本作为答复正文，但 MUST 校验非空、长度、
内部载荷和静默标记；MUST 确认引用的 trigger 是原始人类问题；MUST 使用
`reply:<trigger_id>:<payload hash>` 作为幂等 id。发送成功后才算送达。

#### Scenario: 空答复

- **GIVEN** 主会话调用 `purpose="answer"`，正文为空
- **WHEN** 校验
- **THEN** 返回 `rejected`/`emptyBody`，outbox 没有消息

#### Scenario: 答复引用原始问题

- **GIVEN** 人类 trigger `q1` 在等待答复
- **WHEN** 主会话调用 `purpose="answer"`，`reply_to_trigger_id: "q1"`，正文为答案
- **THEN** 消息发送到 `q1` 的通道，receipt id 固定；重复调用同正文不重复发送

### Requirement: 拒绝空回合与内部载荷

The host MUST 拒绝以下正文/合成结果：空字符串、仅 `NO_REPLY`/`END_OF_TURN`/
`END_OF_RESPONSE`/`SILENT`、包含 `||DSML||`、`"kind":"worker_report"`、
`"kind":"worker_attention"`、`{"ticket_id":` 或 `local-receipt:` 的内容。拒绝时 MUST NOT
发送任何可见消息，MUST 返回可纠正的错误，让主会话在同一回合重试。

#### Scenario: NO_REPLY

- **GIVEN** 模型调用 `orchestrator_reply(purpose="answer", text="NO_REPLY")`
- **WHEN** host 校验
- **THEN** 返回 `rejected`/`silentBody`，没有 outbox 行，模型可重试

#### Scenario: 内部载荷

- **GIVEN** 正文包含 `{"ticket_id":"t1","kind":"worker_report"}`
- **WHEN** host 校验
- **THEN** 返回 `rejected`/`internalPayload`，没有可见消息

### Requirement: 发送后结束回合

When a receipt is sent, the host SHALL 立即 `concludeTurn()`；同一回合后续的模型文本 MUST NOT
被当作工单更新投递。普通对话文本不因本规则被隐藏，但它不是工单消息。

#### Scenario: 先回复再复述

- **GIVEN** 主会话先成功发送 result receipt，随后在同一回合写了一段复述
- **WHEN** 回合继续
- **THEN** host 已结束回合，复述不产生第二条工单消息

### Requirement: 兜底 receipt

When a main-session turn ends and still owes a ready report without a receipt, the host SHALL
发一条 host 合成的 result receipt。对于 `to: "person"` 的未回答阻塞问题，host SHALL 发一条
host 合成的 attention。对于 `to: "orchestrator"` 的问题，host MUST NOT 编造答案；问题保持
开放并在面板可见。

#### Scenario: 模型完全不写

- **GIVEN** 工单 ready，主会话回合结束，没有调用 `orchestrator_reply`
- **WHEN** turn 结束
- **THEN** host 发一条 `result:<ticket_id>:<report_id>` 可见结果，内容来自报告

#### Scenario: 不替 orchestrator 答题

- **GIVEN** 一个 `to: "orchestrator"` 的阻塞问题，回合结束未回答
- **WHEN** turn 结束
- **THEN** 不发送任何伪造答案；问题保持开放，面板显示等待 orchestrator

### Requirement: Receipt 幂等

The host MUST 为每个 receipt 计算确定性 id，并在重复调用时复用同一 outbox 行：result 用
`result:<ticket_id>:<report_id>`，attention 用 `attention-reply:<question_id>`，answer 用
`reply:<trigger_id>:<payload hash>`。同一 id 已发送或已排队时 MUST NOT 新增消息。

#### Scenario: 重复结果

- **GIVEN** 同一报告已发过 result
- **WHEN** 再次调用 `purpose="result"`
- **THEN** outbox 行数不变，返回同一 `receipt_id`

### Requirement: 只约束工单消息

When a turn owes a report or question, the visible delivery MUST be a receipt. When no report
or question is owed, ordinary conversation MUST remain unchanged and MUST NOT be forced through
`orchestrator_reply`.

#### Scenario: 普通讨论

- **GIVEN** 没有待交付报告/问题的普通对话
- **WHEN** 主会话回复
- **THEN** 不要求 receipt，聊天行为与现在一致

### Requirement: 可观察的错误

`orchestrator_reply` SHALL 在拒绝时返回 `reason`（如 `emptyBody`、`silentBody`、
`internalPayload`、`missingQuestion`、`duplicate`、`notReady`），并 MUST NOT 把拒绝原因写成
可见消息。

#### Scenario: 错误可纠正

- **GIVEN** 正文含内部载荷
- **WHEN** 第一次调用被拒
- **THEN** 返回 `internalPayload`；主会话可在同一回合改写后重试，重试成功只发一条
