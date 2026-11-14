# 2026-11-15 worker 会话不被 bili（billion-context）覆盖：restrict 掩掉 compress

结论分两段：**restrict 掩掉 compress 这一段已证实**；**「因此导致长任务被 422 拒」这一段证据不足**，
观测到的那次拒绝走的是另一条分支。下面是证据边界。

## 已证实：restrict 会把宿主的压缩工具剪掉

billion-context 判断「能否折叠」，依据是它的 `compress` 有没有被声明在模型请求里。
`agent.ctx.tools.restrict({ allow })` 会掩掉所有未被点名的全局工具，两份 allow list 都剪掉了
`compress` / `decompress` / `search_context`：router 是 7 个固定名，worker 是 `WORK_TOOLS` 的子集。

真实 DSH `dsh-tools` + `dsh-scope` 四组对照（`docs/evidence/a2cd8a72fd855ece3fdfe075915c96d7/`）：

| 场景 | 该 agent 视图中被声明的工具 |
| --- | --- |
| A 有插件，只给工作工具（今天的行为） | bash,grep,read,skill — 压缩三件被剪 |
| B 有插件，工作工具 + 已注册压缩工具 | 七件全部保留 |
| C 无插件却无条件点名 | `restrict` 拒绝整份 allow list |
| D 无插件，过滤后点名 | 与原行为一致 |

插件 shipped 的 gate 函数跑实测工具清单：今天 `surfaceOn=false`（压缩提示被抑制）；追加三件后
`surfaceOn=true`。生产日志 948 条 surface 判定**全是 `surface=off`，`surface=on` 为 0**，与此一致。

修复即 `compressionTools(agent)`：经 `scopeParentOf(agent)` 只取宿主真正注册过的那些（避免 C 的
整份拒绝），随两份 allow list 一起保留。

## 未证实：这次 422 不是 compress-surface 分支

杀掉本工单前一个 worker 的那条是 **`bili_gate_oversize_refusal_unattributed`**，来自 `dsh-client`
层（无 `sess=` 前缀），其自带说明指向的是**归属**（"not attributed to any bili-managed session"），
而不是压缩面。同一瞬间：

- 插件自己的账：`nudge idle: usage=32% (238235/750000)` — 认为离窗口还很远；
- 字节保守计价：`est ~1,000,901 tok … core 3,511,932B`，乐观下界 877,983 仍在窗口下。

另有一条与之同源的通道：`model request sent DIRECT (uncompressed) — no active initiator attribution`
共 89 次，同样无 `sess=`，即这些模型请求根本没进 bili 的归因/折叠路径。

所以「压缩面被关 → 从不折叠 → 上下文涨过窗口 → 422」只是**部分成立**：前半段有硬证据，后半段与
日志里插件自报的 32% 冲突，至少还叠加了「未归因通道」或「按字节保守计价把 3.3MiB 请求算成 1M tok」
中的一个。要分清必须做重启实验（见下），静态证据不能定论。

## 验证

```sh
node docs/evidence/a2cd8a72fd855ece3fdfe075915c96d7/registry-probe.mjs   # A–D 对照
node docs/evidence/a2cd8a72fd855ece3fdfe075915c96d7/scope-restrict.mjs   # 全局视图 vs agent 视图
node docs/evidence/a2cd8a72fd855ece3fdfe075915c96d7/run.mjs             # 线上 gate 判定
pnpm typecheck && pnpm test && pnpm build
```

基线 `8c32a9d` 与修复后同为 2 个失败，且是同样两条与本次无关的环境泄漏用例（`GIT_CONFIG_GLOBAL`
未还原）；新增回归用例通过。

## 待做（需人决定）

要拿到「修复后真的 `surface=on` 且长任务不再被拒」的线上证据，必须重启 superagent 实例——它会
掐断当前正在跑的 orchestrator/worker 会话（包括执行本工单的会话），所以没有自动执行。重启后应看到：
`bili.log` 出现 `surface=on`、`compress` 出现在请求的 tools 里、以及被拒次数不再增长。若重启后
`surface=on` 出现但 422 仍复发，则第二成因确认在归因/计价一侧，应另开一单。

## 坑

- `tools.restrict()` 只能在 agent 作用域调用；限制在该作用域**永久**，无法「先试再撤」，必须一次给对。
- 一个 scope key 只能绑一次父作用域，试验脚本每个用例要新开 agent scope。
- 别用全局视图 `tools.get(name)` 判断存在性：预设里注册的工具只在父作用域可见，会假阴性。
- `lib/` 是 gitignore 的构建产物，`link:` 的 profile 直接跑它；改 `src/` 后必须 `pnpm build`。
