# Tool Display Rendering

> **当前状态**：V4 row 通过适配层复用统一的 ToolCall renderer；本文描述当前渲染边界。

## 目标

统一聊天区 tool 的展示入口，避免在 conversation row 里按 `kind` 堆分支，同时给后续 `execute`、`search`、`fetch` 等 tool 的专用渲染留扩展口。

## 当前结构

- `packages/ui/src/lib/toolDisplay.ts`
  - 负责把 `ChatToolCall` 归一成 `ToolDisplayModel`
  - 输出 `inlinePreview`、`viewerSource`、`showInput`、`showOutput`、`showKind`
- `packages/ui/src/lib/codeViewer.ts`
  - 负责提取 `text / patch / file / image` 预览数据
  - 不直接决定最终 UI，只提供预览能力
- `packages/ui/src/v4/ConversationRowView.tsx` 与 `packages/ui/src/v4/toolCallRowAdapter.ts`
  - 把 V4 `ToolCallRow` 适配成统一 renderer 所需的输入，不在 row 组件内复制各类 tool UI
- `packages/ui/src/ToolCallBlocks.tsx`
  - 负责 renderer 注册和选择；`packages/ui/src/ToolCallBlocks/renderers/` 承载 kind/family 专用展示
- `packages/ui/src/ToolCallBlocks/ToolCallBody.tsx`
  - 负责通用参数、结果、文件和 Markdown 预览

## 工具展示层级

- 当前连续摘要按“跨类型连续摘要分组”规则展示；组内保留真实 row 顺序、状态与展开记忆。
- Workflow、Subagent 与正文作为分组边界；外层 Working / Worked 历史收纳独立保留。
- 旧同类工具聚合与对应设置已移除，不影响当前跨类型摘要组。

## 会话流可见性

- `DeferredToolCall` 在 `inputStreaming` 阶段尚未确认目标工具，不渲染临时卡片或空白占位，也不从半截包装参数推测目标。完整调用经 Core 确认后，同一行按目标名称复用原 renderer 和显示设置；关闭“显示待办”时，包装的待办工具（2026-11-05 起为 deferred 的 TodoRead；TodoWrite 已常驻，不再经包装调用）从传参到完成均不展示卡片。
- 此过滤只隐藏包装调用的参数生成阶段；直接工具的流式预览、目标工具执行进度以及包装调用的失败/停止展示保持原行为。会话运行态和 Stop 入口仍读取原始投影。
- `EnterPlanMode` 是会话模式切换的内部边界，不向用户提供可操作详情；主会话流在 `inputStreaming` / `running` / 终态下都不渲染它的 tool row。
- 可见性过滤只作用于 UI render unit：协议投影仍保留原始 `ToolCallRow`，运行态、冷恢复、模式切换和诊断轨迹不得因隐藏展示而丢失。
- 过滤在桌面 `desktop-continuous` 和手机 `web-remote-replayable` 共用的渲染单元上执行，不改写两类 delivery 的快照、gap 恢复或消息顺序。

## 收起详情的测量边界

侧栏开关会改变会话宽度，虚拟列表可能重新挂载历史轮次。收起的工具详情仍保留 Radix 的 DOM、ARIA 和动画生命周期，但完全隐藏的节点不应写入测量样式或读取几何尺寸；可见、正在收起及 `forceMount` 内容继续按原流程测量。不得以移除首次展开动画、减少历史内容或改变展开记忆来换取性能。

```text
侧栏宽度变化 → timeline 测高与虚拟窗口更新 → 历史工具挂载
  完全隐藏 → 保留折叠状态，跳过无效测量
  展开 / 收起动画中 / forceMount → 原尺寸测量与 Presence 生命周期
```

影响层为 presentation，修正在 `@radix-ui/react-collapsible` 的尺寸测量边界；ESM 与 CommonJS 同步。工具、消息历史、项目分组和 Accordion 共用该依赖，需检查初始闭合、默认展开、鼠标/键盘切换、嵌套、快速反向切换和 `forceMount`。`ToolLayout` 仍持有工具展开记忆，Radix 持有动画 presence，`ConversationTimeline` 仍是滚动 owner。手机 Web 共用展示组件，协议、权限、工具执行和 continuous/replayable 传输不变，因此不扩展这些不受影响的组合。

SPT05 验收以真实 DOM 几何调用和动画事件为证据：批量收起工具初次/再次挂载时隐藏节点的测量为零；展开与收起动画、详情内容、键盘和展开记忆保持；默认展开及 `forceMount` 的高度变量仍有效。桌面/手机、深浅主题与中英文共同验证。耗时记录用于前后比较，不使用机器相关绝对时长作为通过标准。时间线 resize 的跟随、离底及会话位置沿用 SRM10 回归。

## 扩展方式

- 新增 kind 专用优化时，优先在 `toolDisplay.ts` 里增加 strategy
- strategy 只做“展示决策增强”，不要重写主渲染骨架
- 文件型 tool 优先复用 `codeViewer.ts` 的预览提取结果
- 多媒体资源如果是图片，优先走 `image` preview；其他二进制继续走兜底提示

## 通用兜底详情

