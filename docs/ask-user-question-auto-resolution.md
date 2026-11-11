# AskUserQuestion 五分钟自动继续

## 目标

普通 `AskUserQuestion` 默认不应无限阻塞运行中的 task。每个到达交互队首的普通问答获得一个由 CLI/runtime 管理的五分钟窗口；用户未回答时，runtime 以空答案成功收口，让模型使用最佳判断继续。侧栏只投影该权威状态，不自行决定超时。

普通权限请求和 `ExitPlanMode` 计划审批不参与自动结束。

用户可以在设置页关闭“提问自动继续”。配置默认开启以保持升级兼容；关闭后，当前所有普通
`AskUserQuestion` 和关闭期间注册的问答都永久等待用户回答。重新开启只影响开启后新注册的问题，
不得恢复旧问题的 deadline。

## 产品时序

```text
0:00                    1:00                              5:00
 │──── 静默等待 60s ────│──── 可见进度胶囊 240s ─────────│
 │   静态满底标签        │   填充右边界持续向左收缩         │
 │                      │                                  └─ answers: {}，继续
 └────── 用户首次有效操作：永久暂停本次自动结束 ──────────────┘
```

- `0..60s`：侧栏显示静态满底“等待确认”，不表达剩余时间。
- `60..300s`：胶囊尺寸与文字位置保持不变；蓝色强调填充从 100% 线性缩到 0%，左边界固定、右边界向左退。
- `240..300s`：问答面板右上角额外显示离散秒数 `59秒..1秒`（英文 `59s..1s`）；不显示 `60` 或 `0`，点击秒数只暂停计时。
- `>=300s`：runtime 提交 `{ answers: {} }`；工具结果明确告诉模型用户未回答，应使用最佳判断继续。
- 用户在任一阶段产生首次有效操作后，状态永久变为 `snoozed`，胶囊恢复静态满底。本次交互不再自动结束。

## 用户设置

- AppSettings 字段为 `askUserQuestionAutoResolutionEnabled`，默认 `true`；旧设置文件缺少该字段时按开启解析，不做迁移。
- 设置页“交互”分组使用“提问自动继续”开关。关闭动作先持久化 AppSettings，再通知所有窗口把偏好推到各自连接的 local/remote host。
- 关闭必须立即作用于已经运行的主 Agent、后台任务、Bot 和 subagent；不能等待下一次 session 创建或只隐藏 UI 动画。
- 关闭时，已有 `hiddenGrace` / `visibleCountdown` 转为持久化 `snoozed`；尚未成为队首的旧问答记录为不可计时，之后即使重新开启也不获得 deadline。
- 重新开启仅改变新注册问答的资格；用户已经手动暂停、被设置暂停或在关闭期间注册的问答都保持永久等待。
- 快速连续切换按 host 向 CLI 提交的实际顺序串行应用，不允许旧请求晚到后覆盖新值。

## 状态模型

`PendingInteraction.autoResolution` 是可选状态；没有该字段表示不计时。

```text
                      visibleAt
registered ──> hiddenGrace ─────────> visibleCountdown
                    │                         │
                    │ meaningful input /      │ meaningful input /
                    │ setting disabled        │ setting disabled
                    └──────────────┬──────────┘
                                   v
                                snoozed

visibleCountdown ── deadlineAt ──> resolved(answers: {})
任意 pending ── normal answer / stop / turn close ──> resolved / removed
setting disabled ──> 当前与关闭期间注册的 Ask 永久无计时资格
setting re-enabled ──> 仅之后新注册的 Ask 可进入 hiddenGrace
```

