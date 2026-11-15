# 变更模板（一个 change 一个目录，目标是一句话说得清的一个意图）

> 用法：`openspec new change <change-name>`（生成目录与 `.openspec.yaml`），然后按下面四段
> 分别落成 `proposal.md`、`specs/<capability>/spec.md`、`design.md`、`tasks.md`。
> 本文件本身是空模板，`openspec validate --all` 会忽略它，可以长期留在仓库里。
> 删除你不需要的文件（例如纯文档类的 change 可以没有 design.md，只是 artifacts 记 3/4）。

---

## 一、`proposal.md`

```markdown
## Why

<1-2 段：现状是什么、为什么现在要改。写清问题的具体表现（报错、日志、失败用例），不要只写"不够好"。>

## What Changes

- <具体列出新增/修改/删除的能力，按用户可观察的行为描述>

## Capabilities

### New Capabilities

- `<capability-name>`: <这个能力覆盖什么>

### Modified Capabilities

<只列需求层面发生变化的能力；没有就留空>

## 明确不做

- <把边界写死：什么不在本次范围，为什么>

## 验收标准

<每条都要能在真实环境复现：命令 + 期望输出/字段。避免"工作正常"。>

1. **<项>**：`<命令>` 输出 `<期望>`
2. …

## Impact

- <受影响的代码/配置/文档/外部系统>
```

---

## 二、`specs/<capability>/spec.md`（delta）

```markdown
## Purpose

<仅当这是新能力时写：一两句话说明用途，归档时会成为 specs 的 Purpose。>

## ADDED Requirements

### Requirement: <新行为>

The system SHALL <可观察的行为>。

#### Scenario: <场景名>（含失败路径）

- **WHEN** <条件>
- **THEN** <结果>

## MODIFIED Requirements

### Requirement: <既有行为>

<抄全整段新的版本，包括所有场景；不要只写变化的那一句。>

#### Scenario: <场景名>

- **WHEN** <条件>
- **THEN** <结果>

## REMOVED Requirements

### Requirement: <被删除的行为>

**Reason**: <为什么删>

**Migration**: <原来依赖它的人/代码怎么办>
```

---

## 三、`design.md`

```markdown
## Context

<现状、约束、相关文件；有实测证据就贴证据（日志行、接口返回）。>

## Goals / Non-Goals

**Goals:**

- <这个设计要达成的>

**Non-Goals:**

- <明确排除的>

## Decisions

### 1. <决策名>

<备选方案 A / B / C，选哪个、为什么，否决的理由。>

## Risks / Trade-offs

- **<风险>** → <缓解措施>

## Migration Plan

<上线步骤、回滚方式。>

## Open Questions

- <还不能定的问题>
```

---

## 四、`tasks.md`

```markdown
## 1. <阶段名>

- [ ] 1.1 <可验证的任务>
- [ ] 1.2 <可验证的任务>

## 2. <阶段名>

- [ ] 2.1 <可验证的任务>
```

<勾选框必须写成 `- [ ] X.Y`，`openspec list` 用这个统计进度；完成后改成 `- [x]`。>
