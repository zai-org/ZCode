# 工具变更链路

## Subagent 上下文配置刷新

Settings/外部写盘 → Host 原生 watcher → 逐文件读取及共享纯解析 → 内存 snapshot →
session 初始化/父 turn 的同一 RPC → definitions → listing / Agent / SendMessage / plugin-reference。
配置读取失败 snapshot 标记内置回退；RPC 断连/取消仍结束父轮，保留输入且无 provider 请求。
后台更新期间使用旧完整 snapshot；running child 不刷新，terminal resume 使用父轮定义并保留
身份历史。Host 诊断按文件更新记录，CLI 不重复解析。工具 schema/执行/历史与缓存标记不变。
删除专用广播，不扩展插件热更新、独立 CLI 来源或 continuous/replayable 语义。
远程 workspace 由远端 Host 走同一链路（2026-10-18）；是否接入读取由持有 CLI stdio 的 Host
决定，不按 workspace 身份排除。详见 `docs/subagent-runtime-refresh.md`。

SHR09/SHR10 仅补测：真实 Settings 单字段保存 → 下一父轮 spawn/terminal resume → provider
及既有模型变更持久化；running SendMessage 只投递，不刷新 child。时序控制留在测试端，
不增加生产 marker、测试 RPC 或测试状态分支。

SHR10 Desktop、SHR11-SHR15 继续仅补测试：真实 Host/CLI stdio 的测试代理负责读取故障与
PID/session 观察；provider fixture 负责重试及跨轮窗口。Core 通过既有加载器、模型端口和
取消信号验证 Guide/Stop；child 原始 model-io 按 subagent 来源导出并逐请求核对工具历史。
生产源码、协议、依赖不变，完成前比对全部生产源码和依赖文件校验值。

SHR15 发现的 child 缓存问题已修复：system 输出合并为 CLI prefix 和正文两个块，各保留一个
标记，为对话末尾 breakpoint 留出额度。Main CLI prefix 不再单独标记；正文与 TTL 不变。
完整历史、trajectory 连续及缓存断点回归已通过，见 `docs/subagent-runtime-refresh.md`。

SHR08 缓存回归：Core tool message 的 cacheControl → Adapter tool-result part providerOptions
→ AI SDK 合并 tool messages → Anthropic 对应 tool_result.cache_control。标记跟随原结果块，
避免 SDK 合并时丢弃后续 message providerOptions；工具 schema、正文和状态合同不变。

2026-09-15 Bash 慢命令资源遥测：执行适配器 spawn 后每 15 秒按 PGID 采样，根退出或 stop 结算时
通过独立 `process/toolExecResource` 通知交 Host / main 即时上报；前后台共用同一采样器，最多 20 次，
Windows 只取结束上下文。工具 schema、权限、输出、超时、V4 与 continuous/replayable 投影不变。
测试覆盖 PRT-010/011/012、执行适配器退出分类与 Bash 一致性。详见 `docs/monitoring/process-resource-telemetry.md`。

2026-09-15 复审修复：Bash 完成资源通知增加可选随机 `completionToken`，CLI 在单命令资源 owner
生成，services / Host 原样转发，main 以有界近期集合去重后投影 ARMS 白名单。同一完成事实跨连接、
跨 window Host 只上报一次；不同命令指标相同仍分别上报。标识不含命令、路径或 session/task 信息，
不进入 ARMS、日志或任何 V4 行；旧 CLI 缺字段时保留原事件行为。工具输出、权限与执行节拍不变。

## Todo151：Plan 独立状态

Enter/ExitPlanMode 的 Port、返回 Schema、handler、权限校验、拒绝／反馈、已有 reminder 与
配置投影一起采用独立 planEnabled。Runtime 权限不因 Plan 进入／批准而改变；yolo 不能绕过
规划限制或计划审批。草稿只通过关联本次工具转换的同步更新，不被一般快照持续覆盖。
历史工具结果保持可读，不修改模型提示正文，不新增进入／退出的可见事件。
保存与兼容方案见 `docs/plan-mode-independent-state.md`；Queue 保真修复属于同一提交链路。

