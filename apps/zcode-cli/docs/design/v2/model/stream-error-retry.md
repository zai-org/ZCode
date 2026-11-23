# Stream Error Retry

## 背景

app-server 模式默认开启模型流式输出。Vercel AI SDK 的 `streamText().fullStream` 可能把 provider 429、5xx 或网络失败作为 `error` chunk 产出，而不是直接从 async iterator 抛出异常。

历史实现把 `error` chunk 立即转成 `ModelStreamEvent.error` 交给 core。core 收到后会终止 turn，导致 adapter 的自定义重试循环没有机会发布 `model_retry_scheduled`，ZCode app-server 侧也就无法通过 `_meta.zcode.apiRetry` 通知 z-code-2。

## 契约

- 对普通主请求（`preserveProviderStreamBoundaries` 未开启），如果一次模型 attempt
  正常结束但同时满足：`finishReason` 非 `stop`/`tool-calls`、text 为 0、reasoning
  为 0、tool call 为 0、usage 为 0，则 adapter 将其识别为 generic empty
  completion，并自动重试 **最多 1 次**。该重试复用统一退避和状态事件，但不占用
  core stream recovery budget；如果 adapter 的 `maxAttempts` 已禁止下一次物理请求，
  则不重试。
- 新增例外只覆盖上下文超限、拒绝和内容过滤：`finishReason` 或 `rawFinishReason` 命中
  `context_exceeded`、`context_length_exceeded`、`context_window_exceeded`、
  `model_context_exceeded`、`model_context_window_exceeded`、`prompt_too_long`，
  或 `refusal`、`content-filter`、`content_filter` 时，
  即使 text/reasoning/tool/usage 全为零，也不得叠加 generic empty completion retry。
  判据只做 trim 和大小写归一化，不靠任意错误文本的模糊匹配扩展范围。
  非流式请求读取 SDK 顶层 `rawFinishReason`，兼容已有 `providerMetadata.rawFinishReason`；
  流式 finish 同样支持这两种来源；用于空响应判定，不修改原有 metadata 透传及业务错误识别。
  原有 `stop`、`tool-calls`、`tool_calls` 的空响应处理保持不变。
  普通 `length`、`max_tokens`、`max_output_tokens` 及 `other`/`unknown`
  保持此前判定。缺少 finish 的 EOF 检测与恢复不变。
- 明确上下文超限且没有正文、有效 reasoning（包括 opaque metadata）或完整工具调用时，
  Adapter 在成功 finish/completed 前转换成已有 `ModelContextExceeded`，发布一次
  `model_request_failed`，由 Core 原有 catch 决定 Reactive Compact 和重试，不追加 Continue。
  判定与 usage 是否为零无关。其余响应保持原样，包括任何带有效输出的上下文限制响应；
  Adapter 不判断 Continue，不迁移或删除 Core 原有成功响应兼容分支。
  错误保留 provider 已报告 usage，由既有失败事件记账；不伪造 `ModelComplete`。
  compact 自身复用现有错误/fallback 边界，不改变恢复次数及取消语义。

```text
provider completion -> adapter 检查终止原因
                       | 明确上下文超限 + 无有效输出 -> failed -> core 既有 catch / Reactive Compact
                       | 其余响应 -> 原有空响应重试判定及调用方处理
```

- generic empty completion 的第一次 attempt 在重试前不得向 core 释放 `start`、
  `finish` 或其他仅属于该 attempt 的事件；第二次仍为空时保持现有行为，由 core
  生成 `empty_model_response` 可见错误。非流式 `generateText` 与流式 SSE 使用同一
  次数上限和边界。
- generic empty completion 不得覆盖 provider business error：如果 finish/provider
  metadata 能解析出安全校验、鉴权、额度、内容过滤或其他业务错误，先按业务错误分类，
  继续保持其既有可重试/不可重试策略。用户取消也不得触发 empty completion retry。
