## Why

worker 的问题只能问人。`Attention` 的注释就是「A question for a person」
（`src/core/model.ts:276-277`），工单只有一个 `attention` 槽（`:289`）；worker 提问要求一个
能回复的人类 trigger（`src/core/assignments.ts:108`），存进 `ticket.attention`（`:114-121`）；
主会话的 `purpose=answer` 也要求 `trigger.human`（`src/core/replies.ts:78`）；没有任何路径把
答复写回 worker 会话。`orchestrator_ticket_note` 只是事实（`src/core/engine.ts:263`），
`prompts/work.md:44` 只允许为人阻塞，`prompts/dispatch.md` 又禁止主会话做技术决策。

后果：

- 所有者是唯一的答复者；worker 要么猜，要么阻塞，没有「先问 orchestrator，超出授权再升级给人」
  这一层。
- 每次提问都产生一条 IM，打断人；实现/文件/测试这类主会话本可确认的选择也变成人的工作。
- 同一次阻塞只能有一个问题；第二个问题会覆盖第一个，人只看到最后一个。
- 人的答复只发到 IM，不回到 worker；worker 只能等下一次 trigger，或者永远不知道答案。

agent-autoloop 的 ask 也是问人（没有 agent-to-agent 咨询），但它的 question 原语可复用：
`ask[{title,text,options,recommend,about,key}]`，答案只接受一次，resolve 结案，key 在条目内去重，
fyi 只通知；`answer` 把 `card.answered` 重新入队到原 lane（`kernel/decide.ts:519-553`）。
本变更借用「问题是一等状态、答案是新的 Input」这两点，不声称 autoloop 有 orchestrator 咨询。

## What Changes

- 把单一 `Tickets.attention` 升级为 `ticket.questions: Question[]`：
  `id, key?, from, to: "orchestrator" | "person", question, options?, recommend?, blocking,
  context?, triggerId?, assignmentId?, answer?, answeredBy?, answeredAt?, basis?, resolution?`。
  同一工单可有多个未决问题；开放问题按 key 去重。
- worker 的 `orchestrator_report` 增加 `question`、`question_for`、`options`、`recommend`、`key`、
  `context`：`question_for: "orchestrator"` 时问题进主会话，不产生 IM；`"person"` 保持现有语义。
  `human_action` 保留为 `"person"` 的兼容别名，与 `question` 同时给出时拒绝。
  `blocking` 由报告状态决定：`blocked` 为真，`progress` 为假，`ready/dropped/failed` 带问题拒绝。
- 主会话新增 `orchestrator_answer(question_id, answer, basis)`：在授权内回答问题，记录
  `answeredBy/answeredAt/basis` 和 `question.answered` 事件，并把答复作为一条 `answer` Input
  投递给 worker；不写 outbox、不发 IM。
- 主会话新增 `orchestrator_escalate(question_id, reason)`：超出授权/产品决策/真实成本/不确定时，
  把问题改为 `to: "person"`，附升级理由，按现有 attention 路径发给所有者（host 合成正文，
  见 `host-owned-mechanics`）。
- `orchestrator_reply purpose="attention"` 增加可选的 `question_id`（兼容精确问题文本），
  定位到一条开放的 person Question；人的答复在发送成功后写回 `Question`，并同样作为
  `answer` Input 唤醒 worker，补上目前缺失的闭环。
- worker 新增 `orchestrator_resolve(question_id)`：提问者可结案；未发送的 attention 撤回，
  已发送的只标记 resolved，不再提醒。
- 面板/`orchestrator_read` 显示未决问题、目标（orchestrator/person）、选项、推荐、答复与依据；
  等待 orchestrator 的工单有独立 stage，不混进「等人回答」。
- 旧存储里的 `ticket.attention` 在读取时归一化为一条 `to: "person"` 的 Question，保留原 id，
  使未发送的 `attention-reply:<id>` 仍可投递。

## Capabilities

### New Capabilities

- `orchestrator-consult`: 多问题、双目标（orchestrator/person）、带依据的答复、升级、结案与
  答复回写 worker。

### Modified Capabilities

无。

## 明确不做

- 不做 deadline/超时自动升级/提醒（review 的 P1-2）。本变更只做问题生命周期里 P0 必需的部分。
- 不做 agent-to-agent 咨询，不做 worker 之间的提问；只有 worker → 主会话/人。
- 不改变真实成本闸门、公开接口、定价、文案、跨仓库必须人答的规则；`orchestrator_answer`
  不提供绕过这些约束的能力。
- 不把问题存进新表；`questions` 是 `Ticket` JSON 的一部分，无 schema 版本变更。
- 不让主会话替人回答 `to: "person"` 的问题；`orchestrator_answer` 只接受目标为 orchestrator
  的开放问题。
- 不新增 IM 通道；orchestrator 答复零 IM，person 答复仍走现有 outbox。

## 验收标准

1. `env -u GIT_CONFIG_GLOBAL pnpm vitest run tests/questions.spec.ts` 通过：worker 问
   「测试放哪」→ 主会话回答（带 basis）→ 无 outbox/IM → worker 收到一条 `answer` Input →
   `Question` 显示 answeredBy/answeredAt/basis → `waitsForQuestion` 变假。
2. 同一测试文件覆盖：worker 问「改公开 API」→ 主会话 escalate → 人收到一条 attention（含问题、
   选项、推荐、升级理由）→ 人答复 → worker 收到 `answer` Input，`answeredBy: "person"`。
3. `env -u GIT_CONFIG_GLOBAL pnpm vitest run tests/assignments.spec.ts tests/replies.spec.ts
   tests/stage.spec.ts` 通过：旧 `attention` 迁移、同 key 去重、resolve、工单结束时关闭问题、
   stage 区分 orchestrator/person。
4. `pnpm check`、`openspec validate --all --strict` 通过。
5. 在 superagent `:3082` 上实测：构造一张 worker 提问到 orchestrator 的工单，主会话回答后
   worker 继续，聊天里没有新 IM；再构造一次 escalate，人回复后 worker 恢复。
6. 纯文档交接：新会话只读本变更四件套，能复述 Question 字段、两种目标、答案 Input 的 id 与
   投递路径、升级/结案规则、旧 attention 迁移方式。

## Impact

- 代码：`src/core/model.ts`（Question/Ticket/Input）、`src/core/assignments.ts`（report/ask）、
  `src/core/replies.ts`（attention 选择与答复回写）、`src/core/tickets.ts`（答案 Input、结束关闭）、
  `src/core/stage.ts`（orchestrator stage）、`src/core/engine.ts`（answer/escalate 用例）、
  `src/app/tools/executor.ts`（report 字段 + resolve）、`src/app/tools/main.ts`
  （answer/escalate）、`src/app/notices.ts`（worker_question relay）、`src/app/turn-guard.ts`
  （owed 包含 worker_question）、`src/app/views/*`、`src/client/*`（stage/问题展示与文案）。
- 数据：`Ticket.questions` 为可选 JSON 字段；旧 `attention` 读取时迁移，无 schema 版本变更。
- 提示词：`prompts/work.md`（先问 orchestrator、何时直接问人、答复后继续）、
  `prompts/dispatch.md`（收到问题如何答/升级）、`prompts/replies.md`（attention 用问题 id）；
  控制新增字数，更新预算。
- 测试：`tests/questions.spec.ts`（新）、`tests/assignments.spec.ts`、`tests/replies.spec.ts`、
  `tests/stage.spec.ts`。
- 文档：`docs/notes/2026-11-17-openspec-p0-plan.md`。
