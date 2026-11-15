# local-dispatch-source Apply：主会话消息成为派单候选

实施 `openspec/changes/local-dispatch-source/` Phase 2–3 + Open Question 结论回写。
背景与提案全文见 [2026-11-15-local-dispatch-source-openspec-proposal.md](./2026-11-15-local-dispatch-source-openspec-proposal.md)。

## 根因（为什么以前做不到）

主会话 GUI 里人发的消息只存在于 DSH Session 事件流里，没有任何 Source 把它转成
Engine 的 `Trigger`，因此永远进不了 policy gate / Eval / 工单流程；旧路径必须 @ 机器人
（Feishu）或走 GitHub。生产数据（`~/.dsh/sessions/…orchestrator-*/session.v4.jsonl.zstd`）
证实 GUI 人消息的 source 形如 `{kind:'user', rpcId, clientTimeZone}`，不含登录身份字段。

## 改动

- `src/sources/local.ts`（新增）：`localKind`（kind `local`，policy `allowed` 首位 +
  `explicit`，health `['local']`）+ no-op `channel.send → 'sent'`；插件入口
  `dsh-superagent-local`（`inject ['orchestrator']`，`apply` 里 `ctx.effect` 注册）。
  `ownerTrigger()` 把 `UserMessage` 转成确定性 Trigger：`id=key('local', messageId)`、
  `addressed:'direct'`、`actor {source:'local', id:'owner'}`、thread `local:<masterId>`。
- `src/app/runtime.ts`：构造期订阅 `session/event`；`ingestLocal()` 只认 masterId 会话、
  `source.kind==='user'`、`quiet===0`、已注册 local kind，经 `this.receive()` 入域（同步
  Engine.receive + 异步 pass，无重入等待）。`presetLocalOwner()` 仅在
  `policy.sources.local === undefined` 时预置 `{id:'owner',name:'Owner'}`（保留事后清空）。
- `prompts/dispatch.md`：Apply→accept 段——「落盘/Apply」绑定当前未决显式候选的
  `trigger_id`，title/worktree_name/acknowledgement 从原候选合成，不扩写需求；多候选
  关联规则（引用优先→唯一未决→询问）；确认词不解除 hold、重复确认幂等。
- 打包：`cordis.patch.yml` 插入 `dsh-superagent-local`、`package.json` exports
  `./local-watch`、`tsdown.config.ts` 条目（镜像 github-watch 的接法）。
- `design.md`：OQ#1–#5 全部写入「Apply 结论（已定）」。

## 关键坑

- **回写通道必须存在**：`src/core/replies.ts:55` 的 `ackNoChannel` 在 `takeUp` 之前抛出，
  channel-less 会让 worker 必调的 `orchestrator_ack` 每次报错。no-op channel 让回执落
  `'sent'`、`takeUp` 记录 `acked`，零 core 改动；ack 文本经主会话自身的回复到达人。
- **Eval 按 thread 串行**：`queueForEval`（`src/core/part.ts:57`）推入 primary thread 的
  pending；`Passes.receive → pumpOnce` 同步跑到 `evaluateDue`，第一条消息的 Eval 会在第
  二条存库前开启，此后 thread 持有 open eval，第二条只能 pending 等待——测试断言要按
  「一次一张卡」写。
- `store.threads.describe` 在 thread 行不存在时是 no-op（首次 Intake 存 trigger 才建行），
  thread label 要放在 receive 成功之后。
- 插件注入（candidate card/notice，source `dsh-superagent`）与 `time-context` 等都不是
  `kind:'user'`，按 kind 过滤即可全部排除，不会形成回声候选。
- fixture 的 `take()` 发的 `session/event` 无 `time` 字段，`ownerTrigger` 对非法时间做
  `new Date()` 兜底。

## 验证

```
pnpm vitest run tests/local.spec.ts   # 11 passed
pnpm vitest run                       # 全量（见 PR 描述）
pnpm typecheck && pnpm build
```

覆盖：kind/policy 单测、插件注册、owner 预置（GET settings/sources）、GUI 消息→explicit
候选（basis `via:"addressed"`）、同 messageId 幂等（`'duplicate'`）、20 条注入零新
Trigger、他 session/quiet 过滤、accept→running 工单 + ack `'sent'` + worker
`orchestrator_ack` 复用回执、重复 accept 幂等、闲聊/hold 不建单、GET prompts 含
Apply→accept 段。
