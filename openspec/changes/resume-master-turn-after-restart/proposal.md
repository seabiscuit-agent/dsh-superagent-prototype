## Why

现状：宿主进程重启会**直接结束主会话（orchestrator DSH Session）正在执行的回合**。被强杀时，DSH 下次加载会话会补写一条
`turn/end` `{"reason":{"kind":"interrupted"}}`，客户端把它渲染成「已停止，工具调用结果未知」
（`dsh-client-ui-chat/README.zh.md:66`）。dsh-superagent 只恢复 worker 的 Assignment
（`src/executor/dsh.ts:524` `resume()` → `src/core/assignments.ts:79` `interrupted()`），
**从不恢复主会话自己的回合**，所以重启后主会话要么沉默，要么被别的 pending 消息带进来后误判、
继续等人工，所有者必须再发一条消息才继续。

生产实测（实例 `superagent-spawner :3150`，2026-11-16 23:55 面板重启）：

- 主会话 `~/.dsh/spawner` 实例的 orchestrator 回合 52 从 `1794844493911` 开始，在
  `1794844522262` 以 `turn/end` `{"turn":52,"reason":{"kind":"interrupted"}}` 结束；
  该回合的最后一步（发一条 attention 给所有者，然后收尾）永远没有执行。
- 重启后主会话只有一次被动的 worker_report 唤醒（回合 53，`1794844533099`），它把 worker 的
  failed 报告当成「重启带来的模型瞬断」，回了一句「等你完成 ChatGPT 登录授权」就空闲；
  直到所有者 23:57:26 手动输入「?」（回合 54）才继续。
- 同一时间 worker 侧是有恢复的（`resume()` 给 Assignment 注入 RECOVERY_NOTE，回合 19/20 都收到了），
  只有主会话没有。`docs/003-execution.md:45` 写的是「A process restart ends that work outright.
  An Assignment interrupted while busy restarts with a recovery note」——主会话不在其列。

## What Changes

- 每次启动在 setup 完成、主会话 ensure、`executor.resume()` 之后，检测**主会话最后一次收尾是否被重启切断**；
  是则注入一条恢复说明并唤醒主会话继续该回合，不需要所有者再发消息。
- 区分「被重启切断」和「人主动停止」：`Runtime.shutdown()` 在 `agent.cancel()` 之前把当前打开的回合号写入
  KV `shutdown-turn` 标记；只有 `turn/end` 为 `aborted` 且回合号与标记一致时才恢复。人自己停的回合、
  正常 `completed` / `error` 结束的回合都不恢复。
- 恢复消息固定 request id `restart-recovery:<turn>`，经 `Sessions.prompt(..., 'steer')` 投递，
  跨重启幂等；说明要求主会话先核对工单、报告、待回复与已经发出的外部动作，不重复已经发生过的外部副作用，
  并用一句话告知等待的人「已续跑」。
- setup 未完成或全局 paused 时不唤醒主会话；恢复失败只记日志，不阻塞实例就绪。
- 不改 DSH、不加 UI、不加 HTTP 端点、不改 worker 的 Assignment 恢复（既有行为）。

## Capabilities

### New Capabilities

- `restart-recovery`: 主会话被进程重启切断的回合在下次启动时自动续跑，且与「人主动停止」「正常完成」
  「重复启动」区分开。

### Modified Capabilities

无。Trigger / Ticket / Assignment / Outbox 的契约都不动；恢复消息就是一条普通的 `dsh-superagent`
注入消息（`source.kind: "dsh-superagent"`），local Source 的 intake 会把它当插件消息过滤掉，
不会造成回声候选。

## 明确不做

- **不改 DSH 的回合生命周期**：不修改 `turn/end` 语义、不伪造事件、不改 `interruptedTurnClosers`。
  主会话被切断这个事实由 DSH 记录，本变更只负责读它并续跑。
- **不恢复人主动停止的回合**：没有 `shutdown-turn` 标记的 `aborted` 一律不唤醒；否则人会发现自己按了停止、
  重启后它又跑起来。
- **不恢复 worker 的 Assignment**：`src/executor/dsh.ts:524` 已有该行为，本变更不重复、不改写。
- **不加 UI 与新端点**：没有「恢复」按钮、没有新的 API；恢复只是一条会话消息。
- **不处理重启后模型 provider 失效**：2026-11-16 事故里 worker 恢复后连续失败是
  `Provider is not configured: openai-codex`（配置问题），与本变更无关，留给对应工单。

## 验收标准

1. **分类器单测**：`pnpm vitest run tests/restart-recovery.spec.ts` 全部通过，覆盖
   `interrupted` 恢复、`aborted` + 同回合标记恢复、`aborted` 无标记不恢复、`completed`/`error` 不恢复。
2. **运行时集成测试**：`pnpm vitest run tests/runtime.spec.ts -t "main-session turn"` 通过——
   重启后主会话收到 `restart-recovery:7` 的 `steer` 投递，且再次启动同一回合不产生第二条。
3. **生产数据离线校验**：对 2026-11-16 23:55 的生产主会话事件运行分类器，输出被切断的回合号为 `52`；
   对同一会话中 `completed` 收尾的回合输出空。
4. **仓库检查**：`pnpm check`（typecheck + vitest + build）退出 0；`openspec validate --all --strict` 退出 0。
5. **生产验证（合并后由 orchestrator 执行）**：重启实例 `superagent-spawner` 后，主会话日志出现
   `restart-recovery:` 注入消息，且该回合在没有人类新消息的情况下继续（有新的 assistant/tool 事件）。

## Impact

- 代码：`src/app/restart-recovery.ts`（新增：回合分类、恢复说明、shutdown 标记读写）、
  `src/app/runtime.ts`（`initialize()` 末尾恢复、`shutdown()` 取消前写标记）、`src/kv.ts`（`runtime.shutdownTurn`）。
- 数据库：只写入/删除一个 KV 记录，无 schema 迁移。
- 文档：`docs/003-execution.md`（重启语义补主会话）、`docs/007-architecture.md`（启动序列）、
  `docs/notes/2026-11-17-master-turn-restart-recovery.md`。
- 测试：`tests/restart-recovery.spec.ts`（新）、`tests/runtime.spec.ts`（重启恢复用例）。
