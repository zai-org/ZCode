# Feishu group collaboration

话题输入材料的新实现以 [话题输入材料重构](bots-topic-input-materials.md) 为准；
下文历史记录中的正文拼接引用与 bot_topic_context 自动注入将由标准引用和文本附件替代。

架构登记沿用两个既有边界：`conversation-quote-context` 只生成模型可见引用和可信来源说明；
`window-topic-resource-relay` 绑定物理连接与 logical session，委托已有资源转发通道执行校验、读取与取消。
登记不改变 canonical 输入、Bot 投递 owner 或默认停用渠道发送入口的行为。

## Identity and activation

One enabled group has one default conversation, plus independent topic conversations.
The default key remains `(botId, chatId)` for backwards compatibility; topics use
`(botId, chatId, threadId)`. Each conversation has one current task.
`sender.open_id` is the actor, never the conversation identity. Card callbacks use
`context.open_chat_id`. Different groups and private chats have independent task,
workspace, model, pending interaction and history state. Shared workspace files
are not isolated: activation discloses that concurrent groups can edit the same files. No automatic worktree is created.

Only the privately bound owner can `/enable` a group. Initial activation copies
the private workspace/model/thought level into a new draft, but not its task,
conversation or automatic permission grants. Missing workspace rejects activation.
Repeated activation is idempotent. `/disable` stops intake, callbacks and delivery,
without cancelling accepted work. Re-enable preserves context, not missed output.
Removal from the group, unbinding or owner replacement revokes group access;
joining again requires explicit owner activation. Both ordinary Feishu/Lark groups
and dedicated topic groups are supported. Other providers are excluded.

### 冷恢复后的模型选择

已绑定 task 的模型由 Agent Session 持久化，不从 Bot 草稿或任务索引恢复。
冷恢复时 Provider 暂不可用可以使运行绑定为空，但必须保留 Session 原选择。
Provider 恢复后，群输入未显式携带模型时，V4 接纳从当前运行选择或冷恢复保留值
固定本轮 Selection，继续经过现有模型可用性校验；不要求再次执行 `/model`。
Provider 仍不可用或选择无效时拒绝输入，不改用默认模型。新选模生效后以新值为准，
已接纳输入与队列保持原快照。桌面 continuous 与 Web replayable 共用此接纳边界。

```text
Session 持久选择 → 冷恢复保留值 → V4 模型校验与输入接纳 → 冻结本轮 Selection
                              ↑ 当前运行选择优先
```

回归入口：`apps/zcode-cli/packages/bootstrap/tests/protocol-unbound-resume.test.ts`，
使用真实 Protocol/App/SQLite，在 Provider 缺席时恢复，再发布 Provider 并提交 Bot 输入。

## Topic collaboration (implementation contract)

本节是话题行为的当前实施契约，替代旧的逐次 @、默认任务 alias、queue 和 Steer 路径。
普通群默认会话及私聊保持原语义。

### 接入、隔离与退出

普通用户根消息的话题首次 @ 当前机器人后接入；用户以话题回复当前机器人
在主聊天的消息时自动接入。必须核验真实 sender、chat 和 native thread ID，
不能通过显示名或正文推断机器人身份。已接入话题接收后续所有真人消息，
未接入话题的普通讨论不执行。已接入话题也接收其他机器人的原生消息，触发与真人
相同的处理、运行中中断续接和回复；当前机器人自身消息按原生 open_id 排除，
不能靠名称判等。其他机器人不能首次接入或重新激活已退出话题；已启用普通群的主聊天仅在原生 @ 当前机器人时接收。
接收事件 sender_type 为 bot（兼容旧 app 测试/历史输入），Provider 统一映射为内部 app。
历史接口的 app 与接收事件的 bot 不可混淆。专用话题群无 thread_id 的机器人事件仍不接入。
应用需要开通 im:message.group_at_msg.include_bot:readonly 接收机器人 @，或
im:message.group_msg.include_bot:read 接收包含机器人的群消息，并发布生效；普通
im:message.group_msg 不能证明机器人消息推送权限已开通。
机器人正文（包括 slash 命令和审批文字）只作为普通输入，不能执行控制命令或提交
交互响应。消息 ID 去重、授权撤销和停止屏障沿用现有流程，不建立第二份队列。
历史保留真人和机器人消息（含原生 senderType）；历史内容仍不触发独立执行。
状态回调不作为普通输入。每个 `(botId, chatId, threadId)`（主聊天单独计数）连续
最多接收 5 条其他机器人的新消息，第 6 条起静默忽略，不停止当前运行、不准备材料、
不提交 CLI。通过现有接入门禁的真人新消息清零；卡片/状态回调不恢复计数。
重复消息（包括旧真人消息）不消耗次数、不清零。Bot Host 在现有串行状态写入中
持久化计数与已接收消息 ID，再进入停止/准备流程；并发回调、迟到状态回写和重启不能
绕过上限。接收后准备失败仍占一次，避免失败重投重新触发。旧 v3 状态无字段时从零开始。

```text
真人首次接入 → active 话题
其他机器人原生消息 → Provider 排除自身 → 校验 active → 去重/持久化连续次数（最多 5）→ 现有停止/材料准备 → CLI admission → 回复
当前机器人原生消息 → 丢弃
inactive / leave 后的机器人消息 → 丢弃（即使 @）
```

验收：Feishu/Lark 的其他机器人消息能在原话题提交并回复、重复回调只处理一次；
自身消息、未接入话题和退出后的机器人消息静默忽略；机器人 `/stop`、`/reconnect`
及审批文字不执行控制操作；历史机器人正文及授权附件可读。仅处理平台实际推送的
消息，受应用权限和平台事件范围限制；合成事件测试不证明真实租户的推送能力。

每个 `(botId, chatId, threadId)` 绑定独立任务，包括机器人回复形成的话题。
首次冻结边界、读取历史并准备必需材料，成功后才创建任务与提交。继承群配置
快照，不继承其他任务上下文或审批；同工作区仍共享文件，不自动建 worktree。
接入期间并发消息不能丢失或重复建任务。未知话题身份拒绝，不回退主聊天。

`/stop` 停止当前轮并取消未提交输入，保持接入；绑定用户 `/leave` 停止并退出。
再次 @ 恢复原任务并补历史。`/history off` 暂停话题；历史权限缺失阻止接入，
给出应用权限链接和发布说明。群停用/解绑/退群撤销接入、卡片和投递授权。

### 停止后续接

```text
inactive --首次触发--> preparing initial materials --成功--> active/idle
active/idle --消息准备完成--> running(runId)
running --真人或其他机器人新消息--> stopping(runId) + preparing pending messages
stopping --停止已确认 AND 全部材料就绪--> running(nextRunId)
active --/leave--> inactive（保留任务）
```

收到新消息立即请求停止，材料准备可并行。停止请求使用既有协议 expectedForegroundExecutionId 绑定旧运行（来自 activeWorks），不能把日志 traceId 当执行身份；等待权威
终态后才提交下一轮。停止期间所有消息按接入顺序合并，原始消息各自保留；
同一 run 只停止一次。自然完成与停止竞争只推进一次；迟到通知不影响新轮。
已完成工具副作用不回滚，不能承诺强制抢占工具。

