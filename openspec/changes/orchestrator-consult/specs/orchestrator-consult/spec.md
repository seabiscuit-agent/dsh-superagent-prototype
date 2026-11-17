## Purpose

让 worker 的问题成为工单上的一等多条状态：可以问主会话或人，带选项和推荐，有问题 id 和 key；
答复带依据写回工单，并作为一条 Input 唤醒 worker；未决问题可升级、可结案，面板能区分在等谁。

## ADDED Requirements

### Requirement: 多问题与双目标

`Ticket` SHALL 用 `questions: Question[]` 保存未决与已结案的问题；每个 `Question` MUST 包含
`id`、`from`、`to`（`"orchestrator"` 或 `"person"`）、`question`、`blocking`、`createdAt`，
并可包含 `key`、`options`、`recommend`、`context`、`triggerId`、`assignmentId`、`answer`、
`answeredBy`、`answeredAt`、`basis`、`resolution`。同一工单 MUST 允许同时存在多条未决问题。

#### Scenario: 两条问题同时打开

- **GIVEN** 一张 running 工单
- **WHEN** worker 先提一个非阻塞问题，再提一个阻塞问题
- **THEN** `ticket.questions` 有两条未结案记录，`to` 分别为各自目标，前一条不被覆盖

#### Scenario: 已结案问题保留可查

- **GIVEN** 一个问题已被回答并结案
- **WHEN** 读取 `orchestrator_read ticket/<id>`
- **THEN** 该问题仍在 `questions` 中，带 `answer`、`answeredBy`、`answeredAt` 和
  `resolution: "answered"`，但不再计为未决

### Requirement: Worker 可以直接问 orchestrator

`orchestrator_report` SHALL 接受 `question`（问题文本）、`question_for`（`"orchestrator"` 或
`"person"`，缺省 `"person"`）、`options`、`recommend`、`key`、`context`。`human_action` 是
`"person"` 的兼容别名；`question` 与 `human_action` 同时给出时报告 MUST 被拒绝。当
`question_for: "orchestrator"` 时，问题 MUST NOT 要求 `question_for_trigger_id` 人或可回复通道，
MUST NOT 产生 outbox/IM，MUST 以 `worker_question` relay 交给主会话。

#### Scenario: 问测试放哪

- **GIVEN** worker 在 `blocked` 报告中给出 `question: "测试放哪"`、
  `question_for: "orchestrator"`、`options: ["tests/", "src/"]`、`recommend: "tests/"`
- **WHEN** `orchestrator_report` 执行
- **THEN** 工单新增一条 `to: "orchestrator"`、`blocking: true` 的 Question，主会话收到
  `worker_question` relay，outbox 没有新增待发送消息

#### Scenario: 直接问人保持旧行为

- **GIVEN** worker 给出 `human_action`、`question_for: "person"`、`question_for_trigger_id`
- **WHEN** 报告执行
- **THEN** 问题 `to: "person"`，走现有 attention 路径；没有人类 trigger 或通道时报告被拒绝

#### Scenario: 两种问题文本同时给出被拒绝

- **GIVEN** worker 同时给出 `question` 和 `human_action`
- **WHEN** `orchestrator_report` 执行
- **THEN** 返回 `ambiguousQuestion`，不创建 Question、不投递 Input

### Requirement: 主会话在授权内回答

`orchestrator_answer(question_id, answer, basis)` SHALL 只接受未结案且 `to: "orchestrator"`
的问题，MUST 要求非空 `answer` 和非空 `basis`。成功时 MUST 记录 `answeredBy:
"orchestrator"`、`answeredAt`、`basis`、`resolution: "answered"`，MUST 追加一条
`kind: "answer"` 的 TicketInput（id 为 `question-answer:<question_id>`，含 `questionId`、
`text`、`basis`、`answeredBy`），并 MUST NOT 写 outbox 或发 IM。

#### Scenario: 授权内确认推荐

- **GIVEN** 一条 `to: "orchestrator"` 的开放问题「测试放哪」，推荐 `tests/`
- **WHEN** 主会话调用 `orchestrator_answer(question_id, "放 tests/", "mandate: 测试位置属实现选择")`
- **THEN** 问题变为 answered，记录依据；工单新增一条 `answer` Input 并投递给 worker；
  outbox 没有新消息；`question.answered` 事件带 questionId 和 basis

