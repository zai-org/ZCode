# ZCode CLI Compact 实施规划 v2

## 文档定位

本文是 `docs/design/v2/compact/README.md` 的实施规划。compact 语义以 README 为准，实施形态遵循 ZCode 的分层、事件存储和跨平台约束。

相关文档：

- `docs/design/v2/compact/README.md`
- `docs/design/v2/compact/compact-phase-memory-plan.md`

目标不是先做一个“大摘要函数”，而是先把 compact 做成 session 状态机里的可观测边界：有触发、有事件、有 summary、有 post-compact context、有失败和恢复路径。

## 核心结论

### 固定顺序

ZCode 第一版采用固定的 post-compact 顺序：

```text
compact boundary
compact summary
messages to keep
attachments
hook results
```

这条顺序是最重要的不变量。后续 resume、rewind、SDK stream、TUI projection、provider context builder 都从这个顺序理解 compact。

### 固定阈值起点

第一版使用以下默认数值，后续再根据真实 token 统计调整：

| 名称 | 初始值 | 用途 |
| --- | ---: | --- |
| summary output reserve | `min(modelMaxOutputTokens, 32_000)` | 给 summary 输出和后续请求留空间；没有模型输出上限时默认按 32k 预留。 |
| auto compact buffer | `13_000` | 自动 compact 不等到满窗才触发。 |
| warning/error buffer | `20_000` | UI/SDK 的 context warning。 |
| manual compact buffer | `3_000` | 自动 compact 关闭时的阻塞保护。 |
| max auto failures | `3` | 自动 compact 失败熔断。 |
| prompt-too-long retries | `3` | compact 请求自身超窗时丢旧 API round 重试。 |
| streaming summary retries | `2` | summary 流式请求无有效文本时重试。 |

这些阈值不声明环境变量入口。调试、运维 override 需要通过 config file、CLI/session override 或测试注入完成，避免把临时调参路径扩散成长期环境变量契约。

### 固定边界策略

Compact 成功的唯一可信标志是写入 boundary，而不是“拿到了 summary 字符串”。边界必须包含：

- trigger：`manual`、`auto`、`partial`、`reactive`、`session_memory`
- pre-compact token estimate
- last summarized message id
- summarized message count
- preserved segment metadata
- compacted tool/schema state
- traceId、sessionId、turnId、spanId

如果 boundary 或 preserved segment relink 损坏，恢复时宁可保守加载完整历史并打告警，也不要静默丢历史。

## 和 ZCode 分层的映射

| 职责 | ZCode 位置 | 说明 |
| --- | --- | --- |
| `/compact` 命令入口 | `packages/cli` / `packages/tui` | `/compact [instructions]` 命令入口，只解析用户意图。 |
| compact 状态机 | `packages/core/src/compact` | compact 状态机和业务编排。 |
| auto compact 触发 | `packages/core/src/context` + `packages/core/src/compact` | context budget policy 和 auto trigger。 |
| summary prompt | `packages/core/src/compact` | summary prompt 模板；provider 调用仍走 adapter。 |
| microcompact | `packages/core/src/context` + `packages/adapters` | tool result budget 先做本地替换，provider cache edit 后置。 |
| session memory compact | `packages/core/src/memory` + `packages/core/src/compact` | session memory 只是 summary 来源，不能绕过 boundary。 |
| active chain 与 boundary 查找 | `packages/contracts` + `packages/core/src/agent/message-history.ts` | active chain、boundary 查找、post-compact chain 构造。 |
| session 存储 | `packages/adapters/src/storage` | append-only message/part 存储和 resume/relink。 |

Core 不直接读写文件、不读 `process.env`、不直接调用 provider SDK。所有外部 I/O 通过 contracts 注入。

## 里程碑

### M0: 契约落地

目标：先把 compact 变成可以被 replay、resume、UI 和 SDK 识别的事件/part。

产出：

- `CompactBoundary` runtime schema。
- `CompactSummary` runtime schema。
- `CompactTrigger`、`CompactStatus`、`CompactFailureReason` 稳定枚举。
- session event / session part 的 compact payload。
- `buildPostCompactMessages(result)` 纯函数。
- `getMessagesAfterCompactBoundary(messages)` 纯函数。
- `annotateBoundaryWithPreservedSegment(boundary, segment)` 纯函数。

测试：

- boundary 后 active chain 只包含 summary、preserved messages、attachments、hook results。
- 多个 boundary 时以后一个 boundary 为准。
- preserved segment 缺失或损坏时返回保守 fallback，并产生结构化 warning。
- schema 拒绝未知 trigger、缺少 traceId、缺少 summarized anchor 的 payload。