- compact 的 `preserveProviderStreamBoundaries=true` 请求不纳入本规则；compact
  继续由其 provider boundary、stream-to-non-stream fallback 和 commit boundary
  规则决定是否重试。

- 如果流式请求在首个已提交模型事件前收到可重试 `error` chunk 或 iterator 抛出可重试网络错误，应按 adapter 的统一重试策略处理。
- 重试前必须发布 `model_request_failed` 和 `model_retry_scheduled`，让 core/ZCode app-server 可以继续转发 retry 状态。
- runtime status event 继续使用 `attempt` / `maxAttempts` 统计总尝试次数；TUI 和 ZCode app-server 私有 UI 元数据必须在投影层换算成用户可见的重试次数，首次重试显示 `1/N`。
- 重试期间不应向 core 产出 `ModelStreamEvent.error`，因为该事件代表本次 turn 已不可恢复。
- adapter 可以暂存并丢弃无副作用的流式前奏事件，当前包括 `start`、`text_start`、`text_end`、`reasoning_start`、`reasoning_end`、`tool_input_start`、`tool_input_delta` 和 `tool_input_end`。这些事件不会立刻写入 session store 的 assistant 内容，也不会执行 tool；如果本次尝试随后失败，应直接丢弃并从下一次尝试重新开始。
- 普通主请求中，文本长度为零的 `reasoning_delta` / `text_delta` 也属于 retry-safe 前奏。Anthropic 的 `signature_delta` 会被 AI SDK 转成携带签名 metadata 的空 `reasoning_delta`；它必须随前奏暂存，不能触发已输出边界。成功时按原顺序释放完整事件和签名；可重试失败时丢弃当前 attempt 的前奏。这里按 `text.length === 0` 判断，不 trim，不丢弃签名，也不对具体 provider 错误码增加特判。
- 非空 `reasoning_delta` 是用户可见的实时思考输出，必须立即释放给 core 和 UI，因此和非空 `text_delta`、`tool_call`、`finish`、`error` 一样会越过 adapter 重试边界。越界后的可重试失败交给 core recovery；adapter 不得把可见 reasoning 缓存到正文或工具出现后才释放。
- 空 delta 的暂存及释放继续由 adapter 当前 attempt 的 `pendingRetrySafeEvents` 唯一持有，复用既有错误分类、请求清理、退避和预算；取消、非可重试错误、预算耗尽及 compact 的 `preserveProviderStreamBoundaries` 边界保持原语义。core 不新增零字节 recovery，不扩大第二套预算。
- 该边界位于 CLI 内，重试状态继续通过现有 model status 事件投影。桌面 `desktop-continuous` 保持 direct continuous 链路，手机 `web-remote-replayable` 保持 snapshot/gap 恢复；不新增协议、持久化字段或迁移，不改变 host attachment、workspace identity 和工具执行时机。
- 越过 adapter 重试边界后的可重试失败不代表本 turn 必须终止。adapter 仍应把失败上抛给 core，但 core runtime 可以按 `streaming-tool-execution-and-recovery.md` 从最近的 provider-safe recovery anchor 发起新的 SSE streaming request。该 runtime recovery 必须显式丢弃失败 attempt 的 assistant tail，不能把 partial text 合并进下一次请求上下文。
- 若失败命中 execution Selection 的声明式 fallback，模型切换仍必须遵守同一 recovery anchor 契约：先将
  完整工具调用用真实或 synthetic result 成对收口，再切换模型；被丢弃 assistant 使用统一
  `StreamRecoveryDiscarded` 持久化标记。它是“等待后续恢复”而非请求成功：最后一条仍是该 attempt 时冷恢复
  为 interrupted，存在后续正常 assistant 时才恢复为 success。若所有 fallback target 都不可解析，仍须先把
  已接受工具提交为真实、取消或 synthetic interrupted result，使 durable ToolPart 与 live/cold history 收口；
  随后保留原 provider 错误终止，不发起 fallback 请求，也不回到失败 execution provider 做 recovery。
  settlement 若提交了工具结果，必须重置 output-token continuation 预算；纯 text/reasoning tail discard 不重置。
  此边界对 desktop continuous 与 mobile replayable 使用同一 runtime 事件/持久化事实。
