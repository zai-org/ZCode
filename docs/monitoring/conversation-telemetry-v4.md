# V4 对话埋点兼容规范

本文冻结 V4 conversation 主链路的对话埋点口径。实现以 `z-code-2` 的生产行为为兼容基准，
基础迁移保持旧字段类型与指标公式；扫码远控的 completion/step 增量覆盖见文末专节。

## 目标与非目标

恢复下列生产事件：

- `/event/report`：`send_btn`、`message_completion`、`agent_step`、`context_compaction`、
  `assistant_message_feedback`。
- ARMS：`perf_ui_first_token`、`perf_ui_message_complete`、`perf_ui_turn_breakdown`、
  `perf_ui_stream_stall`、`perf_ui_tool_call_detail`、`plan_request`、`plan_ttft`、
  `chat_error_banner`。
- 依赖真实对话入口的 `session_quota_alert` quota banner 和已有 Upgrade 面板交接。

非目标：

- Web/手机端实际网络上报。
- initial snapshot、cold hydration、gap recovery 或历史 transcript 的补报。
- 修正旧版固定零值、空字符串、负值钳制和 stop-without-terminal 等历史口径。
- 把 telemetry 状态写入 conversation rows、snapshot、relay 或 main 进程。

## 架构与状态边界

以下为桌面 continuous 链路；扫码远控由执行服务复用同一归集算法，直接经 Host → Main 投递。
两条链路按 command 来源互斥，不依赖当前页面是否可见。

```text
CLI V4 live SessionEvent
        |
        | normalize metadata-only fact
        v
Host workspace telemetry service
        | validate + forward; no persistence/replay
        v
Renderer workspace telemetry supervisor
        | seed + foreground refs + bounded dedupe
        +----------------------+----------------------+
        |                      |                      |
        v                      v                      v
 /event/report            ARMS ui_perf       quota/feedback

persisted hydration / initial / recovery
        |
        +----> conversation projection only
               MUST NOT emit telemetry facts
```

不得复活旧 `zcodeTaskRuntimeMonitor`，也不得把 supervisor 放在 `SessionPane`、
`SessionDataLayer` 或受 30 秒 keep-warm 控制的 connection 上。supervisor 归属于窗口的
workspace/service attachment，隔离 key 为：

```text
endpoint + remoteSessionId + (workspaceIdentity?.trim() || workspacePath) + serviceGeneration
```

同一 workspace/service generation 只有一个 supervisor。task 切换、pane 卸载和 keep-warm
到期不销毁；workspace detach、窗口关闭或 service generation 更换时销毁。

foreground 是可见 session 的引用集合，不是单 pane owner。同一 session 在多个分屏可见时仍只消费
一次事实；多个不同 session 可以同时 foreground。

## Live fact 协议

`ConversationTelemetryFact` 是严格 discriminated union，公共字段为：

```ts
interface ConversationTelemetryFactBase {
  version: 1;
  eventId: string;
  eventSeq: number;
  occurredAt: number;
  sessionId: string;
  sourceCommandId?: string;
  turnId?: string;
}
```

事实类型覆盖：

- `turn.started`
- `model.request.status`
- `stream.chunk`，只允许 `thought | text`、长度、是否首 chunk 和可选
  `parentToolCallId`，不带正文；带 parent 的子代理 text 不进入主 generation step，但旧 handler
  仍会在 step builder 外记录其 first token 和 stall。parented thought 继续保留旧 reasoning/TTFT/stall
- `tool.lifecycle`，只允许工具名、状态、ID、父子/Agent 关联和扁平 allowlist perf，不带
  input/output。Runtime `ToolExecutionTelemetry` 的 nested `detail` 必须由 CLI fact normalizer
  按 command/filesystem/patch 判别分支逐字段映射，禁止直接透传或 spread；`command.hash` 只留在
  CLI 本地诊断对象，不进入 V4 fact。shared schema 中保留的 `commandHash` 不代表官方 producer
  会填充该字段
- `permission.lifecycle`
- `usage.delta`，只由 `querySource=main_turn`（或兼容历史缺省且非
  `tool_internal`）的 `ModelComplete` 产生；`session_title`、compact、子代理和其它
  sidecar usage 不得累计到用户 prompt
- `turn.terminal`
- `compaction.terminal`

`model.request.status` 只保留旧 `plan_request` 和 message telemetry 需要的 provider/model/status、
请求耗时、错误分类和 provider hostname。hostname 必须通过 URL 解析后得到，禁止保留 path、query、
header、header count、token、prompt、上游原始 message 或 finish reason。

