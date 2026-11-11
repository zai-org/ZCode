# Conversation Behavior Protocol Declaration

目标：先把“对话产品行为协议”声明清楚，再讨论录入和生成工具。协议声明要让产品、QA、开发能对齐同一套语义：一个 case 是怎么来的、树上的节点分别代表什么、哪些路径是产品规则剪枝、哪些路径是还没定义清楚。

## 协议分层

协议不是一份 JSON，也不是一张流程图。它是几层产品语义的组合。

| 层         | 声明什么                      | 例子                                                                                               |
| ---------- | ----------------------------- | -------------------------------------------------------------------------------------------------- |
| 状态维度   | 产品在某一刻的可观察上下文    | `runPhase=running`、`queue=empty`、`goal=active`                                                   |
| 输入事件   | 用户或系统下一步可能发生什么  | 用户输入 `/compact`、系统返回 `assistantComplete`                                                  |
| 目标对象   | 动作作用在哪个对象上          | latest turn、old turn、composer、goal control                                                      |
| 规则 guard | 某个组合是否允许继续          | running 时不能 compact；running 时 fork 稳定 assistant target 可允许                               |
| effect     | 被允许或拒绝后的产品结果      | enqueue、reject toast、进入 compacting                                                             |
| 不变量     | 永远不能被破坏的产品原则      | running edit 必须先过 stop barrier；fork 只能复制稳定 assistant 历史，不复制 queue/background work |
| trace case | 一条可 review、可转测试的路径 | Given running, when `/compact`, then reject                                                        |

## Trace Tree 节点类型

Trace Tree 是协议展开后的视图。它不是协议本身，但它必须忠实表达协议语义。

| 节点类型    | 含义                 | 责任                                                              | 是否可转 E2E |
| ----------- | -------------------- | ----------------------------------------------------------------- | ------------ |
| `state`     | 一个产品上下文快照   | 说明当前所有状态维度的取值                                        | 否           |
| `candidate` | 一个候选输入         | 表示用户动作或系统事件进入笛卡尔积枚举                            | 否           |
| `guard`     | 命中的产品规则       | 说明这条组合由哪条规则裁决                                        | 否           |
| `effect`    | 规则产生的结果       | 说明 allow/reject/enqueue/system/undefined 后的副作用和下一上下文 | 部分         |
| `case`      | 需要人 review 的叶子 | 汇总完整路径、断言、review 状态                                   | 是           |
| `summary`   | 画布预算折叠节点     | 只表示“这里还有很多节点未展开显示”                                | 否           |

节点之间的基本顺序：

```text
state -> candidate -> guard -> effect -> state ...
                                 |
                                 -> case
```

## 输入事件类型

输入事件分两类，不要混在一起。

| 类型           | 含义                    | 例子                                                  |
| -------------- | ----------------------- | ----------------------------------------------------- |
| `user-action`  | 用户主动触发的 GUI 行为 | sendText、slashCompact、setGoal、forkOld、editLatest  |
| `system-event` | 系统异步推进的事件      | assistantComplete、compactComplete、autoCompactNeeded |

每个输入事件至少要声明：

- `id`：稳定标识，比如 `slashCompact`。
- `actor`：`user` 或 `system`。
- `surface`：发生在哪个产品入口，比如 composer、toolbar、turn actions。
- `target`：作用对象，比如 latest turn、old turn、current session。
- `payload class`：输入内容类别，比如 normal text、slash command、goal text。
- `applicability`：这个事件在哪些上下文里应该被枚举。

## Decision 类型

`guard` 的结果必须落到明确的 decision 类型里。

| decision    | 含义                           | 例子                               |
| ----------- | ------------------------------ | ---------------------------------- |
| `allow`     | 动作立即生效，并进入下一上下文 | completed 后 fork old turn         |
| `reject`    | 动作被明确拒绝，路径剪枝       | running 时 `/compact`              |
| `enqueue`   | 动作不立即执行，但被排队       | running 时继续发送文字             |
| `system`    | 系统事件推进状态               | assistantComplete 后进入 completed |
| `undefined` | 产品预期未声明                 | 某个组合没人定义过                 |

`reject` 不是错误兜底。它必须有明确产品反馈，例如 toast、disabled reason、inline error，且必须声明“不能产生哪些副作用”。

`undefined` 是最重要的 review 入口。它表示模型枚举到了一个真实可能的组合，但协议还没定义怎么处理。

## Command ACK 声明

用户在 renderer/web 上触发的会话动作不应直接改写权威 conversation 状态。它们应先进入 command intent，
由 CLI/runtime 根据当前 projection revision、guard 和幂等键裁决；owner host 只负责可信连接上下文、
owned-subscription 与 owner/lease 路由，不能维护第二份 conversation queue。ACK 和后续
projection/event 共同收口 UI。

```text
user action
  -> ConversationCommand
     |-- commandId
     |-- clientId
     |-- sessionId
     |-- baseRevision?
     |-- type
     `-- payload
  -> host injects {connectionId, trusted clientMode}
  -> CLI guard / dedupe / execute
  <- CommandACK
  -> projection revision update
```

| ACK         | 含义                                                       | 必须声明的副作用                                      |
| ----------- | ---------------------------------------------------------- | ----------------------------------------------------- |
| `accepted`  | command 已被权威层接收，可能已立即执行或进入 command queue | command state 可恢复；UI 等待 projection 收口         |
| `rejected`  | guard 明确拒绝 command                                     | reason、用户反馈、禁止副作用                          |
| `stale`     | `baseRevision` 落后，当前状态可能已变                      | UI 必须先刷新 projection；非幂等动作不能静默重放      |
| `duplicate` | 同一 `commandId` 已处理                                    | 返回既有结果，不能重复执行                            |
| `failed`    | command accepted 后执行失败                                | fault catalog、恢复入口、是否保留 queue/command state |

输入持久接纳与 `TurnStarted` 之间的短窗口由 CLI 在既有 `pendingCommands` 发布精确 commandId；
包含 createSession.firstInput。匹配启动、拒绝或取消时移除，并与后续 queue/turn 事实按同一 owner 顺序
发布。它是当前准入的派生投影，不是第二份队列；重启不凭该投影恢复执行。只拿 accepted ACK 或会话
busy/idle 不能证明某条输入完成。App 控制通过该事实及 sourceCommandId 观察具体 operation。

`@zcode/rpc` 只承载 call/listen、连接、超时、日志和遥测；`commandId`、`baseRevision`、`projectionRevision`、
`eventSeq`、`deliveryKind`、`accepted/rejected/stale/duplicate` 都是 conversation protocol 语义。

桌面窗口（包含 SSH/WSL/Docker）由 host 可信标记为 `desktop-continuous`，手机 `/remote` 和 Web remote
标记为 `web-remote-replayable`。UI-facing subscribe 不能自行选择 profile；每个 attachment 有独立
`connectionId`、subscription registry 和清理生命周期。

```text
desktop A / continuous ── owned sub-a ──┐
                                        ├─> one CLI projection / CommandInbox
