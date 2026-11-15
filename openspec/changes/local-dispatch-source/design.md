## Context

被描述系统就是本仓库 `dsh-superagent-prototype`（宿主实例 `superagent :3082`，
state `~/.dsh/state/superagent/orchestrator.sqlite`，见
`~/dsh-instances/HANDOVER-2026-11-15.md`）。提案与本仓库实现同仓（Explore + Propose
阶段只落盘 `openspec/` 与 `docs/notes/` 文档），不改运行时。

### 现状三栏（2026-11-15 实测）

**已完成（代码里已有、可直接复用）**

- Trigger 形状与幂等：`src/core/model.ts:22-39` 定义 `Trigger`；`src/core/intake.ts:23`
  用 `repo.triggers.get(trigger.id)` 去重，返回 `'duplicate'`；`src/core/ids.ts:3` 的
  `key(...values)` 是各 Source 造稳定 id 的既有工具（`src/sources/feishu-trigger.ts:18`
  `key('feishu', messageId)`）。
- 显式授权的直达路径：`src/policy.ts:197`
  `if (allowed && trigger.addressed) return { admissible: true, strength: 'explicit', ... }`。
  `addressed` 是 Source 侧声明（`src/core/model.ts:31`），`allowedSender` 查
  `settings.policy.sources[actor.source].allowed`（`src/policy.ts:119`）。
  `unlistedAddressed` 是唯一可配成 `explicit` 的 cell（`src/admission.ts:9-13`）。
- accept 即派工：`src/core/tickets.ts:55` `executor.start(...)` 在 `Tickets.create` 的
  同一事务里；`src/app/tools/main.ts:95-102` 的 `orchestrator_route` `case 'accept'`
  调用 `host.engine.decide(...)`；`prompts/dispatch.md:5-6` 已写明 explicit 候选用它路由。
  idempotent by trigger ID（`prompts/dispatch.md:46`）。
- 回声过滤的现成先例：`src/app/delivery.ts:18-24` 的 `deliveryId` 把
  `dsh-superagent` / 旧 `plugin` 源的消息与 `user`（含 `rpcId`）区分开；
  `src/app/delivery.ts:76-78` 注入消息时标 `{ kind: 'dsh-superagent', form: ... }`。
- 主会话是普通 DSH Session：`src/app/runtime.ts:211` `sessions.ensure(masterId, ...)`；
  候选卡经 `src/app/assessment.ts:96-98` → `runtime.ts:134` `sessions.prompt(..., 'steer')`
  → `src/app/delivery.ts:80` `agent.steer(message)` 进入其 inbox。
- 飞书本就默认可选：`cordis.patch.yml:10-12` 里 `dsh-superagent-feishu` 为
  `disabled: true`；`src/sources/registry.ts:124-131` 对未安装/禁用 Source 降级为
  `{ listened: false }` / `{ listened: true, observed: false }`，单 kind 可运行。
- 管理 API 可只读核对：`docs/006-deployment.md:163,169-180,210`，
  `GET sources` / `GET settings` / `GET tickets` / `GET decisions` / `GET prompts`。

**已声称但生产失败（本提案不碰，仅登记）**

- `HANDOVER-2026-11-15.md:30`：新实例不继承 policy / eval / executor / prompts /
  source 配置，飞书群与 allowed 列表都要重配。spawner 的 `settings-template-layer`
  提案负责；本提案的 `source:local` 默认值也必须进那一层，否则新实例仍要手工配。
- `HANDOVER-2026-11-15.md` 四节坑：绝不直改运行中的 `orchestrator.sqlite`（会让
  `Store.settings` 崩 `expected object, received string`）；DSH web token 每次重启变。

**未开始（本提案要解决的真正缺口）**

- 没有任何 in-process 通道把主会话自己的 GUI `user/message` 转成
  `ctx.orchestrator.receive(trigger)`。现有 Source 都是轮询/Webhook 循环调
  `SourceContext.receive`（`src/sources/github.ts`、`src/sources/feishu-loops.ts:26-27`）。
  `session/event` 监听器存在（`src/app/sessions.ts:132` 的 `Sessions.install`、
  `src/app/delivery.ts:34`）但只用于 retry health 与 delivery 去重。
- `src/sources/` 不得 import `src/app/`（`docs/007-architecture.md:258`），所以新监听器
  不能放进 `src/sources/local.ts` 里自注册。
