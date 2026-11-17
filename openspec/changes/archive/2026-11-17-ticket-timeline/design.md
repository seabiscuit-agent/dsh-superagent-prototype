## Context

本仓库的编排状态是一家 SQLite 库（`src/app/store.ts`）：每张工单、每次派工、每条回执各一行 JSON，
写入时整体覆盖。这套设计的优点是读便宜、状态唯一，缺点是没有历史：报告被后一份报告盖掉
（`src/core/assignments.ts:172`），结束原因只留最后一次（`src/core/tickets.ts:376`），
回执的 `status` 从 `pending` 改成 `sent`/`dropped`（`src/app/store.ts:277`）。
`DomainEvent`（`src/core/ports.ts:88-112`）已经把这套系统「会发生什么」的词汇表定完了，
但它只被 `src/app/runtime.ts:188-205` 用来给主会话推通知，进程重启即失。

`docs/agent-autoloop-gap-proposals.md` 第 1 节要求补一条按时间排列的事实链，并点名参考
agent-autoloop。那边（`kernel/store.ts`、`kernel/evolve.ts`）的做法是「日志即权威」：
所有业务变更先变成 `Fact`（`{seq, at, type, changes[]}`），投影表是可重建缓存，
`rebuild()` 从事实重放。我们只吸收它的三条判断——追加写、与业务写入同事务、
旧事实不伪造时刻——不吸收「投影可重建」，因为本仓库的业务表已经在跑，把它降级成缓存
是一次没有收益的架构迁移（见 `## Goals / Non-Goals`）。

约束：本阶段是提案，不改运行时与 UI；`openspec/config.yaml` 要求需求写可观察行为、
机制写在这里、验收能在生产实例 `superagent`（`http://127.0.0.1:3082`）复现。

## Goals / Non-Goals

**Goals**

- 让人能在不翻会话记录的情况下回答「这张工单为什么走到这里」：时刻、类型、数据三件套，
  按时间升序，任何一个读取入口都一样。
- 事实与业务写入同事务：不存在「状态变了但没记事实」或「记了事实但状态没变」。
- 忠实：旧数据缺什么就显示缺什么，不补时刻、不编事件。
- 成本可控：写一条事实是一次 INSERT，读一条链是一次带索引的 SELECT；不影响既有轮询与投递节奏。

**Non-Goals**

- 不做事件溯源：业务表仍是唯一权威状态，事实表只写不读（除时间线读取本身）。
- 不为时间线引入新的事件总线、异步写入或后台 flush。
- 不接管审计或合规：不记录模型原始对话、不记录 prompt 与工具入参全文。
- 不改通知语义：通知仍由 `emit` 当场生成，不由事实回放产生。

## Decisions

### 1. 事实表与业务写入同事务，靠 `Store.atomic` 而不是新的写入器

备选：

- A. 在 `Part.emit` 里同步写事实。问题：`emit` 既在事务内部调用，也被非事务路径调用
  （`src/core/engine.ts:53` 的 `signalFastPath` 直接 emit、不包 `atomic`），
  且 `MemoryRepositories` 与 `Store` 的实现不同，容易写出「测试有事实、生产没有」的分叉。
- B. 由 `Store.atomic` 在提交后回调里写。问题：`afterCommit` 在回滚时被丢弃（正好），
  但它是内存回调，不具备持久性；写库需要另一个事务，跨事务就不是原子的。
- C. 让每个 `Repositories` 写入方法自己顺手 INSERT 一条事实（本方案）。

选 C：`Repositories` 是 Engine 唯一的写入口，`Store` 的每个写方法已经在一个
`Store.atomic` 里执行，事实 INSERT 直接挂在同一个连接、同一个事务上，回滚天然一致；
`MemoryRepositories` 只需要在内存里 push 一个数组，测试路径与生产路径的语义一致。
代价是每个写方法都要多一行调用，`Repositories` 接口长大；这比「一个隐式全局钩子」更容易审查。
唯一的例外是 `dispatch.fast_path`：它不由业务写入伴随（`signalFastPath` 不改任何状态），
所以在该方法里自己开一次 `atomic` 写事实，不与别的写入捆绑。

### 2. 事实词汇表复用 `DomainEvents`，只在缺口处补三种

备选：

- A. 为时间线另立一套「审计事件」枚举。问题：两套词汇必然漂移，
  今天 `DomainEvent` 已经覆盖了触发、评估、决策、建单、派工、结束、订阅、提问与策略变更。
- B. 直接记录所有方法调用与入参。问题：事实表变成日志倾倒场，体积与隐私都失控。
- C. 复用 `DomainEvents`，只补今天没有对应事件的三种事实（本方案）。

选 C：`report.recorded` 补上「报告被覆盖」这个真实缺口；`receipt.*` 补上投递三段状态
（`OutboundMessage` 没有时刻，这个缺口在 proposal 里已经点明）；`question.withdrawn`
补上问题被撤回这个没有事件的状态迁移。其余一律不加，需要新事实时先加 `DomainEvent`。

### 3. 事实表只写不读，业务表保持权威

备选：

- A. 照抄 autoloop：事实即权威，投影重建（`rebuild()`）。问题：本仓库的
  `ticket`/`decision`/`thread` 行同时被视图、HTTP、资源读取和迁移使用，
  把它们降级成缓存要重写迁移、全部视图与并发模型，收益只是「能重放」，而我们不做重放。
- B. 双写并让读取优先事实、回落业务表。问题：两套真相，冲突时没人能判断谁对。
- C. 事实只写，读取只用于时间线（本方案）。