- 兜底工具展开为单张浅底、细边框、12px 内边距的卡片，沿用 CUA 详情的视觉层级。摘要与分组规则不变。
- 卡片按“参数 → 结果／错误”排列，分区之间使用细分隔线；标题与复制按钮同一行。不得追加完整 tool call JSON 或重复 kind。
- 遵守 display model 的参数展示决策；参数未提供时省略，空对象显示“无参数”。仅含原始值的对象使用两列键值布局，保留字段原名；嵌套对象和数组使用格式化 JSON。
- 普通结果文本直接展示；对象和数组使用格式化 JSON，不再嵌套背景卡片。保留 0、false、null 和空字符串这些已返回的值。每个内容区最大高度 240px，超出可滚动，长字段可换行且不得撑宽手机页面。
- 错误优先于普通结果，不重复输出成功内容；缺少错误详情时使用工具状态文案。运行／等待且尚无结果时显示“等待结果”；终态无结果显示“暂无结果”，不推断成功。
- 图片、文件／Markdown、计划预览和子工具继续使用原展示能力；快照字段加载入口保留。复制只复制对应区原始内容；没有内容时不显示复制按钮，复制失败应有反馈。
- 状态直接读取现有 tool call，不新增业务状态或计时器：`pending/running + 无结果 → 等待结果；收到结果 → 展示结果；failed/error → 展示错误`。桌面与手机共用 renderer，不改变协议与传输。
- 浏览器验收：中英文、390px／1200px、深浅主题；空／简单／复杂参数、文本／JSON／长结果、失败、运行到完成、复制与收起再展开。候选脚本为 `packages/ui/test/browser/manual-review/pending/fallback-details.test.mjs`，不代表真实手机网络恢复验收。

## 会话协作工具展示

- `ToolCallBlocks/session/session.tsx` 按精确 `toolName ?? kind` 匹配 ListSessions、ReadSession、SendToSession、WaitSessions，不影响其他工具 identity；这四类调用进入现有连续摘要分组。
- 四类摘要统一 BookOpenText 16px 图标：动作名称、目标／数量、必要状态、展开箭头；沿用 ToolLayout 的单行截断、tooltip、组内图标隐藏和组外 16px 间距。
- ListSessions 展示返回会话数量、标题与状态列表；nextCursor 仅提示还有结果，不新增翻页请求；searchScope 中不可用来源或空 scopes 明确提示搜索范围不完整，不能把空数组说成全局没有会话。
- ReadSession 的 summary view 展示标题与会话状态；messages view 展示角色和 text，保留分页提示。没有标题时用返回 session 或 input.sessionId 的短 ID，完整 ID 放 tooltip，不跨会话缓存标题。
- SendToSession 展示目标与 input.prompt、admission/delivery 和 reason。accepted+queued 为已排队，accepted+start_now 为已接收；rejected 为已拒绝，unknown 为结果未知，不把调用 completed 等同于消息已处理。
- WaitSessions 展示每个 operation 的目标、状态、reason 与 attention.message；整体 timed_out、cancelled、unknown 分别为等待超时、等待已取消、结果未知，completed 只表示等待结束。保留同一会话的多个 operation，不合并状态；摘要数量按会话去重。
- tool failed/denied/stopped 优先于结果；pending/running 使用现有生命周期。未知结构仅展示可验证字段；真正缺失结果才显示暂无结果，不回退整包 JSON。非 JSON 文本（包括超出 32 KiB 后的已保存提示、保存失败后的截断文本）必须在结果分区按原文显示并可复制，保留路径、预览和截断说明；终态摘要标为文本结果，不从输入 operation 推断仍在等待。不自动读取提示中的文件路径；完整快照仍经已有注入回调加载。支持结构化 output 与 JSON 字符串；仅 output 缺失时读 rawOutput，不越过已有输出选用过期数据。snapshot 加载入口保留。
- 详情复用单卡片、分隔线、分区复制与最大 240px 滚动区。仅复制用户可见内容；结构化结果不额外展示 workspacePath、commandId、requestId 或内部路由字段；消息原文和上游已保存／截断文本保持原文。
- 数据链：`现有 tool call（desktop 连续流／mobile 快照恢复）→ 纯展示投影 → 同一摘要与详情`。不增加服务查询、业务状态缓存或计时器。
- 浏览器候选验收涵盖中英文、390px/1200px、深浅主题、四类真实注册入口、状态更新、失败/拒绝/停止/超时、结构化与 JSON 输出、旧记录缺字段、分页/搜索范围、复制、长内容滚动及展开保持。真实桌面使用 CDP 检查已加载组件；不代表完整 Agent 或远控传输验收。

## Bash 调用描述

Bash 执行摘要优先显示非空 `input.description`，使用普通正文样式；缺失、空白或非字符串时显示实际命令。独立工具、组内子项与进行中组头复用同一摘要。分组切换到统计时保留原计数。Bash 展开详情后，摘要中的非空 description 继续显示，收起后也保持；无描述时沿用命令摘要展开隐藏规则。展开详情和权限预览仍展示实际命令与输出，不用描述替换执行内容。

## 专用 Tool Renderer

