## Context

P0-3 要解决的不是「再写一条更严的提示词」，而是把可以机械判定的部分从提示词搬到 host：

- 可见消息的正文由模型自由写，导致空回合、内部载荷、先回复再复述、括号旁白；
- 本地消息的路由每次都经过主会话 assessment，即使人已经用明确措辞说「派活」；
- 提示词只增不减，测试只能断言「包含某句话」。

autoloop 的可借鉴点是：事件不决定谁/方向/技能/权限，规则决定；receipt 事务化；契约测试
输入→必然结果。这里把「回复」做成 receipt，把「派活/讨论」做成本地前缀的机械分流，把预算
做成棘轮。

## Goals / Non-Goals

- Goal：工单相关可见消息的正文由 host 从 receipt 合成，模型不再自由写。
- Goal：空回合/内部载荷/重复回复在 host 层被拒绝或去重。
- Goal：`!dispatch` 不产生 assessment 回合；`!discussion` 永不建工单。
- Goal：提示词字符数有棘轮，新增规则必须显式付账。
- Non-Goal：取消自然语言消息的意图判断；改 merge/auto-merge；绕过真实成本闸门；
  用面板卡片替代 GitHub inline review。

## Decisions

### 1. 保留 `orchestrator_reply` 名字，扩成结构化 receipt

提示词、turn-guard、现有测试都围绕 `orchestrator_reply`；新增一个 `orchestrator_receipt` 会让
两条出口并存，模型更容易选错。做法是保留工具名，按 `purpose` 扩展字段：

- `result`：`ticket_id` 必填，`text` 可选且只作为 `note`；
- `attention`：`question_id` 必填，正文由 host 从 Question 合成；
- `answer`：`reply_to_trigger_id`/`trigger_id` 必填，`text` 是人的答复。

工具内部先调用 `src/app/receipts.ts` 的 render/validate，再调用现有 `engine.reply` 发送。
`engine.reply` 仍是唯一 outbox 写入点，receipt 层不另开发送路径。理由：不复制
ready/attention/answer 的校验、通道选择和幂等逻辑；出问题只需看一处。

替代方案是新工具 + 旧工具只留 answer；否决原因是迁移期两条出口并存，且提示词需要同时教两个。

### 2. Host 合成 result/attention，answer 保留自由文本

- `result` 的正文来自工单最新 `assignment.report`（`state`、`summary`、`at`）和 PR 链接；
  报告是 worker 写的，host 只做过滤/排版，不让主会话再写一遍。
- `attention` 的正文来自存储的 Question（问题、options、recommend、context/升级理由）。
- `answer` 本质是人话，host 无法合成；保留自由文本，但做空值/静默/内部载荷/长度校验，并要求
  引用原始人类问题。

这是有意的非对称：结果和问题有结构化来源，答复没有。代价是 answer 仍可能写得不好；但
`concludeTurn` + 引用校验 + 100 词上限把最危险的失败模式挡住了。

### 3. Result 用 `report.at` 作为 report id

`Assignment.report` 已有 `{state, summary, at}`，`at` 是报告写入时间，天然唯一且稳定。receipt
id 用 `result:<ticket_id>:<report.at>`，不需要新增 report id 字段。若同一毫秒两份报告（实际
不会，报告是串行写入），再加 assignment id 作为后缀；实现时以 `report.at` 为主。

`attention` 用 `attention-reply:<question_id>`（consult 变更已定义）；`answer` 用
`reply:<trigger_id>:<sha1(text)>`。同一 id 已发送/已排队时不新增 outbox 行。

### 4. 拒绝而不是静默清洗（answer/note 例外）

- answer：空、静默标记、内部载荷 → 拒绝，返回可纠正错误，让模型在同一回合重试。静默清洗会
  让模型以为发出去了，人却收到被删改的句子。
- result 的 summary / note：来自 worker 或模型，host 做标记过滤和限长；过滤后如果为空，拒绝。
  这里选择清洗而不是拒绝，因为报告已经产生，拒绝对人没有帮助；但会记录一条 warning。

内部载荷集合与 `turn-guard.ts` 的 `INTERNAL` 保持一致，新增 receipt 校验时复用同一常量，
避免两套正则漂移。

### 5. 发送后 `concludeTurn`，回合结束兜底

`orchestrator_reply` 在 `status === "sent"` 后调用 `turn.concludeTurn()`（已有）。新增
`TurnGuard.finish()`：主会话回合结束时若仍有 owed 的 ready 报告/阻塞 person 问题且没有 receipt，
host 用同一 renderer 发一条兜底：

- ready 报告 → `result:<ticket>:<report.at>` 可见结果；
- `to: "person"` 阻塞问题 → `attention-reply:<question_id>`；
- `to: "orchestrator"` 问题 → 不发伪造答案，问题保持开放，面板可见。

兜底放在 turn 结束而不是 `TurnGuard.check` 的 nudge 里，因为 check 可能被模型再次触发；结束
钩子只跑一次，且 receipt id 幂等。替代方案是继续用 nudge 直到模型写对；否决原因是空回合
已经证明 nudge 不保证。

### 6. Fast path 在 `ingestLocal`，不改 Source 协议

`src/app/runtime.ts:242-256` 的 `ingestLocal` 是本地消息进入系统的唯一位置。前缀解析放在
`receive(trigger)` 之前：

