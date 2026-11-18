# schedule-source 实施：定时事件源

日期：2026-11-18；变更目录：`openspec/changes/schedule-source/`；提案 PR #22。
新增 `src/sources/schedule.ts`（Source kind、watch 循环、准入行）与 `src/sources/schedule-cron.ts`
（5 段 cron + IANA 时区，纯函数）；`src/sources/host.ts`/`src/app/source-context.ts`/
`src/app/runtime.ts` 增加 `paused()` 转接；`src/kv.ts` 增加 `schedule-cursor:<key>`。

## 游标落点

- 首次见到一行：游标取「当前时刻之前最近一档 due」，不产 Trigger；因此安装/新增行不会补历史。
- 之后只补最近一档：停机三天后重启也只发最后一档，不会把每个错过时刻都灌进收件箱。
- `ctx.receive(trigger)` 与游标推进在同一个 `ctx.atomic()` 里；失败则游标不动，下一轮重试同一 due，
  因 Trigger id 相同而走 duplicate，不会重复建单（若已跨过下一档，则按「只补最近一档」处理）。
- `ctx.paused()` 为真时既不产 Trigger 也不推进游标；恢复后同样只补最近一档。`intake.receive()`
  没有 paused 检查，必须在 Source 侧拦，否则暂停期间会积压一批。

## DST 坑

- 用 `Intl.DateTimeFormat`（`hourCycle: 'h23'`）逐分钟走本地墙钟，步长最多 60 分钟：秋季回拨
  重复的墙钟分钟会被走两遍（两个 offset 各到期一次），春季跳过的分钟永远不会被当成 due。
- 周几从本地年月日推出（`Date.UTC` 后 `getUTCDay()`），不要用实例的 `getDay()`，否则跨时区错一天。
- 跨午夜不能按固定 60 分钟跳：从 23:30 跳会落到 00:30，漏掉刚跨日那天的 00:00；步长必须取
  `60 - minute` 落到下一个整点。回归用例在 `tests/schedule-cron.spec.ts` 的「does not skip midnight」。
- 日/周同时受限取并集（Vixie 语义），`0 0 * * 0,7` 的 7 归一到 0 并去重。

## 校验分两层

- Schema 层只校验 key/非空字符串/唯一性；cron 与时区在每轮 watch 里逐行 `parseCron`/构造
  formatter，失败只把该行记成 `scheduleJobInvalid` 并点名 key，其它行继续跑。
- `enabled` 必须是 `z.enum(['true','false'])`：行编辑器的 `select` 只产出字符串，`z.boolean()`
  会让每次保存都解析失败。`title` 必须放第二列，否则行折叠摘要拿不到可见名字。

## admission 默认值

- `policy.rows()` 只列启用行，cell 仅 `unlistedUnaddressed: true`；默认 `ignore`，所以装上后
  不建单，只有操作者把该格改为 `inferred` 才开始接单。

## 验证命令

- `env -u GIT_CONFIG_GLOBAL pnpm check`（tsc + vitest 全量 + tsdown，产出 `lib/schedule-watch.js`）
- `openspec validate --all --strict`
- 一次性 profile（端口 3101，stateDir `/tmp/schedule-after-state`）连跑 `* * * * *` 行；
  `sqlite3 ... "select at from trigger where value like '%\"source\":\"schedule\"%'"` 确认停机 5 分钟后
  只补最近一档（03:35），03:31–03:34 没有行。
- 面板「来源」卡片：健康项 error 点名 `broken-row`；「设置→来源」的任务行可增删改。

## 坑

- 从 `src/core/index.ts` 导入 `key()` 会经过 orchestrator 的循环依赖；`schedule-cron.ts` 保持
  无依赖纯函数，`schedule.ts` 只依赖 `host.ts` 与 `kv.ts`。
- `ctx.receive()` 是同步契约，返回 Promise 视为装配错误并显式报错，避免静默丢事件。
