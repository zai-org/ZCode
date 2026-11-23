# Desktop Renderer 用户操作 Trace

## 状态

- 本文是 Electron Desktop Renderer 用户语义操作 Trace 的实现规范。
- 只新增 `ui_action` Span；Web、手机、Host、CLI、RPC 与 ZCode Protocol 不接入。
- `/event/report` 保持现有事件、字段与计数，不复用本 Catalog。

## 架构

```text
用户操作
  -> Renderer Feature Catalog
  -> Renderer 创建/结束 ui_action
  -> Renderer 有界批处理
  -> Main 透明 Broker
  -> OTLP
```

Main 只分发灰度配置、校验 batch 并使用自身凭据导出。Main 不创建、结束、重采样、
改写或重新挂接 Span；Host/CLI 不接收 Trace Context。

## Catalog

### Core：25 个叶子 feature

| feature_id                         | action                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `workspace.local.lifecycle`        | `open` / `switch` / `close`                                                                                         |
| `workspace.remote.lifecycle`       | `open_dialog` / `connect` / `reconnect` / `disconnect`                                                              |
| `workspace.project_binding`        | `attach` / `detach` / `work_outside_project`                                                                        |
| `task.lifecycle`                   | `create` / `open` / `archive` / `rename` / `delete`                                                                 |
| `task.layout`                      | `open_split` / `split_right` / `split_down` / `close_pane`                                                          |
| `conversation.composer.message`    | `send` / `stop`                                                                                                     |
| `conversation.composer.attachment` | `add` / `remove` / `retry_upload`                                                                                   |
| `conversation.composer.config`     | `change_model` / `change_thought_level` / `change_mode`                                                             |
| `conversation.queue.item`          | `send_now` / `edit` / `remove` / `reorder`                                                                          |
| `conversation.queue.policy`        | `resume` / `toggle_auto_drain` / `toggle_followup` / `clear_and_send` / `keep_and_send`                             |
| `conversation.history.branch`      | `retry` / `edit` / `fork` / `rewind_files`                                                                          |
| `conversation.history.feedback`    | `like` / `dislike` / `clear_feedback` / `copy`                                                                      |
| `conversation.blocking.user_input` | `select_option` / `submit_text` / `cancel`                                                                          |
| `conversation.blocking.hook`       | `review` / `dismiss`                                                                                                |
| `conversation.navigation`          | `load_older` / `jump_bottom` / `open_turn`                                                                          |
| `conversation.subagent`            | `expand` / `open_side_pane` / `open_split`                                                                          |
| `conversation.background_work`     | `open` / `cancel`                                                                                                   |
| `workbench.file`                   | `open_tree` / `refresh` / `open_file` / `open_preview`                                                              |
| `workbench.terminal`               | `open` / `close`                                                                                                    |
| `workbench.browser`                | `open` / `navigate` / `back` / `forward` / `refresh` / `open_external`                                              |
| `workbench.git`                    | `open` / `commit` / `generate_commit_message` / `run_action`                                                        |
| `extension.plugin`                 | `open_store` / `search` / `open_detail` / `install` / `enable` / `disable` / `update` / `uninstall` / `save_config` |
| `extension.mcp`                    | `authorize` / `refresh` / `enable` / `disable`                                                                      |
| `automation.lifecycle`             | `create` / `update` / `run_now` / `enable` / `disable` / `pause` / `resume` / `delete`                              |

### Settings：17 个叶子 feature

