# Anthropic Stream Compatibility

Status: L1 Implemented

## 当前实现状态

Implementation status as of 2026-10-27：兼容层落在 Anthropic provider fetch 边界。
`packages/adapters/src/model/model-execution.ts` 只在 `provider.kind === "anthropic"` 时把
provider fetch 包装为 `createAnthropicCompatFetch()`；`openai-compatible`、`openai`、
`gateway` 和 custom provider 不经过该兼容层。

已实现：

- **按响应类型处理**：`content-type` 含 `event-stream` 的响应走 SSE transform；
  `application/json` / `+json` 的非流式响应按同样的规则改写 `content` 数组；其他响应原样返回。
- **Provider 内置工具**：SDK 不认识的 `server_tool_use` 改写成 provider 执行的
  `mcp_tool_use`，与它配对的裸 `tool_result` 改写成 `mcp_tool_result`；上游直接下发的
  `mcp_tool_use` / `mcp_tool_result`（新格式）原样透传，缺 `server_name` 时补上，没有配对调用的
  `mcp_tool_result` 按 `index` 丢弃。两种格式下与结构化块重复的
  markdown 渲染副本都按结构确认后去掉，详见下文「Provider 内置工具多轮回放」。
- **未配对的裸 `tool_result`**：没有对应服务端调用的裸 `tool_result` 仍是非标块，按 `index`
  丢弃 start、delta 和 stop frame（非流式路径直接从 `content` 中去掉）。
- **透传**：合法 text、SDK 认识的 `server_tool_use`、`web_search_tool_result` 等 typed result、
  非 JSON SSE frame 以及 `[DONE]` 原样透传。thinking frame 在无需补全签名时也原样透传；
  若 provider 只在 `content_block_start` 的 thinking block 中携带非空 `signature`，
  兼容层会在同 index 的 `content_block_stop` 前补一个标准 `signature_delta`；
  如果流中已经出现原生 `signature_delta`，则不重复补全。
- **非流式 thinking**：JSON 响应中既没有 `signature` 也没有 `redactedData` 的 thinking
  block 会被删除，避免 AI SDK 按原生 schema 拒绝整个响应。
- **按 message 隔离状态**：`message_start` 时清空待补 thinking signature、待过滤 block index
  和服务端工具配对状态，避免前一个 message 的未闭合状态污染下一个 message。
- 包装后的 SSE / JSON 响应会移除已失效的 `content-length` 和 `content-encoding`，避免
  改写后 response metadata 与 body 不一致。
- Anthropic function tool 投影默认显式关闭 AI SDK 的 eager input streaming，
  使请求体不携带 per-tool `eager_input_streaming` 字段。这个字段属于 provider
  兼容敏感能力，部分 Anthropic-compatible 后端、协议转换代理和 gateway 路由会把它当
  unknown tool schema field 拒绝；ZCode 当前先采用稳定兼容优先策略。

测试覆盖在 `packages/adapters/tests/model-execution.test.ts`（未配对裸 `tool_result` 过滤、
服务端工具改写与 markdown 副本去除、typed result 保留、thinking start 签名补全、原生 signature
delta 去重、非流式 JSON 改写、非 JSON SSE frame 透传）与
`packages/adapters/tests/provider-builtin-tool-compat/`（服务端工具改写契约）。

## Provider 内置工具多轮回放

Implementation status as of 2026-10-26。

### 问题

GLM 服务端会在请求开头往工具表里追加内置工具（`analyze_image`、`webReader`
等），客户端不感知。模型调用这类工具时，服务端自己执行、把结果拼进下一轮再请求模型，
最后把**多轮结果合成一个 assistant message** 下发（一组 `message_start` /
`message_stop`，block index 连续，usage 是多轮合计）。真实流的块顺序：

```text
thinking → text → text(「**🌐 …」调用头 markdown) → server_tool_use(analyze_image)
  → text(「**Output:** …」结果 markdown) → 裸 tool_result → 下一轮 thinking/text/tool_use
```

