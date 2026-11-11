# Conversation Selection Side Chat

## Feature summary

桌面 Electron 与桌面 Web 的主会话时间线支持框选单行文字，并提供两个动作：

1. **注释**：在选区旁打开注释输入框，评论可选；保存后把“选区 + 评论”作为一条注释追加到主 composer，
   随下一条消息发给模型，并在正文原文处画编号标记。不写评论直接回车即只加原文，取代原“添加到当前任务”。
   见下文「选区注释」。当前 CLI 未声明评论能力时不提供“注释”，回退为 **添加到当前任务**（只加原文）。
2. **在辅助对话中提问**：优先把选区追加到当前激活的
   `selection_side_chat` child tab；当前未激活辅助对话时创建一个新的 hidden child，
   并在右侧 Side Pane 中继续多轮对话。

右侧 Side Pane 的空面板启动页和顶部 `+` 菜单同时提供 **辅助对话** 入口。入口与框选动作
共享主 `SessionPane` 的创建能力，但固定入口每次都创建并激活一个新的辅助对话 tab。
同一父 session 可以同时保留多个 child、composer 草稿和阻塞交互。

主 composer 的 `/` 面板额外提供 App 层命令 **`/side`** 及其等价别名 **`/btw`**（适配不同
用户习惯，面板中各自独立展示）。裸命令从面板选中时新建并激活一个空辅助对话 tab，同时把
输入中的命令 token 移除，不发送消息；直接提交 `/side <文字>` 或 `/btw <文字>` 时，命令后的
文字作为新 child 的首条普通消息立即发送。参数只支持文字：存在文件附件、代码评论、网页/PPTX
元素或划词引用时不消费为 App 命令，继续走主会话原有发送逻辑。两个命令由渲染层在 CLI slash
catalog 之外包装注入，不修改 CLI 命令目录；若 CLI 返回同名命令，以 CLI 为准隐藏并不消费 App
命令。草稿态（尚未创建 session）、辅助对话自身 composer、只读与手机 viewport 均不提供这两个命令。

手机端不注册框选入口；“更多详情”不属于本功能。副屏用于解释和轻量探索，允许正常工具、
文件修改与权限交互，但不提供 goal、edit/retry 或 fork。

## Esc 停止的焦点归属

主、辅对话同时可见不等于同时拥有键盘焦点。右侧面板打开时，Esc 只允许停止键盘事件所属的
`SessionPane`；以浏览器事件路径中的 pane DOM 为准，不以 tab 可见性或监听器注册顺序选择目标。
焦点留在已停止的对话时，再按 Esc 不停止另一对话；切换输入焦点后才改变目标。
右侧面板打开时，焦点在对话外不停止任何对话；面板关闭后，Esc 默认停止主区当前对话，
无需先点回输入框。分屏时只有主区现有 focused pane 获得该默认入口；隐藏的辅助对话不参与。
由 Shell 已有的面板开关与可见态下发默认入口，不新增焦点或面板状态。打开时立即撤销，
关闭且不再可见后启用；桌面与手机布局沿用同一规则。弹窗和已消费 Esc 的输入建议继续优先处理，
停止按钮仍按各自会话路由。

```text
Esc → 弹窗 / 已消费 → 无停止命令
    → 右侧面板打开 → 键盘事件所属 SessionPane → 自己的 session stop
    → 右侧面板关闭 → 主区 focused SessionPane → 自己的 session stop
                                      └─ idle → 无停止命令
```

SSC34：主会话先运行、辅助对话后运行，焦点在辅助输入框；Esc 只停止辅助对话，重复按键不影响主会话，切回主输入框才可停止主会话。
SSC35：辅助对话先运行、主会话后运行，焦点在主输入框；执行对称断言。
SSC36：主辅均运行，面板打开时在主区外按 Esc 不停止；收起面板后将焦点移到无浮层的页面空白处，
Esc 只停止主对话；重新展开面板确认辅助对话仍持续输出。组件回归覆盖桌面/手机布局的默认入口、
隐藏 workspace 门禁，以及开启默认入口后 dialog/defaultPrevented 仍优先。
这些场景均验证未停止一侧继续收到流式正文；使用本地 controlled-stream E2E，避免真实 provider 提前结束。
该焦点规则共享于桌面/Web renderer，不更改 session owner、停止协议或 continuous/replayable 传输。
手机无辅助对话入口；此次不扩展远程 transport、主题和 locale 的组合。

## Clarification log

