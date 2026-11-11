# Conversation Session UI Test ID Contract

目标：为会话区 MVP E2E 提供稳定、全工程化的 UI 定位协议。WDIO 必须通过 `data-testid` 和明确 DOM 状态断言产品行为，不能依赖截图、CSS class、视觉位置或易变文案来判断通过。

## 现有规范

项目已有全局 test id 单一来源：

- `packages/shared/src/test-ids.ts`
- `docs/testing/testid-audit.md`
- `docs/architecture/architecture.md`

现有规则继续有效：

- 所有 `data-testid` 常量统一声明在 `packages/shared/src/test-ids.ts`。
- `test-ids.ts` 的常量只从 `@zcode/shared/test-ids` 导入，根入口 `@zcode/shared` 不导出它们；工作流一族 `test-ids-workflow.ts` 仍从根入口导入。原因见 [pre-push 说明](testing/pre-push-hook.md) 的受影响单测一节。
- 新增常量必须带中文注释。
- UI 组件禁止硬编码 test id 字符串。
- E2E 使用 `packages/desktop/test/e2e/helpers/selectors.ts` 的 `sel(tid)` 或等价 helper。
- 动态列表项使用 `testId(BASE, suffix)`。

## 断言原则

截图不是通过判定。截图和录像只作为失败后的人工复盘 artifact。

MVP UI 判定只能来自这些确定性信号：

| 信号                          | 用途                     | 示例                                                      |
| ----------------------------- | ------------------------ | --------------------------------------------------------- |
| `data-testid`                 | 定位稳定元素             | queue item、message、compact marker                       |
| `data-state`                  | 判断状态机投影           | `running`、`completed-interrupted`、`compacting`          |
| `data-status`                 | 判断操作结果             | `queued`、`started`、`completed`、`failed`、`interrupted` |
| `data-role`                   | 判断消息角色             | `user`、`assistant`、`tool`、`timeline`                   |
| `data-session-id`             | 判断元素属于哪个 session | active session、message list、queue panel                 |
| `data-message-id`             | 判断消息身份             | fork target、edit target                                  |
| `data-queue-item-id`          | 判断队列项身份           | send-now、edit、remove、reorder                           |
| `aria-disabled` / `disabled`  | 判断操作是否允许         | fork/edit/compact/send 按钮                               |
| input value / normalized text | 判断用户输入和消息内容   | queue item 文本、composer value                           |

文案可以作为内容断言，但不能作为定位手段。比如可以断言 queue item 文本包含“继续解释”，但不能用 `button=继续解释` 来找按钮。

### V4 canonical materialization 补充

V4 formal E2E 读取的是产品协议 materialization，不复用旧 M3/M4 debug row 文案：

