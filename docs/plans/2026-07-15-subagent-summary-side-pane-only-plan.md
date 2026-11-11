# Subagent Navigation And Directory Implementation Plan

> 状态：产品边界已确认，正在独立 worktree 实施。本文已合并原 side-pane-only 计划与 Subagent Session Directory 计划；当前代码不是产品语义来源。

**目标：** 父对话流中的 Agent/Task 工具始终保持单行摘要，不再展开 Prompt、输出、活动或子工具。存在 `childSessionId` 时，点击摘要行在桌面/普通 Web 打开右侧只读 tab，在手机 `/remote` 打开现有右侧抽屉；不存在 `childSessionId` 时摘要行不可点击。桌面/普通 Web 的摘要提供当前父 Session 的 Subagent 目录，按正在运行/已结束分组并对已结束项分页。失败原因同时保留在父摘要状态和当前 child 详情中，但不为 child 详情新增持久化或timeline row。

**架构方向：** 继续复用 V4 `SessionPane`、conversation projection、workspace side-pane state 和手机现有 drawer。新增只读 `session/subagents` 查询，把父 active transcript、已持久化 child session 与 runtime overlay 组合为单一投影；不新增数据库表。UI 侧显式区分顶层 task 分组身份 `rootSessionId`、直属父会话 `parentSessionId` 与目标 `childSessionId`。桌面保持 `desktop-continuous`，手机保持 `web-remote-replayable`；relay、desktop main 和 Host 不持有目录状态。

**非目标：** 本次不恢复 subagent 派生 subagent 的 runtime 能力，不新增 child 错误持久化，不改变 permission/AskUserQuestion 的归属，不改变 side-pane tab 的持久化或订阅生命周期，不新增数据库表或 Agent tool 字段，不修改 Workflow，不在手机提供目录，也不为手机另起 Host/Agent runtime。

## 1. Feature Summary

| 字段                | 内容                                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 变更类型            | 现有行为纠偏与回归保护；统一 foreground/background/mobile 的 subagent 详情入口                                                                 |
| 用户可见入口        | 父会话 Agent 摘要行、Running subagent 状态行、桌面/普通 Web 右侧 tabs、手机 `/remote` 右侧抽屉、child 只读会话                                 |
| 现有主 spec         | `docs/subagent-session-side-tabs.md`、`docs/agent-tool-call-renderer.md`                                                                       |
| 现有 catalog/matrix | `docs/conversation-session-case-catalog.md` SAT01-SAT23、BG26、Z01；`docs/testing/conversation-session-e2e-coverage-matrix.md`                 |
| 主要 UI owner       | `ConversationAgentToolCallRow`、`SessionPane`、`SubagentSessionSidePane`、`AnimatedSidePanePanel`、`workspaceSidePane`、`WorkspaceShellLayout` |
| 主要测试 owner      | `packages/ui/test/subagentSidePane.test.ts`、pending SAT E2E、BG26 E2E、Z01 pending E2E                                                        |
| 不下沉的边界        | CLI projection/runtime 继续持有摘要与撤销权威；不把状态移到 relay/main，也不改 Host attachment、owner/lease、queue 或 workspace execution path |

## 2. Clarification Log

| 轮次 | 问题                                                   | 用户答案                                            | 固定边界                                                                            | 后续                        |
| ---- | ------------------------------------------------------ | --------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------- |
| 1    | 父对话里的 Agent 是否继续行内展开                      | 不再在对话流展开；点击整行打开侧栏                  | 父对话只承载状态摘要和详情入口                                                      | accepted                    |
| 1    | subagent 报错显示在哪里                                | 父摘要行显示即可；详情中也可以显示                  | 父行保留“执行失败”与根因 hover/focus；有 child 时详情也显示当前错误                 | accepted                    |
| 1    | 没有 `childSessionId` 时如何处理                       | 不可点击                                            | 不创建临时错误 tab，不保留 inline fallback                                          | accepted                    |
| 1    | 嵌套 subagent 是否允许递归打开                         | 允许留口子；当前 runtime 已不能派生 subagent        | UI 身份模型与 callback 支持递归；真实 runtime E2E 暂时剪枝                          | accepted + runtime-pruned   |
| 1    | 手机如何展示                                           | 不内联，使用右侧抽屉                                | 复用现有 mobile side-pane overlay，不新增移动页面                                   | accepted                    |
| 2    | child 详情中的 permission/AskUserQuestion 是否特殊跳转 | 不用特殊处理                                        | 不自动关闭抽屉、不新增“回父对话处理”提示                                            | accepted                    |
| 2    | child 错误是否成为持久 timeline 内容                   | 不用持久化，能显示即可                              | 直接消费当前 `snapshot.control.lastError`；不新增 row/schema/storage                | accepted，覆盖前一轮 B 选择 |
| 3    | 目录是否新增数据库表                                   | 不新增                                              | 复用 active transcript、SQLite child session 与 runtime overlay                     | accepted                    |
| 3    | 目录范围                                               | 当前 active branch；Workflow 不改                   | Agent 与兼容 Task alias；只显示可靠持久 child                                       | accepted                    |
| 3    | 状态与分页                                             | running 不分页；ended 每批 20                       | terminal success/fail/cancel/lost 同组，保留具体状态                                | accepted                    |
| 3    | 多端                                                   | 桌面/普通 Web 有目录；手机只保留详情抽屉            | 手机不提供目录                                                                      | accepted                    |
| 3    | mini/expanded                                          | mini 不显示 ended；expanded 有 ended count          | ended-only 不强制 mini；expanded 的 count 收进“智能体”折叠分组，点击 count 打开目录 | accepted                    |
| 3    | branch 生命周期                                        | edit/retry 失效、compact 保留、fork 继承 ended 引用 | 自动关闭失效详情 tab且不进最近关闭                                                  | accepted                    |
| 4    | 协议边界                                               | 允许只读 `session/subagents` 查询                   | 不新增 Agent tool/error 字段或数据库表                                              | accepted                    |
| 4    | 手机无 child 完整错误                                  | 本次只保留短错误                                    | 不新增 touch 专用完整错误入口                                                       | accepted                    |
| 5    | child 详情是否支持文件摘要撤销                         | 支持                                                | 对话保持只读；只开放单 turn workspace-only rewind，父 task 可仍在运行               | accepted                    |