| Boundary            | Decision                                                                                                                                                                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| child 基准          | 由父 session 最新稳定落盘边界派生；父 turn 正在生成时保留已提交 user input，排除未完成 assistant/tool 增量                                                                                                                                                                                                        |
| 框选历史行          | 只影响引用内容，不改变 child 的 fork 基准                                                                                                                                                                                                                                                                         |
| 生命周期            | 主任务推进、切换任务、长时间未使用均不自动过期；不实现 TTL/数量回收和过期卡                                                                                                                                                                                                                                       |
| 关闭                | 关闭 tab、关闭其他/全部、父任务删除/归档、窗口退出均关闭 live runtime 并移除 tab                                                                                                                                                                                                                                  |
| 重启                | 不恢复 tab、草稿或 parent-child UI 绑定；隐藏 child 历史可继续留在 SQLite                                                                                                                                                                                                                                         |
| 缺失 child          | `proto.sessionNotFound` 直接移除 tab；本次框选动作可重新创建一次，不显示失效页                                                                                                                                                                                                                                    |
| blocked             | 主 session composer 被 Permission/AskUserQuestion/ExitPlanMode 隐藏时不显示浮层；副屏 blocked 时仍允许“添加到当前任务”，副屏动作禁用                                                                                                                                                                              |
| 能力限制            | 副屏正常发送、compact、工具和权限交互；协议与 UI 同时禁止 goal、edit/retry、fork                                                                                                                                                                                                                                  |
| assistant 选区      | completed 与 streaming assistant 正文、Markdown 和代码均允许框选；动作发生时冻结选中文字，后续 delta 不改写引用                                                                                                                                                                                                   |
| 发送载荷            | 新发送使用 `# userselect:` / `userselect` 结构块，数组元素只保留 `{ text }`；来源字段仅用于发送前去重，旧完整结构块继续只读兼容                                                                                                                                                                                   |
| 固定入口            | 空面板启动页与顶部 `+` 菜单均提供“辅助对话”；每次点击新建 tab；主任务 running/blocked 时仍可用，无 active task 与手机端隐藏                                                                                                                                                                                       |
| `/side` `/btw` 命令 | App 层斜杠命令与等价别名，渲染层在 CLI catalog 之外注入，不改 CLI（CLI 同名时以 CLI 为准）；裸命令选中即新建空辅助 tab 并移除 token，带文字参数时提交 child 首条消息；附件/结构化上下文不消费；草稿态、辅助对话自身、只读、手机不提供；描述文案随 locale 中英文适配，搜索关键词同时匹配 `side`/`btw` 与“辅助对话” |
| 多开路由            | 同一父任务可同时打开多个辅助对话；划词追加到当前激活的辅助 tab，当前激活项不是辅助对话时新建并激活                                                                                                                                                                                                                |
| 历史可见性          | 父历史继续作为 provider context，但 child timeline、搜索、分页、轮次导航和可见 row count 均从空白开始                                                                                                                                                                                                             |
| Goal 父任务         | `active`、`paused`/`budget_limited`、`complete` 均允许创建；child 复制正文时移除 `anchor.goalBoundary`，不复制 session target、verifier entries、queue 或 active work                                                                                                                                             |
| 视觉密度            | 框选浮层使用约 32px 高、12px 字号、紧凑 padding、`rounded-lg` 与 `shadow-md`；用户文案统一为“辅助对话”                                                                                                                                                                                                            |
| fork 切换           | 父任务已有辅助对话时 fork 到 child，只隐藏父绑定 tab；child 展开 Side Pane 显示启动页，切回父任务恢复原 tab、child 与草稿                                                                                                                                                                                         |

## State and ownership

```text
主时间线合法选区
    |
    +-- 添加到当前任务 ----> 主 composer 引用 chip
    |
    +-- 副屏动作
           |
           v
查找当前 Side Pane activeTabId
           |
           +-- 当前父任务的 live 辅助 tab ---> 校验 child、激活 tab、追加去重引用
           |
           +-- 非辅助 tab / 无 active tab ---> 创建隐藏 child、打开新 tab、追加引用
           |
           +-- 同一创建手势仍 pending ------> 合并 pending promise，避免双击重复创建

Side Pane 启动页 / 顶部 + 菜单 / 主 composer `/side`、`/btw`
    |
    +-- 无 active task / 草稿态 / 手机 --> 不显示“辅助对话”入口，`/` 面板无 `/side`、`/btw`
    |
    +-- 有 active task（含 running/blocked）
           |
           +-- 裸命令点击 / 选中 --------> 创建隐藏 child、打开新 tab、聚焦空 composer
           |                             （移除输入中的命令 token）
           +-- 带文字参数提交 ----------> 创建并注册 child，首条文字在 child startNow 发送，打开新 tab
           |                             （父任务 queue/guide 不变）

主任务推进 / 切换任务 / 长时间未使用
    ---> 不改变 child 生命周期

关闭 tab / 父任务删除归档 / sessionNotFound / 应用退出
    ---> 关闭 live runtime ---> 移除 tab
```

