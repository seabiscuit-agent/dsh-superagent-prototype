## Why

现状：宿主实例 `superagent :3082` 只有 GitHub 与 Feishu 两个 Source。开一张新工单，
所有者必须在飞书群里发一条 **@ 机器人** 的消息（`address: 'mention'`），由
`src/sources/feishu-trigger.ts` 造出 Trigger，再经 Thread → Eval → `orchestrator_route`
才能派工。主会话（orchestrator DSH Session，见 `docs/001-domain.md`）本就是所有者与主
agent 讨论需求的地方，但它的 GUI 消息**不会**变成 Trigger：讨论归讨论，真要落盘还得切到
飞书、@ 一下、再等评估。这与 `docs/000-philosophy.md` 的「占用最少人类注意力」相悖，
也与 `HANDOVER-2026-11-15.md:30` 记录的配置继承缺口叠加：新实例连飞书群与 allowed
列表都不继承，派工链路更脆。

而缺的只是「把主会话消息接进 Engine」这一段，不是新的 Engine：
`src/app/delivery.ts:18-24` 已能区分人写的 `user/message` 与插件注入的
`dsh-superagent` 消息；`src/policy.ts:197` 已支持 `allowed && trigger.addressed`
直接产出 `strength: 'explicit'`；`src/core/tickets.ts:55` 已在 accept 的同一事务里
启动 Executor；`src/app/tools/main.ts:95-102` 已把 `orchestrator_route kind accept`
做成主会话的一次工具调用。

## What Changes

- 新增第三个 Source kind `local`：把主会话里所有者发出的 GUI `user/message` 转成
  `source: 'local'` 的 Trigger。
- 每条所有者消息都是**显式候选**（`strength: 'explicit'`）：由 Source 侧声明
  `addressed: 'direct'` 并把所有者预置进 `policy.sources.local.allowed`，
  **不需要 @ 机器人**。
- 主会话对未决候选给出「落盘 / Apply」确认时，用既有的 `orchestrator_route` 的
  `kind: 'accept'` 原子建单并派工，**不引入任何新 UI 按钮**或新 Engine 端点。
- 飞书降为**可选通道**：`source:feishu` 关闭时，仅靠 `local` 也能完整派工；
  现有 GitHub / Feishu 行为保持不变。
- 本提案只交付文档（Explore + Propose）：`openspec/changes/local-dispatch-source/`
  的四份产物与本目录骨架，实施留给后续批准的工单。

## Capabilities

### New Capabilities

- `local-dispatch-source`: 主会话消息即显式候选、Apply 触发即派工、无 @ 无按钮、
  飞书可选的本地 Source 适配器及其验收标准。

### Modified Capabilities

无。核心的 Trigger / Eval / Mandate / Ticket / Executor 契约不改；`local` 是新增的
Source kind，外加 `src/app` 层一个 intake listener 与一段 prompt，不是对既有能力的改写。

## 明确不做

- **不改核心领域模型**：`Engine.decide`、Eval、Mandate、Subscription、admission gate
  的语义都不动；`local` 复用它们。
- **不引入新 UI**：没有「接受 / 派工 / Apply」按钮，没有新面板、新页签或新控件；
  accept 本来就是主会话的一次 `orchestrator_route` 工具调用。
- **不把每条消息都自动 accept**：需求讨论、状态询问、闲聊、`stop` 仍然只是候选或
  被 `ignore`；只有对未决候选的明确落盘确认才建单。
- **不改 `eval.mode` 语义**：`off` / `observe` / `auto` 仍只管 inferred 候选
  （`docs/002-authorization.md:101`）；explicit 在三种模式下都有效。
- **不直写运行中的 `orchestrator.sqlite`**，不改本仓库的运行时代码或 UI：本阶段
  只交付 `openspec/` 与 `docs/notes/` 下的提案文档。
- **不动相邻的「新实例继承」缺口**：`HANDOVER-2026-11-15.md:30` 与 spawner 的
  `settings-template-layer` 提案负责；本提案只要求 `local` 的配置也进那一层。

## 验收标准

本提案是文档，本工单可立即验证：