验收：

- 不接 provider，不接 CLI。
- 单测可以证明 compact boundary 已经能驱动 session projection。

### M1: 手动 `/compact` MVP

目标：先做最小可用 full compact。用户手动触发，生成 summary，写 boundary，后续 turn 使用压缩后的 active context。

当前手动 compact 第一刀只承诺 full compact，不做 partial keep segment。实现时需要特别保护持久化边界：summary message、text part 和 compaction part 必须作为一个逻辑写入单元看待；如果 compaction part 写入失败，必须删除已写入的 summary message，避免 resume 把半截 summary 当成真实历史。boundary 必须记录 `lastSummarizedMessageId`，并把同一个值写入 compaction part 的 `tail_start_id`，给后续 rewind、partial compact 和 preserved segment relink 留锚点。

流程：

1. CLI/TUI 解析 `/compact [instructions]`。
2. Core 从最近 boundary 后取 active messages。
3. 如果 message 太少，返回 `Not enough messages to compact.`。
4. 运行 `PreCompact` hook，合并用户指令和 hook 指令。
5. 构造 no-tools summary prompt。
6. 通过 provider adapter 发起单轮 summary 请求。
7. 清洗 `<analysis>`，只保留 `<summary>`。
8. 生成 boundary 和 compact summary。
9. 追加 post-compact attachments。
10. 写入 session log / message part。
11. 运行 `PostCompact` hook。
12. TUI/SDK 收到 `compact.completed` 和 `compact_boundary`。

第一版 post-compact attachments 包含：

- 最近读过的文件：最多 5 个，总预算 50k tokens，单文件最多 5k tokens。
- 当前 plan/todo 状态。
- 已调用 skill 的摘要：单 skill 5k tokens，总预算 25k tokens。
- deferred tools / MCP instructions / agent listing 的 delta。
- session start hook 结果。

测试：

- 自定义 `/compact 重点保留测试输出` 会进入 summary prompt。
- hook 指令会被追加，用户指令在前。
- summary agent 尝试 tool call 时被拒绝，并转为失败或重试。
- compact 后下一轮 context builder 不再包含旧历史。
- compact 失败不会写入半截 boundary。

验收：

- 非交互 `--prompt` 和 TUI 都能触发手动 compact。
- transcript/UI 还能显示旧历史，但 provider active context 只看 boundary 后投影。

### M2: Auto compact

目标：每轮 provider 请求前自动判断是否需要 compact。

当前第二阶段先在 core runtime 内实现 policy 和熔断，不直接读取环境变量。CLI/bootstrap 后续负责把 `ZCODE_` 环境变量和用户配置解析成 `AgentRuntimeConfig.compact`。Auto compact 失败不应让当前用户 turn 失败；它只增加连续失败计数，达到 `maxConsecutiveFailures` 后跳过后续自动尝试，直到一次成功 compact 重置计数。

策略：

```text
effectiveWindow = contextWindowForModel - min(modelMaxOutputTokens, 32_000)
autoThreshold = effectiveWindow - 13_000
shouldCompact = activeTokenEstimate >= autoThreshold
```

跳过条件：

- 用户配置关闭 compact。
- 用户配置关闭 auto compact。
- `querySource` 是 `compact`、`session_memory`、summary agent、subagent 内部压缩路径。
- 当前 session 的连续自动 compact 失败数达到 3。
- 历史不够压缩：入口按全部存储条目判断（至少 2 轮、至少一条 assistant），和 reactive compact 的入口相同；
  请求投影删除的回复仍然算历史。入口不够时直接跳过，不写 compact 时间线。通过入口后，compact 保留最后一轮，
  只对其余部分再判断一次，不够时写一条 Skipped 时间线；正常回复的历史也是这样。

测试：

- token 超阈值触发 auto compact。
- 低于阈值不触发。
- compact 自身请求不会递归 auto compact。
- 失败 3 次后熔断，后续 turn 不再重复烧 provider。
- 成功后 consecutive failures 归零。

验收：

- `compact.started`、`compact.completed`、`compact.failed` 都带 pre/post token、threshold、willRetriggerNextTurn。
- auto compact 失败时当前 turn 可以继续使用原 messages，除非 provider 后续真实返回 context overflow。

### M3: Prompt-too-long 与 overflow 兜底

目标：处理两种最容易卡死用户的情况。

