# 会话输入来源（ConversationInputSource）

用户消息可以带一个结构化来源 `source`。界面用它显示「来自插件 X」「来自会话 …」。
缺省表示用户亲自输入。来源是可信调用方写入的事实，CLI 不从正文推断，也不让模型设置。

本文是 CLI 对来源的完整契约。协议形状在
`packages/shared/src/zcode-protocol-v4/input-intent.ts`（`conversationInputSourceSchema`），
CLI 内部形状在 `packages/contracts/src/interfaces/session.port.ts`（`TurnInputSourceMetadata`），
两处必须一致。

## 1. 来源种类

| kind        | 字段                                        | 由谁设置                                                                                                           |
| ----------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pluginUi`  | `pluginId`、`toolCallId`                    | 插件 UI 经 `ui/message` 代用户发送                                                                                 |
| `genUi`     | `path`、`title?`                            | 交互视图代用户发送                                                                                                 |
| `session`   | `sessionId`、`title?`（`title` 只读旧数据） | App Host：模型跨会话发送时由 app-control 注入调用方会话                                                            |
| `extension` | `pluginId`                                  | App Host：扩展网关代插件发送（[扩展宿主 §17.8](../../../../../docs/plugins/extension-host.md#178-可见标识与审计)） |

- 每种都是 strict 对象：多一个字段或缺一个必填字段，整条命令按 `proto.invalidPayload` 拒绝。
- `extension.pluginId` 是非空字符串，与 `pluginUi.pluginId` 同一取值规则。它来自扩展进程自报，只用于展示与归因，不是授权依据（扩展宿主 §7.3）。

## 2. 入口

| 命令                            | 字段     | 说明                                     |
| ------------------------------- | -------- | ---------------------------------------- |
| `sendText`                      | `source` | 全部来源                                 |
| `createSession.firstInput`      | `source` | 全部来源；与 `sendText` 同一条首发写路径 |
| `editUserQuery` / `retryTurn`   | —        | 沿用被编辑或重试的原 intent 的来源       |
| `sendQueuedNow`                 | —        | 沿用原 queue item 的来源                 |
| `createSelectionSideSession` 等 | —        | 不带来源                                 |

## 3. 谁能设置

```text
模型 / 工具 ──► 会话控制工具（cli_* / app_*）──► strict 入参，没有 source 字段
                                               └─ App facade 固定 {kind:"session"}
扩展 ctx.sessions.* ──► Window Host 扩展网关 ──► 注入 {kind:"extension", pluginId}
渲染进程 / 手机 ────► Host ──► sendText（pluginUi / genUi）
                         │
                         ▼  V4 command（stdio，对端只有 Host）
                       CLI：只从命令 payload 读取 source，原样写入 canonical intent
```

- 只有 V4 command 通道上的 App Host 能设置来源。CLI 的 stdio 对端只有 Host，CLI 不再区分 Host 内部的调用方。
- 模型和工具不能设置来源：
  - 会话控制工具的模型入参是 strict schema，没有 `source` 字段，多带即拒绝；
  - CLI 运行时、工具执行和模型输出都不构造来源；
  - CLI 不从正文推断来源。
- App 侧要求（扩展宿主 P3c App 步骤负责）：`extension` 只能由扩展网关注入。Host 必须拒绝渲染进程和手机发来的带 `extension` 来源的 `sendText` / `createSession`。这一条 CLI 无法替 Host 校验。

## 4. 持久化

来源随 canonical input intent 一起写入，不改表结构，不需要 migration：

- 开始执行的输入：用户消息 `metadata.conversationInputIntent.source`（完整事实，读取时按 schema 校验）与 `metadata.inputIntent.source`（旧种子）。两者都在 CLI 会话库 `message` 表的 `data` 列（JSON 文本）里。
- 排队的输入：session input 账本 `payload.conversationInputIntent.source`，在 `session_input` 表的 `payload` 列（JSON 文本）里。队列本身不跨进程保留（重启时丢弃并留痕）。
- 冷恢复从 `conversationInputIntent` 读回来源。
- **批准（用户，2026-11-05）**：`extension` 来源会作为新取值写进上面两列的 JSON。表结构不变，用户已批准。之后凡是数据库改动（表结构、migration、往已有库里写新种类的数据），都要先经用户手动批准。

## 5. 投影

- `userInput` 行带 `source`；`queue.items[]` 带 `source`。
- live 与冷恢复产出同一份来源。桌面与手机读同一份行。
- 界面文案（「来自插件 X」）属于 App，不在 CLI。

## 6. 幂等

app-control 命令（commandId 前缀 `app-control-`，模型跨会话工具与扩展写入共用这个 facade）的
请求身份包含来源（`command-inbox.ts` 的 `requestIdentity`）：

- 同一 `commandId` 重试，来源相同：`duplicate`，只产生一条消息。
- 同一 `commandId`，`pluginId` 不同：`proto.commandConflict`。
- `session` 来源的展示标题不参与身份（既有规则）。

## 7. 能力位

`runtime/capabilities` 返回 `extensionInputSource: true`。

App 发送带 `extension` 来源的命令之前，必须先确认能力位（`ZCodeAgent.supportsExtensionInputSource`）。没有能力位时，app-control 报 `unavailable`：不发送，也不去掉来源后发送。原因是旧 CLI 对两个入口的行为不同：

| 入口                              | 旧 CLI 的行为                                                                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `sendText.source`                 | `discriminatedUnion` 不认识 `extension`，整条命令 `proto.invalidPayload`。失败可见，但原因不清楚。                                     |
| `createSession.firstInput.source` | `firstInput` 是非 strict 的 `z.object`，`parseCommandEnvelope` 静默剥掉 `source`。会话和首条消息照常创建，消息没有来源。这是静默降级。 |

## 8. 兼容：旧 App 读到新来源

```text
写入：新 App ──(能力位)──► 新 CLI ──► 持久化 intent.source = extension
                                         │
