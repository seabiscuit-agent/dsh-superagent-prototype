## Why

`docs/agent-autoloop-gap-proposals.md:33` 把「按规则派工」列为与 autoloop 的差距，现状是：

- 每个非人类事件（CI 结果变化、定时任务到点）进入时都先 `queueForEval`（`src/core/intake.ts:62`），
  必须先由主会话模型读窗口、再决定是否建单；「source + 事件类型命中某条规则」这件事本身没有执行路径。
- `!dispatch` 只是人手打的前缀（`src/app/runtime.ts:340-370`），要求有人先看到消息、再打字；确定性事件
  到点时没有人在场。
- `policy.rules` 是给 assessor 的自然语言提示（`src/policy.ts:67-69`），不构成可机械求值的匹配条件：
  把「CI 失败就修」写成 instruction，仍是模型每个事件重新判断一次。

后果：CI 红了要等下一轮评估；定时巡检到点也要等模型。评估排队、模型抖动或评估超时都会让确定性事件
晚一个 pass 才建单，甚至仍然不建。这类事件本应零延迟、零模型调用地建单。

本变更在设置里引入一个与 `policy.rules` 分离的 `policy.dispatch.rules`：按 `source` + 事件类型精确匹配，
恰好一条启用规则命中时机械建单，且 MUST NOT 调用 assessor。差距文档里的 `to`（把活交给哪个
agent/profile）依赖多执行器选型，本仓库只有单执行器，按 owner 决定不做，见「明确不做」。

## What Changes

- 设置新增 `policy.dispatch.rules`，规则字段：`id`、`enabled`、`when.source`、`when.events[]`、
  `title`、`brief`、`maxActive`；与 `policy.rules` 分开存放，合入 `policyVersion`。
- `Trigger` 增加可选 `event` 字段，由 Source 构造 trigger 时声明；本变更落地 `schedule.fire` 与
  `github.ci.failed` / `github.ci.running` / `github.ci.passed`。
- 只有 gate 判为 `inferred` 的机器事件（`human: false`，经 bot 或 admission 准入）进入派工匹配；
  人类显式请求、followup、`observe`/`off` 模式都不命中。
- 恰好一条规则命中：不调用 assessor，直接建单。Mandate `strength: "inferred"`、`basis.via: "dispatch"`
  记录规则与事件；Decision 原因码为 `dispatchRule`；trigger disposition 记 `dispatch.created`。
- 零条命中：退回现有模型评估，行为与今天一致。多条命中：disposition 记 `dispatch.ambiguous` 后退回
  模型评估，不任选一条。
- 规则 `maxActive` 达到上限：不建单、不进评估，disposition 记 `dispatch.capacity`，触发器留给主会话
  `orchestrator_trigger_requeue`；requeue 时先重试派工。
- 规则被停用、修改或删除：进行中工单按 `mandate.basis.via === "dispatch"` 重新校验（模式仍 `auto`、
  规则仍存在且启用、source 与事件仍匹配、gate 仍有效）；不通过时给工单 `policy-changed` 输入并
  `proactive: false`。
- 设置面板的 Eval/Policy 页新增「派工规则」一节，可增删改查；保存仍走 `orchestrator_settings_save`
  的 `policy` 块。

## Capabilities

### New Capabilities

- `dispatch-rules`：确定性事件按规则直通建单（匹配、机械接受、容量保留、重新校验、可见性）。

### Modified Capabilities

（无。`policy.rules` 的语义不变；`Trigger`/`Policy` 的端口增量在 design 中说明。）

## 明确不做

- 不做 `to`，不做按厂商、profile 或模型分派：owner 已确认那半对本仓库无用（单执行器）。
- 不做 `tell` 或通知模板；容量保留的提示复用现有 notice 措辞。
- 不引入第二套运行时规则文件或规则 DSL：超出 `source + 事件` 的表达式、模板变量、角色选择一律不支持。
- 不替换 SQLite 或 Store，不新增 settings block；派工规则复用 `policy` 块。
- 本变更不覆盖 issue / pull / comment / review 事件，只列 `schedule.fire` 与 `github.ci.*`；其他事件
  等 Source 明确语义后再加。
