## Why

宿主没有「按墙钟重复产生事件」的来源。唯一的时钟是 Passes 每 2 秒的 `setInterval`
（`src/app/passes.ts:28`），`pumpOnce()` 只做 `effects.kick()` 和 `engine.evaluateDue()`
（`:63-68`）；`evaluateDue()` 只处理已到期的 Eval、有未投递 Input 的工单和待评估的
thread（`src/core/engine.ts:75-85`），没有任何「到点产生一条新事件」的状态。

`ticket-agenda` 补上了工单内一次性 `at` 唤醒，但它的前提是一张**已存在**的活工单：
`orchestrator_schedule(ticket_id, key, at, reason)`，到点身份是「这张工单的一条 `agenda`
Input」。它自己明确写着「不做内置 `schedule` Source（cron 行），cron 作为 agenda 的消费者
另开变更」。于是今天缺的是**在没有任何工单时，由一个来源按时间产生一条事件**。

后果（都可观察，不是「不够好」）：

- 「每天 9 点看一次 CI」「每小时扫一次 Issue 队列」只能靠系统 crontab / launchd 拼
  `curl` 或人工点一下，宿主自己的准入表、评估、时间线、暂停语义全部被绕过。
- 主动模式只能对进来的 Trigger 反应。没有来源能按时间主动进来，所以「主动」实际上仍是
  被动的：没有窗口事件就没有动作。
- `docs/006-deployment.md:133-141` 的每小时巡检只能靠外部 profile agent 起会话，宿主自己
  不能定时。

`docs/agent-autoloop-gap-proposals.md` 第 2 块把这块登记为「定时事件源」：依赖为空，与工单内
`agenda` 互补不替代，规定只要 5 段 cron + IANA 时区、到点产生无发送者的 Trigger、只产
Trigger 不直接派工、只补最近一次错过。本变更就是它的提案。

## What Changes

- 新增内置 Source kind `schedule`：一个实例（id 固定 `schedule`）承载一组任务行，每行
  `{key, cron, timezone, title, text, enabled}`，在面板里用 `rows` 编辑。
- 5 段 cron（分 时 日 月 周）+ IANA 时区，自实现解析与 wall-clock 换算（不新增依赖）。
- 到点产生一条 Trigger 交给 `ctx.receive()`：`source = "schedule"`、`human = false`、
  `actor = {source: "schedule", id: ""}`（**无发送者**）、线程 `schedule:<key>`、
  `text` 取任务行文本、`meta = {job, due, cron, timezone}`；随后走既有
  intake → scope → admission → 评估 → 建单，与 GitHub / 飞书事件同一条链。
- 触发 id 由 `key("schedule", job, due)` 决定，同一个到期时刻最多入域一次；重复交给
  intake 的 duplicate 分支丢弃，不重复建单。
- 每个任务把 `cursor`（上次触发的到期时刻）持久化到 store；重启、暂停、来源关闭后恢复时
  **只补最近一次**错过的到期时刻，不 replay 全部。
- 到点**只产生 Trigger**：不建单、不派工、不调用模型；是否建单由现有 Policy、admission
  表与评估模式决定。
- 在 Source 面板暴露任务行编辑器、每行「下次触发时刻」，并新增 `schedule` 健康项，
  用于表达「某行 cron / 时区非法，该行不触发」与「下一次触发时刻」。

## Capabilities

### New Capabilities

- `schedule-source`: 内置定时事件源的配置面、cron 与时区计算、Trigger 产生、同一到期时刻
  去重、游标与错过策略，以及它如何被既有授权链评估。

### Modified Capabilities

无。

## 明确不做

- 不做系统 cron / launchd，不做任意 shell 或 HTTP 定时任务：本来源不执行命令、不发请求，
  只产生 Trigger。
- 不复用也不改 `agenda`：`agenda` 是工单内 Input（要求 `ticket_id` 与活工单），`schedule`
  是来源事件（可能建新单、可能根本没人接）；两者不互相调用、不共享 key 空间。
