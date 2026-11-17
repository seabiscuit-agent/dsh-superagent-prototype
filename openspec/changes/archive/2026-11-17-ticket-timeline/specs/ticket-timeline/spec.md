## Purpose

给每张工单一条只追加、带时刻的事实链，让「这张工单为什么走到这里」可以被按时间读出来：
事实与产生它的业务写入同事务落盘，业务表仍是权威状态，读取有三个入口（面板折叠行、
`why` 命令、`orchestrator_read ticket/<id>/timeline`），旧工单只在被显式要求时按现有字段
推导回填，缺失时刻一律留空，不伪造。

## ADDED Requirements

### Requirement: 事实与业务写入同事务落盘

The system SHALL 在产生业务写入的同一个 `Store.atomic` 事务里追加对应事实行，
使事务回滚时事实一起回滚；事实表只允许 INSERT，不提供 UPDATE 或 DELETE 通路。

#### Scenario: 派工与事实一起提交

- **GIVEN** 一张 `running` 状态的工单，尚无任何 assignment
- **WHEN** Engine 执行 `assignmentStarted(ticketId)` 启动一次派工并成功提交
- **THEN** `fact` 表中恰好新增一行 `type = "assignment.started"`、
  `data.ticketId` 与 `data.assignmentId` 指向该次派工，且该行 `at` 等于这次写入使用的时刻

#### Scenario: 事务回滚不留下事实

- **GIVEN** 事务内已经写入一条 `ticket.ended` 事实，随后业务写入抛错
- **WHEN** `Store.atomic` 回滚该事务
- **THEN** `fact` 表中不存在这条事实；同一工单的 `ticket` 行仍保持事务前的状态

### Requirement: 事实词汇覆盖领域事件与三种补充事实

The system SHALL 把 `DomainEvents` 的每一个成员都记录成事实，并额外记录三种今天没有事件可记的事实：
`report.recorded`（一次 worker 报告的落盘，含报告状态摘要）、`receipt.queued` / `receipt.sent` /
`receipt.dropped`（回执的排队、发出与丢弃，含 `receiptId` 与丢弃原因）、`question.withdrawn`
（问题被撤回）。每行事实 SHALL 带 `at`、`type`、`data`、`origin`，`origin` 取值 `recorded` 或 `derived`。

#### Scenario: 一条完整链路按顺序成链

- **GIVEN** 一张新工单，从触发到派工、报告、提问、答复、回执、结束依次发生
- **WHEN** 按 `at` 升序读取该工单的事实链
- **THEN** 链路里依次出现 `trigger.received`、`ticket.created`、`assignment.started`、
  `report.recorded`、`question.*`、`receipt.queued`、`receipt.sent`、`ticket.ended`，
  且每条事实的 `origin` 为 `recorded`

#### Scenario: 报告被后一份报告覆盖时两份都在

- **GIVEN** 一次 assignment 已有 `report.state = "blocked"` 的报告，worker 随后又提交 `ready` 报告
- **WHEN** 第二份报告落盘
- **THEN** 事实链里有两条 `report.recorded`，各自带自己的 `at` 与状态摘要；
  业务表仍只保留最新一份报告

### Requirement: 事实链只读且业务表仍是权威状态

The system SHALL 让任何行为都不依赖 `fact` 表的内容：删除或清空 `fact` 表之后，
工单状态、派工、投递与通知行为 MUST 保持不变。

#### Scenario: 清空事实表不影响编排行为

- **GIVEN** 一张有若干事实与一条待发回执的工单
- **WHEN** 直接清空 `fact` 表后让 Passes 与 Outbox 继续运行
- **THEN** 回执照常发出，工单状态与派工流程与清空前一致，只有时间线读取返回空链

#### Scenario: 事实链不被用作恢复来源

- **GIVEN** 宿主重启，`fact` 表里有一条 `assignment.started`
- **WHEN** 宿主启动并恢复既有 assignment
- **THEN** 恢复路径仍走 `assignmentInterrupted` 与既有会话记录，
  不从事实链重放；事实链中新增的是恢复本身产生的事实

### Requirement: 三个读取入口返回同一条链

The system SHALL 通过 `GET /orchestrator/api/tickets/<id>/timeline`、
`orchestrator_read ticket/<id>/timeline` 与面板时间线返回同一份按 `at` 升序的事实链；
结果超过上限时 SHALL 返回最近的一批并把 `truncated` 置为 `true`。未知工单 MUST 返回 404
（HTTP）、`Ticket not found`（资源读取）与退出码 4（CLI），且不创建任何事实。

#### Scenario: 三个入口顺序一致

- **GIVEN** 一张有超过 10 条事实的已结束工单
- **WHEN** 分别用 curl、`orchestrator_read` 与面板读取时间线
- **THEN** 三者返回同样的事实序列（`at` 升序、同一 `type` 与 `data`），
  超过上限时同样给出 `truncated: true`

#### Scenario: 未知工单不写事实

- **GIVEN** 数据库里不存在 id 为 `does-not-exist` 的工单
- **WHEN** 依次请求 HTTP 时间线、`orchestrator_read` 与 `why does-not-exist`
- **THEN** 三者分别返回 404、`Ticket not found` 与退出码 4，`fact` 表行数不变

#### Scenario: 没有事实的工单返回空链