| State / fact                       | Authority                            | Renderer state                                 | Persistence                    |
| ---------------------------------- | ------------------------------------ | ---------------------------------------------- | ------------------------------ |
| child conversation 与工具/权限状态 | CLI runtime/session store            | V4 projection                                  | SQLite hidden child            |
| 当前窗口 parent → children/active  | renderer Side Pane registry          | tab 按 child 唯一，`activeTabId` 决定划词目标  | 不持久化                       |
| composer 草稿与待发送引用          | 对应 composer                        | session/tab scoped state                       | 不持久化                       |
| 已发送引用 chip                    | CLI session user message             | `# userselect:` 文本数组                       | 随 user message 持久化         |
| workspace 隔离                     | session workspace ref                | `workspaceIdentity?.trim() \|\| workspacePath` | tab key 与 command route       |
| live 列表可见性                    | CLI sessions-index/task-index filter | task list cache                                | root query 排除 parented child |

## Start 同模型推荐

`/side <text>` / `/btw <text>` 创建并提交首条消息前，使用父 session snapshot 已生效的 provider/model/thought 判断同模型 Start 推荐；不读取父 Composer 尚未提交的模型草稿。缺少完整可验证的继承选择时，继续原有 Host 继承行为并跳过推荐。

确认切换将完整 `firstInput.modelSelection` 随唯一 `createSelectionSideSession` 命令传入，Host 用它创建 child 并启动首条输入；“不了”省略该字段，保持原继承；关闭弹窗不发命令、不创建 child，保留原输入。裸命令与空副屏入口不推荐。原 ACK admission、去重及 continuous/replayable 边界不变。

## Selection and reference contract

- 监听范围归属 `SessionPane/ConversationTimeline`，不依赖 input DOM，也不监听 Side Pane。
- 支持鼠标和键盘产生的单 row 选区。可选内容为用户/助手正文、代码、推理和工具结果。
  assistant 的 selectable region 必须落在真实 DOM 容器上，不能依赖不会透传 `data-*` 的 Markdown
  组件 props；completed 与 streaming assistant 均适用。
- streaming assistant 引用在用户点击动作时按当前 `Selection.toString()` 冻结，之后的模型 delta
  不回写已创建的 `ConversationSelectionReference`。
- 选区端点落在控件、菜单、状态标签或阻塞弹窗中时不产生入口；同一 selectable region 内从
  普通 Markdown 跨选到表格单元格时，DOM 顺序中夹着的 `select-none` 表格工具栏不算控件选区，
  仍产生入口。跨 row、纯空白和已经卸载的虚拟行不产生入口。
- 滚动、Esc、选区折叠、切任务和进入主会话阻塞态关闭浮层。
- `ConversationSelectionReference` 包含 `id`、`sourceSessionId`、`sourceRowId`、
  `contentType` 与原始 `text`。去重键包含全部来源字段和文本；不同 row 的相同文字不是重复。
- 单条最多 8,000 字符、每个 composer 最多 8 条、总计最多 16,000 字符。超限原子拒绝并
  显示本地化提示，不截断、不清除已有引用或草稿。
- 发送前的 composer reference 继续保留完整来源字段，用于精确去重、限制与待发送 hover；发送时只把
  `{ text }` 数组追加到 `# userselect:`、语言标签为 `userselect` 的结构块，避免把 session、row、content type
  和内部 id 暴露给模型。timeline 解析后仅显示正文与引用 chips，已发送 chip 的 hover 只展示已持久化
  的选中文字。
- 旧 `# Conversation selections:`、语言标签为 `zcode-conversation-selections` 的完整结构块继续只读解析，保证
  既有历史 chip 可见；新消息不再写旧格式，也不迁移已落盘消息。与 Web element context 同时存在时，
  先解析末尾 Web element block，再解析 selection block。

新发送格式：

````text
# userselect:
```userselect
[{"text":"云计算"}]
```
````

## 选区注释

用户读助手回答时，常需要针对其中某一句、某个表格单元格或某段代码提问。注释让用户在选区上直接写下
问题，模型同时收到被引原文与针对它的评论，不需要在输入框里手工复述上下文。注释复用上面的选区引用
合同，不另建一套附件或 prompt 格式。

2026-11-09 交互定稿（ZCode 3.0 群 11-06 话题）：原“批注”与“添加到当前任务”统一为 **注释**——
选区内容无论是否附带评论，都作为一条注释提交。

- **入口**：选区浮层动作为“注释”“在辅助对话中提问”。点“注释”后浮层换成输入卡片（编号、原文、多行评论、
  取消/添加注释），箭头指向选区；输入框抢走焦点会折叠浏览器选区，正文用同色底保留选区高亮，并在末尾以
  虚线编号预占下一个号。评论可选：留空直接回车 = 只加原文；Shift+Enter 换行，输入法组字中的 Enter 不保存；
  Esc、取消、点击浮层外、切会话、进入阻塞态或分享模式时丢弃未保存输入。Markdown 预览的选区浮层不提供注释，
  继续是“添加到当前任务”。
