# Span、Attribute、Event 与 Metric 字典

> 本文定义 Telemetry Schema Version 6 的 Span、Attribute、Event 与 Metric。设计原则和调用示例见
> [CLI Agent Telemetry 设计与开发规范](../cli-agent-telemetry.md)。

本文件需要人工维护。TypeScript 能约束 Setter 参数，却不能替代字段含义、缺失语义、隐私、
基数、查询用途和继承关系的说明。新增或修改任何 Span、Attribute、Event、Metric 或兼容别名
时，必须同步更新本文件。

## 1. 命名与类型约定

### 1.1 Span Name

Span Name 稳定且低基数：

```text
agent_turn
agent_step
tool_execution
command_execution
context_compaction
detached_operation
model_call
model_attempt
```

不另建 `span_type`。索引、模型、Provider、Tool Name 等动态值只进入 Attribute。

### 1.2 Canonical Attribute

```text
zcode.<span_name>.<property>
zcode.execution.<property>
zcode.telemetry.<property>
zcode.runtime.<property>
zcode.device.<property>
```

Span Attribute 使用下划线 Span Name，例如 `zcode.model_attempt.requested_model`。Metric 名称使用
OTel 风格的点分域，例如 `zcode.model.attempt.duration`。二者用途不同，不要机械互换。

约定：

- 时间 Attribute 明确以 `_ms` 结尾，单位毫秒；
- Duration Metric 的 OTel Unit 为 `s`；
- Count/Index 是整数；
- Token 是非负整数；
- 布尔值只有在事实明确时才写；
- 不存在表示“未观察到/不适用”，不能按 false 或 0 解释；
- Stable Enum 使用小写 snake_case；
- 原始 Provider Model/Finish Reason/Error Code 不人为折叠，但会做长度和字符约束。

### 1.3 字段来源阶段

字段不需要运行时 Schema Registry。它们按事实到达阶段写入：

| 阶段     | 典型来源             | 典型字段                                         |
| -------- | -------------------- | ------------------------------------------------ |
| Start    | 创建 Span 时已经确定 | operation、tool_name、requested_model            |
| Progress | 生命周期中首次确定   | first_content、permission_decision、HTTP status  |
| Terminal | 结束时确定           | outcome、failure_stage、exit_code、finish_reason |
| Resource | Runtime 创建时确定   | version、build、runtime surface                  |

Writer 方法是字段入口，Runtime 内的显式 Key 是输出映射。

## 2. Resource 字段

### 2.1 Trace Resource

| 字段                             | 类型    | 含义与来源                                                           |
| -------------------------------- | ------- | -------------------------------------------------------------------- |
| `service.name`                   | string  | 默认 `zcode-cli-agent`，可由受控 OTEL 配置覆盖                       |
| `service.version`                | string? | CLI bundle 实际内置版本，来自 `apps/zcode-cli/package.json` 构建注入 |
| `service.instance.id`            | string  | 每个 CLI 进程随机实例 ID                                             |
| `deployment.environment.name`    | string? | 产品环境                                                             |
| `process.runtime.name`           | string  | `nodejs`                                                             |
| `process.runtime.version`        | string  | Node 版本                                                            |
| `os.type`                        | string  | Node `process.platform`                                              |
| `host.arch`                      | string  | 归一化 CPU 架构                                                      |
| `zcode.telemetry.schema_owner`   | string  | 固定 `cli`                                                           |
| `zcode.telemetry.schema_version` | integer | 当前为 `5`                                                           |
| `zcode.product.version`          | string? | Desktop/产品构建版本                                                 |
| `zcode.build.commit_id`          | string? | 可信构建 Commit                                                      |
| `zcode.runtime.surface`          | enum    | `standalone_cli` / `desktop_local_host` / `remote_workspace_host`    |
| `zcode.runtime.distribution`     | enum    | `source` / `development_bundle` / `packaged` / `unknown`             |
| `zcode.device.installation_id`   | string? | 持久化随机安装假名，不是硬件 ID                                      |

### 2.2 Metric Resource

Metric 保留服务、版本、环境、Runtime、平台和构建字段，但省略：

```text
service.instance.id
zcode.device.installation_id
```

原因是它们会进入 Metric Series 身份，导致每个安装和进程产生独立时序。Metric Exporter 使用
DELTA Temporality，适配大量短生命周期 CLI 生产者。

## 3. Query Projection（执行关联投影）

