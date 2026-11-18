## 1. 领域模型与端口

- [x] 1.1 `Trigger` 增加可选 `event?: string`，Source 构造时写入；`Received`/Mandate 相关类型保持不变
- [x] 1.2 `MandateBasis` 增加 `{ via: 'dispatch'; rule: string; event: string; gate: { via: 'bot'; sender: string } | { via: 'admission'; cell: string } }`
- [x] 1.3 `TriggerDisposition` 增加可选 `dispatch: { result: 'created'; rule; ticketId } | { result: 'ambiguous'; rules: string[] } | { result: 'capacity'; rule; active: number }`
- [x] 1.4 `PolicyEffect` 增加可选 `dispatch?: { rule; title; change: 'changed' | 'disabled'; brief? }`
- [x] 1.5 `DomainEvents` 增加 `dispatch.held: { triggerId; rule; reason: 'capacity' }`
- [x] 1.6 `Policy` 端口增加 `dispatch(trigger): { mode: AcceptMode; rules: DispatchRule[] }` 与 `dispatchBasis(trigger, rule, gate): MandateBasis`

## 2. 配置与策略

- [x] 2.1 `DispatchRuleSchema`：`id` 用 `RuleIdSchema`、`enabled`、`when.source`、非空 `when.events[]`、`title`、`brief`、`maxActive`（1..16），对象 `.strict()`
- [x] 2.2 `PolicyConfigSchema` 增加 `dispatch: { rules: DispatchRuleSchema[] }`，默认 `{ rules: [] }`，拒绝重复 id
- [x] 2.3 `policyVersion` 哈希纳入 `policy.dispatch`
- [x] 2.4 `revalidate` 增加 `via === 'dispatch'` 分支：模式 auto、规则存在且启用、source/event 匹配、gate 路径仍有效
- [x] 2.5 `policyEffects` 比较新旧 dispatch 规则，产出 `PolicyEffect.dispatch`；`asBefore` 同时恢复旧 `policy.dispatch`
- [x] 2.6 `policyMessage` 增加派工规则停用/改变的英文说明
- [x] 2.7 `REASONS` 增加 `dispatchRule`

## 3. 派工执行

- [x] 3.1 `Evals.dispatch(triggerId)`：仅处理已入 pending、无 owners、`human === false`、gate 可准入且 strength 为 `inferred` 的 trigger
- [x] 3.2 唯一命中：构造 gate-only Evaluation、从 pending 移除、`accept` 建单（`title`/`brief` 取自规则，Decision 带 `dispatchRule`），不调用 assessor
- [x] 3.3 零命中：不改动 pending，交回现有 Eval
- [x] 3.4 多命中：写 `dispatch.ambiguous` 后交回现有 Eval
- [x] 3.5 容量：按规则统计未结束派工工单，达到 `maxActive` 时移出 pending、写 `dispatch.capacity`、发 `dispatch.held`
- [x] 3.6 `Engine.receive` 在 intake 返回 `stored` 后调用 `evals.dispatch`
- [x] 3.7 `Evals.reevaluate` 先重试派工（容量释放则建单、仍满则不排队），未命中再走原 requeue
- [x] 3.8 `orchestrator_trigger_requeue` 返回 `queued` 时能区分容量保留（读 disposition）

## 4. Source 事件

- [x] 4.1 schedule Source 的到点 trigger 声明 `event: 'schedule.fire'`
- [x] 4.2 `ciEvent(counts)` 辅助：失败 > 0 → `github.ci.failed`；进行中 > 0 → `github.ci.running`；否则 `github.ci.passed`
- [x] 4.3 branch CI 与 PR checks 的 trigger 构造函数接收并写入 `event`；首次基线仍不产 trigger
- [x] 4.4 未声明事件的 Source（local、issue/pull/comment）保持无 `event`，不进派工

## 5. 设置面板与通知

- [x] 5.1 Eval/Policy 设置页新增「派工规则」一节：列表 + 增删 + 启用开关，字段 source/events/title/brief/maxActive
- [x] 5.2 中英文文案与校验提示；保存仍走 `orchestrator_settings_save` 的 `policy` 块
- [x] 5.3 `eventNotice` 处理 `dispatch.held`，通知说明容量与 requeue 指引
- [x] 5.4 trigger 卡片/时间线展示 `dispatch.created|ambiguous|capacity`

## 6. 验证

- [x] 6.1 `tests/dispatch.spec.ts`：唯一命中零 assessor、零命中走 Eval、多命中歧义、容量保留与 requeue、停用规则、observe 回退、人类不命中、CI 事件映射
- [x] 6.2 更新 `policyVersion`、`policyEffects`、`revalidate` 相关既有测试
- [x] 6.3 `env -u GIT_CONFIG_GLOBAL pnpm check` 通过
- [x] 6.4 `openspec validate --all --strict` 通过
- [ ] 6.5 superagent `http://127.0.0.1:3082` 实测 schedule 规则到点建单、时间线无 `eval.started`、mandate 显示 dispatch
- [x] 6.6 更新 `openspec/README.md` 状态表，归档后把能力移入 `openspec/specs/dispatch-rules/spec.md`
