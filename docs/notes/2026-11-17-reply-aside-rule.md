# 2026-11-17 回复正文禁止括号旁注，没新信息就沉默

## 根因

- 编排器在主会话没有新进展时，发过「（无新增；…）」「（删框改动在办…）」这类纯括号占位消息。
  `prompts/replies.md`（`runtime/replies`，主会话和 worker 共读）只约束 reply 工具的用途、ack 和
  100 词上限，没有约束正文里的括号旁注，也没有明确「没有新信息就不要发」，所以每个新会话都会重犯。
- 只把括号去掉、继续发同样的占位内容，也不算解决；问题在于消息本身没有可执行的信息。

## 修复

- `prompts/replies.md`：新增一条硬约束——回复正文不塞括号旁注，状态、路径、保留意见和内部备注
  要写进它所属的句子或省略；没有新信息就保持沉默，去掉括号不等于把旁注变成回复。
- `tests/prompts.spec.ts`：新增契约测试，断言这条规则同时出现在主会话和 worker 合装后的 prompt 里。
- `tests/model-surface.spec.ts`：orchestrator 的字符预算 60_000 → 60_500，为新约束留出空间。
- 策略保存接口的序列化问题（`orchestrator_settings_save` 收到 JSON 字符串报
  `expected object, received string`）已由 PR #10（commit 8ee88b3）修复：`value` 改为 `z.unknown()`，
  `settingsValue()` 对字符串做 `JSON.parse`，非 JSON 给明确错误；`tests/tools.spec.ts` 有回归用例。
  本工单核实 main `b6b91d1` 已包含，不再重复修改。

## 坑

- 规则必须放进 built-in part（`prompts/replies.md`），不能只写团队 `communication`：新实例或团队覆盖
  都会把只存在于面板里的文字丢掉。
- prompt 文本计入 model-surface 的字符预算，改 `prompts/` 后必须跑该测试，否则只会看到预算超限。

## 验证

```sh
./node_modules/.bin/vitest run tests/prompts.spec.ts tests/model-surface.spec.ts tests/tools.spec.ts
```

- 54 个用例全部通过（含新增契约测试与 settings 字符串回归用例）。