- `ToolSearch` 按精确工具名使用搜索摘要卡，复用 WebSearch 的图标、运行状态和失败提示。卡片始终不可展开，不渲染参数、搜索结果、schema 或原始数据。
- 摘要使用输入 `query`：`select:Read,TodoWrite` 展示为“搜索工具：Read, TodoWrite”，关键词查询保留原文；输入尚未到达或为空时只显示“搜索工具”。中英文共用同一渲染路径，长查询沿用搜索卡的单行省略。
- 该分流仅属于 UI，不把 ToolSearch 加入通用 search family 或 Explore 聚合，不改变工具结果、模型请求及持久化。桌面实时与冷恢复、手机 Web 共用该 renderer。
- `Node REPL` / Browser Use 工具的展开布局保持透明，并与工具摘要正文保持同一水平基线；不得在 `ToolLayout` 的详情间距之外再次叠加整块横向 padding。文本结果内容块和“查看执行细节”展开后的代码/错误栈分别使用 `bg-card border border-border rounded-xl`；图片、“查看执行细节”按钮和折叠布局本身留在卡片外。单行、非 JSON、长度不超过 160 字符的短结果使用普通次级正文展示；JSON、多行或更长的日志继续使用带复制/换行操作的 CodeBlock。图片结果在消息流展开区始终使用单列，避免窄桌面栏和手机 Web 中被响应式断点切成过窄的双列缩略图；大图查看器行为保持不变。
- `CUA` 工具的展开区只展示面向用户的动作、结果、失败原因、建议、截图、权限、环境、列表和应用状态，不提供完整 tool call JSON 的“查看原始数据”入口。原始 input、output、display 和生命周期元数据仍按既有协议与持久化链路保留，只是不进入桌面端与手机 Web 共用的 CUA 展开界面；其他工具 renderer 的原始数据能力不受影响。
- `ReadSessionContext` 工具已于 2026-11-03 删除。旧会话中已有的调用继续通过 `ReadSessionContextToolCallBlock` 渲染，不走 fallback 的 `Parameters` / `Result` JSON 块；共享工具身份表保留该名字。
- 摘要行展示本次上下文读取的 `query`，并把 `sessionId` 作为次级标识。
- 展开区只展示 `query` 和返回的上下文内容；若 output 是结构化对象，优先读取 `output.content`，再回退到文本型 output 或 `rawOutput`。
- 新工具 `ReadTopicResource` 没有专用 renderer，使用通用工具卡片。
- `SendMessage` 归入 `message` family，并通过 `SendMessageToolCallBlock` 渲染。收起态按“已发送/正在发送 + input `summary`（缺省时用 `message` 的第一个非空行） + 给/to + 目标 agent `to`”组成一句完整摘要；展开态只展示目标智能体、摘要和消息正文，不展示投递状态、message/agent/task id、输出路径、result 或整段 tool call JSON。目标、摘要和消息都尚未到达时必须禁用展开，禁止在 streaming input 或字段未加载的 snapshot 上出现空详情面板。
- `SendMessage` 的主展示数据使用 Core 在 model content 格式化之外生成的 `local_agent_message` display payload（hook additional context 是单独的附件，不进 tool result）。payload 只保留 `status`、失败 `error` 和结果 `message`，不得携带或展示 delivery、message/agent/task id、输出路径；`error` 与 `message` 必须分别受 4 KiB UTF-8 预算约束，超出时保留完整 code point 并追加 `...[truncated]` 标记，避免 display 绕过 tool result budget 放大实时事件和持久化快照。lowercase `send_message` 是另一条 session mailbox 语义，不得复用 `SendMessage` identity、display 或 renderer。
- `SendMessage` 的 display 若返回 `status: "failed"`，即使外层 tool call 已 completed，也按业务失败展示“消息发送失败”和 failure status；真实 tool failure 同样不得继续显示“已发送”。结构化 output、JSON 字符串、纯文本 model content 和 `rawOutput` / `result.content` 只作为旧快照/provider 兼容 fallback，禁止通过错误文案推断成功或失败。
- `SendMessage` 的收起态必须显式覆盖完整终态：`completed` 显示“已发送”，`failed` 或 display 业务失败显示“消息发送失败”，`denied` 显示“发送已拒绝”，`stopped` 显示“发送已停止”；不得把非成功终态落入成功文案。
- `TaskStop` 归入 `task-control` family，并通过 `TaskStopToolCallBlock` 渲染。收起态只使用停止中/已停止的动作文案和 `task_id`（输入阶段兼容 deprecated `shell_id`），不得展示 `task_type`；展开态的摘要行继续保留 task id，详情区只展示 task type、任务描述或命令，以及结果消息，不重复 task id，也不展示整段 tool call JSON。
- `TaskStop` 的主展示数据使用 Core 生成的 `task_stop` display payload，字段只包含 `taskId`、`taskType`、可选 `command`、结果 `message` 和可选 `truncated`。`command` 与 `message` 必须分别受 16 KiB UTF-8 预算约束，任一字段被截断时设置 `truncated: true`，避免 display 绕过 tool result budget 放大实时事件、持久化快照和展开 DOM；UI 展开态必须明确提示详情已截断。实时事件从 `raw.result.display` 读取，持久化恢复从 `raw.display` 读取，其他 provider 可从 `raw.rawOutput.display` 读取；三个入口必须由同一个 UI reader 做严格 kind/字段校验。
- `TaskStop` 的成功 output/model content 继续保持原始工具契约；runtime 必须让 `local_bash` 的 `command` 表示实际命令、`local_agent` 的 `command` 表示短 `description`，不得把完整 subagent `prompt` 放入结果。UI 对 `local_agent` 将可信 `task_stop` display 中的 `command` 按“任务描述”以正文样式展示；命令型任务继续按“命令”以等宽样式展示。没有 display 的历史 `local_agent` 结果不得把旧 `output.command` 当作描述展示，因为该字段可能保存完整 prompt；旧字段只允许用于精确识别并压缩标准成功文案。display projection 只负责去掉标准成功文案中已经由 `command` 字段单独展示的重复内容：`Successfully stopped task: <taskId> (<command>)` 在 UI 的“结果”中显示为 `Successfully stopped task: <taskId>`。UI 对没有 display 的历史结果只做同一模板的精确匹配，任意自定义结果文案必须原样保留。
- `TaskStop` 继续兼容旧结构化对象、JSON 字符串和 `rawOutput`。历史结果若带 hook additional context，只允许识别明确的 `\n\n[Hook additional context]` envelope 并解析前段 JSON，不得做任意前缀截断或文案猜测。停止操作本身不使用 destructive 颜色；只有真实失败态继续复用 `ToolLayout` 的 failure status 与错误 tooltip。
- `TaskStop` 的收起态必须显式覆盖完整终态：`completed` 显示“已停止”，`failed` 显示“停止任务失败”，`denied` 显示“停止操作已拒绝”，`stopped` 显示“停止操作已取消”；失败、拒绝或中断不得与“已停止”同时出现。
- `TaskStop` 的 `failed` / `denied` / `stopped` 若带错误原因，展开态将该原因作为“结果”展示；若 task type、任务描述或命令、结果和截断提示都不存在，则必须禁用展开，禁止出现可点击但内容为空的详情面板。
- `TaskOutput` 归入 `task-control` family，并通过 `TaskOutputToolCallBlock` 渲染。收起态使用等宽 `task_id` 作为主内容，状态按“工具执行终态 > retrieval status > 被查询 task status”的优先级投影：工具执行失败显示统一的“执行失败”，运行中显示“任务运行中”，等待超时显示“等待超时”，成功读取 completed task 显示“已获取”，failed/lost 显示“任务失败”，cancelled/killed/stopped 显示“任务已停止”。未知 task status 原样显示，禁止把成功读取结果一律当作 task 成功。
- `TaskOutput` 的主展示数据使用 Core 生成的 `task_output` display payload，只包含 `retrievalStatus`、最长 64 字符的可选 `taskStatus`、最长 2000 字符的可选 `output` 和可选 `truncated`。`task_id` 继续直接读取 tool input，不在 display 重复保存。output 使用 `trimEnd()` 后保留前 2000 字符；空白 output 不生成字段，运行中已取得的部分 output 允许展示。仅非空 output 提供展开入口，展开区使用固定最大高度的滚动 `<pre>`；截断时提示后续内容已省略。task type、description、error、prompt、result、output path 和原始 provider XML/JSON 不得进入 display、摘要正文或展开内容；真实 tool execution failure 仍复用 `ToolLayout` 的通用失败状态 tooltip，通过 `context.errorText` 在 hover/copy 时展示错误原因，且不因此生成展开区。
- `RespondToCoordinator` 归入 `message` family，并通过 `RespondToCoordinatorToolCallBlock` 渲染。收起态只使用 input `summary` 作为主内容，不提供展开区；运行中显示“正在回复”，success 显示“回复已排队”，业务或执行失败显示统一的“执行失败”，拒绝和停止显示对应终态。“已排队”只表示 response command 已进入 parent runtime command queue，不得写成已送达、已读取或已处理。
- `RespondToCoordinator` 的主展示数据使用 Core 生成的 `respond_to_coordinator` display payload，只包含 `status: "success" | "failed"`。`message`、`responseId`、`error` 和原始 result 不得复制到 display、摘要正文或展开内容；真实 tool execution failure 仍复用 `ToolLayout` 的通用失败状态 tooltip，通过 `context.errorText` 在 hover/copy 时展示错误原因，业务 `status: "failed"` 不凭空生成错误详情。普通 child tool row 只在 child session topic 中物化；父会话继续只显示 Agent/Task 摘要，不得为了专属卡片恢复 mirrored child tool row。
- 新增 display 通过 completed tool metadata 和 V4 `ToolCallRow.display` 传输。旧记录没有对应 display 时，两个 renderer 只使用 input 与通用 tool lifecycle 展示最小摘要，不解析 provider-visible XML/JSON，也不新增持久化迁移。
- 正式 desktop WDIO 复用 background Agent 生命周期验证两条投影链：成功 case 在父会话真实调用 `TaskOutput` 并展开 output，随后从 Agent 摘要进入 child 会话检查 `RespondToCoordinator` 的 summary/“回复已排队”以及父会话隔离；组合错误 case 让 TaskOutput 查询不存在的 task，并让 child 调用缺少必填 `message` 的 RespondToCoordinator，当前覆盖两个 tool row 的 error 终态、统一的“执行失败”文案、卡片正文不包含 provider error wrapper 或原始错误，以及 child-only 边界。两张错误卡 hover 通用失败状态后展示对应 `context.errorText` 的 WDIO 断言尚未补齐，因此 O19 保持 `partial`。E2E 不重复枚举 retrieval/task 状态、业务 queue failure、2,000 字符边界或 mobile replayable；这些组合由 Core display、V4 projection/wire 和共享 renderer 定向测试覆盖。
- 这些 renderer 都复用 `ToolLayout`、`ToolSnapshotFieldNotice`、semantic color token、`text-ui-base` 正文排版和 lucide 图标。Execute/Shell 工具收起态 summary 中的 command 使用 UI sans 字体，与同一摘要行保持一致；展开后的命令正文继续使用等宽字体。传给 memoized `ToolLayout` 的 JSX props 必须通过 `useMemo` 保持稳定引用；详情布局必须在窄屏纵向自然换行，并兼容桌面/Web、Zai Light/Zai Dark 与中英文文案长度。
- `Read` / `Edit` / `Write` 摘要在会话流变窄时优先保留文件名：窄于 `360px` 的 conversation container 先隐藏动作标签、来源徽标和父目录路径，文件 chip 使用剩余宽度并在自身内部截断；文件图标、diff 统计和展开入口继续保留。普通宽度仍显示完整动作标签与路径，桌面分栏与手机 Web 共用同一容器规则。
- 所有 ToolCall 运行中都保留静态 kind 图标，不再替换成旋转 loading 图标；运行态通过 kind 文案扫光、状态文案和摘要内容表达，避免大量 toolcall 同时 streaming 时持续触发动画渲染开销。
- ToolCall 文案统一遵循“运行态动作名称、终态稳定类别名称”：中文 `pending` / `in_progress` 的 kind label 使用 `正在 + 动作`；英文沿用简洁自然的现有动作词（如 `Reading`、`Sending`、`Working`），不为句式对称机械扩写。进入 `completed` / `failed` / `denied` / `stopped` 后统一回到不带“已”的类别名称，目标、命令、文件和业务结果继续放在摘要正文中，失败、拒绝、停止等异常状态继续由 status label 表达。例如单个 Read 显示 `正在读取 package.json`，完成后显示 `读取 package.json`；单个 Execute 显示 `正在执行 pnpm test`，完成后显示 `终端 pnpm test`。禁止把“已读取”“已执行”等成功动作当作终态类别名称，也禁止在类别名称和摘要正文中重复同一个进行中动作。
- 专属业务状态优先于通用生命周期文案：`RespondToCoordinator` 的成功结果仍是“回复已排队”，`TaskOutput` 仍区分任务运行中、等待超时、任务失败和任务已停止，`TaskStop` 仍区分成功停止任务与停止操作自身被拒绝/取消。类别名称只负责说明工具是什么，不能覆盖这些业务结果。
- Tool 摘要和 Execute 详情中的 command 文本统一继承 UI sans，不使用 `font-mono`；命令输出仍保留 `font-mono`，维持 terminal-like 数据的对齐与辨识度。这是 command 展示对全局 typography 默认规则的产品例外。
- SubAgent 的视觉运行态只看父 Agent tool 的 `pending` / `in_progress`。子工具是展开区明细，不反向续住父 Agent 运行态；父 Agent 已经 completed 时，即使子 tool 仍 running，外层也收敛成静态 `SubAgent xxx`。
- Agent / SubAgent 收起态遇到 `TodoWrite` 子工具时展示待办语义摘要，不展示裸工具名：优先展示 in-progress 项，否则展示下一条未完成项，否则展示最后一条完成项；格式为 `Updating todo 2/5 当前任务`，全部完成时为 `Updated todo 5/5 当前任务`。这样子 agent 更新计划时，滚动摘要仍能表达具体内容，而不是 `Running TodoWrite`。
- 当前主轮仍为 running 时，Agent / SubAgent 卡片与聊天底部 `ChatLoading` 同时显示。Agent 卡片及其内部子工具只负责工具详情，不控制 `ChatLoading`；底部 loading 在主轮进入终态时隐藏，等待 AskUserQuestion 或权限确认期间也隐藏，避免把“等待用户”误表达成“正在思考”。
- 流式 Shell 在命令参数尚未到达时暂缓展示，命令到达后按真实工具逐条展示；终态仍保留原工具行。
- `Goal` 工具、用户消息里的 `/goal` 命令 mention、goal 摘要和 goal 校验分割线统一使用 lucide 的 `GoalIcon`。
  这个图标与用户可见的 `/goal` 语义一致，避免继续用 `TargetIcon` 造成项目内图标和 lucide `goal` 图标不一致。