- SSE stream 不使用普通 HTTP 总请求超时；adapter 使用事件间隔 idle timeout。每次等待下一个 AI SDK stream chunk / SSE event 时单独计时，事件到达后重置；总耗时可以超过初始 idle timeout。默认初始 idle timeout 为 600000ms，可通过 `~/.zcode/cli/config.json` 的 `modelStream.idleTimeoutMs` 覆盖。SSE idle timeout 在重试场景按次数递增：首请求使用配置的 base timeout，第一次重试在 base 上增加 30000ms，第二次重试增加 60000ms，之后每次继续增加 30s。adapter 内部 pre-output retry 使用 `attempt - 1` 递增；越过 adapter 边界后的 core stream recovery 必须把 `streamRecovery.retryNumber` 作为请求级 retry number 传给 adapter，因为恢复请求在 adapter 看起来仍是新的 `attempt=1`。
- SSE idle timeout 触发时必须发布 `model_stream_stalled`，abort 当前 provider 请求，并归一为 `stream_idle_timeout`。如果尚未越过重试边界，则复用 adapter 统一 retry budget；如果已经产出非空 `reasoning_delta`、非空 `text_delta`、`tool_call` 或 `finish`，adapter 不得自动重放，本次 stream 失败交给 core runtime recovery 判断是否重新发起新的 SSE streaming request。
- v1 不新增 `stream_reset` 事件；adapter 在达到重试边界或 stream 成功结束前不向上游释放不可见的 retry-safe 前奏。非空 `reasoning_delta` 已是实时可见边界，core 通过现有 `stream_recovery_tail_discarded` 让投影把失败行收口为 interrupted，再由新 assistant message id 承接恢复流。
- 非可重试错误或重试预算耗尽时，应包装为稳定的 adapter error，保留原始 cause、statusCode、attempt、requestId、traceId 和 model 信息。
- 重试预算档位 `modelRetryBudget` 由 runtime 绑定在模型句柄上，adapter 只读不改：`default` 用 adapter 解析出的 `maxAttempts`；`unbounded` 给 workflow actor，瞬态失败无上限；`single-attempt` 把本次请求的 `maxAttempts` 收敛为 1，瞬态失败不重试、首次失败即上抛给 core。`single-attempt` 只用于带 `selectionFallback` 声明的执行作用域 Selection（如 Highspeed 加速卡），由 core 在失败后退回会话模型继续本轮；它不改变退避曲线、失败分类、鉴权刷新/签名修复的额外尝试和 compact 边界，状态事件的 `maxAttempts` 如实上报 1。
- adapter 内部 retry 是新的物理 provider 请求，每次新的 `model_request_started` 都必须带新的 `requestId` 和 `x-request-id`，通过相同 `traceId` 与递增 `attempt` 串联；`model_retry_scheduled` 仍归属于刚失败的旧 request。
- 每个因 provider、网络或流读取错误而结束的物理 stream attempt，都必须在进入下一次 retry 或抛出最终错误前 abort 自己的请求信号，并在同一个有界屏障内等待 iterator 的异步关闭和 AI SDK `fullStream` tee 保留分支的消费清理完成；该清理不依赖 `preserveProviderStreamBoundaries`。关闭异常或超时仅记录低频 warn，不得覆盖原始 provider 错误或无限阻塞重试。自然 EOF 不额外 abort；普通 consumer 主动提前结束和 caller stop 继续异步 best-effort 关闭，不能被内部清理超时拖慢。
- HTTP 200 SSE 中的 provider business error 必须优先在 provider fetch 边界识别，例如 `event: error` + `data` JSON 的 `error.code/error.message`。如果该业务错误可映射为 `HTTP 5xx`，或其结构化 provider code 明确表示上游网络失败，例如 `1234`、`network_error` 或 `network_error_retryable`，并且请求尚未向 core 产出任何已提交模型事件，则应复用 adapter 的统一 retry budget；否则 stream body 应失败并由 Model Runner 发布最终的 `model_request_failed`。
- fetch 边界通过 `Response.clone()` 检查 JSON business error 后，若决定抛出 `ProviderBusinessError`，必须有界消费原始 response body；禁止只消费 clone 而遗留不可达的原始 tee 分支占用连接槽，也禁止底层 stream 永久 pending 而阻塞已解析业务错误的抛出。这里优先完整消费而不是只调用 `cancel()`，因为 `cancel()` 完成不等价于 Undici 连接已可复用。

