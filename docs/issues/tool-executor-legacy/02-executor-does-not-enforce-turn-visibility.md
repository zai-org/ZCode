# 02 — 执行器不检查本轮工具可见性，模型猜出的隐藏工具名仍会执行

Status: needs-triage

## 现象（代码阅读）

- 本轮的工具名单只在 provider 边界过滤：`getTurnTools` 去掉本轮 `toolDisallowlist`、自动任务轮的变更工具等；`getTools(model)` 去掉当前模式不提供的工具。
- 执行器按 registry 查找工具，不再检查这些规则。模型凭历史或猜测调用一个本轮没有提供、但仍在 registry 里的工具时，调用照常执行。只给 App 用、不给模型的 MCP 工具同理。

## 证据

- `apps/zcode-cli/packages/core/src/runtime/methods/turn-tool-visibility.ts`：本轮过滤只作用于请求工具名单。
- `apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts`：按 registry（以及晚到解析）取 entry，没有可见性检查。
- 以上是代码阅读结论，还没有运行复现；HEAD `843cd99740` 已经如此。

## 影响

模型调用本轮被隐藏的工具时，执行结果与"工具不存在"不一致。是否需要在执行器加检查，需要产品确认。

## 来源

2026-10-30 动态 MCP 分支评审 B2 时发现，不是该分支引入；该分支不修复。