以下字段来自不可变 `AgentTelemetryExecutionContext`，只投影到确实需要独立检索的关键 Span。
它们不是 Span 继承，也不替代 Parent/Link。

| 字段                                | 类型    | 含义                                                               | 主要出现位置                        |
| ----------------------------------- | ------- | ------------------------------------------------------------------ | ----------------------------------- |
| `zcode.execution.session_id`        | string? | 当前 Session                                                       | Turn、Detached、Call、Attempt       |
| `zcode.execution.parent_session_id` | string? | Child 的父 Session                                                 | 同上                                |
| `zcode.execution.turn_id`           | string? | 当前 Turn                                                          | 有 Turn Context 的所有关键 Span     |
| `zcode.execution.parent_turn_id`    | string? | Child 的父 Turn                                                    | Turn、Detached、Call、Attempt       |
| `zcode.execution.query_id`          | string? | 请求级 Query ID                                                    | Turn、Detached、Call、Attempt       |
| `zcode.execution.actor_kind`        | enum?   | `main` / `subagent` / `workflow_child`                             | Turn、Tool、Detached、Call、Attempt |
| `zcode.execution.agent_name`        | string? | 受控 Agent 名称                                                    | Turn                                |
| `zcode.execution.identity_state`    | enum?   | `authenticated` / `anonymous` / `unknown`                          | Turn                                |
| `zcode.execution.user_subject_id`   | string? | 受控用户主体 ID                                                    | Turn                                |
| `zcode.execution.launch_surface`    | enum?   | `desktop` / `standalone_cli` / `web_remote` / `automation` / `bot` | 有 Execution Context 的 Span        |
| `zcode.execution.tool_call_id`      | string? | Tool Call 关联 ID                                                  | Tool、Command、工具内 Call/Attempt  |
| `zcode.execution.logical_call_id`   | string? | 逻辑模型调用 ID                                                    | Call、Attempt                       |
| `zcode.execution.model_operation`   | enum?   | Attempt 的父 Call Operation 快照                                   | Attempt                             |
| `zcode.execution.model_role`        | string? | Attempt 的父 Call Model Role 快照                                  | Attempt                             |

`user_subject_id` 当前不是 Hash 字段；调用方只能注入经过产品身份边界确认的主体 ID。安装 ID 和
用户主体 ID 都禁止作为 Metric Label。

## 4. Lifecycle 字段继承

每个业务 Span 使用自己的前缀继承同一组生命周期语义。例如 `model_attempt` 产生：

```text
zcode.model_attempt.outcome
zcode.model_attempt.failure_stage
zcode.model_attempt.error_category
zcode.model_attempt.error_type
zcode.model_attempt.error_code
zcode.model_attempt.error_message
zcode.model_attempt.cancel_reason
zcode.model_attempt.abandon_reason
```

| Property         | 类型    | 写入条件         | 含义                                 |
| ---------------- | ------- | ---------------- | ------------------------------------ |
| `outcome`        | enum    | 所有已终态 Span  | 业务终态                             |
| `failure_stage`  | enum    | `failed`         | 本 Span 内失败阶段                   |
| `error_category` | enum    | `failed`         | 低基数错误类别                       |
| `error_type`     | string? | 首次认领来源错误 | Error 名称/类型，受控字符            |
| `error_code`     | string? | 首次认领来源错误 | SDK/运行时错误码，清理控制字符并截断 |
| `error_message`  | string? | 首次认领来源错误 | 来源错误信息，脱敏后最多 2048 字符   |
| `cancel_reason`  | enum?   | `cancelled`      | 取消原因                             |
| `abandon_reason` | enum?   | `abandoned`      | 非正常收口原因                       |

### 4.1 公共枚举

```text
error_category =
  configuration | authentication | permission | rate_limit | timeout |
  network | provider | parse | cancelled | internal | unknown

cancel_reason =
  user | abort_signal | timeout | shutdown | superseded | unknown

abandon_reason =
  missing_terminal | session_shutdown | process_shutdown
```

同一个 Error 可能沿 Attempt → Call → Step → Turn 冒泡。错误对象及其 `cause` 链由最靠近来源的
Span 首次认领；父 Span仍记录自己的 `outcome/failure_stage/error_category`，但不复制错误正文。

## 5. `agent_turn`

Parent：主 Turn 为 Root；前台 Child Agent 可为 Tool Child；后台 Child Agent 为新 Root + Link。

