# ZCode Protocol（当前事实）

ZCode Protocol 是 App、Host Process 与 `zcode-cli` 之间唯一的 Agent 协议。当前聊天主链路使用 V4 conversation topic、权威 projection 与 command inbox；`packages/shared/src/zcode-protocol/index.ts` 中仍保留的旧 session schema 只服务尚未删除的兼容调用，不是新增功能入口。

## 核心约束

- 协议实体统一叫 `session`；产品层历史 `taskId` 在聊天主链路中等同于 `sessionId`。
- CLI 是 conversation 的事实源。消息行、运行阶段、队列、交互请求、模型配置、usage、goal 与控制能力都来自 `ConversationSnapshot`。
- UI 只拥有草稿、滚动、焦点、面板展开等纯本地展示状态，不能在 renderer 中维护第二份权威消息或队列。
- 桌面使用 `desktop-continuous`，手机远控使用 `web-remote-replayable`。两种 profile 共享同一 CLI 投影，但恢复语义不能互相扩散。
- 手机 `/remote` 只 attach 已有 Host/CLI，不创建独立 Agent runtime。

## 传输拓扑

```text
Renderer
  │ MessagePort RPC
  ▼
Host Process
  │ stdio NDJSON
  ▼
zcode-cli app-server
  ├─ command inbox
  ├─ ProductProjection reducer
  └─ conversation topic publisher
```

stdio NDJSON 只按 LF 字节 `0x0a` 分帧；写帧格式固定为 `JSON.stringify(message) + "\n"`。reader 可兼容帧尾 CRLF，但不得 trim 或改写帧内字符串。

## V4 读路径

客户端订阅 `conversation/<sessionId>` topic。subscribe ACK 本身不内嵌 snapshot；服务端随后按该
subscription 的水位、logEpoch 和 delivery profile 投递 initial/recovery snapshot 或连续 delta：

```text
subscribe(topic, baseSeq, baseLogEpoch)
  ├─ base 可续接 ──> delta(fromSeq, toSeq]
  └─ base 失效   ──> snapshot + 后续 delta
```

`ConversationSnapshot` 是完整可恢复视图，包含：

- session 元信息与 phase；
- `rows.window` 消息/工具/marker 行；
- `queue` 与 `inputRouting`；
- pending interactions；
- model、mode、thought、follow-up 配置；
- usage、goal、background work 与 control availability。

客户端只允许按 seq 连续应用 delta。重复或迟到帧静默丢弃，出现 gap 时重新订阅并以 snapshot 收敛。桌面 continuous 不拼接手机 replayable 的运行态恢复消息。

## V4 写路径

所有用户意图通过 `v4/command` 发送。信封包含稳定 `commandId`、`clientId`、`sessionId`、
可选 `baseRevision` / `baseLogEpoch`、命令类型和 payload。CAS 命令要求 `baseRevision`，
row-targeting 命令还要求 `baseLogEpoch`；重试必须复用原 `commandId`。CLI 用 command inbox 做幂等、
epoch、CAS 和 product guard 裁决。

当前命令全集以 `packages/shared/src/zcode-protocol-v4/command.ts` 为唯一类型事实源，主要分组如下：

| 分组          | 命令                                                                                    |
| ------------- | --------------------------------------------------------------------------------------- |
| 会话/输入     | `createSession`、`createSelectionSideSession`、`sendText`、`sendGoalCommand`、`renameSession`、`deleteSession` |
| 生成控制      | `stop`、`compact`、`retryTurn`、`editUserQuery`、`forkAssistant`                        |
| 文件回退      | `applyFileRewind`                                                                       |
| 队列          | `sendQueuedNow`、`lockQueueItemEdit`、`editQueueItem`、`releaseQueueItemEdit`、`reorderQueueItem`、`deleteQueueItem`、`setAutoDrain` |
| 配置          | `switchModelConfig`、`switchCollaborationMode`、`setFollowupMode`                       |
| Goal/后台工作 | `pauseGoal`、`resumeGoal`、`cancelBackgroundWork`                                       |
| 阻塞交互      | `resolveInteraction`、`snoozeInteractionAutoResolution`                                |

`lockQueueItemEdit`、`releaseQueueItemEdit`，`editQueueItem` 的附件/配置/`editorId` 字段，以及 `editUserQuery` 的 `mode`/`planEnabled` 字段属于队列冻结编辑，见 [Composer 编辑态](ui/composer-edit-mode.md)。`editQueueItem` 不要求 `baseRevision`，并发保护由编辑锁承担。

`session/steer`、`session/rewind` 和独立 rewind 命令已经删除。引导输入由 `sendText` + `inputRouting`/follow-up mode 裁决；重试和编辑分别使用 `retryTurn`、`editUserQuery`；workspace 文件撤销使用 `applyFileRewind`，不会隐式截断会话历史。

