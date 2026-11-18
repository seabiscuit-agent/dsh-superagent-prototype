# 工单问题面板点选作答实施记录（2026-11-18）

## 根因

- 面板只把阻塞问题渲染成横幅加「去原通道回答」，人不能在面板点选项；`ticketDetail`
  的 `questions` 来自 `ticketSummary` 的 `openQuestions`，看不到 pending/answered/withdrawn。
- `answerQuestion` 只接受 orchestrator 问题，`personAnswered` 只在通道回复发出后回写，
  面板、通道、outbox 各写各的，无法保证一个答案槽。
- `src/executor/dsh.ts` 的 `inputMessage` 没有 `answer` 分支，`deliverInput` 对
  `undefined` 直接返回，而 `deliverQueued` 仍调 `inputsDelivered`，答案会被静默吞掉。

## 本次修复

- `src/core/model.ts`：`Question` 增加 `withdrawableUntil` / `committedAt` / `withdrawnAt` /
  `withdrawnAnswer` / `correctedAt` / `corrections`；`TicketInput.answer` 增加
  `correction?: true`；导出 `WITHDRAW_WINDOW_MS = 15_000`、`pendingAnswer`、`canWithdraw`。
- `src/core/engine.ts`：新增 `answerPersonQuestion`（面板/通道共用、先到先算、15 秒窗口）、
  `commitAnswer`（effect 与 holdMs=0 共用）、`withdrawAnswer`、`correctAnswer`；
  `personAnswered` 改为 `answerPersonQuestion(..., holdMs: 0)`，输掉竞态时记录
  `question.answer-ignored`。工单结束把 pending 答案标记 withdrawn 且不生成 Input
  （`src/core/tickets.ts`）。
- `src/core/replies.ts`：`orchestrator_reply purpose=answer` 先查答案槽（`alreadyAnswered` /
  `answerPending` / `notPersonQuestion`）；`correction: true` 走 `correctAnswer` 并发送
  `question-correction-reply:<qid>:<n>` 回执。
- `src/app/effects.ts` + `src/app/runtime.ts`：持久化 `answer` effect（key 为 question id，
  重复入队幂等），到期提交；撤回/已答/更正时取消。outbox 发送 reply 前检查问题是否已被
  其他入口作答，未采用时以 `answeredElsewhere` 丢弃。
- `src/app/views/tickets.ts` + `src/client/ticket.tsx`：详情返回全部问题与
  `canAnswer` / `canWithdraw` / `canCorrect`；面板改为问题卡片（选项按钮、推荐/阻塞标签、
  倒计时撤回、已答/已撤回/更正历史、无选项与已结束提示、原通道链接）。
- `src/app/http.ts` / `src/client/api.ts`：新增 answer/withdraw/correct 三条同源路由，冲突
  错误码映射 409；`src/app/tools/main.ts` 的 `orchestrator_reply` 支持 `correction`。

## 坑

- 撤回边界是「worker 是否可能消费」，不是「面板是否显示」：pending 期间不能有 Input，
  否则撤回会留下 `undelivered`/`delivered` 半状态。
- `reopen` 等没有正文的 Input 不能在 `deliverInput` 返回后无条件标记已投递；现在返回
  `false` 并走 `deliveryFailed`，保留 `undelivered`。
- `MemoryRepositories` 返回副本：`reply` 在 `correctAnswer` 之后要重新读取 ticket/question
  再算 correction 编号与回执 id。
- `question.answer-ignored` 必须走 `record()`（带 DomainEvent），不能只写 Fact，否则时间线
  与事件订阅看不到。
- 面板 union 路由模板串无法收窄，`submit` 用三个显式 `call` 分支。
- 本 worker 环境自带 `GIT_CONFIG_GLOBAL`，会让 `tests/runtime.spec.ts` 的环境恢复断言失败；
  用 `env -u GIT_CONFIG_GLOBAL pnpm check` 验证。

## 验证

```sh
env -u GIT_CONFIG_GLOBAL pnpm check   # typecheck + 1357 tests + build
openspec validate --all --strict
openspec status --change ticket-question-answers
```

面板实测（superagent profile :3082，1440x900，light）：点击选项 → 15 秒内撤回 → 再答 →
到期提交 → 更正；worker 只在提交/更正后收到 answer Input。截图见
`docs/evidence/f4c5bfe9ef36f4774e30b4b620610358/`。
