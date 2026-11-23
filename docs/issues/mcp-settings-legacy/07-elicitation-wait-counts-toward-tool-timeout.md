# 07 — MCP server 发起的 elicitation 等待期间，工具超时仍在计时（待复现）

Status: needs-info

## 现象（推断）

- MCP 工具超时默认 30 s。server 在工具调用中发起 elicitation 并等待用户回答时，工具的 deadline 不暂停。
- 用户超过 30 s 才回答，工具调用就会超时失败。

## 证据

- 超时：`apps/zcode-cli/packages/core/src/mcp/index.ts:49`（`MCP_TOOL_TIMEOUT_MS = 30_000`）。
- `ToolDeadline` 的 `pause`（`apps/zcode-cli/packages/core/src/tool/executor/timeout.ts:37`）只由模型请求排队事件驱动；工具 handler 拿不到 deadline。
- elicitation 端口：`apps/zcode-cli/packages/adapters/src/mcp/index.ts:158`。
- 以上是代码阅读结论，还没有运行复现。

## 影响

需要用户填写信息的 MCP 工具，在用户回答较慢时失败。

## 处理方向（未定）

先复现。确认后给工具 handler 提供"等待用户"钩子，等待期间暂停执行器和 adapter 两套计时。

## 来源

2026-10-26 动态 MCP 分支评审时发现。发布基线 `2a04205f08` 已存在，不是该分支引入；该分支不修复。
