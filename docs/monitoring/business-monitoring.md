# 业务质量监控

> **2026-09-11 当前补充（Todo129）**：V4 ConversationTelemetrySupervisor 已消费真实请求 fact 并上报 step/completion。Provider 重构后的官方身份仅在事件字段构造处恢复旧统计 ID；个人/Team 共用旧 Coding Plan 桶，Start 独立，闲时两家共用旧闲时桶。UUID 与未知身份不推断，模型名编码、usage、归因、去重及历史数据不变。详细映射与验收见 [Todo129](../working-memory/provider-refactor/steps/todo-129-impact-and-cases.md)。下方关于“V4 尚未接回”的描述只代表历史状态。

> **状态**：指标设计/历史口径。V4 `SessionPane` + projection 主链路尚未接回本文所述的
> `message_completion` / `agent_step` 聚合；旧 `useZCodeChat`、`taskStreamEventHandlers` 入口已删除。
> 在 V4 telemetry 接线和验证完成前，不得把下述字段当作当前稳定采集数据。

## 范围（待补充）

<!-- 产品行为、会话/任务质量、埋点事件、本地统计展示等 -->

## 与非业务监控的边界

| 归属本文件 | 不归属本文件（见 [performance-monitoring.md](./performance-monitoring.md)） |
| ---------- | --------------------------------------------------------------------------- |
| 待补充     | 页面性能、JS 错误、崩溃、RUM、开发期 Profiling                              |

## 上报与存储（待补充）

<!-- 例如 /report、agent 可观测库、设置页展示等 — 口径与字段由需求定义 -->

## 指标与事件清单（待补充）

### `send_btn`

用户发送消息点击 / 提交事件。发送时会读取当前登录身份域的套餐身份快照，并将结果冻结到本轮
prompt telemetry；后续同一轮 `message_completion` 必须复用同一份字段，不在完成时重新读取账号状态。

| 字段              | 类型   | 是否新增 | 说明                         | 口径 / 示例                                                                                                                                                                                |
| ----------------- | ------ | -------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `plan_status`     | string | 是       | 用户发送本轮消息时的套餐身份 | `coding_plan` / `start_plan` / `no_plan` / `unknown`                                                                                                                                       |
| `plan_product_id` | string | 是       | 当前套餐的后端稳定商品 ID    | Coding Plan 使用订阅 `productId`；Start Plan 使用余额接口 `plans[]` 中服务端优先级排序第一的 active 套餐 `plan_id`（即 entitlement `subscription.details[0]`）；无 active 套餐时为空字符串 |

套餐身份判定优先级固定为 `Coding Plan > Start Plan > No Plan > Unknown`。请求失败、仍在加载、鉴权异常、
provider 未配置或快照超过 entitlement cache TTL 时必须上报 `unknown`，不能误归为 `no_plan`。
Z.AI 与 BigModel 互斥登录身份域由 `providerFamilyDomain` 决定；该字段只用于选择当前身份域下的
Coding Plan / Start Plan 快照，不作为业务埋点字段上报，也不跟随 `message_completion.model_provider`
切换。

多 active Start Plan 口径：`subscription.details` 现在携带全部 active 套餐并保持服务端优先级顺序，
`plan_product_id` 取 `details[0]`（服务端排序第一的 active 套餐）。服务端调整套餐排序或套餐增减时该
维度会跟随翻转，这是明示口径而非身份跳变；按该维度做漏斗/留存对比时需与数据侧对齐此规则。

### 界面模式 `ui_mode`（2026-10-23）

`app_launch`、`app_daily_active`、`send_btn`、`message_completion`、`agent_step` 的
`event_extra_detail` 均携带字符串 `ui_mode`：`work`（办公）、`code`（编程）、`unknown`
（没有可归属的界面快照）。内部 `interfaceMode` 的 `office/coding` 仅在 UI 埋点边界映射。
这表示发起时的界面模式，不推断任务内容，不替代 `ask_mode`，不改 onboarding 的选择快照语义。

- 启动/日活使用上报时最近同步的 renderer 模式；初始上下文必须等 UI store 就绪后同步。
  界面切换及跨窗口广播只更新现有 Main 上下文；该同步链路不产生业务事件，
  不新增轮询或改变原有日活去重/心跳。显式用户入口的切换事件见下节 `ui_mode_switch`。
- 消息通过发送门禁时从 UI store 读取并固定到既有 telemetry seed；队列确认、ACK 延迟、
  promotion、执行中切换模式不改写该快照。completion 与该消息全部 step 使用相同值。
- 前台/后台子 Agent 沿用已有父消息归因链；没有父快照（包括先于父 ACK 到达的 child）为
  `unknown`，不得读当前窗口冒充来源。后台自动任务/后台唤醒没有交互 seed 时同样为 `unknown`。
- `ui_mode` 缺失的旧调用与不合法值降为 `unknown`。当天同时使用两种模式按两者都用统计，
  不把启动/日活的一次模式快照当成全天使用归属。