mobile  B / replayable ── owned sub-b ──┘

sub-a frame -> port A only        sub-b overflow/resync -X-> port A
```

ACK 丢失或重连时，`commands/query` 每次最多查询 64 个 `{sessionId, commandId}`。CLI 查找顺序固定为
内存 LRU、transcript/message anchor、timeline marker、fork child metadata、discarded input ledger、
`unknown`；同 key 查询与执行必须 single-flight。

`turn.steerQueued` 与 `turn.steerDrained` 的 shared strict schema 必须完整覆盖 CLI runtime 发出的
additive 事实。queued payload 包括可选的 `delivery`、`intent`、`toolDisallowlist`；drained payload
包括可选的 `drainedInputs[]`，每项保留 `pendingInputId`、持久化 `messageId`、文本及相同的投递元数据。
Agent Service 不得因这些已声明字段触发 `unrecognized_keys` 并丢弃事件；queue/guide 的权威状态仍只
由 CLI runtime 持有。

`SessionResumed` 是 raw event sequence 的显式 runtime epoch 边界。Gateway 即使已持有旧 runtime
的 continuous publisher，也必须在收到新的 `SessionResumed` 时清空旧 epoch 的 pending gap，并以
该事件的 raw sequence 重新建立连续 cursor。旧 runtime 在 unsubscribe/重建窗口内遗漏的尾部事件不再
可能补齐，禁止让这些 gap 阻塞新 epoch 的 `TurnStarted` projection authority；同时不得把这个本地
desktop continuous 规则替代为手机 `web-remote-replayable` 的 snapshot/gap 恢复协议。

`commands/query` 对 `fault.command.inputDiscardedOnRestart` 必须同时返回持久输入事实里的
`delivery=startNow|queue|guide`。Renderer 的提交恢复账本只覆盖“上行是否被权威层接收”的短窗口，
不是跨 runtime 的第二份 queue：一旦 snapshot 出现同 `sourceCommandId` 的 queue/guided item，立即清除
对应 localStorage 记录；若 App/CLI 恰在 ACK 与 projection 之间重启，query 返回 `queue|guide` 时同样
静默清账；权威层返回 `unknown` 时保留 renderer 恢复线索且不呈现 UI 错误，等待明确结果、权威投影或既有 TTL。只有 `startNow` 在重启后
仍未进入 transcript，才保留显式重发入口，禁止自动重放。

```text
renderer pre-uplink journal
  |-- queue/guided projection -------------> settle + remove localStorage
  |-- restart query: delivery=queue|guide --> settle silently
  |-- transcript sourceCommandId ----------> settle + remove localStorage
  |-- restart query: unknown -------------> keep pending, no recovery banner
  `-- restart query: delivery=startNow ---> show explicit resend decision
```

恢复提示固定渲染在 conversation sticky bottom dock，并复用聊天区 error banner 的默认
`surface + border + foreground` 颜色、圆角、间距与 wrapping；不得使用 warning 黄色背景，也不添加阴影。

`v4/conversation/plans` 是按 session 查询当前有效计划目录的只读、无状态 query：请求为
`{ sessionId }`，响应为 `{ plans, atSeq, atLogEpoch }`。CLI 必须先复用 conversation 的 cold-resume /
hydration 建立完整 projection，再从当前分支筛选 `toolName=ExitPlanMode`、状态属于
`success/error/cancelled` 且含正文的 `ToolCallRow`，按 `rowId` 降序返回。它不能只扫描 wire snapshot 的
tail window，也不能把完整普通历史下发给 renderer。renderer 用 `atLogEpoch` 和本地目录 revision 丢弃
迟到读；`row.removed` 必须使旧目录失效。该 query 沿现有 workspace attachment 透传，身份 key 继续使用
`workspaceIdentity?.trim() || workspacePath`，不改变 desktop continuous 或 web remote replayable 的订阅、
owner、queue、snapshot/gap 语义。

## Rule 声明

一条 rule 由四部分组成。

| 字段            | 作用                                  |
| --------------- | ------------------------------------- |
| `match.context` | 匹配产品上下文                        |
| `match.input`   | 匹配用户动作或系统事件                |
| `decision`      | allow/reject/enqueue/system/undefined |
| `assertion`     | 后续 E2E 需要验证的结果               |

示例：

```text
rule runningCompactQueues
when:
  context.runPhase = running
  input.id in [slashCompact, compact]
then:
  decision = enqueue
  feedback = 已加入队列
  forbidden side effects:
    - 不作为普通消息发送
    - 不打断当前 active work
    - 不在轮到该 queue item 前启动 compact
assert:
  compact queue item is visible
  sourceCommandId and FIFO position are preserved
  run remains running
```

## 不变量声明

不变量是比单条 rule 更高层的产品原则。它们用于检查规则之间是否冲突，也用于发现漏定义的路径。

第一批对话不变量：

