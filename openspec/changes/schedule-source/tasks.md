## 1. cron 与时区内核（纯函数）

- [ ] 1.1 新建 `src/sources/schedule-cron.ts`：`parseCron(expr)` 解析 5 段（`*`、`a`、`a-b`、`*/s`、`a-b/s`、`a,b`、月份/周英文缩写），对 6 段、`@daily`、`L`、`#`、`?` 抛 `Error`
- [ ] 1.2 同文件实现 `nextDue(spec, timezone, after: Date): Date | undefined`：用 `Intl.DateTimeFormat` 取目标时区的年月日时分，逐分钟前进，上限 5 年
- [ ] 1.3 日与周同时受限时取并集（Vixie cron 语义），在代码注释里写清楚
- [ ] 1.4 新建 `tests/schedule-cron.spec.ts`：`0 9 * * *` + `Asia/Shanghai` → `01:00Z`；`0 9 * * *` + `America/New_York` 跨 DST 两日各一次；`*/15 * * * *` 的连续三次；日/周并集用例；非法语法逐条抛错；找不到时返回 `undefined`

## 2. Source kind 与配置面

- [ ] 2.1 新建 `src/sources/schedule.ts`：`SOURCE = 'schedule'`、`ScheduleConfigSchema`（`jobs: JobRow[]`，`JobRow = {key, cron, timezone, title, text, enabled}`，key 正则 + 同配置唯一性 refine）
- [ ] 2.2 `fields`：一个 `rows` 字段，列依次为 `key`（`text` + `pattern`）、`cron`（`text`）、`timezone`（`text`）、`title`（`text`）、`text`（`text`）、`enabled`（`select`，options 为 `true` / `false`）——`FieldSpec` 的 rows 列只支持 `text` 与 `select`
- [ ] 2.3 `scope`：`meta.job` 命中配置里某个启用行时返回 `{listened: true, observed: true, row: job}`，否则 `{listened: true, observed: false}`——**`observed` 必须为真**，否则 `machineGate` 的第二道条件（`src/policy.ts:175`）会因为没有 `addressed` 而拒绝每一条 Trigger；`health: ['schedule']`
- [ ] 2.4 `policy`：`schema`（`allowed` 默认空数组、`bots` 默认空数组，每字段带 default）；`rows(config)` 为每个启用行返回 `{id: key, label: title, note: "cron (timezone)", cells: {listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: true}}`
- [ ] 2.5 不实现 `channel`、`threadContext`、`find`、`repliesTo`（设计决策 7）；`facts()` 返回已启用行数与最近一次的下次触发时刻供面板显示

## 3. watch 循环与游标

- [ ] 3.1 `watch(ctx, signal)`：`await ctx.ready` → `!ctx.configured()` 报 `health('paused','setupPending')` 并返回 → 循环内先算最近到期、`pause(clamp(wait, 1000, 60000), signal)`、再逐行处理
- [ ] 3.2 `src/kv.ts` 新增 `KV.schedule = { cursor: family<{due: string, triggerId: string}, [job: string]>('schedule-cursor:') }`
- [ ] 3.3 首次见到某行：游标初始化为「当前时刻之前最近的一档到期时刻」，不产生 Trigger
- [ ] 3.4 到期处理：`trigger = {id: key('schedule', job, due), source, threads: [{source, id: job}], actor: {source, id: ''}, human: false, at: due, text, meta: {job, due, cron, timezone}}` → `ctx.receive(trigger)` → 在同一个 `ctx.atomic()` 里推进游标
- [ ] 3.5 每行 parse/nextDue 失败时 `ctx.report('schedule', health('error','…', {job, error}))` 并跳过该行，不影响其它行
- [ ] 3.6 成功时 `ctx.report('schedule', {state: 'ready', detail: '<n> jobs; next <ISO>', at})`
- [ ] 3.7 `apply()`：`ctx.effect(() => ctx.orchestrator.sources.register(kind))` + AbortController 包裹的 watch，`.catch(error => source.report('schedule', {state: 'error', detail: String(error)}))`

## 4. 装配与本地化

- [ ] 4.1 `tsdown.config.ts` 第一组 entry 加 `'schedule-watch': 'src/sources/schedule.ts'`
- [ ] 4.2 `package.json` exports 加 `"./schedule-watch": "./lib/schedule-watch.js"`
- [ ] 4.3 `cordis.patch.yml` 在 `dsh-superagent-local` 之后插入 `dsh-superagent-schedule`（`disabled: true`），并同步改 `tests/bundle-patch.spec.ts:33-35` 的顺序断言
- [ ] 4.4 `src/sources/host.ts` 的 `HEALTH_TEXT` 加新 code（如 `scheduleJobInvalid`），`src/client/locales.ts` 的 `TEXT` 表加对应中英文（`tests/locales.spec.ts` 要求成对）
- [ ] 4.5 面板 Source 卡片验证：任务行可增删改、显示下次触发时刻、非法行显示错误

## 5. 测试与验收

- [ ] 5.1 新建 `tests/schedule.spec.ts`（假时钟）：每分钟任务连续 3 次到期产 3 条 Trigger 且 id 互异；停机三天只补 1 条且 `at` 为最后一档；同一 due 重启两次只入域一次；`enabled=false` / 来源关闭 / `policy.paused` 三种情况都不产 Trigger
- [ ] 5.2 准入用例：默认 `ignore` 时不建单且 reason 为 `admission_ignored`；改为 `inferred` + `auto` 且规则命中时建单，mandate strength 为 `inferred`、cell 为 `unlistedUnaddressed`
- [ ] 5.3 `env -u GIT_CONFIG_GLOBAL pnpm check` 通过；`tests/sources.spec.ts`、`tests/registry.spec.ts` 的相关断言同步更新
- [ ] 5.4 `openspec validate --all --strict` 通过
- [ ] 5.5 `docs/007-architecture.md` 的 Modules/Tests 表登记 `src/sources/schedule.ts` 与 `src/sources/schedule-cron.ts`，否则 `tests/docs.spec.ts` 失败
- [ ] 5.6 生产实例 `:3082` 实测：配 `*/1 * * * *`，观察下次触发随时间前进与会话线程出现 Trigger；改准入后再观察建单；`pkill` 宿主后重启，确认只补一次
- [ ] 5.7 写 `docs/notes/2026-11-18-schedule-source-implementation.md`（实施阶段），记录游标落点、DST 坑、admission 默认值、验证命令
