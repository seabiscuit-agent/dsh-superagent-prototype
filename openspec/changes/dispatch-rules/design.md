# Design: dispatch-rules

## Context

superagent 的 intake 对每个通过 scope 过滤的 trigger 都执行 `queueForEval`（`src/core/intake.ts:62`），
随后由主会话模型在 pass 中评估（`src/core/evals.ts:71` 起）。现有的机械接受路径只有两条：人手打
`!dispatch` 前缀（`src/app/runtime.ts:340-370`）与 trigger 已订阅到工单时的 fanout
（`src/core/intake.ts:19-67`）。前者要求有人在场，后者要求先有工单。

`policy.rules` 是 assessor 的自然语言输入（`src/policy.ts:67-69`），只影响模型判断，不能机械求值。
`sources` 的 admission 配置决定一个 Source 的机器事件能否进入评估，但准入之后仍然走模型。

本文档描述的是本仓库的 prototype（`src/` 与 `tests/`）；「提案」本身只是文档。下文所有「MUST/SHALL」
是对实现阶段的约束，不是已经实现的行为。

## Goals / Non-Goals

**Goals**

- 让「CI 失败」「定时到点」这类 Source 已明确知道类型的事件，在配置命中时零模型调用地建单。
- 匹配条件必须可机械求值，且不削弱现有的准入与显式请求语义。
- 规则变化、容量不足、多规则歧义都必须可观察，不静默丢事件、不静默改行为。
- 复用现有 Mandate、Decision、disposition 与 policy 变化机制，不引入平行记账。

**Non-Goals**

- 不按厂商 agent、profile 或模型分派工作（差距文档中的 `to`）；本仓库只有一个执行器。
- 不做通用规则引擎、模板、脚本、HTTP/cron 调度；本变更只把已有事件接到工单。
- 不改变人类请求的评估路径，不改变 followup/fanout 行为。
- 不为 `observe` 模式提供「模拟直通」结果。

## Decisions

### 1. 配置放在 `policy.dispatch`，与 `policy.rules` 分开

`policy.dispatch = { rules: [...] }` 随 `policy` 块一起保存，`policyVersion` 的哈希输入加入
`dispatch`；`policyEffects` 的 `asBefore` 也恢复旧的 `dispatch`。备选是顶层
`settings.dispatch`，但那需要新的 `SettingsBlock`、新的工具枚举、新的 revision 传播，且 policy
变化检测要跨块比较。代价是 `policy` 块变大，但派工规则本来就只在策略变化时才有意义。

规则字段：`{ id, enabled, when: { source, events[] }, title, brief, maxActive }`。`id` 复用
`RuleIdSchema`；`when.events` 非空；`maxActive` 为 1..16 的整数（与 `LIMITS.maxWorkers` 同量级）。
不设 `to`：见明确不做。

### 2. 事件类型由 Source 声明，规则只匹配 `source + event`

Trigger 增加可选 `event`（`<source>.<kind>`）。本变更只声明两个 Source 的事件：schedule 的
`schedule.fire`（`src/sources/schedule.ts:44-50`）与 GitHub CI 的 `github.ci.failed|running|passed`
（由 `ciCounts` 在产 trigger 时推导，`src/sources/github-read.ts:17-24`）。备选是从 `meta` 推断事件
（`kind`、`ci` 布尔等），但 meta 是 Source 私有的，跨 Source 解析会耦合到每个 Source 的内部形状；
而 `event` 是 Source 对外的公共契约，未来加事件只需 Source 侧声明。

规则只按 `source` 与 `event` 匹配，不做正则、路径、分支或标签过滤。理由是：更复杂的条件会让「为什么
这条规则没命中」难以解释，而且需要新的表达式语言；需要区分时，用多条规则 + `maxActive` 表达。

### 3. 派工在 gate 判 `inferred` 之后接管

匹配前先走现有 gate：`admissible`、`strength === "inferred"`、`human === false`，且评估模式为
`auto`、策略未暂停。这样派工继承 `scope.listened`、bot 列表、admission cell 的全部安全语义；显式人类
请求与 followup 永远不进派工。备选是只看 `human === false` 就派工，但那会绕过 scope 过滤与准入，
出现「规则命中了被 scope 忽略的事件」这种不可接受的路径。

暂停与 `observe` 刻意不直通：`observe` 的承诺是只观察不动作，暂停是全局闸门。因此暂停期间事件留在
队列，恢复后由模型评估；这是一次明确的取舍（不实现暂停期挂起重放），在 spec 里写明。

### 4. 恰好一条才直通，多条记歧义后回退

