# 三 P0 的 OpenSpec 承接与实施

日期：2026-11-17
变更：
- `openspec/changes/ticket-agenda/`（P0-1 时间维度）
- `openspec/changes/orchestrator-consult/`（P0-2 问题与答复）
- `openspec/changes/host-owned-mechanics/`（P0-3 机械规则下沉）

## 根因

- P0-1：系统只有 Trigger，没有「未来某个时刻唤醒工单」的一等状态；`Passes` 每 2 秒只扫
  已到期项，`evaluateDue` 只处理已 due 的 Eval/未投递 Input/待评估线程。
- P0-2：`Ticket` 只有一个 `attention`，worker 只能向人提问；人的答复只进 outbox，没有路径
  写回 worker 会话，也没有「先问 orchestrator，超授权再升级」这一层。
- P0-3：路由、回复用途、可见性、重启、成本、审查轮次等机械规则写在 60K 提示词里，靠模型
  自觉；空回合、内部载荷、重复回复只能用 turn-guard/filter 事后补。

## 实施

### P0-1 ticket-agenda（已完成）

- 复用 Effects 表的 `due` 与 `(kind,key)` 去重/重启恢复；`enqueue(kind,key,payload,at?)`
  增加可选到期时间，`agenda` payload 为 `{ticketId,key,reason,at}`，key 为
  `ticket:<ticketId>:<key>`。没有新表，不改 `Passes` tick 与 `evaluateDue`。
- 主会话工具 `orchestrator_schedule`：校验 ticket 存在且未结束、key 形态、reason 1–500、
  at 可解析；同 key 覆盖，cancel 删除；返回 `{scheduled,key,at}` 或 `{cancelled}`。
- `agendaHandler` 到点调用 `Engine.agenda`，在事务内：ticket 等待人时抛 `Later`（2 秒后重试，
  不消耗失败次数）；已结束/不存在则发 `agenda.dropped` 通知且不唤醒；否则追加一条自动
  `agenda` Input，id 含 `at` 所以重试幂等。paused 时 handler 的 `limit` 为 0，恢复后只补
  最近一次。
- `ticket/<id>` 与 `GET tickets/<id>` 增加 `agenda: [{key,at,reason}]`；不改 Ticket JSON 结构。
- 文档与提示词：`docs/007-architecture.md` 的 Glue/Modules/Tests 表；`prompts/dispatch.md`
  一行调度指引；`openspec validate` 通过。

### P0-2 orchestrator-consult（下一步）

### P0-3 host-owned-mechanics（下一步）

## 坑

- OpenSpec strict 只检查 requirement 正文的**第一行**是否含 SHALL/MUST；换行把关键词放到第二行
  会报 `must contain SHALL or MUST`。场景标题必须四个 `#`；delta 里 SHOULD/MAY 会被拒；
  `## Purpose` 至少 50 字符。
- `npx -y openspec@latest` 在本机报 "could not determine executable to run"；用已安装的
  `openspec`（1.4.1）。
- 新增源码/测试文件必须同时进 `docs/007-architecture.md` 的 Modules/Tests 表，否则
  `tests/docs.spec.ts` 失败。
- `tests/locales.spec.ts` 要求中英文占位符一致，且每个 effect kind 有 `health.<kind>`；
  `tests/model-surface.spec.ts` 的预算要随新工具调整（当前 orchestrator 63_000）。
- `tests/agenda.spec.ts` 的 fake engine 返回联合类型，`vi.fn` 的返回类型要显式标注，否则
  `mockImplementation` 触发 TS2322。

## 验证

```bash
env -u GIT_CONFIG_GLOBAL pnpm vitest run   # 67 files / 1275 tests passed
openspec validate --all --strict           # 6 passed, 0 failed
```

交接：P0-2/P0-3 的 proposal/spec/design/tasks 已合入 main；按 tasks.md 顺序实施，P0-1 的 agenda 读侧与通知可作为 P0-2 等待问题逻辑的参照。
