# ticket-question-answers Specification

## Purpose

工单详情面板直接显示 person 问题的选项按钮：点选即写入该问题唯一的答案槽，面板、对话与
GitHub 回复先到先算；答案在投递前 15 秒可撤回，窗口结束后用更正前进修正，并保留可审计的
答案历史。

## Requirements
### Requirement: 面板显示待答问题与选项

`GET /orchestrator/api/tickets/:id` 与面板 SHALL 显示每一条 person 问题的 `question`、
`context`、`options`、`recommend`、`blocking` 和原通道链接，包括开放、待投递、已答、已撤回
和已更正的问题；当 `options` 存在时，面板 MUST 把每个选项渲染成可点的按钮；
`to: "orchestrator"` 的问题 MUST NOT 出现面板作答按钮。已答、待投递、已撤回、已更正的问题
MUST 带对应状态继续显示，而不是从详情里消失。

#### Scenario: 有选项的阻塞问题

- **GIVEN** 工单有一条 `to: "person"`、`blocking: true`、`options: ["tests/", "src/"]`、
  `recommend: "tests/"` 的开放问题
- **WHEN** 打开工单详情
- **THEN** 问题文本、`context`、两个选项按钮、推荐标记、阻塞标记和原通道链接都可见；
  点按钮即可提交，不需要二次确认

#### Scenario: 非阻塞问题也能在面板答

- **GIVEN** 工单有一条 `to: "person"`、`blocking: false` 的开放问题
- **WHEN** 打开工单详情
- **THEN** 该问题同样显示选项按钮，只是不进入阻塞横幅；工单不因它停在 person stage

#### Scenario: 没有选项时只保留通道链接

- **GIVEN** 一条没有 `options` 的开放 person 问题
- **WHEN** 打开工单详情
- **THEN** 面板不显示答案按钮，保留「去原通道回答」链接；直接调用面板 answer 路由返回
  `optionRequired`

#### Scenario: orchestrator 问题不出现按钮

- **GIVEN** 一条 `to: "orchestrator"` 的开放问题
- **WHEN** 打开工单详情
- **THEN** 面板只显示「等待主会话回答」的提示，没有选项按钮；直接调用面板 answer 路由返回
  `notPersonQuestion`

#### Scenario: 已答与已撤回仍可查

- **GIVEN** 一条已提交答案的问题和一条撤回后重新开放的问题
- **WHEN** 打开工单详情
- **THEN** 前者显示答案、作答人、时间和「已投递」，不显示答案按钮；后者显示「已撤回」、
  旧答案的审计信息和新的选项按钮

### Requirement: 点选即正式回答

`POST /orchestrator/api/tickets/:id/questions/:questionId/answer` SHALL 接受
`{ "answer": string }`，并且 MUST 只接受开放、`to: "person"`、尚无待提交答案的问题；当
`options` 存在时 `answer` MUST 是其中之一。成功时 MUST 记录 `answeredBy: "person"`、
`answeredAt`、`withdrawableUntil`（`answeredAt` 加 15 秒），保持 `resolution` 未设置，
emit `question.answer-pending`，并返回该问题；它 MUST NOT 要求二次确认，MUST NOT 写 outbox、
Decision 或 IM。工单已结束时 MUST 返回 `ticketEnded`；问题已关闭时 MUST 返回 `notOpen`；
已有人回答时 MUST 返回 `alreadyAnswered`。

#### Scenario: 点选一个选项

- **GIVEN** 一条有 `options` 的开放 person 问题
- **WHEN** 面板调用 answer 路由，`answer` 为推荐项
- **THEN** 问题记录 `answer`、`answeredBy: "person"`、`answeredAt`、`withdrawableUntil`；
  面板显示「待投递，可撤回」；worker 此刻还没有收到答案

#### Scenario: 非法选项被拒绝

- **GIVEN** 同一条问题，`options: ["tests/", "src/"]`
- **WHEN** answer 路由收到 `"docs/"`
- **THEN** 返回 400 `invalidOption`，问题保持开放，没有答案字段变化

#### Scenario: 已有待提交答案

