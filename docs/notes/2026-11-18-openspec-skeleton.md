# OpenSpec 骨架与 openspec-workflow skill 对齐

日期：2026-11-18；变更目录：`openspec/`（无运行时代码改动）。

## 背景与根因

所有者要求「先找有没有 openspec 模板 skill，有就按它把 openspec 骨架初始化出来」。核实结果：

- skill 存在：`~/.agents/skills/openspec-workflow/SKILL.md`，携带 `templates/{SPEC_TEMPLATE.md,CHANGE_TEMPLATE.md}`。
- 本仓骨架**早已存在**（2026-11-15 起，`openspec/{config.yaml,README.md,specs,changes}`），两个模板与 skill 逐字节一致，
  `openspec init --tools none` 重跑幂等（`Config: openspec/config.yaml (exists)`，工作区无改动）。
- 骨架「在」但没通过 skill 要求的 `validate --all --strict`：latest CLI（`@fission-ai/openspec` 2.1.0）
  对归档合并出的 `openspec/specs/local-dispatch-source/spec.md` 报 WARNING——`## Purpose` 仍是
  `TBD - created by archiving change …` 占位，strict 下退出码 1。1.4.1 不报，所以此前一直显示 6 passed。

## 修复

- `openspec/specs/local-dispatch-source/spec.md`：把 `## Purpose` 换成归档 delta 里的真实描述
  （主会话人消息成 `local` 显式候选、Apply 复用 `orchestrator_route kind accept` 原子建单、不需要 @ 与按钮）。
  主 spec 的 Purpose 只能手改；delta 里的 Purpose 只在创建能力时被读取，归档不会覆盖它。
- `openspec/changes/on-demand-routing/.openspec.yaml`：补 `schema: spec-driven` + `created: 2026-11-17`，
  与其余 4 个 change 一致（缺失时校验仍过，但 `openspec status` 语义不齐）。
- `openspec/README.md`：「当前进行中的变更」原来只写已归档的 `local-dispatch-source`，改为按
  已归档能力 / 已实施未归档 / 仍在进行三栏列出。
- 根 `README.md`：新增 `## Specifications` 一节指向 `openspec/README.md`（skill「复用」节要求新仓库
  在 README 写一节指向 `openspec/`，此前完全没有）。

## 坑

- `npx -y openspec@latest` 会装到空的 `openspec` 包（0.0.0）并报 `could not determine executable to run`；
  用 `npx -y @fission-ai/openspec@latest` 或已装的 `openspec` 1.4.1。
- 1.4.1 与 2.1.0 对 Purpose 占位的判定不同：只有 2.1.0 在 `--strict` 下报错。CI 若用 latest 会突然变红，
  所以文档里固定写 `@fission-ai/openspec@latest`。
- 2.1.0 的 `init --tools none` 只生成 `openspec/{config.yaml,changes,archive,specs/.gitkeep}`，
  不生成 `README.md`/两个模板；模板仍来自 skill。
- 场景标题必须四个 `#`（2.1.0 下 `### Scenario:` 会被忽略并报「需求没有场景」）；需求正文首行需 SHALL/MUST。

## 验证

```sh
npx -y @fission-ai/openspec@latest validate --all --strict   # 6 passed, 0 failed（exit 0）
openspec validate --all --strict                              # 1.4.1，同样 6 passed
openspec list                                                 # 5 个 change 的进度
openspec init --tools none && git status --short               # 幂等，无改动
env -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_NOSYSTEM pnpm typecheck # tsc --noEmit 通过
env -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_NOSYSTEM pnpm test      # 1295 passed
```

注意：本仓测试 `tests/runtime.spec.ts` 会断言进程环境变量被还原，agent 运行环境注入的
`GIT_CONFIG_GLOBAL` 会让它误报 2 例失败；跑测试前 unset 它即可，与本改动无关。
