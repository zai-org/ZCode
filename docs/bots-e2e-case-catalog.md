# Bots E2E Case Catalog

## Topic collaboration additions

- BOT-E2E-TP-01 (also covers mention-only guidance without admission and quoted text in one CLI queue input): a native-topic-bound task uses the real Host/CLI queue; Desktop
  source and attachments survive cancellation; resolving its saved delivery through
  the reply action bar targets that topic and works at narrow viewport widths.
- BOT-E2E-TP-02: two ordinary topics and a dedicated topic-group root create distinct
  tasks; ordinary discussion is silent; the next mention sees only the incremental
  background up to its own message. Requires real Feishu CUA evidence in addition to
  provider/service tests. No fixture can prove tenant permissions or native routing.

本文记录 Bot 渠道的端到端行为合同。Bot 用例独立于 conversation-session：它们复用 ZCode task stream，但入口、状态所有者和外部证据位于 `BotsService` 与 provider API。

## 范围决策

| 边界               | 决策                                      | 理由                                                          |
| ------------------ | ----------------------------------------- | ------------------------------------------------------------- |
| 本轮主范围         | Feishu/Lark `streaming_card` 完整生命周期 | 这是分支中用户可见且跨层风险最高的行为                        |
| Provider 环境      | CI 使用 mock Feishu HTTP API              | 避免真实租户、凭据和网络造成不稳定                            |
| Task 时序          | `controlled-stream`                       | 必须观察运行态展开与终态收起，`fast-text` 无法证明中间状态    |
| 客户端语义         | `bot-channel-continuous`                  | Bot stream 不进入手机 `web-remote-replayable` 恢复语义        |
| 多 host runtime 锁 | 后续独立 process E2E                      | 当前已有 service integration 回归；多进程夹具不与卡片语义混跑 |
| Plan approval UI   | 排除                                      | 与 Bot 渠道生命周期无直接状态交叉                             |

## 接受用例

### BOT-E2E-AT-01：文件与富文本附件提交

- Setup：Feishu/Lark 私聊及已启用群聊；平台资源接口返回 6 MiB 独立文件，以及 3/6 MiB 富文本文件，使用隔离的附件缓存和任务服务替身。
- Action：原生 `file` 和包含正文及顶层 `files` 数组的 `post` 消息经 provider callback 进入 Bot，下载附件并提交本轮输入。
- Assert：附件完整缓存，字节与平台响应一致；私聊 prompt 包含缓存路径，群聊提交携带完整文件附件；不返回大小超限提示；下载失败仍返回可操作错误且不提交任务。
- Evidence：平台 HTTP 请求、真实缓存文件及任务提交参数；不代表真实租户、模型、手机 UI 或远程传输验证。
- Status：accepted，manual-review pending；`bots/delivery/bot-large-attachment.test.ts`。2026-11-06 macOS WDIO 隔离回放 12/12 通过，运行证据见覆盖矩阵；未转正或新增 CI 准入。

### BOT-E2E-MODEL-IMMEDIATE：桌面选模后直接飞书续聊

- 档位补验：已有会话保持 Provider/Model 不变，仅通过滑块或快捷键切换档位，不从桌面发送；
  Session Selection 必须先确认目标档位，随后真实飞书输入的请求使用该档位。
  运行中及已排队输入继续使用原档位；未绑定草稿不提前创建会话。
- 2026-11-03 macOS 修复开发构建实测：同一 GLM-5.3 Coding Plan 从 Max 调到 High，
  未发送桌面消息，直接飞书续聊；真实请求 `output_config.effort` 由 `max` 变为 `high`，
  两轮均返回 OK。Session 更新事件与消息快照一致；队列及运行中 usage E2E 2/2 通过。