`message_completion` 与 `agent_step` 的 `event_extra_detail` 还必须携带当前 workspace 场景维度：

- `workspace_kind`：`local` / `remote`，表示本轮实际运行的 workspace 类型；
- `remote_kind`：`ssh` / `wsl` / `docker` / `server`，本地或无法解析远端类型时为空字符串。

这两个字段是低基数维度，桌面由 renderer workspace attachment、扫码远控由执行服务的 workspace
在归集器创建时冻结，并同时写入同一
message 的 completion 与 step。远端类型只能通过统一的 `parseRemoteWorkspaceIdentity` 解析；不得把
`remoteSessionId`、`workspaceIdentity`、`workspacePath`、主机地址或其它高基数身份直接写入埋点。

Host 依据 attachment 注入的可信 `clientMode` 决定订阅权限，不能相信 renderer 自报。
只有 `desktop-continuous` renderer 安装真实 reporter；`web-remote-replayable`、Bot 和自动化客户端
即使能看到权威 conversation 状态，也不能借 telemetry service 产生网络上报。SSH/WSL/Docker/Server
远程链路可能存在 Desktop Host attachment → trusted host relay 的多层 connection scope；relay 本身仍
不得安装 reporter，但必须把现有 trusted 下游连接的 `clientMode` 和 namespace connectionId 继续传给
上游。只有带可信下游 `desktop-continuous` 上下文的 telemetry fact 订阅可以穿过 relay，直接 relay
订阅或 `web-remote-replayable` 下游必须返回空事件。扫码远控新增的已归集业务事件使用独立
Host-only 通道，允许 trusted relay 转发至 Main，不向终端开放事实订阅或网络 reporter。
Telemetry attachment 是旁路能力；Platform 或 agent service 尚未就绪时必须保持 no-op，不能阻断
workspace/remote renderer，依赖齐备后才按 service generation 建立 supervisor 与 live subscription。

fact 只从当前进程的 live ingest 产生：

- persisted hydration、subscribe initial、snapshot 和 recovery：不产生。
- hydration 期间新到达并暂存在 live buffer 的事件：产生一次。
- CLI/runtime 重启后不根据 orphan 或历史终态补造 completion。

### 模型请求指标（`model.request.metrics`）

供扩展进程算生成速率（[扩展进程](../plugins/extension-host.md) §10）。每个成功完成的模型请求一条，
由 `ModelNetworkStatus` 的 `model_request_completed` 产生，与 `model.request.status` 同源、同 live 规则。

```ts
interface ModelRequestMetricsFact {
  version: 1;
  kind: "model.request.metrics";
  eventId: string;
  eventSeq: number;
  occurredAt: number;
  sessionId: string;
  turnId?: string;
  sourceCommandId?: string;
  requestId: string;
  providerId: string;
  modelId: string;
  querySource?: string; // main_turn / session_title / compact / subagent …，来自请求 trace 属性
  queryId?: string;
  durationMs: number;
  timeToFirstContentMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
}
```

- 只带 id、模型身份、耗时和 token 数，不带正文、header、URL 或 finish reason。schema 是 strict。
- 走独立通知 `v4/telemetry/model-request-metrics`，**不进** `ConversationTelemetryFact` union，也不改
  `model.request.status`。原因：上面每个分支都是 strict，旧 App 解析到未知字段会丢掉整条事实；
  加新 `kind` 会让旧 App 每个请求记一条 warn。旧 App 对未知通知方法不做处理，新通知对它无影响。
- 区分用途看 `querySource`：消费方只取 `main_turn` 才算主轮速率。
- App 侧经 `IZCodeAgentService.onDynamicModelRequestMetrics(target)` 订阅；不接 renderer reporter，
  不产生网络上报。

## 界面模式归属

`send_btn`、`message_completion`、`agent_step` 增加 `ui_mode`，发送时冻结并沿既有 seed/父子
归因链传递，无来源时为 `unknown`。详见[业务埋点界面模式契约](./business-monitoring.md)。

## ID、时钟和去重

