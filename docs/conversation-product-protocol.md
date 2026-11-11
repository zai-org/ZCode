# Conversation Session Product Protocol（当前规格）

更新日期：2026-07-15

本文是 V4 conversation 的当前产品协议。schema 以
`packages/shared/src/zcode-protocol-v4/` 为准，CLI 裁决与投影以
`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/` 为准，UI 消费以
`packages/ui/src/v4/` 为准。旧 `@zcode/protocol`、legacy task stream 和 renderer conversation
reducer 只存在于历史文档或兼容层，不得覆盖本文语义。

目标：把 conversation session 的产品行为定义成稳定协议，让产品、开发、QA 和 E2E 用同一套语言讨论状态、动作、裁决、副作用和证据。本文只定义协议层，不展开完整 rule table，也不声明自动化覆盖完成。

本文优先整合现有文档中的共同语义；若现有文档之间已经出现冲突，本文不静默选择一边，而是放入“待确认边界”。确认后再回写 rule table、case catalog 和 coverage matrix。

## Source Documents

| 文档 | 当前职责 |
| --- | --- |
| [conversation-protocol-declaration.md](./conversation-protocol-declaration.md) | V4 前的术语与裁决历史；冲突时不作为当前实现依据 |
| [conversation-product-state-space.md](./conversation-product-state-space.md) | 状态空间与 guard 剪枝方法；具体字段以 V4 schema 为准 |
| [conversation-session-case-catalog.md](./conversation-session-case-catalog.md) | 已有自然语言 case catalog，包含当前 accepted、undefined 和扩展 case |
| [testing/conversation-session-e2e-coverage-matrix.md](./testing/conversation-session-e2e-coverage-matrix.md) | 自动化覆盖矩阵，只说明证据状态，不作为产品语义第一来源 |
| [testing/conversation-session-compact-decision-worksheet.md](./testing/conversation-session-compact-decision-worksheet.md) | compact 故障和 pendingAction 的决策工作单 |
| [testing/conversation-session-fork-cross-product-matrix.md](./testing/conversation-session-fork-cross-product-matrix.md) | fork 专项矩阵，收敛能否 fork、历史边界和未来状态继承 |
| `packages/shared/src/validationAppSettings.ts` | app setting `zcodeInteractionBehavior = queue | guide` 的校验与默认值 |
| `packages/shared/src/zcode-protocol-v4/` | command、snapshot、delta、topic 和 ACK 的当前 schema |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/` | command inbox、guard、projection、topic 发布和恢复的当前事实源 |
| `packages/ui/src/v4/ConversationComposer.tsx`、`conversationStatusPanelModel.ts`、`SessionPane.tsx` | composer 控制、停止/状态面板、命令派发和 projection 消费逻辑 |
| `packages/formal-proof/src/model.ts` | 当前形式化枚举器原型，作为协议可执行化参考 |

## Protocol Shape

conversation session 的行为协议按下面的裁决函数定义：

```text
ProductContext x InputEvent x TargetObject -> Guard -> Decision -> Effect -> Evidence
```

含义：

- `ProductContext`：用户动作发生前，session 可观察到的产品上下文。
- `InputEvent`：用户动作或系统异步事件。
- `TargetObject`：动作作用对象，如 composer、queue item、assistant turn、user query。
- `Guard`：当前组合命中的产品规则或剪枝条件。
- `Decision`：产品裁决结果。
- `Effect`：状态迁移、数据变化、UI 反馈和禁止副作用。
- `Evidence`：证明裁决正确的 UI、store、protocol、network、file 或 log 信号。

协议不是线性流程图。GUI 中用户下一步不可预测，所以先枚举候选组合，再由 guard 裁决。case catalog 和 E2E 只能从已确认的 guard/effect 派生，不能反过来替代产品协议。

## State Ownership and Product Projection

conversation 的核心产品状态已经以后置事实源为准：CLI / agent runtime 维护 canonical transcript、runtime work、command inbox 和 conversation product projection；UI 只保留无法后置或必须即时响应的局部交互状态。

这里的 projection 不是“虚拟 GUI”或 DOM 状态。它是 CLI/runtime 把 transcript、runtime facts 和产品 guard 归一后，提供给 renderer/web 的 conversation 产品视图。它回答“这一轮是什么、timeline 放哪、哪些动作可用、session 是否结束、输入应如何路由”，而不是回答“哪个面板展开、滚动条在哪、鼠标 hover 谁”。

```text
CLI / agent runtime
|-- canonical transcript
|   |-- messages[]
|   `-- parts[]
|-- runtime facts
|   |-- activeWorks[]
|   |-- backgroundWorks[]
|   |-- pending permissions / elicitations
|   `-- active turn / compact / goal / fork facts
|-- command inbox
|   |-- accepted commands
|   |-- running commands
|   `-- failed / rejected / duplicate commands
`-- conversation product projection
    |-- turns[]
    |-- rows[]
    |-- timeline events
    |-- action availability
    |-- input routing
    `-- session control
          |
          | @zcode/shared/zcode-protocol-v4 semantics
          v
Host / service
|-- trusted connection context
|-- owned-subscription routing
|-- owner / lease / stale-run routing
|-- continuous / replayable recovery facade
|-- latest projection cache (soft state)
`-- no new conversation semantics
          |
          | @zcode/rpc transport
          v
Renderer / Web UI
|-- render projection
|-- send user intents as commands
|-- optimistic overlay before ACK
`-- local-only UI state
```

当前 conversation schema 位于 `@zcode/shared` 的 `zcode-protocol-v4` 模块。旧
`packages/shared/src/zcode-protocol/index.ts` 仍服务非 V4 兼容面，但不是 V4 conversation 产品语义的
新增入口。`@zcode/rpc` 只负责 channel、call/listen、request/response、连接、日志和遥测，不拥有
conversation 产品语义。`productTurnId`、phase、actions、inputRouting、revision、seq 和 command ACK
属于 V4 protocol/projection，不属于 RPC。

| 层 | 应拥有的内容 | 不应拥有的内容 |
| --- | --- | --- |
| CLI / agent runtime | transcript、turn/runtime identity、active/background work、command guard、conversation projection | DOM、滚动、hover、面板展开 |
| Host / service | 可信连接上下文、owned subscription 路由、owner/lease、continuous/replayable 恢复、projection cache | 新增或修改 conversation 产品裁决、第二份 conversation queue |
| Renderer / Web UI | draft、cursor、scroll、hover、focus、panel open、optimistic pending/stopping overlay | turn 分组事实、timeline 归属、session endedness、action availability |

### Projection Shape

Conversation Product Projection 已是 UI 的权威输入。新产品语义必须优先落在 projection，而不是在 renderer 中用 message 数组位置和本地 flag 推断。

```ts
interface ConversationProductProjection {
  projectionVersion: number;
  revision: number;
  eventSeq: number;
  generatedAt: number;
  session: ConversationSessionProjection;
  turns: ConversationTurnProjection[];
  rows: ConversationRowProjection[];
  activeWorks: ConversationActiveWork[];
  backgroundWorks: ConversationBackgroundWork[];
  queue: ConversationQueueProjection;
  pendingCommands: ConversationCommandState[];
  actionAvailability: ConversationActionAvailability;
  inputRouting: ConversationInputRouting;
}
```

`rows[]` 是解决 turn 丢失和 timeline 错位的产品层索引。UI 应按 rows 渲染 conversation，而不是从 flat `messages[]` 里重新猜测 user/assistant/timeline 的边界。旧数据缺少强 anchor 时可以由兼容层生成 fallback rows，但 fallback 只能用于历史恢复，不能作为新数据协议。

分页元数据同样只描述当前 active branch：`totalCount` 是 active branch 的全序行数，
`firstRowId` 是 active branch 的全序首行，而不是本 session 曾经分配过的最小 `rowId`。
`rowId` 分配保持单调且 rewind 后允许留下空洞；当 `row.removed(fromRowId)` 从
`firstRowId` 或更早位置开始裁剪、因而裁掉整个 active branch 时，归约结果必须把
`totalCount` 清零并将 `firstRowId` 置空，后续新分支
首个 `row.appended` 再建立新的 `firstRowId`。UI 的“加载更早”只能表示 active branch 中
确有未加载前缀，禁止把 append-only 存储里的旧分支或 rowId 空洞解释为可分页历史。

```text
projection.rows
|-- turn:t1/input:user-msg-1
|-- turn:t1/assistant:msg-2
|-- turn:t1/worklog:compact-op-1
|-- turn:t1/post:goal-target-a-iteration-1
`-- turn:t2/assistant:msg-9              # background model-only wake 独立成轮，无可见 user trigger row
```

### Persistent Authority、Canonical Facts 与可寻址身份

conversation 的持久权威固定为 `message`、`part`、session metadata 和 goal state；
projection row、renderer store、内存 eventStore、`rowId` 与 DOM 顺序都不是这些事实的
第二权威。live event 和 cold hydration 必须先归一成同一组 canonical facts，再由唯一
resolver/materializer 生成 turn、row、action 和 command target：

```text
live SessionEvent --------------------\
                                       +-> CanonicalFact[] -> resolver -> projection
cold message/part/session/goal facts -/
```

- 已持久化正文、timeline、session metadata 与 goal 以持久事实为准；live 只补尚未持久化
  的 in-flight/ephemeral facts，并按持久实体键去重。
- `rowId` 只用于一次 projection/materialization 内的展示、虚拟滚动和 diff；刷新、冷恢复、
  fork 或 rewind 后允许变化，禁止作为 edit/retry/fork 的业务 target。
- 可操作 row 必须同时携带稳定 `entityId` 和 `productTurnId`；command payload 以稳定实体
  身份寻址，CLI 在同一 revision 原子生成 `row.actions` 与 command target。
- live 与 cold 的等价不只比较可见文本，还必须比较 canonical entity、turn 归属、action
  availability、command target、goal intent 和最终 session metadata。
- 用户 stop 导致的模型请求取消属于 `completed(interrupted)`，不是 `TurnError`。即使底层
  assistant message 为保留 provider 调试信息而持久化了 `error`，其中的 typed cancellation
  code/result 也必须在 cold hydration 时归一成 `TurnComplete(cancelled)`；历史数据中由
  ZCode 自身生成的标准取消错误需要兼容恢复。禁止仅因存在 `assistant.info.error` 就把取消
  重建为 `phase=error` 或填充 `control.lastError`。
- desktop `continuous` 与 mobile `replayable` 可以有不同中间帧；两端收敛后的 canonical
  facts 和终态 projection 逐字段相同。该交付差异不扩展成每条产品 case 的重复终态排列。

### Command and ACK Model

Renderer/Web 发起的会话动作应表达为 command intent，而不是直接改本地 conversation 事实。CLI/runtime 根据当前 projection revision、guard 和幂等键裁决，返回 ACK，并通过后续 projection/event 让 UI 收口。host 可以按 owner/lease 路由 command，但不能在 CLI 之外再建一份 accepted input queue。

```text
UI local intent
  -> command(commandId, clientId, baseRevision, type, payload)
  -> transport by @zcode/rpc
  -> host attachment injects {connectionId, trusted clientMode}
  -> guard / dedupe / enqueue / execute in CLI CommandInbox
  <- ACK accepted | rejected | stale | duplicate | failed
  -> projection revision increases
  -> UI reconciles optimistic overlay with projection
