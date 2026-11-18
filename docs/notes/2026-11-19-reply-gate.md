# orchestrator_reply 的结论/建议闸门

## 背景

owner 反馈：编排常把 worker 的结论压成一句 PR 链接，或把常规工程选择列成选项丢回来拍板。
排查发现这类规则早就写在提示词里（`prompts/work.md:31`、`prompts/team/communication.md:53`、
`prompts/handoff.md:1`，以及 `2a48f00` 的「报告先给结论」），但只是散文，模型可以绕过。
所以本次把规则做成工具层的确定性闸门。

## 修复

`orchestrator_reply`（`src/app/tools/main.ts`）新增两个字段，并在 `.superRefine` 里强制：

- `purpose: 'result'` 必须带 `conclusion`：owner 能直接用的结论，作为消息第一段发出；
  `text` 可选，作为结论之后的补充。PR 链接本身不能当结论。
- `purpose: 'attention'` 必须带 `recommendation`：编排建议的选项，追加在消息末尾
  （中文「建议：」，英文 `Recommendation: `）。这样 owner 收到的是一条带建议的问题，不是选项菜单。
- `purpose: 'answer'` 仍只需要 `text`。

消息文本由工具拼装后交给 `Engine.reply`，word/IM 上限照旧在 outbox 校验。
`prompts/replies.md` 同步说明这条闸门。

## 坑

- 缺字段时 zod 报错先于引擎的 `notReady` / `notAttention`，测试要按场景先补字段再断言引擎错误。
- 结论与正文是两个字段，拼装后总长度会叠加；IM 100 词上限仍由 outbox 的 `checkedImText` 兜底。
- 提示词预算（`tests/model-surface.spec.ts` BUDGET）随 `prompts/replies.md` 增加一行而上调；
  实测 orchestrator 62,878 / worker 41,231，预算调到 63,200 / 41,400。
- 这条闸门只保证消息结构里有结论/建议，不判断内容质量；质量仍靠提示词与 review。

## 验证

```
cd /Users/seabiscuit/src/conclusion-first-delivery-gate
env -u GIT_CONFIG_GLOBAL pnpm typecheck
env -u GIT_CONFIG_GLOBAL pnpm test        # 66 files / 1260 tests
env -u GIT_CONFIG_GLOBAL pnpm build
```

新增测试 `tests/tools.spec.ts`：result 缺 `conclusion`、attention 缺 `recommendation` 都会被拒绝。
