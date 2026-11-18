# 主会话创建后立即跑一个开场回合

## 结论

dsh-superagent 创建主会话只做了 `sessionController.create` + `rename`，从未跑回合。
DSH 的会话列表把「还没有 `turn/start`」的会话视为 blank
（`dsh-api-session-controller/lib/index.js:2654`），界面把 blank 会话的标题渲染为空串
并显示成「新会话」（`dsh-client-ui-workspace/lib/client.js:996-999`），还会隐藏
除当前选中外的 blank 会话（同文件 `:963-967`）。所以主会话明明建好了，owner 看到的是
一个空的「新会话」，像是初始化失败。

## 修复

`src/app/runtime.ts`：

- `initialize()` 里 `ensure` 返回主会话 agent，若其事件中还没有 `turn/start`，
  调用新增的 `openMainSession(master)`。
- `openMainSession` 用 `Sessions.prompt(masterId, ..., OPENING_NOTE, 'queue')` 送入一条
  中文开场消息，要求只回一句话确认主会话已就绪、不要调用工具。
- 这个回合是 awaited 的：`runtime.ready` 时开场消息已入 inbox 且持久化完成；
  失败只 `logger.warn`，不阻塞实例就绪。

`prompts/team/communication.md` 同时追加结论优先规则：先讲 worker 结论与 owner 可用的结果，
PR 链接本身不算结论；常规工程选择自己决定、给建议而不是选项菜单；只把产品行为、优先级、
成本/风险交给 owner。spawner 的 settings 模板同步了同样的文字。

## 坑

- 开场如果 fire-and-forget，会落在 `runtime.ready` 之后；测试在 ready 后清空投递，
  就看不到它，且顺序不确定。await 是必须的。
- 测试替身 `followup` 只把 agent 置为 `running`，没有回合结束；awaited 开场后
  `resumeMaster()` 因 `status !== 'idle'` 跳过恢复，恢复类测试断言 0 条投递。
  在 `beforeEach` 清空投递后把 master 状态改回 `idle` 即可（模拟开场回合结束）。
- 角色提示词有 1400 字符预算（`tests/cards.spec.ts`），规则放共享的
  `team/communication.md`，同时把 `tests/model-surface.spec.ts` 的预算调到
  orchestrator 62_100 / worker 41_200（实测 61,994 / 41,012）。
- 开场消息的 id 会经 `key()` 哈希成 `dsh-superagent:<hash>`，测试别断言原始 id。
- 只有 blank 会话需要开场；已有 `turn/start` 的会话重启用 `resumeMaster` 恢复，
  两条路径互斥，不会重复打招呼。

## 验证

```
env -u GIT_CONFIG_GLOBAL pnpm typecheck
env -u GIT_CONFIG_GLOBAL pnpm test    # 66 files / 1261 tests
env -u GIT_CONFIG_GLOBAL pnpm build
```

新增测试：`tests/runtime.spec.ts` 的「opens a main Session that never ran a turn with one greeting」
与「does not greet the main Session again once it has run a turn」。

界面取证：修复前 sidebar 只有「New Session」；用本地 stub 模型启动固定版后，
sidebar 显示 `dsh-superagent orchestrator` 并出现「主会话已就绪」。
截图在 `docs/evidence/9f41f8429cbab18d9bb548c9d6dfd500/`。