```

| ACK | 含义 | UI 结果 |
| --- | --- | --- |
| `accepted` | command 已进入权威 command inbox 或已立即执行 | 保留 optimistic 展示，等待 projection 确认 |
| `rejected` | 当前 guard 明确拒绝 command | 移除 optimistic 展示，显示协议给出的 reason |
| `stale` | command 基于过旧 projection，必须先刷新再重试或让用户确认 | 拉取最新 projection，不静默重放非幂等动作 |
| `duplicate` | 同一 `commandId` 已处理过 | 使用已有处理结果，避免重发导致重复消息或重复 stop |
| `failed` | command 已 accepted 但执行失败 | 按 fault catalog 展示错误并保留可恢复状态 |

所有会改变 conversation 的 command 必须具备幂等身份：`commandId`、`clientId`、`sessionId`、可选 `baseRevision` 和业务 target。`clientMode` 由 host attachment 可信注入，UI 不得自行选择。Web 秒级链路下，允许 UI stale；不要求每个 renderer 本地状态都实时同步。正确性边界是 `revision + eventSeq + snapshot/projection` 能把 UI 重新收口到权威状态。

### Connection、Subscription 与恢复边界

桌面窗口（包括 SSH/WSL/Docker）固定使用 `desktop-continuous`；手机 `/remote` 和 Web remote 固定使用 `web-remote-replayable`。两者可以订阅同一个 session，但每个 attachment 都有 host 分配的独立 `connectionId` 和独立 subscription registry，UI-facing subscribe 不能覆盖 profile。

```text
Desktop attachment A (continuous) ── sub-a ──┐
                                             ├─> CLI 同一份 projection/event log
Mobile attachment B (replayable) ── sub-b ──┘

frame(subscriptionId=sub-a) -> only port A
frame(subscriptionId=sub-b) -> only port B
port B saturated/resync      -> 不影响 A
```

下行帧必须按 `subscriptionId` 只送到 owner port，禁止 workspace 广播后再由客户端丢弃别人的帧。snapshot 整体替换；迟到帧 `toSeq <= localSeq` 静默丢弃；gap 只触发一个在途 resync，resume 再断档升级为强制 snapshot。attachment 重建或 CLI runtime epoch 变化后自动重订阅。relay/main 只透传 RPC payload 和连接级 `saturated/drained` 信号，不持有 session、stream、queue、snapshot 等 conversation 业务状态。

冷恢复的会话身份只来自 host 可信注入的 `workspace`：`conversation/subscribe`，以及会在 runtime 不在内存时冷恢复的只读查询（`rowsRange`、`plans`、`fileChanges`、`fileRewindPreview`、附件读取与上传开始、workflow run 读面）和命令信封都带可选 `workspace`，renderer 不传。CLI 不能按存储的 cwd 重建身份：受管 worktree 会话的 key 是项目、cwd 是 worktree（`docs/git/worktree.md` §9.3）。host 只对本地 workspace 注入。

ACK 丢失或重连时，UI 通过 `commands/query`（每次最多 64 个 `{sessionId, commandId}`）对账。CLI 固定按“内存 LRU -> transcript/message anchor -> timeline marker -> fork child metadata -> discarded input ledger -> unknown”查找；同 key 的查询与执行共享 single-flight，避免查询窗口诱发重复执行。

同一 `commandId` 已在执行时，duplicate request 与 `commands/query` 都等待该 in-flight command
的同一个 final-result promise；禁止提前返回缺少 `result` 的 admission ACK。无论最终 accepted、failed
或 noop，promise settle 后才释放该 session 的 admission FIFO，异常路径也必须释放，避免后续命令死锁。

```text
first request ── execute once ──> final ACK(result=child-X) ──> release session FIFO
duplicate    ── await same promise ─────────────────────────> duplicate(result=child-X)
commands/query ─ await same promise ────────────────────────> accepted(result=child-X)
```

## Product Context

### Session Phase

| 值 | 含义 |
| --- | --- |
| `draft` | 尚未创建正式 session，用户仍在输入首条 query |
| `prewarming` | 首发已提交，session 正在准备或首轮尚未进入稳定 running |
| `running` | 当前 session 有 active foreground turn 或 completion-blocking active work 正在执行，包括 assistant/tool/foreground subagent/compact/goal verifier/goal continuation/turn-steer |
| `completed(success)` | 当前 session 的 completion-blocking active work 都已正常收口，可接受下一步动作；允许仍有 background work pending |
| `completed(interrupted)` | 用户 stop 或等价中断已经终止 completion-blocking active work，可接受下一步动作；允许仍有 background work pending |
| `error` | session 进入错误态；具体恢复语义由 fault catalog 定义 |

`compacting` 和 `goalVerifying` 不是与 `running` 平级的顶层 phase；它们是 `running` 内部的 active work kind。本文后续若需要表达这两种上下文，使用 `activeWork.kind=compact` 和 `activeWork.kind=goalVerifier`。

没有独立的 `paused` 产品状态。停止生成后，必须先终止当前 session 的 completion-blocking active work，才进入 `completed(interrupted)`；如果 queue 里有消息，queue 保留且 `autoDrain=false`。background-only cancel 不属于 session stop。

### Active Work and Completion Gate

session 是否完成不能只看 assistant stream 是否结束，而要看 session 归属的 completion-blocking active work 集合是否清空。本文中的 `activeWork` 默认指会阻塞 `sessionEnded` 的 foreground work；background bash 和 background subagent 是 session-owned background work，不阻塞 session completion。

可以把一个 conversation session 理解成下面这样的文件夹。`foreground-work/` 下面的每一项都属于当前 session 的 completion gate；只有这个目录清空后，`sessionEnded` 才能为 `true`。`background-work/` 仍归属当前 session，但不把 session 锁在 running。

```text
session/
|-- identity-and-config/
|   |-- sessionId
|   |-- workspace identity
|   |-- provider/model/thought config
|
|-- queue/
|   |-- deferred sendText
|   |-- deferred sendGoalCommand
|   `-- other future input allowed by guards
|
|-- foreground-work/                  # decides sessionEnded
|   |-- primary-turn/
|   |   |-- assistant/model stream
|   |   |-- tool calls and blocking requests
|   |   `-- tool results
|   |
|   |-- subagents/
|   |   `-- foreground subagent
|   |
|   |-- compact/
|   |   |-- manual compact
|   |   `-- auto compact pendingAction
|   |
|   |-- goal/
|   |   |-- goal verifier
|   |   `-- goal continuation
|   |
|   `-- turn-steer/
|       `-- guide-mode follow-up not yet drained
|
|-- background-work/                  # does not decide sessionEnded
|   |-- background bash
|   `-- background subagent
|
|-- continuation-inbox/
|   `-- backgroundResult -> synthetic user input for a future foreground run
|
`-- lifecycle/
    |-- draft
    |-- busy: prewarming/running while foreground-work/ is not empty
    `-- completed(success/interrupted) once foreground-work/ is empty
```

| Completion-blocking Active Work | 含义 | 完成门槛 |
| --- | --- | --- |
| `primaryTurn` | 当前用户输入触发的主 assistant turn、模型流、工具调用或阻塞请求 | 收到正常完成、失败收口或 stop 中断收口 |
| `foregroundSubagent` | 主 turn 派生且需要在当前 assistant 回合内汇总的子 agent、child request | foreground 子 agent 完成、失败或被 stop 终止 |
| `compact` | manual compact 或 auto compact 的压缩请求和 pendingAction 前置维护 | compact 完成、noop、失败或被 stop 终止 |
| `goalVerifier` | goal target 的达成验证请求 | verifier 返回 pass/notSatisfied、failed 或被 stop 终止 |
| `goalContinuation` | goal 未完成后自动续跑的下一步执行链路 | 续跑完成、进入下一轮 active work、或被 stop 终止 |
| `turnSteer` | guide 模式提交给运行时但尚未确认 drained 的后续引导 | 被运行时确认、拒绝、回退到 queue 或被 stop 收口 |

| Background Work | 含义 | 产品收口 |
| --- | --- | --- |
| `backgroundBash` | 主 turn 派生但声明为后台运行的 bash/process work | 不阻塞 `sessionEnded`；完成后产生 background result |
| `backgroundSubagent` | 主 turn 派生但声明为后台运行的 subagent | 不阻塞 `sessionEnded`；完成后产生 background result |
| `backgroundResultContinuation` | background result 回到 main session 后触发的后续输入 | 进入 `continuation-inbox`；可启动新的 foreground run 或在 busy/held 状态下排队 |

`BackgroundTaskStarted/Updated/Completed` 必须携带 runtime 已裁决的
`taskKind: "bash" | "subagent"`；`toolName` 只保留工具来源和旧事件兼容用途，不再作为新
projection 的产品分类权威。兼容旧事件时必须通过同一个 legacy resolver 识别
`Agent`、`Task`、`subagent` 等历史别名，禁止 reducer、service 和 UI 各自维护字符串判断。
`backgroundWorks[].kind`、取消能力和 UI 图标均从这一 canonical fact materialize，保证
desktop continuous 与 web replayable snapshot 的终态分类一致。