- Setup：飞书绑定已有 Session，模型为 Start；桌面打开同一会话。
- Action：桌面选择 BigModel Provider，不点击模型、不发送桌面消息，直接飞书发送。
- Assert：成功回执后的飞书实际请求为 BigModel；已有运行轮及已接纳队列保持原模型。
- Assert：配置失败不显示已切换；同名模型仍按 Provider 身份区分；新建草稿不改其他会话。
- Status：accepted；2026-11-03 macOS 真实飞书续聊通过。15:58:44 配置确认 BigModel，15:59:26 实际网络请求为 `bigmodel-standard-api / GLM-5.3`，15:59:32 完成。切换与飞书发送之间没有模型二次点击或桌面发送。
- Regression：`conversation-session-model-switch-queue.test.ts` 两项通过（运行中 auto drain、held queue 立即发送），CLI 冻结 Submission 与旧读取依据回归通过。手机真机、Windows/Linux 原生客户端未实测。

2026-10-21：ReplyToChannel 默认注册和发送接线注释停用，MN-02/FN-01 组合 E2E 暂时跳过，
原用例及 fixture 完整保留，待插件接入后恢复。MN-01/MN-03 中直接调用 Bot service 的测试
继续保护原实现。下方默认工具发送记录仅作历史证据，不代表当前入口可用。

### BOT-E2E-MN-03：无原生 ID 的名字提及

- Setup：已授权群/话题，群成员目录与历史可信机器人 mention；输入仅包含文字名字。
- Action：ReplyToChannel 按名字包含查询；唯一候选或唯一完整匹配直接发送，多人分别解析。
- Assert：英文名保留空格；全部未解决名字一次返回，不能将未查询说成成功。
- Assert：唯一目标为原生 at；重名/无结果/无权限时零发送；同一 toolCall 只投递一次。
- Evidence：MN-01 服务/平台 E2E 覆盖双渠道与群/话题；MN-02 真实 CLI 续聊通过名字查群成员。
- Status：formal；`bots/channels/feishu-channel-mention.test.ts`，用户于 2026-10-08 确认转正。真实租户权限与手机 UI 待验证，不把平台替身当生产证明。

### BOT-E2E-SR87：草稿有效选择与首次派发

- Setup：已绑定 Bot 保存个人套餐模型/high；目标选择服务返回同模型/high 的 Team 有效选择。
- Action：查看 `/model`、`/think`，再发送首条普通消息；另以失效结果尝试修改档位和派发。
- Assert：菜单显示有效身份和档位，但不改草稿；首条任务采用有效选择；失效原意图不被默认模型替代，不创建任务。
- Evidence：受控选择服务和任务服务调用、Bot 状态写入。公共解析算法由 Provider 集成测试覆盖；不宣称该用例发送了真实模型请求。
- Status：manual-review pending；范围依据 Todo87，外部飞书网络不参与。

### BOT-E2E-SR99：绑定 Session 的后续选择

- Setup：Bot 已绑定空闲 Session；Session 原选择为个人套餐模型/high，公共 View 返回 Team 同模型/high 或不可用；Bot 不存绑定后的第二份选型。
- Action：从 Bot 收到下一条普通消息。
- Assert：只用 Session 原选择调用公共 View，可用时把完整有效选择送入实际发送参数；不可用时不发送、不默认替换、不改写原选择或 Bot 草稿。
- Evidence：synthetic harness 证明 Bot 消费边界；W99-E03/E06 已在 Pro 通过生产 Task adapter 与实际 stdio Worker 请求及冷恢复。IM API 仍是隔离替身，不宣称真实飞书租户；见 Todo99 复审账本。
- Status：accepted，manual-review pending。`/model` 已裁决为立即修改/保存同一 Session，完整链路合同见 W99-E06。

### BOT-E2E-SC-01 Feishu 单卡时间线生命周期

- Setup：已绑定的 Feishu 私聊 Bot，`replyMode=streaming_card`，中文 locale；mock provider 返回固定 token、message id 与 reaction id。
- Action：Feishu callback 提交带 `E2E_BOT_STREAMING_CARD_LIFECYCLE` 标记的普通消息；task 依次产生文本、工具开始/完成、文本、工具开始/完成、最终文本和 `task_complete`。
- Assert：
  - callback 进入公共业务管线并创建一个 task；
  - provider 只创建一张 Card JSON 2.0，后续只 PATCH 同一 message id；
  - 时间线严格为 `message → tools → message → tools → message → terminal status`；
  - 最新运行中工具块展开，终态所有工具块收起；
  - 工具只展示紧凑摘要；允许摘要 formatter 提取安全的路径/命令提示，但不展开完整 input 对象，也不泄露 output、stdout、stderr 或 raw JSON 标记；
  - Typing reaction 在运行阶段建立，并在 terminal event 后删除；
  - 订阅使用 `bot-channel-continuous`，不请求 replayable snapshot/gap 恢复。
