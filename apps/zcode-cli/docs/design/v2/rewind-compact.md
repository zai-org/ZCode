# Rewind 与 Compact 协同设计 v2

## 文档定位

本文定义 ZCode v2 中 rewind、checkpoint 与 compact 的共同状态模型。它不是 UI 设计稿，也不是文件恢复 adapter 的实现细节；它先固定三件事：

- compact 之后哪些 conversation rewind 是合法的。
- compact 前的 file checkpoint 如何继续可用。
- 消息附件和大文件 artifact 在 compact、rewind、fork 中如何保留或降级。
- rewind / checkpoint 需要进入哪些可恢复、可审计的 contract。

Compact 管模型可见上下文；rewind 管会话和工作区状态恢复。二者共享 session event log 和 message/checkpoint 锚点，但不能互相直接篡改对方的历史。

Conversation rewind 的分阶段实施计划见 [`rewind/plan.md`](./rewind/plan.md)。该计划把本文的 contract 落到 runtime、session store、TUI 和 ZCode app-server 的实现顺序，并记录了需要保留的语义边界。

## Auto Compact 触发依据

Auto compact 的触发必须优先使用 provider 返回的真实输入 token 用量，而不是本地字符估算。模型每次请求完成后，runtime 记录该请求的 `usage.inputTokens`、请求时的 provider-visible message 数量、模型引用和 trace 信息；下一次进入 auto compact 判断时：

1. 如果存在可用的真实 `usage.inputTokens`，以它作为基线 token 数。
2. 如果上一轮请求后又追加了 assistant、tool 或 user message，只对新增 message 做本地估算，并加到真实基线上。
3. 如果没有真实 provider 用量，才退回到对当前 active chain 的全量本地估算。

这样做的原因是 OpenAI-compatible provider 可能在 tokenizer、工具 schema、reasoning 或服务端包装上与本地估算存在数量级差异；真实服务端用量是 compact 决策的最高优先级事实源。

本地估算是 provider usage 不可用时的保守水位判断。它必须同时计算普通正文和
`reasoning` block 的文本；不能复用只投影可见正文的 helper 后把 reasoning 计为 0。
provider 返回的 `reasoningTokens` 已包含在 `outputTokens` 中，复用 usage anchor 时不得再次
累加。该估算仍使用字符数近似 token，不承诺与具体 provider tokenizer 完全一致，也不会修改
canonical history 或 provider-specific reasoning 回放规则。

如果 provider 通过 finish reason 表示上下文溢出，例如 GLM SSE 中的 `model_context_window_exceeded`，runtime 必须把它归一为 `ModelContextExceeded`，触发 reactive compact 或向上抛出结构化错误，不能把空内容当成普通 `end_turn`。

## 核心原则

### 1. Event log 是事实源

所有 compact、checkpoint、rewind 都追加 event 或 part，不删除旧历史。UI 可以隐藏 compact 前的 scrollback，provider active chain 可以从 compact boundary 后开始，但审计和高级恢复仍应能从 event log 或 transcript 找到旧状态。

### 2. Active chain 是模型可见投影

Full compact 后，active chain 默认只包含：

```text
compact boundary
compact summary
preserved messages
attachments
hook results
messages after compact
```

因此 conversation rewind 默认只能选择 active chain 内的 message。选择 compact boundary 之前的 message，不能假装是普通 rewind。

### 3. Workspace checkpoint 独立于 conversation visibility

文件修改 checkpoint 不应因为 compact 被删除。即使 checkpoint 的锚点 message 已经被 compact 覆盖，仍可以执行 file-only rewind。执行后必须追加新的 `rewind_triggered` 事件，并在下一轮模型上下文中说明工作区已恢复到哪个 checkpoint。

### 4. 跨 compact boundary 的 conversation rewind 使用 append-only branch cut

用户回到 compact 前的 conversation point 时，当前 session 不物理删除旧 message/part，也不自动
创建 child。session 持久化 `keptMessageIDs + branchCutAfterMessageID + branchGeneration`，active
branch 由保留前缀与 cut 之后的新消息组成；随后才在 active branch 内选择最后一个 compact
boundary 构建 provider history。被 cut 掉的 compact summary/boundary、microcompact、context usage
和 read-file 派生状态必须重建，且不得追加描述旧 prompt 的 model-visible reminder。

