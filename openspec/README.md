# OpenSpec — 编排层设计提案

本目录用 [OpenSpec](https://github.com/Fission-AI/OpenSpec)（CLI `openspec`，schema `spec-driven`）
记录「DSH Super Agent 编排层」的设计提案。**被描述的系统就是本仓库**
`dsh-superagent-prototype`（宿主实例 `superagent :3082` 加载的实现）；提案与实现同仓，
便于规格随代码一起演进。提案（Explore + Propose 阶段）是文档，落盘在本仓库的 `openspec/`
与 `docs/notes/` 下供所有者评审；本阶段不改动任何运行时代码或 UI。

```
openspec/
├── config.yaml                    # 项目上下文与写作规则（openspec init 后手工补充）
├── README.md                      # 本文件
├── specs/                         # 源规格：现在已经成立的行为
│   ├── README.md
│   ├── SPEC_TEMPLATE.md           # 空模板，validate --all 会忽略
│   └── <capability>/spec.md
└── changes/                       # 提案，一份变更一个目录
    ├── CHANGE_TEMPLATE.md         # 空模板，四段写法骨架
    ├── archive/                   # 归档（.gitkeep 保证空目录进 git）
    └── <change-name>/
        ├── .openspec.yaml         # schema + 创建日期
        ├── proposal.md            # Why / What Changes / Capabilities / 明确不做 / 验收标准 / Impact
        ├── specs/<capability>/spec.md  # delta：ADDED / MODIFIED / REMOVED
        ├── design.md              # 机制、决策、取舍、风险、回滚
        └── tasks.md               # 可勾选的实施清单
```

当前状态（以 `openspec list` 为准）：

- 已归档能力：`local-dispatch-source`（`specs/local-dispatch-source/spec.md`）—— 主会话消息即候选、
  Apply 触发即派工、不引入 @ 与按钮、飞书降为可选通道。
- 已实施完成、尚未归档的变更：`ticket-agenda`（agenda 定时唤醒）、`host-owned-mechanics`
  （结果/答复回执由宿主合成、派工前缀）、`resume-master-turn-after-restart`（重启后续跑被切断的主会话回合）。
- 已实施完成、尚未归档的变更：`ticket-timeline`（工单事实链：面板折叠时间线、`why` 命令、
  `ticket/<id>/timeline` 读取资源，旧工单按需回填并标 `derived`；schema 12 只建 `fact` 表）。
- 仍在进行的变更：`on-demand-routing`（主会话按需建单与撤订路由）、`orchestrator-consult`
  （worker 先问 orchestrator、超授权再升级为人）。

## 流程：探索 → 提案 → 实施 → 归档

| 步骤 | 谁做 | 命令 / 动作 | 产物 |
| --- | --- | --- | --- |
| 探索 | 主会话 | 直接对话，只出结论不写代码 | 一段结论 |
| 提案 | worker | `openspec new change <name>`；按 `CHANGE_TEMPLATE.md` 写四段 | `openspec/changes/<name>/` |
| 校验 | 任何人 | `openspec validate <name> --strict` | 通过 / 错误清单 |
| 实施 | worker | 按 tasks.md 逐项做，做完勾选 `- [x]` | 代码改动 + 勾选 |
| 归档 | 维护者 | `openspec archive <name> --yes` | specs 更新 + 移入 archive |

## 硬规矩

- **先提案再动代码**：写清「目标 / 范围 / 明确不做 / 验收清单」，验收项必须能在真实环境复现
  （命令、字段、期望值、哪台实例），不能只写「工作正常」。
- **一个变更一个意图**：一句话说不完就拆成多个 change。
- **delta 只改它声明的东西**：新增 `## ADDED Requirements`；改既有行为用
  `## MODIFIED Requirements` 并抄全整段；删除用 `## REMOVED Requirements` 并写 **Reason** / **Migration**。
- **场景标题必须四个 `#`**：CLI 1.4.1 不把 `### Scenario:`（三个）识别为场景，
  需求会被判「没有场景」而校验失败；每条需求至少一个场景。
- **需求正文必须含 SHALL / MUST**：`SHOULD` / `MAY` 在 delta 里会被拒。
- **`## Purpose` ≥ 50 字符**：少了只是 WARNING，但 `--strict` 下退出码为 1。
- **场景写失败路径**：来源不可读、重复消息、误触发、被显式停止都要有场景。
- **不做的事写进来**：「明确不做」与需求同等重要，避免提案被读成无限授权。
- **区分三栏现状**：已完成 / 已声称但生产失败（附证据）/ 未开始。
- **交接即验收**：新会话只读文档能否接手，是提案质量唯一可靠的测试。

## 常用命令

```sh
openspec list                     # 进行中的 change（含任务进度）
openspec list --specs             # 已归档能力及其需求数
openspec show <name>              # 查看 change 或 spec
openspec validate --all --strict  # 校验全部（提交前必跑）
openspec status --change <name>   # 规划产物完成度（4/4 才算齐）
openspec archive <name> --yes     # 合并 delta 并归档
```

## 工具接入

初始化用 `openspec init --tools none`；`openspec init --tools <tool>` 生成的 `.claude/` /
`.codex/` 等目录只在本机用，不要提交。