- 领域里没有「确认 / 落盘」这一分类：每条 explicit 候选都要 `orchestrator_route`
  决策（`prompts/dispatch.md:5-6`），`follow_up` 直达 worker（`docs/001-domain.md:37`）。
- built-in skill / prompt / resource reader 的名字被硬编码为 `'feishu' | 'github'`
  （`src/app/context.ts:14`、`src/app/prompts.ts:120-121,147`、`src/app/sessions.ts:340`），
  `SETUP_FIELDS` 也只探测这两个 Source 的账号字段
  （`docs/007-architecture.md:275-286`）。第三个 kind 不会自动拿到 bundled skill 或
  account-setup problem。

## Goals / Non-Goals

**Goals:**

- 让所有者在主会话里「说需求 → 看候选卡 → 说落盘」即完成派工，不切通道、不 @、不点按钮。
- 复用现成的 Trigger / Eval / Mandate / Ticket / Executor / `orchestrator_route`，不新增 Engine 端点。
- 飞书保持可选：关掉它也能完整派工，现有 GitHub / Feishu 行为零回归。
- 把「intake listener 的自激回声」「Apply 与闲聊的区分」「无 channel 时回写」这几个
  真实约束写进规格与 Open Questions，让后续 Apply 工单只读文档就能接手。

**Non-Goals:**

- 本阶段不实现代码、不改本仓库运行时、不引入任何 UI 控件。
- 不把「每条消息自动 accept」当目标：闲聊 / 状态询问 / `stop` 仍是候选或被 ignore。
- 不改 `eval.mode` 对 inferred 候选的语义（`docs/002-authorization.md:101`）。
- 不重构 Feishu/GitHub 的硬编码 skill 名（见决策 6，留给 Apply 决定）。
- 不解决新实例继承（`HANDOVER-2026-11-15.md:30`），只要求把 `local` 默认值纳入那一层。

## Decisions

### 1. intake listener 放在 `src/app`，不放 `src/sources`

备选 A：像现有 Source 一样轮询主会话 transcript → 否决。主会话没有供 Source 用的读游标
与 `ThreadContext.read` 实现，且会与 `AgentDelivery` 的注入消息混在一起，等于重造一套
轮询 + 去重。备选 B：新建 `src/sources/local.ts` 并在其中 `ctx.on('session/event', ...)`
→ 否决，`docs/007-architecture.md:258` 明确 `src/sources` 不 import `src/app`，而
`session/event` 与 `Sessions` 在 `src/app`。备选 C（选）：在 `src/app` 的组合根
`Runtime`（`src/app/runtime.ts:60`，它已 `implements SourceHost`）里装一个
`session/event` 监听器，只认 `masterId` 会话的 `user/message`，构造 Trigger 后经
`SourceContext.receive` / `runtime.receive(trigger)`（`runtime.ts:195`）入域；
`src/sources/local.ts` 只声明 kind / schema / fields / health / policy / scope。
理由：遵守分层、复用 `runtime.ts:160-162` 已有的 `sourceDeps.receive → passes.receive`
链路、不新增 Engine 端点。

### 2. 用 `addressed: 'direct'` + `allowed` 拿 explicit，不靠单元格

备选 A：把相关 admission row 的 `unlistedAddressed` cell 配成 `explicit`
（`src/admission.ts:9`、`src/policy.ts:204`）→ 否决，因为那会放行**任何** direct 消息，
不只所有者。备选 B（选）：`local` kind 对每条所有者消息声明 `addressed: 'direct'`，
并把稳定的所有者 `actor.id` 预置进 `policy.sources.local.allowed`，走
`src/policy.ts:197` 的 `allowed && trigger.addressed` 短路。
理由：explicit 与 accept mode 无关（`docs/002-authorization.md:101`），范围只限所有者，
且不需要 @（`addressed` 是 Source 声明，不是文本里真的 @ 了谁）。

### 3. Apply → accept 走 prompt 关联，不新增端点/按钮