- **GIVEN** 问题已有一条 15 秒内待提交的答案
- **WHEN** 再次调用 answer 路由
- **THEN** 返回 `answerPending`，不覆盖待提交答案；面板提示先撤回再改选

#### Scenario: 已经回答

- **GIVEN** 问题已提交答案
- **WHEN** 再次调用 answer 路由
- **THEN** 返回 `alreadyAnswered` 和现有答案；不产生第二条有效 Input

#### Scenario: 空答案被拒绝

- **GIVEN** 一条开放 person 问题
- **WHEN** answer 路由收到空字符串或缺失 `answer`
- **THEN** 返回 400 `emptyAnswer`，问题保持开放

#### Scenario: 工单结束后不能作答

- **GIVEN** 工单已结束，仍有一条开放 person 问题
- **WHEN** 调用 answer 路由
- **THEN** 返回 409 `ticketEnded`，不写答案、不生成 Input

### Requirement: 同一答案槽先到先算

一个 `Question` SHALL 只有一个有效答案槽。面板 answer 路由、`orchestrator_reply
purpose="answer"` 和 outbox 的 `host.answered` 回写 MUST 调用同一个
`answerPersonQuestion` 操作，并在同一个 store 事务里串行化；先成功写入者 MUST 获胜，后到者
MUST 返回 `alreadyAnswered`（已提交）或 `answerPending`（待提交），MUST NOT 覆盖答案、MUST NOT
产生第二条有效 `answer` Input。通道入口的答案可以是自由文本，不要求在 `options` 内，但
MUST NOT 为空；面板入口仍受「选项必须是 `options` 之一」的约束。已发出但输掉竞态的通道
回复 MUST NOT 再改变答案槽；未发出的通道回复 MUST 在发送前重新检查问题状态，已答/待答时
MUST 放弃发送。

#### Scenario: 面板先答，聊天后到

- **GIVEN** 面板已为问题写入答案
- **WHEN** 主会话随后用 `orchestrator_reply purpose="answer"` 回答同一问题
- **THEN** 主会话得到 `alreadyAnswered` 或 `answerPending`，不发送第二条答案消息，worker
  只有面板那一条有效 Input

#### Scenario: 聊天先答，面板后到

- **GIVEN** 人的通道回复已发送并写回问题
- **WHEN** 面板再点另一个选项
- **THEN** 面板显示已回答和现有答案，answer 路由返回 `alreadyAnswered`，不产生第二条 Input

#### Scenario: 两个面板点击并发

- **GIVEN** 两个 answer 请求同时到达同一问题
- **WHEN** 事务依次执行
- **THEN** 只有一个请求写入答案，另一个返回 `alreadyAnswered` 或 `answerPending`；两个响应
  看到的是同一个答案，不出现两份状态

#### Scenario: 通道发送成功但问题已被答

- **GIVEN** 主会话的通道回复已发出，但发送期间面板已写入答案
- **WHEN** outbox 的 `host.answered` 回写执行
- **THEN** 回写看到问题已有答案，不覆盖、不追加 Input；通道消息可能已经发出，但答案槽不变

### Requirement: 撤回只在投递前有效

面板答案在 `withdrawableUntil` 之前 SHALL 只是 `Question` 上的待提交答案，MUST NOT 生成
worker 可见的 `answer` Input。`POST /orchestrator/api/tickets/:id/questions/:questionId/withdraw`
SHALL 只在问题有面板待提交答案、当前时间早于 `withdrawableUntil`、且工单未结束时成功；成功时
MUST 清空 `answer`、`answeredBy`、`answeredAt`、`withdrawableUntil`，记录 `withdrawnAt` 与
`withdrawnAnswer`，取消待提交 effect，保持问题开放，emit `question.withdrawn`。窗口结束、
答案已提交、没有待提交答案或工单已结束时 MUST 拒绝撤回，并分别返回 `withdrawExpired`、
`alreadyCommitted`、`notWithdrawable` 或 `ticketEnded`。

#### Scenario: 窗口内撤回

- **GIVEN** 面板在 5 秒前写入待提交答案
- **WHEN** 调用 withdraw 路由
- **THEN** 问题回到开放、`answer` 为空；待提交 effect 被取消；worker 从未收到该答案的 Input；
  面板重新显示选项按钮和「已撤回」审计信息

