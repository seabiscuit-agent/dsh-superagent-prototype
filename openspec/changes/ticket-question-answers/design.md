## Context

`orchestrator-consult` 已经把单个 `attention` 拆成 `Question[]`：worker 在
`orchestrator_report` 里带 `question` / `question_for` / `options` / `recommend`，
`Question` 记录 `to`、`options`、`answer`、`answeredBy`、`resolution`。但工单详情页目前只在
`.dt-banner` 里显示阻塞问题的文本和一个「去原通道回答」链接（`src/client/ticket.tsx:175-180`），
人不能在面板上点选项；`src/core/engine.ts` 的 `answerQuestion` 只接受 orchestrator 问题，
`personAnswered` 只在通道回复发送成功后回写。

同时 `src/executor/dsh.ts:157-165` 的 `inputMessage` 没有 `answer` 分支，`deliverInput` 对
`undefined` 直接返回，`deliverQueued` 随后仍调用 `inputsDelivered` 把 Input 移出
`undelivered`。即使今天在别处生成 answer Input，worker 也收不到正文，且会被误标为已投递。
这个变更要把面板作答、答案槽、撤回窗口和更正路径一次定清楚。

## Goals / Non-Goals

**Goals**

- 工单详情页对开放 person 问题显示选项按钮，点选即写入正式答案。
- 面板、对话、GitHub 回复共用一个答案槽，先到先算，不产生第二份状态。
- 面板答案在 15 秒内可撤回；撤回时 worker 从未见过这条答案。
- 窗口结束后只能更正，旧答案保留在审计历史里，worker 收到明确「取代旧答案」的新 Input。
- 面板、`orchestrator_read` 和时间线都能看到 pending / answered / withdrawn / corrected 的差别。
- 进程重启后待提交答案仍会按时提交，撤回窗口不因重启丢失。

**Non-Goals**

- 不接 dsh-redo，不做会话级回滚。
- 不把 15 秒做成配置项。
- 不做面板自由文本输入；没有 `options` 的问题仍回原通道。
- 不让面板回答 `to: "orchestrator"` 的问题。
- 面板作答不写 outbox、不产生 Decision、不发 IM。
- 不改变 `Question` 的存储方式，不新增数据库 schema 版本。

## Decisions

### 1. 面板答案先落在 Question 上，窗口结束才生成 Input

面板点击后只写 `Question.answer`、`answeredBy: "person"`、`answeredAt`、
`withdrawableUntil = answeredAt + 15s`，`resolution` 保持未设置；同时入队一个持久化
`answer` effect（`effects.enqueue('answer', questionId, { ticketId, questionId }, withdrawableUntil)`）。
到点后 effect 才写 `resolution: "answered"`、`committedAt`，并通过现有 `tickets.addInput`
生成 id 为 `question-answer:<questionId>` 的 `answer` Input，走既有的投递/启动 worker 路径。

**为什么**：撤回的边界必须是「worker 是否可能消费」。如果在点击时就生成 Input，worker
可能在 15 秒内读到并据此改代码、开 PR；此时撤回只能骗面板，不能收回副作用。把提交推迟到
窗口结束，撤回期间根本不存在 Input，语义干净。

**放弃的方案**：

- *点击即生成 Input，撤回时删 Input*：Input 可能已经被 `deliverQueued` 取走并投递，删除
  无法撤销 worker 已读到的内容；还会在 `undelivered` / `assignments.delivered` 之间留下
  半状态。
- *dsh-redo 回滚会话*：redo 是会话级回滚，会连同 worker 已写的文件、命令和 PR 一起回退，
  不能只撤回一条答案；owner 已明确不复用。
- *内存定时器*：重启丢失，窗口内的撤回和提交都不可靠。

### 2. 撤回窗口固定 15 秒

`WITHDRAW_WINDOW_MS = 15_000` 放在 core 常量里，不从 settings 读取。

**为什么**：这是交互节奏，不是策略；做成配置会让面板、测试和文档出现多种时间语义。15 秒
足够人发现点错，又短到 worker 不会被无谓地晾着。

**放弃的方案**：可配置窗口（增加 settings/迁移/文档面）；无限期可撤回（等于没有提交边界）。

### 3. 所有入口共用 `answerPersonQuestion`

新增 core 操作 `answerPersonQuestion(ticketId, questionId, text, { entry, holdMs })`，由
`engine.answerQuestion`（面板）、`orchestrator_reply purpose="answer"`（主会话/通道）和
outbox 的 `host.answered` 回写共同调用；`entry` 决定校验：面板入口要求 `options` 存在且答案
在其中（无 options 返回 `optionRequired`），通道入口允许自由文本、只拒绝空串；`holdMs` 决定
是 pending 还是立即提交：面板传 15 秒，通道传 0。操作在 `repo.atomic` 内完成，先检查
`resolution`、已有 `answer`、是否 person 问题、文本/选项合法性。

**为什么**：三处各写一套「设置答案 + 生成 Input」必然分叉；同一个函数才能保证「先到先算」
和同一套错误码。

**放弃的方案**：面板单独实现一条写入路径（会出现两个答案槽）；由 outbox 统一代发面板答案
（面板作答不需要 IM，且会把简单点击变成一次网络发送）。

### 4. 先到先算，后到者不覆盖

同一问题只允许一个有效答案槽。已提交返回 `alreadyAnswered`；已有面板待提交答案返回
`answerPending`。通道回复在发送前重新读取问题，已答/待答就放弃发送；已经发出的消息如果
输掉竞态，`host.answered` 回写只记录「未采用」，不覆盖答案槽，也不生成第二条 Input。

**为什么**：面板和 IM 是异步的，两个入口同时到达是常态；「后到覆盖」会让 worker 收到两条
互相矛盾的答案，且无法判断哪条是最终版。

