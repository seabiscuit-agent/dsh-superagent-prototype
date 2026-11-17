# 2026-11-18 schedule-source 提案（内置定时事件源）

纯文档变更：`openspec/changes/schedule-source/`，不改 `src/`、`locale/`、`tests/`、`cordis.patch.yml`。

## 根因（为什么现在没有定时事件）

- 宿主唯一的时钟是 Passes 的 2 秒节拍 `setInterval(() => this.request(), 2000)`
  （`src/app/passes.ts:28`），`pumpOnce()` 只做 `effects.kick()` 与 `engine.evaluateDue()`
  （`:63-68`）；`evaluateDue()` 只处理已到期 Eval、有未投递 Input 的工单、待评估 thread
  （`src/core/engine.ts:85-95`）——没有「到点产生一条新事件」的状态。
- `ticket-agenda` 只做**工单内**一次性 `at` 唤醒：签名 `orchestrator_schedule(ticket_id, key, at, reason)`
  要求 `ticket_id`，到点身份是「这张工单的一条 `agenda` Input」。它自己的 proposal 明确
  「不做内置 `schedule` Source（cron 行）」，design 的 Open Questions 把「cron 复用 agenda 还是
  直接生成 Trigger」留给后续。
- 结果：「每天 9 点看 CI」只能靠系统 crontab / launchd / 外部 profile agent，绕过准入表、评估、
  时间线与暂停语义。

## 提案要点

- 新 Source kind `schedule`：一个实例承载任务行 `{key, cron, timezone, title, text, enabled}`。
- 5 段 cron + IANA 时区自实现（`src/sources/schedule-cron.ts`，纯函数，`Intl.DateTimeFormat`
  取 wall clock，因此 DST 自然正确）；不引依赖（现只有 `zod` 与 `proper-lockfile`）。
- 到点产 Trigger：`source=schedule`、`human=false`、`actor.id=''`、线程 `schedule:<key>`、
  `meta={job,due,cron,timezone}`；id 由 `key('schedule', job, due)` 决定 → 同一到期时刻幂等。
- 逐行游标进 `KV.schedule`（store key/value，不新建表，不复用 `effect` 表）。
- 只产 Trigger：不建单、不派工、不调模型；走既有 `scope → machineGate → 评估 → 建单`。
- 无发送者 → 落 `unlistedUnaddressed` 格，默认 `ignore`（`ADMISSION_DEFAULTS`），**必须显式打开**
  才可能建单。
- 错过只补最近一次：重启/暂停/来源关闭后恢复时，每个任务行最多一条。

## 关键决策

1. **直接产 Trigger，不复用 agenda**：agenda 是「已准入之后」的 Input，cron 是「准入之前」的
   来源事件；复用会让 cron 旁路 `machineGate`，且 `agenda` 的重试队列语义与「错过即错过」冲突。
2. **独立 watch 循环**（照抄 `src/sources/github.ts` 的 `watch`），睡眠到下一次到期并夹在
   `[1s, 60s]`；不塞进 `Passes`。
3. **日/周同时受限取并集**（Vixie cron 语义）——实现里最容易静默错的一条，单测必覆盖。

## 明确不做

系统 cron/launchd、任意 shell/HTTP 定时、replay 全部错过档位、秒级粒度、同组串行与手动
「立即运行」、给 `schedule` 提供回执 channel（定时建的工单没有默认回话对象，`noChannel` 会暴露）。

## 坑 / 需确认点

- **`scope()` 必须返回 `observed: true`**：`machineGate` 的第二道条件是
  `if (!scope.listened || !(trigger.addressed || scope.observed)) return {admissible: false, reason: 'not_human'}`
  （`src/policy.ts:175`）。无发送者的 Trigger 永远没有 `addressed`，所以 `observed` 是唯一放行
  条件；写成 `observed: false` 会让每条 Trigger 以 `not_human` 被过滤，来源装好即死。先例是
  `src/sources/github.ts:61` 的 CI——`observed: row !== undefined && config[OBSERVED[row]]`。
- **「每行下次触发时刻」在现有面板里没有渲染通道**：`FieldSpec` 的 `rows` 列只支持 `text` /
  `select`（`src/sources/kind.ts:22`），`SourceKind.facts` 只接收 `deployment`（`:91`），
  `settingsView` 也只传 `kind?.facts?.(setup.deployment)`（`src/app/views/settings.ts:36`）；
  来源列表只渲染 `error` / `paused` 的健康条目（`src/client/source.tsx:103`）。要显示它得先给
  面板加「配置派生只读值」的能力，别在提案里假装已有。
- `tests/bundle-patch.spec.ts:33-35` 硬断言 `cordis.patch.yml` 顶层 insert 的 id 顺序，新增插件行
  必须同步改这条断言。
- `SourcePolicyPart.schema` 每个字段必须有 default，否则 `registry.policyPart()` 在 `safeParse`
  失败回落 `schema.parse({})` 时崩。
- 新 health code 要同时改 `src/sources/host.ts` 的 `HEALTH_TEXT` 与 `src/client/locales.ts` 的
  `TEXT`（`tests/locales.spec.ts` 要求中英成对）。
- 新 src 文件要登记进 `docs/007-architecture.md` 的 Modules/Tests 表，否则 `tests/docs.spec.ts` 失败。
- 定时建的工单没有 `channel`（`create()` 只收集 `trigger.channel` 存在的来源），回复时抛
  `UserError('noChannel')`；这是已知限制，留给后续 `report_to`。
- `SourceContext` 不含 `masterId`，来源只能 `ctx.notify()` 或 `ctx.receive()`，不能直接唤醒主会话。
- **`SourceContext` 不暴露 settings/paused**：`intake.receive()` 里也没有 paused 检查，暂停只在
  `Engine.evaluateDue()`（`src/core/engine.ts:88`）、`Evals.due()`（`src/core/evals.ts:37-42`）
  与 `Tickets` 唤醒路径（`src/core/tickets.ts:264`）生效。所以「暂停期间不触发」必须靠新增
  `SourceContext.paused()`（实现见 design 决策 9），否则暂停期间照常入域、恢复后一次性评估一堆，
  与「只补最近一次」矛盾。这是一处跨模块接口变更，要与 `schedule` 同 PR 落地。

## 同批归档

`openspec archive ticket-timeline --yes`：实施 PR #21 已合并，但 `tasks.md` 的勾选框从未勾上
（归档时 0/25）。归档产物：`openspec/specs/ticket-timeline/spec.md`（9 条需求）+
`openspec/changes/archive/2026-11-17-ticket-timeline/`（目录日期由 CLI 按创建日决定）。

## 验证命令

```sh
openspec validate schedule-source --strict   # 期望：Change 'schedule-source' is valid
openspec validate --all --strict             # 期望：退出 0
openspec status --change schedule-source     # 期望：4/4 artifacts complete
openspec list                                # 期望：schedule-source 0/28 tasks
git status --short                           # 期望：仅 openspec/ 与 docs/notes/ 下改动
```

实施阶段（未来）还需 `env -u GIT_CONFIG_GLOBAL pnpm check` 与 `:3082` 生产实测，见
`openspec/changes/schedule-source/tasks.md` 第 5 组。