- `hiddenGrace`：`startedAt`、`visibleAt`、`deadlineAt`。
- `visibleCountdown`：沿用相同三个绝对时间；阶段变化是可恢复事件，而不是 UI 本地推断出的业务状态。
- `snoozed`：`startedAt`、`snoozedAt`；不再包含 deadline。
- 生产常量固定为 `visibleAt = startedAt + 60_000`、`deadlineAt = startedAt + 300_000`。测试通过注入 clock/scheduler 缩短等待，不能改变产品值。
- Registry 为每个问答在注册时记录计时资格。全局设置关闭会撤销所有当前问答的资格；重新开启不得回填已有 registration。

只有队首普通 `AskUserQuestion` 获得 `startedAt`。后续 pending interaction 在前项出队后才开始自己的完整五分钟，避免排队时间消耗其回答窗口。

## 权威链路与恢复边界

```text
Settings Switch ──> AppSettings ──> cross-window broadcast
                                           │
                                           v
                                  each connected host service
                                           │ strict workspace protocol
                                           v
AskUserQuestion tool ───────────> CLI interaction coordinator
        │ requestUserInput                  │ timer / setting gate / snooze / resolve
        │                                   ├──────────────> tool result
        │                                   │
        │                                   └─ durable autoResolution event
        │                                                   │
        │                                                   v
        └──────────────────────────────────────────> product projection
                                                            │
                                                            ├─ task snapshot
                                                            └─ sessions-index summary
                                                                     │
                                                                     v
                         desktop-continuous live / web-remote-replayable snapshot+gap
                                                                     │
                                                                     v
                                              UI pending dialog + sidebar badge
```

- deadline、用户回答、暂停命令按 CLI 命令队列中的实际处理顺序先到先得。
- 设置关闭与 deadline 竞态也按 CLI 实际处理顺序先到先得：关闭先应用则保留 pending 并持久化
  `snoozed`；deadline 已先收口时，迟到设置同步不得产生第二份 tool result。
- 正常回答、stop、turn 终止和交互移除必须清理 timer。
- CLI/UI 重连或进程恢复后使用持久化的绝对时间恢复；最新阶段以 `runtime/user_input_auto_resolution` session entry 按 interactionId 覆写保存，若恢复时 deadline 已过，立即以空答案收口。
- 若恢复时全局设置为关闭，任何持久化 active deadline 必须先转为 `snoozed`，不能在恢复窗口内短暂自动收口。
- `snoozeInteractionAutoResolution { interactionId }` 幂等：重复暂停、已收口或不支持计时的交互均返回 noop。
- `workspace/updateInteractionPreferences` 是 host 到对应 workspace CLI 的严格控制面方法。参数携带完整 workspace ref；CLI 在持久化所有受影响 interaction 后才 ACK。
- `userInput.autoResolutionUpdated` 是可恢复事件，记录开始、进入可见阶段与暂停；snapshot 是当前事实，事件用于 continuous 增量与 replayable gap 恢复。
- `SessionSummary.pendingInteraction` 只携带侧栏需要的轻量 `kind`、`toolName` 与 auto-resolution 状态，后台 task 无需打开详情即可区分普通权限、`AskUserQuestion` 和 `ExitPlanMode`。

### 多端与身份隔离

- 桌面 renderer 继续使用 `desktop-continuous` 主链路，不拼接手机 replayable 运行态消息。
- 手机 `/remote` 继续 attachment 到桌面已有 host；不另起 Agent runtime，也不把 timer 状态下沉到 relay/main。
- 手机使用 `web-remote-replayable` 的 snapshot/gap 恢复同一权威 deadline 或 `snoozed` 状态，不能自行重启五分钟。手机断线期间由设置关闭的 deadline，重连后仍保持永久等待。
- interaction 的 owner/lease、origin、`workspaceIdentity`、`workspacePath` 与 `remoteSessionId` 路由保持不变。身份 key 继续使用 `workspaceIdentity?.trim() || workspacePath`。
- background task、Bot、subagent 与普通 task 走同一个 coordinator；subagent origin 不因自动收口丢失。
- 本地 Bot 复用窗口 Host 的 Agent service；远端 Bot 持有独立的 desktop-attached remote runtime
  RPC 端口。设置同步必须同时推送到这些**已缓存**的 Bot runtime，且禁止为了同步偏好新建远端
  Host/Agent；新建 Bot runtime 在暴露 task/session service 前先应用最新偏好。
