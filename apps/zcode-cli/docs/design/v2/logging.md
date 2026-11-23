# Logging and Trace

ZCode 的日志不是调试输出的集合，而是 agent runtime 的可观测契约。所有 session、turn、message、model request、tool call、permission、storage 操作和外部 I/O 都必须归属到同一个顶层 `traceId` 下，并通过 `spanId` / `parentSpanId` 还原调用链。

## 目标

- 每次顶层任务创建一个稳定 `traceId`，默认覆盖整个 session 的任务链。
- 每个 turn、model request、tool call、permission、adapter I/O 创建自己的 span。
- session event 是可恢复事实来源，structured log 是诊断索引，trace span 是时序与调用链。
- 日志默认不保存密钥、token、完整 prompt、完整 tool 输入输出或隐私内容。
- core 和 adapter 都接收显式 `ExecutionContext` / `TraceContext`，不得在中途生成无关联 trace。

## 三层输出

### Session Event

append-only session event 记录可恢复状态，包括用户消息、模型结果、tool lifecycle、permission lifecycle、compact boundary 和错误。事件必须包含：

- `eventId`
- `sessionId`
- `turnId`
- `traceId`
- `sequenceNumber`
- `timestamp`
- `type`
- `payload`

### Structured Log

日志用于排障和审计索引，默认写入 JSONL。每行最小字段：

- `timestamp`
- `level`
- `event`
- `message`
- `module`
- `traceId`
- `spanId`
- `parentSpanId`
- `sessionId`
- `turnId`
- `toolCallId`
- `durationMs`
- `status`
- `error`

日志 payload 必须先经过 redactor。默认敏感 key 包括 `apiKey`、`token`、`authorization`、`cookie`、`password`、`secret`、`credential`。

错误日志必须保留可诊断的原因链。凡是通过 `logger.error(message, error, context)` 写出的错误，JSONL 中的 `error` 字段必须至少包含外层错误的 `name`、`message`、稳定 `code` / `type`（如果存在），并递归记录 `cause` 的同类摘要。错误对象上的结构化 `context` 也必须进入日志并经过 redactor。`turn.failed` 不能只留下 `UNKNOWN_ERROR`，必须能直接从日志定位原始失败原因，例如 provider 缺少 API key、模型请求非法、权限拒绝或工具执行失败，而不需要再查询 session storage。

CLI/TUI 等用户界面也必须感知系统深层状态：当入口层展示错误、等待、重试、权限、模型、工具或 I/O 状态时，应优先展示稳定的状态码、可操作摘要和安全的 cause 链摘要，而不是只显示最外层包装错误。用户可见摘要必须经过隐私和密钥泄露风险评估，完整 payload 仍只进入受控日志或 debug 路径。

### Conversation Command Audit Index

renderer 日志不是生产环境里的对话操作事实来源。低频、由用户发起且会改变会话历史的
V4 conversation command，必须在 Agent server 完成命令副作用后写一条 `info` 结构化日志，
让默认生产 JSONL 可以直接定位操作，同时避免依赖客户端日志是否启用。这类日志证明的是
server 已完成对应命令，不等价于证明用户通过某个具体按钮或键盘入口触发。

- `conversation.command.edit_user_query.completed`：只在 conversation rewind 已提交、编辑后的
  canonical intent 已接受后记录。字段至少包含 `traceId`、`sessionId`、`commandId`、
  `clientId`、`targetRowId`、`targetEntityId`、`workspaceMode`、`intentKind`、
  `attachmentCount` 和 `status=completed`。
- `conversation.command.fork_assistant.completed`：只在 stable fork 已完成并获得 child session id
  后记录。字段至少包含 `traceId`、`parentSessionId`、`childSessionId`、`commandId`、
  `clientId`、`targetRowId`、`targetEntityId`、`targetBoundaryMessageId`、
  `revisionAtDecision` 和 `status=completed`。

上述日志不得记录 `newText`、原 query、goal objective、附件内容或其他完整用户输入。
同一 command 的 rejected/failed 结果继续由 command ACK 与统一错误日志表达，不能把失败请求
误记成 completed。edit/fork 属于用户低频生命周期操作，生产环境一天的数量远低于消息流事件，
因此使用 `info` 而不是 `debug`。

### Model Stream Diagnostics