### 5. 附件 artifact 独立于 workspace checkpoint

用户消息里的图片、PDF、二进制和大文本 preview 属于 session input artifact，不属于 workspace mutation checkpoint。file-only rewind 恢复工作区文件时，不应重新解释已经提交的附件；conversation rewind 清理 message/part 时，也不应立即删除附件 artifact。附件 artifact 通过引用计数或未引用扫描延迟 GC。

## Rewind 范围

`RewindScope`：

- `conversation`：只恢复模型可见消息链，不改文件。
- `workspace`：只恢复文件/工作区 snapshot，不改 conversation active chain。
- `both`：同时恢复 conversation 与 workspace。

`RewindStrategy`：

- `active_chain`：目标仍可从 append-only transcript 重建，当前 session 可直接应用；允许跨 compact boundary。
- `file_only`：目标 checkpoint 可恢复，但 conversation target 已被 compact 覆盖。
- `fork_required`：仅保留给显式 fork/workspace fork 结果；conversation edit/retry 不再因 compact 命中该策略。
- `unavailable`：目标不存在，或没有可用 checkpoint。

## Compact 与 Rewind 的交集

### Full compact

Full compact 写入 `CompactBoundary.lastSummarizedMessageId`，表示边界之前最后一个被 summary 覆盖的 message。之后：

- active chain 从 compact boundary 开始。
- compact 前 conversation checkpoint 默认不出现在普通 message selector 中。
- compact 前 file checkpoint 可以出现在高级 checkpoint 列表中，但必须标注 `covered_by_compact`。

### Partial compact

Partial compact 必须记录 `preservedSegment`：

- `headMessageId`
- `anchorMessageId`
- `tailMessageId`

如果 target 在 preserved segment 中，conversation rewind 可以按 active chain 处理。如果 target 被 summary 覆盖，则按 full compact 的规则处理。

Partial compact 不能拆开 tool_use/tool_result pair，不能拆开同一个 assistant message id 的 thinking/tool block。`up_to` 方向保留的 segment 里必须移除旧 compact boundary 和旧 compact summary，避免后向扫描命中旧边界。

### 最近保留段的持久化与冷恢复

Auto/reactive compact 已选中的 recent groups 不进入 summary，必须在 live 与冷恢复中保留相同的已持久化内容。以既有 assistant-started round 为选择单位：持久化侧按相同的组数取最近组，再记录原始 `headMessageId / tailMessageId`；不得把 runtime 中按来源过滤得到的消息数用于截取数据库中的另一份候选列表。`keptMessageCount` 从实际选中的持久化记录计算，仅作统计，不能反过来决定区间。

组内 user、coordinator、子 Agent 回信、后台任务通知及已持久化的 Runtime Attachment 均保留原文、身份和呈现标记。`synthetic`、`model-only` 和 `source` 表达输入身份或 UI 可见性，不是丢弃 provider 上下文的依据。工具结果随所属 assistant 的 tool parts 一起恢复。compaction 控制记录、`providerVisibility=hidden` 的 timeline 记录和没有模型内容的失败记录继续排除；request-local 的提示不新增持久化副本，仍按各自生命周期生成。

```text
runtime 最近 N 个 assistant groups ──> live 原样保留
                  |
active session 同样取最近 N 组 ──> 保存区间 ID ──> 冷恢复整个区间
                                                    |
                                     统一 MCS / 非 MCS 投影
```

复用既有区间 schema，不迁移旧数据库。旧区间也恢复其中已有的 synthetic/attachment；无法从历史区间推断当时被错误排除在区间外的消息，不追溯扩展边界。保留段只参与 provider history，不改变 compact 后 timeline 的最新消息锚点。Desktop continuous 和手机 replayable 继续消费同一 CLI 权威历史，不改变各自传输、恢复边界。

回归必须经过实际 compact boundary 持久化与冷 hydration，并验证 MCS 开关下原文、完整 reminder、角色、工具批次和次数；仅复制 runtime entries 的测试不能证明冷恢复正确。