#### Scenario: 超过窗口

- **GIVEN** 面板答案写入已超过 15 秒，但提交 effect 尚未运行
- **WHEN** 调用 withdraw 路由
- **THEN** 返回 409 `withdrawExpired`，答案保持；面板只提供「更正」入口

#### Scenario: 已经提交给 worker

- **GIVEN** 答案已由提交 effect 写成 Input
- **WHEN** 调用 withdraw 路由
- **THEN** 返回 `alreadyCommitted`，不删除 Input、不改变答案

#### Scenario: 工单已经结束

- **GIVEN** 工单在窗口内被停止或结束
- **WHEN** 调用 withdraw 路由
- **THEN** 返回 `ticketEnded`；工单结束时待提交答案已标记为已撤回，不生成、不投递新 Input

#### Scenario: 撤回后重新作答

- **GIVEN** 一次撤回已完成，问题重新开放
- **WHEN** 面板再点一个选项
- **THEN** 写入新的待提交答案和新的 `withdrawableUntil`；旧答案只留在 `withdrawnAnswer`
  和事件流里，不进入答案槽

#### Scenario: 窗口内重启

- **GIVEN** 待提交答案写入后、窗口结束前 host 重启
- **WHEN** 新进程读取工单
- **THEN** `answer`、`withdrawableUntil` 和待提交 effect 都还在；截止前撤回仍成功，截止后
  effect 照常提交并投递

### Requirement: 超时走更正

`POST /orchestrator/api/tickets/:id/questions/:questionId/correct` SHALL 接受
`{ "answer": string }`，并且 MUST 只接受已回答的 person 问题；当 `options` 存在时新答案 MUST
是其中之一。窗口内调用 MUST 返回 `withdrawInstead`，要求先撤回；问题尚未回答时 MUST 返回
`notAnswered`；orchestrator 问题 MUST 返回 `notPersonQuestion`；工单已结束时 MUST 返回
`ticketEnded`。成功时 MUST 把当前答案连同
其 `answeredAt`/`answeredBy` 压入 `corrections`，写入新 `answer`、`correctedAt`，追加一条 id 为
`question-correction:<questionId>:<n>`、`kind: "answer"`、`correction: true` 的 TicketInput
并立即投递，emit
`question.corrected`；更正 MUST NOT 可撤回。主会话 `orchestrator_reply` 的 answer 请求带
`correction: true` 时 MUST 走同一路径。

#### Scenario: 超时后更正

- **GIVEN** 面板答案已提交，worker 已收到原答案
- **WHEN** 面板调用 correct 路由，选择另一个 option
- **THEN** 问题 `answer` 为新值、`correctedAt` 已写、`corrections` 含旧值；worker 收到
  `question-correction:<id>:1` Input，文本说明它取代旧答案

#### Scenario: 窗口内不能更正

- **GIVEN** 待提交答案仍在 15 秒窗口内
- **WHEN** 调用 correct 路由
- **THEN** 返回 409 `withdrawInstead`，不写 `corrections`、不投递 correction Input

#### Scenario: 尚未回答不能更正

- **GIVEN** 一条开放 person 问题，还没有任何答案
- **WHEN** 调用 correct 路由
- **THEN** 返回 409 `notAnswered`，不写 `corrections`、不投递 correction Input

#### Scenario: 连续更正

- **GIVEN** 问题已有一条更正
- **WHEN** 再次更正到另一个选项
- **THEN** 追加 `question-correction:<id>:2`，`corrections` 按时间保留两条旧答案；最后一条
  是有效答案；重复提交与当前答案相同的更正不产生第二条 Input

#### Scenario: 工单结束后不能更正

- **GIVEN** 工单已结束
- **WHEN** 调用 correct 路由
- **THEN** 返回 `ticketEnded`，不追加 Input

#### Scenario: 非法更正

- **GIVEN** 问题有 `options: ["tests/", "src/"]`
- **WHEN** correct 路由收到 `"docs/"`
- **THEN** 返回 400 `invalidOption`，答案和 `corrections` 都不变

### Requirement: 可观察性与审计