零条 → 保持现有 Eval；多条 → disposition `dispatch.ambiguous`，再回退 Eval，不任选一条。备选是
「按配置顺序第一条获胜」，但那让配置顺序成为隐式语义，且一条误配会悄悄改变另一条规则的行为。歧义
记入 disposition，主会话在诊断时能看到全部命中项。

### 5. 复用 `Evals.accept` 与 Decision，而不是直接 `Tickets.create`

`Evals.dispatch(triggerId)` 构造一个 gate-only Evaluation（与 `directEval` 同形，
`src/core/evals.ts:71-160`），然后调用私有 `accept`：Mandate `strength: "inferred"`、`basis.via:
"dispatch"`、`scope` 为规则 `brief`，Decision 原因码 `dispatchRule`。这样 revalidate、policy 变化、
时间线与卡片渲染都无需第二套路径。备选是直接 `tickets.create`，但那会绕过 Mandate 与 Decision，
使派工工单无法被 `policyChanged` 与 `revalidate` 正确处理。

调用时机：`Engine.receive` 在 intake 返回 `stored` 后、同一事务内调用 `evals.dispatch`（intake 已经把
trigger 放进 `thread.pending`，dispatch 在唯一命中时把它取出）。requeue 路径复用同一匹配逻辑，但不要求
trigger 在 pending 中。

### 6. 容量保留而不是拒绝或排队评估

active 按「`mandate.basis.via === "dispatch"`、规则 id 相同、未结束」统计。达到 `maxActive` 时把
trigger 从 pending 取出（否则下一 pass 的模型评估会绕过上限）、记 `dispatch.capacity`、发
`dispatch.held` 通知；`orchestrator_trigger_requeue` 先重试派工，容量释放则建单，仍满则保持。
备选是直接丢弃：与「不静默丢弃」冲突；备选是继续走模型：模型可能建单，使上限形同虚设。

### 7. 设置面板加一节，沿用整块保存

`src/client/eval.tsx` 已有 Policy 规则列表（`RuleRow`、增删、启用开关）。派工规则用同一交互模式加一
节，字段为 source、events、title、brief、maxActive；保存仍走 `orchestrator_settings_save` 的 `policy`
块。备选是新增 settings block 或独立工具，但那扩大接口面与 revision 竞争范围，收益只是编辑体验。

## Risks / Trade-offs

- **误配导致错误建单**：规则是显式配置，命中后不再有模型把关。缓解：`observe` 模式下不直通（配置期
  先用 observe 验证事件流）、规则可随时停用、工单 mandate 与 Decision 显示规则名、`policy-changed`
  把规则变化送到进行中工单。
- **CI 抖动重复建单**：同一 head 从 failed 到 running 再到 passed 会各产一次 trigger 与规则命中的
  机会。本变更不做 per-head 去重，依赖 `maxActive` 与规则作者只匹配 `github.ci.failed`；per-head 去重
  列入 Open Questions。
- **容量长期占满**：保留的 trigger 需要人处理。通知与 disposition 提供指引，但如果没人处理，事件就停在
  那里——这是刻意的「可见保留」而非静默丢失。
- **策略版本变化**：`policyVersion` 纳入 `dispatch`；升级后旧 settings 解析出默认
  `{rules: []}`，与内存对象一致，不会因升级本身产生 policy 变化；真正的规则变化才触发
  `policy-changed`。
- **事件词表是长期契约**：Source 一旦声明 `event` 就不应随意改名；本变更先把最小集合（schedule、
  GitHub CI）写进契约。

## Migration Plan

- 数据：`Settings.policy` 新增 `dispatch`，旧值缺键时用默认 `{ rules: [] }`；无 schema 迁移、无回填。
  旧 Mandate（via addressed/followup/admission/listed/bot）不受影响，`revalidate` 的 dispatch 分支只
  在 `basis.via === "dispatch"` 时进入。
- 行为：未配置派工规则时行为与今天完全相同（零命中回退）。因此该变更可以独立发布；规则由主会话在
  发布后按需添加。
- 回滚：删除 `policy.dispatch.rules` 即回到模型评估；已经建立的派工工单在规则消失后走
  `policy-changed`，不会自动结束。

## Open Questions

- 同一 head 的 CI 状态多次变化是否需要按 head/sha 去重，避免一次提交产生多张工单？可在后续变更用
  `when.events` 之外的条件解决，或由规则 `maxActive` 约束。
- 工单标题是否需要模板（如带分支名或 PR 号）？本变更只支持静态 `title`，细节由 trigger 文本提供。
- 是否为 issue / pull / comment / review 声明事件？需要先定义「评论算不算事件」的语义，避免与
  followup 重复。
- 是否需要「用某条规则重跑一次」的调试入口？当前路径是 requeue + 现有通知。
