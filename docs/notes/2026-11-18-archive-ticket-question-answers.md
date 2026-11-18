# 归档 ticket-question-answers：规格并入 specs/

日期：2026-11-18；原变更：`openspec/changes/ticket-question-answers/`（提案 PR #28、实施 PR #29，
实施提交 `08b265b`）；归档结果：`openspec/changes/archive/2026-11-18-ticket-question-answers/`
与 `openspec/specs/ticket-question-answers/spec.md`。

## 根因 / 背景

实施合并后变更目录仍停在 `openspec/changes/`，`openspec/specs/` 没有
`ticket-question-answers` 能力规格，完成的任务清单被算作「仍在进行」，后续要改答案槽、
撤回窗口或更正语义时没有稳定规格基线可增量修改。

## 做法

- 确认归档前提：`openspec status --change ticket-question-answers` 为 4/4 artifacts，
  `tasks.md` 37 项全部勾选，实施 PR #29 已合并。
- `openspec archive ticket-question-answers -y`：新建
  `openspec/specs/ticket-question-answers/spec.md`（7 条 Requirement：面板显示、点选即答、
  单答案槽先到先算、投递前撤回、超时更正、可观察性与审计、授权与重启），原目录移入
  `changes/archive/2026-11-18-ticket-question-answers/`。
- 归档器生成的 Purpose 是 `TBD - created by archiving ...` 占位，按 proposal 手写为「面板点选、
  先到先算、15 秒撤回、超时更正」摘要。
- `openspec/README.md` 状态表把 `ticket-question-answers` 从「已实施完成、尚未归档」移到
  「已归档能力」。

## 坑

- `npx -y openspec@latest` 不可用（npm 上 `openspec` 是空壳包，CLI 包名
  `@fission-ai/openspec`）；本机直接用全局 `openspec`（1.4.1）。
- `openspec archive -y` 只给任务完成度提示，不会替你判断验收是否真的做过；归档前必须核对
  `tasks.md` 与实施 PR 的验证记录。
- 归档后 `git status` 同时显示原目录删除与 archive 新增，属预期，不要手工搬目录替代 CLI。
- 本次只改文档、不动运行时代码，没有 UI 变更，因此 PR 不需要 Before/After 截图。

## 验证

```bash
cd /Users/seabiscuit/src/archive-question-answers-0f1054a82270
openspec validate --all --strict   # 10 passed, 0 failed
openspec list                      # ticket-question-answers 不再列为进行中变更
openspec status                    # 只保留尚未归档的变更
git status --short                 # 仅 openspec/ 与 docs/notes/ 改动
```