2026-09-08 Bash shutdown：adapter close 为既有异步杀树收尾保活，独立 Node 回归覆盖退出前
完成后代清理。正常根退出、工具事件与 continuous/replayable 边界不变，见 `docs/bash-background-parity.md`。

2026-09-08 Bash 进度调度：按 Node 进程/内部轮询周期共用 interval，任务独立订阅与尾读；最后一个订阅退出时释放。保留逐任务 5 GiB watchdog，协议/展示不变；测试覆盖共享、移交、并发读与迟到结果，Desktop BG14 复验。

2026-09-08 Desktop：Bash 终态通过严格 `bash_output` display 传递有界头部、截断标志与保留文件路径；界面显示部分输出提示和文件入口，运行态隐藏行数/字节数。Provider 内容和 TUI 不变，验收见 `docs/bash-background-parity.md`。

## Bash 直接文件输出

2026-09-07 补齐：Bash 大输出取消结算时 64 MiB 文件裁剪，模型收到头部摘要和完整输出路径。
有界尾读产生 5/100 行预览和估算行数，经可选 `outputPreview` 契约进入 CLI 的 V4 工具行投影；
终态/后台清理预览，不复用 replayable-only `progress` 字段。测试覆盖完整文件与进度事件。2026-09-08 按用户最终要求保留 Desktop 渲染与 BG14 验证，TUI 不改。

普通 Bash 输出与生命周期的具体合同见
`docs/bash-background-parity.md`。输出文件 flags 按宿主平台选择，不按 shell 方言选择。

```text
Bash schema / permission / handler
  -> Execution adapter：准备命令、异步 open 一次
  -> spawn(stdin, fd, fd) -> 关闭父 fd
  -> 子进程直接写 canonical output
  -> 前台有界 tail progress / 终态有界 head result
  -> Background registry / TaskOutput / 单次 completion notification
  -> 原有 runtime queue / V4 投影
```

前后台使用同一文件、同一进程；每 5 秒检查 5 GiB 软阈值，根进程 exit 即结算。
后台后代可能在终态后继续写，不能再将终态描述为文件稳定。通用 argv/Hook 的 pipe
与硬截断合同不变。Bash 不再发逐 chunk stdout/stderr 事件，复用 progress/result 协议；
desktop continuous 与 web remote replayable 的交付边界不变。

## 工具历史声明顺序

同一 assistant 的工具声明顺序可以不同于提前执行时的首次落盘顺序。ToolPart 每次写入都携带调用
对象的 `blockIndex`（一次响应内的块到达序号，与 text / reasoning part 共用）；`declarationIndex`
不再写入，只在旧数据里读取。回退和断流恢复继续新建 part，沿用同一 callID 和序号；模型 history
hydration 在同一 assistant 内按 callID 选最后新建的 part，再按 `blockIndex`（旧数据按
`declarationIndex`）恢复 calls/results 声明顺序。缺少序号时保留所选记录原序。session-store 读取时
只对有序 assistant 消息按 `blockIndex` 重排 reasoning / text / tool part，其他 part 位置不变，旧消息
保持物理顺序；UI 不做调用合并。浏览器轮尾截图 tool part 不进入模型历史。文件读取状态恢复按 live
的写入顺序：快照 metadata
另带执行器在工具记录快照时取的可选 `snapshotIndex`，同一 assistant 内按它重放快照，模型 history
不使用它。模型流回调和落盘时机保持不变；live 调度、执行和提交结果按 `blockIndex` 排序，和冷恢复同序。
详细契约见 [工具历史顺序修复方案](./tool-history-order-repair-proposal.md) 与
[Assistant 内容块顺序](../../../../apps/zcode-cli/docs/design/v2/model/assistant-block-order.md)。

```text
声明 Bash(0) -> Read(1) -> 原有落盘 Read(1), Bash(0)
                       -> hydration calls/results Bash(0), Read(1)
```

## Read PDF 的 Runtime 依赖注入

```text
宿主创建/注入 PdfDocumentPort
  -> AgentRuntimeDeps（主任务与子任务）
  -> createRuntimeToolExecutor
  -> ToolExecutionContext.pdfDocumentPort
  -> Read(pages): renderPages -> 图片处理 -> 下一次模型请求中的有序页图
  -> Read(无 pages): getPageCount -> 超过 10 页时拒绝整份读取
```