回退：装回旧 App ──► 旧 CLI 冷恢复 ──────┘
        旧 CLI：conversationInputIntentSchema 不认识 extension → 完整事实整体失败
              → 退回 metadata.inputIntent 种子（不校验）→ source 原样进入 userInput 行
        旧 App：
          有逐行降级（2026-11-04 起，04-sync 规则 13）→ 这一行变成 unreadable 占位行，其他行正常
          没有逐行降级 → 整个 snapshot 被拒 → fault.subscription.contentRejected，会话打不开
```

- 默认没有运行中的版本偏斜：本地 CLI 随 App 打包；远端 Source Server 默认只承诺同版本（`minCompatibleVersion` 缺省等于产品版本，见 [R3 远程架构](../../../../../docs/architecture/r3-source-server-remote-architecture.md)）；手机页面按 `app_version` 分目录发布（[Remote v4 静态部署](../../../../../docs/web-remote-control/remote-v4-static-deployment.md)）。
- 逐行降级见 [04-sync 规则 13](../../../../../docs/v4-refactor/04-sync-and-recovery.md)。
- 偏斜只在回退时出现：用户装回旧 App，旧 App 自带的旧 CLI 读新 CLI 写的历史。
- 各位置的结果：

| 位置                          | 旧 App（有逐行降级）                                   | 更旧的 App（没有逐行降级）     |
| ----------------------------- | ------------------------------------------------------ | ------------------------------ |
| snapshot `rows.window` 中的行 | 这一行变成占位行，正文不显示                           | 整个 snapshot 被拒，会话打不开 |
| delta 中的行                  | 这一帧被拒，强制 snapshot 后同上                       | 同左后整体失败                 |
| `rows/range` 历史回补         | 这一行变成占位行                                       | 整页被拒                       |
| `queue.items[]`（A 区，严格） | 整个 snapshot 被拒；回退后不会出现（队列不跨进程保留） | 同左                           |

- 现有的协商模式不适用：`hostCapabilities`（CLI 按 Host 声明决定发布什么）只能约束新 CLI；回退时读数据的是旧 CLI，新 CLI 不在场。所以不新增协商机制。
- **决策（用户，2026-11-05）：不处理回退。** 已知后果：装回旧版 App 后，带插件来源的消息在有逐行降级的 App 里显示为占位行；更早的 App 打不开这些会话。理由：只有回退时才出现，运行中没有版本偏斜。
- 考虑过、未采用的缓解：新 CLI 只把 `extension` 来源写进经校验的 `conversationInputIntent`，不写进旧种子 `inputIntent`，旧 CLI 退回种子时消息正常显示、只是不标来源。代价是持久化格式出现一处不对称。以后要支持回退时再评估。

## 9. 测试

- `packages/bootstrap/tests/v4-extension-input-source.test.ts`：能力位；`createSession.firstInput.source` 与 `sendText.source` 落库、进入排队项与 `userInput` 行；冷恢复保持来源；非法来源被拒绝；用基线 schema 复现旧 App 与旧 CLI 的读取结果。
- `packages/bootstrap/tests/command-inbox.test.ts`：同一请求重试与 `pluginId` 冲突。
- `packages/core/tests/session-control/tools.test.ts`：会话控制工具不向模型暴露 `source`，带 `source` 的调用被拒绝。