| 专属字段                        | 类型    | 含义                                                         |
| ------------------------------- | ------- | ------------------------------------------------------------ |
| `zcode.agent_turn.turn_number`  | integer | Session 内 Turn 序号                                         |
| `zcode.agent_turn.input_source` | enum?   | `user` 或受控 Synthetic Message Source                       |
| `zcode.agent_turn.result_type`  | enum?   | `assistant_message` / `tool_request` / `no_output` / `other` |

```text
outcome       = completed | failed | cancelled | abandoned
failure_stage = setup | agent_loop | finalize | unhandled
```

Start 时投影完整 Session/Turn/Query、Actor、Agent、Identity 和 Launch Surface。

## 6. `agent_step`

Parent：`agent_turn`。

| 专属字段                           | 类型    | 含义                         |
| ---------------------------------- | ------- | ---------------------------- |
| `zcode.agent_step.step_id`         | string  | Step 对应消息/执行 ID        |
| `zcode.agent_step.step_index`      | integer | Turn 内从 0 开始的 Step 序号 |
| `zcode.agent_step.terminal_reason` | enum?   | 正常结束原因                 |

```text
terminal_reason =
  model_completed | tool_requested | turn_completed | compaction_requested

outcome       = completed | discarded | failed | cancelled | abandoned
failure_stage = prepare | model | tool | commit | unhandled
```

## 7. `tool_execution`

Parent：通常为 `agent_step`；工具内部模型调用和命令均为它的 Child。

| 专属字段                                        | 类型     | 含义                                                        |
| ----------------------------------------------- | -------- | ----------------------------------------------------------- |
| `zcode.tool_execution.tool_name`                | string   | Tool Registry 中的受控名称                                  |
| `zcode.tool_execution.permission_decision`      | enum?    | `granted` / `denied` / `not_required`                       |
| `zcode.tool_execution.permission_denial_reason` | enum?    | `user_denied` / `policy_denied` / `unavailable` / `unknown` |
| `zcode.tool_execution.output_bytes`             | number?  | Tool 结果序列化后的大小，不含正文                           |
| `zcode.tool_execution.output_truncated`         | boolean? | 输出是否被截断；未知时省略                                  |

```text
outcome = completed | denied | failed | cancelled | abandoned

failure_stage =
  lookup | validation | permission | pre_hook | handler |
  post_hook | serialize | unhandled
```

Events：

- `permission_requested`：一次 Tool 最多一个；
- `permission_decided { decision }`：仅发生过请求且最终需要决定时写入。

## 8. `command_execution`

Parent：`tool_execution`。只有实际启动 OS 进程才创建，不适用于 Read/Write 等普通 Tool。

| 专属字段                                  | 类型     | 含义                                                   |
| ----------------------------------------- | -------- | ------------------------------------------------------ |
| `zcode.command_execution.safe_name`       | string   | Allowlist 命令族，例如 `git.status`，不是原始命令      |
| `zcode.command_execution.category`        | enum     | 命令类别                                               |
| `zcode.command_execution.command_count`   | integer  | Pipeline 中命令数量                                    |
| `zcode.command_execution.shell_kind`      | enum?    | `bash` / `zsh` / `sh` / `powershell` / `cmd` / `other` |
| `zcode.command_execution.sandboxed`       | boolean  | 是否在 Sandbox 中执行                                  |
| `zcode.command_execution.first_output_ms` | number?  | 首次输出耗时，毫秒                                     |
| `zcode.command_execution.exit_code`       | integer? | OS 进程退出码；未产生退出码时省略                      |
| `zcode.command_execution.signal`          | string?  | 终止 Signal 的受控标识                                 |
| `zcode.command_execution.output_bytes`    | number?  | 输出字节数，不含正文                                   |
| `zcode.command_execution.timed_out`       | boolean? | 是否明确超时                                           |

```text
category = shell | git | package_manager | build | test | file | network | other
outcome = completed | failed | cancelled | backgrounded | abandoned
failure_stage = prepare | spawn | execute | timeout | collect_output | unhandled
```

Events：

- `first_output`：最多一个；
- `termination_requested { reason }`，reason 为 `cancelled/timeout/shutdown`。

完整命令、参数、脚本、路径、cwd 和环境变量禁止上报。

## 9. `context_compaction`