`generateText()` 和 `streamText()` 都必须记录可定位的 model SDK 诊断日志。`model.sdk.generate.completed` 已用于非流式完成路径。流式路径除了 `model.sdk.stream.completed` 之外，还必须在 stream 迭代抛错时记录 `model.sdk.stream.failed`，并带上与完成日志同级的诊断字段：

- `chunkCounts`
- `errorChunkCount`
- `lastChunkType`
- `finishReason`
- `rawFinishReason`
- `textDeltaChars`
- `reasoningDeltaChars`
- `toolCallCount`
- `usage`
- `error`（失败时）
- `errorAfterFinish`（若在 `finish` / `message_stop` 之后才抛错则为 `true`）

这类日志的目标不是改变控制流，而是把“响应已完成但连接收尾时又出现 `ECONNRESET` / `aborted`”这种尾部故障单独暴露出来，便于复现和判断是 provider 断流、代理 reset，还是客户端在完成后误读了额外错误。

### Trace Span

span 表示一次可计时操作。最小字段：

- `traceId`
- `spanId`
- `parentSpanId`
- `name`
- `startedAt`
- `endedAt`
- `status`
- `attributes`
- `error`

P0 只要求本地内存和日志可用；OpenTelemetry exporter、metrics 和外部 collector 放到后续 telemetry phase。

## 启动耗时日志

启动耗时属于 structured log，不进入 session event，避免把诊断噪音写入可恢复会话事实。所有启动日志必须使用现有 logger/redactor，并带上可串联的 `traceId`、`sessionId`（若已有）、`module`、`event`、`stage`、`durationMs`、`status` 和 `context.totalDurationMs`。

`durationMs` 表示当前阶段耗时；`context.totalDurationMs` 表示从该启动流程开始到当前日志的累计耗时。计时使用单调时钟，日志失败不得影响启动流程。

app-server 进程启动至少记录：

- `app_server.startup.started`：入口开始。
- `app_server.startup.config.completed`：配置加载完成。
- `app_server.startup.session_store.completed`：session store 打开完成。
- `app_server.startup.connection.completed`：ZCode app-server connection 建立完成。
- `app_server.startup.completed` / `app_server.startup.failed`：启动总耗时。

ZCode app-server `session/new` 至少记录：

- `app_server.session.new.started`：收到 new session 请求并创建 session trace。
- `app_server.session.new.validate.completed`：cwd、MCP server、additional directories 等请求约束校验完成。
- `app_server.session.new.config.completed`：初始 mode、model、thought level 解析完成。
- `app_server.session.new.app.completed`：ZCode app/runtime 创建完成。
- `app_server.session.new.record.completed`：ZCode app-server session record 注册完成。
- `app_server.session.new.commands.completed`：available commands 通知发送完成。
- `app_server.session.new.completed` / `app_server.session.new.failed`：new session 总耗时。

`createZCodeApp()` 也要记录 `bootstrap.app.startup.*` 阶段，覆盖配置、runtime config、storage、MCP adapter、runtime 构造和总耗时。app-server 创建 app 时必须把同一个 `traceContext` 和 `loggerFactory` 传入 `createZCodeApp()`，让 `app_server.session.new.*` 与 `bootstrap.app.startup.*` 可以按同一个 `traceId/sessionId` 关联。

## 分层约束

- `contracts` 只定义 `Logger`、`LoggerFactory`、`TraceContext`、`ExecutionContext`、`Span`、schema 和 port。
- `adapters` 实现文件日志、console sink、redaction、目录解析和未来 exporter。
- `bootstrap` 创建 logger factory、root trace context，并注入 runtime。
- `core` 只记录领域事件和调用 logger/tracer port，不直接读取环境变量、文件系统或 console。
- CLI/TUI/SDK 负责展示 `traceId`，不直接拼接底层日志格式。

## 环境变量

所有自有环境变量使用 `ZCODE_` 前缀：

- `ZCODE_LOG_DIR`：覆盖默认日志目录。
- `ZCODE_LOG_CONSOLE`：为 `1` 时同时向 stderr 写诊断日志。

