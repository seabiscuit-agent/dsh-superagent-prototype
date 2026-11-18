# dispatch-rules

按规则派工：Source 声明的确定性事件（`schedule.fire`、`github.ci.*`）命中 `policy.dispatch.rules` 唯一一条规则时跳过模型评估直接建单，零命中/多命中回退 Eval，容量满时保留触发。

归档时 `tasks.md` 的 6.5（生产实例 `127.0.0.1:3082` 实测）未勾选：本次只做归档，未重新执行该验收；其余 34 项按实施提交 `b71c559` 与 PR #26 的验证记录勾选。