选 C。这条决定同时把风险关在笼子里：事实表损坏、清空或被误删，只影响时间线，
`tests/timeline-facts.spec.ts` 里专门有一条「清空事实表后编排行为不变」的用例守着它。

### 4. 读取上限与截断：返回最近一批并显式标 `truncated`

一张长工单可能有几百条事实（每次派工、每条回执都算）。备选：

- A. 全量返回。问题：面板每次轮询都拉全量，`orchestrator_read` 也会把整个链塞进上下文。
- B. 分页游标（像 thread page 那样）。问题：时间线的主要用法是「看最近发生了什么」，
  分页把最常见的用法变成两次请求。
- C. 默认返回最近 N 条（`N = 200`），`truncated: true`（本方案）。

选 C。`why --json` 与 HTTP 一致；需要完整历史时后续再加 `--all` 或游标，不现在猜。

### 5. 回填显式、标 `derived`、幂等

备选：

- A. 迁移时一次性回填所有旧工单。问题：迁移变慢、可能失败，且「推导出来的历史」会与
  「真实记录的历史」混在一张表里看不出区别。
- B. 不回填。问题：旧工单（包括正在排障的这张）永远没有时间线，功能上线即打折。
- C. `why <id> --backfill` 显式回填，行标 `origin = "derived"`（本方案）。

选 C。幂等靠「同一工单 + 同一推导键」判重，已存在的 `recorded` 事实永远优先；
推导不出的时刻留空（`at: null`），面板与 `why` 显示「无时刻」。这正是 autoloop
`docs/state-machines.md` 里「旧事实不伪造时间」那条纪律。

### 6. `why` 用子命令而不是第二个位置参数

现在的 `scripts/dsh-superagent` 是 `action` 单位置参数（`start|stop|restart|status`），
直接加第二个位置参数会让 `dsh-superagent status --json` 之类的写法含混。
备选：把 `action` 换成 argparse subparsers。选它：既有四种动作的参数与退出码契约不变，
`why` 作为新 subcommand 自带 `ticket_id` 位置参数与 `--json`/`--backfill`；
`tests/service-script.spec.ts` 里断言精确输出的用例需要跟着改成 subcommand 形式，
但行为与退出码语义保持。

## Risks / Trade-offs

- **每个写方法多一次 INSERT**：写放大。缓解：事实行只存必要字段，`data` 用 JSON 列；
  基准是「一次派工写两三条事实」，与已有的整行 JSON 覆盖相比不是数量级变化。
- **表会持续增长**：不做压缩（非目标）。缓解：`ticket + at` 索引让读取保持常量级；
  真正需要时再提案归档策略，本提案不猜阈值。
- **`emit` 与事实可能不一致**：如果某个状态迁移只改了业务表而没有对应事件，
  时间线会缺一段。缓解：`tests/timeline-facts.spec.ts` 用「每个 `DomainEvents` 成员至少出现一次」
  的表驱动用例，加上逐条链路的顺序断言；缺事件时先补 `DomainEvent` 再补记录点。
- **CLI 改造风险**：subcommand 重构会碰到 `tests/service-script.spec.ts` 的精确断言。
  缓解：先改测试再改脚本，保持退出码映射不变（0/1/2/3 语义 + 新增 4）。
- **面板轮询成本**：时间线默认收起，收起时不请求接口；展开后随详情页轮询刷新。
- **本提案是文档**：`openspec validate --all --strict` 通过不等于实现完成；
  `tasks.md` 最后一组专门列了生产实例实测与新会话接管验证。

## Migration Plan

1. `SCHEMA_VERSION` 11 → 12，`OLDEST_SCHEMA` 保持 10；`migrateTo12(store)` 只建 `fact` 表与
   `fact_ticket_at` 索引，不改写任何既有行、不回填。
2. 迁移失败沿用既有包装（`The orchestrator database is unchanged at schema ${version}: …`），
   保证「版本没升、表没建」的原子性，不出现半成品。
3. 上线顺序：先落表与写入点（旧工单时间线为空）→ 再开三个读取入口 → 最后开 `--backfill`。
   每一步都可以独立回滚：关掉读取入口不丢数据，回填写的是 `derived` 行，可以整批删掉。
4. 生产实例 `superagent`（`:3082`）升级后先做一次 `why <一张已结束工单>` 确认链路，
   再按需对正在排障的工单执行 `--backfill`。

## Open Questions

- 读取上限 `200` 是否是合适的默认值？如果面板实际只需要最近 50 条，
  上限可以按入口分开（HTTP 50 / `why` 200）。实施时用真实工单长度校准。
- 事实行要不要带 `seq`（单调递增）以便同 `at` 时稳定排序？本提案先用 `(at, id)` 排序；
  如果同一毫秒内出现多条事实且顺序会误导，再补 `seq` 列（需要迁移）。
- `question.*` 三种事件不走 `Part.emit` 辅助方法，而是在 `src/core/engine.ts:288`、
  `:305`、`:321`、`:341` 直接调用 `this.options.emit?.(...)`。记录点必须覆盖两种写法，
  实施时以「`DomainEvents` 的每个成员都有对应事实」的测试为准，而不是按调用点逐个数。
- 问题被撤回有三处状态迁移（`src/core/assignments.ts:139`、`:167`、`src/core/tickets.ts:361`）
  却没有事件；`question.withdrawn` 事实要么补一个 `DomainEvent` 再记录，
  要么在这三处直接记事实。本提案倾向前者（保持「先有事件再有事实」），实施时确认。
