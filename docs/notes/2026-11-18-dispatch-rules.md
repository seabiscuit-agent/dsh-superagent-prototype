# 按规则派工（dispatch rules）

根因：非人类触发的处置只有「人工评估」一条路。定时任务和 CI 失败已经能到达引擎，但 Source 不声明事件类型，policy 无法给出确定性路由；即使规则明显命中，也要等一次模型评估，慢、费，且结果不稳定。

修复（`openspec/changes/dispatch-rules`，PR 见分支 `agent/implement-dispatch-rules-400070b4dafc`）：

- `Trigger.event` 由 Source 声明：`schedule.fire`、`github.ci.failed|running|passed`（`src/sources/github-read.ts` 的 `ciEvent`）。没有 event 的触发不进派工。
- `policy.dispatch.rules` 为每条规则声明 `when.source`、`when.events`、`title`、`brief`、`maxActive`；随 policy 块保存并计入 `policyVersion`。
- `Evals.dispatch` 在 intake 存下触发后、同一事务内运行：人类触发、observe/off、暂停、已有 owner 或事件不存在时不动；gate 必须 admissible 且 inferred。
- 恰好一条规则命中：构造 gate-only Evaluation 复用 `accept`，不经 assessor；Mandate 的 basis 为 `{via:'dispatch', rule, event, gate}`，Decision 原因码 `dispatchRule`，disposition 记 `created` 与 ticket id。
- 零命中：保持 pending，照常走 Eval。多命中：disposition 记 `ambiguous` 并回退 Eval。
- 容量：同一规则的未结束 dispatch 工单达到 `maxActive` 时把触发移出 pending，记 `capacity`，发 `dispatch.held` 通知；`orchestrator_trigger_requeue` 先重试派工，仍满则 `queued:false`。
- 规则停用/删除或事件不再匹配时，`revalidate` 返回 false → `policy-changed` 输入且 `proactive:false`；只改 brief 仍通过，但 `policyEffects` 发 `dispatch.changed`，要求在新范围内完成。
- 设置面板 Policy 页加「派工规则」一节；Trigger 卡片显示事件与三种派工结果。

坑：

- 事件格式是 `<source>.<kind>`，但 kind 本身可含点（`github.ci.failed`），校验正则必须允许 `(\.[a-z][a-z0-9-]*)+`，首次实现只允许一个点导致保存失败。
- `policyEffects` 的 scope 参数是 `(settings) => SourceScope`（即 `{scope}` 包装），不是 `scope` 函数本身。
- dispatcher 的 active 计数只按 `basis.via==='dispatch'` 且 rule id 相同、未结束；不要用 Mandate 的 `rules` 字段（那是文本规则）。
- `dispatch.fast_path` 事件用于可观察性：accepted 与 ambiguous/fallback 都记，便于时间线解释为什么没走评估。

验证：

```
env -u GIT_CONFIG_GLOBAL pnpm check
env -u GIT_CONFIG_GLOBAL pnpm vitest run tests/dispatch.spec.ts
openspec validate --all --strict
```

相关：`openspec/changes/dispatch-rules/specs/dispatch-rules/spec.md`、`docs/notes/2026-11-18-dispatch-rules-proposal.md`、`tests/dispatch.spec.ts`。