合批在既有 botGroupSource.messages 保存各条 messageId、senderId、senderName、正文、引用和扁平附件索引；最后一条消息作为接收边界，消息 ID 不得重复。UI 从这些结构化原文逐条展示，不解析拼接正文。

准备缓存只保存未接受输入，CLI CommandInbox 仍是唯一接受队列。禁止 Bot 层
建立 accepted queue。提交使用稳定 commandId；确认丢失查询原命令，不重复执行。
Host 在冷恢复/附件上传前记录任务与 remoteSessionId 隔离的取消代次，上传完成后再次校验；/stop、/leave 递增代次，阻止旧输入迟到接收。此代次不保存 accepted input。

取消与命令发送共用 task/workspace/remoteSessionId 级串行屏障。发送取得屏障时复核准备代次；取消立即使尚未发送的旧代次失效，并等待已开始发送的命令及 ACK 对账收口后才返回。已开始发送的命令先于取消线性化，不能承诺撤回；后续 stop 读取收口后的权威运行态。屏障只管理 Host 在途调用，不保存 accepted input，也不代替 CLI CommandInbox。

```text
准备(代次 N) → 串行屏障内复核 N → 发送/ACK 对账 → 释放屏障
取消 → 代次 N+1（拒绝未发送的 N）→ 等待在途发送收口 → 取消完成 → 权威 stop
```

回归须覆盖无附件发送内部挂起时取消不能提前完成、等待屏障的旧代次被拒绝、发送失败后屏障释放、新代次输入和相同 commandId 的 CLI 幂等透传，以及远端会话身份隔离。
控制命令/审批/问答走专用通道，不触发普通消息中断，也不被材料准备阻塞。
旧轮中断后未投递结果不得作为最终结果发送，已发送内容保留。

### 输入材料与展示

首次展示根引用（真实原文、发送者、时间）和可打开的话题历史文本附件。
本次正文保持原样；只有 @ 不造占位正文或空气泡。后续消息独立展示发送者、
正文及附件，即使同批执行也不合成一个 UI 气泡。root_id 不代表明确引用，
只在用户明确引用另一条消息时追加引用。不重复根引用或注入 bot_topic_context。

历史首次读取，持续消息通过事件收集；重连/缺口增量补取。每次最多自动读取
200 条并单独保留根消息，按消息 ID 去重，记录覆盖范围与缺口。历史文本包含
时间、发送者名称和 ID、消息 ID、正文、附件名称/类型/引用。当前和明确引用的
必需附件通过已有上传流程准备后一次提交，其他历史资源按任务授权范围回查。
不依赖用户安装 lark-cli；历史命令、批准文字不能作为控制输入。

准备/等待停止用 OneSecond，执行用 OnIt，对应轮完成用 CheckMark，失败用
CrossMark。中断/取消移除未完成表情；每条输入独立关联 run，后续完成不能补标
旧消息。UI 用轻量准备/等待停止/重试状态；中断回答保留并标记“已被新消息中断”。
不恢复排队卡、BotGroupTaskNotice 或重复来源正文。

### 中断归属的协议边界

App 不根据消息顺序推断自动中断。CLI 的 activeWorks 在拥有输入归属时携带可选
sourceCommandId，与 foregroundExecutionId 一起标识本次运行；缺少输入归属时保留
普通停止展示。Bot 发起新消息停止时，按这一权威映射记录被中断输入，手动 /stop
和 /leave 不写入自动中断原因。UI 通过同一任务的 Bot 状态订阅读取原因，不新增
独立 runtime 或 accepted queue，手机保持原 replayable 边界。

```text
CLI activeWorks(executionId, sourceCommandId)
  → Bot 新消息停止指定 executionId
  → 原输入的自动中断原因
  → App 对应 sourceCommandId 的停止标签
```

### 准备状态展示边界

Bot 服务临时保存未提交消息及准备状态，getBotStates 只投影 messageId、发送者、正文和
preparing/waitingStop/failed 状态，不传附件二进制或凭据。App 将准备消息投影到会话流，失败后移除临时行，不显示错误块或重试。CLI 接收后立即移除临时展示，正式
消息由 CLI 行显示；取消、退出、撤权、关闭清除临时状态。该缓存不持久化、不自动重跑，
也不是 accepted queue；服务重启后按既有历史边界重建材料。

### 准备中输入的消息气泡

准备中的每条真人输入属于会话流。来源行显示「飞书/Lark · 发送者」与不收缩的加载图标，
悬停或键盘聚焦图标时，tooltip 显示「正在准备材料」或「等待当前执行停止」。
不在气泡内或下方常驻显示准备文字。正文仍复用完整正式消息组件和折叠/展开；
空正文只显示来源与状态图标，不造空气泡。材料准备失败后移除该临时展示行，不显示红色错误块、重试按钮或孤立来源标签；不改动服务端失败记录、执行与飞书侧回复。
长姓名截断，不挤掉状态图标。provider 来自当前绑定机器人的配置或已接收来源，不猜测 Lark 为飞书。

```text
Bot 未接受材料（messageId） → 时间线 render unit → 正式正文组件 + 来源行加载图标
CLI 正式消息（botGroupSource.messageId / messages[].messageId） → 正式气泡
                           └→ 同 ID 准备气泡不再展示
```

准备消息接入 ConversationTurnGroup，参与现有消息流测高/滚动，不在 Timeline 底部另挂提示。保留 running live tail，不能为准备态把执行中的轮次移入历史虚拟列表。
仅从当前时间线和 Bot 状态派生展示，不增加缓存或 accepted queue；消息仍由各自 owner
发布。相同原始 ID 的正式消息到达后隐藏迟到准备状态，不能按正文匹配去重。
复用同一气泡组件不代表跨 owner 保留同一个 DOM 节点。桌面 continuous 和手机 replayable
保持原链路。验收覆盖多条输入、空白正文、准备/等待/失败、重试、正式消息先到的重叠窗口，
以及中英文、深浅主题、桌面/手机宽度；组件浏览器证据不代替真实飞书和手机远控端到端。

### 本次实现与验收记录

- 服务 dispose、机器人被移出群、更换绑定用户时的迟到材料取消已有群服务回归测试；完整跨端验证仍待手动验收。
- App 已接入轻量准备/等待停止/失败重试状态，并区分自动中断与手动停止；组件和服务测试通过，真实 Desktop/手机展示仍待手动验证。
- 重试必须匹配当前 taskId 与 workspaceIdentity；等待停止阶段覆盖稍后完成授权的消息，取消后的旧回调不能更新新一代状态。
- 首次根引用及其附件在提交时统一去重，重新计算原消息附件索引；后续消息自身附件保留。回归测试覆盖已提前准备的根资源。
- 旧话题排队/Steer 丢弃事件只更新原输入状态，不发送排队提示；话题中断不再重复发送停止通知。
- 专用话题根通过原生消息接口校验 thread_id 与同群根消息；旧 alias 仅在空闲迁移时读取，成功后删除并保存独立绑定。现有服务/Provider 测试覆盖这些路径。
- Agent 事件回放测试验证原始发送者、引用及附件索引通过 snapshot schema 后保留；真实持久化重启与手机 replayable 展示仍待手动验收。
- 自动化：群服务 81 项、Agent 投影 177 项；停止协调器、运行时停止屏障、准备状态、原始消息展示与中断标签另有专项测试。根目录、Agent bootstrap、E2E 类型检查通过。
- 提交前检查：`NODE_OPTIONS=--max-old-space-size=8192 pnpm verify:pre-push` 通过（Lint 43 项既有 warning、0 error）。脚本只枚举已提交差异，因此另行检查本次暂存内容：15 个修改测试文件通过；24 个修改源文件的完整关联集使用 `vitest related --run --pool=forks --maxWorkers=2`，893 个测试文件、9,916 项测试通过，4 项跳过。
- 环境记录：Node 24.14.0 的 threads 测试池多次在 V8 内存回收线程发生 SIGSEGV（macOS 原生报告可查），提高堆上限仍偶发；最终改用独立进程隔离，同一关联测试范围完整通过，未关闭检查规则。
- 未启动 dev、未运行 UI E2E。真实飞书/Lark、Desktop/手机、跨系统及真实重启恢复均待用户按材料文档步骤手动验收，自动测试不代替这些结果。