- `talk_id = sessionId`。
- send/completion/step 的 `message_id = sourceCommandId`。
- feedback 的 `message_id = assistant entityId`；缺少 entityId 时不以 rowId 代替。
- compaction 的 `message_id = summaryMessageId ?? operationId`。
- renderer 以收到 live fact 时的 `Date.now()` 计算旧耗时；`occurredAt` 只用于诊断。
- eventId 使用约 2000 条有界 LRU。
- terminal 按 `(sessionId, sourceCommandId, eventName)` exactly-once。
- compact 按 `(sessionId, operationId, "context_compaction")` exactly-once；同一 operation
  即使异常重复到达相互矛盾的 terminal status，也只采用首个 live terminal。
- 本地 prompt seed 只在内存中保留；renderer reload 后不补报。

## 事件触发矩阵

下表描述桌面 UI reporter；扫码远控的两个业务事件由执行服务在 live 执行中产生，与 foreground 无关。

| 事件 | foreground | 切走后的 background | initial/recovery |
| --- | --- | --- | --- |
| `send_btn` | 本地桌面 command 被 UI 接纳时一次 | queued promotion 不重报 | 不报 |
| `message_completion` | 报 | 已有本地 seed 的轮次继续报 | 不报 |
| `agent_step` | 报 | 已有本地 seed 的轮次继续报 | 不报 |
| `plan_request` | 报 | 报 | 不报 |
| `context_compaction` | terminal 到达时可见才报 | 不报 | 不报 |
| 六项 UI ARMS | 报 | 不报 | 不报 |
| `chat_error_banner` | banner 实际可见才报 | 不报 | 恢复后首次真实可见可报 |

`send_btn` 的发送时间来自 UI 原始动作。已有 session 的 direct/queued command 在本地接纳后上报；
draft 首发等待 create ACK 得到 sessionId 后上报，但沿用原始 input/send 时间。相同 commandId 的重试、
queued promotion 或 command inbox duplicate 不重报。

发送种子的模型字段继续复用旧 UI 兼容值：运行时 provider（当前缺省为 `glm`）只写 `agent`；
`config.provider !== glm` 时 `model_name` 使用 `custom:<provider>:<model>` 编码，`model_provider`
仍写拆分后的真实 config provider。真实模型请求到达后，completion/step 再沿用旧逻辑改写为
`<provider>/<model>`。不得因为 V4 config 已把 provider/model 拆字段，就改变旧数仓字符串口径。
草稿首发即使 prewarm snapshot 尚未到达，也必须从该草稿生命周期冻结的初始化 config 与显式 intent
合并得到 seed；不能回退为空模型/`glm`，也不能为了等待 telemetry 阻塞真实发送。

`message_completion` 和 `agent_step` 只由桌面 UI 建立 seed 的 prompt 产生。`turn.started` 把 seed 与
session/turn/sourceCommandId 绑定；所有携 sourceCommandId 的后续事实必须匹配当前生命周期。stop
没有 terminal 时保持旧行为，不合成 completion。

同一 `talk_id + message_id` 的 `message_completion` 与全部 `agent_step` 必须使用相同的
`workspace_kind` / `remote_kind`。本地 Desktop 与 Desktop 远程 workspace 都属于
`desktop-continuous`，因此 `clientMode` 只用于可信订阅门禁，不能作为 workspace 场景维度。

工具 terminal fact 到达时必须立即按该时刻关闭对应 tool step，并先上报
`/event/report agent_step`；同轮 `message_completion` 只在之后的 turn terminal 收口。若正常工具
terminal 因 fact schema 失败被丢弃，turn terminal 虽会兜底关闭仍打开的 step，但会把
`duration_ms` 拉长到整轮结束，并可能用 turn 状态覆盖真实工具状态、错误与失败计数。该 fallback
只保留给真实缺失/异常链路，不能作为正常 desktop continuous 链路的成功路径或测试依据。

`TurnComplete(cancelled)` 保留旧两阶段收口：agent step 仍按 `task_complete` 成功关闭，随后
`message_completion.status="user_interrupt"`，并使用旧固定错误
`USER_INTERRUPT / User stopped generation`。只有真实 `TurnError` 用 `task_error` 关闭 step。

`plan_request` 直接消费真实模型网络状态，覆盖旧版五种状态；允许前后台且不要求本地 prompt seed。
不得从 `apiRetry`、accepted、queued 或其它投影状态推断。eventKey 使用 2000 条 FIFO/LRU 去重。