- **能力协商**：`conversationQuoteSchema` 与 `sendText` payload 都不是 strict，旧 CLI 会静默剥掉
  `comment` / `agent`，用户看得到评论而模型收不到。新 CLI 在 `runtime/capabilities` 声明
  `conversationQuoteComment: true`；Host 在启动屏障里记录声明者，renderer 经
  `zcodeAgentService.supportsConversationQuoteComment` 查询当前 workspace 的 CLI，未声明、查询失败、
  旧 Host 或远端未实现时不提供“注释”与编辑入口（不降级拼进正文），菜单回退为“添加到当前任务”。
- **超限**：注释已满 8 条或原文总长超限时，保存会被原子拒绝；浮层保持打开、保留输入，并在浮层内
  显示与 composer 相同的本地化上限提示。对已注释的同一段再次写评论属于更新，不受条数上限限制。
- **数据**：评论是 `ConversationSelectionReference` 上的可选 `comment`（≤2,000 字符），来源字段、去重键、
  条数与原文长度限制不变。对已注释的同一段（同来源同文本）再次写评论时更新原条目，不新增；不带评论的
  重复注释不覆盖已有评论。消息来源的注释另带仅渲染层使用的 `anchor`（行内第几个 selectable region +
  字符偏移），不进入发送载荷；同一句话在回答里出现多次时靠偏移指到用户真正框的那一处。
- **正文标记**：主时间线消息层上叠一层绝对定位覆盖层（不改 Markdown 渲染树），按 `anchor` 还原 Range
  画下划线与末尾编号气泡。编号 = 在 composer 注释列表里的位置，一条注释一个号。
  有评论 = 实心气泡 + 实线下划线；仅原文 = 空心气泡 + 虚线下划线；已发送 = 同形态换中性灰。
  行未挂载（虚拟滚动）、文字已变或锚点还原后文字对不上时不画，宁可少画也不画错位置；流式输出、
  虚拟行挂载、窗口尺寸变化合并到下一帧重算。已发送标记只保存在当前 renderer 内存，刷新后消失。
- **编辑**：点正文编号，或 composer 列表行的铅笔 / “添加评论”，卡片就地变编辑态，箭头仍指向正文编号，
  原文留在卡片顶部。评论留空 = 回到只保留原文，不会因清空评论删掉注释。底部“删除注释”整条移除，
  6 秒内可通过 toast 撤销并原位恢复，其余编号自动补位。列表入口找不到正文编号（行未挂载）时浮层指向列表行。
  同一会话分屏时只由聚焦的时间线响应编辑请求。
- **列表**：输入框 chip 统一显示“N 条注释”。详情标题为“下一条消息将携带 N 条注释 · 编号对应正文”；
  每行编号气泡与正文一致，原文最多两行（悬停看全文），评论加重显示在原文下方；行尾铅笔 = 编辑/添加评论，
  垃圾桶 = 删除（可撤销）。悬停列表行与正文气泡互相高亮。历史 user row 的 chip 同样显示“N 条注释”。
- **子 agent 来源**：选区落在 Agent/Task 工具行（展示子 agent 输出）时，引用带 `agent`（该行配对 subagent
  row 的 `subagentType`，缺失时取工具输入的 `subagent_type`）。
- **协议**：`conversationQuoteSchema` 可选 `comment`、`agent`，随 `sendText.conversationQuotes` 进入
  CLI，并随 user row 的 `conversationQuotes` 回放到历史。CLI `withConversationQuotes` 仍把引用数组原样
  JSON 放进 `<conversation_quote>`；只要有非空评论，就追加一句说明：带 `comment` 的条目是用户针对该段
  原文的问题或要求，`agent` 表示产出该段的子 agent。无评论时模型输入与原来逐字相同。本次交互调整不改协议。
- **rewind**：edit/retry/回滚删除来源行后，带评论的注释失去所指回答，主 composer 同步删除这些注释。
  判据只用权威 snapshot rows：rowId 在 session 内单调且不复用，已加载窗口（窗口内最小 rowId 及之后）
  里缺失的来源行即为被删除；窗口之前尚未分页加载的历史不判删除；整条活动分支被删（窗口为空且
  `firstRowId` 为 null）时删除该 session 的全部带评论注释。仅原文的注释是动作时冻结的文字，保持原行为不删。
  编辑态 composer 的引用属于 edit scope，不参与该判定，也不提供正文编辑入口。
- **未做**：已发送标记不持久化；子 agent 侧栏 tab 为只读会话，不提供选区浮层；手机端不注册选区入口。

