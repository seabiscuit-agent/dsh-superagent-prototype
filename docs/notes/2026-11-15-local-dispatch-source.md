# local Source 收尾（模板层 + 生产验收 + 归档）

日期：2026-11-15 · 工单 95a77ca9edd779c4e91aa98939192d08 · 归档 PR：本提交所在 PR

## 根因与背景

主会话 GUI 作为 local Source 已上线（PR #4），但 spawner 的 settings 模板是快照，缺
`policy.sources.local`。子实例 runtime 虽会一次性预置 owner（`src/app/runtime.ts`
`presetLocalOwner`），但 spawner 每次启动把 policy 块**整块** PUT 进子实例，模板没有
local 节就会把预置覆盖掉——新实例所有者的主会话消息不再是显式候选。

## 修复

- spawner PR seabiscuit-agent/dsh-superagent-spawner#14（merged cac8b50）：用
  `scripts/capture-template.mjs` 重采集，模板 `blocks.policy.sources.local` 预置
  `{allowed:[{id:"owner",name:"Owner"}],admission:{}}`；顺带 executor 快照跟进宿主
  rev 22（workbuddy/hy4free → zai-coding-cn/glm-5.3，前者免费额度当日到期）；
  回归测试钉住该节存在。
- `source:local` 设置条目本身由插件代码注册，模板不携带也不需要。
- 宿主 feishu source `PUT enabled:false`（rev3→4），关闭后 off 非 error。

## 生产验收结论（详见 ../evidence/95a77ca9…/README.md）

- 宿主 22:34 重启加载 0.9.12 后：local ready；policy.sources.local 含 owner；
  本工单全程「无 @ 候选 → Apply 建单 → follow-up 落同单」即验收项 6–8 的活证据；
  回声走 filtered 不建单（项 9）；feishu off（项 10）。
- 验收项 11 差异（如实记录）：Apply→accept 段在仓库默认 `prompts/dispatch.md`
  （GET /prompts 的 runtime/dispatch part），不在 `current.config` overlay；
  `defaultChanged: []` 说明默认未被覆盖。
- 出厂核对：新实例 factory-check 模板直出 local owner allowed + 新 executor +
  prompts 与宿主相等；接上 repository 后 github/local 双 ready。子实例 spawner 插件
  的 self-heal 警告为无害噪音（子实例不自派工）。

## 踩坑

- 面板 `action=stop` 的 `name` 走 query string，POST JSON body 里它读不到（create 却读
  body）。
- repository 为空的实例 github 源显示 `error: Waiting for the deployment check`，并把
  local 源连带显示 `setup`——是全局 setup problem 的连锁，不是 local 自身故障。
- 子实例 github 手工 PUT 需带 `cli`（deferred 实例的 cli 为空串，会被
  `agentCliUnset` 拒绝）；部署校验要求 agent 账号对仓库有推送权（公共无权限仓库报
  `repositoryReadOnly`）。
- gh-agent token 无 delete_repo/admin 权限：临时核对仓库只能归档不能删。

## 验证命令

```bash
curl -s -H 'x-orchestrator-request: 1' http://127.0.0.1:3082/orchestrator/api/sources
curl -s -H 'x-orchestrator-request: 1' http://127.0.0.1:3082/orchestrator/api/settings
curl -s -H 'x-orchestrator-request: 1' http://127.0.0.1:3082/orchestrator/api/prompts | jq '.current.revision, .defaultChanged, [.parts[]|select(.key=="runtime/dispatch")].text'
# 面板（需 x-spawner-request: 1 + Origin 同源）
curl -s -H 'x-spawner-request: 1' -H 'Origin: http://127.0.0.1:3082' 'http://127.0.0.1:3082/dsh-superagent-spawner/api?action=info'
```

相关：`openspec/changes/archive/local-dispatch-source/`（本 PR 归档）、spawner
`openspec/changes/settings-template-layer/tasks.md` 1.4、
`src/sources/local.ts`、`src/app/runtime.ts`。