| 不变量 | 说明 |
| --- | --- |
| sameSessionActiveTurnExclusive | 同一个 session 不能同时跑两条 active turn；并发只发生在不同 session 之间 |
| runningStableAssistantForkAllowed | running 时可以 fork 更早 `completedSuccess` turn 最后一段 completed assistant；当前 streaming/interrupted/failed partial 和中间 assistant 段不能 fork |
| latestQueryEditPreemptsActiveTurn | 只有最后一轮 real user query 可以 edit；running 时提交 edit 等价先 stop 当前 active work，再从最后一轮 query 重跑 |
| latestAssistantRetryOnly | 底层 retry capability 仍先锁定当前投影里全时间线最后一条 `assistantText` row，再要求同一 product turn 存在 `origin=realUser` 的 canonical user input；background result/goal continuation/mailbox 等 synthetic 结果轮与更早真实用户轮均不得获得 capability。2026-07-15 产品裁决：桌面、Web 与手机 UI 统一隐藏普通 assistant retry 入口，但保留 `canRetry` 投影、`retryTurn` 命令及门禁，避免把 UI 收口误扩散为协议/恢复语义删除 |
| runningPromptQueues | running 且 `followupMode=queue` 时发送普通消息必须进入该 session 的 queue，不打断当前轮 |
| runningGoalQueues | running 时发送 `/goal xxx` 必须进入该 session 的 queue，消费时设置或更新 goal |
| acceptedInputHasSingleAuthority | 桌面与手机已提交的 busy/running 输入统一按 CLI 串行 admission 顺序进入一个 CommandInbox/FIFO；host 和 UI 不保留第二份权威队列 |
| acceptedInputAlwaysAccountedFor | 已提交输入必须且只能处于 queue、guided row、transcript、explicit rejected/failed/discarded 之一 |
| acceptedInputProjectionSilenceRecovers | `sendText` 或 `editUserQuery` 收到 `accepted` 或 `duplicate` ACK 后，发起端必须等待同一 `sourceCommandId` 的 queue item 或 real-user `userInput` row。`editUserQuery` 已发布 branch cut 时，replacement row 仍是恢复后的唯一权威输入事实，客户端不得只保留截断结果。若短暂宽限期内仍无任一权威可见事实，客户端只触发当前 owned subscription 的 single-flight same-sub resync；不得补造 user row、恢复旧分支、建立 renderer queue 或自动重放 command。恢复继续沿可信 attachment 保持 desktop continuous / mobile replayable 边界；`sendGoalCommand` 的 direct goal state 不以 user row 作为确认条件 |
| destructiveReplayPreservesReplacement | `editUserQuery` / `retryTurn` 在 branch cut 前完成外部模型目录预检；提交 branch cut 后不得因再次读取变化中的目录而拒绝 replacement。若 Core 创建模型时目录已变化，必须先发布 `TurnStarted` 并持久化 replacement user input，再发布 `TurnError(model_creation)`。replacement 走普通轮的同一条生命周期，终态只写一次：落库本身失败时仍以原始模型创建错误收口，Stop 收口为 `completed(cancelled)`；该轮不接受 guide，guide 改投普通 queue。允许工作区保持已确认的 rewind，但不得出现“旧分支已截断且 replacement 不存在”的状态；唯一例外是 `UserPromptSubmit` hook 显式拦截，按普通轮的策略拒绝结束且不落库。`/compact` 不产生 user row，创建失败直接发布 `TurnError(model_creation)` |
| promptRequiresTextOrAttachment | `sendText`、`createSession.firstInput`、`createSelectionSideSession.firstInput` 与 `editUserQuery` 的正文和有效附件至少存在一个；普通附件输入可以使用空正文，本功能的 child 首发只允许非空正文，二者同时为空必须明确 reject |
| sourceCommandIdEndToEnd | queue item、drain/guided event、user row、message anchor、marker 与 fork child metadata 保留原始 sourceCommandId |
| guideDrainsAfterCompletedToolBatch | eligible guide 可以在 tool 出现前等待；只有一次 model step 的全部 sibling tool results 已提交后，才按 admission FIFO 一次内联消费全部已等待的 guide，并在同一 product turn 继续 |
| acceptedGuideStartsWorkSegment | accepted guide 不切 product turn，但必须关闭上一 visual work segment，并以 guided user entity 开启独立工时/折叠段；同一边界一起消费的相邻 guide 共用第一条开启的段；最终 action target 不变 |
| guideFallbackPreservesIntent | 当前 turn 无可用 tool batch 就终态，或 guide 不适用/被拒绝时，同一 intent 原地改投普通 queue；payload、client、IDs、admissionSeq 和 FIFO 不变 |
| incompleteGoalBlocksQueueDrain | 普通 queue 自动消费必须同时满足 session ready，且 target 不存在或 `target.status=complete`；active/paused/budget_limited target 阻塞 text、goal、compact 全部 kind |
| verifierFailOpenCompletesTarget | verifier 基础设施、输出格式或工具误用异常采用 `passed=true` fail-open，并通过正常 target complete 路径解锁 queue；禁止添加绕过 target 更新的 drain 分支 |
| verifierCancelDoesNotPass | 手动 Stop/abort verifier 是 cancelled/failed + target paused，queue 保留且 `autoDrain=false`；不能当作 fail-open 或 pass。非流式 model provider 即使没有及时响应 `AbortSignal`，adapter 也必须以 abort race 立即结束本地 `generateText` 等待，禁止等上游自然返回后才收口 verifier |
| restartDiscardRespectsDeliveryLifetime | CLI restart 后未进入终态的 admitted input 标记 discarded；`queue/guide` 属于旧 runtime 周期，按持久 delivery 静默结算且不保留 renderer 重发副本；`unknown` 保留待确认线索且不显示 UI 错误；只有未进入 transcript 的 `startNow` 提示用户确认，禁止自动重放 |
| runningCompactQueues | running 时 `/compact` 作为 `kind=compact` 的维护意图追加到 CLI FIFO；不打断当前 active work，也不能当普通消息 |
| stopEndsAsInterruptedCompleted | 停止生成后没有“暂停态”；当前轮结束为 `completed(interrupted)` |
| stopKeepsQueueAndDisablesAutoDrain | 停止后 queue 原样保留，且默认不自动消费 |
| pausedQueueInputRequiresConfirmation | `completed` 且 `queue>0` 且 `autoDrain=false`（暂停队列）时，普通消息和 `/goal <新目标>` 不静默入队：保留正常发送按钮，提交后用确认弹窗选择「清空队列并发送」或「保留队列并立即发送」；`/compact` 仍直接追加到暂停队列（2026-07-15 UI 重裁决；v4 仍表达为 `inputRouting.mode=choice`） |
| pausedQueueResumeDrainsFifo | 暂停队列的“继续”是 CLI 权威恢复命令：只设置 `autoDrain=true`；随后仍受 session ready 与 `target absent/complete` guard 约束。无未完成 target 时空闲态立即从队首启动、忙碌态先武装并在当前 active work 收口后启动；target 非 complete 时只武装不消费。满足 guard 后按 FIFO 自动消费到空，Stop/compact 失败等中断重新回到 `autoDrain=false` |
| queueContentIndependence | queue 消息是未来用户意图，不绑定某一段历史上下文；edit 历史 query、compact、fork 都不改写 queue 内容 |
| queuedEditFreezesItemInPlace | 第一方 UI 编辑 queue item 时先 `lockQueueItemEdit(editorId)` 冻结该项；只有 accepted 后才在发起端原 session/workspace composer 进入编辑态。冻结项原位保留 ID/位置/kind，自动 promotion 到冻结队首即暂停，冻结项拒绝 send-now/delete/reorder；提交用 `editQueueItem(editorId)` 原地替换文本、附件与配置并解锁，取消或任意端「解除」用 `releaseQueueItemEdit`；不使用超时释放 |
| composerEditModeStashesDraft | 编辑 latest real-user query 或 queue item 都复用底部 composer 编辑态：进入前暂存原草稿，编辑内容不写持久化草稿；取消、提交成功或失效后普通发送成功都恢复原草稿；目标失效只依据投影（`canEdit`、queue item 与 `editLock`），失效后发送走普通 `inputRouting` |
| compactingAcceptsFutureInput | compacting 时普通消息和 `/goal xxx` 追加 queue |
| duplicateCompactRejected | 同一 session 已有 running 或 queued compact 时再次 compact 必须 reject，不重复入队 |
| compactCanBeStopped | compacting 时允许停止；compact timeline 标记 interrupted，session 回到 `completed(interrupted)` |
| forkAssistantOnly | 只能 fork assistant message；不能 fork user 或 tool message |
| forkDoesNotCopyQueue | fork 新 session 时不复制父 session queue |
| forkDoesNotCopyBackgroundWork | fork 新 session 时不复制父 session 的 live background bash/subagent 或 pending background result |
| runningForkDoesNotRewindWorkspace | running fork 只复制稳定 conversation history；不 rewind 共享 workspace，父 session 继续运行 |
| editUserOnly | 只能 edit user query；assistant 和 tool 不能 edit |
| editKeepsQueue | edit 最后一轮 real user query 会从该轮重跑，但 queue 原样保留 |
| sessionConfigScoped | 模型和思考深度是 session 级存储；切换历史 session 显示各自配置 |
| providerRetryUsesLiveTurnTail | `control.apiRetry` 是 session-scoped runtime-memory 事实，只显示在当前 running turn 底部并替代 generic loading；有效模型进展或终态后清除，CLI 冷启不恢复。只读 child 可展示该状态，但不得因此开放手动 retry command |
| freshSubagentInitialModelIsDurable | fresh child 在首轮输入前持久化实际解析模型 `model_change(undefined -> X)`，首轮显示无切换箭头的“正在使用 X”且冷启可重建；普通 Main 首轮静默，resume 不重复写入，旧 child 不回填，父 timeline 不镜像 |
| newSessionInheritsLastSelection | 新建 session 使用用户上一次显式选择并由 runtime 确认生效的 `provider + model + thought` 配置元组；thought 不得脱离所属模型独立继承 |
| draftCollaborationModeUsesRendererGlobalPreference | `build/edit/plan/yolo` 的记忆只作用于未发送草稿：同一 renderer 的新草稿读取全局 localStorage 偏好，已有 session 的打开或切换不得改写该偏好 |
| queuedSubmissionPreservesSelection | queue item 保存完整 Submission；消费时使用入队时已经固定的 Provider、Model 与思考深度，后续 Session Selection 变化不改写已入队意图；Provider 配置在创建 Model 时读取最新事实 |
| acceptedGuideSwitchesAtModelStepBoundary | guide 被当前 Loop 接收时，输入、Session Selection 与后续 Active Model 一起生效；已经发出的模型请求继续完成，下一个 model step 使用 guide 的 Selection |
| crossSessionUnlimitedConcurrency | 不同 session 可以真实并发运行，产品层没有并发上限 |
| sessionResidencyTargetIsSoft | 每个 CLI 可以用 LRU 维持 resident session 软目标；active/queued/background/pending/subscribed/operation-leased session 必须优先保活，受保护 session 超过目标时允许超额，禁止为满足容量而取消工作 |
| deactivatedSessionEqualsColdSession | resident eviction 只删除 CLI 内存 record/publisher/runtime，不删除持久 session 或 task index、不发 `session.removed`；后续访问与 CLI 重启后的未加载 session 共用 cold-resume，renderer 不接收去激活业务通知 |
| sessionContextFollowsActiveSession | 用户切换历史 session 后，右侧 sidebar、任务、上下文必须跟随 active session |
| autoCompactIsSystemTurnPrefix | 自动 compact 是系统插入的前置维护步骤，不占用户 queue；成功后继续原本要执行的动作 |
| cliOwnsConversationProjection | conversation product projection 由 CLI/runtime 基于 CLI facts 产生；owner host 只缓存、路由和恢复投影，UI 不用本地消息数组发明产品事实 |
| productRowsRequireCompleteConsumerContract | CLI 只有在 row 的身份、session/turn/tool 落位、cold 恢复位置和 Renderer 已形成完整契约时，才能把 runtime fact 物化为 conversation product row。`HookRun*` 只投影 client-safe `hookInvocation` 摘要：按权威 `turnId` 进入轮尾 action，resume 中缺少 turnId 的 `SessionStart` 等待下一条真实 user-intent turn，禁止构造 `session-hooks:*` synthetic turn；admission-only blocked 不得被展示为“运行过”。live/cold、desktop continuous、mobile replayable 与 Renderer 必须在同一变更中闭环，不能只合入协议类型或 producer |
| v4ColdResumeSeparatesActivationFromProjection | V4 历史会话冷订阅只复用 session runtime activation；历史 rows/goal/plan/queue/interaction 与首帧由 V4 durable materialization 和 ProductProjection 恢复。不得为了激活 runtime 或读取 usage 构建无人消费的 legacy 全量 snapshot；legacy `session/resume` 仍以 activation + legacy snapshot 保持响应兼容 |
| turnIdAuthoritative | `turnId` 是 CLI/runtime 权威 turn 身份；`turnIndex` / `ordinal` 只能展示 |
| stableHistoryTargetsPreferMessageId | fork、edit、rewind、file summary 等历史操作优先使用稳定 `messageId` 或 `turnId`，旧数据才 fallback 到 `turnIndex` |
| timelinePlacementFromProjection | timeline 的位置必须来自 projection 的 `anchorTurnId` / `anchorMessageId` / `placement`，不能用最近 user/assistant 或数组下标推断 |
| commandIdempotencyRequired | 所有会改变 conversation 的 command 必须有 `commandId`，支持 duplicate ACK，避免重试造成重复消息或重复停止 |
| stopTargetsObservedForegroundExecution | Stop 必须携带用户点击时投影出的 `foregroundExecutionId`；同一 runtime command 内的 primary turn、goal verifier 与 goal continuation 共享身份。Runtime 只取消身份匹配的当前 execution；旧 execution 已终止并切到无关新 execution 时返回 noop，禁止误停新请求。命中 execution 后，本地 active work 的取消不能依赖 provider promise 是否遵守 abort；provider 的迟到结果只能被丢弃，不能延迟 UI/runtime 收口或复活旧 work |
| trustedDeliveryBoundary | desktop（含 SSH/WSL/Docker）固定 continuous，mobile/Web remote 固定 replayable；client 不能伪造 profile |
| subscriptionOwnedByConnection | subscription 和 buffer 按 connection 隔离，frame 只发给 owning attachment；慢手机不能影响桌面 |

