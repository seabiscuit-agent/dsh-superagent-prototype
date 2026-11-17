# ticket-timeline 提案：工单事实链（面板时间线 + `why` CLI）

日期：2026-11-18；变更目录：`openspec/changes/ticket-timeline/`（纯文档，无运行时代码改动）。
参考：`docs/agent-autoloop-gap-proposals.md` 第 1 节；设计来源 https://github.com/KKKKhazix/agent-autoloop
（只取「追加写 / 同事务 / 不伪造旧时刻」三条理念，未照抄代码）。

## 根因

一张工单只剩最终状态：报告被后一份覆盖（`src/core/assignments.ts:172`）、结束原因只留最后一次
（`src/core/tickets.ts:376`）、回执 `status` 被就地改写（`src/app/store.ts:277`）、
`OutboundMessage` 连排队时刻都没有（`src/core/ports.ts:72`）。`DomainEvents` 已经是有 18 个成员的
完整词汇表（`src/core/ports.ts:88-112`），但只被 `src/app/runtime.ts:188-205` 用来推通知，重启即失。
于是排障只能翻会话记录。

## 提案要点

- 新表 `fact`（`ticket`/`at`/`type`/`data`/`origin` + `fact_ticket_at` 索引），只 INSERT，
  与业务写入在同一个 `Store.atomic` 事务里提交。
- 词汇表复用 `DomainEvents`，只补 `report.recorded`、`receipt.{queued,sent,dropped}`、`question.withdrawn`；
  `OutboundMessage` 加可选 `queuedAt`，旧回执缺失就显示「无时刻」。
- 三个读取入口同一条链：`GET /orchestrator/api/tickets/<id>/timeline`、
  `orchestrator_read ticket/<id>/timeline`、工单页默认折叠的「时间线」行。
- `scripts/dsh-superagent why <ticket-id> [--json] [--backfill]`，未知工单退出 4。
- 回填显式、幂等、标 `origin: "derived"`，不覆盖 `recorded`，推导不出的时刻留空。
- 业务表仍是权威状态：清空 `fact` 表只影响时间线（有测试守着）。

## 明确不做

不引入 autoloop 的 `rules.json`/`hub.db`/facts→projections 重建；不做事件溯源、快照、事实压缩；
不记录模型原始对话；通知仍由 `emit` 当场产生；恢复路径仍走 `assignmentInterrupted`，
不从事实回放。

## 坑 / 需要实施时确认的点

- `question.*` 三种事件不是通过 `Part.emit` 辅助方法发出的，而是 `src/core/engine.ts:288`、
  `:305`、`:321`、`:341` 直接 `this.options.emit?.(...)`；记录点要覆盖两种写法。
- 问题撤回有三处状态迁移（`src/core/assignments.ts:139`、`:167`、`src/core/tickets.ts:361`）却没有事件。
- `scripts/dsh-superagent` 现在是单位置参数 `action`，加 `why` 需要改成 subparsers；
  `tests/service-script.spec.ts` 断言精确 stdout，必须同步改。
- 新文件要登记：`src/app/views/timeline.ts` → `docs/007-architecture.md` Modules 表；
  `tests/timeline-facts.spec.ts` → Tests 表（`tests/docs.spec.ts` 会查）。新增 `class` 必须有 JSDoc
  （`tests/class-docs.spec.ts`）。
- `DomainEvent` 顺序断言的测试文件不要复用 `tests/timeline.spec.ts`（那是 Thread 页分页）。

## 验证

```sh
openspec validate --all --strict          # 7 passed, 0 failed
openspec status --change ticket-timeline   # 4/4 artifacts
openspec show ticket-timeline --json | head
```

实施阶段（提案未实施，以下命令尚未运行）：`env -u GIT_CONFIG_GLOBAL pnpm vitest run tests/timeline-facts.spec.ts`、
`pnpm check`，以及生产实例 `superagent`（`http://127.0.0.1:3082`）的 `why` 与 curl 实测。
