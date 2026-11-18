## 1. cron 与时区内核（纯函数）

- [x] 1.1 新建 `src/sources/schedule-cron.ts`：`parseCron(expr)` 解析 5 段（`*`、`a`、`a-b`、`*/s`、`a-b/s`、`a,b`、月份/周英文缩写），对 6 段、`@daily`、`L`、`#`、`?` 抛 `Error`
- [x] 1.2 同文件实现 `nextDue(spec, timezone, after: Date): Date | undefined`：用 `Intl.DateTimeFormat` 取目标时区的年月日时分，逐分钟前进，上限 5 年
- [x] 1.3 日与周同时受限时取并集（Vixie cron 语义），在代码注释里写清楚
- [x] 1.4 新建 `tests/schedule-cron.spec.ts`：`0 9 * * *` + `Asia/Shanghai` → `01:00Z`；`0 9 * * *` + `America/New_York` 跨 DST 两日各一次；`*/15 * * * *` 的连续三次；日/周并集用例；非法语法逐条抛错；找不到时返回 `undefined`

## 2. Source kind 与配置面

- [x] 2.1 新建 `src/sources/schedule.ts`：`SOURCE = 'schedule'`、`ScheduleConfigSchema`（`jobs: JobRow[]`，`JobRow = {key, cron, timezone, title, text, enabled: z.enum(['true','false']).default('true')}`，key 正则 + 同配置唯一性 refine；`enabled` 用字符串而不是 `z.boolean()`，因为行编辑器的 `select` 列只能产出字符串，`z.boolean()` 会让每次保存都解析失败）。**cron 与时区不在这里校验**（只要求非空字符串）：它们是逐行属性，放在 schema 里会让一行笔误禁用整个来源，见 spec 第 1 条的「校验分两层」
- [x] 2.2 `fields`：一个 `rows` 字段，列依次为 `key`（`text` + `pattern`）、`title`（`text`）、`cron`（`text`）、`timezone`（`text`）、`text`（`text`）、`enabled`（`select`，options 为 `"true"` / `"false"`）——`FieldSpec` 的 rows 列只支持 `text` 与 `select`；`RowsField` 只有在**第二列是 `text`** 时才拿它当行的可见名字（`src/client/settings-kit.tsx` 的 `named`），超过 `ROWS_SHOWN = 6` 行时折叠摘要就靠它，所以 `title` 必须排第二
- [x] 2.3 `scope`：`meta.job` 命中配置里某个启用行时返回 `{listened: true, observed: true, row: job}`，否则 `{listened: true, observed: false}`——**`observed` 必须为真**，否则 `machineGate` 的第二道条件（`src/policy.ts:175`）会因为没有 `addressed` 而拒绝每一条 Trigger；`health: ['schedule']`
- [x] 2.4 `policy`：`schema`（`allowed` 默认空数组、`bots` 默认空数组，每字段带 default）；`rows(config)` 为每个启用行返回 `{id: key, label: title, note: "cron (timezone)", cells: {listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: true}}`
- [x] 2.5 不实现 `channel`、`threadContext`、`find`、`repliesTo`（设计决策 7）；`facts()` 只拿得到 `deployment`、拿不到配置，因此省略或只放与配置无关的常量事实，不要试图用它显示每行状态

## 3. watch 循环与游标

- [x] 3.1 `watch(ctx, signal)`：`await ctx.ready` → `!ctx.configured()` 报 `health('paused','setupPending')` 并返回 → 循环内先判 `ctx.paused()`（真则 `pause(60000, signal)` 后 continue，不产 Trigger、不推进游标）→ 否则算最近到期、`pause(clamp(wait, 1000, 60000), signal)`、再逐行处理
- [x] 3.2 `src/kv.ts` 新增 `KV.schedule = { cursor: family<{due: string, triggerId: string}, [job: string]>('schedule-cursor:') }`
- [x] 3.3 首次见到某行：游标初始化为「当前时刻之前最近的一档到期时刻」，不产生 Trigger
- [x] 3.4 到期处理：`trigger = {id: key('schedule', job, due), source, threads: [{source, id: job}], actor: {source, id: ''}, human: false, at: due, text, meta: {job, due, cron, timezone}}` → `ctx.receive(trigger)` → 在同一个 `ctx.atomic()` 里推进游标
- [x] 3.5 每行 `parseCron` / 时区解析 / `nextDue` 失败时 `ctx.report('schedule', health('error', '<新 code>', {job, error}))` 并跳过该行，不影响其它行；健康项 detail 必须带出该行 `key`
- [x] 3.6 成功时 `ctx.report('schedule', {state: 'ready', detail: '<n> jobs; next <ISO>', at})`
- [x] 3.7 `apply()`：`ctx.effect(() => ctx.orchestrator.sources.register(kind))` + AbortController 包裹的 watch，`.catch(error => source.report('schedule', {state: 'error', detail: String(error)}))`

