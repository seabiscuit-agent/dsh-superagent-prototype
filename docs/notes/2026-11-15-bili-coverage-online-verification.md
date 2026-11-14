# 2026-11-15 线上验证：压缩面已随重启生效；0.9.7 五项继承逐条结论

承接 [restrict 掩掉 compress](2026-11-15-bili-worker-compression-coverage.md)。宿主 superagent
于 `2026-11-15T04:34:48` 重启（此前那次「需人决定是否重启」已由人执行），本文记录重启后的实测。

## 结论

1. **压缩面生效**：worker 会话能折叠、nudge 能注入，`surface=off` 归零。
2. **五项继承**：密钥、登录态、eval/executor、agent CLI 成立；**模型目录与启停对两个旧实例失败**，
   原因不是 0.9.7 代码，而是共享层清单退化（见下）。

## 压缩面（`~/.local/state/billion-context/bili.log`，以重启时刻切分）

| | 行数 | surface=off | surface=on | nudge INJECT | oversize_refusal | DIRECT |
| --- | --- | --- | --- | --- | --- | --- |
| 重启前 | 26651 | 1021 | 0 | 0 | 3 | 93 |
| 重启后 | 7458 | **0** | 0 | **11** | 0 | 25 |

`surface=off` 只在「面为 OFF 且本应注入」时打日志（`surfaceOffDetail()` 首行
`if (d.compressSurfaceOn || !shouldInject) return void 0`），故「重启后 0 条」即每次判定都 ON。

**别拿日志里的 compress 字样当证据**：`top-level=[…]` 只在 surface=OFF 时打印，重启后一次都不打印；
重启前的「含 compress」行全是 nudge 文案 `max compressible N < threshold`，不是工具表。可用的硬证据是行为侧：
插件 shipped gate 在 work-only allow 下必 SUPPRESSED，重启后 nudge 连续 11 次 FIRES；
本工单会话（`worker-19628a72…`）自行 compress 7 次、折叠 493k tokens。

restart 后仍有 25 条 `model request sent DIRECT (uncompressed) — no active initiator attribution`，
与压缩面无关，归因侧问题仍在。

## 五项继承（0.9.7；`/orchestrator/api/settings` 与 `/orchestrator/api/models`）

| 项 | 结论 |
| --- | --- |
| 1 模型密钥 | 成立。四实例 `.credentials.yaml` 均 symlink 至宿主，refs 同为 `ZAI_API_KEY`/`OPENCODE_GO_API_KEY`；`apiKeyEnv` 一致；进程 env 里没有明文 key，走 refs 解析，创建日志无 `credentials:` 告警 |
| 2 模型目录与启停 | **两旧实例失败**：`superagent-2`/`inherit-nohost` 缺 `qoder-global`、`workbuddy` 两组 provider；`superagent-4`/`inherit-e2e` 与宿主全同 |
| 3 登录账号 | 成立。0.9.7 后实例的 `workbuddy-vault`、`.qoder-accounts.*`、`.qoder-pool.cn`、`.workbuddy-roster-seen.cn` 全 symlink；`.qoder-pool.global.json`/`.workbuddy-device.json` 逐实例独立（符合设计）。0.9.7 前实例仍是拷贝/缺失 |
| 4 eval/executor | 成立（`superagent-2`/`superagent-4`/`inherit-e2e` 与宿主按值全 SAME）；`inherit-nohost` executor 为 `model:null`，因其缺 workbuddy 适配器，`PUT /settings/executor → 400 no adapter registered` |
| 5 agent CLI | 成立。`cli=/Users/seabiscuit/.local/bin/gh-agent` 已继承（`superagent-2`、`inherit-e2e`）；`superagent-4`/`inherit-nohost` 因 `repository` 为空而延迟继承，日志写明 `github: deferred: … waits for one` |

## 第 2/4 项的真因：共享层清单退化，且不自愈

`~/dsh-instances/.shared/profile/package.json` 只有 **2 deps / 4 bundles**（宿主是 18/16），
mtime 与某次 create 同时。`template.js` 的 `sharedManifest()` 从 `hostManifest?.dependencies` 拷贝，
`readHostManifest()` 一旦抛错就 `return null`，两个 `?.` 让清单静默退化成「只有两个 link 包」，
随后 `pnpm install` 打出 `Packages: -138`。重建时 `hostManifest:null` 的输出与磁盘清单**逐字节相同**，
换成真实宿主清单则得 18/16 —— 即退化点就是那次读到 null，而非模板本身。

坏层不会自愈：`ensureSharedProfile()` 只在 `createJob` 调用；`startJob` 仅比较
`node_modules/.shared-layer-stamp` 与当前清单 sha1，坏层实例的 stamp 已等于坏清单 sha1，
重启永远判定「已同步」。`instances.json` 的 `sharedLayerStamp` 是登记值、可能滞后，不能当判据。
修法：让 `readHostManifest()` 失败时显式告警而非静默降级，并在 stamp 不匹配宿主真实清单时重装。

## 验证与坑

```sh
node docs/evidence/a2cd8a72fd855ece3fdfe075915c96d7/online-verify.mjs   # 本文全部数据
```

- 读 PR 要带 `--repo seabiscuit-agent/dsh-superagent-prototype`，否则因上游关闭 PR 报
  `GraphQL: Pull requests are disabled for this repository.`
- 插件仓 `lib/` 是构建产物，`link:` 的 profile 直接跑它；改 `src/` 后必须 `pnpm build` 并重启宿主。