## 3. Product Contract

### 3.1 摘要行状态机

```text
Agent 工具摘要行（永远不展开）
│
├─ childSessionId 可用
│  ├─ foreground / background
│  ├─ running / success / failed / cancelled
│  └─ click / Enter / Space
│     ├─ desktop-continuous -> 创建或激活右侧只读 tab
│     └─ web-remote-replayable -> 创建或激活手机右侧抽屉中的 tab
│
├─ childSessionId 尚未到达
│  ├─ 当前保持不可点击摘要
│  └─ childSessionId 后续到达 -> 变为可点击；不得自动打开详情
│
└─ childSessionId 永远不存在
   ├─ 启动前 provider/model/config/tool 失败
   ├─ 摘要显示 terminal 状态和现有错误状态入口
   └─ 不可点击、不创建临时 tab、不显示 inline detail
```

### 3.2 交互不变量

1. Agent 摘要行在 V4 conversation 中不出现展开箭头、`aria-expanded` 或 collapsible content。
2. 有 child 目标时，整条摘要是单一详情动作，支持鼠标、Enter 和 Space；重复激活只聚焦已有 tab，不切换为关闭。
3. 无 child 目标时，摘要没有 `role=button`、`tabIndex=0` 或详情 action test id。
4. foreground 和 background 不再分叉详情行为；`backgrounded` 只影响 runtime 生命周期和状态，不影响是否可打开 child。
5. 手机 `compactForRemoteControl` 不再作为 subagent detail 的禁止条件；它仍可继续约束 embedded browser、外部 App、分屏等无关能力。
6. Running status panel 与 conversation Agent 行复用同一打开请求和 tab 身份；stop/cancel 控件继续阻止冒泡。
7. child 详情保持对话只读：无 composer、retry、edit、fork、stop、permission/elicitation response；单 turn workspace-only file rewind 是唯一显式写能力例外，打开 child 和执行撤销都不改变 shell `activeTaskId` 或父对话历史。

### 3.3 文件撤销持久与时序合同

```text
child live runtime(seq 1..N) -> detached publisher(raw=N)
child runtime released       -> checkpoint/session_entry
preview/apply cold resume    -> SessionResumed(new raw epoch)
                              -> RewindTriggered
                              -> workspace_file_rewind/session_entry
                              -> publisher transport seq 继续 N+1..
```

- checkpoint 关联与 workspace-only rewind 状态都复用既有 `session_entry`，不新增表或 migration。
- `SessionResumed` 只重设 gateway 的 raw cursor，不回退对外 transport sequence；刷新后 child turn 保持
  `reverted`，且父 Agent 行、父 task aggregate 和聊天历史不变。

### 3.4 错误展示合同

```text
父 Agent tool projection.error
  -> 父摘要“执行失败”
  -> 现有 hover/focus/copy 根因

child 当前 snapshot.control.lastError
  -> child 只读详情中的错误 notice
  -> 仅展示当前 projection 已提供的错误
  -X-> 不新增 turnError row
  -X-> 不新增协议 schema
  -X-> 不新增 session/task 持久化
```

- 父摘要继续使用最接近根因的结构化错误，不能退化为 `Turn execution failed`。
- child 详情错误 notice 不放进 composer，因为 read-only pane 不渲染 composer。
- 如果现有 cold snapshot 恰好带有 `control.lastError`，可以照常显示；本文不把“child 详情错误跨刷新必然存在”定义成新合同。
- BG26 继续验证父 Agent 行在 task restore 后保持 failed + error；child 详情只要求 live/current projection 可见，不新增 restore 断言。
- child 内部单个工具失败但整个 Agent 最终成功时，父摘要不得误标 failed；内部失败只留在 child timeline。
- `cancelled/stopped` 与 `failed` 继续分开，不把用户主动停止渲染为 provider 错误。

### 3.4 递归下钻身份

现有 `parentSessionId` 同时承担“直属父会话”和“tab 随哪个顶层 task 显隐”，只适用于一级 child。未来递归必须拆开：

```text
root task A
└─ child B
   └─ child C

打开 C：
  rootSessionId   = A     # tab 分组、切 task 显隐、最近激活记录
  parentSessionId = B     # 直属 lineage，未来 breadcrumb/诊断使用
  childSessionId  = C     # 详情订阅目标

tab stable id = workspaceKey + rootSessionId + childSessionId
workspaceKey  = workspaceIdentity?.trim() || workspacePath
```

- 一级 child 使用 `rootSessionId === parentSessionId`，因此现有 tab id 文本保持兼容。
- `SubagentSessionSidePane` 内的 Agent 行复用与主 `SessionPane` 相同的 summary action；只由宿主 wrapper 继承 `rootSessionId`。
- 当前 runtime 不允许 subagent 派生 subagent，因此只实现 UI 类型、tab reducer 和 callback contract；不伪造真实 provider E2E 覆盖。
- 本次不增加 breadcrumb UI；保存直属 `parentSessionId` 只是避免接口再次把 lineage 与可见分组混用。