### Compact 之后的上下文布局

compaction 结果的顺序（boundary → 请求前公告 → summary → 保留段 → compaction 附件）：

```text
[context prefix (system)]
[请求前公告] context_prefix → session_context → date   仅当保留段非空；保留段已有的来源不重复（date 也一样：保留段里有日期公告时，即使已过期也不放，之后的请求在末尾宣告一次变化）。context_prefix 只认完整块：保留段只有增量时也放完整块；保留段有完整块时不放，内容变化由下一次请求追加增量（reason `compaction`）
[summary]
[保留段]
[compaction 附件] 文件恢复 → plan_file_reference → runtime_mode（计划模式下的完整提醒，保留段已有完整提醒时不发）
                  → tool_search_announcement → agent_listing_delta → skills_listing → environment → model
                  → output_style_instructions
```

- compaction 附件（含文件恢复与 plan_file_reference）都参与冒泡，附件之间保持生成顺序。支持 MCS 时它们都是 system，在 user run 末尾按上表顺序合成一条 system；不支持 MCS 时都是 user 侧 reminder，顺序相同。
- 文件恢复（`resume_referenced_session_context`）在 summary 返回之后重读磁盘上的当前文件，不用读取状态里缓存的视图：
  - 候选：compact 前读取状态里 `Read`、`Write`、`Edit` 留下的记录。不选 Bash 回填、Recall 注入、`MEMORY.md` 初始记录和工作流草稿的记录；不选 plan 文件、已加载进上下文前缀的指令文件，以及 `.codex/memories/`、`docs/superpowers/plans/`、`.git/` 下的文件；不选保留段里 Read 过的文件（路径按当前工作目录解析后比较；返回 `file_unchanged` 的 Read 不算，它只指向已被摘要的旧结果）。
  - 选择：按时间从新到旧先取 5 个，再读取；读取失败或被跳过的文件照样占名额。本进程写入的记录（包括 rewind 重建的记录）按文件的 `mtimeMs` 排序，冷恢复出的记录（`restoredFromSession`）按读取时间排序；缺 `mtimeMs` 时用读取时间。
  - 读取：整个文件，不带 `offset` / `limit`。不走工具调用流程：没有 hook、工具事件和权限弹窗；只跳过命中读权限 deny 规则的文件，ask 规则照常读取；判定与 Read 工具调用共用同一个模式与规则判定，规则只加载一次。规则按原始字符串匹配，所以记录的规范化路径和工具输入的原始写法（读取状态的 `requestedPath`：live 由工具记下，冷恢复取自 tool part 的输入）各判定一次，任一命中 deny 就跳过：同一写法的 Read 被拒的文件不会被补回。补回后写回的记录保留原始写法。plan 文件和补回文件并行读取。只补回文本文件：图片、视频、PDF 和 Read 预检不通过的文件（二进制、设备文件）跳过。读取传入取消信号，读完再检查一次；取消时整个 compact 取消，不产出附件。
  - 内容：`Called the Read tool with the following input: {"file_path":…}`，换行后是 `Result of calling the Read tool:` 和 Read 工具结果原文。估算超过 5k token，或超过 Read 的文件大小上限时，只放引用提示（"Note: … was read before the last conversation was summarized, but the contents are too large to include. Use Read tool if you need to access it."）。按顺序累加，总量超过 50k token 的文件丢掉，不放提示（单文件不超过 5k、最多 5 个文件时实际不会触发）。
  - 读取状态：compact 后的 live 表只含补回的文件，记录规则与重启后的行为见 [Read File State Resume](tool/17-read-file-state-resume.md) 的“Compaction 之后”。
  - 补回内容随 compaction 附件一起持久化，冷恢复读到相同字节，不再重读磁盘；已有的 compaction 不改写。