- 设置同步不按 `clientMode` 分叉；它改变 shared-host runtime 的同一权威 registry。变更后的 interaction 事实仍分别通过桌面 `continuous` 与手机 `replayable` 投递。

## 有效用户操作

下列操作会发送一次暂停命令：

- 鼠标首次进入整个普通 `AskUserQuestion` 面板；
- 点击选项，或用键盘选择选项；
- 自定义输入的键入或粘贴；
- 前进/后退题目导航；
- Bot 多题问答首次记录有效的分题答案。
- 点击问答面板右上角的末分钟秒数；
- 点击侧栏 AskUserQuestion 的“停止计时”胶囊。

打开 task、程序化自动 focus、滚动或窗口重新可见本身不算有效操作。hover AskUserQuestion 侧栏胶囊只把“等待确认”替换为“停止计时”，不发送命令；点击胶囊才发送暂停。鼠标进入问答面板则是明确的阅读/作答意图，会立即暂停。UI 只发送首次暂停；runtime 仍负责幂等，防止重连或多端竞态造成重复副作用。

## 问答面板末分钟提示

- 只有仍带 `deadlineAt` 的普通 `AskUserQuestion` 在剩余时间严格小于 60 秒时显示秒数；`snoozed`、普通权限和 `ExitPlanMode` 不显示。
- 秒数由绝对 `deadlineAt` 推导：先用单次 timeout 等待进入末分钟，再只为当前打开的一个问答面板按秒校准；侧栏 task row 不新增 JS interval。
- 点击秒数只发送暂停命令，不选择选项、不提交空答案；权威投影进入 `snoozed` 后秒数消失，侧栏恢复蓝色静态“等待确认”。
- 手机没有 hover，仍由选项点击、输入、导航或点击秒数触发暂停；desktop continuous 与 web remote replayable 都恢复同一绝对 deadline。

## 问答本地进度边界

CLI/runtime 权威管理 interaction 生命周期和自动结束状态；已挂载 renderer 中的当前题目、焦点和未提交答案草稿属于本地表单状态。两者以 `interactionId/requestId` 为身份边界，不能用 snapshot 对象引用是否变化判断是不是新问答。

```text
同一 requestId
hiddenGrace ── 首次有效操作 ──> snoozed
     │                              │
     └──── CLI 投影更新 metadata ───┘
                                    │
                                    └─ UI 保留 questionIndex / drafts / focus

新 requestId ──> 新建问答实例 ──> 按 currentQuestionIndex / answerDrafts 初始化
```

- 同一 `requestId` 的 `autoResolution`、owner/lease、origin 或其他非题目生命周期 snapshot 更新，不得重置当前 tab、已选答案、自定义输入或首次操作标记。
- task 切换期间若 `sessionId` 已变化但上一 task 的 snapshot 尚未换代，该旧 snapshot 不得渲染当前 task 的问答，也不得参与当前 task 草稿清理；只有 `snapshot.sessionId === sessionId` 的投影可作为 pending interaction 权威。
- 新 `requestId` 必须创建新的本地问答实例，不能继承上一轮草稿。
- 页面首次打开、重连或 replayable snapshot 重新挂载时，仍使用该请求携带的 `currentQuestionIndex` / `answerDrafts` 初始化；挂载后的普通 metadata 更新不反向覆盖本地编辑进度。
- 桌面与手机各自按 `workspaceKey + taskId + requestId` 保留未提交的 renderer-local 草稿；切换 task 导致问答组件卸载后，切回同一 task 必须恢复当前题目和已填答案。最终 `resolveInteraction` 仍按 runtime 先到先得；请求成功收口后清理对应本地草稿。若未来要求跨端实时同步分题草稿，需要新增显式协议状态，不能借用对象重建隐式同步。