- **GIVEN** 一张在引入事实链之前就结束的工单，未被回填
- **WHEN** 读取它的时间线
- **THEN** 返回 `facts: []` 且 `truncated: false`，不返回错误、也不返回占位事实

### Requirement: 回执时刻诚实

`OutboundMessage` SHALL 增加可选的 `queuedAt`，在回执入队时写入；
既有回执缺失该字段时 MUST 保持缺失，读取与展示都显示为「无时刻」，不得用 `dropped.at`
或当前时刻补齐。

#### Scenario: 旧回执缺时刻显示为空

- **GIVEN** 一条在引入 `queuedAt` 之前入队的回执
- **WHEN** 面板与 `why` 展示这条回执相关事实或回执列表
- **THEN** 该回执的排队时刻显示为「无时刻」，`dropped` 原因仍按其自身时刻展示

#### Scenario: 新回执带排队时刻

- **GIVEN** 一张工单产生一条 acknowledgement 回执
- **WHEN** 回执入队并随后发出
- **THEN** 事实链里有 `receipt.queued` 与 `receipt.sent` 两条事实，
  且 `receipt.queued.at` 等于回执的 `queuedAt`

### Requirement: 面板时间线默认折叠

工单详情页 SHALL 在既有 `Details` 折叠区里增加一行「时间线」，默认收起，
展开后按时间升序显示事实，每行至少含时刻、类型与一句摘要，`origin = "derived"` 的行
MUST 标出来源；工单无事实时该行 SHALL 显示「未记录事实」，不得隐藏整行。

#### Scenario: 展开后与 why 输出一致

- **GIVEN** 一张有 6 条事实的工单详情页
- **WHEN** 打开页面并展开「时间线」
- **THEN** 页面显示的 6 行与 `./scripts/dsh-superagent why <id> --json` 的 6 条事实一一对应，
  顺序相同

#### Scenario: 折叠时不改变其它区块

- **GIVEN** 工单详情页已加载
- **WHEN** 「时间线」保持收起
- **THEN** 页面不请求额外接口、不显示事实行，mandate、inputs、assignments 等既有区块与改动前一致

### Requirement: `why` 命令读取一条链

`scripts/dsh-superagent` SHALL 增加 `why <ticket-id> [--json]`：默认打印人读的按时间排列的事实列表，
`--json` 打印与 HTTP 入口相同的数组；服务不可达时 MUST 以退出码 1 结束，
未知工单以退出码 4 结束，设置未完成仍按既有约定以退出码 3 结束。

#### Scenario: 人读输出与 JSON 同源

- **GIVEN** 生产实例 `superagent`（`http://127.0.0.1:3082`）在跑，且有一张已结束工单
- **WHEN** 执行 `./scripts/dsh-superagent why <id>` 与 `./scripts/dsh-superagent why <id> --json`
- **THEN** 两种输出的事实条数、顺序与类型相同，`--json` 可直接被 `jq` 解析

#### Scenario: 服务不可达退出 1

- **GIVEN** `--url` 指向一个没有监听的端口
- **WHEN** 执行 `./scripts/dsh-superagent why <id>`
- **THEN** 命令以退出码 1 结束并在 stderr 说明不可达，不写任何事实

### Requirement: 旧工单按需回填且不伪造时刻

回填 SHALL 只在显式执行 `why <ticket-id> --backfill` 时发生：按现有字段推导事实并写成
`origin = "derived"`，对同一工单重复执行 MUST 保持幂等，MUST NOT 覆盖或删除 `origin = "recorded"`
的事实；推导不出的时刻 SHALL 留空而不是取邻近值。

#### Scenario: 回填后可读且标为 derived

- **GIVEN** 一张在引入事实链之前结束的工单，`ticket.ended.at` 与 assignment 的 `startedAt`
  齐全但报告缺少时刻
- **WHEN** 执行 `./scripts/dsh-superagent why <id> --backfill`
- **THEN** 时间线出现 `ticket.created`、`assignment.started`、`ticket.ended` 等 `origin = "derived"` 的事实，
  缺时刻的 `report.recorded` 的 `at` 为空，面板与 `why` 都把它显示为「无时刻」

#### Scenario: 重复回填不翻倍也不覆盖

- **GIVEN** 一张工单已回填过一次，且链中有一条 `origin = "recorded"` 的 `ticket.ended`
- **WHEN** 再次执行 `--backfill`
- **THEN** 事实总条数不变，`origin = "recorded"` 的那条事实内容不变，不新增第二份推导事实

### Requirement: 迁移只建表不改写既有行

schema SHALL 从 11 升到 12；迁移只创建 `fact` 表与其索引（`ticket` + `at`），
MUST NOT 回填事实、MUST NOT 改写既有业务行；旧库升级后读取任何工单时间线返回空链而不是错误。

#### Scenario: schema 11 升级到 12

- **GIVEN** 一个 schema 版本为 11 的数据库
- **WHEN** 用新版本 Store 打开它
- **THEN** `fact` 表存在且为空，`kv` 中 schema 版本为 12，既有工单与回执行内容不变

#### Scenario: 迁移失败不留半成品

- **GIVEN** 一个 schema 版本为 11、`fact` 表创建过程会失败的数据库
- **WHEN** 新版本 Store 尝试升级
- **THEN** 启动报出既有的迁移失败提示并保持 schema 11 与既有数据，
  不出现「版本已升到 12 但没有 `fact` 表」的中间状态
