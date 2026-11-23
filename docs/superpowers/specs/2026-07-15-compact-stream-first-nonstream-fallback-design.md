# Compact Stream-first → Non-stream Fallback 设计

## 状态

- 日期：2026-07-15
- 基线：ZCode `feat/streamable-compact`
- 变更类型：compact summary 辅助请求的 transport 调整
- 明确非目标：cache-sharing fork、独立 summarizer、compact 产品状态或 prompt 语义调整

## 背景

变更前，ZCode 在 `compactActiveConversation()` 中直接调用
`modelAdapter.generateText(...)`。因此即使普通主请求使用 SSE，compact summary 仍固定走 HTTP
non-stream 请求。

目标行为是 compact summary 请求先尝试 streaming；streaming 在内部 retry 后仍失败时，可在尚未提交
完整 assistant content block 的边界回退到 non-streaming。`thinking_delta` / `content_block_delta`
仍是 in-flight 内容，`content_block_stop` 才是 commit boundary。

本设计只调整该 transport 顺序和安全边界，不改变 compact 的其他语义。

## 目标

一个逻辑 compact attempt 固定执行：

```text
streamText(compactRequest)
  ├─ success → 返回隐藏聚合结果
  └─ terminal failure before committed block
       → generateText(the same compactRequest)
```

同时保证：

1. compact streaming delta 不进入 session event、UI 或 realtime stream；
2. fallback 不改变 compact prompt、tools、thinking、selection、preserve 或 persistence；
3. adapter 内部 SSE/HTTP retry policy 和 auto compact 外层三次逻辑 attempt 均保持不变；
4. abort、context exceeded、media too large 继续进入现有专用处理，不被 transport fallback 吞掉。

## 与 cache-sharing fork 的关系

cache-sharing fork 是一种 compact 内部的辅助执行分支：它用于复用主会话缓存前缀，并把 summary
生成与主会话状态隔离。它不是 stream transport 的前置条件，也不是用户可见 session fork。

本次不引入该分支，也不实现 cache-sharing fork 失败后的独立 summarizer system prompt。现有
P32 direct-summarizer/cache-sharing gap 继续保持 postponed。

## 变更前实现边界

### Core compact

`apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts` 当前负责：

- 创建一次 `ModelRequest(querySource=compact)`；
- 组装 projected messages、compact tools、provider options、status sink、trace 和 header refresh hook；
- 直接调用 `modelAdapter.generateText(...)`；
- 处理 abort、media too large、context exceeded、usage fact、summary validation 和 persistence；
- auto trigger 最多执行 3 个逻辑 compact attempt，manual trigger 只执行 1 个。

### Adapter retry

`runner-stream.ts` 和 `runner-generate.ts` 已分别拥有 SSE/HTTP retry。Core 不复制这两个 retry
循环。stream adapter 在已经向上游发出 retry boundary event 后不会继续 SSE 重放；compact helper
可以因为所有 delta 都仍隐藏，而在尚无完整 content block 时安全地切换到 HTTP。

### 事件可见性

普通主请求的 streaming collector 会产生 `ModelStreaming`。compact 不得复用这条可见 collector；
否则 summary 草稿会污染会话 transcript、desktop continuous 和 web-remote replayable 状态。

## 设计

### 新增 helper

新增：

`apps/zcode-cli/packages/core/src/runtime/methods/compact-summary-model-request.ts`

主接口：

```ts
runCompactSummaryModelRequest({
  logger,
  modelAdapter,
  request,
}): Promise<RuntimeModelTextResult>
```

职责：

1. 先迭代 `modelAdapter.streamText(request)`；
2. 在内存中按 content block 聚合 compact 实际消费的已提交 text、tool calls、finish reason、usage 和顶层 provider metadata；
   reasoning 只记录是否出现 delta 和是否完成 block，不保留正文或 block metadata；
3. 不调用 `createModelStreamingEventQueue()`，不发布任何 `ModelStreaming`；
4. stream 正常完成时返回与 `generateText()` 同形的 `RuntimeModelTextResult`；
5. eligible stream failure 时记录一次低频 warn，并调用 `modelAdapter.generateText(request)`；
6. fallback 失败时抛出 fallback error，原 stream error 保留在 network status 和降级日志中。

