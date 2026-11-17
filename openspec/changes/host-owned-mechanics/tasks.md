# 实施任务（讨论定稿后执行；当前全部未开始）

## 1. Receipts

- [x] 1.1 新建 `src/app/receipts.ts`：`renderResult(ticket, report, note?)`、
  `renderAttention(question)`、`validateAnswer(text, trigger)`；复用 `turn-guard.ts` 的
  `INTERNAL`/`SILENT` 常量，导出 `receiptId(purpose, payload)`。
- [x] 1.2 `src/app/tools/main.ts` `orchestrator_reply`：按 purpose 取结构化字段
  （`ticket_id`/`question_id`/`reply_to_trigger_id`），先 render/validate，再调用
  `engine.reply`；返回 `{receipt_id, status, reason?}`；拒绝时不写 outbox。
- [x] 1.3 结果正文含 state 标签、summary、PR 链接；attention 正文含问题/options/recommend/
  升级理由；answer 校验引用、长度、空值/静默/内部载荷；note ≤2 句。
- [x] 1.4 幂等：`result:<ticket>:<report.at>`、`attention-reply:<question_id>`、
  `reply:<trigger>:<sha1(text)>`；store reopen 后同一 receipt 不新增 outbox 行。
- [x] 1.5 发送成功 `turn.concludeTurn()`；新增 `TurnGuard.finish()` 在回合结束发兜底
  （ready → result，person 阻塞 → attention；orchestrator 问题不伪造答案）。
- [x] 1.6 兼容 `ticket.attention`（consult 未合并时）与 `ticket.questions`（合并后），
  renderer 只读其中一种，测试覆盖两种输入。

## 2. Dispatch fast path

- [x] 2.1 `src/core/model.ts` `Trigger.intent?: "dispatch" | "discussion"`；`runtime.ingestLocal`
  解析首行前缀（精确小写、一个空格），保留完整 trigger 文本。
- [x] 2.2 `Intake.receive(trigger, { assess?: boolean })` 默认 true；`assess:false` 时仍保存
  Trigger/线程关联/disposition，但跳过 `queueForEval`；`Engine.receive` 透传。
- [x] 2.3 `!dispatch`：机械 `engine.decide(accept)`，title 取首行（≤200），worktree 名
  slug+hash，确认语按本地 `language` 模板（zh/en，≤IM_WORDS），`passes.request()` 启动。
- [x] 2.4 新增本地 Source `language` 配置（设置/schema/文档）；缺失或非法 → 回退主会话；
  `policy.paused`、policy gate、空请求、无效 title/worktree → 同回退，不建部分工单。
- [x] 2.5 `!discussion`：不建工单；`route()` 对 `intent === "discussion"` 的 accept/attach
  返回 `discussionOnly`；主会话在聊天里讨论。
- [x] 2.6 发 `dispatch.fast_path` 事件（trigger id、ticket id、accepted/fallback/discussion），
  不含完整提示词/私有内容。

## 3. Prompt budget ratchet

- [x] 3.1 生成 `tests/model-surface.baseline.json`：按 role 与 system/tools 分项记录当前字符数。
- [x] 3.2 `tests/model-surface.spec.ts` 读取基线：任一项超过基线即失败，错误信息给出
  「删等量文本或解释并更新基线」；低于基线通过，不自动下调。
- [x] 3.3 与现有 `BUDGET` 60,500/40,500 并用；新增测试：基线 +1 失败、等于基线通过。

## 4. 提示词与文档

- [x] 4.1 `prompts/dispatch.md`、`prompts/replies.md`：删除被 host 接管的空回合/内部载荷/
  重复回复规则，保留判断类规则；说明 receipt 的 purpose 与兜底。
- [x] 4.2 文档写清 `!dispatch`/`!discussion` 的语法、`language` 配置、回退条件、转义方式
  （首行 `!!` 视为普通文本）。
- [x] 4.3 更新 `docs/notes/2026-11-17-openspec-p0-plan.md` 中本变更的范围与顺序。

## 5. 验证与交接

- [x] 5.1 `tests/receipts.spec.ts`：empty/`NO_REPLY`/内部载荷/重复 receipt；host 只发一条，
  正文无内部标记，concludeTurn 被调用；ready 无工具调用时兜底一条；不伪造 orchestrator 答案。
- [x] 5.2 `tests/dispatch-fast-path.spec.ts`：`!dispatch` 建一张工单、assessor 未调用、一条
  确认；`!discussion` 不建工单且 route accept 被拒；拒绝回退；无前缀走旧路径。
- [x] 5.3 `env -u GIT_CONFIG_GLOBAL pnpm vitest run tests/receipts.spec.ts
  tests/dispatch-fast-path.spec.ts tests/model-surface.spec.ts tests/local.spec.ts` 通过。
- [x] 5.4 `pnpm check`、`openspec validate --all --strict` 通过。
- [x] 5.5 实测（分支实例 `127.0.0.1:3153`，非 `:3082`）：`!dispatch` 直接进入机械接单（标题为原文、
  `收到，开始处理：…` 确认、未走 assessment）；`!discussion` 不建工单；host 结果回执正常；
  内部载荷拒绝由 `tests/receipts.spec.ts`/`tests/tools.spec.ts` 覆盖。
- [x] 5.6 写 `docs/notes/2026-11-17-host-owned-mechanics.md`（根因、实现、坑、验证命令）。
- [x] 5.7 新会话只读 proposal/spec/design/tasks 能复述 receipt 字段/拒绝/兜底、两个前缀、
  `language` 回退、预算基线更新方式。
