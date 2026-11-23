# ZCode 交互行为

## 背景

当 ZCode 当前轮仍在运行时，用户继续发送内容有两种产品语义：

- 队列：把后续输入作为待发送消息，等上一轮结束后自动发送。
- 引导：交给 ZCode CLI 的 turn steering，在下一次合法 model-step 边界注入当前轮。

`AppSettings.zcodeInteractionBehavior` 控制这个偏好，默认值是 `queue`。Composer
不再暴露会话级“追加模式”切换；会话投影里的 `config.followupMode` 只是 CLI/runtime
对这份 app 偏好的当前同步结果。用户在设置页切换后，已打开的 v4 session 通过
`setFollowupMode` 命令同步到 CLI；新建或预热 session 通过 `createSession.config.followupMode`
继承当前 app 偏好。

## 行为

`queue` 是默认行为。桌面和手机已提交的 busy/running 输入都由 CLI/runtime 的
`CommandInbox` 串行 admission；renderer、host、relay 和 desktop main 都不维护第二份权威
conversation queue。桌面通过 `desktop-continuous` 直接接收事实，手机 Web 远控通过
`web-remote-replayable` snapshot/gap 恢复同一组 CLI 事实，两种 delivery profile 不改变消费规则。

队列消费的边界是 session ready，而不是任意单个 timeline 横条完成。`context_compaction`
的 `started` / `retrying` 和 `goal_verification` 的 `started` 都表示当前 session 仍有
维护或裁判活动在运行，普通 queue 不能在这些状态下自动 drain。手动 `/compact`
完成后如果 session 已 ready，可以继续消费队列；auto/pre-request compact 的 `completed`
只表示前置压缩完成，后续原 prompt 仍可能继续运行，不能被当成队列 ready 边界。

Goal mode 下还需要额外满足“整个 goal 已达标”：`goal_verification completed` 只是一次
verifier attempt 的终态。verifier 明确返回 `passed: false` 时会继续进入下一轮
goal continuation；verifier 自身格式错误、请求异常或错误调用工具时采用 fail-open，
写入 `passed: true`，避免裁判链路偶发失败把已经交付的目标卡住。`passed: true`
之后也必须等 session target 被更新为 `status: "complete"` 才能消费普通 queue。
只要 task meta / projection 里仍有非 `complete` 的 target，队列消息就继续等待；target 为空
表示当前没有 goal，不受该 guard 限制。用户在未达标 goal 期间继续输入时，也应先进入
普通 queue，而不是绕过 goal loop 立即发送。这个 guard 同时覆盖 `sendText`、queued `/goal`
和 queued `/compact`，并保持原 admission FIFO。手动停止 verifier 不属于 fail-open：它会把
verification 收口为 cancelled/failed、target 置为 paused，并使 queue 保留且默认不自动消费。

普通 queue 的自动消费顺序固定为：

```text
queue head
  -> autoDrain=true ?
  -> session ready ?
  -> target absent OR target.status=complete ?
       no  -> keep the whole FIFO unchanged
       yes -> promote exactly one head item by its original kind
```

队列项“立即发送”是用户显式抢占路径，继续沿用 reservation + Stop barrier，不属于上述自动
消费 guard。

`guide` 是模型/provider 无关的 runtime 能力：它不改写已经发给 provider 的 in-flight 请求，只在
task 正在 streaming、没有附件且没有 stop 请求时尝试 turn steering。已有普通 queue 表达未来
product turn 的用户意图，不阻塞显式 guide 进入当前 active turn；两类输入按 delivery 分轨，普通
queue 的相对顺序保持不变。
guide 可以在 tool call 出现前提交并等待；只有当前 model step 的全部
sibling tool results 已提交后，runtime 才按 admission FIFO 一次消费全部已等待的 guide，并在同一
product turn 的下一次 provider 请求中使用它们。不能在单个 parallel tool 提前完成时消费；同一边界取出
多条时，最后一条带意图的 guide 决定 Selection、权限模式与 Plan 意图。

guide 在等待合法 model-step 边界期间仍由 CLI `pendingInputs` / `TurnSteerQueued` 持久承载，
但 renderer 不把 `admittedDelivery=guide` 展示成普通 future queue。它应立即在当前对话流末尾
显示用户消息，并在气泡下方显示“等待引导当前任务…”。收到 `TurnSteerDrained(delivery=guide)`
后，正式 `UserInputRow(guided=true)` 以同一 `sourceCommandId` 接管展示，等待提示消失；若 runtime
把该输入降级为 `admittedDelivery=queue`，临时对话流消息消失，同一权威项回到普通队列面板。
renderer 只做 projection 分流，不维护第二份 accepted-input queue。

待引导消息的气泡、等待提示和操作按钮必须与底部输入框共用内容列及每侧 8px 的水平留白（与输入框 dock 的 `px-2` 一致），
桌面和手机 Web 均保持右边缘对齐。该临时列表直接渲染消息行，不经过普通轮容器，
因此列表自身承担水平留白，不能直接贴到内容列边缘。