- `TID_V4_ROW-*` 的 `timelineMarker` 根暴露 `data-row-kind="timelineMarker"`、`data-marker-type`、`data-status`；compact 再暴露 `data-origin`。V4 compact 终态词表是 `success/failed/noop/cancelled`，旧 UI 的 `started/completed` 只能作为 legacy 映射背景。
- `TID_CHAT_SUMMARY_PANEL` 是 goal/background 的统一 shell。`mini` 和 `panel` 都必须在 shell 暴露 `data-goal-status`、`data-goal-objective`、`data-running-background-count`；详情区是否挂载不影响 E2E 读取权威状态。
- V4 timeline 的 raw projection window、raw total 与 logical turn render units 必须使用不同属性：`data-window-row-count`、`data-total-row-count`、`data-render-unit-count`。mounted unit 用 `data-v4-turn-unit` 计数，禁止拿 `[TID_V4_ROW-*]` 数量冒充 virtual item 数。
- 编辑 latest user query 与排队消息都走 composer 编辑态（[Composer 编辑态](ui/composer-edit-mode.md)）：入口仍是
  `TID_V4_EDIT + rowId` / `TID_V4_QUEUE_ITEM_EDIT + queueItemId`，之后用 `TID_V4_COMPOSER_INPUT` 输入、`TID_V4_COMPOSER_SEND`
  提交。`TID_V4_COMPOSER_EDIT_BAR` 暴露 `data-edit-target-kind`（`userQuery|queueItem`）、`data-edit-target-id`、
  `data-edit-state`（`editing|invalid`）、`data-edit-invalid-reason`（`notLatest|queueItemRemoved|editLockLost`）；
  取消用 `TID_V4_COMPOSER_EDIT_CANCEL`，切换目标确认弹窗为 `TID_V4_COMPOSER_EDIT_SWITCH_DIALOG`（复用 ConfirmDialog，确认按钮 `TID_CONFIRM_DIALOG_CONFIRM`）。原位置占位为
  `TID_V4_EDIT_IN_COMPOSER_HINT + rowId` 与 `TID_V4_QUEUE_ITEM_EDIT_LOCK + queueItemId`（`data-edit-lock-owner=self|other`），
  queue `li` 暴露 `data-edit-locked`，远端锁的解除按钮为 `TID_V4_QUEUE_ITEM_RELEASE_EDIT + queueItemId`。
  `TID_V4_EDIT_INPUT/SUBMIT/CANCEL/ATTACHMENT_REMOVE` 随行内编辑器在实现时删除。

## 动态后缀规则

动态 test id 后缀必须稳定、可关联、不可来自可变展示文案。

| 对象               | 后缀来源                                       | 禁止                      |
| ------------------ | ---------------------------------------------- | ------------------------- |
| session/task       | `sessionId` / `taskId`                         | session title、列表 index |
| message            | `messageId`，没有时用稳定 `turnIndex` fallback | 消息正文、DOM index       |
| queue item         | `queueItemId`                                  | queue 文本、DOM index     |
| compact marker     | 优先 `inputId`，没有时用 compact `operationId` | 时间展示文本              |
| model/thought item | config option value                            | 可翻译 label              |
| toast/error        | stable reason code                             | 可翻译文案                |

如果产品行为需要验证“顺序”，不要把顺序编码进 test id；使用同一 selector 查询列表后读取每个元素的 `data-queue-item-id` 或 `data-message-id` 顺序。

## 会话区必需 Test ID

以下是 MVP case 需要补齐或确认存在的 UI 元素。已有常量可以复用；缺失常量应补到 `packages/shared/src/test-ids.ts`。

### 登录和模型前置

会话区 E2E 不能假设空项目可直接使用。MVP compact case 的前置链路必须按用户路径完成：

1. 在欢迎页点击 `TID_LOGIN_USE_API_KEY_BUTTON`，进入 API Key 登录。
2. 使用 `TID_LOGIN_API_KEY_INPUT` 填入测试 API Key，点击 `TID_LOGIN_API_KEY_CONTINUE_BUTTON`。
3. 进入工作区后，在模型供应商设置中配置 DeepSeek API Key。
4. 回到会话区后切换到 `deepseek-v4-flash`。

这条前置链路本身也属于产品协议：测试不得通过直接写入登录态来绕过欢迎页，除非该 case 的目标明确是非 UI 层服务验证。

| 建议常量                             | 元素                         | 必需属性                   |
| ------------------------------------ | ---------------------------- | -------------------------- |
| `TID_LOGIN_USE_API_KEY_BUTTON`       | 欢迎页 API Key 登录入口      | `disabled`                 |
| `TID_LOGIN_API_KEY_PROVIDER_TRIGGER` | API Key 登录 provider 选择器 | 当前 provider value        |
| `TID_LOGIN_API_KEY_PROVIDER_ITEM`    | API Key 登录 provider 选项   | 动态后缀为 provider choice |
| `TID_LOGIN_API_KEY_INPUT`            | API Key 输入框               | value                      |
| `TID_LOGIN_API_KEY_CONTINUE_BUTTON`  | API Key 登录继续按钮         | `disabled`                 |
| `TID_LOGIN_API_KEY_CANCEL_BUTTON`    | API Key 登录取消按钮         | `disabled`                 |
| `TID_LOGIN_API_KEY_SKIP_BUTTON`      | API Key 登录暂时跳过按钮     | `disabled`                 |
| `TID_LOGIN_API_KEY_ERROR`            | API Key 登录错误提示         | normalized text            |

