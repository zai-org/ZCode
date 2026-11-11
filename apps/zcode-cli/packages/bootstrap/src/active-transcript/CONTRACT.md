# Active transcript

`projectActiveSessionMessages(messages, session, rewindEvents)` 把持久化消息账本投影为 active 分支。

- 输入为会话全部持久消息、会话行（取 `revert`）与 `RewindTriggered` 事件；纯函数，不读写存储。
- 连续 rewind 优先使用 runtime 当时保存的 `keptMessageIDs`，避免旧分支复活；没有 `createdMessageId` 的不可用 rewind 事件不裁剪消息。
- 内部 `/rewind conversation` 的成功回执不属于对话内容，投影时移除。

`isTranscriptVisibleMessage(message)` 复用产品投影策略，只保留真实用户输入、可见回复与时间线事件；运行时提醒、环境信息、中断标记等隐藏 user 消息不返回。

调用方：ZCode 协议的 `session/messages`、`session/read` 与独立 CLI 的 `ReadSession`。协议读取保留原有完整消息形态，是否再按可见性过滤由调用方决定。