## 工具与历史语义

- `AskUserQuestion` 成功输出允许 `answers` 为空对象。
- 空答案不是用户拒绝，不选择默认项，也不产生 permission deny。
- 模型可见 tool result 使用“用户未回答，请使用最佳判断继续”的明确语义。
- UI 历史显示“未回答，已自动继续”，不生成伪造 user message。
- 正常回答、主动拒绝、普通权限与 `ExitPlanMode` 保持现有语义。

## 侧栏展示

- 普通权限、`ExitPlanMode` 和其他非 Ask 阻塞交互：绿色静态“等待确认”，无动画，也没有“停止计时”操作。
- 问答 `hiddenGrace` / `snoozed`：使用独立的浅蓝 surface + 深蓝文字，静态满底“等待确认”。其中 `hiddenGrace` 尚有 deadline，hover 显示灰色“停止计时”并允许点击暂停；`snoozed` 仍保留蓝色“等待确认”，但不再可点击。
- 问答 `visibleCountdown`：固定蓝色 track + 内层蓝色 fill；默认文字固定居中为“等待确认”，hover/focus-visible 时隐藏 fill 并原位切换为灰色“停止计时”，不改变胶囊宽度；点击后发送现有幂等暂停命令。
- 不复用 Zai 主题下为黑/白的 `brand`，也不借用 `success` 表达等待态；Ask 与普通确认分别使用稳定的 interaction 语义 token。
- 普通 task row、timeline row、grouped task row 复用同一个 badge 组件。
- 使用绝对时间和 CSS `transform: scaleX(...)`/animation 恢复进度，不为每条 task 创建高频 JS interval。
- `prefers-reduced-motion` 下禁用连续动画，只在协议状态、focus 或 visibility 变化时按绝对时间刷新比例。
- 桌面与手机宽度、亮暗主题和中英文使用同一语义 token 与 i18n key。

## 验收与剪枝

必须覆盖：

- fake clock 的 0s、59s、60s、180s、末分钟 `59秒..1秒`、300s 阶段与空答案收口；
- 静默期/可见期暂停、重复暂停 noop、正常回答/stop/turn close 清理；
- 问答面板 mouseenter、右上角秒数点击、程序化 focus 不暂停和侧栏 hover 不暂停；
- 多 pending 串行获得完整窗口；
- sessions-index 的后台摘要和 desktop continuous / web replayable 恢复；
- 三种侧栏 row、双主题、中英文与桌面/手机布局；
- 默认开启、关闭前注册、计时中关闭、关闭期间注册与重新开启不追溯；
- Q09–Q14、Q23–Q25 conversation cases。

明确剪枝：

- 权限和 `ExitPlanMode` 不与倒计时做全排列，因为协议中没有 `autoResolution`。
- 不对每个具体选项数、题目数和输入法做计时叉乘；以首次有效操作边界覆盖。
- 不要求真实等待五分钟；自动化注入 clock/scheduler，生产常量另做静态断言。
- relay/main 不保存业务 timer；恢复只验证 shared-host runtime snapshot/gap。
- 主 Agent、后台任务、Bot 与 subagent 不分别复制完整 GUI E2E；共享 registry 由 fake-clock/协议测试覆盖，
  desktop GUI 只保留一条代表路径，mobile replayable 由恢复集成测试覆盖。

GUI 候选位于
`packages/desktop/test/e2e/conversation-session/permissions/conversation-session-ask-user-question-auto-resolution-setting.test.ts`。
它只允许在 `ZCODE_ENV=test` 下使用 `ZCODE_E2E_ASK_USER_QUESTION_CLOCK_SCALE=20`
缩放 runtime 的 60 秒/300 秒窗口；生产环境忽略该注入。候选在人工确认前不晋级正式 E2E。