2026-11 起服务端改为下发 Anthropic MCP connector 的原生块（新格式）：调用块是带 `server_name`
的 `mcp_tool_use`，结果块是 `mcp_tool_result`（text 块列表 + `is_error`），结果摘要挪到结果块之后。
markdown 渲染内容不变；非流式响应没有 markdown 渲染。同一次响应里有多次调用时，所有调用在前、
结果在后，按 id 配对：

```text
text(「**🌐 …」) → mcp_tool_use(A) → [text(「**🌐 …」) → mcp_tool_use(B)]
  → mcp_tool_result(A) → text(「**Output:** …」) → [mcp_tool_result(B) → text(「**Output:** …」)]
  → 下一轮 thinking/text/tool_use
```

服务端全量切到新格式前两种格式都可能出现，兼容层同时处理。

旧实现里 AI SDK 丢弃未知名的 `server_tool_use`，兼容层丢弃裸 `tool_result`，
core 再把所有 text 拼成一个字符串、thinking 挪到最前。下一次请求里只剩一段带
markdown 的正文：模型看不到结构化的调用和结果，却能看到「调用工具」的文字样例，
随后在正文/思考里模仿这段文字假装调用、编造结果，严重时思考陷入循环。

### 处理

- **兼容层**（`provider-builtin-tool-compat/compat.ts`）：把 SDK 不认识的
  `server_tool_use` 改写成 AI SDK 原生的 `mcp_tool_use`（provider 执行），把与之
  配对的裸 `tool_result` 改写成 `mcp_tool_result`；没配对上的裸 `tool_result`
  仍按「未配对的裸 `tool_result`」丢弃。紧挨着服务端工具、与结构化块重复的两段 markdown 渲染
  （调用头以 `**🌐` 开头、结果以加粗标签开头）一并去掉，界面改由工具卡片展示。
  结果副本必须夹在服务端调用与它的配对 `tool_result` 之间才会被去掉（先缓冲，等下一个块确认），
  只凭加粗前缀不删；服务端缺少配对结果时，紧跟调用的加粗正文原样保留。
  新格式的 `mcp_tool_use` / `mcp_tool_result` 是 SDK 原生块，不改写，只去掉 markdown 副本：
  调用头必须以 `**🌐` 开头且下一个块就是 `mcp_tool_use`。结果摘要必须紧跟配对的 `mcp_tool_result`，
  以 `**Output:**` 开头，并且紧接着是配对调用的摘要标签 `**<工具名>_result_summary:**`
  （例如 `**Output:**\n**analyze_image_result_summary:** …`），整块收完时确认；对不上就立即放行。
  摘要后面没有结构块可以确认（旧格式靠后面的配对 `tool_result` 确认），模型下一轮的正文也会紧跟结果出现，
  只看前缀会把以 `**Output:**` 开头的模型回答整块删掉，所以要用摘要自带的工具名标签确认身份。
  旧格式的真实流和服务端文档示例里的摘要都是这个形态；标签换了只会漏删，不会误删。
  紧跟配对结果的 text 以 `**🌐` 开头时按调用头处理：服务端漏发摘要、结果后直接接下一个调用时，
  这个调用头照样去掉，与旧格式的覆盖范围一致。
  配对按调用 id，在本条消息内有效，新旧两种格式共用：旧格式改写出的调用也能配对上游的 `mcp_tool_result`，
  反之亦然，服务端半迁移时不会把合法结果当成未配对。
  非流式 JSON 响应做同样的结构改写和下面两条防护，不参与 core 的多轮切轮（见下文「范围」）；新格式的非流式
  响应没有 markdown 渲染，不做副本去除。
  新格式另有两条防护，不依赖服务端遵守协议：
  - 缺 `server_name` 的 `mcp_tool_use` 补上 `zcode-provider-builtin`（与旧格式改写用的值相同）。
    2026-11-05 线上曾漏发这个字段，AI SDK schema 校验失败，整轮报错，图片留在历史里后每轮都失败。
  - 本条消息里没有配对调用的 `mcp_tool_result` 按 `index` 丢弃 start、delta 和 stop frame。
    AI SDK 按 id 直接取调用记录，取不到会抛 `TypeError`，整条流失败。
