# Permission 审批与项目级允许

## 背景

桌面端权限弹窗需要支持“在该项目中一直允许”。agent 内部已经支持 `permissionUpdates`，但 app 侧只拿到 allow/deny 的简单响应，导致 UI 只能展示“仅允许这一次”和“拒绝”。

## 目标

把权限选项建模为“展示文案 + 真实协议响应”的组合：

- `allow_once`：只允许本次工具调用。
- `allow_project`：允许本项目后续相同工具/规则，响应里携带 `permissionUpdates`。
- `deny`：拒绝本次工具调用。

可信官方 CUA 另有一个受限的项目级能力组语义：用户第一次为官方 CUA 选择
`allow_project` 后，同一项目内后续官方 CUA 工具共享这一条授权，不再因为
`get_app_state`、`left_click`、`key`、`drag` 的工具名不同而逐个弹窗。这个例外只扩大
官方 CUA 工具族内部的匹配范围，不改变 `allow_once` 的一次性语义，也不扩大普通 MCP
工具的权限。

## 协议约束

`interaction/requestPermission`、`permission.requested` 事件和 pending permission snapshot 都必须携带 `options`。每个 option 必须包含：

- `optionId`：稳定选项 ID。
- `kind`：UI 展示语义。
- `name` / `description`：展示文案。
- `response`：用户选择该 option 时原样回传给 agent 的 `ZCodePermissionResponse`。

legacy app 按 option.response 透传裁决；V4 通过稳定 optionId 交给 Agent 已登记的交互处理，不根据 UI 序号推导响应。完全访问属于下述独立提交动作，不能当成普通 allow。

## Deny with feedback（V4）

V4 permission snapshot 可通过 `freeText: true` 声明“拒绝时允许附带反馈”。该字段是输入能力，不是
第四种 permission 裁决，也不改变 `allow_once`、`allow_project` 和 `deny` 的协议。

- Desktop、Web 和手机 `/remote` 复用同一 `PermissionDialog` 与 `resolveInteraction`；桌面保持
  `desktop-continuous`，Web/手机保持 `web-remote-replayable`。
- 用户提交的反馈随 `resolveInteraction.answer.freeText` 发送，并与 `optionId: "deny"` 一起进入同一
  provider-visible denied `tool_result`；不新增真实 user message、`steer` 或 permission 事件类型。
- 拒绝内容以稳定 Deny 文案开头；非空反馈按固定格式追加：稳定文案后接一个空格、
  `To tell you how to proceed, the user said:`，再换行放置 `<trimmed feedback>`。
- 空白反馈回退稳定 Deny 文案；allow 选项携带的 `freeText` 忽略；未知 option 仍 fail-closed 为 deny。
- 输入框是独立的 UI 导航行，序号接在权限选项之后（支持完全访问时为 `5.`，旧能力组合仍为 `4.`），与 Deny 分别选中、高亮；默认仍聚焦第一个权限选项。上下键、Tab / Shift+Tab 在权限选项和输入行间循环，对应数字键（完整选项为 `5`）聚焦输入行而不提交；输入法选词不切换行。
- 输入行与权限选项属于同一视觉分组，行间距统一为 4px；工具详情、选项分组和底部确认区之间仍保持 12px。输入框保持在权限 `listbox` 外，不改变权限选项的无障碍语义。
- 输入行非空时 Enter 或确认提交 Deny with feedback；空白时 Enter 不提交、确认禁用。普通 Deny 确认仍附带已有非空反馈，Allow 仍忽略反馈；Escape 仍只退出输入焦点，五行上限不变。
- PermissionDialog 的 feedback 输入是可自动换行、按内容增高的多行文本框，序号与 textarea 第一行文字的垂直中心对齐，不随输入框整体高度移动（普通权限选项仍居中），最多 5 行、4096 字符，超过行数后在输入框内滚动；共享 `resolveInteraction` schema 不限制其他
  interaction 的 `freeText`，避免收窄 AskUserQuestion、Plan 和通用 user-input 的既有行为。未提交草稿只存在
  renderer 内存，pending command 继续只保存敏感摘要。
- legacy v3、TUI 和 bot 不声明该能力，继续使用普通 Deny 兼容路径。

```text
UI focus (fullAccess): [1 Allow once] <-> [2 Allow project] <-> [3 Full access]
       ^                                                          |
       +---------------- [5 Feedback] <-> [4 Deny] <---------------+
                               |
                                                        Enter / Confirm
                                                               v
                                            existing Deny + answer.freeText
```

## 弹窗展示语义

