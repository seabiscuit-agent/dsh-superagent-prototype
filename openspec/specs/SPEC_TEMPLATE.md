# <capability> Specification

> 用法：复制为 `specs/<capability>/spec.md`（`<capability>` 用 kebab-case），替换所有 `<...>` 占位。
> 归档时 `openspec archive` 会用 delta 的 `## Purpose` 覆盖这里的 Purpose（新能力），或原样保留
> （已存在的能力）。文件名必须是 `spec.md`，`README.md`/`*_TEMPLATE.md` 不会被当作能力。

## Purpose

<一两句话说明这个能力覆盖什么行为。少于 50 字符只是 WARNING，但 --strict 下会让校验退出码为 1，
所以写完整句子。>

## Requirements

### Requirement: <需求名>

The system SHALL <可观察的行为>。

#### Scenario: <场景名>

- **GIVEN** <前置状态>
- **WHEN** <触发的动作或条件>
- **THEN** <可判定的结果>
- **AND** <同一结果的另一条断言，可省略>

<!-- 复制上面这一组 ### Requirement + #### Scenario 展开更多需求。
     约束（openspec validate 会检查）：
     - 正文必须含 SHALL / MUST（SHOULD / MAY 在 delta 里会被拒）
     - 每条需求至少一个 #### Scenario（四个 #）
     - 场景标题写清这个用例是什么，不要写 "Test 2" -->
