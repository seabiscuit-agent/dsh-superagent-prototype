## Purpose

把主会话（orchestrator DSH Session）里所有者写的人消息接成 `local` Source 的显式候选，
让「落盘 / Apply」确认复用既有的 `orchestrator_route kind accept` 原子建单并派工，
全程不需要 @ 机器人、不需要新按钮，也不以飞书为前置条件。

## ADDED Requirements

### Requirement: 主会话人消息成为显式候选

The system SHALL 把主会话中由人发出的 `user/message` 转成 `source: "local"` 的 Trigger，
其 `human` 为 `true`、`addressed` 为 `direct`，并保证该 Trigger 经 admission gate 后的
`strength` 为 `explicit`；MUST NOT 因为消息文本里缺少 @ 机器人而把它判为 inferred 或
not admitted。

#### Scenario: 无 @ 的普通需求成为显式候选

- **GIVEN** 宿主实例 `superagent :3082` 已注册 `local` kind，`policy.sources.local.allowed`
  含所有者 `ou_b0cfd32821e4464db97b2245e2c865e5`，`source:feishu` 为 `enabled: false`
- **WHEN** 所有者在该实例主会话里发送一条不含 @ 的需求消息「给 README 加一句」
- **THEN** 主会话收到一张 `strength: "explicit"` 的候选卡，其 `trigger.source` 为
  `local`、`addressed` 为 `direct`、`human` 为 `true`，且
  `GET tickets?state=open` 的工单数不变

#### Scenario: 列出但加 @ 的所有者仍是显式

- **WHEN** 所有者发送一条含 @ 机器人文本的消息
- **THEN** 产出的仍是单张 `strength: "explicit"` 候选卡，`addressed` 仍为 `direct`，
  不会因为 @ 而重复建 Trigger

#### Scenario: 来源不合规时不入域

- **WHEN** `source:local` 被设为 `enabled: false` 或 `local` kind 未安装
- **THEN** 主会话消息 MUST NOT 产出候选卡，`GET sources` 把 `local` 记为 `off` 或
  `missing`，且不抛未捕获异常

### Requirement: 插件注入的消息被过滤

The system SHALL 只把 `source.kind` 为 `user` 或 `user-rpc` 的主会话消息当作候选来源；
MUST NOT 把插件自身注入的 `dsh-superagent` 消息（candidate card、follow_up、
worker_report、notice）转成 Trigger，也不得由此新建工单。

#### Scenario: 连续注入不产生回声候选

- **GIVEN** 主会话已有 20 条由 `AgentDelivery.send` 注入的 `dsh-superagent` 消息
- **WHEN** 这些消息各自的 `session/event` 被 intake listener 观察到
- **THEN** `GET sources` 中 `local` 的 `filtered` 计数等于注入数且不含新建的
  `local` Trigger，`GET tickets?state=open` 数量不变

#### Scenario: 人消息与注入消息交错

- **WHEN** 一条人消息前后各有一条 candidate card 注入
- **THEN** 只为该人消息产出一张候选卡，两张注入消息都不产出候选卡

### Requirement: Apply 确认触发派工且无需按钮

The system SHALL 在主会话对一张未决显式候选给出「落盘 / Apply」确认时，通过既有的
`orchestrator_route` 的 `kind: "accept"` 在一次事务里创建 Ticket、Mandate、Assignment、
Subscriptions 与 acknowledgement，并启动 Executor；MUST NOT 要求任何新的 UI 按钮、新的
Engine 端点，也 MUST NOT 仅因发出确认就绕过 accept 决策。

#### Scenario: Apply 即建单派工

- **GIVEN** 一张 `strength: "explicit"` 的 `local` 候选卡尚未被决策
- **WHEN** 所有者回复「落盘」或「Apply」
- **THEN** `GET tickets?state=open` 新增一张 running 工单，`GET tickets/<id>` 的
  assignment 含原需求原文，`GET decisions` 含该 `trigger_id` 的 `accept` 决策，
  且 `title` / `worktree_name` / `acknowledgement` 均来自该候选而非新扩写的需求

#### Scenario: 重复 Apply 幂等

