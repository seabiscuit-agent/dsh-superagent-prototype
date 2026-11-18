# 2026-11-18 schedule-source 提案（内置定时事件源）

纯文档：`openspec/changes/schedule-source/`，不改 `src/`、`locale/`、`tests/`、`cordis.patch.yml`。
相关：[proposal.md](../../openspec/changes/schedule-source/proposal.md)、[design.md](../../openspec/changes/schedule-source/design.md)、
[spec.md](../../openspec/changes/schedule-source/specs/schedule-source/spec.md)、[tasks.md](../../openspec/changes/schedule-source/tasks.md)。

## 根因：宿主没有「按墙钟产生事件」的来源

- 唯一时钟是 Passes 的 2 秒节拍 `setInterval(() => this.request(), 2000)`（`src/app/passes.ts:28`），
  `pumpOnce()` 只做 `effects.kick()` 与 `engine.evaluateDue()`（`:63-68`）；`evaluateDue()` 只处理已到期
  Eval、有未投递 Input 的工单、待评估 thread（`src/core/engine.ts:85-95`）。
- `ticket-agenda` 只做**工单内**一次性唤醒，要求 `ticket_id` 与活工单；它自己的 proposal 明确「不做内置
  `schedule` Source」，design 的 Open Questions 把「cron 复用 agenda 还是直接产 Trigger」留给后续。
- 后果：「每天 9 点看 CI」只能靠系统 crontab，绕过准入表、评估、时间线与暂停语义。

## 提案要点

- 新 Source kind `schedule`：任务行 `{key, cron, timezone, title, text, enabled}`，5 段 cron + IANA 时区
  自实现（`src/sources/schedule-cron.ts`，`Intl.DateTimeFormat` 取 wall clock，DST 自然正确），不引依赖。
- 到点产 Trigger（`human=false`、`actor.id=''`、线程 `schedule:<key>`），id = `key('schedule', job, due)`；
  只产 Trigger，不建单不派工；逐行游标进 `KV.schedule`，重启/暂停后只补最近一次。
- **直接产 Trigger，不复用 agenda**：agenda 是准入之后的 Input，cron 是准入之前的来源事件；effect 队列的
  重试语义与「错过即错过」冲突。
- 无发送者 → 落 `unlistedUnaddressed` 格，默认 `ignore`，必须显式打开才可能建单。

## 坑 / 需确认点（逐条对照源码才发现，均已写进提案）

- **`scope()` 必须 `observed: true`**：`machineGate` 的第二道条件是
  `if (!scope.listened || !(trigger.addressed || scope.observed)) return {admissible: false, reason: 'not_human'}`
  （`src/policy.ts:175`）。无发送者永远没有 `addressed`，写成 `observed: false` 会让来源装好即死。先例：
  `src/sources/github.ts:61` 的 CI 行。
- **校验必须分两层**：cron/时区放进 `SourceKind.schema` 会让 `SourceRegistry.resolve()` 把**整个实例**置
  `enabled: false`，一行笔误静默停掉所有任务。语法与时区改在 watch 里按行求值。
- **`enabled` 用字符串 `"true"`/`"false"`**：`rows` 的 `select` 列只产出字符串，`z.boolean()` 会让每次保存
  都解析失败、整实例 disabled。
- **不给面板的「每行下次触发时刻」打包票**：`FieldSpec.rows` 只有 `text`/`select`（`src/sources/kind.ts:22`），
  `facts()` 只拿到 `deployment`（`:91`、`src/app/views/settings.ts:36`），来源列表只渲染 `error`/`paused`
  （`src/client/source.tsx:103`）。
- **暂停语义要新增 `SourceContext.paused()`**：来源侧拿不到 settings，`intake.receive()` 也没有 paused 检查。
  `src/app/runtime.ts:389` 的「sources still record incoming triggers」针对外部推来的消息；时钟事件可重算，
  暂停期间不产 Trigger 是那条规则的例外。
- **「被准入拒绝」不是 filtered**：`machineGate` 拒绝落成 `ignore` 决策（`src/core/evals.ts:97`）；
  `disposition.filtered` 只在 `scope()` 返回 `listened: false` 时写。
- 其它：`tests/bundle-patch.spec.ts:33-35` 的 insert 顺序断言；policy schema 每字段要 default；新 health code
  要同时改 `src/sources/host.ts` 与 `src/client/locales.ts`；新 src 文件要登记 `docs/007-architecture.md`；
  定时建的工单没有 channel（`noChannel`）。

## 同批归档

`openspec archive ticket-timeline --yes`（实施 PR #21 已合并但 tasks 从未勾选，归档时 0/25）→
`openspec/specs/ticket-timeline/spec.md` + `openspec/changes/archive/2026-11-17-ticket-timeline/`。

## 验证命令

```sh
openspec validate --all --strict            # 8 passed, 0 failed
openspec status --change schedule-source    # 4/4 artifacts complete
git status --short                          # 只有 openspec/ 与 docs/notes/
env -u GIT_CONFIG_GLOBAL pnpm check         # 提案阶段也跑，确认纯文档没碰坏构建
```
