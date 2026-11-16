## Context

被描述系统是本仓库 `dsh-superagent-prototype`（DSH 插件；生产实例 `superagent-spawner :3150`，state
`/Users/seabiscuit/dsh-instances/superagent-spawner/workspace/state/superagent-spawner`，
`stateDir` 由 `cordis.patch.yml` 注入；本仓库通过 `link:` 直接被该实例加载，重启即生效）。

### 现状（实测证据，2026-11-16 23:55 面板重启）

- DSH 在加载会话时会给未闭合的回合补写 `turn/end` `{"reason":{"kind":"interrupted"}}`
  （`@deepseek-ai/dsh-session/lib/index.js:907` `interruptedTurnClosers`，
  `@deepseek-ai/dsh-agent-loop/lib/index.js:1725-1750` 在 agent 创建/加载时 `append(closers)`）。
  客户端把它渲染成「已停止，工具调用结果未知」（`dsh-client-ui-chat/README.zh.md:66`）。
- 主会话事件：回合 52 开始于 `1794844493911`，结束于 `1794844522262`
  `{"turn":52,"reason":{"kind":"interrupted"}}`；随后 `1794844533099` 起了一个被动的回合 53
  （pending worker_report），它把 worker 的 failed 报告当成重启瞬断，回「等你完成 ChatGPT 登录授权」后空闲；
  直到所有者 `23:57:26` 手动输入「?」才有回合 54。也就是说：**被切断的回合 52 的剩余步骤从未执行**。
- worker 侧：`src/executor/dsh.ts:524` `resume()` 给忙碌的 Assignment 注入
  `src/core/assignments.ts:21` 的 RECOVERY_NOTE 并重开回合（事故里回合 19/20 确实收到），
  但主会话不在恢复范围。
- 正常关闭路径：`Runtime.shutdown()`（`src/app/runtime.ts:282-305`）用
  `agent.cancel({kind:'user'},{keepInbox:true})` 取消 `[masterId, ...assignment sessions]`，
  回合以 `aborted` 结束（`@deepseek-ai/dsh-agent-loop/lib/index.js:493-505` `abortedCancelCause`）。
  这条路径下没有 `interrupted` 事件，所以只靠 `interrupted` 判断会漏掉面板「重启」按钮与 `stop` 再 `start`。

### 约束

- 不能改 DSH：插件只在自身生命周期里读写会话事件与投递消息。
- 不能重复外部副作用：被切断的回合最后一步可能是「已经发出」的 `orchestrator_reply` / GitHub 评论 /
  派工；恢复说明必须让主会话先核对再继续。
- 不能把「人主动停止」变成「重启后自己又跑起来」。
- local Source 会把 `source.kind` 为 `dsh-superagent` 的注入消息过滤掉（`src/app/delivery.ts`），
  所以恢复消息不会变成回声候选或新工单。

## Goals / Non-Goals

**Goals:**

- 重启后主会话自动续跑被切断的回合，所有者不用再发消息。
- 与「人主动停止」「正常完成」严格区分。
- 恢复投递幂等（同一回合只一条）、失败不阻塞就绪、paused/setupPending 时不唤醒。

**Non-Goals:**

- 不恢复 worker Assignment（既有 `resume()` 已覆盖）。
- 不改 DSH 的回合/中断语义。
- 不处理重启后模型 provider 配置失效（事故里的 `Provider is not configured: openai-codex` 是另一个问题）。
- 不加 UI 或 HTTP 端点。

## Decisions

### 1. 用「最后一回合收尾 + shutdown 标记」判定，而不是在 `turn/end` 上挂钩子

备选：A) 在 `sessions.install()` 的 `session/event` 监听里看到 `interrupted` 就立刻 steer；B) 持久化
「回合进行中」标志并在启动时读；C) 读会话快照的最后一回合收尾（本方案）。

- A 不行：`interrupted` 是崩溃**之后**、下一次加载时才补写的事件；此时进程刚起来，插件还没装好监听，
  而且「补写」与「正常事件回放」在监听里难以区分。
