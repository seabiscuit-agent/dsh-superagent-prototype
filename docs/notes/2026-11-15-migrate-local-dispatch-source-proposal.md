# 迁入 local-dispatch-source 提案 — note

Ticket: df0fdc22c5fa4438852b3770edd256c7（触发 fe018e72ba5c55d97496cb4a32982b78，Feishu）

## 问题 / 根因

- `local-dispatch-source` OpenSpec 提案（PR #37 / c31f316）被放进了
  `seabiscuit0409/shipany-video-template`——一个 ShipAny SaaS 模板仓，与被描述系统
  `dsh-superagent-prototype` 无关。openspec/ 骨架、change 四份文档和知识笔记都落在错仓。
- 提案描述的是 prototype 的编排层架构决策，应与实现同仓，便于规格随代码演进。

## 改动

- 两仓各一个纯文档 PR：
  - shipany-video-template：删除整个 `openspec/` 与
    `docs/notes/2026-11-15-local-dispatch-source-openspec-proposal.md`（撤掉误加内容）。
  - dsh-superagent-prototype（fork `seabiscuit-agent/...`）：从 `fork/main` 拉分支，
    整体搬入 `openspec/` 与该 note，不改 `src/`、不改运行时。
- 迁仓时改写文档里「被描述系统在别仓、本仓只承载文档」的措辞为「提案与实现同仓」，
  涉及 `openspec/config.yaml`、`openspec/README.md`、
  `openspec/changes/local-dispatch-source/{proposal,design,tasks}.md` 与 note；
  修正 note 里的 `cd` 验证路径、补记迁仓与原仓撤销信息。delta spec 不依赖仓库名，未改。
- 新增本 note 记录迁仓本身；提案 note 保留并加注迁仓 Ticket。

## 坑

- 原仓工作区是 `git worktree`（`~/src/shipany-video-template/.git/worktrees/…`），
  两仓共用同一份 git 身份需各自 `git config user.*` 为 seabiscuit-agent。
- prototype 的 `fork` 远端（seabiscuit-agent）才是开 PR 的仓库；`origin` 指向
  `deepseek-ai/dsh-superagent-prototype`（只读上游）。PR 必须推到 `fork`、base `fork:main`。
- `openspec validate --all --strict` 依赖 `openspec/` 在仓库根，搬移后路径不变即通过；
  改仓库名相关文字不会破坏 delta spec（它不含仓库名）。
- 知识笔记硬约束 < 60 行：迁仓补记后一度到 61 行，合并「格式先例 / 配置继承」两行压回 59 行。

## 验证

```bash
# 迁入仓
cd /Users/seabiscuit/src/proto-migrate-proposal-df0fdc22c5fa
openspec validate --all --strict          # 1 passed, 0 failed
openspec status --change local-dispatch-source   # 4/4 artifacts complete
openspec list                            # 8/22 tasks
pnpm build                               # 纯文档，退出 0（不破坏构建）

# 撤出仓
cd /Users/seabiscuit/src/migrate-proposal-repo-df0fdc22c5fa
git status --short                       # 仅见 openspec/ 与 note 的删除
pnpm build                               # 退出 0
```

## 相关

- 迁入后的提案：`openspec/changes/local-dispatch-source/`
- 提案 note：`docs/notes/2026-11-15-local-dispatch-source-openspec-proposal.md`
- 原仓 PR #37：https://github.com/seabiscuit0409/shipany-video-template/pull/37