## 编辑行数计数

- `Edit` / 写文件类工具的摘要行继续复用 `changeStat.added` / `changeStat.removed` 作为唯一统计来源，UI 不在渲染层重新推导 diff 行数。
- 行数变化时，`+N` / `-N` 中的数字可使用一次短字符槽翻页动画；`+` / `-` 符号保持静态，颜色继续使用 `text-diff-added` / `text-diff-removed`。
- 翻页动画必须使用固定字符宽度和 `tabular-nums`，避免桌面端连续流式更新或手机端 replayable 恢复补帧时造成摘要行抖动。
- 用户开启 `prefers-reduced-motion: reduce` 时，数字降级为静态字符槽，只保留完整读数的辅助技术标签。
- 运行中的 `Write` / `Edit` 预览由 projection 最多每秒提供一次新的真实 `changeStat`；同一个采样点的路径、内容、diff 与 `+N/-N` 必须原子更新。
- UI 禁止用 `requestAnimationFrame` 逐行追赶目标值。目标从 `12` 更新到 `45` 时直接把 `45` 交给一次短翻页，不补播 `13`、`14` 等中间值。
- 工具结束、取消、恢复历史 snapshot 或手机 replayable 终态时立即显示真实目标，不回放已经过期的流式行数。

## 历史一致性

