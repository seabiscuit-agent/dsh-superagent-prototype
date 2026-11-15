> 本工单授权范围是 **Explore + Propose**：只交付文档。
> 第 1 阶段（已经成立的骨架与四份提案文档）在本工单完成并勾选；
> 第 2–4 阶段是**后续 Apply 工单**的实施清单，本工单不实现、不勾选，留给新会话
> 只读本目录即可接手。勾选框格式 `- [ ] X.Y` 供 `openspec list` 统计进度。

## 1. 落盘 OpenSpec 骨架与提案（本工单，文档变更）

- [x] 1.1 用 `openspec init --tools none` 建 `openspec/{specs,changes/archive}`；手工补
  `config.yaml`（点明被描述系统就是本仓库 prototype 的实现）与 `README.md`。
  验证：`openspec --version` → `1.4.1`；`find openspec -maxdepth 2 -type d` 含三段目录。
- [x] 1.2 `openspec new change local-dispatch-source` 生成 `.openspec.yaml` 与
  change README。验证：`cat openspec/changes/local-dispatch-source/.openspec.yaml` →
  `schema: spec-driven` + `created: 2026-11-15`。
- [x] 1.3 拷贝 `SPEC_TEMPLATE.md` / `CHANGE_TEMPLATE.md` / `specs/README.md` 三个空模板，
  并建 `changes/archive/.gitkeep`。验证：`openspec list --specs` 不把它们当能力。
- [x] 1.4 写 `proposal.md`：Why / What Changes / Capabilities / 明确不做 /
  11 条可复现验收标准 / Impact。验证：验收项含命令与期望字段，并点名实例
  `superagent :3082`。
- [x] 1.5 写 `specs/local-dispatch-source/spec.md` delta：6 条 `### Requirement:`、
  正文含 SHALL/MUST、每条至少一个四个 `#` 的 `#### Scenario:`（共 16 个场景），覆盖失败路径
  （来源不合规、回声、未确认、显式 hold、重复 Apply、飞书关闭）。
  验证：`openspec validate local-dispatch-source --strict` 无「must include at least one scenario」。
- [x] 1.6 写 `design.md`：Context 三栏现状 + file:line 证据、Goals/Non-Goals、
  6 个决策（含备选与否决理由）、Risks、Migration Plan、5 个 Open Questions。
  验证：新会话只读四份文档能复述 intake 落点、授权取值、Apply→accept、回写通道、飞书可选。
- [x] 1.7 写 `tasks.md`（本文件）与知识笔记
  `docs/notes/2026-11-15-local-dispatch-source-openspec-proposal.md`（< 60 行，含根因 /
  产物 / 坑 / 验证命令，链接相关文件）。验证：文件存在且行数 < 60。
- [x] 1.8 `openspec validate --all --strict` 退出 0；`openspec status --change
  local-dispatch-source` 显示 `4/4 artifacts complete`；`pnpm build` 退出 0
  （纯文档，不应破坏构建）。验证：三条命令的退出码。

## 2. 实现 `local` Source kind（后续 Apply 工单，未授权）

- [x] 2.1 在本仓库新建 `src/sources/local.ts`，声明 `SourceKind`：`kind: 'local'`、
  schema / fields / health、`policy`（`allowed` 首位 + `explicit`）、`scope`，省略
  `environment` / `refreshLabels`（`channel` 按 3.6 / OQ#1 结论改为 no-op channel：
  `send → 'sent'`，详见 `design.md`）。验证：`node --test` 单测能
  `localKind.schema.parse({})` 并断言 `kind === 'local'`、无 `channel`。
- [x] 2.2 `apply` 里 `ctx.effect(() => ctx.orchestrator.sources.register(localKind),
  'local: source kind')` 注入 `orchestrator`。验证：`GET sources` 含 `id: "local"` 且
  `state` 为 `ready`（验收项 4）。
- [x] 2.3 对每条所有者人消息造确定性 `id = key('local', messageId)`，填
  `source: 'local'`、`human: true`、`addressed: 'direct'`、`actor: {source:'local', id:…}`、
  `threads` 至少一个 `ThreadRef`、`at`、`text`、`meta`。
  验证：同 `messageId` 连发两次 → `Intake.receive` 第二次返回 `'duplicate'`（验收项 8）。

## 3. 主会话 intake 与授权（后续 Apply 工单，未授权）

- [x] 3.1 在 `src/app` 组合根（Runtime / `Sessions.install` 附近）装 `session/event`
  监听器：只认 `masterId` 会话的 `user/message`，只接 `source.kind === 'user'` /
  `user-rpc`，过滤 `dsh-superagent` 注入；尊重 `quiet` 守卫；不放在 `src/sources`。
  验证：连续注入 20 条 candidate card / notice 后 `GET sources` 的 `local.filtered`
  等于注入数、`GET tickets?state=open` 不变（验收项 9）。