- **adapter**：AI SDK 的 provider 执行 `tool-result` / `tool-error` 转成
  `provider_tool_result` 流事件。
- **core**：每遇到 provider 执行的工具调用，就把此前的 reasoning/text 收成一「轮」，
  按流顺序落盘（reasoning/text part → 带 `metadata.providerExecuted` 的 tool part），
  并发出 Scheduled → Started → Result 工具事件，界面显示为 MCP 工具卡片。
  轮内每段文字各写一个 part；reasoning、文字和服务端工具 part 都带 `blockIndex`，分轮时计数器不重置，
  冷恢复按 `blockIndex` 排序后再切轮（见 [Assistant 内容块顺序](./assistant-block-order.md)）。
  这类调用不进入本地工具调度。它们已切成带结果的前序轮次，不是本 step 的最终调用，所以续写、超窗与
  fileChanges 不计它们（`docs/model-request-output-tokens.md` 的完整 tool call 优先规则对其例外），
  空结果判定仍把它们算作有内容。
- **中断收口**：流结束、失败或被取消时仍没有结果的服务端调用按中断收口，卡片补 Result 终态，
  落盘 error 状态的 tool part，回放为 tool_use + 错误结果，与本地工具中断语义一致。
- **回放（方案 A）**：每轮写成 `assistant(text, tool_use)` + `user(tool_result)`，
  与服务端内部拼接的多轮一致；最后一轮照旧。冷恢复按 tool part 的
  `providerExecuted` 标记重新切轮，回放结果与 live history 相同。断流重试 / 执行模型回退作废的
  assistant 消息（`StreamRecoveryDiscarded`）里，正文、思考和服务端轮次从不进入 live history，冷恢复
  同样剔除（服务端轮次的 part 是在流中提前落盘的）；退回前已结算的本地工具调用与结果照旧保留。
- **与 compact 对齐**：一条持久化 assistant 拆出的多条 runtime assistant entry 共用 `compactGroupKey`，
  compact 把它们算作一组，与 `selectPersistedCompactTail` 按数据库消息算出的保留边界一致；否则 compact
  只保留最后一轮时，冷恢复会把已进入摘要的服务端调用和结果重新带回请求。
  键就是持久化 assistant 消息 id，实时与冷恢复取值相同。不能用工具调用 id：它只保证单次响应内
  调用与结果配对，有的实现每次响应都从 `call_1` 编号，相邻两次响应会因此并成一组。
- **不当上下文估算锚点**：服务端在一次响应里执行内置工具时，下发的 usage 是内部多轮请求的合计
  （真实抓包：单次请求输入约 18k，带一次 `analyze_image` 的响应报约 37k），不代表下一次请求的上下文。
  这类响应的 assistant entry 实时和冷恢复都不挂 `tokens`，冷恢复也不为它补带 usage 的空 assistant；
  compact 的上下文估算回落到上一个真实锚点加本地增量。持久化的 usage 照常保存，用量展示与缓存统计不受影响。
- **范围**：只处理流式路径。非流式（`modelStreaming: "off"`，桌面、TUI、CLI prompt 都不使用）不切轮，
  结构化调用与结果在提交时被过滤。

### 为什么回放用方案 A

2026-10-26 用真实服务端对比过两种回放，两者都返回 200，模型都能引用识别结果，
但服务端日志里的内部还原结果不同：

- **A**：`assistant(text, tool_use)` + `user(tool_result)` 被还原成
  `assistant(analyze_image)` → `tool(结果)` → `assistant(Read)` → `tool`，
  与服务端自己拼接的多轮一致，先后关系正确。
- **B**：同一条 assistant 里的 `[server_tool_use, tool_result, tool_use]` 被还原成
  **一条 assistant 同时发出 analyze_image 与 Read**，变成了并行调用，丢掉了
  「看到识别结果后才决定读文件」的先后关系。

因此只保留方案 A。

