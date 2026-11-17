# 主会话空回合不回复 / 同一问题分两次作答：运行层修复

## 现象
主会话收到 worker_report 或 worker_attention 后，回合正常结束，但 owner 看不到任何文本：回执通知行注入后模型只写了 `NO_REPLY`（面板会过滤），回合随之结束。另一种形态是 `orchestrator_reply` 发完回执后，模型又在正文里转述一遍，同一条答案出现两次。

## 根因
- 本地 Source 没有独立外发通道：回执是注入到主会话的 notice 行。模型只调用了 `orchestrator_reply` 工具、没有再产出 assistant 文本，回合就没有任何可见输出。
- reply 工具当时不结束回合，模型在同一回合里可以再用正文复述答案，形成两条可见消息。

## 修复
1. `src/app/tools/main.ts`（`orchestrator_reply`）：回执确认送达（`status === 'sent'`）后调用 DSH 的 `ToolRunContext.concludeTurn()`，该步即结束回合，模型无法再追加重复或转述正文；`pending` 不结束（owner 此时还没看到）。
2. `src/app/turn-guard.ts`：主会话 `agent/turn-stopping` 守卫。用 `session.snapshotEvents()` 取当前 turn 窗口，判定
   - owed：窗口内有 `worker_report` / `worker_attention` 中继；
   - addressed：有可见 assistant 文本，或已有 `local-receipt:` 回执消息；
   - nudged：本回合已补过一句话。
   owed 且未 addressed 且未 nudged 时，steer 一条 `Turn check` 指令，要求一句话说清现状与下一步，或直接把问题问出来。`follow_up` / `candidate` 中继不算 owed（那是 worker 决策，沉默合法）。
3. 配套：`Sessions.renderReceipt` 用字面 `local-receipt:<receiptId>` 作为回执消息 id（不经 `prompt` 的哈希），守卫才认得出"这回合已经给过 owner 回执"；`Tool.execute` 增加第三参 `ToolTurn { concludeTurn() }`，由 `Sessions.registerTool` 透传。

## 坑
- `Sessions.prompt` 会对 requestId 做 sha256（`key()`），回执若走 `prompt`，消息 id 就不是 `dsh-superagent:local-receipt:` 前缀，守卫会误判为未回复并紧跟着再催一句。
- `concludeTurn` 不会撤销已排队的 steering 或 additionalContexts，守卫的 nudge 须自己保证一回合最多一次。
- 空回合标记 `NO_REPLY` 在面板被过滤，测试里不能用 assistant 文本里的哨兵来模拟"owner 看不见"。
- 本机 shell 会导出 `GIT_CONFIG_GLOBAL`（实例的 worker-gitconfig），两个 setup 测试会因此误报；用 `env -u GIT_CONFIG_GLOBAL pnpm check`。

## 验证
- 事故会话回放（`/tmp/main-session.jsonl`，2026-11-17 那次）：turn 150 `owed=true, addressed=false`（守卫会补一句话），turn 151/152 已 addressed 不打扰，turn 153 `owed=true, addressed=false` 与 owner 感知的"worker 跑完没回复"一致。
- `env -u GIT_CONFIG_GLOBAL pnpm check`（typecheck + vitest + tsdown build）
- 新增 `tests/turn-guard.spec.ts`：owed/addressed/回执/只催一次/非主会话/每回合窗口/follow_up 与 candidate 保持沉默。
- `tests/runtime.spec.ts` e2e：`keeps a master turn that owes the owner a word from closing silently after a worker report`；reply 工具断言 `concludeTurn` 仅在送达后触发。