如果一条 rule 的 effect 违反不变量，Trace Tree 应该生成 `violation case`，而不是普通 accepted case。

## 会话区已确认语义

这一节记录当前已经确认的理想产品语义，不以现有代码实现为准。后续 case 枚举、剪枝和 E2E 生成都应该先对齐这里。

### 状态维度

```text
session.phase =
  draft
  prewarming
  running
  completed(success)
  completed(interrupted)
  error

activeWork.kind =
  primaryTurn
  foregroundSubagent
  compact
  goalVerifier
  goalContinuation
  turnSteer

followupMode =
  queue | guide

toolResultBatch =
  none | pending | committed

queue.length =
  0 | 1 | 2 | 3+

queue.autoDrain =
  true | false

compact.origin =
  manual | auto

collaborationMode =
  build | edit | plan | yolo
```

当 `collaborationMode=plan` 时，composer 提交 parser 已识别的 goal 控制命令必须在 UI
admission 边界 reject：提示“goal 无法在 Plan 模式下使用，请切换模式”，保留输入原文，且不得
创建 session、发送 `sendGoalCommand` / `resumeGoal` 或写入 prompt history。该 guard 发生在
draft promotion、running queue 和暂停队列裁决之前，因此 runtime phase 与 queue 状态不再
扩大这条组合。

