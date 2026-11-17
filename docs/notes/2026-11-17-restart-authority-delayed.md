# 2026-11-17 重启权收归主会话，并实现延迟重启互斥

## 根因

- 重启一直不是权限，而是「能不能拿到 shell」：worker 与主会话同进程、同 OS 用户，worker 用
  `tmux respawn-pane -k` 或 `POST /dsh-superagent-spawner/api?action=restart` 就能重启宿主。
  2026-11-16 23:55 一次 worker 重启把当时所有 worker 的回合连同整个任务一起切断。
- 没有任何「有活跃 worker 就延后」的机制：重启立即执行，正在跑的 worker 回合被 `agent.cancel` 掉。

## 修复

- `src/app/restart-guard.ts`：`restartCommand()` 匹配会结束/替换宿主进程的 shell 命令（tmux
  `respawn-pane`/`kill-session`/`kill-server`、`tmux new-session` 起 dsh、`kill|pkill|killall`
  配 dsh/node、launchctl/systemctl、spawner API 的 restart/stop/start、`scripts/dsh-superagent`
  的 restart/stop/start），在 `Sessions.workOnly()` 的 guard 里对 worker 及其 subagent 拒绝，
  文案要求 worker 改为上报。主会话 guard 不拦。
- `src/app/restart-queue.ts`：`RestartQueue` 只保存一个待执行请求；`load().running > 0 ||
  load().queued > 0 || mainBusy()` 时每 `RESTART_CHECK_MS = 5000` 轮询一次，空闲后执行且只执行一次。
  `mainBusy()` 读主会话 agent 的 `status === 'running'`：工具调用发生在主会话回合内，所以新请求
  通常先挂起，等这一轮结束再重启，避免把正在进行的回合切断。
  执行前先清 pending（进程死掉也不会重放），apply 失败则恢复 pending 并重试；`cancel()` 撤回。
  请求只在内存里：进程重启本身就满足请求，插件重启则丢弃，由主会话重问。
- `src/app/restart-panel.ts`：`restartViaPanel()` 先 `GET ?action=list` 找到自己的行，再让
  `self !== true` 的 peer 面板 `POST ?action=restart&name=<自己>`（202 即接受）。peer 全拒或不存在
  时，只有在 `host.selfRestart === true` 的**新版** spawner 面板上才向自己发同一个请求：面板用
  detached 助手（`lib/self-restart.js`）先优雅停止、等进程退出、再用原命令拉起，202 先回。旧面板
  会停掉自己而不再拉起，所以没有能力位就绝不发，报错并留给人工。
- `src/app/tools/main.ts`：新增 `orchestrator_restart`（只注册给主会话，`cancel: true` 撤回），
  并修复 `orchestrator_settings_save` 把 JSON 字符串当对象传下去报
  `expected object, received string` 的问题（`settingsValue()` 先 parse，非 JSON 给明确错误）。
- `Runtime` 把 `executorLoad(store, executor.activeCount())` 作为 load、`restartViaPanel` 作为
  apply 接进队列，`stop()` 时 `dispose()`；`mainTools` 新增 `host.restart`。

## 坑

- `tools.restrict({ allow })` 只能列 preset 继承来的工具，列 plugin 自己注册的会抛
  `Restriction names a non-inherited tool`；主会话的 `orchestrator_*` 本来就不在 allow 里也没被遮住，
  所以 `orchestrator_restart` 不需要（也不能）加进 allow。
- `tests/runtime.spec.ts` 里的 guard 常以 `guards.get(id)!()` 无参调用，`restartCommand()` 的参数
  必须可选，否则这些用例全挂。
- 本机 worker 环境被 spawner 注入过 `GIT_CONFIG_GLOBAL`/`PATH`，`tests/runtime.spec.ts` 的两个
  环境用例在注入环境里失败、清环境后通过（见 2026-11-17-master-turn-restart-recovery.md）。
- 延迟队列不持久化是刻意的：持久化会在进程真正重启后重放同一请求，形成二次重启。

## 验证

```sh
npx tsc --noEmit
npx vitest run tests/restart-queue.spec.ts tests/restart-guard.spec.ts tests/restart-panel.spec.ts tests/tools.spec.ts
env -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_NOSYSTEM PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$(command -v node)")" npx vitest run
```

相关：`docs/003-execution.md`（Restarting the instance）、`docs/006-deployment.md`（重启权与面板）。