### 请求身份

`compact-active.ts` 只构造一个 request object。stream leg 与 HTTP leg 复用以下语义字段：

- `abortSignal`
- `model`
- `maxOutputTokens` / `maxOutputTokensSource`
- `messages`
- `metadata`
- `providerOptions`
- `statusSink`
- `traceContext`
- `tools`
- `refreshRuntimeHeadersBeforeAttempt`

header refresh hook 仍可在每个物理 attempt 产生新 header；测试只比较 provider-visible 语义输入，
不要求动态 header 或 adapter request id 完全相同。

### 隐藏 stream 聚合

Compact summary 继续携带现有 runtime/MCP tool schema，以保持 provider-visible request 和 cache
shape；但 `formatCompactSummaryOrThrow()` 不把 tool call 交给 executor，只按文本生成摘要，compact 不执行工具（规则见 `apps/zcode-cli/docs/design/v2/compact/README.md`「摘要文本的选取」）。
因此 compact 不需要普通主请求“参数 JSON 一完整就提前发布 tool call”的优化。Compact request 只做
单向 opt-in：设置 runtime-only `preserveProviderStreamBoundaries: true`。该字段统一保留三组
provider stream provenance：首个真实 provider event 结束 SSE retry 资格；provider response start、
provider content block start/delta/stop 的同-index 与类型合法性、最终 stop reason 是否 truthy 决定 stream 是否形成可接受结果；真实 content block
stop 形成不可 HTTP 重放的 commit。AI SDK 在读取 provider stream 前本地合成的 `start` 不算 provider
event，仍可沿用既有 adapter retry；compact opt-in 必须开启并只在 adapter 内观察 raw provider chunk，
以覆盖会被 AI SDK 吞掉或合成的 response start、block start/delta/stop 与 stop reason。每个 provider
`message_delta` 都覆盖当前 stop reason，后续 `null` 会清掉先前值；raw `ping` 不形成边界，
其余 raw event 到达后不再 SSE retry，但只要尚无真实 block stop，Core 仍可丢弃隐藏 partial 并走
non-stream fallback。raw chunk 本身不投影到 Core/UI；adapter 只向 compact collector 发送无正文
的语义边界事件。Core 按 raw block index 记录 `content_block_start` 的 block type，并只校验
delta compatibility（不解析正文）：`text_delta→text`、`input_json_delta→tool_use/server_tool_use`、
`signature_delta→thinking`、`thinking_delta→thinking/redacted_thinking`，`citations_delta` 与未知未来
delta 在 block 已存在时放行。只有同 index 已建立、delta 类型未失配且 response 已开始时，
`content_block_stop` 才能提交。未设置该字段的普通主请求继续沿用既有 eager tool-call、retry-safe prelude 与
best-effort end 行为；这里不增加第二个 boolean 或通用 transport 策略。
Raw start/delta/stop 一旦非法便立即抛出；fallback gate 只按此前是否已有 commit 决定能否重放，
不保留“继续排空后再判错”的中间状态。

事件处理：