## 已收到 SSE Event 后的恢复语义

SSE stream 中断后不做连接级 resume，也不依赖 `Last-Event-ID` 拼接模型输出。模型生成流不是普通订阅流，连接断开时 provider 端可能已经继续生成、执行 provider-native 工具或丢弃内部状态；客户端无法证明“下一段 event”可以无缝接在本地已收到的 token 后面。因此 ZCode 的恢复对象是模型语义状态，而不是 SSE 连接本身。

恢复流程：

1. adapter 检测到 idle timeout、EOF-before-finish、`response.failed` 或 iterator error 后，必须先 abort 当前 provider request。
2. core runtime 冻结本次 attempt 已收到的 stream ledger，区分稳定锚点与不完整 tail。
3. runtime 丢弃不完整 tail，只从最近的 provider-safe anchor 重新发起新的模型请求。
4. 新请求的 `model_request_started` 必须携带 `streamRecovery` 元信息，至少包含 `recoveredFromRequestId`、`retryNumber` 和 `maxRetries`，让日志能直接串起“旧 request 失败 -> 新 request 恢复”。core 还必须把同一个 `retryNumber` 作为请求级 SSE idle timeout retry number 传给 adapter，使第一次 recovery 请求 idle timeout 在配置的 base timeout 上递增 30000ms，而不是继续使用首请求窗口。

事件提交边界：

| 事件 | 恢复处理 |
| --- | --- |
| `start` / `text_start` / `reasoning_start` | 仅记录为 attempt 前奏，不作为恢复锚点。 |
| 空 `text_delta` / 空 `reasoning_delta`（含纯签名） | 普通请求在首个有效输出前暂存；失败重试时随前奏丢弃，成功时按原顺序释放并保留 metadata。 |
| 非空 `text_delta` | 可以实时展示和记录，但在 `finish` 前属于不完整 assistant tail；恢复时必须丢弃，不能作为完成的 assistant message 送回模型上下文。 |
| 非空 `reasoning_delta` | 可以实时展示和记录，但不作为模型上下文锚点；恢复时随失败 tail 丢弃。 |
| `tool_input_delta` 且尚未形成 `tool_call` | 不执行工具，恢复时丢弃。 |
| `tool_call` 已接受但工具未执行 | 不把该工具视作已完成；恢复时由下一次模型请求重新决定，或记录 synthetic not-executed 结果。 |
| 工具已执行且结果已提交 | 该 tool result 是 provider-safe anchor；恢复请求必须保留 assistant tool_call 与 tool result，避免重复执行。 |
| 工具执行状态未知或存在副作用 | 不得重复执行；必须写 synthetic interrupted tool result 或阻断恢复。 |
| `finish` / provider `response.completed` | 本次 stream 完整成功，清空 recovery 状态。 |
| `error` / provider `response.failed` / EOF-before-finish / idle timeout | 进入 adapter retry 或 core recovery，取决于是否已经越过 adapter retry boundary。 |

core recovery 的可观测性要求：

