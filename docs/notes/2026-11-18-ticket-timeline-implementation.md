# ticket-timeline 实施：工单事实链（`fact` 表 + 三个读取入口 + `why`）

日期：2026-11-18；提案 `openspec/changes/ticket-timeline/`（本次按 tasks.md 25 项全部落地）。
提案阶段的调研见 `2026-11-18-ticket-timeline-proposal.md`，这里只记实施中真正踩到的东西。

## 根因（同一张工单只剩终态）

报告被后一份覆盖（`src/core/assignments.ts:172`）、结束原因只留最后一次（`src/core/tickets.ts:376`）、
回执 `status` 就地改写（`src/app/store.ts:277`）、`OutboundMessage` 连排队时刻都没有。现在这些时刻
都进 `fact` 表，与业务写入同一个 `Store.atomic` 事务。

## 落点

- 表与仓储：`src/app/store.ts`（`fact` + `fact_ticket_at`，`facts.append` / `facts.of`）、
  `src/app/store-read.ts`（`facts(ticket, limit)` 读 `limit + 1` 判 `truncated`）、
  `src/core/memory.ts`（数组实现，`atomic` 回滚同时丢弃事实）。schema 11→12，
  `src/app/migration.ts` 的 `migrateTo12` 只建表建索引、不回填。
- 写入：`src/core/part.ts` 的 `fact()` / `remember()`；`tickets`、`assignments`、`evals`、`intake`
  在各自写方法里记；`dispatch.fast_path` 在 `Engine.signalFastPath` 自己开一次 atomic；
  `src/app/outbox.ts` 记 `receipt.queued/sent/dropped` 并把 `queuedAt` 一路带到 `receipts.settle` 的重建行。
- 读取：`src/app/views/timeline.ts`（`ticketTimeline` / `backfillTimeline`）、
  `GET tickets/:id/timeline`、`POST tickets/:id/timeline/backfill`、
  `orchestrator_read ticket/<id>/timeline`、面板 `src/client/ticket.tsx` 默认折叠的「时间线」、
  `scripts/dsh-superagent why <id> [--json] [--backfill]`（未知工单 4、不可达 1、设置未完成 3）。

## 坑

- `EnginePart` 上新帮手不能叫 `record`：`Evals.record(thread, evaluation, outcome)` 已占用，TS2416。
  最终叫 `remember`（事实 + 事件同一时刻），`Engine` 内部的私有 `record` 与它不同类，无冲突。
- 事实只在「有工单」时挂链：`trigger.received` 在 `intake` 里按 `fanout` 逐工单记，
  开单的那次触发由 `tickets.create` 用 `trigger.at` 补记；没有工单的时刻 `ticket` 记 `null`。
- 回填必须跳过**已 recorded 的类型**，否则已记录的链会长出 derived 孪生行（面板与 `why` 重复）。
  `backfillTimeline` 用 `recorded` 集合 + `derivedKey`（`type\0key`）双重去重。
- 未知工单的文案要一致：HTTP 走 `RouteError(404, 'Ticket not found')`（不能让它冒泡成
  `UserError('unknownTicket')`，那样 body 会是 `{error:'Unknown ticket', code}`）；资源读取在
  `section === 'timeline'` 时抛 `new Error('Ticket not found')`；CLI 退出 4。
- `argparse` 子命令：共享选项要 `parents=[shared]` + 每个选项 `default=argparse.SUPPRESS`，
  只放顶层或只放子命令都会让选项在另一个位置被拒（10 个既有测试会红）。
- 面板折叠态不能发请求：`Timeline` 用 `asked` 状态，`usePoll` 在未展开时直接 resolve undefined。
- 测试基线：新增资源会抬高 `tests/model-surface.baseline.json` 的 `orchestrator_read` 预算
  （2948 / 1670）；`docs/007-architecture.md` 的 Modules/Tests 表必须登记新文件，否则 `tests/docs.spec.ts` 失败。

## 验证命令

```
env -u GIT_CONFIG_GLOBAL npx vitest run tests/timeline-facts.spec.ts   # 11 passed
env -u GIT_CONFIG_GLOBAL npx vitest run                               # 70 files / 1309 tests
env -u GIT_CONFIG_GLOBAL pnpm check                                    # typecheck + test + build
openspec validate --all --strict                                       # 7 passed
python3 scripts/dsh-superagent why <id> --url http://127.0.0.1:3100    # 与面板同一顺序
python3 scripts/dsh-superagent why does-not-exist --url …; echo $?      # 4
```

面板证据：`docs/evidence/5bdaed48877b07b9e368fd902e91fcc6/`（同一工单、同一 1440×900 视口与深色主题，
基线 `3cc552d` 的实例与本分支实例各一份）。
