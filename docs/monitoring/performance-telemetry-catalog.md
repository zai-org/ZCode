# 性能埋点事件字典

> 跨通道速查清单，回答"性能相关埋点有哪些、各自上报什么"。
> 详细口径与边界见 [performance-monitoring.md](./performance-monitoring.md)；本表只做索引与字段速查。
> CLI Agent 模型 API OTel 统一观测见
> [CLI Agent Telemetry 开发指南](../trace/cli-agent-telemetry.md)；部署侧配置 ARMS OTLP 后生效。
>
> 数据分四条通道：
>
> - **ARMS（main 进程）**：`@arms/rum-electron` `sendCustom`，进程级稳定性 / 资源 / 网络；ZCode CLI 资源由 CLI 自采样后转交 main。
> - **ARMS（renderer/UI）**：`reportArmsCustomEvent` → IPC → main `sendCustom`，`group=ui_perf`。
> - **ARMS（CLI Agent）**：`@zcode/telemetry` → OTLP/HTTP protobuf，模型 Logical Call / Physical Attempt。
> - **`/report`（agent_trace）**：`reportAppTelemetryEvent`，消息链路质量与耗时，**非 ARMS**。
>
> **V4 接线规范**：聊天 `/report` 和 renderer ARMS 的恢复口径见
> [conversation-telemetry-v4.md](./conversation-telemetry-v4.md)。实现必须通过 live-only fact feed 接线，
> 不能从 initial/recovery 投影补报。

## `/report` 本地日志边界

- `TelemetryCore` 不在本地日志中打印请求、完整 payload、响应、响应体或原始错误。
- 全部 attempt 最终失败后只记录一条脱敏 warn；字段限定为事件名、event ID、attempt 数、状态分类和
  耗时。逐次重试只使用开发态 debug。完整投递合同见
  [event-report-delivery-reliability.md](./event-report-delivery-reliability.md)。
- 上报失败继续按原 Promise 拒绝路径交给调用方处理；有界重试不得改变 `device_mid` 持久化或
  daily-active 去重语义。
- `message_completion` / `agent_step` 属于随消息和步骤增长的高频事件，禁止为每次上报增加本地
  console 或落盘日志。

## 公共维度

| 通道                  | 自动携带维度                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| ARMS main             | `platform` / `app_version` / `arms_env` / `device_mid`（+各 group 专有维度，见下）                                                                |
| ARMS ui_perf          | 同上 + `renderer_id`（由 main IPC handler 补齐）                                                                                                  |
| `/report` agent_trace | `model_name` / `model_provider` / `ask_mode` / `agent` / `talk_id` / `message_id` / `workspace_kind` / `remote_kind`（version 由后端注入）        |
| ARMS CLI Agent        | `service.name=zcode-cli-agent` + `uid`（hash）/ `device_mid` / `session_id` / `turn_id` / `trace_id` / `rid` / `operation` / `provider` / `model` |

---

## 一、ARMS 稳定性 `group=stability`

专有维度：`scene_lifecycle`（cold_start / runtime / app_quit / update_install）、`scene_window`（main / process_monitor / other）。

