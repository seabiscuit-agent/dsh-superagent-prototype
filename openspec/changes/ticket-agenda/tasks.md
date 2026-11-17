## 1. 存储与时钟

- [x] 1.1 `src/app/effects.ts` 的 `enqueue` 增加可选 `at?: string`，`due = at ?? now()`；`at` 用
  `new Date(at).toISOString()` 归一化；`tests/effects.spec.ts` 增加「未来 due 不被提前取走」用例
- [x] 1.2 `EffectPayloads` 增加 `agenda: { ticketId, key, reason, at }`，`EffectKind` 自动包含；
  增加 key 构造 `agendaKey(ticketId, key) => "ticket:<id>:<key>"`
- [x] 1.3 在 runtime 注册 `agenda` handler：live 检查、等待人答复时延后（`Later`）、
  `tickets.addInput`、已结束 emit `agenda.dropped`；`limit: () => paused() ? 0 : 4`
- [x] 1.4 `src/app/notices.ts` 映射 `agenda.dropped` 为主会话 notice（ticket、key、reason、at）

## 2. Input 与投递

- [x] 2.1 `src/core/model.ts` 的 `TicketInput` 增加 `kind: "agenda"`（含 `text`、`at`）；
  `src/core/tickets.ts:15` 的 `automatic()` 对 `agenda` 返回 true
- [x] 2.2 handler 写 Input 的 id 为 `agenda:<ticketId>:<key>:<at>`，重复重试只产生一条
- [x] 2.3 验证 `assignments.report` 的 blocked/failed automatic 过滤不会丢掉 agenda：
  handler 在 attention/person Question 未答完前不写 Input；补一条回归测试
- [x] 2.4 已结束工单即使手工插入 agenda 行也不产生 Input、不 resume；测试覆盖 `stop` 后到期

## 3. 工具与可观察性

- [x] 3.1 `src/app/tools/main.ts` 增加 `orchestrator_schedule`：
  `{ ticket_id, key, at, reason, cancel? }`；校验 `notFound` / `ticketEnded` / `invalidTime` /
  `invalidReason` / `invalidKey`；`cancel: true` 用 `effects.cancel('agenda', key)`；返回
  `{scheduled, key, at}` 或 `{cancelled: true}`
- [x] 3.2 过去时刻的 `at` 不报错，下一次 Passes 扫描投递；测试用假时钟覆盖
- [x] 3.3 `agendaRows(ticketId)` 从 effect 表读未到期行；`orchestrator_read ticket/<id>` 与
  `GET tickets/<id>` 返回 `agenda: [{key, at, reason}]`；触发/取消后不再出现
- [x] 3.4 工具拒绝 worker 调用：只在 main tools 注册，worker 工具列表没有它

## 4. 测试

- [x] 4.1 新建 `tests/agenda.spec.ts`，用注入的 `now`/假时钟覆盖：
  到点前无 assignment、到点恰好一条 Input、行删除、下一次扫描无第二条
- [x] 4.2 同一 `(ticket_id, key)` 二次安排只留一行、due/理由更新、旧时刻不投递
- [x] 4.3 关闭并重开 store（或新建 runtime 指向同一 DB），跨过 due 后只投递一次
- [x] 4.4 `policy.paused` 为真时到期不投递；恢复后只投递一次
- [x] 4.5 attention/person Question 未答时到期不投递；答完后投递一次；无阻塞等待时立即投递
- [x] 4.6 `cancel` 后到点无 Input；已结束工单丢弃且 notice 只发一次
- [x] 4.7 `env -u GIT_CONFIG_GLOBAL pnpm vitest run tests/agenda.spec.ts tests/effects.spec.ts
  tests/local.spec.ts` 全绿

## 5. 提示词、文档与验收

- [x] 5.1 `prompts/` 主会话说明何时用 `orchestrator_schedule`（跨小时的 CI/发布/恢复），
  以及不要为「等人回答」排复查；控制新增字数，更新 `tests/model-surface` 预算
- [x] 5.2 写 `docs/notes/2026-11-17-openspec-p0-plan.md`（≤60 行），链接本变更并记录
  根因、机制、验证命令、回滚注意
- [x] 5.3 `pnpm check`、`openspec validate --all --strict` 通过
- [ ] 5.4 生产验收（superagent `:3082`）：排 `now+2m` 复查，等待期无 worker turn；到点唤醒；
  重启宿主后重排一次仍唤醒；把结果贴进 PR
- [x] 5.5 新会话只读本变更四件套，能复述 due 存储位置、key 规则、暂停/错过策略、取消入口
