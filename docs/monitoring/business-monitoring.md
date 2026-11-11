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
| `workspace_kind`              | string      | 是       | 本步骤 workspace 类型                 | 与同一 `talk_id + message_id` 的 `message_completion` 保持一致；`local` / `remote`                                                                                                     |
| `remote_kind`                 | string      | 是       | 远程 workspace 类型                   | `ssh` / `wsl` / `docker` / `server`；本地或无法解析时为空字符串                                                                                                                        |

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