- [x] 3.2 把过滤后的消息经 `SourceContext.receive` / `runtime.receive(trigger)` 入域，
  不新增 Engine 端点、不重入事务里等异步投递。验证：发无 @ 需求后立即出现
  `strength: "explicit"` 候选卡，`GET tickets?state=open` 不变（验收项 6）。
- [x] 3.3 把所有者稳定 `actor.id` 预置进 `policy.sources.local.allowed`，`local`
  scope 返回 `listened: true`；不改 `eval.mode`，不改 GitHub / Feishu 的 admission 表。
  验证：`GET settings` 的 `policy.sources.local.allowed` 含所有者，且候选 basis 为
  `via: "addressed"`（验收项 5、飞书开启时验收项「旧路径不变」）。
- [x] 3.4 在 `prompts/dispatch.md` 加 Apply→accept 段：把「落盘 / Apply」绑到当前未决
  显式候选的 `trigger_id`，`title` / `worktree_name` / `acknowledgement` 从原候选合成，
  保留「不扩写需求」约束。验证：`GET prompts` 的 `current.config` 含该段（验收项 11）；
  说「落盘」后 `GET tickets?state=open` 新增 running 工单、`GET decisions` 出现
  `accept`（验收项 7）。
- [x] 3.5 覆盖不派工路径：只发需求 / 问状态 / 闲聊 / 「先别做」不 accept；显式 hold
  未解除时 Apply 不建单；重复 Apply 幂等。验证：`GET decisions` 无对应 `accept`，
  `GET tickets?state=open` 数量不变（验收项 8 与规格失败路径）。
- [x] 3.6 解决 Open Question #1（回写通道）：no-op `channel.send` 返回 `'sent'`，或
  `src/app` 的 steering 路径，二选一并把结论写回 `design.md`。
  验证：工单 ready / human_action 时文本出现在主会话同一会话里，而非 Outbox 静默丢弃。

## 4. 生产验证、配置继承与归档（后续 Apply 工单 / 由人操作）

- [x] 4.1 解决 Open Question #2（`'local'` 是否进 `sourceSkills` / `composeSkill` /
  `bindSkills` / `SETUP_FIELDS`）与 #3（多张未决候选的关联规则）、#4（GUI 所有者
  `actor.id` 取值），把结论写回 `design.md`。验证：`design.md` 的 Open Questions
  相应条目被删除或标注结论。
- [x] 4.2 把 `source:local` 与 `policy.sources.local` 默认值写进 spawner 的
  settings-template-layer 模板。验证：新建实例后 `GET settings` 直接含所有者
  allowed 列表，无需手工补配。（spawner PR seabiscuit-agent/dsh-superagent-spawner#14，
  已合并 cac8b50：模板 `blocks.policy.sources.local` 预置 owner；`source:local` 条目
  本身由插件代码注册，模板不需要。生产证据见 docs/evidence/95a77ca9edd779c4e91aa98939192d08/，
  新实例 factory-check 出厂即含该列表。）
- [x] 4.3 `PUT settings/source:feishu` 设 `enabled: false` 并
  `scripts/dsh-superagent --profile superagent restart`。验证：`GET sources` 中 feishu
  为 `off` 而非 `error`，重复验收项 6–7 仍成功建单（验收项 10）。（22:30 PUT
  rev3→4 saved；重启后 feishu=off、github/local=ready；本工单后续多条主会话消息
  继续建单/跟进，证据同上目录。）
- [x] 4.4 在宿主实例 `superagent :3082` 逐条跑 proposal.md 验收项 4–11，把命令与
  输出贴进 PR 描述。由人操作：确认「主会话无 @ 发需求 → 落盘 → 工单跑完」全过程
  没有点击任何按钮。验证：11 条验收项全部有生产证据。（宿主 22:34 重启加载 0.9.12
  后采集；矩阵见 docs/evidence/95a77ca9edd779c4e91aa98939192d08/README.md。验收项 11
  如实记录差异：Apply→accept 段在 runtime 默认 prompts/dispatch.md，不在
  current.config overlay，defaultChanged=[]。）
- [x] 4.5 `openspec archive local-dispatch-source --yes` 归档，delta 合并进
  `openspec/specs/local-dispatch-source/spec.md`。验证：`openspec list --specs` 出现
  该能力且 `openspec validate --all --strict` 仍退出 0。（本 PR 即归档提交。）
