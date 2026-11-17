## Context

当前 worker 的问题和人的答复是两条断开的路径：`Assignments.report` 把问题写进
`ticket.attention`，`Replies` 把人的回复发到 outbox，但没有任何代码把答复写回 worker 会话。
`attention` 只有一个槽，第二个问题覆盖第一个；`purpose=answer` 又要求人类 trigger。结果是
主会话无法在授权内回答实现问题，所有者成为所有问题的瓶颈。

本变更把「问题」做成工单上的多条状态，把「答复」做成一条 Input，并给主会话一个明确的
answer/escalate 工具面。它不改变人的最终权力，只增加一层「先问 orchestrator，超授权再升级」。

## Goals / Non-Goals

- Goal：一张工单可同时有多条问题；每条有目标、选项、推荐、阻塞性和审计字段。
- Goal：worker 能问 orchestrator；主会话能在授权内答复，且答复回到 worker。
- Goal：超授权/产品决策/真实成本/不确定时升级给人，问题不丢、不重复。
- Goal：人的 attention 答复也回到 worker；旧 attention 数据可读。
- Non-Goal：deadline/自动升级/提醒（P1-2）；agent-to-agent 咨询；改变真实成本闸门；
  把问题放进独立表。

## Decisions

### 1. 用 `questions: Question[]` 替换单一 `attention`

`Ticket.attention` 删除，`Ticket.questions` 成为唯一事实。理由：

- 多问题是 P0 的明确需求；在 `attention` 旁边再加一个数组会出现两套提醒/回复/结束逻辑。
- `Attention` 的字段（id、question、triggerId）是 `Question` 的子集，迁移直接映射。
- 面板、replies、stage 都改为读 `questions`，只有一处判断「在等谁」。

替代方案是保留 `attention` 给 person、新增 `questions` 给 orchestrator；否决原因是同一条问题
可能升级（to 从 orchestrator 变 person），两套存储需要同步，容易出现同一问题两份状态。

### 2. 目标由 worker 在提问时选择，缺省 person

`question` 是新的问题文本字段，`question_for` 缺省 `"person"`；`human_action` 保留为
`"person"` 的兼容别名，两者同时出现时拒绝。新提示词
要求技术选择默认 `"orchestrator"`，只有公开接口、定价、文案、花钱、跨仓库等才直接问人。
理由：

- 缺省 orchestrator 会让所有旧调用先经过主会话，包括本该人答的授权问题；主会话如果判断错，
  问题被延迟。
- 缺省 person 不改变旧行为，新的分层通过提示词和 `question_for` 显式选择落地；代价是 worker
  可能继续直接问人，需要在 `prompts/work.md` 里写清楚默认先问 orchestrator。

这是一个策略选择，不是机械规则；如果 owner 希望强制「一律先问 orchestrator」，可以在
`host-owned-mechanics` 或后续 policy 里加升级规则，本变更不预埋。

### 3. 答复是一条 `answer` Input，不是恢复挂起的调用

worker 的回合在报告后就结束了；答案到达时新建/恢复一个 worker 回合，把
`{kind: "answer", questionId, text, basis, answeredBy}` 作为 Input 投递。理由：

- 与现有 `addInput`/`deliverQueued` 路径一致，不需要保留挂起的进程或工具调用；
- `answer` 不是 automatic，能穿过 blocking 问题和 `assignments.report` 的 automatic 过滤；
- Input id 固定为 `question-answer:<questionId>`，重试/重复发送幂等。

替代方案是让 worker 在提问工具里阻塞等待；否决原因是 DSH 的回合/进程生命周期不支持长期挂起，
且重启后没有句柄可恢复。

### 4. `basis` 必填，答案写进 Question，不写 Decision 表

`orchestrator_answer` 要求 `basis`（哪条 mandate/policy/实现选择授权了答复），和
`answeredBy/answeredAt` 一起写进 Question；同时 emit `question.answered`。理由：

- Decision 表目前是 routing/accept/stop 的决策记录，语义是「这个 Trigger 怎么处理」；
  把问答塞进去会让面板和查询混淆。
- Question 自身就是审计记录，`orchestrator_read` 直接可见；需要事件流时用 domain event。

review 说「记成 Decision/审计」；这里选择审计字段 + 事件，不选 Decision 表，理由如上。

### 5. 升级由 `orchestrator_escalate` 直接发 attention

`orchestrator_escalate` 把 `to` 改为 person、记录理由，并直接按 attention 路径发消息，正文由
host 从问题/选项/推荐/理由合成（与 `host-owned-mechanics` 共用 renderer）。理由：

- 如果只翻 `to`、要求主会话再调 `orchestrator_reply`，模型可能漏掉，问题在面板里静默挂着；
- 一次工具调用完成状态变更和可见通知，`attention-reply:<id>` 的 id 天然去重。

替代方案是两阶段（escalate 只改状态，reply 再发）；否决原因是可靠性。代价是
`orchestrator_escalate` 成为第二个可见出口，`host-owned-mechanics` 必须把它的正文也纳入
host 合成/校验，不能只覆盖 `orchestrator_reply`。