- Evidence：task service 调用、stream subscription 参数、Feishu mock HTTP 请求序列和最终 Card JSON。
- Fixture：`packages/desktop/test/e2e/fixtures/bots/feishu-streaming-card-lifecycle.json`。
- Status：`formal`。

## 接受并已自动化的补充用例

| Case ID       | 候选                                         | 状态   | 原因                                                    |
| ------------- | -------------------------------------------- | ------ | ------------------------------------------------------- |
| BOT-E2E-AQ-01 | AskUserQuestion 多选/自定义在同卡更新        | formal | controlled elicitation 与 callback fixture              |
| BOT-E2E-IL-01 | 阻塞交互切断流式卡并保留最终交互卡           | formal | controlled stream + Feishu HTTP 请求序列                |
| BOT-E2E-RT-01 | 两个本地 host 争用相同 Feishu runtime lock   | formal | 真实文件锁的 owner/contender/takeover 证据              |
| BOT-E2E-RT-02 | attached remote host 不启动 provider runtime | formal | 启动状态与零 provider 网络请求证据                      |
| BOT-E2E-PV-01 | Feishu/Lark domain 隔离                      | formal | 同一 HTTP mock 的完整 origin 断言                       |
| BOT-E2E-RW-01 | 远程 workspace 断开时不重连、不本地 fallback | formal | remote service 调用计数与零 task 调用证据               |
| BOT-E2E-CR-01 | Bot 创建定时任务后执行结果回推原会话         | formal | Host 注入、持久化重开、先订阅后派发与 provider 出站证据 |
| BOT-E2E-CF-01 | 已绑定 Feishu 长连接失败时展示可诊断状态     | formal | Desktop 真实 UI、runtime 状态与绑定关系联合证据         |

## 剪枝

| Decision     | 组合                                           | 分类    | 依据                                                                              |
| ------------ | ---------------------------------------------- | ------- | --------------------------------------------------------------------------------- |
| BOT-PRUNE-01 | streaming card × Telegram/Weixin               | pruned  | `streaming_card` 是 Feishu/Lark provider 能力；其他 provider 保持原回复语义       |
| BOT-PRUNE-02 | streaming card × mobile replayable recovery    | pruned  | Bot task stream 固定为 `bot-channel-continuous`                                   |
| BOT-PRUNE-03 | 单卡渲染 × 多 host runtime lock                | pruned  | 两者状态所有者和故障证据不同，合并会降低失败定位能力                              |
| BOT-PRUNE-04 | Bot lifecycle × plan approval dialog rendering | ignored | 本分支中的相邻提交，不属于 Bot provider 交付合同                                  |
| BOT-PRUNE-05 | automation 回推 × 中间流式消息                 | pruned  | 定时任务仅回推 `summary_changes` 终态，避免群聊或私聊被工具过程刷屏               |
| BOT-PRUNE-06 | automation 回推 × mobile replayable recovery   | pruned  | 回推继续订阅 `bot-channel-continuous`，不进入手机 gap/snapshot 恢复链路           |
| BOT-PRUNE-07 | 连接失败 UI × 未绑定 Bot 的 Desktop 重复覆盖   | pruned  | 未绑定分支已有组件合同；Desktop E2E 聚焦绑定关系与 runtime error 同时存在的冲突态 |

### BOT-E2E-CF-01 已绑定 Feishu 长连接失败状态

当前用例从 case-local `bot-config.v3.json` 加载；通过真实 UI 启用后核对 v3 写入及绑定保留。
旧文件一次性导入、旧 strict Reader 和回滚字节保持由 `botsStorageV3.test.ts` 验证。