六项 UI 性能事件和 `plan_ttft` 只在 session foreground 时更新/收口。stream stall 必须严格
`> 3000ms`；工具开始/更新和 terminal 清空 tracker；tool detail 只有 allowlist perf 非空时上报。
旧统计接受的首个 thought、text（包括 parented child chunk）或 tool 都可成为 first token。旧 prompt
在 terminal 前完全没有 thought/text/tool 时，completion 的 `time_to_first_token="-1"` 仍镜像一次
`perf_ui_first_token(value=0)`；`plan_ttft < 0` 或 provider 为空时不发。仅在后台到达的首 token
不能在切回前台后补算为 UI TTFT。

旧生产 completion 调用从未传入 `fileChanges`，因此 `file_change_cnt`、
`generated_code_lines` 以及 ARMS breakdown 对应属性固定为 `"0"`/`0`。V4 即使从 runtime
拿到文件摘要，也不得借迁移修正这两个指标。

compaction 使用旧 runtime 模型值：非 `glm` provider 的 `model_name` 为
`<provider>/<model>`，`model_provider` 保留 provider id；它不同于 `send_btn` 的
`custom:<provider>:<model>` UI 编码。`reason` 只读取旧 timeline 实际消费的 `reason`；不得用
V4 的 `compactReason` 回填空字符串。

`chat_error_banner` 在错误真正渲染可见后上报，同一组件 mount 内相同 key 一次；被 reducer/UI
抑制的错误不报。普通 provider business error 保留旧版可见恢复动作与业务 code 维度；官方版本安全校验的
内部恢复 action 不进入 banner telemetry。

错误从 CLI 投影到 UI 时可附带 `attribution` 结构化事实：`source`、`reason`、`providerId`、
`modelId`、`providerKind`、`transport`、`statusCode`、`providerErrorCode`、`retryable`、
`errorPhase`、`exceptionKind`。这些字段
全部可选，只用于故障归因和监控聚合；不得改变既有 banner 的显隐、文案、按钮、重试、安全校验或
feedback 行为。旧事件与旧持久化记录缺少 attribution 时继续按原有 fallback 工作。

`chat_error_banner` 在保持既有字段不变的前提下，按白名单展开上述事实为
`error_source`、`failure_reason`、`provider_scope`、`provider_id`、`model_id`、`provider_kind`、
`transport`、`status_code`、`provider_error_code`、`failure_retryable`、`failure_phase`、
`failure_exception_kind`。内置 provider 可保留稳定 ID；
自定义 provider 一律归一为 `provider_scope=custom`、`provider_id=custom`，避免用户自定义名称造成
高基数或隐私泄漏。`model_id` 只允许保留 telemetry 显式白名单中的内置稳定模型 ID；自定义 provider
的模型和内置 provider 下未命中白名单的模型统一写为 `custom`，provider 或 model 缺失时写空字符串。
白名单匹配与输出均使用规范化小写 ID，新增内置模型未进入白名单时必须默认降级为 `custom`，不得原样
透传。禁止上传 base URL/完整 URL、header、token、请求或响应正文、prompt/tool 内容、stack、完整
detail、requestId。ZCode 只上报事实归因，不上报 `owner` 或 `shouldAlert` 等监控策略结论。

`exceptionKind` 必须在 adapter 边界由 allowlist 规范，禁止把自定义 Error name 原样带入协议或 ARMS。
`failure_reason=unknown` 不等于诊断字段缺失；Dashboard 分开统计 reason coverage 与
`source + errorPhase + exceptionKind` 的 diagnostic coverage。

attribution 随权威 conversation error 状态进入 snapshot，因此 live continuous 与 persisted cold
hydration 对同一错误应得到相同归因；它不触发 telemetry 补报。桌面仍仅在 banner 实际可见时通过
`desktop-continuous` reporter 上报，手机 `web-remote-replayable` 不新增网络上报能力。

`source` 必须依据错误发生边界判定，不能只按 failure reason 猜测。判定优先级为：用户取消和
请求发出前的本地 provider 配置、请求选项校验、未知 adapter 异常归为 `runtime`；TLS、代理、
连接和超时等明确传输失败归为 `network`；其余仅在存在 provider 响应、provider business error
或 provider 返回内容校验失败等上游证据时归为 `provider`。同一个 `invalid_request` reason
因此可能按是否已有 provider 响应分别归为 `runtime` 或 `provider`；明确的网络 reason 即使由
provider 响应携带，仍保持 `network`。

