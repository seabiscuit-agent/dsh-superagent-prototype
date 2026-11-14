# 2026-11-15 worker 会话不被 bili（billion-context）覆盖：restrict 掩掉 compress

结论分两段：**restrict 掩掉 compress 已证实**；**「因此导致长任务被 422 拒」证据不足**。

## 已证实：restrict 剪掉了宿主的压缩工具

billion-context 判断「能否折叠」的依据是它的 `compress` 有没有被声明在模型请求里。
`agent.ctx.tools.restrict({ allow })` 掩掉所有未被点名的全局工具，两份 allow list 都剪掉了
`compress` / `decompress` / `search_context`：router 是 7 个固定名，worker 是 `WORK_TOOLS` 子集。
生产日志 948 条 surface 判定**全是 `surface=off`，`surface=on` 为 0**。

真实 DSH `dsh-tools` + `dsh-scope` 四组对照（脚本与输出见 `docs/evidence/a2cd8a72fd8…/`）：

| 场景 | 该 agent 视图中被声明的工具 |
| --- | --- |
| A 有插件，只给工作工具（今天的行为） | bash,grep,read,skill — 压缩三件被剪 |
| B 有插件，工作工具 + 已注册压缩工具 | 七件全部保留 |
| C 无插件却无条件点名 | `restrict` 拒绝整份 allow list |
| D 无插件，过滤后点名 | 与原行为一致 |

用插件 shipped 的 gate 函数跑实测清单：今天 `surfaceOn=false`；追加三件后 `surfaceOn=true`。

修复即 `compressionTools(agent)`：经 `scopeParentOf(agent)` 只取宿主真正注册过的（避免 C 的整份拒绝）。

## 未证实：这次 422 不是 compress-surface 分支

被杀 worker 那条是 `bili_gate_oversize_refusal_unattributed`，来自 `dsh-client` 层（无 `sess=`），
自述指向**归属**而非压缩面。同一瞬间插件自报 `usage=32% (238235/750000)`，而字节保守计价给出
`est ~1,000,901 tok`（3.3MiB，乐观下界 877,983 仍窗口下）。另有 89 次
`model request sent DIRECT (uncompressed) — no active initiator attribution`，同样无 `sess=`。

所以因果链只有前半段有硬证据，后半段与插件自报的 32% 冲突；至少还叠加「未归因通道」或
「字节保守计价」之一。静态证据不能定论。

## 验证

```sh
node docs/evidence/a2cd8a72fd855ece3fdfe075915c96d7/registry-probe.mjs   # A–D 对照
node docs/evidence/a2cd8a72fd855ece3fdfe075915c96d7/scope-restrict.mjs   # 全局视图 vs agent 视图
node docs/evidence/a2cd8a72fd855ece3fdfe075915c96d7/run.mjs              # 线上 gate 判定
pnpm typecheck && pnpm test && pnpm build
```

基线 `8c32a9d` 与修复后同为 2 个失败，且是同样两条与本次无关的环境泄漏用例
（`GIT_CONFIG_GLOBAL` 未还原）；新增回归用例通过。

## 待做（需人决定）

线上确认必须重启 superagent 实例——会掐断在跑的 orchestrator/worker 会话（含执行本工单的会话），
故未自动执行。重启后应看到 `surface=on`、`compress` 出现在请求 tools 里、被拒次数不再增长。
若 `surface=on` 已出现但 422 复发，则第二成因在归因/计价一侧，另开一单。

## 坑

- `tools.restrict()` 只能在 agent 作用域调用，且限制在该作用域**永久**，必须一次给对。
- 一个 scope key 只能绑一次父作用域，试验脚本每个用例要新开 agent scope。
- 别用全局视图 `tools.get(name)` 判断存在性：预设注册的工具只在父作用域可见，会假阴性。
- `lib/` 是 gitignore 的构建产物，`link:` 的 profile 直接跑它；改 `src/` 后必须 `pnpm build`。

相关实现 [sessions.ts](../../src/app/sessions.ts)、用例 [runtime.spec.ts](../../tests/runtime.spec.ts)。