`PdfDocumentPort` 由宿主提供，Core 只透传既有端口，不创建第二套 PDF adapter，也不依赖旧模型连接端口。
2026-09-02 的合并 `bd4dc05bcb` 在删除 `modelConnectionPort` 的冲突处理中遗漏了相邻的 PDF 端口注入，
导致工具 schema 仍公开 `pages`，但分页读取返回配置缺失，整份读取跳过页数检查。

恢复接线必须同时保留分页成功结果与原生读取的页数保护；权限、超时、取消、工具 schema 和错误分类不变。
主任务与子任务共用此执行器装配边界；桌面、Web/手机远控均使用宿主已有的 CLI Runtime，不改变
continuous/replayable 交付链路。跨平台路径与 PDF 外部命令仍由现有 adapter 负责。

`runtime-read-pdf.test.ts` 通过完整 Runtime 工具循环验证主任务和子任务：分页调用注入的 adapter，
下一次模型请求收到按页序排列的图片；无 `pages` 且超过 10 页时返回工具错误，且不读取 PDF 二进制。
测试不能只直接构造 ToolExecutor，否则无法发现 Runtime 装配时漏传依赖。

## 话题历史附件按需读取（本地／stdio／WebSocket 接入验证中）

2026-11-03 起，话题资源由 `ReadTopicResource` 读取。`ReadSessionContext` 已删除，见
`docs/architecture/zcode-app-control-design.md` 0.8。模型传入已归档的 `messageId` 与资源序号。
模型输入不包含 botId、chatId、workspace、授权版本或下载地址。
当前 session 必须与工具上下文一致；输入来源和授权版本从当前任务的可信入站记录解析。

工具输入为 `{ inputId?, messageId, index? }`，`index` 缺省为 0；文本历史索引携带 inputId 时，只能解析该任务已接收的对应快照。省略 inputId 时沿用最新可信输入。模型填写的 inputId 只做选择，不提供授权。

工具没有 sessionId 参数。真实模型验证发现当前任务 ID 不在模型上下文内，所以工具由工具上下文
解析当前任务，不允许跨话题读取。运行时注入了 `topicResourcePort`（App 托管的会话）才注册该工具，
并延迟曝光；非机器人会话调用时没有已接纳的话题授权，工具报错。
可信来源优先读取 `conversationInputIntent`，兼容旧 `inputIntent`；canonical 字段存在但无效时
不能借旧字段恢复权限。只有正常用户输入可提供来源；缺少入队授权版本时明确拒绝附件读取。
Host 返回寄存引用及名称／MIME／字节数，Agent 校验实际字节数后写 session binary artifact。

```text
ReadTopicResource({ inputId?, messageId, index? })
  -> current session + trusted admitted input source
  -> dependency-injected TopicResourcePort
  -> strict Agent/Host reverse request
  -> Host readTopicResource (archive + group/topic/version checks)
  -> existing chunked attachment upload into requesting CLI
  -> CLI session artifact -> binary artifact with target-local path
  -> bounded tool result (status/path/fileName/mime/bytes/messageId/index)
```

App/Agent 方法及双向参数使用 `packages/shared/src/zcode-protocol/index.ts` 的运行时
schema；旧 Host 能力缺失须明确失败，独立 CLI 不注册该工具，不回退到任意 URL 下载。Host 连接边界
注入 workspaceIdentity 与 remoteSessionId，不接受模型覆盖；远程 runtime 的请求必须经现有
连接回到拥有机器人凭据的 Host，不能另建运行时或在远端读取本地凭据。

stdio 的受控进程测试复现：CLI 先预热再绑定 logical session 时，反向资源请求永久捕获首次
wireClient 参数，丢失 remoteSessionId。每次读取开始时从同一个 CLI 的当前可信入口固定路由，
下载、上传与最终授权检查共用这一份快照，不能在异步步骤中重新挑选工作区或运行时。