备选 A：新增一个「Apply」按钮或 `Engine.apply` 端点 → 否决，违反「无按钮」且
`orchestrator_route` 已是主会话工具调用。备选 B：每条候选自动 accept → 否决，
会把闲聊、`stop`、状态询问全变成工单。备选 C（选）：在 `prompts/dispatch.md` 增加一段，
让主会话把「落盘 / Apply」识别为对**当前未决显式候选**的 accept，复用该候选的
`trigger_id`，并用 `orchestrator_route` 的 `title` / `worktree_name` /
`acknowledgement`（`src/app/tools/main.ts:61-67`）从原候选合成，不扩写需求
（`prompts/dispatch.md:14,38`）。
代价（诚实登记）：架构里没有「pending confirmation」状态把一条人消息链到某张候选卡；
候选卡是 steered `user/message`，「Apply」是另一条 GUI `user/message`，主会话必须靠
上下文关联 `trigger_id`。这是 prompt/状态设计问题，不是设置开关；`eval.mode` 帮不上忙。

### 4. 回声过滤用 `deliveryId` + 确定性 id + `quiet` 守卫三重

备选 A：只按文本前缀过滤 → 否决，注入的 JSON 文本形态会变。备选 B（选）：复用
`src/app/delivery.ts:18-24` 的 `deliveryId` 语义，只接 `source.kind === 'user'` /
`user-rpc`；用 `key('local', messageId)` 造确定性 Trigger id，让
`src/core/intake.ts:23` 的 `duplicate` 成为第二道防线；监听期间尊重
`runtime.ts:163-166` 的 `quiet` 守卫（工具执行时 `this.quiet++`），避免把
`eventNotice` / `followupNotice` 的 relay 再次喂回 Engine。
理由：这三层都已在生产代码里，不需新机制；重入 `Passes.request()` 有既有守卫可依。

### 5. `local` kind 省略 `channel`，回写走主会话内联

备选 A：实现 `SourceChannel.send` 把 ack/结果写回 → 否决，`SourceContext.notify`
是 Outbox receipt（`src/app/source-context.ts:66` → `src/app/outbox.ts:27`），不是往主会话
transcript 说话；`registry.send` 对无 channel 的 kind 返回 `'gone'`
（`src/sources/registry.ts:98`）。备选 B（选）：省略 `channel`，ack 自然 settle 为
`channelGone` 静默，候选卡、结果、human_action 都由主会话助手回合 /
`agent.steer` / `agent.inject` 内联呈现（`delivery.ts:79-80`）。
代价（诚实登记）：`orchestrator_reply`（`src/app/tools/main.ts:224`）与 `human_action`
的 IM 投递走 `Engine.reply` → Outbox，无 channel 会静默丢弃。要么给 `local` Trigger
一个 `send` 返回 `'sent'` 的 no-op channel，要么在 `src/app` 加一条 steering 路径。
本提案把它列为 Open Question #1，Apply 前必须定，不能默认「结果能到」。

### 6. 飞书保持默认关闭，硬编码名字的取舍留给 Apply

备选 A：把 `'local'` 加进 `sourceSkills`（`src/app/context.ts:14`）、`composeSkill`
（`src/app/prompts.ts:120-121,147`）、`bindSkills`（`src/app/sessions.ts:340`）与
`SETUP_FIELDS` → 完整但要改多处 app 代码。备选 B：什么都不加，接受 `local` 没有
bundled skill、没有 account-setup `problem`、thread context 可能 `NO_CONTEXT`
（`src/app/assessment.ts:47`）。备选 C（选，决策层面）：本提案只确认「Feishu 可关、
单 kind 可跑」成立（`cordis.patch.yml:10-12`、`registry.ts:124-131`），把 A/B 的取舍
列为 Open Question #2 交给 Apply 工单按实际需要决定，不在提案里假装已解决。
理由：这是实现范围问题，不是设计方向问题；提案阶段硬选会越权。

## Risks / Trade-offs

- **自激回声 / 无限候选** → 决策 4 的三重过滤（`deliveryId` + `key()` 确定性 id + `quiet` 守卫）；
  验收项 9 专门在生产实例上连注 20 条验证不新建单。
- **「每条消息都是候选」撞上命令/元消息**（`stop`、状态询问、闲聊、candidate card JSON）
  → 规格里明确「只有对未决候选的明确落盘确认才 accept」，其余保持未决或 `ignore`；
  接受「会记录多条 ignore 决策」这一代价，不引入新的消息分类概念（符合
  `docs/000-philosophy.md` 的少概念）。
- **Apply 确认与候选卡缺少显式关联状态** → 决策 3 诚实登记为 prompt/状态设计；
  Apply 工单需给「当前未决候选」一个可核对的 `trigger_id` 关联规则，并保留
  idempotent accept（`prompts/dispatch.md:46`）。
