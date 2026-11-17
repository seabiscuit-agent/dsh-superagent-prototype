## Context

宿主今天的时间相关能力只有三处，都不承担「按墙钟产生新事件」：

- **2 秒节拍**：`src/app/passes.ts:28` 的 `setInterval(() => this.request(), 2000)`，
  `pumpOnce()` 只做 `effects.kick()` 与 `engine.evaluateDue()`（`:63-68`）。`pump()` 首行
  `if (!this.host.configured() || this.host.closing()) return`，所以未完成 setup 时整条泵都停。
- **一次性 agenda**：`ticket-agenda` 复用 `effect` 表，`Effects.enqueue(kind, key, payload, at?)`
  支持未来 `due`；`agendaKey(ticketId, name) = 'ticket:<id>:<name>'`；到点给**已存在的活工单**
  追加一条 `agenda` Input。它的 `proposal.md` 明确「不做内置 schedule Source（cron 行）」，
  `design.md` 的 Open Questions 把「cron 应该复用 agenda 还是直接生成 Trigger」留给后续。
- **来源轮询**：`src/sources/poll.ts` 只服务「线程有活动」的抓取（`POLL_HORIZON_MS = 14 天`、
  `cursorAt(started)` 回退 5 秒），语义是追消息，不是按钟点造事件。

来源契约（`src/sources/kind.ts`）已经允许一个 kind 自定义 `schema`、`fields`、`health`、
`scope`、`policy.rows`、`channel`，并由 `SourceRegistry.register()` 在 plugin `apply()` 里注册；
每个来源插件有自己的 entry（`tsdown.config.ts` 的 `github-watch` / `feishu-watch` /
`local-watch`）与 `cordis.patch.yml` 的 insert 行。`SourceContext.receive(trigger)` 是唯一入口：
`src/core/intake.ts` 会做 scope 判定、线程订阅、`addInput`、评估排队与事实落库。也就是说
「按时间产生一条事件」所需的下游能力**已经齐全**，缺的只是上游那个产生者。

授权侧（`src/policy.ts:171-188` `machineGate`）已经能处理无发送者的 Trigger：`actor.id`
为空时走 `const cell = 'unlistedUnaddressed' as const`，要求该格为 `inferred` 且
`eval.mode !== 'off'`，结果 strength 恒为 `inferred`。GitHub CI 事件就是这个形状的先例
（`src/sources/github.ts` 的 `ci` 行，注释「CI has no sender, so only the cell of a sender off
the list who does not address the agent applies.」）。

约束：

- `package.json` 的运行时依赖只有 `zod` 与 `proper-lockfile`；不为一个 cron 解析引入新依赖。
- `tests/bundle-patch.spec.ts:33-35` 硬断言 `cordis.patch.yml` 顶层 insert 的 id 顺序，新增插件行
  必须同步改这条断言。
- `SourcePolicyPart.schema` 每个字段必须有 default（`registry.ts` 的 `policyPart()` 在
  `safeParse` 失败时回落 `schema.parse({})`），否则面板一存就崩。
- `SourceContext` 不含 `masterId`（`src/app/source-context.ts` 的 `SourceContextDeps` 没有它），
  来源只能通过 `ctx.notify()`（notice effect）回主会话，或直接走 `ctx.receive()`。

## Goals / Non-Goals

**Goals:**

- 让宿主自己按 5 段 cron + IANA 时区产生来源事件，不需要系统 crontab、外部 agent 或人工点击。
- 产生的 Trigger 走完整既有链：scope → admission → 评估 → 建单 → 时间线，不旁路任何一步。
- 同一到期时刻恰好一次；重启、暂停、来源关闭后恢复只补最近一次。
- 语法与时区错误可见（健康项 + 面板），不静默降级、不猜。
- 配置面自然是「一组任务行」，能在一个 Source 卡片里加/改/停。

**Non-Goals:**