### 3.5 多端与异步边界

```text
Desktop renderer attachment                  Mobile /remote attachment
{desktop-continuous}                         {web-remote-replayable}
        │                                             │
        ├─ parent conversation subscription           ├─ parent replayable subscription
        └─ child side-tab subscription                 └─ child drawer replayable subscription
                         \                            /
                          existing shared Host / CLI

relay / desktop main:
  只做 attachment、鉴权和 rpc-frame 透传
  不拥有 tab、conversation、error、snapshot 或 child 状态
```

- 手机必须复用 `WebRemoteControlMobileShell` 已有右侧 overlay；打开时背景聊天继续 inert。
- 手机打开 child 不创建独立 local host、remote host、SSH/WSL/Docker session 或 Agent runtime。
- remote workspace 请求贯穿 `workspaceIdentity` 与 `remoteSessionId`；不得只用 `workspacePath` 创建 tab/连接 key。
- 本次不修改现有 side-pane force-mount/lease 生命周期。是否让手机隐藏 tab 释放订阅属于性能优化，先留在 backlog，不能顺手改变 replayable 语义。

## 4. Current-Code Conflict Map

| 冲突                        | 当前事实                                                                                                                                 | 目标判断                                                  | 分类               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------ |
| background Agent 被禁止直开 | `9ebfe37525a` 在 `openSubagentSessionFromSummary` 增加 `backgrounded` guard，并把 `canOpenChildSession` 绑定 `showSubagentOutputPreview` | 违反 SAT01 与本次确认的 foreground/background 一致性      | bug-candidate      |
| BG26 强制展开               | BG26 E2E 点击 `TID_TOOL_SUMMARY_TRIGGER` 并等待 inline output                                                                            | 应改为父行失败 hover + 直开 child + child 当前错误 notice | spec/test conflict |
| SAT11 inline fallback       | 当前 spec 对无 child、启动失败、嵌套和手机保留 inline 展开                                                                               | 全部取消 inline；无 child 静态，nested/mobile 走详情容器  | spec conflict      |
| 手机 detail callback 断路   | mobile `V4ChatPane` 没有 `onOpenSubagentSession` prop，Agent 行 context 得到 `undefined`                                                 | 用现有 DI 链接回 app-shell handler                        | bug-candidate      |
| 手机 compact gate           | Agent row 与 Status panel 在 `compactForRemoteControl` 时不提供入口                                                                      | subagent detail 应进入现有右侧抽屉                        | bug-candidate      |
| child pane 无递归 callback  | `SubagentSessionSidePane` 未接收/下发 `onOpenSubagentSession`                                                                            | 下发带 root/parent/child 身份的 wrapper                   | capability gap     |
| read-only pane 丢错误       | `control.lastError` 只传给 composer；read-only 隐藏 composer                                                                             | 在 read-only SessionPane 内直接展示当前错误 notice        | bug-candidate      |
| inline preview 数据耦合     | `showSubagentOutputPreview`、`SubagentDrilldown`、`agentOutputPreview` 和 Agent `content` bridge 只服务 inline                           | 移除 V4 inline path 和已无消费者的桥接                    | cleanup            |
| root/parent 混用            | tab visibility、stable id、last-active map 都只使用 `parentSessionId`                                                                    | 拆为 root grouping 与 immediate lineage                   | design defect      |

## 5. Domain Scope And State Owners

### 5.1 Primary domains

| Domain                            | 是否纳入       | 原因                                                                                        | 主要来源                                           |
| --------------------------------- | -------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Conversation/session behavior     | yes            | Agent 行 guard、tool terminal 状态、child target 时序、错误 projection                      | conversation protocol、SAT/BG/Z catalog            |
| Permission/tool/subagent UI       | yes            | ToolLayout action/inline 互斥、Agent renderer、nested child                                 | `docs/agent-tool-call-renderer.md`、ToolCallBlocks |
| UI shell/responsive               | yes            | desktop tab 与 mobile drawer 使用同一 side-pane state                                       | `DESIGN.md`、WorkspaceShell、MobileShell           |
| Mobile remote/replayable          | yes            | 必须保持 shared-host/replayable 边界                                                        | web remote architecture、task realtime sync        |
| Workspace identity/remote runtime | yes            | tab/connection 隔离需要 identity + remoteSessionId                                          | workspace constraints、workspaceSidePane           |
| Persistence                       | limited        | 复用现有 parent transcript/event 与 child session；不新增表， tabs 仍为 renderer memory     | directory/ side-pane spec                          |
| CLI/runtime/protocol              | yes, read-only | 新增 `session/subagents` 查询和 active-branch 投影； 不恢复 nested runtime、不改变 workflow | protocol schema + query unit                       |

### 5.2 State owners

| 状态/事实                              | Authority                                           | UI mirror/cache                             | 证明方式                          |
| -------------------------------------- | --------------------------------------------------- | ------------------------------------------- | --------------------------------- | ------------------------------ | --------------------- |
| Agent tool status/error/childSessionId | CLI ProductProjection `ToolCallRow` + `SubagentRow` | ConversationProjectionStore、legacy adapter | snapshot/delta + DOM              |
| child 当前 `control.lastError`         | child conversation projection                       | SessionDataLayer lease/store                | child snapshot + read-only notice |
| side-pane tabs/active tab              | renderer `useAppPanels`/workspace side-pane state   | current workspace shell memory              | reducer unit + DOM tab count      |
| root task visibility                   | shell `activeTaskId`                                | last-active subagent map                    | task switch unit/E2E              |
| workspace isolation                    | `workspaceIdentity?.trim()                          |                                             | workspacePath`                    | tab id/connection registry key | same-path remote unit |
| delivery profile                       | trusted Host attachment                             | transport/session layer                     | clientMode/deliveryKind evidence  |
| mobile drawer open/inert               | renderer MobileShell                                | DOM overlay state                           | UI integration test/manual remote |

