# Debug Observability App

`debug` 是一个开发期专用的旁路观察项目，用 React、Vite 和 Hono 构建。它不进入 agent runtime，不改变 prompt、session、tool、model adapter 或缓存策略，只读取 agent 已经落盘或显式导出的日志、SQLite session 数据和 session event JSONL。

## 目标

- 按 `traceId` 串起一个顶层任务涉及的 session、turn、model request、tool call、permission、subagent 和错误事件。
- 用甘特图表达同一 trace 内的并发执行段，避免把 tool call、model request 和网络请求误读成严格串行。
- 可视化 provider-visible context 的组成，至少展示 system prompt、skills、tools 以及其他 section 的字符数、估算 token 数和占比。
- 展示 prompt cache 的整体命中情况，包括 cache read/write token、估算命中率，以及能观察到的文本片段命中/未命中状态。
- 通过本地 debug HTTP(S) 代理实时展示网络请求，并尽量按 `traceId`、`sessionId`、`turnId`、`spanId` 归因。
- 在旁路数据不足时明确标注观测缺口，并给 agent runtime 开发者提出需要补充的事件或 artifact。

## 非目标

- 不为生产用户启用，不追求高并发、低延迟或长期存储效率。
- 不修改 agent 执行路径，不通过 monkey patch 或 hook provider SDK 获得隐式数据；网络代理仅在开发者显式把被测进程的 proxy 环境变量指向 debug app 时观察流量。
- 不默认保存完整 prompt 到新的持久化位置；如果源数据本来没有完整内容，debug UI 只能展示 metadata 和缺口。

## 数据源

### Structured log JSONL

默认读取 `{home}/.zcode/cli/log/*.jsonl`，也可以通过 UI/API 传入自定义 `logDir`。日志用于索引：

- `traceId`、`sessionId`、`turnId`、`spanId`、`parentSpanId`、`toolCallId`
- `event`、`module`、`message`、`status`、`durationMs`
- `context` 中的 safe metadata，例如 `Context built` 记录的 section 名称、字符数和 token 数

当 logger 识别到开发环境默认 debug 时，runtime 会写出 `event: "context.built"` 的 debug 级日志，其中包含 context sections 的 `name`、`source`、`chars`、`tokens`、`preview` 和 `content`。这是开发期可观测路径；默认非 debug 日志级别不写完整 section content。日志级别不通过 `ZCODE_LOG_LEVEL` 配置；需要这些快照时，应使用 dev 运行形态重新运行被测 CLI。

在每次模型请求前，runtime 还会在 debug 级别写出 `event: "context_usage_snapshot"`。它不是稳定对外 API，而是开发期 JSONL 观测事件，用于 debug app 展示 context 占用。需要稳定接口的消费方（如扩展插件）用 [Context 组成](model/context-composition.md) 的查询方法；两者来自同一份分解。快照至少包含：

- `categories[]`：按 system prompt、meta user context、skills、tool prompt、tool schemas、messages 分组的占用。
- `categoryBreakdown[]`：默认日志只记录每个分组的 contributor 数量与 Top contributors；section contributor 记录 `name`、`source`、`injectionTarget`、`cacheHint`，tool contributor 记录 tool name/server/readOnly/sideEffectScope，skill contributor 记录 skill name/source/scope/path，message role contributor 记录 role/count。该字段用于回答“每轮上下文里分别是谁贡献了大头”，不得写入完整 prompt/message/tool schema 文本，也不得无上限列出所有 contributor。
- `mcpToolCount`、`systemToolCount`、`skillCount`、`systemPromptSectionCount`：默认日志记录数量，便于判断是否是工具/技能/section 数量异常。
- `messageBreakdown`：按 role 拆分的消息占用。
- `tokenMethod`、`confidence`、`tokenizer`：每个 token 数的来源说明。当前版本使用本地估算 `zcode.estimateTokens.v1`，因此 `tokenMethod` 为 `estimated`；后续接入 provider token count 时可写 `provider_count`。

完整 `mcpTools[]`、`systemTools[]`、`skills[]`、`systemPromptSections[]` 与完整 contributor 明细属于显式诊断模式或专用 debug artifact；默认 daily log 只保留 compact snapshot。这样仍能从默认日志定位“哪个类别变大”和“Top contributor 是谁”，但不会在每次模型请求前把全部工具/技能/section 明细重复落盘。

日志默认经过 redactor，因此 debug UI 不应假设能拿到完整 tool input/output 或 provider response。