| `ModelStreamEvent`                                    | 隐藏聚合动作                         | SSE retry 资格            | HTTP fallback commit             |
| ----------------------------------------------------- | ------------------------------------ | ------------------------- | -------------------------------- |
| AI SDK synthetic `start`                              | 不保存                               | 保留                      | 否                               |
| raw provider event（排除 `ping`）                     | 只观察；raw 正文不向 Core/UI 投影    | 结束                      | 否                               |
| provider `response_start` 语义边界                    | 记录 provider response 已建立        | 结束                      | 否                               |
| provider `content_block_start(index,type)` 语义边界   | 记录 raw block index/type            | 结束                      | 否                               |
| provider `content_block_delta(index,type)` 语义边界   | 校验 block 存在及 delta 类型兼容     | 结束                      | 否                               |
| provider `content_block_stop(index)` 语义边界         | 同 index 合法时固化真实 block commit | 结束                      | 是                               |
| provider `message_delta.stop_reason` 语义边界         | 覆盖当前 stop reason truthy 状态     | 结束                      | 否                               |
| `text_start` / `reasoning_start` / `tool_input_start` | 只观察 provider event                | 结束                      | 否                               |
| `text_delta`                                          | 追加到对应 pending text block        | 结束                      | 否                               |
| `reasoning_delta`                                     | 只记录出现过 partial delta           | 结束                      | 否                               |
| `tool_input_delta`                                    | 不向 UI 投影，等待真实 input end     | 结束                      | 否                               |
| `tool_input_end` / provider 完整 `tool_call`          | 聚合被 deny 的 tool call             | 结束                      | 仅无 raw block provenance 时推断 |
| `text_end` / `reasoning_end`                          | 关闭 block；text 此时才合入 summary  | 结束                      | 仅无 raw block provenance 时推断 |
| `tool_call`                                           | normalize、按 id 去重并保存          | 结束                      | 仅无 raw block provenance 时推断 |
| `finish`                                              | 保存 usage/finish/provider metadata  | 结束                      | 否；还需满足 stream 完整性 gate  |
| `error`                                               | 归一化后进入 fallback gate           | 仅首 event 前 stale/watchdog 保留；SSE protocol/business error 结束 | 取决于 commit 状态               |

`text_delta` / `reasoning_delta` / 可解析但尚未 provider block stop 的 tool JSON 即使已经到达，也不会
对外可见；它们会结束本次物理 SSE 的 retry 资格，但只要整次 stream 尚未完成任何 provider content
block，Core 仍可丢弃 hidden partial 并执行 non-stream fallback。这分别对应
first-provider-event boundary 与 `content_block_stop` commit boundary。判据不是单个 part 是否含
文字，也不是最终 summary 文本是否为空。对于提供 raw message-block provenance 的 provider，AI SDK
合成的 `text_end` / `reasoning_end` / `tool_input_end` 不能替代真实 `content_block_stop`；对于没有该
raw provenance 的 provider，才保留既有 normalized end 推断。即使后续收到 clean `finish`，未经过
`text_end` 的 pending text 也不能进入 summary；已有完成 text block 后再出现未闭合尾块时，只保留
已完成 block。

这里的“空”按整条 provider response 判断，不按单个 part 判断：一个已经完成的空
text/reasoning block 仍然到达 block commit，因此既不会再发 SSE retry，也不能 HTTP 重放；整条 stream
clean EOF 后仍没有合法 response/block/stop reason，则不再追加 SSE retry，而是进入一次 non-stream
fallback。空 `text_delta`、空 JSON fragment 或某个局部 part 没有正文，都不能单独触发 retry。
若 stream 在完整 tool JSON delta 后、真实 input end 前断开，adapter 不得提前合成 committed
`tool_call`；若正常 `finish` 到达，任何实际 tool call 仍由 compact deny 校验拒绝，绝不进入工具
executor。

真实 provider `content_block_stop` 才是 message-block provider 的工具 block commit。AI SDK 可能从
`message_start.content` 本地合成 `tool_input_end/tool_call`；这类事件没有 provider block stop，不能
抢先禁止 fallback。对于不提供 raw message-block provenance 的 provider，完整 direct `tool_call` 仍是
可用的 commit 推断；即使其 name/input 校验失败，adapter 也必须先把 commit marker 送达 Core 并停止
SSE retry，再传播错误，避免已提交块被 HTTP 重放。随后任何成功聚合出的 tool call 仍由 compact 的
统一 deny 拒绝，不执行工具。单独的 `finish` 只保存结果，不能替未闭合工具块合成
`tool_input_end/tool_call`，也不冒充 `content_block_stop`。

assembler 的统一 flush 只按 compact opt-in 判断：普通 main 保留既有 best-effort 未闭合工具块收尾；
compact 无论遇到 provider `finish` 还是 iterator EOF，都不得替缺失的真实 input end 合成 commit。
这里不再保留两个行为相同的 flush 入口或 `source/includeUnended` 参数。