- Setup：在隔离的 Desktop E2E 配置中准备一个已有 `providerUserId` 的 Feishu Bot，但不提供其 credential，使 provider runtime 可确定地进入 error；不访问真实飞书网络。
- Action：从“移动端远程控制 → 机器人管理”进入真实 Desktop 弹窗，启用 Bot，等待 runtime 刷新后重新打开弹窗。
- Assert：左侧摘要显示飞书连接失败；右侧状态显示“连接中断”而不是“已连通”；错误详情提示长连接上限或飞书服务繁忙，并建议持续失败时绑定新的机器人，同时保留“解绑”入口。
- Evidence：隔离 HOME 下的 Bot 配置、真实 Host runtime status、Desktop renderer DOM 与失败截图。
- Boundary：只验证 Desktop `desktop-continuous` 管理界面的 runtime 投影，不创建手机 `web-remote-replayable` session，不依赖真实 Feishu WebSocket。
- Status：`formal`，已通过 Desktop 人工验收并转正。

### BOT-E2E-CR-01 Bot 来源定时任务终态回推

- Setup：准备已绑定的 Feishu 私聊 Bot，在真实 workspace 中发送会触发 `CronCreate` 的消息；mock Feishu provider 记录所有出站请求。Weixin 复用相同的 delivery target / watcher 合同，由 provider service integration test 单独证明 `/sendmessage` 终态出站。
- Action：创建 automation，关闭并重新打开 automation repository 证明目标已落盘；scheduler 恢复绑定 task，注册 Bot watcher 后发送一次 controlled automation prompt，分别注入 `task_complete` 与 `task_error`。
- Assert：
  - Bot prompt turn 携带 Host 注入的 `{ provider, botId, providerUserId, chatType }`，普通 UI prompt 不携带；
  - `CronCreate` 参数不暴露 Bot 目标，automation protocol 只从 active turn 读取并持久化；
  - repository 重开后仍能按 `automationId + workspaceKey` 读取目标，脏 JSON 按无目标降级；
  - scheduler 在 `sendPrompt` 前完成 `bot-channel-continuous` 订阅；
  - completion 只向原会话发送最终结果与变更摘要，error 只发送一次失败消息；
  - Bot 删除、禁用、provider 不匹配或 provider 出站失败只记录 warning，不改变 automation run 的派发与结算；
  - `workspaceIdentity` 贯穿远程 workspace，不能只按 `workspacePath` 匹配。
- Evidence：正式 Desktop E2E 证明 V4/legacy 协议 payload、sqlite 重开读取、task service 调用顺序、stream subscription 参数和 mock Feishu provider HTTP 请求；Weixin `/sendmessage` 由 `packages/services/test/botsService.messageFlow.test.ts` 的 provider service integration test 证明。
- Boundary：Bot 回推不创建独立 runtime；desktop 仍是 `desktop-continuous`，手机远控仍是 `web-remote-replayable`。
- Status：`formal`。

### BOT-E2E-IL-01 Feishu/Lark 交互与流式卡分段生命周期

- Setup：Feishu/Lark 私聊 Bot，`replyMode=streaming_card`；task 先产生普通 Agent 正文，再产生 AskUserQuestion 或 Plan approval。
- Action：用户推进问题并完成交互，Agent 随后继续输出正文；另覆盖交互等待期间 task error/stop。
- Assertions：旧流式卡只保留交互前的 Agent 内容并进入无 Running 状态的封口态；AskUserQuestion 进行中按“已提交问答 → 分隔线 → 当前待回答问题”累积展示，当前题草稿不进入已回答区；WebSocket action handler 必须用业务回调返回的完整 outbound 同步生成唯一 `card.raw`，其中包含新题 token，不得再执行 `card_update_token`、message PATCH、POST 或 DELETE；完成、取消或任务终止后交互卡保留为无按钮只读卡；交互后的 Agent 内容创建新的流式卡；任何问题、答案或 Plan 正文都不回填旧/新流式卡。
- Evidence：Feishu message POST/PATCH/DELETE 顺序、Card JSON 2.0 payload、message id 分段与 task stream 事件。
- Boundary：Bot 固定使用 `bot-channel-continuous`；不扩展到 desktop `desktop-continuous` 或 mobile `web-remote-replayable` 的会话恢复语义。