没有独立的 `paused` session phase。用户停止生成后，当前轮进入 `completed(interrupted)`；如果 queue 里还有消息，queue 保留且 `autoDrain=false`。UI 把这个组合称为“暂停队列”，并在队列项上方显示恢复提示条；产品文案不再暴露内部术语 `held queue`。

普通主 turn 进入 `error` 时同样只结束当前 turn，不撤销已经 accepted 的后续输入：queue 原样保留并切换为 `autoDrain=false`，暂停提示原因标记为错误；用户可以点击“继续”恢复队首 FIFO。错误路径禁止发出 `TurnSteerDiscarded(reason=turn_failed)`，也禁止在错误终态触发自动 drain。该恢复不变量同时适用于桌面 `desktop-continuous` 和手机 `web-remote-replayable` 的共享 CLI admission，后者仍必须遵守 replayable 的 snapshot/gap 边界。

暂停队列的确认与恢复时序：

```text
Stop
  -> payload.expectedForegroundExecutionId = 当前 control.activeWorks 的 executionId
  -> CLI Runtime 校验当前 execution 身份并原子标记 stopRequested
  -> 身份已切换: noop，不得取消后续无关 turn
  -> 身份匹配: abort 当前 execution
  -> completed(interrupted)
  -> queue 保留, autoDrain=false
  -> UI: 队列已暂停 [继续]

普通消息或 /goal <新目标>
  -> 打开发送确认框（草稿、附件保持原样）
  -> 清空队列: 校验确认时的 queueItemId 集合未变化 -> 清空旧队列 -> 发送当前输入
  -> 发送消息: 校验确认时的 queueItemId 集合未变化 -> 保留旧队列暂停 -> 发送当前输入

点击继续
  -> setAutoDrain(true)
  -> idle + target absent/complete: 提升当前队首
  -> target active/paused/budget_limited: 只武装，等待 target complete
  -> busy: 仅武装，当前 active work 收口后提升队首
  -> Q1 -> Q2 -> ... -> queue 为空
```

确认框的 `queueItemId` 集合校验是跨端并发保护：确认打开后若桌面端或手机端增删了队列项，原确认失效并基于最新投影重新确认；不能把用户没有看到的新队列项一并清空。仅重排同一批 ID 不扩大清空集合，可继续执行。冻结编辑与 `editQueueItem` 原地保留同一批 ID，也不使确认失效；选择清空时冻结项一并删除，发起编辑端进入失效态。

`compacting` 和 `goalVerifying` 不是与 `running` 平级的顶层 phase。它们是 `running` 内部的
completion-blocking active work，分别表达为 `activeWork.kind=compact` 和 `activeWork.kind=goalVerifier`。

自动 compact 会围绕一个 `pendingAction` 运行。`pendingAction` 指触发自动 compact 的待执行动作，它不一定是一条消息。

`pendingAction` 的典型来源：

- 用户在 `completed, queue=0` 时直接发送的普通消息。
- queue 自动消费时取出的队首消息。
- queue 自动消费时取出的 `/goal xxx`。
- edit user query 后准备重跑的那一轮输入。

### Running

| 前置                                                                                                         | 用户动作                                 | 产品结果                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `running, followupMode=queue`                                                                                | 发普通消息                               | 追加到 queue，不打断当前轮                                                                                                                            |
| `running, followupMode=guide`，满足模型/provider 无关的 runtime eligibility                                  | 发普通消息                               | admission 为 guide；等待完整 tool result batch 后与其他已等待的 guide 一起内联消费，不启动第二个 turn                                                 |
| `running, followupMode=guide`，已有普通 queue                                                                | 发普通消息                               | guide 仍进入当前 active turn；既有 queue 作为未来 turn FIFO 保持原相对顺序，不构成 fallback guard                                                     |
| `running, followupMode=guide`，无 tool batch 即终态，或因附件/Stop/不可 steer active work 不满足 eligibility | 发普通消息                               | 同一 intent 原地回退 queue；保留 payload、IDs 和 admission FIFO；模型/provider 不能作为 fallback guard                                                |
| `running`                                                                                                    | 发 `/goal xxx`                           | 追加到 queue；消费时已有 goal 就更新，没有 goal 就设置                                                                                                |
| `running`                                                                                                    | 发 `/compact`                            | 以 `kind=compact` 追加到 queue，不打断当前 active work；轮到时才启动 compact                                                                          |
| `running`                                                                                                    | stop                                     | 当前轮结束为 `completed(interrupted)`；queue 原样保留；`autoDrain=false`                                                                              |
| `running`                                                                                                    | fork stable assistant                    | allow；目标必须是更早 `completedSuccess` turn 的最后一段 completed assistant；child 只复制稳定对话历史，父 session 继续运行，共享 workspace 不 rewind |
| `running`                                                                                                    | fork current streaming assistant partial | reject                                                                                                                                                |
| `running`                                                                                                    | edit 最后一轮 real user query            | 先 stop 当前 active work，再从该 query 重跑；queue 原样保留且不自动消费                                                                               |
| `running`                                                                                                    | edit 非最后一轮 user query               | reject 或入口 absent；不能 rewind 历史轮，也不能启动第二条 active turn                                                                                |

### Completed

| 前置                                                            | 用户动作            | 产品结果                                                                                                       |
| --------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `completed(success), queue=0`                                   | 发普通消息          | 立即开始下一轮                                                                                                 |
| `completed(interrupted), queue=0`                               | 发普通消息          | 立即开始下一轮                                                                                                 |
| `completed(interrupted), queue>0, autoDrain=false`              | 发普通消息          | 保留正常发送按钮；提交后打开确认弹窗。选择清空则清空已确认旧队列后立即发送，选择发送则保留旧队列暂停并立即发送 |
| `completed, queue>0, autoDrain=false`                           | `/goal <新目标>`    | 同普通消息，打开确认弹窗后按清空/保留裁决；`/goal resume` 等目标控制命令不进入本弹窗                           |
| `completed, queue>0, autoDrain=false`                           | 队列“立即发送”      | reserve 目标项并开始 promote；启动成功才移除，失败释放 reservation 并原位保留                                  |
| `completed, queue>0, autoDrain=false`                           | 编辑 queue item     | 冻结该项并在发起端 composer 进入编辑态（原草稿暂存）；提交原地替换并解锁，取消解锁；不触发消费                 |
| `completed, queue>0, autoDrain=false`                           | 重排、删除 queue    | 只修改 queue，不触发消费                                                                                       |
| `completed, queue>0, autoDrain=false`                           | compact             | 不打开确认弹窗；追加到暂停队列末尾，保持 FIFO；仍不自动消费                                                    |
| `completed, queue>0, autoDrain=false, target absent/complete`   | 点队列提示条“继续”  | `autoDrain=true`；立即从队首开始，按 FIFO 自动消费到空                                                         |
| `running, queue>0, autoDrain=false, target absent/complete`     | 点队列提示条“继续”  | `autoDrain=true` 并武装；不抢占当前 active work，收口后按 FIFO 自动消费到空                                    |
| `queue>0, autoDrain=false, target active/paused/budget_limited` | 点队列提示条“继续”  | 只设置 `autoDrain=true`；不得提升队首，等待 target complete 后再按 FIFO 自动消费；显式 `sendQueuedNow` 除外    |

