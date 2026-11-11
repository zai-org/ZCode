# 断流恢复后，冷恢复比 live 多回放一轮服务端工具

Status: needs-triage

## 现象

一次模型响应里先后有本地工具、服务端执行的工具（没有收到结果）和只读本地工具。只读工具在流中提前执行并
提交了结果，然后流失败，进入断流恢复。之后：

| 请求                 | 工具结果                                        |
| -------------------- | ----------------------------------------------- |
| live 的下一次请求    | `[write（恢复时中断）, read]`                   |
| 冷恢复后的下一次请求 | `[native（INTERRUPTED 错误结果）, write, read]` |

两边请求字节不同：重启后从这条消息开始缓存未命中，模型在重启后看到一次它之前没看到的服务端调用。

复现：`apps/zcode-cli/packages/bootstrap/tests/tool-history-order.test.ts` 的 `stream-failure` 场景。

## 根因证据

- 有本地工具已经提交时，断流恢复走 `streaming-tool-coordinator.ts` 的 `recoverFromModelFailure` →
  `commitAcceptedToolSettlement`。它只把本地工具（`settlement.toolCalls`）提交进 live history；
  服务端轮次在流中已经由 `provider-tool-rounds/cards.ts` 落盘，但没有进入 live history。
- 这条路径不给 assistant 消息打 `StreamRecoveryDiscarded` 标记。只有没有任何本地工具被接受时，
  `recoverPartialAssistantOutputFailure` 才会打这个标记。所以 hydrator 不会剔除这条消息里带
  `providerExecuted` 标记的 tool part，冷恢复把这一轮回放出来。
- [Anthropic Stream Compat](../../../apps/zcode-cli/docs/design/v2/model/anthropic-stream-compat.md)「回放」
  只规定了作废的 attempt 在 live 和冷恢复两边都剔除服务端轮次，没有覆盖这条「已有工具提交」的恢复路径。
- 在 `origin/staging` `4637771911` 上同样存在：那时这个测试在更早的断言就失败了，走不到冷恢复的比较。
  不是 [Assistant 内容块顺序](../../../apps/zcode-cli/docs/design/v2/model/assistant-block-order.md) 引入的。

## 待决定

修复方向需要先确定：

- live 保留这次 attempt 的服务端轮次（`commitAcceptedToolSettlement` 一并提交），或者
- 冷恢复剔除它（这条路径也给消息或 part 打标记，hydrator 按标记过滤）。

这次 attempt 的文字和思考块在这条路径下是否落盘、是否进入 live history，未核实，修复前需要一起确认。

## 测试

`stream-failure` 场景目前断言的是已知的差异（冷恢复多一个 `native` 结果）。修复后删掉这个分支，
改回「冷恢复等于 live」。
