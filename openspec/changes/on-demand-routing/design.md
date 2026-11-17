## Context

当前路由只有一种语义：ticket 订阅 thread，之后该 thread 上的消息经 Intake fanout 给订阅的工单；
ticket 结束时订阅保留，人类消息可直接 resume。主会话（local Source）也已按这条路径工作，
于是所有者讨论一句就被投进 worker，工单结束后又自动续单。

所有者要的是三段式：讨论由 orchestrator 直接回答；明确要动手才建单；工单结束后撤订，
后续同话题消息先到 orchestrator，由它判断后挂回原单。

## Goals / Non-Goals

- Goal：Source 可声明按需路由；主会话默认按需。
- Goal：按需线程的消息只产生候选，不直接进工单；工单结束静默撤订；候选卡仍能列出已结束工单。
- Non-Goal：改变 GitHub/Feishu 等订阅来源的行为；自动判定消息归属；新增持久状态或迁移。

## Decisions

### 1. 路由方式放在 SourceKind 上

`SourceKind` 新增可选 `routing?: 'subscriptions' | 'on-demand'`，默认 `subscriptions`。
`SourceRegistry.routing(id)` 提供查询，`EngineOptions.routing` 把同一个函数注入 Engine，
Intake 据此决定是否 fanout。

选择它而不是在 `Thread` 上存标志：路由方式是来源的固有属性（主会话永远按需），
放在 Thread 上会为每条消息引入需要维护的状态，并且历史线程没有该字段时需要回填。
SourceKind 的 trait 已经承载 scope、channel、policy 等来源级差异，routing 属于同一类。

### 2. 按需来源在 Intake 跳过订阅 fanout

`receive` 仍正常保存 trigger、更新 `lastAt`/`correlated`，但当来源为 on-demand 时
遍历的订阅集合为空，因此不产生 Ticket Input，也不 wake 工单；随后照常
`queueForEval` 或走 explicit 候选，由 orchestrator 决定 accept/attach/ignore。

`attach` 仍会订阅线程：订阅是「这张工单正在处理这个线程」的展示与后续上下文来源，
只是对 on-demand 来源不再驱动 fanout。工单结束时再把它移除。

### 3. 结束撤订由 Tickets.end 完成，事件静默

`end()` 在既有清理之后遍历 `threads.list()`，对 ref 来源为 on-demand 且订阅了本工单的线程调用
`dropSubscriptions(thread.key, 'ticket', ticketId, 'the ticket ended')`。
`thread.unsubscribed.by` 增加 `'ticket'`；`notices.eventNotice` 对该值返回 undefined，
因为 `ticket.ended` 通知已经说明结果，无需再发一条误导性的「worker 认为线程无关」。

### 4. 候选卡补列已结束工单

候选卡的 `tickets` 来自 `thread.subscriptions`，撤订后自然为空。`links.endedOnThread`
在候选主 trigger 属于 on-demand 来源时，从 store 中挑出 origin trigger 与当前线程有交集的
已结束工单（最多 4 张），并入 `related_tickets`。orchestrator 因此能在卡上直接看到可挂回的原单；
其余工单仍可用 `orchestrator_read tickets` 查。

## Risks / Trade-offs

- on-demand 线程的每条消息都走 orchestrator，模型漏看候选时消息会过期；既有 timeout 规则兜底。
- 已结束工单列表最多 4 张，线程上历史工单很多时需再读 tickets；这是提示长度与可发现性的折中。
- 订阅来源完全不受影响，但仍共享 `dropSubscriptions` 的 `by` 联合类型。

## Migration

无。新增字段均为可选，JSON 存储无需 schema 变更；已结束工单的历史订阅在部署后不会自动清理，
但主会话的新工单结束时会撤订，且候选卡逻辑不依赖旧订阅是否存在。