Parent：当前 Turn；通常与触发它的 Step 同属 Turn，但不是 Step 的“错误恢复字段”。内部模型请求
作为 Child Call/Attempt。

| 专属字段                                                  | 类型     | 含义                            |
| --------------------------------------------------------- | -------- | ------------------------------- |
| `zcode.context_compaction.trigger`                        | enum     | Contracts 中的 `CompactTrigger` |
| `zcode.context_compaction.phase`                          | enum     | Contracts 中的 `CompactPhase`   |
| `zcode.context_compaction.model_mode`                     | enum     | `streaming` / `non_streaming`   |
| `zcode.context_compaction.outer_attempt`                  | integer? | 外层恢复尝试序号                |
| `zcode.context_compaction.max_attempts`                   | integer? | 外层最大尝试数                  |
| `zcode.context_compaction.triggering_step_index`          | integer? | 触发压缩的 Step 序号            |
| `zcode.context_compaction.recovered_from_logical_call_id` | string?  | 恢复来源 Call ID                |
| `zcode.context_compaction.input_tokens`                   | number?  | Auto / Reactive 触发压缩时的当前 provider-visible 上下文 Token |
| `zcode.context_compaction.output_tokens`                  | number?  | 压缩输出 Token                  |
| `zcode.context_compaction.policy_context_window_tokens`   | number?  | Auto / Reactive 本次执行模型使用的策略上下文窗口 |
| `zcode.context_compaction.threshold_tokens`               | number?  | Auto Compact 本次决策使用的触发阈值；其他触发类型可省略 |
| `zcode.context_compaction.token_source`                   | enum?    | `estimate` / `provider_usage`；说明 `input_tokens` 的来源 |

```text
outcome = completed | discarded | failed | cancelled | abandoned
failure_stage = prepare | model | parse | commit | fallback | unhandled
```

Event：`fallback_selected { reason }`，reason 是受控枚举。

Auto Compact 直接复用已有策略决策。Reactive Compact 复用 overflow 路径的
provider-visible 消息：优先使用最近一次 Provider Usage 并叠加快照后的消息估算，缺失时使用
本地估算；它不写入 `threshold_tokens`。Reactive 的窗口依次取当前 turn 执行模型、Runtime
配置和 Compact 默认值。Manual、Partial 与 SessionMemory 省略这三个上下文字段。
这些字段只作为 Span attributes 上报，不作为 Metric labels。

## 10. `detached_operation`

用于 Turn 外仍需独立结果和耗时的操作。前台可为 Child；Queued/Background 使用 Root + Link。

| 专属字段                                  | 类型     | 含义                                                          |
| ----------------------------------------- | -------- | ------------------------------------------------------------- |
| `zcode.detached_operation.operation`      | enum     | 第 10.1 节操作类型                                            |
| `zcode.detached_operation.execution_kind` | enum     | `foreground` / `queued` / `background`                        |
| `zcode.detached_operation.trigger`        | enum     | `user` / `turn` / `tool` / `scheduler` / `recovery` / `other` |
| `zcode.detached_operation.target_kind`    | enum?    | `session` / `goal` / `workspace` / `project_memory` / `other` |
| `zcode.detached_operation.goal_iteration` | integer? | Goal 迭代序号                                                 |
| `zcode.detached_operation.chunk_index`    | integer? | Chunk 序号                                                    |
| `zcode.detached_operation.chunk_count`    | integer? | Chunk 总数                                                    |
| `zcode.detached_operation.result_type`    | enum?    | `text` / `boolean` / `metadata` / `other`                     |

```text
outcome = completed | failed | cancelled | abandoned
failure_stage = schedule | execute | commit | unhandled
```

### 10.1 Operation 目录

| Operation                         | 含义                      | 入口类别       |
| --------------------------------- | ------------------------- | -------------- |
| `goal_completion_verification`    | Goal 完成验证             | system-sidecar |
| `goal_title_generation`           | Goal 标题生成             | system-sidecar |
| `project_memory_extract`          | Project Memory 提取       | system-sidecar |
| `project_memory_dream`            | Project Memory Dream/整理 | system-sidecar |
| `project_memory_recall`           | Project Memory 召回       | system-sidecar |
| `session_title_generation`        | Session 标题生成          | system-sidecar |
| `tool_internal_model_call`        | 未单列的 Tool 内模型工作  | tool/system    |
| `web_fetch_processing`            | Web Fetch 内容处理        | tool           |
| `web_search`                      | Web Search 模型请求       | tool           |
| `workspace_git_commit_message`    | Git Commit Message 生成   | system-sidecar |
| `workspace_generate_text`         | Workspace 通用文本生成    | system-sidecar |