| ID    | Setup / action                                                       | Expected evidence                                                                 | Status   |
| ----- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------- |
| SCM01 | 助手回答的表格单元格与正文段落分别框选，点“注释”，键盘输入评论后保存 | 输入过程中浮层不关闭；composer chip 为“2 条注释”，正文 ①② 实心编号                | accepted |
| SCM02 | 两条注释分别挂在第一、二轮回答上，编辑第二轮用户问题触发 rewind      | 第二轮回答行被删除后其注释同步移除，其余编号补位                                  | accepted |
| SCM03 | 保留的注释随下一条消息发送                                           | 模型请求最后一条 user 消息含原文、评论与说明，不含已删除注释；发送后标记变灰      | accepted |
| SCM04 | 框选正文点“注释”，不写评论直接回车                                   | 菜单无“添加到当前任务”；虚线编号预占；保存后空心编号，列表行有“添加评论”          | proposed |
| SCM05 | 点正文里仅原文注释的编号，补写评论并保存                             | 编辑浮层指向该编号；空心变实心，列表同步显示评论                                  | proposed |
| SCM06 | 编辑浮层点“删除注释”，6 秒内点“撤销”                                 | 删除后编号补位、计数减一；撤销后原位恢复                                          | proposed |

剪枝：代码块选区与表格/正文共用同一 selectable region 判定（SSC17/SSC24），不单独叉乘；注释与“在辅助
对话中提问”组合、远程 identity、theme/locale 不做 E2E 叉乘，视觉以桌面深浅主题截图代表；列表铅笔入口与
正文编号入口共用同一编辑浮层，E2E 只走正文编号入口。

## Protocol and runtime contract

- V4 新增非 CAS 命令 `createSelectionSideSession`。父 session 由 command envelope 的
  `sessionId` 指定，payload 为 `{}` 或 `{ firstInput: { text } }`；带 `firstInput` 时由 child
  复用首发 `sendText` admission/startNow 路径。ACK result 为
  `{ type: "createSelectionSideSession", sessionId, input? }`，同一 commandId 重试不得重复创建或发送。
- 服务端从父 record 派生完整 workspace ref、remote identity、model、thought、mode、
  followup mode 与权限规则；UI 不传 workspace identity 拼装字段。
- child task type 为 `selection_side_chat`，带 `parentSessionId`。不复制 goal、queue、后台任务、
  continuation inbox 或 pending interaction。
- 复制的父历史逐条标记 `model-only`、`uiVisibility=hidden`、`providerVisibility=visible`；live 和
  cold hydration 必须使用同一 projection policy。隐藏历史不进入 child 可见 rows、total count、
  load-older、conversation find 或 turn navigator。
- copied history 之后写入 model-only boundary：继承历史只作参考，不继续父任务；仅处理副屏中新
  问题；修改工作区必须由用户在副屏明确请求。
- boundary 作为 persisted `selection_side_chat` reminder 注册，channel 为 `history_continuity`、
  lifecycle 为 `resume_history`。原子 fork bundle 中保存 raw text 和 source-aware part metadata；
  child 首次挂载和后续恢复均 hydrate 成 Runtime Attachment。该 source 明确跳过 MCS，始终由
  共享投影器在 child 新问题之前输出 user `<system-reminder>`，对齐 `/btw` 的提醒位置；
  其他 source 的 MCS 投影保持原有规则。
  不在落盘正文预包标签，不每轮追加重复提醒，不迁移旧的缺少 part metadata 的 side chat。
- `sendGoalCommand`、`resumeGoal`、`editUserQuery`、`retryTurn`、`forkAssistant` 对该 kind
  返回 `guard.selectionSideChatRestrictedCommand`。
- live sessions-index、task-index、项目/对话/分组/置顶/归档列表过滤该 kind；直接订阅 child
  conversation topic 仍正常工作。

## 首轮 reminder E2E 回归（SSC33）

正式用例 `conversation-session-side-chat-reminder.test.ts` 在同一次 default replay 中运行
MCS/non-MCS 两个独立场景。父会话完成一次只读工具调用后，通过裸 `/btw` 打开空 child，
等待 child 输入框可编辑后，发送一条要求固定回复的普通问题，并等待该回复完成。

- non-MCS 使用默认 `deepseek-v4-flash` 与本地 replay endpoint。
- MCS 通过设置页添加并选择 `claude-opus-4-8`，触发生产模型能力判定；请求仍交给本地 replay。
- 两个场景均断言：fork boundary 的 source-aware part metadata 保留；继承历史不显示在 child
  timeline，但进入 provider context；提醒正文恰好出现一次，以 user `<system-reminder>` 位于
  新问题前；父会话消息不被 child 输入改写。
- 独立检查请求中其他 `role: system` 消息：MCS 场景存在，non-MCS 场景不存在，避免把整体
  关闭 MCS 误判为 side-chat source 正确排除。响应由 case-local synthetic fixture 固定，
  不将响应内容作为模型身份感知证据。core 单测另从实际 fork bundle JSON 往返验证恢复。