### SQLite session DB

默认只读打开 `{home}/.zcode/cli/db/db.sqlite`，也可以通过 UI/API 传入自定义 `dbPath`。SQLite 用于展示 session、message、part、todo 等持久化状态。

当前 DB 中 message/part 记录不保证携带 `traceId`。debug app 可以在已知 `sessionId` 时把它们并入同一视图，但必须标记为 `session-only` 来源，不得伪装成完整 trace 证据。

### Session event JSONL

debug app 支持读取用户显式传入的 session event JSONL 文件或目录。该源是最适合可视化 trace 的旁路格式，事件最小字段沿用 `docs/design/v2/logging.md`：

- `id` 或 `eventId`
- `sessionId`
- `turnId`
- `traceId`
- `sequenceNumber`
- `timestamp` / `occurredAt` / `recordedAt`
- `type`
- `payload`

如果 `model_request.payload.messages` 包含 system message，debug app 可以展示完整 context 文本并按 section 推断占比。如果只有 `Context built` metadata，则只能展示 section 名称和计数。

如果只有 SQLite `step-finish.tokens.input`，debug app 可以展示一条 `模型输入（SQLite 聚合）` 的低置信度 fallback，让开发者看到本轮确实有 provider input token；该 fallback 不得伪装成 system prompt、skills、tools 或 message 分块。

### Network capture proxy

debug server 默认启动本地 HTTP(S) MITM 代理，契约见 `docs/design/v2/network-capture-debug.md`。该数据源是开发期实时内存视图，不写入 session DB，也不替代 runtime 事件。它通过 `x-zcode-trace-id` header 或 trace query 参数与 trace 关联；没有归因字段的请求必须显示为未归因。

## Hono API

所有 API 都是只读接口。

### `GET /api/traces`

Query：

- `logDir?: string`
- `dbPath?: string`
- `eventPath?: string`

返回：

- 可用数据源状态、路径、记录数和 warning
- 最近 trace 列表：用户第一条消息摘要、`traceId`、关联 session、事件数、日志数、首次/末次时间、cache token 汇总

### `GET /api/traces/:traceId`

Query：

- `sessionId?: string`
- `logDir?: string`
- `dbPath?: string`
- `eventPath?: string`

返回：

- 合并时间线：logs、session events、SQLite messages/parts
- 执行 spans：可持续的 turn、model、tool、permission、subagent 和 log 段，契约见 `docs/design/v2/debug-execution-gantt.md`
- context snapshots：按 model request 或 context built log 生成
- cache reports：按 model complete、turn complete、assistant step-finish 汇总
- developer requests：当前数据源无法回答的问题和建议新增的 runtime 事件

### `GET /api/observations/events`

Query 与 `GET /api/traces` 相同：

- `logDir?: string`
- `dbPath?: string`
- `eventPath?: string`

返回 `text/event-stream`，用于 UI 实时更新 trace 列表、trace 详情和甘特图。事件流只发送轻量变更通知，不直接发送完整 timeline/context/cache payload；前端收到 `change` 后必须通过现有只读 API 重新拉取当前筛选条件下的数据。

事件：

- `hello`：连接建立时返回当前观测的 source fingerprint 和服务端检查间隔。
- `change`：任一观测源 fingerprint 变化时发送，包含 `revision`、`changedAt`、`changedSources[]` 和完整 `sources[]`。
- `source-error`：检查观测源失败时发送结构化错误，UI 应显示为可恢复状态，并等待浏览器自动重连或下一次事件。

服务端可以用文件系统 watcher 或 mtime/size fingerprint 轮询实现变更检测；这是 debug-only 旁路能力，不能影响 agent runtime 主路径。SQLite 需要同时观察主 DB、`-wal` 和 `-shm` 伴随文件，避免 WAL 模式下 UI 不更新；其中 `-shm` 是共享内存索引，读者也可能更新 mtime，因此变更判断只把它的存在和大小作为信号，实际内容刷新依赖主 DB 与 `-wal` 的 fingerprint。

### `GET /api/network/status`

返回 debug network proxy 的运行状态、证书路径和可复制环境变量。

### `GET /api/network/requests`

返回最近网络请求，可按 `traceId` 过滤。

### `GET /api/network/events`

返回 network capture 的 SSE 实时事件流，用于 UI 列表增量更新。

## UI 视图