`agent_step` 和 `context_compaction` 也属于 `AgentTelemetryOperation`，但有专属父 Span，不作为
Detached Start 的 operation。

“入口类别”只帮助理解 Operation，不是 `zcode.execution.actor_kind`。后者只描述执行该操作的
Agent Runtime：`main/subagent/workflow_child`。

## 11. `model_call`

Parent：`agent_step`、`context_compaction`、`tool_execution` 或 `detached_operation`。一个逻辑
Call 包含一个或多个物理 Attempt。

| 专属字段                                             | 类型     | 含义                                                             |
| ---------------------------------------------------- | -------- | ---------------------------------------------------------------- |
| `zcode.model_call.operation`                         | enum     | 模型调用的业务用途                                               |
| `zcode.model_call.streaming`                         | boolean  | 逻辑调用是否请求流式模式                                         |
| `zcode.model_call.model_role`                        | string?  | 主模型、快速模型等受控角色                                       |
| `zcode.model_call.requested_provider_id`             | string   | 解析后的 Provider 配置 ID                                        |
| `zcode.model_call.requested_model`                   | string   | 用户/调用方请求的 Model                                          |
| `zcode.model_call.call_cause`                        | enum     | `initial` / `continuation` / `fallback_replacement` / `recovery` |
| `zcode.model_call.previous_logical_call_id`          | string?  | 非 initial 调用的前序逻辑 ID                                     |
| `zcode.model_call.reasoning_capability`              | enum     | `supported` / `unsupported` / `unknown`                          |
| `zcode.model_call.reasoning_requested_state`         | enum     | `enabled` / `disabled` / `provider_default` / `unknown`          |
| `zcode.model_call.reasoning_requested_control`       | enum     | 控制方式，见下方                                                 |
| `zcode.model_call.reasoning_requested_level`         | string?  | 请求的 effort/level 原值                                         |
| `zcode.model_call.reasoning_requested_budget_tokens` | integer? | 请求的思考预算                                                   |

```text
reasoning control =
  fixed_level | fixed_budget | adaptive | toggle | provider_default | unknown

outcome = completed | failed | cancelled | abandoned
failure_stage = resolve_target | attempts | fallback | aggregate | unhandled
```

Reasoning 是跨 Provider 的规范化概念；上游叫 Thinking 或 Reasoning 都在 Adapter 层映射为
Capability、State、Control、Level/Budget。未知/自定义模型不能被推断为 disabled。

## 12. `model_attempt`

Parent：`model_call`。SpanKind：`CLIENT`。一个 Attempt 对应一次真实 Provider API 请求。

### 12.1 请求与关联

| 字段                                      | 类型    | 含义                                                                           |
| ----------------------------------------- | ------- | ------------------------------------------------------------------------------ |
| `zcode.model_attempt.request_id`          | string  | ZCode 物理请求 ID                                                              |
| `zcode.model_attempt.attempt_number`      | integer | 从 1 开始的 Attempt 序号                                                       |
| `zcode.model_attempt.max_attempts`        | integer | 当前策略最大尝试数                                                             |
| `zcode.model_attempt.attempt_cause`       | enum    | `initial` / `retry` / `fallback`                                               |
| `zcode.model_attempt.previous_request_id` | string? | Retry/Fallback 的前序请求 ID                                                   |
| `zcode.model_attempt.retry_delay_ms`      | number? | 本 Attempt 前等待时间                                                          |
| `zcode.model_attempt.transport`           | enum    | Adapter 的真实 Transport，如 `sse` / `json`                                    |
| `zcode.model_attempt.api_operation`       | enum    | `messages` / `chat_completions` / `responses` / `generate_content` / `unknown` |

### 12.2 Provider、Endpoint 与 Model

| 字段                                      | 类型    | 含义                                    |
| ----------------------------------------- | ------- | --------------------------------------- |
| `zcode.model_attempt.provider_id`         | string  | 用户配置/路由实例 ID                    |
| `zcode.model_attempt.provider_kind`       | enum    | 协议/厂商类型，如 `anthropic`、`openai` |
| `zcode.model_attempt.provider_origin`     | string? | 清洗后的 `scheme://host[:port]`         |
| `zcode.model_attempt.provider_route`      | string? | 清洗后的 Path，不含 Query/Fragment      |
| `zcode.model_attempt.requested_model`     | string  | 该 Attempt 实际请求的 Model             |
| `zcode.model_attempt.response_model`      | string? | Provider 响应返回的 Model               |
| `zcode.model_attempt.provider_request_id` | string? | Provider 返回的请求 ID                  |