```text
TurnSteerQueued(admitted=guide)
  -> CLI queue fact 保留
  -> renderer pending guide（对话流 + 等待提示）
  -> TurnSteerDrained(guide) -> 正式 guided user row
  -> delivery fallback(queue) -> 普通 queue panel
```

桌面端任务运行中，`Cmd+Enter` 或按住 `Cmd` 点击发送按钮（macOS），以及
`Ctrl+Enter` 或按住 `Ctrl` 点击发送按钮（Windows/Linux），
只对当前这一条消息执行与 session `followupMode` 相反的投递语义：

| `followupMode` | `Enter`       | `Cmd/Ctrl+Enter`                                                                      |
| -------------- | ------------- | ------------------------------------------------------------------------------------- |
| `queue`        | 普通队列      | 立即发送：原子 `sendText(requestedDelivery=startNow)` 抢占当前 turn，不创建 QueueItem |
| `guide`        | 引导当前 turn | 普通队列                                                                              |

组合键或修饰键点击只覆盖本次输入，不调用
`setFollowupMode`，不改写持久设置。普通 `Enter`、`Shift+Enter` 和普通点击发送按钮继续沿用
当前交互。空闲状态（包括新任务 draft）的 `Cmd/Ctrl+Enter` 与 Enter 一样正常发送；
`Cmd/Ctrl+Shift+Enter` 保留换行。组合键能力只在手机 Web 远控的移动输入视口禁用；
桌面 Electron 即使窗口窄于 768px，或 Windows 设备报告 `hover: none` / `pointer: coarse`，
仍必须保留平台主修饰键提交，不能用通用媒体查询代替 desktop / Web remote 产品边界。

当桌面端 running composer 已有可发送内容且发送按钮可用时，按下平台主修饰键应自动打开
发送按钮 Tooltip，无需 hover。标题展示本条消息的相反行为：默认 queue 时显示“立即发送”，
默认 guide 时显示“加入队列”；快捷键区域在 macOS 显示 `⌘ + Enter`，在 Windows/Linux 显示
`Ctrl + Enter`。松开主修饰键、窗口失焦、提交开始、输入变为不可发送、切到 idle/移动端或组件
卸载时关闭自动提示。普通 hover Tooltip 继续显示原发送行为，修饰键提示不写入设置或协议。

```text
keydown(Cmd/Ctrl)
  -> running && canSend && desktop ?
  -> open tooltip(opposite action, Cmd/Ctrl + Enter)
keyup / blur / submit / !canSend
  -> close modifier tooltip
```

```text
running composer Cmd/Ctrl+Enter OR Cmd/Ctrl+click send
  -> queue mode: sendText(requestedDelivery=startNow)
  -> guide mode: sendText(requestedDelivery=queue)
  -> CLI CommandInbox 串行 admission
  -> 只改变这一条 input intent
```

queue 模式的 `startNow` 必须在 CLI 内原子取得 foreground promotion lease，执行 Stop barrier，
等待旧 foreground 完全 idle 后直接启动新 turn。该路径不得调用普通 queue admission、不得创建或
短暂投影 QueueItem，也不得依赖 renderer 观察 queue 后再发第二条 promotion command。CLI 接受
`sendText(startNow)` 后发起端立即清空 Composer；若命令在接受前被拒绝，原草稿与附件保持不变。
`sendQueuedNow` 只用于用户显式提升已经存在的 QueueItem，不再承担新输入的立即发送。

```text
guide admitted
  -> wait for next tool result batch
  -> commit every sibling ToolCallResult
  -> drain waiting guides inline (rule: turn-steering.md「Drain 边界」)
  -> persist one guided user fact per guide
  -> start the next provider request in the same product turn
```

如果当前 turn 在没有形成可用 tool result batch 的情况下 text-only complete、stop 或 interrupted，
未消费的 guide 必须把同一 `ConversationInputIntent` 原地改投普通 queue；原文、附件、clientId、
`sourceCommandId`、`queueItemId` 和 admission FIFO 不变。附件/compact/verifier
busy 不满足 eligibility，或 runtime steer reject 时也走同一 fallback，不能静默丢失。

模型/provider 维度按不变量剪枝：所有已接入的模型都复用相同 message history 与下一次普通 provider
request，不能按模型名、provider 名或上游协议格式设置 guide 白名单。

## 边界

该设置只改变 busy 时是否优先尝试 turn steering，不改变 task realtime 传输语义：

- 桌面主链路仍是 `desktop-continuous`。
- 手机远控仍是 `web-remote-replayable`。
- relay 和 desktop main 不拥有 session、stream、queue 或 snapshot 业务状态。
- guide/queue 的 CLI 产品 guard 不因 delivery profile 分叉；replayable 只负责恢复，不拥有业务队列。
