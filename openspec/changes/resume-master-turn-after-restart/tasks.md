> 本工单同时交付提案与实施（Explore + Propose + Apply）。实施范围见 proposal.md「明确不做」。

## 1. 回合分类与关闭标记

- [x] 1.1 新增 `src/app/restart-recovery.ts`：`RestartTurnEvent`、`cutTurn(events, shutdown)`（识别
  `interrupted`、带同回合标记的 `aborted`、标记匹配的未闭合回合）、`recoveryNote()`、`markShutdownTurn(store, session, events)`。
  验证：`pnpm vitest run tests/restart-recovery.spec.ts`。
- [x] 1.2 `src/kv.ts` 增加 `KV.runtime.shutdownTurn`（`record<{ session: string; turn: number }>('shutdown-turn')`），
  并在注释里写明它由 `Runtime.shutdown()` 写、`Runtime.initialize()` 读后删。
  验证：`pnpm typecheck`。

## 2. 接入 Runtime 生命周期

- [x] 2.1 `Runtime.shutdown()`：在 `agent.cancel()` 之前对主会话调用 `markShutdownTurn(store, masterId, events)`，
  保证标记在 `store.close()` 之前落库。
  验证：`pnpm vitest run tests/runtime.spec.ts` 中停止再启动的用例不回归。
- [x] 2.2 `Runtime.initialize()`：在 `effects.start()` 之后、`runtimeHealth.set(ready)` 之前调用 `resumeMaster()`：
  `paused()` 时跳过并保留标记；`agent.status !== 'idle'` 跳过；检测到切断回合时
  `Sessions.prompt(masterId, \`restart-recovery:${turn}\`, recoveryNote(), 'steer')`，失败 `ctx.logger.warn`，
  检测后删除标记。验证：集成测试 + `pnpm check`。

## 3. 测试

- [x] 3.1 `tests/restart-recovery.spec.ts`：分类器四类收尾（interrupted / aborted+标记 / aborted 无标记 /
  completed / error / 空事件）、未闭合回合 + 标记、说明文本含「不要重复外部动作」要求。
- [x] 3.2 `tests/runtime.spec.ts` 增加主会话重启恢复用例：伪造主会话 `turn/start` + `turn/end interrupted`，
  `restart()` 后断言 `deliveries` 里有一条 `{sessionId: masterId, mode: 'steer', id: promptedId('restart-recovery:7')}`；
  优雅停止路径断言标记被清掉；正常完成/人停止的回合不投递。
- [x] 3.3 生产数据离线校验：对 `2026-11-16 23:55` 的生产 orchestrator 会话快照运行分类器，
  输出被切断的回合 `52`；对 `completed` 回合与当前完整日志输出空。命令与输出已写进
  `docs/notes/2026-11-17-master-turn-restart-recovery.md`。

## 4. 文档与交付

- [x] 4.1 更新 `docs/003-execution.md`（重启语义补主会话）与 `docs/007-architecture.md`（启动序列补恢复）。
- [x] 4.2 新增 `docs/notes/2026-11-17-master-turn-restart-recovery.md`（< 60 行：根因、修法、坑、验证命令）。
- [x] 4.3 `pnpm check`（typecheck + vitest + build）与 `openspec validate --all --strict` 退出 0。
- [x] 4.4 开 PR（分支 `agent/fix-restart-resume-a894895b371b` → fork `seabiscuit-agent/dsh-superagent-prototype:main`），
  正文含中文说明、验证命令与真实会话截取证据；生产重启验证由 orchestrator 在合并前/后执行。
