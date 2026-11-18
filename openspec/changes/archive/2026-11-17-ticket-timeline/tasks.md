## 1. 事实表与写入点

- [ ] 1.1 `src/app/store.ts` 增加 `fact` 表（`id INTEGER PRIMARY KEY AUTOINCREMENT`、`ticket`、
  `at`、`type`、`data`、`origin`）与 `fact_ticket_at` 索引，加进构造函数建表块；`Store.atomic`
  里写入的事实与业务写入共用同一事务（回滚时一起消失）。
- [ ] 1.2 `src/core/ports.ts` 增加事实类型（`Fact`、`FactOrigin = 'recorded' | 'derived'`、
  事实 `type` 联合），并在 `Repositories` 上增加 `facts.append(...)` / `facts.of(ticketId, limit)`；
  `src/core/memory.ts` 的 `MemoryRepositories` 用内存数组实现同一接口（含 atomic 快照回滚）。
- [ ] 1.3 在 `Repositories` 的每个写方法里接上事实记录：`tickets.create/bind/end/restart/subscribe`、
  `assignments.started/report/end`、`evals.decide/policyChanged`、`intake.receive`、
  `engine` 里四处 `options.emit?.` 的 `question.*`。事实的 `at` 取该方法已用的同一个时刻字符串。
  `dispatch.fast_path` 例外：`signalFastPath`（`src/core/engine.ts:53`）不改业务状态，
  自己开一次 `atomic` 单独写这条事实。
- [ ] 1.4 `src/core/ports.ts` 的 `OutboundMessage` 增加可选 `queuedAt`；`src/app/outbox.ts` 的
  `send` 写入它，`receipts.add` 保留它；`receipt.queued`/`receipt.sent`/`receipt.dropped`
  三种事实分别挂在 `send`、`settle(id,'sent')`、`settle(id, reason)` 上，`dropped` 带原因。
- [ ] 1.5 `tests/timeline-facts.spec.ts`（新）：表驱动断言 `DomainEvents` 的每个成员都至少产生
  一条事实；一条「触发→建单→派工→报告→提问→答复→回执→结束」的端到端顺序断言；
  事务回滚不留事实；清空 `fact` 表后编排行为不变。

## 2. 读取入口

- [ ] 2.1 `src/app/store-read.ts` 增加 `facts(ticketId, limit)`（按 `at`、`id` 升序，
  返回 `{facts, truncated}`），走 `fact_ticket_at` 索引。
- [ ] 2.2 新建 `src/app/views/timeline.ts`：`ticketTimeline(host, ticketId)` 校验工单存在
  （不存在抛 `UserError` 带 `missing`），把事实映射成带一句摘要的视图行，
  `at: null` 保持为 `null` 并把 `origin` 带出去。
- [ ] 2.3 `src/app/api.ts` 增加 `'GET tickets/:id/timeline'`；`src/app/http.ts` 增加
  `ticketTimelinePage`（404 文案 `Ticket not found`）并接到 `ticketPage` 之外的新路由；
  上限 200，`truncated` 透出。
- [ ] 2.4 `src/app/resources.ts` 增加 `ticket/<id>/timeline` 描述（`holds` 一句话说明
  按时间升序、含 `origin`），并在 `ResourceHost` 的 `store` 选取里加上 `read.facts`。
- [ ] 2.5 `tests/http.spec.ts` / `tests/views.spec.ts` / `tests/tools.spec.ts` 补用例：
  未知工单 404、空链返回 `[]`、`truncated` 生效、资源读取与 HTTP 同序。

## 3. 面板

- [ ] 3.1 `src/client/ticket.tsx` 在既有 `Details` 折叠区增加一行「时间线」（默认收起），
  展开后按时间升序渲染时刻、类型、摘要；`origin = 'derived'` 行带「推导」标记，
  `at: null` 显示「无时刻」；无事实时显示「未记录事实」。
- [ ] 3.2 收起时不发额外请求：时间线数据随 `GET tickets/:id` 一次带回（或展开时才 `call`
  时间线接口），选定一种并在实现里注释原因；面板安静原则（`docs/005-panel.md`）不变。
- [ ] 3.3 `src/client/locales.ts` + `locale/{en,zh}.json` 增加时间线相关文案，
  `tests/locales.spec.ts` 的中英文占位符对齐通过。

## 4. CLI `why`

- [ ] 4.1 `scripts/dsh-superagent` 把 `action` 改成 argparse subparsers，
  保留 `start|stop|restart|status` 的既有参数、输出与退出码（0/1/2/3）；
  `tests/service-script.spec.ts` 的精确断言同步更新。
- [ ] 4.2 新增 `why <ticket_id> [--json] [--backfill] [--url] [--profile]`：
  人读输出按时间排列，`--json` 输出与 HTTP 相同的数组；404 映射退出码 4，
  不可达仍退出 1，设置未完成仍退出 3。
- [ ] 4.3 `--backfill` 调 `POST /orchestrator/api/tickets/<id>/timeline/backfill`：
  按 `ticket.createdAt`、`ended.at`、assignment 的 `startedAt`/`endedAt`/`report.at`、
  `question.createdAt`/`answeredAt`/`resolvedAt` 推导 `origin = 'derived'` 事实；
  幂等键为 `(ticket, type, derived key)`，`recorded` 事实优先，推导不出的 `at` 留 `null`。
- [ ] 4.4 `tests/service-script.spec.ts` 补 `why` 的输出与退出码用例（含 4 与 1）。

## 5. 迁移与文档

- [ ] 5.1 `src/app/migration.ts`：`SCHEMA_VERSION` 11→12，新增 `migrateTo12(store)` 只建表与索引；
  `tests/migration.spec.ts` 增加 schema 11 → 12 的用例（既有行不变、`fact` 为空、schema 记为 12）。
- [ ] 5.2 `docs/007-architecture.md` 补 Modules 表里 `src/app/views/timeline.ts` 一行、
  Tests 表里 `tests/timeline-facts.spec.ts` 一行（`tests/docs.spec.ts` 会检查）。
- [ ] 5.3 `docs/005-panel.md` 记录「时间线」在工单详情页的位置、默认折叠与「无时刻/推导」标示规则。
- [ ] 5.4 `openspec/README.md` 当前状态段补登 `ticket-timeline`；`docs/notes/2026-11-18-ticket-timeline-proposal.md`
  写清根因、方案、坑与验证命令。
- [ ] 5.5 `tests/model-surface.spec.ts` 的提示词预算随 `ticket/<id>/timeline` 进入资源语法更新，
  必要时同步 `prompts/` 里 `orchestrator_read` 的说明。
- [ ] 5.6 `env -u GIT_CONFIG_GLOBAL pnpm vitest run`、`pnpm check`、`openspec validate --all --strict` 全绿。
- [ ] 5.7 生产实例 `superagent`（`http://127.0.0.1:3082`）实测本提案验收标准第 4 条的四件事，
  把命令与真实输出贴进 PR。
- [ ] 5.8 交接验证：开新会话，只读 `openspec/changes/ticket-timeline/` 与
  `docs/notes/2026-11-18-ticket-timeline-proposal.md`，能让它复述事实表结构、写入点、
  三个读取入口、回填语义与未决问题。
