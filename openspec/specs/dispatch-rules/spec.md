# dispatch-rules Specification

## Purpose

确定性事件派工：Source 在 Trigger 上声明 `event`，`policy.dispatch.rules` 按 `source + event` 唯一命中时
跳过模型评估直接建单；零命中或多命中回退既有 Eval，容量满时保留触发，规则变更时重新校验已建工单。

## Requirements
### Requirement: Source 声明事件类型

Source 在构造 Trigger 时 MUST 可选地声明 `event`，取值为 `<source>.<kind>` 形式的字符串；没有 `event`
的 Trigger MUST NOT 进入派工匹配。本变更 MUST 为 schedule Source 的到点触发声明 `schedule.fire`，为
GitHub CI 触发按检查结果声明 `github.ci.failed`、`github.ci.running` 或 `github.ci.passed`。

#### Scenario: 定时任务到点

- **WHEN** schedule Source 因一个启用 job 到期构造 trigger
- **THEN** 该 trigger 的 `event` 为 `schedule.fire`，且它是无发送者、`human: false` 的机器事件

#### Scenario: CI 状态变化

- **WHEN** GitHub CI 快照中失败数为 0、进行中数大于 0，且 fingerprint 相对上次变化
- **THEN** 产出的 trigger `event` 为 `github.ci.running`；失败数大于 0 时为 `github.ci.failed`；
  两者都为 0 时为 `github.ci.passed`

#### Scenario: 没有事件类型

- **WHEN** 一个 Source 构造了不带 `event` 的 trigger（例如普通评论）
- **THEN** 该 trigger 不参与派工匹配，按现有方式进入评估或 fanout

### Requirement: 派工规则配置

设置 MUST 在 `policy.dispatch.rules` 存放派工规则，与 `policy.rules` 分开；每条规则 MUST 包含唯一
`id`、`enabled`、`when.source`、非空 `when.events[]`、`title`、`brief`、`maxActive`（1 到 16 的整数）。
保存非法或 id 重复的规则 MUST 被拒绝，且未保存的配置 MUST NOT 生效。`policyVersion` MUST 包含
`policy.dispatch`，使规则变化被识别为策略变化。

#### Scenario: 保存合法规则

- **WHEN** 主会话通过 `orchestrator_settings_save` 的 `policy` 块写入一条
  `{id: "ci-fix", when: {source: "github", events: ["github.ci.failed"]}, title: "修 CI", brief: "...",
  maxActive: 2}` 的规则
- **THEN** 保存成功，后续事件按该规则匹配，`policyVersion` 相对保存前改变

#### Scenario: 拒绝非法规则

- **WHEN** 保存的规则 `when.events` 为空、`maxActive` 为 0，或两条规则使用同一个 `id`
- **THEN** 保存失败并返回校验错误，旧配置继续生效

### Requirement: 派工资格

派工 MUST 只对同时满足以下条件的 Trigger 生效：`human` 为 `false`；gate 判定为 `admissible` 且
`strength` 为 `inferred`；评估模式为 `auto`；策略未被暂停；trigger 没有工单认领它（首次接收时已入评估队列）。
人类显式请求、`addressed`、followup，以及 `observe`/`off` 模式下的 Trigger MUST NOT 被派工接管。

#### Scenario: 机器事件且自动模式

- **WHEN** `policy.paused` 为 false、`eval.mode` 为 `auto`，一个 `schedule.fire` 机器事件通过 gate
- **THEN** 该事件进入派工规则匹配

#### Scenario: 人类消息不命中

- **WHEN** 一条 `human: true` 的消息到达，即使它的 Source 与 meta 能被某条规则匹配
- **THEN** 不进行派工，仍由主会话模型评估

#### Scenario: 观察模式不直通

- **WHEN** `eval.mode` 为 `observe`，一个 `schedule.fire` 事件到达
- **THEN** 不建单，触发进入现有 Eval 并记录 would_accept

#### Scenario: 暂停期间

- **WHEN** `policy.paused` 为 true 时一个机器事件到达
- **THEN** 不派工、不建单，trigger 留在评估队列；恢复后由模型评估（本变更刻意不做暂停期挂起重放）

### Requirement: 唯一命中直通建单

恰好一条启用规则同时匹配 trigger 的 `event` 与 `when.source` 时，系统 MUST 不经 assessor 直接建单：
工单标题取规则 `title`，scope 取规则 `brief`；Mandate `strength` 为 `inferred`，`basis.via` 为
`dispatch` 并记录 `rule`、`event` 与 gate 准入路径；Decision 原因码为 `dispatchRule`；trigger
disposition 记 `dispatch.created` 与工单号。同一 fingerprint 的重复 trigger MUST NOT 二次建单。