- `reason` 继续随权限请求保留，供策略诊断、日志和恢复链路使用；UI 不应把所有策略原因都当成用户提示。
- `High risk tools require explicit approval` 和 `Tool has side effects and requires approval` 是内部策略说明，不在权限弹窗中展示。弹窗已经通过“等待确认”、工具详情和操作选项表达审批状态，重复展示这些说明不会帮助用户决策。
- 工具输入中的具体 `description`、命令、文件变更、URL 和其他可操作详情仍按现有规则展示。

## 规则生成

`allow_project` 的 `permissionUpdates` 使用 `addRules`：

- `behavior: "allow"`
- `toolName` 来自权限请求。
- 非 Bash 工具的 `ruleContent` 继续尽量从权限输入提取 URL、路径或 glob；提取不到时只记录工具名。
- Bash 工具由 CLI 的 AST-aware rule policy 生成稳定 command prefix 或 exact rule，app、host、main、relay 和 TUI 都不得重新从 input 推导。
- 只有通过 official plugin authority secret gate 验证的 CUA tool entry 才携带运行时
  `permissionCapabilityGroup: "official_cua"`。其 `allow_project` 建议规则在既有
  `{toolName, ruleContent?}` 结构中使用保留 key
  `zcode:permission-capability:official_cua`，不增加 wire 字段，也不从可伪造的 MCP
  server/tool 名推导。
- 能力组保留规则不携带 `ruleContent`。它表达用户对该项目内整组官方 Computer Use
  能力的授权，而不是某次坐标、路径或 app input 的字符串匹配。

Bash 稳定 prefix 使用既有 `"<prefix>:*"` 编码；无法安全归一化、包含 redirect/dynamic
结构或高风险宽 action 时保存完整命令 exact。compound command 最多返回五条独立规则，
超过上限回退整串 exact。只读 invocation 由 Bash readonly policy 自动允许，不写冗余规则。

`suggestedPermissionUpdates` 必须进入 `permission.requested` durable event 和 pending
snapshot。桌面 continuous、手机 replayable、刷新恢复和 TUI 统一展示、回传这份权威数据，
不能分别计算出不同授权范围。

## 官方 CUA 能力组边界

能力组匹配同时依赖“持久化规则”和“当前 tool entry 的可信 authority”：

```text
official plugin config + authority secret
              |
              v
register MCP tool -- verified? -- no --> ordinary exact-tool permission
              |
             yes
              v
tool entry carries permissionCapabilityGroup=official_cua
              |
     first allow_project
              v
project ruleset stores official_cua group rule
              |
   later tool in same project
              v
stored group == current trusted tool group ?
        | yes                         | no
        v                             v
      allow                      normal ask/deny policy
```

必须接受的组合：

- 同一 `projectId`、同一份已验证 official CUA authority 下，第一次
  `allow_project` 后，其他 official CUA 工具命中能力组规则。
- 旧的 exact tool、Bash prefix/wildcard 和 tool-only 规则保持原语义。
- 权限请求从 desktop continuous 恢复到手机 `web-remote-replayable` 时，仍回放同一份
  option response；项目规则只由 Agent 的 session store 持久化一次。

必须拒绝或回到正常询问的组合：

- `allow_once` 后的下一次调用。
- 不同 `projectId`、缺失持久化 session 或 project identity 漂移。
- 第三方 MCP 使用相同 server/tool 名、伪造 official plugin id、同名工具覆盖，或
  authority 验证结果发生漂移。
- 普通 MCP、node_repl、browser-use 等非官方 CUA 工具。
- 手工写入保留 key 但当前 tool entry 没有可信 official CUA capability；必须回到正常
  ask/deny，不能按普通 exact toolName 兜底。

禁止把能力组编码为 `mcp__computer-use__*`、server-name wildcard 或 plugin-name wildcard。
这些字符串都可被第三方 MCP 模仿，不能作为授权 authority。

## 存储兼容

项目权限继续保存在 `local_setting` 的 `permission/ruleset` JSON 中，不新增 SQL migration，
不修改 schema version，也不改变 `PermissionRuleValue` 的严格
`{toolName, ruleContent?}` 形状；旧 exact、`:*`、wildcard 与 tool-only rule 原样保留。
能力组使用一个旧 schema 可解析、旧 Agent 只会安全忽略的保留 `toolName` key；其中 Bash
prefix/wildcard 改由 AST evaluator 按 invocation 安全匹配，避免旧宽规则吞掉 compound 的
追加命令。没有新授权发生时不得批量重写历史 ruleset。

这个编码是混合版本与回滚边界：旧 desktop/mobile/bot 的严格 schema 能展示并原样回传
该规则；新版 Agent 将它与当前可信 tool entry 的 capability 一起解释。若回滚到旧 Agent，
保留 key 不会匹配真实工具，最坏只会再次询问，不会扩大授权或让 pending permission
无法解析。

这样能覆盖 shell 命令、文件路径、网络 URL 等常见权限请求，同时保留 agent 侧规则解释权。