- **WHEN** 同一 `trigger_id` 的「落盘」确认被再次提交
- **THEN** 工单数不变，返回已接受工单的既有 `ticketId`，不产生第二张工单

#### Scenario: 未确认不派工

- **WHEN** 所有者只发需求、只问状态、闲聊，或明确说「先别做」
- **THEN** 不调用 accept，不新建工单；这些消息要么保持为未决候选、要么被 `ignore`
  记为普通讨论，`GET decisions` 不出现对应的 `accept`

#### Scenario: 确认被显式停止时不派工

- **GIVEN** 所有者此前对该需求说过「先别做 / 停」，该 hold 仍生效
- **WHEN** 又发来「Apply」
- **THEN** 不新建工单；只有当所有者明确解除 hold 后，新的确认才可能派工

### Requirement: 候选与确认一等公民地留在主会话

The system SHALL 让候选卡、确认对话、结果交付都在主会话的对话流里完成；MUST NOT 为了
派工而要求所有者切换到飞书或 GitHub，也 MUST NOT 通过 `SourceContext.notify` / Outbox
把候选卡塞进主会话 transcript。

#### Scenario: 单 Source 完整跑通

- **GIVEN** `source:feishu` 与 `source:github` 均为 `enabled: false`
- **WHEN** 所有者发需求 → 候选卡 → 「落盘」→ 工单跑完
- **THEN** 全过程在主会话可见；`GET sources` 里 `local` 为 `ready`、feishu 为 `off`
  且不是 `error`；没有 `channelGone` 导致的结果丢失告警

#### Scenario: 回写走主会话内联而非 Outbox

- **WHEN** 工单产出 ready 结果或 human_action 问题
- **THEN** 文本以主会话助手回合或 `agent.steer` / `agent.inject` 的形式出现在同一
  会话里，而不是经 `SourceChannel.send` 写到外部 Channel

### Requirement: 飞书可选且现有行为不变

The system SHALL 允许只启用 `local` 一个 Source 就完成派工；MUST NOT 因飞书关闭而使
主会话消息、Eval、Ticket 或 Executor 失效。所有既有 GitHub / Feishu 的 admission 规则、
allowed 列表、admission 表行与 strength 取值 MUST 保持原样。

#### Scenario: 飞书关闭仍可派工

- **GIVEN** `source:feishu.enabled = false` 且实例已重启
- **WHEN** 重复「无 @ 需求 → 落盘」流程
- **THEN** 成功建单派工，`GET sources` 中 feishu 为 `off` 而非 `error`

#### Scenario: 飞书开启时旧路径不变

- **GIVEN** `source:feishu.enabled = true` 且群 `oc_4eb98eb55063c6b2ab0e1f817aa28dc1`
  的 `listen` 仍为 `all`
- **WHEN** 所有者在飞书群里 @ 机器人发一条新需求
- **THEN** 仍按 `policy.sources.feishu` 现有规则产出同类候选，强度、cell 与
  `via: "addressed"` 的 basis 与启用 `local` 之前一致

### Requirement: 提案可校验且可交接

本仓库 SHALL 以 OpenSpec `spec-driven` 结构承载该提案，且 `openspec validate --all
--strict` MUST 退出 0；一个新会话 SHALL 能只读 `openspec/changes/local-dispatch-source/`
四份文档复述 intake 落点、授权取值、Apply→accept、回写通道、飞书可选这五个决策。

#### Scenario: 严格校验通过

- **WHEN** 在本仓库根执行 `openspec validate --all --strict`
- **THEN** 退出码 0，输出不含 ERROR 或 WARNING

#### Scenario: 产物状态齐全

- **WHEN** 执行 `openspec status --change local-dispatch-source`
- **THEN** 输出 `Progress 4/4 artifacts complete`，proposal / design / specs / tasks
  均为已完成

#### Scenario: 纯文档不改运行时

- **WHEN** 检查本仓库 `git diff --stat` 与 `pnpm build`
- **THEN** 变更只落在 `openspec/` 与 `docs/notes/` 下，不触及 `src/`，且
  `pnpm build` 退出 0
