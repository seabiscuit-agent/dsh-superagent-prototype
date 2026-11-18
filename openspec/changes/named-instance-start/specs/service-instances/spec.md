# service-instances Specification

## Purpose

`scripts/dsh-superagent` 是实例的第二个操作面（面板之外）。本能力让它与面板共用一份共享登记表：列出登记了哪些实例，按名字执行 start / stop / restart / status，并把「已归档」当成「不可启动」，避免命令行绕过面板的退役决定。

## ADDED Requirements

### Requirement: 脚本按共享登记表列出实例

The system SHALL 让 `scripts/dsh-superagent ls` 读取面板登记表（`DSH_SUPERAGENT_REGISTRY`，否则当前 DSH home 下的 `spawner/instances.json`，缺失时回退 `~/.dsh/spawner/instances.json`）并打印一张表：NAME、PORT、STATE、URL。STATE SHALL 为 `archived`（登记行已归档）、`running`（本 profile 的 dsh 进程存在）或 `stopped`。

The system SHALL 在没有子命令时打印同一张表与 `start <name>` 用法，退出码 0；登记表不存在时打印提示与用法，退出码 0。

#### Scenario: 多实例登记表

- **WHEN** 登记表有四行：`superagent`（3082，已归档）、`superagent-spawner`（3150，运行中）、`dsh-superagent-prototype`（3151，已停止）、`new-word-discovery`（3152，运行中），执行 `ls`
- **THEN** 输出四行且每行含名字、端口、对应 STATE 与 `http://127.0.0.1:<port>/`

#### Scenario: 登记表缺失

- **WHEN** 三个候选位置都没有 `instances.json`，执行 `ls` 或无参数运行
- **THEN** 打印 `No instances are registered in <路径>` 与用法，退出 0，不报栈

### Requirement: 按名字控制实例

The system SHALL 让 `start` / `stop` / `restart` / `status` 的可选位置参数 `<名字>` 从登记行解析 profile、端口（健康检查 URL）、工作目录、`DSH_HOME` 与 tmux 会话；`start` SHALL 在登记行的 workspace 下、以登记行 tmux 会话启动 `dsh --profile <profile>`。

The system SHALL 在 `--profile` 与登记行不一致、或名字未登记时以非零退出并说明原因，SHALL NOT 退回默认 profile/端口执行。

#### Scenario: 按名字启动子实例

- **WHEN** 登记行 `alpha` 有 profile `alpha-p`、port 5099、workspace `<root>/alpha/workspace`、tmuxSession `dsh-alpha`，执行 `start alpha`
- **THEN** 脚本以 `-s dsh-alpha -c <root>/alpha/workspace` 新建 tmux 会话，命令为 `DSH_HOME=<行的 dshHome> dsh --profile alpha-p --no-open`，健康检查打 `http://127.0.0.1:5099`

#### Scenario: 未知名字

- **WHEN** 执行 `status nope` 且登记表没有该名字
- **THEN** 退出 1，stderr 含 `No instance named nope is registered in <登记表路径>` 与 ``run `dsh-superagent ls` to list them``

#### Scenario: profile 与登记行冲突

- **WHEN** 执行 `start alpha --profile other`，登记行 profile 为 `alpha-p`
- **THEN** 退出 1，stderr 含 `alpha is registered with profile alpha-p, not other`

### Requirement: 已归档实例不可启动

The system SHALL 对登记行 `archived: true` 的实例拒绝 `start` 与 `restart`：不写停止标记、不创建 tmux 会话、不写 PID，退出码 1，stderr 含 `is archived in <登记表路径>` 与在面板恢复的提示。

The system SHALL 让 `status` 对归档行输出 `archived: true`、`manually_stopped: true`（即使没有停止标记文件）；`--respect-stop` 的 `start` / `restart` 对归档行打印跳过信息并退出 0。

#### Scenario: 命令行启动已归档入口实例

- **WHEN** `superagent` 行 `archived: true`，执行 `start superagent`
- **THEN** 退出 1，stderr 含 `superagent is archived in <路径>; restore it in the panel before starting it.`；不产生新的 tmux 会话或进程

#### Scenario: 小时检查跳过已归档实例

- **WHEN** 同一行执行 `--respect-stop start superagent`
- **THEN** 输出 `The instance is archived; automatic recovery skipped.`，退出 0

#### Scenario: status 报告归档

- **WHEN** 同一行执行 `status superagent`
- **THEN** JSON 含 `"archived": true`、`"manually_stopped": true`，`url` 取登记端口，`cwd` 取登记 workspace，退出 1
