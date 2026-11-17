## Purpose

内置的定时事件源：用户用 5 段 cron 与 IANA 时区声明若干任务，到点由宿主在 `schedule:<key>`
线程上产生一条无发送者的 Trigger，交给既有的 intake、准入表与评估链，与 GitHub、飞书事件
走同一条路；它只产生事件，不建单、不派工、不执行命令。

## ADDED Requirements

### Requirement: 任务行配置与校验

The system SHALL 提供内置 Source kind `schedule`，其配置是一组任务行，每行恰好包含
`key`、`cron`、`timezone`、`title`、`text`、`enabled` 六个字段；`key` 匹配 `^[a-z0-9][a-z0-9-]*$`
且在同一配置内唯一，`cron` 与 `timezone` 非空，`title` / `text` 非空，`enabled` 缺省为 `true`。

校验分两层，MUST NOT 混同：

- **schema 层**（`SourceKind.schema`）：字段缺失、`key` 格式或重复、文本为空。失败时整个实例按
  既有 `SourceRegistry.resolve()` 语义被置为 disabled（`enabled: false`，config 回落 schema
  默认值），面板显示该实例不可用；宿主不崩溃。
- **行求值层**（watch 循环内）：`cron` 的 5 段语法与语义、`timezone` 是否为已知 IANA 名。失败
  只让**该行**不触发，`schedule` 健康项变 `error` 并点名该行 key，其它合法行照常触发。

分层的理由：cron 与时区是逐行属性，让一行的笔误停掉整个来源会让其它定时任务一起静默。

#### Scenario: 保存一行每分钟任务

- **GIVEN** `schedule` Source 已安装但没有任何任务行
- **WHEN** 用户保存一行 `{key: "ci-sweep", cron: "*/1 * * * *", timezone: "Asia/Shanghai", title: "CI 巡检", text: "看一次 CI 队列", enabled: true}`
- **THEN** 配置通过校验并被持久化，面板里出现这一行；下次触发时刻不在行编辑器里显示（见
  「触发与状态可观察」），以来源线程的实际触发为证

#### Scenario: key 重复或格式非法时整份配置被拒

- **GIVEN** 已有任务行 `key = "ci-sweep"`
- **WHEN** 用户再保存一行 `key = "ci-sweep"`，或保存一行 `key = "CI Sweep"`（含大写与空格）
- **THEN** schema 校验失败并给出该行的错误，原配置保持不变；若该失败配置已落盘，实例被置为
  `enabled: false`，不产生任何 Trigger（这是 schema 层的整实例后果，与逐行的 cron 错误不同）

#### Scenario: cron 或时区非法时该行不触发但有可见状态

- **GIVEN** 一行 `cron = "61 * * * *"`（分钟越界）或 `timezone = "Mars/Olympus"`，另一行合法
- **WHEN** 宿主启动并进入 watch 循环
- **THEN** 只有该行不产生 Trigger，`schedule` 健康项为 `error` 且 detail 带出该行 `key`；
  合法行照常按自己的到期时刻触发

### Requirement: 按 cron 与时区解析到期时刻

The system SHALL 用 5 段 cron（分、时、日、月、周）与 IANA 时区计算每个任务行的下一个到期
时刻，换算按该时区的 wall clock 进行（**含夏令时切换**），并把到期时刻归一化为 UTC ISO 8601
字符串（`...Z`）后使用；语法扩展（秒字段、`@daily`、`L`、`#`）MUST 被当作非法输入拒绝，不得
静默降级。

#### Scenario: 固定时区的每天 9 点

- **GIVEN** 一行 `cron = "0 9 * * *"`、`timezone = "Asia/Shanghai"`
- **WHEN** 宿主在 `2026-11-18T00:30:00Z` 计算下次触发
- **THEN** 得到 `2026-11-18T01:00:00Z`

#### Scenario: 夏令时切换日仍按当地时间触发

- **GIVEN** 一行 `cron = "0 9 * * *"`、`timezone = "America/New_York"`
- **WHEN** 宿主跨越当地 DST 切换日计算下次触发
- **THEN** 到期时刻对应的纽约当地钟面时间仍是 09:00，UTC 偏移从 `-04:00` 变为 `-05:00`
  （或反向），而不是固定偏移

#### Scenario: 认识不到的语法被拒绝

- **GIVEN** 一行 `cron = "0 0 9 * * *"`（6 段，含秒）或 `cron = "@daily"`
- **WHEN** watch 循环求值该行
- **THEN** 该行被视为非法、不进入到期计算，健康项 `error` 点名该行；不静默按 5 段截断，也不
  降级成其它语义