- `stream_recovery_started` 必须记录失败原因、`failedRequestId`、`retryNumber` 和 `maxRetries`。
- `stream_recovery_tail_discarded` 必须记录被丢弃的 assistant message、正文/思考字节数和工具调用 ID。
- `stream_recovery_retry_started` 必须记录所选 `anchorId` 和 `failedRequestId`。
- 紧随其后的 `model_request_started` 必须带上 `streamRecovery.recoveredFromRequestId`，使用户无需靠时间戳猜测是否真的重新发了请求。
- ZCode app/server/UI 投影层必须把 `model_request_started.streamRecovery.retryNumber/maxRetries` 转成现有 `apiRetry` 运行态，让当前运行 turn 底部的重试提示显示 core recovery 的 `1/10`、`2/10`，而不是因为 adapter `attempt=1` 误清空状态。
- 普通 adapter retry 的 `model_request_started attempt>1` 只表示“开始下一次请求”，不代表恢复成功，不能立刻清空 `apiRetry`；否则网络抖动时当前运行 turn 底部的提示会在“重试中”和空状态之间闪烁。
- `apiRetry` 的恢复成功边界是 retry attempt 首次产生有效模型进展（`text_delta` / `reasoning_delta` / tool input / tool call）或请求成功完成；最终失败、取消和 turn 终态也必须清空该运行态。
- core recovery 的请求级 SSE idle timeout retry number 必须和 `streamRecovery.retryNumber` 一致；默认 base timeout 为 600000ms，所以第 1 次 recovery 使用 630000ms，第 2 次使用 660000ms，后续每次增加 30000ms。

## SSE Idle Timeout 配置

`~/.zcode/cli/config.json` 支持配置模型流式输出的初始 idle timeout：

```json
{
  "modelStream": {
    "idleTimeoutMs": 600000
  }
}
```

- `modelStream.idleTimeoutMs` 的单位是毫秒，表示等待下一个 SSE/AI SDK stream event 的最长静默时间。
- 该值只控制首请求的 base timeout；adapter retry 和 core stream recovery 仍按每次重试增加 30000ms。
- 该值不是普通 HTTP 总请求超时。只要 stream event 持续到达，单次模型请求总耗时可以超过该值。
- 该值在模型 adapter 构造时读取；修改 `config.json` 后，需要新建 agent/runtime 才能保证生效，不承诺对已构造的 adapter 热更新。
- 不应把该值放入 `provider.options.timeout` / `chunkTimeout`。provider 配置描述供应商连接参数，`modelStream.idleTimeoutMs` 描述 ZCode 自己对 SSE 事件静默的恢复边界。

## 环境变量覆盖

模型 adapter 的重试策略默认值可以通过 `ZCODE_` 环境变量覆盖，入口只存在于 bootstrap/adapter 层，core 不读取 `process.env`。

| 环境变量 | 默认值 | 语义 |
| --- | --- | --- |
| `ZCODE_MODEL_RETRY_MAX_RETRIES` | `10` | 可重试失败最多重试次数，不包含第一次请求；运行时事件中的 `maxAttempts` 等于该值加一。 |
| `ZCODE_MODEL_RETRY_BASE_DELAY_MS` | `2000` | 指数退避的初始延迟毫秒数，允许为 `0`。 |
| `ZCODE_MODEL_RETRY_BACKOFF_FACTOR` | `2` | 每次重试延迟的指数退避倍率，必须大于 `0`。 |
| `ZCODE_MODEL_RETRY_MAX_DELAY_MS` | `60000` | 普通指数退避延迟上限毫秒数，允许为 `0`；provider `retry-after` 提示在 `x-should-retry` 未显式为 `false`，且不超过 5 分钟或短于当前指数退避时仍优先。 |

优先级：显式传入 adapter 的 `retry` 选项 > `ZCODE_MODEL_RETRY_*` 环境变量 > 内置默认值。非法环境变量值不会让启动失败；adapter 忽略该变量并回退到下一层默认值，避免一个错误的调试变量让 CLI 完全不可用。日志和状态事件不得输出完整环境变量集合，只能暴露归一化后的 retry budget。