### Queue

queue item 是未来用户意图或维护意图，不绑定某一段历史上下文。因此：

- edit 最后一轮 real user query 不清空 queue。
- compact 不改写 queue 内容。
- fork 不复制 queue。
- 普通用户输入入队时保存完整 Submission，其中的模型与思考深度表达该次提交的用户意图；真正消费时只重新读取最新 Provider 配置并创建 Model，不改用 Session 后来选择的模型。

所有端已提交的 busy/running 输入进入同一个 CLI/runtime `CommandInbox` FIFO，顺序以 CLI 串行 admission
为准。queue item 自包含保存原始 `sourceCommandId`、稳定 `queueItemId`、`clientId`、kind（`sendText` / `sendGoalCommand` / `compact`）、原文、
attachments、delivery、顺序以及 steer/dispatch 状态。guide 不适用、attachments、compact/verifier busy
或 runtime steer reject 时按原字段回退普通 queue；empty、超限或 runtime reject 必须显式
`rejected/failed`，UI 不得先清空 payload。`compact` 消费时必须走 compact lifecycle，只产生
timeline marker，不生成 real-user row，也不进入 transcript query/edit/retry 语义。

第一方 UI 的 queue edit 固定为 `lockQueueItemEdit -> accepted -> composer 编辑态 -> editQueueItem | releaseQueueItemEdit`。
编辑内容包含输入 kind、可见文本、有序 `AttachmentRef[]` 与队列项记录的模型/mode/Plan；goal 的可见文本是 `/goal ...`，提交时 kind 不变；
compact 不提供入口。进入编辑态前暂存 composer 原草稿，取消或提交成功后恢复；composer busy 时在 UI admission
边界拒绝且不得发 command。完整规则见 [Composer 编辑态](ui/composer-edit-mode.md)。

`queueItem.editLock = { editorId, clientId, inputOrigin }` 是 CLI 内存中的权威事实并进入投影。`editorId`
标识单个窗口/标签页（sessionStorage），刷新后不变。锁只对 `dispatch.state=queued` 的项生效；
`reserved/promoting` 返回 `guard.queueItemReserved`，已有锁返回 `guard.queueItemEditLocked`。
`editQueueItem` 的 `editorId` 与锁不符时返回 `guard.queueEditLockLost`。发起端刷新后发现自己 `editorId`
的锁而本地无编辑态时立即释放；窗口关闭或手机断开后锁保留，由任意端手动解除。不使用超时。

编辑提交保留原 `sourceCommandId` 与 `queueItemId`。编辑态与暂存草稿只属于发起端 renderer，不进入 snapshot
或 replayable 状态；其他端只看到 `editLock`。请求必须绑定点击时的 sessionId 与
`workspaceKey = workspaceIdentity?.trim() || workspacePath`；锁 ACK 返回前切换 session/workspace 时不进入编辑态并释放锁。

编辑态完全复用 composer：原附件保持原顺序与完整字段，不重新 upload/adopt；新增附件走普通发送的上传事务；
工具栏修改的模型/mode/Plan 随 `editQueueItem` 写回。没有本地 object URL 的图片退化显示文件名和类型图标，不扩展下载协议。

guide 与普通 queue 只共享输入事实和 admission FIFO，不共享消费触发器：

```text
guide: tool batch committed -> drain all waiting guides inline (FIFO) -> same product turn continues
queue: session ready -> target absent/complete -> promote one head item as a future turn
```

guide 在 tool call 出现前提交是合法的；runtime 等待下一次完整 tool result batch。parallel tool call
必须等所有 sibling result（成功或失败）都落事实后才能消费 guide；同一边界按 admission FIFO 一次取出
全部已等待的 guide；每条在 user message 与 promote 提交后各自写入一条 drained fact，中途失败时已提交的已显示，
未提交的留在队列。guide 被接收时，它携带的 ModelSelection 同时成为 Session
Selection，并在下一个 model step 创建新的 Active Model；同一边界取出多条时，最后一条带意图的 guide 决定 Selection、
权限模式与 Plan 意图。接收前已经发出的请求继续使用原 Model。当前 turn text-only complete、stop 或 interrupted 且未出现可用 batch 时，
runtime 必须用明确的 delivery/fallback fact 把同一 Submission 原地改投 queue，保留 Selection、payload、
IDs 与 admission 顺序；live projection 与 cold hydration 必须一致，不能用新 ID 重新入队。

普通 queue 的自动 promotion 必须按以下 guard 串联判断，且对所有 kind 一视同仁：

```text
head.dispatch=queued
  AND head.editLock absent
  AND queue.autoDrain=true
  AND no active controller / session ready
  AND (target is absent OR target.status=complete)
```

一次 `goal_verification completed` marker 或 `passed=false` 都不足以解除 guard。显式 pass 与 fail-open
都先写 `passed=true`，再把 target 更新为 `complete`，之后才允许正常 queue promotion。手动终止
verifier 则进入 cancelled/failed + target paused，并保持 queue 不自动消费。`sendQueuedNow` 是显式
reservation + Stop barrier 路径，不属于自动 promotion guard。

队列编辑新增 `lockQueueItemEdit` / `releaseQueueItemEdit`，`editQueueItem` 扩展为携带 `attachments`、`modelSelection`、
`mode`、`planEnabled` 与 `editorId`，原地更新并保留 ID、位置、kind 和来源 command，同时释放锁。`sendQueuedNow` 固定为
`reserve -> stop barrier -> start/promote -> remove`；多端只能有一个 reservation owner。

调度原子性：自动 promotion 发现 Bootstrap 或 Core foreground/runtime queue busy 时不得 reserve/stop，
只在真正 idle 后重评；显式 `sendQueuedNow` 必须在 Stop 前取得 Core 进程内的一次性 promotion lease，
并按原 `sourceCommandId/inputId` 让 promoted command 先于已等待的 notification 出队。lease 不持久化、
不投影，也不改变 desktop continuous 与 mobile replayable 的交付边界。

queue 只保证当前 CLI 进程内可靠。CLI restart 后仍未进入 transcript/终态的 admitted input 进入 discarded
ledger，`commands/query` 返回 `fault.command.inputDiscardedOnRestart` 及持久 `delivery`。UI 的 24 小时
pending registry 只覆盖权威投递未知窗口：queue/guided projection、restart query 的 `queue/guide`
会立即清账；`unknown` 保留待确认线索直到明确结果、权威投影或既有 TTL；只有未进入 transcript 的 `startNow` 保留人工确认重发，禁止自动重放。