| 事件                       | value             | 上报内容                                                                                                                                                                                                      | 触发条件                                                                               |
| -------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `perf_app_start`           | —                 | 冷启动计数（Crash-Free 分母，绑 `device_mid`）                                                                                                                                                                | 主窗 `did-finish-load` 后延迟 **3.2s**（`PERF_APP_START_AFTER_VIEW_MS`）               |
| `perf_crash`               | `1`               | `crash_scope` / `crash_cause` / `crash_source=electron_callback` / `crash_id` / 兼容字段 `crash_kind`                                                                                                         | `render-process-gone` / ZCode Host `child-process-gone`；每个 Electron 回调上报一次    |
| `perf_agent_start`         | `1`               | `runtime_instance_id` / `runtime_generation` / `provider`                                                                                                                                                     | Agent 子进程成功触发 Node `spawn`                                                      |
| `perf_agent_ready`         | `1`               | `runtime_instance_id` / `runtime_generation` / `provider` / `startup_duration_ms`                                                                                                                             | Agent runtime 首次通过 provider/model 门禁                                             |
| `perf_agent_crash`         | `1`               | `runtime_instance_id` / `error_name` / `error_code` / `error_message` / `error_stack` / `error_fingerprint` / `exit_code` / `signal` / `uptime_ms` / `crash_phase` / `termination_class` / `diagnostic_class` | Host 管理的 Agent 无主动退出意图且未命中受控终止排除条件时 exit；每个 runtime 只报一次 |
| `perf_agent_spawn_error`   | `1`               | `runtime_instance_id` / `error_name` / `error_code` / `error_message` / `error_stack` / `error_fingerprint` / `runtime_generation` / `diagnostic_class`                                                       | Agent command/cwd spawn 失败                                                           |
| `perf_mcp_process_start`   | `1`               | `mcp_id` / `mcp_instance_id` / `mcp_source` / `mcp_isolation` / `runtime_surface`                                                                                                                             | 正式 stdio MCP 完成连接和 `tools/list`；版本探测 probe 不计                            |
| `perf_mcp_process_crash`   | `1`               | start 标识 + `exit_code` / `signal` / `uptime_ms` / `affected_session_count`                                                                                                                                  | 已发 start 的 stdio MCP 非预期退出；主动回收不计                                       |
| `perf_mcp_session_startup` | `process_count`   | `session_id` / `configured_count` / `connected_count` / `process_count` / `failed_count`                                                                                                                      | 每个 session lease 的首次 MCP startup snapshot                                         |
| `perf_anr`                 | `duration_ms`     | 无响应时长                                                                                                                                                                                                    | `webContents` `unresponsive` 持续 ≥ **5s**（`STABILITY_ANR_THRESHOLD_MS`）             |
| `perf_freeze`              | `duration_ms`     | 冻结时长（期间未发生 crash）                                                                                                                                                                                  | `unresponsive` 持续 ≥ **30s**（`STABILITY_FREEZE_THRESHOLD_MS`）                       |
| `perf_app_exit`            | `exit_code`（=0） | `exit_kind=normal`                                                                                                                                                                                            | `before-quit`                                                                          |
| `perf_process_exit`        | `exit_code`       | `exit_reason` / `process_role`                                                                                                                                                                                | 子进程 / 渲染进程异常退出                                                              |

SDK 原生 crash 不走 `sendCustom(group=stability)`，使用独立事件契约：

| `event_type` | `type`  | `source`        | 上报内容                                                                                                                                                                           | 触发条件                                                                                                                             |
| ------------ | ------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `exception`  | `crash` | `crashReporter` | `crash_scope=app_native_process`（仅 `native_dump_process_role=main`）或 `native_dump_unattributed` / `crash_cause=native_crash` / `crash_source=crash_reporter_dump` / `crash_id` | dump 的 `binary_images` 命中产品应用名或真实 runtime exe 名；仅确认产品二进制但没有主进程角色标记时保留为 `native_dump_unattributed` |

实现：`packages/desktop/src/main/desktopStabilityTelemetry.ts`、
`packages/desktop/src/main/appARMSBootstrap.ts`

---

## 二、ARMS 资源 `group=resource`

资源链路自 v3.12.1 起已实现，完整采样、聚合、失败语义与验收见
[全进程 CPU / 内存监控埋点](./process-resource-telemetry.md)。生产聚合窗口为 5 分钟，
开发构建与 E2E 为 1 分钟；Bash 完成事件即时发送。全部设备、全部角色采集。
三个事件共有 `platform`、`app_version`、`arms_env`、`device_mid` 四个全局属性，
与下列事件属性合并后最多 20 项；undefined 不发送。CPU 是整机归一化百分比，内存单位 KB。
`platform` / `arch` / `logical_cpu_count` / `total_memory_gb` 描述进程实际运行机，远端 CLI / MCP
覆盖桌面默认值；`app_version` 是负责上报的桌面版本。

角色词表：`main`、`renderer_main`、`renderer_guest`、`gpu`、`chromium_other`、`host`、
`scheduler`、`cli_chat`、`cli_aux`、`mcp`。main 的 `getAppMetrics()` 每 10 秒提供 Chromium CPU / RSS，
Node 与主 renderer 的 heap 每 60 秒自采；CLI 每 60 秒自采，MCP 每 5 分钟使用通用进程探针。
main 零外部进程；线程数、GPU 显存、磁盘 IO 与 10% 角色抽样均已删除。
本地 `[memory]` 日志继续与遥测复用读数，见[进程内存本地诊断日志](./memory-diagnostics-log.md)。

### `perf_process_window`

每角色 / runtime surface / 运行机分组每 5 分钟一条；MCP 再按 mcp_id 分组。
`value=cpu_percent_mean`。Node 与 renderer_main 最多 20 属性（heap 无读数时省略），
mcp 19 属性，其他 Chromium 角色 18 属性；白名单并集 21 项不代表单条发送 21 项。

