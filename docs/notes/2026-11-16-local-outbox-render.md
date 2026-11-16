# local 回执渲染进主会话：Outbox 侧定因与修复

背景：owner 问「local 回执只在 outbox 标 sent、不渲染回面板」是 superagent 自带还是插件
带来。定因结论：**dsh-superagent 自带缺口**（PR #4 的 local Source no-op channel），
DSH 宿主无辜——它一直提供 `Agent.inject` + ContextForm `notice` 折叠行渲染，只是从没被
调用；与其他插件（mobile/spawner/billion-context）无关。

## 根因

- `src/sources/local.ts` 的 `channel.send = async () => 'sent'`：`Outbox.deliver` 调
  `sources.send` 直接落 `'sent'`，回执结清但没有任何消息进入主会话，面板自然不显示。
- openspec 2026-11-15-local-dispatch-source 的 Apply 结论赌「ack 与结果由主会话助手回合
  呈现」，但 replies 政策又禁止编排器重复投递（transport 已"送达"）——两头都落空，
  worker 的 `orchestrator_ack` 和 `orchestrator_reply` 在 local 工单上谁都看不到。
- 生产证据（修前）：`~/.dsh/state/superagent/orchestrator.sqlite` outbox 表 6 条
  `source='local'` 回执全 `'sent'`，其文本在 `~/.dsh/sessions/…orchestrator-066e…`
  会话历史里 grep 不到。

## 改动

- `src/app/outbox.ts`：`OutboxHost` 新增必填 `renderLocal(receipt, summary)`；
  `deliver()` 在 `channelAllowed` 之后拦截 `source==='local'` 的回执，先渲染再结清
  `'sent'`，抛错走 effect 重试（与渠道失败同路）。`localSummary()` =
  `boundContextSummary("<Kind> for ticket <id>: <首行>")`。
- `src/app/runtime.ts`：接线 `renderLocal: (r, s) => sessions.prompt(masterId,
  \`local-receipt:${r.id}\`, r.text, { inject: s })`——复用 `AgentDelivery` 的
  messageId 去重（含持久化历史重扫），重启幂等。
- `src/sources/local.ts` / `prompts/dispatch.md`：注释与提示词改为如实描述
  （渲染由 Outbox 完成；ack 照旧由路由回合自述；不得重复已渲染的 reply）。

## 关键坑

- **DSH worker shell 跑全量测试**：环境带着 `GIT_CONFIG_GLOBAL` 等变量，
  `tests/runtime.spec.ts` 两条「环境恢复」断言会假失败；用
  `env -u GIT_CONFIG_GLOBAL pnpm vitest run` 复核再定论。
- `key()` 是 sha256 截断不是字符串拼接；断言注入消息 id 要用
  `sessions.promptedId(requestId)` 对称计算。
- `boundContextSummary` 从 `@deepseek-ai/dsh-llm` 根导出（120 字符截断）。
- 回声安全：注入消息 source 是 `{kind:'dsh-superagent', form:'notice'}`，
  `ingestLocal` 只认 `kind:'user'`，不会变成新候选。

## 验证

```
env -u GIT_CONFIG_GLOBAL pnpm vitest run tests/local.spec.ts tests/outbox.spec.ts tests/docs.spec.ts tests/tools.spec.ts  # 47 passed
pnpm typecheck && pnpm build
scripts/dsh-superagent --profile superagent restart   # 生产加载（见 docs/evidence/a0f45f4ab36c6d49a2c4fd0801b6f57e/）
```

覆盖：accept ack 渲染为主会话 notice 行（summary 全文断言）、result reply 渲染、
主会话缺席时回执等待、会话回来后 5s 重试渲染、worker ack 复用回执、重复 accept 幂等。
