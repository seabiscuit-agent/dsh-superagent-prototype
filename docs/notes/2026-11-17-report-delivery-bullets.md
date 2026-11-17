# 报告交付：结论列点 + 数字可核实

## 根因

2026-11-17 的生产主会话里，一份 `state: ready` 的 worker 报告（ticket 9d6d4f…，报告为 PR #25）
已经以 `worker_report` 消息注入主会话，`summary` 第一段就是 owner 问的子代理答案；但主会话只回了
“评审结论已交付。报告本身在 [PR #25] 里……”，结论一条没列。

两层提示同时把交付压成一条链接：

- `prompts/replies.md`：“The orchestrator extracts delivery facts and writes a new notification; it must not forward the report or compress it point by point.”
- `prompts/team/communication.md`：“IM is a delivery notification, not a work report.” … “send one short sentence containing only the user-visible result, its link and any necessary next action.”

随后补发的答案里“两个子代理都跑了一小时”照抄了 worker 报告原文（实际 worker 会话 15 分 51 秒），
说明“数字从哪来、是否经过测量”也需要一条规则。

## 修复

- `prompts/replies.md`：允许“不粘贴报告”，但要求报告/评审/分析类交付先列结论短点，再给原报告链接；
  只有链接的交付算不完整。数字保留报告自带的支撑，未测量的数字不得当成事实转述。
- `prompts/team/communication.md`：把“IM 不是工作报告”改成带例外（报告交付要列结论点）；
  一句话默认规则加同一例外；新增“报告里的数量必须带证据来源，估计值要标注为估计”。

## 陷阱

- `src/app/prompts.ts` 的组装顺序是 communication → scope → delivery → … → replies，replies.md 在最后，
  只改团队段会留下更靠后的相反约束，两层必须一起改。
- replies.md 的 100 词硬上限与“不要用 bullet 列表规避上限”仍有效：结论列点必须放进同一条消息。
- 部署实例的 communication 来自 spawner 仓库的 `lib/settings-template.json` 快照，不是本文件；
  该仓库要同步同一规则（另开 PR）。

## 验证

```sh
cd /Users/seabiscuit/src/proto-report-delivery-fix-6d3fd98a91f8
npx vitest run tests/prompts.spec.ts tests/model-surface.spec.ts
node -e "..." # 可选：打印 composePrompt 大小核对风格预算
```

`tests/prompts.spec.ts` 新增契约测试；`tests/model-surface.spec.ts` 把 orchestrator 预算
60_500 提到 61_500（新增约束约 800 字符）。