| 类别 | 属性                      | 说明                                                               |
| ---- | ------------------------- | ------------------------------------------------------------------ |
| 维度 | `process_role`            | 上表 10 个枚举值                                                   |
| 维度 | `runtime_surface`         | `local` / `remote`                                                 |
| 维度 | `arch`                    | 运行机架构                                                         |
| 维度 | `logical_cpu_count`       | 运行机逻辑核数                                                     |
| 维度 | `total_memory_gb`         | 运行机物理内存，取整 GB                                            |
| 维度 | `mcp_id`                  | 仅 `mcp` 角色                                                      |
| 状态 | `background_ratio`        | 0 到 1，两位小数                                                   |
| 状态 | `uptime_minutes`          | 该角色内最老进程的运行分钟数                                       |
| CPU  | `cpu_percent_p95`         | 窗口内角色总 CPU 的 p95                                            |
| CPU  | `cpu_percent_peak`        | 窗口内角色总 CPU 的最大值                                          |
| 内存 | `rss_kb_total_mean`       | 角色内全部进程 RSS 之和的均值                                      |
| 内存 | `rss_kb_total_peak`       | 角色内全部进程 RSS 之和的最大值                                    |
| 内存 | `rss_kb_max_process_peak` | 窗口内单个进程 RSS 的最大值                                        |
| 内存 | `heap_used_kb_mean`       | 仅 Node 与 renderer_main；多进程取每次收到读数的最大单进程再求均值 |
| 内存 | `heap_used_kb_peak`       | 同上，取最大值                                                     |
| 质量 | `process_count_peak`      | 窗口内该角色同时存活的最大进程数                                   |
| 质量 | `sample_count`            | 窗口内样本数；main 侧角色预期 30，CLI 角色预期 5，mcp 为 1         |

### `perf_system_window`

每台桌面设备每 5 分钟一条，`value=app_cpu_percent_mean`，固定 17 属性。
Chromium 使用同 tick 精确合计，CLI / MCP 使用最近样本（120 / 600 秒过期）；远端不计入。

| 类别 | 属性                                             | 说明                                                               |
| ---- | ------------------------------------------------ | ------------------------------------------------------------------ |
| 维度 | `arch`、`logical_cpu_count`、`total_memory_gb`   | 桌面机                                                             |
| 状态 | `background_ratio`、`app_uptime_minutes`         | `background_ratio` 与角色事件同源；uptime 取 main 进程运行时长     |
| 整机 | `system_cpu_percent_p95`                         | `os.cpus()` 差分                                                   |
| 整机 | `system_free_memory_kb_min`                      | 窗口内 `os.freemem()` 最小值                                       |
| 应用 | `app_cpu_percent_p95`                            | 全部本机 ZCode 进程合计                                            |
| 应用 | `app_rss_kb_total_mean`、`app_rss_kb_total_peak` | Chromium 体系每 10 秒精确合计，加 CLI 与 MCP 最近一次已知样本      |
| 应用 | `process_count_total_peak`                       | 全部本机 ZCode 进程数峰值                                          |
| 质量 | `sample_count`                                   | 首个 tick 无 CPU 基线不产生样本，5 分钟窗口预期 29                 |
| 质量 | `telemetry_self_ms`                              | 窗口内 main 侧采样与聚合代码累计墙钟毫秒数，`performance.now()` 计 |

### `perf_tool_exec_resource`

每条运行满 15 秒的 Bash 在完成时即时上报，`value=duration_ms`。
非 Windows 为 12 属性；Windows 无 tree 两项，共 10 属性，sample_count=0。

| 类别   | 属性                    | 说明                                                     |
| ------ | ----------------------- | -------------------------------------------------------- |
| 维度   | `runtime_surface`       |                                                          |
| 维度   | `tool_name`             | 第一期固定 `bash`                                        |
| 维度   | `exit_kind`             | `completed` / `timeout` / `killed` / `error`             |
| 命令   | `tree_rss_kb_peak`      | 命令进程树 RSS 之和的峰值                                |
| 命令   | `tree_cpu_time_ms`      | 命令进程树累计 CPU 时间；与 `duration_ms` 相除得到忙闲比 |
| 命令   | `sample_count`          | 采到的样本数                                             |
| 上下文 | `cli_rss_kb`            | 命令结束时 CLI 自身 RSS                                  |
| 上下文 | `system_free_memory_kb` | 命令结束时整机剩余内存                                   |

### 已停发资源事件

