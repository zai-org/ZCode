# provider-builtin-tool-compat

服务端执行内置工具后，会在一条 assistant 流里依次下发：调用头 markdown → `server_tool_use`（SDK 不认识的名字）
→ 结果 markdown → 裸 `tool_result` → 下一轮。本模块把结构化块改写成 AI SDK 原生支持的
`mcp_tool_use` / `mcp_tool_result`（provider 执行），并去掉与之重复的 markdown 渲染。
服务端新格式直接下发 `mcp_tool_use` → `mcp_tool_result` → 结果 markdown；结构化块原样透传，只去掉 markdown 渲染。
规格见 `apps/zcode-cli/docs/design/v2/model/anthropic-stream-compat.md`「Provider 内置工具多轮回放」。

不变量：

- 只改写 SDK 不认识的 `server_tool_use`；SDK 已支持的名字（web_search、code_execution 等）原样透传。
  上游下发的 `mcp_tool_use` / `mcp_tool_result` 不改写，只有缺 `server_name` 时补上
  `PROVIDER_BUILTIN_TOOL_SERVER_NAME`。
- 配对按调用 id，只在本条消息内有效，新旧格式共用：旧格式改写出的调用和上游的 `mcp_tool_use` 都能配对
  裸 `tool_result` 或 `mcp_tool_result`。
- 裸 `tool_result` 只有配对时才改写；没配对的交给 anthropic-stream-compat 按原规则丢弃。
  没配对的 `mcp_tool_result` 由本模块按 index 丢弃 start、delta 和 stop frame（AI SDK 遇到它会抛错）。
- markdown 副本按结构确认，不只凭前缀：调用头必须以 `**🌐` 开头且下一个块就是服务端调用（`server_tool_use`
  或 `mcp_tool_use`）；旧格式结果副本必须以加粗开头、紧跟服务端调用，且下一个块就是这次调用的配对 `tool_result`；
  新格式结果摘要必须紧跟配对的 `mcp_tool_result`，以 `**Output:**` 开头，并紧接着配对调用的摘要标签
  `**<工具名>_result_summary:**`；紧跟配对结果的 text 以 `**🌐` 开头时改按调用头确认（服务端漏发摘要时）。
  确认前先缓冲，确认不了就原样放行。所以旧格式缺少配对结果时紧跟调用的加粗正文，以及新格式结果之后
  不带配对工具摘要标签的正文（包括以 `**Output:**` 开头的模型回答），都原样保留。
- 状态按 message 维护，`message_start` 时清空；流结束时补发仍在缓冲的帧，不吞内容。
- 纯协议变换，不做 IO；只由 anthropic-stream-compat 在 Anthropic fetch 边界调用。

行为回归：`apps/zcode-cli/packages/adapters/tests/provider-builtin-tool-compat/`（契约，两种格式），
`model-execution.test.ts`（经 AI SDK 的端到端，旧格式）与 `provider-builtin-tool-rounds.test.ts`
（经 Runtime 的端到端，新旧两种格式 fixture）。