- **无 channel 时 ack / attention 静默丢弃** → Open Question #1，验收项 11 要求
  `GET prompts` 可审计，Apply 前必须选定 no-op channel 或 app-level steering。
- **built-in skill / SETUP_FIELDS 只认 `feishu|github`** → Open Question #2；
  若选不改，`local` 候选的评估可能只能用 Trigger + batch（无 thread context reader，
  `src/app/assessment.ts:47`）。`docs/007-architecture.md:275-286` 已列出这些惰性耦合。
- **新实例不继承配置** → 验收项 5 要求 `source:local` 与 `policy.sources.local` 进
  settings-template-layer；不解决则新实例仍要手工配，派工链路照旧脆。
- **重入与事务** → `session/event` 处理器里调 `receive` 会重入
  `Passes.request()`（`src/app/runtime.ts:158-159`）；必须尊重 `quiet` 守卫，且
  不要在 Engine 事务里同步等待异步投递。

## Migration Plan

本工单（Explore + Propose）只落盘文档，不触碰运行中的实例。后续 Apply 工单的步骤：

1. 在本仓库新分支写 `src/sources/local.ts`（kind / schema / fields / health /
   policy / scope），`apply` 里 `ctx.effect(() => ctx.orchestrator.sources.register(localKind), ...)`。
2. 在 `src/app/runtime.ts` 装 `session/event` 监听器（`masterId` 过滤 + `deliveryId`
   过滤 + `quiet` 守卫），把 GUI `user/message` 经 `SourceContext.receive` 入域。
3. 在 `cordis.patch.yml` 加 `local` 插件条目；保持 `dsh-superagent-feishu` 的
   `disabled: true` 不变。
4. 在 `prompts/dispatch.md` 加 Apply→accept 段；`GET prompts` 可审计。
5. 把 `source:local`（含 `policy.sources.local.allowed` 的所有者 `ou_b0cfd…`）写进
   settings-template-layer 模板，随新实例继承。
6. 按 Open Question #1/#2 的结论处理回写通道与 skill 名；补 `node --test` 单测覆盖
   回声过滤、确定性 id、Apply 关联、停/闲聊不派工。
7. 在宿主实例 `superagent :3082` 用 `scripts/dsh-superagent --profile superagent restart`
   加载，按 proposal.md 验收项 4–11 逐条在生产核对；`openspec archive
   local-dispatch-source --yes` 归档。

**回滚**：`PUT settings/source:local` 设 `enabled: false`（`GET sources` 变 `off`），
或撤销 `cordis.patch.yml` 的 `local` 条目并重启；GitHub / Feishu 路径自始至终未改，
回滚后退回「飞书 @ 开单」的现状。绝不直改 `orchestrator.sqlite`。

## Open Questions

- **#1 回写通道**：无 `channel` 时 `orchestrator_reply` / `human_action` 的 IM 投递会经
  Outbox 静默丢弃（决策 5）。给 `local` 一个 `send` 返回 `'sent'` 的 no-op channel，
  还是在 `src/app` 加一条指向 `sessions.prompt(masterId, ..., 'steer')` 的 steering 路径？
  Apply 前必须定，否则结果到不了人。
- **#2 skill / setup 名字**：是否把 `'local'` 加进 `sourceSkills` / `composeSkill` /
  `bindSkills` / `SETUP_FIELDS`（决策 6 A），还是接受它无 bundled skill、无 account
  problem、可能 `NO_CONTEXT`（决策 6 B）？影响评估能读多少上下文。
- **#3 「当前未决候选」的关联规则**：当有多张未决候选卡时，主会话凭什么把一句
  「落盘」绑到正确的 `trigger_id`？按最新一张、按文本引用、还是要求确认里带编号？
  这条规则要写进 prompt 且能被 `GET decisions` 核对。
- **#4 所有者身份来源**：`policy.sources.local.allowed` 里的 `actor.id` 用 GUI 登录身份
  还是沿用飞书的 `ou_b0cfd…`？它决定 `allowedSender` 的 `sameName` 比较能否命中，
  需在主会话 GUI 上实测一条真实 `user/message` 的 `source` 形状后定。
- **#5 配置继承**：`source:local` 与 `policy.sources.local` 是否并入 spawner 的
  `settings-template-layer` 模板（本提案只要求，不实现）？若否，新实例仍会缺所有者
  allowed 列表。