| 事件                   | 停发版本与替代                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `perf_resource_window` | **自 v3.12.1 起停发**；由角色级 `perf_process_window` 与设备级 `perf_system_window` 取代 |
| `perf_resource_agent`  | **自 v3.12.1 起停发**；由 `perf_process_window` 的 `cli_chat` / `cli_aux` 角色取代       |
| `perf_mcp_memory`      | **自 v3.12.1 起停发**；由 `perf_process_window` 的 `mcp` 角色取代                        |

### 独立资源事件

`perf_resource_zcode_data_size` 保持本地 ZCode 数据根逻辑字节数口径，每台设备最多 24 小时一次，
见[ZCode 数据目录占用 ARMS 上报](./zcode-data-size-arms-telemetry.md)。更早的 `perf_resource_cpu`
等仅用于历史查询。MCP 的三个稳定性生命周期事件见[MCP 进程 ARMS 可观测性](./mcp-process-arms-telemetry.md)。

---

## 三、ARMS 网络 `group=network`

**5min 聚合**（dev 1min）。每个 `{transport, interface}` 只发送一条
`perf_network_window`，合并全局 properties 后最多 20 个属性。HTTP path 仅保留显式登记的静态路由段，其他段模板化；任意本地绝对
路径归为 `local_file`；RPC=`channel.command`；
WS=`web_remote_control.relay`。

| 事件                  | value            | 说明                                                         |
| --------------------- | ---------------- | ------------------------------------------------------------ |
| `perf_network_window` | duration mean ms | counts + duration peak/p95；HTTP 阶段 mean；主错误类型与计数 |

数据源：HTTP 解析 ARMS `beforeReport` 的 `api` 事件；RPC 经 Host `NetworkTelemetryChannelServer` 回传；WS 来自远控 relay。
实现：`desktopNetworkTelemetry.ts`、`networkTelemetryAggregator.ts`、`packages/rpc/src/network-telemetry-middleware.ts`、`hostNetworkTelemetry.ts`

---

## 四、ARMS 端侧 UI 性能 `group=ui_perf`

renderer 侧埋点，全采（100%）。

### 4.1 启动分阶段（7 段，每冷启动各 1 次，`session_id` 关联同次启动）

| 事件                              | value 测量段                                                  |
| --------------------------------- | ------------------------------------------------------------- |
| `perf_ui_launch_to_input`         | **总**：进程创建（`getCreationTime`）→ 输入框可用             |
| `perf_ui_launch_electron_init_ms` | 进程创建 → main JS                                            |
| `perf_ui_launch_app_ready_ms`     | main JS → `app.whenReady`                                     |
| `perf_ui_launch_window_ms`        | `whenReady` → `loadURL`                                       |
| `perf_ui_launch_renderer_load_ms` | `loadURL` → bundle 执行                                       |
| `perf_ui_launch_react_commit_ms`  | bundle → React 首次 commit                                    |
| `perf_ui_launch_startup_gate_ms`  | React commit → 输入框可用（鉴权 / provider / workspace 恢复） |

### 4.2 Session 首次打开（每个逻辑打开最多两条）

| 事件                          | value      | 关键 properties                                                                 |
| ----------------------------- | ---------- | ------------------------------------------------------------------------------- |
| `perf_ui_session_open_start`  | `1`        | `session_open_id` / `session_id` / `open_kind` / `open_trigger` / `client_mode` |
| `perf_ui_session_open_result` | `total_ms` | `status` / `session_open_id` / `session_id` / Host/CLI/Renderer 阶段耗时字段    |

哨兵：任一段为负（跨进程时钟偏移）或总时长 > **300000ms**（`LAUNCH_TO_INPUT_SANITY_MAX_MS`）→ **整批丢弃**。未登录（WelcomeScreen）不上报。旧 `perf_ui_first_screen` 已废弃，语义并入 `perf_ui_launch_react_commit_ms`。

### 4.3 消息链路（镜像自 `/report` 的 `message_completion`，不新增计时）

| 事件                       | value                                               | properties                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `perf_ui_first_token`      | 首 token 延迟 ms                                    | `model` / `talk_id` / `message_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `perf_ui_message_complete` | 消息端到端耗时 ms                                   | `result` / `model` / `talk_id` / `message_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `perf_ui_stream_stall`     | 真实停顿 ms（流式相邻正文 chunk 间隔 > **3000ms**） | `stall_ms` / `waiting_tool` / `model` / `talk_id` / `message_id`（停顿结束的 chunk，取不到留空）                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `perf_ui_tool_call_detail` | 工具终态耗时 ms                                     | `tool_name` / `status` / `talk_id` / `message_id` / `tool_call_id` / `parent_tool_call_id` / `child_tool_call_id` / `child_session_id` / `agent_id` / `agent_type` / `total_ms` / `permission_wait_ms` / `command_run_ms` / `first_output_ms` / `no_output_ms` / `timed_out` / `command_name` / `command_category` / `command_count` / `command_status` / `fs_read_ms` / `fs_write_ms` / `patch_match_ms` / `file_count` / `total_bytes` / `max_file_bytes` / `hunk_count` / `match_attempts` / `workspace_kind` |

