# 归档 schedule-source：规格并入 specs/

日期：2026-11-18；原变更：`openspec/changes/schedule-source/`（提案 PR #22、实施 PR #23）；
归档结果：`openspec/changes/archive/2026-11-18-schedule-source/` 与 `openspec/specs/schedule-source/spec.md`。

## 根因 / 背景

实施合并后变更目录仍停在 `openspec/changes/`，`openspec/specs/` 没有 `schedule-source`
能力规格；后续变更无法在一个稳定的规格基线上增量修改，`openspec list` 也持续把它算作
待完成变更。按工作流第 4 步，交付后用 `openspec archive` 把 delta spec 并入主规格并
把四件套移入 `changes/archive/`。

## 做法

- `openspec archive schedule-source -y`：校验任务状态为 Complete 后，新建
  `openspec/specs/schedule-source/spec.md`（7 条 Requirement），原目录整体移入
  `changes/archive/2026-11-18-schedule-source/`。
- 归档器生成的 Purpose 是 `TBD - created by archiving ...` 占位；按 proposal 手写成
  「只产生 Trigger、不建单、游标只补最近一档」的摘要，避免规格首屏是占位符。
- `openspec/changes/archive/ticket-timeline/spec.md` 的 Purpose 仍是 TBD，说明这是归档器
  的默认行为而不是本变更的疏漏；后续归档时顺手补写即可。

## 坑

- `npx -y openspec@latest` 报 `could not determine executable to run`：npm 上的 `openspec`
  是 0.0.0 空壳包，CLI 的包名是 `@fission-ai/openspec`。本机用全局 `openspec`
  （`@fission-ai/openspec@1.4.1`，在 `~/.nvm/.../bin/openspec`）即可。
- 归档会删掉 `changes/schedule-source/.openspec.yaml` 并在 archive 目录重建；`git status`
  同时显示删除与新增，属预期，不要手工搬目录替代 CLI。
- 只归档、不改代码时没有 UI 证据；校验以 `openspec validate --all --strict` 为准。

## 验证

```bash
cd /Users/seabiscuit/src/archive-schedule-source-338f77215f92
openspec validate --all --strict   # 8 passed, 0 failed
openspec list                      # schedule-source 不再列为待完成变更
git status --short                 # 仅 openspec/ 与 docs/notes/ 改动
```