- 输入附件在 compaction 之前运行，属于保留段或被摘要；同一请求在 compaction 之后不再收集输入附件，只运行按历史去重的请求前公告。保留段为空（manual compact）时，请求前公告由下一次请求追加在末尾。
- `total_tokens_reminder`（见 `loop/meta-user-context.md`）：compaction 不重述它。auto/reactive compaction 前收集的那条在保留段里，摘要请求和 compaction 后的第一个请求不产生新提醒。auto 与 reactive 成功后，runtime 把 compact 前最近一条带 usage 的 assistant 的上下文量加进计数器的 rolled；manual compact 不加，下一条真实用户消息会重新起算。
- summary 文本：续写提示（"Continue the conversation…Pick up the last task as if the break never happened."）之后，保留段非空时再追加 `\n\n` 和尾注 "The messages after this summary are the most recent messages from before compaction, kept verbatim. The summary was written without seeing them, so something it says has not happened yet may already have happened in them."。判定与请求前公告相同（保留段非空）；manual compact 不带尾注。尾注随 summary 文本持久化，冷恢复读到相同字节；已有 summary 不改写。
- summary 是普通 user 消息，按用户输入参与相邻 user 的换行规则：summary 前紧挨的 user 文本（例如保留段非空时的请求前公告）以 `\n` 结尾。判断依据是 `compactBoundary`，不按 `legacy_synthetic` 来源（旧的后台通知也用这个来源）。
- 压缩提示词包括第 6 节末尾的用户消息归属说明（"Only messages that actually came from the user (user-role turns) count as user messages…"）和 `</example>` 之后的换行。
- runtime_mode 由 compaction 重述：计划模式下发一条完整的 plan 提醒。保留段在当前计划段（最近一次退出计划模式之后）已有完整提醒时不发：auto/reactive compaction 与输入附件收集在同一次循环中，保留段可能已带本次收集的完整提醒，再发一条会出现两条完整提醒，完整／简短周期也多算一次。保留段只有简短提醒时，完整说明已被摘要，照常发完整提醒。
- environment 与 model 由 compaction 重述：保留段已有完整 environment 块时不重述 environment，否则用 compact 前历史中最近一次公告的快照发完整块；保留段已有 model 公告时不重述 model，否则重述 compact 前最近一次 model 公告。compact 前历史里没有对应公告时不重述，由下一次请求的输入附件收集追加（完整环境块、当前模型）。
- output_style_instructions 在 model 之后重述：保留段已有该来源（包括重置）时不重述；否则重述 compact 前最近一次公告，最近一次是重置时不重述。它不受 environment/model 的 env_info 门控。
- 持久化：请求前公告、summary、compaction 附件按上表顺序在同一事务中写入（`SessionStorePort.commitMessageBundle`），存储顺序与 live 一致；只有 summary 成功产出时才写入。store 未实现该方法时逐条写入，失败时尽力删除已写入的记录。
- 声明：summary 的 compaction part（与 `compactBoundary.preservedSegment` 同一个 part）在 `metadata.compactLeadingMessageIds` 中记录请求前公告的消息 ID。只记录 summary 之前的公告；compaction 附件可能在下一次 compact 时与最后一组一起被保留，不得写入该列表。
- 冷恢复：最后一个 boundary 声明的请求前公告放在 summary 之前。切片 `preservedSegment` 区间时，跳过所有 summary 声明的请求前公告：保留段可以落在上一次 compact 的保留段里，此时区间在存储顺序上跨过上一次的公告和 summary；这些公告在压缩后的第一组，总被下一次 compact 总结，不会出现在 live 保留段中。
- fork：重映射 `compactLeadingMessageIds`；映射不到的 ID 丢弃，不阻断 fork（旧版本 fork 会原样复制该字段）。
- 旧版本兼容：不改 strict 的 `compactBoundary` schema。`CompactionPart.metadata` 不进入 App 协议，旧版本按 JSON 读取 part 时忽略它。旧版本冷恢复时，summary 之前的公告不在 `slice(boundaryIndex)` 范围内，会被漏掉；跨过的保留段可能带回上一次的公告。这两种情况只影响上下文内容，不会导致读取失败。
- git status 与分支：规则只看历史（见 `loop/meta-user-context.md`）。保留段非空且其中没有 `session_context` 时，compaction 通过 `ContextSourcePort.resolveGitContext` 按当前目录重新读取（分支直接读取，不使用轮询缓存），是仓库才在 summary 之前宣告；保留段为空时由下一次请求读取。读到的 Git 只进入公告，不改 runtime 的 context 快照，compact 写库失败时不留任何 Git 事实。没有 context port 的运行时沿用会话起始快照。
- skills_listing：在 compaction 附件中紧跟 agent_listing_delta。保留段里没有 skills_listing 且当前 skill 目录不为空时重述完整列表，判定与输入附件收集相同；compact 后的第一次请求就带 skill 名单。ZCode 不找回已调用的 skill。已恢复列表的原位更新见 `loop/meta-user-context.md`。
- 指令文件与 `MEMORY.md`：summary 返回后，与文件恢复并行重读（异步 IO，传入取消信号）。只更新 runtime 持有的指令内容与 Memory 索引，不改工作目录、环境、Git 预取标记。读取失败时沿用原内容并记 warn；取消时整个 compact 取消。重读结果先只用于生成 summary 之前的 context_prefix（见上表）；compact 成功落库后才交给 runtime，同时把指令增量的 reason 改为 `compaction`（之后不再改回）。compact 失败或取消时 runtime 的内容和 reason 都不变。保留段为空时由下一次请求宣告完整块。`MEMORY.md` 的读取状态在 compact 读取状态装好之后按重读的内容写入。没有 context port 的运行时（子 agent）不重读。