## 6. Dimensions And Equivalence Classes

| 维度               | 值/等价类                                                                | 是否展开       | 剪枝理由                                          |
| ------------------ | ------------------------------------------------------------------------ | -------------- | ------------------------------------------------- |
| child target       | present、temporarily absent、permanently absent、present but unavailable | yes            | 直接决定 action、静态行与 pane 错误               |
| Agent execution    | foreground、background                                                   | pairwise       | 目标行为相同，但 regression 来自 background guard |
| terminal status    | running、success、failed、cancelled                                      | representative | action invariant 相同；failed/cancelled 单独断言  |
| client/surface     | desktop/ordinary Web side tab、mobile drawer                             | yes            | 容器和 delivery kind 不同                         |
| nesting            | root child、nested child future capability                               | yes            | 身份模型不同；runtime E2E 剪枝                    |
| open lifecycle     | first open、repeat open、task switch、closed/reopen                      | representative | stable id 与 parent group 风险                    |
| data source        | live child publisher、cold child store、subscribe error                  | representative | 详情可用性不同但不得退回 inline                   |
| workspace          | local、remote same path/different identity                               | pairwise       | identity/remoteSessionId 强不变量                 |
| error source       | parent tool error、child control.lastError、inner child tool error       | yes            | 防止错误层级混淆                                  |
| theme/locale/input | light/dark、zh/en、pointer/keyboard/touch                                | pairwise       | UI/i18n/a11y 验收，不做全排列                     |

## 7. Candidate Classification

| Candidate | State + event                                     | Expected effect                                                          | Status                 | Notes                             |
| --------- | ------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------- | --------------------------------- |
| SDS-C01   | desktop foreground + child present + activate row | open/reuse right read-only tab; no inline                                | accepted               | 更新 SAT01                        |
| SDS-C02   | desktop background + child present + activate row | 与 foreground 相同                                                       | accepted               | 修复 `9ebfe37525a` regression     |
| SDS-C03   | any client + child permanently absent             | static summary; no tab/no inline                                         | accepted               | 更新 SAT11                        |
| SDS-C04   | child temporarily absent then arrives             | static -> action；不自动打开                                             | accepted               | SAT11 时序                        |
| SDS-C05   | mobile replayable + child present                 | open existing right drawer with child tab                                | accepted               | 更新 SAT10                        |
| SDS-C06   | failed child + current lastError                  | parent hover + child read-only error notice                              | accepted               | 更新 BG26；无新持久化             |
| SDS-C07   | failed child + renderer/task restore              | parent failed/error restore；child notice 非必然合同                     | accepted               | 保留 BG26 parent restore          |
| SDS-C08   | child pane contains nested Agent target           | inherit root、record immediate parent、open/reuse nested tab             | accepted UI contract   | runtime E2E pruned                |
| SDS-C09   | child target exists但 subscribe/hydration 失败    | pane 显示连接/订阅错误；父行不退回 inline                                | accepted               | 使用现有 retry surface            |
| SDS-C10   | cancelled Agent                                   | 保持可打开已有 child；状态显示 stopped/cancelled，不显示 failure tooltip | accepted               | focused unit                      |
| SDS-C11   | Running status item on desktop/mobile             | 使用同一 tab/drawer request；cancel 阻止冒泡                             | accepted               | 更新 SAT12 mobile gate            |
| SDS-C12   | mobile no child + 需要查看完整原始错误            | 当前仅确认整行不可点击和不内联；touch 专用错误入口未确认                 | undefined              | 不阻塞 desktop 主路径，见 backlog |
| SDS-C13   | mobile drawer closed/inactive tabs                | 保持现有 lease/forceMount 行为                                           | ignored in this change | 性能后续，不改变 delivery 语义    |
| SDS-C14   | nested runtime 真正生成 child-of-child            | 当前产品能力不存在                                                       | pruned                 | 只测 UI request/reducer contract  |
| SDS-C15   | 为启动失败创建 toolUseId 临时 tab                 | 禁止                                                                     | pruned                 | 用户明确无 child 时不可点击       |
| SDS-C16   | 将 child error 写入 timeline/schema/store         | 禁止                                                                     | pruned                 | 用户明确“不用持久化”              |

## 8. Pruning Decisions And Backlog

| ID  | 剪枝/未决组合                                        | Guard/不变量                             | 处理                                   |
| --- | ---------------------------------------------------- | ---------------------------------------- | -------------------------------------- |
| P01 | 所有 Agent inline Prompt/output/activity/child tools | `agentSummaryNeverExpandsInConversation` | 删除 V4 inline path，不保留 fallback   |
| P02 | 无 child 时临时详情 tab                              | `childDetailRequiresChildSessionId`      | 静态摘要；不以 toolUseId 发明第二身份  |
| P03 | 手机另起 runtime/host                                | shared-host attachment invariant         | 复用现有 MobileShell + Host/CLI        |
| P04 | nested provider E2E                                  | current runtime capability guard         | 只做 UI/reducer unit；能力恢复时补 E2E |
| P05 | child 错误新增持久化                                 | user decision                            | 只消费当前 control.lastError           |
| P06 | permission/AskUser 特殊跳转                          | user decision                            | 无新 UI/时序                           |
| P07 | mobile hidden-tab lease 优化                         | 不属于交互语义修复                       | 保持现状，另开性能 case                |

