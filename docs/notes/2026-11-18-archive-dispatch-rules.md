# 归档 dispatch-rules：规格并入 specs/

日期：2026-11-18；原变更：`openspec/changes/dispatch-rules/`（提案 PR #25、实施 PR #26，实施提交
`b71c559`）；归档结果：`openspec/changes/archive/2026-11-18-dispatch-rules/` 与
`openspec/specs/dispatch-rules/spec.md`。

## 根因 / 背景

实施合并后变更目录仍停在 `openspec/changes/`，`openspec/specs/` 没有 `dispatch-rules` 能力规格；
`openspec list` 一直把已完成变更算作 `0/35 tasks`，后续变更也无法在稳定规格基线上增量修改。
owner 要求先归档，功能本身的调整另开讨论。

## 做法

- 先按实施提交 `b71c559` 与 PR #26 的验证记录勾选 `tasks.md`：1.x–5.x、6.1–6.4、6.6 共 34 项；
  6.5（生产实例 `127.0.0.1:3082` 实测 schedule 规则到点建单）本次未复测，保留未勾选，并在
  archive 的 `README.md` 里写明原因。
- `openspec archive dispatch-rules -y`：新建 `openspec/specs/dispatch-rules/spec.md`（9 条 Requirement），
  原目录移入 `changes/archive/2026-11-18-dispatch-rules/`。
- 归档器生成的 Purpose 是 `TBD - created by archiving ...` 占位，按 proposal 手写为「事件声明 + 唯一
  命中直通 + 回退/容量/重新校验」摘要。
- `openspec/README.md` 状态表把 `dispatch-rules` 从「待评审的提案」移到「已归档能力」。

## 坑

- `npx -y openspec@latest` 报 `could not determine executable to run`：npm 上的 `openspec` 是空壳包，
  CLI 包名是 `@fission-ai/openspec`；本机直接用全局 `openspec`（1.4.1）。
- `openspec archive -y` 对未完成任务只给 Warning 并继续（`Task status: 34/35`），不会替你判断验收是否
  真的做过；勾选必须逐项对证据。
- 归档后 `git status` 同时显示原目录删除与 archive 新增，属预期，不要手工搬目录替代 CLI。
- 本次只改文档、不动运行时代码，没有 UI 变更，因此 PR 不需要 Before/After 截图。

## 验证

```bash
cd /Users/seabiscuit/src/archive-dispatch-rules-b26e1e694a46
openspec validate --all --strict   # 9 passed, 0 failed
openspec list                      # dispatch-rules 不再列为待完成变更
openspec status                    # dispatch-rules 只出现在 specs/
git status --short                 # 仅 openspec/ 与 docs/notes/ 改动
```
