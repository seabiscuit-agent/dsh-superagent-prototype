## 1. 规格（本提案）

- [x] 1.1 `proposal.md`：症状、三条改动、验收标准
- [x] 1.2 `specs/service-instances/spec.md`：列表、按名字控制、归档不可启动三条需求与失败场景
- [x] 1.3 `design.md`：读登记文件、位置参数、路径回退、归档即有意停止
- [x] 1.4 `openspec validate named-instance-start --strict` 通过（`openspec validate --all --strict` 11/11）

## 2. 实现

- [x] 2.1 `registry_path()` / `registry()` / `instance(name)` / `archived(profile)`：三级路径回退、name 或 profile 匹配
- [x] 2.2 `ls()`：NAME / PORT / STATE / URL 表；`state` = archived | running | stopped
- [x] 2.3 `settings()`：名字解析 profile/url/cwd/dshHome/session/archived；未知名字与 `--profile` 冲突报错
- [x] 2.4 `start()`：按登记行的 tmux 会话、工作目录与 `DSH_HOME` 启动；`status()` 输出 `archived` 与归档行 `manually_stopped: true`
- [x] 2.5 `main()`：无子命令打印表与用法；`ls` 直接返回；显式 start/restart 归档拒绝（exit 1）；`--respect-stop` 归档跳过（exit 0）

## 3. 测试

- [x] 3.1 `tests/service-script.spec.ts`：`ls` + 无参数 + 按名字 start（tmux 会话/目录/`DSH_HOME`/profile 断言）
- [x] 3.2 `tests/service-script.spec.ts`：归档拒绝 start/restart、status 归档标记、`--respect-stop` 跳过、不产生 tmux 会话
- [x] 3.3 `tests/service-script.spec.ts`：未知名字与 `--profile` 冲突
- [x] 3.4 `npx vitest run tests/service-script.spec.ts` 全绿；`npx vitest run` 与基线对比（2 个既有环境失败）

## 4. 文档与证据

- [x] 4.1 `docs/006-deployment.md`：「Start and stop」补 `ls`、按名字用法与归档行行为
- [x] 4.2 before/after 终端输出证据（`docs/evidence/40c613b7a9c86f75f617b97e1a03ad32/`）