ACK 状态为 `accepted | rejected | stale | duplicate | noop | failed`。ACK 只表示 command 裁决结果；最终 UI 状态必须以带 `sourceCommandId` 的权威 projection 回流为准。

## sessions-index 与 workspace-config

除了 conversation topic，V4 还提供两个 workspace 级 conflated topic：

- `sessions-index/<workspaceId>`：会话列表活性摘要；pin/archive/group/unread 等组织态仍从
  tasks-index 读取并在客户端 join。
- `workspace-config/<workspaceId>`：模型/模式等 configOptions 与 slash command 目录；它服务草稿和
  toolbar catalog，不覆盖已绑定 session 的 `snapshot.config`。

二者各自拥有 seq/logEpoch/subscription recovery，不能共享 conversation 的水位或把 workspacePath
替代远程 workspaceIdentity。

## 队列语义

CLI runtime command queue 是唯一权威队列。running 时的普通输入和 `/goal` 都在 CLI admission 边界按 `inputRouting` 决定立即执行、enqueue、guide 或要求用户处理 held queue。桌面和手机不各自维护一条 accepted queue。

UI 可以做短暂 optimistic 展示，但删除、编辑、立即发送、排序和 auto-drain 都必须发送对应 V4 command，并等待 snapshot/delta 收敛。

输入在执行前写入 `session_input` lifecycle ledger；它用于 promotion 原子性和跨重启查重，不是重启后
自动恢复执行的持久队列。CLI 重启时未 promotion 的 admitted 输入会明确转成 discarded，客户端只能
提示用户确认重发。

## 进程与工作区隔离

一个 App 可以运行多个 workspace window；每个窗口有独立 Local Host，远程连接另由该窗口作用域内的
Remote Host 承载。所有 Host 都以 `workspaceKey = workspaceIdentity?.trim() || workspacePath`
隔离 workspace，每个 workspaceKey 最多启动一个聊天 CLI 进程：

```text
App
  └─ workspace window
      ├─ Local Host
      │  ├─ workspaceKey A ── zcode-cli A
      │  └─ workspaceKey B ── zcode-cli B
      └─ Remote Host(s)
          └─ remoteSessionId / attachment ── workspaceKey C ── zcode-cli C
```

`workspacePath` 只用于文件系统与命令 cwd；身份、缓存、队列、会话绑定和跨进程关联必须使用 workspaceKey。远程 workspace 必须贯穿传递 `workspaceIdentity` 和 `remoteSessionId`。

## Provider 配置

Host 的 `modelProviderService` 是 provider registry 配置源；CLI 是 session 当前模型和运行态的事实源。
Host 把带 revision 的 registry 同步给对应 workspace CLI。聊天 UI 用 app/workspace config catalog 构造
可选模型，用 conversation snapshot 读取当前配置；endpoint 和 API key 不进入 snapshot，也不随每次输入
重复下发。草稿可读取该 workspace 下的全局上次选择作为 create/预热种子，但它不能覆盖已有 session。

运行中切换配置默认影响下一轮。secret 不进入 snapshot；远程 workspace 也使用同一 provider-registry command，不依赖旧版配置文件。

## 兼容工具调度事件

旧 `session/event` 链路仍接收 CLI 发出的 `tool.updated(kind=scheduled)`。
其可选 `assistantMessageId` 表示所属 assistant 消息，必须通过 App 的严格校验并保留；
不携带该字段的旧事件继续兼容。字段存在时必须是非空字符串，其他未知字段仍拒绝。
完整 `input` 和 `inputOmitted/inputRef=model_stream` 两种调度载荷均遵守此契约。

2026-09-07 的 60 轮飞书长任务暴露了消费侧 schema 遗漏该字段的问题：CLI 正常发送，
Host 却因 `Unrecognized key: assistantMessageId` 丢弃整条 scheduled 事件。
这里只补齐既有兼容字段，不新增聊天能力，也不改变 V4 projection、workspace 隔离、
desktop-continuous 或 web-remote-replayable 的投递与恢复边界。

回归需覆盖两种 deliveryKind、两种 input 形式、缺省字段兼容及非法/未知字段拒绝。

## 修改规则

- 修改协议前先改 `packages/shared/src/zcode-protocol-v4/` 的 schema、纯函数和 spec。
- 协议变更必须同时验证 CLI reducer、Host transport、desktop continuous 与 mobile replayable。
- 禁止在 UI、relay 或 Electron main 中复制 session/task/stream/queue/snapshot 业务状态。
- 旧 `packages/shared/src/zcode-protocol/index.ts` 只能缩减兼容面，不能承接新的聊天能力。