### Requirement: 到点产生一条 Trigger

When a task row's due time arrives, the host SHALL 产生一条 Trigger 并交给
`ctx.receive()`：`source = "schedule"`、`human = false`、
`actor = {source: "schedule", id: ""}`（**无发送者**）、`threads = [{source: "schedule", id: <key>}]`、
`text` 取该行 `text`、`meta = {job: <key>, due: <到期时刻>, cron, timezone}`、`at` 为该到期时刻；
触发 id MUST 由 `(key, due)` 决定（同一输入恒得同一 id）。产生 Trigger 之外，本来源 MUST NOT
直接建单、派工、调用模型或执行任何命令。

#### Scenario: 到点只产生事件

- **GIVEN** 一行每秒分钟都匹配的任务，且没有禁用
- **WHEN** 某个到期时刻到达
- **THEN** `ctx.receive()` 收到一条上述形状的 Trigger，`schedule:<key>` 线程被创建并记录该
  触发；是否建单由既有评估与准入决定，本来源不再做别的事

#### Scenario: 只有时间产生的请求不会自动建单

- **GIVEN** 该任务行的 admission 格为默认 `ignore`，且 eval mode 为 `auto`
- **WHEN** 到点产生 Trigger 并进入评估
- **THEN** `machineGate()` 返回 `admission_ignored`，该 Trigger 落成一条 `ignore` 决策（不是
  intake 的 `filtered` 记录——`filtered` 只在 `scope` 返回 `listened: false` 时写），不建工单、
  不唤醒任何 worker 会话

### Requirement: 同一到期时刻只触发一次

The system SHALL 保证同一个 `(key, due)` 最多入域一次：重复产生的 Trigger 必须被既有触发去重
（相同 id 返回 `duplicate`）吞掉，不得产生第二条 Input、第二张工单或第二条时间线事实。

#### Scenario: 重启后同一到期时刻不重复

- **GIVEN** 到期时刻 `D` 的 Trigger 已入域，游标已推进到 `D`
- **WHEN** 宿主重启，watch 循环重新计算并再次给出 `D`
- **THEN** Trigger id 与已存记录相同，`ctx.receive()` 返回 `duplicate`，没有第二条 Input 或工单

#### Scenario: 两个任务行在同一分钟到期

- **GIVEN** 两行不同 `key` 的任务都匹配同一分钟
- **WHEN** 该分钟到达
- **THEN** 产生两条 Trigger，id 不同，分别落在 `schedule:<key1>` 与 `schedule:<key2>` 线程上，
  互不覆盖

### Requirement: 游标持久化与错过策略

The system MUST 为每个任务行把「已处理的最后一个到期时刻」持久化为游标；宿主重启、来源被
关闭后重新启用、暂停由真变假时，SHALL 从游标继续，并**只为每个任务行补最近一次**错过的到期
时刻，绝不 replay 每一个错过的档位。首次见到一个新任务行时，游标取「当前时刻之前最近的一次
到期时刻」，因此新建一行不会立刻补发历史。

watch 循环 MUST 在暂停期间不产生 Trigger、也不推进游标，使暂停期间的每个到期时刻都在恢复后
折叠成一次。判断暂停 MUST 走新的 `SourceContext.paused()`：现有 `SourceContext` 没有暴露
settings 或暂停状态（`src/sources/host.ts`），来源侧拿不到它。

#### Scenario: 停机三天后恢复只补一次

- **GIVEN** 一行每分钟任务，游标停在三天前，宿主停机三天
- **WHEN** 宿主重启并进入 watch 循环
- **THEN** 该行只产生一条 Trigger，`meta.due` 为最后一档错过的到期时刻（不是三天前那一次），
  游标推进到该时刻；下一次触发是恢复后的下一档

#### Scenario: 新建任务行不补发历史

- **GIVEN** 用户在 `2026-11-18T02:33:10Z` 新建一行 `*/1 * * * *`
- **WHEN** 该行第一次进入 watch 循环
- **THEN** 不产生任何 Trigger，游标初始化为 `2026-11-18T02:33:00Z`，下一次触发在
  `2026-11-18T02:34:00Z`

#### Scenario: 暂停期间不触发

- **GIVEN** `ctx.paused()` 为真（`policy.paused` 或部署检查未完成），期间有多个到期时刻
- **WHEN** Passes 与 watch 循环继续运行
- **THEN** watch 不产生 Trigger 也不推进游标；恢复后只补最近一次，不补全部