日志级别不通过环境变量配置。调用方可以显式传入 logger `minLevel` 或通过 logger factory 的运行时接口调整级别；未显式传入时，开发环境默认 `debug`，以便本地 debug app 能看到 `context.built` 和 `context_usage_snapshot`；普通运行默认 `info`。开发环境由 `ZCODE_RUNTIME_ENV=development` 或本地源码/tsx CLI 入口识别；`ZCODE_RUNTIME_ENV=production` 和 `ZCODE_RUNTIME_ENV=test` 明确使用普通默认值。`NODE_ENV` 不参与 ZCode 运行时判定，避免用户 shell 或包管理器变量影响 agent 行为。`ZCODE_LOG_LEVEL` 不属于受支持的环境变量 surface，设置后必须被忽略。

默认日志目录通过跨平台目录解析获得，初版可使用 `{home}/.zcode/cli/log`。默认日志文件名为 `zcode-YYYY-MM-DD.jsonl`，其中日期使用本机本地日历日，而不是 UTC 日期；否则北京时间等正时区在本地凌晨启动时会把日志写入前一天的文件，导致排查启动耗时时误判为日志缺失。

## 日志保留与自动清理

默认只保留最近 7 个本地日历日的结构化日志文件。清理对象仅限默认日志命名契约匹配的 `zcode-YYYY-MM-DD.jsonl` 文件；其他文件、子目录、artifact、session event、SQLite DB 和 debug 产物不得被日志清理任务删除。

日志清理不是启动门禁，也不应增加用户感知的启动延迟。`createZCodeApp()` 和 ZCode app-server agent 启动完成后，通过 logging adapter 在后台延迟 60 秒调度一次清理；不在配置加载、SQLite migration、runtime 构造或 ZCode Protocol连接前立即执行。短生命周期命令可以因为进程退出而跳过本轮清理。

清理边界按文件名里的本地日期判断，不依赖 mtime。以本地日期 `2026-05-08` 为例，保留 `2026-05-02` 至 `2026-05-08` 的日志，删除 `2026-05-01` 及更早的匹配日志。不存在的日志目录、并发删除、权限错误或单文件删除失败都不得影响 agent 主流程；失败只写结构化 warn，并包含目录、文件名、retentionDays、cutoffDate 和安全错误摘要。

该能力不新增环境变量。未来如果要开放保留天数或延迟配置，必须先在本 spec 定义配置层级、优先级、错误行为和测试覆盖；能用配置文件、CLI 参数或 session 配置表达的能力，优先不要做成 `ZCODE_` 环境变量。

## 默认日志载荷边界

`{home}/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl` 是默认定位日志，目标是回答“哪个 session/turn/trace/protocol seq/事件类型在什么时间出问题”，不是保存完整协议消息、模型流式内容或工具输入输出镜像。默认日志可以记录索引、状态、计数、耗时、字节数、key 列表和短摘要；不得在高频路径写入完整 `protocolMessage`、完整 stream delta、完整 tool input/result、完整 stdout/stderr tail 或完整 request/response headers。

高频事件必须摘要化写入：

- `event_store.appended` 对 `model_streaming`、`tool_call_progress`、`streaming_tool_ledger_updated`、`model_network_status` 等与消息流同频或近似同频的事件不逐条写默认日志；按 session/turn/event type 聚合为 `event_store.appended.summary`，记录 `firstSessionEventSequenceNumber`、`lastSessionEventSequenceNumber`、`eventCount`、`payloadBytes`、`payloadKinds`、`firstEventId`、`lastEventId` 和 flush 原因。
- ZCode Protocol 的 `session/event` 发送日志保留 `deliveryKind`、`protocolSeq`、`eventId`、`protocolEventType`、`payloadKind`、`sessionEventType` 和 source event sequence；默认只记录 `protocolMessageBytes`、`protocolPayloadBytes`、`payloadKeys`、`payloadSummary`，不记录完整 `protocolMessage`。
- context usage 默认写 compact snapshot：总 token/char、分类、消息 breakdown、每类 contributor 的数量与 Top contributors。完整 `mcpTools`、`systemTools`、`skills`、`systemPromptSections` 和完整 contributor 明细只属于显式诊断日志，不进入默认 daily log。
- `zcode_protocol.process.memory_sample` 复用 `process/resourceSample` 的 60s 采样节拍写进程内存样本（`rssKb` / `heapUsedKb` / `heapTotalKb` / `externalKb` / `arrayBuffersKb` 与常驻 session、event store 行数等计数器），但只在 heapUsed 相对上次写盘变化超过 5%、任一计数器变化或距上次写盘满 5 分钟时才写；门控与字段口径见仓库根 `docs/monitoring/memory-diagnostics-log.md`。样本不含 session id、路径或任何内容。

