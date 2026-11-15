# 主会话直接派单 — OpenSpec 提案落盘 — note

提案起草 Ticket: ff52ab9c2ac32a2fcac924577f75b0eb（触发 f29f6c5f8bf1fb3c198c5a4f9d78324b，Feishu）
迁仓 Ticket: df0fdc22c5fa4438852b3770edd256c7（触发 fe018e72ba5c55d97496cb4a32982b78，Feishu）
提案原落在 shipany-video-template（PR #37，c31f316），因放错仓库于 2026-11-15 迁入本仓 dsh-superagent-prototype，并从原仓撤掉。

## 问题 / 根因

- 宿主实例 `superagent :3082` 只有 GitHub / Feishu 两个 Source，开新工单必须飞书群 @ 机器人
  （`addressed: 'mention'`）。主会话（orchestrator DSH Session）里讨论需求不会变 Trigger，
  真要落盘得切通道 @ 一下再等评估。
- 缺的只是「把主会话 GUI `user/message` 接进 Engine」这一段，核心引擎已齐全：
  `src/policy.ts:197` 的 `allowed && trigger.addressed` 直达 explicit、
  `src/core/tickets.ts:55` accept 同事务启动 Executor、
  `src/app/tools/main.ts:95` `orchestrator_route kind accept` 已是主会话工具调用、
  `src/app/delivery.ts:18-24` 的 `deliveryId` 已能过滤插件自注入消息。
- 真正缺口：`session/event` 监听器只用于 retry health / delivery 去重
  （`src/app/sessions.ts:132`、`src/app/delivery.ts:34`），没有一条把它转成
  `SourceContext.receive(trigger)` 的路径；且 `src/sources` 不得 import `src/app`
  （`docs/007-architecture.md:258`）。

## 产物（本工单只做 Explore + Propose，不改运行时）

- `openspec/{config.yaml,README.md,specs/,changes/}` 骨架：被描述系统就是本仓库
  `dsh-superagent-prototype` 的实现，提案与实现同仓；本阶段只新增文档、不改运行时。
- `openspec/changes/local-dispatch-source/` 四份：proposal.md（11 条可复现验收）、
  specs/local-dispatch-source/spec.md（6 需求 / 16 场景含失败路径）、design.md（三栏现状、
  6 决策、5 Open Questions）、tasks.md（第 1 阶段已勾、第 2–4 阶段留 Apply 工单）。

## 坑

- OpenSpec CLI 1.4.1：`openspec init --tools none` 只建空目录，**不写** config.yaml/README；
  需手工补。change 名裸传给 `openspec validate <name>` 报 `Unknown item`，用 `--all --strict`。
- `#### Scenario:` 必须四个 `#`，三个 `#` 的 `### Scenario:` 被判「没有场景」；
  需求正文必须含 SHALL/MUST（SHOULD/MAY 在 delta 里被拒）；`## Purpose` < 50 字符
  在 `--strict` 下退出 1。
- 「每条消息都是候选」会撞上 `stop`、状态询问、闲聊与 candidate card JSON 注入 → 明确
  「只有对未决候选的落盘确认才 accept」，并承认会记录多条 ignore 决策。
- 无 `channel` 时 ack / `orchestrator_reply` / human_action 经 Outbox 静默丢弃（登记为
  Open Question #1，Apply 前必须定）；`eval.mode` 只管 inferred，帮不上 explicit。
- built-in skill / `SETUP_FIELDS` 硬编码 `feishu|github`，第三个 kind 不自动拿 skill
  （Open Question #2）。绝不直改运行中 `orchestrator.sqlite`（`HANDOVER-2026-11-15.md`）。

## 验证

```bash
cd /Users/seabiscuit/Documents/workspace/dsh-superagent-prototype
openspec validate --all --strict          # ✓ 1 passed, 0 failed
openspec status --change local-dispatch-source   # 4/4 artifacts complete
openspec list                            # 8/22 tasks（第 1 阶段已勾）
pnpm build                               # 纯文档，退出 0
```

## 相关

- 提案：`openspec/changes/local-dispatch-source/`（四份文档，交接即验收）
- 被描述系统现状：`~/dsh-instances/HANDOVER-2026-11-15.md:30`（新实例不继承配置）
- 格式先例 / 配置继承：`/Users/seabiscuit/src/dsh-superagent-spawner/openspec/changes/settings-template-layer/`（`source:local` 默认值并入其模板）
- 迁仓：原仓 shipany-video-template 的 `openspec/` 与同名 note 已同步撤销。
