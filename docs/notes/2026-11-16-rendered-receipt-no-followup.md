# 2026-11-16 渲染回执后 orchestrator 又发一条转述：dispatch 补一句硬规则

## 根因

宿主 PR #6 让 local 回执以 notice row 渲染进主会话后，owner 在宿主和新实例都看到
"一个问题下面有两个回答"：回执行 + orchestrator 自己紧跟的一条转述/已发出式备注
（宿主 14:36 抱怨的「已收口…」，实例 13:32/13:44/13:51 的整段复述，14:14 起的
「已把两个选择发给你了…」）。dispatch.md 原句只说 "never repeat a reply the panel
already rendered"，flash 档模型把"换个说法"当成不重复。

## 修复

`prompts/dispatch.md` 在原句后补一行（同段）：

> A rendered receipt is already delivered to the owner: follow it with no message
> of your own — no paraphrase, no summary, no 已发出-style note; speak again only
> when the owner asks something the receipt does not answer.

prompts/ 由 `packaged()` 在插件模块加载时从磁盘读（`const guides = promptFile(...)`），
无需重编 lib；宿主/实例进程重启后生效。

## 验证

- `node -e` 按 promptFile 的段落拼接规则重放 dispatch.md，新句落在 local Source 段内。
- 行为验证：进程重启后观察主会话不再出现回执后的转述/备注消息。

相关：dsh-superagent-spawner PR #16（子 patch 带上 superagentSource，修实例侧自愈）；
docs/notes/2026-11-16-local-outbox-render.md（渲染机制本身）。