```text
fork: inherited history -> selection_side_chat Attachment -> child question
wire (MCS / non-MCS): user [<system-reminder>boundary</system-reminder>, question]
```

```bash
pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/conversation-session/branching/conversation-session-side-chat-reminder.test.ts'
```

正式回归仅保留 UI、持久化和 provider 请求断言；运行报告与网络证据由共享 E2E runner
统一采集，不在用例中额外写全量 session dump、复制 model-io 或保存重复截图。

## Side Pane and lifecycle

- 每个窗口、每个 `(workspaceKey, parentSessionId)` 可以同时存在多个 live child；不要求跨窗口同步
  tab 列表或 active 目标。
- stable tab key 使用 `workspaceKey + parentSessionId + childSessionId`。固定入口每次完成点击都创建
  新 child；同一点击在命令 pending 期间合并，失败不留下空 tab。
- 同父辅助 tab 以本地化“辅助对话 N”命名；`N` 从当前父任务已使用的正整数中取最小可用值，
  关闭后允许复用编号，tab identity 始终以 childSessionId 为准。
- 新引用保留目标 child 的问题草稿；完全重复只激活目标 tab，不新增 chip。兄弟 child 的草稿、
  引用和 blocked 状态不受影响。
- Side Pane 收起或显示其他 tab 时，展开并激活目标 tab，保留其他 tab。
- 空面板启动页与顶部 `+` 菜单共享同一个“辅助对话”item resolver；入口只在 desktop
  Electron/desktop Web 且存在 active parent session 时出现。
- 固定入口不受父 session running、Permission、AskUserQuestion 或 ExitPlanMode 阻塞影响；它不追加
  引用，并始终新建空 child。已有 child（包括自身 blocked）继续保留，用户可通过 tab 切换处理。
- 切换主任务只隐藏不关闭；切回父任务恢复原 live session、草稿和引用。
- Side Pane 是否显示 tab strip 必须以当前任务过滤后的可见 tab 集为准。workspace registry 即使仍保存
  其他任务的隐藏 tab，当前任务可见集合为空时也显示“打开标签页”启动页，不能渲染空 tab shell。
- 所有关闭路径调用 child `deleteSession`/close lifecycle；不进入最近关闭。
- 不存在用户可见的 expired 状态；临时网络断连沿用既有重连 UI，不创建替代 runtime。

## Remote and delivery boundaries

```text
desktop renderer / desktop Web
        |
        v
parent session attached host --createSelectionSideSession--> child runtime
        ^
        |
relay / desktop main 仅鉴权、attachment 调度与 rpc-frame 透传
```

- 本地与 SSH/WSL/Docker 都沿父 session 的 shared-host attachment 创建 child。
- 远程链路贯穿 `workspaceIdentity` 与 `remoteSessionId`，禁止按 `workspacePath` 单独匹配。
- desktop `desktop-continuous` 保持 direct continuous；Web remote
  `web-remote-replayable` 保持 snapshot/gap/owner/lease 恢复边界。
- 手机 viewport 不显示入口，也不会为本功能启动独立 runtime。

## Accepted cases and pruning