### 6. 人的答复在 outbox 发送成功后才结案

`Engine.reply` 的 attention 分支在 `sendReplies()` 返回 `sent` 后调用
`Questions.answeredByPerson(questionId, text)`：写 answer 字段、resolution、answer Input。
理由：发送失败时问题必须保持开放，否则所有者以为答了、worker 永远收不到。
`attention-reply:<id>` 和 `question-answer:<id>` 都按 question id 幂等，重复发送不产生第二条。

### 7. key 只在未决问题内去重

同 key 更新未决问题；answered/resolved/withdrawn 不参与去重，同 key 再问创建新问题。理由：
worker 可能在不同阶段问同一件事（例如先问测试框架、后来问测试目录），结案后应允许重新提问；
未决期间重复问则是同一件事，覆盖即可。

### 8. blocking 由报告状态派生

`state: "blocked"` → `blocking: true`；`state: "progress"` → `false`；`ready/dropped/failed`
带问题拒绝。理由：如果再加一个 `blocking` 参数，会出现 `blocked` 但 `blocking:false` 的矛盾，
投递逻辑无法判断。工具 schema 不暴露 `blocking`。

### 9. 新增 `waitsForQuestion`，保留 `waitsForPerson` 的窄语义

- `waitsForQuestion(ticket)`：存在未决 blocking 问题（任意目标）；`tickets.addInput` 用它 hold
  automatic Input。
- `waitsForPerson(ticket)`：存在未决 blocking 且 `to: "person"` 的问题；stage 用它决定
  person/answer。

替代方案是扩大 `waitsForPerson` 的语义；否决原因是名字会骗人，且 stage 需要区分两种等待。

### 10. 旧 attention 在读取时归一化

`migration.ts` 增加 `migrateQuestions(ticket)`：`attention` 存在且 `questions` 为空时，生成
`{id: attention.id, from: "worker", to: "person", blocking: true, question, triggerId,
createdAt: ticket.updatedAt}`；保存时写回 `questions`、丢掉 `attention`。保留 id 是为了让未发送的
`attention-reply:<id>` 继续匹配。没有 schema 版本变更。

### 11. stage 增加 `orchestrator/answer`

`TicketStage` 增加 `{stage: "orchestrator"; action: "answer"}`。判断顺序：person 的 blocking
问题优先（人先看到），否则 orchestrator 的 blocking 问题。理由：如果复用 `person/answer`，
面板会让所有者去回答一个本应由主会话回答的问题，产生越权答复。

### 12. 问题存在 Ticket JSON，不建表

问题数量小、生命周期跟工单一致、需要和 assignment/report 在同一事务里改；独立表会引入
双写和清理。查询「所有未决问题」通过 `tickets.open()` 扫描 JSON；对 P0 规模足够。P1 如果
需要跨工单统计，再考虑投影表。

## Risks / Trade-offs

- **主会话可能越权回答**：`basis` 是自报的，host 不能机械判断「公开 API」等语义。缓解是
  `prompts/dispatch.md` 的升级规则 + 人审；残余风险要如实记录，不能声称已机械强制。
- **多个 blocking 问题**：worker 正常不会同时阻塞在两个问题上，但模型可以；stage 只显示一个，
  另一个在详情里。P1 可加「一次只允许一个 blocking」的约束，本变更不限制。
- **问题堆积**：没有 deadline/提醒，长期未答的问题会留在 `questions`。P1-2 处理；本变更至少
  在 `orchestrator_read` 和面板可见，且 resolve 能清掉。
- **提示词变长**：新增 consult/answer/escalate/resolve 说明会推高预算；`host-owned-mechanics`
  的预算棘轮会迫使作者删掉等量的旧规则或明确提高基线。
- **迁移写回**：读取时归一化、下次保存写回；如果一张旧工单永远不再保存，每次读取都会重新
  归一化（幂等，开销小）。未发送 outbox 的旧 id 保留。
- **answer Input 与 agenda**：问题答完后，等待中的 agenda handler 会在下一次 2 秒重试时投递；
  两个 Input 都进入 `undelivered`，`deliverQueued` 按顺序投递，不会互相覆盖。

## Migration

无 schema 版本变更。`Ticket.questions` 为可选 JSON 字段；旧 `attention` 在读取时映射，保存时
写回。旧 outbox 的 `attention-reply:<id>` 继续有效。回滚时新代码写的 `questions` 会被旧代码
忽略，但旧代码看不到未决问题，面板会显示为空；发布说明要写这一点。

## Open Questions

- `orchestrator_answer` 的 `answer` 长度上限用 5,000 还是 20,000 字符？
- 是否允许主会话把问题标记为 `resolved`（而不是只由提问者结案）？当前只允许提问者。
- 升级后的 attention 是否需要把「已排除选项」单独结构化，而不是拼进正文？
- 多条 person 问题的 attention 发送策略：逐条发，还是合并成一条？首个实现逐条。