## 验收

- 不支持完全访问能力的权限弹窗保留三项：仅允许这一次、在该项目中一直允许、拒绝；支持时使用下述四项与可选第五行反馈。
- 点击“在该项目中一直允许”后，app 回传的 response 包含 `permissionUpdates`。
- 后续相同规则不再重复弹出权限申请。
- official CUA 的项目级选项明确展示“Computer Use”范围；选择后，同项目
  `get_app_state → left_click → key → drag` 只出现第一次确认。
- 同名第三方 MCP、不同项目和 authority drift 都不能复用 official CUA 能力组规则。
- 权限弹窗只读展示将新增的 prefix/exact scopes，不提供可编辑 pattern input；多行或超长
  exact 仅显示有界首行摘要，完整 rule 只随 response 透传，不进入选项 DOM。
- refresh/replay 后 scope 文案和原始 `permissionUpdates` 与首次请求一致。

## 审批框“允许，并切换为…”（Todo158）

普通主任务审批在 Agent 支持完整提交能力时依次提供：允许一次、始终允许此命令、允许并切换模式、拒绝；声明 `freeText` 时反馈为第五行。命令的项目允许保留 Agent 给出的 prefix/exact 规则；文件、网络、MCP、CUA 保留自己的范围文案。

命令审批第 2 项说明为“项目范围内，后续相同命令不再询问”；第 3 项为「允许，并切换为〔模式〕」。从变更前确认进入时默认自主模式（guarded），可单独展开菜单选择完全访问（yolo）。菜单选择不放行；提交该行才授权，完全访问仍须风险二次确认。当前执行权限已是自主模式时只提供切到完全访问的动作，不显示菜单。旧 Agent 未声明新能力时保留原完全访问入口，不承诺新会话继承。图标与颜色与输入框共用。

第 3 项和其他选项使用同一行布局：序号一列，右侧依次为动作文案、模式菜单和“同一项目的新会话也会使用所选模式”说明；说明与其他选项说明同字号，宽度不够时换到下一行并与动作文案左对齐。整行只有一层选中/悬停背景，点击行内任意非菜单位置等同提交该行；模式菜单可单独打开，不提交。

只有审批框的模式授权动作批量切换当前任务 Runtime、该任务 Composer 和已接纳尚未执行的全部队列项（含 held/Guide）为用户提交的 `guarded` 或 `yolo`。各自 `planEnabled` 分别保留，其他配置、正文、附件、顺序和投递方式不变；既有 Plan 工具限制仍生效。普通 Composer 菜单仍只改草稿。当前轮继续执行，不创建新消息，不修改 Agent 项目 permission/mode 或 ruleset。发起端收到该命令实际完成所选模式授权的回执后，只更新当前项目 Composer Recent 的权限；同端同 Host、同项目新建的空白会话立即继承，无须再发送消息。取消、拒绝、迟到的应答和旧 Agent 没有授权证明时均不写。模型、Plan、已有会话和其他项目保持原行为；后续已接纳的显式提交仍可更新偏好。

```text
resolveInteraction(allowAndSwitchGuarded / fullAccess) → session FIFO → registry + broker claim（Hook 退赛）
 → 队列消费屏障，固定目标 ID → SQLite 原子 execution / session_input / receipt
 → Runtime 内存 → SessionModeChanged（mode + permissionGrant + 目标 IDs）
 → V4 config/queue 同次投影 → Composer 按 interactionId 消费一次
 → 当前 broker allow → 当前工具继续
```

