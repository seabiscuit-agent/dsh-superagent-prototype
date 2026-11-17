## Why

superagent 没有时间维度。宿主唯一的时钟是 Passes 每 2 秒的 `setInterval`（`src/app/passes.ts:28`），
`pumpOnce()` 只做 `effects.kick()` 和 `Engine.evaluateDue()`（`:63-68`）；`evaluateDue()`
只处理已到期的 Eval、有未投递 Input 的工单和待评估的 thread（`src/core/engine.ts:75-85`），
没有「未来某刻再叫醒这张工单」的状态。

后果：

- 跨小时的 CI、发布、故障恢复无法在宿主里等待；worker 只能轮询或结束回合，轮询烧 token 和 slot。
- `docs/002-authorization.md:145` 把等待外部状态推给 Source，但 Source 只反应外部事件，不能表达
  「2 小时后再看一次」。
- `docs/006-deployment.md:133-141` 的每小时巡检只能靠外部 profile agent，宿主自己不能定时。
- 主动模式只能对进来的 Trigger 反应，不能按时间巡检。

agent-autoloop 把 cron、later、retry、lease 放进同一张 due 表按 `now` 扫描；本变更把
「未来唤醒」做成宿主的一等状态，先覆盖工单级一次性复查。cron Source 留给后续变更。

## What Changes

- Effect 队列支持未来的 `due`：`Effects.enqueue(kind, key, payload, at?)`，新增 `agenda`
  效果类型。复用 effect 表已有的持久化、`(kind, key)` 去重、2 秒扫描、重启恢复和重试，
  不新增 agenda 表。
- 新增主会话工具 `orchestrator_schedule(ticket_id, key, at, reason, cancel?)`：给一张活工单排
  一次到点复查；同一 `(ticket_id, key)` 只有一行，重复安排改时间/理由，`cancel: true` 撤销。
- `agenda` 到点后给工单追加一条 `agenda` Input（automatic），走现有 `addInput` 的
  `executor.deliver` / `executor.start` 路径；到点前不产生任何模型调用。
- 工单已结束/停止：到点丢弃并给主会话一条 notice，不 resume；暂停期间不触发，恢复后只补最近一次。
- 工单正在等待人的答复：到点不打断问题，等问题答完后投递一次。
- `orchestrator_read ticket/<id>` 与 `GET tickets/<id>` 暴露未到期的 schedule（key、at、reason）。

## Capabilities

### New Capabilities

- `ticket-agenda`: 工单级未来唤醒的持久化、去重、取消、重启恢复、暂停与错过策略。

### Modified Capabilities

无。

## 明确不做

- 不做内置 `schedule` Source（cron 行）。cron 巡检的触发语义、配置面和产品行为未定；
  本变更先把 agenda 原语交付，cron 作为它的消费者另开变更。
- 不做周期性工单，不做「补跑每一条错过」的 replay 模式；只有 `at` 一次性。
- 不改 `Passes` 的 2 秒节拍，不改 `evaluateDue()` 的既有职责。
- 不在本变更实现用量记账（review 的阶段 0）；等待期零调用用会话/日志观察验证。

## 验收标准

1. `env -u GIT_CONFIG_GLOBAL pnpm vitest run tests/agenda.spec.ts` 通过；用假时钟覆盖：
   到点前无 worker turn、到点恰好一次 Input、重启后仍触发、同 key 覆盖、取消、暂停恢复只补一次、
   等待人的工单延后、已结束工单丢弃。
2. `env -u GIT_CONFIG_GLOBAL pnpm vitest run tests/local.spec.ts` 与 `pnpm check` 通过。
3. `openspec validate --all --strict` 通过。
4. 在 superagent `:3082` 上实测：对一张活工单执行
   `orchestrator_schedule(ticket_id, "smoke", "<now+2m>", "确认 CI")`，等待期间该工单没有新的
   worker turn；到点后 worker 收到一条 `agenda` Input 并恢复；重启 `dsh-superagent` 后重复一次，
   仍能唤醒。
5. 纯文档交接：新会话只读本提案、`design.md`、本 spec 和 `tasks.md`，能复述 due 存储位置、
   key 规则、暂停/错过策略、取消入口，并按 tasks 开始实现。

## Impact

- 代码：`src/app/effects.ts`（`at`、`agenda`）、`src/core/tickets.ts`（`agenda` Input）、
  `src/core/engine.ts`（schedule 用例）、`src/app/tools/main.ts`（工具）、
  `src/app/notices.ts`（丢弃 notice）、`src/core/model.ts`（Input 类型）、
  `src/app/http.ts` / `src/app/views/tickets.ts`（只读字段）。
- 数据：复用 `effect` 表，无 schema 版本变更；`Ticket.inputs` 新增 `agenda` kind。
- 提示词：主会话增加一小段「何时排复查、何时不排」，不新增机械规则。
- 测试：`tests/agenda.spec.ts`（新）、`tests/local.spec.ts`（回归）。
- 文档：`docs/notes/2026-11-17-openspec-p0-plan.md`。