主 session 不负责自己裁剪历史。它只识别 provider context overflow，
把恢复动作交给 compact，并在 compact 成功后重试当前 model step。这样
active context 的裁剪、summary 生成、boundary 持久化和 resume/replay 语义
都收口在 compact 模块内，避免主 session 和 compact 各自维护一套丢弃策略。

第一种：compact 请求自身 prompt-too-long。按 head 截断后重试：

- 按 API round 从旧到新分组。
- 根据 provider 返回的 token gap 丢旧组。
- token gap 不可解析时丢最旧 20% group。
- 保证剩余消息不以 assistant 开头，必要时插入 meta user marker。
- 最多重试 3 次；第 3 次仍失败后，compact 返回不可自动重试的
  `model_context_exceeded`，不能再被 auto compact 外层 retry 放大成 3x3。
- 当前实现先覆盖文本消息路径：compact summary provider 调用抛出或返回 prompt-too-long 文本时，runtime 会截掉最旧 round 后重建 compact request，并为每次尝试追加独立 `model_request` 事件。
- 截断只影响 summary 模型看到的输入；compact 成功后仍创建标准 full compact boundary，并把 active context 替换为 summary message。
- 如果 3 次后仍然 PTL，手动 compact 暴露 `model_context_exceeded`，auto/reactive compact 继续按现有失败降级策略处理。

第二种：主请求已经 prompt-too-long：

- 只做 overflow detection，不在主 session 内删除消息。
- 调用 reactive compact：`CompactTrigger.Reactive`，`CompactReason.ProviderOverflow`。
- reactive compact 成功后重放本轮 provider 请求。
- 仍失败才把 context overflow 作为用户可见错误抛出。
- 入口按全部存储条目判断历史是否够压缩（至少 2 轮、至少一条 assistant），和 auto compact 的入口相同。
  请求投影删除的回复（没有工具调用、只有思考或空白）仍然算历史；入口不够时直接跳过，不写 compact 时间线。
  通过入口后，compact 保留最后一轮，只对其余部分再判断一次，不够时写一条 Skipped 时间线，再抛出超窗错误。
- reactive retry guard 的作用域是当前 model-step 重试链：reactive compact 成功后 guard 保持已使用，
  原地重试仍然 context overflow 时直接抛出 `model_context_exceeded`，避免无限重试；只有同一
  product turn 的完整 sibling tool result batch 全部终态、持久化并完成 guide drain 后，才进入下一个
  model step 并重新开放一次 reactive compact。
- no-tool stream recovery、Start Plan admission retry、Stop hook continuation、compact skipped/failed、
  部分或中止的 tool batch 都不构成 guard 重置边界。
- 只有实际写入 compact boundary 的成功 compact 才更新快速回填 tracker；健康 no-op 的
  `skipped` 不重置 `toolTurnsSinceCompact`，也不计入连续快速回填。
- auto/reactive compact 共用当前 product turn 的快速回填跟踪：每次 compact 成功后从 0 统计完整
  tool batch；如果上下文连续 3 次都在不足 3 个 tool turn 内重新达到 compact/overflow 条件，则在第
  3 次回填处熔断，不再启动下一次 compact，并暴露可操作的 `model_context_exceeded`。达到至少 3 个
  tool turn 后再回填会把连续快速回填计数归零。
- 快速回填熔断与现有 compact 连续失败熔断互相独立；前者只活在当前 product turn，后者继续按
  session 级失败计数工作。
- reactive compact 复用 full compact 边界事件，`CompactBoundary.trigger = reactive`，并继续写入 summary message + compaction part，因此 resume、fork、rewind 都能从同一个 compact boundary 恢复。
- reactive compact 尊重 `compact.enabled === false`；禁用时直接暴露 provider context overflow，不做隐式状态改写。
- 如果 reactive compact 自身失败，当前 turn 暴露原始 context overflow，compact 失败只进入日志，不污染 active provider history。

测试：

- compact summary 请求 PTL 后会丢旧 round 并重试。
- 重试仍失败时给用户可操作错误。
- 主请求 PTL 后 compact 成功会继续原 turn。
- 同一 model-step 的 reactive 原地重试再次 overflow 时不启动第二次 compact。
- 完整 tool result batch 后的后续 model step 再次 overflow 时允许第二次 reactive compact。
- 连续 3 次快速回填会熔断；达到 3 个 tool turn 后再回填会重置 streak。
- media/document 过大时先替换为 `[image]`、`[document]` 再 summary。

验收：

- 用户不会因为“summary 请求也太长”陷入无法继续的死局。
- 所有 PTL retry 都有 trace/span 和 dropped message 统计。