`GET /orchestrator/api/tickets/:id`、`orchestrator_read ticket/<id>` 和面板 SHALL 暴露每条
Question 的 `answer`、`answeredBy`、`answeredAt`、`withdrawableUntil`、`committedAt`、
`withdrawnAt`、`withdrawnAnswer`、`correctedAt`、`corrections` 和 `resolution`；工单时间线 MUST
记录 `question.answer-pending`、`question.answered`、`question.withdrawn`、
`question.corrected` 以及答案 Input 的投递结果。面板 MUST 区分「待投递（可撤回）」、「已投递」、
「已撤回」、「已更正」和「投递失败」。

#### Scenario: 面板显示待投递

- **GIVEN** 面板答案写入但窗口未结束
- **WHEN** 打开工单详情
- **THEN** 问题显示答案、作答人、`withdrawableUntil` 和倒计时；不显示「已投递」

#### Scenario: 面板显示已投递

- **GIVEN** 提交 effect 已把答案写成 Input 并投递成功
- **WHEN** 打开工单详情
- **THEN** 问题显示「已投递」、`committedAt` 和「更正」入口；不显示撤回按钮

#### Scenario: 面板显示已撤回

- **GIVEN** 一次撤回已完成
- **WHEN** 打开工单详情
- **THEN** 问题显示「已撤回」、`withdrawnAt`、`withdrawnAnswer` 和新的选项按钮

#### Scenario: 面板显示已更正

- **GIVEN** 问题已有一条更正
- **WHEN** 打开工单详情
- **THEN** 问题显示当前答案、`correctedAt` 和按时间排列的 `corrections`；旧答案不会被误认为
  当前答案

#### Scenario: 投递失败

- **GIVEN** 提交 effect 已生成 Input，但 worker 投递失败
- **WHEN** 打开工单详情
- **THEN** 面板显示 `deliveryError`，问题仍为 answered；现有 retry 路径可重投，不重复生成
  第二条有效 Input

#### Scenario: orchestrator 回答没有人的撤回/更正

- **GIVEN** 问题由主会话用 `orchestrator_answer` 回答
- **WHEN** 打开工单详情
- **THEN** 面板显示 `answeredBy: "orchestrator"` 和依据，不显示 person 的撤回/更正按钮

### Requirement: 授权、通道与重启

面板 answer/withdraw/correct 路由 MUST 只监听 loopback，并 MUST 校验同源
`x-orchestrator-request` 头，沿用 `/orchestrator/api/*` 的现有边界；它们 MUST NOT 暴露给
Feishu/GitHub 传输。面板作答 MUST NOT 写 outbox、Decision 或 IM；主会话/通道回复仍只在人主动
回复时走 outbox。待提交答案 MUST 由持久化 effect 承载，进程重启后 MUST 保留到
`withdrawableUntil`；工单结束时 MUST NOT 再投递答案或更正 Input。

#### Scenario: 非 loopback 或跨源请求

- **GIVEN** 请求来自非 loopback 地址或缺少同源头
- **WHEN** 调用 answer/withdraw/correct 路由
- **THEN** 请求被拒绝，问题状态不变

#### Scenario: 面板作答不产生 IM

- **GIVEN** 面板成功回答一条 person 问题
- **WHEN** 检查 outbox 与通道
- **THEN** 没有新的待发送消息，也没有 Decision；`orchestrator_read` 能看到答案

#### Scenario: 通道回复仍走 outbox

- **GIVEN** 人在 Feishu/GitHub 回复同一问题
- **WHEN** 主会话用 `orchestrator_reply purpose="answer"` 处理
- **THEN** 回复仍走 outbox；发送成功后写同一答案槽；面板显示 answered

#### Scenario: 重启后提交

- **GIVEN** 待提交答案的 effect 已入队，host 在窗口结束前重启
- **WHEN** 新进程启动并处理到期 effect
- **THEN** 答案在 `withdrawableUntil` 之后提交并投递；截止前撤回仍可用

#### Scenario: 工单在窗口内结束

- **GIVEN** 待提交答案尚未提交，工单被停止
- **WHEN** 工单结束或提交 effect 到期
- **THEN** 待提交答案标记为已撤回，不生成也不投递 Input；面板只读显示 ended