- ZCode persisted tool call 现在会持久化 `status` 和 `raw`
- 这样实时流里的 diff / image / 特殊 tool payload，刷新后仍然能复用同一套展示逻辑
- Core 的 `ToolResultDisplayPayload` 是 UI 结构化事实边界：display 从原始 tool output 生成，通过实时 `ToolCallResult.result.display` 传输，并通过 completed tool part metadata 持久化。模型可见 content 的格式化、截断和 hook additional context 不得改变 display。
- V4 product projection 必须把 CUA、file diff 等通用 display 保留在 `ToolCallRow.output.display`；`ToolCallRow.display` 只保留既有 `node_repl_images` 专用通道。UI adapter 优先读取 `output.display`，并兼容旧 Node REPL 顶层 display。
- CUA display v1 的 `input` 仅作为旧历史记录兼容字段继续可读；新事件不再重复写入。工具调用自身的 `ToolCallRow.input` 是唯一输入事实源，UI 解析旧 display 时丢弃其中的副本。
- UI 读取 display 时必须同时覆盖桌面 `desktop-continuous` 的实时 raw event 与手机 `web-remote-replayable` 的持久化 metadata；不得把 replayable 恢复数据拼接进 desktop continuous 主链路，也不得绕过现有 snapshot/gap 恢复边界。

## WebFetch 与公开工具展示

WebFetch 独立归入 web-fetch family。摘要使用网页图标、Fetch/Fetching（中文：网页抓取/正在抓取）和目标 URL；不使用 prompt，不展开。明确历史 fetch/web_fetch/webfetch 别名兼容；不按 URL 输入猜分类。权限预览复用 WebFetch renderer；Explore 子项复用 URL 文本提取函数，再由探索分组渲染。

App 与分享复用工具 renderer 注册表及分组 presentation。App 通过 capabilities 注入文件媒体、应用图标、模型 provider 名称和 agent 颜色；插件交互通过 render context 的 pluginUi 注入；公开展示仅注入资源 URL 与安全外链。纯展示层不能静态导入服务、平台、插件 runtime。Fetch 仍属于只读探索分组。

