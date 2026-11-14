# 2026-11-15 worker 会话不被 bili（billion-context）覆盖：restrict 掩掉 compress

表面错误是 `http 422 bili_gate_oversize_refusal_unattributed`，但根因不在网关配额。

## 根因

billion-context 判断「这段对话能否折叠」，依据是它的 `compress` 工具**有没有被声明在模型请求里**。
`agent.ctx.tools.restrict({ allow })` 会掩掉所有未被点名的全局工具，两份 allow list 因此都剪掉了
`compress` / `decompress` / `search_context`：router 是那 7 个固定名，worker 是 `WORK_TOOLS` 过滤后的子集。

工具本身正常（manifest 取到 3 个、日志 0 次注册失败），但请求上没见过 `compress` 就报 `surface=off`、
不注入压缩提示、永不折叠；上下文涨过模型窗口后被插件本地拒绝，整轮被杀。

生产旁证：`~/.local/state/billion-context/bili.log` 中 `surface=on` 计数 **0**、`surface=off` **948**，
即从未有过可压缩的线上声明；被拒的正是 `worker-a2cd8a72fd855ece3fdfe075915c96d7`。

## 修复

`src/app/sessions.ts` 新增 `COMPRESSION_TOOLS` 与 `compressionTools(agent)`：后者用
`scopeParentOf(agent)` 读宿主**真正注册过**的压缩工具（写法同 `WORK_TOOLS` 的过滤），两份 allow list 都追加。
只在宿主注册时才点名——`restrict` 遇到未知名字会拒绝整份 allow list，故无压缩插件的 profile 行为不变。

## 验证

在真实 DSH `dsh-tools` + `dsh-scope` 上四组对照，脚本与输出在 `docs/evidence/a2cd8a72fd855ece3fdfe075915c96d7/`：

| 场景 | 该 agent 视图里被声明的工具 |
| --- | --- |
| A 有插件，只给工作工具（今天的行为） | bash,grep,read,skill — 压缩三件被剪 |
| B 有插件，工作工具 + 已注册压缩工具 | 七件全保留 |
| C 无插件却无条件点名 | `restrict` 拒绝整份 allow list |
| D 无插件，过滤后点名 | 与原行为一致 |

再用插件 shipped gate 函数跑实测工具清单（`run.mjs`）：今天的 allow list `surfaceOn=false`；
追加三件后 `surfaceOn=true`。

```sh
node docs/evidence/a2cd8a72fd855ece3fdfe075915c96d7/registry-probe.mjs   # A–D 对照
node docs/evidence/a2cd8a72fd855ece3fdfe075915c96d7/run.mjs             # 线上 gate 判定
pnpm typecheck && pnpm test && pnpm build
```

基线 `8c32a9d` 与修复后同为 2 个失败，且是同样两条与本次无关的环境泄漏用例（`GIT_CONFIG_GLOBAL`
未还原）；新增回归用例通过。

## 残余风险

- **未在重启后的活实例验证**：跑着的 dsh 进程加载的是修复前 `lib/`，需重启；重启会掐掉在跑的
  orchestrator 会话，属需人决定的动作，本次没做。缺一条线上 `surface=on` 日志。
- **注册时序**：插件取完 manifest 才 `tools.register`；若 Session 在注册完成前被装饰，
  `compressionTools()` 为空，该会话仍是旧行为（不报错，只是没修好）。
- `lib/` 是 gitignore 的构建产物，`link:` profile 直接跑它，改 `src/` 后必须 `pnpm build`。

## 坑

- `tools.restrict()` 只能在 agent 作用域调用；限制在该作用域**永久**，无法「先试再撤」，必须一次给对。
- 一个 scope key 只能绑一次父作用域，试验脚本得每个用例新开 agent scope。
- 别用全局视图 `tools.get(name)` 判断存在性：预设里注册的工具只在父作用域可见，会假阴性。