- 不做卡片点选或一键派工按钮，不改审批流程，不接管人类显式请求。

## 验收标准

1. 单测 `tests/dispatch.spec.ts`：
   - 一条 `schedule.fire` 规则命中：建单成功、`assessor.request` 零调用、mandate `basis.via === "dispatch"`
     且记录 rule/event、Decision 原因码 `dispatchRule`、disposition `dispatch.created`。
   - 零命中：触发进入 Eval，`eval.started` 出现，行为与今天一致。
   - 两条命中：disposition `dispatch.ambiguous`，随后进入 Eval，不建单直到模型接受。
   - `maxActive` 上限：不建单、无 Eval、disposition `dispatch.capacity`、发出 `dispatch.held` 通知；
     关闭一张占用工单后 requeue 该 trigger：建单；上限未释放时 requeue 返回 `queued: false`。
   - 规则停用或删除后新事件：不进派工、走 Eval；已存在工单收到带 dispatch 说明的 `policy-changed`。
   - `eval.mode` 为 `observe`：不直通，走 Eval。
   - 人类消息（`human: true`）即使带匹配 meta：永不命中。
   - CI 状态映射：`ciCounts` 失败/进行中/通过分别产出 `github.ci.failed` / `github.ci.running` /
     `github.ci.passed`。
2. `env -u GIT_CONFIG_GLOBAL pnpm check` 通过（类型检查、单测、构建）。
3. `openspec validate --all --strict` 通过；`openspec status --change dispatch-rules` 显示 4/4 artifacts。
4. 生产实例 superagent（`http://127.0.0.1:3082`）实测：配置一条 `schedule.fire` 规则（1 分钟 cron），
   到点后直接出现新工单，时间线无 `eval.started`，工单 mandate 显示 `via: dispatch` 与规则名；停用规则
   后下一次触发进入 Eval。
5. 交接验收：新的 worker 只读本 change 的四段与 `docs/notes/2026-11-18-dispatch-rules-proposal.md`
   即可复述匹配条件、容量语义、重新校验规则与不做项，无需额外的口头上下文。

## Impact

- 代码（实施时）：
  - `src/core/model.ts`：`Trigger.event`；`MandateBasis` 新增 `via: "dispatch"`；`TriggerDisposition.dispatch`；
    `PolicyEffect.dispatch`。
  - `src/core/ports.ts`：`Policy.dispatch(trigger)`、`Policy.dispatchBasis(...)`；`DomainEvents` 新增
    `dispatch.held`。
  - `src/policy.ts`：`DispatchRuleSchema`、`PolicyConfigSchema.dispatch`、`policyVersion` 纳入 dispatch、
    `revalidate` 的 dispatch 分支、`policyEffects` 与 `asBefore`。
  - `src/core/evals.ts`：新增 `dispatch(triggerId)`；`reevaluate` 先重试派工；复用 `accept`。
  - `src/core/engine.ts`：`receive` 在 intake `stored` 后调用 `evals.dispatch`。
  - `src/core/reasons.ts`：`dispatchRule`。
  - `src/sources/schedule.ts`：`schedule.fire`；`src/sources/github.ts` 与 `src/sources/github-read.ts`：
    CI 事件推导。
  - `src/app/notices.ts`：`dispatch.held`；`src/executor/dsh.ts`：`policyMessage` 的 dispatch 说明。
  - `src/client/eval.tsx`：派工规则一节。
- 数据：`Settings.policy` 新增 `dispatch` 块；旧 settings 无该键时按 `{ rules: [] }` 解析，无迁移。
- 提示词：面板中英文文案与 `policyMessage` 文案；不新增 assessor 提示词。
- 测试：新增 `tests/dispatch.spec.ts`；更新 `policyVersion`/`policyEffects` 相关既有断言；harness 参照
  `tests/schedule.spec.ts:28-60`。
- 文档：归档后 `openspec/specs/dispatch-rules/spec.md`；`openspec/README.md` 状态表；
  `docs/notes/2026-11-18-dispatch-rules-proposal.md`。
