# 会话能力标签

AgentRuntime 的 `sessionFeatures` 是本会话能力标签的唯一事实源，规格见
`apps/zcode-cli/docs/design/v2/model/session-features-header.md`。

```text
打点（/workflow 展开、工具结果结算、主循环请求准备之后）→ recordSessionFeature → 内存 Set（同步）
                                                         └→ 串行合并写 session entry（先读后写，失败只记 warn）
runtime 模型句柄每次调用 → readSessionFeatures → 调用上下文 → adapter 写 x-zcode-session-features
冷恢复 → restoreSessionFeaturesOnResume：entry ∪ 持久化历史推导
```

- 只增不减：compact、rewind、冷恢复都不撤销标签。
- 每个 runtime 只记录自己 session 的能力；子 agent、workflow 子 actor 出生时为空。
- 打点之后的第一个模型请求必然带着新标签，不依赖 entry 写入结果。
- entry 写入串行，执行时读取最新集合；每次写入前先读 entry 与内存取并集，读不到就跳过这次写入，
  所以当前版本能识别的标签在 entry 中永远不会减少。词表外标签在读取时忽略，降级期间的后续写入会把它删除。
- entry 读写都是 best-effort：读写失败都只记 warn，不改变恢复与结算的结果。
- 不改变工具结果结算的顺序与持久化步骤，只读取结果。
- ToolSearch 模式标签只由 turn-loop 在请求准备之后打，取 `prepared.toolSearch` 的生效模式；
  请求准备环节本身不写状态，compact、目标校验、Memory 的请求不打。
- BUA/CUA 标签按"真实尝试"打，不看 success 和 isError：`mcp__node_repl__js` 结果里由 node-repl-host
  写入的可信 key（`zcode/nodeReplBrowserUse`、`zcode/nodeReplComputerUse`），以及 registry entry 认证组为
  `official_cua` 的旧版 computer-use MCP 工具的任何结算结果；只按工具名不认。两条路径都推不出历史，只靠 entry。
- `workflow_auto_attempt` 按"尝试"打：CreateWorkflow 有结算结果就打，错误类型为 `permission_denied`、
  `tool_not_found` 时不打；成功启动时与 `workflow_auto` 同时出现。历史只认 `completed` 的工具 part，
  `error` 状态分不出权限拒绝，只靠 entry。

行为回归位于 `tests/session-features/`。