- 桌面 continuous 与手机 replayable 的 owner、隔离及 reporter 门禁不变；不新增手机上报出口，
  不从历史/recovery 补造模式或消息事件。

```text
UI store（当前模式唯一 owner）
  ├─ 初始化 / 模式变化 → platform.syncTelemetryContext → 既有 Main 上下文 → launch / daily
  └─ 发送门禁通过 → seed.ui_mode（固定）→ send_btn → message_completion / agent_step
                                                └─ 已关联 child step 继承
```

`ask_mode` 是独立的 Agent 执行/权限模式，埋点透传会话配置字符串。当前菜单值为
`build`（修改前询问）、`guarded`（自主执行，风险时询问）、`plan`（规划）、`yolo`（完全访问）；
`edit`（自动编辑）保留历史兼容，旧协议还接受 `auto`。缺配置时为空串，历史数据不能按封闭枚举假设。

验收：两种界面发送的三类消息事件同值；切换后新消息使用新值而在途旧消息不变；
排队确认/重复 ACK 不重报；关联 child 继承、无来源后台为 unknown；启动及跨日活跃使用最新
上下文且日活去重不变；无 desktop reporter 的手机路径不新增网络请求；缺失与非法值安全降级。

### 界面模式切换 `ui_mode_switch`（2026-10-28）

统计用户在以下三个入口**实际应用的模式变化**，不代表所有来源的界面切换总量。
事件使用 `element_name=ui_mode_switch`、`event_type=ck`，位置复用现有 `event_region`：

| 用户入口 | `event_region` | 上报时机 |
| --- | --- | --- |
| 用户头像菜单 | `app.profile` | 选择不同模式并应用到 UI store 后 |
| Settings 常规 | `app.setting` | 选择不同模式并应用到 UI store 后 |
| Onboarding | `app.onboarding` | 提交引导、实际应用已选择的模式后；点卡片只改草稿，不报 |

`event_extra_detail.previous_ui_mode` 是应用前的模式，`ui_mode` 是应用后的模式，均为字符串。
沿用 `work`（内部 office）、`code`（内部 coding），只有无法读取可归属模式时才为 `unknown`。
例如头像菜单从编程切到办公：

```json
{
  "element_name": "ui_mode_switch",
  "event_region": "app.profile",
  "event_type": "ck",
  "event_extra_detail": { "previous_ui_mode": "code", "ui_mode": "work" }
}
```

```text
三个用户入口 → 操作时读取 UI store 旧值 → 原 setInterfaceMode 命令 → 读取实际新值
  ├─ 新旧不同 → 既有 platform 上报通道 → ui_mode_switch
  └─ 新旧相同 → 不上报
初始化 / 快捷键 / 广播 / 刷新恢复 → 原 store 路径 → 不产生 ui_mode_switch
```

- UI store 继续是唯一状态 owner，埋点不改变偏好持久化、广播或 Agent 的 `ask_mode`。
  旧值在操作时读取，不能使用上一轮 render 的闭包值。每次不同模式的实际应用报一次。
- 初始化、刷新恢复、同值重选、跨窗口接收广播不报。快捷键切换（包括引导内的快捷键）
  本轮明确不在三个入口的统计范围；它会实际改变模式，但不报，也不在之后提交相同模式时补报。
  因此不能用该事件计算所有入口的切换总次数。后续若扩展快捷键，须先定义其来源口径。
- Onboarding 关闭或只改卡片草稿不报；仅翻到偏好页也不报。提交时模式应用先于异步偏好保存，
  后续保存失败不撤回已发生的切换，重试同值不重报。跳过时沿用原有产品行为：只有实际应用
  了不同模式才报。既有 `onboarding_end` 仍独立记录作答及退出方式。
- 复用平台 reporter 及隐私处理，不新增轮询、事件回放或手机上报通道。手机 Web 仍受原有
  事件白名单限制，不发送此事件；桌面 continuous / 手机 replayable 恢复语义不变。

