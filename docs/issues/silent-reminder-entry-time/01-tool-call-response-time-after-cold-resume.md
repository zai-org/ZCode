# 带工具调用的响应，冷恢复后条目时间比 live 晚

Status: needs-triage

## 现象

静默提醒按条目时间计时，规则见 [Silent-turn reminder](../../../apps/zcode-cli/docs/design/v2/loop/meta-user-context.md)。
带工具调用的 assistant 响应，live 与冷恢复得到的条目时间不同：

```text
t=0      请求开始              → 行的 time.created
t=50     响应结束，条目提交      → live 条目时间
t=50~150 工具执行（包括等用户回答、等权限确认）
t=150    工具批次结算           → 行的 time.completed → 冷恢复条目时间
```

纯文字响应、用户输入、隐藏提醒和 compaction 记录两边相同，或者只差几毫秒。

## 影响

- 只有一种情况会改变判定：这条响应是静默段的锚点，而且静默段跨过一次冷恢复，中间没有新的用户轮次
  （例如 goal 续跑）。
- 冷恢复后锚点更晚，所以提醒只会更晚发，不会多发。已发出的提醒按原位置、原字节回放，请求字节不变。

## 根因证据

- live：`commitTurnRequestEntries`（`apps/zcode-cli/packages/core/src/runtime/methods/turn-output-token-continuation.ts`）
  在提交时记录时间。带工具调用的 assistant 必须在工具执行之前提交：工具结果要跟在它的 tool-call 后面
  （`turn-model-step.ts` 中 `commitAssistantToTurnRequest` 调用前的注释）。
- 冷恢复：`session-history-hydrator.ts` 对 assistant 行取 `time.completed ?? time.created`。`time.completed` 由
  `persistToolModelStepFinish`（`turn-step-finish.ts`）在 `settleToolResults` 之后写入。
- `time.created` 是请求开始时间（`turn-model-step.ts` 的 `assistantCreatedAt = modelStartedAt`）。
- db 里没有字段记录“响应结束、工具执行前”这个时刻。

## 可选方案

| 方案                            | live 与冷恢复 | 代价                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A 现状                          | 上述情况不同  | 无                                                                                                                                                                                                                                                                                                                                                                                                  |
| B 新增持久化字段，记录条目时间  | 相同          | assistant 行增加一个字段；要确认旧版 App 和旧 runtime 读到新字段时不报错                                                                                                                                                                                                                                                                                                                            |
| C live 和冷恢复都用 `created`   | 相同          | 提交前已经知道这个值（`assistantCreatedAt`），不用回头修改条目；hydrator 对所有行都读 `created`，代码更少。锚点提前到请求开始：模型生成回复的时间也算静默时间，提醒更早发                                                                                                                                                                                                                           |
| D live 和冷恢复都用 `completed` | 相同          | 提交时这个值还不存在，要在工具结算后修改已提交的条目：MessageHistory 的克隆和本轮请求 state 两份都要改，MessageHistory 要新增修改接口；写 `completed` 的位置都要同步（`turn-tools.ts` 3 个分支、`turn-stop.ts`、`streaming-recovery.ts`、`turn-execution-fallback.ts`、`turn-model-step.ts` 的错误与两种丢弃路径）。锚点响应自己的整个工具批次（长时间 Bash、前台子代理）都不算静默时间，提醒更晚发 |

## 决定记录

- 2026-11-15：暂时保持 A，不改代码。代码中的标记：`session-history-hydrator.ts` 的 `TODO(silent-reminder-entry-time)`。

## 测试

`apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts` 的
`collects and restores timed silent reminders only for main continuations` 断言这个已知差异：带工具调用的响应，
冷恢复后的时间多一个工具批次（`toolMs`）。选定 B、C 或 D 之后，改成“冷恢复等于 live”。