`perf_ui_stream_stall` 边界：工具调用期间不计入（`tool_call`/`tool_call_update` 到达时 `clearStreamStallTracking`）；阈值 `STREAM_STALL_REPORT_THRESHOLD_MS=3000` 仅作上报闸门，value 为真实间隔。`model` 取当前激活 prompt 的 `model_name`（`getActivePromptModelName`，chunk 本身不带模型），无激活 prompt 时留空。渲染卡顿（longTask）由 ARMS Browser SDK 自动采集，不在此手动埋点。

`agent_step` 明细只保留在 `/report` 的 `agent_trace` 链路；ARMS RUM 不再逐 step
双发，避免一条长消息按 step 数放大 IPC 和自定义事件量。RUM 侧通过
`perf_ui_turn_breakdown.agent_step_cnt`、首 token、端到端、流式停顿和工具终态事件做低频归因。
CLI 直接上报的 `zcode.agent.step` OTel Span 属于
[CLI Agent Telemetry 开发指南](../trace/cli-agent-telemetry.md)，不经过这条 IPC/RUM 链路，
也不等价于 `/report agent_step`。
`perf_ui_tool_call_detail` 只镜像带 `raw.result.perf` 的工具终态。subagent mirror 子工具会带父子关联字段，数仓拿到父 `Agent` 的 `tool_call_id` 后，可在 ARMS 中按 `parent_tool_call_id` 下钻子工具；非 subagent 工具这些字段为空。

`command_name` 只允许公开命令 Registry 中的静态可执行文件名或 `empty` / `compound` /
`other` 固定桶。`command_hash` 自 2026-07-27 起不再进入 RUM/ARMS：即使是截断 Hash，
仍会制造高基数，并可能通过常见命令字典进行反查；该字段只保留在 CLI 本地结构化诊断
对象中。CLI OTel Agent Trace 是工具可靠性的新主事实源，现有 RUM 事件短期双跑兼容，
后续看板迁移完成后再下线重复字段/事件。

`model` 与 `chat_error_banner.model_id` 共用同一条白名单：只允许 telemetry 显式白名单中的
内置稳定模型 ID，自定义 provider 的模型（`custom:<providerId>:<modelName>` 编码值）、
`<providerId>/<modelId>` 复合值中非内置 provider 的部分，以及内置 provider 下未命中白名单的
模型，统一写为 `custom`；缺失时留空。实现由 `@zcode/shared` 的
`sanitizeTelemetryModelValue` 收口，`uiPerfArmsTelemetry.emit` 在发送前统一改写 `model`
属性，调用方无需各自处理。白名单来源与内置 provider 双命名空间（运行时 `account:*` 与旧报表身份
`builtin:*`）的判定规则见 [plan-usage-arms-telemetry](./plan-usage-arms-telemetry.md)。
实现：`packages/ui/src/lib/uiPerfArmsTelemetry.ts`；V4 入口由 workspace telemetry supervisor 驱动。

### 4.4 ARMS SDK longTask 自动事件

| 字段                               | 口径                                                                                                |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| `event_type=longTask`              | Browser SDK 自动采集的渲染主线程卡顿事件。                                                          |
| `duration` / `fps` / `source`      | SDK 原始字段，`source` 为 `LoAF` 或 `rAF`。                                                         |
| `properties.loaf_script_count`     | SDK `snapshots` 内 attribution 条数，最多 5。                                                       |
| `properties.loaf_top_duration_ms`  | top attribution 耗时 ms，四舍五入且钳非负。                                                         |
| `properties.loaf_top_invoker_type` | `user-callback` / `event-listener` / `script` / `unknown`；rAF 缺少 `invokerType` 时归为 `script`。 |
| `properties.loaf_top_share_pct`    | top attribution 占 longTask 总 `duration` 的百分比整数；总时长无效时为 0。                          |

隐私边界：不把原始脚本名、脚本 URL、文件路径、selector、堆栈或源码片段写入 `properties`；`snapshots` 缺失或解析失败时不补字段。

---

