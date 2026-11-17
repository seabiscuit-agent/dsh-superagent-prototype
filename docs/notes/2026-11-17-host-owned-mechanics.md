# host-owned-mechanics：机械规则回到 host

日期：2026-11-17；变更：`openspec/changes/host-owned-mechanics`。

## 根因

提示词承担了本应由 host 保证的机械规则：回复 body 要模型自己拼、空回合/内部载荷/静默标记靠
模型避免、`!dispatch` 与 `!discussion` 没有结构、提示词长度只靠人工预算，导致重复回复、
泄漏内部 payload、空回合和 prompt 膨胀。

## 实现

- `src/app/receipts.ts`：`renderResult` 从最新 report 合成 result 正文（状态标签、过滤后的
  summary、PR 链接，超 IM 字数先裁 summary）；`attentionText` 从存储的 Question 合成；
  `validateAnswer` 检查空/静默/内部载荷/长度/真人原问题；`receiptId` 给出确定性 id。
- `orchestrator_reply` 改为结构化：`purpose` 加 `ticket_id`/`question_id`/`trigger_id`/`note`/
  `text`；拒绝返回 `{receipt_id,status:'rejected',reason}` 且不入 outbox；发送成功
  `concludeTurn()`。`Outbox` 的 `questionId` 在送达成功后回调 `Engine.personAnswered`。
- `TurnGuard` 在回合结束时找仍欠的 receipt（ready report / person blocking question），直接
  发一次兜底，不再 steer 模型重述；orchestrator 问题绝不由 host 代答。
- 本地 Source 首行前缀：`!dispatch <request>` 机械 accept（`assess:false`，标题取首行，
  worktree 名由标题 slug + trigger hash 生成）；`!discussion <text>` 只存 Trigger、不建单，
  `orchestrator_route` 的 accept/attach 返回 `discussionOnly`；`!!` 转义为普通文本并去掉一个
  `!`。确认语取 Source 配置 `language`（zh/en），缺失或 accept 失败回退主会话。
- `dispatch.fast_path` 事件记录 accepted/fallback/discussion；不改 paused、admission、成本门。
- `tests/model-surface.baseline.json` 按 surface 记录字符数，增长即失败；只能删除等量文本或
  在 PR 说明后手动提高。

## 坑

- outbox id 有历史 hash 形式；新 receipt id 用冒号形式时，关闭旧 attention 要同时 withdraw 两种 id。
- 旧 `attention` 迁移出的问题保留原 id，`attention-reply:<id>` 才能匹配已排队的 receipt。
- Person 回答 worker 问题时不需要 `ticket.answers` take-up（`!!answering` 放行），否则写回被拒。
- `orchestrator_report` 之后工单可能已 ended；测试 dropped 状态要用第二张工单。
- 本变更需要新模块/测试进 `docs/007` 的 Modules/Tests 表，否则 docs.spec 失败。

## 验证

```bash
env -u GIT_CONFIG_GLOBAL pnpm check          # typecheck + vitest + build
openspec validate --all --strict             # 6 passed, 0 failed
```

生产 `:3082` 冒烟（`!dispatch` 无 assessment、确认与工单、`!discussion` 不建单）尚未执行，
PR 中如实标注。