`provider_id` 与 `provider_kind` 不同：同一种 OpenAI 兼容协议可以有多个用户配置实例；Origin
描述真正请求到的服务位置。Origin 缺失表示 Adapter 没提供或 Base URL 无法安全解析，不是
“默认 Provider”。

### 12.3 Reasoning

Attempt 重复 Call 的请求 Reasoning，是为了 Provider/Model 物理请求独立查询；并增加响应确认
后的 Effective 值：

```text
zcode.model_attempt.reasoning_capability
zcode.model_attempt.reasoning_requested_state
zcode.model_attempt.reasoning_requested_control
zcode.model_attempt.reasoning_requested_level
zcode.model_attempt.reasoning_requested_budget_tokens
zcode.model_attempt.reasoning_effective_state
zcode.model_attempt.reasoning_effective_control
zcode.model_attempt.reasoning_effective_level
zcode.model_attempt.reasoning_effective_budget_tokens
```

Requested 表示进入 Provider Adapter 的意图；Effective 表示 Adapter/Provider 最终采用的事实。
缺少 Effective 事实时省略，不从 Requested 猜测。

### 12.4 Usage、流式和响应

| 字段                                                  | 类型    | 含义                                                                               |
| ----------------------------------------------------- | ------- | ---------------------------------------------------------------------------------- |
| `zcode.model_attempt.input_tokens`                    | number? | Provider Usage 输入 Token                                                          |
| `zcode.model_attempt.output_tokens`                   | number? | Provider Usage 输出 Token                                                          |
| `zcode.model_attempt.reasoning_tokens`                | number? | Provider Usage Reasoning Token                                                     |
| `zcode.model_attempt.cache_read_tokens`               | number? | Provider 报告的 Cache Read Token                                                   |
| `zcode.model_attempt.cache_write_tokens`              | number? | Provider 报告的 Cache Write Token                                                  |
| `zcode.model_attempt.finish_reason`                   | string? | Provider 原始有界结束原因                                                          |
| `zcode.model_attempt.stream_output_committed`         | boolean | 终态时流输出是否已提交给业务消费者；当前 Status Sink 对缺失旧事件值按 false 归一化 |
| `zcode.model_attempt.time_to_first_provider_event_ms` | number? | 首个 Provider Event 耗时                                                           |
| `zcode.model_attempt.time_to_first_content_ms`        | number? | 首个有效内容耗时                                                                   |
| `zcode.model_attempt.time_to_first_text_ms`           | number? | 首段文本耗时                                                                       |

Token Setter 接收累计值，Metric 内部只记录单调增量；回退值比已记录值小时忽略，避免重复计数。
“是否命中缓存”不创造布尔摘要：Provider 返回 `cache_read_tokens > 0` 即可表达原始事实；没返回
Usage 时保持缺失。

### 12.5 HTTP 与 Error

| 字段                                         | 类型     | 含义                                                           |
| -------------------------------------------- | -------- | -------------------------------------------------------------- |
| `zcode.model_attempt.http_status_code`       | integer? | Provider HTTP 状态，例如 429/500；当前由失败 Status Event 提供 |
| `zcode.model_attempt.provider_error_code`    | string?  | Provider Response 中的原始错误码                               |
| `zcode.model_attempt.provider_error_message` | string?  | Provider Response 原始错误信息，经脱敏和截断                   |
| `zcode.model_attempt.retry_after_ms`         | number?  | Provider 指示的重试等待                                        |

Lifecycle 的 `error_code/error_message` 表示终止该 Span 的 Error（当前 Adapter 通常传入原始
Transport/SDK Error；仅缺失 Error 对象时由 Status 事实构造）；`provider_error_*` 表示 Provider
Response 的结构化错误事实。二者可能同时存在，不应互相覆盖或按 error code 模板化。

```text
outcome = completed | failed | cancelled | abandoned
failure_stage = configuration | connect | response | stream | parse | validation | unhandled
```

Events：

