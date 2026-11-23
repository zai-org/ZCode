# 01 — 按调度执行工具时丢掉 `offPeakTurn`，闲时轮的执行器检查失效

Status: needs-triage

## 现象（代码阅读）

- `executeToolSchedule` 为每个并行组重新组装执行选项，只传了 automationTurn、automationId、signal、traceContext、subagentModelOverride、model、toolSearch（和新增的 responseId），没有传 `offPeakTurn`。
- 同文件的 `executeToolBatch` 分批时传了 `offPeakTurn`。主循环走的是调度路径，所以 handler 里的 `assertNotOffPeakTurn` 在闲时执行轮读到的总是 `undefined`。

## 证据

- `apps/zcode-cli/packages/core/src/tool/executor/batch-runner.ts`：`executeToolSchedule` 调 `executeBatch` 的选项对象。
- `apps/zcode-cli/packages/core/src/tool/handlers/off-peak.ts`：`assertNotOffPeakTurn`；调用方 `OffPeakCreate`、`Workflow`。
- HEAD `843cd99740` 与 `origin/staging` 上同样缺这一项。以上是代码阅读结论，还没有运行复现。

## 影响

provider 侧已经在闲时执行轮隐藏 `OffPeakCreate` 等工具，这里只是第二道检查失效。模型猜出工具名直接调用时，闲时轮可以再创建闲时任务。

## 处理方向

在 `executeToolSchedule` 的选项里补上 `offPeakTurn`，并补一条走调度路径的回归测试。

## 来源

2026-10-30 动态 MCP 分支评审 B2（执行器晚到解析）时发现，不是该分支引入；该分支不修复。
