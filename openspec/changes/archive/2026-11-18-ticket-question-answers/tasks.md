## 1. 数据模型与 core 操作

- [x] 1.1 在 `src/core/model.ts` 给 `Question` 增加可选字段 `withdrawableUntil`、`committedAt`、`withdrawnAt`、`withdrawnAnswer`、`correctedAt`、`corrections`（`{ text, at, answeredBy }[]`），并给 `TicketInput` 的 `answer` 变体增加 `correction?: boolean`；保持旧工单反序列化兼容。
- [x] 1.2 在 `src/core/model.ts` 增加 `WITHDRAW_WINDOW_MS = 15_000`，并导出 `pendingAnswer(question)` / `canWithdraw(question, now)` 等纯函数，避免面板和 core 各算一套。
- [x] 1.3 在 `src/core/engine.ts` 实现 `answerPersonQuestion(ticketId, questionId, text, { entry, holdMs })`：原子校验开放/person/无 pending/无 answered；面板入口要求 `options` 合法（无 options 返回 `optionRequired`），通道入口允许自由文本但不得为空；写 `answer`、`answeredBy`、`answeredAt`、`withdrawableUntil`，emit `question.answer-pending`；`holdMs = 0` 时直接提交。
- [x] 1.4 实现提交路径：写 `resolution: "answered"`、`committedAt`，用 `tickets.addInput` 生成 `question-answer:<id>`（kind `answer`），emit `question.answered`；抽出 `commitAnswer` 供 effect handler 和 `holdMs = 0` 共用。
- [x] 1.5 实现 `withdrawAnswer(ticketId, questionId)`：校验 pending、窗口内、工单未结束；清空 pending 字段，写 `withdrawnAt` / `withdrawnAnswer`，取消 `answer` effect，emit `question.withdrawn`；错误码 `withdrawExpired` / `alreadyCommitted` / `notWithdrawable` / `ticketEnded`。
- [x] 1.6 实现 `correctAnswer(ticketId, questionId, text)`：只接受已回答 person 问题；窗口内抛 `withdrawInstead`；把旧答案压入 `corrections`，写新答案和 `correctedAt`，生成 `question-correction:<id>:<n>`（`correction: true`）并立即投递，emit `question.corrected`；与当前答案相同的更正 no-op。
- [x] 1.7 让 `personAnswered` 调用 `answerPersonQuestion(..., { holdMs: 0 })`，保留通道回复的既有行为；`answerQuestion`（orchestrator）不变，继续拒绝 person 问题。
- [x] 1.8 在 `src/core/errors.ts` / 错误映射里补齐 `emptyAnswer`、`invalidOption`、`optionRequired`、`answerPending`、`alreadyAnswered`、`notAnswered`、`notOpen`、`notPersonQuestion`、`withdrawExpired`、`alreadyCommitted`、`notWithdrawable`、`ticketEnded`、`withdrawInstead`。

## 2. 投递与 effect

- [x] 2.1 在 `src/app/effects.ts` / effect handler 注册 `answer` kind：到期后原子读取工单，问题仍 pending 且工单未结束时调用 `commitAnswer`；工单已结束或问题已撤回/已答时只清 effect。工单结束路径（`stop`/结束处理）把仍在 pending 的答案标记为 `withdrawn`，不生成 Input。
- [x] 2.2 在 `src/core/tickets.ts` 的 `addInput` 之外提供 `scheduleAnswerCommit(ticketId, questionId, at)`，确保 `answer` effect 的 key 是 question id、payload 是 `{ ticketId, questionId }`，重复入队幂等。
- [x] 2.3 在 `src/executor/dsh.ts` 的 `inputMessage` 增加 `answer` 分支，正文包含问题 id、答案和「来自人」的说明；`correction` 为真的 Input 追加「取代此前答案」的说明。
- [x] 2.4 修正 `deliverQueued` / `deliverInput`：`inputMessage` 返回 `undefined` 时不得调用 `inputsDelivered`，Input 保留在 `undelivered` 并记录可诊断错误，避免答案被静默吞掉。
- [x] 2.5 确认 `answer` / correction Input 走 `addInput` 后能启动 pending assignment 或投递给 running assignment；工单已结束时不再生成 Input。
- [x] 2.6 在 `host.answered` 回写路径里，问题已 answered/pending 时不覆盖、不追加 Input；记录「未采用」的可观察结果。
- [x] 2.7 在 `src/core/replies.ts` 的 `answer` 入口先查答案槽：已提交返回 `alreadyAnswered`，待提交返回 `answerPending`，都不入 outbox；`correction: true` 时转到 `correctAnswer`，未回答返回 `notAnswered`。
- [x] 2.8 更新 `prompts/handoff-worker.md` / `prompts/work.md`：说明 answer Input 是人的正式回答、correction Input 取代旧答案，worker 不需要再向人确认同一问题。