compact opt-in 下 Adapter 手工驱动 `fullStream.next()`；只有 `next.done=true` 属于自然 EOF。retry、
terminal error、direct tool-call 校验失败或 consumer 提前退出都必须在 `finally` 先 abort 本次物理
attempt 的 linked signal，再 best-effort 调用底层 iterator `return()`。仅 `return()` 无法取消 AI SDK
`tee()` 保留的 provider stream；consumer 提前退出还必须发布一次 non-retryable cancelled 终态，避免
fallback 前遗留悬空的 SSE `model_request_started`。该清理不改变 retry/fallback 判定，也不会反向 abort
caller signal。普通 main stream 不启用这套主动取消/补终态逻辑，继续保持既有的 caller/idle 已 abort
时才 best-effort 关闭 iterator 的生命周期。

Adapter 只在有硬证据时给 terminal error 标记内部 `streamFailurePhase`，并把硬 transport status 另存为
`httpResponseStatus`：iterator 尚未构造，或真实 non-2xx response 尚未进入 SSE body，属于
`request_setup`；已经观察 provider boundary、底层实际 response status 为 2xx、已收到 fullStream
`error` chunk，或 response `content-type` 为 `text/event-stream`，属于 `response_body`。真实 transport
status 的优先级高于 response header；`ProviderBusinessError.responseStatus` 的优先级高于可能已被业务码
覆盖的 `statusCode`，finish payload 的 `response.status` 也按 transport status 抽取；`RetryError` 必须先
解包再比较内层证据。首 event 前、没有 status/response 证据的 socket reset 保持未知，不能臆断成
setup。硬 HTTP 200 body 中即使出现逻辑 `EPIPE` 也不能冒充 stale transport。上述字段只存在于 adapter
error context，不进入 contracts/protocol/UI。

### Fallback gate

stream error（包括 `finish` 后的 iterator tail error）、iterator 未产生可用 finish，或 clean finish
不满足 stream 完整性条件时，按以下顺序判断：

1. `isTurnCancellationError(error, request.abortSignal)`：直接抛出；
2. `isModelContextExceededError(error)`：直接抛出，交给现有 compact reselection/truncation；
3. `isModelMediaTooLargeError(error)`：直接抛出，交给现有 strip-media retry；
4. 已收到与 raw start 同 index 的真实 provider content block stop，或在无 raw message-block provenance 时完成 normalized
   text/reasoning/tool block：直接抛出，禁止 HTTP 重放；
5. `streamFailurePhase=request_setup`：可先沿用既有 adapter/API retry；耗尽后只有真实
   `httpResponseStatus=404` 继续进入 non-stream fallback，其他 HTTP 4xx/5xx、同步 runtime/setup、
   provider/model/config/request 校验错误直接抛出；
6. `streamFailurePhase=response_body` 的 SSE protocol/business error 不再做 inner SSE retry；只要还没有
   committed block，允许 non-stream fallback。首 provider event 前的 `ECONNRESET` / `EPIPE` /
   `ConnectionClosed` 与 stream idle watchdog 仍可先使用既有 SSE retry；caller 已取消时取消语义优先，
   不发布 retry；
7. 在此前没有 committed block 时，raw message-block provenance 缺少 response start、delta/stop 找不到同 index start、delta 与 block 类型失配，或 clean finish 同时没有 committed block 与
   最终 truthy provider stop reason：视为 stream-no-events；
8. 其他 eligible terminal stream failure：丢弃隐藏 partial state，调用 `generateText(request)`。

stream 收到 `finish` 且 iterator clean EOF 后，只有“已提交 block”或“最终真实 stop reason 为 truthy”至少
一个成立，并且 message-block provider 已观察到 response start，才属于成功。正常 stop reason 下的空
summary、已提交空 block 或已提交 tool call 继续交给 `createCompactContextExceededFinishError()` 和
`formatCompactSummaryOrThrow()`；AI SDK 默认合成的 `finishReason:other` 且没有 raw stop reason 不能单独
证明成功。

### 时序与计数

```text
CompactStarted(operationId, logicalAttempt)
  └─ ModelRequest（一次逻辑事件）
      ├─ SSE physical attempts（adapter-owned）
      └─ HTTP physical attempts（fallback 后，adapter-owned）
  └─ ModelComplete 或现有 compact failure/retry
```