错误和告警日志可以比 debug 索引保留更多上下文，但仍必须遵守 size cap 和敏感信息 redaction：默认优先记录 `errorMessage`、`code`、`statusCode`、`requestId`、`toolCallId`、`payloadBytes`、`tailBytes`、`outputPath` 这类定位字段；原始内容只允许在 bounded tail 或诊断产物中出现。

## Runtime 传播

1. CLI 或 SDK 创建 app 时生成 root `TraceContext`。
2. `AgentRuntime.executeTurn()` 创建 turn span，并把同一个 `traceId` 传给 event store、model adapter、tool executor 和 permission service。
3. model/tool/permission 只创建 child span，不创建新的 root trace。
4. adapter I/O 必须接收当前 context，日志中记录同一个 `traceId` 和当前 `spanId`。
5. 出站网络 adapter 必须把当前 `traceId` 传播到请求 header；模型请求发送 `x-request-id`、`x-zcode-trace-id`、`x-zcode-session-type`、`x-query-id`（存在 query 时）和 `x-session-id`（存在 session 时）。`x-zcode-session-type` 只能为 `main`、`subagent`、`side_chat` 或 `other`，只用于统计与诊断。`turnId`、`spanId`、`parentSpanId` 等细粒度诊断信息只保存在 status event、session event、trace span 和结构化日志中，不进入 provider-visible HTTP header。
6. 错误包装必须保留 cause，并在日志和 session event 中使用结构化错误字段。

`cause` 记录应有深度上限并处理循环引用；日志记录失败不得影响主流程。日志可以保留错误消息和稳定诊断字段，但不得记录密钥值、完整 prompt、完整 provider response body 或未经 redaction 的 headers。

## 验收

- 同一次 prompt 产生的 session events 使用同一个 `traceId`。
- tool handler 接收到的 `traceId` 与所属 turn 一致。
- 出站模型 HTTP 请求 header 包含与 model status event 相同的 `x-request-id` 和 `x-zcode-trace-id`，并包含按调用来源解析的 `x-zcode-session-type`。
- CLI `--json` 输出包含 `traceId`。
- 日志文件为 JSONL，敏感字段被 redacted。
- `turn.failed` 日志包含外层 runtime 错误和原始 `cause` 的 `name`、`message`、`code` / `type`、redacted `context`，无需查询 SQLite 即可定位常见失败原因。
- TUI 捕获 turn 失败时展示安全的 cause 链摘要，让用户能直接看到深层失败状态，例如 `provider_not_configured`。
- logger 文件写入失败不影响 agent 主流程。
- ZCode app-server `session/new` 日志覆盖 validate/config/create app/register/notify commands/total 阶段，每条阶段日志包含非负 `durationMs` 和同一个 `traceId/sessionId`。
- 日志文件名使用本地日历日，`2026-05-05 02:46 +0800` 必须写入 `zcode-2026-05-05.jsonl`，不能因为 UTC 仍是 `2026-05-04` 而落到前一天文件。
- 启动完成后调度日志保留清理，默认延迟 60 秒，最多保留最近 7 个本地日历日的 `zcode-YYYY-MM-DD.jsonl`，且清理失败不影响 CLI/TUI/ZCode app-server 主流程。

## Message 首响归属事实

TurnStarted 可附带 `isFirstMessage`：从当前 `queueItemId`（无 intent 时用 inputId）
对应的持久 session_input 读取，接纳序号从 0 开始，取消或出队不重置。首条接纳且
运行 turnNumber 为 0 才确认为首条；旧会话缺乏完整接纳历史时省略，不影响执行。
V4 保持原有 turn.started 字段集合，另发独立 turn.admission 通知携带该标识和
原始 intent.admittedDelivery 映射；guide 保留未知 sendMode。模型请求 usage 复用
model.request.metrics，保留缺失/0 与 cacheTokens 回退，不改 usage.delta 的 strict 格式。
消费端与六个 completion 属性的完整语义见
[会话遥测规格](../../../../../docs/monitoring/conversation-telemetry-v4.md#message-首响归属2026-11-10)。