## 3. 视图与面板

- [x] 3.1 在 `src/app/views/tickets.ts` 的 `ticketDetail` 覆盖 `questions`，返回全部 Question，并附 `withdrawableUntil`、`committedAt`、`withdrawnAt`、`withdrawnAnswer`、`correctedAt`、`corrections`、`canAnswer`、`canWithdraw`、`canCorrect`。
- [x] 3.2 保持 `src/app/views/records.ts` 的 `ticketSummary` 只返回 `openQuestions`，列表行为不变。
- [x] 3.3 在 `src/app/http.ts` 注册 `POST tickets/:id/questions/:questionId/answer`、`/withdraw`、`/correct`，沿用 loopback 与 `x-orchestrator-request` 同源校验；错误按现有 `failure()` 映射 400/404/409。
- [x] 3.4 在 `src/client/api.ts` 增加三条 mutation 的类型和调用，复用 `after()` 在成功后 reload。
- [x] 3.5 在 `src/client/ticket.tsx` 把阻塞横幅改为问题卡片：person 问题渲染 `options` 按钮、推荐/阻塞标记、原通道链接；pending 显示倒计时和「撤回」；answered 显示答案/作答人/时间与「更正」；withdrawn 显示旧答案审计与重新选项；corrected 显示当前答案和 `corrections` 历史；ended 工单只读显示、不渲染可操作按钮。
- [x] 3.6 orchestrator 问题只显示「等待主会话回答」，不渲染按钮；没有 `options` 的 person 问题只保留通道链接。
- [x] 3.7 在 `src/client/locales.ts` 增加 zh/en 文案：待投递、可撤回、已投递、已撤回、已更正、更正、撤回、投递失败、选项必填等。
- [x] 3.8 面板对 5 秒轮询和 mutation 后 reload 都保持 pending 倒计时/状态一致；不新增 websocket 或本地状态分叉。

## 4. 测试

- [x] 4.1 core 单测：面板 answer 写入 pending 且不生成 Input；窗口内 withdraw 清空并取消 effect；窗口后 withdraw 返回 `withdrawExpired`；commit 后返回 `alreadyCommitted`。
- [x] 4.2 core 单测：面板先答/通道后到与通道先答/面板后到都只产生一个有效答案槽；并发两次 answer 只有一个成功。
- [x] 4.3 core 单测：correct 在窗口内返回 `withdrawInstead`；提交后追加 correction Input 和 `corrections`；相同答案 no-op；工单结束后拒绝。
- [x] 4.4 effect/重启测试：pending 答案入队后重建 store/runtime，窗口前可撤回，窗口后自动提交并投递一次。
- [x] 4.5 executor 测试：`inputMessage` 对 answer/correction 返回正文；未知 Input 不会被 `inputsDelivered` 静默标记。
- [x] 4.6 HTTP/视图测试：`ticketDetail` 返回全部问题与状态字段；列表仍只返回开放问题；answer/withdraw/correct 路由的错误码与状态码。
- [x] 4.7 面板手工验收（:3082）：点击选项→15 秒内撤回→再答→等待提交→更正；确认 worker 只在提交/更正后收到消息。

## 5. 文档与验收

- [x] 5.1 实施 PR 更新 `openspec/README.md` 的进行中/已实现状态，并在 `docs/notes/` 写实施记录（根因、修复、坑、验证命令）。
- [x] 5.2 运行 `pnpm check`（typecheck + test + build）并记录结果。
- [x] 5.3 运行 `openspec validate --all --strict` 与 `openspec status --change ticket-question-answers`，确保 4/4 artifacts 通过。
- [x] 5.4 在 superagent :3082 实测面板作答/撤回/更正，并把截图放 `docs/evidence/<ticket id>/`，PR 正文用同域 raw URL 引用；截图需包含 Before/After 同一场景、视口、主题。
- [x] 5.5 验收「先到先算」：面板点选后立刻在 Feishu/GitHub 回复同一问题，确认后者被拒绝或未采用，worker 只收到一条答案。
- [x] 5.6 验收「撤回只在投递前有效」：窗口内撤回后 worker 时间线没有 answer Input；窗口结束后撤回按钮消失、只提供更正。