- B 可行但多一次每回合写库，还需要在回合结束时清理，失败路径更多。
- C 最省：DSH 已经把「被切断」这件事持久化进会话日志，启动时读一次快照即可；
  快照通过 `agent.session.snapshotEvents()` 拿到（`src/app/resources.ts:118` 已有同样用法）。
  `interrupted` 覆盖强杀/崩溃；`aborted` + `shutdown-turn` 标记覆盖面板重启的优雅路径。

### 2. `shutdown-turn` 用 KV 记录，不用文件

`Store` 已有 KV（`src/kv.ts`），`Runtime.shutdown()` 在取消 agent 前 `store.set(KV.runtime.shutdownTurn, {session, turn})`，
启动时读一次并删除。用 KV 而不是文件：与 state 目录同一事务域、`store.close()` 前写入、无额外清理规则。
键名**不能**用 `master-recovery:` 前缀——`src/app/migration.ts:117` 的 DEAD_KEYS 会在每次启动时删掉该前缀。

### 3. 只恢复「`aborted` 且回合号等于标记」的优雅路径

若只看 `aborted` 就恢复，人按停止 → 重启 → 又会自动跑，违背直觉。标记只在 `shutdown()` 取消前写入，
回合号精确匹配，因此人能区分「我们关的」和「人停的」。`interrupted` 不需要标记：只有强杀才会产生。

### 4. 用 `Sessions.prompt(..., 'steer')` 而不是 `inject`/`notify`

`steer` 会唤醒空闲会话并开始新回合（`@deepseek-ai/dsh-agent-loop/lib/index.js:552-580`）；
`inject` 只进下一步不唤醒，重启后空闲的主会话会一直不动；`notify`/`relay` 只是入队消息，不保证回合开始。
`Sessions.prompt` 走 `AgentDelivery.send`，按 request id 跨重启去重（`src/app/delivery.ts`），
所以 request id 用固定的 `restart-recovery:<turn>`。

### 5. 恢复说明写「先核对、不重复外部动作、用一句话告知」

被切断的回合可能已经发出过回复/评论/派工。说明沿用 worker RECOVERY_NOTE 的语气，但针对主会话补两点：
先看 open Tickets 及最新 Reports、待回复、已经到达人和仓库的动作；继续该回合后给等待的人一句话说明。
说明是英文，与 `RECOVERY_NOTE` 一致，避免每次重启多一套措辞。

### 6. 恢复失败只记日志

恢复是「尽力而为」的补动作，不应该让实例起不来：`prompt` 失败 `ctx.logger.warn`，`runtime` health 照常
`ready`。唯一必须成功的写操作是 `shutdown-turn` 标记，它在 `shutdown()` 的取消之前、`store.close()` 之前完成。

## Risks / Trade-offs

- **误唤醒一个正在跑的回合** → 启动时 `agent.status !== 'idle'` 直接跳过；正常启动流程里主会话刚 ensure，
  不会在跑回合。
- **恢复说明让主会话重复外部动作** → 说明明确要求先核对工单/报告/已发出动作；对已经发出过的 `orchestrator_reply`
  等工具，重复调用会因 request id 去重或人工可辨（PR/评论链接相同）。
- **人主动停止后重启又跑** → 只有带 `shutdown-turn` 标记的 `aborted` 才恢复；人停的回合没有标记。
- **标记残留** → 启动时用完即删；`paused`/`setupPending` 跳过时保留到下一次成功启动，最长生命周期是一个 KV 记录。
- **恢复回合又因模型 provider 失效失败** → 由既有 RetryHealth/健康面板暴露，属于配置问题，不在本变更处理。

## Migration Plan

无 schema 迁移；升级后第一次启动即生效。回滚：删掉 `initialize()` 里的恢复调用即可，`shutdown-turn`
KV 记录无害（没人读）。生产部署就是把实例重启一次（`link:` 已指向本仓库）。

## Open Questions

- worker 的 Assignment 恢复说明是否也要带上「模型 provider 可能已变」的提示？留给对应工单。
- 是否需要把「恢复发生了」记进 health 面板（例如 `runtime` 的 detail）以便运维观察？本变更先只写日志，
  等有人真的需要看再补。