## Tool Summary 分隔与文字层级

所有工具及 UI 合成分组的摘要不再插入装饰性中点；类别、正文、状态、计数和文件列表使用 gap-2（8px）分隔。公共摘要不提供分隔符参数。正文使用普通字重和 foreground-subtle，类别使用 font-normal；Node REPL 动作标题遵循正文层级。文件、Agent 类型及错误状态保留语义样式。用户内容、命令和详情正文中的标点不删除。桌面、手机远控及公开分享复用此规则；不改变分组算法、展开行为或摘要滚动时序。本文前述摘要示例中的中点均由此规则替换为空间间距。

macOS 桌面默认开启灰度平滑，可在外观设置关闭以恢复系统默认；其他平台不指定 `-webkit-font-smoothing`，详见 [macOS 字体平滑](macos-font-smoothing.md)；字体栈、字号和行高保持不变。

思考摘要同样仅用 gap-2 分隔：思考标签与耗时、标签与流式摘要均不插入装饰性中点；不改思考正文、耗时计算及展开行为。

思考摘要中的“思考”和“思考中”标签使用普通字重，不使用 font-medium；流式扫光及其他状态展示保持不变。

思考图标以及“思考中”“思考”标签使用 foreground-subtle 次要前景色。运行态扫光基色使用 foreground；耗时与思考正文保持原层级。

亮色主题的全局 foreground-subtle 加深，提升次要文字和图标在浅色背景上的辨识度；同时覆盖默认亮色与 Zai Light，保持 primary/subtle/subtlest 层级。深色主题和 foreground-subtlest 不变，具体值以 styles.css 为准。

Zai Light 的 foreground、foreground-subtle、foreground-subtlest 共用 neutral-900 基色，分别保持不透明、70%、40% 透明度层级。

Zai Dark 的主文字 foreground 使用不透明的 neutral-100，提高正文和主要操作的明度；foreground-subtle、foreground-subtlest 继续使用 neutral-300 基色及 60%、30% 不透明度，保留辅助信息层级。共享 foreground 的图标同步提亮；其他语义色、fallback 主题和全局抗锯齿设置不变。验收覆盖桌面/手机宽度与 Zai Light/Zai Dark，确认仅深色主前景变化。

Node REPL 工具摘要：图标与动作标题使用 foreground-subtle，标题使用 font-normal。成功且有动作标题时不再附加完成状态；运行、失败、停止仍表达状态。应用位图图标保留原色，不应用灰度滤镜；无标题时仍显示完成兜底，避免空摘要。

普通 Tool Summary 的图标、类别、动作正文统一 foreground-subtle 和普通字重。运行态保留扫光并使用 foreground 基色；路径、耗时保留 foreground-subtlest，文件/Agent/错误语义颜色保留。工具类别或结果数量不视作成功状态，继续显示。

终端命令摘要使用 foreground-subtlest 第三级前景色，用于单条终端的命令；终端图标、类别与动作标签继续使用 foreground-subtle，展开后的命令正文不变。

“思考中”右侧流式思考摘要使用 foreground-subtlest；思考图标和状态标签继续使用 foreground-subtle，展开正文不变。

工具和思考的进行中扫光基色使用 foreground；静态摘要继续按 foreground-subtle / foreground-subtlest 分层，保留既有淡色渐变与 Highspeed 专属覆盖。

文件摘要（Read、Write/Edit）只显示文件类型图标和文件名，文件名使用 foreground；类型图标保留原始颜色，不影响其他文件入口或应用图标。行内不展示父目录；文件名悬停时通过共享 ControlHintTooltip 组件显示完整路径，最大宽度为 240px，文字水平居中，窄屏保留左右各 8px 边距，长路径允许换行，不使用原生 title 提示。文件点击预览和增删行数的语义颜色保持原行为。

子智能体工具摘要使用 16×16px 的 WorkflowAgentFace、身份名称与任务描述，不显示固定的子智能体类别标签。名称与头像使用同一 workflow 色板：优先采用展示配置或工具的显式身份色；已有八种颜色标识映射到 workflow 对应色，未指定时使用 agentColor(undefined, 原始名称)；名称使用普通 UI 字体和正常字重，仅在展示时将连字符替换为空格并将各词首字母大写（内部标识不变）。描述与当前活动摘要使用 foreground-subtlest。头像状态仅由父 Agent 工具状态驱动：进行中对应 scanning，完成对应 content，失败对应 sad，等待与停止对应 waiting；停止不显示成功表情，原有停止/失败文案保持。沿用头像组件的减少动态效果支持，不由子工具状态延长父工具运行态。

进行中（scanning）的头像每轮动作结束后随机停顿 1～2 秒，再开始下一轮；首次启动延迟仍为 1.2～2.8 秒，眨眼、巡视和偶发表情的动作时长不变。该节奏适用于所有复用 WorkflowAgentFace 的进行中头像，其他状态的间隔保持不变。

子智能体设置列表复用 WorkflowAgentFace：普通行在原头像容器内使用 20×20px 动态头像，去掉 Bot 图标与色点；有插件图标的行保留插件图标，并将右下角色点替换为 16×16px 动态头像（20px 外框）。颜色选择器、设置头像与摘要统一使用 workflow 色板，保留已有八种颜色配置标识；显式配置优先，未配置时按原始名称取色；设置页没有执行状态，显式使用 idle 展示模式：双眼眨眼与轻微巡视，不显示三点或运行态专注/疑惑表情，不能伪造运行状态。复用组件的离屏暂停和减少动态效果支持，不改变用户颜色配置。

颜色选择器保留八个既有标识，不改变保存协议：yellow→workflow 橙黄、red→红、orange→橙、green→绿、cyan→青绿、blue→蓝、purple→紫、pink→粉。只更新展示色值，不改写存量配置。