### File rewind after compact

执行 compact 前 checkpoint 的 file-only rewind 时，runtime 必须：

1. 校验 checkpoint snapshot 可用。
2. 恢复 workspace snapshot。
3. 追加 `rewind_triggered` event，`strategy=file_only`。
4. 追加一条可进入模型上下文的 synthetic user/status message，说明恢复的 checkpoint、文件数量和风险。
5. 不改变 active chain 的 compact boundary。

### Fork rewind

`/fork latest` 和 `/fork <checkpointId>` 创建新的 child session，而不是在当前 session 中删除或改写历史。第一版 fork 的目标是提供“从这里开一条新线”的体验，同时保持实现可恢复：

1. 当前 session 保留完整历史和 compact boundary。
2. child session 的 `parentID` 指向当前 session。
3. child session 复制父 session 从开头到 checkpoint 所在 message 的 message/part，并重新生成 message/part id，避免跨 session 主键冲突。
4. attachment `FilePart` metadata 随 message/part 复制；immutable attachment artifact 可以共享 URI 或增加引用计数。
5. 如果父 session 的 attachment artifact 缺失，child session 必须把对应 part 降级为 `[Missing attachment: ...]` fallback，并记录 debug event。
6. runtime 恢复 checkpoint artifact 中的 workspace 文件。
7. child session 追加 synthetic user/status message，说明 fork 来源、checkpoint、恢复文件、附件降级和 compact 风险。
8. 当前 session 追加 `session_forked` event；TUI 可以把 active app 切到 child session。

如果 checkpoint 的锚点 message 已经被 compact 覆盖，fork 仍然允许；这正是 compact 前 conversation rewind 的默认路径。它不是在原 session 里假装回到旧消息，而是显式开新 session。

### Attachment artifact after rewind

conversation rewind 的 cleanup 只改变 active chain 或删除目标点之后的 message/part 引用，不立即删除附件 artifact。这样可以支持：

- 用户误 rewind 后再 fork 回旧分支。
- compact summary 仍能解释曾经存在过的附件。
- artifact store 后续按引用扫描或保留期做 GC。

file-only rewind 只恢复 workspace checkpoint。即使恢复后的工作区文件路径和某个附件原始 `file://` 路径相同，已提交附件仍以提交时 snapshot 的 artifact 为准，不能重新读取当前工作区文件覆盖历史附件。

part 级 rewind 如果目标在同一 user message 内，必须用 `FilePart.source.text` 判断哪些附件 placeholder 被删除。删除 placeholder 后，对应 `FilePart` 不再进入模型投影，避免 orphan attachment 继续发送给 provider。

## Contract

### CheckpointCreatedPayload

字段：

- `checkpointId`
- `messageId`
- `scope`
- `snapshotRef`
- `diffRef?`
- `fileCount?`
- `compactBoundaryId?`
- `coveredByCompact?`