- `ModelRequest`：每个逻辑 compact request 仍只创建一次；
- `ModelNetworkStatusEvent`：保留每个物理 request，transport 分别为 `sse` / `http`；
- `ModelComplete`：只为最终成功结果创建一次；
- auto compact：仍最多 3 个逻辑 attempt，不能用物理 provider 请求数替代该断言。

### 日志

fallback 是可恢复降级，每次逻辑 attempt 最多记录一条 `warn`：

```text
event=compact.summary.stream_to_non_stream_fallback
module=core.runtime
```

日志只记录 trace、model、error 摘要和是否观察到 partial delta，不记录 prompt、summary 或逐 delta
内容。禁止新增高频 info 日志。

## 明确不做

- 不修改 `shouldStreamModelText()` 或普通主请求 transport。
- 不修改 adapter retry 次数、backoff、SSE idle timeout 或普通主请求的通用 retry policy；只让 compact
  opt-in 保留真实 content-block end，使 adapter retry 与 Core fallback 看到同一 commit provenance。
- 不实现 cache-sharing fork、独立 summarizer 或 fixed compact model。
- 不修改 compact prompt、tool surface/deny policy、thinking、cache control、media projection。
- 不修改 manual/auto/reactive lifecycle、selection、preserved tail、boundary、post-compact reminders。
- 不新增 protocol schema、UI 状态、desktop/web remote 消息或 snapshot 字段。
- 不在生产代码中增加“model adapter 缺少 `streamText` 就直接 HTTP”的测试兼容分支。
- 不用测试 fake 合成无来源的 `text_end` 来阻止 fallback；旧 fake 只负责把成功结果映射为 stream，
  失败必须按真实 pre-commit error 透传。

## 测试合同

### Core helper

`compact-summary-model-request.test.ts` 覆盖：

- stream success，不调用 generate；
- first-event failure、无 finish EOF、空 SSE 与 `response_start → response_stop` 无 block/stop reason fallback；
- 最终 truthy provider stop reason 可接受无 block clean finish，后续 `null` 会清除该资格；缺失 response start、同 index block start 或 delta 类型失配在此前无 commit 时 fallback；已有 block commit 后再遇到坏 block 则保留 commit 并禁止重放；
- AI SDK 从 response-start payload 合成的 tool end 不冒充 provider block stop；
- text/reasoning delta 后、block end 前 fallback；
- 包含无 delta 空 block 在内的 content block/tool call commit 后不 fallback；
- abort/context/media 不 fallback；
- request setup 的同步错误及 HTTP 400/401/403/429/500 即使经过既有 API retry，耗尽后也不 fallback，
  HTTP 404 保留为 fallback 特例；真实 HTTP status 与 SSE body logical status 分开；
- HTTP 200 SSE body 的 logical 500/1234 error 不做第二次 SSE retry，并在 pre-commit 时 fallback；
- stream finish 的空结果/tool call 返回给现有校验；
- fallback success/failure 和请求对象复用；
- tool call 去重、reasoning delta/commit 观察、usage/provider metadata 聚合。

### Adapter runner

`runner.test.ts` 覆盖：

- 普通 main request 的 eager tool-call 顺序保持不变；
- compact 的完整 tool JSON 等到 input end 才发布，但 commit 以 raw provider block stop 为准；
- compact 在首个真实 provider start/delta 后停止 SSE retry，并由 Core 直接决定 HTTP fallback；
- compact 对 HTTP 200 SSE protocol/business error 直接交给 Core fallback；setup 保留既有 API retry，
  inner stream 只有首 event 前的 stale transport/watchdog 保留 SSE retry，caller cancellation 优先，
  普通 main request 不变；
- 真实 HTTP status 优先于 `event-stream` header，fullStream error chunk 的 logical status 不冒充
  request setup；finish `response.status` 与 RetryError 内层 status 继续保留；HTTP 404 与 logical 500
  冲突时仍按真实 404 进入 fallback，只有 logical 404 时不 fallback；
