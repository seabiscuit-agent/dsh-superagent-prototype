## Why

主会话的机械规则写在提示词里：路由、回复用途、可见性、重启、真实成本、审查轮次。主提示词
预算 60,500 字符、worker 40,500 字符（`tests/model-surface.spec.ts:40`），每轮都要重读。
这些规则本来可以机械判定，却靠模型自觉；真实事故说明了后果：

- 空回合只写 `NO_REPLY`，人什么也收不到；
- 先调 `orchestrator_reply`，再在回合里复述一遍；
- 在正文里写括号旁白；
- 把内部载荷（`worker_report`、`||DSML||`）泄漏到可见消息；
- worker 没有报告就结束，被自动记成 `waiting`（"Worker ended without a status report",
  `src/executor/dsh.ts:667-675`），面板看起来像正常等待。

现有补救是 turn-guard、`concludeTurn`、面板过滤器——都是事后打补丁。测试只能断言「提示词包含
某句话」，无法证明行为；同一个输入可能因措辞不同走出不同路由；新增一条规则就让预算再涨。

agent-autoloop 的做法是：事件不决定谁/方向/技能/权限，规则决定；receipt 事务化（先整体校验
再执行，出错只重写 receipt，最多两次，保留原结论）；坏规则保留旧规则并告警。本变更借它的
「机械判定交给 host、正文由 host 合成、契约测试代替提示词断言」，不把 orchestrator 的意图
判断换成 rules.json。

## What Changes

### reply-receipts

- `orchestrator_reply` 改为结构化 receipt：
  - `purpose: "result"`：不要求模型写正文；host 从工单最新报告（state、summary、PR 链接）
    合成一条可见消息，模型最多给一个短 `note`（可选，sanitized）。
  - `purpose: "attention"`：host 从存储的 Question（问题、options、recommend、升级理由）
    合成正文；模型不再自由写问题。
  - `purpose: "answer"`：正文仍是人的答复（本质上自由文本），但 host 做空值/内部载荷/长度
    校验，并要求引用原始人类问题。
- host 拒绝：空正文、`NO_REPLY`/`END_OF_TURN`/`END_OF_RESPONSE`/`SILENT`、内部载荷标记
  （`||DSML||`、`"kind":"worker_report"`、`"kind":"worker_attention"`、`{"ticket_id":`、
  `local-receipt:`）、重复 receipt id；拒绝时不发送任何消息，返回可纠正的错误。
- 确定性 receipt id：`result:<ticket_id>:<report_id>`、`attention-reply:<question_id>`、
  `reply:<trigger_id>:<payload hash>`；同一 receipt 重复调用不产生第二条。
- 发送成功后 `concludeTurn()`；回合里模型再写的内容不成为工单更新。回合结束仍有未回答的
  ready 报告/问题且没有 receipt 时，host 发一条兜底 receipt（result 或 person attention），
  不编造 orchestrator 答案。
- 只有工单相关消息必须走 receipt；普通讨论不变。

### dispatch-fast-path

- 本地 Source 首行前缀：
  - `!dispatch <请求>`：机械接受工单，不产生主会话 assessment 回合。标题取首行（≤200 字符），
    worktree 名由标题 slug + trigger hash 生成，确认语用本地 Source 配置的 `language` 模板
    （zh/en，≤100 词）；语言缺失或接受被拒时回退到现有主会话路由。
  - `!discussion <文本>`：永不创建工单；消息作为普通讨论交给主会话，`orchestrator_route`
    对该 trigger 的 accept/attach 被拒绝。
  - 无前缀：保持现有 LLM 路由。
- 面板按钮不在本变更；后续可复用同一条机械接受路径。

### prompt-budget ratchet

- 新增 `tests/model-surface.baseline.json`，按 role/part 记录当前提示词与工具定义的字符数；
  任何增长都让 `model-surface` 测试失败，直到作者删掉等量文本或在提交说明里解释并更新基线。
- 与现有绝对上限（60,500 / 40,500）并用：上限防一次暴涨，棘轮防长期缓慢上涨。

## Capabilities

### New Capabilities

- `reply-receipts`: host 合成可见正文、结构化 receipt、去重/拒绝/兜底。
- `dispatch-fast-path`: 本地前缀的机械派活/讨论分流，不经 assessment。

### Modified Capabilities

无。

## 明确不做

- 不取消自然语言消息的意图判断；主会话仍然决定接不接、怎么拆、要不要问。
- 不改 merge/auto-merge 规则，不绕过真实成本闸门，不用 fast path 自动批准花钱。
- 不用面板卡片替代 GitHub inline review。
- 不新增 IM 通道；不把 fast path 做成面板按钮（后续）。
- 不删除所有提示词规则；只把能机械判定的部分下沉到 host，判断类规则保留。
- 不改变普通讨论的回复方式；receipt 只约束工单相关消息。

## 验收标准

1. `env -u GIT_CONFIG_GLOBAL pnpm vitest run tests/receipts.spec.ts` 通过：构造
   empty/`NO_REPLY`/内部载荷/重复 receipt 四种输入；host 只合成一条可见消息，正文不含内部标记；
   同一 receipt 重复调用 outbox 仍只有一条；发送后 `concludeTurn` 被调用。
2. 同一测试覆盖兜底：ready 报告没有任何 `orchestrator_reply` 时，host 发一条
   `result:<ticket_id>:<report_id>` 的可见结果，不编造问题答案。
3. `env -u GIT_CONFIG_GLOBAL pnpm vitest run tests/dispatch-fast-path.spec.ts` 通过：
   `!dispatch` 创建一张工单且 assessor 未被调用，只发一条确认；`!discussion` 不创建工单且
   `route` accept 被拒；`!dispatch` 被拒时回退主会话；无前缀走旧路径。
4. `tests/model-surface.spec.ts` 棘轮：基线 +1 字符即失败，等于基线通过；更新基线必须在提交
   说明里写理由。
5. `pnpm check`、`openspec validate --all --strict` 通过。
6. 在 superagent `:3082` 实测：`!dispatch 修复登录按钮文案` 出现确认和工单，无 assessment
   回合；`!discussion 这个方案怎么样` 不建工单；模型不写正文时仍收到 host 合成结果；内部载荷
   被拒绝。
7. 纯文档交接：新会话只读本变更四件套，能复述 receipt 字段/拒绝规则/兜底、两个前缀的行为、
   棘轮如何更新。

## Impact

- 代码：`src/app/tools/main.ts`（reply schema/execute）、`src/app/outbox.ts` 或新的
  `src/app/receipts.ts`（正文合成/校验/去重）、`src/app/turn-guard.ts`（owed/兜底）、
  `src/app/runtime.ts`（本地前缀分流）、`src/core/engine.ts`（机械 accept/discussion）、
  `src/core/model.ts`（Trigger intent、report id）、`src/app/views/*`（receipt 状态）。
- 配置：本地 Source 的 `language`（zh/en）；缺失时 fast path 回退。
- 提示词：`prompts/dispatch.md`、`prompts/replies.md` 删除被 host 接管的机械规则，保留判断类
  规则；预算基线同步。
- 测试：`tests/receipts.spec.ts`、`tests/dispatch-fast-path.spec.ts`、
  `tests/model-surface.spec.ts` + baseline、`tests/local.spec.ts`。
- 文档：`docs/notes/2026-11-17-openspec-p0-plan.md`。