### M4: Tool result budget 与 local microcompact

目标：不要把 full compact 当成唯一降压手段。先裁剪工具结果，再总结历史。

第一阶段做 provider-neutral 本地 message projection：

- 大 tool output 进入 artifact/storage。
- provider context 只保留摘要、hash、artifact ref、截断说明。
- 对已经进入 active history 的旧 tool result，在请求前替换为稳定占位符，例如 `[Old tool result content cleared by microcompact]`。
- 原始 tool part、transcript、artifact 和 checkpoint 不删除；microcompact 是 provider-visible projection，不是 full compact boundary。
- Read/Bash/Grep/Glob/Edit/Write/WebFetch/WebSearch 优先覆盖；`WebSearch` 有本地 tool result budget，内部 provider-native `web_search` side request 的 sources 和内容会折叠进普通 tool result。

当前第一阶段已落地的子集：每个 tool contract 声明 `resultBudget`；tool executor 会在进入 provider-visible context 前按 `maxModelBytes` 截断或写入 artifact，`ToolCallResult` 事件携带 `truncated`、`originalBytes`、`returnedBytes`、`budgetStrategy` 和 `artifactPath`；runtime 注入模型的是预算后的 `modelContent`；runtime 会在每次模型请求前执行 provider-neutral local microcompact projection。

本批已落地 local microcompact：

- `time_based`：main/root session 中，距离最近 assistant 完成超过默认 60 分钟时，清理旧 compactable tool result，至少保留最近 1 个，默认保留最近 5 个。
- `token_pressure`：active context 超过 local microcompact 阈值时，清理旧 compactable tool result；阈值应低于 full auto compact 阈值，避免 summary 过早触发。
- `microcompact_boundary` 事件记录 trigger、strategy、pre/post token estimate、tokensSaved、clearedToolCallIds、keptToolCallIds、traceId 和 turnId。
- local microcompact 成功后替换内存 `messageHistory` 的 provider-visible messages，但保留最近 assistant 的 provider usage baseline（按反向扫描找最近 usage），属于有意接受的近似计算。session store 保留原始 tool part，resume 后再次按 policy 投影。

再后置做 provider cache edit/reference：

- 只有 provider adapter 声明支持时启用。
- cache 删除成功后才发 `microcompact_boundary` 或 equivalent event。
- 本地消息不伪装成已经服务端删除。

测试：

- 超预算 tool result 不直接回灌模型上下文。
- artifact ref 可追踪到完整输出。
- local microcompact 会清理旧 tool result 但保留 tool_call/tool_result 配对。
- microcompact 不创建 full compact boundary。
- provider 不支持 cache edit 时自动降级为本地 projection。

验收：

- 大输出不会直接把下一轮推到 auto compact。
- UI 仍能打开完整 tool output。
- resume 后不会依赖 microcompact event 裁剪历史；下一次请求前可以重新投影。

### M5: Partial compact 与 rewind 衔接

目标：等 message selector / rewind 基础稳定后，再做局部 compact。

支持两个方向：

- `from`：总结 pivot 之后的消息，保留更早上下文。
- `up_to`：总结 pivot 之前的消息，保留更新上下文。

关键不变量：

- 不能拆开 tool_use/tool_result pair。
- 不能拆开同一个 assistant message id 的 thinking/tool block。
- `up_to` 方向要去掉 kept segment 里的旧 compact boundary 和旧 compact summary，避免后向扫描命中旧边界。
- boundary 必须记录 preserved segment relink 信息。

测试：

- 两个方向的消息顺序稳定。
- pivot 落在 tool pair 中间时自动扩展 keep/summarize 范围。
- partial compact 后 rewind 只显示合法范围。
- relink 成功时 resume active chain 一致。
- relink 失败时保守加载完整历史并打 warning。

验收：

- UI 明确标注 compact 前 checkpoint 的风险。
- compact 后只承诺 rewind 到 boundary 之后。

### M6: Session memory compact

目标：把 session memory 作为可选加速路径，而不是另一个 compact 系统。

触发条件：

- 只在没有用户自定义 summary 指令时尝试。
- 等待正在进行的 memory extraction。
- session memory 文件不存在、为空模板、lastSummarizedMessageId 找不到时返回 `null`。
- 默认保留最近上下文：min 10k tokens、至少 5 条 text message、max 40k tokens。
- 压缩后仍超过 threshold 时返回 `null`，回退传统 compact。

测试：