附件 bytes 复用现有分块上传和校验，不放进单个反向响应。Agent 从自己 session 的 artifact
读取完整资源，复用 binary artifact 写入及 session 生命周期清理，文件后缀必须安全规范化。
取消传播到下载/传输/落盘；失败不提供半成品路径。下载不能批准权限、改变策略或创建输入队列。
该工具会写托管文件，不声明只读；`sideEffectScope` 为 `session`，权限名为 `session.topic_resource.read`，
无需审批。工具权限仍检查当前 task/source 边界，trace、结果预算、事件和 V4 投影沿用工具执行链。

测试依次覆盖工具 schema、可信来源解析、Host 反向请求、远端路由、分块失败与取消、runtime
artifact 落地、真实模型按文件内部值回答及原话题投递。Host 下载单测或原生 API 下载成功不代表
这条端到端工具链已完成。

### 真实回查连接关闭（2026-09-08）

13:57 实测调用已选中正确历史附件，但 Host 立即关闭协议并终止 CLI。新增附件 port 将
Core TraceContext 原样放入严格的协议 trace，携带 sessionId、turnId、attributes 等非协议字段。
跨端反向读取和取消必须复用 protocolTraceFromTraceContext 映射，只传 traceId、spanId 和 parentId；
任务／输入身份继续放在严格请求参数中。测试必须用实际 zcodeProtocolMessageSchema 校验完整
读／取消帧，不能仅断言 requestClient 被调用。

取消与断连同时发生时，requestClient 可能在返回 Promise 前同步抛错。取消通知属于尽力通知，
不能从 AbortSignal listener 抛出未捕获异常；原始读取仍按取消或断连失败，不补执行、不重连。

## CronDelete 删除语义

CronDelete 的删除范围必须限定为当前 workspace，且删除结果必须反映数据库实际影响行数。

```text
CronDelete(id)
  -> CLI AutomationPort
  -> automation/delete protocol
  -> Service.delete(id, current workspace)
  -> Repo.delete(id, workspace key)
  -> { deleted: true | false }
  -> Tool result
```

删除不存在的 ID、已删除的 ID 或不属于当前 workspace 的 ID，不能返回成功。调用方需要得到明确的未找到结果，避免模型在 CronList 后反复重试同一个删除请求。

## CronPauseSelf 暂停语义

CronPauseSelf 只在 automation 执行轮可见，用于在 prompt 的停止条件满足时暂停本轮所属任务。

```text
Host admission automationId（仅接受调度派发显式注入；inputId/runId 只是追踪字段）
  -> core RegularTurnLoopState.automationId
  -> executor ToolExecutionContext.automationId
  -> CronPauseSelf({})（无 id 输入，缺少 automationId 时拒绝）
  -> CLI AutomationPort.pause({ id })
  -> automation/pause protocol
  -> Service.pause(id, current workspace)
  -> Repo.pause：只把 active + enabled 的行改为 paused
  -> { paused: true | false }
  -> Tool result
```

普通用户轮、只有兜底信号的轮和 remote workspace 都不暴露该工具。已暂停、已完成、已失败、已删除或不属于当前 workspace 的任务返回 `paused: false`，不改变状态。scheduler 的 `markDispatched` 回写在同一条 UPDATE 内保留 paused，避免暂停后被派发回写复活。完整状态与时序见 `docs/automation-edit-status.md`。

## 远程 workspace 的 Cron 工具策略

SSH、WSL、Docker 和 Server workspace 使用 `remote:*` workspace identity。此类 session 在创建或恢复时将 CronCreate、CronList、CronUpdate、CronDelete、CronPauseSelf 加入 session 级 denylist，避免远程 Agent 暴露无法由远程调度边界可靠承载的定时任务能力。本地 workspace 不继承该限制。

## Todo103：Off-Peak 工具与标准执行边界

```text
Host 本地能力（服务装配 + workspace 类型，不联网）-> Off-Peak policy/创建参数 -> App OffPeakPort -> 工具注册
OffPeakCreate 实际调用 -> Host 灰度/套餐/模型校验 -> createTask/取号
idle turn attribution -> turn denylist + activeOffPeakTaskId -> 拒绝递归 Create
当前 modelExecution + sharedContextRefs -> Core admission -> 完成时清理 turn attribution
```

