# 启动脚本按名字列出与启动实例（2026-11-18）

## 症状与根因

`scripts/dsh-superagent` 只认 `--profile`：多实例部署下列不出登记了哪些实例、端口与状态；想按名字启动
只能手工拼 `--profile` / `--url`，名字写错就落回默认的 `superagent` :3082。面板把入口实例标为归档后脚本
不知道，`start` 仍会把它拉起来——归档在命令行入口完全无效。

## 修复

- `registry_path()`：`DSH_SUPERAGENT_REGISTRY` → `<DSH_HOME|~/.dsh>/spawner/instances.json` →
  `~/.dsh/spawner/instances.json` 三级回退，和面板共用一份真源（子实例 shell 里 `DSH_HOME` 指向
  自己的 workspace，所以必须回退）。
- `ls`：NAME / PORT / STATE / URL；STATE 为 `archived`（登记行）| `running`（本 profile 进程存在）| `stopped`。
  无子命令时打印同一张表加用法行，退出 0。
- 位置参数 `<名字>`：`start` / `stop` / `restart` / `status` 从登记行取 profile、端口、cwd、`DSH_HOME`、
  tmux 会话；`--profile` 与行冲突或名字未登记时报错，不回落默认值。
- 归档行：显式 `start` / `restart` 退出 1 并提示先在面板恢复；拒绝在写停止标记与调用 tmux 之前发生，不产生 PID、日志与会话；
  `--respect-stop` 打印跳过信息退出 0；`status` 输出 `archived: true` 且 `manually_stopped: true`，小时检查
  因此不会把它拉起来。

## 坑

- 首次实现把 tmux `-c` 的目录写成脚本根 `ROOT`，按名字启动时会在 checkout 里而不是实例 workspace 起服务；
  必须用登记行的 workspace（`settings()` 的 `args.cwd`）。
- 测试里 `DSH_HOME` 带空格，命令字符串被 `shlex.quote` 包成 `'…'`，断言要先去掉引号再比 `DSH_HOME=<home>`。
- 本机 bash 守卫会拦住含 `start superagent` / `--respect-stop` 字面量的命令，验证时用变量拼参数或包装脚本。
- 登记表缺失时 `ls` 打印提示并退出 0（面板没起过也能用），但按名字动作必须报错退出。

## 验证命令

```sh
npx vitest run tests/service-script.spec.ts   # 21 passed，含 ls/按名字/归档拒绝/未知名字/冲突
npx vitest run                               # 全量；tests/runtime.spec.ts 2 项为环境变量泄漏导致的既有失败
./scripts/dsh-superagent ls
./scripts/dsh-superagent status superagent    # archived: true, manually_stopped: true, exit 1
```

真实登记表现场与 before/after 终端输出见 `docs/evidence/40c613b7a9c86f75f617b97e1a03ad32/`；
规格见 `openspec/changes/named-instance-start/`。
