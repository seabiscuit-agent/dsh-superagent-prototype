## Purpose

宿主进程重启（面板重启、`tmux respawn-pane`、崩溃）后，主会话（orchestrator DSH Session）被切断的回合在下次启动时自动续跑，
不需要所有者再发一条消息来推动工作；同时不把「人主动停止」和「正常完成」误判成需要续跑。

## ADDED Requirements

### Requirement: 被重启切断的主会话回合自动续跑

The system SHALL 在每次启动完成 setup、主会话 ensure 与 `executor.resume()` 之后，检测主会话最后一次回合收尾是否被进程重启切断；
检测到时 SHALL 以 `Sessions.prompt(masterId, "restart-recovery:<turn>", note, 'steer')` 注入恢复说明并唤醒主会话继续该回合；
MUST NOT 要求所有者重新发送消息才能继续，也 MUST NOT 在主会话之外新建回合或伪造 `turn/end` 事件。

#### Scenario: 强杀切断的回合自动续跑

- **GIVEN** 主会话最后一回合以 `turn/end` `{"turn":52,"reason":{"kind":"interrupted"}}` 结束（进程被强杀或 `tmux respawn-pane -k`），
  且没有同回合的 `shutdown-turn` 标记
- **WHEN** dsh-superagent 启动并完成 setup、主会话 ensure、`executor.resume()`
- **THEN** 主会话收到一条 request id 为 `restart-recovery:52` 的 `steer` 消息并被唤醒，
  消息要求它先核对工单、报告、待回复与已发出的外部动作，不重复可能已经发生的外部副作用，继续该回合，
  并用一句话告知等待的人已经续跑

#### Scenario: 优雅关闭切断的回合自动续跑

- **GIVEN** 主会话回合进行中时 `Runtime.shutdown()` 先把该回合号写入 KV `shutdown-turn`，再以
  `agent.cancel({kind:'user'})` 取消，回合以 `turn/end` `{"reason":{"kind":"aborted","reason":{"kind":"user"}}}` 结束
- **WHEN** 下一次启动检测到 `shutdown-turn` 的回合号与最后一回合一致
- **THEN** 主会话收到 `restart-recovery:<turn>` 的恢复消息并继续，标记在检测后被删除

#### Scenario: 配置未就绪导致的中断不阻塞下次启动

- **GIVEN** 上次启动因为 `setup.run` 未就绪而停在 `paused/setupPending`，主会话回合仍是被切断的状态
- **WHEN** 运维补好配置后实例再次启动
- **THEN** 这一次启动完成 setup 后注入恢复消息，续跑该回合

### Requirement: 人主动停止与正常完成的回合不续跑

The system SHALL 只在「最后一回合 `turn/end` 为 `interrupted`」或「最后一回合为 `aborted` 且回合号等于 `shutdown-turn` 标记」
两种情况下续跑；MUST NOT 因为存在历史恢复消息、存在未读消息或回合以 `completed` / `error` 结束而唤醒主会话。

#### Scenario: 人主动停止的回合不续跑

- **GIVEN** 主会话回合由人主动 cancel，最后一回合以 `aborted`（`reason.kind` 为 `user`）结束，
  且没有同回合的 `shutdown-turn` 标记
- **WHEN** dsh-superagent 启动
- **THEN** 不注入恢复消息，也不唤醒主会话

#### Scenario: 正常完成或报错的回合不续跑

- **GIVEN** 主会话最后一回合以 `completed` 或 `error` 结束
- **WHEN** dsh-superagent 启动
- **THEN** 不注入恢复消息

#### Scenario: 没有回合事件的新会话不续跑

- **GIVEN** 主会话刚被创建，事件快照里没有任何 `turn/start` 或 `turn/end`
- **WHEN** dsh-superagent 启动
- **THEN** 不注入恢复消息，启动照常进入 `ready`

### Requirement: 恢复投递幂等且不阻塞实例就绪

The system SHALL 用固定 request id `restart-recovery:<turn>` 投递恢复消息，使同一回合在多次启动中被去重；
MUST NOT 因为恢复消息投递失败而让实例停在 `starting` 或让启动抛错。

#### Scenario: 同一回合重复启动只投递一条

- **GIVEN** 第一次启动已经投递 `restart-recovery:52` 并落盘为 `user/message`，之后进程在下一个回合开始前再次退出
- **WHEN** 第二次启动再次检测到同一回合被切断
- **THEN** `AgentDelivery` 按 request id 去重，主会话里只有一条 `restart-recovery:52` 消息

#### Scenario: 投递失败时实例仍然就绪

- **GIVEN** 恢复消息投递时抛出错误（例如会话已处于不可投递状态）
- **WHEN** 启动流程继续
- **THEN** 错误写入日志，`runtime` health 仍变为 `ready`，管理 API 与其它 Source 照常工作

### Requirement: setup 未完成或全局暂停时不唤醒主会话

The system SHALL 只在 `setup.configured()` 为真且 settings 未 `paused` 时执行恢复；MUST NOT 在 `setupPending` 或 `paused`
时向主会话注入恢复消息。

#### Scenario: setupPending 时不唤醒

- **GIVEN** state 目录缺少部署配置，`setup.run` 返回未就绪
- **WHEN** dsh-superagent 启动
- **THEN** 主会话不收到恢复消息，`runtime` health 记为 `paused/setupPending`，`shutdown-turn` 标记保留到下一次成功启动

#### Scenario: 全局 paused 时不唤醒

- **GIVEN** setup 已完成，但 settings 的 `paused` 为 `true`
- **WHEN** dsh-superagent 启动
- **THEN** 主会话不收到恢复消息，实例仍进入 `ready`，恢复留到解除 paused 后的下一次启动
