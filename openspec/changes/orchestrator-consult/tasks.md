# 实施任务（讨论定稿后执行；当前全部未开始）

## 1. 领域模型

- [x] 1.1 `src/core/model.ts`：新增 `Question` 类型与 `Ticket.questions: Question[]`，删除
  `Ticket.attention`；`TicketInput` 增加 `answer`（`questionId`、`text`、`basis`、`answeredBy`）。
- [x] 1.2 `src/core/migration.ts`：`migrateQuestions(ticket)` 把旧 `attention` 映射为一条
  `to: "person"` 的问题，保留 id/triggerId；覆盖已迁移、字段缺失、空问题三种输入。
- [x] 1.3 `src/core/model.ts`：新增 `waitsForQuestion(ticket)`（任意阻塞问题）与
  `waitsForPerson(ticket)`（阻塞且 to=person）；`liveTicket` 不变。
- [x] 1.4 单元测试：迁移幂等；多问题序列化往返；`waitsFor*` 在 answered/resolved/withdrawn 后为假。

## 2. 提问路径

- [x] 2.1 `src/app/tools/executor.ts`：`orchestrator_report` 增加 `question`、`question_for`、
  `options`、`recommend`、`key`、`context`；保留 `human_action` 为 person 兼容别名，两者同时
  出现时拒绝；校验 `options` 2–5 项、`recommend` 属于 options、key 合法、
  `ready/dropped/failed` 不得带问题；更新工具描述。
- [x] 2.2 `src/core/assignments.ts`：`report()` 创建/更新 Question；`to: "person"` 沿用
  `person()` 的 trigger/通道校验，`to: "orchestrator"` 不要求 trigger；`blocking` 由 state 派生；
  开放问题按 key 去重；不再写 `ticket.attention`；`ready/dropped` 时关闭本 assignment 的问题。
- [x] 2.3 `src/app/notices.ts`：`to: "orchestrator"` 产生 `worker_question` relay（含
  questionId/options/recommend/blocking）；`to: "person"` 仍为 `worker_attention`，带 questionId。
- [x] 2.4 `src/app/turn-guard.ts`：owed 规则包含 `worker_question`；主会话没有回答/升级时触发
  turn-check；worker_question 不产生 IM。
- [x] 2.5 测试：直接问 orchestrator 零 outbox；缺 trigger 的直接问人仍被拒；同 key 更新不新增行。

## 3. 回答路径

- [x] 3.1 `src/core/engine.ts`：新增 `answerQuestion(questionId, answer, basis)`，校验开放、
  `to: "orchestrator"`、非空 answer/basis；写 answeredBy/answeredAt/basis/resolution；emit
  `question.answered`；通过 `tickets.addInput` 投递 `answer` Input。
- [x] 3.2 `src/app/tools/main.ts`：新增 `orchestrator_answer(question_id, answer, basis)`，只在
  主会话可用；返回 `{answered, delivered, questionId}`；错误码 `notFound/notOpen/
  notOrchestratorQuestion/emptyAnswer/emptyBasis`；不写 outbox、不 concludeTurn。
- [x] 3.3 `src/core/tickets.ts`：`answer` Input 不是 automatic，能穿过 blocking 过滤；id 固定为
  `question-answer:<questionId>`，重复调用不重复投递；工单已结束时记录但不投递。
- [x] 3.4 测试：回答后 worker 收到一条 Input；重复 answer 幂等；空 basis/错误目标被拒；
  outbox 无新增。

## 4. 升级与人的答复

- [x] 4.1 `src/core/engine.ts` + `src/app/tools/main.ts`：新增 `orchestrator_escalate(
  question_id, reason)`；校验开放、目标为 orchestrator、reason 非空；改为 person、记录理由、
  发一条 attention；重复调用返回 `alreadyPerson`；发送失败返回 unsent。
- [x] 4.2 `src/app/render.ts`（或 host-owned-mechanics 的 renderer）：attention 正文包含问题、
  options、recommend、升级理由；不超过 IM 字数，保持中文。
- [x] 4.3 `src/core/replies.ts`：attention 分支从 `questions` 中选择匹配问题（精确 question 文本
  或 question_id）；发送成功后写 person answer + `answer` Input；失败保持开放；
  `withdrawAttention(questionId)` 只撤未发送。
- [x] 4.4 测试：升级后 person 收到一条 attention；人答后 worker 恢复；重复升级/重试不重复；
  通道失败保持开放。

## 5. 结案与工单结束

- [x] 5.1 `src/app/tools/executor.ts` + `src/core/engine.ts`：`orchestrator_resolve(question_id)`；
  只允许提问 assignment；设 resolved/resolvedAt；撤回未发送 attention；已回答不可改 resolved。
- [x] 5.2 `src/core/tickets.ts`：`end()`/stop/ready 关闭所有未决问题为 withdrawn，撤回未发送
  attention，不为它们投递 answer Input。
- [x] 5.3 测试：worker 结案；他人结案被拒；结束时问题关闭、无新 Input。

## 6. stage 与展示

- [x] 6.1 `src/core/stage.ts`：增加 `{stage: "orchestrator"; action: "answer"}`；person 阻塞问题
  优先，其次 orchestrator 阻塞问题；更新 `ticketStage` 顺序与测试。
- [x] 6.2 `src/app/views/*`、`src/client/*`：工单列表/详情显示 questions、目标、选项、推荐、
  answeredBy/basis；新增 stage 文案与筛选（zh/en）。
- [x] 6.3 `orchestrator_read` / `GET tickets/<id>` 输出 questions；旧 attention 工单显示为
  person 问题。

## 7. 提示词与文档

- [x] 7.1 `prompts/work.md`：技术选择默认 `question_for: "orchestrator"`；公开接口/定价/文案/
  花钱/跨仓库直接问人；收到 answer 后继续；resolve 的用法。
- [x] 7.2 `prompts/dispatch.md`：收到 `worker_question` 如何 answer/escalate；basis 写什么；
  不替人回答；升级后不再重复回复。
- [x] 7.3 `prompts/replies.md`：attention 用 question_id/精确问题；不把 answer 再自由复述。
- [x] 7.4 更新 `tests/model-surface` 预算并说明增减；新增字数不得让预算单调上涨。

## 8. 验证与交接

- [x] 8.1 `env -u GIT_CONFIG_GLOBAL pnpm vitest run tests/questions.spec.ts
  tests/assignments.spec.ts tests/replies.spec.ts tests/stage.spec.ts` 通过。
- [x] 8.2 `pnpm check` 通过。
- [x] 8.3 `openspec validate --all --strict` 与 `openspec list` 通过。
- [ ] 8.4 在 superagent `:3082` 实测：orchestrator 回答后 worker 继续且无 IM；escalate 后人答
  worker 恢复；旧 attention 工单可回复。（已在分支实例 `:3153` 验证 orchestrator 问答闭环；
  escalate/人答/旧 attention 仍只有自动化测试覆盖）
- [x] 8.5 写 `docs/notes/2026-11-17-orchestrator-consult.md`，记录根因、实现、坑与验证命令。
- [x] 8.6 新会话只读 proposal/spec/design/tasks 能复述字段、目标、答案 Input、升级/结案规则。
