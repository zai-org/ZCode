# mcp-ui

Agent 侧 MCP Apps 身份、授权、调用和通知入口；通过 McpUiSessionAccess 窄接口使用 session。

- deferred 草稿可使用相同 MCP App 能力。V4 删除会话须在关闭 app 和移除 session 注册前取消 UI 调用并撤销该 session 的实例与 App tools，并等待 session 级资源退订完成；共享连接的其他 session 不受影响。

- server 必须存在于当前会话的可信 MCP 配置，不猜测名称。连接 port 提供规范化来源身份与现有连接 generation；资源读取前后、请求执行前和审批后均验证。
- 首次 open 等待目标 server 已有连接任务，再核对原 session、lease 和连接身份；不等待全部 MCP、不主动重连。同步凭证校验仍立即拒绝失效来源，等待完成不能复活已释放 owner。
- McpUiInstances 是运行凭证唯一 owner：Agent runtimeId、单调 generation、不可猜 token、稳定 appIdentity。绑定 workspace identity/session/plugin/server/resource/scope/owner 和 Host 提供的已知账号上下文。同逻辑页面同连接的并发 open 幂等。
- 页面只能选择工具名称与参数，不能选择连接、会话或实例。callTool 检查 app visibility，并复用已有 ToolExecutor 的校验、hooks、拒绝规则、会话授权与审批；app-only 工具可直接建立授权 entry，不要求暴露给模型。原始 MCP 结果直接返回，不产生自动对话或 transcript row。
- 执行固定已验证的连接代际，不触发连接重建、OAuth 自动恢复或工具重放。取消到达底层 signal；取消不回滚外部已发生操作。
- NDJSON 对完整凭证绑定的 MCP App 请求允许独立执行；长调用不得阻塞取消、关闭、审批及其他页面。普通会话请求保留串行队列，Agent 实例与调用登记负责并发终态。
- 调用接纳时占用 callId；重复接纳、取消和回包幂等，终态之后拒绝迟到结果。close 先移除凭证，再 abort、取消调用、注销工具和资源订阅。onlyIfIdle 与调用 pin 在同一 owner 原子裁决。
- App-provided tools 的现有同 server 最近登记策略保留；模型 entry 在审批前固定并 pin 对应实例。live-only 调用与取消携带完整凭证，不入持久化/replay。保留 5 秒认领、30 秒执行期限；执行只发生一次。
- 资源订阅通知携带完整凭证，断连/来源变化/会话退出时撤销；不向旧实例或替代页面投递。模型和页面两方向的取消均使用官方 MCP/SDK signal。
- resources/read 面向 UI 的结果移除 \_meta；总大小 8 MiB、MIME 白名单、blob MIME 必填，违反时返回明确错误而非截断。

页面生命周期不新增 SQLite 表、不持久化 widgetState，不改变普通会话 CommandInbox、Host owner/lease、continuous 或 replayable 通道。

- Sampling 操作表是采样接纳/取消/终态的唯一 owner，绑定完整实例和连接代际；先 pin 后执行，同代 operationId 不重放，失效立即终结、清账本。每实例/任务/Agent 并发上限 1/4/8，60 秒绝对期限，单实例账本最多 4096 项。采样沿用任务模型/权限，无新审批/会话/历史；只保留用量及诊断。