- Trace selector：筛选条只保留两个 select，第一个选择项目，第二个选择 Trace；Trace 选项必须同时显示 `traceId` 和用户第一条消息摘要。
- Realtime status：UI 默认连接 `/api/observations/events`，观测源变化后自动刷新 trace 列表、当前 trace detail 和甘特图；手动刷新按钮保留为恢复手段。
- Timeline：按时间展示 turn、model、tool、permission、subagent、log 和 DB message/part。时间线条目的 `summary` 和可展开 `payload` 必须保留观测源提供的完整内容，不做字符数截断；UI 可以通过换行、滚动或折叠控制布局，但不能把内容替换成省略预览。
- Gantt：按 lane 展示同一 trace 内的执行段；runtime span 来自 `spans[]`，网络请求按 `NetworkRequestRecord` 转换为 `network` lane 并与相同 `traceId` 合并。
- Context panel：用横向占比条和列表展示 system/skills/tools/other 的 token 和字符数；可展开可观察文本。
- Cache panel：展示 cache read/write token、估算命中率、可归因文本片段、无法归因的原因。
- Gaps panel：展示对 agent runtime 的开发需求，便于下一步补观测事件。
- Network page：独立展示代理状态、证书位置、启动被测 CLI 所需环境变量，以及实时 HTTP(S) 请求列表；当前选中的 `traceId` 会高亮匹配请求，也可以在页面内按 trace 过滤。请求行使用固定高度，主 URL 和错误信息单行省略，避免实时请求进入时列表高度跳动。

## Cache 归因规则

如果 session event 中同时存在：

- `model_request.payload.messages`
- 后续 `model_complete.payload.usage.cacheReadTokens`
- 或 `turn_complete.payload.cacheStats.cachedMessages`

debug app 可以把 provider-visible messages 的前缀标记为 `hit`，后续标记为 `miss`。这只是基于 runtime cache stats 的可解释估算，不代表 provider 返回了逐片段命中明细。

如果只有 SQLite `step-finish.tokens.cache` 或 model usage token，则只能展示 token 级命中率，并通过 `limitations[]` 说明缺少逐文本 cache report；不得生成伪造的 `unknown` message segment。

## 需要 agent 开发者补充的观测事件

### `context_snapshot`

在每次 model request 前输出只读 artifact 或 session event：

- `traceId`、`sessionId`、`turnId`、`modelRequestId`
- `sections[]`: `id`、`name`、`source`、`chars`、`tokens`、`contentHash`、`preview`、可选 `artifactRef`
- `messages[]`: provider-visible message 的 `role`、`chars`、`tokens`、`contentHash`、section 引用
- `toolSchemaSetHash`

### `prompt_cache_report`

在 model response 后输出：

- `traceId`、`sessionId`、`turnId`、`modelRequestId`
- `usage`: input/output/total/cacheRead/cacheWrite/reasoning token
- `segments[]`: `messageIndex`、`role`、`source`、`contentHash`、`tokens`、`cacheStatus` (`hit` / `miss` / `unknown`)、`reason`

### `session_event_jsonl_sink`

提供开发期配置或 CLI 参数，把 session event 追加写入 JSONL 文件。该能力需要走现有 event sink / storage port，不应让业务模块直接写文件。

### `http_trace_headers`

HTTP adapter 应把当前执行上下文中的顶层 trace 写入出站请求 header：

- `x-zcode-trace-id`

这个 header 是 debug proxy 归因网络请求的主要依据。`sessionId`、`turnId`、`spanId`、`parentSpanId`、`modelRequestId` 等细粒度诊断信息不得作为 `x-zcode-*` HTTP header 发送，应通过 runtime event/log 和相同 `traceId` 合并。adapter 不应在缺少执行上下文时临时生成新的 trace。

## 测试覆盖

- JSONL parser 能跳过坏行并返回 warning。
- trace 合并能把同一 `traceId` 的 log 和 event 排序成稳定时间线。
- context analyzer 能从完整 system prompt 推断 `skills`、`tools` 和 `system_prompt` 占比。
- cache analyzer 能在有 `cachedMessages` 时标记前缀命中，在只有 token usage 时报告文本归因不可用。
- API 测试使用临时 fixture 文件，不依赖真实用户日志或 DB。
- observation events 能在 JSONL/SQLite 源 fingerprint 变化时通过 SSE 发送 `change`，前端收到后会自动重新拉取数据。
- network capture 能启动本地 HTTP proxy、脱敏敏感 header、按 `traceId` 过滤，并通过 API/SSE 暴露实时请求。