已接受的取舍：新格式一次响应里有多个并行调用时，服务端内部是一条 assistant 同时发出这些调用，
方案 A 把它们回放成先后多轮（每个调用各一轮 `assistant(tool_use)` + `user(tool_result)`）。
2026-11-06 服务端确认仍接受这种回放，所以不为并行调用另做回放。

测试覆盖：`packages/adapters/tests/model-execution.test.ts`（旧格式的流式与非流式改写、
markdown 副本去除、普通加粗文本保留）；`packages/adapters/tests/provider-builtin-tool-compat/`
（两种格式的改写与副本去除契约，含新格式并行调用、补 `server_name`、丢弃未配对结果、跨格式配对）；
`packages/adapters/tests/provider-builtin-tool-rounds.test.ts`
用脱敏的真实流 fixture 走完 compat → AI SDK → Runtime，校验下一次请求、落盘顺序、
工具卡片事件与冷恢复回放；新格式另覆盖缺 `server_name`、并行调用含 `is_error`、未配对结果。
新格式 fixture（`provider-builtin-analyze-image-mcp.sse`）由旧格式的真实流按
服务端文档改造：调用块换成 `mcp_tool_use`、结果换成 `mcp_tool_result` 并挪到结果摘要之前，其余帧不变。

## 背景

ZCode 图片输入经由 Anthropic-compatible provider 时，部分后端会在 assistant
SSE 中暴露 provider 内部工具结果。例如图片分析后端可能先返回
`server_tool_use`，随后在同一 assistant stream 中返回裸 `tool_result`。

Vercel AI SDK 的 `@ai-sdk/anthropic` 会在 provider 边界用运行时 schema 校验
`content_block_start.content_block.type`。Anthropic response stream 中允许
`server_tool_use`、`web_search_tool_result`、`mcp_tool_result` 等 typed result，
但不接受裸 `tool_result`。裸 `tool_result` 通常属于下一轮 user message 中对
client-side `tool_use` 的响应，不应作为 assistant stream content block 出现。

## 兼容策略

ZCode 不 patch `@ai-sdk/anthropic`，也不改变 ZCode 图片输入格式。兼容逻辑收敛在
model adapter 的 Anthropic provider fetch 边界：

- 处理 `text/event-stream` 的 SSE 响应与 `application/json` / `+json` 的非流式响应；
  其他响应原样返回。
- 除下述服务端工具改写、未配对裸 `tool_result` 过滤和 thinking signature 补全外，
  保留合法 SSE event 的原始内容和顺序。
- 当 `content_block_start.content_block.type === "thinking"` 且其 `signature` 是
  非空字符串时，按 block `index` 暂存该签名。
- 如果同 index 后续出现原生 `content_block_delta.delta.type ===
"signature_delta"`，立即清除暂存签名并原样透传原生 delta，禁止重复合成。
- 如果同 index 到 `content_block_stop` 仍有暂存签名，在原始 stop frame 之前合成
  一个标准 `content_block_delta`，其 delta 为
  `{ type: "signature_delta", signature }`；随后清除该 index 的暂存状态并原样
  透传 stop。合成 frame 不提前到 thinking delta 之前，也不改变其他 frame 的顺序。
- 遇到 SDK 不认识名字的 `server_tool_use` 时，改写为 `mcp_tool_use` 并记下它的 id；
  之后与该 id 配对的裸 `tool_result` 改写为 `mcp_tool_result`。这两类块是 provider
  已执行工具的真实调用与结果，必须保留，core 据此切轮、展示和回放。
- 遇到没有配对服务端调用的裸 `tool_result` 时，将该 `index` 标记为非标 block 并丢弃该
  frame，同一 `index` 的后续 `content_block_delta` 和 `content_block_stop` 一并丢弃；
  收到 stop 后清理标记。这类块不改写为 `mcp_tool_result`、`web_search_tool_result`
  或 text block，避免伪造 provider 语义。
- 服务端渲染的 markdown 副本只在结构确认后去掉：调用头必须紧挨在服务端调用之前，结果副本
  必须夹在服务端调用与它的配对 `tool_result` 之间；确认不了就原样放行。