## BOT-E2E-DT-01 已删除任务自动新建（ZCT-2096089929570893824）

- Status: pending；用例 `packages/desktop/test/e2e/bots/runtime/bot-deleted-task-recovery.test.ts`。
- Setup: 已绑定 Feishu Bot 指向删除 tombstone 中的旧 task，保留旧交互状态；mock provider 记录通知请求。
- Action: 普通消息进入 provider callback，随后重投相同 message id。
- Assert: 不恢复旧 task；同工作区只新建并绑定一个 task；清理旧交互；一次提示说明已删除、新建和上下文不继承；只派发一次原消息；Desktop created 广播指向新 task；订阅仍为 bot-channel-continuous。
- Fixture: case-local synthetic metadata，删除状态及 provider HTTP 由确定性夹具提供；不访问用户机器人。
- 回归边界：删除索引可在订阅恢复与消息准入阶段分别读取；重投去重验证新建、派发、通知各一次，不约束内部读取次数。
- Unit boundary: 本地/远端 identity、未删除但列表不可见（含归档/置顶）、索引读失败、新建失败、通知失败及中英文。仅归档行为保持原样。

### BOT-E2E-DF-01 Feishu reply delivery failure and recovery

- Status: pending. Spec: `packages/desktop/test/e2e/bots/delivery/feishu-delivery-error.test.ts`.
- Setup: bound private Feishu bot; synthetic HTTP business failure with code/msg/log_id.
- Action: private command reply fails, then a subsequent reply succeeds; input from a group that has not enabled the bot and does not mention it is ignored.
- Assert: status exposes deliveryError without misreporting a WebSocket failure; error clears after successful delivery; private outbound uses open_id; ignored group input produces no reply, provider write, task creation, or prompt dispatch.
- Evidence: service/provider HTTP and status projection; UI rendering is separately unit-tested. No claim of live Feishu tenant reproduction, mobile device validation, or DOM end-to-end coverage.

DF-01 verification (2026-09-07): macOS Desktop WDIO passed (`desktop-e2e-20260907040958265-p60496-c535b8967f7e59a1`). HTTP 200/400 business failures, body/header log ID, update rejection, streaming circuit status, and localized error rendering are covered by 124 passing unit tests. Typecheck, Desktop E2E typecheck, and lint passed (43 warnings, 0 errors). Pending case is not promoted. Live Feishu, Windows/Linux, mobile devices, and delivery-failure DOM interaction remain unverified; existing connection-error DOM regression CF-01 passed in macOS Desktop WDIO.

## BOT-E2E-RW-02：R3 stable / legacy Bot 身份

- accepted：已握手 Source 与当前窗口远程 session 在线，回退快照仍是 legacy；以 stable 和 legacy Bot context 分别请求模型/任务入口。
- 断言：两个入口归一到同一 stable scope；不误报断线、不调用本机 task、不额外建 Host/Agent；只授权的旧身份升级后仍限制为同一 Source。
- 对照：同 path 不同 Source、重绑旧线路、preferred Profile 与在线线路不同、断线/重连换代、并发 task/model lookup、迟到 port 和 dispose。
- 主证据为真实模块串联探针及 Bot service synthetic E2E；不声称真实飞书/Telegram 投递已验证。

## Feishu group collaboration (accepted, pending automation)

- BOT-E2E-GR-01: two enabled groups and private chat retain separate task/configuration; member commands cannot switch tasks or approve. Group prompts carry trusted source to canonical admission; no legacy sendPrompt.
  Group command acknowledgements quote the exact incoming message using the provider reply endpoint, as required by the group reply contract; they must not be asserted as unquoted chat-id sends.
