## Why

worker 向人提问时，问题已经写成工单上的 `Question`（`src/core/model.ts:310`），但面板只显示
阻塞问题的文本和一个「去原通道回答」的链接（`src/client/ticket.tsx:175-180`）：没有选项按钮，
也不能在面板里作答。人只能回到 Feishu/GitHub 回复，主会话的 `orchestrator_reply purpose=answer` 是另一条入口；
现有 `personAnswered` 在已答时静默返回（`src/core/engine.ts:322-332`），`replies.answer` 只
匹配开放问题，没有共享的答案槽和并发语义。如果直接加面板按钮，面板、对话和 GitHub 会各写
各的，worker 可能收到两条互相矛盾的答案。

新面板也没有现成的撤回窗口可复用：答案一旦写入就是最终，误点只能再发一条更正，但 worker
可能已经把旧答案当成事实。现有 `answer` Input 的投递还有缺口：`inputMessage` 对 `kind: "answer"` 返回
`undefined`（`src/executor/dsh.ts:157-165`），`deliverQueued` 仍会把它标成已投递
（`:319-321`），worker 可能根本收不到答案。面板作答必须先修这条地基。

所有者已定：面板点选即正式回答；同一问题只有一个答案槽，先到先算；撤回只在 worker 未消费前
有效；超时走更正；不复用 `dsh-redo`。

## What Changes

- 面板问题卡片：所有开放 person 问题显示问题、`context`、`options` 按钮、推荐标记、阻塞标记；
  保留原通道链接作为另一条入口；点选即提交，不做二次确认。
- 统一答案槽：新增 `Engine.answerPersonQuestion(ticketId, questionId, text, { entry, holdMs })`，
  面板、`orchestrator_reply purpose=answer`、outbox 回写都走它；返回
  `answered | pending | alreadyAnswered | ...`；同一 question id 只产生一条有效答案 Input。
- 撤回窗口：面板答案先写 `Question.answer/answeredAt/withdrawableUntil`（固定 15 秒），但
  **不立即**生成 `answer` Input；窗口内 `POST .../withdraw` 清空答案并取消待提交 effect；窗口
  结束由持久化 effect 提交为 Input 并投递。窗口内 worker 不可能消费；窗口结束即最终。
- 超时更正：`POST .../correct`（主会话 `orchestrator_reply` 带 `correction: true`）把旧答案压入
  `corrections`，写新答案，追加 `question-correction:<id>:<n>` Input（`correction: true`），
  立即投递；更正不可撤回。
- 可观察性：`ticketDetail` 返回全部 questions（含 answered/withdrawn/corrected）、
  `withdrawableUntil`、`committedAt`、`corrections`；面板显示已答人/时间、撤回倒计时、更正入口
  与失败原因。
- 投递修复：`inputMessage` 支持 `answer` 与 `correction`，worker 看到问题 id、答案、依据与更正
  标记；`deliverQueued` 不再把未格式化的 Input 当已投递。
- 不做 IM：面板作答不写 outbox、不发 Feishu/GitHub；原通道只在人主动回复时使用。

## Capabilities

### New Capabilities

- `ticket-question-answers`: 面板点选作答、统一答案槽、投递前撤回、超时更正与答案审计。

### Modified Capabilities

无。

## 明确不做

- 不复用 `dsh-redo`，不做会话级回退/重放。`dsh-redo` 无法只撤销一个问题答案，且会回滚 worker
  已产生的文件、命令和 PR 副作用；所有者已明确不复用。
- 不做可配置窗口、不做按人/按问题的差异化窗口；固定 15 秒，后续需要再开变更。
- 不做面板自由文本作答/更正的富文本编辑器。面板只提交 `options` 中的一个选项；没有 `options`
  的问题仍走原通道，面板保留链接但不显示按钮。
- 不做 IM 二次确认，也不要求面板答案同步到原通道；原通道只是另一条入口。
- 不改变 `to: "orchestrator"` 问题的回答路径（`orchestrator_answer`）；面板不替主会话回答。
- 不把 `Question` 拆表、不改 schema 版本；只加可选字段。
- 本变更只交付 OpenSpec 四件套与 `docs/notes`，不改运行时代码或 UI；实施在后续变更/PR 中做。

## 验收标准

1. **规格校验**：`openspec validate --all --strict` 输出 `passed, 0 failed`；
   `openspec status --change ticket-question-answers` 显示 4/4 artifacts complete。
2. **纯文档交接**：新会话只读四件套，能复述答案槽的 id/字段、撤回窗口、提交 effect、更正路径、
   面板路由与失败码，不需要读实现。
3. **面板作答（实施后）**：在 superagent `:3082` 构造 worker 问人「用哪个目录」+ 两个 options；
   面板出现按钮；点选后 `GET tickets/<id>` 的该问题有 `answer`、`answeredBy: "person"`、
   `withdrawableUntil`；worker 在窗口结束后收到一条 `answer` Input，内容含问题 id 和答案。
4. **投递前撤回（实施后）**：点选后 15 秒内点「撤回」，问题回到开放且 `answer` 清空；worker
   从未收到该答案的 Input；面板重新显示按钮；窗口结束后再点撤回返回 `withdrawExpired`
   （提交 effect 已运行时返回 `alreadyCommitted`）。
5. **超时更正（实施后）**：窗口结束后点「更正」，选另一个 option；worker 收到
   `question-correction:<id>:1` Input（`correction: true`），问题 `answer` 为新值，
   `corrections` 保留旧值；再次撤回返回 `notWithdrawable`。
6. **先到先算（实施后）**：面板点选与 `orchestrator_reply purpose=answer` 同时到达，只有一条
   答案生效；后到入口返回 `alreadyAnswered`/`answerPending`，不产生第二条有效 Input，通道最多
   一条回复消息。
7. **重启（实施后）**：撤回窗口内重启 host，问题、`withdrawableUntil` 与待提交 effect 保留；
   窗口结束答案仍投递；截止前撤回仍可用。
8. **构建（实施后）**：`pnpm check` 通过；`inputMessage` 对 `answer`/`correction` 返回非空文本，
   `deliverQueued` 不再把未格式化 Input 标记为已投递。
9. **结束（实施后）**：工单在窗口内结束时不投递答案 Input；面板只读显示 ended，不显示可操作
   按钮。

## Impact

- 代码：`src/core/model.ts`（Question/TicketInput）、`src/core/engine.ts`（answer/withdraw/
  correct/commit）、`src/core/tickets.ts`（addInput/deliver）、`src/core/replies.ts`（answer/
  correction 入口）、`src/app/effects.ts`（answer commit effect）、`src/executor/dsh.ts`
  （inputMessage/deliverQueued/delivery handler）、`src/app/http.ts`（routes）、
  `src/app/views/tickets.ts`/`records.ts`、`src/client/ticket.tsx`/`api.ts`/`locales.ts`、
  `prompts/*`。
- 数据：`Question` 新增 `withdrawableUntil?`、`committedAt?`、`withdrawnAt?`、`withdrawnAnswer?`、
  `correctedAt?`、`corrections?`；`TicketInput` 的 answer 变体新增 `correction?: boolean`；
  无 schema 版本变更。
- 测试：新增 `tests/question-answers.spec.ts`；扩展 `tests/questions.spec.ts`、
  `tests/replies.spec.ts`、`tests/tickets.spec.ts`；面板交互在 `:3082` 实测。
- 文档：`docs/notes/2026-11-18-ticket-question-answers-proposal.md`；`openspec/README.md`
  当前状态。
