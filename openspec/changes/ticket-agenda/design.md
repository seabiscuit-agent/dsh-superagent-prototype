## Context

宿主目前只有两类「到点」状态：Eval 的 `evalTimeoutMs` 和 effect 的重试退避。两者都不是
「在某个未来时刻对一张工单做一件事」。`Passes` 每 2 秒调用 `effects.kick()` 和
`Engine.evaluateDue()`；effect 表已有 `(kind, key)` 主键、`due` 列、持久化和重启恢复，
`dispatch()` 对无序 kind 只取 `due <= now` 的行。也就是说，缺的只是「允许 enqueue 指定未来的
`due`」和一个到点后写 Input 的 handler。

## Goals / Non-Goals

- Goal：一次性的未来唤醒，持久、可去重、可取消、可观察。
- Goal：到点前零模型调用；到点后走既有 Input 投递路径，不新开投递机制。
- Goal：暂停、重启、错过、已结束工单的行为确定，测试可复现。
- Non-Goal：cron/周期任务；用量记账；改 Passes 节拍；给 worker 排 schedule。

## Decisions

### 1. 复用 effect 表，不新建 agenda 表

review 建议 `agenda(at, kind, ticket_id, payload, key)` 表。这里选择复用 `effect`：

- 已有 `(kind, key)` 去重、`due` 索引、2 秒扫描、重启恢复、失败重试和健康统计；
- 新增一张表要再写一套扫描/迁移/健康检查，和 effect 的 due 扫描重复；
- `key = ticket:<ticket_id>:<key>` 同时满足「同工单同 key 一行」和「不同工单互不覆盖」。

代价是 agenda 继承 effect 的 `attempts`/退避语义：handler 抛非 `Later` 错误会按 2s→60s 退避，
健康面板会把连续失败标红。这正是想要的：到点写 Input 失败应该被看见并重试。

### 2. `Effects.enqueue` 增加可选 `at`

```ts
enqueue<K extends EffectKind>(kind: K, key: string, payload: EffectPayloads[K], at?: string): void
```

`due = at ?? this.now()`。`at` 在进入 store 前用 `new Date(at).toISOString()` 归一化为 UTC；
带 `+08:00` 的输入不能直接和 `now()` 的 `...Z` 做字符串比较。工具层校验 `Date.parse`，
失败返回 `invalidTime`。

### 3. 新增 EffectKind `agenda` 与 Input kind `agenda`

handler 收到 `{ticketId, key, reason, at}`，在 `run` 里：

1. 读取工单；不存在或 `!liveTicket` → emit `agenda.dropped`，返回（行被删除）。
2. `waitsForPerson(ticket)` 为真 → `throw new Later()`，行留在 due 位置，2 秒后再试。
   （`orchestrator-consult` 合并后把这里换成 `waitsForQuestion`，让 orchestrator 的阻塞问题也延后。）
3. `tickets.addInput(ticketId, {kind: 'agenda', id: 'agenda:<ticketId>:<key>:<at>', text: reason})`。

Input 用专门的 `agenda` kind，而不是 `text`：`text` 不是 automatic，会绕过「等待人的问题」；
`note` 是 automatic 但语义是事实，且 `assignments.report` 在 blocked/failed 时会丢弃 automatic
Input。`agenda` 在 `automatic()` 中为真，但 handler 只在没有人在等待答复时才写它，
所以不会落入那条丢弃路径。id 含 `<at>`，同一行重试也只产生一条 Input。

`reason` 由 handler 加前缀（如 `Scheduled follow-up: ...`），长度上限 500 字符，避免把整段会话
塞进 Input。

### 4. 暂停用 handler 的 `limit`，不清行

`effects.handle('agenda', run, {limit: () => paused() ? 0 : 4})`。`Effects.dispatch()` 在
`limit()` 为 0 时不会启动 ready 行，行保留；恢复后第一次扫描按 `due <= now` 投递。这样
「暂停三天只补最近一次」是结构性的：每个 key 只有一行，不存在每天一行需要 replay。

