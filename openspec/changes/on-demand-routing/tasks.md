## 1. 来源路由声明

- [x] 1.1 `SourceKind` 增加 `routing?: 'subscriptions' | 'on-demand'`，默认 `subscriptions`
- [x] 1.2 `SourceRegistry.routing(id)` 暴露路由方式
- [x] 1.3 local kind 声明 `routing: 'on-demand'`
- [x] 1.4 `EngineOptions.routing` 注入并在 `runtime.ts` 接线

## 2. 按需接收

- [x] 2.1 Intake 对 on-demand 来源跳过订阅 fanout，仍保存 trigger 并生成候选
- [x] 2.2 attach 仍订阅线程并唤醒工单，作为唯一投递通道

## 3. 结束撤订

- [x] 3.1 `Tickets.end` 对 on-demand 线程移除本工单订阅
- [x] 3.2 `thread.unsubscribed.by` 增加 `'ticket'`，`eventNotice` 对该值静默
- [x] 3.3 人为停止的工单保持 `attachable` 拒绝规则

## 4. 候选卡与提示词

- [x] 4.1 `links.endedOnThread` 把线程上已结束工单并入 `related_tickets`
- [x] 4.2 更新 admission/dispatch/orchestrator/subscriptions 提示词
- [x] 4.3 保持 orchestrator 提示词预算 60,500 不变

## 5. 验证

- [x] 5.1 `tests/local.spec.ts` 端到端：讨论不建单、结束撤订、候选卡含原单、attach 挂回
- [x] 5.2 `tests/cards.spec.ts`、`tests/model-surface.spec.ts` 契约与预算断言更新
- [ ] 5.3 `env -u GIT_CONFIG_GLOBAL pnpm check` 通过
- [ ] 5.4 `openspec validate --all --strict` 通过
- [ ] 5.5 写入 `docs/notes/2026-11-17-on-demand-routing.md`