- 不执行命令、不发 HTTP：本来源只产事件，具体动作由评估后的工单承担。
- 不给 `schedule` 提供回执 channel（定时触发建的工单没有默认回话对象）。
- 不做同组串行、优先级、手动「立即运行」、重放历史档位。
- 不改 `Passes` 节拍、不改 `evaluateDue()` 语义、不碰 `agenda` 的 key 空间。
- 不做秒级粒度。

## Decisions

### 1. cron 直接生成 Trigger，不复用 agenda

三个备选：

- **A. 复用 agenda**：让 cron 到点给某张工单追加 `agenda` Input。
- **B. 复用 agenda 的存储与循环，但产生 Trigger**：新开一个 `cron` effect kind，到点仍走
  `Effects.handle`，由处理器调 `ctx.receive()`。
- **C. 独立来源自己的 watch 循环，直接 `ctx.receive()`**（选中）。

选 C。理由：

- **身份不同**。`agenda` 的身份是「这张工单的一条 Input」，签名是
  `orchestrator_schedule(ticket_id, key, at, reason)`——`ticket_id` 必填。cron 的身份是
  「一个来源到点了」，它可以建一张新工单，也可以没有任何人接（默认 `ignore` 时连单都不建）。
  用 A 就必须先无中生有一张工单，或给 `ticket_id` 加「可空」语义，把「工单定时器」和
  「来源事件」混成一件事，`agenda.dropped`、`tickets.wake` 这些既有分支全部要重新定义。
- **链路不同**。Trigger 必须经过 scope 与 `machineGate` 才能建单；Input 是**已经准入之后**的
  东西。A 会绕过准入，等于让一个 cron 行无条件拥有派工权，与 `docs/002-authorization.md`
  的分层冲突。
- **B 的代价**：`Effects` 是「重试直到成功」的队列（`retry`、`FAILURES_BEFORE_ERROR = 3`、
  `Later`）。cron 的语义恰好相反：错过就是错过，不需要重试，重试反而会造出「补跑」，
  与「只补最近一次」的要求打架。而且 B 需要一个持续的生产者把未来的到期时刻写进 effect 表，
  等于在没有来源的地方复制一份来源。

结论：**C**。这与 `docs/agent-autoloop-gap-proposals.md` 第 2 块「只产 Trigger，不直接派工」
一致，也正面回答了 `ticket-agenda/design.md` 的 Open Question。

### 2. 用独立 watch 循环，最小间隔 1 分钟，睡眠到下一次到期

`Passes` 不参与（2 秒节拍只服务 effects 与 Eval 到期）。`schedule` 的 watch 循环形状照抄
`src/sources/github.ts` 的 `watch(ctx, signal)`：

```
await ctx.ready
if (!ctx.configured()) { report('schedule', health('paused','setupPending')); return }
while (!signal.aborted) {
  const wait = 计算所有行里最近的一次到期时刻 - now，夹在 [1s, 60s]
  await pause(wait, signal)
  ... 逐行判到期、产 Trigger、推进游标 ...
}
```

备选是「固定 60 秒轮询」：实现更简单，但 8 小时的日常任务会让每分钟都醒一次做无用功（虽然
成本极低），且下次触发时刻的计算精度只有分钟；睡眠到边界既省唤醒也能在 :00 秒准时产生事件。
上限 60 秒同时充当安全网：主机休眠/时钟跳变后最多一分钟内自愈。下限 1 秒避免空转。

`pause(ms, signal)` 复用 `src/sources/poll.ts` 的实现（全局 `setTimeout`），使得 vitest 假时钟
可以驱动。

### 3. cron 与时区自实现，纯函数，不引依赖

`src/sources/schedule-cron.ts` 只做两件事：

- `parseCron(expr): { minutes, hours, days, months, weekdays }`——5 段，每段接受 `*`、
  `a`、`a-b`、`a-b/s`、`*/s`、`a,b`；月/周接受 `JAN`…/`MON`…；拒绝 6 段（含秒）、`@daily`、
  `L`、`#`、`?`。