#### Scenario: 命中即建单

- **WHEN** 一条 `schedule.fire` 规则启用且是唯一命中，assessor 可用但尚未被调用
- **THEN** 立即出现工单，`assessor.request` 调用次数为 0，时间线有 `ticket.created` 而没有
  `eval.started`

#### Scenario: 重复投递

- **WHEN** Source 重复投递与已建单 trigger 相同 fingerprint 的 trigger
- **THEN** intake 去重生效，不产生第二张工单，也不重新走派工

### Requirement: 零命中回退评估

没有规则匹配时，系统 MUST 保持现有行为：trigger 留在评估队列，由模型在下一次 pass 评估决定接受或忽略。

#### Scenario: 无匹配规则

- **WHEN** 一个 `github.ci.failed` 事件到达，没有任何规则的 source 与 events 同时匹配
- **THEN** trigger 进入 Eval，出现 `eval.started`，后续结果与未启用本能力时一致

### Requirement: 多命中记歧义并回退

多于一条启用规则同时匹配时，系统 MUST NOT 任选一条直通；它 MUST 在 trigger disposition 记
`dispatch.ambiguous` 与全部命中规则 id，然后回退模型评估。

#### Scenario: 两条规则同时命中

- **WHEN** 两条启用规则都匹配同一个 `schedule.fire` 事件
- **THEN** 不立即建单，disposition 记录两条规则 id，随后出现 `eval.started` 由模型决定

### Requirement: 容量保留与重新排队

系统 MUST 按规则统计 `mandate.basis.via === "dispatch"` 且规则 id 相同、尚未结束的工单作为 active，
并按以下语义处理容量。active 达到 `maxActive` 时，系统 MUST NOT 建单、MUST NOT 把该 trigger 交给模型
评估；它 MUST 保留 trigger、在 disposition 记 `dispatch.capacity` 并发出主会话可见通知，说明关闭工单后
可用 `orchestrator_trigger_requeue` 重试。requeue 时系统 MUST 先重试派工：容量已释放则建单；仍满则保持
保留状态且 `queued` 返回 false。

#### Scenario: 达到上限

- **WHEN** 某规则已有 `maxActive` 张未结束的派工工单，新的匹配事件到达
- **THEN** 不建单、不出现 `eval.started`，主会话收到一条 `dispatch.held` 通知

#### Scenario: 容量释放后 requeue

- **WHEN** 主会话对一张因容量保留的 trigger 调用 `orchestrator_trigger_requeue`，且此时 active 已小于
  `maxActive`
- **THEN** 直接建单，返回 `queued: true`，工单 mandate 记录同一规则

#### Scenario: 仍满时 requeue

- **WHEN** 容量仍未释放时 requeue 同一 trigger
- **THEN** 不建单、不进入评估，disposition 仍为 `dispatch.capacity`，返回 `queued: false`

### Requirement: 规则变化后的重新校验

对 `basis.via === "dispatch"` 的 Mandate，`revalidate` MUST 要求：`strength` 为 `inferred`；模式仍为
`auto`；同一 `id` 的规则仍存在且启用；`when.source` 等于记录的来源；`when.events` 包含记录的
`event`；gate 准入路径仍有效（bot 仍在列表或 admission cell 仍为 `inferred`）。不满足时 MUST 在该
工单上产生 `policy-changed` 输入，标记 `proactive: false`，并在提示中说明派工规则已停用或改变。

#### Scenario: 规则被停用

- **WHEN** 一张派工工单仍在进行，其规则被禁用或删除
- **THEN** 下一次策略变化检查给它 `policy-changed` 输入，`proactive` 为 false，提示说明规则不可用

#### Scenario: 规则被修改但工单继续

- **WHEN** 同一规则仍启用且 source/event 仍匹配，但 `brief` 改变
- **THEN** `revalidate` 仍通过，工单继续，`policy-changed` 提示要求在新 brief 范围内完成

### Requirement: 结果可见且不静默丢弃

派工结果 MUST 可观察：trigger 的 disposition 展示 `dispatch.created`、`dispatch.ambiguous` 或
`dispatch.capacity`；直通建单的 Decision 显示规则与事件；容量保留 MUST 通过通知到达主会话，MUST NOT
静默丢弃 trigger 或无限期隐藏它。

#### Scenario: 查看一次派工

- **WHEN** 主会话读取该 trigger 的卡片或时间线
- **THEN** 能看到派工结果、命中的规则与事件；建单情形还能看到对应工单

#### Scenario: 容量保留的触发器仍可找回

- **WHEN** 一次容量保留发生后，主会话列出该 trigger
- **THEN** trigger 仍存在、disposition 为 `dispatch.capacity`，并且通知中给出的 requeue 指引有效

