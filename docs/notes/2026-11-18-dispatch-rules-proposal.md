# 2026-11-18 dispatch-rules 提案（确定性事件按规则直通建单）

纯文档：`openspec/changes/dispatch-rules/`，不改 `src/`、`tests/`、`locale/`。相关：
[proposal.md](../../openspec/changes/dispatch-rules/proposal.md)、
[design.md](../../openspec/changes/dispatch-rules/design.md)、
[spec.md](../../openspec/changes/dispatch-rules/specs/dispatch-rules/spec.md)、
[tasks.md](../../openspec/changes/dispatch-rules/tasks.md)。

## 根因：确定性事件也要先过一遍模型

- `Intake.receive` 对每个非 fanout 的 trigger 无条件 `queueForEval`（`src/core/intake.ts:62`），之后只能由
  主会话模型评估后才可能建单（`src/core/evals.ts:71` 起）。现有机械接受只有 `!dispatch` 人手前缀
  （`src/app/runtime.ts:340-370`）与已订阅工单的 fanout。
- `policy.rules` 是给 assessor 的自然语言 instruction（`src/policy.ts:67-69`），不是可机械求值的匹配条件；
  「CI 失败就修」写进规则，仍是模型每个事件重新判断一次。
- 后果：CI 变红、cron 到点都要等下一轮评估；评估排队/超时/模型抖动会让确定性事件漏掉或延迟建单。
- owner 已确认：autoloop 那套「按不同厂商 Agent 派工」里，`to`（交给哪个 agent/profile）在本仓库（单执行器）
  用不上，只做「确定性事件命中规则直通建单」这一半。

## 提案要点

- 设置新增 `policy.dispatch.rules`（与 `policy.rules` 分开、进 `policyVersion`）：`{id, enabled,
  when:{source, events[]}, title, brief, maxActive}`。**没有 `to`，没有 `tell`，没有模板。**
- `Trigger` 加可选 `event`（`<source>.<kind>`），由 Source 声明；本变更只落 `schedule.fire` 与
  `github.ci.failed|running|passed`（`ciCounts` 推导）。
- 只在 gate 判 `inferred` 的机器事件上匹配（`human:false`、bot/admission 准入、`auto`、未暂停）。人类显式
  请求与 followup 永不命中；`observe` 不直通。
- 恰好一条命中：构造 gate-only Evaluation → `Evals.accept` 建单，**不调 assessor**；Mandate
  `basis.via='dispatch'` 记 rule/event/gate，Decision 用新码 `dispatchRule`。
- 零条 → 现有 Eval；多条 → disposition `dispatch.ambiguous` 后交回 Eval，不任选。
- `maxActive` 满 → 不建单、不进 Eval、disposition `dispatch.capacity`、发 `dispatch.held` 通知；
  `orchestrator_trigger_requeue` 先重试派工，容量释放才建单。
- 规则停用/改变：`revalidate` 的 dispatch 分支要求 auto + 规则仍启用 + source/event 仍匹配 + gate 仍有效，
  否则给活工单 `policy-changed`（`proactive:false`）。
- 配置面：面板 Eval/Policy 页加「派工规则」一节，保存仍走 `orchestrator_settings_save` 的 `policy` 块。

## 坑 / 需注意（写方案时逐条对照源码）

- **必须复用 `Evals.accept` 而非 `tickets.create`**：绕过 Mandate 会让派工工单无法被 `policyEffects` 与
  `revalidate` 处理（`src/policy.ts:144-165`、`src/core/model.ts:272-277`）。
- **容量满必须先移出 `thread.pending`**：intake 已经 queue 了，不移除的话下一 pass 的模型评估会建单，上限失效。
- **dispatch 放在同事务、intake 之后**：`Engine.receive` 是 `repo.atomic(() => intake.receive(...))`
  （`src/core/engine.ts:48-50`）；在 `stored` 后调用，避免与去重/scope 过滤抢跑。
- **gate 的 `inferred` 判定即安全边界**：`machineGate` 要求 `scope.listened && (addressed || observed)` 且
  bot 在列表 / admission cell 为 `inferred`（`src/policy.ts:171-212`）；派工只在此之后接管，不能只看
  `human === false`。
- **`asBefore` 要一起恢复 `policy.dispatch`**：只恢复 `policy.rules` 会让 dispatch 守卫服务旧版字段。
- **旧 settings 无 `dispatch` 时按 `{rules: []}` 解析**：不做数据迁移；升级本身不改变 `policyVersion`。
- **CI 抖动**：同一 head 的 failed→running→passed 会各产 trigger，本变更不做 per-head 去重，
  靠 `maxActive` 或只匹配 `github.ci.failed`；已列入 design 的 Open Questions。
- **明确不做**：`to`/按厂商/profile/模型分派、`tell`、规则 DSL、第二套运行时、issue/pull/comment/review 事件。

## 验证命令

```sh
openspec validate --all --strict            # 9 passed, 0 failed
openspec status --change dispatch-rules     # 4/4 artifacts complete
git status --short                          # 只有 openspec/ 与 docs/notes/
env -u GIT_CONFIG_GLOBAL pnpm check         # 纯文档也跑，确认没碰坏构建
```