### 未决但不阻塞主实现

| Question                                    | 当前默认                                         | 影响                                                                                  |
| ------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 手机无 child 的失败行如何查看完整原始错误   | 不新增独立 tap/popover；保留短状态，等待产品补充 | 不能以该未决项为由恢复 inline；若后续需要，只允许独立错误状态入口，不得创建 child tab |
| 手机抽屉关闭后是否释放 inactive child lease | 保持现有 side-pane 生命周期                      | 后续基于 relay 带宽、内存和重开延迟数据单独决策                                       |

## 9. Accepted Case Plan

| Catalog mapping | Setup                                                       | Action                                          | Assertions                                                                                       | Evidence                            | Status after doc backfill   |
| --------------- | ----------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------- | --------------------------- |
| SAT01           | desktop/ordinary Web；foreground 与 background 各有 childId | click、Enter、Space                             | 相同右侧 tab action；无 aria-expanded/chevron/inline；重复打开去重                               | DOM + side-pane reducer             | planned                     |
| SAT02/SAT03     | 6+ child tabs，至少两个 streaming                           | 依次打开并切换                                  | 6+ 稳定 tabs；desktop continuous 持续更新                                                        | DOM + child topic seq               | pending/manual review       |
| SAT05           | tab 关闭/重开；renderer refresh                             | reopen                                          | 标题与稳定 id 保持既有合同；不恢复 tabs                                                          | reducer + hydration                 | covered/focused             |
| SAT06           | same path remote identity A/B                               | open children                                   | tab/connection 不串；remoteSessionId 原样传递                                                    | reducer + connection key            | covered/focused             |
| SAT10           | mobile `/remote` replayable，childId present                | tap Agent row/Running row                       | 现有右侧 drawer 打开；聊天 inert；无 inline；active task 不变                                    | mobile DOM + scoped request         | planned                     |
| SAT11           | childId absent/start failure；另含 delayed childId          | activate before/after target                    | absent 不可点击；target 到达后可点击但不自动开；永不 inline                                      | DOM + request spy                   | planned                     |
| SAT12           | Running panel 中 subagent/bash/no-id 混合                   | activate/cancel                                 | subagent desktop/mobile 打开同一详情；bash/no-id 不打开；cancel stop only                        | DOM + request spy                   | planned                     |
| SAT13（新增）   | child side pane 当前 snapshot 有 lastError                  | open child                                      | read-only pane 显示原始错误；不创建 timeline error row                                           | snapshot + DOM                      | planned                     |
| SAT14（新增）   | synthetic nested row contract：A -> B -> C                  | 在 B pane 激活 C                                | request/root=A,parent=B,child=C；tab 随 A 显隐；重复去重                                         | unit/reducer                        | planned, runtime E2E pruned |
| BG26            | background child provider 429                               | terminal notification、hover、open、task switch | parent failed/hover；click opens child；live child notice 含原文；parent restore 保持；无 inline | provider fixture + projection + DOM | planned update              |
| Z01             | Agent 在 child 创建前 provider/model 失败                   | 查看并尝试激活失败行                            | 根因可见；无 child action、无 inline；sibling Agent 正常                                         | runtime tool_result + DOM           | planned update              |

## 10. Implementation Tasks

执行顺序必须保持：spec/catalog/matrix -> failing tests -> source -> runtime evidence -> full checks -> commit。

### Task 0: Backfill Source-Of-Truth Specs Before Code

**Files:**

- Modify: `docs/subagent-session-side-tabs.md`
- Modify: `docs/agent-tool-call-renderer.md`
- Modify: `docs/conversation-session-case-catalog.md`
- Modify: `docs/testing/conversation-session-e2e-coverage-matrix.md`
- Reference only: `docs/superpowers/plans/2026-07-10-background-subagent-failure-detail.md`（历史完成计划，不倒改）

**Steps:**

- [ ] 把“无法直开则 inline fallback”改成“无 child 静态；有 child 统一详情容器”。
- [ ] 更新 SAT01、SAT10、SAT11、SAT12，新增 SAT13/SAT14；记录 mobile drawer、root/parent/child 身份和 no-persistence error。
- [ ] 重写 BG26 的 UI action：删除展开断言，增加 child tab/error notice；保留父行 restore。
- [ ] 更新 Z01：无 child 启动失败卡不可点击且不内联。
- [ ] Matrix 中尚未落地的条目标成 `planned` 或 `missing`，不得提前写 `covered`。
- [ ] 明确 nested runtime E2E 为 capability-pruned，mobile no-child touch 原始错误为 undefined。

### Task 1: Write Focused Failing Tests

**Files:**

- Modify: `packages/ui/test/subagentSidePane.test.ts`
- Modify: `packages/ui/test/workspaceSidePane.test.ts`
- Modify: `packages/ui/test/agentToolCallBlock.test.ts`
- Modify: `packages/ui/test/v4AssistantWorkRenderItems.test.ts`
- Modify: `packages/ui/test/v4ToolCallRowAdapter.test.ts`
- Modify: `packages/ui/test/v4SessionPaneLayoutParity.test.ts`
- Modify: `packages/ui/test/workspaceShellRemoteMobileLayout.test.ts`
- Modify: `packages/ui/test/webRemoteControlMobileShell.test.ts` only if new integration assertion is needed

**Steps:**