1. 首行匹配 `!dispatch ` / `!discussion `；不匹配 → 现有 `receive(trigger)`。
2. 给 Trigger 标 `intent: "dispatch" | "discussion"`（JSON 可选字段，无 schema 变更）。
3. `!dispatch`：`receive(trigger, { assess: false })` 存 Trigger/线程关联但不排 Eval；然后
   `engine.decide(triggerId, { kind: "accept", title, scope: title, acknowledgement, name,
   reason: { code: "explicitRouted" } })`。确认语由本地 Source 的 `language` 模板生成，
   随 accept Outcome 走现有 `Replies.acknowledgeAccepted`；`passes.request()` 启动工单。
4. `!discussion`：`receive(trigger, { assess: false })` 存 Trigger；不建工单；主会话在聊天里
   直接看到消息并讨论。
5. 失败（paused、policy、空请求、无效 title/worktree、language 缺失）→ 不留下部分工单，
   回退到 `receive(trigger)` 的现有路径，由主会话判断。

`receive` 加可选 `{ assess?: boolean }`，默认 true；`Intake.receive` 在 `assess: false` 时
跳过 `queueForEval`，但仍保存 Trigger、disposition、线程关联。这是最小的引擎改动；替代方案
是单独写一个 `ingestLocalDispatch` 绕过 Intake，会重复 Trigger 校验/线程关联，否决。

### 7. `!discussion` 的拒绝放在 route 工具

`route()` 在 `accept`/`attach` 前读 trigger 的 `intent`；`intent === "discussion"` 时返回
`discussionOnly`。理由：主会话仍可能从上下文里拿到 trigger id 并尝试派活；工具层拒绝是最后
一道机械闸。`stop`/`ignore` 不拒绝（讨论消息可以被忽略）。

### 8. 本地语言是配置，不是猜测

`!dispatch` 的确认语必须用消息的语言。猜语言（中文字符比例）在混合文本上会错；新增本地
Source 配置 `language: "zh" | "en"`，缺失或非法时 fast path 回退主会话（主会话本来就会用
源语言写确认）。替代方案是默认 zh；否决原因是英文 owner 会收到中文确认。

### 9. 提示词预算用基线棘轮

`tests/model-surface.spec.ts` 已经计算每个 role 的 surface 字符数。新增
`tests/model-surface.baseline.json`，记录当前 role/part 的数值；测试逻辑：

- 计算值 > 基线 → 失败，提示「删掉等量文本，或在提交说明里解释并更新基线」；
- 计算值 ≤ 基线 → 通过；低于基线不自动下调（避免每次删字都要改基线），但作者可以手动下调。

与现有绝对上限并用。替代方案是只保留绝对上限；否决原因是上限离当前值有 5% 空间，规则可以
在里面慢慢长。

### 10. 契约测试直接调用 host，不读提示词

`tests/receipts.spec.ts` 构造 report/Question，直接调用工具 execute，断言 outbox 行数、正文、
receipt id、concludeTurn；`tests/dispatch-fast-path.spec.ts` 直接调用 ingestLocal，断言
assessor 未调用、ticket 数、ack、事件。测试不 import 提示词文本，因此改提示词不会让测试
假绿/假红。

### 11. 与 consult 的依赖

`attention` 的正文合成读 `Question`（consult 变更）。P0-3 按 review 的顺序排在 P0-2 之后；
如果单独实现，先用 `ticket.attention` 的字段做同样的 render，consult 合并后切到
`questions`。spec 里写的是 Question 字段，实施时以当时模型为准。

## Risks / Trade-offs

- **结果正文变泛**：host 只能拼 state/summary/PR，可能比模型写的少信息。`note` 保留一点补充，
  但限制 2 句；如果 owner 觉得太干，后续可以加结构化字段（next step、blocker），而不是放开
  自由正文。
- **过滤误伤**：summary 里正常的代码片段可能包含 `{"ticket_id":` 之类；过滤会删掉。记录
  warning，让人能从原始报告看到全文。
- **机械标题质量**：首行可能不是好标题；fast path 只保证不超长/可建 worktree，不判断语义。
  这是 owner 显式 `!dispatch` 的代价，可接受。
- **前缀碰撞**：用户真的想讨论以 `!dispatch` 开头的文本时会被机械派活；文档写清楚，且只认
  首行、精确小写。后续可加转义（`!!dispatch`）。
- **兜底重复**：receipt id 幂等；但如果 host 在发送后崩溃、重启后 turn guard 再次兜底，同一 id
  的 outbox 行已存在，不会重复。需要测试 store reopen。
- **`!dispatch` 绕过 assessment 的判断**：人明确说派活时这是想要的；但请求可能包含需要澄清的
  内容。工单里的 worker 仍会澄清/提问，成本可接受。
- **预算基线维护**：每次有意增字都要改 JSON；忘记改会红。这是设计目标，不是缺陷。

## Migration

- `Trigger.intent` 是可选 JSON 字段，旧数据无影响。
- `receive` 的可选参数默认 true，所有现有调用不变。
- `orchestrator_reply` 的旧调用（自由 text）继续可用：`result` 会忽略 text 作为 note；
  `attention` 若没有 question_id，回退到旧 attention 文本并标记 deprecated；`answer` 不变。
- 本地 Source 新增可选 `language`；未配置时 `!dispatch` 回退，不破坏现有消息。
- 无数据库 schema 版本变更。

## Open Questions

- `note` 是否保留？如果保留，2 句是否够？还是完全由 host 合成？
- 前缀是否大小写不敏感？是否支持 `！` 全角？
- `language` 放在 Source 配置还是实例设置？多本地来源时是否需要 per-source？
- 预算基线按 role 总数还是按 system/tools 分项？分项更精确，但更新更烦。
- 兜底 result 是否应该在报告 `blocked/failed` 时也发？当前只对 ready 和 person 问题兜底，
  blocked 报告通常会带问题；无问题的 blocked 是否需要一条「卡住了」的兜底？