颜色选择器各选项使用 20×20px 空闲眨眼 WorkflowAgentFace 代替圆点，显示对应配置颜色；保留 radio 语义、颜色名称和键盘焦点；选中态使用 28px 圆角方框与 2px border 描边，描边内侧与 20px 头像间保留 2px 留白，匹配头像轮廓，不改变保存流程。

会话摘要颜色配置必须复用 useSubagents(workspacePath, ZCODE_AGENT_PROVIDER) 的作用域读取与加载，不自行遍历上下文缓存，也不借用其他工作区全局列表。设置保存沿用现有刷新链更新缓存；摘要订阅同一配置。无配置时才采用工具显式颜色或名称散列。

思考、普通工具与 CUA的整行 summary 在支持 hover 的设备上悬停时，所有非扫光文字（含状态、计数、耗时）显示为 foreground；运行中的扫光文字继续保留扫光，移开恢复原有颜色。唯一文字例外是子智能体名称，保持身份色；其任务描述仍参与 hover。普通工具、CUA 与思考的矢量图标在 hover 时也使用 foreground；原色图片图标、子智能体身份头像和箭头保持原色，不影响展开详情或 tooltip。

Workflow 草稿的“待修正”和“未运行”用 gap-2 分隔；补全摘要的留白名称前不显示装饰性中点。

WorkflowToolSummary 的发起、调整与补全摘要同样不用装饰性中点，字段以 gap-2 分隔；子代理计数使用 foreground-subtlest，hover 遵循公共摘要文字规则，打开箭头使用 foreground-subtle，与左侧工作流图标的默认颜色一致；默认隐藏，summary hover 或键盘聚焦时显示，颜色不变。

工作项外层的相邻分组、独立工具（包括 Subagent、Todo）和思考统一使用 16px 间距；展开后的分组内部摘要间距为 8px，组头到首条子项为 8px。正文边界仍为 16px。桌面、手机与公开分享使用同一规则，不改变分组关系。

## 跨类型连续摘要分组

连续思考与 Explore / Run / Change / Session 两项及以上形成一组；单项直接展示。正文、用户消息、交互、Workflow、Subagent 和其他未归类工具独立展示并断组，不进入统计。原始 rows、工具执行与 Agent 精确配对不变。

- Explore：读取、搜索、列目录、网页获取；每次调用计一项。
- Run：全部终端命令、CUA、BUA（Node REPL）；每次工具调用计一次，不拆分调用内部动作。终端读写文件仍只归 Run。
- Change：文件写入、编辑、补丁；复用文件摘要的完整路径，在 workspace 内解析相对路径后去重。失败/取消调用仍参与统计，不将统计表述成成功证明。路径未知的调用单列“修改 N 次（路径未知）”，不虚构文件数。
- Session：ListSessions、ReadSession、SendToSession、WaitSessions 按精确名称进入同一连续组，与思考和普通工具混排；每次调用计 1 次，合并到 Run 的“执行 N 命令”，不按 sessionId 去重，不根据返回列表或 operations 数量计数。空列表、缺失结果、失败或取消仍按调用次数计数。pendingApproval 仍独立断组；其他 session 工具保持原边界。会话组代表图标使用 BookOpenText，混合组沿用既有优先级。组内专用卡片与原有展开行为保持。
- 思考只展示，不参与工具计数；纯思考组使用“思考 / Reasoning”作为静态摘要。

默认收起。分组是否闭合由整轮可见内容顺序决定，不看组内工具是否全部结束。当前末尾仍可追加的组，在任务运行期间保留原始完整 summary，有活动项时跟随活动摘要，无活动项时保留末尾摘要；正文、Workflow、Subagent、交互或未归类工具等边界出现后，前一组闭合并显示统计，即使其中残留 running。整个任务结束时末尾组同样闭合。分组边界必须跨 history、正文和 work segment 的展示拆分判断；隐藏内容不新增边界。

当前组结束时立即停止翻滚并清空待播摘要，收起态显示统计；展开态始终显示统计作为组头。中文如“查阅 5 项，执行 6 命令，修改 3 文件”；闭合后为“已查阅 5 项，已执行 6 命令，已修改 3 文件”；英文如“Explore 5 items, Run 8 commands, Change 2 files”，单复数随数量变化，零计数不显示。组内保留原始列表和各条详情。

统计组头在展开和收起时始终单行；图标与箭头保持固定尺寸，中间统计文本可收缩，超长显示省略号，悬停查看完整统计。窄屏与中英文、深浅主题遵循相同规则。

展开后的子项列表沿用思考详情的左侧导线颜色与位置：左侧偏移 8px，使用不占布局宽度的 1px 导线，内边距为 16px，文字起点为 24px，与组头的 16px 图标加 8px 间距严格对齐。组头保留图标，子工具及子思考摘要不显示行首图标，也不保留空图标槽；状态标记、文件图标和详情内图标不受影响。组头到子项为 8px，组内摘要间距为 8px，组外仍为 16px。收起时导线随子内容一起收起。

分组内部展开思考正文时只保留外层分组导线，移除正文自身的左侧边框、外边距和内边距，使正文与该思考标题左对齐；正文顶部留白为 4px，保留弱化颜色、耗时、折叠箭头和滚动行为。独立思考块保留原有导线、缩进和 12px 顶部留白。桌面、手机宽度及公开分享使用相同规则。

分组展开后的子内容最多显示 16 条标准单行摘要的高度（16 个当前行高 + 15 个 8px 间距），超出后内部垂直滚动，组头不参与滚动。与 Thinking 共用吸底和 mask 行为：首次展开吸底；跟随期间新增子项、内容增高及容器尺寸变化均重新吸底；用户上滚离底超过 2px 后保留阅读位置，回到底部恢复跟随；收起后再展开默认吸底。顶部/底部存在隐藏内容时对应显示 24px 淡出，无溢出不显示 mask。展开详情也受同一高度上限约束。滚动状态仅由当前容器拥有，不改变外层会话滚动状态。