- [ ] 先把 background/mobile/nested 从 `openSubagentSessionFromSummary` blocked set 移除，只有缺 child/root/callback 才返回 false。
- [ ] 断言无 child Agent summary 是静态行：无 action、无 toggle、无 inline content。
- [ ] 断言 foreground/background 都产生同一 action test id，Enter/Space 走同一 callback。
- [ ] 断言 request/tab 同时保存 `rootSessionId`、`parentSessionId`、`childSessionId`；visibility 和 last-active 只按 root。
- [ ] 断言 mobile `V4ChatPane` 收到 `onOpenSubagentSession` 与 `remoteSessionId`，drawer 继续是右侧 overlay 且背景 inert。
- [ ] 断言 read-only child 在 `control.lastError` 存在时展示 notice；普通无错 child 不展示。
- [ ] 断言不会生成新的 conversation row，也不要求刷新后错误仍存在。
- [ ] 断言 background Agent output 不再需要 `content` 作为“可展开活动正文”桥接。
- [ ] 运行 targeted Vitest，确认 RED 原因分别是 background/mobile gate、inline fallback、身份混用和 read-only error surface 缺失。

### Task 2: Separate Root Grouping From Immediate Parent

**Files:**

- Modify: `packages/ui/src/lib/workspaceSidePane.ts`
- Modify: `packages/ui/src/hooks/useAppPanels.ts`
- Modify: `packages/ui/src/app-shell/types.ts`
- Modify: `packages/ui/src/v4/conversationRowContext.ts`
- Modify: `packages/ui/src/v4/SessionPane.tsx`
- Modify: `packages/ui/src/app-shell/SubagentSessionSidePane.tsx`
- Modify: `packages/ui/src/app-shell/AnimatedSidePanePanel.tsx`
- Modify: `packages/ui/src/app-shell/WorkspaceShellLayout.tsx`

**Interfaces:**

```ts
interface OpenSubagentSideTabRequest {
  rootSessionId: string;
  parentSessionId: string;
  childSessionId: string;
  subagentType: string;
  title: string;
}
```

**Steps:**

- [ ] 扩展 request/tab 类型，保存 root + immediate parent；一级入口同时填当前 session。
- [ ] stable tab id、visible group、last-active map 改用 `rootSessionId`；直属 `parentSessionId` 不参与分组。
- [ ] 对 HMR/旧 renderer-memory tab 使用 `rootSessionId ?? parentSessionId` 兼容，不新增磁盘 migration。
- [ ] `SubagentSessionSidePane` 接收 DI callback；nested request 继承 tab.root，使用当前 child 作为 immediate parent。
- [ ] `AnimatedSidePanePanel` 只透传打开意图，不直接操作 session/runtime。
- [ ] remote request 保留 `workspaceIdentity` 与 `remoteSessionId`；tab key 不使用裸 `workspacePath` 表达身份。
- [ ] 运行 reducer/request focused tests 到 GREEN。

### Task 3: Make Agent Summary Side-Pane-Only

**Files:**

- Modify: `packages/ui/src/v4/ConversationAgentToolCallRow.tsx`
- Modify: `packages/ui/src/v4/conversationAssistantWorkItems.ts`
- Modify: `packages/ui/src/ToolCallBlocks.tsx`
- Modify: `packages/ui/src/ToolCallBlocks/fileSummaryTypes.ts`
- Modify: `packages/ui/src/ToolCallBlocks/renderers/agent.tsx`
- Modify: `packages/ui/src/ToolCallBlocks/ToolSummaryRow.tsx` if needed to remove static `aria-expanded`
- Modify: `packages/ui/src/v4/toolCallRowAdapter.ts`
- Delete after reference audit: `packages/ui/src/v4/SubagentDrilldown.tsx`

**Steps:**

- [ ] `canOpenChildSession` 只依赖有效 child/root/callback，不依赖 foreground/background、mobile compact 或旧 inline preview flag。
- [ ] 无 child 时显式传递 `canToggle=false`；静态摘要不挂 `role=button`、keyboard handler、chevron 或 `aria-expanded`。
- [ ] 保留 child 后到时“只切 action 模式、不自动打开”的行为。
- [ ] 删除 V4 `showSubagentOutputPreview`、`agentOutputPreview`、`SubagentDrilldown` 和 `inSubagentDrilldown` 数据链。
- [ ] 删除只为 background inline activity 服务的 Agent `content` adapter bridge；保留 `error` 与 `output` 的通用 projection 映射。
- [ ] 不删除 Agent renderer 的通用 prompt/activity helper，除非 `pnpm dep:refs` 与 `rg` 证明所有非 V4 消费者也已消失；本次只保证 conversation V4 不可展开。
- [ ] 保持失败 tooltip/copy 按钮阻止冒泡；普通行区域激活详情。
- [ ] 更新中文 bugfix 注释，说明回归根因是 E2E 旧期望把 background 行错误地绑定回 inline fallback。
- [ ] 运行 Agent renderer/work-item/adapter focused tests 到 GREEN。

### Task 4: Show Current Child Error In Read-Only Detail

**Files:**

- Modify: `packages/ui/src/v4/SessionPane.tsx`
- Optional create: `packages/ui/src/v4/ConversationReadOnlyErrorNotice.tsx`
- Modify only if new copy is unavoidable: `packages/ui/src/i18n/locales/zh-CN.ts`, `packages/ui/src/i18n/locales/en-US.ts`

**Steps:**