`coveredByCompact=true` 表示该 checkpoint 的 message 锚点已经不在当前 active chain 中，但 snapshot 仍可能可以 file-only restore。

### RewindTriggeredPayload

字段：

- `rewindId`
- `scope`
- `strategy`
- `targetMessageId?`
- `targetCheckpointId?`
- `compactBoundaryId?`
- `restoredSnapshotRef?`
- `createdMessageId?`
- `reason?`

`strategy=fork_required` 的 event 可以作为 UI/SDK 的 intent 记录；真正 fork 由 session service 追加 `session_forked`。

### SessionForkedPayload

字段：

- `originalSessionId`
- `forkedSessionId`
- `targetMessageId?`
- `targetCheckpointId?`
- `restoredSnapshotRef?`
- `restoredFileCount?`
- `strategy`
- `attachmentArtifactRefs?`
- `missingAttachmentRefs?`

### CompactBoundary 附件字段

Compact boundary 需要记录附件摘要字段，供 debug、fork 和 rewind 判断：

- `attachmentMessageIds?`
- `strippedAttachmentCount?`
- `strippedAttachmentBytes?`
- `strippedAttachmentRefs?`
- `missingAttachmentRefs?`

这些字段只描述 compact 时被 strip 或降级的附件，不表示附件仍在 active model context 中。

## 第一批实现

- runtime schema：checkpoint payload、rewind payload。
- workspace checkpoint artifact schema：`workspace_file_before_change`，包含每个文件的路径、是否原本存在、修改前内容和结构化 diff。
- `evaluateRewindTarget()`：根据 message list、target id、scope、checkpoint 可用性判断策略。
- event payload 类型接入 `SessionEventPayload`。
- projection 记录 `lastCheckpoint` 和 `lastRewind`。
- 文件 mutation 成功后写 checkpoint artifact，并追加 `checkpoint_created`。
- `/rewind` 展示最近 checkpoint；`/rewind latest` 或 `/rewind <checkpointId>` 执行 workspace file-only restore。
- `/fork latest` 或 `/fork <checkpointId>` 创建 child session、复制消息链并恢复 workspace snapshot。
- restore 只通过 `ToolArtifactStorePort.readToolResultArtifact()` 和 `FileSystemPort.writeTextFile/removeFile()` adapter 完成，不直接触碰底层 fs。
- attachment artifact 先只做保留和引用，不随 rewind cleanup 立即删除。
- 单测覆盖 compact 后 active target、compact 前 file-only、compact 前 conversation fork-required、missing target、fork attachment fallback、rewind 不误删 artifact。

不做：

- TUI message selector。
- partial compact runtime。

## 后续里程碑

1. `contracts: rewind checkpoint payloads`
   - schema、event payload、projection、纯函数。
2. `core: create checkpoints around file mutations`
   - 写文件前后通过 file-system adapter 建 snapshot，事件带 traceId。
3. `core: file-only rewind`
   - 恢复 snapshot，追加 synthetic context message。
4. `tui: checkpoint selector`
   - 当前先通过 `/rewind` 命令和 live event 展示；后续再做 active chain target selector，compact-covered checkpoint 进入高级列表。
5. `core: fork-required conversation rewind`
   - compact 前 conversation rewind 创建 fork，而不是污染当前 active chain。
   - 第一版通过 `/fork` 明确触发；后续可以在 message selector 中把 compact-covered conversation rewind 自动转成 fork proposal。

### 辅助对话的 SQLite 批量 fork

辅助对话采用独立副本。`commitForkFromSource` 在一个 SQLite 写事务内提供历史元数据，
core 同步复用现有分支、稳定边界和身份改写，adapter 用批量 `INSERT SELECT` 搬运原正文。
不在 JS 中构造完整正文 bundle，不引入共享历史、schema migration 或删除语义变化。
来源选择和复制使用同一事务视图；回调禁止异步或外部 IO，命令事实和 child 一起提交。
具体字段保留、兼容文字与验收边界见[辅助对话规格](../../../../../docs/ui/conversation-selection-side-chat.md#sqlite-批量创建)。
