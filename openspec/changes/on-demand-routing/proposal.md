## Why

主会话（local Source）已经是显式候选来源，但 Thread 仍按「订阅」语义工作：接受工单会把主会话线程
订阅到该工单，之后主会话里所有消息直接 fanout 给这个工单的 worker，讨论因此绕过 orchestrator；
工单结束后订阅仍保留，下一条同话题消息又被自动 resume。所有者要的策略相反：

- 平时讨论不建单，orchestrator 直接回答；
- 需要动手才建单；
- 做完撤订，之后同话题消息先到 orchestrator；
- orchestrator 判断它属于哪张已结束工单，可以挂回原单，工单连同上下文恢复。

若不改，主会话无法区分「聊天」与「派活」，worker 会被聊天消息打扰，撤订后也无法重新接单。

## What Changes

- SourceKind 增加 `routing: 'subscriptions' | 'on-demand'`；local Source 为 `on-demand`，
  GitHub/Feishu 等未声明者仍为 `subscriptions`（默认值，行为不变）。
- 对 on-demand Source，Intake MUST NOT 把消息 fanout 给线程订阅的工单；每条消息都作为候选交给
  orchestrator。`orchestrator_route` 的 attach 仍会订阅并唤醒工单，作为唯一投递通道。
- 工单结束时，它在 on-demand 线程上的订阅被静默移除；不产生「worker 认为线程无关」的误报通知。
- 候选卡仍列出该 on-demand 线程上已结束的工单，供 orchestrator 判断并 attach 回原单。
- 提示词按新策略改写：讨论直接回答、动手才 accept、完毕自动撤订、后续同话题 attach 回原单。

## Capabilities

### New Capabilities

- `on-demand-routing`: 主会话线程按需建单与撤订，讨论留在 orchestrator，工单结束后可挂回原单。

### Modified Capabilities

无。`local-dispatch-source` 的候选生成、admission 与 explicit strength 不变。

## 明确不做

- 不改 GitHub/Feishu Source 的订阅 fanout 与 ended ticket 自动 resume 语义；它们仍按订阅工作。
- 不新增「忽略某条消息」的状态；on-demand 线程的订阅本身就是工单级的，结束即撤。
- 不自动判断消息属于哪张已结束工单：由 orchestrator 读候选卡后决定 attach，必要时用
  `orchestrator_read tickets` 查更多。
- 不改 admission table，也不放宽非所有者消息的接纳条件；主会话消息仍只来自所有者。
- 不加 UI、不加 HTTP 端点、不迁移数据库（新字段都是可选的，JSON 存储无需 schema 变更）。

## 验收标准

1. **on-demand 消息不 fanout**：`env -u GIT_CONFIG_GLOBAL pnpm vitest run tests/local.spec.ts`
   通过；用例 `holds a local message for the orchestrator while a ticket is open, and attaches it
   back after the ticket ends` 中，工单打开时的新消息成为候选且 `ticket.inputs` 不含它。
2. **结束撤订且静默**：同一用例中工单 ready 结束后 `thread.subscriptions` 不再含该工单，
   主会话没有收到 `no longer follows thread` 通知。
3. **可挂回原单**：第三条消息的候选卡 `related_tickets` 含已结束工单；`attach` 后工单
   `ended` 清除、`inputs` 含新 trigger、线程重新订阅。
4. **订阅来源不变**：`env -u GIT_CONFIG_GLOBAL pnpm vitest run tests/followups.spec.ts tests/runtime-concurrency.spec.ts`
   通过，Feishu/GitHub 线程的 fanout 与 resume 行为未变。
5. **仓库检查**：`pnpm check` 与 `openspec validate --all --strict` 退出 0。

## Impact

- 代码：`src/sources/kind.ts`、`src/sources/registry.ts`、`src/sources/local.ts`、
  `src/core/part.ts`、`src/core/intake.ts`、`src/core/tickets.ts`、`src/core/ports.ts`、
  `src/app/runtime.ts`、`src/app/notices.ts`、`src/app/links.ts`。
- 提示词：`prompts/admission.md`、`prompts/dispatch.md`、`prompts/orchestrator.md`、
  `prompts/subscriptions.md`。
- 数据：`Thread.subscriptions` 会在 on-demand 工单结束时减少；`thread.unsubscribed.by` 新增 `'ticket'`。
- 测试：`tests/local.spec.ts` 新增端到端用例。
- 文档：`docs/notes/2026-11-17-on-demand-routing.md`。