- [ ] 从现有 `snapshot.control.lastError` 和既有 error normalization 派生展示消息，不另建 store。
- [ ] `readOnly && controlLastError` 时在 timeline/detail surface 中渲染紧凑语义错误 notice；不得依赖隐藏的 composer。
- [ ] 使用 DESIGN tokens、`role=alert`/可读文本、长错误换行和可复制行为；同时验证 light/dark 与 zh/en。
- [ ] 不新增 `TurnErrorRow`、V4 row schema、CLI projection event、task/session persistence 或 restore migration。
- [ ] 不为 permission/AskUserQuestion 增加自动关闭、跳转或额外 banner。
- [ ] 订阅错误继续使用现有 centered retry surface；业务 `control.lastError` 与 transport subscribe error 不混为一类。
- [ ] 运行 SessionPane/read-only error focused tests 到 GREEN。

### Task 5: Wire Mobile Main Chat To The Existing Drawer

**Files:**

- Modify: `packages/ui/src/v4/V4ChatPane.tsx`
- Modify: `packages/ui/src/app-shell/WorkspaceShellLayout.tsx`
- Modify: `packages/ui/src/v4/SessionPane.tsx`
- Modify: `packages/ui/src/v4/ConversationStatusPanel.tsx` only for the current mobile gate
- Test: `packages/ui/test/workspaceShellRemoteMobileLayout.test.ts`
- Test: `packages/ui/test/webRemoteControlMobileShell.test.ts`

**Steps:**

- [ ] 给 `V4ChatPane` 增加 `remoteSessionId` 与 `onOpenSubagentSession` DI props，并透传给 `SessionPane`。
- [ ] 手机 WorkspaceShell 调用传入 `workspaceRemoteSessionId` 和现有 `handleOpenSubagentSession`。
- [ ] 仅移除 subagent detail 的 `compactForRemoteControl` gate；不放开分屏、embedded browser、external app 等其它 mobile gate。
- [ ] Running status subagent row 同样允许打开 drawer；bash/no-child item 保持无入口。
- [ ] 复用 `setIsSidePaneCollapsed(false)`、workspace side-pane state 和 `WebRemoteControlMobileShell` 的右侧 overlay；不创建新 drawer component。
- [ ] 验证打开 drawer 不改变 active task，不绕过 replayable subscription，不触发新的 runtime/host creation。
- [ ] 保持 covered chat surface inert、backdrop close 和现有 tab strip 行为。

### Task 6: Rewrite Conversation E2E Contracts

**Files:**

- Modify: `packages/desktop/test/e2e/conversation-session/subagents/conversation-session-subagent-side-tabs.test.ts`
- Modify: `packages/desktop/test/e2e/conversation-session/background/conversation-session-background-subagent-rate-limit.test.ts`
- Modify: `packages/desktop/test/e2e/conversation-session/tools/conversation-session-tool-error-surface.test.ts`
- Modify/create case-local fixtures and manifests only as required by the changed assertions

**SAT manual-review steps:**

- [ ] 保留 6+ tab、重复打开去重、child live growth 和 workbench pane 不变断言。
- [ ] 增加 conversation summary 的 background Agent 直开覆盖，而不是只测 Running status panel。
- [ ] foreground/background summary 都断言无 `aria-expanded`、无 chevron、无 inline content。
- [ ] 增加 delayed/missing child 的可点击性 unit；除非能用稳定 fixture 构造，不为纯 UI guard 强行增加昂贵 provider E2E。

**BG26 steps:**

- [ ] 删除点击 `TID_TOOL_SUMMARY_TRIGGER` 展开和等待 inline `EXPECTED_RESULT` 的逻辑。
- [ ] 断言 background failed summary 使用 side-pane action test id，父行“执行失败” hover 仍是 provider 原文。
- [ ] 点击父行打开对应 child，live/current child error notice 包含 provider 原文。
- [ ] 切 task 再回来只重复父行 failed + hover + 可重新打开同一 child 的断言；不要求 child error 被新增持久化。

**Z01 steps:**

- [ ] 启动前失败 Agent 没有 child action、没有 inline content，父行仍展示真实 provider/model 根因。
- [ ] sibling Agent 继续成功，父 continuation 同时收到 failed/success tool_result。

**Mobile evidence:**

- [ ] 当前 desktop WDIO 不能冒充真实 `/remote` replayable；先用 shell integration unit + 实际手机/窄 viewport manual review。
- [ ] 若后续存在可控 mobile attachment harness，再新增独立 SAT10 replayable E2E；未运行前 matrix 保持 `planned`/`manual-review`。

### Task 7: Runtime And Visual Verification

交互 bug 不能只靠静态阅读。完成首次实现后必须抓运行时证据。

- [ ] 启动可调试 desktop，使用 CDP/agent-browser 检查 foreground/background Agent summary DOM：action id、无 inline、点击打开正确 child。
- [ ] 复现 BG26 case-local 429，记录父行 tooltip、child current error notice 和 task switch 后父行状态。
- [ ] 使用手机 `/remote` 或真实 mobile viewport + shared-host attachment 验证右侧 drawer、背景 inert、关闭/重开、replayable catch-up。
- [ ] 检查 side pane 打开前后 shell `activeTaskId` 不变，child 订阅 sessionId 正确。
- [ ] 对 remote workspace 检查请求/tab/connection key 同时含 `workspaceIdentity` 与 `remoteSessionId`。
- [ ] 检查 UI logger 无新增高频 info；若需要诊断，只使用 `packages/ui/src/logger.ts` 且逐事件 trace 走 debug。
- [ ] 截图核对 light/Zai Light、dark/Zai Dark、中文、英文、窄屏长标题和长错误换行。

### Task 8: Automated Verification And Closeout

**Targeted tests:**