`completed(success)` 和 `completed(interrupted)` 都要求 completion-blocking `activeWork=empty`。如果 `assistantComplete` 到达时还有 foreground subagent、compact、goal verifier、goal continuation 或未收口 turn-steer，session 仍然是 busy，不能进入 completed，也不能开放 completed-only 操作。background bash/subagent 不参与这个 completion gate；它们仍归属父 session，但只通过 `hasBackgroundWork`、background drawer 或 continuation inbox 暴露。

background result 回到 main 后，provider 视角可以用 `role=user` 作为下一轮输入，但产品/协议层必须保留 `origin=backgroundResult`、`backgroundSource=bash|subagent`、`humanAuthored=false` 等价信息。它不是用户手写 query，不能自动继承 edit user query 或普通 retry 的入口语义；如果它已经 materialize 成 fork 点之前的可见 transcript，则按普通稳定历史参与 fork，否则 pending background result 不复制给 fork child。

普通 retry 必须先锁定全时间线最新一条 `assistantText`，再检查同一个 product turn 是否有 `origin=realUser` 的 canonical user input。background result、goal continuation、mailbox 等 model-only/synthetic turn 即使成为最新 assistant，也不显示普通 retry；此时更早由真实用户触发的 assistant 也不能重新获得 retry。下一次真实用户输入完成新的 assistant turn 后，retry 才转移到这个新的最新 turn。

```text
真实用户 Q1 -> assistant A1 [retry]
                       |
                       +-- background 完成 -> synthetic wake -> assistant B1
                                                     |             |
                                                     |             +-- no retry
                                                     +-- A1 no retry（不回退复活）

真实用户 Q2 -> assistant A2 [retry]  # A2 成为新的全时间线最新 assistant，且有 realUser cause
```

当 background result 触发 main 继续运行时，UI 的“已工作多久”抽屉使用一个新的 foreground work interval，不把后台等待时间并入上一次 assistant interval。产品观感可以是“会话突然又开始了”，但状态上是 background result 触发的新 foreground run。

本文中的 `sessionBusy` 指 `prewarming`、`running`，或任何 completion-blocking `activeWork!=empty` 的上下文。仅有 `backgroundWork!=empty` 时，`sessionBusy=false`，completed-only 操作可以按各自 guard 开放。

### Session Endedness and Input Routing

`sessionEnded` 是产品态派生值，只回答一个问题：当前 composer 输入是否可以立即成为下一轮 active turn。它不重定义 agent/runtime hook 的触发时机，也不把某个 hook 当成产品完成门槛。它必须来自 CLI/agent runtime facts 或 host/service 对这些 facts 的规范化投影，UI 不能只靠 assistant 文本流、timeline 横条或本地 `streaming` 状态自行判断。

| 判定 | 条件 | 产品含义 |
| --- | --- | --- |
| `sessionEnded=false` | `prewarming`、`running`，或任何 completion-blocking `activeWork!=empty` | 当前 session 仍未结束；composer 新输入是未来意图，不能直接启动第二条 active turn |
| `sessionEnded=true` | `completed(success)` 或 `completed(interrupted)`，且 completion-blocking `activeWork=empty`；`backgroundWork` 可为非空 | 当前 session 已结束；completed-only 操作开放，普通输入可按 queue 状态启动下一轮 |

当 `sessionEnded=false` 时，普通 `sendText` 默认进入 queue；如果处在 `running + followupInput.mode=guide` 且满足 turn-steer 条件，则按 guide 规则提交给运行时，否则回退 queue。`sendGoalCommand` 同样进入 queue，消费时才设置或更新 goal。

`/compact`、fork、edit 和 `sendQueuedNow` 不因 `sessionEnded=false` 自动入队。它们必须命中各自 guard：例如 busy 中的 `/compact` 仍 reject；`sendQueuedNow` 只有在明确允许抢占消费的上下文中才能先 stop 再 drain；fork 按目标 assistant turn 是否稳定裁决，不因父 session 正在普通 running 就一刀切 reject。`activeWork.kind=compact` 保持操作锁；`activeWork.kind=goalVerifier` 不是独立操作锁，消息类输入照常入队，stop 可中断 verifier。

### Runtime Facts and Control Projection

session 生命周期状态分三层。第一层是 CLI/agent runtime 的事实和 product projection；第二层是 host/service 的传输、owner routing、缓存和 replayable 恢复；第三层才是 UI 渲染和 optimistic overlay。

```text
CLI / agent runtime facts + product projection
  |-- activeWorks[]                  # completion-blocking foreground work
  |-- backgroundWorks[]              # background bash/subagent, does not block sessionEnded
  |-- backgroundResult facts
  |-- activeTurnKind
  |-- activeInputId / runId
  |-- compact timeline fact
  |-- goal target / verifier / continuation fact
  |-- foreground subagent fact
  |-- background bash/subagent fact
  |-- pending requests / permissions / tool calls
  |-- sessionEnded
  |-- hasBackgroundWork
  |-- canStop
  |-- stopState: idle | stoppable | stopping
  |-- stopTargetKind
  `-- inputRouting: startNow | enqueue | guide | reject

Host / service transport and recovery layer
  |-- expose latest projection over RPC
  |-- route owner commands
  |-- preserve replayable watermarks / snapshots
  `-- cache but do not invent conversation semantics

UI
  |-- render stable stop button from canStop/stopState
  |-- route composer submit from inputRouting/sessionEnded
  |-- show detail text from stopTargetKind, not from local guessing
  `-- keep local-only draft / scroll / focus / optimistic overlay