| ID    | Setup / action                                                      | Expected evidence                                                                                               | Status                                                                                            |
| ----- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------- |
| SSC01 | 普通单行文字首次框选并打开副屏                                      | 新 hidden child + active tab + pending chip，不自动发送                                                         | accepted                                                                                          |
| SSC02 | 当前激活辅助 tab 已输入问题后再次框选                               | 复用 active child，保留草稿并追加引用                                                                           | accepted                                                                                          |
| SSC03 | 重复框选完全相同来源与文本                                          | 激活原 tab，无重复 chip                                                                                         | accepted                                                                                          |
| SSC04 | 主会话普通生成中框选                                                | 允许创建；复制稳定输入边界，排除流式输出，发送沿 queue/guide                                                    | accepted                                                                                          |
| SSC05 | 主会话 Permission/AskUser/ExitPlanMode                              | 整个框选浮层不显示，解除后恢复                                                                                  | accepted                                                                                          |
| SSC06 | 副屏自身 blocked                                                    | 主任务动作可用；副屏动作禁用，处理后恢复                                                                        | accepted                                                                                          |
| SSC07 | child sessionNotFound                                               | 无过期页；移除旧 tab，本次动作创建新 child                                                                      | accepted                                                                                          |
| SSC08 | 手动关闭/关闭其他/全部                                              | runtime 关闭、tab 移除、不进最近关闭                                                                            | accepted                                                                                          |
| SSC09 | 应用重启                                                            | 不恢复 tab；再次框选创建新 child                                                                                | accepted                                                                                          |
| SSC10 | 切换主任务再切回                                                    | 按父任务隐藏/恢复，不串 session、workspace 或草稿                                                               | accepted                                                                                          |
| SSC11 | 跨行、超限、控件文字、手机端                                        | 不创建 session；超限给出本地化提示                                                                              | accepted                                                                                          |
| SSC12 | 远程同路径不同 identity                                             | 精确绑定 shared host，不串远端、不启动独立 runtime                                                              | accepted                                                                                          |
| SSC13 | 副屏多轮工具与权限请求                                              | 正常执行并阻塞交互，但不进入任务列表                                                                            | accepted                                                                                          |
| SSC14 | 添加到当前任务并连续框选                                            | 主 composer 保留草稿、累加 chips；新块只持久化 `{ text }`，旧块可读                                             | accepted                                                                                          |
| SSC15 | 主任务进入后续真实用户轮次                                          | 原副屏仍可继续输入，不自动过期或重建                                                                            | accepted                                                                                          |
| SSC16 | 副屏尝试 goal/edit/retry/fork                                       | UI 无入口，协议直接调用被统一 guard 拒绝                                                                        | accepted                                                                                          |
| SSC17 | completed/streaming assistant 正文框选                              | 两个动作均出现；引用冻结为动作时文本，contentType=assistant                                                     | accepted                                                                                          |
| SSC18 | 启动页或顶部 `+` 点击“辅助对话”                                     | 两处入口语义一致；每次创建并激活新的空 composer                                                                 | accepted                                                                                          |
| SSC19 | child 继承父历史后首次打开或冷恢复                                  | provider 保留历史；所有 UI timeline/search/page/count 均为空                                                    | accepted                                                                                          |
| SSC20 | 父任务 running/blocked 时点击固定入口                               | 入口仍可用；无 active task 与手机端不出现                                                                       | accepted                                                                                          |
| SSC21 | 框选浮层显示中英文动作                                              | 约 32px 高、12px 字号；中文统一“辅助对话”术语                                                                   | accepted                                                                                          |
| SSC22 | 父任务有辅助对话后 fork 到 child                                    | child 展开侧栏显示启动页；切回父任务恢复同一 tab/child/草稿                                                     | accepted                                                                                          |
| SSC23 | Goal 父任务为 active、paused 或 complete                            | 三类状态均创建 child；保留 provider 正文，不继承 Goal 运行态或 identity                                         | accepted                                                                                          |
| SSC24 | 同一 assistant row 内从普通 Markdown 跨选到带操作工具栏的表格单元格 | 浮层正常出现；夹在 Range DOM 中的 `select-none` 工具栏按钮不把选区误判为控件选区                                | accepted                                                                                          |
| SSC25 | 同一父任务连续点击固定辅助对话入口                                  | 创建两个不同 childSessionId 的 tab，标题按辅助对话 1/2 展示                                                     | accepted                                                                                          |
| SSC26 | 同一父任务有多个辅助 tab，激活其中一个后主时间线划词                | 引用只进入 active child，保留其草稿；兄弟 tab 不新增引用                                                        | accepted                                                                                          |
| SSC27 | 同一父任务存在辅助 tab，但当前激活浏览器/代码等非辅助 tab           | 主时间线划词创建新的辅助 child 并激活，不猜测最近使用 tab                                                       | accepted                                                                                          |
| SSC28 | 主 composer 输入裸 `/side` 或 `/btw` 并从 `/` 面板选中              | 两个命令独立展示且行为等价：新建并激活空辅助 tab；输入中的命令 token 被移除，不发送消息；命令不写入 CLI catalog | accepted                                                                                          |
| SSC29 | 草稿态（未创建 session）或辅助对话自身 composer 打开 `/` 面板       | 面板不包含 `/side`、`/btw`；CLI 返回的命令列表不受影响                                                          | accepted                                                                                          |
| SSC30 | desktop 主会话 idle，主 composer 输入 `/side 你好` 或 `/btw 你好`   | 直接提交文字参数                                                                                                | 创建并激活新的 child；child 首条 user input 为 `你好` 并立即发送；父 timeline 不出现 `/side 你好` | accepted |
| SSC31 | desktop 主会话 running（可有既有 active turn/queue）                | 提交 `/btw 继续查一下`                                                                                          | child 首条消息 startNow；父 active turn 继续，父 queue/guide 与 workspace 不变                    | accepted |
| SSC32 | 主 composer 带附件、代码评论、网页/PPTX 元素或划词引用              | 提交 `/side 你好`                                                                                               | 不消费 App 命令，不创建 child；沿主会话原有输入路径发送                                           | accepted |