如果 `completed, queue>0, autoDrain=false`，用户从输入框提交普通消息或 `/goal <新目标>`，UI 必须先弹确认框，不能用 composer 内联双按钮替换正常发送按钮。弹窗关闭、Esc 或点击遮罩都只取消本次提交，草稿、附件和 prompt history 不发生移交；`/compact` 例外，直接追加队尾并保持暂停。

### Edit

| 前置                                               | 用户动作                         | 产品结果                                                         |
| -------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------- |
| `completed(success), queue=0`                      | edit 最后一轮 real user query    | 从该轮重跑，后续历史被新分支替换                                 |
| `completed(interrupted), queue=0`                  | edit 最后一轮 real user query    | 从该轮重跑，当前 interrupted 结果被新分支替换                    |
| `completed(interrupted), queue>0, autoDrain=false` | edit 最后一轮 real user query    | 从该轮重跑，queue 原样保留，`autoDrain` 仍为 false               |
| edit 重跑导致 `running`                            | 再发普通消息                     | 追加 queue                                                       |
| edit 重跑导致 `running`                            | 再发 `/goal xxx`                 | 追加 queue                                                       |
| edit 重跑导致 `running`                            | 发 `/compact`                    | 追加 queue；轮到时执行 compact，不打断 edit 重跑                 |
| edit 重跑导致 `running`                            | 再 edit 最后一轮 real user query | 先 stop 当前 edit 重跑，再用最新编辑文本重跑；queue 原样保留     |
| edit 重跑导致 `running`                            | edit 非最后一轮 user query       | reject 或入口 absent；避免历史分支在 active turn 中被二次 rewind |

只能 edit user query。assistant 和 tool 不能 edit。

第一方 UI 的 user query edit 复用底部 composer 编辑态（[Composer 编辑态](ui/composer-edit-mode.md)），不再使用行内编辑器。
编辑期间目标 row 的 `actions.canEdit` 变为 false（例如队列续跑产生新的 real-user 输入）时，编辑态失效，
发送改为普通新消息并走正常 `inputRouting`。

edit 的附件是 canonical input intent 的一部分。第一方 UI 的编辑态完全复用 composer：可删除既有
`AttachmentRef[]`，也可像普通发送一样新增附件（含长粘贴转附件）；新增附件走 `sendText` 同一上传事务，
既有 ref 不重新 upload/adopt。提交时显式携带当前完整数组：字段缺省表示保留原附件，
非空数组表示替换，`[]` 表示清空。空正文但仍有附件可以重跑；正文与 effective attachments
同时为空必须在 branch cut 前 reject。删除只影响新 active branch，不物理清理旧 branch 的附件内容。

`editUserQuery` 与 `sendText` 一样携带 composer 当前的 `modelSelection`、`mode`、`planEnabled`。
`editQueueItem` 不走 CAS：运行中 revision 持续递增，CAS 会误拒编辑提交；并发保护由 CLI 编辑锁承担，
提交的 `editorId` 必须仍持有该项的锁，否则返回 `guard.queueEditLockLost`。

### Fork

只能 fork `completedSuccess` product turn 最后一段 completed assistant。不能 fork user、tool、timeline、
当前 streaming/interrupted/failed partial 或同一 turn 的中间 assistant 段。新数据按持久化 turn anchor
解析；旧数据只有无歧义时 fallback，否则返回 `guard.forkTargetAmbiguous`。

fork 新 session 时复制 fork 点之前的消息历史、fork 点持久化配置和 fork 点前 goal 状态，但不复制父 session 后续配置、queue、live background bash/subagent、pending background result 或 continuation inbox。primary turn、foreground subagent、goal continuation 或 goal verifier running 时都可 fork 更早稳定历史；compact 是 operation lock。父 session 如果仍在 running，当前 active work 继续归属父 session；child 只从稳定 fork 边界开始演进，不 rewind 共享 workspace。completed/idle 的既有 workspace checkpoint 行为本轮不扩大。同一 `sourceCommandId` 重试返回同一个 child。

V4 conversation fork 的 model-only notice 按 `conversation_fork` Attachment 恢复：持久化正文不含标签，provider 投影时统一包一层 `<system-reminder>`。它与 side chat 一样不参与 MCS，始终保留在 fork 历史边界、子会话新问题之前；UI 仍只显示 `session_fork` timeline。既有 legacy/checkpoint fork 的 `rewind_notice` 路径保持原行为，不迁移旧消息或逐轮重复注入。

```text
fork bundle: inherited history -> raw notice + Attachment metadata -> timeline boundary
hydrate:     inherited history -> conversation_fork Attachment
child send:  inherited history -> user <system-reminder>notice</system-reminder> -> user question
                                 (MCS / non-MCS 均保持此位置)
```

### Compact

compact 分为手动 compact 和自动 compact。

手动 compact：

| 前置                                                                             | 用户动作                   | 产品结果                                                                                           |
| -------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------- |
| `completed, queue=0`                                                             | `/compact` 或 compact 按钮 | 开始 compact，插入 timeline started                                                                |
| `completed, queue>0, autoDrain=false`                                            | `/compact` 或 compact 按钮 | 追加到暂停队列末尾；`autoDrain=false`，用户恢复 drain 或点立即执行前不启动 compact                 |
| `running`（含 primary/tool/foreground subagent/goal continuation/goal verifier） | `/compact` 或 compact 按钮 | 追加 queue，严格 FIFO；不打断当前 active work                                                      |
| `compacting`                                                                     | 发普通消息                 | 追加 queue                                                                                         |
| `compacting`                                                                     | 发 `/goal xxx`             | 追加 queue                                                                                         |
| `compacting`                                                                     | 再次 `/compact`            | reject，不入队                                                                                     |
| `compacting`                                                                     | stop                       | 停止压缩；timeline 标记 interrupted；session 进入 `completed(interrupted)`；queue 保留且不自动消费 |

自动 compact：

```text
某个 pendingAction 即将执行
  -> 系统判断 needsCompact=true
  -> 先进入 compacting(origin=auto)
  -> 插入自动 compact timeline marker
  -> compact 成功后继续 pendingAction
```

自动 compact 是系统调度插入的前置维护步骤，不占用户 queue。它可能出现在任意轮次之前，包括用户直接发送、queue 消费、goal 消费、edit 重跑之前。

queued manual compact 即使在轮到前刚发生过 auto compact，也仍按用户显式意图执行；runtime 可以返回
noop marker，但 UI/CLI 不能静默移除。queued manual compact 失败或被 Stop 后，后续 queue 进入 held，
不能越过维护失败/取消继续自动消费。

重试语义：

- 自动 compact 最多重试 3 次。
- 手动 compact 不自动重试。
- 自动 compact 成功后，必须继续执行触发它的 `pendingAction`，除非用户在 compact 期间停止。

仍待确认的自动 compact 分支：

- 自动 compact 重试 3 次仍失败后，`pendingAction` 如何处理。
- 自动 compact 被用户 stop 后，`pendingAction` 如何处理。

### Goal

`/goal xxx` 的语义是设置或更新 session goal：