## 五、ARMS 可见 UI 错误 `group=ui_error`

| 事件                | `surface`                    | 触发口径                                              | 去重口径                                                |
| ------------------- | ---------------------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| `chat_error_banner` | `chat_input_error_banner`    | 输入框上方错误横幅经过 suppression 后真实可见         | 同一 Composer mount 的 task/code/trace/message 指纹一次 |
| `chat_error_banner` | `session_subscription_error` | 正式 Session 的 conversation 订阅失败页在前台真实可见 | 同一 SessionPane mount 的 session/code/message 指纹一次 |

订阅失败继续复用 `chat_error_banner`，避免仪表盘出现第二套“用户可见聊天错误”口径；
通过 `surface` 区分输入框错误与整页订阅错误。事件必须保留结构化 `error_code`，
`fault.subscribe.sessionNotFound` 等 reasonCode 不得只埋在 message 中。后台 pane、
预热 draft 的静默回落和被产品逻辑抑制的错误不曝光。

Windows 桌面正常退出已确认（Main 的 `lifecycleScene=app_quit`）后，Host 清理可能取消在途
runtime 握手。如果 Main 在此后收到 `name=chat_error_banner`、`group=ui_error`、
`surface=session_subscription_error` 且 `error_message` 精确为
`Windows runtime start was cancelled` 的自定义事件，只跳过这条 ARMS 上报。Main 必须在
校验事件后、发送前读取现有退出状态；不得按批次发送时间、模糊错误文案或 Renderer 断连推断
正常退出。仍在运行、退出确认被取消、单独关窗或 `update_install` 下的同文案错误，以及任何
其他错误，都按原口径上报；本地日志、错误展示与重连行为不变。退出前已发送的事件不能撤回，
系统强制终止且未进入 `app_quit` 的场景不由此规则覆盖。启动性能事件用事件字段表达
`cold_start`，迟到的启动回调不得将已经确立的退出 lifecycle 改回 `runtime`。

定向验收使用
[`windows-runtime-quit-telemetry.test.ts`](../../packages/desktop/test/e2e/infrastructure/lifecycle/windows-runtime-quit-telemetry.test.ts)：
真实 Electron 正常退出完成后，以测试监听器保留 Renderer，通过原有 IPC 与 Main 最终事件环
验证运行中同文案可上报、退出后该事件零次、退出后 Job 控制通道错误仍可上报。2026-11-19
Windows x64 修复前反例失败、修复后 1/1 通过，证据为
`packages/desktop/.e2e-artifacts/desktop-e2e-20261119-024956-546`。此证据只验证 Main 的事件
准入，不声明真实系统关机、握手取消来源或其他平台覆盖。2026-11-19 用户确认转正，保留
infrastructure/lifecycle 场景，独立夹具声明 `providerRequestPolicy=none`；不增加 Docker
preset 或跨平台准入。正式路径 Windows x64 独立夹具回放与默认回放各 1/1 通过、0 跳过：
`packages/desktop/.e2e-artifacts/desktop-e2e-20261119-030234-095`（独立夹具）与
`packages/desktop/.e2e-artifacts/desktop-e2e-20261119-030343-939`（默认回放）。通用转正与夹具
检查 CLI 目前仅覆盖对话/插件域，本例沿用非对话用例的手工转正，独立 manifest 使用现有
准入合同校验，不扩改工程工具。

错误归因字段为可选增量字段：`error_source` / `failure_reason` / `provider_scope` /
`provider_id` / `model_id` / `provider_kind` / `transport` / `status_code` /
`provider_error_code` / `failure_retryable` / `failure_phase` / `failure_exception_kind`。其中
`provider_scope` 仅为
`builtin | custom | unknown`；自定义 provider 的 `provider_id` 固定写 `custom`。`model_id` 仅允许
telemetry 白名单内的内置稳定模型 ID；自定义或未命中白名单的模型固定写 `custom`，provider/model
缺失时写空字符串。禁止写入自定义 provider/model 名称、base URL/完整 URL、header/token、请求或
响应正文、prompt/tool 内容、stack、完整 detail 或 requestId。字段缺失不影响事件发送，也不改变
错误展示和恢复行为。

`failure_phase` 为固定 Model API 阶段枚举，`failure_exception_kind` 为 adapter allowlist 后的低基数
异常族；不得上传原始 exception name。Dashboard 应把 reason coverage 与 diagnostic coverage 分开。

实现：`packages/ui/src/lib/chatErrorBannerTelemetry.ts`、`packages/ui/src/v4/ConversationComposer.tsx`、
`packages/ui/src/v4/SessionPane.tsx`。