- AI SDK 本地合成的 `start` 不冒充 provider event，event 前的既有 adapter retry 保持不变；
- 无 raw provenance 时，compact 的空 text/reasoning block end 也代表一个完整 block：立即结束 SSE
  retry 且禁止 HTTP fallback；Anthropic Messages raw 路径只以对应 `content_block_stop` 为 commit；
- 同样的空 block 在未设置 compact opt-in 时保持普通 main request 的既有 retry 行为；
- 真实 input end 前 iterator throw 或 EOF 均不合成 tool-call commit；
- direct tool-call 的 name/input 校验失败也先固化可证明的 commit，不触发 adapter retry 或 HTTP 重放；
- compact 非自然 EOF 会 abort 本次物理 attempt、关闭底层 iterator 并补齐 cancelled 终态；正常 EOF
  不重复 cancel，caller signal 不受反向影响；普通 main consumer close 保持既有生命周期；
- raw response start、带 index/type 的 content block start/delta/stop、每次 stop reason 覆盖被投影为 compact-only 语义边界，raw 正文不泄漏。
- invalid raw protocol 在观察点立即失败；无既有 commit 时 fallback，有既有 commit 时直接上抛；

### Runtime compact

`runtime-compact.test.ts` 覆盖：

- manual/auto/reactive 共同使用 stream-first helper；
- 一个逻辑 `ModelRequest`、一个最终 `ModelComplete`；
- compact 不产生 `ModelStreaming`；
- 原有 prompt、tools、thinking、media/context、timeline、retry 和 persistence 断言继续通过。

### Scripted provider integration

`openai-responses-compact` 固定执行：

1. main setup：SSE success，并直接断言该 marker 对应请求为 `stream:true`；
2. compact stream leg：`stream:true`，返回 non-retryable 404；
3. compact HTTP leg：返回缺失 message `id` / output_text `annotations` 的 JSON success；
4. post-compact main：SSE success，直接断言该 marker 对应请求为 `stream:true`，并在 provider request
   中观察到 summary marker。

两条 main request 必须按 setup / post-compact marker 分别定位；不得使用“任意 provider request 中存在
`stream:true`”的宽松断言，因为 compact 首腿本身也是 streaming。

该 fixture 是 F08 的 provider/transport 补充证据，不新增 conversation 产品状态。F09/C01 只更新
“逻辑 attempt 与物理 transport leg”的术语，产品终态保持不变。

### Desktop 正式接线证据

`conversation-session-compact-stream-fallback.test.ts` 只补一条代表路径，不扩展产品状态：

```text
desktop /compact
  -> runtime compact summary
     -> stream:true / synthetic non-retryable failure
        -> non-stream / JSON success
           -> manual compact success marker
```

fixture 第一腿必须显式匹配 `stream:true`，第二腿必须排除 `stream:true`；spec 同时断言 compact provider
请求恰好为两次，并从 capture artifact 验证最后一腿是 2xx non-stream。正常 stream success 继续由既有
`conversation-session-v4-compact.test.ts` 证明。abort/context/media/commit boundary 等分支保留在 core
单测，不做 desktop/provider 笛卡尔展开。

## 验收标准

- compact 首次物理请求为 SSE；stream success 时没有 HTTP 请求；
- eligible stream failure 后出现 HTTP fallback；
- partial delta 不进入 session/UI，fallback summary 只完成一次；
- abort/context/media/commit/tool validation 语义不变；
- auto compact 仍最多 3 个逻辑 attempt；
- Responses scripted integration 证明 `stream:true → non-stream JSON` 顺序；
- desktop 正式 E2E 证明 `/compact → stream failure → non-stream success → success marker` 接线；
- Desktop compact success fixture 统一复用 replay server 的 `response.text` SSE 生成器，不手写协议帧；
  fallback 的 non-stream JSON 因承担 transport 合同而保留 raw body；
- core/adapters tests、agent/root typecheck、目标包 lint 与 build 通过；
- conversation coverage audit 必须执行，若被仓库既有缺口阻塞，应记录基线错误并确认本次 diff 未新增错误。