- Plan 模式下 goal 控制命令不可用；composer 只 toast 并保留原输入，不创建或更新 goal。
- 如果之前没有 goal，就是设置 goal。
- 如果之前已有 goal，就是更新目标。
- 没有需要禁止用户操作的 `goal validating` 产品状态。
- running 或 compacting 中发送 `/goal xxx` 时，不立即执行，追加 queue。

### Model 和思考深度

模型和思考深度是 session 级存储：

- renderer/configOptions 中需要把 `ZCodeModelRef` 暂时表示为字符串时，统一使用
  `providerId/modelId$variant`；`$` 是该展示态编码的 variant 保留分隔符。`:` 始终属于
  provider 原始 `modelId`，不得被 renderer 解释为 variant，例如 OpenRouter
  `nvidia/nemotron-3-ultra-550b-a55b:free` 必须端到端保持完整。V4 命令、Agent snapshot
  与持久化仍使用独立的 `provider` / `model` / `thought` 或结构化 `ZCodeModelRef`，
  不得把该展示态字符串当作新的跨进程协议。
- 切换历史 session 时，顶部/输入区配置显示该 session 自己的模型和思考深度。
- 新建 session 时，使用用户上一次显式选择并由 runtime 确认生效的
  `provider + model + thought` 配置元组。renderer 持久化的是一个不可拆分的元组，不能把
  model 和 thought 作为两个互不关联的全局偏好分别恢复。
- 打开或切换历史 session 只展示该 session snapshot，不得改写“上次显式选择”配置元组；否则浏览历史
  会话会静默改变下一份新草稿的默认模型。
- 用户跨模型切换时，源模型 thought 不代表目标模型意图。runtime 必须先按目标模型能力选择实际 thought，
  renderer 收到权威结果后再整体持久化新元组；失败、stale 或尚未投影的请求值不得提前落盘。
- 草稿预热的 `createSession.config` 只能引用当前 Environment Model Selection View 中的模型。Host
  必须先等待本 Environment 的 Provider Registry readiness，再下发 `createSession`；不得用 Desktop
  快照、`runtimeModel` 或跨 Environment Registry 推送填补未就绪窗口。只有当前 Registry 已确认移除
  或禁用原 Provider 后，才进入正常的 Worker fallback 与 compare-and-set 持久化路径。
- 模型身份变化必须同步清除草稿配置与 workspace default 中尚属源模型的 thought。即使目标模型支持
  同名档位，也只能采用目标模型默认/实际档位；只有用户随后在目标模型上显式切 thought 才可覆盖。
- 旧版分离的 model/thought localStorage 仅作迁移输入：只有两者能组成同一个模型配置时才迁移；孤立
  thought 不得应用到其他模型。
- queue 中的普通用户 Submission 使用入队时固定的模型和思考深度；Provider 配置、凭据和模型定义在执行时从当前 Environment 事实重新解析。
- 普通 session 首轮使用 silent initial 模型基线，不生成 `modelChange`。fresh Subagent
  child 发布 `ModelSelected(previousModelRef=null, modelRef=X)`，以通用 `∅→X` 模型边界
  在首轮开始时生成 source 缺失的 `modelChange`，并通过 transcript 冷恢复。公共投影只
  识别 silent initial、source-less、known 三态模型基线，不识别 Subagent 身份；不得仅从
  旧 child 元数据或缺失的来源字段推断新边界。
- `modelChange.fromProvider/fromModel` 必须共同存在或共同缺失；前者表示普通 A→B，后者只表示
  Subagent 初始实际模型。renderer 只负责按该结构选择“模型已切换”或“正在使用”文案；source
  缺失时不显示切换箭头，也不在 provider/model 标签后追加“模型”，普通 A→B 展示保持不变。

### 草稿协作模式默认值

`build/edit/plan/yolo` 的全局记忆只属于 renderer 草稿态，不是 workspace default，也不是
session 恢复事实：

- 同一 renderer 中，用户在任一未发送草稿显式选择模式后，写入一个不含 workspace 后缀的
  localStorage 偏好；后续本地或 SSH/WSL/Docker workspace 的新草稿都以该值初始化。
- 草稿预热和首发 `createSession.config.mode` 必须显式携带该值，不能先使用 Agent 的旧
  workspace/project mode 再异步切换，避免首帧和首发竞态。
- 打开历史 session、在已有 session 中切换模式、session snapshot 恢复，都只影响该 session；
  不得改写草稿全局偏好。
- localStorage 缺失、不可读或值非法时确定性回落 `build`；旧 workspace mode 不参与回落。
- desktop renderer 与手机 Web renderer 的 localStorage 相互独立。本规则不声明跨设备同步；
  手机新草稿只继承手机浏览器自己的偏好。

### 多 Session 并发

不同 session 之间是真实并发：

- Session A running 时，用户可以切换到 Session B。
- Session B 可以继续发送并进入 running。
- 产品层没有并发上限。
- 各 session 的 queue、模型、思考深度、context、右侧 sidebar 状态互相隔离。

## Case Review 状态

每个 `case` 节点最终需要被人标记。

| 状态      | 含义                       |
| --------- | -------------------------- |
| accepted  | 产品预期明确，可以生成测试 |
| undefined | 需要补协议                 |
| invalid   | 这个组合应通过前置条件剪掉 |
| ignored   | 组合存在，但当前版本不覆盖 |
| bug       | 当前实现和协议预期冲突     |

review 的输出不是“树好不好看”，而是这些产物：

- 已确认的产品协议。
- undefined case 清单。
- invalid 剪枝条件。
- bug 候选。
- 可生成 E2E 的 accepted case。

## 下一步

先不要做复杂录入 UI。下一步应该把当前工具里的节点和规则说明对齐这份协议声明：

- 第一批自然语言 case 见：[conversation-session-case-catalog.md](./conversation-session-case-catalog.md)。
- MVP 验证矩阵见：[conversation-session-validation-matrix.md](./conversation-session-validation-matrix.md)。
- 会话区 UI test id 合同见：[conversation-session-ui-testid-contract.md](./conversation-session-ui-testid-contract.md)。
- Trace Tree 节点浮层展示 `node type`、`input type`、`decision`、`rule id`。
- rule 列表按 `decision` 和 `invariant` 分类。
- case 导出时带上完整协议字段，而不是只导出标题文本。
- 如果出现 `undefined`，能直接看出缺的是哪一层协议：状态、输入、规则、effect 还是不变量。

## 历史先显示的执行边界（2026-10-09）

支持 historyFirst 的 V4 会话先发布持久历史，runtimeInitialization 未 ready 时只允许阅读与编辑本地文字草稿；新执行命令拒绝且不入 accepted queue。初始化失败保留历史，显式重试通过原订阅入口触发；普通重连不重跑失败尝试。该状态独立于 running/completed，不改变 desktop continuous 与 mobile replayable、模型默认值及任务活动时间。详见 `v4-refactor/17-cold-resume-runtime-activation.md`。