- `nextDue(spec, timezone, after: Date): Date | undefined`——按 `timezone` 的 wall clock 逐分钟
  前进（最多 5 年）找第一个匹配；用 `Intl.DateTimeFormat` 取该时区的年月日时分与 UTC 偏移，
  因此 DST 自然正确，不需要内置 tz 数据库。

备选：`croner` / `cron-parser` 之类。否决理由：为了一个字段引入第三份运行时依赖、且它们的
边界行为（`L`/`#`/秒字段）超出本变更需要的语法面；自实现 ~120 行、完全可单测，还避免了
「库接受 `@daily` 而我们的 spec 说不接受」的错位。

日与周同时受限时采用**并集**（Vixie cron 语义），不采用「两者同时满足」。这一条必须写进
单测，因为它是 cron 实现里最常见的静默错。

### 4. 逐行游标放 `KV.schedule`，不新建表

`src/app/source-context.ts` 的 `state` 就是 store 的 key/value：`get` / `set` / `keys(prefix)`。
新增 `KV.schedule = { cursor: family<{due: string}, [job: string]>('schedule-cursor:') }`，
记录该行已处理的最后到期时刻（UTC ISO 字符串）与触发 id。备选是新建 `schedule` 表或复用
`effect` 表：

- 新表要动 `store` 与 schema 版本，收益只有「可查询」，而面板只需要下次时刻（可由 cron 现算）。
- `effect` 表是重试队列，语义不合（见决策 1）。

游标写在与「推进」同一批 `ctx.atomic()` 里，保证「触发已入域」与「游标已前进」不会分裂：
先 `ctx.receive()` 拿到 `stored` / `duplicate` / `filtered`，再在同一个原子块里写游标。若
`receive()` 抛错（例如宿主正在关闭），游标不动，下一轮会重算同一到期时刻——此时 Trigger id
不变，重复入域被 intake 的 duplicate 分支吞掉，因此是幂等的。

### 5. 触发 id 由 (key, due) 决定

`key()` 来自 `src/core/ids.ts:3`（sha256 前 32 位），与 GitHub 的
`key('github-comment', url, id, version)` 同风格：`key('schedule', job, due)`。这让「同一到期时刻
无论被算几次」都收敛到一个 id，重启、双实例、时钟回拨都不会产生第二张工单；而两个任务行在
同一分钟到期拿到不同 id（`job` 不同）。

### 6. 无发送者 Trigger + `unlistedUnaddressed` 格 + 每行一个 admission row

`scope()` 返回 `{ listened: true, observed: false, row: <job key> }`。`policy.rows(config)` 为每个
启用的任务行返回一行 `AdmissionRowView`（`id` = key，`label` = 行 title，`note` 说明 cron 与
时区），`cells` 只允许 `unlistedUnaddressed`——因为本来源的 Trigger 永远无发送者，没有
「listed」与「addressed」的语义。这与 `src/sources/github.ts` 的 `ci` 行完全一致。

默认值仍是 `ADMISSION_DEFAULTS` 的 `unlistedUnaddressed: 'ignore'`：**装好不会自动开始建单**，
用户必须显式打开。这是本变更最重要的安全默认。

### 7. 只产 Trigger；回执通道留空

`SourceKind.channel` 省略。后果是：定时触发建的工单，`src/core/replies.ts:117` 的
`sourceChannel(ticket) = this.source(ticket)?.channel ?? ticket.channels[0]` 只能取
`ticket.channels[0]`——而 `create()` 只收集 `trigger.channel` 存在的来源（`:47-50`），所以
`channels` 为空，工单需要回复时会抛 `UserError('noChannel')`。

