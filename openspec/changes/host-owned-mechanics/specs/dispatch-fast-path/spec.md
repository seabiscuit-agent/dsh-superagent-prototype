## Purpose

让本地来源的首行前缀把「派活」和「讨论」变成机械分流：`!dispatch` 直接建工单、发一条确认，
不经过主会话 assessment；`!discussion` 永不建工单；无前缀保持现有 LLM 路由。

## ADDED Requirements

### Requirement: 前缀识别

For a human user message from the local Source, the host SHALL 只在消息首行识别 `!dispatch`
和 `!discussion`（`!` 后为小写、紧跟前缀、允许一个空格）。前缀出现在引文、后续行或非本地
来源时 MUST NOT 触发 fast path。

#### Scenario: 首行派活

- **GIVEN** 本地主会话收到用户消息首行 `!dispatch 修复登录按钮文案`
- **WHEN** 消息进入 intake
- **THEN** 识别为 dispatch；请求文本为前缀后的内容

#### Scenario: 引文里的前缀不触发

- **GIVEN** 消息正文引用别人写的 `!dispatch ...`，但首行不是该前缀
- **WHEN** 消息进入 intake
- **THEN** 按普通消息走现有路由，不机械建工单

### Requirement: 机械派活

For `!dispatch <请求>`, the host SHALL 直接调用现有 accept 决策创建一张工单，MUST NOT 调用
assessor/eval；MUST 只创建一个工单；标题取请求首行（trim 后 ≤200 字符）；worktree 名由标题
slug + trigger id hash 生成并满足 `WorktreeNameSchema`；MUST 发送一条确认消息。

#### Scenario: 无 assessment 回合

- **GIVEN** `!dispatch 修复登录按钮文案`
- **WHEN** fast path 执行
- **THEN** 创建一张 source=local 的工单；assessor 未被调用；没有 assessment 事件；
  确认消息恰好一条，包含标题

#### Scenario: 重复投递同一 trigger

- **GIVEN** 同一个 trigger 被 intake 重试
- **WHEN** fast path 再次执行
- **THEN** 不创建第二张工单，不重复发确认

### Requirement: 确认语按本地语言

The host SHALL 用本地 Source 配置的 `language`（`"zh"` 或 `"en"`）选择确认模板；确认语
MUST 不超过 IM 字数上限，MUST 包含标题，MUST NOT 写实施计划。`language` 缺失或非法时
MUST NOT 机械接受，回退到现有主会话路由。

#### Scenario: 中文确认

- **GIVEN** `language: "zh"`，`!dispatch 修复登录按钮文案`
- **WHEN** 接受成功
- **THEN** 确认语为中文、≤100 词、包含“修复登录按钮文案”，不包含步骤清单

#### Scenario: 缺语言回退

- **GIVEN** 本地 Source 未配置 `language`
- **WHEN** 收到 `!dispatch ...`
- **THEN** 不创建工单，消息交给主会话按现有路由处理

### Requirement: 接受失败回退

The host MUST 在机械接受被拒时（paused、policy gate、duplicate、invalid title/worktree、
空请求）留下零工单、零机械确认，并回退到现有主会话路由；由主会话决定如何处理。

#### Scenario: 暂停时不抢跑

- **GIVEN** `policy.paused` 为真
- **WHEN** 收到 `!dispatch 修复登录按钮文案`
- **THEN** 没有新工单、没有机械确认；触发条件交给主会话，主会话可按暂停策略忽略/说明

#### Scenario: 空请求

- **GIVEN** 消息为 `!dispatch` 后无内容
- **WHEN** 识别
- **THEN** 返回 `emptyRequest`，回退主会话，不建工单

### Requirement: 讨论前缀永不建工单

For `!discussion <文本>`, the host MUST NOT 创建或 attach 工单；MUST 把去掉前缀的文本作为
普通讨论交给主会话；`orchestrator_route` 对该 trigger 的 accept/attach MUST 被拒绝。

#### Scenario: 讨论不变成工单

- **GIVEN** 用户发送 `!discussion 这个方案怎么样`
- **WHEN** 主会话尝试 `orchestrator_route(kind="accept", trigger_id=...)`
- **THEN** route 返回拒绝（`discussionOnly`），没有工单；聊天里得到讨论回复

#### Scenario: 讨论里可以后续派活

- **GIVEN** 用户先 `!discussion 这个方案怎么样`，之后另发一条无前缀“就按这个做”
- **WHEN** 第二条消息进入
- **THEN** 第二条按现有 LLM 路由处理，可以正常 accept；第一条仍不建工单

### Requirement: 无前缀保持现有路由

A local human message without a recognized first-line prefix SHALL 走现有主会话 assessment/
route 路径，行为不变。

#### Scenario: 普通请求

- **GIVEN** 用户发送“帮我看看登录按钮文案”
- **WHEN** 消息进入
- **THEN** 仍由主会话判断 accept/ignore，不触发机械 accept

### Requirement: 可观察的分流结果

The host SHALL 让 fast path 的结果可观察：工单 `source: "local"`、确认消息、以及
`dispatch.fast_path` 事件（含 trigger id、ticket id、结果 accepted/fallback/discussion）。
事件 MUST NOT 包含完整提示词或私有内容。

#### Scenario: 面板/日志可区分

- **GIVEN** 一次 `!dispatch` 成功
- **WHEN** 查看事件流
- **THEN** 有 `dispatch.fast_path` accepted 事件，绑定 trigger 和 ticket；没有 assessment 事件

### Requirement: 不绕过策略

The fast path MUST 遵守 `policy.paused`、授权/admission 和真实成本规则；MUST NOT 因为前缀
自动批准花钱、跨仓库或公开接口决策；这些仍由 worker/主会话按现有规则处理。

#### Scenario: 派活不等于授权花钱

- **GIVEN** `!dispatch 买一个付费 API 额度`
- **WHEN** 工单被机械接受
- **THEN** 工单存在，但真实成本动作仍需要 owner 的结构化确认；fast path 不产生任何消费授权