### 5.1 React 错误边界 `group=react_error`

| 事件               | value | properties                                                                            |
| ------------------ | ----- | ------------------------------------------------------------------------------------- |
| `perf_react_error` | `1`   | `error_name` / `error_message` / `error_stack` / `component_stack` / `boundary_scope` |

React 错误边界拦截子树渲染异常并阻止其冒泡到 `window.onerror`，Browser RUM SDK 的自动采集
看不到这类错误，因此单独补一条自定义事件。`boundary_scope` 为根级 `app` 或各 scoped 边界名。

隐私边界：`error_message`、`error_stack`、`component_stack` 在上报前必须经 `@zcode/shared` 的
`redactTelemetryText`，与 ARMS 自动采集 exception 事件
（[脱敏边界](./arms-browser-monitoring.md#自动采集事件的脱敏边界)）同一套规则：绝对路径归一为
`{path}`、邮箱归一为 `{email}`、URL 只留 `protocol//host` 与归一化路由、凭据归一为
`{redacted}` / `{secret}`。`error_stack` 与 `component_stack` 另有 4000 字符上限，保证最近的抛错
组件一定上得去。脱敏只作用于上报副本，本地日志与 fallback 恢复继续使用原值。

实现：`packages/ui/src/lib/reactErrorArmsTelemetry.ts`、`packages/ui/src/ErrorBoundary.tsx`。

---

## 六、消息链路（`/report` agent_trace，非 ARMS）

`messageTelemetry.ts` 继续提供旧格式 builder；V4 workspace telemetry supervisor 只消费 live facts，
再调用 `reportAppTelemetryEvent(eventType="agent_trace")`。

| elementName          | value 性质 | 关键上报字段                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message_completion` | 端到端     | `duration_ms`（从 sendTime 到 turn terminal 的用户可见墙钟耗时，包含前台 Subagent 与等待）/ `time_to_first_token`（未到首 token=-1）/ `waiting_ms`（所有 tool permission 等待累计）/ `input_tokens`·`output_tokens`·`reasoning_tokens`·`cached_input_tokens`·`cache_write_input_tokens`·`total_tokens` / `agent_step_cnt`（当前 message 实际收口的 step 数）/ `tool_call_total`·`tool_call_failed`（当前 message 实际收口的工具 step）/ `generated_code_lines` / `file_change_cnt` / `status` / `error_type`（失败归因）·`error_msg`（非空原文为 `[redacted]`，否则空串） / `request_time`                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `agent_step`         | 逐步骤     | `step_type`（reasoning / tool_call / generation）/ `loop_index` / `duration_ms`（step 墙钟耗时，包含等待）/ `waiting_ms`（tool permission 等待累计，非 tool 为 0）/ `generation_tail_finalize_ms`（仅桌面 `desktop-continuous` 中主 agent generation 被 `task_complete` / `task_error` 收口时写入，表示最后一个不带 `parentToolUseId` 的普通正文 chunk 到终态事件的尾延迟；手机 replayable 恢复重放和非适用场景留空字符串）/ `status`（success / fail / timeout）/ `tool_name` / `tool_call_id`（仅工具 step）/ `agent_id`（父 `Agent` 与镜像 child 工具的等值关联 id）/ `is_tool_call` / `model_name`·`model_provider`·`provider_name`（step 关联的真实请求模型维度）/ `model_request_id`·`model_request_count`·`token_usage_scope`（主请求为 `model_request`，前台 child 聚合为 `subagent_requests`）/ `input_tokens`·`output_tokens`·`reasoning_tokens`·`cached_tokens`·`cache_write_input_tokens`·`total_tokens`（完整 request usage 只归属一个 step）。仅走 `/report`，不逐条镜像 ARMS RUM；CLI OTel Step Span 另见 Agent Turn Trace 规范 |
| `context_compaction` | 压缩结果   | `status`（completed / failed / interrupted）/ `trigger` / `reason` / `attempt` / `duration_ms` / `pre_compact_tokens`·`post_compact_tokens`·`true_post_compact_tokens` / `compact_ratio`（post/pre）。成功率由数仓按 status 聚合                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

`message_completion` 与 `agent_step` 还必须携带同一组场景维度：`workspace_kind`（`local` /
`remote`）和 `remote_kind`（`ssh` / `wsl` / `docker` / `server`；本地或无法解析时为空字符串）。
两者由 workspace attachment 冻结，不能上传 `remoteSessionId`、workspace path、主机地址等高基数身份。

输入阶段字段（`queuePromptTelemetry` 注入到 `message_completion`）：`input_start_time` / `input_first_char_time` / `input_send_time`。
`agent_step_cnt`、`tool_call_total`、`tool_call_failed` 与逐条 `agent_step` 使用同一个
active prompt 生命周期；同 session 的历史 assistant 消息不参与本轮 completion 计数。
Skill tool step 始终携带 `skill_name`（仅取通过遥测校验的已解析名称，否则为 `unknown`，不读取请求参数），另外可携带 `skill_qualified_name`、`skill_plugin_id`、`skill_source`；仅在
`tool_name=Skill` 且 runtime 成功解析 metadata 时写入，不包含 Skill 正文或 description。
前台 handler 与后台 runtime monitor 都必须先把收到的 step/terminal 事件送入该生命周期，
再上报 `message_completion`；切换 task 不能让同一轮的后台计数归零或漏报逐条 `agent_step`。
所有携带 `inputId` 的 step stream event 都必须与 runtime 当前 `activeInputId` 一致；旧 input
迟到的 reasoning / generation / tool / terminal 事件不能收口或污染新 prompt 的 step 状态与
计数。旧协议不携带 `inputId` 时保留兼容路径；queued prompt 发送时即使重绑定实际 inputId，
也以 runtime `activeInputId` 为 ownership 事实源，不能拿排队阶段的 pending inputId 误拒当前事件。
格式实现：`packages/ui/src/lib/messageTelemetry.ts`；生命周期和多端边界见
[conversation-telemetry-v4.md](./conversation-telemetry-v4.md)。

---

## 六、ARMS CLI Agent 模型 API（OTLP Trace）

`service.name=zcode-cli-agent`，不走 Electron RUM `/rum/web/v2`，也不新增客户端数据库表。

| span.name             | 粒度                                        | 关键字段                                                                                                                                                                           |
| --------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zcode.model.call`    | 一次 `generateText/streamText` Logical Call | `operation` / `actor` / `provider_id/kind/origin/route` / `model` / requested/effective thinking / status / duration / TTFT / token/cache / retry recovery / error / `uid/rid/sid` |
| `zcode.model.attempt` | 一次真实 Provider HTTP/SSE 请求             | 上述公共维度 + attempt/max / transport / previous request / retry delay / provider request ID                                                                                      |

正常成功调用产生 1 Call + 1 Attempt；Adapter Retry 只增加 Attempt，Compaction SSE → HTTP fallback 产生两个通过 `previous_logical_call_id` 关联的 Call。所有事件都是 Terminal Span，不上报 Prompt、Header、Provider Options、工具内容或逐 SSE Chunk。

默认 5 秒/100 条 gzip protobuf 批量，队列上限 2,000 条或 4MiB；未配置 OTLP 时 No-op。App RUM、SQLite Usage 和 `/report` 当前继续双写，待灰度对账后再决定长期替代范围。

实现：`apps/zcode-cli/packages/telemetry`、`apps/zcode-cli/packages/adapters/src/model/runner-status.ts`。

## 覆盖度与已知缺口

- ✅ **稳定性 / 资源 / 网络**：进程级齐全（CPU / 内存 / GPU / crash / ANR / freeze / 退出码 / 网络分层耗时）。
- ✅ **启动链路**：进程创建 → "能输入" 7 段拆分，可出分位。
- ✅ **消息链路**：输入 → 首 token → `/report` 逐步骤 → 停顿 → 端到端 → 上下文压缩；
  ARMS RUM 保持每轮/工具终态低频事件，CLI OTel Agent Turn Trace 独立演进。
- ✅ **CLI 模型 API**：主 Agent/Subagent/Workflow、Compaction、Sidecar 和工具内模型调用均形成 Call/Attempt；流量、成功率、耗时、Token/Cache、Retry/Fallback 和脱敏错误可在 ARMS 聚合。
- ⚠️ **CLI 模型看板待部署**：代码已支持标准 OTLP 注入，但仓库不内置 ARMS OTLP 凭据；Workspace 看板、告警和 RUM/SQLite 对账仍需部署侧灰度完成。
- ⚠️ **末帧渲染未覆盖**：`message_completion.duration_ms` / `time_to_first_token` 终点是 `task_complete` 到达 handler 的时刻，**不含 React 重渲染 → 浏览器 paint 上屏**那段；用户视角"渲染完"的延迟仍是盲区。
- ⚠️ **资源不归因到消息**：资源采样 5min 聚合，无法回答"发某条消息时 CPU/内存的尖峰"。