```

事实层必须由 CLI/agent runtime 产生。host/service 可以从 CLI snapshot、event stream 和 replayable gap recovery 中规范化、缓存和转发 projection，但不能独立定义新的 conversation 产品裁决。UI 可以做短暂 optimistic `stopping` 展示，但不能把 session 宣告为 ended；真正 ended 必须等 completion-blocking `activeWorks=[]` 或等价的 `sessionEnded=true` 投影到达。`backgroundWorks[]` 只能影响 background drawer、continuation inbox 和后台取消入口，不能单独把 `sessionEnded` 改回 `false`。

产品控制层用于让 UI 保持粗粒度、稳定的交互壳，同时不丢内部细节：

| 字段 | 值 | 含义 |
| --- | --- | --- |
| `sessionEnded` | `true` / `false` | 是否允许 composer 输入立即成为下一轮 active turn |
| `hasBackgroundWork` | `true` / `false` | 当前 session 是否仍有 background bash/subagent pending；不决定主停止按钮 |
| `canStop` | `true` / `false` | 当前 session 是否存在可被用户 stop 终止的 completion-blocking active work |
| `stopState` | `idle`、`stoppable`、`stopping` | 停止按钮的稳定展示态；点击后可 optimistic 进入 `stopping`，直到权威投影收口 |
| `stopTargetKind` | `assistant`、`tool`、`subagent`、`compact`、`goalVerifier`、`goalContinuation`、`mixed`、`unknown` | 当前 stop 将主要作用于哪类 work；只影响 tooltip、日志、埋点和细节文案，不决定按钮是否闪烁 |
| `inputRouting` | `startNow`、`enqueue`、`guide`、`reject` | 当前 composer 输入的产品裁决摘要，必须能追溯到 rule table guard |

停止按钮不应该在 `assistant -> compact -> goalVerifier -> goalContinuation` 这类 active work 交接中闪烁。只要 `canStop=true` 或 `stopState=stopping`，UI 就保留同一个停止按钮；`stopTargetKind` 变化只能更新 tooltip/辅助说明，不能让按钮先消失再出现。

`stop` 本身仍是 session 级用户动作。点击 stop 后，CLI/agent runtime 根据当前 completion-blocking active work 精确执行：assistant 输出中止 assistant/tool/foreground subagent，compact 中止 compact，goal verifier 中止 verifier，goal continuation 中止 continuation。仅有 background work pending 时，session 主停止按钮不应继续显示；background bash/subagent 的取消走 background task control，不改变 `sessionEnded`。若 goal target 处于 `active`，任意 foreground stop 都必须把 target 置为非 active 的暂停态，后续只有显式 resume 才能重新激活。

### Stop Priority

`stop` 是 session 内最高优先级用户动作。只要当前 session 不是 completed，`stop` 都优先于 queue drain、guide 注入、auto goal continuation、compact pendingAction 和迟到的 runtime terminal event。

| 场景 | 协议 |
| --- | --- |
| `running + stop` | 终止 primary turn、工具/阻塞请求、所有运行中的 foreground subagent、goal continuation、goal verifier 和未确认的 turn-steer |
| `running + activeWork.kind=compact + stop` | 终止当前 compact；manual/auto compact 不能继续写入成功结果，auto compact 的 pendingAction 不能在 stop 后自动执行 |
| `running + activeWork.kind=goalVerifier + stop` | 终止当前 verifier；本次 verifier 归为 `failed(cancelled)`，不能再触发 pass/notSatisfied 后续动作 |
| `running + sendQueuedNow` | 等价于先执行最高优先级 `stop`，等 completion-blocking active work 清空后再消费被点 queue item；`activeWork.kind=compact + sendQueuedNow` 仍按操作锁 reject；`activeWork.kind=goalVerifier + sendQueuedNow` 允许走 stop barrier 后 drain |
| `stop requested + late terminal event` | 迟到的 foreground subagent/compact/verifier/assistant 完成事件只能收口被 stop 的旧 work，不能把 session 重新置为 success，不能覆盖新一轮 active input |
| `backgroundWork only + stop` | 主停止按钮不可用；若用户从 background drawer 取消，走 background task cancel，不等同于 session stop |

`stop` 不是普通 queue item，不能排队等待。实现上可以存在短暂 `stopRequested` 标记或 UI “stopping” 展示，但它不是独立产品 phase；最终只有 completion-blocking active work 清空后的 `completed(interrupted)`、明确失败后的 `error`，或后续重新开始的新 active turn。

### Queue

| 维度 | 值 | 含义 |
| --- | --- | --- |
| `queue.length` | `0`、`1`、`2`、`3+` | GUI 展示和 case 收敛用的长度等价类 |
| `queue.autoDrain` | `true`、`false` | 当前轮完成后是否自动消费队首 |

queue 表示未来用户意图，不属于已完成历史。所有来自桌面或手机、已经提交且在 busy/running 中不能立即启动的输入，都由同一个 CLI/runtime `CommandInbox` 按串行 admission 顺序进入权威 FIFO；桌面 renderer-local queue 和手机 host runtime command queue 都不是 V4 的第二事实源。UI 只保留未提交 draft 和短暂 optimistic overlay。

每个 queue item 必须是自包含的 `ConversationInputIntent`，至少守恒 `sourceCommandId`、`queueItemId`、`clientId`、输入 kind、原文、attachments、delivery/fallback、admission 顺序以及 steer/dispatch 状态。queue item、drain/guided event、user row 和 transcript message anchor 使用同一个原始 `sourceCommandId`；edit、promotion 或 send-now 不得换成操作命令的新 id。

例如：`running + sendText` 可入队为 deferred `sendText`；`running + sendGoalCommand` 可入队为 deferred `sendGoalCommand`；`running + sendCompactCommand/clickCompact` 必须 reject，不能因为 `/compact` 也是 slash command 就进入 queue。未来新增 command 时，也必须先在 rule table 中声明它在各状态下是 `allow`、`enqueue` 还是 `reject`，不能自动继承 `/goal` 的入队语义。

edit、compact、fork 不应改写 queue 内容；fork 新 session 不复制父 queue。queue 真正消费时，才按消费时 session 的最新上下文、模型、思考深度执行。

`editQueueItem` 原地修改权威 item 的文本、附件与模型/mode/Plan 配置，保留 ID、位置、kind、client 和来源 command，并释放编辑锁。编辑期间 `lockQueueItemEdit` 冻结该项（`queueItem.editLock`），自动 promotion 到冻结队首即暂停；冻结项拒绝 send-now/delete/reorder，`releaseQueueItemEdit` 可由任意端解除（见 [Composer 编辑态](ui/composer-edit-mode.md)）。`sendQueuedNow` 采用 `reserve -> stop barrier -> start/promote -> remove`：只有启动成功才移除；timeout 或失败释放 reservation，原 item 原位保留；连续点击或跨端竞争只能有一个 reservation owner。

queue 只保证当前 CLI 进程内可靠。CLI runtime restart 后，上一进程已 admitted 但尚未进入 transcript 的输入进入 discarded ledger，`commands/query` 返回 `fault.command.inputDiscardedOnRestart` 及持久 `delivery`。UI 的 24 小时 pending-command registry 只覆盖投递未知窗口（敏感 interaction 只存 digest）：queue/guided projection 一到即清账；restart query 的 `queue/guide` 静默清账；无权威结论的 `unknown` 保留待确认线索直到明确结果、权威投影或既有 TTL，且不显示 UI 错误；只有未进入 transcript 的 `startNow` 提示用户确认重发，禁止自动恢复或自动重放。

background result 如果在 foreground busy、compact、goal verifier 或 held queue 阶段返回，必须先进入 `continuation-inbox` 或等价的 deferred queue item。它可以在后续 provider 请求中以 `role=user` 出现，但 queue/event 必须保留 `origin=backgroundResult`，避免被误当作用户手写 query、误开放 edit，或被 fork child 复制为 pending future input。

background result 真正触发 model-only wake 时，无论 live 还是 cold 都必须新建独立
`productTurnId`。该轮没有可见 user trigger row，只显示自己的 assistant/work rows；不得因
复用 runtime turn、到达顺序或刷新恢复而并入上一条真实用户轮。

### Follow-up Input Mode

`followupInput.mode` 定义同一个 session 正在 `running` 时，用户从 composer 继续输入普通后续内容的处理方式。它不是 queue item 的类型，而是 running follow-up 的路由策略。

| 值 | 默认 | 含义 |
| --- | --- | --- |
| `queue` | 是 | 后续普通文本进入 CLI 权威 queue，等待当前 active turn 完成或用户显式 `sendQueuedNow` |
| `guide` | 否 | 符合条件的后续普通文本进入 agent-side turn steering，作为当前 active turn 的后续引导；不符合条件时回退到 CLI queue |

`guide` 模式不表示可以改写已经发给 provider 的 in-flight 请求。它只允许把完整 input intent 提交给运行时的 turn-steer 机制，等待运行时确认注入、拒绝或回退。guide 不适用、带 attachments、compact/verifier busy 或 runtime 拒绝 steer 时，必须以原字段回退 CLI queue。empty、超限或 admission/runtime reject 必须返回显式 `rejected/failed`，让 UI 保留文本与附件。无论是 `queue` 还是 `guide`，用户输入都必须保留：不能从 composer 或临时状态消失后，既不在 queue/guided row/transcript 中，也没有显式 `rejected/failed/discarded` 结果。

运行时确认注入一条 guide 后，产品轮次不变，但 CLI 必须在 `turnHeader.workSegments` 中关闭上一 visual work segment，并以 guided user 的稳定实体 ID 开启新 segment。同一次取出的多条 guide（两条之间没有主模型 step）只由第一条开启一个 segment，后续 guide 并入该段；两条 guide 之间有模型 step 时，即使这一步没有可见行，后一条也开启新 segment。CLI 按模型 step 判定边界：live 由主模型流事件与主轮 `ModelComplete` 关闭当前取出，cold hydration 为每条 assistant 消息合成同样的流起始事件，两边得到同一份 segment。UI 只按 `workSegments[].triggerEntityId` 切分视觉工作段，不自行判断是否同一次取出；缺少 turn header 或 `workSegments` 的旧快照才回退为“上一行已是 guided user 时并入”。UI 为每个 segment 独立展示和折叠“已工作/工作中”；这只是工作区边界，不改变最终 assistant 的 fork/retry/action 归属。

`followupInput.mode` 只决定普通 assistant 运行态中普通文本是排队还是尝试 guide。对于 `activeWork.kind=compact`、`activeWork.kind=goalVerifier` 等 `sessionEnded=false` 但不可 steer 的上下文，guide 不生效，普通文本和 `/goal` 都按 deferred input 进入 queue。

当前已确认的边界：

| 场景 | 协议 |
| --- | --- |
| `running + followupInput.mode=queue + sendText` | 入队为 deferred `sendText`，不打断当前 active turn |
| `running + followupInput.mode=queue + sendGoalCommand` | 入队为 deferred `sendGoalCommand`，消费时设置或更新 goal |
| `running + followupInput.mode=guide + sendText + guide eligible` | 进入 turn-steer submitting/queued 状态，或被运行时确认后投影为 guided user message |
| `running + followupInput.mode=guide + sendText + guide ineligible` | 回退为 deferred `sendText` queue item |
| `running + followupInput.mode=guide + sendGoalCommand` | 仍按 `sendGoalCommand` 的状态规则处理；当前语义是入队为 deferred `sendGoalCommand`，除非后续 rule table 明确接受 goal steering |
| `activeWork.kind=compact/goalVerifier + sendText/sendGoalCommand` | 入队为 deferred input，不启动新 turn，不打断当前 active work |
| `running + sendCompactCommand/clickCompact` | 不受 follow-up mode 影响，始终 reject，不入队、不作为普通消息、不启动 compact |
| `sendQueuedNow` | 是显式 queue 抢占消费动作，中文 UI 可称“立即引导”；它不等同于 `followupInput.mode=guide` |

### Compact

| 维度 | 值 | 含义 |
| --- | --- | --- |
| `compact.origin` | `manual`、`auto` | 用户主动触发或系统前置维护触发 |
| `compact.memory` | `never`、`compactable`、`justCompacted`、`notNeeded` | 当前上下文是否需要或允许继续 compact |
| `compact.canCompactAgain` | `true`、`false` | 刚 compact 后再次 compact 是否还可能产生有效压缩 |
| `compact.pendingAction` | 普通发送、queue item、queued goal、edit rerun 等 | auto compact 成功后应继续执行的动作 |

auto compact 是系统插入的前置维护步骤，不占用户 queue。它围绕一个 `pendingAction` 运行；成功后继续 `pendingAction`。auto compact 被 stop 后不能继续执行 `pendingAction`；`pendingAction` 是回 held queue、保留为待用户确认还是丢弃，仍由 compact decision worksheet 确认。

### Goal

| 值 | 含义 |
| --- | --- |
| `none` | 当前 session 没有 goal target |
| `active` | 当前 session 有未完成 target |
| `verifying` | verifier 正在判断 target 是否达成 |
| `verified` | verifier 已判断达成 |
| `notSatisfied` | verifier 正常完成，但判断当前 target 尚未达成 |
| `failed` | verifier 被中途取消、接口失败、超时或内部异常，未能产生有效达成判断 |

`notSatisfied` 和 `failed` 必须分开。`notSatisfied` 是有效验证结论，表示目标还没完成，后续可以继续自动续跑、等待用户输入或按 goal 规则处理 queue；`failed` 是验证过程失败，表示这次 verifier 没有可靠结论，不能被当作“目标未完成”的业务判断。

`/goal xxx` 表示设置或更新 session goal。没有 goal 时是设置，已有 goal 时是更新。running 中的 `/goal` 是未来意图，应进入 queue，消费时再设置或更新 goal。

`goalSet` lifecycle/state fact 只更新 goal state，不单独生成 timeline marker/row；它和用户
提交的 goal input 是两条不同事实。每条已被接纳并 materialize 的用户 goal input 必须生成
canonical、可见的 real-user row，并和普通 text query 一样使用统一 `editUserQuery` action/
target。只有当前 active branch 的 latest real-user input 可编辑；当它是 goal input 时，稳定
`entityId/productTurnId` 必须反查原始 `ConversationInputIntent(kind=goal)`，重发仍路由为
`sendGoalCommand`，不能退化成普通 `sendText`。goal state 的冷恢复以持久 goal 事实为权威，
不能只从可见 `/goal` 文本反推。

### Fork

Fork 是从父 session 的某个稳定 assistant turn 派生 child session。它不是复制当前窗口状态，也不是复制父 session 的未来动作队列或 live background work。父 session 可以正在执行新的 foreground turn 或 background work；只要 fork 目标本身已经是稳定 assistant 历史，就可以 fork。

| 维度 | 协议 |
| --- | --- |
| `fork.sourceSession` | 触发 fork 的父 session |
| `fork.target` | 必须是 `completedSuccess` product turn 最后一段 completed assistant；当前 streaming/interrupted/failed partial、中间 assistant 段都不是 fork target |
| `fork.historyBoundary` | CLI 唯一 resolver 固定返回 turnId、ordered messageIds 和 boundaryMessageId；child 只继承边界及之前的稳定可见 transcript |
| `fork.configSnapshot` | child 继承 fork 点持久化的 provider、model、思考深度配置，不读取父 session fork 时刻的后续配置 |
| `fork.goalSnapshot` | child 继承 fork 点之前的 goal target、iteration 和 verifier timeline |
| `fork.queuePolicy` | 父 queue 保留；child queue 为空 |
| `fork.backgroundPolicy` | 父 session 的 live background bash/subagent、pending background result 和 continuation inbox 不复制到 child；已在 fork 点之前 materialize 成稳定 transcript 的 background result 才会随历史复制 |
| `fork.workspacePolicy` | running fork 只复制对话，不 rewind 共享 workspace；completed/idle 既有 checkpoint 行为本轮不扩大 |
| `fork.timeline` | fork notice 是 turn boundary，不进入 assistant 工作历史，也不被“已工作”折叠 |
| `fork.targetCwd` | 可选 `{ cwd, childSessionId, worktreeCreation }`。缺省时 child 在父 cwd；带上时 child 留在父 workspace，cwd 换成受管 worktree，ID 用 Host 预分配值，仍只复制对话 |

`forkAssistant.targetCwd`（受管 worktree 的“在新 worktree 中分叉”使用，见 `docs/git/worktree.md` §8.2、§9.3）：

- payload schema 是 strict 的 `{ cwd: string; childSessionId: string; worktreeCreation: { path, sha, ref, output } }`，App 与 CLI 共用 `@zcode/protocol` 中的同一份 schema。附加目录不在 payload 里，由 Host 在 child 的 create/resume/subscribe 时下发。
- child 留在父会话的 workspace（key 与进程不变），`directory`/`path` 为 `cwd`，`projectID` 按 cwd 映射回源仓库的路径派生；父 session 的会话级 `allow` 规则不进入 child，`deny`/`ask`/`mode` 保留。不回退、不恢复任何目录的 checkpoint。child 时间线在 fork 分隔标记后显示 `worktreeCreated` 标记。
- 幂等键仍是 fork 命令的 `commandId`：同一 commandId 重试返回同一 child。
- 第一版只支持本地 workspace；父会话在远程 workspace 时返回 `guard.worktreeCwdLocalOnly`。
- Host 必须先确认 `runtime/capabilities.worktreeCwd === true` 才能发送该字段。旧 CLI 会静默丢弃未知字段并 fork 到父目录。
- 不带 `targetCwd` 的 fork 在 worktree 会话中执行时，child 的 `directory` 继承父会话的 worktree；Host 首次写入 child 任务行时从父行继承 `root_path` 与 `worktree_root`（`docs/git/worktree.md` §3.6）。

Fork 的允许性按“历史是否稳定”裁决：

| 前置 | 目标 | Decision | 说明 |
| --- | --- | --- | --- |
| `completed(success)` 或 `completed(interrupted)` | assistant message/turn | `allow` | 创建 child session，继承 fork 点前历史和 fork 点持久化配置 |
| `running + activeWork.kind=primaryTurn/foregroundSubagent/goalContinuation/turnSteer` | 稳定 historical assistant message/turn | `allow` | 父 session 正在运行不等于 fork 目标不稳定；child 只继承 fork 点前历史，不复制当前 active work |
| `backgroundWork!=empty`，无论父 session 是否 completed | 稳定 assistant message/turn | `allow` | background bash/subagent 不阻塞 fork；live background handle 和 pending result 仍只属于父 session |
| `prewarming` 且没有稳定 assistant target | 任意 assistant message/turn | `reject` | 尚无可作为 fork 边界的稳定 assistant 历史 |
| `activeWork.kind=compact` | 任意 assistant message/turn | `reject` | compact 正在改写/维护上下文边界，不能同时创建 child |
| `activeWork.kind=goalVerifier` | 稳定 assistant message/turn | `allow` | verifier 正在运行不等于历史目标不稳定；child 只继承 fork 点前稳定历史，不复制 verifier 或后续 goal loop |
| 任意状态 | 当前 streaming assistant partial | `reject` | partial 还不是稳定 transcript 边界，不能作为 fork 点 |
| `error` 或 failed/error partial，且未形成 `completed(interrupted)` 产品最终态 | assistant partial | `reject` | partial 历史不稳定，不能作为 fork 点 |
| 任意状态 | user message、tool message、timeline marker | `reject` 或入口不存在 | fork 点只定义在 assistant message/turn 上 |

父 session 后续仍按自己的 queue、goal、config、foreground/background work 和运行状态继续，不受 child session 影响。running fork 不经过要求 idle 的 legacy bridge，也不恢复、回滚或复制共享 workspace checkpoint；child 只得到稳定 transcript、fork 点持久化配置和 fork 点之前的 goal 状态。child session 后续请求使用 fork 点配置快照，之后再按 child 自己的配置变化演进。父 session 的 background bash/subagent 如果在 fork 后返回，只能唤醒父 session；不能回调到 child，也不能在 child 中生成 synthetic user input。

新数据以持久化 turn anchor 为准；旧 transcript 只有在逻辑 turn 边界无歧义时才允许 fallback，否则返回 `guard.forkTargetAmbiguous`。包含工具调用的 turn 按逻辑边界复制工具块、工具结果、最终 assistant 和该 turn 已产生的文件事实，不能只按最后一条 raw assistant 截断。同一 `sourceCommandId` 重试必须返回同一个 child。

稳定 fork 的创建是一个原子持久化操作：child session metadata、复制后的 message/part、
goal snapshot/verifier entry、fork provenance、child projection 所需 anchor、child initial input
admission、parent accepted command fact 必须在同一事务全部成功后才注册/启动 child。该 bundle
只服务显式 fork；compact-covered edit 在原 session 提交 branch cut，不创建 hidden child。
所有 child-local message/part/tool/timeline/compact/goal 引用必须通过同一份映射表重写为 child
实体；只允许显式 `originRef`/provenance 继续指向 parent。任何不可解析或不可 remap 的
child-local 引用都使 fork 失败且不发布半成品 child，不能靠 renderer fallback 修补。事务提交后
若 child runtime 同步启动失败，parent 的 edit ACK 与 `commands/query` 仍保持 accepted/指向同一 child；
child initial input 必须持久转为 `failed(fault.command.childStartFailed)`，并在 child projection 产生
可恢复的 `TurnError`，重启时不得把该 failed 终态再次改写成 discarded。

`ForkIdentityMap` 在事务前一次性预分配 session/message/part/tool-call/turn/product-turn/goal-target/
verifier-entry/verification identity；stable fork 只服务显式 `forkAssistant`，不得被 edit/retry
隐式复用。
message parent、`MessageInfo.anchor`、timeline/compact refs、goal/verifier refs 和 fork notice 都只能消费这份
map。legacy workspace fork 可以保留原 checkpoint 策略，但 V4 入口不得调用 child-only metadata create
或逐条 copy/后补 goal/fact 的兼容路径。

该原子性不扩大 workspace rewind 语义：running stable fork 是 conversation-only，不恢复
共享 workspace checkpoint；completed/idle fork 的既有 checkpoint 行为本轮不改变。

### Edit 与 Retry

- 统一 `editUserQuery` 只允许当前 active branch 的最后一条 `humanAuthored=true` real-user
  input；它可以是普通 text query 或用户提交的 goal input。更早 real-user input、synthetic/
  model-only/background result、assistant、tool 和 timeline 都不提供 edit。
- latest real-user input 无论是否已被 compact summary 覆盖，都在原 session 通过 append-only
  branch cut rewind 到该 intent，再用编辑后的完整 intent 重跑；text 仍走 `sendText`，goal
  仍走 `sendGoalCommand`。旧 message/part 不物理删除，但不再属于 active projection、模型上下文
  或冷恢复分支；显式 `forkAssistant` 是唯一创建 child 的入口。
- branch cut 必须先于 compact scope 应用：先得到 `kept prefix + branch cut 后新消息`，再在这条
  active branch 内选择最后一个 compact boundary 构建模型历史。跨过的 compact summary、
  full/microcompact 派生状态全部失效；目标之前仍处于 active branch 的最近 compact 保留。
- conversation rewind 不追加 provider-visible `rewind_notice`，模型只能看到保留前缀和替换后的
  canonical intent。持久层使用 `branchCutAfterMessageID + branchGeneration` 识别新分支，并兼容
  旧 `createdMessageID` 数据。
- `editUserQuery.workspaceMode=preserve|rewind` 区分“只重置对话”和“对话 + 文件重置”。组合模式
  在同一 command 内重新预检并倒序恢复 checkpoint；任一 unsafe、ignored shell、unsupported
  或无安全 checkpoint 都返回结构化 blocked，文件、对话和 provider request 全部不变。
- primary turn、goal continuation 或 goal verifier 正在运行时，latest real-user input edit
  （包括 latest goal input）先进入
  stop barrier；只有旧 completion-blocking work 全部终态收口后，才执行原 session rewind。
  barrier 失败时不得 rewind、不得启动新的 text/goal intent，必须保留旧 active
  work、原输入与当前 branch，也不发送编辑后的 provider 请求。
- `activeWork.kind=compact` 是统一 edit、fork、retry、sendQueuedNow 的操作锁；这些动作全部
  reject，且不得 stop compact、不得入队、不得产生 command target 的半成品副作用。
- retry 必须从目标 product turn 的 canonical cause 恢复完整原始
  `ConversationInputIntent`（kind、text、attachments、goal intent、delivery/fallback 与来源
  cause），不能从可见 user 文本重新拼请求；由 retry command 产生的新 command identity
  不得覆盖原 intent 的 cause/provenance。retry-of-retry 必须沿用最初的
  `provenance.sourceCommandId/queueItemId/clientId`，不能用中间 retry 的 queue/client 覆盖。
- row action 是 handler 的唯一资格来源：普通 running 下 edit 可经 stop barrier、稳定历史
  fork 可用；retry 与文件 rewind 在任一 completion-blocking active work 中不可用；compact
  active work 对 edit/fork/retry/file rewind 全锁。handler 禁止再按 `activeAbortController` 做第二套裁决。
- `startNow` command admission 必须持有同 session CommandInbox gate，直到 canonical
  `TurnStarted` 已落库、从 raw reorder buffer 连续 drain、完成 projection apply，并在同一次
  materialization 中推进 revision、active work 与 row actions 后才能返回 ACK。input facade
  看见 runtime event 只表示「已通知」，不能作为 projection commit 证据；命令层必须按
  `{sessionId,eventId}` 等待 connection-independent gateway commit waiter。这样即使 delta 尚未送达/应用到 UI，旧
  `baseRevision` 的 retry/file rewind 也只能返回 stale；不得在 runtime controller 已 active
  而 projection 仍 idle 的窗口先执行 conversation/workspace rewind。
- `TurnStarted` 前失败必须先清 runtime active lock，再以 failed 结束 command 并取消 durable
  input admission；不得返回 accepted 留下无 canonical user fact 的 ghost input。提交屏障超过
  25 秒仍未产生 `TurnStarted` 时必须 fail-closed abort，清锁后返回明确 timeout failure。
- renderer 在 `sendText` 上行后遇到 transport error 时只能判定 command 结果未知，不能把它
  等同为“明确未 admission”并自动用新 command/session 重发。必须保留原 commandId 的恢复线索，
  通过 `commands/query` 或带同一 `sourceCommandId` 的 queue/guide/transcript projection 收口；
  在权威结果确定前，用户的一次提交最多只能产生一个 Agent admission。
- `TurnStarted` 提交屏障一旦 timeout 并让 command 进入 failed/cancelled 终态，对应 eventId 与
  sourceCommandId 必须进入不可提交终态。即使 raw reorder gap 稍后补齐，也不得再把该
  `TurnStarted` apply 到 canonical projection；否则 renderer 会按 failed ACK 回退重发，原 turn
  又迟到显现，破坏“一次用户提交只有一个权威输入结果”的守恒约束。
- projection event commit waiter 必须满足：已 apply 的 eventId 立即成功；raw gap pending 不成功；
  缺失 seq 到达并连续 drain/apply 后才成功；projection apply error、rehydrate、session/gateway
  dispose、abort 或 25 秒 timeout 都明确 reject，并清理 timer/listener/waiter。timeout 的
  point-of-no-return 以 projection 实际 commit 为准，不能因 runtime sink 已看见事件而误标 committed。
- row command 或 file changes/preview query 遇到 stale revision、stale epoch、stale entity
  target 时，客户端必须触发同一 subscription 的 projection recovery/resync；动作只能在新
  revision/epoch/entity authority 下重新提交，禁止继续复用旧 projection target。
- fork ACK 的 `accepted` 与带既有 child result 的 `duplicate` 同等导航；edit ACK 永远绑定当前
  session，不导航 child。failed/rejected/stale 不得导航；文件 blocked 保持行内草稿并允许用新
  commandId 降级为 `workspaceMode=preserve`。
- UI 只消费 CLI `visibility/origin/marker/actions`。不得按数组位置、`lastFlowRow` 或 raw `/compact`
  文本隐藏 action/row；旧历史缺 canonical 字段时由 CLI hydration 归一化。

### Target Object

| 值 | 含义 |
| --- | --- |
| `composer` | 当前输入框提交的内容 |
| `queueItem` | queue 面板里的某一项 |
| `latestUserQuery` | 最新 real-user input；可以是普通 text query 或用户提交的 goal input |
| `oldUserQuery` | 非 latest 的历史 real-user input（text/goal） |
| `latestAssistantTurn` | 最新 assistant turn |
| `oldAssistantTurn` | 历史 assistant turn |
| `toolMessage` | tool block 或 tool result |
| `timelineMarker` | compact、fork、goal verification、model change 等 timeline marker |

fork 目标只定义在 assistant message/turn 上。edit 目标只定义在 user query 上。tool message 和 timeline marker 不提供 fork/edit 入口，除非后续协议另行定义。

## Input Events

### User Events

| Event ID | Surface | Payload | 常见目标 |
| --- | --- | --- | --- |
| `sendText` | composer | 普通文本 | `composer` |
| `sendGoalCommand` | composer 或 goal control | `/goal xxx` 或 goal text | `composer` |
| `sendCompactCommand` | composer | `/compact` | `composer` |
| `clickCompact` | toolbar 或 action menu | compact intent | current session |
| `stop` | toolbar | stop current session activity | current session active work |
| `forkAssistant` | turn actions | fork intent | latest/old assistant turn |
| `retryTurn` | 协议兼容入口（产品 UI 已隐藏） | retry intent | latest assistant turn |
| `editUserQuery` | composer 编辑态 | edited text/goal text + attachments + modelSelection/mode/planEnabled；保留原 intent kind | latest real-user input |
| `sendQueuedNow` | queue actions | queue item id | `queueItem` |
| `lockQueueItemEdit` | queue actions | queue item id + editorId | `queueItem` |
| `editQueueItem` | composer 编辑态 | edited text + attachments + modelSelection/mode/planEnabled + editorId | `queueItem`（须持有锁） |
| `releaseQueueItemEdit` | composer 取消 / queue「解除」 | queue item id | `queueItem` |
| `reorderQueueItem` | queue actions | new order | `queueItem` |
| `deleteQueueItem` | queue actions | queue item id | `queueItem` |
| `switchModelConfig` | toolbar/model selector | provider/model/thought config | current session |

### System Events

| Event ID | 来源 | 适用上下文 |
| --- | --- | --- |
| `assistantComplete` | runtime/model stream | `running` |
| `assistantFailed` | runtime/model stream | `running` |
| `compactStarted` | runtime | auto/manual compact |
| `compactComplete` | runtime | `activeWork.kind=compact` |
| `compactNoop` | runtime | `activeWork.kind=compact` 或 completed 后再次 compact |
| `compactFailed` | runtime | `activeWork.kind=compact` |
| `goalVerifyStart` | goal runtime | goal active 后进入 verifier |
| `goalVerifyPass` | goal runtime | `activeWork.kind=goalVerifier` |
| `goalVerifyNotSatisfied` | goal runtime | `activeWork.kind=goalVerifier`，verifier 正常返回“目标尚未达成” |
| `goalVerifyFailed` | goal runtime | `activeWork.kind=goalVerifier`，verifier 被取消、接口失败、超时或内部异常 |
| `foregroundSubagentStarted` | runtime/tool | `running`，primary turn 派生 foreground 子 agent |
| `foregroundSubagentComplete` | runtime/tool | `running`，对应 foreground subagent active work 收口 |
| `foregroundSubagentFailed` | runtime/tool | `running`，对应 foreground subagent active work 失败或被 stop 终止 |
| `backgroundWorkStarted` | runtime/tool | background bash/subagent 启动；不阻塞 `sessionEnded` |
| `backgroundWorkComplete` | runtime/tool | background bash/subagent 完成；产生 background result 或 no-op |
| `backgroundWorkFailed` | runtime/tool | background bash/subagent 失败或被 background cancel |
| `backgroundResultQueued` | runtime/tool | background result 已进入 continuation inbox 或 deferred queue |
| `sessionRestored` | restore/snapshot | app reload、切 session、remote replayable |

## Decision Types

| Decision | 含义 | 必须说明 |
| --- | --- | --- |
| `allow` | 动作立即生效 | 下一状态、产生的协议请求或本地状态变化 |
| `reject` | 动作被明确拒绝 | 用户反馈、禁止副作用、状态不变部分 |
| `enqueue` | 动作不立即执行，进入 queue | deferred input event、payload、顺序、是否 autoDrain |
| `noop` | 动作可触发但不改变业务状态 | 用户反馈和为什么不需要动作 |
| `system-transition` | 系统事件推进状态 | 事件归属、下一状态、是否触发后续动作 |
| `undefined` | 产品语义未定义 | 需要确认的问题和候选口径 |
| `bug-candidate` | 当前实现疑似违反已确认协议 | 已确认协议、观察到的冲突、证据入口 |

`reject` 不是兜底错误。每条 reject 必须声明反馈和禁止副作用，例如“不入队、不作为普通 user message、不发 compact 请求”。

`undefined` 不能写稳定 E2E。它必须进入 decision worksheet 或 backlog，确认后才能回写 rule table 和 case catalog。

## Global Invariants

这些不变量优先于单条 case。任何 rule 的 effect 如果违反不变量，应标成 `bug-candidate` 或 `undefined`，不能被当作普通 accepted case。

| Invariant ID | 说明 | 当前状态 |
| --- | --- | --- |
| `sameSessionActiveTurnExclusive` | 同一个 session 不能同时跑两条 active turn；同 session 后续输入必须通过 queue、turn-steer 或明确 stop/drain 规则处理 | accepted |
| `sessionCompletionRequiresNoForegroundWork` | `completed(success/interrupted)` 必须要求 primary turn、foreground subagent、compact、goal verifier、goal continuation、turn-steer 全部收口；background work 不参与 completion gate | accepted |
| `foregroundSubagentKeepsSessionBusy` | assistant stream 或主 turn 局部完成后，只要仍有归属当前 session 的 foreground subagent 在运行，session 就不能进入 completed | accepted |
| `backgroundWorkDoesNotBlockSessionEnd` | background bash/subagent 运行时，session 仍可在 foreground work 清空后进入 completed，并开放 completed-only 操作 | accepted |
| `sessionEndedDrivesImmediateStart` | 只有 `sessionEnded=true` 的 completed 上下文才能让 composer 普通输入立即成为下一轮 active turn；`sessionEnded=false` 时必须命中 queue、guide、reject 或 stop/drain guard | accepted |
| `runtimeFactsAreAuthoritative` | `sessionEnded`、`canStop`、`stopState`、`stopTargetKind` 必须来自 CLI/runtime facts 或 host/service 的规范化投影；UI 不能只靠本地 message stream、timeline 或 `streaming` 状态猜测 | accepted |
| `persistentConversationFactsAreAuthoritative` | message、part、session metadata 与 goal 是持久权威；live/cold 必须先归一为同一 canonical facts，再生成 projection | accepted |
| `rowIdentityIsDisplayOnly` | `rowId` 只用于展示；edit/retry/fork 的 action 与 command target 必须绑定 `entityId/productTurnId` | accepted |
| `trustedDeliveryBoundary` | desktop（含 SSH/WSL/Docker）固定 continuous，mobile/Web remote 固定 replayable；profile 由 host attachment 可信注入，UI 不可选择 | accepted |
| `subscriptionOwnedByConnection` | 每个 connection 有独立 subscription registry；frame 只发给 owning port，一个慢订阅者不得污染其他连接 | accepted |
| `acceptedInputHasSingleAuthority` | 所有端已提交 busy/running 输入按 CLI admission 顺序进入同一 FIFO；host/runtime/UI 不保留第二份权威队列 | accepted |
| `acceptedInputAlwaysAccountedFor` | 每条已提交输入必须且只能处于 queue、guided row、transcript、explicit rejected/failed/discarded 之一 | accepted |
| `sourceCommandIdEndToEnd` | queue item、drain/guided event、user row、message anchor、marker、fork child metadata 保留原始 sourceCommandId | accepted |
| `restartDiscardRespectsDeliveryLifetime` | CLI restart 后未完成 admitted input 明确 discarded；旧 runtime 的 `queue/guide` 静默结算；无权威结论的 `unknown` 保留待确认线索且不显示 UI 错误，只有未进入 transcript 的 `startNow` 提示确认重发，禁止自动重放 | accepted |
| `stopButtonStableAcrossActiveWork` | assistant、compact、goal verifier、goal continuation、foreground subagent 等 active work 交接时，只要 session 仍可 stop，UI 停止按钮必须保持稳定，不因内部阶段切换而闪烁 | accepted |
| `stopPausesActiveGoalTarget` | goal target 为 active 时，用户 stop 不管作用于 assistant、compact、goal verifier 还是 goal continuation，都必须把 target 置为非 active 的暂停态 | accepted |
| `cancelledTurnColdHydrationParity` | 用户 stop 产生的 typed/legacy ZCode cancellation 在 live 与 cold hydration 后都必须归约为 `TurnComplete(cancelled)`；不得产生 `TurnError`、`phase=error` 或 `control.lastError` | accepted |
| `followupInputModeExplicit` | running 中后续普通输入必须按 `queue` 或 `guide` 模式裁决；默认是 `queue` | accepted |
| `runningPromptQueues` | `running` 且 follow-up mode 为 `queue` 时，普通文本进入 queue，不打断当前 in-flight 请求 | accepted |
| `unfinishedSessionPromptQueues` | `sessionEnded=false` 且未命中 guide allow 时，普通文本进入 queue，不启动第二条 active turn | accepted |
| `unfinishedSessionGoalQueues` | `sessionEnded=false` 时 `/goal xxx` 进入 queue，消费时设置或更新 goal；这是 `/goal` 自己的 rule，不代表所有 command 都可入队 | accepted |
| `guideModeEligibilityGuard` | `guide` 模式只在满足 turn-steer 条件时生效；不满足条件必须回退 queue | accepted |
| `guideModePreservesMessage` | `guide` 模式下后续文本必须保留在 turn-steer/guided history 或 fallback queue，不能丢失 | accepted |
| `runningCompactQueues` | `running` 时 `/compact` 作为 typed maintenance intent 进入统一 FIFO；不能当普通消息，也不能并发启动 compact | accepted |
| `runningStableAssistantForkAllowed` | `running` 时可以 fork 更早 `completedSuccess` turn 最后一段 completed assistant；当前 streaming/interrupted/failed partial 和中间 assistant 段不能 fork | accepted |
| `latestQueryEditPreemptsActiveTurn` | 只有最后一条 real-user input（text 或 goal）可以 edit；running 时提交 edit 等价先 stop 当前 active work，再从该 input 重跑且保留原 intent kind | accepted |
| `compactCoveredLatestEditRewindsInPlace` | latest real-user input 已被稳定 compact summary 覆盖时，原 session append-only branch cut，重置被跨过的 compact 派生状态并按原 kind 重放；不创建 child、不追加 rewind reminder | accepted |
| `latestAssistantRetryOnly` | 底层 capability 先锁定当前投影里全时间线最后一条 `assistantText` row，再要求同一 product turn 存在 `origin=realUser` 的 canonical user input；background result/goal continuation/mailbox 等 synthetic turn 和更早真实用户轮均不得获得 capability。产品 UI 在桌面、Web、手机端统一隐藏普通 assistant retry 入口，`canRetry` / `retryTurn` 仅为协议兼容继续保留 | accepted |
| `retryPreservesFullIntent` | retry 从 canonical cause 恢复 input kind、text、attachments、goal intent、delivery/fallback 与来源 cause，禁止仅从可见文本重建 | accepted |
| `goalInputUsesUnifiedEditTarget` | `goalSet` lifecycle 不产 marker；用户 goal input 产 canonical visible real-user row，并与 text query 共用 `editUserQuery` target；重发仍是 `sendGoalCommand` | accepted |
| `stopHighestPriorityCancelsForegroundWork` | stop 是最高优先级；必须终止当前 session 的 primary turn、foreground subagent、compact、goal verifier、goal continuation 和未确认 turn-steer | accepted |
| `stopEndsAsInterruptedCompleted` | stop 终止所有 completion-blocking active work 后进入 `completed(interrupted)`，没有 paused 产品态 | accepted |
| `stopKeepsQueueAndDisablesAutoDrain` | stop 后 queue 保留，`autoDrain=false` | accepted |
| `lateTerminalEventsAfterStopDoNotRevive` | stop 之后迟到的 assistant/foreground subagent/compact/verifier 终态不能把旧 work 改回 success，也不能覆盖新一轮 active input | accepted |
| `heldQueueInputRequiresChoice` | `completed` 且 held queue（queue>0 + autoDrain=false）下，composer 新输入不静默入队：由用户选择「清空 queue 后发送」或「保留 queue 立即发送」（2026-07-05 重裁决，替代原 heldQueueCapturesNewInput） | accepted |
| `queueContentIndependence` | queue 是未来意图，不绑定某段已完成历史；edit、compact、fork 不改写 queue | accepted |
| `forkAssistantOnly` | 只能 fork assistant message；user/tool/timeline 不提供 fork | accepted |
| `forkDoesNotCopyQueue` | fork 新 session 不复制父 queue；父 queue 保留 | accepted |
| `forkStableHistoryOnly` | child 只继承 `completedSuccess` turn 最后一段 completed assistant 及之前的稳定历史；父 session 正在 running 不自动禁止 fork，但当前 partial、中间 assistant 和 compact operation lock 不能作为稳定 fork 边界 | accepted |
| `runningForkDoesNotRewindWorkspace` | running fork 是 conversation-only；不恢复共享 workspace checkpoint，父 session 继续 running；completed/idle 既有 workspace 行为不扩大 | accepted |
| `forkDoesNotCopyBackgroundWork` | fork 不复制父 session 的 live background bash/subagent、pending background result 或 continuation inbox；只复制已进入 fork 点前 transcript 的 background result | accepted |
| `forkInheritsSessionFutureState` | child 继承 fork 点持久化的 provider/model/思考深度和 fork 点之前的 goal 状态，但不继承父 session 后续 config 或 queue | accepted |
| `forkTimelineIsBoundary` | fork notice 是 turn boundary，不进入 assistant 工作历史折叠 | accepted |
| `editUserOnly` | 只能 edit latest real-user input（text query 或用户 goal input）；assistant/tool/timeline 不提供 edit | accepted |
| `editKeepsQueue` | edit latest real-user input 会按原 intent kind 重跑分支，但 queue 原样保留 | accepted |
| `sessionConfigScoped` | 模型、provider、思考深度是 session 级未来配置，不能串 session | accepted |
| `queuedSubmissionPreservesSelection` | queue 保存完整 Submission；消费时继续使用入队时固定的 Provider、Model 与思考深度，Provider 配置在创建 Model 时读取最新事实 | accepted |
| `crossSessionUnlimitedConcurrency` | 不同 session 可以真实并发运行，queue/模型/sidebar 互相隔离 | accepted |
| `autoCompactIsSystemTurnPrefix` | auto compact 是 pendingAction 前置维护步骤，成功后继续 pendingAction | accepted |
| `goalVerificationOutcomeSeparation` | verifier 正常判断未达成必须标为 `notSatisfied`；取消、接口失败、超时或内部异常才标为 `failed` | accepted |
| `compactActiveWorkOperationLock` | `activeWork.kind=compact` 是 running 内部维护态；普通文本和 `/goal` 入队，compact、fork、edit、retry、sendQueuedNow 必须 reject | accepted |
| `goalVerifierBusyRouting` | `activeWork.kind=goalVerifier` 是 running 内部验证态；普通文本、`/goal` 和 `/compact` 都作为未来意图入队，stop 可中断 verifier；latest user query edit 走 stop barrier 后重跑，fork 稳定历史允许，sendQueuedNow 走 stop barrier 后 drain | accepted |
| `backgroundWakeStartsIndependentProductTurn` | background model-only wake 无论 live/cold 都创建独立 product turn；无可见 user trigger row且不得并入上一 real-user turn | accepted |
| `stableForkIsAtomicAndFullyRemapped` | stable fork 只有在 child metadata、历史、goal/provenance 与全部 child-local references 原子写入并 remap 后才发布；失败不留半成品 child | accepted |

## Known Stable Guards

这些 guard 在现有文档中有稳定共识，可作为后续 rule table 的第一批来源。

| Guard ID | 匹配 | Decision | 核心 effect |
| --- | --- | --- | --- |
| `firstSend` | `draft + sendText` | `allow` | 创建 session，进入详情页，首条 user message 可见 |
| `runningPromptQueues` | `running + followupInput.mode=queue + sendText` | `enqueue` | deferred `sendText` 按 FIFO 增长，不发第二个同 session active turn |
| `guideModeTurnSteer` | `running + followupInput.mode=guide + sendText + guide eligible` | `allow` | 后续文本进入 turn-steer 或 guided user message，不触发普通新 turn |
| `guideModeFallbackPreservesMessage` | `running + followupInput.mode=guide + sendText + guide ineligible` | `enqueue` | 回退为 deferred `sendText`，不丢失用户输入 |
| `unfinishedSessionPromptQueues` | `sessionEnded=false + sendText + guide ineligible/not applicable` | `enqueue` | deferred `sendText` 按 FIFO 增长，不启动第二条 active turn |
| `unfinishedSessionGoalQueues` | `sessionEnded=false + sendGoalCommand` | `enqueue` | deferred `sendGoalCommand` 保留 goal 意图，消费时 set/update goal |
| `runningCompactQueues` | `running + sendCompactCommand/clickCompact` | `enqueue` | 追加 kind=`compact` 的 queue item；不作为普通 user message；当前 work 结束后严格按 FIFO 执行 |
| `runningStableAssistantForkAllowed` | `running + forkAssistant + stable historical assistant target` | `allow` | 创建 child；父 session 当前 active work、queue、background work 继续留在父 session |
| `latestQueryEditPreemptsActiveTurn` | `running + editUserQuery + latest real-user input(text/goal)` | `allow` | 先执行 stop barrier；旧 work 清空后 rewind 并按原 kind 重跑；barrier 失败保留旧 work/input/branch，不启动 text/goal |
| `compactCoveredLatestEditRewindsInPlace` | `editUserQuery + latest real-user input + coveredByStableCompact` | `allow` | 原 session append-only branch cut；重置跨过的 compact/microcompact 状态，按原 kind 重放，不创建或导航 child |
| `goalInputUsesUnifiedEditTarget` | `editUserQuery + latest real-user input(kind=goal)` | `allow` | 按稳定 entity target rewind；重发 `sendGoalCommand` intent，goal input row 保持可见，不生成 `goalSet` marker |
| `latestQueryEditOnly` | `editUserQuery + non-latest real-user input` | `reject` | 历史 text/goal input 不提供 edit，避免 active branch 回退到旧上下文 |
| `latestAssistantRetryOnly` | `retryTurn + non-latest assistantText row`，或 latest assistant 所在 turn 没有 `origin=realUser` 的 canonical user input | `reject` | 历史 assistant 回复和 background/synthetic 结果轮都不获得 retry capability；禁止跳过最新 synthetic assistant 回退到旧上下文。所有普通 assistant retry capability 均不渲染为产品 UI 入口 |
| `activeWorkBlocksCompletion` | `assistantComplete + activeWork!=empty` | `system-transition` | 收口已完成 work，但 session 保持 busy，不开放 completed-only 操作 |
| `controlProjectionKeepsStopVisible` | `canStop=true OR stopState=stopping` | `system-transition` | UI 保留同一个停止按钮；`stopTargetKind` 变化只更新细节文案 |
| `stopBusySessionCancelsForegroundWork` | `prewarming/running/activeWork!=empty + stop` | `allow` | 终止当前 session completion-blocking active work，清空后进入 `completed(interrupted)`，queue 保留且 `autoDrain=false` |
| `sendQueuedNowStopsBeforeDrain` | `running + queue>0 + sendQueuedNow` | `allow` | reserve 目标项，执行 stop barrier；启动成功才 remove，失败释放 reservation 并原位保留 |
| `compactActiveWorkOperationLock` | `activeWork.kind=compact + sendCompactCommand/clickCompact/forkAssistant/editUserQuery/retryTurn/sendQueuedNow` | `reject` | 正在 compact；不能启动第二次 compact，不能 fork/edit/retry，不能抢占 drain queue |
| `goalVerifierBusyRouting` | `activeWork.kind=goalVerifier + sendText/sendGoalCommand/sendCompactCommand` | `enqueue` | 正在验证 goal；用户输入和维护意图都保存为 typed queue item，不启动第二条 active turn、不打断 verifier |
| `goalVerifierStopBarrierDrain` | `activeWork.kind=goalVerifier + sendQueuedNow` | `allow` | 先 stop verifier（marker failed/cancelled，goal paused），再按显式 queue 消费规则 drain 目标项 |
| `completedCanStartNextTurn` | `completed + sendText + queue=0` | `allow` | 立即开始下一轮 |
| `backgroundOnlyCompletedCanForkOrCompact` | `completed + backgroundWork!=empty + forkAssistant/clickCompact` | `allow` | background work 不阻塞 completed-only 操作；fork/compact 仍只作用于稳定 transcript |
| `heldQueueInputRequiresChoice` | `completed + queue>0 + autoDrain=false + sendText/sendGoalCommand` | `choice` | 客户端呈现选择：`clearQueueAndSend`（清空 queue 后发送）或 `keepQueueAndSend`（保留 queue 立即发送）；command 重放携带所选 disposition |
| `manualCompact` | `completed + clickCompact/sendCompactCommand` | `allow` | 进入 `running + activeWork.kind=compact`，插入 compact timeline |
| `forkAssistantOnly` | `stable assistant target + forkAssistant` | `allow/reject` | assistant 允许 fork；user/tool/timeline 禁止 |
| `editUserOnly` | `editUserQuery` | `allow/reject` | latest real-user input（text/goal）允许 edit；非最后一条 real-user input、assistant/tool/timeline 禁止 |
| `forkDoesNotCopyQueue` | `forkAssistant` | `allow` | child 继承稳定历史和 fork 点配置，不复制父 queue |
| `forkDoesNotCopyBackgroundWork` | `forkAssistant` | `allow` | child 不复制父 session 的 live background work 或 pending background result |
| `queueContentIndependence` | `editQueueItem/reorderQueueItem/deleteQueueItem` | `allow` | 只改 queue，不触发消费 |
| `queuedEditFreezesItemInPlace` | `lockQueueItemEdit/editQueueItem/releaseQueueItemEdit` | `allow/reject` | 仅 `queued` 且无锁的项可加锁；冻结项拒绝 send-now/delete/reorder，自动 promotion 到冻结队首暂停；`editQueueItem` 锁不符返回 `guard.queueEditLockLost` |

## Pending Product Boundaries

四个边界已于 2026-07-05 全部裁决（v4 重构 M0 决策清收），本节保留裁决记录；详细子问题结论见 [decision-answers](./testing/conversation-session-decision-answers.md) 与 compact decision worksheet。

| Boundary ID | 裁决结论 | 来源 |
| --- | --- | --- |
| `PB-COMP-FAIL-F09` | 保持 completed（回到 compact 前原状态）+ failed marker（带 retry 入口）；queue 保留不自动消费、autoDrain 不变；全部操作恢复 | compact worksheet F09.1–F09.4 |
| `PB-AUTO-COMP-FAIL-G11` | 继续无压缩执行 pendingAction（保持 running，第 4 个请求为主模型请求）；retrying 历史与 failed marker 保留但不阻塞；circuit breaker 生效、手动 compact 成功后重置计数 | compact worksheet G11.1–G11.4 |
| `PB-AUTO-COMP-STOP-G12` | 与普通 stop 完全一致：pendingAction 保留为当前轮 interrupted user message（时间线可 edit/retry，不复制回 queue、不丢弃）；session `completed(interrupted)`；compact marker 置 cancelled；显式追加 queue 全部保留不自动消费 | compact worksheet G12.1–G12.4 |
| `PB-AUTO-COMP-MODEL-N06` | 允许切换：不中断已发出的 compact，config 立即生效；竞态边界 = pendingAction 消费瞬间读取当时最新 config 快照（v4 switchModelConfig 走 revision CAS） | case catalog N06 |

## Evidence Contract

后续每条 rule 或 case 至少声明一条用户可见证据和一条非 UI 证据。

| 层 | 用途 |
| --- | --- |
| UI | 用户实际看到的消息、queue、按钮 disabled、toast、timeline marker |
| Runtime/Store | `sessionId`、phase、queue、target、activeInputId、activeWork、backgroundWork、sessionEnded、canStop、stopState、stopTargetKind、autoDrain、model config |
| Protocol | app/agent 命令，如 send、compact、goal、fork、stop、activity terminal event、runtime facts snapshot、product control projection |
| Network/SSE | provider 请求、compact 请求、stream timing、retry |
| Files | session snapshot、task index、compact summary、fork history |
| Logs | UI logger、service logger、agent log，必须带 case/session/input 归属 |

对于 reject 类 rule，证据必须同时证明 forbidden side effects 不发生。例如 `/compact` running reject 不仅要看到 toast，还要证明 queue 未变、没有普通 user message、没有 compact 请求。

对于 completed 类 rule，证据必须证明 session 归属的 completion-blocking active work 已清空。例如不能只断言 assistant message 出现完成态，还要证明没有仍在运行的 foreground subagent、goal verifier、compact、未收口 goal continuation 或 turn-steer。background bash/subagent 需要以 `backgroundWork` 或 background drawer 事实单独证明；它可以继续 pending，但不能把 `sessionEnded` 重新置为 `false`。

对于 control projection 类 rule，证据必须证明 CLI/runtime facts 到 host/service projection 再到 UI 的链路一致。例如 `canStop=true` 或 `stopState=stopping` 期间，停止按钮不能因为 `assistant -> compact -> goalVerifier` 的内部阶段切换而短暂消失；`stopTargetKind` 改变只能改变 tooltip、日志或辅助文案。

对于 `sessionEnded=false` 入队类 rule，证据必须证明用户输入被保存为 queue item，且没有发起第二条 active turn。若当前是 `activeWork.kind=compact` 或 `activeWork.kind=goalVerifier`，还要证明现有 compact/verifier active work 未被打断，queue 只在后续允许消费的时机 drain。

对于 fork 类 rule，证据必须证明 fork target 是 `completedSuccess` product turn 最后一段 completed assistant 的稳定 transcript 边界，并证明 child 没有复制父 session 的 queue、live background bash/subagent、pending background result 或 continuation inbox。若父 session 在 fork 时仍 running，证据还要证明父 session 的 active work 继续归属父 session、共享 workspace 没有 rewind，child 只获得 fork 点之前的稳定历史。

对于用户 stop 类 rule，证据必须证明 stop command 已作用到所有 completion-blocking active work，尤其包括 foreground subagent；goal target 为 active 时还要证明 target 已置为暂停态；且 stop 后迟到的 assistant/foreground subagent/compact/verifier 终态没有把 session 复活为 success、没有触发 pendingAction、没有覆盖新一轮 active input。background-only cancel 走 background task control，不作为 session stop 证据。

## Next Step

若后续新增 `docs/conversation-session-rule-table.md`，只把本文件中 `accepted` 的 invariant 和 stable guard 展开成规则表。该文件当前尚未建立；`needs-decision` 的边界先进入小批量确认，不进入 accepted rule。