- BOT-E2E-GR-02: owner/member inputs queue during execution; cancellation affects the CLI item only; busy task switching reports running/queue/interaction reasons. After Desktop stop, stale Bot approval records do not block a new draft. Desktop and mobile show source/attachments from the same canonical rows and queue.
- BOT-E2E-GR-03: final summaries persist per delivery segment; unknown outcomes are not replayed; disabled/switched groups reject saved-result resend. No tool or streaming output enters group.
- BOT-E2E-GR-04: completed reply action bar shows compact recovery only for its own unresolved deliveries; clicking opens actions without repeating the result body, and resolving hides the icon; no persistent group-sync/shared-workspace banner. Saved-result retry never resubmits a prompt. Source labels support zh-CN/en-US and narrow layouts.
- BOT-E2E-GR-05: CLI-confirmed queue admission shows OneSecond, start replaces it with OnIt, completion/error replaces it with CheckMark/CrossMark, and cancellation/stop removes it. Late admission cannot overwrite terminal state; other members' reactions remain. Queue cards have one localized waiting/cancel row. Provider payload/service transition assertions and actual Feishu visual evidence must be reported separately.

GR-05 queue-card correction: persist the card's message ID and follow the input
through running and terminal states on the same card, removing cancel controls
after queue admission ends. Verify normal queue promotion to completion, delayed
card creation after completion, duplicate/late events, persisted target reuse and
revoked-group no-op. Live acceptance must let the second input execute normally;
cancelling the second input alone does not cover this regression.

These cases implement the accepted `bots-feishu-group-collaboration.md` contract. Synthetic provider HTTP and controlled task events are permitted for deterministic service integration evidence. Real CLI admission and renderer DOM assertions must be reported separately; mock task methods are not evidence of CommandInbox behavior. Real Feishu tenant permissions, mentions, attachment references, removal, and message restrictions require a real test group.

Group member display revision: GR-02/04 also checks the queue sender's name and
click-to-view full identifier. Provider tests cover paginated directories and
Feishu/Lark domains; UI tests cover historical name overlays and group isolation.
Live tenant permission and actual member-name rendering require separate evidence.

### BOT-UI-TP-PREPARATION：准备态消息气泡

- Setup：真实准备态组件与共用正式气泡，包含普通正文、超长文本、空白正文、等待停止及失败。
- Action：切换中英文/深浅主题及桌面/手机宽度；将准备输入切为失败；先发布正式消息，再清除准备状态。
- Assert：准备消息属于 ConversationTurnGroup；来源行显示渠道、姓名和 loading，hover/focus tooltip 显示准备状态，气泡内只保留正文；复用正式正文折叠/展开，不产生空气泡/水平溢出；失败临时行整体移除，不显示错误、重试、孤立来源或空白轮次；同 ID 正式消息到达后准备态隐藏，其他输入保留。
- Status：浏览器组件候选；不代表真实 Desktop、手机 replayable 或飞书平台 E2E。

### BOT-E2E-PS-01 单聊跨输入端持续回传

- Setup：隔离的飞书、Telegram、微信 provider HTTP；持久 task 绑定与 bot-channel-continuous 服务订阅。
- Action：同一 task 依次接收 IM、desktop、mobile 轮次，完成后再运行；禁用后注入迟到输出。
- Assert：每轮一次回复，飞书卡片不覆写前轮，终态后保留订阅，禁用后无出站。
- Evidence：controlled-stream 服务到 provider HTTP 的 Desktop runner 用例；不将合成 inputOrigin 当作真实手机/CLI 输入证据。
- Status：pending，`bots/delivery/bot-private-task-sync.test.ts`。

### BOT-E2E-RD-01 私聊同一条消息重投不重复入队

- Setup：隔离的飞书、Telegram、微信私聊绑定 task。任务服务替身按 CLI 命令账本回复：同一个 commandId 第一次返回 `accepted`，再次提交返回 `duplicate`，不开新一轮；任务快照状态由用例控制。飞书 reaction POST 按真实响应返回 `reaction_id`（共享替身先匹配消息接口，拿不到该字段）。
- Action：
  - 空闲重投：消息 A 提交并结束首轮（Bot 自己发起的一轮未结束时，私聊新消息会被“任务运行中”拒绝），快照为 `completed`；A 再次进入业务处理，模拟去重窗口过期后、或游标未提交时的重投；随后发新消息 B。
  - 运行中重投：同样结束首轮，但快照为 `running`（会话里还有别的轮次在执行）；A 再次进入业务处理；最后让正在执行的那一轮结束。
  - 附件：带图片附件的同一条消息提交两次。
