## Why

`scripts/dsh-superagent` 只认 `--profile`：`start` / `stop` / `restart` / `status` 都要调用者记得 profile 名、端口，且默认 profile 固定是 `superagent`。多实例部署（面板登记的 `superagent-spawner` :3150、`dsh-superagent-prototype` :3151、`new-word-discovery` :3152）下这不够用：

- 没有一处能列出「本机登记了哪些实例、各自端口与运行状态」；面板有这份表，命令行没有。
- 按名字启动会落回默认 profile/端口（`start superagent-spawner` 会被当成未知参数或落到 3082），必须手工拼 `--profile` 与 `--url`。
- 实例在面板里归档后，脚本不知道：`start` 仍会把已归档的入口实例拉起来，归档等于失效。

登记表（`~/.dsh/spawner/instances.json`，所有面板共享）已经有 name / profile / port / workspace / dshHome / tmuxSession / archived，脚本读一次就能回答这三件事。

## What Changes

- 新增 `scripts/dsh-superagent ls`：打印登记表——NAME、PORT、STATE（running / stopped / archived）、URL。
- `start` / `stop` / `restart` / `status` 接受可选位置参数 `<名字>`：profile、端口、工作目录、tmux 会话、`DSH_HOME` 都从该行解析；`--profile` 与行冲突时报错退出，不再静默使用另一个 profile。
- 不带任何子命令运行脚本时打印同一张表与用法，退出 0。
- 已归档实例：`start` / `restart` 拒绝并以非零退出，提示先在面板恢复；`status` 的 `manually_stopped` 对归档行也为 `true`，让小时检查（watchdog）跳过自动恢复；`--respect-stop` 下同样跳过、退出 0。
- 未登记的名字：报错点名登记表路径与 `ls`，退出 1。

## Capabilities

### New Capabilities

- `service-instances`: 启动脚本按共享登记表列实例、按名字控制、并对已归档实例拒绝启动。

### Modified Capabilities

（无：`ticket-timeline` 的 `why` 子命令不变。）

## 明确不做

- 不新增常驻服务或 IPC：脚本只在启动时读一次登记表文件。
- 不改面板、不改登记表字段与写入方；不迁移已有实例。
- 不改变各控制动作的既有退出码语义（0/1/2/3，`--respect-stop` 的 0）与锁、日志、健康检查流程。
- 不实现登记表写入（创建/归档仍只在面板里做）。

## 验收标准

在装有登记表的机器上（示例：4 行实例，其中 `superagent` 已归档）：

1. **列表**：`./scripts/dsh-superagent ls` 打印表头 `NAME PORT STATE URL` 与四行；`superagent` 的 STATE 为 `archived`。
2. **无参数**：`./scripts/dsh-superagent` 打印同一张表与 `start <name>` 用法行，退出 0。
3. **按名字 status**：`./scripts/dsh-superagent status superagent` 输出含 `"archived": true`、`"manually_stopped": true`，`url` 为登记端口 3082，`cwd` 为登记 workspace，退出 1。
4. **归档拒绝启动**：`./scripts/dsh-superagent start superagent` 退出 1，stderr 含 `is archived in`；不新建 tmux 会话。
5. **监控跳过**：`./scripts/dsh-superagent --respect-stop start superagent` 打印 `The instance is archived; automatic recovery skipped.`，退出 0。
6. **未知名字**：`./scripts/dsh-superagent status nope` 退出 1，stderr 含 `No instance named nope is registered` 与 `dsh-superagent ls`。
7. **profile 冲突**：`./scripts/dsh-superagent start superagent --profile other` 退出 1，stderr 含 `registered with profile superagent`。

## Impact

- `scripts/dsh-superagent`：登记表读取、`ls`、位置参数 `name`、归档拒绝。
- `tests/service-script.spec.ts`：ls/按名字启动/归档拒绝/未知名字/冲突用例。
- `docs/006-deployment.md`：启动章节补 `ls` 与按名字用法、归档行行为。
- 运行中的实例与登记表不需要迁移。
