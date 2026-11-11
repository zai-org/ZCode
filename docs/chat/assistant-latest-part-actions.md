# Assistant Row Actions（当前事实）

Assistant turn 的操作区提供 copy、赞、踩、fork、retry，并在末尾展示该 assistant 消息的
创建时间。操作区只挂在一轮最后一段已完成的 assistant 正文后；一轮有多个 text part 时，
不在中间 part 重复展示。

## 行为

- Copy 复制该轮合并后的 assistant 正文，不只复制最后一个 part。
- 赞 / 踩是互斥反馈。再次点击当前选中项会清空反馈，点击另一项会直接切换。
- 反馈通过 V4 `setAssistantFeedback` 写入 assistant message 的 `info.metadata.assistantFeedback`
  （transcript 是持久权威），再由 `AssistantFeedbackUpdated` 事件推进 live 投影；冷恢复在该消息的
  parts 之后重放同一事件。投影把反馈写到该 entity 的最后一个 assistant 文字行，和 UI 读取的
  latest row 一致。一条消息有多个文字块时（live 与冷恢复都是一块一行），反馈不会落到中间行。
- 反馈不进入 provider-visible history，也不注入后续 Agent prompt。
- Fork 是否可用完全由 CLI 投影的 `row.actions.canFork` 决定；running 中的稳定 assistant
  row 也可被 CLI stable resolver 放行，pane 不自行按 phase 猜测。
- Retry 发送 V4 `retryTurn`，目标是对应 turn/row。
- Fork 发送 V4 `forkAssistant`，成功 ACK 返回 child sessionId，随后由权威
  sessions/projection 收敛。
- 时间来自 CLI 投影的 `AssistantTextRow.createdAt`，表达消息创建时间，不是本轮工作耗时。
  当天只显示时分，昨天显示“昨天 + 时分”，当年更早显示月日和时分，跨年显示年月日和
  时分；无效或非正时间戳不展示，避免出现 1970 年占位时间。

## 时间来源

```text
live ModelStreaming event.timestamp ──┐
cold message.info.time.created ───────┤
                                      v
                           AssistantTextRow.createdAt
                                      |
                            locale/timezone formatter
                                      |
                    completed assistant action toolbar
                         /                         \
          desktop hover/focus          mobile /remote 常显
```

live continuous 直接使用 CLI 事件时间；cold hydration 必须把 transcript assistant message 的
`info.time.created` 传给合成的 `text_start` 事件，不能退化成“会话首条时间 + 合成序号”。事件
全序仍由 `sequenceNumber` 裁决，时间戳只负责展示。desktop continuous 与 mobile replayable
最终都消费同一 `row.createdAt` 事实，各自在本地 locale/timezone 下格式化。

## 反馈状态链路

```text
desktop / mobile assistant action toolbar（本地先显示选中态）
                    |
                    v
        V4 setAssistantFeedback(messageId, entityId, feedback)
                    |
                    v
CLI 写 assistant message info.metadata.assistantFeedback（持久权威）
                    |
                    v
AssistantFeedbackUpdated ──► 投影：该 entity 的最后一个 assistant 文字行 row.feedback
                    ▲
cold hydration：在该消息的 parts 之后重放同一事件
```

desktop continuous 与 mobile replayable 都消费同一个 `row.feedback`。

## 展示与可访问性

- UI 复用 `MessageAction` 的紧凑 ghost/icon 样式和语义色 token；选中态保留清晰背景反馈。
- 使用 `aria-pressed`、本地化 label 和可见 focus 状态。
- 桌面端随 assistant turn hover/focus 显示；手机 `/remote` 没有 hover，动作区直接可见且
  不用 Tooltip 包裹按钮，避免触屏首次 tap 被 hover/portal 吞掉。
- 时间跟随动作区一起显隐，排列在所有可用动作之后；它是只读元数据，不增加可点击区域。
- 点按选中动画尊重 `prefers-reduced-motion`。

实现入口：`ConversationRowView.tsx` 和共享 test id。
