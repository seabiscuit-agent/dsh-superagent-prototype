# 三 P0 的 OpenSpec 承接

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

## 承接

每个 P0 一个 change，一个意图，四件套齐全；`tasks.md` 全部未勾，本阶段不改运行时代码。

- `ticket-agenda`：复用 Effects 表的 `due`/`(kind,key)` 去重/重启恢复，新增 `agenda` effect
  与 `orchestrator_schedule`，到点投递一条 `agenda` Input 唤醒工单；ended 丢弃、paused 暂停、
  同 key 覆盖、只补最近一次。cron Source 明确不做，留给后续。
- `orchestrator-consult`：`questions: Question[]` 替换单槽 attention；`question_for` 支持
  orchestrator/person；`orchestrator_answer`（带 basis）与 `orchestrator_escalate`；答复作为
  `answer` Input 回到 worker；key 去重、resolve、旧 attention 迁移、新 stage。
- `host-owned-mechanics`：`orchestrator_reply` 结构化 receipt，result/attention 正文由 host
  合成，拒绝空回合/内部载荷/重复；本地首行 `!dispatch`/`!discussion` 机械分流；提示词预算
  基线棘轮。

顺序：P0-1 可独立 → P0-2（替换 attention）→ P0-3（attention 合成依赖 Question）。测量阶段
（usage/compaction/等待时长）是 review 的阶段 0，不在本提案内。

## 坑

- OpenSpec strict 只检查 requirement 正文的**第一行**是否含 SHALL/MUST；换行把关键词放到第二行
  会报 `must contain SHALL or MUST`，必须把模态词写进首行。
- 场景标题必须四个 `#`；delta 里 SHOULD/MAY 会被拒；`## Purpose` 至少 50 字符。
- `openspec new change` 只生成 `.openspec.yaml` 和 README，其余文件要自己写。
- 纯文档变更不截图，验收必须写命令/字段/期望/实例（`:3082`）以及「新会话只读文档能否接手」。
- owner 已明确：讨论完成前只写提案，不实施、不勾任务。

## 验证

```bash
openspec validate --all --strict   # 6 passed, 0 failed
openspec list                      # 三个 change，tasks 全 0
```

交接：新会话只读每个 change 的 proposal/spec/design/tasks，能复述范围、字段、验收命令和
明确不做；实现从 tasks 的 1.1 开始，不依赖本 note。