- 不做同组串行、按 subject 分道、暂停/重放/手动「立即运行」等运维面。
- 不做 replay：不补跑每一条错过的到期时刻，只补最近一次。
- 不做秒级 cron：最小粒度 1 分钟。
- 不改 `Passes` 的 2 秒节拍，不改 `evaluateDue()` 的既有职责。
- 不引入 cron 解析库（`package.json` 目前只有 `zod` 与 `proper-lockfile`）。
- 不给 `schedule` 提供回执 channel：定时触发建立的工单没有默认回话通道，这一限制写在
  design 的 Risks 里，不在本变更解决。

## 验收标准

本变更当前只交付提案（纯文档）。验收分两段：提案阶段现在就能跑，实施阶段在勾完 tasks 后跑。

1. **提案可校验**：`openspec validate schedule-source --strict` 退出 0；
   `openspec validate --all --strict` 退出 0。
2. **提案可交接**：`openspec status --change schedule-source` 显示四件套齐全；一个新会话只读
   本提案、`design.md`、`specs/schedule-source/spec.md`、`tasks.md`，能复述 5 段 cron 语义、
   cursor 存在哪、去重键、暂停与错过行为，并按 tasks 从第 1 组开始实现。
3. **纯文档边界**：本阶段 `git status --short` 只显示 `openspec/` 与 `docs/notes/` 下的改动，
   `src/`、`locale/`、`tests/`、`cordis.patch.yml` 无改动。
4. **实施：cron 单测**（未来）：`env -u GIT_CONFIG_GLOBAL pnpm vitest run tests/schedule.spec.ts`
   通过，用假时钟覆盖
   - 每分钟任务连续 3 次到期产生 3 条 Trigger，id 互不相同；
   - 停机 3 天后恢复只产生 1 条，其 `at` 为最后一档错过的到期时刻；
   - 同一到期时刻重启两次只入域一次（第二次被 duplicate 吞掉）；
   - `cron="0 9 * * *"`、`timezone="Asia/Shanghai"` 解析出的到期时刻为 `01:00Z`；
   - `cron="0 9 * * *"`、`timezone="America/New_York"` 在 DST 切换日仍是当地 9 点；
   - 非法 cron、非法时区使该行不触发，且 `schedule` 健康项为 `error` 并带出行 key；
   - `enabled=false`、来源关闭、`policy.paused` 三种情况下都不产生 Trigger。
5. **实施：回归**（未来）：`env -u GIT_CONFIG_GLOBAL pnpm check` 通过；
   `tests/sources.spec.ts`、`tests/registry.spec.ts`、`tests/bundle-patch.spec.ts` 同步更新后通过。
6. **实施：生产实测**（未来）：在 superagent `:3082` 配一行 `*/1 * * * *` 任务，观察面板
   「下次触发」随时间前进、`schedule:<key>` 线程出现 Trigger；把该任务行的 admission 格设为
   `inferred` 且 eval mode 为 `auto` 时产生工单，设为 `ignore` 时只留一条 filtered 记录、
   不建单。

## Impact

- 代码（实施阶段）：新增 `src/sources/schedule.ts`（kind、配置面、watch 循环）、
  `src/sources/schedule-cron.ts`（cron 与时区的纯函数，便于单测）；改
  `src/sources/host.ts`（新增 health code）、`src/client/locales.ts`（对应该 code 的中英文案）、
  `src/kv.ts`（新增 `KV.schedule` 游标记录）、`tsdown.config.ts`、`package.json` 的
  `exports`（`./schedule-watch`）、`cordis.patch.yml`（insert 一行）、
  `tests/bundle-patch.spec.ts`（顶层 id 顺序断言）。
- 数据：新增 `KV.schedule` 游标记录；不改 SQLite schema、不新增表。
- 授权：新增 admission row，每个任务一行（row id = 任务 key）；无发送者的 Trigger 落在
  `unlistedUnaddressed` 格，默认 `ignore`，强度恒为 `inferred`。
- 文档：`docs/007-architecture.md` 的 Modules/Tests 表登记两个新 src 文件；
  `docs/notes/2026-11-18-schedule-source-proposal.md` 记录根因、决策与验证命令。
- 提示词：无改动（触发由时间产生，不由模型发起）。