已携带结构化归因的 adapter error 再次经过 runner 终态边界时，`source`、`reason`、
`retryable`、`statusCode` 和 provider business error 字段由最先取得有效证据的边界负责；后续边界
只能补齐缺失值，不得用更粗粒度的重新分类覆盖。`attempt`、`requestId`、`traceId`、`providerId`、
`modelId`、`providerKind` 和 `transport` 等本次请求事实仍以当前 runner 边界为准。为保留原始 stack、
cause 和调用方已有的错误对象引用，已有 adapter error 的上下文补齐不得替换错误对象；compact 等
调用点可以继续追加其明确拥有的阶段字段。

## 业务触发链路

### Assistant feedback

V4 提供 `setAssistantFeedback` CAS command：

```ts
{
  target: { kind: "assistantEntity"; entityId: string };
  feedback: "like" | "dislike" | null;
}
```

CLI 更新 assistant row 并持久化。UI 乐观更新、command 失败时回滚；点击时仍立即上报旧格式：

```ts
{
  eventType: "ck";
  eventRegion: "chat";
  elementName: "assistant_message_feedback";
  eventExtraDetail: { reaction: "like" | "dislike" | "none" };
}
```

相同 reaction 再点一次写 `null` 并上报 `none`。

### Session quota entry

V4 quota banner 必须恢复可见性、dismiss、提交阻断、entitlement refresh 和 Upgrade 面板。
只有已有购买面板确认打开后才由原购买模块上报 `coding_plan_upgrade_ck`，对话入口负责传递：

- `eventRegion = app.session`
- `upgrade_source = session_quota_alert`

购买模块内部的 product/cycle/pay/result 与支付结果不属于本次 conversation 重构恢复范围；本次只验证
Upgrade 面板真实打开且 funnel context 没有在对话入口丢失。

## 验证合同

- Golden tests 必须比较完整 payload，包括字符串化数字、空字符串和固定零值。
- fake clock 覆盖 first token、3000/3001 stall、permission waiting、terminal exactly-once。
- schema/privacy tests 证明正文、工具内容和 URL path/query 不会进入 fact。
- gateway/service tests 证明 live buffered event 一次，initial/hydration/recovery 零次。
- desktop E2E 用 `/event/report` fetch mock 和测试构建专用的有界 ARMS ring buffer 验证生产入口；
  ring buffer 不得在生产构建暴露或持久化。

conversation 正式用例编号与剪枝结论见 case catalog 的 `TEL` 分组和 E2E coverage matrix。
新旧版本运行时差分、原子化回归 case 与自动化分层见
[`conversation-telemetry-differential-regression-plan.md`](../testing/conversation-telemetry-differential-regression-plan.md)。

## Memory 开关维度（2026-09-17）

`send_btn`、`message_completion`、`agent_step` 的 `eventExtraDetail` 均包含
`memory_enabled`：`"1"` 开启、`"0"` 关闭、`""` 表示旧 CLI/旧事实未提供状态。
它只表示会话运行实例创建时采用的 App Memory 设置，不表示 CLI memory 最终生效、
记忆读取命中或写入成功；不新增 read/write 指标，不改变 Memory 开关行为。

唯一数据源为 CLI `ZCodeProtocolSessionRecord.memoryEnabled`，不在发送或完成时重新读取
App 当前设置。用户中途修改设置不会改变存量运行实例；新建/冷恢复实例使用其创建期值。

```text
会话记录 memoryEnabled
  ├─ accepted command ACK → prompt seed → send_btn / completion / agent_step
  └─ live turn.started → 后台任务 seed → completion / agent_step
                           └─ child step 继承来源 prompt 的值
```

ACK 与 live telemetry fact 增加可选 boolean `memoryEnabled`；缺失保持 unknown，不默认关闭。
新建/选区侧聊 ACK 读取结果 session 的记录，普通发送读取目标 session 的记录。
先于 ACK 的普通事实继续使用现有 pending fact 缓冲；child 启动事实直接沿用父会话字段，不等待 ACK；去重、FIFO、workspace identity 不变。
后台任务不伪造 send_btn；子 Agent 继承来源 prompt 的开关，不把其自身记忆工具使用当开关。
传输只增加无正文元数据，CLI snapshot/历史恢复不补造 telemetry fact。桌面保持
`desktop-continuous` live reporter，手机 `web-remote-replayable` 不安装 reporter；扫码远控的
completion/step 由执行服务覆盖（见下节），命令 ACK 在两端均兼容新字段。

验收：开/关各验证三个事件同值；设置变更后存量实例不漂移；后台轮和 detached child
继承；事实早于 ACK、重复 ACK 保持原有去重；旧 CLI 缺字段留空；非 boolean 协议值被拒绝。
现有 Memory E2E 增加默认关闭与新会话开启的三事件断言。