剪枝：手机只验证入口缺失，不把 selection UI 与 replayable 物理恢复做笛卡尔积；theme/locale 通过
组件和视觉代表覆盖；普通生成、queue/guide 只验证既有路由未回归；tool family 用代表性只读工具、
文件写工具和一次 permission 覆盖，不枚举所有工具；相同 path 远程只与 identity/attachment 组合，
不扩散到 relay 业务状态。SSC22 已于 2026-07-16 确认只保留 desktop continuous 的辅助对话代表
路径；其他 session-scoped tab 类型、remote/mobile、theme/locale 不重复叉乘。SSC23 只枚举
active（无 verifier）、paused（failed verifier）和 complete（passed verifier）；`budget_limited`
与 paused 同属“未完成 Goal snapshot”等价类，不再与客户端、provider 或主题做笛卡尔积。
SSC24 只保留同一 assistant row 的“普通 Markdown → 表格单元格”代表路径；反向拖选共享浏览器
规范化后的同一 Range，streaming、theme、locale、remote/mobile 不重复叉乘。SSC25/26/27 只覆盖
desktop continuous、本地 workspace 与两个辅助 tab；remote identity 继续由 SSC12 覆盖，不与多开数量、
blocked 类型、theme/locale 做笛卡尔积。SSC28/29 只验证 App 层注入、选中即开与草稿态/副屏门禁；
`/side` 与多开数量、locale 的组合由 i18n 关键词单测覆盖，不做 E2E 叉乘。SSC30/31 只保留
文字参数、desktop continuous、本地 workspace 的 idle/running 两个代表状态；SSC32 由 focused
composer/parser tests 覆盖，不与每类结构化上下文做笛卡尔积。

## E2E handoff

- SSC01/02/05/07/08/09/13/14/15/17/18/20/22/25/26/27/28/29/30/31 先进入 conversation-session
  `manual-review/pending`，使用稳定 `E2E_SSC_*` marker。
- SSC03/04/06/10/11/12/16/19/21/23/24/32 以组件、协议、service/core focused tests 为主；SSC22 另用
  Side Pane 可见性 focused test 覆盖共享渲染分支；SSC28/29/30/31 的建议构建、参数解析与命令幂等细节另由单测/协议测试覆盖。
- provider fixture 使用 case-local `fast-text`；SSC13 permission 使用已有交互 fixture，SSC07 使用
  确定性的 sessionNotFound 注入，不以 sleep 模拟。
- 人工确认后再执行 promote、fixture check、默认 replay 与 Docker admission。

## SQLite 批量创建

辅助对话继续持有独立的 message/part 副本，删除、恢复、模型上下文和隐藏历史的语义不变。
创建通过 `SessionStorePort.commitForkFromSource` 在同一写事务内读取父 session 与历史元数据，
同步调用 core 的既有 active-branch、稳定边界和 child-local ID 改写，再提交完整 fork bundle。
回调不得返回 Promise、执行外部 IO 或修改 source；事务中不让出执行权，避免父历史在选择和复制之间变化。

```text
BEGIN IMMEDIATE → 父 session + 历史元数据 → core 同步选择/改写
                → INSERT SELECT 复制正文 → child 配置/命令事实 → COMMIT → runtime 注册
```

正文、推理、工具 input/output、文件 data URL 和附件 payload 留在 SQLite；core 只接收用于
选择与改写的投影。旧 system_reminder 的模型选择仍可能按通知文字判断，该类文字保留供原选择器使用，
不以截断前缀猜测语义。存储层比较投影与改写结果，只把实际变化的 JSON 路径应用到原记录；
未改字段（包括未知字段、显式 null、旧版兼容字段）原样保留。按路径形状分组后分批执行
`INSERT SELECT`，显式分配 child sequence，不逐条准备 SQL、回查正文或 touch session。
复制计划作为 JOIN 外层，源记录按主键查找，避免每批重新扫描整个父历史；长 ID 数组整体改写，
嵌套附件逐字段改写并分段限制 JSON 函数参数数量。创建后的 runtime 恢复沿用既有读取路径。

保持 child/message/part/配置/命令去重事实同事务提交，复制失败、来源不符或 ID 冲突全部回滚。
同 commandId 仍返回已提交 child，不制造第二份。父会话及兄弟 child 不可被覆盖。
不新增持久化表或迁移，不使用共享历史引用，不改变 UI、Host owner 与 continuous/replayable 协议。

验收：CLI 回归覆盖真实 SQLite 的大正文保持、嵌套引用改写、未知/null/兼容字段、稳定分支、
父 turn 正在生成、Goal 排除、重复命令、跨会话来源拒绝、故障注入和冷重开；既有辅助对话
E2E 验证空 timeline、独立 composer 与续发。压测同时报告核心复制和创建/订阅链路，不将延迟转移隐藏为收益。

2026-11-04 本地 macOS 默认 replay：既有 `conversation-session-selection-side-chat.test.ts` 完整通过。
用例显式固定 `zh-CN` 后校验中文 tab 标题。证据保存在
`packages/desktop/.e2e-artifacts/desktop-e2e-20261104114322431-p31920-acbcdd89ba461c1a`；未验证其它 OS 实机。