### 5. 等待人的问题用 `Later` 延后，而不是提前写 Input

如果到点时工单在等待人的答复（P0-1 的 attention；consult 合并后是 blocking person Question），
handler 抛 `Later`。`Later` 不增加 `attempts`，只把 `due` 推到 `now + retry[0]`（2 秒）；
答复到达后下一次重试看到 `waitsForPerson` 为假，写入 Input。代价是等待期间每 2 秒一次 DB 读写，没有模型调用；换来的是
不会提前把 agenda Input 塞进 `undelivered`，也就不会被 `assignments.report` 的 automatic 过滤
丢掉。

替代方案是到点先写 Input、让它被 held；否决原因就是上面的丢弃路径，以及「held 的 Input 在
问题答完后由谁 flush」需要额外改投递逻辑。

### 6. 已结束工单：丢弃并通知，不 resume

`tickets.wake` 只对「有人类 trigger 等待」的 ended 工单生效，schedule 不应绕过这个 guard。
handler 检查 `liveTicket`，false 时 emit `agenda.dropped`（payload: ticketId、key、reason、at），
`eventNotice` 把它渲染成主会话 notice。notice 是尽力而为：进程在删除行后崩溃可能丢一条通知，
但「不复活工单」是不变量。

### 7. 一次性，不做 replay

一个 key 一行、行成功后删除，天然只补最近一次。review 提到的 `replay` 模式不在本变更：
它需要「错过区间」的持久历史，而一行 due 记录没有历史。

### 8. 工具只在主会话

`orchestrator_schedule` 加在 `src/app/tools/main.ts`。worker 没有排 schedule 的权限：
worker 要等待应该报告 `blocked` 或结束回合，由主会话/人决定是否排复查。工具返回
`{scheduled: true, key, at}` 或 `{cancelled: true}`；`at` 缺失且 `cancel` 为假是错误。

### 9. 可观察性

`agendaRows(ticketId)` 从 effect 表读 `kind = "agenda"` 且 key 前缀匹配的行；`orchestrator_read`
和 `GET tickets/<id>` 复用该函数。不要把这些行塞进 `Ticket` JSON，避免同一状态两份。

## Risks / Trade-offs

- **每 2 秒重试等待中的 agenda**：等待数小时会有大量 no-op DB 更新。若观测到写放大，可在
  `Later` 前把 `due` 推到 `now + 30s`（需要 handler 能改 due，当前 `Later` 只加 2s）；本变更先
  保持 2s，和 Passes 节拍一致。
- **effect 健康面板出现 agenda 失败**：这是有意暴露；若 notice 渲染失败会重试，可能重复通知，
  需要 `eventNotice` 幂等或接受重复。
- **暂停期间 due 行堆积**：每个 key 一行，暂停再久也不会堆积；但同一个工单多个 key 会各留一行。
- **时区**：只接受带时区偏移或 `Z` 的 ISO 8601；`"2026-11-17 20:00"` 这类本地时间拒绝，
  避免宿主时区和用户时区不一致。
- **回滚**：旧代码不认识 `agenda` effect kind，回滚后该行不会被任何 handler 消费；没有数据损坏，
  但 schedule 会静默失效。发布说明要写这一点。

## Migration

无 schema 版本变更。`effect` 表和 `Ticket.inputs` 都是 JSON/文本，新增 kind 不需要迁移；
旧工单没有 `agenda` Input。回滚时残留的 `agenda` effect 行成为惰性数据，可手工删除。

## Open Questions

- 是否需要给 `orchestrator_schedule` 一个最长 horizon（例如 30 天）防止误排一年后？
- cron Source 是下一个变更；它应该复用 `agenda` 还是直接生成 Trigger？本变更不回答。
- 面板是否需要「取消复查」按钮，还是只让主会话调工具？首个实现可以只有工具。