验收：三个入口的来源、ck 类型及前后值正确；双向切换使用实时旧值；重选、初始化和刷新不报；
Onboarding 草稿/关闭不报、实际应用报一次；快捷键在引导外/内都不报，随后保存同值不补报，
下一次菜单切换使用快捷键改变后的实际旧值。跨窗口广播不重复报、保存失败重试不重复报。
当前自动化覆盖与未验证项见[界面模式验证](../testing/general-coding-mode-verification.md#界面模式切换埋点验收2026-10-28)。

### 编辑重发与回退：`send_type`、`conversation_rewind`（2026-11-17）

桌面端没有独立的「会话回退」命令：回退就是编辑最后一条用户消息后重发（`editUserQuery`），
`workspaceMode=preserve` 只回退对话，`rewind` 连同该轮的文件改动一起回退；轮次文件摘要里的
「撤销文件改动」是另一条命令 `applyFileRewind`，不截断对话。

**修复**：编辑重发曾不携带 telemetry seed，重发出的那一轮没有 `send_btn`、`message_completion`、
`agent_step`。现在 composer 编辑提交把 seed 交给 `editUserQuery`，这一轮与普通发送一样上报；
本地 TTFT 观测（`localTtft`）维持原口径不纳入编辑轮。「对话 + 文件」遇到文件冲突时 ACK 为
accepted 但没有新一轮：不建 seed，发送漏斗 `send_result` 直接落定 `blocked`（此前编辑提交的
`send_click` 一直没有落定）。配置读取失败后的自动重发（`handleRetryConfigRead`）不是用户提交，
仍不上报。

`send_btn`、`message_completion`、`agent_step` 新增 `send_type`：`normal`（composer 普通发送）/
`edit`（编辑重发）。随 seed 冻结，同一 `message_id` 的三类事件同值；后台任务、定时 / 闲时任务、
扫码远控执行侧的事件不带该字段，旧客户端同样缺失，数据侧按普通发送处理。

`conversation_rewind`（`event_type=result`、`event_region=chat`）在命令 ACK 后上报一次：

| 字段 | 说明 |
| --- | --- |
| `talk_id` / `message_id` | sessionId / 本次 `editUserQuery`、`applyFileRewind` 的 commandId（编辑重发时即新一轮的 `message_id`） |
| `action` | `edit_resend` / `file_only` |
| `workspace_mode` | 编辑重发：`preserve` / `rewind`；只撤销文件为空 |
| `result` | `accepted` / `blocked`（文件冲突或未实际撤销）/ `rejected`（ACK 非 accepted/duplicate） |
| `ack_status` | ACK 状态白名单，其余为 `other` |
| `blocked_reason` | `unsafe_files` / `ignored_files` / `unavailable` / `apply_conflict` / `not_applied` / `other` |
| `target_message_id` | 被回退那一轮 turnHeader 的 `sourceCommandId`，关联上一条 `message_completion` |
| `target_turn_state` | 该轮命令发出前的状态：`running` / `completedSuccess` / `completedInterrupted` / `failed` / `unknown` |
| `target_turn_files` | 该轮 turnHeader 记录的改动文件数；无记录为空 |
| `discarded_turns` | 编辑重发：目标轮及其后被截掉的轮次数；只撤销文件为空 |
| `restored_files` | 只撤销文件且 `applied=true` 时为实际撤销的文件数；其余为空 |

目标轮信息在命令发出前从行窗口读取（ACK 后已被截断）。只上报枚举、计数和命令 ID，不带正文、
路径或错误原文。实现：`packages/shared/src/conversation-telemetry/conversationRewindTelemetry.ts`，
调用点 `packages/ui/src/v4/SessionPane.tsx` 的 `handleEdit`、`handleApplyFileRewind`。
定向回归：`pnpm exec vitest run --config packages/shared/vitest.config.ts`。

### 授权弹窗结果：`permission_prompt_result`（2026-11-17）

此前授权弹窗上的选择不进 `/event/report`。`permission.lifecycle` fact 虽带 `decision`，渲染端只用它算
`waiting_ms`；ARMS 点击文案多数为空、没有工具名，也看不到键盘操作。本事件记录**用户在桌面弹窗上的选择**：
在 `V4InteractionDialogs` 的 `resolveInteraction` 返回后上报一次（应答命令失败时 `ack=failed`，用户重试会再报一次；统计用户选择只取 `ack=accepted`）。同一 interaction 一旦 `ack=accepted` 就不再上报：弹窗要等快照更新才消失，这期间的双击 / 连点会再发一次应答，CLI 仍返回 accepted。`failed` / `noop` 不算收口（noop 来自收件箱或网关 guard，不能证明应答已送达），之后的应答照常上报。
Hook 应答、规则直接放行 / 拒绝、超时、手机 Web 远控的应答不经过此处，不在统计范围。

| 字段 | 说明 |
| --- | --- |
| `talk_id` / `message_id` | sessionId / 弹窗锚点行所在轮次的 `sourceCommandId`（与该轮 `send_btn`、`agent_step` 的 `message_id` 一致）；取不到时为空 |
| `option` | `allow_once` / `allow_project`（始终允许本项目）/ `allow_session` / `allow_full_access` / `allow_switch_guarded` / `deny` / `workflow_refine`；未知 optionId 按 kind 归为 `allow_always_other` / `other` |
| `has_feedback` | 拒绝或 Refine 时是否写了非空理由（`1` / `0`）；不上传理由内容。批准时填写的反馈会被忽略，记 `0` |
| `tool_name` / `tool_call_id` | 与 `agent_step` 同一标识；不合规（超长、含空格等）时分别记 `other` / 空 |
| `from_subagent` | 请求来自子 agent、在父会话弹窗里应答为 `1` |
| `ask_mode` | 应答时会话的权限模式 |
| `mode_switch` | 弹窗提供的模式切换入口：`choose` / `fullAccessOnly` / 空 |
| `wait_ms` | 弹窗在本窗口首次出现到用户应答的毫秒数。起点按 interactionId 记在渲染端模块级有界表里，切换会话、面板重挂载不重置，失败重试沿用原起点；用渲染端时钟，不用 CLI 的 `createdAt`，避免远程工作区时钟偏差。本窗口从未显示过（例如一直在别的任务）时从首次显示算。起点表最多 256 条，被另一端、Hook 或超时收口的弹窗只靠上限回收（不能按当前会话的 pending 列表清理，表跨会话共用）；极端情况下超过上限仍挂着的最早弹窗会从下次显示重新计时 |
| `ack` | `accepted`（含 `duplicate`）/ `noop`（命令收件箱或网关判定无事可做）/ `failed`。另一端（手机、Hook、超时）已先收口时，CLI 仍按幂等成功返回 accepted，客户端区分不了，这种晚到应答也记为 `accepted`；只有两端几乎同时应答才会出现，要区分需 CLI 在结果里带上是否命中 |

实现：`packages/shared/src/conversation-telemetry/permissionPromptTelemetry.ts`，调用点
`packages/ui/src/v4/V4InteractionDialogs.tsx` 的权限弹窗 `onRespond`。

### 工具失败原因码：`agent_step.error_code`（2026-11-17）

工具失败的 `agent_step.error_type` 一直写死为 `TOOL_EXEC_ERROR`（线上失败 step 约 97% 是这个值），
看不出失败原因。CLI 的 `tool.lifecycle` 终态 fact 本来就带 `errorCode`（`ErrorPayload.code ?? type`，
已在 strict wire 上，新 App 配老 CLI 同样可用），渲染端此前只用了错误原文。现在 `agent_step` 新增
`error_code`：`errorCode` 经 `toToolLifecycleEvent` → `ZCodeToolCallUpdate.errorCode` → 工具 step 收口，
在本地按白名单归一后写入，原文不出本机。`error_type` 口径不变。

| 取值 | 含义 |
| --- | --- |
| 空串 | 不是失败的 tool step（成功、reasoning、generation）；旧客户端没有这个键 |
| CoreErrorType 的 27 个值（小写） | 命名错误码，如 `tool_execution_failed`、`invalid_input`、`tool_timeout`、`tool_cancelled`、`tool_not_found`、`permission_denied`、`model_error`、`configuration_error` |
| `agent_subagent_unavailable` / `agent_background_unavailable` / `agent_unknown_type` / `agent_child_runtime_failed` | Agent 工具包装子 agent 失败、子 agent 错误本身没有 code 时露出的 AgentErrorCode |
| `user_interrupt` | 后台子 agent 被用户停止：子会话 `turn.terminal` 的 `USER_INTERRUPT`（CLI fact 里写死的 code），只出现在 Agent 汇总 step |
| `h<1–4 位数字>` | 工具 handler 自己的数字码（如 Edit 的 `8`=原文没找到 → `h8`），或 provider 返回的数字码。不同工具会重号，必须和 `tool_name` 一起解读 |
| `other` | 有 code 但不在白名单内（如负数码、`Error` 这类异常名） |
| `unknown` | 失败但没有工具级 code：整轮失败或中断时被一并关闭的工具 step、旧流里没有 code 的失败 |

- 只在 `step_type=tool_call` 且 `status=fail` 的 step 上有值。后台子 agent 的 Agent 汇总 step 取子会话
  `turn.terminal` 的 `errorCode`。
- 归一函数 `normalizeToolErrorCode`（`packages/shared/src/telemetry.ts`）；出网前
  `sanitizeTelemetryEventDetail` 对 `agent_step.error_code` 按同一白名单再兜底一次，不在白名单内的一律 `other`。
- 已知局限（第一期只改 App）：
  - handler 包成 `ToolExecutionFailed` 时，若 handler 走的是 `throw createCoreError(..., { context: { code } })`
    而不是返回 `ToolHandlerFailure`，fact 里只剩 `TOOL_EXECUTION_FAILED`，`context.code`（如
    `read_file_not_found`、`write_file_stale`、WebFetch 的 `webFetchCode`）到不了渲染端。
  - 工具参数的 schema 校验失败在 CLI 里也是 `ToolExecutionFailed`（`validation.ts` 的 `createInputValidationError`），
    记为 `tool_execution_failed`，`invalid_input` 很少出现。
  - 被权限或 Hook 拒绝的工具不发 `ToolCallError`，step 在整轮结束时被记成 success，不会出现 `permission_denied`。
  - `conversationTelemetryEngine.ts` 的 `isToolTimeout` 用小写 `tool_timeout` 比对，大写 CoreError code 匹配不上。
  - WebFetch 返回 HTTP 4xx/5xx、MCP `isError`、Bash 非零退出这类软失败，step 本来就是 success。
  - 以上留给第二期（CLI 侧原因码）。

定向回归：`pnpm exec vitest run --config packages/shared/vitest.config.ts`；桌面 E2E
`conversation-session-tool-input-validation-provider-content`（schema 校验失败的工具 step 带 `error_code=tool_execution_failed`）。

### Workflow run 结果：`workflow_run_result`（2026-11-18）

此前 run 的结局不进 `/event/report`：`workflow.lifecycle(run-settled)` fact 虽带 `status` 与 `stopReason`，
渲染端只给每个子代理报一条汇总 `agent_step`，成败一律按 `status === "completed"` 判，停止与出错分不开；
没有子代理的 run 什么都不报。现在 `conversationTelemetryEngine` 的 run-settled 分支先报一条
`workflow_run_result`（不依赖有没有子代理），原有子代理汇总 step 不变。

| 字段 | 说明 |
| --- | --- |
| `talk_id` / `message_id` | 发起 run 的父会话 / 发起 run 那一轮（fact 的 `sourceCommandId`，即 CLI 的 `launchInputId`），与该轮 `send_btn`、`agent_step` 的 `message_id` 一致；中枢直接启动时是 run 专属的合成 id，没有 `message_completion` |
| `workflow_run_id` | runId；不合规（超长、含空格等）时为空串 |
| `status` | `completed` / `stopped` / `errored`；不认识的值记 `other` |
| `stop_reason` | 只在 `stopped` 时有值：`user` / `model` / `provider` / `interrupted` / `superseded`（与 dwf 引擎 `RunStopReason` 同集，单测按源码校验同步）；stopped 却缺原因或不认识记 `other`；其余状态为空串 |
| `actor_count` | 本窗口为这个 run 看到的子代理数（`actor-spawned` 的 agentId 去重，跨恢复累计；最多跟踪 256 个 run）。App 在 run 中途打开或两次结算之间重启时会少算，是下界 |

- **每次结算都报**：侧板恢复与 ResumeWorkflowRun 沿用同一个 runId，恢复后再结算一次；`launchInputId` 从 journal 首条
  `run-launched` 读回，恢复前后不变。统计 run 的最终结局按 `workflow_run_id` 取最后一条。不带「第几次结算」：渲染端计数在
  App 重启后归零，而进程退出（`interrupted`）后恢复正是主要的恢复场景；结算次数由数据侧按 runId 数。同一条 fact 重投由
  engine 的 eventId 去重挡住。
- AmendWorkflow 改脚本：旧 run 记 `stopped` + `superseded`，新 run 另起 runId，发起锚点沿用旧 run，`message_id` 相同。
- `errorMessage` 原文不上报，也没有错误码（fact 里没有）。没有单个子代理的成败：引擎只有 actor-created，没有子代理终态。
- 没有 fact 的 run 不报：升级前发起的 run（没有 `launchInputId`）、启动阶段就失败的 run、进程崩溃后才被收敛的 run。

实现：`packages/shared/src/conversation-telemetry/workflowRunTelemetry.ts`，调用点 `conversationTelemetryEngine.ts` 的
`handleWorkflowLifecycle`。定向回归：`pnpm exec vitest run --config packages/shared/vitest.config.ts`；桌面 E2E
`conversation-session-dynamic-workflow-gray-always-on-stop`（零子代理的 run 被用户停止）、
`conversation-session-dynamic-workflow-gray-always-on-amend`（被替代的旧 run 与跑完的新 run 挂在同一发起轮下）。

### 点赞点踩关联到轮：`assistant_message_feedback.source_message_id`（2026-11-18）

`assistant_message_feedback` 的 `message_id` 是被评价的 assistant 行 entityId，和 `send_btn` / `message_completion` /
`agent_step` 用的 `message_id`（发起该轮的命令 ID）不是一套，数据侧只能按 `talk_id` 加时间就近匹配，点踩没法按模型、
版本、工具失败拆。现在 `eventExtraDetail` 增加 `source_message_id`：

| 字段 | 说明 |
| --- | --- |
| `source_message_id` | 被评价回复所在轮的轮头 `sourceCommandId`（CLI 取 `intent.sourceCommandId ?? inputId`）。普通发送是发送命令 ID，编辑重发是新命令 ID（`send_type=edit` 那一轮），E2E 实测：普通轮与 `send_btn`、`message_completion`、工具 `agent_step` 同值；编辑重发轮的 fixture 只回文本，实测了 `send_btn`、`message_completion`，工具 `agent_step` 未覆盖。后台 / 定时 / 闲时 / 排队后立即发送的轮，completion 取的是 `inputId`，两者是否总相等未逐一验证，不得假设必然能关联。轮头没有命令归因时（旧快照）为空串 |

- 反馈按钮只在轮尾操作栏出现（每轮一处），取的是轮头而不是轮内的引导输入：引导不另起轮，该轮的 completion 也挂在轮头命令上。
- `message_id`、`reaction`（`like` / `dislike` / `none`）不变；取消反馈（`none`）同样带 `source_message_id`。
- 消费方把「字段非空」与「关联命中」分开统计（dp：`feedback.source_empty_share`、`feedback.linked_share`），扩大保证范围前逐入口核对最终 payload。
- 手机远控不装 reporter，这条事件仍只从桌面发出。

实现：`ConversationTurnGroup.tsx` 把 `unit.header?.sourceCommandId` 传给 `ConversationAssistantTextActions`，在
`ConversationRowView.tsx` 的 `handleFeedback` 上报。桌面 E2E：`conversation-session-v4-rewind-files` PV4-21（原回复的
`source_message_id` 同时命中普通发送轮的 `send_btn`、`message_completion` 与 Read、Write 两个工具 `agent_step`（按 `tool_call_id` 核对）；编辑重发后新回复的点赞与取消
都等于编辑重发轮的 `send_btn` / `message_completion`）。

### `message_completion`

Agent 单轮消息完成事件的历史设计由 UI 侧 `finalizePromptTelemetry()` 聚合后，通过
`reportAppTelemetryEvent()` 上报到 `/event/report`；当前 V4 主链路未调用该收口。

| 字段                   | 类型          | 是否新增 | 说明                              | 口径 / 示例                                                         |
| ---------------------- | ------------- | -------- | --------------------------------- | ------------------------------------------------------------------- |
| `time_to_first_token`  | string(float) | 否       | 从发送到首 token 的耗时，毫秒     | `firstTokenAt - sendTime`                                           |
| `waiting_ms`           | string(float) | 否       | 权限等待等用户等待耗时，毫秒      | 本轮各 tool permission request 到 response/终止的累计值             |
| `duration_ms`          | string(float) | 否       | 本轮墙钟总耗时，包含 `waiting_ms` | `finishedAt - sendTime`                                             |
| `request_time`         | string(float) | 否       | 用户发送时间戳                    | `sendTime`                                                          |
| `input_tokens`         | string(float) | 否       | 输入 token 数                     | 成功态有 usage 时上报                                               |
| `output_tokens`        | string(float) | 否       | 输出 token 数                     | 成功态有 usage 时上报                                               |
| `reasoning_tokens`     | string(float) | 否       | reasoning token 数                | 无值时为 `0`                                                        |
| `cached_input_tokens`  | string(float) | 否       | 命中缓存的输入 token 数           | 无值时为 `0`                                                        |
| `total_tokens`         | string(float) | 否       | 总 token 数                       | 成功态有 usage 时上报                                               |
| `agent_step_cnt`       | string(int)   | 否       | Agent 步骤数                      | 当前 message 生命周期内实际收口并上报的 `agent_step` 数             |
| `file_change_cnt`      | string(int)   | 否       | 变更文件数                        | 按本轮 fileChanges 去重 path                                        |
| `generated_code_lines` | string(int)   | 否       | 新增代码行数                      | 基于 before/after diff 统计 added                                   |
| `ask_mode`             | string        | 否       | Agent 执行/权限模式                      | `build` / `guarded` / `plan` / `yolo`，兼容 `edit` / `auto` / 空串                                      |
| `retry_cnt`            | string(int)   | 是       | 本轮模型/API 重试次数             | 当前 completion 链路未稳定透出 retry 事件，先默认 `0`               |
| `tool_call_total`      | string(int)   | 是       | 本轮工具调用总数                  | 当前 message 内实际收口的 `tool_call` step 数                       |
| `tool_call_failed`     | string(int)   | 是       | 本轮失败工具调用数                | 当前 message 内状态为 fail/timeout 或存在 error 的 `tool_call` step |
| `error_type`           | string        | 是       | 失败归类                          | 成功为空；有失败工具为 `TOOL_CALL_FAILED`；其它失败为 `UNKNOWN`     |
| `error_msg`            | string        | 是       | 失败提示                          | 成功为空；失败原文非空时为 `[redacted]`，原文空时为空；归因使用 `error_type`                        |
| `plan_status`          | string        | 是       | 用户发送本轮消息时的套餐身份      | 复用同轮 `send_btn` 冻结值，不在 completion 发生时重算              |
| `plan_product_id`      | string        | 是       | 当前套餐的后端稳定商品 ID         | 复用同轮 `send_btn` 冻结值；无法确认时为空字符串                    |
| `workspace_kind`       | string        | 是       | 本轮 workspace 类型               | `local` / `remote`，由 workspace attachment 冻结                    |
| `remote_kind`          | string        | 是       | 远程 workspace 类型               | `ssh` / `wsl` / `docker` / `server`；本地或无法解析时为空字符串     |
| `send_type`            | string        | 是       | 用户发送方式（2026-11-17）        | `normal` / `edit`；非 composer 来源与旧客户端缺失                   |

实现位置：

- 字段聚合：`packages/ui/src/lib/messageTelemetry.ts`
- 完成态上报：旧入口已删除，V4 待接线
- UI 上报封装：`packages/ui/src/lib/appTelemetry.ts`

### `agent_step`

Agent 单步执行事件。它的颗粒度比 `message_completion` 更细：一个
`message_completion` 对应一次用户消息的整体完成态，一次用户消息内可以产生多条
`agent_step`。

当前只使用 `reasoning` / `tool_call` / `generation` 三种 step，不新增 permission step；
工具权限等待通过 `tool_call.waiting_ms` 单独表达，不上传用户提问内容。

| 字段                          | 类型        | 是否新增 | 说明                                  | 口径 / 示例                                                                                                                                                                            |
| ----------------------------- | ----------- | -------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `talk_id`                     | string      | 否       | 会话 / task id                        | 通过上报 payload 的 `talkId` 映射                                                                                                                                                      |
| `message_id`                  | string      | 否       | 当前用户消息 id                       | 通过上报 payload 的 `messageId` 映射                                                                                                                                                   |
| `step_id`                     | string      | 是       | 本次 Agent step 的全局唯一 id         | `uuid`                                                                                                                                                                                 |
| `is_tftt_cached`              | string(int) | 是       | 首 token 是否命中缓存                 | 当前无稳定信号，先固定 `0`                                                                                                                                                             |
| `loop_index`                  | string(int) | 是       | 当前 step 在本次 message 内的顺序     | 从 `1` 开始递增                                                                                                                                                                        |
| `step_type`                   | string      | 是       | 当前步骤类型                          | `reasoning` / `tool_call` / `generation`                                                                                                                                               |
| `is_tool_call`                | string(int) | 是       | 是否工具调用                          | `tool_call` 为 `1`，其它为 `0`                                                                                                                                                         |
| `tool_name`                   | string      | 是       | 工具名称                              | `read_file` / `bash`；非工具为空                                                                                                                                                       |
| `tool_call_id`                | string      | 是       | 工具调用 id                           | 仅 `tool_call` step 写入，用于和工具终态性能事件关联；非工具为空                                                                                                                       |
| `agent_id`                    | string      | 是       | 前台 Subagent 关联 id                 | 父 `Agent` step 与其镜像 child 工具写入同一个值；其他 step 省略                                                                                                                        |
| `duration_ms`                 | string(int) | 是       | 当前 step 墙钟耗时，包含 `waiting_ms` | step 收口时间 - step 开始时间                                                                                                                                                          |
| `waiting_ms`                  | string(int) | 是       | 当前 step 内的权限等待累计值          | `tool_call` 按 request 到 response/终止累加；其他 step 为 `0`                                                                                                                          |
| `generation_tail_finalize_ms` | string(int) | 是       | 正文最后一包到任务终态的尾部收口耗时  | 仅桌面 `desktop-continuous` 中主 agent `generation` 被 `task_complete` / `task_error` 收口时写入；其它 step、手机 replayable 恢复、被工具/推理打断的 generation 或工具子输出为空字符串 |
| `status`                      | string      | 是       | 当前 step 最终状态                    | `success` / `fail` / `timeout`                                                                                                                                                         |
| `model_request_id`            | string      | 是       | token 所属模型请求                    | 当前 step 不持有 request usage 时为空                                                                                                                                                  |
| `model_request_count`         | string(int) | 是       | 当前 step 聚合的真实模型请求数        | 主 Agent request 为 `1`；前台 child 生命周期可大于 `1`；无 usage 为 `0`                                                                                                                |
| `token_usage_scope`           | string      | 是       | token 口径                            | 主 Agent 单请求为 `model_request`；前台 child 聚合为 `subagent_requests`；否则为空                                                                                                     |
| `input_tokens`                | string(int) | 是       | 单次请求输入 token                    | Provider request usage；同一 request 只归属一条 step                                                                                                                                   |
| `output_tokens`               | string(int) | 是       | 单次请求输出 token                    | Provider request usage；同一 request 只归属一条 step                                                                                                                                   |
| `reasoning_tokens`            | string(int) | 是       | 单次请求 reasoning token              | Provider 未返回时为 `0`                                                                                                                                                                |
| `cached_tokens`               | string(int) | 是       | 单次请求缓存命中 token                | 对应 provider cache read；未返回时为 `0`                                                                                                                                               |
| `cache_write_input_tokens`    | string(int) | 是       | 单次请求缓存写入 token                | Provider 未返回时为 `0`                                                                                                                                                                |
| `total_tokens`                | string(int) | 是       | 单次请求总 token                      | Provider 显式 total，缺失时沿统一 usage 规则计算                                                                                                                                       |
| `error_type`                  | string      | 是       | 失败归类                              | 工具失败为 `TOOL_EXEC_ERROR`；task 失败用错误码；成功为空                                                                                                                              |
| `error_msg`                   | string      | 是       | 失败提示                              | 错误原文非空时为 `[redacted]`，原文空时为空；成功为空，归因使用 `error_type`                                                                                                                                                       |
| `error_code`                  | string      | 是       | 工具失败原因码（2026-11-17）          | 只在失败的 tool step 上有值，其余为空串；白名单枚举，见「工具失败原因码」 |
| `workspace_kind`              | string      | 是       | 本步骤 workspace 类型                 | 与同一 `talk_id + message_id` 的 `message_completion` 保持一致；`local` / `remote`                                                                                                     |
| `remote_kind`                 | string      | 是       | 远程 workspace 类型                   | `ssh` / `wsl` / `docker` / `server`；本地或无法解析时为空字符串                                                                                                                        |
| `send_type`                   | string      | 是       | 用户发送方式（2026-11-17）            | 与同一 `message_id` 的 `send_btn`、`message_completion` 同值：`normal` / `edit`；非 composer 来源与旧客户端缺失 |

`step_type` 判定口径：

- `agent_thought_chunk` 开始 `reasoning` step。
- 遇到 `tool_call` / 普通 `agent_message_chunk` / `task_complete` / `task_error` 时收口当前 `reasoning`。
- `tool_call` 开始 `tool_call` step；`tool_call_update` 到 `completed` / `failed` / `denied` 时收口。
- 不带 `zcodeTimeline` 且不带 `parentToolUseId` 的主 agent `agent_message_chunk` 开始 `generation` step；遇到后续 `tool_call` / `agent_thought_chunk` / `task_complete` / `task_error` 时收口。
- `generation_tail_finalize_ms` 只回答桌面 continuous 主链路正文尾包到任务终态之间的 finalize 尾延迟；若正文后继续调用工具、进入新 reasoning，来自手机 replayable 恢复重放，或 chunk 带 `parentToolUseId` 属于工具子输出，则字段为空字符串，避免把下一阶段耗时、恢复重放处理时间或子 agent 输出混入尾延迟。
- `agent_message_chunk` 若为系统 timeline（如 context compaction），不计入 `generation`。
- 模型字段在 step 创建时从当前真实 `model_request_started` 冻结，不能从 prompt 最后一次请求覆盖历史
  step。Provider 只提供 request 级 usage，因此同请求的完整 usage 只写到请求结束时最后一个模型输出
  step，其它阶段保持 `0`，详见
  [Agent Step 真实模型与 Token 归属](./agent-step-model-token-attribution.md)。
- 前台 Subagent 的 child request usage 通过 `childSessionId + parentToolCallId` 归入父 message 对应
  `Agent` 工具 step；后台 Subagent 的异步 message 生命周期不在当前口径内。

计数作用域：

- `activatePromptTelemetry()` 激活新 message 时，`loop_index` 从 `1` 重新开始。
- 每个 `agent_step` 收口时同步累计当前 message 的 completion 指标。
- 同一 `talk_id + message_id` 下，`message_completion.agent_step_cnt` 必须等于实际
  上报的 `agent_step` 条数；不得扫描或累计同 session 的历史 assistant 消息。

实现位置：

- 状态机与字段聚合：`packages/ui/src/lib/messageTelemetry.ts`
- 流事件接入与上报：旧入口已删除，V4 待接线
- UI 上报封装：`packages/ui/src/lib/appTelemetry.ts`

## 多端与 clientMode

远程工作区和手机 Web Remote Control 的使用量口径见
[远程场景使用量埋点 V1](./remote-usage-telemetry-v1.md)；远程工作区逻辑 session 并发数、断开原因与可观测连接时长见
[远程工作区连接 ARMS 自定义事件](./remote-usage-arms-telemetry.md)。

远控埋点只观察既有生命周期终态，不改变传输语义：桌面保持 `desktop-continuous`，手机保持
`web-remote-replayable`；relay 不解析 `rpc-frame`，Web bundle 不新增独立上报器。手机实际使用以
桌面 shared-host attachment 成功建立 bridge 为准。

## 实现索引（代码事实，非规范）

需求定稿前仅作定位参考，以代码为准：

- 业务埋点上报：`packages/services/src/telemetry/telemetryCore.ts`（`https://zcode.z.ai/api/v1/event/report`）
- UI 侧封装：`packages/ui/src/lib/appTelemetry.ts`、`packages/ui/src/lib/messageTelemetry.ts`
- Agent 用量落盘：`apps/zcode-cli/docs/design/v2/usage-observability.md`（CLI 设计 spec，非本目录文档）
- App Usage 聚合：`docs/superpowers/specs/2026-06-02-app-usage-db-migration-design.md`（功能 spec，非本目录文档）

## 追记（2026-09-14）：工作流子代理进入 `agent_step` / `agent_composition`

spec：`apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md`「Token telemetry for subagents」。字段口径的增量：

| 字段 | 变化 |
| --- | --- |
| `agent_step.agent_role` | 新值 `workflow subagent`（既有 `foreground subagent` / `background subagent` 不变） |
| `agent_step.agent_id` | 工作流子代理为 `siteId@ordinal` |
| `agent_step.workflow_run_id` / `child_session_id` / `workflow_tool_call_id` | 新增，只在工作流子代理的 step 上在场 |
| `agent_step.tool_call_id` | 工作流子代理：工具 step `tool_workflow_<agentId>_<childToolCallId>`，汇总 step `tool_workflow_<agentId>_<runId>` |
| `agent_step.message_id` | 工作流子代理挂在发起 run 那一轮的 inputId 下；中枢直接启动为 run 专属的合成 UUID v7，该 message 没有 `message_completion` |
| `message_completion.agent_composition` | 新增 `main_plus_wf` / `main_plus_fg_wf` / `main_plus_bg_wf` / `main_plus_fg_bg_wf`：run 的通知被主对话某一轮消费时置位 |
| `message_completion.message_source` | 由 workflow 通知唤起的独立轮记 `background_workflow` |