- `first_provider_event`：最多一个；
- `first_content`：最多一个；
- `first_text`：最多一个；
- `stream_stalled { idle_ms }`：每次检测到明显停顿写入，Metric 只保留 Count 和 Max；
- 父 `model_call` 的 `fallback_selected { reason }` 记录逻辑 Fallback 决策。

## 13. Compatibility Adapter

Canonical 字段始终先写，兼容字段由独立 Adapter 从同一已清洗事实同步投影。外部标准发生语义
漂移时，只修改 Adapter 和测试，不修改业务 Writer API。

| Canonical 事实          | 兼容字段                             | 转换                          |
| ----------------------- | ------------------------------------ | ----------------------------- |
| Tool 执行               | `gen_ai.operation.name=execute_tool` | 固定值                        |
| Tool Call ID            | `gen_ai.tool.call.id`                | exact                         |
| Tool Name               | `gen_ai.tool.name`                   | exact                         |
| Command Exit Code       | `process.exit.code`                  | exact                         |
| Command Signal          | `process.signal.name`                | exact                         |
| Provider Kind           | `gen_ai.provider.name`               | exact                         |
| Requested Model         | `gen_ai.request.model`               | exact                         |
| Response Model          | `gen_ai.response.model`              | exact                         |
| Finish Reason           | `gen_ai.response.finish_reasons`     | string → 单元素数组           |
| Input Token             | `gen_ai.usage.input_tokens`          | exact                         |
| Output Token            | `gen_ai.usage.output_tokens`         | exact                         |
| HTTP Status             | `http.response.status_code`          | exact                         |
| Provider Origin Host    | `server.address`                     | 从清洗后 Origin 提取 hostname |
| Provider Origin Port    | `server.port`                        | 显式端口或协议默认端口        |
| Lifecycle Error Type    | `error.type`                         | exact，首次认领 Error 时写    |
| Lifecycle Error Message | `error.message`                      | exact，已脱敏                 |

兼容字段不构成第二套内部 Schema。内部查询优先使用 `zcode.*`。

## 14. Event 目录

| Span                 | Event                   | Attribute  | 去重/上限                            |
| -------------------- | ----------------------- | ---------- | ------------------------------------ |
| `tool_execution`     | `permission_requested`  | —          | 首次一次                             |
| `tool_execution`     | `permission_decided`    | `decision` | 一次决定                             |
| `command_execution`  | `first_output`          | —          | 首次一次                             |
| `command_execution`  | `termination_requested` | `reason`   | 每次明确请求；受 Span Event 上限保护 |
| `context_compaction` | `fallback_selected`     | `reason`   | 每次显式决策                         |
| `model_call`         | `fallback_selected`     | `reason`   | 每次显式决策                         |
| `model_attempt`      | `first_provider_event`  | —          | 首次一次                             |
| `model_attempt`      | `first_content`         | —          | 首次一次                             |
| `model_attempt`      | `first_text`            | —          | 首次一次                             |
| `model_attempt`      | `stream_stalled`        | `idle_ms`  | 非逐 Chunk；受 Event 上限保护        |

## 15. Metric 目录

所有 Duration/TTF Histogram 的 Unit 为秒；Trace 中对应 `_ms` Attribute 为毫秒。

