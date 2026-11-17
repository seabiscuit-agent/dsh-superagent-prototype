# 三 P0 的 OpenSpec 实施

日期：2026-11-17；变更：`ticket-agenda`（P0-1）、`orchestrator-consult`（P0-2）、
`host-owned-mechanics`（P0-3）。

## 根因

- P0-1：只有 Trigger，没有「未来某刻唤醒工单」的一等状态；`Passes` 每 2 秒只扫已到期项。
- P0-2：`Ticket` 只有一个 `attention`，worker 只能问人；人的答复没有路径写回 worker，也没有
  「先问 orchestrator，超授权再升级」这一层。
- P0-3：路由、回复用途、可见性、重启、成本、审查轮次等机械规则写在 60K 提示词里，靠模型自觉。

## 实施

### P0-1 ticket-agenda（已完成）

- 复用 Effects 的 `due` 与 `(kind,key)`：`enqueue(...,at?)`、`agenda` payload
  `{ticketId,key,reason,at}`、key `ticket:<id>:<key>`；不改 `Passes` tick 与 `evaluateDue`。
- 主会话工具 `orchestrator_schedule`：校验 ticket/key/reason/at，同 key 覆盖，cancel 删除。
- `agendaHandler` 到点调 `Engine.agenda`：等待人抛 `Later`（2 秒重试，不消耗失败次数）；
  已结束发 `agenda.dropped` 且不唤醒；否则追加幂等的 `agenda` Input；paused 时 limit=0。
- `ticket/<id>` 与 `GET tickets/<id>` 增加 `agenda: [{key,at,reason}]`；Ticket JSON 不变。

### P0-2 orchestrator-consult（已完成）

- `Ticket.questions` 取代 `attention`；旧 attention 读取时迁移为一条 `to:person` 问题并保留 id。
  问题默认问人，`question_for:'orchestrator'` 先问主会话；`state=blocked` 才 blocking；同 key
  更新，`null` 撤回，ready 结掉本 assignment 的问题。
- `orchestrator_answer` 带 basis 回答并投递 `question-answer:<id>` answer Input，不写 outbox；
  `orchestrator_escalate` 升级为人的问题并记录理由；人答复后 `purpose=answer` 发送成功，
  outbox 的 `questionId` 回调写回 worker；`orchestrator_resolve` 只允许提问的 assignment。
- stage 增加 `orchestrator/answer`，person blocking 优先；卡片/详情/面板/read 显示 questions。
- 与 spec 偏差：spec 说 attention 发送成功即写回答复，但 attention 正文是问题，实现改在
  `purpose=answer` 成功后写回，PR 中说明。

### P0-3 host-owned-mechanics（已完成）

- `src/app/receipts.ts`：result 正文由最新 report 合成（状态标签、summary、PR 链接），attention
  由 Question 合成；answer 保留模型文本但拒绝空/静默/内部载荷/超长；确定性 id
  `result:<ticket>:<report.at>`、`attention-reply:<qid>`、`reply:<trigger>:<sha1>`。
- `orchestrator_reply` 只收结构化字段，返回 `{receipt_id,status,reason?}`；拒绝时不入 outbox；
  sent 后 `concludeTurn()`。`TurnGuard` 回合结束对有 ready report 或 person 问题但无 receipt 的
  回合发一次兜底 receipt，绝不自造 orchestrator 答案。
- 本地 Source 首行前缀：`!dispatch` 机械 accept（不跑 assessor）、`!discussion` 永不建单、
  `!!` 转义；确认语取本地 Source `language`（zh/en），缺失/失败回退主会话；发
  `dispatch.fast_path` 事件。
- `tests/model-surface.baseline.json` 按 surface 记录长度；超过即失败，只能删文本或手动更新。

## 坑

- OpenSpec strict 只检查 requirement 正文**第一行**的 SHALL/MUST；场景标题四个 `#`；delta 里
  SHOULD/MAY 会被拒；`## Purpose` 至少 50 字符。
- `npx -y openspec@latest` 报 "could not determine executable to run"；用已安装的 `openspec` 1.4.1。
- 新增源码/测试文件必须进 `docs/007-architecture.md` 的 Modules/Tests 表。
- `tests/locales.spec.ts` 要求中英文占位符一致，每个 effect kind 有 `health.<kind>`；
  `model-surface` 预算随工具调整（当前 orchestrator 66_000 / worker 43_000）。
- agenda fake engine 返回联合类型时，`vi.fn` 的返回类型要显式标注，否则 TS2322。

## 验证

```bash
env -u GIT_CONFIG_GLOBAL pnpm vitest run   # 69 files / 1295 tests passed
pnpm check
openspec validate --all --strict           # 6 passed, 0 failed
```

交接：三个 proposal/spec/design/tasks 已在 main；按 tasks.md 顺序实施。
