# 2026-11-15 worker 会话不被 bili（billion-context）覆盖：restrict 掩掉 compress

长任务被拒的表面错误是 `http 422 bili_gate_oversize_refusal_unattributed`，但根因不在网关配额，
而在 Session 的 `restrict({ allow })` 把宿主压缩插件的工具从线上声明里剪掉了。

## 根因

billion-context 判断「这段对话我能不能折叠」，依据是它的 `compress` 工具**有没有被声明在模型请求里**。
`agent.ctx.tools.restrict({ allow })` 会掩掉所有未被点名的全局工具，因此两份 allow list 都把
`compress` / `decompress` / `search_context` 剪掉了：

- router（主会话）：`['skill','bash','read','read_image','job_output','job_list','job_kill']`
- worker：`WORK_TOOLS` 过滤后的子集

插件的工具本身是好的（`tools.register` 正常、manifest 取到 3 个工具、日志里 0 次注册失败），
但请求上没见过 `compress` 就报 `surface=off`、不注入压缩提示、永不折叠。worker 上下文于是持续
增长到越过模型窗口，插件在本地按文本保守计价拒绝该请求，整轮任务被杀。

生产日志旁证：`~/.local/state/billion-context/bili.log` 里 `surface=on` 计数 **0**、
`surface=off` **948**（worker 8753 条、orchestrator 795 条会话上下文行），即从未有过可压缩的
线上声明。被拒的正是 `worker-a2cd8a72fd855ece3fdfe075915c96d7`（该会话最终 413/422 结束）。

## 修复

`src/app/sessions.ts`：新增 `COMPRESSION_TOOLS` 与 `compressionTools(agent)`，后者以
`scopeParentOf(agent)` 读到宿主真正注册过的压缩工具（写法与 `WORK_TOOLS` 的过滤一致），
router 与 worker 两份 allow list 都追加这段。**只在宿主真的注册时才点名**，因为
`restrict` 会拒绝任何未知名字并连带废掉整份 allow list；没有压缩插件的 profile 行为完全不变。

## 验证（本条最关键：静态读码不足以定论）

四项在真实 DSH `dsh-tools` + `dsh-scope` 上跑，脚本与输出见 `docs/evidence/a2cd8a72fd855ece3fdfe075915c96d7/`：

| 场景 | allow list | 该 agent 视图中被声明的工具 |
| --- | --- | --- |
| A 有插件，只给工作工具（今天的行为） | bash,read,grep,skill | bash,grep,read,skill — 压缩三件被剪 |
| B 有插件，工作工具 + 已注册压缩工具 | 加 compress,decompress,search_context | 七件全部保留 |
| C 无插件却无条件点名压缩工具 | 含未注册名字 | `restrict` 拒绝整份 allow list |
| D 无插件，过滤后点名 | bash,read,grep,skill | 与原行为一致 |

另外用插件的 shipped gate 函数跑实测工具清单（`run.mjs`）：今天的 allow list
`compress=false surfaceOn=false` → 压缩提示被抑制；追加三件后 `surfaceOn=true` → 提示生效。

```sh
node docs/evidence/a2cd8a72fd855ece3fdfe075915c96d7/registry-probe.mjs   # A–D 四组对照
node docs/evidence/a2cd8a72fd855ece3fdfe075915c96d7/run.mjs             # 线上 gate 判定
pnpm typecheck && pnpm test && pnpm build                              # 92 用例 + 构建
```

基线（`8c32a9d`）与修复后都是 2 个失败，且是**同样两条**与本次无关的环境泄漏用例
（`GIT_CONFIG_GLOBAL` 未被还原）；新增回归用例通过。

## 坑

- `tools.restrict()` 只能在 agent 作用域调用，全局上下文直接抛错；且限制在该作用域**永久**，
  没法和「先试再撤」的方式验证，必须一次给对 allow list。
- 一个 scope key 只能绑定一次父作用域，试验脚本必须每个用例新开一个 agent scope。
- 别用 `tools.get(name)`（全局视图）判断工具是否存在：预设里注册的工具只在父作用域可见，
  会得到假阴性。
- `lib/` 是 gitignore 的构建产物，但 profile 通过 `link:` 直接跑 `lib/index.js`——改完 `src/`
  必须 `pnpm build`，否则重启也不生效。