| Instrument                                         | 类型      | 含义                           | 允许 Label                                                                            |
| -------------------------------------------------- | --------- | ------------------------------ | ------------------------------------------------------------------------------------- |
| `zcode.agent.turn.duration`                        | Histogram | Turn 终态耗时/流量             | outcome、error_category、actor_kind、input_source、launch_surface                     |
| `zcode.agent.step.duration`                        | Histogram | Step 终态耗时/流量             | outcome、error_category、actor_kind、terminal_reason                                  |
| `zcode.tool.execution.duration`                    | Histogram | Tool 终态耗时/流量             | outcome、error_category、tool_name                                                    |
| `zcode.command.execution.duration`                 | Histogram | Command 终态耗时/流量          | outcome、error_category、command_category、command_safe_name                          |
| `zcode.context.compaction.duration`                | Histogram | Compaction 终态耗时/流量       | outcome、error_category、trigger、model_mode                                          |
| `zcode.detached.operation.duration`                | Histogram | Detached 终态耗时/流量         | outcome、error_category、operation、execution_kind                                    |
| `zcode.model.call.duration`                        | Histogram | Logical Call 终态耗时/流量     | outcome、error_category、model_operation、model_role、call_cause                      |
| `zcode.model.attempt.duration`                     | Histogram | Provider Attempt 终态耗时/流量 | outcome、error_category、provider_kind、model、transport、model_operation、model_role |
| `zcode.model.call.attempts`                        | Histogram | 每个 Call 的 Attempt 数        | 上述 Call Label + retry_state                                                         |
| `zcode.model.attempt.tokens`                       | Counter   | Provider Token 增量            | provider_kind、model、transport、model_operation、model_role、token_type              |
| `zcode.model.attempt.time_to_first_provider_event` | Histogram | TTF Provider Event             | Attempt Label                                                                         |
| `zcode.model.attempt.time_to_first_content`        | Histogram | TTFC                           | Attempt Label                                                                         |
| `zcode.model.attempt.time_to_first_text`           | Histogram | TTFT                           | Attempt Label                                                                         |
| `zcode.model.attempt.stream_stall.count`           | Counter   | 流停顿次数                     | Attempt Label                                                                         |
| `zcode.model.attempt.stream_max_idle`              | Histogram | 每 Attempt 最大停顿            | Attempt Label                                                                         |
| `zcode.command.execution.time_to_first_output`     | Histogram | Command 首次输出               | Command Label                                                                         |
| `zcode.telemetry.creation_drop.count`              | Counter   | Writer 创建前被容量保护拒绝    | span_name、drop_reason                                                                |
| `zcode.telemetry.abandoned.count`                  | Counter   | 非正常收口 Span                | span_name、abandon_reason                                                             |

```text
token_type = input | output | reasoning | cache_read | cache_write
retry_state = not_needed | recovered | not_recovered
drop_reason = process_capacity | unknown
```

禁止作为 Metric Label：

```text
用户、安装、Session、Turn、Query、Tool Call、Logical Call、Request ID
Provider ID、Endpoint Origin/Route、Provider Request ID
Error/Provider Error Message
```

Model ID 是允许的受控例外，保留原始值并由每个 View 的 250 Series 基数上限保护。

### 15.1 Histogram Bucket

当前显式 View 使用以下秒级边界：

| Instrument Pattern                                                                                      | Boundaries                                                                              |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `zcode.agent.turn.duration`                                                                             | `0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600`                                               |
| `zcode.model.*.duration`                                                                                | `0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120`                                              |
| `zcode.agent.step.duration` / `zcode.context.compaction.duration` / `zcode.detached.operation.duration` | `0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600` |
| `zcode.tool.execution.duration`                                                                         | `0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 30, 120, 300`                                |
| `zcode.command.execution.duration`                                                                      | `0.01, 0.05, 0.1, 0.5, 1, 5, 30, 120, 300, 600`                                         |
| `zcode.*.time_to_first_*`                                                                               | `0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120`                                              |
| `zcode.model.call.attempts`                                                                             | `1, 2, 3, 4, 5, 8, 13`                                                                  |

所有显式 View 的 Series 基数上限为 250。未匹配这些 View 的 Histogram 使用当前 OTel SDK 默认
Aggregation；若为它们新增 SLO，必须先显式定义 Bucket 并同步更新本表。

## 16. ID 词典

| ID                    | 作用域        | 生成方              | 用途                 |
| --------------------- | ------------- | ------------------- | -------------------- |
| `traceId`             | Trace         | OTel SDK            | 整条执行链           |
| `spanId`              | Span          | OTel SDK            | 单个节点             |
| `service.instance.id` | 进程          | Telemetry Bootstrap | 单进程诊断           |
| `installation_id`     | 产品安装      | Telemetry State     | 跨版本安装假名关联   |
| `user_subject_id`     | 登录主体      | Host/Auth           | 受控用户关联         |
| `session_id`          | Session       | Core                | 会话关联             |
| `turn_id`             | Turn          | Core                | 一轮执行关联         |
| `query_id`            | 请求          | Core                | 请求关联             |
| `tool_call_id`        | Tool Call     | Model/Core          | Tool 生命周期关联    |
| `logical_call_id`     | 逻辑模型调用  | Model Telemetry     | Retry/Fallback 聚合  |
| `request_id`          | 物理 Attempt  | Model Adapter       | 一次 Provider 请求   |
| `provider_request_id` | Provider 请求 | Provider            | 与 Provider 支持对账 |

ID 只记录受控、短、有字符约束的值；不能把 Prompt、URL 或路径编码成 ID。
