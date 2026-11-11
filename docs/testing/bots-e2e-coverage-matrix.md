# Bots E2E Coverage Matrix

2026-11-10：`bots/delivery/bot-large-attachment.test.ts` 已人工复核并转正，独立夹具与默认回放
均为 12/12 通过。产物见[转正清单](e2e-business-scenarios.md#2026-11-10-人工复核与转正回放)；
沿用合成平台及任务服务边界，不代表真实聊天平台投递验收。

## BOT-E2E-AT-01：文件与富文本附件提交

- Spec：`packages/desktop/test/e2e/bots/delivery/bot-large-attachment.test.ts`。
- Fixture：`packages/desktop/test/e2e/fixtures/bots/large-attachment.json`。
- 范围：Feishu/Lark × 私聊/群聊，6 MiB 独立文件及 3/6 MiB 富文本文件的原生回调、下载、缓存字节与任务提交；另验下载失败仍拒绝。
- 运行：2026-11-06 macOS WDIO 12/12 通过，产物 `packages/desktop/.e2e-artifacts/desktop-e2e-20261106110622857-p85529-6eec272f382c8978`。Node 执行同一 spec 也为 12/12 通过。
- 回归证据：修改前四个 6 MiB 独立文件场景均返回 5MB 超限；补上富文本场景后，修改前八个 post 场景均未发起附件下载。两处修复后，文件内容、缓存与提交断言全部通过。
- 检查：根 typecheck、Desktop typecheck:e2e、lint（0 errors，671 项既有 warnings）、architecture 和改动代码格式检查通过。受影响工程测试选择器选中 0/232，未执行工程测试。
- 状态：covered（合成平台/任务服务边界），保留 manual-review pending。未验证真实租户重发、CLI 实际读取、手机、Windows/Linux；不将 WDIO 启动桌面等同于上述链路通过。首轮 capture 缺少模型入口配置，在业务断言前失败；显式 replay 后通过。

> `retired:` 逐处标记已退役 App 单测，仅供追溯；原通过记录不代表现行覆盖。独立断言缺口需由后续验收补齐。

> 2026-10-26：App 业务单测已按[测试规格](unit-test-quality.md)退役。本文中的相关单测路径和历史通过记录不再代表现行覆盖；CLI/CUA、工程测试、E2E 与浏览器验收证据仍按各自状态解释。未补验收的场景不得自动视为已覆盖。

## 2026-10-21 默认渠道工具暂停

ReplyToChannel 默认注册和发送接线注释停用，MN-02/FN-01 组合 E2E 暂时跳过；
原用例及 fixture 完整保留，待插件接入后恢复。窗口发送接线用例同样保留并暂时跳过，
新增断言确认默认 relay 不调用 Bot 发送服务。权限、协议和发送实现的独立测试继续执行。
TP-04 的身份断言改读有序分工材料，不再依赖发送用 refId 或工具指引。
下方默认工具发送通过记录仅为历史证据，不计为本次覆盖。

## 2026-10-19 人工复核通过项

7 个 Bot spec 已完成独立 fixture 和默认正式回放，保留正式目录；`bot-deleted-task-recovery` 已修正文件路径，但未完成修复后回放，先保留 pending。
本轮状态与逐文件证据见[批量清单](./conversation-session-e2e-coverage-matrix.md#2026-10-19-人审通过项迁移清单)。
`feishu-group-draft-mode` 的业务缺陷继续保留 pending；本轮未改 Bot 业务实现。

BOT-E2E-DT-01 首轮正式回放在读取 fixture 时报告 `ENOENT`，尚未进入业务断言。
迁移到正式目录后，相对文件路径应同步减少两层；保留原 fixture 和删除恢复、重复投递断言，修正后重新验证。

## MN-01 / MN-03 转正（2026-10-08）

用户确认将 Feishu/Lark × 群/话题 4 项用例转正，正式入口为 `bots/channels/feishu-channel-mention.test.ts`。
沿用 Bot 域 `fixtures/bots/feishu-channel-mention.json` 的 synthetic/fast-text 合同，覆盖原生
提及、包含匹配、多目标、澄清零发送、幂等及普通群机器人原生 @ 回调。无真实模型请求，
平台 HTTP 在 case 内记录并断言；不将合成环境转正等同于真实租户或手机验证。
通用 promotion dry-run 仅支持 conversation-session，故按现有 Bot 正式目录规范迁移并修正 helper 路径。
默认 Desktop WDIO 是正式入口，未新增 Docker admission。
验证：隔离 common-only 回放 `desktop-e2e-20261008-102803-871` 与默认回放
`desktop-e2e-20261008-102907-909` 均为 4 passing；无 manual-review 开关。
根 typecheck、E2E typecheck、lint（67 项既有警告）、架构检查、差异格式检查通过。
首次 skip-build 因普通开发构建缺少测试开关未启动测试，重新构建后上述两次回放通过。

## 机器人接收事件修复（2026-10-08）

接收回调 sender_type=bot（内部归一化为 app）；历史接口保留 app。普通群须已启用且原生 @，
已接入话题继续处理所有平台实际推送的机器人消息；自身回声、重复事件、未启用及已退出话题均被拦截。
主聊天与话题中的机器人 slash/选择文字都只作为消息，不进入控制分发。

- Provider/群服务/mention gate 共 205 项单测通过；初始沙箱内文件测试失败，允许既有测试临时目录后通过。
- `desktop-e2e-20261008-095311-834`：2 项真实 CLI 话题回归通过，原生 bot 事件触发停止旧轮、续接与回复。
- `desktop-e2e-20261008-095707-065`：4 项 Feishu/Lark × 群/话题回归通过，普通群 bot 回调、命令正文与去重通过。
  首次新增群回调检查因测试替身遗漏 bot/v3/info 身份响应失败，补齐后通过。
- 根 typecheck、E2E typecheck、lint（67 项既有警告）、架构门禁、话题 fixture checker 通过。
- 平台与模型网络为替身；真实租户机器人事件权限及 live 通知仍需验证。群启用消息已补充 include_bot 权限说明。
- 未更改桌面 continuous、手机 replayable、远程工作区身份隔离、投递 owner 或输入队列；未实测手机及 Windows/Linux。

## MN-03 按名字解析原生提及（2026-10-08）

包含查找更新：唯一包含候选或唯一完整名字匹配直接发送，所有未解决名字一起返回。
本次 147 项单测通过；`desktop-e2e-20261008-093912-272` 的 Feishu/Lark × 群/话题
4 项通过，验证简称、多目标原生 at 与多个失败项零发送。根/CLI typecheck、E2E typecheck、
根 lint、架构检查通过；CLI 全量 lint 被未改动 telemetry 文件 max-lines 阻断，
改动 CLI 文件单独 lint 通过。Bot pending spec 不受通用 fixture checker 支持，
当时使用现有 Bot synthetic fixture 与显式 replay，尚未转正；现已转正，见本文顶部。
英文全名与多人分隔已更新工具提示，真实模型自然语言解析及真实租户仍待实测。

- 已实现：`ReplyToChannel` 的 mentionName 查询、唯一匹配发送、重名候选与用户选择、
  无结果/查询失败零发送，以及查询期间授权复核和原请求回执重放。
- 群成员接口不包含机器人；机器人名字仅匹配同一任务有效授权内已保存的原生 mention，
  没有可信身份时要求原生 @。不保证枚举群内全部机器人。
- Provider/service 4 文件 130 项、CLI 2 文件 11 项测试通过；覆盖同名用户/机器人、
  完整分页失败、选择跨输入保留/跨凭据拒绝、整条不部分发送及目录变化后的幂等回执。
- 真实 Host/CLI MN-02：`desktop-e2e-20261008-091311-382` 中 1 项通过，客户端无来源
  续聊通过名字查询一个此前没有原生节点的成员并发送 at。该批另一 pending spec 因默认
  capture 缺少测试 URL 未执行；明确 replay 后在 `desktop-e2e-20261008-091522-301`
  的 MN-01/MN-03 Feishu/Lark × 群/话题 4 项全部通过。
- 根 typecheck、desktop typecheck:e2e、fixture、根 lint（既有 67 warnings）、架构检查通过；
  CLI 全量 typecheck 30 个任务通过。CLI 全量 lint 被未修改文件的既有 max-lines 错误阻断，
  本次两个 CLI 源文件使用 CLI 规则单独检查为 0 errors / 0 warnings。
- 模型和平台 HTTP 均为隔离替身；未验证真实租户权限、实际模型自然语言选择、手机 UI
  及其他操作系统。桌面 continuous、手机 replayable、投递 owner 与队列均未改动。

## Input material refactor（当前边界）

TP-01 now covers topic start-now admission and original-message presentation through the real Host/CLI. Setup: a controlled streaming run; action: submit a topic batch with two original messages, one root quote and a history attachment; assertions: no queued input, separate original senders/bodies, first-only quote/history and original-text preview at Desktop and narrow viewport sizes. The material is synthetic; native Feishu history collection and Bot-service stop coordination require separate service tests and manual acceptance. TP-01 的后续运行记录见本文；旧 queue/Steer 结果只作历史。现 case 手动停止后提交，尚不证明 Bot 自动停止协调，新增 TP-04 专门覆盖。

## Topic collaboration (in progress)

| Case          | Status  | Evidence boundary                                                                                                                           |
| ------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| BOT-E2E-TP-01 | pending | `bots/channels/feishu-topic-runtime.test.ts`; real Host/CLI and DOM, synthetic topic batch/materials; reuses group-runtime controlled-stream fixture |
| BOT-E2E-TP-02 | pending | partial native verification: ordinary/dedicated routing, incremental history, long-background summary; remaining native cases below         |

Provider/service/Agent unit tests cover topic isolation, owner opt-in, message
boundaries, bounded summary and native API payloads. They do not establish real
Feishu/Lark tenant compatibility. Desktop narrow viewport is not a substitute for
mobile remote replayable validation.

Topic implementation verification (2026-09-07): 222 focused provider/service tests and
169 Agent runtime/archive/summary tests passed. Root and CLI core typechecks passed;
lint reports 43 existing warnings and zero errors. A separate 35-test remote routing
regression passed. The existing desktop continuous and mobile replayable boundaries
are unchanged; those unit tests do not establish real mobile operation.

TP-01 passed in the controlled macOS Host/CLI + Desktop DOM run
`desktop-e2e-20260907140113423-p6639-99c0f20745391c21`, including queued attachment
cancellation, narrow-screen delivery reconciliation and topic details. The existing
`feishu-group-runtime.test.ts` passed in the same run (two specs passed). Native topic
identity and saved delivery were seeded; the case stays pending manual review.

`pnpm verify:pre-push` passed on rerun. The initial broad run reported one
unrelated `SubagentsSection` optimistic-render assertion failure (9,800 tests
passed); its 36-test file passed in isolation, then the entire pre-push command
passed without concurrent E2E. No unrelated test or implementation was changed.
Changed-file formatting and `git diff --check` passed.

Live verification resumed on 2026-09-08 after the Mac was unlocked. The existing
`pnpm dev:desktop` process completed startup (Electron PID 17515, local Host 17711;
development log `/tmp/zcode-topic-dev.log`). Computer Use operated Ryan Bot in the
real `ZCode 群聊验证` group (`oc_da0fa1e9e7e9f852894c8d6aaca1c044`).

- `/history on` returned the native opt-in confirmation. An ordinary root message
  and an ordinary topic reply created no task before the first explicit bot mention.
- Topic A (`omt_19fae40ad30fdbe5`, root
  `om_x100b66c282f2dcacc4922dae1e667f0`) created task
  `sess_8c86bd38-5bb4-4f4d-8e4a-4f0521b92eef` on the first mention. The native
  result `om_x100b66c29c2ee0acdfa3a1a2b0a964c` appeared inside Topic A; persisted
  delivery status was `sent`.
- Topic B (`omt_19fae586a54e1b83`, root
  `om_x100b66c29a35b8b0c2ffcd23b5457a7`) created a separate task
  `sess_35dd54ab-a705-480d-839f-26e726c96837` and replied `TOPICBREADY` inside
  Topic B (`om_x100b66c296b92104c3434026e359f3e`). The default group task remained
  `sess_5ec4cfa2-10e5-46d9-947f-eb2fe9a3eb27`. Completion reactions were visible.
- The real history API rejected access with `need scope: im:message.group_msg`.
  Both topics displayed the explicit basic-mode warning. Topic A correctly did
  not claim knowledge of unread background. This proves the missing-permission
  behavior, **not** successful history retrieval or incremental ingestion.
- The permission was located in the application's live permission-management
  page as `获取群组中所有消息（敏感权限）`, under application identity. Enabling and
  publishing it was left to the user. A subsequent read-only probe with a fresh
  application token returned `code: 0` for Topic A's native thread history,
  including its root (position -1), ordinary discussion (position 0), request
  (position 1), and two application cards. This establishes permission and native
  API access.
- After disk space recovered to 12 GiB, Computer Use submitted request
  `om_x100b66c367d6ec70c122bdda2618103` in Topic A. The visible native reply was
  `Codename: APRICOT; agreed launch day: Friday.` Its accepted input snapshot
  contained exactly the root and ordinary Friday discussion, `hasGap: false`.
- A subsequent ordinary message changed the launch day to Monday
  (`om_x100b66c365b480a0c10ca8be0bba666`). Before the next mention, the topic still
  had two accepted inputs and no new bot reply. The next mention
  `om_x100b66c3604438b8c459784b98545d6` produced the native reply
  `Codename: APRICOT; latest confirmed launch day: Monday (changed from Friday).`
  Its persisted background contained **only** that new ordinary message; root,
  old discussion, prior requests and bot replies were not re-injected. Both
  successful requests completed in the original Topic A task, with checkpoints
  equal to their respective request message IDs.

The Desktop accessibility tree contained the new tasks, but its screenshot stayed
on an older view and read-only CDP reported a hidden renderer. This is not accepted
as real Desktop visual verification. Long-history limits, native attachment and
card-control scenarios, Lark, physical mobile remote control and
Windows/Linux remain unverified. TP-02 stays pending.

The 2026-09-08 evidence-update pre-push attempt stopped with `ENOSPC` while loading
`retired:packages/services/test/zcodeAgentService.v4.test.ts` (22 files / 339 tests passed before the failed suite;（retired: 为退役历史证据，不计现行覆盖。）
no tests ran in that suite). Only about 159 MiB remained on the system volume.
This is an environment failure, not a passing gate or a confirmed implementation
regression. After disk space recovered to 12 GiB, the complete
`pnpm verify:pre-push` rerun passed (`/tmp/topic-evidence-prepush-retry.log`).

The real private group `ZCode 专用话题验证`
(`oc_6596fb27f96a81b6ee5c34cc09be6089`) was created through the native API with
`chat_mode: topic`, Ryan Bot and the bound user as its only participants. Computer
Use confirmed the native topic-group page and its create-topic entry.

Dedicated-topic execution was then verified through Computer Use on 2026-09-08:

- Publishing an owner mention `/enable` as a topic root enabled the parent group
  and returned the native enablement card inside that topic. The parent group's
  default task remained absent.
- A subsequent mention inside that topic returned `DEDICATEDREADY`, with a
  completion reaction. Native thread `omt_19fafc4ae38e9be0` (root
  `om_x100b66c306f1d4b8c4cdd16b32ac7e0`) bound to task
  `sess_895438b4-d7d0-4136-bc07-878ec258476d`; accepted input
  `om_x100b66c3057900a4dd82aa5adb6242a` completed and its saved delivery was
  `sent` (`om_x100b66c303bf28b4c102b2c7b21c42f`).
- A second topic with a mention directly in its root
  `om_x100b66c3189decbcc27d014d2d7c4fc` created distinct thread
  `omt_19fafdac200edb8b` and task `sess_f34a27da-c0dd-4e34-b200-ce4952cb9f70`.
  Computer Use opened that topic and observed `DEDICATEDSECOND` and a completion
  reaction under its own root. This establishes both root-mention and reply-mention
  routing in a real `chat_mode: topic` group, separate from ordinary-group tasks.

Dedicated-group history, attachment/card-control races, long history and remaining
cross-platform cases are still pending; the broader TP-02 case is not promoted.

来源：[Bots E2E Case Catalog](../bots-e2e-case-catalog.md)、[Bots](../bots.md) 与 [Bot Channel Runtime Split](../bot-channel-runtime-split.md)。

## 状态维度

| 维度               | 等价类                                                  | 本轮处理                                                                                                               |
| ------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Provider           | Feishu、Lark、Telegram/Weixin                           | Feishu 代表共享卡片实现；Lark domain 另案；非卡片 provider 剪枝                                                        |
| Reply lifecycle    | create、running update、terminal update                 | BOT-E2E-SC-01 全部显式断言                                                                                             |
| Stream block       | message、tool start/update、terminal                    | BOT-E2E-SC-01 使用 controlled stream                                                                                   |
| Locale             | zh-CN、en-US                                            | SC-01 覆盖 zh-CN；en-US 由 provider/service unit contract 保留，后续可做 pairwise                                      |
| Delivery kind      | bot-channel-continuous、web-remote-replayable           | 只接受前者；后者按架构 invariant 剪枝                                                                                  |
| Runtime authority  | local host、attached remote host、competing local hosts | SC-01 覆盖 local；其余进入 RT 专项                                                                                     |
| Evidence           | service action、subscription、provider HTTP、card JSON  | SC-01 四层联合证明                                                                                                     |
| Automation origin  | Feishu、Weixin、普通 UI                                 | CR-01 正式 E2E 覆盖 Feishu；Weixin 由共享协议与 provider service integration test 覆盖；普通 UI 断言无 delivery target |
| Automation result  | complete、error、Bot unavailable                        | CR-01 覆盖终态回推和 best-effort 降级                                                                                  |
| Persistence        | create 后同进程、repository 重开                        | CR-01 必须证明重启后仍能读取原会话目标                                                                                 |
| Connection failure | unbound、bound                                          | CF-01 覆盖 bound 冲突态；unbound 已由组件测试覆盖并从 Desktop E2E 剪枝                                                 |

## 覆盖表

| Case ID       | Priority | Status | Spec                                                                     | Timing             | Setup / Action / Assertion                                                                                                                |
| ------------- | -------- | ------ | ------------------------------------------------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| BOT-E2E-SC-01 | P0       | formal | `packages/desktop/test/e2e/bots/delivery/feishu-streaming-card-lifecycle.test.ts` | controlled-stream  | Feishu callback 建 task；注入分阶段 stream；断言单卡、时间线、折叠、Typing 与 continuous 订阅                                             |
| BOT-E2E-AQ-01 | P1       | formal | `packages/desktop/test/e2e/bots/channels/feishu-provider-interactions.test.ts`    | controlled-stream  | pending elicitation；多选/自定义 callback；同一 message_id 原地更新并提交协议响应                                                         |
| BOT-E2E-IL-01 | P0       | formal | `packages/desktop/test/e2e/bots/channels/feishu-provider-interactions.test.ts`    | controlled-stream  | 阻塞前主卡封口；交互卡推进/终态保留；后续 Agent 输出另起流式卡                                                                            |
| BOT-E2E-RT-01 | P1       | formal | `packages/desktop/test/e2e/bots/runtime/bot-runtime-authority.test.ts`           | controlled-process | owner 持锁；contender 被拒绝；owner 释放后 takeover                                                                                       |
| BOT-E2E-RT-02 | P0       | formal | `packages/desktop/test/e2e/bots/runtime/bot-runtime-authority.test.ts`           | fast-process       | attached remote host；runtime 保持 idle；无 provider 网络请求                                                                             |
| BOT-E2E-PV-01 | P1       | formal | `packages/desktop/test/e2e/bots/channels/feishu-provider-interactions.test.ts`    | fast-text          | Feishu/Lark 相同 callback；断言各自 OpenAPI origin                                                                                        |
| BOT-E2E-RW-01 | P0       | formal | `packages/desktop/test/e2e/bots/runtime/bot-remote-disconnected.test.ts`         | controlled-stream  | remote workspace disconnected；普通消息被拒绝；不 reconnect、不解析远端 service、不本地执行                                               |
| BOT-E2E-CR-01 | P0       | formal | `packages/desktop/test/e2e/bots/delivery/bot-automation-result-delivery.test.ts`  | controlled-stream  | Feishu 创建 automation；重开 repo；先订阅后派发；complete/error 回推；失效 Bot 降级；Weixin provider 出站由 service integration test 覆盖 |
| BOT-E2E-CF-01 | P0       | formal | `packages/desktop/test/e2e/bots/runtime/feishu-runtime-error-ui.test.ts`         | controlled-process | 已绑定 Feishu 缺少 credential；启用 runtime；重开机器人弹窗并断言绑定保留、连接中断与错误详情                                             |

## Fixture 合同

BOT-E2E-SR87 位于 `bots/runtime/bot-effective-selection.test.ts`；synthetic、fast-text。验证菜单/首次派发使用同一有效选择，且查看菜单和无效提交不改原意图。Todo99 追加 BOT-E2E-SR99：绑定后从 Session 原选择解析下一次空闲输入，不重解释已固定执行。共用该 pending spec，未晋级；conversation W99-E03/E06 另在 Pro 验证 Bot→生产 Task adapter→实际 Worker 请求、完整 setter 与冷恢复。证据不覆盖真实 IM 网络或手机/SSH 联合环境。

- `feishu-streaming-card-lifecycle.json` 是 case-local synthetic stream fixture。
- 其余 5 个用例分别使用 `fixtures/bots/` 下同语义命名的 case-local synthetic metadata；所有 fixture 都声明 `syntheticReason` 与 timing 分类。
- 分类为 `synthetic`，原因：外部 provider replay 只能提供模型 SSE，不能稳定控制 Bot 消费 task event 的逐步观察窗口；该夹具明确生成确定性的 ZCode stream events。
- Mock Feishu API 必须记录请求而不是只返回成功，以请求次数、URL、method、reaction id 和 Card JSON 作为证据。
- `bot-automation-result-delivery` 记录 mock Feishu 请求，并用受控 task stream 证明 scheduler 监听早于 prompt 派发；不允许用固定 sleep 代替事件闸门。Weixin `/sendmessage` 由 `retired:packages/services/test/botsService.messageFlow.test.ts` 的共享 watcher/provider service integration test 覆盖，不虚报为 Desktop E2E。（retired: 为退役历史证据，不计现行覆盖。）
- 用例已通过人工 review 并移出 `manual-review/pending/`；Bot 域当前没有独立 Docker preset，默认 Desktop WDIO 是正式执行入口。
- CF-01 使用 case-local synthetic metadata；缺失 credential 只用于确定性触发 runtime error，`syntheticReason` 必须说明它替代真实飞书故障注入；该用例已通过 Desktop 人工验收。

## BOT-E2E-DT-01 已删除任务自动新建（ZCT-2096089929570893824）

- Status: pending；用例 `packages/desktop/test/e2e/bots/runtime/bot-deleted-task-recovery.test.ts`。
- Setup: 已绑定 Feishu Bot 指向删除 tombstone 中的旧 task，保留旧交互状态；mock provider 记录通知请求。
- Action: 普通消息进入 provider callback，随后重投相同 message id。
- Assert: 不恢复旧 task；同工作区只新建并绑定一个 task；清理旧交互；一次提示说明已删除、新建和上下文不继承；只派发一次原消息；Desktop created 广播指向新 task；订阅仍为 bot-channel-continuous。
- Fixture: case-local synthetic metadata，删除状态及 provider HTTP 由确定性夹具提供；不访问用户机器人。
- Unit boundary: 本地/远端 identity、未删除但列表不可见（含归档/置顶）、索引读失败、新建失败、通知失败及中英文。仅归档行为保持原样。

验证记录（2026-09-07）：DT-01 在 macOS Desktop WDIO 通过；同时通过 `feishu-provider-interactions`、`bot-remote-disconnected`、`feishu-streaming-card-lifecycle` 回归。DT-01 证据覆盖 provider callback → Bot 状态 → task service → provider HTTP 与 Desktop 广播，不冒充真实飞书租户或桌面 DOM 验证。真实远端 host、Windows/Linux、手机链路尚未实机验证；本次只使用既有 task service 与 workspaceIdentity 路由，不改 continuous/replayable 协议。用例保留 pending，未宣称已完成人工验收或 CI 转正。

### BOT-E2E-DF-01 Feishu reply delivery failure and recovery

Todo103 补充验收：DT-01 的替代任务使用当前 Model Selection View 的完整选择并沿 V4
创建/首发，不恢复旧字段；无可用选择时不得创建或发送。CF-01 在弹窗保持打开时
等待后台连接状态投影，不依赖关闭重开来刷新，用于验证新增可见期串行状态轮询。
下方 2026-09-07 记录是固定 staging 历史证据；本轮运行结果另记 Todo103 账本。

- Status: pending. Spec: `packages/desktop/test/e2e/bots/delivery/feishu-delivery-error.test.ts`.
- Setup: bound private Feishu bot; synthetic HTTP business failure with code/msg/log_id.
- Action: private command reply fails, then a subsequent reply succeeds; group input is rejected.
- Assert: status exposes deliveryError without misreporting a WebSocket failure; error clears after successful delivery; private outbound uses open_id; group creates no task.
- Evidence: service/provider HTTP and status projection; UI rendering is separately unit-tested. No claim of live Feishu tenant reproduction, mobile device validation, or DOM end-to-end coverage.

DF-01 verification (2026-09-07): macOS Desktop WDIO passed (`desktop-e2e-20260907040958265-p60496-c535b8967f7e59a1`). HTTP 200/400 business failures, body/header log ID, update rejection, streaming circuit status, and localized error rendering are covered by 124 passing unit tests. Typecheck, Desktop E2E typecheck, and lint passed (43 warnings, 0 errors). Pending case is not promoted. Live Feishu, Windows/Linux, mobile devices, and delivery-failure DOM interaction remain unverified; existing connection-error DOM regression CF-01 passed in macOS Desktop WDIO.

## R3 Bot 身份回归（A3）

`BOT-E2E-RW-02`：pending；Host resolver + Bot bridge + Main 精确路由合同与 Bot service synthetic 场景。覆盖 stable/legacy、同路径跨 Source、权限 key、runtime 换代。执行证据见 `packages/desktop/.e2e-artifacts/bot-identity-fix-20260916/`；不包含真实第三方消息投递和手机 relay。

## Group collaboration additions

| Case          | Status  | Required evidence                                                        |
| ------------- | ------- | ------------------------------------------------------------------------ |
| BOT-E2E-GR-01 | pending | group activation, owner checks, private/group state and canonical source |
| BOT-E2E-GR-02 | pending | real CLI FIFO and CAS cancellation; desktop/mobile projection            |
| BOT-E2E-GR-03 | pending | saved segmented results, uncertainty and authorization revalidation      |
| BOT-E2E-GR-04 | pending | actual task-pane DOM, localized source labels and saved-result retry     |

Cases remain pending manual review; automated execution evidence is recorded below, without promotion. Continuous Desktop, replayable mobile and independent Bot subscriptions keep their existing delivery boundaries.

2026-09-07 GR-01 provider/service evidence: macOS Desktop WDIO passed both Feishu and Lark cases in `desktop-e2e-20260907080816019-p64763-2c57d53b14b98617`. Pending spec `bots/channels/feishu-group-collaboration.test.ts` uses synthetic provider HTTP and controlled task admission; it verifies group routing, independent tasks, owner-only activation/new, exact mention filtering, event deduplication, source metadata and post-admission reactions. Real CLI FIFO and renderer evidence remain separate required checks; no promotion or live tenant validation is claimed.

GR-02/04 runtime evidence will use the existing E2E-only `window.__testActions` bridge to submit a group message through the real Host BotsService into the real CLI, while Desktop renders its canonical queue. Synthetic bot configuration/group association is seeded only in the isolated E2E data directory; no live bot credentials or tenant messages are used. The bridge remains gated by `shouldExposeE2EStoreBridge` in production builds.

- GR-02/04 actual Host/CLI/DOM evidence: `feishu-group-runtime.test.ts`, run
  `desktop-e2e-20260907083412006-p20801-c4446c2fbacc5e8b`, 2026-09-07,
  1 passing. Controlled provider SSE fixture holds a real CLI turn while a group
  member submits through the actual Host service. Desktop renders the same queue
  and sender, deletes that queued input without stopping, and reconciles a saved
  uncertain result through the service. This is pending manual review; it is not
  real-tenant Feishu or mobile remote evidence.

- Final combined Desktop regression: `desktop-e2e-20260907085131276-p59423-2a071562b47f5926`,
  3 specs / 4 cases passed (Feishu, Lark, real Host/CLI group queue with file,
  and the existing disconnected remote Bot regression).
- Group task creation and permission persistence: `desktop-e2e-20260907090653408-p90137-073eb0ea483a754d`,
  1 case passed. The real Host/CLI/DOM scenario also sends `/new`, sets owner mode
  to `yolo`, and submits the first group request. The isolated CLI SQLite record
  has `permission.scope=session` and the selected mode; project permission
  defaults are unchanged. This supplements the queue/file/cancellation and saved
  result reconciliation checks above.
- Automated checks on 2026-09-07: 37 focused App test files / 462 tests and
  4 CLI protocol/projection/facade files / 198 tests passed; remote attachment,
  queue scope and continuous/replayable regression evidence is covered separately
  by 6 remote test files / 89 tests. Root `pnpm typecheck` passed.
- Full affected App run executed 880 files: 878 passed (9,677 tests), with 60
  failures in two SessionPane suites whose component mocks omitted the new group
  notice dependency. After isolating the notice consistently with their existing
  composer/model test scope, both files / all 60 tests passed on focused rerun.
  Group notice behavior remains covered by its own tests and the real Desktop E2E.
  Lint completed with 43 existing warnings and 0 errors; group permission isolation
  added 2 passing CLI core tests. `verify:pre-push` was invoked before commit but
  its affected-test selection skipped the uncommitted changes, so the full affected
  App run above was invoked directly against the changed files.
- Live Feishu/Lark tenant mentions, attachment reference visibility, callback
  operator identity, bot removal and lost speaking permission have **not** been
  exercised against a real group. Windows/Linux, real mobile browser/device and
  full cross-host restart behavior remain unverified. Synthetic fixtures and
  unit tests do not stand in for those checks.
- Broader CLI `session-persistence.test.ts` did not pass in this environment:
  its existing model adapter fixtures lack `setModelIoFullRetentionEnabled`;
  diagnostic isolation also exposed local plugin/hook dependencies and stale
  legacy queue/prompt event expectations. Those exploratory fixture edits were
  reverted, and this unrelated suite is not reported as passing. The new group
  session permission behavior is covered by the focused facade tests and the
  real Host/CLI SQLite E2E above.

Post-commit gate (2026-09-07): `pnpm verify:pre-push` passed against feature
commit `57d9b6c3b3`. The repository runner selected all 81 changed files, passed
the 19 changed unit-test files, and passed the affected-code test run for the
55 matching App files. Lint also passed (43 warnings, 0 errors). This supersedes
the earlier skipped pre-commit affected selection; the legacy CLI and live-tenant
validation limitations above remain unchanged.

- GR-02 regression (2026-09-07): after stopping the real CLI and emptying its queue,
  a stale Bot permission record must not block `/new`; verify draft creation and
  removal of the stale record before creating the next task. Unit coverage also
  distinguishes running, queued and interaction-blocked replies.

  Live reproduction: Desktop showed a stopped task with an empty queue while the
  same group retained an unhandled permission record in Bot persistence. After
  restarting normal `pnpm dev:desktop`, a real mention `/new` at 18:32 returned
  `Task: draft / State: draft`. Host logs confirmed CLI `reason=idle` and stale
  interaction cache cleanup. No live persistence was edited and no additional
  `/stop` was sent. This verifies the original Feishu failure independently of
  the isolated runtime E2E. Real remote/mobile regression remains unverified.

  Validation: typecheck, lint (43 existing warnings), 193 focused service tests,
  and verify:pre-push passed. Corrected GR-02/04 Desktop E2E passed in
  `desktop-e2e-20260907103208043-p85801-62fec90a245ce74d` (1 case). The first
  attempt had an invalid synthetic permission missing `response`; a subsequent
  build-reuse attempt exited before testing because dev startup removed `out`.
  Neither failed attempt is counted as passing evidence.

GR-04 action-bar revision: verify per-turn placement, no composer panel or repeated result body, popover reconciliation, queue coexistence, and hidden success/in-flight states. Runtime and real UI evidence to be recorded after verification.

GR-04 implementation notes (2026-09-07): removed `BotGroupTaskNotice` entirely.
Recovery is a popover trigger in the corresponding reply action bar. Persisted
`sourceCommandId` matches canonical input rows; runtime turn IDs are deliberately
not used as product turn IDs. In-flight projection stays pending while storage
retains unknown for crash recovery. No change to Desktop continuous, mobile
replayable, owner routing, or canonical queue admission.

Intermediate verification found and fixed maintenance-turn Hook action leakage.
Two existing SessionPane test harnesses now isolate the new delivery provider.
The first association E2E retry used an obsolete renderer activeInputId (null in
V4); the corrected test reads canonical input attribution from the isolated CLI
ledger. Another retry used unsupported WebDriver window/rect; it now uses the
repository Electron window-size helper. These retries are not passing evidence.

GR-04 final Desktop E2E: passed in
`desktop-e2e-20260907105839858-p78673-cee7e60c7f0472f5` (1 case).
It verifies the canonical CLI input association, recovery beside the matching
reply, no saved-body duplication or composer panel, narrow-window popover bounds,
reconciliation, and the action produced by a real Host/CLI result send rejection
in the isolated test provider. This is not a live Feishu API failure test.

Live normal dev verification at 19:03: restarted `pnpm dev:desktop`, used computer
use to send a harmless `DELIVERYACTIONOK` request in the existing group task, and
observed the same reply in the real Feishu test group (labelled Desktop). Desktop
showed no composer delivery panel or spurious unknown indicator. The new delivery
record has a canonical sourceCommandId, status sent and no error. No real Bot state
was edited. Real tenant failure/timeout, mobile remote, light theme and Windows/
Linux execution remain unverified; semantic tokens and shared UI paths are retained.

Typecheck, Desktop E2E typecheck, lint (43 existing warnings) and focused regression
suites passed. The broad affected test run passed after fixing Hook eligibility
and test providers; its pre-push staging step failed because the pre-commit HEAD
range still named the removed test file. Post-commit `pnpm verify:pre-push` passed against `4a5f7bdb2f`: 21 changed test files and the affected run for 58 App files completed successfully, including staging.

Group member display revision: directory lookup replaces
contact lookup for group actors. Controlled GR-02/04 covers the queue label and
identity popover; it does not establish live tenant API permission or name access.

Group member display evidence (2026-09-07): provider/service/source-label tests
passed (98 tests before removing the generic member word; the updated label's
5 tests passed afterward). Root typecheck passed. GR-02/04 passed with the real
Host/CLI in isolated run `desktop-e2e-20260907113243713-p4711-4f6d853c0d2015c0`,
including queue-name and full-ID popover assertions. Normal dev Desktop history
showed short identity labels and the working popover via CDP screenshot; no saved
source metadata was modified. Live directory lookup for configured app
`cli_a9786b1e21e5dbc2` still returned 99991672. The user's permission screenshot
was for a different app (`cli_a9647cf87cf95bef`), so live name resolution remains
unverified. Actual mobile remote, Windows and Linux UI runs remain unverified;
the change uses the shared source label and does not alter runtime delivery modes.

Final local gates for this revision: `pnpm typecheck`, `pnpm lint` (43 existing
warnings, no errors), and `pnpm verify:pre-push` passed. The latest wording omits
the generic member label and shows only the last six ID characters on fallback.

Normal `pnpm dev:desktop` was rebuilt and restarted after the change (main PID
53715, Host PID 53837). Native Computer Use verified the existing group task's
`Feishu / 飞书 · 5cce9a` labels, click-to-open full ID, and Escape dismissal.
The new Host RPC `bots.getGroupMemberNames` reached the actual Feishu API and
returned the same missing-scope error for `cli_a9786b1e21e5dbc2`; therefore the
remaining live-name verification is blocked by that application's permission,
not by a mocked UI or an unstarted service. The normal dev app remains running.

Follow-up live evidence (2026-09-07): the user replaced the configured bot with
Ryan Bot (`cli_a9647cf87cf95bef`) and enabled the same test group for that bot.
The previous bot's group authorization is disabled. The actual member API now
returns HTTP 200 / code 0, including the bound user's name. The normal dev Host
logs `bots.getGroupMemberNames OK`; native Computer Use and the user's screenshot
both show `飞书 · 莫汝舰` on the real incoming message. This resolves the earlier
application-permission blocker. The spacing follow-up adds an 8px gap between
attribution and the bubble; GR-02/04 measures the actual rendered gap.

Spacing regression passed in isolated Desktop run
`desktop-e2e-20260907114650611-p68251-40a284ddf131f45c`, including the rendered
8-12px gap assertion. Root typecheck and lint also passed.
The spacing follow-up also passed `pnpm verify:pre-push` before submission.

Reply-body attribution follow-up (2026-09-07): group replies no longer prepend
the sender name/open_id; the native reply target remains. Two service regressions
failed before the change and pass afterward. GR-02/04 now asserts the saved
stopped result is exactly `Task stopped.` with its original message reference.
The isolated Desktop run
`desktop-e2e-20260907115618260-p20788-6275e395b82d51f7` passed. Root typecheck,
lint, and 30 group service tests passed.

Native Computer Use verified the normal `pnpm dev:desktop` and real Ryan Bot
in ZCode 群聊验证: after a new draft, `@Ryan Bot Reply only REPLYBODYOK. Do not
use tools.` produced a native quoted reply whose body is exactly `REPLYBODYOK`.
The saved delivery is `sent` and retains the incoming message ID. Existing
messages remain unchanged. The first request after restarting the dev Host
encountered `proto.sessionNotFound` for the old task; this is a separate restart
recovery issue, not fixed or claimed covered by this formatting change. Windows,
Linux and real mobile remote control were not rerun for this service-only change.
The full `pnpm verify:pre-push` rerun passed. Its first run hit the unrelated
Supervisor client-timeout/rollback lifecycle test; that file passed all 19 tests
in isolation before the full rerun.

GR-05 reaction revision (2026-09-07): 94 focused provider/service/lifecycle tests
pass, including monotonic transitions, cancelled/failed/completed states,
Feishu/Lark operator isolation and compact queue-card payload. The prior
permanent-OK behavior fails the added service transition assertions. Desktop
GR-02/04 passed in `desktop-e2e-20260907121550738-p28948-c52d61fb6862ae03` with
the updated queue acknowledgement; it does not prove external reaction rendering.
Root typecheck and lint passed. The real bot can list message reactions (HTTP
200 / code 0) and reports its operator as the application's app ID.

GR-05 live macOS evidence: normal `pnpm dev:desktop` was restarted, then native
Computer Use sent `@Ryan Bot` a read-only `sleep 45` request and a second queued
request in ZCode 群聊验证. The first displayed OnIt; the second displayed
OneSecond and a single-row waiting/cancel card. Clicking Cancel succeeded,
replaced the card with its cancellation confirmation and removed the second
input's reaction. The first completed with `REACTIONDONE`; its only reaction
was CheckMark. Direct API readback returned code 0, `[CheckMark]` for the first
message and `[]` for the cancelled message; the saved result status is `sent`.
No old OK or in-progress reaction remained on those inputs. Failed/stop paths
have service regression coverage, not live failure-injection evidence. Lark
has provider HTTP coverage; real Lark, Windows/Linux and mobile were not rerun.
Root typecheck, lint and the full pre-push gate passed. An initial provider test
run exposed test-token cache contamination; the new fixture now uses its own
app ID and the focused suite passes all 94 tests.

GR-05 queue-card lifecycle correction (2026-09-07): the previous live test
cancelled the queued input and did not cover normal promotion/completion. Queue
cards now persist their message ID and latest input state; admission writes
preserve progress produced by earlier run events. Serialized updates catch up
late card creation and remove cancel controls after waiting. Provider tests
assert the returned card handle; service tests assert running/completed/failed
updates to that handle with no selection. Focused coverage is 99 tests, including
completion before admission returns and the persisted-target/cancel/stop/discard
cases. Root typecheck, lint and pre-push passed. Desktop GR-02/04 passed in
`desktop-e2e-20260907123427883-p5094-a2e438fea8ec6398`, including persisted stopped
status from the real CLI.

Live normal-dev verification used native Computer Use in ZCode 群聊验证 with
Ryan Bot: a `sleep 45` request (`QCARDFIRST`) followed by a queued `sleep 15`
request (`QCARDSECOND`). The second request was allowed to execute normally.
Its original card changed from waiting with Cancel to running without Cancel,
then completed without Cancel; both requests finished with CheckMark. Persisted
cardMessageId stayed identical through waiting/working/done, and cardStatus was
done after `QCARDSECOND` arrived. Old cards without a saved message ID are not
automatically migrated. Actual failure injection, real Lark, Windows/Linux and
mobile remote control were not rerun; no continuous/replayable stream or CLI
queue ownership changes are involved.

## Mention-only and explicit-reference correction (2026-09-08)

The real 10:42 Feishu callback reached the running Host but parsed to zero inputs.
Removing the bot mention left empty text, and the provider discarded it before
reference/topic handling. Text references were fetched for scope checks but not
retained. This was reproduced by four failing provider/service tests.

The correction preserves group mention-only inputs, keeps verified text/post/card
references separate from command parsing, prepares referenced images in the same
input, and guides empty requests without admission when no authorized background
is available. Topic history is prepared once before task creation, with the same
admission-time authorization check and accepted-input checkpoints as before.

122 provider/service tests passed, including quoted control text, post images,
card-visible text, absent history opt-in and history-read failure. Root typecheck
passed after correcting a nullable post body; lint retained 43 existing warnings
and no errors. TP-01 Desktop E2E passed in
`desktop-e2e-20260908025213758-p73535-03aa4b82e6f8baf6`: empty mention returns guidance
with zero queued inputs, and explicit quoted text enters the real CLI queue with
the existing input/attachment and can be cancelled without stopping the task.
The candidate remains pending; it uses the existing controlled provider fixture.

Normal `pnpm dev:desktop` restarted after the local macOS signing prompt was
resolved. Native Computer Use confirmed that a bare main-chat mention returns the
Chinese guidance and does not add an execution reaction. A quote-only mention was
parsed successfully, but exposed a cold-task admission failure:
`proto.sessionNotFound`, although the original task remained in the CLI database.
The adapter now obtains the existing background subscription snapshot before
attachment upload/admission, preserving the same task and workspace identity.
The added test checks recovery ordering, remoteSessionId propagation and refusal
to submit after recovery failure. All 212 tests across the three affected suites
passed; typecheck and lint passed (43 existing warnings, zero errors).
Desktop/mobile continuous/replayable transport and owner routing were not changed.

A subsequent native quote-only request was accepted into the original task after
cold start (`om_x100b66c39fb070acc34a8c8d2ab2180`), exposing the companion failure:
the startup continuous result subscription had exhausted retries before runtime
activation, so the completed result did not reach Feishu. Group stream setup now
waits for the same authoritative snapshot before subscribing, and rechecks the
subscription map after the await to avoid duplicate startup/input listeners.
The lifecycle test covers this ordering without resubmitting old inputs.

Final native verification used `pnpm dev:desktop` and Computer Use in the ordinary
Feishu test group. After restart, quote-only mention
`om_x100b66c3b24414b0c4fa84f7f9c3268` quoted the ordinary arithmetic question
“7 plus 5”. Feishu visibly returned `12` as a native reply and replaced the
working reaction with CheckMark. Persisted state confirms the original task
`sess_5ec4cfa2-10e5-46d9-947f-eb2fe9a3eb27`, accepted admission, progress `done`,
and delivery `sent` to that exact request
(provider message `om_x100b66c3b39e84b4df93b3dcb6d1bde`). No task reset or historical
input replay was used. The implicit request wording explicitly asks the model to
answer the quoted question or carry out its request; command parsing remains
separate on the server.

TP-01 passed again with the cold-subscription fix in
`desktop-e2e-20260908031650082-p95172-4bf16d8330951c84` (one case, one spec).
The final three unit suites passed 212 tests. A broad pre-push run had one unrelated
20 ms timing assertion fail in `retired:packages/ui/test/v4SessionPaneModelSwitchRecovery.test.ts`, with（retired: 为退役历史证据，不计现行覆盖。）
9,818 tests passing; its isolated rerun passed all 53 tests. The full `pnpm verify:pre-push` rerun passed before commit. Native Lark, mobile Web and other OS coverage remain
unverified for this correction; earlier platform coverage is not relabelled.

### Native long-background summary verification (2026-09-08)

Computer Use operated `pnpm dev:desktop` with Ryan Bot in the real dedicated topic
group `oc_6596fb27f96a81b6ee5c34cc09be6089`. The bound owner enabled topic history
with a native `/history on` mention, then created a fresh CEDAR topic
`omt_19fa0d1df1cfda52`. The root and ordinary discussion did not submit task inputs.

- The editor received 27,860 characters of synthetic discussion. A subsequent
  read-only native message API check returned exactly 19,999 text characters for
  message `om_x100b66cc11ee38b4c12a2ac6a7e4efc`, ending midway through record 159.
  Therefore this run covers the server-stored text only, not the entire pasted
  draft. The application archive matches that native API text length; the missing
  editor tail is not evidence of application history truncation.
- A separate ordinary reply `om_x100b66cc2e689908de2920d0b7445a2` confirmed Tuesday
  rather than the old Friday proposal and left the owner undecided. The next
  explicit mention `om_x100b66cc2a8d606cc02f7d5d40479cd` created independent task
  `sess_b3ed9e49-22a9-4b30-8de9-8e3fcc93ce03`. Its accepted background contained the
  two discussion records (19,999 and 50 characters); the root was an explicit quote.
- The actual Agent persisted a 795-character `bot_topic_context` record with an
  earlier-discussion summary and the recent confirmation verbatim. The summary
  labeled Friday as an unconfirmed proposal and retained its original message ID.
  This was a real configured model invocation, not a summary fixture.
- The native final reply correctly reported CEDAR, Tuesday, and owner not yet
  determined. Computer Use observed that reply in the source topic and the native
  completion checkmark. Input progress was `done`; saved delivery was `sent`, with
  provider message ID `om_x100b66cc289cecb0c4a6013736ee30a`.

The focused Agent background/archive tests also passed (11 tests, two files).
This run does not establish the 200-message cap, missing-history recovery,
summary-conflict tool lookup, topic attachment/card races, mobile `/remote`, Lark,
or Windows/Linux behavior. Those remain separate verification items.

### Topic card authority and attachment routing regression (2026-09-08)

Seven explicit service cases now use distinct task IDs for sibling topics. They
reject queue cards with another topic, chat, task, authorization generation or
actor, including old cards after parent disable/re-enable. Rejections assert zero
CLI cancellation calls and unchanged saved inputs for both topics. The valid
author-card control asserts exactly one cancellation targeting A's task and
original command, with B unchanged. The older generic fixture's constant task ID
is not used as evidence for these cross-task checks.

The six-file focused run passed 83 tests: group service authority, topic history,
Bot attachment upload, shared-host mobile attachment, window-host attachment
registry and remote prompt attachments. These are controlled service/transport
regressions, not a real phone, native attachment upload or native card race test.

### Native dedicated-topic file boundary (2026-09-08, incomplete)

Computer Use uploaded the synthetic 154-byte file
`zcode-topic-attachment-verification.txt` to CEDAR in the dedicated test group.
The native history API confirmed file message `om_x100b66ccd1ebe0a8c22a536e7f67b07`
in thread `omt_19fa0d1df1cfda52`, chat `oc_6596fb27f96a81b6ee5c34cc09be6089`.
No bot mention was sent with this file, and no file-analysis input was admitted.

The inspected native message UI had forward/recall/selection controls but no quote
reply. The forward dialog was closed without forwarding. Further UI verification
stopped after Computer Use reported that the user had changed the Feishu window.
This establishes native upload only, not attachment admission or Agent analysis.

Code inspection then confirmed a real implementation gap: historical files become
text placeholders in provider history and the topic archive tool cannot fetch their
resources. The remaining retrieval contract is now explicit in the feature spec;
do not mark historical attachment analysis complete based on explicit-parent tests.

### Historical resource Host boundary (2026-09-08)

Implemented and tested the Host service download boundary. The targeted run passed
154 tests across topic resource authorization/service, native provider and group service
suites. New checks cover task/input/archive/workspace scope, group/history/owner/version
revocation, native message identity, cancellation and post-download authorization changes.
The service integration case returns a transport-ready attachment after both authorization
and native metadata checks. No Agent-side tool or remote materialization is claimed yet.

A real read-only provider invocation downloaded the previously uploaded dedicated-topic
file `om_x100b66ccd1ebe0a8c22a536e7f67b07`: one resource, 154 bytes, SHA-256
`2cb888eaeb649a4bc9c91a4c9682280d11cec485fa7cd8f9b416c82f03df2d4d`, matching the
original synthetic file. This establishes native resource API permission/content fidelity;
the file has not yet been admitted as history by a subsequent mention, so it is not
evidence of the complete Agent on-demand retrieval flow.

Root typecheck and lint passed (43 existing warnings, zero errors). The first full
pre-push run had CUA shutdown timing and mobile-layout timeout failures plus a Vitest
worker heap exhaustion; both files passed in isolation (79 tests). The full
`VITEST_MAX_WORKERS=2 pnpm verify:pre-push` rerun then passed without changing those tests.

# 2026-09-08 原生单独 @ 与令牌有效期回归

- `pnpm dev:desktop` 实际运行时，12:37 的主聊天单独 @ 收到原生事件，但发送补充需求提示失败，飞书返回 `99991663`。代码原先忽略 `expire` 并固定缓存 90 分钟。
- 改为按接口剩余有效期缓存；飞书／Lark provider 定时回归先失败、修复后通过，provider 共 79 项通过。真实接口本次返回 `expire=4187` 秒，小于旧实现固定的 5400 秒。
- 重启开发版本后，Computer Use 在 `ZCode 群聊验证` 发送原生单独 @，消息 `om_x100b66cd6c1c20a4c026ae6aa5b7893`，原生回复 `om_x100b66cd6c2e3938c1c10da2d404a76`，客户端显示“请补充需求，或回复要处理的消息并 @我。”
- 原生 API 消息 ID 对照当前群持久化输入，该消息没有 admission 记录；未新建或排入任务。之前失败的消息 `om_x100b66cd5f92d8acc322408850c60f9` 也没有自动补执行。
- 本次真实验证确认重启后提示投递恢复；完整有效期跨越由受控时钟测试覆盖，未在真实租户等待令牌自然过期。未将该验证宣称为 Agent 历史附件读取、手机、Lark 或其他操作系统通过。

### 2026-09-08 13:18 原生历史附件回查验证（未通过）

运行 `pnpm dev:desktop`，在真实专用群「ZCode 专用话题验证」的 CEDAR 话题使用原生 @Ryan Bot 发起纯文字请求。消息 `om_x100b66cde75330b0c3e499c124d58c0` 被 CLI 接收并显示 OnIt；模型选择了正确的历史文件消息 `om_x100b66ccd1ebe0a8c22a536e7f67b07`，但 `ReadSessionContext(sessionId=current, strategy=topic, attachment=...)` 被 executor 的 JSON Schema 校验错误拒绝（oneOf 同时匹配两个分支）。模型随后查询本机会话目录，不能作为附件读取成功证据。已补 executor 边界失败测试，再改为单字符串模式；12 条工具测试通过。

13:11 的另一条测试消息意外带入剪贴板图片，触发真实 Bot 附件 admission 的 `fault.attachment.connectionUntrusted`，未被 CLI 接收。13:17 已在原生界面撤回该测试消息并确认撤回状态。该入口现补接既有可信 connection scope，91 条 task adapter 测试通过；修复后的真实富文本上传仍待重测。

继续发送 /stop 前 Mac 锁屏，Computer Use 返回无法自动解锁；未将尚未确认发送的停止命令记为成功。历史文件下载、最终字段回复及最终表情归属仍需解锁并重启新代码后重测，不能用单测或先前 Host 下载哈希验证替代端到端结果。

本地检查：当前资源桥、资源授权、附件上传与 task adapter 共 122 条测试通过，根目录 typecheck、lint 通过（lint 43 个 warning）。本轮完整 pre-push 曾在 `retired:packages/ui/test/subagentsSection.test.ts` 的保存后刷新失败场景失败，单独重跑该场景通过，尚未取得新一轮完整 pre-push 成功。扩展 Agent 全量测试仍有 CUA、文件行数及外部 conformance 路径等失败；未宣称全量通过。当前修改暂未提交，远程 Host 转发、真实手机和 Lark 仍待验证／实现。（retired: 为退役历史证据，不计现行覆盖。）

### 2026-09-08 后续代码与受控远程链路检查

- 话题原文回查补齐 canonical 字段优先级；冲突及无效 canonical 的两条测试先失败，修复后工具测试 14 条通过。
- 为 SSH／WSL／Docker 现有 stdio 连接接入私有反向资源频道；测试使用受控 PassThrough transport，不是实连 SSH。改动前请求 30 秒超时，改动后原连接上反向 RPC 成功。
- 分块传输覆盖字节数、SHA-256、群停用、来源连接、remoteSessionId、取消、超时、过载拒绝和同 ID 旧请求迟到。未建立新任务队列或 runtime。
- 受控假 CLI 进程复现预热后反向请求遗漏 remoteSessionId，修复为每次资源请求固定同一 CLI 的当前目标；该测试验证 Host 路由，不代表真实远端 Agent 工具调用通过。
- 最新服务／Host／stdio 回归 8 文件 86 条通过，根目录 typecheck 与 lint 通过（43 个 warning）。完整 `verify:pre-push` 的上一版提交范围重跑成功；该脚本按基线到 HEAD 取文件范围，新增未提交文件另由上述定向测试覆盖，最终提交仍需再跑提交检查。
- Computer Use 再次确认 Mac 锁屏。旧 `pnpm dev:desktop` 执行句柄已退出（130），旧 Electron／Host PID 已不存在；因此不再保留旧代码中的失败测试进程。新的 `pnpm dev:desktop` 构建句柄仍在运行，尚未把新版本原生验证记为通过。
- 待补：新版本本地历史文件完整读取和原话题结果、真实 SSH／WSL／Docker、WebSocket Server 私有回查通道、手机／多成员权限卡、Lark 与其他系统验证。保留原目标范围，不以受控传输测试替代这些验收。

### BOT-E2E-TP-03 话题交互卡（pending）

- 用例：`bots/channels/feishu-topic-interactions.test.ts`，case-local synthetic metadata。
- Setup：启用群并提交话题输入，使用受控 task service 与记录式 Feishu/Lark HTTP。
- Action：发出权限与普通问答事件。
- Assert：卡片只 POST 原话题根消息的 reply，携带 reply_in_thread；回调保留群、话题、任务和授权版本。
- 范围：服务到 provider HTTP 的确定性回归；不代表真实租户、Agent 模型或 Desktop DOM 验证。
- 13:53 原生重测仍未通过：模型继续之前失败后的本机查询，未调用附件工具；13:54 的审批卡出现在群主聊天。停止操作窗口后交由用户验证。修复后的原生交互卡尚未重测。
- 私有 WebSocket 转发已接入；本机真实 WebSocket 连接的受控回归与 peer/Host 检查共 4 文件 16 条通过，未宣称真实远端附件业务链路通过。

TP-03 当前服务回归：Provider 与群服务共 139 条通过；新增 Feishu/Lark 两个场景在
Vitest 服务执行入口通过（2 条），未运行 WDIO，不记为 Desktop E2E 通过。
根目录 typecheck 通过，lint 为 43 warnings / 0 errors。临时卡原话题路由、权限／问答
授权字段修复尚未重启到用户正在操作的开发进程，原生验收待补。

### 2026-09-08 13:57 原生工具调用触发协议关闭

用户手动重测后，CEDAR 任务真实记录出现 ReadSessionContext，strategy=topic、sessionId=current、
附件消息 `om_x100b66ccd1ebe0a8c22a536e7f67b07` 均正确，但结果为 `ZCode Protocol client connection closed`。
Host 同时记录该工作区 CLI 协议关闭及 SIGTERM（protocol-close）。附件 port 直接发送 Core trace，
包含严格协议 trace 不接受的 sessionId／turnId／attributes。新增完整协议帧测试先失败，复用
既有 protocolTraceFromTraceContext 后 3 条 bootstrap port 测试通过（含读取及取消）。
Bootstrap 类型检查、根目录 typecheck/lint 和 CLI 构建通过；lint 43 warnings、0 errors。
用户确认可重启后，旧开发句柄退出130，旧 Electron3817／Host4058 已不存在；开始新的
pnpm dev:desktop。修复后原生读取、返回文件内容及最终表情仍待重测，不记为已通过。

14:06:46 新开发进程已就绪（Electron45600／Host45737，local services ready）；CLI 构建产物中
已确认附件 port 使用转换后的协议 trace。附件桥／群／Provider 服务回归167条、既有消息流回归77条
通过。飞书窗口由用户操作，下一轮原生工具调用及原话题结果待确认。

### Standalone Core WebSocket resource routing regression

`retired:packages/zcode-server-cli/test/coreHttp.test.ts` now exercises two real loopback WebSocket Desktop peers through（retired: 为退役历史证据，不计现行覆盖。）
capability-authenticated `/ws/host`. Reverse requests reach only the matching
workspaceIdentity + remoteSessionId; closing one peer removes only that route. A normal
`/ws` connection does not attach a private resource peer. All 7 Core HTTP tests passed.
The first test-helper attempt lost the RPC initialization frame by awaiting `open` before
installing listeners; synchronously installing RPC in the `open` callback fixed the fixture.
No production transport change was needed. Resource responses remain synthetic, so this
is not live Feishu/Lark, remote Agent attachment, or mobile UI acceptance.

附件取消／断连竞争回归：直接调用实际 abort listener，复现 requestClient 同步抛错会逃逸现有
Promise.catch。取消通知改为 async try/catch 后，bootstrap port 共4条通过；原始读取仍以取消
或断连失败，不新增重试。Bootstrap 与根目录类型检查、lint 通过（43 warnings / 0 errors）。
该追加修复尚未重启到14:06启动的开发进程；正常读取的 trace 修复已在该进程中。

当前工作树受影响单测（包含未提交及新增源文件，而非仅比较 HEAD）：865 个文件通过，
9721 条通过、4 条跳过，日志 `/tmp/topic-current-related.log`。这不包含 Agent 独立工作区
全量测试，也不代表原生飞书验收。TP-01／TP-03 开始运行 WDIO；其构建清理共享 `out`
导致已有开发进程退出，需在本轮测试结束后恢复开发进程，再继续用户手动验证。

本轮 WDIO 已完成：TP-01 的真实 Host／CLI、附件队列及 Desktop DOM 场景1条通过；
TP-03 的 Feishu／Lark 交互卡服务场景2条通过，共2个文件通过，退出0。
日志 `/tmp/topic-desktop-wdio-current.log`。TP-03 即使由 WDIO 执行，仍是服务替身场景，
不作为原生卡片或端到端 UI 证据；TP-01 不覆盖真实飞书文件下载。

14:31:46 开发进程恢复，Host33325 记录 `local services ready, all channels registered`，
日志 `/tmp/zcode-topic-post-wdio-dev.log`。本次重新构建包含取消／断连修复；
提交前校验另在 `/tmp/topic-post-wdio-prepush.log` 运行，原生读取结果仍待用户重测。

该次提交前检查最终退出1：related Vitest 被 SIGSEGV 终止，未输出完整断言报告，
不能记为通过。已重新执行检查（`/tmp/topic-post-wdio-prepush-workers2.log`）；文件名中的
workers2 仅表示启动时传入的环境变量，仓库 Vitest 配置显式指定4个 threads，不能据此
声称实际降低了并发。没有修改测试范围或绕过提交钩子。

系统崩溃报告 `~/Library/Logs/DiagnosticReports/node-2026-09-08-143229.ips`
匹配 Vitest PID14259，EXC_BAD_ACCESS，faultingThread5 的栈位于 V8
ConcurrentBaselineCompiler／AssemblerBase::AddEmbeddedObject。这证明检查进程在后台编译阶段
崩溃，尚不能确认诱因，也不能替代未完成测试的结果。

提交前检查重跑最终退出0，changed-test 与 related 两阶段均完成；完整日志为
`/tmp/topic-post-wdio-prepush-workers2.log`。本次通过不清除前述崩溃记录，也不扩大原生验收范围。

## 已绑定群聊第一期（手动验收待执行）

BOT-E2E-GR-UI-01：机器人设置 → 当前飞书/Lark 机器人 → 工作区访问范围下方。
用两个机器人、两个群、0/多个已记录话题验证：每群一行，只有群名、话题数和开关；
无关联任务、展开或详情入口。切换机器人、长群名、深浅主题、中英文均检查。
Desktop 与手机远控分别验证（窄 Desktop 不代替手机）；窄屏机器人列表在上、设置在下。
关闭群后保留任务/话题计数，另一群不变；重开不补发，飞书 /disable 后界面同步。
保存中不可重复操作；断连失败保持原状态并显示刷新入口；机器人关闭时禁用群开关。
单测覆盖聚合隔离、重复话题、开关等待/失败/no-op、加载失败；不代替真实端到端验收。
当时按用户要求未启动 dev，本项保持 pending；2026-09-23 已补 Desktop 成功保存路径（见文末），手机远控仍未验证。
2026-09-17 收尾提交：群列表/交互及群服务共 91 条单测通过；不将单测当作真实渠道验收。

## BOT-UI-TP-PREPARATION：准备态消息气泡

- 候选：`packages/ui/test/browser/manual-review/pending/topic-preparation.test.mjs`，同目录 case-local fixture。
- 单测：`retired:packages/ui/test/v4BotTopicPreparation.test.ts`；覆盖原始消息 ID 去重、合批 ID、同正文不同 ID 保留、空白正文无气泡、来源行加载图标及 hover/focus tooltip。（retired: 为退役历史证据，不计现行覆盖。）
- 浏览器：桌面/手机宽度 × 中英文 × 深浅主题，真实组件和样式；准备、等待、失败移除及接收重叠；正文沿用正式消息折叠/展开，loading 位于渠道/姓名旁。
- 真实 Desktop/手机远控/飞书 E2E 待验证，不将窄屏 Chrome 计为真实手机验收。

本次组件验证：上述浏览器 8 组通过并人工查看深浅主题截图；准备态/原始消息展开/消息编辑 42 项单测及时间线/标记回归 33 项通过；根 typecheck、architecture:check --changed 通过，lint 0 error、48 warning。截图在系统临时目录 `zcode-topic-preparation/`。

2026-09-17 后续修正：准备消息进入 ConversationTurnGroup 消息流，共用完整正文组件，状态/失败/重试在同一气泡 DOM 内。新增 render-unit 与真实 turn-group 组件回归，覆盖未产生 CLI rows、running live tail 保留及正式输入接替；140 项相关单测通过。根 typecheck、lint（0 error，48 warning）、架构检查通过；浏览器 8 组通过。真实飞书与手机远控仍待验收。

2026-09-17 来源行状态调整：准备文字不再常驻显示，改为「飞书/Lark · 姓名 + loading」，hover/focus tooltip 显示状态；空正文不造气泡。119 项相关单测、8 组浏览器检查通过；覆盖首次配置解析 Lark、旧任务迟到配置隔离、长姓名、tooltip 和重试。typecheck、lint（0 error，48 warning）、架构检查通过。真实飞书/手机远控待验收。

2026-09-17 删除材料准备失败展示：失败不再投影为临时消息，移除红色错误、重试按钮及孤立来源，不产生空白 render unit；服务记录/执行/飞书回复未改动。75 项单测与浏览器 8 组覆盖初始失败、准备转失败、其他消息保留；真实飞书/手机远控待验收。

## 单聊持续回传

| Case          | 状态    | 用例                                                           | 证据边界                                                                                   |
| ------------- | ------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| BOT-E2E-PS-01 | pending | `packages/desktop/test/e2e/bots/delivery/bot-private-task-sync.test.ts` | controlled-stream，三渠道出站 HTTP、连续 desktop/mobile 来源轮次与停用；真实 IM/手机未验证；三渠道私聊输入的命令信封 clientId 均为 `bot:<botId>:<chatId>:<userId>`（CLI 据此不对 IM 用户声明设计模式），去掉该字段变红 `desktop-e2e-20261104075020271-p67472-2346b7cc39b45101`，恢复后绿 `desktop-e2e-20261104075146936-p69418-40b2f88dd72d2984` |
| BOT-E2E-RW-03 | pending | `packages/desktop/test/e2e/conversation-session/remote/configuration/manual-review/pending/conversation-session-r3-bot-private-client-id.test.ts` | SSH 远端（`harness/remote/run-local-docker.mjs`，队列 `r3-server-qa-botprivateclientid`）：Telegram 私聊经本机 Host Bot 服务投到远端任务，命令信封 clientId 为 `bot:<botId>:<chatId>:<userId>`（`formatBotInputClientId`），远端 CLI 执行该轮、远端输入账本记下 bot 形状 clientId，不被 terminal-client clientId 一致性检查拒绝；passed `local-docker-20261104090411-72d33e`。用例经 `__testActions.sendBotMessage` 输入前先切回本地 tab（测试入口按当前 workspace 取服务）。 |

服务补充：多目标共享订阅、自动任务去重、微信 token 更新/重启读取/显式重试、换绑隔离。UI 补充：重试按钮仅显式触发、发送中禁用、成功隐藏及错误可见。均不替代真实渠道人工验收。

## 私聊重投与轮询退避

| Case          | 状态   | 用例                                                                       | 证据边界                                                                                          |
| ------------- | ------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| BOT-E2E-RD-01 | formal | `packages/desktop/test/e2e/bots/delivery/bot-private-redelivery.test.ts`   | 三渠道私聊重投复用 commandId；duplicate 后空闲收口、运行中不误停；附件保留随机 ID；未运行真实 CLI |
| BOT-E2E-RD-02 | formal | `packages/desktop/test/e2e/bots/runtime/bot-polling-retry-backoff.test.ts` | 微信/Telegram 失败日志与退避递增；成功提交后清零；退避中 dispose 立即返回；未验证真实渠道网络     |

- 运行：2026-11-10 macOS WDIO。manual-review 阶段 5/5 通过，产物 `packages/desktop/.e2e-artifacts/desktop-e2e-20261110-093041-172`；rebase 到 staging `58b809c7b7` 后重新构建再跑 5/5 通过，产物 `packages/desktop/.e2e-artifacts/desktop-e2e-20261110-095047-489`。manual-review 默认 capture 缺少模型入口，会在 root hook 失败；这两个用例不调用模型，当时改用显式 replay（`E2E_PROVIDER_REPLAY_FIXTURE_PATH=…/fixtures/upstream/common.json`）。转正后在正式路径按默认模式（不设 replay 变量）运行 5/5 通过，产物 `packages/desktop/.e2e-artifacts/desktop-e2e-20261110-100558-858`。
- 回归证据：撤掉 `packages/services/src/bots` 的修复后 5/5 失败，产物 `packages/desktop/.e2e-artifacts/desktop-e2e-20261110-093358-861`。RD-01 中同一条消息两次得到不同的随机 UUID；RD-02 中第 2 次重试间隔仍为 5000ms。
- 2026-11-10 评审 CR-01（duplicate 后 Typing 与运行状态残留）：扩展后 RD-01 7 项、RD-02 3 项，重新构建后 10/10 通过，产物 `packages/desktop/.e2e-artifacts/desktop-e2e-20261110-111249-139`。撤掉本轮 services 改动（ACK 返回、duplicate 收口、附件随机 ID）后，3 个空闲重投用例因“没有向桌面广播 completed”失败，附件用例因“两次 ID 相同”失败，产物 `packages/desktop/.e2e-artifacts/desktop-e2e-20261110-111552-414`；3 个运行中重投用例修复前也通过，它们防止误停，不是缺陷复现。修复前的临时验证中，Telegram/微信在 duplicate 后每 4 秒继续发 Typing，飞书 reaction 不删，桌面只收到 `resumed`/`prompt_sent`。
- 时序约束：Bot 自己发起的一轮未结束时，私聊新消息会被“任务运行中”拒绝，不会提交。RD-01 先结束首轮，再模拟重投；duplicate 收口以任务快照为准（`completed`/`error` 为空闲）。
- 状态：formal，用户于 2026-11-10 确认转正；covered（任务服务替身与 runtime 依赖注入边界）。未验证真实 CLI 对同一 commandId 的 duplicate 回复、真实渠道重投、手机、Windows/Linux；未加入 Docker 准入集。
- 状态：formal，用户于 2026-11-10 确认转正；covered（任务服务替身与 runtime 依赖注入边界）。未验证真实 CLI 对同一 commandId 的 duplicate 回复、真实渠道重投、手机、Windows/Linux；未加入 Docker 准入集。

## Native channel mention reply

BOT-E2E-MN-01: `bots/channels/feishu-channel-mention.test.ts`，
synthetic service/provider 验证当前输入节点、正文原生 at、固定会话、幂等及未知目标拒绝。
CLI 工具父消息绑定、协议与客户端节点显示分别由单测覆盖；真实飞书验证由用户进行。

2026-09-23 验证：MN-01 的 Feishu/Lark × 群/话题 4 个合成场景在 Desktop WDIO 通过
（`desktop-e2e-20260923052447997-p75879-83688b39c0a71a8a`），当时保留 pending；2026-10-08 已转正。
`channel-mention.test.mjs` 的 390/1200px × 深浅主题 4 个真实组件场景通过；
CLI 工具契约、当前执行输入绑定、来源持久化、反向协议，以及 Host/远端连接隔离另有单测。
这不构成真实租户通知、另一机器人响应或手机 replayable 真机的验证。

## 2026-09-23 分支覆盖补齐

以 case catalog 的 accepted 分支验收表为准。新增 TP-04/TP-05/FN-01/MN-02 优先真实 Host/CLI；
既有 GR/MN/TP/PS case 扩展已定义行为，GR-UI-01 补实际组件交互。
证据必须分别标记 service synthetic、真实 CLI、Desktop DOM、手机 replayable 与 live tenant；
本轮证据如下，不沿用旧通过次数。没有重新开启重复成功回执修复。

| Case                        | 当前证据                                                                                                                                              | 结论                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| MN-02 / FN-01               | `conversation-session-bot-channel-worker.test.ts`：真实 CLI 工具、反向 RPC、两次原生提及、无来源桌面续聊；真实 text delta 丢帧，终态仍完整回传一次    | passed，formal           |
| TP-04 / TP-05               | `conversation-session-bot-topic-worker.test.ts`：收到真实流后自动停止，完成停止后才提交下一条；真实 ReadSessionContext 结果、落盘文件字节及跨任务拒绝 | passed，formal           |
| GR-02 正常晋升 / PS-01      | `conversation-session-bot-continuous-worker.test.ts`：群排队自然晋升并引用正确消息；真实 IM 首轮及 desktop service 续聊各回传一次                     | passed，formal           |
| GR-UI-01                    | `feishu-bound-groups-ui.test.ts`：Desktop 实际点击、RPC 保存、话题计数和其他群/机器人不变                                                             | passed，formal           |
| TP-03                       | 飞书/Lark × 是否明确提及共四场景：可信消息边界、真实 run 来源、引用当前提问、审批 @ 管理员、问答按提及决定 @                                          | passed，pending          |
| GR-02/04 旧 Desktop runtime | v3 状态文件、职业引导和新 Provider 分组夹具已更新；队列展示、取消、来源详情与已收到操作执行至通过；群草稿 `/mode yolo` 失败                           | failed，不算全 case 通过 |

2026-11-03 起 TP-05 改用 `ReadTopicResource` 下载历史话题资源（ReadSessionContext 已删除）。上表 TP-05 证据来自 2026-09-23 的 ReadSessionContext 运行，不代表新工具的运行结果。新工具的运行证据：`desktop-e2e-20261103013357670-p39238-6e019240fc443c4e` 中 `conversation-session-bot-topic-worker.test.ts` 2/2 通过，TP-05 的真实 ReadTopicResource 工具结果为 completed，Host 资源端口收到 1 次读取，托管文件内容与平台夹具一致。首轮 `desktop-e2e-20261103010238669-p10892-abb86846fee45c92` 失败于 tool not found：工具名被误放进动态工作流灰度名单，机器人会话关闭灰度时一并下架；已修复并补 core 回归。未验证：真实飞书、远端 Source Server、Windows/Linux。

新 worker case 的实际路径为 `packages/desktop/test/e2e/conversation-session/manual-review/pending/`；
其他候选在 `packages/desktop/test/e2e/bots/manual-review/pending/`。
三个 worker 的 case-local provider fixtures 与 canonical manifests 均通过 fixture checker；
checker 对结果 marker 的提示不代表输入匹配缺失，结果 marker 只用于出站与文件内容断言。

运行证据：

- `desktop-e2e-20260923072023647-p32033-0a7006ae178b1ce2`：MN-02/FN-01、GR-02 正常晋升/PS-01、GR-UI-01 共 4 tests 通过。该批 TP-05 的初版文件断言把工具文本误按完整 JSON 解析而失败，后续已按真实工具输出格式修正。
- `desktop-e2e-20260923072235577-p39368-fb67b05b6f0e5ef6`：TP-04/05 两项通过；MN-01 四项、PS-01 三渠道三项、runtime authority 两项、remote disconnected 一项、automation result 一项、provider interactions 三项通过。GR runtime 与旧 TP-03 夹具失败分别记录，不把该批整体写成通过。
- `pnpm typecheck`、Desktop `typecheck:e2e`、`architecture:check --changed` 通过；6 个相关单测文件共 149 tests 通过。
- 根 `pnpm lint` 失败于本次未改文件的 max-lines：`packages/shared/src/zcode-protocol-v4/command.ts` 405，`packages/ui/src/v4/conversationTurnRenderUnits.ts` 401；本次修改的测试与 helper 定向 lint 0 error/0 warning。

未关闭的问题与边界：

1. GR runtime 的 `/mode yolo` 实际返回 `Mode option not found.`，随后新 session 的权限为 `{scope:"session",mode:"build"}`。`listDraftConfigOptions` 仅返回 reasoning，mode.set 无候选；已对比 `origin/staging`，同一实现也存在于基线。保留原本 yolo 隔离断言，不修改产品实现或降低预期；因此该 case 仍失败，后续断言未执行。
2. TP-05 调试时旧 `readSessionMessages` 接口出现当前 CLI 返回结构与旧 schema 不匹配（messageId/sessionId 对 id/sessionID 等）。最终文件核验读取隔离 CLI SQLite 的真实 completed tool result，不绕过 ReadSessionContext 下载；该旧查询接口问题未在本次测试维护中修复。
3. 实际手机 replayable、SSH、Windows/Linux、真实飞书/Lark 租户通知与另一机器人响应未验证。成功的 Node Host/CLI 测试不冒充 Electron UI，窄窗口不冒充手机。
4. 初始验证时所有新增 case 保持 pending；随后用户确认转正，最终状态见下节。必要检查仍有失败，因此不自动 commit。

GR-UI-01 最终隔离配置保留缺密钥的绑定引用，避免自动触发扫码注册；
`desktop-e2e-20260923072504683-p46231-87bcca99bca1deb4` 中该项通过，截图可见两群开关与 2/0 话题数。
TP-03 更新当前历史边界、从根引用改为当前消息引用，并补上真实入站字段 `mentionedBot` 与 run/input 来源；
权限审批的管理员提醒不受该字段限制，普通问答才受限制。不能用旧夹具缺字段的失败推断实际客户端行为。

TP-03 最终四场景在 `desktop-e2e-20260923073023766-p58398-07c97a81dceae606` 全部通过。
按最终版本去重合计：本轮新增 6 tests + 相关既有回归 18 tests 通过，GR-02/04 一个完整 case 仍失败；
不把中间失败、重复回放计入通过数量。此处为转正前验证记录；最终目录状态见下节，上述未验证边界继续保留。

### 2026-09-23 用户确认转正

用户确认后，四份新增 spec（六条测试）进入正式目录：

- `conversation-session/session-control/conversation-session-bot-channel-worker.test.ts`
- `conversation-session/session-control/conversation-session-bot-topic-worker.test.ts`
- `conversation-session/session-control/conversation-session-bot-continuous-worker.test.ts`
- `bots/channels/feishu-bound-groups-ui.test.ts`

前三份采用独立 common + case-local 回放夹具；UI 用例使用隔离配置，无模型请求。已有 `/mode yolo` 失败用例仍保持 pending。此次没有 Docker 验证或 CI 准入，不代表真实飞书租户、手机或其他桌面系统验收。

转正后验证：

- 显式独立夹具回放：`desktop-e2e-20260923080004888-p15664-50144fe647413bfe`，4 spec / 6 tests 全部通过。
- 默认回放：`desktop-e2e-20260923080201440-p21714-f35052aadb92370c`，4 spec / 6 tests 全部通过。Worker 自建回放服务仅加载 common 与自己的 case-local fixture。
- 三份 fixture check、Desktop E2E typecheck、根 typecheck、架构检查和覆盖审计均通过；新增 spec/helper 定向 lint 为 0 errors / 0 warnings。Fixture check 的未匹配 marker 警告对应输出断言/附件内容，不是缺失请求。
- 转正审计发现 Highspeed manifest 两条 syntheticReason 与 provider fixture 不一致，已机械同步说明文字，未改请求或测试语义。
- 初次转正时根 lint 存在两个 max-lines 错误，随后由 `536dd65dce` 拆分配置 schema 和渲染类型解决，保持原有行为与导出入口。
- `905e271182` 补齐 Highspeed 测试的 Bot 服务 mock，并等待 stdio 服务异步回收后再清理临时目录。最终 typecheck、lint（0 errors / 62 warnings）、架构检查和完整 pre-push 均通过；pre-push 覆盖 76 个变更测试文件及 196 个源文件的关联回归。此结果不替代上文尚未通过的 Desktop E2E 或 Docker/CI 准入。

## 2026-10-08 话题详情入口移除

回复操作栏不再展示话题详情按钮或弹窗；历史 TP-01 的详情展示证据不再代表当前 UI 契约。组件回归覆盖话题任务的成功投递无入口，以及失败/未知投递保留恢复按钮。组件及会话轮次回归 119 条通过；真实浏览器在 390/1200 宽度 × 中英文 × 深浅主题的 8 组检查均通过，断言详情入口消失、失败恢复弹层仍可打开。真实 Desktop 与手机 relay E2E 本次未重跑。

## TP-06 其他机器人消息

复用 `conversation-session-bot-topic-worker.test.ts` 的 TP-04 场景，增加真实 Provider 解析的其他机器人输入和自身消息过滤断言。Provider/service 单测覆盖双渠道、未接入/退出边界、控制命令隔离、重复事件和机器人历史。

2026-10-08 验证：5 个单测文件共 232 项通过；桌面 E2E 2 项通过，运行记录
`desktop-e2e-20261008-085523-181`。真实 Host/CLI 证明其他机器人消息停止旧运行后
进入同一任务并成功回复，重复回调及自身消息不新增输入；历史资源工具回查继续通过。
fixture 检查、根 typecheck、desktop typecheck:e2e、lint 和架构检查通过；lint 保留
既有 warnings。平台 HTTP 与模型为隔离替身，不替代真实飞书/Lark 推送、租户权限、
手机远控界面或其他操作系统验证。本次不修改桌面 continuous / 手机 replayable 链路。

## 2026-10-08 机器人自动互答上限

- TP-04：真实 Host/CLI 话题任务连续接收 5 条机器人消息；第 5 条仍运行时，第 6 条不触发 stop 或 admission；真人新消息恢复后继续接收。
- MN-01：Feishu/Lark 原生 bot 回调在主聊天执行 5 条上限、重复不计数、真人恢复。
- 服务单测：并发上限、旧真人重投不恢复、主聊天/话题隔离、v3 schema 序列化后新建服务保留上限。
- 限制：平台 HTTP 使用合成夹具；不证明真实租户机器人推送权限或手机远控真机行为。guard 只影响 Bot Host 入站，不改变 desktop continuous / mobile replayable 的运行态恢复协议。

验证：`desktop-e2e-20261008-113805-939` 两个正式 spec 共 6 passing；加强运行中断言后
`desktop-e2e-20261008-114025-803` 真实 CLI 话题 2 passing；服务/Provider/存储/mention 共 216 条单测通过。

## 2026-10-09 引用与投递重放回归

MN-01 正式用例覆盖 Feishu/Lark × 群/话题的活跃发送重放：平台响应由 Promise 屏障控制，
重放不能提前返回，两次最终回执一致且只发送一次；普通群机器人引用会读取父消息。
`desktop-e2e-20261009-022912-432`：4 passing。首次完整构建后 WebDriver session 创建超时，
同一构建重试成功；该启动失败不计入用例通过。
服务/Provider/delivery 共 138 条单测通过，覆盖 bot/app 的文字/附件父引用、自身过滤、
活跃发送及限流重试的重放等待、重启遗留 unknown 不重发。平台 HTTP 是合成替身，
不替代真实租户通知、手机远控及跨操作系统验证。

## 2026-10-09 多机器人身份与指派边界

- TP-04 扩展：真实 CLI 正在运行时，原生只 @ 其他机器人的消息不触发 stop/admission；下一条有效输入补读这条背景，携带当前机器人身份，成功接收后清理补读标记。
- 服务单测：同名不同 ID 不抢答；重建服务保留补读检查点；补读期间的新背景保留到下一轮；无 @ 空输出保持静默，显式 @ 的空输出保留完成提示。
- CLI 单测：模型上下文包含自身身份、逐条消息是否 @ 自己以及职责边界；无 @ 的非本人任务允许不调用工具、不回复。

验证：`desktop-e2e-20261009-072256-679` TP-04/05 共 2 passing；服务 112、
Provider 100、CLI 上下文 5 条测试通过。根 typecheck、CLI typecheck、desktop
typecheck:e2e、根 lint、改动 CLI 文件 lint、架构与 fixture 检查通过。
CLI 全量 lint 被既有 debug/cli/telemetry 文件的 max-lines 错误阻塞，未改动这些文件。
平台 HTTP 与模型使用合成夹具；不证明真实模型始终正确理解无 @ 分工，也不替代真实租户、
手机远控和其他操作系统验证。本次只改变 Bot 入口与输入上下文，不修改 desktop continuous /
mobile replayable 的流恢复协议；未新增 Docker/CI 准入。

### 群聊停止静默（2026-10-09）

MN-01 的 Feishu/Lark × 群主聊天/话题四项覆盖 `/stop` 成功不返回状态卡、
取消完成事件不投递停止通知。群服务单测验证停止表情更新和错误回复的原始收件人。
本轮运行结果以 MR 验证记录为准，合成渠道覆盖不代表真实租户验证。

### 跨任务名字候选（2026-10-09）

MN-01 四种 Feishu/Lark × 群主聊天/话题组合模拟切换任务并从持久化状态恢复，
新任务仅提供纯文字名字仍能解析同授权历史原生 mention，直接使用旧 ref 则拒绝发送。
单测另覆盖不同授权、群、app、bot、provider 的历史节点隔离。

### MR 评审回归（2026-10-09）

TP-04 既有真实 Host/CLI 用例增加停止屏障期间「有效需求 → 纯 @」批次，检查
原始消息均被 admission；同名原生收件人通过实际模型请求的 isCurrentBot 区分。
Provider 单测覆盖 checkpoint 前、调用后、删除和窗口内必需卡片展开失败。
合成平台/模型隔离不代替真实租户，desktop continuous/mobile replayable 未改变。

身份投影定位回归：CLI 单测覆盖相同正文、原生 @ 前后位置交换、同一目标重复出现和多消息
批次；TP-04 实际模型请求断言有序 text/mention 结构及自身/他人关联，不暴露 targetId。