## 4. 装配与本地化

- [x] 4.1 `tsdown.config.ts` 第一组 entry 加 `'schedule-watch': 'src/sources/schedule.ts'`
- [x] 4.2 `package.json` exports 加 `"./schedule-watch": "./lib/schedule-watch.js"`
- [x] 4.3 `cordis.patch.yml` 在 `dsh-superagent-local` 之后插入 `dsh-superagent-schedule`（`disabled: true`），并同步改 `tests/bundle-patch.spec.ts:33-35` 的顺序断言
- [x] 4.4 `src/sources/host.ts`：`SourceContext` 加 `paused(): boolean`，`HEALTH_TEXT` 加新 code（如 `scheduleJobInvalid`）；`src/app/source-context.ts` 的 `SourceContextDeps` 加并转接 `paused()`；`src/app/runtime.ts` 的 `sourceDeps` 传 `paused: () => runtime.paused()`（与 `:388` 同口径）；`tests/sources.spec.ts` 的 `host()` 与 `tests/registry.spec.ts` 的假 deps 补默认 `paused: () => false`；`src/client/locales.ts` 的 `TEXT` 表加对应中英文（`tests/locales.spec.ts` 要求成对）
- [x] 4.5 面板 Source 卡片验证：任务行可增删改；非法行使来源列表的 `schedule` 健康项变 `error` 并点名该行（**不**在行编辑器里显示下次触发时刻——现有面板无此通道，见 spec「触发与状态可观察」）

## 5. 测试与验收

- [x] 5.1 新建 `tests/schedule.spec.ts`（假时钟）：每分钟任务连续 3 次到期产 3 条 Trigger 且 id 互异；停机三天只补 1 条且 `at` 为最后一档；同一 due 重启两次只入域一次；该行 `enabled: "false"` / 来源关闭 / `ctx.paused()` 为真三种情况都不产 Trigger，且暂停期间游标不前进
- [x] 5.2 准入用例：默认 `ignore` 时不建单且 reason 为 `admission_ignored`；改为 `inferred` + `auto` 且规则命中时建单，mandate strength 为 `inferred`、cell 为 `unlistedUnaddressed`
- [x] 5.3 `env -u GIT_CONFIG_GLOBAL pnpm check` 通过；`tests/sources.spec.ts`、`tests/registry.spec.ts` 的相关断言同步更新
- [x] 5.4 `openspec validate --all --strict` 通过
- [x] 5.5 `docs/007-architecture.md` 的 Modules/Tests 表登记 `src/sources/schedule.ts` 与 `src/sources/schedule-cron.ts`，否则 `tests/docs.spec.ts` 失败
- [x] 5.6 生产实例 `:3082` 实测：配 `*/1 * * * *`，观察 `schedule:<key>` 线程随时间出现 Trigger（`at` 对齐到期时刻）；把 cron 改坏后确认来源列表健康项变 `error` 并点名该行；改准入后再观察建单；`pkill` 宿主后重启，确认只补一次
  - 实施说明：本机没有 `:3082` 实例，改用一次性 profile（`:3099`/`:3101`）验证；每分钟 Trigger、坏行 error、停机后只补最近一档均已实测。改准入建单由 `tests/schedule.spec.ts` 覆盖，live 路径会调用真实模型、需要费用授权，未在验证实例上执行。
- [x] 5.7 写 `docs/notes/2026-11-18-schedule-source-implementation.md`（实施阶段），记录游标落点、DST 坑、admission 默认值、验证命令
