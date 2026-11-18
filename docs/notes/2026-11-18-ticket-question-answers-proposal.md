# 工单问题面板点选作答提案（2026-11-18）

## 根因

`orchestrator-consult` 已把 `attention` 拆成 `Question[]`，但工单详情页只在
`src/client/ticket.tsx:175-180` 显示阻塞问题文本和一个「去原通道回答」链接：人不能在面板点
选项；`src/core/engine.ts` 的 `answerQuestion` 只收 orchestrator 问题；`personAnswered`
只在通道回复发送成功后回写。更关键的是 `src/executor/dsh.ts:157-165` 的 `inputMessage`
没有 `answer` 分支，`deliverInput` 对 `undefined` 直接返回，`deliverQueued` 仍把 Input 标成
已投递——answer Input 会被静默吞掉。

## 提案要点

- 面板对开放 person 问题渲染 `options` 按钮；点选即写入 `Question` 的待提交答案，15 秒内
  worker 看不到任何 Input；到点由持久化 `answer` effect 提交并走既有 `addInput` 投递。
- 面板、`orchestrator_reply purpose="answer"`、outbox `host.answered` 共用
  `answerPersonQuestion`；一个答案槽，先到先算，后到返回 `alreadyAnswered` /
  `answerPending`。
- 撤回只在提交前有效：清空待提交答案、取消 effect、记录 `withdrawnAt` / `withdrawnAnswer`；
  超时返回 `withdrawExpired`，已提交返回 `alreadyCommitted`。
- 超时只能更正：旧答案进 `corrections`，追加 `question-correction:<id>:<n>` Input，正文说明
  取代旧答案；窗口内更正返回 `withdrawInstead`。
- 详情返回全部问题及 `canAnswer` / `canWithdraw` / `canCorrect`；列表仍只返回开放问题。
- 明确不复用 dsh-redo：会话级回滚会连 worker 已写的文件、命令和 PR 一起回退，不能只撤一条答案。

## 坑

- 撤回边界必须是「worker 是否可能消费」，不是「面板是否显示」；先建 Input 再删会留下
  `undelivered` / `assignments.delivered` 半状态。
- `resolution` 在 pending 期间保持未设置，所以问题仍算 open、stage 仍是「等人」；面板必须
  区分「待投递」和「未答」，否则人会以为点击没生效。
- `deliverQueued` 在 `deliverInput` 返回后无条件 `inputsDelivered`；修 answer 分支时必须同时
  修「无正文不得标已投递」。
- 通道回复可能已发出但输掉竞态；答案槽不覆盖，但要在 `host.answered` 记录「未采用」。
- 详情 `questions` 目前来自 `ticketSummary` 的 `openQuestions`；要展示历史必须在
  `ticketDetail` 覆盖，不能改列表的过滤。

## 验证命令

```sh
openspec validate --all --strict
openspec status --change ticket-question-answers
openspec show ticket-question-answers
```

提案阶段是 docs-only，不改 `src/`；实施阶段再跑 `pnpm check`，并在 superagent :3082 做
面板点击/撤回/更正实测，Before/After 截图放 `docs/evidence/<ticket id>/`。

相关文件：[proposal.md](../../openspec/changes/ticket-question-answers/proposal.md)、
[design.md](../../openspec/changes/ticket-question-answers/design.md)、
[spec.md](../../openspec/changes/ticket-question-answers/specs/ticket-question-answers/spec.md)、
[tasks.md](../../openspec/changes/ticket-question-answers/tasks.md)。