模型供应商设置里的 `TID_MODEL_PROVIDER_NAV_ITEM` 必须暴露 `aria-selected` 和 `data-state`。E2E 选择 DeepSeek、GLM 等 provider 时只能读取 `aria-selected="true"` 或 `data-state="selected"`，不能通过 `border-*` / `bg-*` 等 CSS class 判断选中态。

聊天工具栏模型选择器是二级结构时，provider 分组必须暴露 `TID_CHAT_MODEL_SELECT_GROUP`，动态后缀为 provider group key（例如 `provider:e2e-deepseek`）。E2E 需要先打开 provider 分组，再选择 `TID_CHAT_MODEL_SELECT_ITEM`；不能把“一级菜单里暂时没有模型 item”误判为模型不可用。

### 根容器和状态

| 建议常量               | 元素            | 必需属性                                                                                                                                                                                   |
| ---------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TID_CHAT_VIEW`        | 会话详情根容器  | `data-session-id`、`data-state`、`data-queue-count`、`data-target-id`、`data-target-objective`、`data-target-status`、`data-runtime-status`、`data-active-input-id`、`data-stop-requested` |
| `TID_CHAT_MESSAGES`    | 消息列表        | `data-session-id`                                                                                                                                                                          |
| `TID_CHAT_INPUT`       | composer 输入框 | value                                                                                                                                                                                      |
| `TID_CHAT_SEND_BUTTON` | 发送按钮        | `disabled`                                                                                                                                                                                 |
| `TID_CHAT_STOP_BUTTON` | stop 按钮       | `disabled`                                                                                                                                                                                 |
| `TID_CHAT_LOADING`     | 正在生成指示器  | `data-session-id`                                                                                                                                                                          |

### 消息和轮次

| 建议常量                                      | 元素                                     | 动态后缀                    | 必需属性                                                                       |
| --------------------------------------------- | ---------------------------------------- | --------------------------- | ------------------------------------------------------------------------------ |
| `TID_CHAT_TURN`                               | turn group 容器                          | `turnIndex`                 | `data-turn-index`、`data-session-id`                                           |
| `TID_CHAT_MESSAGE`                            | 单条消息容器                             | `messageId`                 | `data-message-id`、`data-role`、`data-turn-index`                              |
| `TID_CHAT_USER_MESSAGE`                       | user message 容器                        | `messageId`                 | `data-message-id`                                                              |
| `TID_CHAT_ASSISTANT_MESSAGE`                  | assistant message 容器                   | `messageId`                 | `data-message-id`                                                              |
| `TID_CHAT_ASSISTANT_HISTORY_TRIGGER`          | assistant message 历史折叠触发器         | `historyStateKey`           | `data-history-state-key`、`data-history-open`、`data-history-has-content`      |
| `TID_CHAT_ASSISTANT_HISTORY_CONTENT`          | assistant message 历史折叠内容区         | `historyStateKey`           | `data-history-state-key`、`data-history-open`                                  |
| `TID_CHAT_TOOL_MESSAGE`                       | tool message 容器                        | `messageId` 或 `toolCallId` | `data-tool-call-id`                                                            |
| `TID_CHAT_TOOL_CALL_BLOCK`                    | assistant message 内部的 tool call block | `toolCallId`                | `data-tool-call-id`、`data-tool-name`、`data-status`                           |
| `TID_CHAT_TIMELINE_MARKER` / `TID_V4_ROW`     | timeline marker                          | marker id / rowId           | `data-row-kind`、`data-marker-type`、`data-status`；compact 另有 `data-origin` |
| `TID_CHAT_COMPACT_MARKER`                     | compact marker                           | `inputId` 或 `operationId`  | `data-trigger`、`data-status`、`data-operation-id`、`data-input-id`            |
| `TID_CHAT_CHANGE_SUMMARY_TOGGLE_FILES_BUTTON` | assistant 变更摘要的撤销/重新应用按钮    | `messageId`                 | `data-message-id`、按钮文案                                                    |

### Compact Marker 最小闭环

手动 `/compact` 成功是会话区第一条后验 E2E case。自动化判定必须同时满足：

- UI 层先出现 `TID_CHAT_COMPACT_MARKER`，`data-status="started"`，`data-trigger="manual"`。
- 同一个 marker identity 后续更新为 `data-status="completed"`。如果 agent lifecycle 事件把 `operationId` 从本地 optimistic id 更新为真实 operation id，`data-input-id` 必须保持不变，测试用 `data-input-id` 关联 started 和 completed。
- marker 文案可以随 i18n 改动，不参与定位；中文当前展示“正在压缩上下文”和“上下文已自动压缩”只作为人工复盘线索。
- 网络层必须捕获一个逻辑 compact attempt：首次物理 provider 请求为 `stream:true`；stream 成功时只有 streaming 腿，eligible stream failure 时允许同一逻辑 attempt 追加 non-stream fallback 腿。每条 compact provider 请求都必须包含主 session 内容和 `CRITICAL: Respond with TEXT ONLY` compaction 指令。
- `session/compact` 的 ACK 不能当作成功依据；成功依据是后续 `context_compaction` timeline event / snapshot 中的 `status="completed"`。

### 队列

| 建议常量                            | 元素               | 动态后缀      | 必需属性                                        |
| ----------------------------------- | ------------------ | ------------- | ----------------------------------------------- |
| `TID_CHAT_QUEUE_PANEL`              | 队列面板           | 无            | `data-session-id`、`data-auto-drain`            |
| `TID_CHAT_QUEUE_ITEM`               | 队列项             | `queueItemId` | `data-queue-item-id`、`data-kind`、`data-index` |
| `TID_CHAT_QUEUE_ITEM_CONTENT`       | 队列项内容         | `queueItemId` | normalized text                                 |
| `TID_CHAT_QUEUE_SEND_NOW_BUTTON`    | 立即发送按钮       | `queueItemId` | `disabled`                                      |
| `TID_CHAT_QUEUE_EDIT_BUTTON`        | 编辑队列项按钮     | `queueItemId` | `disabled`                                      |
| `TID_CHAT_QUEUE_EDIT_INPUT`         | 队列项编辑输入框   | `queueItemId` | value                                           |
| `TID_CHAT_QUEUE_EDIT_SAVE_BUTTON`   | 保存队列项编辑按钮 | `queueItemId` | `disabled`                                      |
| `TID_CHAT_QUEUE_EDIT_CANCEL_BUTTON` | 取消队列项编辑按钮 | `queueItemId` | `disabled`                                      |
| `TID_CHAT_QUEUE_REMOVE_BUTTON`      | 删除队列项按钮     | `queueItemId` | `disabled`                                      |
| `TID_CHAT_QUEUE_DRAG_HANDLE`        | 重排拖拽手柄       | `queueItemId` | `aria-disabled`                                 |

### 消息操作

| 建议常量                       | 元素                   | 动态后缀        | 必需属性                                           |
| ------------------------------ | ---------------------- | --------------- | -------------------------------------------------- |
| `TID_CHAT_MESSAGE_FORK_BUTTON` | fork assistant 按钮    | `messageId`     | `disabled` / `aria-disabled`                       |
| `TID_CHAT_MESSAGE_EDIT_BUTTON` | edit user query 按钮   | `messageId`     | `disabled` / `aria-disabled`                       |
| `TID_CHAT_MESSAGE_EDIT_INPUT`  | edit 输入框            | `messageId`     | value                                              |
| `TID_CHAT_MESSAGE_EDIT_SUBMIT` | edit 提交按钮          | `messageId`     | `disabled`                                         |
| `TID_CHAT_MESSAGE_EDIT_CANCEL` | edit 取消按钮          | `messageId`     | `disabled`                                         |
| `TID_V4_HOOK_DETAILS_TRIGGER`  | 轮尾 Hook 详情按钮     | `productTurnId` | `aria-label`、`aria-expanded`                      |
| `TID_V4_HOOK_DETAILS_CONTENT`  | 本轮 Hook 详情 Popover | `productTurnId` | event/tool、来源与状态文本；不得包含命令或绝对路径 |

Tool call 当前不是独立消息，而是 assistant message 内部的结构化块。验证“tool 不可 edit / fork”时，必须定位 `TID_CHAT_TOOL_CALL_BLOCK` 并断言该 block 内没有 `TID_CHAT_MESSAGE_EDIT_BUTTON` 或 `TID_CHAT_MESSAGE_FORK_BUTTON` 后代。assistant message 自身仍可按 assistant 规则显示 fork，不等价于 tool block 可 fork。

当前失败探针：`conversation-session-tool-actions.test.ts` 已证明持久化层存在 tool part，但会话页 DOM 没有渲染 `TID_CHAT_TOOL_CALL_BLOCK`。因此该契约是后续修复 UI 投影时的验收目标，不能算已满足。

### 命令反馈

默认情况下，正向 conversation E2E 必须断言不存在 `TID_CHAT_ERROR_BANNER`。如果某个 case 预期就是错误恢复、provider/network fault、权限失败或其他 negative path，必须在 case 文档里显式写明允许出现错误横幅，并断言错误横幅的原因和恢复状态。不能把“出现错误横幅但最终还能继续”视为正向 case 通过。

| 建议常量                | 元素                                                 | 动态后缀                                                     | 必需属性                                                              |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------- |
| `TID_CHAT_TOAST`        | toast 容器                                           | reason code                                                  | `data-reason`、`data-severity`                                        |
| `TID_CHAT_ERROR_BANNER` | `ChatViewErrorBanner` / `ChatErrorBanner` 错误条容器 | 无；若需要区分错误原因，用 `data-reason` / `data-error-code` | `data-reason`、`data-error-code`、`data-trace-id`、`data-dismissible` |
| `TID_CHAT_GOAL_STATE`   | goal 状态投影                                        | session id                                                   | `data-goal-status`、`data-target-id`                                  |

### Session 切换和配置

| 建议常量                                | 元素                            | 动态后缀               | 必需属性                                                  |
| --------------------------------------- | ------------------------------- | ---------------------- | --------------------------------------------------------- |
| `TID_TASK_ITEM`                         | session/task 列表项             | `sessionId` / `taskId` | `data-session-id`、`data-active`、`data-state`            |
| `TID_CHAT_MODEL_SELECT_TRIGGER`         | 当前 session 模型选择器         | 无                     | `data-session-id`、`data-model-value`                     |
| `TID_CHAT_MODEL_SELECT_GROUP`           | 当前 session 模型 provider 分组 | provider group key     | `data-model-provider-key`、`data-model-provider-selected` |
| `TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER` | 当前 session 思考深度选择器     | 无                     | `data-session-id`、`data-thought-level`                   |

### 项目侧栏（2026-09 虚拟项目重构后）

旧 workspace 侧栏节点（`workspace-item` / `workspace-list` / `workspace-close` /
`workspace-file-tree-button` / `conversation-new-task`）已随 Group 视图与目录节点一起下线，
对应常量已从 `test-ids.ts` 删除。E2E 通过项目 `<section>` 的 `data-project-id` /
`data-project-name` 定位项目（老 workspace 首次迁移成同名单 root 项目，项目名 = 目录 basename），
helper 见 `packages/desktop/test/e2e/helpers/project-sidebar.ts`。

| 常量                                                       | 值                                                      | 用途                                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `TID_PROJECT_SECTION` / `TID_CONVERSATION_SECTION`         | `project-section` / `conversation-section`              | 项目区 / 任务区分区容器（`data-slot="collapsible-trigger"` 带 aria-expanded）                                     |
| `TID_VIRTUAL_PROJECT_ADD`                                  | `virtual-project-add`                                   | 项目区新建项目按钮                                                                                                |
| `TID_VIRTUAL_PROJECT_NEW_TASK`                             | `virtual-project-new-task`                              | 任务区全局新建任务按钮                                                                                            |
| `TID_VIRTUAL_PROJECT_ROW`                                  | `virtual-project-row`                                   | 项目行（父级 section 带 `data-project-id` / `data-project-name`）                                                 |
| `TID_VIRTUAL_PROJECT_TOGGLE`                               | `virtual-project-toggle`                                | 项目行展开触发器，`aria-expanded` 表示任务列表是否展开                                                            |
| `TID_VIRTUAL_PROJECT_UNREAD`                               | `virtual-project-unread`                                | 折叠态未读指示                                                                                                    |
| `TID_VIRTUAL_PROJECT_TASKS`                                | `virtual-project-tasks`                                 | 项目行任务列表容器，内部任务行仍是 `TID_TASK_ITEM`                                                                |
| `TID_VIRTUAL_PROJECT_ACTIONS` / `TID_VIRTUAL_PROJECT_MENU` | `virtual-project-actions` / `virtual-project-menu`      | hover 操作区与更多菜单触发器（Radix trigger，需 pointerdown 手势）                                                |
| `TID_VIRTUAL_PROJECT_FILES`                                | `virtual-project-files`                                 | 打开主要目录文件树（多 root 时为下拉触发器）                                                                      |
| `TID_VIRTUAL_PROJECT_CREATE_TASK`                          | `virtual-project-create-task`                           | 项目行新建任务（cwd = 主要目录）                                                                                  |
| `virtualProjectActionTestId(id, context)`                  | `virtual-project-<id>` / `virtual-project-context-<id>` | 更多菜单 / 右键动作项：`edit`、`pin`、`delete`、`remove-entry`、`device-settings`、`create-task`、`files-<index>` |
| `TID_PROJECT_PINNED_TASKS`                                 | `project-pinned-tasks`                                  | 全局置顶任务区                                                                                                    |
| `TID_REMOTE_PROJECT_HOST`                                  | `remote-project-host`                                   | 远端 host 分组，`data-host-id` 为 host id；连接按钮图标 `lucide-plug`                                             |

注意：`packages/ui/src/project-sidebar/*` 目前仍硬编码这些字符串，常量与实现同值；组件改用常量属于 src 侧收尾项。

## WDIO Page Object 要求

会话区测试不要直接在 spec 里拼 CSS。新增一个 conversation/session page object，集中封装定位和断言。

示例接口：

```ts
chat.sessionRoot(sessionId);
chat.queuePanel(sessionId);
chat.queueItems(sessionId);
chat.queueItem(queueItemId);
chat.queueSendNowButton(queueItemId);
chat.message(messageId);
chat.messageForkButton(messageId);
chat.messageEditButton(messageId);
chat.compactMarker(inputId);
chat.expectQueueOrder([queueItemIdA, queueItemIdB]);
chat.expectNoProtocolFrame({ method: "session/compact", inputId });
```

## 对验证矩阵的修正

验证矩阵里的 UI 层必须改成“使用 test id 和 DOM 属性断言”。截图、录像只保留在 Artifact 层，不能作为自动化通过条件。

正确表达：

```text
UI:
  - [data-testid=chat-queue-panel] 存在
  - data-auto-drain=false
  - queue item 数量为 1
  - stop button disabled=true

Artifact:
  - 保存 final.png，供失败后人工复盘
```

错误表达：

```text
UI:
  - 截图看起来 queue 还在
```
