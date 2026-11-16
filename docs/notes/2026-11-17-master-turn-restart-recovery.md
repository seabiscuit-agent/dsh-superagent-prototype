# 2026-11-17 重启切断主会话回合后不自动续跑

## 根因

- DSH 被强杀/重启会中断主会话（orchestrator）正在跑的回合；下次加载会话时 DSH 给未闭合回合补写
  `turn/end {"reason":{"kind":"interrupted"}}`（`@deepseek-ai/dsh-session/lib/index.js:907`
  `interruptedTurnClosers`，`@deepseek-ai/dsh-agent-loop/lib/index.js` 在 agent 创建时 `append(closers)`），
  客户端把它显示成「已停止，工具调用结果未知」。
- dsh-superagent 的 `resume()`（`src/executor/dsh.ts:524`）只恢复 worker 的 Assignment，主会话自己的回合
  没有任何人续跑：2026-11-16 23:55 的事故里回合 52 被切断，重启后主会话只被一条 pending worker_report
  被动带进回合 53，把 worker 的 failed 当瞬断回了一句就空闲，直到 owner 23:57 手动发「?」。
- 面板「重启」走优雅 `Runtime.shutdown()`：`agent.cancel({kind:'user'})` 让回合以 `aborted` 结束，
  没有 `interrupted` 事件，所以只按 `interrupted` 判断会漏掉这条路径。

## 修复

- 新增 `src/app/restart-recovery.ts`：`cutTurn(events, shutdown)` 读会话快照的**最后一回合收尾**——
  `interrupted` 直接恢复；`aborted` 只有回合号等于 KV `runtime.shutdown-turn` 标记时才恢复；
  未闭合回合 + 匹配标记也恢复（队列里的 abort 事件可能还没落盘）。
- `Runtime.shutdown()` 在 `cancel()` 之前 `markShutdownTurn()` 记录即将切断的回合；
  `Runtime.initialize()` 在 `effects.start()` 之后 `resumeMaster()`，用
  `Sessions.prompt(masterId, 'restart-recovery:<turn>', recoveryNote(), 'steer')` 唤醒主会话。
  失败只 `ctx.logger.warn`，不阻塞 `ready`；`paused()` 时保留标记等下次启动。
- 人自己按停止的回合没有标记，重启后不会又跑起来；`completed`/`error` 收尾一律不恢复。

## 坑

- 不要把标记放进 `master-recovery:` 前缀的 KV：`src/app/migration.ts:117` 的 `DEAD_KEYS` 每次启动会删。
- 恢复投递是异步的（fire-and-forget）：`restart().ready` 之后立刻断言会拿到 `[]`，集成测试要
  `await vi.waitFor(...)`。
- 投递 id 是 `Sessions.promptedId('restart-recovery:<turn>')`（`src/core/ids.ts` 的 `key()` 做了 sha256），
  不是字面量 `dsh-superagent:restart-recovery:N`。
- worker 在 spawner 注入的环境里跑时，`tests/runtime.spec.ts` 有两个环境用例（`GIT_CONFIG_GLOBAL`、
  `PATH` 里的 `worker-bin`）本来就会失败；跑基线用
  `env -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_NOSYSTEM PATH=...` 清干净。
- 生产数据离线校验要按 `time <= 1794844522226`（23:55:22 的 `turn/end`）截断事件，否则后面 completed
  的回合会把「最后一回合」覆盖掉，看起来像没问题。

## 验证

```sh
pnpm vitest run tests/restart-recovery.spec.ts
pnpm vitest run tests/runtime.spec.ts -t "main-session turn"
pnpm check && openspec validate --all --strict
```

生产快照（`orchestrator-d01335c24cab5096749941188086fb62/session.v4.jsonl.zstd`）上用 `cutTurn`：
按 23:55:22 截断 → 回合 `52`；回合 53 `completed` 之后 → `undefined`；当前整份日志 → `undefined`（无假阳性）。

相关：`openspec/changes/resume-master-turn-after-restart/`、`docs/003-execution.md`（Restart）、
`docs/007-architecture.md`（Runtime 启动序列）。