3.12.2 移除注册阶段灰度读取，保留本地支持边界、调用准入与绑定请求；CLI 冷恢复/创建通过当前异步 App 工厂装配，不恢复旧
workspace catalog、临时 overlay、turnRuntimeModel 或模型还原。idle execution 仍携带精确
ModelSelection/requestAuth，不能改 Session 持久选择。退出/拒绝/排队分支都要清理当前 turn
的 activeOffPeakTaskId；允许 Cron turn 创建闲时任务，禁止将 OffPeakCreate 并入 Cron 写工具常量。

## 显式 Subagent 模型选择（Todo99）

```text
profile 原 Selection -> Worker 公共 Selection Facade（同一已应用账号/Registry 快照）
  -> 临时有效 Selection -> child Runtime -> ModelFactory 精确校验 -> 模型请求
```

解析通过宿主注入的只读端口复用；不改工具参数、结果与 profile 持久化。无同模型时不回退父模型；档位失效不补默认。隐式继承和内部执行 override 不重解释。端口透传子 Runtime / workflow，独立终端 CLI 未注入时保持原行为。完整契约与验证见 `docs/working-memory/provider-refactor/steps/todo-99-worker-account-selection-repair.md`。

## 闲时轮禁止 SendMessage / Workflow（D52）

```text
Host 闲时派发 -> prompt-turn.ts / server-operations.ts turn denylist（+SendMessage,+Workflow）
  -> turn-loop.ts 按 OFF_PEAK_MUTATION_TOOL_NAMES 在每个 model step 隐藏
  -> handler send-message.ts / workflow.ts 读 context.offPeakTurn -> assertNotOffPeakTurn
  -> recoverable PermissionDenied（提示改用前台 Agent）-> 模型改走 Agent 工具（带 subagentModelOverride）
```

原因：SendMessage 续跑终态子 Agent 与 Workflow 派生脚本子会话都在闲时轮 `modelExecution` 之外重建
模型，回落父会话常驻选择并计入用户 Coding Plan（ZCT-2099408932463325184）。三处 denylist 常量必须同值；
`isOffPeakCreateRestrictedTurn` 的 denylist 兜底只认 OffPeakCreate 哨兵。工具 schema、权限、超时不变；
automation 轮与普通轮不受影响。测试：`core/tests/off-peak-tool.test.ts`、
`bootstrap/tests/offpeak-prompt-turn-disallowlist.test.ts`、`bootstrap/tests/v4-native-commands.test.ts`。

#### 2026-09-08 原生验证发现的入口校验问题

2026-11-03：话题原文回查随 ReadSessionContext 删除。`ReadTopicResource` 没有 sessionId 参数，下文的 `sessionId: current` 选择器已不存在。

历史附件选择以 `conversationInputIntent` 为权威来源。仅当该字段不存在时兼容 `inputIntent`；权威字段存在但无有效话题记录时，不得从同条消息的旧字段恢复记录。相同消息上两个字段冲突时只采纳权威记录，正文与 synthetic 背景仍不能注入来源身份。

真实模型显式传入 `sessionId: current` 时，工具 executor 的 JSON Schema 校验将正则字符串与字面量的联合转换为 `oneOf`，而最小校验器未应用正则，因此两个分支同时匹配，错误拒绝调用。当前话题选择器应使用单个字符串模式表达 `current | sess_*`，在 executor 入参校验与 handler 运行时解析两层验证；非话题策略仍要求明确任务 ID。不能仅直接调用 handler 的单测宣称真实工具入口可用。


## Agent 官方插件发现与确认安装

`SearchPlugins` / `SuggestPluginInstall` 经 contracts -> Core handler -> 注入的 PluginDiscoveryPort -> Bootstrap 官方目录/安装适配器；V4 pluginInstall 专用交互由 CLI 发出，桌面/手机通过 resolveInteraction 回应。UI 仅提交选择，安装继续复用 storage lock、内置恢复和 User/Workspace 启用原语。工具内部显式确认合同绕过重复通用弹窗，但 project deny/ask 和 plan 限制保留；yolo 也必须点击卡片，绝不套用 AskUserQuestion 自动结束。能力刷新仅注入 PluginActivationPort，未接入返回 refreshRequired。两个工具均为 deferred（`shouldDefer`），经 ToolSearch 按需加载；Session-specific guidance 暂不注入插件推荐提示。详见 docs/plugins/agent-plugin-discovery.md。