- session memory 可用时不调用 summary provider。
- session memory 不可用时安全回退传统 compact。
- memory compact 仍产出相同 boundary/summary/post-context。
- lastSummarizedMessageId 在 compact 成功后重置。

验收：

- 对调用方来说，session memory compact 和传统 compact 的返回结构完全一致。

### M7: UX、SDK 与观测补齐

目标：让 compact 不只是能跑，还能被用户、SDK 和后续 agent 理解。

事件：

- `compact.started`
- `compact.progress`
- `compact.boundary.created`
- `compact.summary.created`
- `compact.completed`
- `compact.failed`

持久化轨迹：

- compact lifecycle 必须额外写入一条 synthetic timeline message。它不是 provider-visible summary，也不是 tool call；它只服务 transcript、TUI、ZCode app-server replay 和恢复诊断。
- timeline message 使用 `compaction` part，但 `timelineStatus` 表示 `started` / `completed` / `failed` / `interrupted`，只有带 `compactBoundary` 的 compaction part 才能作为 active-chain 截断边界。
- compact 开始先写 timeline message + `compact_started` event；summary 和 boundary 写成功后，再把同一条 timeline message 更新为 `completed` 并写 `compact_completed` event。
- 进程在 summary 请求中被中断时，下一次 `resumeFromStore()` 扫描到没有 terminal 状态的 timeline part，应把它标记为 `interrupted`。如果已经存在同 operation 的 boundary，则恢复成 `completed`。
- ZCode app-server 不新增主路径通知。bootstrap 把 compact lifecycle 投影成 `agent_message_chunk + messageId + _meta["zcode.timeline"]`，client 识别 meta 后渲染为 separator；泛 ZCode protocol client 显示 fallback 文本。

指标：

- trigger、querySource、traceId、sessionId、turnId。
- preCompactTokenCount。
- compaction input/output/cache tokens。
- truePostCompactTokenCount。
- autoCompactThreshold。
- willRetriggerNextTurn。
- summarized/kept/attachment message counts。
- failure reason、retry count、circuit breaker state。

用户提示：

- 手动 compact 成功：`Compacted`，verbose 时显示 summary，否则只给打开完整 summary 的提示。
- 自动 compact：TUI spinner/status，SDK `status=compacting`。
- 失败：手动 compact 给明确错误；auto compact 默认静默记录，避免中断当前工作。

测试：

- SDK stream 能收到 compact boundary。
- TUI 能渲染 compact boundary。
- CLI 非交互 transcript 写入 compact part。
- 日志不泄露完整旧 transcript，debug 模式可通过 artifact ref 追踪。

## 第一批不做

这些能力后续再做，不要塞进第一批：

- context collapse。
- provider cache edit 版 microcompact。
- session memory compact。
- partial compact。
- subagent 独立 compact 策略。
- 跨 session 长期 memory 合并。
- 复杂 UI message selector。

第一批只做：契约、手动 full compact、auto compact、PTL retry、基础 tool result budget、provider-neutral local microcompact。

## 推荐 PR 拆分

1. `compact contracts and projection`
   - schema、event、active chain、post-compact builder、测试。
2. `manual compact command`
   - `/compact`、summary prompt、provider adapter 调用、post-compact write、测试。
3. `auto compact policy`
   - token threshold、recursion guard、failure circuit breaker、telemetry、测试。
4. `compact overflow fallback`
   - PTL retry、media stripping、reactive compact 最小路径、测试。
5. `tool result budget`
   - 大输出 artifact 化、context projection、UI 引用、测试。

## 验证清单

每个实现 PR 至少跑：

- `npm run lint`
- `npm test`

关键单测必须覆盖：

- active chain 从最后一个 boundary 后开始。
- compact 成功写入 boundary 和 summary。
- compact 失败不写半截状态。
- auto compact 阈值、关闭配置、递归保护、熔断。
- prompt-too-long retry。
- resume 后不会加载被裁剪历史。
- preserved segment relink 成功/失败。
- tool output 超预算不直接进入模型上下文。

## 风险和约束

- Summary 是有损操作，prompt 必须强制保留用户显式约束、文件路径、错误修复、当前工作和下一步。
- UI scrollback 和 provider active context 必须分层，不能让用户误以为旧历史仍逐字可见。
- Compact 的 provider 请求、hook、session write 都要继承同一个 traceId。
- Compact 不能在低层吞错；只有 auto compact 可把失败降级为“本轮继续，记录 consecutive failure”。
- Core 不能直接依赖文件系统、provider SDK、`process.env` 或 shell。
- 所有配置和环境变量必须使用 `ZCODE_` 前缀。