- Assert：
  - 重投的 `sendPrompt` 与首次使用同一个 traceId（即 v4 `sendText` 的 commandId），B 使用新 ID。
  - 空闲重投得到 `duplicate` 后：向桌面广播 `completed`；Telegram/微信超过一个续发周期（4 秒）不再发 Typing；飞书删除 Typing reaction；B 不被“任务运行中”拒绝。
  - 运行中重投得到 `duplicate` 后：不广播 `completed`，Typing 继续，飞书 reaction 不删除；那一轮结束后按原终态路径停止 Typing。
  - 附件输入两次提交使用不同的随机 ID。
- Evidence：服务到任务服务替身的提交参数、广播事件与渠道 Typing 请求。没有运行真实 CLI 返回 `duplicate`（既有协议合同），不代表真实渠道重投。
- Status：formal；`bots/delivery/bot-private-redelivery.test.ts`，用户于 2026-11-10 确认转正。

### BOT-E2E-RD-02 轮询失败日志与退避

- Setup：微信 runtime 注入失败的 `getupdates`；Telegram runtime 的业务回调返回失败。两者都使用替身锁和替身 logger。
- Action：启动轮询，让它连续失败；微信另跑一组“失败、失败、成功提交、再失败”，并在退避等待中 dispose。
- Assert：每次失败都写一条 warn 日志，日志带 Bot ID、连续失败次数、下次重试间隔和错误信息；第二次重试的间隔比第一次长；Bot 继续轮询，不跳过失败的批次。完整成功提交一批后，下一次失败从 5 秒重新退避；退避等待中 dispose 在 2 秒内返回。
- Evidence：runtime 依赖注入边界上的调用时间与日志。不代表真实渠道网络。
- Status：formal；`bots/runtime/bot-polling-retry-backoff.test.ts`，用户于 2026-11-10 确认转正。

### BOT-E2E-MN-01 原生渠道 mention 回复

- Status：formal；`bots/channels/feishu-channel-mention.test.ts`，用户于 2026-10-08 确认转正。
- Setup：Feishu/Lark 已启用群；确定性原生目标节点与任务 admission。
- Action：显式额外回复引用该输入的 refId，重复同一 toolCallId，再请求未知 ref。
- Assert：同群/话题原生 quote + 正文 at；稳定回执，重复调用不增加 HTTP；未知目标无发送。
- Evidence：service → durable delivery → provider HTTP；不代表模型自行选用工具或真实飞书客户端通知。

BOT-UI-MN：真实正式气泡、准备气泡与队列组件在 390/1200px、深浅主题显示渠道 chip；
普通 @ 文本无渠道节点，无横向溢出、不显示平台 ID。组件浏览器测试不等于手机 replayable 真机验证。

## 分支验收补齐（2026-09-23，accepted）

范围：飞书群协作分支相对 staging 的群聊、话题、材料、回传、设置 UI 与渠道工具。
用户已确认实施整个分支的覆盖补齐；重复成功回执保持现状，不增加去重断言。
状态 owner：CLI CommandInbox 管 admission/执行，Bot Host 管绑定、材料及 delivery，UI 只投影；不另建队列。