### 迁移与验证边界

旧独立任务保留；指向默认任务的 topicAliases 仅用于一次性迁移，在安全空闲
边界创建独立任务，保存独立绑定并删除旧 alias，作为迁移完成记录。保留原任务，不复制完整旧上下文。
移除常驻 alias 路由，不维护两套话题执行实现。

Desktop continuous、手机 replayable、owner/lease、workspaceIdentity 和
remoteSessionId 保持既有边界。自动验证包含停止竞争、并发接入、消息去重、
材料失败、撤权及迁移；真实飞书/Lark、Desktop 和手机展示由用户手动验收，
本次不启动 dev。未完成的真实验证必须在交付中明确列出。

### Historical attachment retrieval (local/stdio/WebSocket integration under verification, 2026-09-08)

Remote forwarding uses a private reverse channel on the existing Desktop-to-server
stdio connection. Only the credential-owning Desktop Host authorizes/downloads the
resource. The source connection must validate the current logical workspace and
remoteSessionId before invoking Bot authorization. The model cannot choose a Host,
URL, credentials or transfer destination. Desktop and mobile stream profiles remain
unchanged.

Resource transfer uses begin/chunk/finish/cancel, at most 384 KiB per decoded chunk
and the existing 20 MiB attachment limit. At most two live downloads per connection
are retained for 120 seconds; overflow rejects immediately without queuing. Every
chunk and finish rechecks the original authorization. Cancellation, timeout and
connection close abort downloads and erase retained bytes. The receiver checks the
declared byte count and SHA-256 before passing the file to its existing CLI uploader.
This short-lived resource transfer state is not an accepted input or execution queue.

For a shared WebSocket Server, register a private resource peer only on the existing
capability-authenticated `/ws/host` connection. Bind workspaceIdentity + remoteSessionId
from trusted V4 facade calls, never message bodies. Two live peers cannot claim the
same route; closing a peer removes its routes. A normal `/ws` mobile/browser connection
cannot register a resource peer. Each reverse request resolves exactly one peer and
the Desktop then revalidates its own current logical session and Bot authorization.
There is no last-client fallback, broadcast probing, reconnect or new runtime.

```text
Remote CLI -> remote Host -> same stdio reverse channel -> Desktop Host
                                                        authorize + download
Remote CLI <- existing attachment uploader <- bounded chunks + final authorization
```

Native verification found that a file reply in the dedicated topic UI offered forward,
recall and selection actions, but no quote-reply action in the inspected client. The
archive retains a file placeholder; the `ReadTopicResource` tool
now requests the original resource through a trusted input and authorization generation.
Local, SSH/WSL/Docker stdio and standalone WebSocket Server integration are under
verification; controlled transport tests do not establish native end-to-end acceptance.

The Host `readTopicResource` service now resolves a trusted input ID to its accepted
task/topic archive and validates the supplied authorization generation, group history
opt-in and workspace identity. It rechecks authorization around native I/O and returns
one size-checked transport-ready attachment. Provider metadata lookup supports file,
image and rich-text image messages; cancellation reaches the native download. This
service is the download boundary. The local Agent reverse request uses existing chunked
upload into its own CLI, validates the bytes and writes a session binary artifact. A final
authorization check runs after upload before returning the reference. Stdio callbacks
use the bounded private reverse channel described above. Native local/remote file
materialization and original-topic delivery remain pending verification.

The retrieval capability must bind to the executing task, not model-supplied bot/chat
identity. A model may select a message/resource reference already present in that
task's admitted topic background; it cannot request arbitrary group history. Host
validates the current task/workspace identity, parent and topic authorization generation,
and the original native message's chat/thread before downloading. Recheck authorization
after network I/O before exposing bytes. Disabled/rebound/unrelated topics fail closed.

```text
current task tool -> typed Agent/Host request (archived message reference)
                  -> Host task + workspace + group/topic authorization
                  -> native message/resource verification and download
                  -> existing chunked target-runtime attachment transport
                  -> bounded tool result / target-local resource reference
```

Reuse dependency-injected Agent ports and reverse protocol requests; keep provider
credentials in Host. Maintain cancellation, resource lifetime and atomic failure
semantics. Remote requests carry workspaceIdentity and remoteSessionId and return
target-accessible resources, never Desktop absolute paths. This lookup is read-only
task work, not a new input queue, approval response or change to execution policy.

Required regression: an archived same-topic file can be read on demand; an unarchived,
cross-task/chat/thread reference, revoked authorization, failed download or interrupted
transfer returns an explicit failure without exposing partial data. Native acceptance
must ask for a value found only inside the file, verify runtime content and original-topic
delivery, and separately record remote workspace coverage.

Group enable/disable is group-wide. Within a topic, new/clear instruct the owner to open
another topic; task displays its bound task without cross-topic switching. Stop,
configuration and interaction controls affect only the bound conversation, subject to
existing role/busy restrictions. Group reauthorization rotates the version for all topic
contexts; pending deliveries are invalidated, not replayed. Every send/card action checks
group authorization plus topic/task/run/request identity. An unavailable source message
may fall back only to the same thread; never to main chat or another task.

UI reuses task list/conversation/queue/approval surfaces. Title defaults to group plus
topic title. The reply action bar does not expose topic details or a topic context dialog.
Summary corrections are ordinary task input. Only failed or unknown deliveries expose
recovery controls in reply actions; do not restore BotGroupTaskNotice or composer result panels. Desktop continuous
and mobile replayable boundaries, owner/lease and workspace identity remain unchanged.

Acceptance includes two ordinary topics, dedicated topic groups, bot-result follow-up,
plain-message silence, incremental overlap/ACK races, long-context/gap/summary conflict,
cross-topic card attacks, disable/restart/remote disconnect, attachments and delivery.
Run protocol/service tests, Desktop E2E/mobile regression and real pnpm dev:desktop CUA
against Feishu; record Lark/cross-platform limitations separately. Automated fixtures
are not evidence of real tenant permissions or native topic behavior.

Service-level card acceptance explicitly verifies sibling-topic attacks: a queue card
from topic A used in B, another chat, with another task or an old authorization version
must return a toast-only rejection before calling CLI cancellation. An unrelated member
cannot cancel A's input even with its otherwise valid card. The original author may
cancel the matching A input; B's input remains accepted. Re-enabling the parent group
must not make either topic's earlier cards valid again. These controlled tests establish
service authority only, not native callback delivery or multi-device timing.