- 收到 `message_start` 时清空待补签名、待过滤 index 与服务端工具配对状态；状态只属于
  当前 assistant message，不允许跨 message 继承。
- 无法解析为 JSON 的 SSE frame 与合法 typed result 必须原样透传。

这个策略把 provider 内置工具的真实调用与结果转成 AI SDK 能解析的标准块，把无法归属的
非标块和重复的渲染副本剥离，让后续的 thinking/text 继续进入 AI SDK。若后端修正为标准
Anthropic-compatible stream，该兼容层不应改变行为。

### Tool Input Streaming 字段策略

`@ai-sdk/anthropic` 默认会在 streaming Anthropic 请求的每个 function tool 上注入
`eager_input_streaming: true`。ZCode 的 provider adapter 必须默认关闭该注入：

- 普通 client-side function tool 转成 AI SDK tool 时，设置
  `providerOptions.anthropic.eagerInputStreaming = false`。
- 这个 provider option 只用于影响 AI SDK 的 Anthropic 请求体序列化，不进入
  ZCode 的 `ModelToolContract`、tool runtime schema、session event 或 UI 投影。
- Provider-native tools 不追加该 option；它们按各自 provider-native contract 处理。
- 后续若重新启用 fine-grained tool input streaming，必须先补 provider capability
  contract，按 provider/baseURL/model allowlist 或显式配置开启，并覆盖代理拒绝字段、
  invalid partial JSON、max_tokens 中断和 stream recovery 测试。
- 即使默认不主动请求 Anthropic eager input streaming，adapter 仍必须能消费任意
  provider 已经返回的 `tool-input-start/delta/end`，按
  `streaming-tool-execution-and-recovery.md` 的 assembler 规则合成唯一
  `tool_call`。是否发送 `eager_input_streaming` 请求字段仍由 provider
  capability gate 决定。

## 可观测性与错误边界

兼容层不吞掉 HTTP 错误、provider business error 或 stream 传输错误。它只改写已经成功
建立的 SSE / JSON 响应中的特定 content block：服务端内置工具改写为 MCP 块、去掉未配对的
裸 `tool_result` 与重复的渲染副本，或把 thinking start 中已有的签名投影为 AI SDK 可读取的
标准 signature delta；不会生成、校验或修改签名内容。
上游 JSON 业务错误仍由现有 provider business error fetch 检测。

## 测试覆盖

测试需要覆盖：

- 未配对的裸 `tool_result` block 及同 index stop 被过滤。
- SDK 不认识的 `server_tool_use` 与配对的裸 `tool_result` 改写为 `mcp_tool_use` /
  `mcp_tool_result`；markdown 副本只在结构确认后去掉，未确认的加粗正文保留。
- 普通 text/thinking 与 SDK 认识的 `server_tool_use` event 保留。
- thinking 签名只出现在 `content_block_start` 时，在同 index 的
  `content_block_stop` 前合成一个 `signature_delta`，原始 start、thinking delta
  和 stop 的相对顺序保持不变。
- 同 index 已有原生 `signature_delta` 时不再合成，原生签名及事件顺序原样保留。
- SSE frame 跨 transport chunk、CRLF frame separator 与末帧缺少空行时，仍在 stop 前合成
  唯一签名事件，并保持已有 framing。
- 新 `message_start` 会清除未闭合 block 的待补签名状态，不会把上一条 message 的
  签名补到下一条 message。
- 非流式 JSON thinking 的空字符串 `signature` 与 `redactedData` 仍视为已有 metadata，
  不会被 unsigned-thinking 兼容清理误删。
- 合法 typed result，例如 `web_search_tool_result`，不被误删。
- 非流式 JSON 响应做同样的结构改写；既不是 SSE 也不是 JSON 的响应不被改写。
- 非 JSON SSE frame 原样透传。
- Anthropic client-side function tool request options 显式包含
  `providerOptions.anthropic.eagerInputStreaming = false`，从而不产生
  `eager_input_streaming` 请求字段。
