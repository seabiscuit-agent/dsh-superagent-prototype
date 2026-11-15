# specs/ — 源规格（source of truth）

这里存放**当前已经成立**的系统行为，按能力（capability）分目录：

```
openspec/specs/<capability>/spec.md
```

- 本目录不手写新行为：新行为先写成 `openspec/changes/<change>/specs/<capability>/spec.md`
  里的 delta，实施并归档后由 `openspec archive` 合并进来。
- 能力名用 kebab-case（如 `user-auth`、`data-export`），同一能力只对应一个目录。
- 规格格式：`## Purpose` + `## Requirements`，每条 `### Requirement:` 至少带一个
  `#### Scenario:`（四个 `#`，GIVEN/WHEN/THEN 列表）。
- 新建能力：复制 `SPEC_TEMPLATE.md` 成 `<capability>/spec.md`。`README.md` 与
  `*_TEMPLATE.md` 不会被当作能力，可以长期留在仓库里。
- 还没有已归档能力时，`openspec list --specs` 输出 `No specs found.`——这是正常状态。