## Inputs and commands

Only user messages mentioning the current bot are admitted. Strip only that bot's
mention; preserve other mentions. Deduplicate by provider message ID, not text or
event ID. Text and rich-text images are supported. A reply mentioning the bot can
attach the explicitly referenced image/file from the same chat (and same topic when
applicable). Topic history follows the opt-in contract above. Attachment preparation
is all-or-nothing and uses existing size/type rules.

Everyone can submit prompts and use help/status. Only the initiating actor or the
owner can answer ordinary questions or cancel that actor's queued request. Only
the owner can enable/disable, new/clear, stop, workspace/project, model, mode,
think, reconnect, task, or approve/deny permissions and plans. Existing command
policy also applies. Bind remains private-only; reply granularity is fixed to
summary in groups. Help is role-aware; cancel only cancels a menu. Ordinary text
never implicitly answers a group interaction. Desktop/mobile questions belong to
the owner. The first valid answer wins; stale or unauthorized callbacks do not
mutate cards. Owner authorization is checked in the service, not in card markup.

`/new` creates a draft; the next prompt creates the task. Old tasks retain history
but lose active delivery. Task history/selection is restricted to this group.
Running, pending interaction or queued input blocks task/workspace switching.
Stop retains the canonical Desktop queue semantics. Queue cancellation operates on
the CLI item; racing execution cannot stop the whole task. Message edits/recalls
do not automatically cancel, edit or roll back accepted input.

## One input queue and delivery

```text
group mention -> verify/deduplicate/prepare attachments --+
desktop/mobile input -----------------------------------+-> owner route
                                                          -> CLI CommandInbox
                                                               |       |
                                                     UI projection   group result
```

Group input requests FIFO delivery, never automatic steering. Order is CLI
admission order, not client timestamps or attachment download start. Acknowledge
only after admission; queued replies offer cancellation. Stable command IDs allow
ACK recovery without duplicate execution. Interactions and cancellation bypass
ordinary input queueing. Text and attachment references survive queue operations,
promotion and transcript persistence. No second accepted-input queue in the Host,
Bot service, renderer or relay.

Groups receive final per-input summaries, necessary questions/approvals and terminal
failure/stopped/discarded status, never streaming/tool progress. Replies reference the original message when possible. Do not prepend the sender name
or open_id to reply bodies, including stopped/failed/discarded notifications.
Desktop/mobile source labels remain for inputs from those devices. A recalled source
falls back only to the same authorized group. Desktop/mobile inputs also deliver
to the currently attached group. Private replies keep streaming cards.

Group message reactions reflect canonical input lifecycle instead of permanent OK.
Only after CLI admission may a queued input show waiting; direct execution shows
working. Run start replaces waiting with working, completion shows success, and
failure shows error. Cancellation/stop removes the bot's status reaction and
keeps the existing textual explanation. Late admission acknowledgements cannot
overwrite running or terminal state. Repeated events must not stack reactions.
Only this application's reactions may be replaced; member reactions are untouched.
Provider failures are presentation failures and never resubmit or reject an
accepted input. Native emoji mapping: waiting `OneSecond`, working `OnIt`, success
`CheckMark`, error `CrossMark`, cancelled/stopped no reaction. On mutation, list
the message's reactions to reconcile this application's status after restart;
never delete member/other-app reactions. This does not resume discarded work.
Queue acknowledgement uses one compact row with localized waiting text and a
cancel button, preserving the existing authorization and command payload.
The same queue card follows the input lifecycle: waiting (cancel enabled), working,
done, failed, stopped, cancelled or discarded (all without cancel controls).
Persist the card message ID and input state per canonical input. A card whose
creation completes after run start/completion must immediately catch up to the
latest state; late admission and repeated events cannot revert the card. Serialize
card mutations per input and recheck group authorization/current task before each
update. Card failures never replay execution. Existing cards without a saved
message ID are not discoverable by scanning group history.

Persist task/group association and result delivery records, including stable send
IDs and payload, to support Host recovery and result-only retry. Revalidate bot,
group and active task before every send/retry. Disable/task-switch invalidates old
pending delivery. Unknown send outcomes require reconciliation; retries must not
rerun the task. Respect rate limits and split oversized results. Scheduled output
also rechecks group authorization. No replay of output suppressed during disable.

## UI, authority and recovery

Reuse existing desktop/mobile task, transcript, queue and approval components.
Show group/source/sender in the task and transcript. The composer does not show a
persistent group-sync or shared-workspace banner (2026-09-07 product update).
Only unresolved delivery failures/unknown outcomes show the recovery panel; it
disappears when all results are resolved. Delivery failure has result-only retry. Status
uses workspace display names, never internal absolute paths or credentials.

Default group execution requires approval, without inherited private auto-grants;
only owner-controlled configuration/approval changes policy. Source metadata is
trusted attachment data, never authority derived from prompts. New protocol data
has strict runtime schemas and remains backward compatible for private inputs.
Persist group state separately from private bot state, serialize shared-file writes.

Keep desktop-continuous, web-remote-replayable and bot subscriptions separate.
Preserve owner/lease/stale-run routing, workspaceIdentity and remoteSessionId.
Disconnected remotes only reconnect via explicit reconnect; do not run locally.
UI rebuilds use existing queue recovery; CLI restart retains the existing explicit
discarded semantics. Runtime logs omit secrets/content; high-frequency logs are debug.

## Acceptance

Tests cover owner activation/revocation; two groups and private isolation; exact
mentions; duplicate delivery; attachments and cross-chat rejection; one mixed-source
queue; cancel/start races; actor/owner interaction rules; stale multi-client cards;
approval isolation; draft/new/history switching; stop/disable/removal; per-input
summary and Desktop delivery; rate limits/unknown outcomes/result-only retry;
Host/CLI restart and remote boundaries; mobile, themes and locales. Implement tests
before code. Run typecheck, lint, focused unit/integration and Desktop E2E. Real
Feishu and cross-platform results must be reported separately from fixture tests.

### 飞书接口权限核对（2026-09-07）

接收群 @ 事件使用 `im:message.group_at_msg:readonly`。读取明确引用的消息及其附件还需应用身份的 `im:message:readonly` 或 `im:message`；这与订阅全群消息事件的 `im:message.group_msg` 是不同权限。仅配置 @ 事件权限不能保证附件下载成功。机器人必须仍在原消息所属群中，并通过服务端同群校验；权限不足、消息不可见或附件不可下载时整条输入失败，不执行剩余文字。

