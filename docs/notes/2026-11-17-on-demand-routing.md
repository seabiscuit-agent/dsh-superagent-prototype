# 主会话按需建单（on-demand routing）

日期：2026-11-17
变更：`openspec/changes/on-demand-routing/`

## 根因

Thread 只有「订阅」一种路由语义：ticket 订阅 thread 后，Intake 把所有消息 fanout 给订阅工单，
ticket 结束仍保留订阅。主会话（local Source）走同一条路，于是讨论被直接投给 worker，
工单结束后同话题消息又自动 resume，无法做到「讨论不建单、动手才建单、做完撤订、之后挂回原单」。

## 修复

- `SourceKind.routing`（默认 `subscriptions`）+ `SourceRegistry.routing` + `EngineOptions.routing`；
  local Source 声明 `on-demand`。
- `Intake.receive` 对 on-demand 来源跳过 fanout：消息只生成候选，`attach` 是唯一投递通道。
- `Tickets.end` 对 on-demand 线程静默 `dropSubscriptions(..., 'ticket')`；
  `thread.unsubscribed.by` 增加 `'ticket'`，`eventNotice` 对该值返回 undefined。
- `links.endedOnThread` 把线程上已结束工单补进候选卡 `related_tickets`（最多 4 张），
  使撤订后的工单仍可被 attach 回去。
- 提示词：admission/dispatch/orchestrator/subscriptions 说明讨论直接回答、attach 例外与撤订语义。

## 坑

- `create()` 不为 accept 时的 trigger 建 Input，`ticket.inputs` 初始为空，测试别断言它含首条消息。
- worker 报告 `ready` 结束工单时 `ended.outcome` 是 `completed`，不是 `ready`。
- 候选卡 `tickets` 来自 `thread.subscriptions`；撤订后必须另行查已结束工单，否则 attach 找不到原单。
- orchestrator 提示词有 60,500 字符硬预算，新增措辞要在预算内腾位置，不能只改 BUDGET。
- 本机继承的 `GIT_CONFIG_GLOBAL` 会破坏 runtime 测试的 git 断言，统一用
  `env -u GIT_CONFIG_GLOBAL` 跑。

## 验证

```bash
env -u GIT_CONFIG_GLOBAL pnpm check
openspec validate --all --strict
env -u GIT_CONFIG_GLOBAL pnpm vitest run tests/local.spec.ts tests/cards.spec.ts tests/model-surface.spec.ts
```

相关文件：`src/core/intake.ts`、`src/core/tickets.ts`、`src/app/links.ts`、`src/sources/local.ts`、
`prompts/subscriptions.md`