#### Scenario: 空依据被拒绝

- **GIVEN** 同一条开放问题
- **WHEN** 主会话调用 `orchestrator_answer(question_id, "放 tests/", "")`
- **THEN** 返回 `emptyBasis`，问题仍开放，没有 `answer` Input

#### Scenario: 不替人回答

- **GIVEN** 一条 `to: "person"` 的开放问题
- **WHEN** 主会话调用 `orchestrator_answer`
- **THEN** 返回 `notOrchestratorQuestion`，不写答案、不投递 Input

### Requirement: 超出授权时升级给人

`orchestrator_escalate(question_id, reason)` SHALL 只接受未结案且 `to: "orchestrator"` 的问题，
MUST 要求非空 `reason`。成功时 MUST 把 `to` 改为 `"person"`，把升级理由记入 `basis` 或
`context`，并按现有 attention 路径发出一条带问题、`options`、`recommend`、升级理由的消息；
同一 question id 的 attention MUST 只发一次。发送失败时问题保持 `to: "person"` 但未送达，
返回值 MUST 说明未送达。

#### Scenario: 改公开 API 的提问升级

- **GIVEN** worker 问「把公开 API 改成 v2」，`to: "orchestrator"`
- **WHEN** 主会话调用 `orchestrator_escalate(question_id, "公开接口必须由人决定")`
- **THEN** 问题 `to: "person"`，`basis` 为理由；所有者收到一条 attention，包含问题、
  选项、推荐和升级理由；worker 仍在等待，没有 `answer` Input

#### Scenario: 重复升级不重复发

- **GIVEN** 同一问题已升级并已发送 attention
- **WHEN** 再次调用 `orchestrator_escalate`
- **THEN** 不产生第二条 outbox 消息，返回 `alreadyPerson`

### Requirement: 人的答复回到 worker

The host SHALL 在 `orchestrator_reply purpose="attention"`（按 `question_id` 或精确问题文本
定位到一条开放的 person Question）发送成功后记录 `answeredBy: "person"`、`answeredAt`、
`resolution: "answered"`，并追加一条
`kind: "answer"` 的 TicketInput（id 为 `question-answer:<question_id>`）投递给 worker；
同一 question id MUST NOT 产生第二条答复 Input。发送失败时问题保持开放。

#### Scenario: 人答完后 worker 继续

- **GIVEN** 一条 `to: "person"` 的开放问题，所有者回复「用 tests/」
- **WHEN** attention 消息发送成功
- **THEN** 问题记录 person 答复；worker 收到一条 `answer` Input，内容含答案和问题 id；
  配送重试不会产生第二条 Input

#### Scenario: 发送失败不结案

- **GIVEN** 一条 `to: "person"` 的开放问题，通道不可用
- **WHEN** 回复尝试发送并失败
- **THEN** 问题仍开放，没有 `answer` Input，主会话/面板能看到失败状态

### Requirement: 同 key 只保留一个未决问题

Questions with the same `key` on one ticket SHALL 去重：若同 key 已有未结案问题，新的报告
MUST 更新该问题的问题文本、`options`、`recommend`、`context`、`blocking` 和 `to`，MUST NOT
新增第二条；已结案（answered/resolved/withdrawn）的问题不参与去重，同 key 再问创建新问题。

#### Scenario: 重复问同一件事

- **GIVEN** 工单已有一条 `key: "test-location"` 的开放问题
- **WHEN** worker 再次报告 `key: "test-location"`，推荐改为 `src/`
- **THEN** `questions` 中该 key 仍只有一条，推荐更新为 `src/`，`id` 不变

#### Scenario: 结案后可以再问

- **GIVEN** `key: "test-location"` 的问题已 answered
- **WHEN** worker 再次报告同 key
- **THEN** 新增一条开放问题，旧问题保留 answered 记录

### Requirement: 提问者可以结案