分组首次建立时以行标识分配 identity；App 工作项列表在历史前插和追加时按共有行保留原组身份，不能每次重算第一条 row 导致整组重挂（见 [SSV05](chat-virtual-scroll.md#分组身份连续性ssv05)）。分组组件唯一持有展开状态。新增、结束、失败和取消均不覆盖用户选择。外层 Working / Worked 继续按原有工作段状态及默认展开规则收纳过程，工具分组不得隐藏外层入口或强制外层展开。外层展开后保留内部工具分组功能，最终答复仍按原规则留在外面。右侧箭头不翻滚，默认隐藏，hover 或键盘聚焦时显示。支持鼠标、触屏及 Enter/Space。

```text
整轮可见内容顺序 + unit.isRunning → 末尾未闭合组：完整 summary / 已闭合组：统计
原始 rows → 可见性过滤 → 类型分类 → 连续片段 → 当前摘要与统计（只做派生）
用户选择 → 分组展开状态（生命周期变化不写入）
```

桌面、手机远控与公开分享复用分类和展示。无新增协议、持久化或任务状态源。验收覆盖任务运行但所有工具已完成、任务结束仍有迟到 running 工具、统计去重/未知路径/失败/复数、Workflow/Subagent/正文断组、手动选择保持、冷恢复、深浅主题、中英文及窄屏；真实手机 replayable 网络恢复另验。

统计组头在文字前按 CUA > BUA（Node REPL）> Change > Run > Explore 优先级复用工具原始图标；同优先级取最先出现的工具，跳过思考；纯思考组保留思考图标。运行时仍显示当前工具图标。展开和收起复用共享 Collapsible 高度及淡入淡出动效，收起结束后卸载详情；快速反向切换由同一展开状态驱动，不增加延时状态。

运行中收起的翻滚摘要外框与展开统计组头使用同一行高。翻滚容器作为 flex 子项布局，不能由行内基线增加行盒高度；展开/收起时组头顶部、图标与文字中心保持不动，详情区域独立执行高度动画。

工作项列表使用 4px 基础 gap；外层相邻项统一补 12px 留白，使分组、独立工具和思考彼此之间为 16px。只有明确标记为组内的摘要列表取消额外留白，使用 8px 间距；展开和收起遵循相同外层规则。

未闭合组的内容优先使用最近一个 inputStreaming/running 工具或 streaming 思考的完整摘要；收起且没有活动项时保留末尾工具的完整摘要（纯思考或末尾为思考时使用末尾思考摘要），按原始项状态刷新，不切换统计。收起预览的工具类别或思考标签持续使用 foreground 扫光，直到分组闭合；扫光表达分组仍未结束，不将已完成工具改成运行态，图标不扫光。结构闭合或任务结束后才切换静态统计。展开态仍显示统计，无活动项且未闭合时保持原统计扫光。展开状态保持。

统计仅含 Change（思考不计数）时，只有收起态的统计展示追加文件列表；有 Explore/Run 时保持原统计。单个已解析文件且无未知路径时用“修改 / Change + 文件名”省略文件数；多文件保留统计并追加文件图标和名称，完整路径去重、顺序取首次出现。按可用宽度保留前序完整文件项，其余显示 +N；变宽后恢复。文件名用共享 tooltip 显示完整路径，desktop 有预览回调时点击打开文件/差异且不触发分组展开。未知路径不编造文件名，原次数提示保留。展开态仍只显示原统计；活动摘要、结构闭合、扫光和 Working/Worked 均不改。

单条工具摘要（含分组展开后的子项）按工具自己的状态显示时态：进行中沿用 Writing / Editing / Deleting / Searching / Running，完成后使用 Wrote / Edited / Deleted / Searched / Ran。Read 的过去式仍为 Read。分组统计不受此文案修正影响。

分组统计按结构闭合状态选择时态，展开与收起一致：未闭合组仍用 Explore / Run / Change（查阅 / 执行 / 修改）；遇到分组边界或任务结束后改为 Explored / Ran / Changed（已查阅 / 已执行 / 已修改），单文件标签也使用 Changed / 已修改。工具暂时结束不代表组完成。子项读取完成后使用 Read / 已读取。

外层过程收纳恢复 staging 去重规则：整轮运行中不显示 Working 收纳标题，过程内容保持展开且不允许手动收起；轮结束且工作段状态不再 running 后才显示 Worked 收纳入口。运行时加载提示沿用现有入口。内部连续工具分组、摘要选择与闭合状态不受外层收纳影响。

Working 加载提示与工具摘要共用对齐基准：图标槽 16×16px，内部 13×13px 像素图标水平和垂直居中，图标槽至文字的间距为 8px，文字起点距行左侧 24px。

Change 分组性能约束：同一不可变工具行的完整文件摘要只解析一次，计数与文件列表共用结果；时钟、正文或其他工具更新不得重建历史行的 diff。工具行引用变化时重新解析，不跨行标识复用旧结果。验收覆盖重复渲染、追加工具及更新工具输入。

可选宿主契约：子智能体配置由 SessionPane 宿主按 workspace 身份加载，经展示 capabilities 注入颜色。独立 ToolCallBlock、PermissionDialog 不要求 ServiceProvider 或 TabStoreProvider；无宿主时不加载配置。

Change 文件去重按 workspace 解析相对路径后，统一分隔符并折叠 `.`、`..`；绝对路径不得越过根目录，UNC 不越过共享根。仅做词法规范化，不改变大小写，不解析符号链接。计数与文件列表共用此规则。