### Requirement: 触发走既有授权链

The system SHALL 让 `schedule` 产生的 Trigger 与其它来源走同一条链：`SourceRegistry.scope()`
判定是否听取、`src/policy.ts` 的 `machineGate()` 判定准入、评估与建单沿用既有流程。`scope()`
MUST 对该来源的 Trigger 返回 `observed: true`（并带 `row = <job key>`），因为
`machineGate()` 的第二道条件是「被 addressed 或来源接收全部消息」，而无发送者的 Trigger 永远
不会被 addressed；`meta.job` 不在当前配置的启用行里时，`scope()` MUST 返回
`observed: false`，使其不入域。无发送者的 Trigger MUST 落在 `unlistedUnaddressed` 格，强度恒
为 `inferred`；该格默认 `ignore`，用户必须在策略面板显式改成 `inferred` 才可能入域。

#### Scenario: 未配置准入时不入域

- **GIVEN** `schedule` 的 admission 表保持默认（`unlistedUnaddressed = "ignore"`）
- **WHEN** 到期 Trigger 进入 `machineGate()`
- **THEN** 返回 `{admissible: false, reason: "admission_ignored"}`，不消耗模型调用

#### Scenario: 任务行已被删除或停用后的迟到 Trigger

- **GIVEN** 一条 Trigger 的 `meta.job` 在当前配置里已不存在，或该行 `enabled = false`
- **WHEN** 该 Trigger 到达 intake 或之后重新校验
- **THEN** `scope()` 返回 `observed: false`，Trigger 仍被保存但 `machineGate()` 以 `not_human`
  拒绝，落成一条 `ignore` 决策；若整个来源实例被关闭，则 `scope()` 返回
  `{listened: false, reason: "source_disabled"}`，intake 直接写 `filtered` 记录。两种情况下都不
  建工单、不被旧结论唤起

#### Scenario: 打开准入后由评估决定是否建单

- **GIVEN** 用户把 `unlistedUnaddressed` 设为 `inferred`，eval mode 为 `auto`，且有一条启用规则与
  该任务文本相关
- **WHEN** 到期 Trigger 进入评估
- **THEN** Mandate 的 strength 为 `inferred`、basis 的 cell 为 `unlistedUnaddressed`；评估接受时
  建工单，拒绝时只留一条决策记录

#### Scenario: 来源或实例被关闭

- **GIVEN** `schedule` 实例被 disabled，或有任务行 `enabled = false`
- **WHEN** 到期时刻到达
- **THEN** 不产生 Trigger；前者由 `scope()` 返回 `{listened: false, reason: "source_disabled"}`，
  后者该行根本不进入 watch 循环

### Requirement: 触发与状态可观察

The system SHALL 让用户能看出定时源在做什么，且只承诺现有面板真正能渲染的两条通道：

1. `schedule` 健康项：异常时（某行 cron/时区非法）状态为 `error`，detail MUST 含该行 `key` 与
   错误原因——来源列表只渲染 `error` 与 `paused` 的条目（`src/client/source.tsx:103`），所以这是
   唯一在面板可见的健康通道；正常时的 `ready` detail MUST 写出已启用行数与下一次触发时刻，
   供日志与后续面板扩展读取，但不作为本变更的可见性承诺。
2. `schedule:<key>` 线程：每次触发的 `at`、`meta.due` 与任务文本随既有来源线程与时间线可读。

本变更 MUST NOT 承诺「在配置行编辑器里显示每行下次触发时刻」：`FieldSpec` 的 `rows` 列只支持
`text` 与 `select`（`src/sources/kind.ts:22`），`SourceKind.facts` 只接收 `deployment` 而拿不到
配置（`src/sources/kind.ts:91`、`src/app/views/settings.ts:36`），现有面板没有渲染配置派生只读
值的通道。展示每行下次触发时刻需要给面板新增能力，留给后续变更。

#### Scenario: 非法行在健康项里点名

- **GIVEN** 三行任务，其中一行的 `cron` 非法
- **WHEN** 用户查看来源列表
- **THEN** `schedule` 健康项状态为 `error`，detail 含该行 `key` 与错误原因；另外两行照常触发

#### Scenario: 触发在来源线程上可见

- **GIVEN** 一行任务已经触发过若干次
- **WHEN** 用户打开 `schedule:<key>` 线程或该线程上的工单时间线
- **THEN** 能看到每次触发的时刻（`at` = 到期时刻）与任务文本，不需要额外视图
