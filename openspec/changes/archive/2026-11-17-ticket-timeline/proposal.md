## Why

一张工单走到今天，往往只剩下最终状态：`ticket` 表每行的 JSON 被反复覆盖，报告被后一份报告盖掉
（`src/core/assignments.ts:172` 覆写 `assignment.report`），结束原因只有最后一次
（`src/core/tickets.ts:376`），回执的 `status` 从 `pending` 直接改成 `sent`/`dropped`
（`src/app/store.ts:277`），`OutboundMessage` 本身连排队时刻都没有
（`src/core/ports.ts:72`）。`DomainEvent` 已经是「发生了什么」的完整词汇表
（`src/core/ports.ts:88-112`，18 种），但它只用于给主会话推通知
（`src/app/runtime.ts:188-205`），进程一重启就没了。

所以排障时只能翻会话记录：为什么这张工单在等一个人？那次派工为什么被切断？哪条回执没发出去、
是没排队还是排队后被丢？现有 `ticket/<id>` 只给当前值，给不出「按时间排列的事实链」。
`docs/agent-autoloop-gap-proposals.md` 第 1 节把这块列为四块缺口的第 1 块（无依赖，可先做）。

## What Changes

- 新增 append-only 的 `fact` 表：每行一条工单事实（时刻、类型、结构化数据、来源 `recorded`/`derived`），
  与产生它的业务写入在同一个 `Store.atomic` 事务里落盘，业务写入回滚时事实一起回滚。
- 事实词汇表就是现有的 `DomainEvent`，并补三种今天没有事件可记的事实：`report.recorded`、
  `receipt.*`（入队/发出/丢弃）、`question.withdrawn`。`OutboundMessage` 的回执补 `queuedAt`，
  旧回执缺失时留空而不是补一个假时刻。
- 新增读取入口：主会话与 worker 用 `orchestrator_read ticket/<id>/timeline`，
  面板与 CLI 用 `GET /orchestrator/api/tickets/<id>/timeline`；返回按时刻升序的事实链、
  被截断时为 `truncated: true`。
- 工单详情页新增一行默认折叠的「时间线」（沿用 `Details`/`DisclosureRow`，与现有 assignments、
  environment 同一套折叠），展开后按时间顺序显示事实，缺时刻的行显示为「无时刻」。
- `scripts/dsh-superagent` 增加 `why <ticket-id> [--json]`：人读输出与 `--json` 原始事实，
  服务不可达仍退出 1，未知工单退出 4。
- 旧工单不自动编造历史：`why <ticket-id> --backfill` 显式地按现有字段（`createdAt`、
  `ended.at`、assignment 的 `startedAt`/`report.at`）推导一遍，写成 `origin: "derived"` 的事实，
  幂等、不覆盖已记录事实、面板与 `why` 都标出来源。回填是唯一写事实的 HTTP 通路
  （`POST /orchestrator/api/tickets/<id>/timeline/backfill`，与既有管理接口一样要求同源头）。
- 事实只读：任何行为都不读 `fact` 表，业务表仍是权威状态（不引入 autoloop 的
  facts → projections 重建机制）。

## Capabilities

### New Capabilities

- `ticket-timeline`：工单事实链的落盘、读取、面板折叠视图、`why` 命令与旧工单按需回填。

### Modified Capabilities

（无。`local-dispatch-source` 的派工语义不变；`ticket-agenda` 的 agenda 行为不变，
其到点投递会作为已有事件顺带进入时间线。）

## 明确不做

- 不引入 agent-autoloop 的 `rules.json`、`hub.db`、`facts → projections → rebuild` 那套
  「日志即权威、投影可重建」机制；本仓库的业务表继续是权威状态，事实链只做可观察的历史。
- 不做事件溯源式状态重建、不做快照、不做事实压缩或归档策略。
- 不把事实链当审计合规材料：它记录领域事件，不记录模型原始对话（会话记录仍在原处）。
- 不改 `DomainEvent` 的既有语义，也不把通知改成从事实表回放生成；`emit` 的通路与 quiet 语义保持。
- 不做「按事实链回溯重放」的恢复路径，重启恢复仍走 `assignmentInterrupted` 与 `resume-master-turn`。

## 验收标准

1. `env -u GIT_CONFIG_GLOBAL pnpm vitest run tests/timeline-facts.spec.ts` 通过：新测试覆盖
   「同一事务回滚不留下事实」「每个 `DomainEvents` 成员至少被记录一次」「派工→报告→问题→答复→
   回执→结束」一条端到端链路的顺序，以及 `origin: "derived"` 不覆盖 `recorded`。
2. `env -u GIT_CONFIG_GLOBAL pnpm vitest run` 全绿；`pnpm check`（`typecheck` + `test` + `build`）退出码 0。
3. `openspec validate --all --strict` 退出码 0。
4. 生产实例 `superagent`（`http://127.0.0.1:3082`）实测，`openspec` 校验通过之后做：
   - `curl -s -H 'x-orchestrator-request: 1' http://127.0.0.1:3082/orchestrator/api/tickets/<一张已结束工单的 id>/timeline`
     返回 `facts` 数组，元素含 `at`、`type`、`data`，且时刻升序；
   - `./scripts/dsh-superagent why <同一 id>` 打印同一条链的人读版本，`--json` 打印同样的数组；
   - 面板 SuperAgent 工单页出现「时间线」折叠行，默认收起，展开后与 `why --json` 顺序一致；
   - `./scripts/dsh-superagent why does-not-exist` 退出码 4 且不创建任何事实。
5. 新会话只读本目录 + `docs/notes/2026-11-18-ticket-timeline-proposal.md` 就能接着实施：
   能说出事实表结构、写入点、三个读取入口、回填语义与已知取舍。

## Impact

- 代码：`src/core/ports.ts`（事实类型、`Repositories.facts`、`queuedAt`）、
  `src/core/model.ts`、`src/core/assignments.ts`、`src/core/tickets.ts`、`src/core/engine.ts`、
  `src/core/memory.ts`、`src/app/store.ts`、`src/app/store-read.ts`、`src/app/migration.ts`、
  `src/app/views/timeline.ts`（新）、`src/app/http.ts`、`src/app/api.ts`、`src/app/resources.ts`、
  `src/app/outbox.ts`、`src/client/ticket.tsx`、`src/client/locales.ts`、`locale/{en,zh}.json`、
  `scripts/dsh-superagent`。
- 数据：新表 `fact`，schema 从 11 升到 12；`outbox` 的 JSON 增加可选 `queuedAt`。
  旧库迁移只建表与索引，不回填、不改既有行；`fact` 为空时读取返回空数组而不是错误。
- 提示词：`ticket/<id>/timeline` 进入工具描述与资源语法，`prompts/` 里的 `orchestrator_read`
  说明需要同步，模型面预算（`tests/model-surface.spec.ts`）随之更新。
- 测试：新增 `tests/timeline-facts.spec.ts`；`tests/views.spec.ts`、`tests/http.spec.ts`、
  `tests/tools.spec.ts`、`tests/migration.spec.ts`、`tests/locales.spec.ts`、
  `tests/service-script.spec.ts`、`tests/model-surface.spec.ts` 需要跟着改。
- 文档：`docs/007-architecture.md` 的 Modules/Tests 表、`docs/005-panel.md` 的时间线位置与折叠约定、
  `openspec/README.md` 当前状态段、`docs/notes/2026-11-18-ticket-timeline-proposal.md`。