上面算出的是本地退避。请求带着实现了 `retryCooldownMs` 的准入端口（目前只有主代理的 observer）时，普通重试（不含 off-peak 排队）的最终等待是 `max(本地退避, 端口报告的剩余冷却)`，冷却部分封顶 5 分钟；首次请求不读冷却。冷却拉长了等待、且 `jitter` 开着时，再往后加与 Retry-After 同一档的抖动（最多 20%、不超过 5 秒，总等待仍不超过 5 分钟）。空 completion 的那一次重试同样按这条规则等，并在 sleep 前归还准入票据；它的状态事件不转投票据，治理器仍按 `ended` 结算。`model_retry_scheduled.delayMs` 报的是最终等待；`model.retry.delay.resolved` 日志在叠加了冷却时另记 `admissionCooldownMs` 与 `backoffMs`。冷却从哪来见 `docs/dynamic-workflow/concurrency.md`「Where the port is bound」。

## 测试覆盖

- 纯签名或空正文 delta 后，仅出现尚未完成的 `tool_input_start` / `tool_input_delta`，随后发生 SSE 503 error chunk、连接重置或 idle timeout 时，应走 adapter retry，且不向 core 泄漏失败 attempt 的签名、空 delta 和工具输入。AI SDK 将提前 EOF 归一为空 completion 时，继续验证既有一次 empty completion retry；本次不扩展 EOF 检测或其预算。
- 成功 attempt 的签名必须完整保留并在完整工具调用前按原序释放；非空正文/思考、完整 `tool_call`、compact provider boundary 仍停止 adapter 重放。取消、非可重试错误和预算耗尽均不增加请求。
- stream `error` chunk 为 429 时，首个已提交输出前应重试并发布 `model_retry_scheduled`。
- 普通流式 SSE 以 `finishReason=other`、零 text/reasoning/tool/usage 结束时，应只
  发布一次 `model_retry_scheduled`，不向 core 泄漏第一次 attempt 的事件；第二次
  成功时最终只看到第二次的有效输出，第二次仍为空时仍生成 `empty_model_response`。
- 非流式 `generateText` 返回同样的 zero-output empty completion 时，应只重试一次；
  第二次成功返回有效结果，或第二次仍为空并把既有空响应错误交给 core。
- 流式和非流式的零输出 `rawFinishReason=model_context_window_exceeded` 不产生
  adapter retry，转为一次超窗失败，保留已报告 usage；normalized finish 为 `length`
  或 `other` 时均成立。上下文超限同义标记同样处理；有有效输出时无论 finish 是否可续写均原样返回。
  拒绝、内容过滤、普通输出限制与未知标记保持原行为。
- 桌面 I73 从无账号态通过 Personal Provider UI 建立回放前置，不播种无关的假 OAuth 凭据，
  避免登录过期弹窗遮挡被测交互。Provider 只初始化一次，每个场景通过 UI 新建任务并选择模型，
  不要求与重试语义无关的思考档位。同时验证明确上下文限制的空 SSE：先准备可压缩历史，
  再严格执行超窗失败 → compact → 恢复三次请求，不追加 Continue；最终正常回复并回到 idle，
  失败请求、compact 和恢复请求的 usage 独立记录、汇总不重不漏。
- compact `preserveProviderStreamBoundaries=true` 的空 completion 不得因普通主请求
  规则增加额外重试。