| Case                | Setup → Action → Assert                                                                                   | 证据与状态                            |
| ------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| BOT-E2E-TP-04       | 真实 CLI 话题运行中 → Bot 接收新消息 → 自动停止旧 run，权威终态后续接，零排队，旧输出不冒充新轮           | Host/CLI/模型 HTTP，pending           |
| BOT-E2E-TP-05       | 已接收历史文件索引 → 真实 ReadTopicResource → Host 验证并下载，CLI 收到正确文件；其他任务/失效授权不下载  | Host/CLI/模拟平台 HTTP，pending       |
| BOT-E2E-FN-01       | 工具输出后终态含完整正文 → adapter 对账 → 完整结果仅回传一次；普通对话仍正常                              | adapter/真实 stream/平台出站，pending |
| BOT-E2E-MN-02       | 真实 CLI 触发 ReplyToChannel → 原生提及成功 → 客户端续聊按名字查询新目标，无 botGroupSource，不弹默认审批 | Host/CLI/模拟平台 HTTP，pending       |
| BOT-E2E-GR-02       | 运行中接收群输入 → 取消及正常晋升分别执行 → FIFO、原始来源、同卡终态与不重复输入                          | 调整已有 runtime case                 |
| BOT-E2E-GR-UI-01    | 两机器人/两群 → 设置开关、失败及恢复 → 隔离、持久化、不补发                                               | 新增 UI 候选                          |
| BOT-E2E-PS-01       | 私聊绑定 task → IM/desktop/mobile 连续轮次与重启 → 一轮一回传，失败显式重试                               | 扩展已有候选，模拟 origin 不计手机 UI |
| BOT-E2E-MN-01/TP-03 | 群/话题与多个身份 → 回复和管理员操作 → quote、条件 @、管理员提醒及幂等                                    | 扩展现有服务候选                      |

剪枝：Feishu/Lark 平台差异由服务候选双平台覆盖，真实 CLI 主链路优先 Feishu；不机械交叉所有平台与主题。
主题/宽度由组件浏览器验证；真实手机 replayable、SSH 身份、平台租户通知分别记录，不能以窄屏或 stub 代替。
初始验证阶段新增用例保持 manual-review/pending；2026-09-23 用户确认后，下列四份新增 spec 已转正，未进入 Docker/CI。
先完成 case-local fixture 与 canonical manifest，再跑受控回放；平台请求全部隔离，不使用用户 Bot。

本轮新增正式用例（2026-09-23 用户确认）：

- `conversation-session/session-control/conversation-session-bot-channel-worker.test.ts`：MN-02 + FN-01，真实 CLI 原生提及、无来源的客户端续聊、丢失 text delta 的终态补齐。
- `conversation-session/session-control/conversation-session-bot-topic-worker.test.ts`：TP-04 + TP-05，真实运行中自动停止续接、工具结果及受管理附件字节校验。
- `conversation-session/session-control/conversation-session-bot-continuous-worker.test.ts`：GR-02 正常晋升 + PS-01 IM/desktop 持续订阅。
- `bots/channels/feishu-bound-groups-ui.test.ts`：GR-UI-01 实际 Desktop RPC/持久化与群/机器人隔离。

上述路径均相对 `packages/desktop/test/e2e/`。新 worker 正式用例使用真实 CLI/生产 Host 服务，Bot repo 与平台 HTTP 为隔离夹具，不能称为 Electron UI 或真实租户验证。
PS-01 的重启、失败重试及换绑继续由 `botsService.privateSync.test.ts` 覆盖；mobile 来源模拟不升级为实际手机证明。
GR-UI-01 的失败/并发/迟到回调、禁用机器人继续由 `botBoundGroupsInteraction.test.ts` 覆盖，本轮 Desktop 用例只证明实际成功保存路径。
MN-01 增加同任务桌面续聊和跨任务拒绝；TP-03 扩展飞书/Lark × 条件 @ 四场景，覆盖当前消息引用、审批提醒管理员与普通问答条件提醒；模型继承继续由 `botsService.groups.test.ts` 验证。

### BOT-E2E-TP-06：其他机器人话题输入

- Setup：真人已接入话题并开始受控流式任务。
- Action：经真实 Provider 解析其他机器人的话题消息，随后发送当前机器人的自身消息。
- Assert：其他机器人消息停止旧运行后提交到相同任务并回复；自身消息不产生输入。
- Evidence：复用 TP-04 的真实 Host/CLI、受控模型和平台替身；原生推送与真实租户权限待人工验证。
- Status：accepted；实现与回归证据见覆盖矩阵。

机器人接收事件回归：真实事件 sender_type=bot 映射为内部 app；已启用普通群原生 @
可提交，未启用/无 @ 不提交；话题延续保持 active 校验、去重、自身回声与控制命令隔离。
TP-04 使用 bot 事件穿过 Provider → Host → CLI → 平台回复；历史接口仍使用 app。