依据：[获取指定消息内容](https://open.feishu.cn/document/server-docs/im-v1/message/get)（2026-04-10 更新）、[获取消息中的资源文件](https://open.feishu.cn/document/server-docs/im-v1/message/get-2)（2026-08-27 更新）。未使用全群历史查询接口。

### Delivery reconciliation

An uncertain send is never retried automatically. Desktop/mobile expose delivery recovery beside the timestamp in the corresponding
completed reply action bar. No recovery panel is mounted above the composer or
queue, and saved result bodies and sender IDs are not repeated. A compact localized
icon opens a popover with retry or reconciliation actions; successful and in-flight
sends render nothing. Persist an optional sourceCommandId from the trusted task event inputId on each
delivery segment. Match it against canonical user-input rows in the product turn;
runtime turnId is not the product turn ID. Records without a source command are
not guessed onto another reply.
The service projects in-flight delivery as pending while preserving crash-safe
unknown persistence; after the operation settles it broadcasts the final state. The operator can
mark it received, or confirm that it was not received; the latter changes it to a
definite failure and exposes the existing resend action. This reconciliation does
not execute a task or read group history. Both reconciliation and resend recheck
the current group authorization and task association. Concurrent delivery still
in flight cannot be reconciled. State changes use the same serialized persistence
path as group lifecycle changes.

Input origin labels use an optional `inputOrigin` (`desktop` / `mobile`) injected
by the trusted Host command attachment, never inferred from prompt text or a
client-supplied client ID. It travels with the canonical input through queue,
retry and transcript restoration; bot sender metadata takes precedence in group
replies. This display field does not change continuous/replayable delivery modes.

Each historical group task also retains its workspace path and optional identity.
After changing the current workspace, `/task` can still list that group's earlier
local/connected workspace tasks, and Desktop can label an earlier task as paused.
The history map is not an access grant for unrelated tasks or a request to connect
a disconnected remote workspace. Older records fall back to the current workspace.

The per-message input association persists its admission outcome. A repeated
provider event for an accepted input never issues a new admission, including
after Host/CLI restart. An unresolved admission is reconciled through the existing
stable command query while the original request is active; later redelivery does
not guess that an unknown command was never executed. It reports that the operator
must check the task, rather than submitting that message again after dedupe expiry.

Remote group controls use the already validated attachment scope:

```text
Bot group input / queue control
  -> existing remote MessagePort attachment
  -> Host injects workspaceIdentity + remoteSessionId
  -> task adapter validates the loaded task's workspace identity
  -> existing Agent owner route / CLI CommandInbox
```

The three group queue service methods carry optional remote target fields for
compatibility. A target from another workspace is rejected before uploading any
attachment or reading/changing its queue. Local calls retain their existing target.

Saved deliveries retain the group authorization generation that created them.
Disable/re-enable, bot removal and rebinding cannot make an in-flight retry valid
again merely because the same task remains current. Every retry checks both the
saved invalidation status and that generation immediately before sending.

Group task creation requests `permissionScope: session` on the V4 create command.
Only this path persists the task immediately and initializes an empty build-mode
session ruleset before acknowledging creation; normal Desktop drafts stay deferred.
Group draft configuration is applied afterwards, so an owner's explicit mode choice
is retained and cannot update the shared project ruleset. The first-input guard
remains for older group tasks, but does not reset an already isolated session.

## Group member display names

Group attribution resolves names from the current chat's member directory using
`GET /im/v1/chats/{chat_id}/members?member_id_type=open_id`, with the application
permission `im:chat.members:read`. Private chat contact lookup remains unchanged.
The provider follows pagination, coalesces concurrent requests, and caches names
per provider, bot, application, credential reference and chat for one minute.
Failures receive a short retry backoff; partial directories are never published.

A read-only service authorizes directory access against the enabled bot and group,
including a second authorization check after network I/O. The UI shares one lookup
across historical messages and queued inputs without rewriting saved source IDs.
Current names take precedence over saved names. Missing names use only the last six ID characters, without a generic member label; hover and click/tap expose the full
ID. Names never participate in authorization. Directory failure must not reject
otherwise valid input or delay task/delivery status rendering. No task queue or
Desktop continuous / mobile replayable semantics change.

Validation covers pagination, request coalescing, failure backoff, bot/chat
isolation, disabled/rebound access, history and queue attribution, fallback and
full-ID disclosure. Real tenant verification is separate from controlled E2E.

Conversation attribution has an 8px gap before the message bubble, using the
shared spacing scale. This applies to Desktop and mobile conversation rows;
queue attribution retains its compact layout.

# 话题原文回查实现契约

2026-11-03 起，Agent 不再用工具回查话题原文。`ReadSessionContext` 已删除，见 `docs/architecture/zcode-app-control-design.md` 0.8。话题增量已作为 `text/plain` 话题历史附件随用户消息给模型。旧 `topicContext` 原文的兼容读取一并删除。下载话题里的文件或图片改用 `ReadTopicResource`。不把摘要当作原文；尚未获取的消息不声称已归档。下一次 @ 的有限原生 API 读取继续负责新增归档。

任务摘要来自 model-only `bot_topic_context` 记录，原文与摘要都保留引用依据。

实现边界：覆盖范围以已归档消息 ID、当前唤起检查点及 `hasGap` 表示，不推断无法读取区间的消息数量。回复操作栏不提供话题详情入口或摘要弹窗；移除此 UI 不改变服务端话题归档。话题原文只覆盖已读取、已接收的输入背景；未读取的早期历史不会自动联网补取。真实租户及跨平台验收状态记录于 `docs/testing/bots-e2e-coverage-matrix.md`。

## 明确引用与仅提及（2026-09-08）

- 主聊天普通消息不触发执行。主聊天只有 @、无引用或附件时，返回补充需求提示，不创建任务或执行表情。
- 明确引用文字后只 @：当前需求为处理引用消息，原文保留为带消息 ID 的引用材料。@ 后有新要求时，以新要求为准。引用中的命令不经过命令解析器。
- 引用的文字、富文本及附件必须可读且属于同群同话题；不可读、撤回、格式不支持时明确拒绝，不静默忽略引用。
- 话题内只有 @：仅在群已开启历史读取并有可用话题背景时提交“结合讨论处理明确问题，意图不明则询问”；没有可用背景时提示补充需求。历史读取失败不执行空需求。
- 显式引用不依赖历史开关；主聊天 `@ hello` 不隐式读取相邻消息。附件与引用正文一次入队，CLI 确认前不显示执行／排队表情。

```text
可信 @ → 原生引用校验 → 保留当前要求 + 引用材料
       → 空需求：明确引用 / 已授权话题背景 / 补充需求提示
       → 一次 CLI admission → 表情及原位置回复
```

### 冷启动后的群输入

真实开发环境重启后，默认群任务仍存在于数据库，但 Bot 直接提交 V4 命令时运行时尚未加载，返回 `proto.sessionNotFound`。群输入在附件上传与 admission 前通过已有后台订阅取得原任务的 CLI 权威快照，复用冷恢复 READY 屏障；失败则拒绝本次输入，不新建任务、不重放历史输入。工作区身份与远程 session 原样传递。Desktop continuous、手机 replayable 路径保持不变。

冷启动恢复还必须先取得权威快照，再建立 Bot continuous 结果订阅。否则旧 session 订阅会因会话尚未加载耗尽重试，导致后续输入虽执行成功却没有结果回推。此恢复只读取状态，不提交或重放输入；远端仍先检查现有连接。

仅引用唤起的模型输入明确委托“回答引用消息中的问题或完成其中的请求”，引用段只标识原文来源。命令隔离由服务端在拼接引用前完成，不用含混的“不是指令”提示阻止模型处理用户明确引用的需求。

## 访问令牌有效期

真实群内仅 @ 验证发现：事件正常接收，但提示投递返回 `99991663`。Provider 原先把每次获取的令牌固定缓存 90 分钟，忽略接口 `expire` 返回的剩余有效秒数；获取已有令牌并不意味着重新获得完整有效期。缓存必须使用请求开始时间加返回的 `expire`，沿用提前 60 秒刷新。缺失或非法有效期不缓存，不猜测有效期；本次合法令牌仍可用于本次请求。此修复不重放失败需求，不改变队列或 Desktop continuous／手机 replayable 链路。

```text
读取缓存 → 剩余有效期超过 60 秒 → 使用
         → 否 → 获取令牌 → 按 expire 保存有效期 → 本次调用
```

### Bot 附件 admission 连接身份修复（2026-09-08）

原生富文本消息触发 `fault.attachment.connectionUntrusted`：Bot task adapter 直接调用裸 Agent 附件接口，未经过现有 V4 connection scope 注入可信连接身份。修复按工作区身份及 remoteSessionId 为 Bot 接入复用独立 connection scope，同一目标的 Bot snapshot、附件、admission、命令对账与取消共享连接；不增加 runtime 或队列，不修改 Desktop continuous／手机 replayable 各自 attachment。工作区身份和 remoteSessionId 继续透传。

```text
Bot task adapter → Bot trusted connection scope → existing Agent client → CLI CommandInbox
                    └ attachment begin/chunk/commit use the same connection
Desktop / mobile → existing own connection scopes ────────────────────┘
```

### 2026-09-08 话题交互卡投递回归

真实 CEDAR 话题中审批卡出现在群主聊天。临时审批／问答卡必须与普通回复使用相同的
话题锚点解析：优先 replyToMessageId，其次 rootMessageId；有 threadId 但没有锚点时
发送失败，不能回退到群主聊天。创建卡片必须传 reply_in_thread，后续更新保持同一卡片。
创建与更新交互卡都保留 groupCard 中的群、话题、任务及授权版本，临时卡路径不能绕过
普通群卡的身份约束；权限模式归一化为 streaming_card 不应丢掉这些字段。

### Standalone Server reverse resource regression

Both HTTP Server entrypoints require transport tests on real loopback WebSockets:
only capability-authenticated /ws/host attaches a resource peer; ordinary /ws does not.
Two simultaneous Desktop connections with different remoteSessionId values must receive
only their own reverse validation requests. Closing one connection removes its route
without removing the other. These tests use synthetic resource readers, not a live tenant.

## App 已绑定群聊（第一期）

机器人设置中，飞书/Lark 当前机器人的工作区访问范围下方展示扁平群列表。
视觉复用机器人设置的 SettingsGroupCard，标题与行统一 px-4/py-3，边框、背景和圆角与相邻设置一致。
每群仅一行：群名（长名称截断并保留 title）、已记录话题数量、群级开关；
不展示任务、话题明细、展开箭头或详情入口。话题数是当前绑定用户下已记录的
不同 threadId 数量，包含已退出话题，不表示飞书全群的实际话题总数。
只展示当前 botId、当前 ownerId 的群默认记录，按 chatId 聚合话题，私聊不计入。

```text
群列表 hook -> getBotStates -> 群默认记录 + 去重话题计数
群开关 -> setGroupEnabled -> 既有群授权 owner -> bots:group-state -> 重新读取
```

UI 不乐观修改授权状态；保存期间禁用开关，失败显示可重试错误。切换机器人或
关闭页面后，迟到读取不更新新页面。接收群状态广播后刷新，重新开启不补发历史。
关闭群保留任务，沿用 /disable 的输入、卡片与回推失效语义。机器人总开关关闭时
保留群配置但禁用群开关并说明原因；不会借群开关自动开启机器人。
无绑定群时引导在群中 @机器人发送 /enable。加载失败不能显示成空群列表。
复用既有 services/RPC，不改变 desktop continuous 和 mobile replayable 任务链路。

手动验收：中英文、深浅主题、窄屏单行截断；两个机器人/两个群不串行；0/多个话题
计数；切换与重开页面状态同步；关闭/重新开启不删任务、不补发；失败恢复可重试。
本期按用户要求不启动 dev，真实界面及手机远控由用户手动验证。

## 群回复引用与发送者提醒（2026-09-23）

群内直接回复（任务结果、命令、补充需求、错误提示、审批和问答卡）使用飞书原生引用，
并在卡片开头以真实用户 ID @ 本次提问者。用户引用他人再提问时，引用与 @ 均指向
当前提问者，不取被引用材料的作者。话题内仅在触发消息明确 @ 机器人时才 @ 发送者；
普通话题消息只引用、不 @。群主会话与私聊保持原行为。

每轮根据可信 inputId 读取既有 inputs.source；不得使用最近发言者、群 owner 或上一轮
来源猜测对象。话题合批引用 source.messageId（该批最后一条），首条正文回复按输入
顺序 @ 本批明确 @ 机器人的去重发送者，未明确提及的参与者不提醒。长回答每段引用同一消息，仅首段 @；独立交互卡单独提醒，
PATCH 原卡不新增提醒消息。@ 只用于展示，不改变原有审批/问答权限。

```text
群消息 → 既有输入来源（消息/发送者/合批列表）→ CLI 接受输入
      → 带 inputId 的结果 → Bot 确定回复对象 → 既有 delivery 持久化
      → 同一群/话题授权检查 → 飞书原生 reply + 卡片 at
```

输入与队列仍由现有 owner 管理；delivery 仅保存已生成结果的引用、mentionedUserIds、
分段和稳定投递 ID。重试从该记录恢复，不重新解析当前群状态中的发送者。
桌面/远端任务继续使用 bot-channel-continuous，手机 replayable 边界不变。
无可信群输入的客户端或定时任务结果不生成个人引用或 @；话题位置仍使用原话题锚点。
旧投递无 mentionedUserIds 时保持原行为，不猜测、不补发历史提醒。

原消息失效仅在明确拒绝后降级：普通群去掉引用，在原群保留 @；话题先尝试不同且
有效的根锚点一次，根锚点也被拒绝则失败，不能降级到群主聊天或循环重试。
超时等不确定结果维持 unknown，不自动重发；限流、重启后的允许重试保留原回复
对象；停用/换绑继续由原授权版本使投递失效。命令和临时卡沿用同样的引用降级规则。

验收：单人、多人交错、引用他人、话题合批、长回答分段、命令与独立交互卡均正确
关联；无来源和私聊不增加提醒；撤回/根锚点失效/限流/超时/重启不会串人、循环或
重复投递。单测断言路由、卡片和持久化；真实飞书客户端的引用跳转、@ 展示及通知
需独立实测，不能由 mock 通过推断。

### 话题模型继承边界（2026-09-23 修复）

新话题从群当前任务的 getTaskModelSelection 读取结构化模型快照，保留 providerId、
modelId 和 options.reasoningLevel；不得从 model 配置菜单或 task.model 显示值反推。
例如显示值 GLM-5.3-Flash$max 应继承模型 GLM-5.3-Flash 和独立的 max 思考等级。
群仍为草稿时继承其明确 draftOptions；话题创建后保持自己的快照，不随群后续选模
自动变动。已有错误草稿需明确修复，本次不引入执行时对错误 modelId 的兼容。

## 管理员待办提醒（2026-09-23）

群聊和话题需要管理员处理时，以绑定的 bot.providerUserId 为唯一收件人生成真实 @：
管理员专属操作被拒绝、权限审批、计划审批、群未启用、历史关闭、模型选择不可解析、
工作区不可用或越界、远端断连/重连失败。普通问答、任务结果、一般工具错误不升级为管理员待办。
飞书应用权限不足只给应用管理员配置指引，不推断绑定用户有应用管理权限。

管理员提醒替换普通发送者提醒，保留原生引用和原话题位置。未经授权的卡片点击仍只 toast，
首次需要管理员协助时另发独立通知，不更新共享审批卡或授予点击者权限。

```text
服务识别管理员待办 → 当前绑定身份 + 群/话题 + 原因/审批请求
                   → 本进程通知去重 → 原有发送/交互卡链路
成功接收新输入/对应阻塞恢复 → 清除阻塞提醒记录 → 后续再次阻塞可重新提醒
```

去重仅是有界的内存通知记录，不新增任务/输入队列；服务重启或记录被容量淘汰后允许再次提醒。
同一阻塞持续期间后续提示保留文字但不再 @；不同话题、管理员或审批请求相互独立。
审批卡 PATCH 不生成新提醒，普通补充问题不占用管理员提醒记录。
验收覆盖上述正反场景、多人重复操作、话题隔离、恢复后再次提醒，以及按钮拒绝不修改原卡。

## 原生 mention 节点与渠道回复（2026-09-23）

2026-10-21 当前入口：ReplyToChannel 的默认注册、Host 默认发送接线和模型调用提示仅注释停用，
权限、协议、发送实现和测试材料完整保留，未来插件尚未实现。下述主动渠道回复与按名字提及
不再由默认 Agent 暴露。原生输入节点、分工识别、UI 展示、普通最终回复自动回传继续保留；
模型分工材料不再携带发送用 refId，原提示源码保留为注释。

```text
Bot 输入 → 持久化来源 → 模型分工上下文 → 最终回复 → Bot 自动回传
ReplyToChannel 默认注册 / Host 发送接线 / 模型调用提示：注释停用
ReplyToChannel handler / 权限 / 协议 / Bot 发送实现：完整保留
```

本次不增加避让规则。可信飞书 mention 在 BotGroupInputSource.contentParts 中按原顺序保存，
合批逐条保存；appId 与既有 botId/chatId/threadId/messageId 一起界定应用与会话。
text 仍是兼容投影，必须等于节点拼接结果；客户端只根据可信节点渲染，不从 @name 文本恢复身份。
普通文本、名字及引用材料本身不构成发送地址；名字须经下述 Host 查询解析才可发送。
未知目标类型允许原生提及，@所有人不进入个人节点。

输入 → Provider 节点 → 既有 inputs.source / canonical intent → queue / transcript / desktop continuous / mobile replayable
执行 → ReplyToChannel(refId, text parts) → CLI 执行输入标识 → 已鉴权 Host 反向请求 → Bot 任务绑定检查 → 既有 delivery → 飞书回执

ReplyToChannel 仅用于用户明确要求的额外原生回复，不能指定任意群、机器人或裸 ID。
服务以工作区和 task 唯一解析当前绑定的群聊/话题，验证授权版本与 appId；不要求当前输入携带 botGroupSource。
引用节点可来自该任务在同一有效绑定下已接收的原生消息，支持桌面及手机续聊“再 @ 一下他”。
结果区分 sent/failed/unknown/invalidated，只有 sent 才确认发送；稳定 toolCallId 对应一个投递记录。
节点化正文按顺序生成原生 at，不能解析模型普通输出里的 @name 或 Markdown 为发送命令。
系统发起人/管理员提醒与正文 mention 去重，正文 mention 不改变审批权限。
旧消息没有节点时保持文本，不猜 ID；其他任务、群聊、话题、旧授权或换绑应用的节点不能成为发送目标。

工具按已落盘 toolCall 所属 assistant.parentID 取执行 inputId，渠道绑定与目标解析由 Bot Host 独占；
后到队列输入不能替换正在执行的发送对象。发送前还检查输入未停止/取消、应用未换绑。
正文限制 1–2000 字符，单条投递；同一 toolCall 重试返回持久回执，不确定结果不自动重发。
取消在发出 Host 请求前阻止提交；请求发出后无法撤回已送达消息，调用方取消/断连不能当作未发送。
trace 随反向请求、远端转发和投递记录保留。

客户端正式消息、准备态和队列共享渠道 chip（@姓名 + Feishu/Lark）；无节点的旧消息保持原展示。
复制或撤回到普通文本编辑器后不携带渠道发送授权，不从字符串重新构造可发送身份。
显示层文本与节点投影不一致时回退普通正文，避免编辑后仍展示过期的目标关联。

ReplyToChannel 默认免工具审批：build、edit 和 plan 模式下，回复既有授权会话无需再次弹出权限请求；
仍标记为真实 network 副作用，不伪装成只读工具。显式项目 deny/ask 规则保留优先级。
免审批仅适用于此内置工具及其 channel.reply 契约，其他网络发送工具保持原规则；
发送前仍由 Host 校验任务绑定、会话、应用和 refId，缺失、歧义或失效绑定直接失败并返回可解释错误。

验收：飞书原生 @ 成功后，从客户端/手机追加“再 @ 一下他”仍向同一群/话题发送；
无绑定、多个绑定、换绑、停用、其他任务/话题引用和取消输入均不能发送。
CLI → 已鉴权反向请求 → Bot 状态唯一 owner 解析绑定及历史节点 → 既有 delivery 幂等投递。
不新增缓存或 accepted queue；desktop continuous 与 mobile replayable 的输入及恢复链路保持不变。

### 按名字提及（2026-10-08）

用户明确要求“@某人/某机器人”但没有原生节点时，ReplyToChannel 接受
`{type: "mentionName", name, candidateRef?}`。普通最终输出的 @ 文本不自动触发发送。
Host 用当前任务有效绑定的群成员目录（完整分页，沿用 60 秒缓存）与该任务同一授权下
已接收的可信 mention 节点形成候选，名字按 Unicode NFKC、去首尾空白及大小写归一化
后作包含匹配；候选唯一则直接发送，候选多个时优先唯一的完整名字匹配，否则请求选择。
不解析或接收模型给出的平台 ID。保留英文名内部空格；顿号、逗号、换行等明确名单分隔
形成多个 mentionName，不仅凭空格拆名。全部名字均须查询；澄清结果列出全部未解决项，
不因第一个失败而跳过后续名字，也不将未查询或未发送说成成功。
群成员接口不包含机器人；未曾原生提及、没有可信身份的机器人须请用户原生 @ 一次。
目录查询失败不得假定“没有其他同名人”并发送。

```text
用户明确要求 → CLI ReplyToChannel(名字) → Host 校验任务绑定 → 查询群成员 + 可信节点
  → 唯一候选：解析真实 ID → 再次校验绑定/输入/凭据 → 现有 delivery → 回执
  → 多个候选：needs_clarification + 有界候选（名称、类型、区分标签、opaque ref），零发送
  → 无候选/查询失败：needs_clarification + 原因，零发送，请用户原生 @
用户选择 → 新 toolCall，名字 + candidateRef → 重新查询并核验候选 → 发送
```

不允许模型自行选择重名候选。候选仅绑定当前应用、凭据、群和授权，不能跨群/跨授权复用；
选择标识不包含裸 ID，不新增待确认队列。多目标中任意一个未解决则整条不发送。
候选最多展示 10 个，超出时要求原生 @。普通候选名单不产生 @ 通知。
同一 toolCall 的请求指纹与解析后的节点随现有 delivery 保存；回执重读不再按新目录
重解析接收人，也不重发；同一 toolCall 改名字或正文拒绝。旧投递记录保持兼容。
发送前的异步查询不能绕过换绑、停用、停止输入及 workspaceIdentity 隔离。
App/CLI 共享严格 schema；普通桌面 continuous、手机 replayable 与 Bot 投递 owner 不变。

验收：唯一用户、已知机器人、重名与明确选择、无结果、无权限、分页失败、同名不同 ID、
查询期间撤销授权、同一调用目录改名后的重放、跨应用/群/工作区候选拒绝；Feishu/Lark
和群/话题均覆盖。真实平台权限与未提供机器人目录的限制在交付证据中说明。

### 引用准备与投递重放边界（2026-10-09）

普通群中其他机器人原生 @ 并引用父消息时，引用准备与消息解析均透传真实 sender open_id；
无 thread_id 也保留被引用的文字和附件，自身机器人仍不接收。
同指纹 ReplyToChannel 重放若存在活跃发送，必须加入既有 delivery owner 的等待，平台只发送一次，
两次调用获得最终回执。落盘 unknown 是崩溃恢复标记；仅在没有活跃发送时返回 unknown，
不得因重放自动重发。此处不增加队列，不改变 desktop continuous / mobile replayable 边界。

### 多机器人身份与指派边界（2026-10-09）

Host 每轮注入当前 Bot 配置名字及 Provider 核验的自身 open_id（旧输入缺失 ID 时不猜），
并保留逐条 mentionedBot 和其他原生 mention。身份由可信元数据确定，名字只作展示，
不由正文、历史发言或机器人的自称改变。CLI 模型上下文明确共享讨论不代表共享任务：
明确 @ 自己才接下分给自己的部分；多人 @ 各自遵循明确分工；无 @ 的续聊只延续自身任务，
无关时不调用工具、不输出回复；不要为别人的任务宣布完成。普通手打 @ 无可信节点时不硬过滤。

只含其他原生 mention、未 @ 当前 Bot 的消息在 Host 入口作为背景：不执行 slash 控制、
不停止当前 run、不准备材料或提交 CLI、不重置或消耗互答额度。当前已接入话题只保存
一个 backgroundHistory 检查点和版本标记（不是输入队列），下次实际输入补读原生历史。
检查点固定为首次背景到达前最后已接收消息；后续背景更新版本但不推进检查点，避免
正在准备/提交的输入跳过背景。只有接收成功且补读版本仍匹配才清除标记；失败与重启保留。
非活跃话题不因背景激活。未 @ 的模型轮次无可见输出时不补发“任务已完成”；显式 @、
错误及实际产出保持原有回传。无新协调机器人或独立分工数据库，既有对话保存职责。

```text
Provider 身份与原生 mention → Host 入口
  只 @ 他人 → 持久化历史检查点 → 原任务继续
  @ 自己 / 无 @ 续聊 → 补读待处理背景 → CLI 注入身份与逐条指向 → 处理自己的职责或静默
```

desktop continuous / mobile replayable、workspaceIdentity 和唯一 CLI admission owner 不变。
验收覆盖同名不同 ID、纯文本 @、多人 @、并发历史准备、重启恢复、未接入话题及空回复。

### 原文中的自身 mention 保留（2026-10-09）

原生消息中的所有 mention（包括当前机器人）都保留为有序 channelMention，保持姓名、位置、
目标 ID 和 refId；供界面、输入持久化和模型使用。此前把自身 mention 换成空字符串，
实际多人分工输入因此丢失了每段工作的指派对象。
Provider 另提供临时 commandText，只移除开头连续的自身原生 mention 和相邻空白；
控制命令及纯唤醒识别使用该副本，普通消息始终使用原文。正文中间、其他收件人及手打 @ 不剥离。
text/post 两种入站格式都遵守同一规则；不改变自身回声过滤、机器人互答上限和群聊身份验证。

### 机器人交互卡片排除（2026-10-09）

仅带按钮、选择器、输入框、表单等操作控件的机器人卡片不作为自动回复输入。interactive
只是飞书卡片载体，纯 markdown/text 对话卡片仍正常参与讨论。机器人引用操作卡片的确认
消息同样过滤；引用普通对话卡片的回复不被过滤。不依赖中英文确认文案。
Provider 使用原生 mentions 和卡片中的有序 at 节点恢复可信 mention；发送端正文 ID 与
接收端 ID 不同的情况使用平台提供的有序 mentions，不能把原始正文 ID 当成本端身份。
卡片事件若只包含客户端升级占位内容，通过同群同话题的原生消息接口读取真实卡片；
读取失败不提交 CLI。历史通过可选 controlCard 分类过滤操作卡片及本批次中引用它的
机器人确认回复，普通对话卡片保留，扫描边界和检查点不变。真人主动引用卡片、真人点击
仍走现有授权流程。自身回声、连续五条上限、桌面 continuous 和手机 replayable 不变。

### 群聊停止静默（2026-10-09）

群主聊天与话题内成功停止任务（包括取消、打断）后不发送停止通知或状态卡。
停止执行、输入状态、表情与任务列表更新仍正常完成；停止失败和无活动任务保留错误提示。
私人会话行为不变，不改变 CLI admission、桌面 continuous 或手机 replayable 链路。

### 跨任务名字查找（2026-10-09）

名字候选复用当前群绑定中同 bot、同 app、同 provider、同 chat/thread、同授权的已接收
历史输入原生 mention，不按 taskId 或结束状态删除候选。旧任务身份只参与 mentionName
解析，旧 refId 不能用于直接发送；当前任务的发送授权、撤销、并发复核和目录失败策略不变。
不读取其他群或其他授权，也不把本地 bot 配置里的 ID 当成本端原生 ID。

### 评审回归边界（2026-10-09）

历史分页先用原生元数据确定调用边界/checkpoint，并排除删除消息，再展开窗口内卡片。
窗口外卡片读取失败不得阻断输入；窗口内必要材料读取失败仍禁止提交。
停止期间合并批次的有效性逐条判断 commandText/正文、引用与附件，不用尾条的命令副本
代表整个批次，不重新解析合并正文为控制命令。模型的可信 mention 投影按原生目标 ID
计算 isCurrentBot，让同名收件人的具体位置可以关联自身身份，不暴露其他收件人 ID。

```text
历史元数据 → 边界筛选 → 必要卡片展开 → CLI admission
逐条输入 → 停止屏障 → 全批次有效性判断 → 保留原始消息提交
原生 mention targetId + 当前 bot openId → isCurrentBot → 模型分工
```

当前授权、Host 持久化 owner、CLI 单一 admission、desktop continuous/mobile replayable 不变。

模型身份定位补充：除 mention 清单外，逐条输入投影有序 text/channelMention 节点，
让原生 @ 与外观相同的手打文本可区分；每个 mention 仅含 ref、名字、渠道及 isCurrentBot。
批次按 messageId 分组，重复 mention 保留每次出现位置；canonical 原文和持久化结构不变。