1. **文档校验**：`openspec validate --all --strict` → 退出码 0，无 ERROR/WARNING
2. **产物齐全**：`openspec status --change local-dispatch-source` → `Progress 4/4 artifacts complete`
3. **交接即验收**：新会话只读 `openspec/changes/local-dispatch-source/` 四份文档，
   能说出「intake 落点、授权取值、Apply→accept、回写通道、飞书可选」五个决策与理由

以下是**实施后**在宿主实例 `superagent :3082` 上必须能复现的生产检查（本工单不实施，
属于后续 Apply 工单的验收）。统一前缀 `api=http://127.0.0.1:3082/orchestrator/api`，
请求带 `x-orchestrator-request: 1`（`docs/006-deployment.md:163,210`）：

4. **local 已注册且健康**：`curl -sH 'x-orchestrator-request: 1' $api/sources` →
   含 `id: "local"` 且 `state: "ready"`（不是 `missing` / `error`）
5. **授权配置**：`curl -sH 'x-orchestrator-request: 1' $api/settings` →
   `sources` 含 `source:local`，`policy.sources.local.allowed` 含所有者
   `ou_b0cfd32821e4464db97b2245e2c865e5`，且 `policy.sources.feishu` 仍可为空
6. **无 @ 即显式候选**：在主会话发一条不含 @ 的普通需求（如「给 README 加一句」）→
   主会话立即收到一张 `strength: "explicit"` 的候选卡；`GET threads` 里该 Trigger 的
   `source` 为 `local`、`addressed` 为 `direct`；
   `curl -sH 'x-orchestrator-request: 1' "$api/tickets?state=open"` 工单数不变
7. **Apply 即派工**：紧接着说「落盘 / Apply」→
   `curl -sH 'x-orchestrator-request: 1' "$api/tickets?state=open"` 新增一张 running
   工单，`GET tickets/<id>` 的 assignment 指向该需求原文；`GET decisions` 出现该
   `trigger_id` 的 `accept` 决策；全过程没有点击任何按钮
8. **重复 Apply 幂等**：对同一 `trigger_id` 再确认一次 → 工单数不变
   （`prompts/dispatch.md:46` `An accept is idempotent by trigger ID`）
9. **回声不自建单**：主会话连续注入 20 条 candidate card / notice 后 →
   `GET sources` 中 `local` 的 `filtered` / `dropped` 不出现由插件注入消息产生的
   新 Trigger，`GET tickets?state=open` 数量不变
10. **飞书可选**：`PUT settings/source:feishu` 设 `enabled: false` 并重启 →
    `GET sources` 中 feishu 为 `off` 而非 `error`，重复第 6–7 步仍成功建单
11. **prompt 可审计**：`curl -sH 'x-orchestrator-request: 1' $api/prompts` →
    `current.config` 含把「落盘确认」映射为 `orchestrator_route kind accept` 的段落，
    且仍保留「不扩写请求、不加实现计划」的约束（`prompts/dispatch.md:14`）

## Impact

- **被描述系统（prototype）**：新增 `src/sources/local.ts`（kind）、`src/app` 层一个
  `session/event` → `SourceContext.receive` 的 listener、`prompts/dispatch.md` 的 Apply
  段、`cordis.patch.yml` 的插件条目、`sourceSkills` / `SETUP_FIELDS` 对 `'local'` 的
  取舍（若采用决策 5），以及设置模板层里的 `source:local` / `policy.sources.local`
  默认值。
- **行为变化**：所有者不再需要 @ 机器人；主会话里「讨论 → 落盘确认 → 派工」三步在
  同一处完成；飞书不再是派工前置条件。
- **风险**：intake listener 的自激回声、Apply 与闲聊的区分、无 `channel` 时
  ack / attention 的投递、以及 built-in skill 硬编码 `feishu|github`。逐项缓解见
  `design.md`。
- **本仓库（prototype）**：只新增 `openspec/` 下的文档与
  `docs/notes/2026-11-15-local-dispatch-source-openspec-proposal.md`；不动 `src/`、
  不改 UI、不影响 `pnpm build` 产物。
