## Purpose

让主会话（以及任何声明 `routing: "on-demand"` 的 Source）按「讨论不建单、动手才建单、做完撤订、
后续挂回原单」工作；其他 Source 仍按订阅 fanout，行为不变。

## ADDED Requirements

### Requirement: Source 声明路由方式

The system SHALL 让每个 `SourceKind` 声明 `routing: "subscriptions" | "on-demand"`，未声明时
按 `"subscriptions"` 处理；local Source MUST 声明为 `"on-demand"`。

#### Scenario: 主会话是按需来源

- **WHEN** 宿主注册 local kind 并读取 `sources.routing("local")`
- **THEN** 返回 `"on-demand"`，且主会话候选卡仍以 `strength: "explicit"` 到达

#### Scenario: 旧 Source 默认仍是订阅

- **WHEN** 一个未声明 `routing` 的 SourceKind（如 github）注册后读取 `sources.routing("github")`
- **THEN** 返回 `"subscriptions"`，其线程订阅、fanout 与结束工单自动 resume 行为不变

### Requirement: 按需线程的消息不投递给工单

The system SHALL 对 `routing: "on-demand"` 的 Source 跳过订阅 fanout：线程上的每条消息
MUST 只作为候选交给 orchestrator，MUST NOT 作为 Ticket Input 直接进入已订阅工单的 worker。

#### Scenario: 工单打开时的讨论只到 orchestrator

- **WHEN** 主会话已有打开的工单，所有者又发一条「这个页脚是不是也该用新字体？」
- **THEN** 该消息成为 orchestrator 的候选，`ticket.inputs` 不包含它，worker 收不到这条消息；
  orchestrator 可以用 `ignore` 结束这次讨论而不建单

#### Scenario: 候选过期后下一条仍被接纳

- **WHEN** 一条按需消息在 assessment timeout 内没有被 route
- **THEN** 它按既有规则过期，线程接受下一条消息作为候选；订阅工单不会收到这两条消息中的任何一条

### Requirement: 按需工单结束时静默撤订

The system SHALL 在工单结束时移除该工单在 on-demand 线程上的订阅，并 MUST NOT 因此产生
「worker 认为线程无关」或「no longer follows thread」之类给人看的通知。

#### Scenario: 工单完成后线程回到未订阅

- **WHEN** 主会话工单的 worker 报告 `ready` 并结束
- **THEN** `thread.subscriptions` 不再含该工单 id，主会话没有收到撤订通知，
  下一条同话题消息重新成为候选

#### Scenario: 人为停止的工单不被挂回

- **WHEN** 所有者用 `orchestrator_route` 以 `stop` 结束一张主会话工单，之后又发一条同话题消息
- **THEN** 该消息仍是候选，但 `attach` 到这张被人工停止的工单会被拒绝（既有 `attachable` 规则），
  orchestrator 只能 accept 新工单或 ignore

### Requirement: 候选卡保留按需线程的已结束工单

The system SHALL 在 on-demand 线程的候选卡 `related_tickets` 中列出该线程上已结束的工单，
即使它们的订阅已被移除，使 orchestrator 能判断并挂回原单。

#### Scenario: 同话题后续消息挂回原单

- **WHEN** 工单结束后所有者发「把页脚年份改成 2027」，orchestrator 读候选卡
- **THEN** 卡的 `related_tickets` 含该已结束工单；`orchestrator_route` 以 `attach` 处理后，
  工单的 `ended` 被清除、新 trigger 进入 `inputs`、线程重新订阅该工单
