## Context

`scripts/dsh-superagent` 是实例的操作入口（start / stop / restart / status），默认 profile 是 `superagent`、默认 URL 是 `http://127.0.0.1:3082`；多实例部署靠手工 `--profile` / `--url` 拼。面板（dsh-superagent-spawner 插件）维护登记表 `~/.dsh/spawner/instances.json`，每行有 name、profile、port、workspace、dshHome、tmuxSession、host、archived、instanceRoot。归档后：面板 API 已用 409 `archived` 拒绝启动，但脚本仍会拉起服务。

## Goals / Non-Goals

**Goals:**

- 一条命令看清「本机登记了哪些实例、端口、运行状态、是否归档」。
- 按名字执行控制动作，profile / 端口 / 工作目录 / `DSH_HOME` / tmux 会话由登记行决定。
- 已归档实例在脚本入口同样不可启动，watchdog 也不会把它拉起来。

**Non-Goals:**

- 不写登记表（创建、归档、恢复仍只在面板里做）。
- 不改变控制动作的退出码语义、锁、日志与健康检查流程。
- 不引入常驻进程、socket 或新的依赖。

## Decisions

### 1. 读登记文件，不查询面板 API

面板的登记表就是唯一真源，读取不需要认证、不依赖面板在线，脚本在实例全停时也能工作。查询 API 需要知道「哪个实例的面板」才可信，反而多一层依赖。

### 2. 位置参数 `<名字>` 而不是新增 `--name`

现有调用面是 `start --profile X`；`start <name>` 与 `superagent status superagent` 读起来自然，且与 `ls` 输出的名字同一口径。名字匹配 name 或 profile，兼容既有按 profile 称呼的习惯；`--profile` 与登记行冲突时报错，避免「以为是 alpha，实际起了 beta」。

### 3. 注册表路径三级回退

优先 `DSH_SUPERAGENT_REGISTRY`（测试与非常规部署），否则当前 DSH home（`$DSH_HOME` 或 `~/.dsh`）下的 `spawner/instances.json`，再回退 `~/.dsh/spawner/instances.json`。子实例的 shell 里 `DSH_HOME` 指向它自己的 workspace，而登记表在各面板间共享——回退保证从任何 cwd 都能读到同一份。

### 4. 归档即「有意停止」，复用 `manually_stopped`

`status` 的 `manually_stopped` 本来就是给 hourly check 看的「不要自动恢复」信号；归档行语义相同，直接并进去，watchdog 的三段检查与 `--respect-stop` 行为都不用改。

### 5. 拒绝路径先于副作用

`settings()` 先解析登记行并判断 `archived`，拒绝在写停止标记与调用 tmux 之前发生，所以不会留下 PID 文件、tmux 会话或新日志（只会创建该 profile 的空控制目录与锁文件）；`--respect-stop` 的归档跳过在 `settings()` 之前，保持「自动恢复永远零副作用」的既有约定。

## Risks / Trade-offs

- **登记表被手工编辑出错** → 解析失败时按未登记处理并报出登记表路径，不静默回落默认 profile。
- **`ls` 的 running 判断依赖本 profile 的进程扫描** → 与 `status` 同一函数，不会与面板的健康检查完全一致（面板还看端口应答）；表中 STATE 只用于一眼分辨，精确健康仍用 `status <name>`。
- **tmux 会话名来自登记行** → 老行缺 `tmuxSession` 时回退 `dsh-<profile>`，与旧脚本一致。

## Migration Plan

- 无数据迁移：登记表字段已存在；脚本向后兼容（不带名字的调用与原来等价）。
- 回滚：旧脚本只认 `--profile`，忽略位置参数；归档拒绝失效但不影响运行中的实例。

## Open Questions

- 是否给 `ls` 增加 `--json` 供其他脚本消费？本变更先只做人读表；等有第二个消费者再加。