`orchestrator_resolve(question_id)` SHALL 只允许提问的 worker 结案自己 assignment 的未决问题。
成功时 MUST 设 `resolution: "resolved"` 和 `resolvedAt`；若问题 `to: "person"` 且 attention
尚未发送，MUST 撤回；已发送的 MUST NOT 撤回，只是不再提醒。已回答的问题 MUST NOT 被改成
resolved。

#### Scenario: worker 自己找到答案

- **GIVEN** worker 提了一个非阻塞问题，之后自己查到了答案
- **WHEN** worker 调用 `orchestrator_resolve(question_id)`
- **THEN** 问题 `resolution: "resolved"`，主会话不再收到该问题的提醒；未发送的 attention 被撤回

#### Scenario: 别人的问题不能结案

- **GIVEN** 问题属于另一个 assignment
- **WHEN** 当前 worker 调用 `orchestrator_resolve`
- **THEN** 返回 `notAsker`，问题保持开放

### Requirement: 阻塞语义与投递

A Question SHALL 为 blocking 当且仅当它来自 `state: "blocked"` 的报告；来自
`state: "progress"` 的问题为非阻塞。`blocked` 问题存在时，automatic Input MUST 被 held，
worker MUST NOT 被新的 automatic Input 唤醒；`answer` Input 不是 automatic，MUST 能唤醒
worker。非阻塞问题 MUST NOT 阻止 automatic Input 投递。

#### Scenario: 阻塞问题挡住 note

- **GIVEN** 工单有一条 blocking 的 orchestrator 问题
- **WHEN** 一个 `note` Input 到达
- **THEN** note 进入 `undelivered` 但不启动/唤醒 worker；`answer` 到达时才投递

#### Scenario: 非阻塞问题不挡投递

- **GIVEN** 工单只有一条 `blocking: false` 的问题
- **WHEN** 一个 `note` Input 到达
- **THEN** note 按现有路径投递，worker 不被问题挡住

### Requirement: 旧 attention 迁移

A stored ticket with `attention` and no `questions` SHALL be read as if it had one Question
with `id` equal to the old attention id, `from: "worker"`、`to: "person"`、`blocking: true`、
`question` 和 `triggerId` 取自旧字段。未发送的 `attention-reply:<id>` MUST 仍能匹配并投递。

#### Scenario: 升级后旧工单仍可回复

- **GIVEN** 数据库里一张旧工单带 `attention: {id: "att-1", question: "用哪种测试框架？"}`
- **WHEN** 新代码读取该工单并回复该问题
- **THEN** 工单显示一条 `to: "person"` 的 Question（id 为 `att-1`），回复 id 仍为
  `attention-reply:att-1`，发送成功后 worker 收到 `answer` Input

### Requirement: 工单结束关闭问题

When a ticket ends, the host SHALL 把所有未决问题标为 `resolution: "withdrawn"`，撤回未发送的
person attention，MUST NOT 为该工单投递新的 `answer` Input，并 MUST NOT 因未决问题阻止结束。

#### Scenario: 带问题被停止

- **GIVEN** 工单有一条开放问题
- **WHEN** 工单被 `stop` 或 `ready` 结束
- **THEN** 问题变为 withdrawn，没有新的 answer Input，工单保持 ended

### Requirement: 可观察性与 stage

`orchestrator_read ticket/<id>`、`GET tickets/<id>` 和面板 SHALL 显示未决问题的 `id`、`to`、
`question`、`options`、`recommend`、`blocking`、`answeredBy`、`basis`。当工单唯一（或最老的）
blocking 问题目标为 orchestrator 时，stage MUST 为 `orchestrator/answer`；目标为 person 时
MUST 为 `person/answer`。

#### Scenario: 面板区分在等谁

- **GIVEN** 工单有一条 blocking 的 `to: "orchestrator"` 问题
- **WHEN** 打开工单列表/详情
- **THEN** stage 显示 orchestrator/answer，而不是 person/answer

#### Scenario: 人问题优先显示

- **GIVEN** 工单同时有一条阻塞的 person 问题和一条阻塞的 orchestrator 问题
- **WHEN** 读取 stage
- **THEN** stage 为 person/answer（人需要先看到）