- 重试后的第二次 stream 成功时，最终只向 core 产出成功事件。
- `model_retry_scheduled` 事件应保留 `reason=rate_limited`、`statusCode=429`、`nextAttempt` 和 `delayMs`，供 ZCode app-server 转换为 `_meta.zcode.apiRetry`。
- 普通 adapter retry 的 `model_request_started attempt>1` 不应清空 `apiRetry`；下一次模型进展或成功完成才清空，避免重试状态闪烁。
- provider SSE `event: error` 中携带非零业务 code 时，应归一为 `ProviderBusinessError`，最终用户看到 provider message，而不是空输出或 `finishReason: other`。
- provider business error 可映射为 `HTTP 5xx` 或明确表示 provider 网络失败时，在首个已提交输出前应走统一 retry budget；达到上限后再发布最终失败。
- iterator 在仅收到 `reasoning_delta` 后发生 `ECONNRESET` 或 idle timeout 时，adapter 应保留实时可见 reasoning 并把失败上抛；core 必须丢弃该 attempt 的未完成 reasoning tail，从前一个 provider-safe anchor 发起新 SSE 请求。恢复请求不得携带失败 reasoning，也不得把新输出追加到旧 assistant message id。
- 没有任何 provider event，或只有尚未释放的 retry-safe prelude 时发生可重试失败，仍由 adapter 在同一个逻辑请求内重试，不额外消耗 core recovery budget。
- iterator 在仅收到 `tool_input_delta`、尚未收到 `tool_call` 时发生 `ECONNRESET`，应丢弃该 attempt 的暂存 tool input 事件并重试。
- 普通 stream 的失败 attempt 即使未启用 `preserveProviderStreamBoundaries`，也必须在下一次 retry 启动前 abort 请求信号，并等待 iterator 异步关闭完成或达到内部清理超时；测试需分别证明异步关闭完成前不会启动下一 attempt，以及永不完成的关闭不会无限阻塞。普通 consumer 主动提前结束的既有行为不得随之改变。
- 连续 HTTP business error 的资源隔离必须使用真实 AI SDK provider 与本地 HTTP server 覆盖完整默认 retry budget；测试必须从服务端证明 11 个物理请求均实际到达，并在 budget 耗尽后收到最后一个 provider 原始错误。mock iterator 回调、`Response.bodyUsed` 或 `model_request_started` 只能证明调用方进入过清理/重试代码，不能替代连接槽与 reader 已释放的证据。
- SSE 事件间隔超过 `modelStream.idleTimeoutMs` 时，应发布 `model_stream_stalled`，abort provider 请求，并以 `stream_idle_timeout` 进入失败/重试事件。
- SSE retry 的 idle timeout 应按重试次数递增；测试必须覆盖 adapter 根据请求级 retry number 发布递增后的 `model_stream_stalled.timeoutMs`。
- SSE 总耗时超过 `modelStream.idleTimeoutMs` 但每个事件间隔都小于 idle timeout 时，应继续正常完成，不应触发普通 HTTP 总超时。
- `modelStream.idleTimeoutMs` 配置应从 `~/.zcode/cli/config.json` 进入 runtime config，并传入 `AiSdkModelAdapter`。
- iterator 在已经产出 `text_delta` 或 `tool_call` 后发生可重试网络错误时，不应自动重试。
- core recovery 的 `model_request_started` 即使 adapter `attempt=1`，只要携带 `streamRecovery.retryNumber/maxRetries`，ZCode UI、service runtime snapshot 和 protocol `_meta.zcode.apiRetry` 都应展示对应的重试次数。
- `ZCODE_MODEL_RETRY_MAX_RETRIES` 覆盖默认 retry budget，且 `maxAttempts` 仍按“首次请求 + 重试次数”上报。
- `modelRetryBudget = single-attempt` 时，429 等瞬态失败不得发布 `model_retry_scheduled`，首次失败即抛出 adapter error，状态事件 `maxAttempts` 为 1；流式与非流式同样适用。
- `ZCODE_MODEL_RETRY_BASE_DELAY_MS`、`ZCODE_MODEL_RETRY_BACKOFF_FACTOR`、`ZCODE_MODEL_RETRY_MAX_DELAY_MS` 覆盖指数退避默认值。
- 显式 adapter `retry` 选项优先于环境变量；非法环境变量值回退默认值。