### 本次验证边界

- 2026-09-17：根工程与 CLI typecheck、根 lint、architecture changed 检查通过。
- UI/协议相关 112 项单测通过；gateway/workflow fact 回归 108 项通过、1 项失败。
  失败项为既有 `Core admission ACK 不等待 TurnStarted projection；旧 revision retry/file rewind 只 stale`，
  使用未修改的 staging gateway 复跑仍得到相同失败。
- CLI lint 被未修改文件的既有 `max-lines` 错误阻塞。
- Memory WDIO 的 `before all` 未能选择 Full access/yolo 模式，未到新增埋点断言；
  不能把本次运行作为桌面开/关埋点的端到端通过证据。手机远控未进行新增实机验证，
  原有 reporter 的 desktop-continuous 边界保持不变。

## 扫码远控执行统计（2026-10-23）

扫码或复制链接进入的 Web Remote Control（含手机 App 使用同一远控 attachment）由执行服务记录
`message_completion`、`agent_step`，沿 PC 既有 TelemetryCore /event/report 投递。此增量不报
`send_btn`、不新增手机 SDK/设备身份/账号认证协议；公共设备和账号仍按 PC 现有口径。
`client_kind=mobile` 在本功能表示扫码远控输入通道，不用于区分原生 App 与手机浏览器；
`message_source` 保留 chat / scheduled_task / off_peak_task / background_task 及 completion 的后台细分。
`workspace_kind` / `remote_kind` 表示执行位置，与客户端来源正交。

```text
可信 remote attachment → Host 覆盖 inputOrigin → 原 CommandInbox admission / input intent
 → live turn.started（inputOrigin、执行配置）→ 执行服务唯一遥测归集器
 → step / turn 终态 → Host 事件 → Desktop main → 既有 TelemetryCore 投递与重试
桌面 continuous → 原 UI reporter；手机 replayable snapshot / recovery → 仅投影，不补报
```

- 每条命令由可信 clientMode 决定来源，不能读取“当前手机在线”或 session 的最后使用端。
  覆盖 createSession 首发、sendText、goal、edit/retry；排队提升保留原 input 来源，不能用提升者覆盖。
- 复用现有纯归集算法，不从 UI rows 推导 token/step，不建立第二份业务 accepted queue。
  手机断开、切页和桌面 pane 未挂载/卸载不销毁执行侧归集器。
- 后台通知合批仍只统计实际执行的一轮；批中包含手机触发时保留 mobile，避免合批漏掉远控来源。
  整批 traceContext 同时传给合批轮和后续 goal 自动轮，不再回退到首条通知的单条来源。
- 同一服务 workspace 中一份归集器；子 Agent / workflow 步骤沿原父消息归因；桌面 reporter
  不再消费被执行侧接管的远控事实。用户在 PC 续聊同一 session 时仍走原桌面统计。
- 去重沿用 eventId、sessionId/sourceCommandId、step_id；重试 ACK、队列提升、快照恢复不重新计数。
- 本机与远端 Source 都在实际 live ingest 处归集。远端通过独立能力声明开放 Host-only 事件，
  旧 Source 不订阅未知事件，须升级 Source 后才能覆盖该远程工作区。
- 执行事实不持久化补造：PC/执行进程退出前尚未产生的终态、进程崩溃期间丢失的事实不承诺补齐；
  已交给 Main 的事件继续使用原投递与重试机制，不新增持久化补报队列。手机断连本身不影响仍运行的执行服务统计。
- Main 在远控事件入队时同步将完整投递 Promise 登记到 TelemetryCore 的 pending 集合；
  正常退出沿用一个 2 秒 drain 预算，覆盖尚在 dispatcher 排队的事件，不为每条事件重新计时。
  顺序为「接收 → 登记完整 Promise → 排队 → 发送 → 移出 pending」，超出预算仍允许退出。

验收：无 UI reporter 下手机首发/续聊成功、失败、取消；工具/模型/前后台子 Agent/workflow；
手机断连后终态；PC/mobile 同 session 交替；不同 workspace 隔离；重复 live fact、队列提升与恢复
不重复；不产生 send_btn；客户端伪造来源被 Host 覆盖；Host → Main 最终 payload 的两个事件
均含 client_kind=mobile，且 Token/步骤、message_source 与原算法一致。