这是**故意**的：定时任务没有天然的回话对象，凭空编一个（主会话？最后一封飞书？）会制造
「谁在跟我说话」的歧义。本变更把这条限制写进 Risks 与 Open Questions，留给后续（例如
任务行增加可选 `report_to`，指向 `local` 主会话或某个飞书 chat）。

### 8. 组装面：一个 kind、一个 entry、一行 insert

与其它来源一致：`src/sources/schedule.ts` 导出 `name = 'dsh-superagent-schedule'`、
`inject = ['orchestrator']`、`apply()` 里 `ctx.effect(() => ctx.orchestrator.sources.register(kind))`
加一个 AbortController 包裹的 watch；`tsdown.config.ts` 加 `'schedule-watch': 'src/sources/schedule.ts'`；
`package.json` exports 加 `"./schedule-watch"`；`cordis.patch.yml` 在 `dsh-superagent-local`
之后插入 `dsh-superagent-schedule`，并同步改 `tests/bundle-patch.spec.ts:33-35` 的顺序断言。
默认 `disabled: true`，理由与 `feishu` 相同：没有配置时不产生任何行为，也不占用健康面板一行。

## Risks / Trade-offs

- **默认 `ignore` 让「装好却什么都不发生」** → 面板要在该行旁明确写「该行需要在策略里打开准入
  才会建单」，验收标准 6 正面测这一条。
- **定时工单没有回执通道**（决策 7）→ 写进 design 与 notes；短期用 `ticket.channels[0]` 缺失时
  的 `noChannel` 报错暴露问题，而不是静默丢消息。后续变更再补 `report_to`。
- **自实现 cron 的边界错误**（日/周并集、DST、月末）→ 纯函数 + 表驱动单测覆盖这些具体日子；
  `nextDue` 有 5 年上限，找不到就返回 `undefined`（该行不触发 + 健康项 error），而不是死循环。
- **时钟跳变/主机休眠造成「一觉醒来一堆到期」** → 游标只推进到「最后一档错过的到期时刻」，
  每个任务行最多一条 Trigger；不会放大成 N 条。
- **多实例同 stateDir**：`proper-lockfile` 保证只有一个宿主持锁；即使短暂双跑，`key(job, due)`
  让重复入域被吞掉。
- **watch 循环常驻**：每小时 60 次唤醒是最坏情况，每次只做纯计算与比较，成本可忽略；若用户
  没配任何任务行，循环按 60 秒上限睡眠并且不产生任何 store 写入。
- **`Passes` 的 2 秒节拍与 watch 循环并存** → 两者职责正交（effects/Eval 到期 vs 产生新事件），
  不共享状态，唯一交叉点是 `ctx.receive()` 触发的 `this.request()`。

## Migration Plan

1. 合并后默认 `disabled: true`，因此部署后**行为不变**。
2. 用户在 Source 卡片启用 `schedule`，加一行任务，保存。
3. 若要它建单：策略面板把该行的 `unlistedUnaddressed` 从 `ignore` 改为 `inferred`，并确认
   eval mode 为 `auto` 且至少一条规则启用。
4. 回滚：把实例 disable 或删掉任务行即可；`KV.schedule` 里的游标记录成为惰性数据，不需要
   清理，下一次启用会按「新建行」语义重新初始化（若 key 相同则沿用旧游标，只会跳过历史）。

## Open Questions

- 定时触发的工单该往哪里回执？候选：任务行新增可选 `report_to`（`local` 主会话 / 某个飞书
  chat）；或让工单在 `noChannel` 时自动落一条 notice。本变更不做，等真实使用反馈。
- 任务行是否需要「仅工作日」「按季度」这类语义糖？5 段 cron 已能表达（`1-5`、`*/3`），
  先不加。
- 是否需要「最近 N 次触发记录」的只读视图？当前靠 `schedule:<key>` 线程的历史即可，等
  面板实测后再定。
- 多个任务行共享同一 `key` 前缀做分组（例如 `ci-sweep-nightly`）是否够用？先用命名约定。