**放弃的方案**：last-write-wins（状态分叉）；给每个入口各建一个答案（等于没有互认）。

### 5. 更正追加新 Input，不修改旧 Input

`correct` 只接受已回答的 person 问题；窗口内返回 `withdrawInstead`。成功时把旧答案压入
`corrections: { text, at, answeredBy }[]`，写新 `answer` 和 `correctedAt`，追加 id 为
`question-correction:<questionId>:<n>`、`correction: true` 的 Input 并立即投递。更正不可撤回。
与当前答案相同的更正视为 no-op，不追加 Input。

**为什么**：旧 Input 可能已被 worker 读取，改它不会改变 worker 已经看到的内容；追加一条
带「取代旧答案」语义的新 Input，worker 才能明确以哪条为准。

**放弃的方案**：原地修改旧 Input（worker 可能已读）；窗口结束后禁止任何修改（人只能重开
工单，代价过大）。

### 6. 详情返回全部问题，列表只返回开放问题

`ticketDetail` 覆盖 `ticketLine` 带来的 `questions`，返回该工单的全部 Question（含已答、
已撤回、已更正），并补充 `withdrawableUntil`、`committedAt`、`withdrawnAt`、
`withdrawnAnswer`、`correctedAt`、`corrections` 和服务端计算的 `canAnswer` /
`canWithdraw` / `canCorrect`。`ticketSummary`（列表）继续只返回开放问题。

**为什么**：详情页需要展示答案历史和撤回/更正入口；列表只需要「还有什么在等人」。

**放弃的方案**：详情也只返回开放问题（已答问题消失，无法审计）；列表返回全部（列表变重，
且会让人误以为已回答的问题还在等）。

### 7. 面板按钮只属于 person 问题

面板对 `to: "person"` 的开放问题渲染按钮；`to: "orchestrator"` 的问题保持「等待主会话回答」，
不提供按钮。answer 路由对 orchestrator 问题返回 `notPersonQuestion`。

**为什么**：orchestrator 问题的回答者是主会话，面板直接答会绕过 `orchestrator_answer` 的
`basis` 记录和权限判断；owner 也明确面板是给人用的。

**放弃的方案**：面板也能答 orchestrator 问题（需要把主会话的 basis 语义搬进 UI，且会让人
误以为可以替主会话做决定）。

### 8. 面板作答不产生 IM，观察走工单视图

answer/withdraw/correct 路由只写工单和事件，不写 outbox、不产生 Decision、不发 IM。人看
面板或 `orchestrator_read` 就能确认结果；通道回复仍由主会话主动走 outbox。

**为什么**：面板点击本身就是人机交互，再发一条 IM 确认是噪声；也会让「谁回答了」出现两个
记录源。

**放弃的方案**：每次面板作答发一条确认 IM（噪声、额度、和通道回复混淆）。

## Risks

- **Pending 期间 stage 仍显示「等待人」**：这是有意的；如果 UI 没区分 pending 和未答，人会
  以为点击没生效。面板必须显示「待投递，可撤回」和倒计时。
- **effect 到点时 worker 已结束/工单已结束**：提交 handler 必须重新读工单，`ended` 时只清
  effect，不生成 Input；否则会在已结束工单上留下无法投递的 Input。
- **撤回与提交的竞态**：withdraw 和 commit 都在 `repo.atomic` 内重新检查
  `withdrawableUntil` 与 `resolution`；以事务内时间/状态为准，不依赖 UI 倒计时。
- **通道回复已发出但输掉竞态**：消息无法收回，答案槽不覆盖；需要在 `host.answered` 里记录
  「未采用」，避免人以为自己的回复生效了。
- **`inputMessage` 修复不完整**：只加 `answer` 分支不够，`deliverQueued` 仍可能把未知 Input
  标成已投递；修复时要让「没有格式化文本」成为显式错误/保留在 `undelivered`，而不是静默成功。
- **旧客户端缓存**：面板 5 秒轮询，提交/撤回后最多 5 秒才刷新；`after()` 已在 mutation 后
  主动 reload，新增路由也要走同一个 `after()`。

## Migration

- `Question` 新增字段全部可选，ticket 以 JSON 存在 `ticket.value`，不需要 schema 版本升级；
  旧工单读取时字段缺省即为「没有 pending/撤回/更正」。
- 新增 `answer` effect kind，复用现有 `effect` 表的 `kind/key/value/due`，不需要新表。
- `answer` Input 的格式修复是行为变更：已存在的 answer Input 若尚未投递，会在下一次
  `deliverQueued` 时得到正文；已投递的旧数据不回溯。
- 面板新增文案放 `src/client/locales.ts` 的 zh/en 两套；旧客户端不认识新字段时按开放问题
  渲染，不会崩。
- 这是 docs-only 变更：本 PR 只写 `openspec/changes/ticket-question-answers/` 和说明文档，
  不改 `src/`；实施 PR 再按 tasks.md 落地。

## Open Questions

- 15 秒是提案值。owner 已定「撤回只在 worker 未消费前有效、超时走更正」，但没有指定窗口
  长度；如果 owner 要求不同值，只改 `WITHDRAW_WINDOW_MS` 常量，不引入配置。实施后可在
  :3082 实测再决定是否调整。
- 通道回复「已发出但输掉竞态」时，是否需要在原通道补一句「已有其他入口回答」？当前设计只
  记录未采用、不改答案槽；补发消息会增加噪声，留到实施时按实际体验决定。
- 非阻塞 person 问题是否也应该出现在阻塞横幅之外的一个「其他问题」区？当前设计是详情页
  列出全部开放 person 问题，非阻塞不进入横幅；具体分组留给实施 UI。