- 项目归属查询只服务于新会话偏好。先登记并发送应答，项目查询与发送并行，Agent 不等查询便可放行。直接 ACK 和重连 query 共用结算入口；归属与实际授权回执都已确定才写 Recent。查询失败、或刷新前未取得归属时不猜项目。
- 同一请求已提交权限但未完成发布时，改选另一权限不会重新授权。Agent 返回标明原模式的原因码；界面固定该请求的重试目标并提示用户点击原模式重试，不自动提交。可见的批准动作与模式控件分别翻译，无障碍名称使用完整本地化句子。
- 新增可选的 `modeSwitch`：普通主任务为 `choose`，自主模式的危险命令为 `fullAccessOnly`。后者不投放旧 `fullAccessOption`，旧端仍只有普通单次选项；普通主任务保留旧入口兼容。切换必须使用独立 optionId 和实际授权回执，不能按普通 allow 处理。
- AskUserQuestion、ExitPlanMode、要求独立确认的 workflow 和 child-origin 审批不声明该能力；child 继续原审批，不能只切展示所在父 Runtime 就声称子任务已获完全访问。
- Agent registry 校验 session/interaction。事务开始前取消、Hook 已胜出、已拒绝或迟到应答不提权；同请求重复提交共享一次操作。claim 后失败保留审批，支持显式重试或拒绝。
- SQLite 事务同时保存当前 execution state、目标队列的权限和按 interactionId 去重的 receipt，不新增表。事务失败全部回滚；提交后的重试使用原固定目标，不包含后来提交。
- Guide 消费及 reserve/promote 与授权屏障协调；已有消费/提升中的操作先完成，审批可重试。事件发布失败时，后续模式修改/队列消费先恢复已提交事件；投影失败重试从原权威日志重建，保留后来事件顺序。工具仅在投影提交完成后放行。
- 每次完全访问尝试独立管理等待：提交/投影失败后解除本次屏障，已到达和后来到达的 legacy 应答或超时继续按原语义收口；没有应答时保留审批供显式重试/拒绝。重试必须建立新屏障，不能复用已兑现的失败通知提前放行。
- 冷恢复只将有效且属于当前 session 的 receipt 用作 Composer 授权标记；无效记录或未知扩展字段记诊断并跳过，清除旧内存标记，继续恢复任务。授权动作的幂等重试仍严格拒绝损坏 receipt，不按当前队列重新授权。
- Composer 在现有 workspaceIdentity/session 草稿内持久化已处理 grant ID；普通快照和队列编辑不能再次触发旧授权。队列编辑改为原位冻结（[Composer 编辑态](ui/composer-edit-mode.md)）：进入编辑态时把队列项已记录的 mode、Plan、模型与 reasoning 载入工具栏（旧项缺少的字段保留当前草稿），用户修改后由 `editQueueItem` 原地写回，退出编辑态时恢复原草稿配置。scope 切换不修改其他任务；新提交按自己的明确配置处理。
- 桌面 continuous 与手机 replayable 沿用各自投递/重连契约；进程重启恢复 execution state 与 grant 标记，队列仍沿用现有冷恢复丢弃规则。

实现及验收证据见 [Todo158](working-memory/provider-refactor/steps/todo-158-permission-dialog-full-access-and-queued-mode.md) 和 [覆盖矩阵](testing/conversation-session-e2e-coverage-matrix.md)。pending E2E 不自动视为人工准入或手机整链路通过。

## 命令预览完整性（2026-09-28）

- 权限卡片中的 Bash 命令默认自动换行、最多显示三行；按实际渲染溢出显示“展开命令”。
- 展开后保留完整命令，最多占十行高度，通过纵向滚动查看末尾；支持收起、键盘操作，窄屏长路径不得撑宽页面。
- 等待授权仅展示输入，不展示输出或“没有输出”占位。实际执行完成后的空输出提示保持原行为。
- 展开状态仅归命令预览组件所有；不改变权限响应、执行状态、desktop continuous 或 mobile replayable 链路。
- 浏览器回归覆盖桌面/手机宽度、深浅主题、长命令展开/收起、末尾可达、短命令无展开按钮和授权按钮仍可用。

验证记录：`permission-full-access.test.mjs` 共享 UI 浏览器 E2E 共 8 项通过（390/1200 宽度、深浅主题）；相关单测 14 项、`pnpm typecheck`、`pnpm lint`（0 error）和架构门禁通过。本次未运行 Electron 整链路或手机 relay 集成测试；浏览器 fixture 仍保留 pending 人工准入状态。

展开控件使用次级文字和 text-ui-sm 字号，中文为“展开命令 / 收起”，英文为“Show full command / Collapse”，右侧显示方向箭头。使用 link 按钮，移除水平 padding 和 border，始终保持透明，hover / focus-visible 以下划线反馈；按钮文字严格与命令正文左对齐，并保留默认按钮高度作为触控区域。

命令滚动视口延伸至卡片右侧内边缘 4px 处，正文通过视口内补齐 padding 保持原有缩进与可用宽度；收起按钮位于滚动视口外，不随命令滚动。

`$` 起始标记与命令正文放在同一滚动视口内，滚动离开首行后一起消失，回到顶部后重新出现；不得固定在命令中段旁。

键盘路径：存在长命令展开按钮时，默认第一项权限选项按 Shift+Tab 返回命令按钮，按钮按 Tab 回到第一项；展开后继续 Shift+Tab 可进入命令滚动视口。展开/滚动不得提交授权。短命令没有按钮时，既有选项循环保持不变。

## Group task scope

Feishu/Lark group tasks use `SessionInfo.permission.scope = "session"` before tool execution. The first trusted group input initializes an empty session ruleset; later inputs retain only that task's explicit approvals. Session-scoped tasks do not read or write project approval memory. Existing private/Desktop tasks without this marker retain project semantics. An explicit owner mode change remains session configuration; message text and model output never set the marker or grant permissions.

```
trusted group input → persisted session scope → tool permission check
                                             → session grants only
owner approval      → same pending request   → session grant update
```