```bash
pnpm vitest run \
  packages/ui/test/subagentSidePane.test.ts \
  packages/ui/test/workspaceSidePane.test.ts \
  packages/ui/test/agentToolCallBlock.test.ts \
  packages/ui/test/v4AssistantWorkRenderItems.test.ts \
  packages/ui/test/v4ToolCallRowAdapter.test.ts \
  packages/ui/test/v4SessionPaneLayoutParity.test.ts \
  packages/ui/test/workspaceShellRemoteMobileLayout.test.ts \
  packages/ui/test/webRemoteControlMobileShell.test.ts
```

**E2E checks:**

```bash
pnpm --filter @zcode/desktop typecheck:e2e

pnpm --filter @zcode/desktop e2e:fixture:check -- \
  --spec ./test/e2e/conversation-session/background/conversation-session-background-subagent-rate-limit.test.ts

pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec \
  './test/e2e/conversation-session/background/conversation-session-background-subagent-rate-limit.test.ts'
```

- [ ] 对 pending SAT/Z01 按 `e2e-case-lifecycle` 执行 manual/capture review、case-local fixture 整理和 promotion；不得直接标 formal covered。
- [ ] 如修改/删除导出，先运行 `pnpm dep:refs --list-exports <file>`，再对 changed export 做 `pnpm dep:refs <file>:<symbol>`；用 `rg` 补查 JSX/字符串消费者。
- [ ] 运行 `pnpm typecheck`。
- [ ] 运行 `pnpm lint`。
- [ ] 运行 `git diff --check`。
- [ ] 审查 diff，确认没有协议、relay/main、queue、owner/lease、side-pane persistence 或 runtime 能力的意外改动。
- [ ] 更新 catalog/matrix 的最终 coverage 状态和测试路径。
- [ ] 使用 Conventional Commit，例如 `fix(ui): open subagent details outside conversation flow`。

## 11. Verification Matrix

| Surface                   | Desktop continuous              | Ordinary Web       | Mobile replayable         | Required evidence                    |
| ------------------------- | ------------------------------- | ------------------ | ------------------------- | ------------------------------------ |
| foreground Agent summary  | automated unit + SAT manual/E2E | shared unit/manual | mobile integration/manual | DOM action/no-inline + request       |
| background Agent summary  | BG26 + SAT coverage             | shared unit/manual | mobile integration/manual | row failed/hover + child open        |
| no child/start failure    | Z01 + focused unit              | shared unit        | focused unit/manual touch | static row + root error              |
| child current error       | BG26 live                       | shared unit/manual | mobile manual             | snapshot.control.lastError -> notice |
| recursive UI contract     | reducer/unit only               | reducer/unit only  | reducer/unit only         | root/parent/child request            |
| remote workspace identity | unit + remote manual            | unit/manual        | remote mobile manual      | workspaceKey + remoteSessionId       |
| accessibility             | pointer + Enter/Space           | same               | touch + drawer            | role/tabIndex/focus/inert            |

## 12. Risks And Rollback Boundaries

| Risk                                         | Detection                          | Mitigation                                              |
| -------------------------------------------- | ---------------------------------- | ------------------------------------------------------- |
| 无 child 行仍被 ToolLayout 默认设为可展开    | static markup/DOM unit             | V4 明确 `canToggle=false`，断言无 aria-expanded/content |
| background output 不再 inline 后错误丢失     | BG26 parent hover + child notice   | 保留 row.error；只删除 content 展开桥接                 |
| nested tab 切 task 后消失                    | root/parent reducer test           | visibility/last-active 只使用 rootSessionId             |
| mobile request 丢 remoteSessionId            | shell prop capture + remote manual | V4ChatPane/SessionPane 显式透传                         |
| mobile 慢连接影响 desktop                    | connection/clientMode evidence     | 不修改 delivery profile；owned subscription 保持隔离    |
| read-only error notice误当成 transport error | focused snapshot tests             | 业务 lastError 与 subscribe retry surface 分开          |
| 删除 SubagentDrilldown 误伤其他入口          | dep:refs + rg                      | 只在无消费者后删除；否则保留文件但断开 V4 path          |
| E2E 为通过而再次改产品代码                   | catalog/matrix review              | spec 先行；BG26/SAT01 以本计划为准                      |

回滚只允许回滚本次 UI wiring/identity/error notice；不得通过恢复 background/mobile inline fallback 来回滚。若 child pane 有阻断性故障，应修复 pane/订阅错误面，而不是重新让父 conversation 承担详情。

## 13. Definition Of Done

- [ ] `docs/subagent-session-side-tabs.md`、catalog 和 matrix 与用户裁决一致。
- [ ] 所有 V4 Agent summary 在 conversation 中都不存在 inline detail path。
- [ ] foreground/background 有 child 时均直开同一桌面 tab/mobile drawer。
- [ ] 无 child 时整行不可点击，不创建临时 tab。
- [ ] child target 后到不会自动打开详情。
- [ ] parent failed hover 保留根因；child 当前错误可见且无新增持久化/schema。
- [ ] nested UI contract 正确区分 root/parent/child，真实 runtime case 明确剪枝。
- [ ] mobile 复用 shared-host replayable + 现有右侧 drawer，active task 和 desktop continuous 不受影响。
- [ ] BG26 不再通过展开 Agent 卡片证明错误可见。
- [ ] targeted tests、E2E evidence、`pnpm typecheck`、`pnpm lint`、`git diff --check` 全部通过。
- [ ] 最终实现使用 Conventional Commit，并在提交说明列出 mobile replayable 与 nested runtime 的验证边界。