| feature_id               | action                                                                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings.navigation`    | `open_section` / `back_to_workspace` / `open_onboarding`                                                                                                                                                            |
| `settings.locale`        | `change_locale`                                                                                                                                                                                                     |
| `settings.appearance`    | `change_theme` / `change_ui_font_size` / `change_code_light_theme` / `change_code_dark_theme` / `toggle_code_line_numbers` / `toggle_code_line_wrap` / `change_code_font_size`                                      |
| `settings.terminal`      | `toggle_system_profile` / `save_font_family` / `change_shell`                                                                                                                                                       |
| `settings.search`        | `toggle_native_search`                                                                                                                                                                                              |
| `settings.network`       | `save_http_proxy` / `save_no_proxy` / `save_ca_certificate`                                                                                                                                                         |
| `settings.desktop`       | `toggle_hardware_acceleration` / `toggle_close_to_tray` / `toggle_keep_awake`                                                                                                                                       |
| `settings.update`        | `toggle_preview_updates` / `toggle_auto_update`                                                                                                                                                                     |
| `settings.notification`  | `toggle_notification` / `toggle_notification_sound`                                                                                                                                                                 |
| `settings.conversation`  | `change_interaction_behavior` / `toggle_ask_user_auto_resolution` / `toggle_model_io_retention` / `toggle_show_reasoning` / `toggle_show_todos` / `toggle_total_tokens_reminder` / `toggle_agent_always_background` |
| `settings.tool_grouping` | `toggle_explore_grouping` / `toggle_terminal_grouping` / `toggle_changes_grouping`                                                                                                                                  |
| `settings.task`          | `toggle_auto_archive` / `change_auto_archive_days`                                                                                                                                                                  |
| `settings.storage`       | `change_data_directory`                                                                                                                                                                                             |
| `settings.memory`        | `toggle_memory` / `refresh_memory` / `change_memory_scope`                                                                                                                                                          |
| `settings.browser`       | `toggle_browser_use` / `import_browser_data` / `toggle_insecure_certificates` / `clear_cache` / `clear_all_data`                                                                                                    |

`toggle_*` 通过 `state_after=enabled|disabled` 表达目标值；`change_*` 只允许低基数枚举；
`save_*` 只在显式提交时开始。`toggle_memory` 不删除已有 Memory。

## 生命周期与字段

操作通过本地校验、即将产生真实语义副作用时开始。导航在目标视图提交后结束，设置在相应
偏好或服务写入成功后结束，Command 仅在 Renderer 收到 `accepted` ACK 后完成。确认型操作
从最终确认开始；超时或卸载为 `abandoned`。遥测异常不得改变业务结果。

固定 outcome：`completed` / `failed` / `rejected` / `cancelled` / `noop` / `abandoned`。

固定 result source：`local_commit` / `shared_settings` / `setting_service` /
`platform_result` / `authority_ack` / `optimistic_projection`。

Span Name 固定为 `ui_action`，service.name 固定为 `zcode-desktop-renderer`。允许字段仅包括
Catalog 标识、surface/trigger、结果、受控状态、workspace/remote 类型和 action_id。禁止 prompt、
回复、文件内容、路径、workspaceIdentity、remoteSessionId、代理地址、证书路径、字体名称、
Cookie、浏览记录、Model I/O、完整错误和 stack。

## 灰度、批次与失败合同

`/api/v1/client/configs` 的 `data.configs.rendererActionTrace` 下发：

```json
{
  "enabled": true,
  "sampleRatio": 0.05,
  "enabledGroups": ["core", "settings"],
  "configVersion": "2026-08-25-v1"
}
```

- 生产默认关闭；缺失、首次超时、解析失败或非法配置均不采集。
- 生产 sampleRatio 只允许 0～0.20；开发/自动化测试显式使用 1.0。
- 未知 group 忽略；配置更新只影响新 Span。
- Renderer queue 256；batch 32 条/256 KiB；2 秒或满批触发。
- Main ingress 32 batch；OTLP timeout 3 秒，最多重试一次。
- 满队列、非法 DTO 或导出失败只丢遥测，不回压业务。

## 验收

- Catalog feature/action 唯一且完整。
- `/event/report` 调用和 payload 零变化。
- Host/CLI/RPC/Protocol 零改动。
- Web/手机不初始化、不发送 batch。
- Main 保留 Renderer 生成的 traceId/spanId/时间/Resource/Attribute。
- 无敏感字段，无新增 50ms Long Task，Renderer Heap 增量不超过 10 MB，batch IPC P95 小于 5ms。
