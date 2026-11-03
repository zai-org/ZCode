# Tool Change Chain Spec

工具 schema、顺序与描述是固定字节（tools 段字节进入缓存前缀）：`toToolJsonSchema` 按
zod v4 toJSONSchema 的 key 顺序输出——`$schema` 在最前，`description`、`default` 在 `type` 前，
数组的 `minItems`/`maxItems` 在 `type` 前，属性声明顺序不变；ToolSearch 输入 schema 走同一入口。
SendMessage、ToolSearch 进入按名字排序的工具名单；名单外的工具按注册顺序排在名单之后；
MCP 工具（名称以 `mcp__` 开头）按名字排序排在最后，顺序与 server 连接顺序无关。名字一律按 en-US 规则比较，
顺序与进程的语言设置无关（同一会话换语言设置恢复时 tools 段字节不变）。WebSearch
描述不写真实月份。Bash/Read/Skill/WebFetch/Agent 描述为固定文本，只说明已支持的能力
（fork/后台/目录作用域 skill、署名行、Jupyter、teammate/cross-session、worktree 等未支持，不出现在描述里）。
只改请求投影，不改变执行、权限或持久化；升级后第一个请求的 tools 段缓存失效一次。

工具结果文本（2026-10-18）：Read 去重只比较该文件最近一次 Read 视图；空内容警告按读取结果区分；
部分视图的页长按比例估算，提示改为 `read_truncation_notice` 附件，排在该批 tool result 之后；
未知工具名统一为 `<tool_use_error>Error: No such tool available: X</tool_use_error>`；
其他工具错误给模型原文（保留换行，超过 1 万字符保留头尾）；Bash 失败结果头尾截断、不落盘，
超时转后台的文案说明超时秒数。只改模型可见文本和投影，工具 schema、权限、事件与 UI 不变；
已发送的历史不改写，只有新产生的结果使用新文本。细节见 01-read.md、04-bash.md。
SendMessage 的 summary 改为可选、超长截断；Agent 描述的后台一行补上 "Never fabricate or predict a pending agent's results…" 一句
（ZCode 默认前台运行，后台说明只写这一行）。tools 段升级后缓存失效一次；细节见 07-subagent.md。
后台 agent 终态通知的文本与 `originMeta.subagentResult` 结构化结果见 07-subagent.md；App 不解析 summary 文本，
Agent 卡片的“执行失败”hover 仍只显示原文；只影响新产生的通知，已发送的历史不改写。
运行时校验（2026-10-20）：Bash 超时转后台的 `timedOutAfterMs` 与输入 `timeout` 一样允许小数；
SendMessage 只有空白的 message 在 hook 与权限之前判为输入错误（child 只收到 message），模型收到 `<tool_use_error>message must not be empty</tool_use_error>`。provider schema 与 tools 段字节不变。
工具 Hook 上下文（2026-10-21）：`PreToolUse` / `PostToolUse` / `PostToolUseFailure` 返回的 additionalContext
不再拼进 tool_result。executor 把每条 context 写成 `<Event>:<ToolName> hook additional context: <context>`
（例如 `PreToolUse:Bash hook additional context: …`），放进 `ToolExecutionResult.hookAdditionalContexts`；
结算把每条写成一个 `tool_hook_context` 附件，排在这批 tool result 之后、其他批次提示之前，按 tool result 的顺序分组，
同一工具 Pre 在前，多个 Hook 不合并、多行原样保留。tool_result 只放工具原文：失败时与没有 Hook 时是同一段错误原文，
Hook 文本也不占 tool result 预算。MCS 下这些附件和同批其他附件合成同一条 system；非 MCS 下按普通 user 侧提醒投影。
附件持久化，resume 后位置不变。`tool_call_result` 事件和 App 工具卡不再含 Hook 文本；官方 CUA 帧凭据过滤保留。
Memory 后台循环（Extraction、Dream）用同一个 `toolBatchModelEntries` 生成这批 entries，批次提示照常送达；
它的 executor 不配置 hooks，所以没有 Hook 上下文（见 [Memory](../memory/README.md)）。
单条 context 超过 10000 字符时先落盘，附件里只放 `<persisted-output>` 外壳；落盘失败时截到 10000 字符并附原因
（规则见 hooks.md「聚合规则」）。

## Bash 注入会话上下文环境变量（2026-11-01）

Bash handler → `createExecutionRequest` → `ExecutionRequest.env.set`：每次 Bash 调用（前台、显式后台、
超时转后台）都设置 `CLAUDE_CODE_SESSION_ID` / `CLAUDE_SESSION_ID` / `ZCODE_SESSION_ID`（当前会话 ID）与
`CLAUDE_PROJECT_DIR` / `ZCODE_PROJECT_DIR`（会话工作区根目录 `workspaceRoot`），其余变量仍按 adapter 默认
继承。原因：自定义命令的 `!` 块改为转交模型经 Bash 执行（[custom-commands.md](../custom-commands.md)
「Dynamic expansion」），原来只由命令解析阶段的 shell 执行器提供这组变量；插件脚本（例如在自身进程里
读取会话 ID 区分会话的 stop hook 状态文件）需要在 Bash 里拿到同样的值。变量名与值与 hooks 的
`createPluginEnvOverlay` 一致。工具名单、schema、描述、权限判定与 App 协议不变。回归覆盖 Bash 请求带上
这组变量，以及桌面 E2E 中转交执行的命令读到当前会话 ID 与工作区路径。

## 内置 Explore 继承父会话权限（2026-10-31）

Agent 工具 → runner → `resolveSubagentPermissionMode`：内置 Explore 不再固定 yolo，与其他 profile 一样
继承父会话模式与 Plan 状态；子会话改用父会话的 `PermissionService`（allowedTools、disallowedTools、
会话内授权随之生效），不再新建默认配置的实例。Explore 的 Bash 由 shell AST 判定只读：只读命令放行，
非只读命令在父会话 build/edit 下请求审批并代理回父会话，在 Plan 下拒绝，在 yolo 下放行，在 guarded 下
命中危险命令规则时单次确认、其余放行；WebFetch
同样按父会话模式判定。修复原因：Explore 只靠 prompt 约束只读，提示注入后模型可经 `Agent(Explore)`
在 build 或 Plan 父会话下免审批执行任意 Bash。工具名单、schema、描述与 App 协议不变。回归覆盖父会话
build、build + Plan、yolo 下 Explore 的 Bash/WebFetch 判定与是否执行，以及父会话审批卡片的 E2E。

`SendMessage` 恢复已结束的子会话时同样按父会话当前的模式与 Plan 状态重算子会话模式：子 runtime 以新算的
`{ mode, planEnabled }` 调用 `resumeFromStore`（`executionStateOverride`），覆盖落盘的执行状态。恢复路径曾沿用
落盘模式，父会话从 yolo 改为 build 后，恢复的子会话（含升级前落盘为 yolo 的 Explore）仍免审批执行命令。
回归覆盖 yolo→build、build→Plan 与 Explore 的恢复。

## Plan 模式只在原模式之上收紧（2026-10-31）

tool executor → `checkStaticToolPermission` → `PermissionService.checkPermission`：disallowedTools、
项目 deny/ask 之后，`planEnabled` 先过 Plan 闸门，再走原模式判定。闸门只直接放行只读免审批工具
与声明 `allowedInPlanMode` 的会话控制工具；需审批的只读工具（WebFetch、`readOnlyHint` MCP）交给
原模式；非只读、非 destructive 的 MCP 在原模式 yolo/guarded 下交给原模式，其余原模式下返回
`mode.plan.mcp` 询问并带 `optionsPolicy: "no-always-allow"`，排在 allow 规则之前；其他非只读工具
与 destructive MCP 仍为 `mode.plan.nonReadOnly` 拒绝。闸门没拒绝时，guarded 的危险命令单次确认
（`userApprovalRule`）在原模式判定前生效，不被 Plan 跳过。executor 把判定里的 `optionsPolicy` 合并进
审批请求，v3/v4 投影据此去掉"始终允许"与"完全访问"。原实现在 Plan 下替换原模式且不看
`needsApproval`，WebFetch 与 MCP（含宿主 `node_repl` 的 `js`）在 Plan 下比 build 更宽。
工具 schema、描述、注册、App 协议字段不变。回归覆盖 Plan×原模式判定矩阵、allow 规则不能跳过
MCP 询问、审批请求不带始终允许，以及 `EnterPlanMode` 后调用 MCP 先请求审批。
规则见 [Plan Mode Approval Boundary](../../../../../../docs/plan-mode-approval-boundary.md)。

## 插件 Agent 权限模式只能收紧（2026-10-31）

插件 agent 文件（默认 `agents/` 与 manifest `agents` 声明的目录）→ `loadPluginAgentTemplates` 保留 frontmatter `permissionMode` 并标记
`permissionModeRestrictOnly` → 名称空间与裸名别名（同一 profile 展开）→ Agent 工具 runner
→ `resolveSubagentPermissionMode` 先按声明映射子会话模式，再由 `restrictPermissionMode`
与父会话模式比较，取更严格的一个。严格程度从严到宽为 plan、build、edit、guarded、yolo；
`bypassPermissions`、`dontAsk` 对应 yolo，因此插件声明不能放宽；`auto` 未实现，按继承处理。
官方与第三方插件同一规则。用户级 profile 按声明生效，项目级 profile 仍在解析时剥离。
标记只存在于 CLI 进程内的 `AgentProfile`，不进入 Host→CLI 的 `agentProfileSchema`。
工具 schema、描述、App 协议和 UI 投影不变。回归覆盖严格度矩阵，官方/第三方插件的
`bypassPermissions`、`dontAsk`、`acceptEdits`、`plan`、`auto` 五种声明值与两种调用名，以及父会话 build 时插件 `bypassPermissions` 子会话的 Bash 仍请求审批。
规则见 [项目配置信任边界](../../../../../../docs/security/deep-link-project-trust-boundary.md)。

## 官方命令环境包装保留 Bash 后台能力（2026-10-28）

Bash handler → `withOfficialCommandEnv` 注入会话环境 → 原执行器
`runBashWithBackgroundLifecycle` → 原有后台任务登记、输出与完成通知。
包装层复用 core 公开的能力接口与检测函数，只在底层支持时暴露对应方法；显式后台和超时转后台
均保留原模式、取消信号、事件回调、结果与错误。后台状态仍由原执行器唯一管理。
`ExecutionPort` 接口之外的能力有两个，`runBashWithBackgroundLifecycle` 与
`waitForBackgroundTask`，两者都必须透传：后者缺失时后台追踪退回 1 秒轮询，
Bash 完成通知会晚于同一轮 tool-loop 的下一次模型请求。
`env.base: "empty"` 不注入，端点不可用时沿用既有执行策略。
回归覆盖包装后的真实生命周期入口与后台等待入口。桌面 E2E 复跑：background 26/26 通过，
background-bash-output 7/7 通过，bash-direct-output 6/8 通过——`BDO05` 的前台与后台 5 GiB
边界因可用磁盘低于 12 GiB 的前置条件未执行，其中后台变体会经过本链路，仍待在空间充足的机器上补跑。
日志证据是 Bash 的 `background_task.tracking.started` 恢复为 `hasDirectWaiter: true`。
不改变工具 schema、权限、模型结果格式或 App 协议。

## Bash sed 只读权限收口（2026-10-28）

`sed` 脚本可执行外部命令或写文件，shell AST 与参数白名单不能单独证明其只读。共享 readonly
policy 只开放数字行号打印和标准输入替换两个完整脚本子集；复用 AST argv，不重新解析 shell 文本。
参数、完整脚本和文件参数同时通过白名单后，才授予 `readOnly`、`concurrentSafe` 和免审批能力。
链路仍为 Bash AST → readonly policy → runtime capability → PermissionService → executor：
Plan（旧 `mode=plan` 与独立 `planEnabled=true`）按既有规则拒绝非只读 Bash；普通 Build
默认请求审批，Plan 关闭后的其他模式和显式授权继续遵循原权限规则。管道、命令链和已支持
wrapper 中的 sed 也必须通过同一白名单，项目 allow 不能解除 Plan 对非只读 Bash 的限制。
`-e`/`-f`/`-i`、未知参数、执行/写入脚本和脚本后的 option 形参数不自动放行；保留展示层的原地修改识别。
不改 Bash schema、执行命令、权限事件结构或桌面/手机投影；Plan 拒绝时沿用 PermissionDenied，
不发 PermissionRequested、不调用 ExecutionPort。文件查看继续优先用 Read。
回归覆盖安全打印/替换、脚本执行/写入、参数与转义边界、独立 Plan、显式 allow、Build 审批及 cat/grep 放行，
并通过真实 executor 验证拒绝事件和执行端零调用。运行时验收在临时目录检查文件副作用。
完整边界见 [Bash](04-bash.md) 与 [AST 权限语义](../../../bash-tool-ast-permission-semantics.md)。

## 会话 ID 兼容（2026-10-28）

普通新建恢复 `sess_${crypto.randomUUID()}`（UUID v4）；已持久化的 `session_` 身份不变。
Composer session mention → runtime reference reminder → ReadSessionContext schema
→ 原 ID 的 SessionStore 查询 → 原 ID 的工具结果，兼容两种前缀。
邮箱目录仍按原 ID 隔离；保留路径安全校验、权限、工具超时与返回结构。
回归覆盖两种历史后缀、混合引用去重、非法 ID 拒绝、准确读取及完整重启后继续对话。
完整规格见根目录 `docs/session-context-tool.md` 的 Session identity compatibility。

## 共享 CLI 的工具请求归属（2026-10-27）

定时、闲时工具沿用模型输入、权限、结果和持久化契约。协议 port 从自身 session record
取得 workspace，经协商的 `sessionWorkspaceRouting` 能力附加到 Host 请求；列表、删除、
更新和自暂停也必须携带归属，不能使用物理连接首次绑定的目录。缺少自身 workspace 时
明确失败；旧 Host 未协商能力时保持原参数。Host 用已登记的 session/workspace 校验路由，
不接受共享连接中的未知归属。工具执行与桌面 continuous、手机 replayable 投影 owner 不变。
回归包含两类 port 的新旧协议、共享 CLI 的独立审批和真实 Bash cwd 写入；完整设计见
[共享 CLI](../../../../../../docs/shared-task-cli.md)。

## Read 读取状态与 compaction 文件恢复（2026-10-22）

Read 返回 `file_unchanged` 时不再记录读取状态快照；hydrator 跳过这类结果（含旧数据里已存的快照），
由之前那次真实读取恢复视图。compaction 文件恢复改为在 summary 之后重读整个当前文件：只选 Read / Write /
Edit 的记录，不走工具调用流程（无 hook、无工具事件、不弹窗），只跳过读权限 deny 规则：执行器新增
`areReadsDeniedWithoutPrompt`，与工具调用共用同一个模式与规则判定（`checkStaticToolPermission`），一批文件只加载
一次规则。规则按原始字符串匹配，所以读取状态另记工具输入的原始写法（`requestedPath`，Read / Write /
Edit 写读取状态时记下；冷恢复取自 tool part 的输入，不写进快照），补回时它和规范化路径各判定一次，任一命中 deny 就跳过。补回结果写入 live 读取状态表，不落盘。Read 的 schema、权限声明、模型可见结果文本和 UI/V4 投影不变；compaction 后补回附件
的内容变为文件当前内容，只影响新产生的 compaction，已持久化的不改写。规则见
[rewind-compact.md](../rewind-compact.md) 与 [17-read-file-state-resume.md](17-read-file-state-resume.md)。

## MCP 手动信任（2026-10-23）

工作区直接 MCP 声明 → bootstrap 当前声明快照 → 用户域逐条信任 → MCP port 准入 →
连接池/stdio/HTTP/SSE → 工具与资源。未信任不连接、不发凭据、不注册可调用工具；
每次连接准入重读声明和信任；连接内调用只查 gate 内存。会话内自动重连沿用原授权，撤销或配置变化在新建/重启会话的连接准入时生效。
桌面和手机设置经同一目标 Host 发送精确摘要，不新增模型可调用授权工具。
完整合同见根目录 `docs/runtime-tools/mcp-status-list-control-plane.md`「手动信任」。
显式 default/connect 工作区切换先使旧设置 gate 失效；只读 status 不切换 gate，不清理其他工作区连接。命令、环境变量与隔离字段在审核和执行之间保持一致。
坏声明逐条拒绝，空 `.zcode` map 沿用 `.agents` fallback；订阅释放不经过执行授权，用户来源由装配层保留。
工作区 MCP 准入沿用 Hooks 的会话内非阻断提示：gate 重读当前声明 → 会话事件 → V4 快照 → composer 图标弹层；
设置授权后只刷新同 workspace 的待审核投影，不自动连接。展示与忽略不改变工具执行授权。
提示读取只在初始化、新用户输入消费、恢复和显式授权变化时发生；普通模型续步与内部续跑不读取提示配置。
新用户输入包含用户 guide/steer；首输入复用初始化读取。配置加载器保留；提示刷新不改变现有连接的准入结果。
准入提示更新不计为会话活动；冷恢复和授权通知均不得改写 sessions-index 活动时间。

## node_repl 无进展提示（2026-10-26）

只改 node-repl-host 内部：`tools/call(js)` 按 `session_id + turn_id` 计同码、同结果与本 turn 调用量，
命中档位时在 `toMcpRunResult` 之后的 content 末尾追加一行「You may end this turn.」提示。
schema、权限、超时、isError、图片顺序、core 的 model-anomaly 与 UI/V4 投影均不变。
宿主行为变化，node-repl-host 升到 0.6.2（package、manifest、seed 定义、SEA 清单、serverInfo）。
合同见根目录 `docs/mcp-stateless-node-repl.md`「无进展提示」。回归：`no-progress-guard.test.ts`
与 `mcp-server.test.ts` 的 MCP 调用序列。

## 插件 Agent 源文件定位（2026-10-20）

`Agent` 的插件 profile 沿用组件发现结果中的实际源路径：插件目录 / manifest 目录
→ `PluginComponentItem { name, path }` → `loadPluginAgentTemplates` → 名称空间与裸名别名
→ Agent 工具执行。frontmatter `name` 与文件名可不同；名称不得重新转换为文件路径。
缺少路径的描述性组件不加载，源文件不可读保留诊断；不新增路径兜底或独立注册表。
工具 schema、权限、执行快照和 UI/V4 投影不变。详见 [插件 Agents 规范](../plugin-compat.md#agents)。

## 草稿 MCP UI 完全访问（2026-10-19）

审批卡 → 现有 interaction broker → runtime 授权 → 授权事件 → V4 投影 → 所属草稿 Composer。
未持久化草稿不写 session 子行；授权与首发/外部活动持久化交错时复用已有持久化 Promise。
重试固定原授权事件与目标集合，正式会话保留原事务；首发按当前权限保存同一 session。
工具 schema、执行权限策略、外键与 continuous/replayable 交付不变。测试覆盖真实 SQLite、
并发持久化、发布重试、草稿身份与首发，产品合同见根目录 `docs/plugins/draft-mcp-ui-session-spec.md`。

## Automation 自暂停工具 CronPauseSelf（2026-10-16）

新增 deferred 内置工具 `CronPauseSelf`，供 automation 执行轮在 prompt 的停止条件满足时暂停
本轮所属任务。链路：contracts `CronPauseSelfInputSchema`（严格空对象）/
`CronPauseSelfOutputSchema { paused, id, message }` → `AutomationPort.pause({ id })` → handler →
bootstrap `automation/pause` → Host `AutomationService.pause`。目标 id 只取
`ToolExecutionContext.automationId`，由 turn-tools / streaming coordinator / batch runner / call runner
从 `RegularTurnLoopState.automationId` 透传；模型输入不含 id，缺少身份时 handler 返回
PermissionDenied 且不调用 port。

```text
Host admission automationId（仅接受调度派发显式注入；inputId/runId 只是追踪字段，不能恢复权限身份） -> RegularTurnLoopState.automationId
  -> getTurnTools：无 automationId 时隐藏 CronPauseSelf（provider 工具、ToolSearch 目录与公告同源）
  -> executor options.automationId -> ToolExecutionContext.automationId
  -> CronPauseSelf handler -> AutomationPort.pause -> { paused }

busy admission
  -> PendingTurnInput / TurnSteerQueued 保存同一 automationId
  -> QueueItem 投影与编辑原样保留
  -> sendQueuedNow 提升时显式回放 automationId
  -> 新 RegularTurnLoopState 恢复同一身份；禁止从 inputId/queryId/denylist 重新推断
```

权限 `automation.pause`、riskLevel low、无需审批、sideEffectScope workspace、非只读、非并发安全；
复用 Cron 工具的超时、结果预算与取消声明，searchHint 见 [19-tool-search.md](19-tool-search.md)。
只在 `includeAutomation` 时注册；不加入 `AUTOMATION_MUTATION_TOOL_NAMES`（core / bootstrap /
services 三处），否则执行轮会隐藏它，旧 Host 的三项 denylist 兜底判据也会失效；不进
`SORTED_PROVIDER_TOOL_NAMES`。remote workspace 的 session denylist 加入该工具。`CronCreate`
的 modelInstructions 增加一句：用户给出停止条件时写进 prompt，并要求条件满足时调用 `CronPauseSelf`。
旧 Host 返回 `-32601` 时按工具错误结束，不回退。暂停的条件写与 scheduler 回写竞态见
`docs/automation-edit-status.md`（仓库根目录）。测试覆盖 handler 身份来源、无身份拒绝、可见性矩阵、
executor 透传、ToolSearch 目录与 bootstrap 协议请求。

## Bash 临时输出路径隔离

主应用及 workflow 子运行时装配 tmp 父目录 → execution adapter 实际准备具名输出文件 →
不可用时复用原 storageRoot 文件准备 → 确定唯一输出路径 → 现有前后台执行、进度、结果与文件入口。
模型 schema 和 App 协议不变，stdout/stderr 仍直接写 fd。覆盖降级、取消/关闭与准备竞争、
前后台路径一致性、Windows 原生搜索自引用及崩溃后的具名文件保留；不迁移历史输出。
存储统计仍限现有数据根，完整合同见 `04-bash.md` 和根目录 `docs/tmpdir-storage-paths-spec.md`。

## 自定义 Agent Memory 工具投影（2026-10-15）

Runtime 从当前父轮 Agent definitions 快照派生有效工具，启动配置、注入 reader 和 Host
每轮加载的 profiles 必须经过同一投影。Memory 启用且允许使用时，为声明 memory scope
及显式 tools 的 profile 补齐 Write/Edit；未声明 tools 保持继承，disallowedTools 和权限过滤
仍生效。不修改 Host 原始快照，不跨轮缓存工具，不增加延时或重试。回归检查三种配置来源、
连续父轮、Memory 关闭和禁用工具；Desktop MEM08 验证 custom-agent 真实写入 Memory 文件。

合并后登记工具结果结算、渠道回复及留白填充入口的模块边界；复用原契约与公开路径，不改变工具执行和持久化行为。

FillWorkflowHole 沿用非常驻内置工具的 deferred 分类；ReplyToChannel 不再默认注册。

Local 搜索名称为 `LocalToolSearch`，Native 仍为 `ToolSearch`。contracts 名称常量 →
单一 handler 的 Registry alias → 请求曝光与结构化历史/公告投影 → 同一 executor/权限/Hook。
模式切换在每次请求准备时生效，不修改共享 Registry 或持久化身份；旧历史、compact 和冷恢复
沿用原发现事实。同步包装说明、加载反馈、错误提示与真实 provider wire 回归，详见
[三种请求投影](19-tool-search.md#local-toolsearch-与三种请求投影)。

UI 按 `ToolSearch` / `LocalToolSearch` 两个名称选择同一搜索卡片，图标、文案与不可展开行为
完全一致。参数流开始到停止均保留原工具身份；renderer 兼容新名称，避免执行归一化前落入
通用 JSON 卡片。TS14 受控流使用 `LocalToolSearch`，验证参数占位和停止状态。

ToolSearch / LocalToolSearch 的共用 `Query forms` 说明明确不支持正则，末尾给出
`shell terminal execute command` 空格分隔关键词示例；query 参数说明同步标明不支持正则。
仅更新模型可见文案，沿用原搜索算法与输入结构；验证 Native / Local 最终 provider wire。

Local ToolSearch 描述明确搜索后的 `DeferredToolCall {name,input}` 调用方式，只用一个简短的
TodoWrite 调用示例说明；常驻工具仍直接调用。只经既有曝光入口更新 Local description，
不改变 Native 文案、结果格式或执行协议。校验示例参数及 CLI/PTY 冷恢复的最终 wire，
合同见 [模型可见文案](19-tool-search.md#模型可见文案)。

Local 逐项反馈与 compact 提升：引用投影按模型调用批次前可见定义去重，新展开 schema 的
结果在 tool_result 内给出调用指引，纯重复结果给出已加载提醒。发现扫描同时读取有效 compact
检查点；曝光、搜索、公告及包装准入
共用提升后的分类，成功 compact 后以普通 tools 恢复已发现工具。保持真实引用持久化、
Native/Off、执行生命周期和 Continue 记录链不变。验收详见 [ToolSearch spec](19-tool-search.md#local-逐项反馈与-compact-后提升)。
已加载指引在 tool_result 内使用公共 `<system-reminder>` 包装；不生成 attachment，
MCS 开关不改变其位置或角色。验证混合/纯重复/冷恢复的最终请求及模式对应的提示数量。
首次展开的 deferred 定义在同一 tool_result 内合并追加 Loaded 调用指引，明确顶层 name/input；
单工具使用 `Call it now`，多工具使用 `Call them now`；其余保留统一的
`<tool name>` 占位、精确名称指引与复数结尾；
只加强模型行动指引，不改变执行、结果成功状态或已加载提醒，不承诺定义永久有效。
复用引用投影，Local 不再派生结果外成功提示；Native 保持原有提示。实际请求、Continue/compact
记录共用同一投影标记，不改变常驻选择、Native/Off 或历史持久化。验证多工具去重、
Hook 顺序、MCS、compact 提升及真实进程冷恢复的最终 wire。

ToolSearch 四项补齐：Native 有效搜索结果在整批 tool_result 后派生成功提示；未发现 deferred 参数
错误补精确 select、当前 schema 和模式调用方式；公告使用严格来源 attachment 参与 MCS 并
保留增量 metadata；MCP select 支持原始/规范化短名。复用既有遍历、持久化和执行链，
保持 callID、用户/媒体归属、Continue/compact 和桌面/手机交付边界。历史定义快照和
unavailable schema 保留延期，不增加存储字段或改变引用过滤。合同见 [19-tool-search.md](19-tool-search.md)。
Continue/compact 的请求记录重建复用本次投影的有效搜索结果 callID，避免漏掉派生成功提示；
不增加历史扫描、深拷贝或存储字段，实际请求与执行链不变。
未发现 deferred 工具的参数错误保留完整纠错段落：说明定义未加载与参数类型退化的关系，
再给出精确 select 和当前 schema；仅 Local 追加包装调用说明。完整文本回归同时保护
原始校验错误及已发现/Off/不存在工具的既有行为，不改变准入或执行。

ToolSearch 删除/恢复公告仅描述当前可用性，不推断 MCP 连接状态或变化原因。
正常与受限 turn 的增量比较、持久化、compact 及权限筛选保持原状；精确文案测试覆盖
内置工具恢复、MCP 分组、30/31 个删除名称和混合增删，确保不附加未经证实的原因。

App Settings ToolSearch 模式：配置 schema/patch -> 本地或远程 Host 偏好响应 -> Bootstrap
runtime-materialization -> runtimeConfig.toolSearch。只在新建/冷恢复取值，热恢复及已有草稿
不更新；fork/子 Agent 继承。CLI 参数、工具协议/执行/历史均不变。验证 Settings UI 保存到
最终 provider wire 的真实 E2E，及旧字段缺省、主子作用域、冷恢复与 Host 权威源。
缺省保持 Off；设置行底部显示实验性与原生模式供应商缓存支持不足时的用量风险，中英文一致，
不覆盖用户已保存的模式。复用底部说明区域，验证默认关闭、说明可见与原有保存/恢复链路。

Local ToolSearch 扩展沿用 [19-tool-search.md](19-tool-search.md) 的真实引用和发现检查点。
`--toolsearch-mode` 替代旧 enable flag；Local 将连续引用在结果内合并展开为 functions 文本，
两次 compact 之间的 tools 不随搜索发现增长；成功 compact 后检查点工具提升为普通 tools。DeferredToolCall 使用 `{name,input}`，仅转发当前允许的 deferred
目标，在公共准入归一化为普通目标调用；内部历史与持久化只增加 modelCallWrapper 字面量，
请求出口恢复原始包装，删除重复保存的 modelToolCall input。V4 scheduled 定稿目标身份；
断流未调度时，已有 tool_call_closed 仅补齐包装工具行的目标名称与输入，不推进业务状态。
Todo/microcompact/工具卡复用普通调用判断。重点验证原始参数隔离、调度/权限/Hook/媒体/turn-stop、
pending 到终态重存、冷恢复/分支、六向模式切换和 Continue/compact 的原有生命周期。
不保存 schema 快照、不新增 schema reminder、DB migration 或测试专用生产接口。
Core 事件时序与原始流保持原状；App 共用 render unit 隐藏 inputStreaming 的 DeferredToolCall，
完整目标身份到达后沿用原卡片和显示设置；直接工具预览及包装失败/停止展示不变。
展示层不从半截包装参数推测已准入目标。验证无 Scheduled
的断流恢复、实时与冷恢复身份、普通工具及失效事件隔离、continuous/replayable 的完整行更新。
请求内的引用过滤与 Local 展开共用一次历史投影；只复制内容实际变化的工具结果，
同一工具定义在本次请求内只编码一次。发现集合仍先独立扫描，最终 provider render
保留隔离拷贝；不改变公告时序、引用顺序或引入跨请求缓存。

ToolSearch 的默认关闭、显式模式覆盖、结构化引用与冷恢复合同见
[19-tool-search.md](19-tool-search.md)。发现状态仅从真实结果和有效 compact 检查点推导；
关闭只修改请求投影，不新增数据库表列，不改变 MCP 初始化或主子权限边界。
公共 tool metadata 同时接受既有字符串 modelContent 和 ToolSearch 结构化数组，避免失败 MCP
工具在 V4 transcript 冷恢复时丢失 display；ToolSearch 写入与发现恢复仍严格校验数组。
请求组装统一经 `prepareRuntimeProviderRequest` 执行一次 ToolSearch 准备，主/子 Agent、
Goal、Memory 与 Compact 提供各自完整工具目录；消息投影不再隐式猜测启用状态。
media 保持独立环节；公告在正常提醒阶段由原历史 owner 提交后再取请求快照，纯 max-token
Continue 不检查或生成公告。Compact 根据保留历史与继续执行的工具作用域独立重建公告；
请求准备只投影已有公告。公告正文与增量 metadata 随隐藏 synthetic 历史持久化，
fork/resume/rewind 按有效历史原位恢复，不新增 session 级缓存。验证续写去重、配套 wire、Goal SQLite 状态和恢复边界。
重试按 canonical 原始输入 ID 截断，公告及 Todo 等隐藏提醒不能成为重试边界；回归检查模型请求与冷恢复没有重复输入。
公告 metadata 只记录 addedNames/removedNames/readdedNames 增量；从保留历史顺序推导
当前已公告与曾完整列名集合，正文与 metadata 同源。删除按完整作用域工具池判断，
避免 compact 保留增量尾部漏补名称、deferred 转 alwaysLoad 误报删除。内置 deferred 工具
补齐 searchHint，不改变搜索排序、真实引用或发现检查点。
内置工具仅 Agent/AskUserQuestion/Bash/Edit/Glob/Grep/Read/ReportFindings/Skill/ToolSearch/Write
保留常驻资格；名单外工具在各自 metadata 声明 shouldDefer，不增加分类映射层。
ReportFindings 尚未实现，Task 兼容入口继续对 provider 隐藏；注册、灰度、权限和执行不变。
覆盖真实内置目录首轮曝光、搜索加载与关闭回退；MCP、provider 原生工具维持原有规则。
Native ToolSearch 的 provider description、参数说明及增删/恢复公告文案使用默认配置。
公告沿用 30 个删除名称阈值、
MCP server 分组与 ambient 提示；仅修改模型文案，不扩展 MCP 生命周期或公告状态。
ToolSearch 的 provider schema 将 query/max_results 都标为 required；执行链仍先通过
runtime schema 补默认值 5。验证最终 wire required 和省略 max_results 的真实执行结果。
ToolSearch 的引用块不参与普通文本截断；结果的预算投影保留引用和块顺序，仅限制文本
（Hook 文本是批次后的附件，不进 tool result）。展示内容和字节统计由最终块派生，completed metadata 与冷恢复
沿用真实结果；覆盖超过 100 KB 的搜索、批量 select、Hook 及 SQLite 恢复，不收紧输入范围。
Compact 摘要请求与主循环使用同一份工具目录，不按 ToolSearch 状态另选，也不设工具数量阈值；回归覆盖禁用、alwaysLoad 与超过 100 个工具的 Runtime 请求。
插件 MCP 的 `.mcp.json`/manifest 经各 transport 配置转换时必须保留 `alwaysLoad`；
验证插件发现到最终请求 schema 的透传，不改变 MCP 初始化、鉴权或工具权限。
App MCP 配置转协议 DTO 同样保留布尔 `alwaysLoad`，覆盖 stdio/HTTP/SSE；
未配置或非法值不生成字段，验证 JSON 传输与现有严格协议 schema，不扩张会话配置路径。

2026-09-18 ToolSearch 测试补齐：PTY force/resume/continue 走真实终端输入；动态目录与
尾部连续 compact 使用独立 Runtime/HTTP 集成 fixture，覆盖 streaming on/off 并检查原始历史。
macOS 与 Windows 原生进程证据及手机待验证边界见根目录 coverage matrix；不改产品入口。
同日补充 executor 执行边界、真实 Hook 结果 SQLite 冷恢复、搜索细分输入、开启状态空引用
投影的单测。E2E/单测不得为测试修改生产实现或新增测试专用入口；只复用既有依赖契约。

## Skill 通用名称埋点（2026-10-14）

所有 `tool_name=Skill` 的 `agent_step` 增加 `skill_name`。不提取调度输入的请求名称，
Skill handler 解析后通过既有 metadata 回调提供真实 `metadata.name`，沿
`ToolCallResult/Error → tool.lifecycle.skillName → agent_step.skill_name` 传递。
加载前失败/拒绝/停止、名称未解析或不符合遥测名称规则时使用 `unknown`。
CLI fact、UI 兼容 metadata 与最终 `/report` 共用名称校验，禁止任意请求参数进入遥测；
验收覆盖路径、URL、换行、模拟凭据与超长字符串的最终 HTTP 请求体。
不调整模型输入输出、权限或工具执行；不新增状态 owner，桌面 continuous 与手机 replayable
边界不变。字段、兼容与验收见根目录 `docs/monitoring/skill-agent-step-telemetry.md`。

## TaskStop 查找失败提示

`TaskStop` 精确查找未命中时，统一返回以下模型可见错误；不增加前缀匹配或 ID 格式校验：

```text
Invalid task ID "<id>". This lookup failure does not mean the task has completed or stopped; use the full task_id returned when the task started to stop it.
```

链路：`background_task_not_found → handler error (code: 1) → executor success: false → model isError: true`。
查找失败不能证明目标任务已完成或停止；模型应使用启动时返回的完整 `task_id`。
完整 ID 命中后的停止行为、其他错误、schema、权限、协议与 App 交互保持原样。
回归覆盖短 ID、未知完整 ID 的失败文案及模型错误标记，并保留成功停止和其他失败分支断言。

## 规划与 Todo 动态提醒

Plan 完整、简短及退出提醒，Todo 提醒与持续静默提醒都从消息历史计数，链路为消息历史 →
reminder formatter → runtime attachment → provider projection，复用持久化上下文载体和恢复链路。
细节见 16-plan-mode.md 与 loop/meta-user-context.md。工具 schema、审批、执行、事件和桌面／手机 UI 不变。

## 子 agent 环境与模型上下文共享

普通 child 的环境与执行模型通过和 Main 相同的 section assembler → runtime announcement →
持久化历史 → provider projection 下发，细节见 loop/meta-user-context.md。Agent schema、description、
权限、工具集合、结果与桌面/手机展示不变。

## 动态工作流的来源缺失提示

`CreateWorkflow` 与 `EvalWorkflowSnippet` 的字段全部可选，模型发出的参数不是合法 JSON 时，
adapter 记 `model.tool_input.normalize_failed` 并把它恢复成 `{}`，`{}` 能过这两个工具的 schema，
随后在 `validateInput` 的「恰好一个来源」上失败。旧文案把「多给」和「没给」并成一句
「Passing both, or neither, is ambiguous」，写了 `code` 的模型读不出原因，会原样重发。

现在两种情况分开：多给一个来源用 `*_SOURCE_CONFLICT_ERROR`；一个都没有用
`*_SOURCE_MISSING_ERROR`，尾部接共用的 `WORKFLOW_SOURCE_MISSING_HINT`，说明解析失败的调用
到达时是空的、常见原因（内联源码里未转义的 `\` 或 `"`）以及改走 `path` 的办法。

链路：`adapter {} 恢复 → executor schema 通过 → validateInput 返回 400 + 文案 → model isError: true`。
schema、归一化、权限、hook、handler 与 UI 不变；`AmendWorkflow`、`SaveWorkflow`、`FillWorkflowHole`
有必填字段，空调用先在 schema 失败，不在本次范围。回归覆盖两工具的多给 / 没给 / 只有
`timeoutMs` 三种入参，并经 executor 断言 `{}` 拿到缺失提示、不弹确认窗。

## 闲时后台执行（实施中）

按根目录 `docs/off-peak-task/background-lifecycle-plan.md` 实施：Agent 显式、profile 默认及超时转后台，
SendMessage 运行中投递/终态恢复，以及 Bash 显式/超时后台复用普通工具链。
票据生命周期独立于工具执行：3102 使后续模型请求等待新票，本地 Bash 继续保存输出；
换票只重试尚未提交结果的模型请求，不重放工具或原始 prompt。主轮结束后继续接收既有通知。
真实用户输入接管后，新后台轮读取 Session Selection；已运行子轮保留本轮模型。
输入 schema、权限、结果预算、通知包装、子轮 Bash 清理和桌面/手机交付边界不变。
Workflow、递归闲时/定时任务和自动记忆提取的限制保留；重启不恢复后台进程或通知。
验证覆盖换票并发、旧票迟到、用户接管、停止与任务取消、后台通知到达边界及两端交互。

## 冷打开历史先显示（2026-10-09）

持久化 tool 摘要由现有 V4 reducer 在 runtime 初始化前显示；工具详情、附件读取、App 交互
与执行入口等待 runtime ready。工具声明、模型可见输入输出、权限和执行语义保持原样。
初始化失败保留历史，显式重试复用完整 resume hook。状态与传输边界见根目录
`docs/v4-refactor/17-cold-resume-runtime-activation.md`，桌面 continuous 与手机 replayable
仍复用同一个 publisher，各自维持既有序号恢复语义。

## 工具内部模型请求的会话归因（2026-09-30）

WebSearch、WebFetch processing、ReadSessionContext 的内部模型请求继承发起工具的宿主
会话类型，移除调用点的 `modelRequestSessionType: "other"`；由 runtime 模型句柄统一绑定。
`querySource` 继续表达工具用途，ReadSessionContext 不按被读取的目标会话归因。
链路为 runtime 模型句柄 → tool handler 调用上下文 → adapter → provider HTTP header；
只调整观测分类，工具 schema、权限、执行、取消/超时、tool result、UI 与远控投递保持现状。
覆盖 runtime 工具调用与模型边界测试，合同见根目录 Agent 模型请求归因 Header spec。

## Agent listing attachment（2026-09-14）

Agent description 的目录迁移到持久化 `agent_listing_delta` attachment；仅指引模型查阅会话。
Runtime 在普通请求与 compact 恢复处共用增量收集器，按有效历史去重，通过无 I/O definitions
读取入口预留未来增删。工具参数、执行、权限与桌面 continuous / 手机 replayable 交付不变。
最终 role/顺序由现有通用 attachment 重排、MCS 与位置校验裁决；不增加 source 特例或放宽通用 anchor。
合同与分层覆盖见根目录 `docs/subagent-listing-attachment.md`；I21/SA 保留四类 profile，MCS 用一个代表场景验收，增量/恢复/失败路径由 focused tests 直接断言。
description 使用精简基线文案：补齐按 agent ID 的 SendMessage 续跑及
模型/reasoning/tools 定义来源说明（`.zcode/agents/*.md` frontmatter），去掉与首次 listing 重复的并发提示；执行、后台默认和 isolation 不变。
用户／项目自定义 agent 的 Host、Settings 与独立 CLI 扫描均限 agents 根目录直接文件，
与 depth:0 监听一致；插件递归发现不变。深层文件不进入 listing 或执行定义，父轮快照和 resume 边界不变。
目录 metadata 在恢复及历史写入/替换边界校验、复制；请求收集只读有效 delta 的名称增删，
避免重复校验分配，不引入缓存，也不改变非法数据处理与 provider-visible 合同。
增删计算直接遍历已通知集合，有变化后才排序；自动压缩仅在通过阈值与 rapid-refill 判断后
读取 listing 工具集合。普通请求仍在 MCP 初始化后独立读取当前工具，过滤与错误传播不变。

2026-09-29 staging 合并：保留 Guarded 统一审批生命周期，在批准与规则授权完成后复用工作流的 `applyInputAdjustments`，并将实际调整传给 handler/result。工作流确认窗的模型/并发调整在 build 与 guarded 均生效；危险 Bash 的 user-once、Hook 重判、取消与持久化拒绝合同不变。

2026-09-24 自主模式批量删除补充：只扩展 Guarded matcher，rm 为递归或明确批量，Git clean 为有效 force；新增 CMD rd/rmdir /s、del/erase、POSIX/Git Bash find -delete、CMD/Git Bash Robocopy /MIR 或 /PURGE。保留真实 dry-run/独立帮助豁免及方言边界，find 不分析 exec 载荷，Robocopy 不读取 JOB，wrapper 仍仅 env/time/sudo。逐词新增内部未引用 glob 事实，不改变其它规则的 dynamic 语义。复用 Bash capability → PermissionService → executor/broker → provider tool_result；不新增审批分支、公共 schema、状态或 UI。七类识别正反例、受控批准/拒绝/YOLO、原生隔离目录语义和独立 pending Desktop 闭环分别验收，详见根 Guarded spec 的本次补充与 DCA-V1-19..25。

本轮识别回归：CMD 内建删除接受粘连开关（`rd/s/q target`、`rd target/s/q`），分词保持引号、重定向与其它命令不变；Robocopy 在 Git Bash 下区分 `/c/...` 盘符路径与开关；rm 的危险选项存在性与潜在删除目标分别扫描，兼顾 BSD 首个目标后不再解析选项的语义（`rm first --help` 是批量删除）。只修命令参数归属，匹配证据与原生隔离目录结果成对验证；审批核心、通用选项扫描策略不变。

后续范围确认：仅修复已声明的 BSD find `-d/-x` 前置选项，保持起始路径阶段，避免在 `.` 处提前返回而漏读 `-delete`；谓词参数、exec 载荷和未知 arity 边界不变。Robocopy 裸 glob 文件过滤参数暂列已知覆盖限制，不扩展其动态词处理。

后台 Bash 详情：新增只读 `v4/conversation/backgroundBashOutput`，通过 runtime 授权和
execution port 固定尾读 8 KiB；不调用 TaskOutput，不改变模型工具、执行或通知合同。
详情按需轮询、暂停跟随与终态保留合同见根目录 `docs/background-bash-output-details.md`。
子会话冷恢复后，输出查询按 workId 沿现存会话/祖先 adapter 定位执行记录，仅 unavailable 继续查找；
始终用原始 sessionId 校验归属，读取错误与 unsupported 原样返回，不创建 runtime 或迁移任务。
详情查询仅返回状态、输出与文件入口所需字段，任务记录只保留 Bash 类型标记；必需 facade
直接调用，可选能力边界保留 unsupported。成功轮询复用 Host debug 日志，失败级别不变。
编码由 `run()` 单次解析并传入任务记录，避免记录创建重复同步探测 Windows 代码页；
覆盖前台、显式/超时后台、start 及启动前取消，保持既有输出、事件和 UI 合同。

2026-09-08 Bash shutdown：直写后主动停止仍先结算；adapter close 引用已登记的清理句柄，
等待 SIGKILL 升级及实际杀树完成。用无额外保活的独立 Node 验证后代清理；正常根退出、
事件/协议、Desktop continuous 与手机 replayable 均保持既有语义，详见 `docs/bash-background-parity.md`。

2026-09-08 Bash 进度调度：按 Node 进程/内部轮询周期共用 interval，任务独立订阅与尾读；最后一个订阅退出时释放。保留逐任务 5 GiB watchdog，协议/展示不变；测试覆盖共享、移交、并发读与迟到结果，Desktop BG14 复验。

2026-09-08 Desktop：Bash 终态通过严格 `bash_output` display 传递有界头部、截断标志与保留文件路径；界面显示部分输出提示和文件入口，运行态隐藏行数/字节数。Provider 内容和 TUI 不变，验收见 `docs/bash-background-parity.md`。

## Bash 完整文件与实时预览（2026-09-07）

当前执行合同见根目录 `docs/bash-background-parity.md`：普通 Bash 大输出保留完整文件，返回
头部摘要和路径；每秒从 4 KiB 尾窗产生 5/100 行预览及行数估计。
`ExecutionEvent -> ToolCallProgress -> legacy schema / V4 ToolCallRow.outputPreview`
必须完整传递有界预览。终态/后台清理预览，拒绝迟到事件，不物化父会话的 subagent 镜像工具。
desktop continuous 与 web replayable 保持现有交付边界；2026-09-08 按用户最终要求保留 Desktop 共享 Execute renderer 渲染，TUI 不改。

## 飞书话题原文回查

`ReadSessionContext` 增加只读 `topic` 策略及分页 cursor。该策略强制目标为当前 session，仅从可信输入元数据读取已归档话题消息，按消息 ID 或关键词返回原文及覆盖缺口，不调用抽取模型，不把用户正文当作身份。原有 relevant/handoff 保持兼容；输出继续走统一预算、trace、tool result 持久化与 UI 投影。测试覆盖跨 session 拒绝、原文去重、分页及缺口，不用合成结果代替真实飞书验证。

2026-09-22 SaveWorkflow 溯源字段：入参增加可选 `run_id`（本定义是从哪次 run 提炼出来的）。
它**不是第三条正文来源**——正文仍只能来自 `script` 或 `script_path`，落盘、权限、确认窗、结果与
预算逐字不变；handler 不读它。唯一作用是让 GUI 把「这次 run 已被保存」联接回完成卡
（`docs/dynamic-workflow/transcript-and-notifications.md`「Which workflow a run is saved as」）。
provider 可见 JSON Schema 随之多一个可选字符串字段；旧客户端与旧 CLI 不发它即缺席，行为不变。
同批次新增的两个 GUI 协议方法（`workflows/save` / `workflows/forRun`）不经模型工具面，
不改任何 tool 声明。

2026-09-28 CreateWorkflow 阶段流（phase streams）：display `causalityGraph` 增加可选
`phaseStreams`（`{from, to}[]`，≤ 128），由 bounds 层从因果图阶段商里的 `data` 边中取两端互为
`alongside` 的那些（channel 串起来的 future 阶段）求得，与 `phases` / `phaseEdges` / `exits`
同进同退。只改展示投影：工具入参、provider 可见 schema、模型可见结果、权限、执行与预算逐字不变。
三份 strict schema（contracts、协议 v3、v4 display）同步；早于 2026-09-21 的 GUI 读到新键仍整帧
失败，此后的只丢这张卡的图。合同见根目录 `docs/dynamic-workflow/presentation.md`「Streams」。

## 飞书话题自动中断归属

运行投影的 activeWorks 可选携带 sourceCommandId，取自同一 TurnStarted 的规范化输入 fact，
不由 App 按消息顺序推断。该字段与 foregroundExecutionId 共同关联自动停止的原输入，
经既有 snapshot/delta schema 和 replay 保留；缺少归属的旧事件继续兼容。不改变工具
权限、模型输入、执行调度或 continuous/replayable 边界。测试校验新轮归属与 schema
往返，随后验证 App 的中断标记。

## 工具结果收尾完整性（2026-09-24）

整批工具已有真实 `ToolExecutionResult` 后，CLI 先按声明顺序同步写入 canonical 与
turn request history，再执行 usage、媒体、ToolPart、checkpoint 等异步收尾。
存储失败仍抛原异常并结束本轮，但不得留下只有 tool call 的当前会话历史，也不得重跑已执行工具。
Stop 继续取消未完成工具；已成功结果的媒体保存不再使用该 turn 的取消信号。
只有成功持久化的结果才可沿既有路径发布 `tool_result_committed` 与 recovery anchor。
不修改 database lock、协议或数据库结构，不增加补写队列；进程退出后未持久化结果沿用现有
interrupted 冷恢复，不保证原始输出。Desktop continuous 与手机 replayable 保留既有交付边界。
完整顺序见 [streaming recovery](../model/streaming-tool-execution-and-recovery.md#tool-result-settlement)。
回归覆盖图片 Stop、真实 SQLite 锁、批次中途保存失败、媒体与 usage 失败、冷恢复和 checkpoint 取消。

## 目的

改动 tool 不是只改一个 handler 或 schema。tool 是 NL->Code 的核心边界，任何新增、删除、重命名、字段调整、执行语义调整、权限变化、输出变化、provider-native 化、后台化或 UI 展示变化，都必须沿同一条端到端链路核对。

本 spec 是改 tool 前的入口清单。具体 tool 的能力和字段仍写在同目录下的独立 spec，例如 `01-read.md`、`04-bash.md`、`13-websearch.md`。如果两者冲突，先更新本 spec 或具体 tool spec，再改代码。

## 什么时候必须看本文

以下都算 tool 改动：

- 新增、删除、重命名 tool。
- 修改 tool input/output schema、默认值、字段兼容、严格性或错误码。
- 修改 tool 是否只读、是否破坏性、并发安全、sideEffectScope、审批需求或权限匹配来源。
- 修改 tool handler、adapter I/O、超时、取消、重试、结果预算、artifact 或模型可见结果。
- 修改 tool 在 system prompt、model request tools 或 provider adapter 中的呈现。
- 修改 provider-native/server-side tool 映射，例如 WebSearch。
- 修改 TUI、ZCode app-server、debug、session replay、compact、resume、rewind 中任何 tool 相关投影。
- 修改 MCP、plugin、subagent、background task 等动态或间接 tool 接入。

Skill tool 的 telemetry 增量遵循独立规范
[Skill `agent_step` telemetry](../../../../../docs/monitoring/skill-agent-step-telemetry.md)：
resolved skill metadata 只能作为 telemetry-only 字段沿 session event、V4 fact 和既有
`agent_step` 收口链路传播；不得新增 skill description step，也不得把 SKILL.md 正文写入
高频埋点。非 `Skill` tool step 不得继承 `skill_*` 字段。

### Todo103 G13：后台 Subagent 统计重接

只扩展现有工具镜像和无正文 telemetry fact：标记后台来源、区分子工具与子 Agent 汇总，
以及记录主轮实际消费的结果组成。不改变 Agent 的参数、权限、调度、取消或输出，
不建立第二份任务状态；显式模型继续使用 Todo99 的公共有效选择解析，隐式子任务继承父执行。
模型身份仍取当前请求的扁平 providerId/modelId，不恢复旧 ModelRef。
执行规范和测试边界见根目录 `docs/monitoring/agent-step-model-token-attribution.md`；
desktop continuous 的 live 统计不能通过手机 replayable 恢复补发。

## 总原则

离线 prompt-trajectory 转换只影响调试产物：从相邻真实请求补全 response 摘要遗漏的
thinking，并识别末尾 user block 追加。默认保留真实历史改写的分段；显式
`--ignore-tool-search-changes` 仅在离线比较中忽略 ToolSearch 引用、占位文本、目录公告及
成功引用结果批次后的对应 `Tool loaded.` 提示，普通同名文本仍参与比较；
目录公告识别覆盖当前 Native／Local 文案，并保留旧日志格式的兼容性。
输出仍保留最后真实请求并标注合成模式。不改生产 tool descriptor、执行、缓存、权限或
UI 链路；合同见 [Model-IO trajectory](../../../plan/trajectory/model-io-to-anthropic-trajectory-tool.md)。

CR-01（来源提示包装）：SendMessage、RespondToCoordinator 与后台任务产出的正文只在
provider user reminder 包装时复用 source sanitizer 中和嵌套 `system-reminder` 标签。
canonical 载荷、工具输入/输出、权限审批与主子 Agent 身份不变；合法 MCS 保持原文。
正式主子 Agent 双能力轨迹需携带标签注入载荷，验证降级、compact 和冷恢复仍使用同一包装边界。

新轮后台任务通知（2026-09-12）：共享 provider 投影对 `task_notification` 复用上述包装边界，
为完整前缀和正文添加 `<system-reminder>`：整批的每条通知是一个文本块，各自包一次。Agent/Bash/Workflow 原始结果、通知批处理、
主子工具权限、持久化与 UI 可见性不变；BG25/BG36 在 MCS 与非 MCS 请求中验证 user 包装。

运行中立即发送：抢占 Core 前台执行后，输入作为普通用户消息开启新 turn，不带 `user_steer`，不并入已发出的 tool_result；工具取消、结果配对、审批、队列提升与执行轮边界不变。具体边界见 [turn steering](../loop/turn-steering.md#运行中立即发送2026-10-26)。

### 动态工作流子代理的 Browser Use

2026-09-30：dwf 子代理的 `mcp__node_repl__js` 可以驱动内置浏览器。工具定义、schema、权限与 node_repl MCP 进程不变；变的是宿主侧浏览器端口的装配：actor runtime 拿到父会话端口经 `BrowserControlPort.forChildSession` 派生的子端口，协议 broker 按登记把子会话的 workspace / clientMode 解析到父会话，下发的 `sessionId` 仍是子会话自己的（桌面 tab 归属）；run dispose 时 `closeSession({ closeTabs: true })` 关掉子代理全部 tab 并撤销登记。协议 broker 的连接记忆与子会话登记按 server context 共享（进程级 node_repl 实例与每个 app 的实例原先各存一份，生命周期因此从不到达桌面）。子代理的 skill 端口补上插件技能根（`control-browser`），不含捆绑的 `dynamic-workflows`。core `Agent` subagent 当时仍被 node_repl broker 以 `runtimeScope: "subagent"` 挡下（2026-10-09 已放开，见下节），legacy `Workflow` child 不给端口。合同见 `packages/dynamic-workflow/docs/execution-engine.md`「Subagent sessions」与根目录 `docs/zcode-protocol-model-backed-control-requests.md` 契约 4。

### Agent 子代理的 Browser Use

2026-10-09：移除「subagent 不能用 Browser Use」的限制。工具定义、schema、权限与 node_repl MCP 进程不变；node-repl-host 的 browser bridge 与 bootstrap node_repl broker 不再按 `runtime_scope: "subagent"` 拒绝（错误 `Browser is not available in subagent` 删除），node-repl-host 随之升到 0.6.1（package、manifest、官方 seed 定义、SEA 清单、serverInfo 版本同步）。core `Agent` 子代理由父 runtime 以 `forChildSession({ childSessionId, parentSessionId, tabOwner: "parent" })` 派生子端口：协议 broker 把子会话请求的 `sessionId` 换成父会话下发（桌面按它判定 tab 归属与面板展开），子代理与当前对话共用 tab，子端口 turnEnded / closeSession 不发往桌面，子代理结束只撤销登记、不关 tab；dwf 子代理保持默认 `tabOwner: "child"`。Computer Use 的 subagent 限制不变。合同见根目录 `docs/browser-use/2026-07-16-subagent-browser-unavailable-spec.md`。

### Guarded 危险命令单次确认

2026-10-19：额度停止（`stopped(provider)`，kind `quota`）带重置时刻时由宿主到点自动续跑（bootstrap `dynamic-workflow-quota-resume.ts`，见 execution-engine.md「Resuming after a quota reset」）；重置时刻在 Retry-After 缺席时从 provider 原文读出。`ResumeWorkflowRun` 的描述与终态通知改为「不要在重置前恢复」。不改工具 schema 与协议。回归：adapters 原文解析、bootstrap 自动续跑模块与 run service 集成用例、core 终态通知。

2026-10-19：动态工作流 facade 新增值 `run`（`{ id, resumedFrom? }`，两个 facade 都含），与 `args` 同一条标识符级 lowering 与沙箱注入（spawn payload 的 `run` 字段，冻结后挂 `__host.run`）；resume 时 launch 把 journal 里的 lineage 指针递给 harness，脚本两世读到同值。不改工具 schema、协议与 UI；SKILL §16.2 标记块与 `FACADE_DTS` 同步。回归：`facade-dts.test.ts` 降级、`run-identity.test.ts` 沙箱、run service 的 amend → cancel → resume 用例。

2026-10-19：`EvalWorkflowSnippet` 的 `resolveInput` 对内联与 `path` 两条来源都回填 `script`（恒等于归一化后的 `code`），PreToolUse hook、项目权限规则与另外三个工作流工具读同一个字段名。运行时 schema 加 `script`，模型面 JSON schema 不列它（与 `CreateWorkflow.script_line_offset` 同姿态）；`code` 保留给 UI 与已有 hook。回归：`eval-workflow-snippet-tool.test.ts` 的归一化与 executor 级 hook 用例。

2026-10-21：子 runtime 的工具面减掉 run 内省两件套 `ListWorkflowRuns` / `GetWorkflowRun`，范围是 workflow child、nested workflow child 和主代理 `Agent` 工具的 subagent（`resolveRuntimeDisallowedTools` 按 taskType 生效）。根因：这两个工具经 dwf run 端口读取，端口只在 app 顶层 runtime，子 runtime 按不变式不得持有（`bootstrap/src/app/dynamic-workflow-run-progress-sink.ts`），所以在子 runtime 里只会报 `workflow_introspection_unavailable`（线上 10-20：workflow child 调用 155 次，全部失败）。主会话的工具面、两个工具的 schema、权限与协议都不变；ListSavedWorkflows 仍保留。合同见 `docs/dynamic-workflow/launch.md` 的「workflow child sessions」行。回归：`runtime-tool-allowlist.test.ts`。

2026-10-19：动态工作流子代理的工具面再次减掉 `AskUserQuestion`，与 actor 系统提示「没有向人提问的工具」一致；子代理要人判断时只经 `escalate` 交主代理。权限模式继承、权限请求经父会话送达不变；不改 schema、协议与 UI。回归：`workflow-driver.test.ts` 工具面、`script-workflow-child-runtime.test.ts` 调用不产生 PermissionRequested。

2026-09-23（续）：动态工作流子代理改为继承发起会话的完整权限模式（build/edit/yolo/guarded/auto；plan 不带入，旧值 `plan` 记为 build），`run-launched.subagentPermissionMode` 记任意模式，缺席或未知值仍按 YOLO；并把 `AskUserQuestion` 还给子代理——它本就走 PermissionRequested，已由同一条父会话镜像送达确认窗。EnterPlanMode/ExitPlanMode 仍移除。见 `docs/dynamic-workflow/launch.md`「Permissions inside a run」。

2026-09-23：动态工作流子代理继承 Guarded。建 run 时发起会话为 guarded，则 `run-launched` 记 `subagentPermissionMode: "guarded"`，actor runtime 以 guarded 运行（resume 从事件读回，不看会话此刻模式）；危险命中沿既有 executor → 父 runtime 派生 broker（`createChildClientPorts`）→ user-once，origin 为 subagent、`description` 为 `<persona 名> (<siteId>@<ordinal>)`，权限窗徽标据此点名。确认窗只从父会话投影生成，所以 actor 的 PermissionRequested/Resolved/Denied 经 `notifyExternalChildSessionEvent({ interactionOrigin })` 镜像到父会话（只通知不 append，只镜像交互不镜像工具活动）。不改 matcher、审批核心、协议 schema；legacy `/workflow` 子代理仍 YOLO。见 `docs/dynamic-workflow/launch.md`「Permissions inside a run」。

2026-09-18：git push 的 refspec 含 glob 时仍按已知 `+` 前缀识别强推，不因整词 dynamic 丢失该证据；保留 dry-run、选项值与仓库操作数边界，不改解析器、审批、协议或 UI。回归覆盖 POSIX/Git Bash/CMD 识别与受控 executor 的 Guarded 批准/拒绝、YOLO 对照。

2026-09-17 review 修复（识别层，不改审批/协议/UI）：选项扫描改为二维声明 `ordering × unknown`——wrapper 与 Git 前置参数 `stop-at-operand + abort`，rm/rsync/Git 子命令 `interspersed + continue`，未知选项不再抹掉已识别的 recursive+force / `--delete` / `--force` 证据，调用方按"命中优先于 unsupported"收敛；选项表只补 Git 前置参数（`-c`、`-p`、`--exec-path` 等，abort 策略下必需），其余表保持原样。CMD 尾部重定向目标（`2>nul`、`> out.txt`）不再误判为缺目标。Bash capability 在 `bashShellSelection` 缺失时与 readonly 判定一致按 POSIX 文法匹配，不再静默退回 YOLO。子任务 broker 显式转发 `registered`；Hook 改写重判复用首次判权的 `preparedContext`。合同细节见根目录 Guarded spec §未知选项、尾部重定向与缺失 Shell 选择。

CMD 重定向目标不参与 REM 注释识别，避免 `>rem git reset --hard` 漏拦；仅修正 parser 词角色判断，复用既有 matcher → PermissionService → executor 链路，不改审批、协议或 UI。回归覆盖文件名/真正注释、Guarded 批准/拒绝和 YOLO 对照。

2026-09-15 收尾：Guarded 在模式菜单替换 Edit，旧 edit 协议/配置/策略保留，YOLO 及 full-auto/full_auto 别名不变。审批重构须保留原 evaluated(debug)、denied(warn)、resolved(info)、hook_race_forfeited(warn) 日志及 trace/tool/request 关联字段；输入仅使用原有有界结构摘要，不添加正文或高频日志。该恢复不修改请求生命周期、provider tool result、desktop continuous 或手机 replayable 边界。

2026-09-15 matcher review 修复：Shell AST 不承担程序 argv 语义；选项扫描显式声明停止策略，rm recursive + force 不再被 help/version 豁免。core 的隔离原生命令 oracle 与 Desktop 的拒绝闭环分别验收；沿既有 ToolEntry → PermissionService → executor/broker → provider result，不改协议、状态所有权及 desktop continuous / mobile replayable 路由。九项规则的豁免合同见根目录 Guarded spec。

guarded 是独立权限模式，仅此模式对明确危险 Bash 命令增加用户单次确认，原模式不变。显式 approvalMode=user-once 贯穿 broker/event/投影；Hook 输入修改重判后仍需确认时使用新 requestId，审批和执行复用 mode/input/cwd 快照。Shell 选择由既有 session shell owner 固定，matcher 与 handler 复用同一 selection，不增加 per-call clone/freeze，也不假设运行中可切换 Git Bash/CMD。普通/Explore subagent 继承保护；workflow/script child 保持 YOLO，但不得降低 guarded 父任务模式。目录、失败语义及测试见根目录 docs/dangerous-command-approval-v1-plan.md。

broker 对 `userInteraction` 请求返回的答案虽然通过 `modifiedInput` 传递，但只完成本次问答，不重新判权；用途来自原权限决定，应答来源来自 responder race。Hook 改写仍走重判，答案仍走原 schema/handler 校验，不新增 UI 或传输层状态。

统一 executor 请求生命周期，不为 user-once 另建审批流水线，不递归重跑 Hook。改写统一 normalize/schema；撤回重构额外引入的 ToolEntry.validateInput 复验，工具语义预检仍只在首次模型输入、PreToolUse 之前执行，handler 自身校验不变。Hook 修改后的权限判断保持，旧 ID 先收口，新输入必要时创建新 ID。2026-09-15 用户确认：Guarded 的可信 broker allow/modify + modifiedInput 表示已批准最终输入，校验并冻结后直接执行，不额外重判/申请批准；来源只取 responder race，不采信载荷自报。原模式范围不扩张，非法输入、取消与 user-once 持久化响应仍拒绝。登记先于交互发布，终态仅一次；取消/超时/错误保留结构化类型。Guarded 自动化无人在线保留待审批，CLI 重启沿已有 hydrate 中断收口；严格 mode 提交失败时不执行 firstInput。协议集成验证修改后只执行一次、一个请求终态；Desktop 回归 Hook 替换及原批准路径，不新增输入编辑控件或第二份 pending。

1. 先写 spec，再实现。spec 至少说明能力、输入、输出、权限、副作用、失败路径、结果预算、事件、UI/ZCode app-server 投影、测试覆盖和迁移策略。
2. 先补契约，再连实现。跨 LLM、provider、tool executor、session store、ZCode app-server、MCP 或插件边界的数据必须有 runtime schema 或可校验 JSON Schema。
3. 外部 I/O 只走 adapter/port。core/tool handler 不直接调用 `fs`、`fetch`、`http`、`child_process`、`process.env`、系统剪贴板或数据库。
4. 权限、调度和审批读取 tool 声明，不依赖调用点临时猜测。
5. 大结果不直接回灌模型上下文，必须走 `resultBudget`、摘要、预览或 artifact/storage。
6. 所有 tool 调用必须传播 `traceId`，并继续带上 `sessionId`、`turnId`、`toolCallId`、`spanId` / `parentSpanId`。
7. 修改 tool 后必须有测试证明新契约生效，并覆盖关键失败路径。
8. WebFetch 不做外部 domain safety service 前置校验。网络安全边界由 URL
   runtime schema、用户/项目 permission rules、统一 `HttpClientPort`、safe redirect
   策略、代理/证书配置和审计事件共同承担；tool handler 不应在目标请求前依赖第三方
   domain_info 服务决定是否允许 fetch。

### 能力条件化 tool shape

当 tool 字段只对部分模型能力开放时，provider-visible contract 与 executor 的实际校验必须来自同一份当前 turn 能力快照：

```text
current turn model capability
          |
          +--> provider tool descriptor / JSON Schema
          |
          +--> executor resolved ToolEntry / JSON Schema
          |
          +--> handler capability branch / timeout budget
```

- 禁止只修改 `getTools()` 返回的 descriptor，而让 executor 继续使用 registry 中的静态 schema；这会产生“模型可生成、运行时必拒绝”的断层。
- `false` / `undefined` 的能力值不得回退到旧 session model；同步 subagent 借用 turn 私有模型时尤其要保持 snapshot 语义。
- 动态 schema 解析只能改变 provider/validation contract，不得复制 handler、权限、Hook、trace 或结果序列化生命周期。
- Read PDF 是当前实例：`supportsPdf=true` 时 `description` 和 `pages` 同时出现；否则保留原 Read shape。`pages` 分支还要独立检查 `supportsImages`，因为原生 PDF 与页面图片是两个能力。
- runtime、subagent、project-memory agent 和 workflow child 必须继承同一个外部 I/O port；不得出现某个执行环境暴露字段但缺少 adapter 的情况。
- `submit_result` 是第二个实例（2026-09-13）：动态工作流子代理按编译期 submit profile 拿到**不同的**
  `inputSchema`——`mono` 子代理的工具声明就是 `{ result: <该 ask 的 schema> }`，`generic` 子代理仍是
  任意 JSON。两者共用同一个 handler、同一条 `workflow.submitResult` 权限与同一个 `stopTurnOnSuccess`；
  引擎侧校验对两者一致。contract 上的 `strict: true` 只是**资格**声明，adapter 按 provider/model 决定
  是否真的下发，并把 strict 子集表达不了的约束折进 description 而不是丢掉
  （`packages/dynamic-workflow/docs/execution-engine.md` § Typed `submit_result`）。
- 结构化媒体结果必须通过真实 provider projection 与冷恢复链路验证，不能用直接调用 handler/adapter 的测试代替端到端证据。

### Windows CUA 开发运行时接入（已确认）

Windows 本地源码开发环境新增的仅是 Host backend 对 Windows Computer Use Helper 的
admission / execution route。它在 `win32` 上显式校验 `ZCODE_CUA_DEV_ROOT` 的
package、Helper entry 和 native addon，并使用 `process.execPath` 加
`ELECTRON_RUN_AS_NODE=1` 启动 Helper；该阶段不得注入 broker token。

现有 30 个 CUA MCP tools 的名称、输入/输出 schema、副作用标注、权限和
delivery-state 语义均不变：不新增、删除或重命名 tool，不改变 provider-visible
surface，不改变 session event、replay、compact、resume 或 UI/ZCode app-server 投影。
非 Windows、remote、无效开发根目录或缺失产物一律 fail closed，且不得回退到
macOS Helper。测试需覆盖平台门、稳定失败 reason、异步文件系统检查与最小诊断。

显式禁用工具必须 fail closed。会话级 `toolDenylist`（ZCode Protocol
`session/create`）不只是执行期权限规则，还必须从
provider-visible 内置工具和 MCP 工具注册中移除对应工具。测试需要同时覆盖
模型可见工具面和执行期权限路径，避免“禁用了但模型仍能看到/调用”的假安全状态。
CLI 的 `--disallowed-tools` / `--disallowedTools` 通过本次 runtime 的
`toolDisallowlist` 从可见与可执行工具集中移除整个工具，不改写 permission config。
`Bash(git *)` 只按工具名 `Bash` 过滤，不提供命令内容匹配；help 使用 `"Bash Edit"`
等工具名示例。CLI prompt 入口为 `-p, --prompt <text>`；未实现的 `--print`、
`--settings`、`--permission-mode`、`--max-turns`、`--allowed-tools`、
`--allow-main-worktree-yolo` 不得作为可用能力展示。完整语义见
[CLI 工具可见性 Denylist](./18-cli-tool-visibility-denylist.md)。
ZCode Protocol `session/create` 也属于同一条链路：App 或评测 harness 如果需要
session 级工具面约束，应通过协议参数传入 `toolAllowlist` / `toolDenylist`，
并在创建 runtime 时同步投影到 `runtimeConfig.toolAllowlist` /
`runtimeConfig.toolDenylist`。不要依赖 prompt 文字要求模型“不要用某些工具”，
因为 provider-visible tool surface 才是实际可调用边界。

Structured-media tool-result projection is selected by `apiFormat` first.
Anthropic Messages and OpenAI Responses (`providerKind=openai`) keep structured
tool-result content. OpenAI Chat Completions (`apiFormat=openai-chat-completions`)
does not have a reliable structured-media tool-result channel through the AI SDK
chat converter: `tool-result` content is serialized into provider-visible text.
When `apiFormat` is absent, only the known Chat-compatible provider kinds
(`openai-compatible`、`gateway`) use that fallback; `providerKind=openai` remains
the Responses path. Chat provider adapters must therefore keep the actual tool
result as short text and, when the target model supports the media type, append
supported media as a synthetic user content message after the contiguous
tool-result block. This preserves assistant tool-call / tool-result ordering
while preventing base64 media from being tokenized as plain text.

MCP 动态 tool 还需要额外确认：

- Tool advertisement 与 live execution 权限必须分离。可信官方 HTTP MCP 的 `server/discover`、
  `initialize`、notification、`ping`、`tools/list`、GET probe 与 `tools/call` 都必须逐请求取得并注入
  当前身份头；服务端仍只在 `tools/call` 做执行授权，catalog、connected status、cached descriptor
  或历史成功不得充当执行授权。可信官方 stdio MCP 同样必须在 `server/discover`、`initialize`、
  notification、`ping`、`tools/list` 与 `tools/call` 的 `params._meta["com.zcode/official-mcp-auth"]`
  注入当前身份载荷，禁止把凭证放入进程 env。调用期无身份或无权益应返回结构化 tool error，
  不得反向把 server 置为 failed 或移除已广告工具。普通 HTTP/stdio MCP 不得获得官方凭证通道。
- 注册时必须保留 server 级执行策略，例如 `timeoutMs`。长任务 MCP server 不能在 core bridge 中被硬编码短超时截断；bridge 应把 descriptor 上的超时投影到 `ToolEntry.metadata.timeoutMs`、`timeout.defaultMs` 和实际 `McpPort.callTool` 选项。
- 一次 MCP tool call 的 `timeoutMs` 是端到端 caller 预算，必须覆盖等待已有连接、第一次
  `tools/call`、共享 OAuth 恢复、Phase 1 重连和最多一次安全重试。各阶段只能消费剩余预算，
  禁止在重连或重试时重新获得一份完整 timeout。
- MCP OAuth 授权/重连是 adapter 持有的共享恢复任务，不归任一 tool caller 所有。caller 的
  timeout 或 AbortSignal 只能结束当前 waiter，不能关闭 callback listener、释放共享授权 lease
  或取消其他 caller 正在复用的恢复；只有显式 disconnect、adapter/session shutdown 或 connection
  generation 换代可以取消共享恢复。
- MCP 连接与授权状态必须在所有成功、失败、取消和外部 I/O 异常路径收敛到
  `connected`、`failed` 或 `disconnected`。`record.connecting` 不得以 rejected Promise 配合
  `status: connecting` 留在记录中；单 server OAuth 编排失败必须先收敛自己的状态，不能让批量
  server snapshot 因裸异常整体中断。
- 显式 modern protocol pin 的 version probe 是唯一协商路径，必须继承 server 的完整连接 `timeoutMs`；只有允许 legacy fallback 的 `auto` 模式才可使用有界短 probe。pin probe 超时不得伪装成 legacy server 或静默丢工具。
- MCP server 自己实施的调用超时必须与 `tools/list` 描述、输入 schema 和具体 tool spec 保持一致；修改默认值时要由同一命名常量驱动执行与模型文案，并用契约测试防止二者漂移。
- 可选超时字段的 provider-visible 描述不能只写字段类型；必须给出模型可执行的决策规则，包括何时必须显式传值、如何为预计执行时间预留开销，以及超过上限时应拆分调用。
- MCP server 可在 result `_meta` 中声明 namespaced 的 `zcode/errorPresentation: "message-only"`，要求通用 bridge 在 `isError: true` 时直接投影 content，不额外添加 `MCP tool returned an error:` 包装。该能力只控制模型可见文案，不得被当作失败状态本身；失败事实仍以标准 MCP `isError` 为准。`node_repl` 生产端不得声明 `message-only`：它直接把经过脱敏的结构化 `run.error.message` 写入 content，并让通用 bridge 投影稳定的 `MCP tool returned an error:` 前缀，供不读取私有 `_meta` 的分析链路区分成功与失败。错误结果不得混入错误类型、`at ...` 堆栈帧或失败前的 REPL 日志。通用 bridge 禁止按 `serverName` 分支或解析具体错误正文。本调整不修改 `ToolResultPayload`、session event、持久化、UI 或 desktop continuous / web remote replayable 链路。开发态 desktop agent 构建必须同步重建 `@zcode/browser-use-plugin` runtime，确保插件缓存 hash 能感知这类生产端变更。
- 标准 media result 不应无条件降级成文本占位。`image` block 应进入 provider-neutral `ModelMessageContent`，让 screenshot/visual inspection 类 MCP 能力和内置 `Read` 图片路径一致；不支持的 media 再返回短占位并受 result budget 约束。
- 官方 CUA 的最终 raster 是坐标输入的一部分，不是普通可优化媒体。只有通过 Host authority 校验的官方 `zcode-cua` descriptor 可以启用该路径；每个 image 必须紧邻精确形态的 `image_ref {frame_id,width,height,actionable}`，bridge 必须校验 canonical base64、PNG/JPEG 文件头、MIME、实际尺寸、200 KiB 上限和单结果 `frame_id` 唯一性，并保持 bytes 与 block 顺序不变。`PostToolUse` hook 文本是这批 tool result 之后的附件，不进受保护的结果，不能替换或重排媒体对。任一校验失败时必须原子移除本次结果中的全部 CUA image/image_ref 并返回错误，禁止只留引用、只留图片或退回 artifact/文本占位。第三方同名 MCP 仍走通用 result budget，不能获得豁免。
- official CUA 结构化结果在 Host 内只由 `modelContentProtection=official_cua_frame_v1` 表示；不要再增加或恢复并行 preserve boolean。`returnedBytes` 是文本与真实媒体载荷的唯一 aggregate，hook 文本不进 tool result，不计入它；不能依赖第二份 `mediaBytes` 镜像状态。
- shared `node_repl` 内的 CUA SDK 不得把 producer 的 legacy MCP 文本 envelope 原样再提交给模型。成功的纯文本 action/metadata 结果只在 Worker 中归一化为 SDK 字段；若还需向 Host 传递 app-display `_meta` 或 action-state，structured sink 必须使用空 `content` 的 sideband projection。只有错误或受保护的 image/`image_ref` 结果可以携带模型可见 `content`。这样同一 cell 末尾的 `nodeRepl.write(state.text)` 是唯一 AX 文本来源，不会与动作回执或 `content`/`text`/`message` 镜像叠加。
- official CUA plugin-host 恢复 broker token 前只校验真实权威事实：bundled official plugin id、已捕获的 authority/token 和与捕获值完全相等的 socket。`--permission-mode product` / `--backend broker` 从未参与 producer 运行时决策，不得再注入或当作安全凭据；注入 canonical socket 时必须清掉 `--` terminator 之前的旧标签，混版本配置不能继续把伪安全状态传给 producer。任一真实凭据缺失或漂移仍必须在 import 前 fail closed。
- official CUA 的目标应用图标不得依赖模型重复输出 `bundle_id`，也不得由 Renderer /
  Desktop main 按 PID 反查。producer 必须在统一 tool invocation 中根据 session
  `state_id`、frame registry `frame_id`、Helper `application_info` 或 capture 结果解析
  权威身份，并只通过 namespaced result `_meta` 输出展示 locator。Core 仅在 official
  authority gate 后将其投影到 versioned tool-result display；live、persisted、desktop
  continuous 与 web-remote replayable 必须消费同一字段，禁止 UI 反向解析普通结果文本。
  具体契约见
  [CUA 目标应用展示元数据 Spec](../../../../../docs/cua/2026-08-19-cua-target-app-display-metadata-spec.md)。

插件兼容动态 tool 还需要额外确认：

- Claude/ZCode plugin 只通过现有 skill、custom command 和 MCP 投影进入
  runtime；core 不直接读取插件 manifest 或插件目录。
- 插件 MCP server 的变量展开、server name 规范化、timeout、trust gate 和
  permission 声明必须在 MCP tool 注册前完成，避免 provider-visible tool
  名称和实际 server 配置漂移。
- 官方内置 plugin 的 MCP tool surface 由各 plugin 自己的 MCP server schema
  声明，例如 `ios-simulator` 与 `android-emulator`。新增官方 plugin 时，
  `.zcode-plugin/plugin.json`、缓存 seed、SEA asset manifest、skill/command
  文案和 bootstrap/plugin tests 必须一起更新，确保模型看到的
  `mcp__<normalized-server>__<tool>` 名称与缓存中实际启动的 server 一致。
- 官方 Android plugin 的 target 类 tool 必须同时覆盖 USB 真机和 emulator。
  `serial` 表示已连接 Android target，不应被当成 emulator-only 字段；
  target 类 tool 无 `serial` 时可以选择 ready target，并且只在没有 ready
  target 时才兜底启动 GUI emulator；`android_start_emulator` 只负责启动新的
  GUI emulator，不负责复用既有 target；复用既有真机或 emulator 时，后续
  target 类 tool 应直接传入已知 `serial`。

## 大内容兜底要求

大内容 tool 需要在自身语义层先限制结果，再让 executor 的 `resultBudget` 作为最后保险。

- formatter 已对某个输出自行限长时，tool 可以声明 `isModelContentBounded(output)`；返回 `true` 的输出不再按 `resultBudget` 落盘或截断。只用于有确定上限的文本，例如 Bash 失败结果的头尾截断；executor 不按 tool 名称判断。
- `Read` 文本默认规则：未显式传 `limit` 时，如果文件总大小超过 `256KB`，返回稳定错误并提示使用 `offset` / `limit`；显式传 `limit` 时，必须按完整文件的真实行区间读取，而不是先截断头部再切片。
- 用户提交的文本附件通过合成 `Read` 调用/结果进入模型上下文时，同一附件生成的 reminder body 使用单换行连接，不同附件仍使用双换行；超过默认 `2000` 行上限时，模型可见提示必须明确“first 2000 lines”并提示按需继续读取该文件。
- `Read` 文本选中内容还需要经过 `25_000` token 输出预算校验；超过时返回稳定错误，让模型缩小 `offset` / `limit` 范围。
- `Read` 的 `offset` 是模型可见行号语义，`0` 和 `1` 都表示从第 1 行开始；adapter 内部使用零基行偏移，避免跨层歧义。
- `Read` 图片默认走多阶段媒体保护链路，最长边上限使用 `2000px`：先按真实图片 bytes 和 magic bytes 判定空文件、格式和尺寸，再在 `ImageProcessorPort` 中完成 5MB base64 API 上限、3.75MB raw target、2000px 尺寸上限和可选 token budget 压缩。图片结果必须只以 provider-neutral media block 回灌模型，不得附加尺寸说明文本，也不得把 base64 当普通文本回灌；原始尺寸、展示尺寸和坐标比例保留在结构化 output，供 UI、debug 和后续内部能力使用。
- 图片、PDF、其他二进制文件和视频在最终 provider request 投影中共用 `40MiB` 聚合预算，
  统一按完整 data URL 字节数计量；单个视频的 `30MiB` 原始文件上限仍由输入/Read 层校验。
  预算只修改请求副本，不能删除 session transcript、tool result 或 artifact，也不能由
  单个 tool 增加专属豁免。单张图片的 5MB API 上限和聚合预算是两条独立边界。
- `Read` 视频只支持已登记格式，默认输入上限为 `30MiB`；不转码、不压缩，读取后以 provider-neutral video block 回灌模型。超限返回稳定错误，model-I/O 不得记录完整 base64。
- `Bash`、`WebFetch` 等天然可能产生大输出的 tool 应返回摘要、tail/head preview 或 artifact 引用；不能把完整 stdout、HTML、JSON、二进制或 base64 直接塞回模型上下文。
- provider-neutral tool result message 必须携带 `isError` 语义，并由 adapter 映射到 provider 能理解的错误结果形态，例如 AI SDK `error-text` / Anthropic `is_error`；不要只靠把 `{ "error": ... }` 混进文本内容表达失败。
- `js` 的模型可见错误只能序列化一次 `name + message`；若保留 stack，只追加 stack frames，不得再次
  输出 stack 首行中的同一 `name + message`。浏览器错误应在原有稳定 error code 下附带有界的恢复
  提示，不能要求模型解析重复正文或依赖错误字符串决定结构化状态。
- Compact/runtime 可以在请求前对历史旧 tool result 做 provider-visible microcompact projection，但只能替换模型可见内容为稳定占位符或 artifact 引用；不得删除原始 tool part、session transcript、artifact、checkpoint 或破坏 assistant tool call 与 tool result 的配对。该 projection 必须有结构化事件、traceId、pre/post token estimate 和测试覆盖，resume 时不能把 microcompact 事件误当作 full compact boundary。
- `Bash` 模型可见结果默认规则：返回 stdout/stderr 文本、必要的中断标记、stale read 提示和 artifact 预览，不把 `status`、`exitCode`、bytes、path 等结构化 `BashOutput` 字段 JSON 化给模型；这些字段只供结构化 output、事件、UI/ZCode app-server 和 debug 使用。Bash `isError` 语义只表示命令被中断/取消，非零退出码仍通过文本输出和结构化 `status` 暴露。
- `Edit` / `Write` 成功结果模型可见内容保持短确认；完整内容、diff 和 patch 只能进入结构化 output、事件、UI projection 或 artifact。
- 新增大内容能力时必须在具体 tool spec 中写清：原始大小上限、模型可见上限、是否报错还是截断、artifact 策略、错误码、UI/ZCode app-server 投影和测试用例。

## 文件 Mutation Tool 对齐要求

`Read`、`Write`、`Edit` 是同一条受控文件变更链路，不应被当作彼此独立的薄 handler 修改。任何影响三者之一的行为变更，都必须同步检查：

- 模型可见工具说明：是否清楚表达 `Read -> Edit/Write` 的读前写入约束、`old_string` 匹配规则、行号前缀剥离、缩进保真、唯一性、`replace_all` 语义、优先编辑既有文件和 emoji 仅按用户显式要求加入的边界。
- 编辑兼容链路：`Read` 模型可见行号格式变更时，必须同步检查 `Edit` 的行号前缀兼容、模型提示、历史日志回放、测试快照和错误提示；不能只改一端。
- 手工补丁链路：`ApplyPatch` 这类结构化文件 mutation tool 必须和 `Edit` / `Write` 共用 edit 权限、diff projection、失败无副作用语义和 `FileSystemPort` I/O 边界。
- 运行时状态：`Read` 是否记录完整 read cache，`Edit` / `Write` 是否消费 read cache、mtime/revision 和 partial read 状态。
- 文件保真：`Edit` 是否保持原编码和原换行风格，`Write` 是否按完整内容写入，并且所有文件 I/O 都通过 `FileSystemPort`。
- 文件内容契约：`FileSystemPort.readTextFile` 返回给 core 的 text content 应是 LF 规范化后的 Unicode 逻辑内容，并通过 metadata 暴露原始 `encoding` 与 `lineEndings`；`Edit` / `Write` / `ApplyPatch` 需要保真写回时必须把这些 metadata 传回 adapter，而不是在 handler 中直接接触底层 bytes。
- 文本编码边界：filesystem adapter 负责 BOM、UTF-8、UTF-16LE 以及常见中文 legacy 编码（GB2312 / GBK / GB18030）的检测、解码和写回。模型可见工具说明只表达“复制 Read 的逻辑文本即可”，不要要求模型猜测或传入编码参数。新增编码能力必须覆盖读、范围读、编辑、完整写入、结构化 patch、不可编码字符失败和二进制误判保护。
- 大文本采样边界：`4096` 字节样本末尾的 UTF-8 候选按缺少字节数补读后再严格校验；未完成状态不能直接确认 UTF-8，非法续字节进入原有 legacy 检测。正文继续共用流式 decoder。按 [Read 文本大文件预算](01-read.md#文本大文件预算) 覆盖短读、EOF、ASCII 前缀后的 GB 字符与附件最终 provider 请求；不把有限采样视为全文件编码保证。
- 错误契约：未读、partial read、stale file、匹配失败、多处匹配、notebook、权限拒绝和文件过大必须有稳定错误码，不能依赖英文错误文本判断流程。
- 模型结果序列化：文件变更成功时只返回短确认文本；完整内容、diff 和 patch 留给内部 output、事件、UI projection 或 artifact。
- Read 模型可见序列化：文本读取结果必须用专用 `formatModelContent` 输出 cat-n 风格行号文本，不得回退到 JSON 字符串化，否则 tab、换行等会被转义并污染后续 `Edit.old_string` 精确匹配。
- 路径边界策略：当前版本只负责把相对路径按 session cwd 解析并规范化为绝对路径，不在 core `path-policy` 层硬拒绝 workspace 外路径；读写审批、deny/ask 规则和 adapter 能力边界后续统一收敛到 filesystem permission adapter。
- Memory 文件例外必须走同一最终权限边界：project Memory 与 custom-agent Memory 只对各自
  root 内、不包含既有敏感 path segment 的严格小写 `.md` Write/Edit 自动授权，并保留既有
  显式 tool/path deny、project ask 与 hook ask。不得因此补 Read、改变普通 Bash 权限，或让
  child runtime 继承 Main 的 Recall/Extraction/Dream 状态。
- UI/ZCode app-server/Debug 投影：diff preview、权限请求、tool result、trace 和日志应消费结构化 output，不反向解析模型可见文本。
- TUI `Edit` 文件 diff 投影必须保持审计信息紧凑：生命周期标题使用动作名加文件路径；路径在当前 workspace 内显示相对路径，workspace 外保留绝对路径；输入字段中的 `file_path` / `replace_all`、diff 标题行和 hunk header 不作为默认结果行重复展示；正文 diff 消费结构化 hunk，由 TUI 内部按终端宽度渲染 unified 或 split。语法高亮使用 Shiki tokenization，再转换为 OpenTUI `StyledText`，语言从文件路径推断；Shiki 不支持、加载失败或超过本地预算时必须降级为纯文本 diff，不能影响 tool result 展示。
- TUI 侧边栏的 current-session modified-file 统计只能消费
  `tool_call_result.payload.result.display` 里的安全 diff 摘要；不得反向解析模型可见
  tool result 文本、读取 git/文件系统或依赖具体 handler 内部结构。
- 文件 mutation tool 的 diff display 必须同时进入持久化的 tool part metadata。
  live TUI/ZCode app-server 可以消费 `tool_call_result.payload.result.display`，resume / session load
  必须从 `part.data.state.metadata.display` 重建同一份 bounded UI 投影，不能依赖内存
  event replay，也不能反向解析 `completed.output` 的模型可见短确认文本。旧 session 中
  缺少 metadata 的 tool part 按 legacy output 展示，不伪造无法可靠还原的历史 diff。
- 工具性能观测字段必须进入结构化 output / result metadata，例如 `perf`，不得塞进模型可见
  tool result 文本，也不得要求 UI 反向解析文本。Bash / Write / Edit 的 `perf` 只允许包含
  耗时、大小、退出码、低基数分类和脱敏 hash，不包含原始命令、文件路径、文件内容或 diff 内容。
  permission wait 发生在 executor 层，应由 executor 合并到 tool result perf，而不是由 handler 猜测。
- Runtime 的 `ToolExecutionTelemetry` 使用按 `kind` 判别的 nested `detail`，V4
  `tool.lifecycle.performance` 继续使用既有扁平 allowlist。CLI fact normalizer 必须逐字段映射，禁止
  直接 spread/透传 `perf`、`detail.command` 或 `detail.filesystem`；本地诊断用的
  `command.hash` 不得进入 V4 fact。严格 schema 失败会丢弃整条工具终态 fact，使 Renderer 只能在
  turn terminal 兜底关闭 tool step，进而污染 `/event/report agent_step` 的时长、状态和失败归因。
  回归测试必须同时覆盖真实 Gateway 的 command/filesystem/patch 映射，以及 supervisor 在真实工具
  terminal 立即收口 `agent_step`、随后才上报 `message_completion` 的出口时序。

本链路当前按阶段推进：先补 spec、模型指导和短结果序列化；随后补 read cache、stale guard、匹配校验、文件保真、权限安全和 diff UI。

## Browser automation tool 对齐要求

Browser use 虽由 `js` REPL 驱动，但其 capability manifest、模型文档、backend 生命周期与错误文本
共同组成模型可见工具契约。修改其中任一层时必须同步检查：

- Node REPL 的模型可见身份必须来自真实 `node_repl` MCP server，工具名只有
  `mcp__node_repl__js`。它是 Browser Use 与 Computer Use 共用的宿主入口，不是 browser 专属：
  两个插件各自只携带 skill、docs、client 脚本与 native 依赖 root，宿主产物由 `node-repl-host`
  seed 单元提供；不得再用 core 裸 `js*` tool 伪装 MCP 边界。
- `js_reset` 与 `js_add_node_module_dir` 已于 2026-09-18 整体删除（工具面 + handler + schema +
  moduleDirs 执行链），不得以“兼容”为由重新加回。两者实测调用量均为 0。
  `js_reset` 自 fresh-kernel 改造起就是空操作（每次 `js` 已是新 kernel），却每轮占用工具定义
  token，且因为“永不失败”会让弱模型陷入连续重复调用（工单 ZCT-2100503886992535552：155 次
  连调、4837 万输入 token）——工具不存在时 `Tool not found` 的失败结果才是模型换策略所需的信号。
  `js_add_node_module_dir` 则是把宿主职责推给模型：模型无法自行知道该传哪个 `node_modules`，
  能告诉它的只有 skill 文档，而文档知道的路径宿主自己就能注入。将来若官方 skill 要携带第三方
  包，走宿主注入，不要再给模型开配置工具。
- 模型代码的 import 因此只支持 `node:*` 内置模块与基于 skill root 的绝对 `file://` URL，裸包名
  不解析。两个官方 SDK 的 bootstrap 本来就是这个形态。
- 删除只作用于可执行路径。历史回放渲染仍依赖 `packages/shared/src/tool-identity.ts` 与
  `packages/ui/src/lib/nodeReplToolDisplay.ts` 里的名称映射：那两处只读取历史 transcript 里的
  toolName，与当前 `tools/list` 无关，删掉会让旧会话的调用块退化成 unknown fallback renderer。
  回放合同与模型可见面是两件事，不要一起删。
- Node REPL MCP server 通过 `@zcode/core/repl` 复用执行引擎，browser client 通过
  `@zcode/core/browser-client` 接入；禁止从 core 总入口打入 Agent、Bash 注册表和工作流编译器。
  App、普通 CLI、SEA 保留现有 plugin-host 适配与工具合同，构建依赖图和真实 bundle 握手/执行
  共同验证该边界，详见根目录 `docs/browser-use/browser-use-plugin-runtime-boundary.md`。
- plugin-host 在 CLI main 中先于通用 Agent runner 和 Provider 模块导入分流；保留环境清理、
  SEA 工具准备、broker 鉴权、argv 与退出合同，禁止把插件参数当作 Agent 配置参数。
- MCP server 的 JS schema、结果元数据和 browser broker 协议经各自公共子入口导入，
  不求值 contracts/shared 总入口；保持原 schema 与协议实现，不复制轻量版校验。
- MCP tool call 必须把 session/turn/trace 放入 request `_meta`；browser bridge 必须经当前 session 的
  受认证本机 IPC broker 回到 `BrowserControlPort`。禁止 MCP child 直接引用 desktop/main/runtime 具体实现，
  也禁止按 cwd/workspacePath 猜 session 身份。
- official plugin host 只在调用插件 `main()` 期间短暂恢复 CUA Helper 的 socket/token；`serveStdio`
  的 server factory 则延迟到 MCP initialize 才执行。因此 `node_repl` 必须在 `main()` 返回前捕获并
  构造 shared-host CUA runtime，factory 只能复用该 runtime，不能再次读取 `process.env`。Worker 只接收
  runtime 创建的二跳 bridge socket/token，禁止得到 Helper 原始凭据：

  ```text
  plugin host 恢复 Helper env
              |
              v
      node_repl main() -- capture --> shared-host CUA runtime
              |
              +-- return --> plugin host 清理 Helper env
              |
      MCP initialize --> deferred server factory --> captured runtime
  ```

- `tabs.list()` 返回 `TabInfo[]`，恢复控制时必须再用 `tabs.get(info.id)` 取得 `Tab`。受控列表为空
  不代表 backend 断线；若要继续控制用户可见页，再检查 `browser.user.openTabs()` 并显式 claim，
  最后才允许创建新 tab，避免重复页面。
- turn 结束只取消该 turn 的 pending browser request，不能隐式关闭 tab。当前 IAB 和 CLI managed
  CDP 都让受控 tab 在同一进程/session 内跨 turn 保留；`tabs.finalize()` / handoff / deliverable 只在
  backend 真实支持时表达状态，不赋予 omission 删除语义。IAB `closeSession` 释放可见 tab 给用户，
  CLI managed CDP `closeSession` 因没有用户可见 surface 而关闭该 session context/page，并在没有剩余
  context 时回收自己启动的 Chromium。该差异必须由 descriptor capability/override 准确裁剪。
- CLI headless Browser Use 只能由显式 `--browser-use=headless` 启用，descriptor 必须在真实 Chromium
  launch + CDP handshake 后以 `type: "cdp"` 返回；`headless` 是 launch mode，不是第四种 backend。
  browser-use plugin 禁用、executable 缺失、handshake 失败时不得返回 stub，也不得启动后静默降级。
  `--prompt`/TUI 可以注入 managed port；ZCode app-server、Desktop 和 mobile shared-host 链路不得因此
  另起独立 browser runtime。
- stale/missing tab、locator strict violation 与 locator timeout 必须保留稳定 error code，并在 message
  中给出恢复路径。strict violation 要求 fresh `domSnapshot()`、`count()` 和更窄的 snapshot-proven
  locator，禁止把 `first/last/nth` 当作消歧捷径；timeout 要求刷新 DOM 并检查 count/visibility，禁止
  原样重试或猜测 snapshot 中不存在的 role/name/selector。
- `playwright.domSnapshot()` 是页面理解、元素发现和 locator 构造的默认事实源。只要最新 snapshot
  仍有效且已经包含目标，模型必须直接复用其中的 role/name/text 等事实，不得为了“查看页面相关元素”
  再用 `playwright.evaluate()` 扫描 `input`、dump HTML、遍历 DOM 或猜测 CSS selector。snapshot 信息
  不完整或交互后可能过期时先刷新 snapshot；只有 snapshot 与 locator 读取都无法回答一个有界、只读
  问题时，才允许把 `evaluate()` 作为最后手段。
- Playwright locator 的 `TextMatcher` 契约同时接受字符串和 `RegExp`。`node_repl` 在独立 VM Realm
  执行模型代码，因此 matcher 类型识别不得依赖当前 Realm 的 `instanceof RegExp`；必须接受跨 Realm
  正则并保留其 source/flags 序列化结果。该兼容修复不改变 Browser Use 的权限、副作用、事件或输出
  契约，并且必须由真实 VM 创建的正则回归测试覆盖。
- Node REPL Browser broker 的请求关联也属于 tool 失败契约：收到合法 UUID 后，即使后续严格 schema
  校验失败，错误回包仍必须携带该请求 UUID。禁止在 parse/schema 错误路径生成无关占位 id，否则
  client 会把真实参数错误覆盖成 `response id mismatch`。
- `playwright.evaluate()` / `locator.evaluate()` 在页面上下文执行传入的 JavaScript，可用于页面计算或状态变更；
  当高层 locator/action API 无法表达目标意图时使用，并保持脚本聚焦、结果可观察。
  该错误只表示当前 browser command 失败，不表示 IAB/tab 崩溃。
- 普通 browser side effect 不自动截图；DOM-first 观察、显式截图和工具面板 preview metadata 是三条
  独立通道。本阶段仍不生成仅供工具面板预览的截图 metadata。
- App 在提交新一轮真实用户输入前，应以只读方式获取当前 window/workspace 可见的 IAB tab 摘要，
  通过独立的 `browserAmbientContext` 协议字段传给 runtime。core 只在 provider-visible 的本轮 user
  content 中生成 `<in-app-browser-context source="ambient-ui-state">`，持久化/UI 仍保留用户原始输入。
  该上下文只是环境事实，不能推导用户显式选择 IAB，也不能改变 desktop continuous 与 web remote
  replayable 的路由边界；读取失败必须无副作用降级为无 ambient context，且日志不得记录完整 URL。
- `goto()` 的成功/失败必须以页面最终状态为准。Electron `loadURL()` 返回 `ERR_ABORTED` 时，如果同一
  次导航已被站点重定向或 SPA 接管，并且当前 document 已提交到与目标等价的 URL，应返回成功；
  当前 document 未提交、仍停在旧页或发生真实网络失败时仍返回结构化错误，不能统一吞错。
- App/Agent 滚动升级期间，新增的 provider-only browser 字段必须进入 session/send 可降级字段集合。
  兼容解析要接受 `Invalid params` 和附带摘要的 `Invalid params — ...` 两种消息，并只依据结构化
  `unrecognized_keys` issues 决定省略字段重试。desktop 的 `dev:local-cli` 必须在启动前重建 CLI bundle，
  避免 resolver 优先命中旧 `dist/zcode.cjs`，形成“App 新协议、Agent 旧协议”的假回归。
- 模型文档、skill 与 `js` tool description 必须使用一致的 browser 选择和恢复顺序：目标 URL 用
  `getForUrl(url)`，无目标才用 `getDefault()`；跨 turn 先复用 browser binding，再按 controlled tabs →
  user tabs → new tab 恢复。一次直接 URL 尝试失败后禁止循环猜 URL、路径或资源 ID，应改用最新 DOM、
  站内搜索或目的型 connector/API/CLI 查到可验证目标。
- 变更必须覆盖 IAB turn/session lifecycle、locator error、JS model serialization、snapshot-first / read-only
  evaluate 模型指导和按 manifest 条件选择文档的测试；新增 provider-only ambient context 时只扩展
  `session/send` 的 strict schema 与 runtime request assembly，不新增 session event，不把 ambient state
  写入用户可见 transcript。

## 端到端链路

### 1. 设计文档

位置：`docs/design/v2/tool/`

每次 tool 改动先确认：

- 是否需要新增或更新具体 tool spec。
- prompt-only 的单句措辞调整也必须在具体 tool spec 中记录 provider-visible 语义，并由 contract test 锁定；不得在文案中绑定 tool contract 未保证的内部 subtype。
- Workflow 这类后台编排 tool 还必须同步检查
  [`15-workflow.md`](15-workflow.md) 和 [`../workflow-script.md`](../workflow-script.md)，
  因为它横跨 provider-visible tool schema、workflow runtime、session store、子 session
  链接和 workflow 状态投影（`/workflows` 命令已于 2026-08-22 移除，投影本身仍在）。
- 是否影响公共生命周期、权限、结果预算或动态 tool 接入，需要同步更新 `README.md` 或本文。
- 是否有旧字段、旧 handler、旧 adapter、旧 prompt、旧测试需要删除或迁移。
- 是否会改变用户可见行为，需要在 spec 里写清兼容和迁移路径。

### 2. Contracts 层

常见位置：

- `packages/contracts/src/tools/*.ts`
- `packages/contracts/src/tools/contract.ts`
- `packages/contracts/src/model/index.ts`
- `packages/contracts/src/events/session.events.ts`
- `packages/contracts/src/interfaces/*.port.ts`

核对项：

- Zod runtime schema 是内置 tool 的唯一 schema 源；JSON Schema 通过统一 helper 派生。
- `inputSchema`、`outputSchema`、TypeScript 类型和导出入口同步。
- 新增跨边界数据时，优先补 runtime schema 或稳定接口，而不是只加 TypeScript 类型。
- provider-native tool 需要在 model/tool contract 里表达执行模式，例如 `executionMode`、`providerNative`、`providerExecuted`。
- usage、事件 payload、session store、ZCode app-server 或 compact 会消费的新字段，必须从 contracts 层开始声明。

### 3. Core Tool 声明

常见位置：

- `packages/core/src/tool/types.ts`
- `packages/core/src/tool/handlers/<tool>.ts`
- `packages/core/src/tool/handlers/index.ts`
- `packages/core/src/tool/registry.ts`

每个内置 tool 的 `ToolEntry` 必须核对：

- `metadata.name`、`description`、可选 `modelInstructions`。
- `capability`。
- `inputSchema`、`outputSchema`、`runtimeInputSchema`、`runtimeOutputSchema`。
- `readOnly`、`destructive`、`concurrentSafe`、`requiresUserInteraction`、可选的 `allowedInPlanMode`。
- `sideEffectScope`、`riskLevel`、`needsApproval`。
- `permission`、`resultBudget`、`timeout`、`cancellation`、`trace`。
- `handler` 和可选 `formatModelContent`。
- 可选 `formatBatchNotice`：返回 `{ source, content }` 时，工具批次结算后把它作为该 source 的
  system-reminder 附件排在这批 tool result 之后（不进 tool_result）。结算代码只调用这个钩子，
  不按工具名或输出形状特殊处理某个工具；Read 用它发送 `read_truncation_notice`。
  工具 Hook 的 `tool_hook_context` 附件由同一结算写入，排在这些批次提示之前。
  "一批结果 → 模型 entries"只有一个函数（`toolBatchModelEntries`，`runtime/helpers/tool-result.ts`），
  Main 结算和 Memory Agent 循环（Extraction、Dream）都调用它；新增工具结果语义只改这里，
  所有调用方一起生效。
- registry `toContracts()` 是否把模型、runtime 或 provider adapter 需要的字段投影出去。

不要只注册 handler；tool 声明是权限、调度、prompt、adapter、executor、UI 和测试共同消费的契约。

### 4. System Prompt 与模型可见工具说明

常见位置：

- `packages/core/src/tool/registry.ts`
- `packages/core/src/tool/handlers/*`
- `packages/core/src/runtime/methods/context-usage.ts`
- `packages/adapters/src/model/*`

核对项：

- tool 是否需要专属使用规则，例如何时用、何时不用、结果如何引用、是否要先读文件、是否必须带来源。
- tool 是否属于特定 agent tool pool。`Glob` / `Grep` 原本按 Explore-only 内置工具设计；
  当前默认 embedded search branch 会在主智能体和 `Explore` child runtime 中隐藏它们，
  non-embedded/direct fallback branch 才会把它们放入 provider `tools` 数组。调整 branch
  gate 时，需要同时更新 registry 过滤、toolAllowlist 交集语义和相关测试。
- tool 专属规则默认属于该 tool 的 provider-visible description。ZCode 的 `modelInstructions`
  是 tool prompt 的结构化补充，由 `ToolRegistry.toContracts()` 拼入
  `ModelToolContract.description`，而不是作为长文塞进 system prompt。
- ZCode 不在 system prompt 中镜像普通 tool 列表、运行态元数据或 tool 使用规则；这些信息必须
  随 model request 的 `tools` 数组进入 provider。debug/usage 可以展示 tool prompt 占用，
  但不能成为模型可见的第二份说明。
- tool 描述应足够明确，适合模型选择工具；复杂行为放 `modelInstructions`，但最终仍随
  tool contract 一起进入 provider tool description。
- 只改 provider-visible prompt 也要回到对应 tool spec 说明来源和适配点，并补契约测试证明
  `ToolRegistry.toContracts()` 能投影新描述；调整 prompt 时必须核对本项目实际 tool pool，
  避免把不可用的工具或流程写进模型可见说明。
- prompt 的边界说明如果和当前 runtime 行为不完全一致，必须在具体 tool spec 写清
  ZCode 的适配差异，不能让模型看到一个代码无法兑现的工具承诺。
- Bash embedded search 使用的原生 `bfs` / `ugrep` / `rg` 属于 tool runtime contract。调整其版本、
  构建参数、静态依赖或分发路径时，必须同步更新
  [`embedded-search-native-build.md`](../../../../../../docs/runtime-tools/embedded-search-native-build.md)，
  并从真实 Bash tool entry 的 handler 进入 execution adapter，用真实产物 E2E 覆盖固定前置参数、stdin、退出码、提前关闭管道、matcher 覆盖、特殊参数绕行和压缩/archive 搜索；
  默认 Bash prelude 必须直接执行原生程序，`bfs` / `ugrep` 缺失时回退系统 `find` / `grep`，
  `rg` 只在 shell 缺少可执行命令时补随包实现；不能只用 mock 或退回 Node / WASM 到系统命令
  的转发层证明可用。`grep` 特殊参数绕行必须同时维护 Bash prelude 的 shell glob 与 internal CLI
  的正则契约；`-[Zz]*`、`-[!-]*[Zz]*`、`--null`、`--null-data` 保留 GNU grep 的 null-data
  语义并绕回系统命令，ugrep 压缩搜索使用无歧义的 `--decompress`。
- 用户交互类 tool（例如 `AskUserQuestion`）的使用边界、选项组织方式和禁止滥用场景
  必须进入 `modelInstructions`，否则模型只能看到干瘪的短描述，容易少问、误问或把
  澄清问题当成普通审批。
- 当前日期、workspace、skills、user instructions 等 context 是否被 tool prompt 正确引用。
- context usage / debug 是否能看见 tool prompt 占用。

### 5. Model Request 与 Provider Adapter

常见位置：

- `packages/adapters/src/model/transform.ts`
- `packages/adapters/src/model/runner.ts`
- `packages/adapters/src/model/registry.ts`
- `packages/adapters/src/model/catalog*.ts`
- `apps/zcode-cli/packages/bootstrap/src/model-factory.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/types.ts`

核对项：

- `ModelToolContract` 是否包含 provider 需要的全部字段。
- 普通 client-side tool 是否正确映射为 AI SDK / provider function tool。
- provider-native/server-side tool 是否按 provider kind 和 model capability 映射，不支持时 fail-closed 或不投影。
- Anthropic-compatible 不等于 Anthropic-native；WebSearch 只能对已确认支持服务端搜索的 Anthropic baseURL host 单独 allowlist。
- provider 不支持的 schema 关键字、字段名、blocked/allowed 规则是否在 adapter 层归一化或报错。
- Anthropic-compatible JSON 响应可能返回缺少 `signature` / `redactedData`
  的 `thinking` block。修复原因：AI SDK 会按 Anthropic 原生 schema
  校验 thinking 完整性，缺签名会让 WebFetch 这类内部非流式
  `generateText` 调用整体失败；adapter 必须删除这类不可校验的
  thinking block，保留 text、usage 和 stop reason，不要伪造空签名。
- tool input 字符串化、provider tool call id、providerExecuted、server tool result、citations、usage 是否被 normalize。
- 流式 function call 参数必须在 adapter 层按 `toolCallId` 组装：
  `tool_input_delta` 只作为 retry-safe prelude 暂存；一旦 JSON 参数完整，
  adapter 生成唯一的 provider-neutral `tool_call`，并对 provider 结尾重复
  `tool-call` 去重。ZCode Protocol / app-server 不应直接暴露每条高频参数
  delta 给 UI，而应通过后续 `tool.updated` 生命周期事件展示稳定状态。
- openai-compatible、anthropic-compatible、gateway、local provider 等兼容层是否需要单独 gate。

### 6. 权限、Hook、Mode 与调度

常见位置：

- `packages/core/src/permission/*`
- `packages/core/src/tool/scheduler.ts`
- `packages/core/src/runtime/methods/tools.ts`
- `packages/core/src/tool/executor.ts`
- `packages/contracts/src/hooks/*`

核对项：

- permission `patternSources` 是否覆盖路径、命令、domain、toolName、input 或 custom 来源。
- allow/deny/ask、mode、allowedTools、disallowedTools、plan/read-only 限制是否仍正确。
- hooks 的 `PreToolUse` / `PermissionRequest` / `PostToolUse` / `PostToolUseFailure` 是否需要看到新增字段，hook 修改 input 后是否重新归一化。
- 工具 Hook 的 additionalContext 只走工具批次后的 `tool_hook_context` 附件；不得拼回 tool_result、
  tool result 预算或 `tool_call_result` 事件。单条超过 10000 字符时落盘成 `<persisted-output>` 外壳。
- `PermissionRequest` hook 与交互 broker 是并发竞速关系（`../permission-responder-race.md`）：
  broker 应答通道必须在确认窗可见后立即建立，hook 卡死/失败只令其退赛，不得阻塞用户应答，
  也不得转成 deny。改动 ask 路径时不得把两者重新串行化。
- runtime lifecycle hooks 的 `SessionStart` / `UserPromptSubmit` / `Stop` 是否仍在 tool 执行前后正确注入 additional context，且不会绕过 permission、mode、scheduler 或 tool contract。
- `Stop` hook 要求继续一轮时是否有 continuation 上限，避免 hook feedback 导致无限 turn loop。
- scheduler 是否按 sideEffectScope、concurrentSafe、requiresUserInteraction、destructive 和 session state 正确并发或串行。
- provider-native tool 不应进入 client-side executor；误执行必须 fail-closed。

### 7. Executor 与 Handler

常见位置：

- `packages/core/src/tool/executor.ts`
- `packages/core/src/tool/executor/*`
- `packages/core/src/tool/input-normalization.ts`
- `packages/core/src/tool/handlers/<tool>.ts`
- `packages/core/src/tool/handlers/<tool>-*.ts`

核对项：

- 输入先走 adapter 通用归一化，再走 executor tool-aware runtime schema。
- handler 只表达业务意图；外部 I/O 走 port/adapter。
- handler 在既有执行过程中发现可预期的 tool-specific 失败时返回稳定
  `errorCode + message`；executor 通用组装结构化 error 和 provider-visible
  `<tool_use_error>`，不得按具体 tool name 分支。成功 output 和正常执行顺序不因此改变。
- 状态竞态、I/O 故障和取消仍走异常路径；不要为了消除所有 `throw` 而把不可预期故障
  伪装成业务拒绝。
- timeout、abort signal、用户取消、权限拒绝、hook 拒绝都能到达正确错误路径。
- app/session shutdown、CLI 退出、TUI 切会话或 app-server closeSession 等外层生命周期事件，是否也能传递到对应 tool 的取消/清理路径；不能只覆盖“单次调用超时或用户取消”。
- CLI 进程级 shutdown 信号（`SIGINT`、`SIGTERM`，以及 POSIX `SIGHUP`）必须先进入统一 cleanup，再退出进程；持有 detached 子进程、进程组、后台任务或长连接的 adapter 不能只依赖单个 command 的 abort signal。
- 错误保留 cause 和稳定 error code，不依赖错误文本做流程判断。
- dynamic read-only 或 dynamic risk 需要有明确函数和测试，不要只靠工具名。
- handler 输出必须通过 runtime/output schema 校验。

Executor 是 client-side tool 的受控执行入口。`packages/core/src/tool/executor.ts`
只保留 public facade，内部按以下边界拆分：

- 单个 tool call 编排只负责串起归一化、schema 校验、hook、permission、handler、结果序列化、事件和后台任务追踪。
- permission flow 只负责 permission service、project rules、broker request、PermissionRequest hook 和 permission update 持久化；不得直接执行 handler。
- hook flow 只负责构造 hook 输入、解释 hook 输出和 additional context；hook 修改 input 后必须回到 executor 主流程重新归一化与校验。
  工具 Hook 的 additional context 由 hook flow 格式化，executor 放进 `ToolExecutionResult.hookAdditionalContexts`
  （成功、失败、PreToolUse 拒绝和提前失败都一样），由结算写成附件。
- result serialization 只负责 `resultBudget`、artifact 写入、模型可见内容和字节截断；不追加 Hook 文本。UI diff display、事件投影和日志不应反向解析模型可见文本。
- background task tracker 只负责 task polling 和 background task session event；不得影响当前 tool call 的成功/失败结果。
- batch/schedule 只负责并发组、blocking failure 和 skipped tool result 合成；不得绕过单个 tool call 的 permission、hook、timeout 和 trace 传播。

拆分 executor 时必须保持 `createToolExecutor`、`ToolExecutor`、`ToolExecutorImpl`
的外部导出路径兼容，并证明 trace、permission、hook additional context、resultBudget/artifact、
skipped result 和 background task 事件没有行为变化。

Tool Agent Trace 统一在单调用 Executor 外层建立，handler 不单独埋点：

- Span 名称使用 Registry 解析后的 canonical tool name，alias 不产生第二套指标维度。
- Parent 固定选择当前 Step，缺少 Step 时回退当前 Turn；业务不得传 OTel
  `traceId` / `spanId` / `parentSpanId`。
- Scope 必须覆盖 validation、hook、permission、handler、serialization 和结果预算全链路；
  不为 streaming progress、background polling 或单条 output chunk 建 Span。
- 成功、权限拒绝、取消和失败分别映射到受控 Tool Outcome；错误只传原始 `unknown`，
  由 Telemetry Sanitizer 统一提取 code、脱敏 message 和 fingerprint。
- `outputBytes` / `outputTruncated` 只读取 Executor 已生成的结构化 serialization metadata，
  不读取或上传 tool input、完整 output、文件路径或命令。
- Telemetry Port 可选且默认 Noop；导出失败不得改变 tool 结果、权限、超时、取消或
  background task 语义。

对应执行 Trace 主规范见
[`../../../../../docs/trace/cli-agent-telemetry.md`](../../../../../docs/trace/cli-agent-telemetry.md)。

### 8. I/O Adapter 与跨平台边界

常见位置：

- `packages/adapters/src/fs/*`
- `packages/adapters/src/exec/*`
- `packages/adapters/src/http/*`
- `packages/adapters/src/storage/*`
- `packages/adapters/src/mcp/*`
- `packages/adapters/src/skills/*`

核对项：

- 文件路径使用 Node `path` / `url` / workspace resolver，不手写分隔符。
- 子进程使用参数数组，避免 shell 字符串拼接；考虑 Windows `.cmd` / `.exe` 和空格路径。
- 持有外部进程、连接或后台任务的 adapter 必须暴露明确 shutdown/close 语义，确保宿主 app 关闭时能回收自身拉起的资源，而不是把 cleanup 责任散落在 handler 或 UI。
- 使用独立进程组、detached spawn、PTY、后台 runner 或 exec-server 的 adapter，必须同时定义宿主进程收到 shutdown 信号时的 cleanup 入口；否则父进程异常退出会绕过 session finally，留下仍可运行的子进程树。
- 进程清理策略必须区分显式 stop 与 root 自然退出后的 pipe drain，并保持 tool-specific 与通用 execution 的边界；修复某个 shell 的跨进程组清理时，不得把相同能力扩散到自然完成路径或其它 command mode。
- 网络走统一 HTTP adapter，保留代理、证书、普通请求总超时、重试、审计和错误归一化；SSE 等长连接协议必须单独定义事件间隔 idle timeout，不能复用普通 HTTP 总超时。
- storage/session/artifact 写入需要原子性、并发控制和 trace。
- adapter 输出错误要结构化，core 不解析 provider 或系统错误文本。

### 9. 结果序列化、预算与 Artifact

常见位置：

- `packages/core/src/tool/executor.ts`
- `packages/contracts/src/tools/*`
- `packages/contracts/src/interfaces/tool-artifact-store.port.ts`
- `packages/adapters/src/storage/*`

核对项：

- `outputSchema` 是否覆盖成功输出。
- `formatModelContent` 是否只输出模型需要的摘要，不泄露大内容或敏感信息。
- `resultBudget` 的 inline、model、preview、artifact 策略是否合理。
- 大输出写 artifact 后，tool result event 是否包含 uri/path、原始大小、返回大小、truncated、budgetStrategy。
- binary/image/PDF/structured blocks 是否有独立 content block 或 artifact，不压成不可读字符串。
- 如果 tool result 需要把图片/PDF 等媒体回传给模型，provider-visible
  tool result 必须保留结构化 content block，例如 AI SDK
  `output: { type: "content", value: [{ type: "image-data", data, mediaType }] }`。
  UI、event、DB 和 debug 可使用文本摘要或 artifact 引用，但不能把媒体结果压成
  JSON 字符串后再发给模型，也不能把 base64 作为普通 tool output 文本持久化。

### 10. Session Event、Message History 与持久化

常见位置：

- `packages/contracts/src/events/session.events.ts`
- `packages/contracts/src/events/event-reducer.ts`
- `packages/core/src/agent/message-history.ts`
- `packages/core/src/runtime/methods/message-persistence.ts`
- `packages/core/src/runtime/methods/compact-*.ts`
- `packages/core/src/runtime/methods/resume.ts`
- `packages/adapters/src/storage/*`

核对项：

- scheduled、started、progress、result、error、batch、model streaming、server tool use 等事件是否需要新增或扩展。
- toolCallId 是否稳定跨 provider、assistant message、tool result、replay 和 UI。
- storage / provider wire 为非法 tool call 使用固定非空占位名时，占位字符串不能同时充当非法性
  discriminator：live 必须使用原始非法字段判定，resume 必须使用显式持久化 metadata 判定；没有
  metadata 的同名 tool / alias / MCP 调用仍按普通工具执行和展示。无法满足公共协议 schema 的非法
  lifecycle 事件应停在内部恢复链，不得把占位名作为普通 `tool_call_scheduled` 投影给产品层。
- message history 是否保存模型下一轮需要的 tool result、provider metadata、server tool blocks、citations 或 encrypted content。
- session persistence、resume、compact、rewind、fork 是否保留或重建足够上下文。
- tool result display 的 bounded projection 是否既写入 live `tool_call_result`，也写入
  completed tool part 的 versioned metadata；resume、app-server load 和 TUI 初始 transcript
  必须消费持久化 metadata。metadata JSON 需要 runtime schema 校验，旧数据缺字段时
  保持可读并降级为 legacy output。
- 当前已登记的非文件 display variant 必须保持以下契约：
  - `local_agent_message` 只包含 `status`、可选 `error` / `message`，两个文本字段分别限制为 4 KiB UTF-8。
  - `task_stop` 只包含 `taskId`、`taskType`、`message`、可选 `command` / `truncated`，`command` 和 `message` 分别限制为 16 KiB UTF-8。
- **TODO(TUI display parity)**：TUI 的 live `ToolCallResult` 和 persisted transcript adapter 当前仍只 materialize `file_diff`。后续恢复 TUI 维护时，必须让两条路径复用同一个 exhaustive display adapter，为 `local_agent_message` / `task_stop` 生成 bounded semantic output；识别到结构化 display 后不得重复渲染 legacy raw output，并分别补充 live event 与 restored transcript 测试。
- 文件 mutation tool 生成 checkpoint 时，事件必须同时保留用户消息锚点和 tool/assistant 消息锚点；compact、resume、rewind、fork 后续只能通过这些稳定锚点重建 active chain 与 workspace snapshot 关系，不能反向解析 tool 文本或临时 runtime 状态。
- event reducer 和 usage summary 是否消费新增字段，且不重复计数。
- 持久事件携带的用户可见一次性提示来源必须投影为稳定事实，但只能由客户端在实时
  `online` 帧首次观察到时触发；`initial`、`recovery`、历史 snapshot 和重复 delta 只恢复状态，
  不得重新弹出提示。桌面 `desktop-continuous` 与手机 `web-remote-replayable` 分别在自己的
  delivery 边界执行该规则，relay/main 不保存提示状态。

### 11. TUI、ZCode app-server、Debug 与可观测性

常见位置：

- `packages/tui/src/app-events.ts`
- `packages/tui/src/app-tool-transcript.ts`
- `packages/tui/src/app-copy.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/*`
- `packages/debug/*`
- `docs/design/v2/debug-*.md`

核对项：

- TUI 是否能展示 tool start/progress/result/error、approval、diff、network、todo、background 或 server-side tool 状态。
- TUI tool 展示应优先消费 `tool_call_scheduled.payload.input` 和
  `tool_call_result.payload.result.display` 的结构化投影；同一个
  `toolCallId` 的 pending/running/result/error 应更新同一个 transcript part；
  streaming text 和 tool part 必须通过 `assistantMessageId` / `toolCallId` 保持同一 assistant step 内的原始顺序，而不是反向解析模型可见结果或重复追加互相脱节的状态行。
- TUI tool transcript part 不应额外增加整块左侧 gutter；标题与相邻 assistant
  内容对齐，detail、diff、output 只使用各自语义所需的本地缩进。
- 文件类 tool 的 TUI 标题必须优先使用结构化 `file_path` 生成审计友好的短路径。
  当前 workspace 内的路径显示 workspace-relative path；workspace 外路径显示完整路径。
  错误说明作为 tool part 下方的 error 风格文本展示，不把 `Tool <name> failed`
  这类生命周期文本当作唯一可见信息。
- TUI approval prompt 对命令类输入应优先展示 `input.description` 作为用户可读说明；
  面板内不显示 `riskLevel`/`mode` 等策略元数据，命令预览只展示 `input.command`
  的值，避免把完整 JSON 输入或权限策略原因混在确认内容中。
- ZCode app-server 是否能转发 tool call update、permission request、usage update、background task、prompt result usage。
- V4 cold hydration 可用由 tool row delta 维护的派生索引加速 turn 终态收口，但 snapshot 仍是
  权威状态；索引必须随 terminal/background/rewind 更新，并在 clone/adopt、strict replay 与
  batch hydration 中保持隔离和终态等价，不能改变 timeline delta 顺序。
- ZCode app-server permission request 选项必须与当前客户端契约保持一致：普通 tool 至少投影
  `Allow once`、`Always allow in this project` 和 `Deny`，其中 project allow 必须返回
  project 级 `permissionUpdates`，不能退化成一次性 allow。
- 普通交互 permission 的用户 Deny 必须将 provider-visible `tool_result.content` 对齐为稳定拒绝
  文案：`The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.`；策略或 hook 拒绝仍保留各自原因。
- V4 permission 可声明 `freeText` 输入能力。用户在 Deny 时提交的非空反馈必须通过同一
  `resolveInteraction` answer 进入拒绝 `tool_result.content`，格式为稳定拒绝文案后接一个空格、
  `To tell you how to proceed, the user said:`，再换行放置 `<trimmed feedback>`；不得新增 user message、steer 或
  自定义 permission decision。Desktop 继续 `desktop-continuous`，Web/手机 remote 继续
  `web-remote-replayable`，legacy/TUI/bot 保持普通 Deny 兼容路径。
- Debug 是否能观察 model request、tool call、I/O、permission、retry、artifact、queue、usage 和 trace。
- copy registry 是否需要新增文案，避免 UI 文本散落。
- 敏感输入、secret、完整用户内容、大输出是否被日志/trace/redaction 控制。

### 12. 配置、能力、扩展与兼容

核对项：

- 新配置优先走 config/session/project/CLI 参数；新增 `ZCODE_` 环境变量前必须先写 spec。
- model capability、provider kind、MCP capability、plugin namespace、subagent tool pool 是否影响 tool 可见性。
- 删除旧实现时，导出入口、tests、docs、migration、legacy aliases 是否同步处理。
- dynamic tool / MCP tool 必须经过 capability 声明、schema normalization、命名空间隔离和权限收口。

## 特殊 Tool 类型补充

### Client-side tool

普通内置 tool 由 ZCode executor 执行。重点检查 handler、adapter I/O、permission、scheduler、resultBudget、artifact、events 和 UI。

如果 client-side tool 允许在模型 SSE 仍打开时提前执行，还必须同步检查
`docs/design/v2/model/streaming-tool-execution-and-recovery.md` 中定义的
ledger、recovery anchor、provider-safe transcript builder、取消语义和断流恢复
测试矩阵。不能只把 executor 提前调用；必须证明不会产生重复 tool 执行、
orphan tool result 或 provider-visible dangling tool call。

提前执行异常后，流结束回退或 synthetic recovery 继续新建 ToolPart，沿用 callID
和声明序号。复用旧 partID 会保留首次插入位置，使后完成的回退 Read 快照被更旧的
Read 覆盖。模型 hydration 在同一 assistant 内按 callID 选最后新建的 part，再按
完整声明序号恢复 calls/results；缺少序号时保留所选记录原序，最新未结束记录仍恢复
为 interrupted result。UI 和文件读取状态继续消费原始 parts。
测试须覆盖回退成功、失败、再次写入失败、恢复后迟到 batch start，以及同文件多条
Read 的回退/冷恢复/rewind/Edit 链路。此修复不调整权限、执行时机、错误内容、数据库
结构或 desktop continuous / mobile replayable 交付边界。

执行作用域模型（例如 Highspeed）在 SSE 中途失败并切换到会话模型时，同样必须走上述
provider-safe settle，而不能只 abort handle 并记录 `tool_abandoned`。完整 `tool_call` 已建立
provider-visible 义务：已完成结果原样提交，运行中优先提交 cancellation result，未知状态提交 synthetic interrupted result，
assistant tool call 与 tool result 成对写入 live history 和 durable ToolPart；切换后不得重跑，冷恢复
不得出现 `pending`/`running` 或额外补造的 interrupted result。尚未形成完整 `tool_call` 的输入仍直接
作废。测试必须同时覆盖工具已返回和工具执行中断流，并比较切换前 live request 与冷恢复 history。

### Provider-native / server-side tool

Provider-native / server-side tool 可以直接暴露在主模型请求中，也可以只作为某个
client-side tool 的内部 side request 能力。WebSearch 当前目标采用 side request
形态：主 loop 注册普通 `WebSearch` client-side tool；`web_search` provider-native
contract 只在 `WebSearch` handler 内部 request 中出现。外层 `WebSearch` 必须完整
经过 ToolExecutor、permission、hook、scheduler、事件、resultBudget 和 tool result
history。重点检查：

- contract 中有 provider-native 执行模式。
- model adapter 把它拼到 provider tool schemas，而不是普通 function tool。
- 兼容端点必须确认支持 provider-native schema；当前只有 Anthropic provider kind 且 baseURL host 为 `bigmodel.cn`、`z.ai`、`deepseek.com` 或其子域时允许投影 `web_search_20260209`。
- 如果 provider-native tool 直接进入主模型请求，runtime 不调用 ToolExecutor 执行它；
  WebSearch 不采用这条路径。
- 如果 provider-native tool 只服务 side request，外层 client-side tool 仍必须完整经过
  ToolExecutor、permission、hook、scheduler、事件和 resultBudget。
- 恢复或新增直接暴露的 provider-native tool 时，必须确认它没有被 built-in registry
  注册成同名 client-side tool，否则 `ToolRegistry.toContracts()` 会优先生成普通
  function tool，adapter 不会进入 provider-native helper 分支。
- providerExecuted / server tool use / citations / usage 进入事件、历史、持久化和展示。
- provider tool description 中仍有模型使用规则，system prompt 中不再镜像这类规则。

### User-interaction tool

例如 AskUserQuestion。重点检查：

- `requiresUserInteraction`、permission broker、TUI/ZCode app-server request-response、pending/resume、非交互 session 降级。
- 不把交互流程写死在 TUI，ZCode app-server 也必须能承载。

### Background / long-running tool

#### Todo122：Subagent 选择失败原因

选择失败继续由同一 resolveSubagentSelection 阻断；仅补错误输出。六种公共 selectionIssue
进入既有 context.reason，兼留 selectionIssue 原始日志字段。具体原因使用简短中英双语消息，
避免后台仅保留 message 时丢失可读原因；稳定原因标记和原选择身份随 message 保留，
不新增专用协议。有效选择存在时才将其身份投影为 context.providerId/modelId，不冒称
失败前的原选择已经执行。前台 executor、后台错误通知、V4/UI 提示和复制复用既有路径。
不改输入 schema、权限、调度、继承/override 优先级或失败条件，不查询账号、不写选择，
不带 Key、Header、配置全文或会话正文。测试覆盖真实错误投影、工具结果与前后台 runner。

例如 background subagent 或后台 Bash。重点检查：

- Todo99 托管 Worker 的显式 Subagent 在创建子执行前，通过注入端口复用同进程已应用
  Registry 快照的公共 effective selection；解析失败阻断，不能退回父模型。原 profile 不写回。
  内部已固定 override 先于 profile 解析，隐式继承继续使用父执行 Model；Factory 只精确校验，
  不再对应账号。普通、嵌套、workflow/script 子 Runtime 必须传递同一端口；独立 CLI 暂不接入。
  不增加 Tool schema、权限、事件、持久化字段，也不改变 desktop continuous / mobile replayable。
  验证必须包含真实子 Runtime 取模和请求，不以 helper 单测替代整条链路。

- Markdown 契约以 Todo97 的后续裁决为准：正式字段为 `model` / `thoughtLevel`，不读取或逆迁移未上线中间态 `modelSelection`。内部与协议继续使用结构化 ModelSelection，不能将它与 Markdown 字段混淆。
- 已发布旧 Provider 值只在用户数据目录的初始化迁移阶段转换，正式 reader 不再执行旧身份转换；项目、插件等范围外文件不自动改写。旧身份不能通过 ModelFactory 别名复活。Todo99 只解析迁移后的正式选择，不重新实现迁移。

- task id、status、progress、completion/error、cancel/resume、session event store 和 user-visible notification。
- `SendMessage` 恢复 terminal local agent 时不会经过 `Agent` tool executor；该路径继续只发布
  `SubagentSpawned(background=true, resumed=true)`。V4 必须在同一个 projection transaction
  中用这条事实恢复 subagent row 并创建同一 `agentId` 的 cancellable background work；复用 row 时
  必须保留最初 `Agent` tool call 的 `parentToolCallId` 展示锚点，不能用本次 `SendMessage` call id
  覆盖，也不能再补发第二个 started 事件表示同一次状态迁移。
- Background Agent 的 `childSessionId` 是父 session 下钻到完整 child session 的稳定关联字段：
  Agent launch output / runtime task snapshot -> `BackgroundTaskStarted/Updated/Completed` ->
  ZCode Protocol V4 `backgroundWorks` 必须逐段保留；不得要求 UI 从 tool result 文本、
  subagent row 或 `workId` 重新猜测。旧事件确实缺字段时只能降级为不可下钻的普通状态项。
- child session 自己的 `Write` / `Edit` 文件摘要必须继续以 child 的
  `checkpoint_created` artifact 和终态 `model_complete.fileChanges` 为事实来源，并投影到 child
  turn header。`querySource=subagent` 只能放开这份 workspace 摘要，不能借机把 child usage、
  输入框或其他可编辑会话能力投影成主会话语义；右侧只读详情可以独立开放 preview/apply rewind。
- child runtime 释放后仍需撤销时，checkpoint 关联和 workspace-only rewind 状态分别复用既有
  `session_entry` 持久化；cold resume 的 `SessionResumed` 建立新 raw event epoch，但 V4 transport
  sequence 必须继续单调，避免旧 detached child 高水位吞掉新的撤销事件。
- subagent / background task 内部产生的 child tool lifecycle 以 child session 持久事件为事实来源；镜像到父 runtime 的
  `source: "subagent"` 事件只供兼容消费者、运行态诊断和 telemetry 使用，不是父 session 的工具事实。ZCode Protocol V4
  ProductProjection 必须在 row materialization 前识别该来源，foreground/background 一律不得生成父 conversation 的
  `ToolCallRow`、plan 或文件摘要；完整工具历史只在 `conversation/<childSessionId>` 中物化。父 conversation 继续投影
  Agent/Task 行、subagent manifest、background work 和带 subagent origin 的阻塞交互。该边界同时适用于桌面
  `desktop-continuous` 与手机 `web-remote-replayable`，不能只在 renderer 过滤而让 snapshot/replay 保留脏 row。
- dwf run 的第三个启动入口是模型工具 `ResumeWorkflowRun`（继 CreateWorkflow 的 submit 路径与 v4
  `resumeWorkflowRun` 命令之后，2026-08-29）。它返回 CreateWorkflow 同款 `backgrounded` 形状
  （`{status:"backgrounded", backgroundTaskId ≡ runId}`），executor 的自动追踪按输出形状而非按工具名触发；
  per-tool 生命周期分派经 `isDynamicWorkflowRunDispatchToolName`（CreateWorkflow ∪ ResumeWorkflowRun）认名，
  registry 登记沿用 existing 合并语义保住原始 CreateWorkflow 工具行的 `parentToolCallId`（详情页 join 跨 resume
  不断链）。
- 重臂 dwf run 时 `registerRuntimeBackgroundTask` 必须复位既有条目的**终态结算面**（notified / error /
  completedAt / exitCode / resultText / pid）而保留**身份面**（agentId / agentType / parentToolCallId /
  turnId / description / startedAt）；`outputFile` 有意保留（dwf 从不写它，existing 兜底仅为产物外部化预留）。
  根因：同进程 cancel 终态 → 未重启即 resume 时，残留的 `notified:true` 会让
  `claimRuntimeBackgroundTaskNotification` 拒收，恢复 run 的终态模型通知被吞——v4 命令路径与工具路径同病。
- 不用 tool call 次数做硬停止；靠取消、超时、provider retry 上限、token/context limit 和用户操作收口。

### Session-state tool

例如 Todo。重点检查：

- 创建未来执行（如 `CronCreate`）时，持久化模型必须读取会话稳定模型，禁止读取当前 Turn 的临时执行模型。Highspeed、闲时模型等 turn-scoped overlay 只能服务当前 Turn；即使工具在 overlay 生效期间执行，也必须保存 overlay 安装前的会话模型，避免临时 provider 清理后未来任务无法恢复。
- 临时模型不能反向改变未来任务工具的可见性：Highspeed 用户 Turn 仍允许 `CronCreate`；实际 Automation Turn 以 `automationId` 为最终执行边界，必须忽略同轮误传的加速 `modelSelection` 与 `modelExecution`，并按既有规则隐藏 Automation 写工具。
- session store、event reducer、resume、compact summary、TUI/ZCode app-server projection。
- session-only side effect 和 workspace/system side effect 分开声明。
- `readOnly` 只用于不会改变 session/workspace/system/network 状态的检查型 tool。会写入 session 状态的 tool 应声明 `sideEffectScope: "session"`，并根据是否允许在 plan mode 使用来设置权限；不要为了免审批把 session mutation 标成 read-only。
- `allowedInPlanMode` 只允许显式放行 `sideEffectScope: "session"`、`destructive: false`、`needsApproval: false` 的控制型 tool；它不能放行 workspace/system/network side effect，也不能覆盖 global/project deny/ask 规则。典型用途是 child runtime 向所属 coordinator 写入 session-local response queue。
- 用于完成 long-running target/goal 的 session-state tool 必须把“计划、todo、checklist、阶段完成、预算耗尽或停止工作不是完成证据”写进模型可见描述或 prompt，并要求模型基于真实 artifact、命令输出、测试、PR 状态或用户确认完成审计。
- 如果 session-state tool 的结果需要二阶段确认，例如 goal completion verifier，优先把 verifier 做成 runtime gate 和可配置开关，不新增持久状态；必须定义 verifier 失败时的模型继续提示、稳定状态事件、UI/ZCode app-server 状态投影和测试覆盖。现有 long-running goal 仍通过兼容事件 `target_changed` 和 ZCode app-server `_meta.zcode.target` 投影给旧客户端；当前模型可见 goal 工具只有 `GoalRead`，不得再新增或恢复 `GoalCreate` / `GoalUpdate` / `Target*` 这类模型可见状态变更工具。

### Discovery-backed instruction tool

例如 Skill。重点检查：

- discovery roots、向上遍历边界、同名优先级和兼容目录顺序必须写进具体 spec；handler 不应临时猜测路径。
- discovery 只返回 metadata 时，要证明正文仍按 tool 调用通过 adapter/port 按需读取，并继续传播取消和 trace。
- 同名、无权限、缺失 frontmatter、过大或不可读 skill 都必须进入 diagnostics 或稳定错误路径，不能静默改变模型可见能力。

## 最低测试矩阵

每次 tool 改动至少按风险选择覆盖：

- contracts：schema 成功/失败、默认值、旧字段删除、JSON Schema 投影。
- core：ToolEntry 契约完整性、registry 投影、system prompt 不镜像工具、input normalization、permission、scheduler、executor、handler 成功/失败/取消/超时。
- adapters：I/O port 行为、provider mapping、provider error normalization、cross-platform path/exec/network。
- runtime integration：模型 tool call -> executor -> tool result -> message history -> 下一轮请求。
- events/persistence：session event、store、resume、compact、rewind、usage summary。
- TUI/ZCode app-server/debug：用户可见状态、审批、结果展示、usage、trace。
- regression：相关包 typecheck、lint，以及能证明该链路的 targeted tests。

如果改动触及共享 contract、runtime、executor、session event 或 model adapter，不能只跑单个 handler 测试；至少跑对应 package 的 typecheck 和相关 integration tests。

## 提交前检查

### Subagent Computer Use boundary（2026-08-18）

官方 CUA 的子 Agent 限制不是 prompt 约束，而是 provider-visible surface 与 producer
execution backstop 的双层 tool 边界。实现细节和稳定错误见
[`docs/cua/2026-08-18-subagent-computer-use-unavailable-spec.md`](../../../../../docs/cua/2026-08-18-subagent-computer-use-unavailable-spec.md)。

- Core 必须使用 `computeOfficialCuaServerNames` 的 authority 结果，不得按 server/tool 字符串匹配。
- wildcard child 过滤 borrowed MCP snapshot；explicit CUA server/tool/selector/Skill 在模型请求前失败。
- SkillPort 的 discover/load 都要过滤官方 `computer-use`，且保留第三方同名 Skill。
- CUA producer 必须在 kill-switch、Broker 和 handler 前检查 namespaced `runtime_scope`。
- 主 Agent canonical/alias、permission group、protected frame 和其他 MCP 的可见性保持不变。

- spec 已更新，并指出旧行为是否保留、迁移或删除。
- 无关脏改动没有混进同一个提交。
- 没有直接 I/O 越过 adapter/port。
- system prompt 不重复声明工具；provider-visible tool description / model request tools / adapter 投影三者一致。
- permission、sideEffectScope、concurrentSafe、destructive、requiresUserInteraction 没有互相矛盾。
- outputSchema、runtimeOutputSchema、resultBudget、artifact 和 UI projection 一致。
- session event、message history、resume/compact/replay 没有丢失模型下一轮需要的信息。
- tests 覆盖成功路径和关键失败路径；无法验证的跨平台行为写在剩余风险中。

## 官方 CUA provider 拼写别名

官方 CUA 的模型可见工具名只允许使用规范 server 段
`mcp__computer-use__*`。模型偶发把连字符改写成下划线时，只能在同时满足以下条件后给
`ToolEntry` 增加单向运行时别名 `mcp__computer_use__*`：

- descriptor 来自已经通过 Host authority 校验的官方 `zcode-cua` server；
- server 名精确等于官方规范名，不能从工具名反推 provenance；
- alias 不进入 `ToolRegistry.toContracts()`、provider request、system prompt、manifest
  或持久化事件；
- executor 命中 alias 后必须先恢复 `entry.metadata.name`，再进入 permission、hook、
  scheduler、event、history 和 MCP dispatch；
- alias 与任意已注册 canonical tool 或其他 alias 冲突时必须拒绝，不能静默覆盖。

禁止把该兼容扩展成全局连字符/下划线归一化。第三方 server 即使使用相同 display name，
也不能获得官方 CUA alias、not-ready retry 或其他 trusted-origin 行为。

## Todo103：Off-Peak 工具整合

Host 当前 View/灰度经 policy 或创建参数控制 OffPeakPort 注入，工具默认选择由 Host 生成
完整 ModelSelection。CLI 保留闲时 turn 的防递归标记/denylist，完成、拒绝、排队、抛错均恢复
先前 activeOffPeakTaskId；继续传递 sharedContextRefs 与现行 modelExecution，不恢复旧
turnRuntimeModel/overlay/模型还原接口。完整链路见仓库根 `docs/off-peak-task/tech-design.md` §4.7。

## Todo104：模型媒体能力字段统一

Model 数据合同统一为 inputFormat/outputFormat 与 supportsText/Image/Video/Audio/Pdf。
Read PDF 的能力读取、当前 turn 工具能力投影、媒体过滤、compact 与 Adapter 请求投影同时
消费该共享合同；不改变 Read 输入/输出、权限、IO port、PDF/图片独立能力门和结果预算。
名称调整不修改实际 SDK body、工具 Schema 或持久化 tool 消息；desktop continuous 与手机
replayable 保持原有交付链路。验证包含协议候选严格校验、Read PDF executor、媒体请求与
冷恢复/compact 相关用例，不能仅凭设置页显示判断完成。

### 中途消息来源呈现（2026-09-11）

SendMessage / RespondToCoordinator 的来源呈现遵循 `../loop/turn-steering.md`：更新 coordinator 识别提示，保留历史前缀兼容与已有回复/继续工作合同。参数、权限、执行目标、background batch 与可见性边界不扩展；child 不获得 SendMessage，parent peer 的回复目标来自绑定 agent-id。验证工具描述、真实父子 Runtime 请求、冷恢复及 BG25/O18/O19 fixture。

### 2026-09-18 ToolSearch E2E 补齐

仅扩展测试与文档：真实入口 → 搜索执行 → 最终 HTTP body → compact/fork/重启后的第一条请求；包含关闭请求以验证降级和恢复。产品 schema、权限、SQLite 和 App 协议均不变。验收场景见根目录 conversation-session coverage matrix 的 TS 子场景。

### 2026-09-18 ToolSearch E2E 正式准入

本次及此前 8 个 spec（29 项）经用户确认转正，case-local fixture 成为实际模型响应来源，
原请求阶段、取消屏障与产品断言保持不变。只修改测试和文档；不新增生产接口或修改
数据库、协议。正式路径与运行证据见根目录 coverage matrix，Docker 准入单独记录。

## CreateWorkflow 修订续跑的会话内免确认（2026-09-13）

```text
用户放行 CreateWorkflow / 中枢直接启动 -> runId
  -> PermissionService.grantWorkflowLineage(runId, resume_from?)      （纯内存，会话同寿）
模型 CreateWorkflow{resume_from}
  -> checkAlwaysAsk：阻断分支 -> 会话规则 -> lineage 命中 allow -> 否则 ask
用户 Cancel（initiator user）-> revokeWorkflowLineage(runId) 撤销整条 lineage
```

只改权限判定与两处播种、一处撤销；工具 schema、输出、事件、UI 投影、服务端修订门零改动。
ResumeWorkflowRun / resume 重臂不播种。决策记录见仓库根 `docs/dynamic-workflow/launch.md` 追记 2026-09-13。

## GetWorkflowRun 的情势截面（2026-09-17）

```text
dwf_event / dwf_node / dwf_actor
  -> bootstrap roster（阶段 / 花名册 / 健康，读时派生）
  -> DynamicWorkflowRunDetail{phases?, subagents, health, logTail[].at?}
  -> core handler：Date.now() 一次 -> generatedAt；逐字段搬 -> summary（确定性拼装）
  -> runtimeOutputSchema（strict，phases ≤ 32 / subagents ≤ 64 + subagentsTruncated）
  -> formatModelContent（纯函数 (output) => text，块序见 docs/dynamic-workflow/launch.md）
  -> createToolResultDisplay -> get_workflow_run 卡（contracts + packages/shared 两侧 strict）
```

输出新增 `summary`、`generatedAt`、`phases?`、`subagents`、`subagentsTruncated?`、`health`，
`logTail[]` 多一个可选 `at`；输入、权限、predicate、resultBudget、artifact 策略零改动。
`generatedAt` 是必要的：`ToolEntry.formatModelContent` 只收 `output` 一个参数，模型面上所有
「多久以前」只能对一个随输出过界的读数算，否则格式器不可测且同一份输出里的两个年龄不可比。
两侧 display schema 的成员与枚举必须同步。**同步失败的代价曾被本文件写轻过**：2026-09-21 之前，
渲染端把整帧拒掉、恢复阶梯在同一份内容上重试、会话停在 `fault.subscription.recoveryFailed` 且永不
自愈——不是「工具卡退化成文本」。自 2026-09-21 起 v4 信封用 `.optional().catch(undefined)` 承载
display，读不懂的载荷被丢掉、帧照常交付，「退化成文本」才真正成立（`docs/v4-refactor/10-protocol-spec.md`
§4.4.5）。但兜底只保护带该修复的客户端：对更早发布的客户端仍是整帧被拒，所以**加字段前先看镜像**
这条规矩不变。
决策与块序见仓库根 `docs/dynamic-workflow/launch.md` 的「`GetWorkflowRun`」与「Their cards」。

## workflow 草稿目录的写入免确认（2026-09-18）

```text
executor（permission-flow / permission-input-recheck）
  -> PermissionContext{workingDirectory}
  -> checkPermission：disallowed -> 项目 deny/ask -> plan -> 项目 allow
     -> WebFetch 预批 -> **草稿预批**（Edit / Write，isWorkflowDraftPath）
     -> allowedTools -> 模式默认值
```

Edit / Write 的 `file_path` 解析后落在 `<cwd>/.zcode/workflow-drafts/` 内即 allow，
ruleId `tool.workflowDraft.preapproved`；判定在 `permission/workflow-draft-path.ts`，纯路径比较、
不碰文件系统。ApplyPatch 虽同为 `edit` 权限名但输入是 `patch_text`，不在其列。
位次与 WebFetch 预批同处：压不过项目 deny/ask，也压不过 plan（plan 仍拦下一切写入）；
上下文没有 `workingDirectory` 时不生效。工具 schema、输出、事件、UI 投影零改动。
合并 Guarded 后，首次判权和 Hook 改写重判均使用既有执行上下文中的 cwd，保留草稿预批及 Guarded 快照语义。
决策记录见仓库根 `docs/dynamic-workflow/launch.md`「Script files」→「Editing a draft needs no approval」。

## 脚本文件来源与工作副本（2026-09-18）

```text
contracts/tools/{create,amend,save}-workflow.ts、eval-workflow-snippet.ts
  -> entry.validateInput（模型入参上的来源约束：Create/Save/Eval 恰好一个，Amend 至多一个）
  -> entry.resolveInput（唯一一次读盘：读 path 文件 / 写 saved 的工作副本）
  -> PreToolUse hook + 项目权限规则 -> 权限事件载荷 -> prepareApproval
  -> handler（内联来源在读编译结果之前写草稿）-> port.submit / port.amend 的 scriptPath
  -> 模型面 response（诊断的文件行前缀 + 「去编辑那个文件」的 NOTE）
```

四个工具各加一条文件来源，恰好给一个（`AmendWorkflow` 例外：至多一个，两个都不给即沿用前驱的
脚本，见下一节）：`CreateWorkflow.path`（外加只与它同进同退的顶层
`args`）、`AmendWorkflow.path`、`SaveWorkflow.script_path`（不叫 `path` 是因为那已是本工具
解析回填的落点）、`EvalWorkflowSnippet.path`。来源约束住在 `validateInput` 而不是 schema：归一化
之后 `script` 与来源字段同时在场是合法执行态。回填的 `script_line_offset` 与
`saved.draft` 不进模型的 JSON schema（与 `AmendWorkflow.predecessor` 同一姿态）。

内联与 saved 来源各写一份工作副本到 `<cwd>/.zcode/workflow-drafts/`（`handlers/workflow-drafts.ts`，
尽力而为、失败即无路径）；`path` 来源不写。绝对路径随 `submit` / `amend` 的 `scriptPath` 进
`run-launched`，模型面显示的是工作区相对写法（`handlers/workflow-script-path.ts`）。诊断的
`{path}:L{line}:C{col}` 按**文件行**（加 `script_line_offset`），而输出里的 `diagnostics` 数组与
display 载荷仍按正文行——转录面画的是正文。`AmendWorkflow` 的 `path` 提交在任何窗口之前经
端口可选成员 `getScript` 比字节（与下一节沿用脚本读的是同一个成员），未改动且未同时改
`max_concurrency` / `subagent_model` 即 `workflow_script_unchanged`（错误码 24）。UI/V4 投影、事件与输出形状零改动。
决策记录见仓库根 `docs/dynamic-workflow/launch.md`「Script files」。

**内联草稿记作模型写过的文件**：`CreateWorkflow` / `AmendWorkflow` 的 handler 写完内联草稿后，经
`handlers/workflow-draft-read-state.ts` 用 `fileSystemPort.stat` 取 mtime / size，往
`context.readFileState` 记一条与 `Write` 同形的完整视图，并经 `recordReadFileStateMetadata` 落到
tool part metadata（`PersistedReadFileStateTool` 增 `CreateWorkflow` / `AmendWorkflow`，
`read-file-state-hydrator.ts` 在 resume 时恢复）。于是 NOTE 要求的那一次 `Edit` 不必先 `Read`
一遍模型自己刚写的脚本。只记模型本次调用亲手写的字节：saved 拷贝、沿用前驱脚本
（`predecessor.script_inherited`）的新草稿、中枢直接启动与 GUI 设置修订都**不记**。stale 校验照旧
（外部改动后 mtime 前进即 `STALE_FILE`）；stat 失败即不记（尽力而为）。工具 schema、输出、事件、
UI 投影零改动。

## AmendWorkflow 可省略脚本（2026-09-18）

```text
模型 AmendWorkflow{run_id, max_concurrency?, subagent_model?, name?}（`script` 与 `path` 都不带）
  -> resolveInput：port.getTask（前驱事实 + scriptPath）+ port.getScript（journal 的 script_text）
  -> 回填 script，predecessor.script_inherited = true（predecessor 无条件覆盖，模型伪造无效）
  -> 前驱的脚本文件此刻仍是这份字节 -> 回填 path（新 run 继续记它）；否则 path 缺席
  -> PreToolUse / 权限规则 / prepareApproval（编译回填的脚本，确认窗照常画图）/ handler
  -> handler：path 缺席即照内联脚本写一份新草稿
  -> port.amend{scriptText, scriptPath}（端口永远收到脚本，继承只发生在工具层）
```

输入：脚本的三条来路是 `path` / `script` / 都不给（`validateInput` 只拒「两个都给」；归一化在
`handlers/amend-workflow-source.ts`，整份入参的归一化在 `handlers/amend-workflow-resolve.ts`）。
`script` 在模型面 JSON schema 与运行时 schema 上都可选（hook 改写后的二次校验按
模型原始形状）；`predecessor` 多一个 `script_inherited?: true`。端口新增可选只读成员
`getScript(runId)`，不进 `getTask` 快照：快照被后台追踪器轮询，而脚本是端口上最大的字符串。
失败都在确认窗之前：前驱没有存档脚本、宿主无端口或端口不带 `getScript` →
`workflow_amend_script_unavailable`（错误码 26，resolveInput，早于 hook）；继承来的脚本在当前 facade 下
编不过 → 诊断首句说明脚本继承自前驱，诊断行与 NOTE 照「脚本文件来源」写成文件坐标
（prepareApproval 放行后由 handler 回诊断）。GUI「配置」（runtime 的 amendWorkflowRunSettings）
对新 run 的脚本文件走同一条规则、同一段代码（`resolveKeptScriptFile`）。输出形状、display kind、权限判定（owner 规则不变）、事件与 v4 协议
零改动；UI 只在 lineage 行多一句「脚本不变」（聊天卡读模型原始入参里 `script` 与 `path` **同时**缺席——`path`
修订也不带 `script`，却是改过的脚本；确认窗读回填的 flag）。决策见仓库根 `docs/dynamic-workflow/launch.md`「Keeping the predecessor's script」。

## AmendWorkflow 只改并发即就地生效（2026-09-19）

```text
模型 AmendWorkflow{run_id, max_concurrency}（script / path / subagent_model / name 都不带）
  -> resolveInput：port.getTask（前驱事实 + 状态）+ resolveAmendMaxConcurrency（三态 → 数或 null）
     -> 「除并发外什么都没变」且 run 还活着 ⇒ 判为就地调并发：不读 getScript、不继承脚本
     -> 同值 ⇒ unchanged（结构化失败，早于 hook 与确认窗，拒绝里点名当前上界）
  -> PreToolUse / 权限规则（owner 规则一字未改；这条路不进确认窗：没有脚本要给人看）
  -> prepareApproval：不编译、不起 ask，闸门直接放行
  -> handler：port.retuneConcurrency({ runId, maxConcurrency })
     -> ok        ⇒ response 点名 run id 与新上界；不进后台追踪器（run 本来就在里面）
     -> unchanged ⇒ 结构化失败
     -> not_live（已结算 / 不归本进程 / pending 但引擎还没建）
        ⇒ 本会话自己的 run 落回真正的 amend（此时才 getScript + 编译，缺脚本 / 编不过按 amend
          自己的拒绝回报）；不满足 owner 谓词的 run 拒掉：已结算是 workflow_run_settled（28），
          从没握住过是 workflow_run_not_retunable（29）——这条路一个窗都没弹过，
          不能把「什么都没批」撑成「另起一次 run」
```

输入：`AmendWorkflow` 的 schema 零改动——就地路由是对入参形状的判定，不是新字段。端口新增
`retuneConcurrency({ runId, maxConcurrency: number | null })`
（`interfaces/dynamic-workflow-run.port.ts`），答
`{ok:true, maxConcurrency, previous, ceiling} | {ok:false, reason:"not_live"|"unchanged", current?}`：
`null` 即本机上限，端口答的是**实际生效**的那个数（已 clamp 进 `[1, ceiling]`）；`ceiling` 让调用方
能说「上限已取消」而不是报一个数，`previous` 是事件日志与设置轮 `{from,to}` 的左边，`current` 让
`unchanged` 点得出当前上界。GUI 的 `amendWorkflowRunSettings`（runtime method）是第二个调用方，与工具
共用同一段三态解析和同一条路由。「活着」由 run service 说了算：它得握着这个 run 的活体条目、且控制面
已经绑上引擎——pending 但引擎还没建起来的 run 当场答 `not_live`，不缓冲、不等，这也是弹层只在
`running` 上说「就地生效」的原因。端口不带 `retuneConcurrency` 的老宿主没有这条路，调用原样落成
今天的修订。落回修订前会**重读一遍 run**（手里那份 `predecessor` 还写着「在跑」），要不要放行只
问一个谓词——契约里的 `isAmendWorkflowOwnedPredecessor`，与权限服务 owner 规则同一个函数。
`workflow_retune_unchanged`（27）、`workflow_run_settled`（28）与 `workflow_run_not_retunable`（29）
是这条路由自己的三个拒绝，码表在 `handlers/amend-workflow-source.ts` 的 `AMEND_WORKFLOW_ERROR_CODE`，
都不动 run。同值优先在 resolveInput 收口（读得到天花板时），读不到天花板才由端口去答。

引擎与 journal：`setMaxConcurrency(n)` 在一个同步步里写 caps、`updateRunCaps` 和
`run-caps-changed` 事件，抬高上界时额外 pump 一次调度；`dwf_run.caps_max_concurrency` 因此有了
第二个写入者，而 resume 读的还是这一行，所以调过的上界能跨重启活下来。无 migration。driver 侧每个
run 多一把座位闸：上界被调低时，多出来的子代理停在**下一次 turn step 的模型请求**上（走既有的
`model_request_queued` → `waiting(slot)`），工具内发出的模型请求永不停驻。

事件与 v4 协议：新增 `run-caps-changed`。`eventType` 本就是开放字符串，reducer 的 default 分支
只抬水位，所以加值对老客户端是向后兼容的（与闭集加值不同档）。shared reducer 按 `run-started` 的同
一条规则搬 `concurrency.limit` 与 `concurrencyCeiling`，CLI 在铸载荷时补 `concurrencyCeiling`
（与 `run-started` 同一处）。

UI/V4 投影：事件日志多一行「并发上限 8 → 2」；并发 chip 不改（本就是 `min(cap, limit)`）。设置轮的
`amend.predecessorRunId` 改为可选，缺席即「就地生效」，该轮只画一行、不画 run 卡片（卡片在 run 发起
处已经有了，再画一张会读成第二次 run）；记录在案的偏斜：老桌面上该字段必填，那一行 parse 失败被整行
丢弃（与 `scope` / `path` 同一档）。「配置」弹层只在 run 正在跑（`running`）且只改并发时换一句
「立即应用到当前运行，不会新起一次运行。」——`pending` 照旧说原话，因为它的引擎可能还没建起来，
那时这次修改仍会落成一次真正的修订。

输出：`{ok:true, response, diagnostics: [], retuned:{runId,maxConcurrency,previous,ceiling}}`
——没有 `status:"backgrounded"`、没有 `backgroundTaskId`、没有 display 载荷（这条路不编译）。
`retuned` 是显式判别块（「ok 且没有 status」在这个工具上还有别的来路），只到进程内为止：协议的
`toolOutputSchema` 只带 text / display / truncated。所以**过得了 v4 的只有 response 那句话**，
桌面工具行按它与入参形状画，改词等于改 UI，两种上界各有一份逐字测试。
不新增协议字段是刻意的：`create_workflow` 的三份 display schema 都是 `.strict()` 的冻结字段集，
多一个键会让旧端把整条工具结果丢掉；而新增一个 display kind 会让版本锁定的手机包直接 parse 失败。
（两条风险自 2026-09-21 起在**带修复的**客户端上被限制成「这张卡没有载荷」；更早发布的客户端仍会
拒整帧，因此本决策不变。）

测试：`dynamic-workflow/tests/engine/engine-retune-concurrency.test.ts` 与
`dynamic-workflow-runtime/tests/control.test.ts`（setter 与控制面绑定）、
`bootstrap/tests/workflow-seat-gate.test.ts`、`workflow-driver-seat-gate.test.ts`、
`workflow-run-control.test.ts`（停驻 / 解停 / abort 回 working / 没见过开始的结算是无操作 /
工具请求不停驻 / 不死锁 / ensureSession 窗口）、`bootstrap/tests/dynamic-workflow-run-service.test.ts`
的 `retuneConcurrency` 三种答复（含 `null` 落到上限、越界 clamp、pending 无引擎答 `not_live`）、
`core/tests/amend-workflow-permission.test.ts`（路由、三个拒绝、两段逐字回话）与
`dynamic-workflow-run-settings.test.ts`（GUI 侧同一条路由）、
`packages/shared/test/zcodeProtocol.test.ts` 与 reducer 用例的 `run-caps-changed`、
`packages/ui/test/createWorkflowToolCallBlock.test.ts`、`workflowTurnDigests.test.ts`、
`workflowRunSidePane.test.ts`、`workflowRunSettingsPopover.test.ts`（工具行、无卡、弹层措辞）。决策见仓库根 `docs/dynamic-workflow/concurrency.md`「Retuning a live run」与
`docs/dynamic-workflow/launch.md`「Changing only the parallelism of a live run」。

## 审批框完全访问（Todo158，实施契约）

V4 普通主任务审批可声明 fullAccess：同一 resolveInteraction 先取得 broker 应答权，
原子保存任务权限和已接纳未执行队列的权限后，再允许当前工具。Runtime、Composer、
队列各自保留 Plan；项目 ruleset/default、其他任务、用户问答与独立 workflow 确认不变。
完整提交、失败恢复、兼容与 PA158 回归清单见根目录
`docs/working-memory/provider-refactor/steps/todo-158-permission-dialog-full-access-and-queued-mode.md`。
子代理请求通过父任务展示不意味着父 Runtime 拥有子 Runtime；未实现完整能力不得投放此选项。

### Todo158 失败收口与恢复修复（CR-01 / CR-02）

```text
每次 fullAccess 尝试 → broker 创建本次失败通知
  成功 → registry 产生 V4 answer → 放行原工具
  失败 → 清理本次等待并通知已等待的 legacy 应答/超时 → 按原语义收口
  重试 → 新建独立等待；仍在提交期间不能提前放行
任务恢复 → 读取可选 receipt 标记 → 校验成功且同 session 才恢复标记
  无效/未知扩展字段 → 清除旧标记、记诊断并继续恢复；授权重试仍严格校验
```

Broker 仍拥有应答竞争，Runtime 仍拥有权限与恢复；不改变协议、队列事务或 desktop continuous/mobile replayable 边界。回归覆盖 legacy resolve/reject 在失败前后到达、提交/投影失败、重试、取消及生产 Runtime 对合法/无效/未来 receipt 的恢复。

## 完成通知的 durationMs 改按 lineage 活动时长（2026-09-21）

```text
dwf_event（run-started + 每一世最后一条事件）
  -> adapters listRunLifeSpans（宿主读面，单条 SQL，不解 payload）
  -> bootstrap runLineageActiveMs（沿 resumedFrom 逐跳求和，有界 + 防环）
  -> snapshotOf 终态分支 -> DynamicWorkflowRunSnapshot.activeDurationMs
  -> core workflowNotificationDurationMs：max(本世 completedAt − startedAt, activeDurationMs)
  -> workflowNotification.durationMs -> 完成卡「时间」格
```

只改 `durationMs` 的**取数口径**：schema、字段名、边界与三态携带规则零改动，老载荷与不带
`activeDurationMs` 的端口（引擎内存 journal、测试替身）按本世时长原样工作。口径变更的理由是
resume 与修订各自重开一次进程内时钟，而同卡的 tokens 是整条 lineage 的——四小时的 run 修订一次
之后报 12 秒。判据与「本世时长」的地板见根目录
`docs/dynamic-workflow/transcript-and-notifications.md` 的「How long it took」。

`listRunLifeSpans` 不进引擎的 `JournalStorePort`（引擎不读时长），与 `listRuns` 一族同规地
按能力探测接入，且**独立探测**、不并入 `supportsRunIntrospection` 的四条——缺它只让时长退回
本世，不该连坐 `GetWorkflowRun` 的可用性。

## 工作流创作工具的描述收短与技能门（2026-09-21）

```text
模型 CreateWorkflow{script|path} / AmendWorkflow{path|script} / SaveWorkflow / EvalWorkflowSnippet
  -> validateInput（不变）
  -> resolveInput：技能门（handlers/workflow-skill-gate.ts）
       context.hasLoadedSkill("dynamic-workflows")
         = runtime 扫 provider 可见历史（agent/loaded-skills.ts）：有一次成功完成的 Skill 调用才为真
       否 -> ToolHandlerFailure{errorCode 428}（早于 hook 与确认窗；文案指路 Skill 工具与重试的工具）
       是 / 探针缺席（会话没有 skillPort）-> 原有归一化
  例外：CreateWorkflow 只带 `saved`；AmendWorkflow 既无 `path` 也无 `script`
```

四个创作工具的 provider-visible 描述从合计约 1.9 万 token 收到每家几百 token（`*-description.ts`），
契约层的字段 `.describe()` 同步缩成一句；facade 声明（`FACADE_DTS`，约 4.4k token，此前在 CreateWorkflow
与 SaveWorkflow 各嵌一份）、写作规则、阶段与命名规则、Amend 的缓存与三态字段、Save 的文件格式与实参
声明、snippet facade 的范围全部搬进 `packages/bundled-skills/skills/dynamic-workflows/SKILL.md` §16
「Tool reference」，其中 facade 逐字嵌在 `<!-- facade-dts:start/end -->` 标记块里，由
`bootstrap/tests/dynamic-workflow-skill.test.ts` 钉与 `FACADE_DTS` 相等、且文件不超 Skill 工具的
`MAX_SKILL_BYTES`（原 §11 的完整示例因此迁到 examples.md §5）。描述里留下的只有决定「调不调」所需的
东西：CreateWorkflow 的点名路由与三条来源、AmendWorkflow 的修/扩/跑到一半就改/只改设定、SaveWorkflow
的绝不主动保存，以及四家共有的「先加载 `dynamic-workflows` 技能，否则拒绝」。

新增 `ToolInputResolutionContext.hasLoadedSkill?`（core/tool/types.ts）→ `ToolExecutorOptions` /
`ToolExecutorDeps` → call-runner 的解析上下文；runtime-tools.ts 只在 `deps.skillPort` 在场时注入探针，
用 `messageHistory.borrowReadOnlyRuntimeEntries()` 回答。判据取历史而不是会话级标志：compaction 用摘要
替换历史后技能正文已不在模型上下文里，门随之重新关上（与 Edit 要求 Read 同一种语义：compact 后
readFileState 只留补回给模型的文件）；resume / rewind 重建历史即重建答案，无第二套 hydration。输出形状、权限判定、事件、v4
协议与 UI 零改动。`DYNAMIC_WORKFLOW_SKILL_NAME` 从 bootstrap 迁到 contracts（core 与 bootstrap 共用）。
测试：`core/tests/workflow-skill-gate.test.ts`（四家 × 未加载拒绝 / 已加载放行 / 无探针放行 + 两条例外）、
`core/tests/loaded-skills.test.ts`（成功 / 未完成 / 出错 / 别的技能 / 旧 `{name}` 形 / compaction 后）、
`core/tests/workflow-routing-hints.test.ts`（路由信号 + 每家字符预算 + 无 facade）、
`core/tests/create-workflow-tool.test.ts` 与 `amend-workflow-permission.test.ts`、`saved-workflow-tools.test.ts`
的描述钉子改指技能。决策见仓库根 `docs/dynamic-workflow/authoring.md`「The authoring surface」→「The skill
gate」与 `docs/dynamic-workflow/launch.md`「When the model may call it」「What the model is told」。

## 工作流 facade 的流水线原语 channel / future（2026-09-22）

```text
模型 CreateWorkflow / AmendWorkflow / SaveWorkflow / EvalWorkflowSnippet{script}
  -> 编译：FACADE_DTS 多一段 stream（facade/dts-stream.ts：Channel<T> / channel() / future()）
       snippet facade 同含（片段可排练流水线纯逻辑）；SKILL.md §16.2 标记块随之重嵌，tripwire 钉相等
  -> 分析：channel / future 无站点（与 log 同）；`send` 入 HEAP_MUTATORS（生产者→消费者数据边）；
       `future` 入回调注册表（once + entered，async 体为 strand）；collectSitePhases(core) 产出站点→阶段名表
  -> lowering：channel<T>(n) -> __host.channel(n)；future(f) -> __host.future(f)
  -> 编译产物 CompiledDynamicWorkflowScript.sitePhases -> runWorkflowScript -> EngineConfig.sitePhases
       引擎铸造实例时词法优先、动态兜底（execution-engine.md「Identity: sites, ordinals, phases」）
  -> 沙箱：cell 第二段引导（dynamic-workflow-runtime/src/child-cell-streams.ts）实现队列与 future；
       停滞检测：每条 response 之后 setImmediate 上 __checkStalled —— 无在飞请求且未完成即
       error-complete（ChannelDeadlock 点名通道 / ScriptStalled），run 结算 errored 而不是永远挂着
```

工具的 schema、权限、事件、v4 协议与 UI 零改动；变的是四个创作工具接受的脚本语言（facade）与沙箱
的失败形态。决策见仓库根 `docs/dynamic-workflow/authoring.md`「Streams: `channel` and `future`」，分析器
侧见 `packages/dynamic-workflow/docs/analysis.md`「Phases」与「Heap writes」。测试：
`dynamic-workflow/tests/streams.test.ts`（编译 / 9001 / 数据边 / strand / 站点阶段表）、
`tests/engine/site-phases.test.ts`、`dynamic-workflow-runtime/tests/streams.test.ts`（真沙箱：投递、
FIFO 唤醒、ChannelClosed、死锁 / 停滞、词法阶段端到端）、`tests/facade-dts.test.ts` 重钉。

## node_repl 工具卡的 CUA App 身份（2026-09-17）

Computer Use 收进 `node_repl` 后，`mcp__node_repl__js` 的 display 需要额外承载目标 App 身份，
否则工具卡只能显示通用图标。链路与判据：

- `createToolResultDisplay` 的 CUA 分支按 `readCuaToolName`（要求工具名含 `computer_use`）分流，
  对 `mcp__node_repl__js` **不成立**，不要试图靠扩大该正则来复用 `kind: "cua"`：CUA 已不是
  独立工具，`toolName`、`structuredContent`、`errorCode` 等字段在 js 结果上都没有对应物。
- 身份走 `node_repl_images` display 的可选 `app: { appKey, displayName? }`。该 display 的
  `images` 因此改为可选：纯动作 cell 没有截图，但仍需要投影身份。kind 名保留（改名会让
  已持久化的 row 整段被 strict schema 剥掉）。
- 事实只能来自宿主：node-repl-host 的 CUA bridge 从 broker 响应读 producer `_meta`，写入
  `NodeReplRunResult.cuaApp`，再由 `toMcpRunResult` 落到 `_meta["zcode/nodeReplCuaApp"]`。
  沙箱可写通道送来的 producer 键必须删除（`nodeRepl.setResponseMeta` /
  `nodeRepl.emitStructuredResult` 都在模型可见 globals 上），处置同
  `ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY`。
- 三处 strict schema 必须同集：contracts 的 `toolResultDisplayPayloadSchema`、shared 的
  `toolCallDisplaySchema`，以及 `toProtocolToolCallDisplay` 的放行名单（`node_repl_images`
  已在名单内，扩字段不需要改它）。
- 完整展示合同见 `docs/cua/cua-tool-app-identity-summary.md`「node_repl 时代的身份来源」。

## 动态工作流工具面的按需注册（onDemand）

灰度 mode `onDemand` 不再折叠成 `alwaysOn`：十个工作流工具（与 Agent / Task 描述里那行
CreateWorkflow）推迟到会话第一次真的要用到它们时才注册；`/workflow` 目录项、技能、自动化页 tab 与
Resume 入口在两种模式下都在。决策与验收见仓库根 `docs/dynamic-workflow/launch.md`「On demand:
activation」（DWG-09 ～ DWG-13）。链路：

- **协议**：`dynamicWorkflowMode` 与 `dynamicWorkflowEnabled` 同行——shared 的
  `workspace/updateDynamicWorkflowPolicy`、`session/create`、`session/resume`（strict）与 v4
  `createSession` payload（additive）。Host（`zcodeAgentService`）的 `resolveDynamicWorkflowGate`
  返回 mode 而不是布尔，三条创建路径经 `resolveDynamicWorkflowSessionFlags` 同源下发；只认布尔的旧
  CLI 走已有的 compat 省略重试，按 alwaysOn 行事。
- **协议服务端**：`appRuntimePreferences.dynamicWorkflowMode` 与布尔并存；`createRecord` 经
  `resolveDynamicWorkflowRuntimeGate`（dynamic-workflow-policy.ts）写出两个显式布尔
  `runtimeConfig.dynamicWorkflowEnabled` / `dynamicWorkflowToolsOnDemand`（本次参数 → workspace 结论 →
  缺席按 alwaysOn）。
- **core**：激活态归 runtime（`dynamicWorkflowToolsActivated`，非 onDemand 出生即 true）；两处注册入口
  共用的 `resolveRuntimeDynamicWorkflowToolsIncluded(runtime)` 读 `enabled ∧ (¬onDemand ∨ activated)`。
  `runtime/methods/dynamic-workflow-activation.ts` 的 `activateDynamicWorkflowTools` 翻状态 →
  `refreshBranchAwareBuiltInTools` 重注册并清 cachedTools → 落 `runtime/dynamic_workflow_activation`
  entry（contracts 新增 `SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION`；首轮激活先于落盘时由
  `ensureSessionPersisted` 补写）。触发：bootstrap `create-app.ts` 的 builtin prompt resolver 展开
  `/workflow`（`resolveZCodeBuiltinPromptCommandInvocation` 带回命令名）、`trackResumedDynamicWorkflowRun`
  （GUI Resume）、`amendWorkflowRunSettings` 两条路（配置）、`startSavedWorkflowRun`（直接启动）、
  `resume.ts` 的 `restoreDynamicWorkflowActivationOnResume`（entry 在场，或持久化历史里有 `/workflow`
  用户消息 / 十个工具之一的调用——`isDynamicWorkflowToolName` 自 tool/handlers 导出）。只加不减：
  compaction、服务端翻转都不回收。
- **子会话**：`subagent.ts` 把父会话此刻的激活态折进子配置（未激活 → 子按需且无入口；已激活 → 子即时
  注册）；`script-workflow-child-runtime.ts` 对 actor 显式写 `dynamicWorkflowToolsOnDemand: false`。
- 输出形状、权限判定、事件、v4 投影与 UI 零改动。测试：`core/tests/dynamic-workflow-activation.test.ts`、
  `core/tests/subagent-explore.test.ts`（onDemand 两例）、`bootstrap/tests/dynamic-workflow-policy.test.ts`
  （mode 缓存 + 推导矩阵）、`bootstrap/tests/dynamic-workflow-on-demand.test.ts`（`/workflow` 经输入门面
  激活）、`bootstrap/tests/dynamic-workflow-skill.test.ts`、`bootstrap/tests/runtime-config.test.ts`、
  `packages/services/test/zcodeAgentService.dynamicWorkflowPolicy.test.ts`。

## 确认窗里调整子代理模型与并发（2026-09-22）

```text
CreateWorkflow / AmendWorkflow 的 resolveInput（端口在场时）
  -> 入参回填 adjustable_settings{subagent_model: 有无模型目录, concurrency_ceiling?}（无条件覆盖，模型伪造无效）
  -> PreToolUse / 权限规则 / prepareApproval / PermissionRequested 事件载荷（确认窗读入参里的这块）
用户在确认窗改值后选 Allow / 本会话始终允许
  -> v4 resolveInteraction.answer{optionId, content{subagent_model?: string|null, max_concurrency?: number|null}}
  -> bootstrap interaction-broker：只对两个工具的 allow 应答读 content，按契约 schema 校验、丢弃多余键
  -> PermissionBrokerResult.inputAdjustments
  -> core permission-flow：授权（含会话免确认）之后、handler 之前调 entry.applyInputAdjustments
     （模型经目录重新解析、上界钳进 [1, 天花板]、null 即删键；失败即工具失败，什么都不启动）
  -> ToolExecutionContext.inputAdjustments（已生效的值）-> handler 在 response 里先说一句「用户在确认窗调整了设置」
```

`adjustable_settings` 走**入参通道**而不是 `create_workflow` display：display 的字段集冻结，多一个键会让
严格解析它的客户端（聊天卡、legacy v3 的按 kind 查表）把整块连图一起丢掉；入参通道对所有版本都无
schema。模型面 JSON schema 不列它（与 `predecessor` / `script_line_offset` / `saved.draft` 同一姿态），
运行时 strict schema 收它为可选。旧 agent 不回填 → 新客户端照旧画纯文本条件行；旧客户端不认 → 忽略。

契约：`PermissionBrokerResult.inputAdjustments?`（contracts/interfaces/permission.port.ts）、
`WorkflowSettingsAdjustmentSchema` 与 `WorkflowAdjustableSettingsSchema`（contracts/tools/workflow-settings.ts，
两个工具的运行时 schema 各自 extend 它）；bootstrap 侧的应答读取在 `zcode-protocol/workflow-settings-answer.ts`；
core：`ToolEntry.applyInputAdjustments?`、`ToolExecutionContext.inputAdjustments?`、executor 的应用步骤在
`tool/executor/permission-input-adjustments.ts`，两个工具共用 `handlers/workflow-settings-adjustment.ts`。
Deny、Refine、PermissionRequest hook 胜出、legacy v3、TUI / headless 自动放行都不带调整。工具输出形状、
display kind、事件、journal、v4 协议 schema 零改动（`answer.content` 早已是 `record<string, unknown>`）。
决策与文案见仓库根 `docs/dynamic-workflow/launch.md`「Adjusting the settings in the window」与
`docs/dynamic-workflow/presentation.md`「The confirmation window」。

## 独立 CLI 的 `--workflow-mode`（2026-09-23）

TUI 与 headless（`--prompt`、`--target`）没有 Host 下发灰度 mode，改由进程参数
`--workflow-mode disabled|onDemand|alwaysOn` 决定十个工作流工具的注册面，**缺省 `disabled`**。决策与验收见
仓库根 `docs/dynamic-workflow/launch.md`「The standalone CLI: `--workflow-mode`」（DWG-14 ～ DWG-17），参数
契约见 `commands.md`。链路：

- **CLI 入口**（`cli/src/workflow-mode.ts`）：`run.ts` 解析并校验取值与作用域（`app-server`/`agent-server`
  与不建会话的子命令报错），`resolveWorkflowModeRuntimeConfig` 把 mode 折成两个显式布尔
  `dynamicWorkflowEnabled` / `dynamicWorkflowToolsOnDemand`，由 `prompt-command.ts` 与 `tui-prompt-handler.ts`
  写进每个 app 的 `runtimeConfig`。
- **bootstrap / core 零改动**：两个字段的全部后果沿用协议服务端已有实现——注册门
  `resolveRuntimeDynamicWorkflowToolsIncluded`、`Agent`/`Task` 描述行、`dynamic-workflows` 技能剔除、builtin
  resolver 不展开 `/workflow`、onDemand 激活（`/dwf resume` 经 `trackResumedDynamicWorkflowRun` 激活）。core
  「缺席即开」的极性不变，独立 CLI 只是不再让字段缺席。
- **命令面**：command center 的 `workflowMode` 依赖在 `disabled` 下给 `/workflow` 与 `/dwf resume` 返回本地提示；
  `listSlashCommandSuggestions` / `formatSlashCommandHelp` 按同一 mode 去掉 `workflow`；headless
  `-p "/workflow …"` 在建 app 前报错退出 1。
- 工具 schema、权限、执行、事件、v4 投影零改动。测试：`cli/tests/workflow-mode-option.test.ts`、
  `cli/tests/headless-workflow-option.test.ts`（`-p`/`--target`、resume/continue、denylist、stdio 隔离、
  中英文 help），以及 `cli/tests/headless-workflow.test.ts` 中需要工作流的用例改为显式 `--workflow-mode alwaysOn`。
- 取代 staging 同期的布尔 `--enable-workflow`（仅 headless、TUI 缺省开启）：该参数已移除，传入即未知参数。

## ReplyToChannel（2026-09-23）

2026-10-21：暂停内置暴露，后续由插件重新提供（本次不实现插件）。仅注释默认注册及 import、
Host 默认发送接线和模型调用提示；保留 handler、权限规则、CLI reply port、Host 反向请求处理、
远端 relay 协议、共享 schema、Bot 发送实现及对应测试。
模型上下文不再注入工具名、发送 refId、按名字查询或调用后去重指引，原提示源码保留为注释。
原生 mention 的有序位置、显示名与 isCurrentBot 仍用于判断分工；canonical 输入及其持久化不变。
普通最终回复继续自动回传。依赖默认入口的 MN-02/FN-01 组合 E2E 和窗口发送接线用例暂时跳过，
原用例及 fixture 完整保留，待插件接入后恢复；独立实现测试继续执行。
以下发送合同只描述保留的实现，不代表当前默认产品入口可用。

工具用当前任务绑定会话已确认的 mention refId 发送原生提及，包括客户端续聊引用历史目标；不接收群 ID、应用 ID 或裸用户 ID。
2026-10-08：新增 mentionName（name、可选 candidateRef），由 Host 在当前授权会话查询真实身份。
输入 schema/模型工具 schema/描述 → 当前执行输入 → 现有 reply port/协议 → Host 查询与复核
→ delivery 幂等 → 严格 sent/failed/unknown/invalidated 或 needs_clarification 结果。
名字按包含查询：唯一候选或唯一完整名字匹配直接发送，其余重名、无结果、权限不足均不发送。
保留多词名字，顿号/逗号/换行明确分隔多人；不得仅凭空格拆名。Host 查询全部名字，
needs_clarification.unresolved 返回全部未解决项（最多 50）；模型只询问这些项，不得声称已发送。
正常最终答复不自动识别 @ 文本；模型仅在用户明确请求时使用名字查询。保持已有权限、取消、
trace、tool result 持久化与跨端投影；候选输出有界，具体合同见根 Bot spec 的按名字提及章节。
input schema → executing canonical input identity → explicit reply port → authenticated Host → task channel binding / trusted mention resolution → Bot delivery owner → typed result。
botGroupSource 仅表达单条输入来源，不是调用前提；Host 唯一绑定决定群/话题，CLI 不选择历史消息充当当前授权。
保留 tool trace、取消、既有权限策略与结果预算；属于 network 副作用，非只读，非破坏性。
普通最终回复仍由 Bot 自动发送；仅用户明确要求发送/提及时使用，不能借普通文本恢复 mention 身份。
工作区与本地/远端身份验证在 Host，群授权及投递幂等在 Bot；不新增 accepted queue。

## 脚本为每个子代理点名模型（2026-09-26）

persona 可以点名子代理跑在哪个模型上：`agent(name, { model: "GLM-5.3-Flash" })`，或先用 facade 的
`model("…")` 声明成 `ModelRef` 再在运行期挑一个（路由）。决策与文案见仓库根
`docs/dynamic-workflow/authoring.md`「Choosing a model per subagent」、`docs/dynamic-workflow/launch.md`
「Models the script names」，优先级见 `apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md`
「Subagent sessions」。链路：

```text
脚本 agent(…, { model }) / model("x")
  -> 编译：9010（analysis/actor-models.ts）要求 model 的类型是 ModelRef / 字符串字面量 / 字面量联合，
     收集 AnalyzeResult.modelReferences；lowering 把 model("x") 抹成 "x"
  -> resolveInput（CreateWorkflow / AmendWorkflow）：handlers/workflow-script-models.ts 对着 ModelCatalogPort
     解析每个名字 -> 入参 `model_bindings`（名字逐字 -> 规范串；AmendWorkflow 同名沿用前驱快照的绑定）
  -> prepareApproval：有名字没绑定即不开窗；handler 报 9011（文件行），走编不过那条路
  -> 确认窗不逐名列出（脚本的选择就是作者模型的决定），只把模型那一句的开头改成「子代理默认运行在」；
     应答 content 没有 model_bindings，用户在窗里改不了名字的绑定
  -> port.submit / amend({ modelBindings: Record<name, ModelSelection> })
  -> run-launched.modelBindings（零 SQL，与 subagentModel 同车）-> 条目 / 快照 / 详情 / GetWorkflowRun <script_models>
  -> 建子代理会话：resolveActorPersonaModel(persona.model, bindings) -> workflowActorModelPolicy 的 actorSelection
     （persona 模型 > run 的 subagentModel > resume pin > 父会话模型）-> dwf_actor.resolved_model
  -> actor-created 进度载荷派生 `model`；ask 的 node-dispatched 重复出生事实时引擎带 `actorPersonaModel`
     （名字），宿主派生 `actorModel`（规范串）——冷回放同源
  -> shared 归约：WorkflowRunActor.model（两条出生路径同一个 workflowActorEntry，超 256 整个丢）
  -> UI：运行详情脊线的子代理行尾跟模型名、tooltip 带规范串（WorkflowRunPhaseList / WorkflowRunSpineParts）
```

- 契约：`WorkflowModelBindingsSchema`（contracts/tools/workflow-settings.ts，两个工具的运行时 schema 各自收它，
  模型面 JSON schema 不列）、
  `DynamicWorkflowRunSubmitRequest/AmendRequest.modelBindings`、`DynamicWorkflowRunSnapshot/Detail.modelBindings`、
  `GetWorkflowRunOutput.modelBindings`。引擎只记名字（`PersonaSpec.model`），从不解读；缓存身份比对不含
  `model`（engine/persona.ts 的 `personaIdentity`）。
- 其余两个启动方：中枢直接启动（`runtime/methods/dynamic-workflow-run-start.ts`，解不出即 `compile_failed`）与
  GUI「配置」（`dynamic-workflow-run-settings.ts`，沿用快照的绑定，解不出即 `model_unavailable`）共用同一模块。
- 兼容：入参通道无 schema，旧客户端忽略 `model_bindings`；`workflowRuns` 的 actor 多一个可选 `model`，非 strict
  对象，旧客户端丢键。旧 CLI 上写了 `model:` 的脚本得到 TypeScript 自己的错误（旧 facade 没有这个成员）。

## 类型化留白与 `FillWorkflowHole`（2026-09-28）

脚本可以留一个**类型化的空洞**：`await hole<Plan>("决定分组", `…${survey.slowest}…`)`。运行到这里，这一支停驻，
主代理在会话里写出一段代码补上（同一调用加上 `async () => {…}` 作第三实参），那段代码在留白**所在的词法作用域**里
编译、运行。决策与文案见仓库根 `docs/dynamic-workflow/authoring.md`「Holes: `hole<T>()`」、
`docs/dynamic-workflow/launch.md`「The `FillWorkflowHole` tool」、`docs/dynamic-workflow/transcript-and-notifications.md`
（`hole` 通知）、`docs/dynamic-workflow/presentation.md`「Holes on the timeline」；分析规则见
`packages/dynamic-workflow/docs/analysis.md`「Sites」（Hole sites）；引擎侧见
`packages/dynamic-workflow/docs/execution-engine.md`「Holes」。链路：

```text
脚本 await hole<T>(name, prompt?)
  -> 编译：站点 id 是留白**名字**的键 `hole#<8 位十六进制>`（FNV-1a，analysis/hole-id.ts；与嵌套深度
     无关，两名撞哈希报 9012）；留白体内铸造的站点加**一层**前缀 `<该留白 id>/…`（外层计数器看不见体内，
     体内再留的留白用自己的名字键、嵌套关系记在站点表 `fill` 上），所以补全**不改动任何既有 site id**，
     id 也不随接龙深度增长（修复原因：曾逐层拼接 `hole#1/hole#1/…`，八九步就过协议 64 字符上界）；9012（analysis/hole-sites.ts）：显式类型实参、字面量唯一名字
     （与 phase 标记同一命名空间，≤128）、必须 await、不在数组方法回调里、体是内联函数字面量且不引用
     留白之后声明的绑定；留白本身即一个阶段（id = site id，名字 = 留白名）
  -> lowering：`__host.hole("hole#21b40fca", name, prompt, __src => eval(__src)[, async () => {…}])`；
     `LoweredWorkflow.holeBodies[siteId]` = 有效脚本里该留白体的 lowered 文本 `(async () => {…})`
  -> cell（runtime child-source）：有体直接调用、不过线；无体先查 `__fills`，再发 request{type:"hole"}
     停驻这一支（兄弟分支照跑，停滞检测不触发）；应答 {code} 记住后在留白处 **直接 eval**，得到闭包
     再调用——每次到达都重建求值器，循环 / helper 里的留白拿到本轮绑定
  -> 引擎：hole(siteId, name, prompt) 铸序数（不落 node 行）、盖出生阶段、记 hole-reached、按 site 停驻；
     fillHole{siteId, code, script{text,hash}, askSpecs, sitePhases, phaseNames, holes?}：一次同步步里换
     规格表 / 阶段表（超集）、journal.updateRunScript（script_text 与 script_hash 同写）、记 hole-filled、
     记住 code、解开该 site 全部停驻；not_waiting / settled 皆为 no-op
  -> 通知：core runtime/methods/dynamic-workflow-run-progress.ts 由 hole-reached 发一条 kind:"hole"
     （siteId / ordinal / name / type / prompt / draftPath / line / before / after / reachedAt），正文
     `<workflow-hole>` 块 + 下一步（读草稿、只写语句、FillWorkflowHole）
  -> 模型 FillWorkflowHole{run_id, hole_id, script | path}
     handler（core handlers/fill-workflow-hole.ts）：技能门 -> 二选一 -> 内联体先写 **fill 文件**
     `<cwd>/.zcode/workflow-drafts/<slug>.<hole-slug>.dwf.ts`（铸 -2 / -3；path 提交不铸）->
     `fill_unchanged`（path 字节等于上次被拒的尝试）-> 审批按「本会话的 run 免窗」同一谓词
     （hole.owned_by_this_session 由工具回填，模型不可声称）-> port.fillHole
  -> run service（bootstrap dynamic-workflow-run-fill.ts）：读行里的脚本 -> 站点表定位留白 ->
     spliceHoleBody（体作最后一个实参）-> compileOnce（诊断按落点归属：体内 -> fill 文件行，体外 ->
     草稿行）-> checkSiteStability（旧 id 全在、新 id 全带前缀，否则 fill_ids_unstable，宿主故障）
     -> 引擎 fillHole -> 草稿**就地改写**为有效脚本（scriptPath 不变；「草稿绝不被覆盖」的唯一例外）
  -> 工具输出 = CreateWorkflowOutput（display 为有效脚本的图；卡片取本 run 最新的 display）
  -> 进度载荷：hole-reached（宿主补 type / reachedAt）、hole-filled（phaseNames + 对齐的 holes 下标表）
     -> shared 归约 workflowRuns[].holes / phaseHoles -> UI：留白站（虚线灯、类型徽章）、等待（警示环）、
     补全后的头行 + 悬停区域、留白通知行三态、FillWorkflowHole 工具行（CreateWorkflow 渲染器按工具名选词）
```

- 契约：`contracts/tools/fill-workflow-hole.ts`（`FILL_WORKFLOW_HOLE_TOOL_NAME`、输入 schema，输出复用
  `CreateWorkflowOutput`）、端口 `fillHole?` 与 `FillWorkflowHoleResult`（`run_not_found` / `hole_not_waiting` /
  `compile_failed` / `fill_ids_unstable`，诊断带 `inFill`）、快照与 `GetWorkflowRunOutput.holes?`（≤32，
  与 `pendingQuestions` 同规「无则缺席」）、`workflowNotification` 新增 `kind:"hole"`、display 新增
  `holes?` 与阶段 / 步骤上的 `fill?`——contracts 与 packages/shared 两侧镜像必须同步（见上文
  GetWorkflowRun 条目的教训）。
- 引擎：`WorkflowHostApi.hole`、事件 `hole-reached` / `hole-filled`、`run-launched.holes?`、
  `JournalStorePort.updateRunScript`（SQLite 与内存实现同受 journal contract 约束，零 SQL 迁移：两列已在）。
  留白不落 node 行：resume 重放的是有效脚本，已补全的留白在 cell 内直接跑体、不再发请求；停在等待时
  被停止的 run，resume 会重新到达并再问一次。
- 权限：与 AmendWorkflow「本会话的 run 免窗」同一条规则；另一会话的 run 或用户停过的 run 开窗，窗里画
  补全的草稿线（新站点全墨，两侧邻居 40% 虚影），列出体内新增的 `world.run` 命令；编不过的体不开窗。
- 兼容：旧客户端对 `workflowRuns[].holes` / `phaseHoles` 丢键；display 走 v4 信封的 catch 兜底（更早的
  客户端整帧被拒，同 GetWorkflowRun 条目）。旧 CLI 上写了 `hole()` 的脚本得到 TypeScript 自己的错误。
- 测试：dynamic-workflow `tests/hole-sites.test.ts` + `tests/graphs/hole-*.ts` 快照 + `tests/lowering/holes.ts` +
  `tests/engine/engine-holes.test.ts`；runtime `tests/holes.test.ts`（留白处 eval 读到前面的 const、循环逐轮绑定、
  抛错在留白处拒绝、有体不过线、停驻不触发停滞检测）；contracts / core / bootstrap / shared / ui 各自的
  handler、进度、归约、时间线模型用例；desktop e2e 用例已写、未跑。

## Skill 工具为 `dynamic-workflows` 放宽正文上限（2026-09-30）

`Skill` 加载 `dynamic-workflows` 时上限是 200 000 字节（`WORKFLOW_SKILL_MAX_BYTES`），其余技能仍是 100 000
（`MAX_SKILL_BYTES`），都在 `core/src/tool/handlers/skill.ts`。起因：这份技能从 2026-09-22 起一直贴在 100 000
上，每加一个功能都得先删掉已有的指导。决策与代价见仓库根 `docs/dynamic-workflow/authoring.md`「The skill」。

- 判据是请求里的技能名，与技能门（`workflow-skill-gate.ts` / `agent/loaded-skills.ts`）认的是同一个名字；
  同名的用户或项目技能会遮住内置那份，也拿到这个上限。
- 上限在 handler 里按技能选，再经 `SkillLoadRequest.maxBytes` 交给 adapter 截断；契约与 adapter 不变。
- 工具级的 `maxOutputBytes` / `resultBudget` 是静态的，取两者中大的那个加上外壳（`<skill_content>` 标签、
  Base directory 行）的余量 `SKILL_RESULT_WRAPPER_BYTES`，否则贴着上限的正文会被结果预算再从尾部截一刀。
- 测试：core `tests/skill-tool.test.ts`（两种技能各自传给 SkillPort 的上限、工具预算不小于最大上限加余量）；
  bootstrap `tests/dynamic-workflow-skill.test.ts` 的字节断言改看新常量。

## Execution fallback 无目标时的工具收口（2026-10-09）

Highspeed 等 execution-scoped 模型在流中已经接受完整只读工具后失败时，工具 settlement 与 fallback target
是否可用是两个独立决定，统一沿既有 coordinator → executor → session store 链路闭合：

```text
完整 tool_call → during-stream executor → provider/network failure
  → coordinator settlement（完成=真实 result；安全取消=cancellation；未知=synthetic interrupted）
  → executor 持久化终态 ToolPart + live provider history 提交配对 call/result
  → target 可用：切换模型继续；若提交了工具结果则重置 output-token continuation 预算
  → target 不可用：保留原 provider error 终止，不请求模型、不再发布 tool_abandoned
```

根因是旧 fallback helper 先解析目标、无目标便返回，调用方又为避免重复请求加速 provider 而跳过通用 recovery，
最终只执行 `abandon()`：已完成结果丢失、durable part 停在 pending/running，冷恢复才补造与 live history 不同的
interrupted result。修复不改变工具 schema、权限、执行时机、协议或 UI；只让工具调用的唯一 settlement owner
在决定是否继续模型请求之前完成持久化收口。回归测试覆盖 completed/running 两种工具状态、无目标时仅一次模型
请求、原错误传播、live/cold history 一致，以及三次输出续写后经工具 fallback 建立新 anchor 的预算重置。

### 2026-10-09 Bot 协作上下文

可信 Host 的 botGroupSource.botIdentity 与逐条 mentionedBot 贯穿持久化输入和模型上下文。
模型仅处理自身分工，无 @ 且无关时允许无工具、无可见回复；原生指向别人由 Host 阻止触发，
后续历史只作背景。共享协议沿用严格 botGroupInputSourceSchema，不新增工具或执行队列。

2026-10-09 机器人身份回归：Host 原生来源 → botGroupSource 持久化 → conversation-quotes
模型分工投影。可信 mention 增加由 botIdentity.openId 比对派生的 isCurrentBot，
区分同名机器人分工；不暴露其他目标 ID，不修改工具 schema、发送授权或 CLI admission。

身份定位补充：conversation-quotes 将原始有序 text/mention 节点逐条映射到模型专用
材料，保留同名手打文字与原生提及的区别，不改持久化正文或发送 ref 的授权边界。

2026-10-09 子代理模型的 provider 边界：`subagent_model` 与脚本 `model` 名字的解析（core `model-reference.ts`）
不再让裸 `modelId` 落到会话 provider 以外的条目上——裸名只在当前 provider 下找，只在别处有即
`other_provider` 业务失败并列出全称；跨 provider 只有全称一种写法，而技能、两个工具的字段描述与
`docs/dynamic-workflow/launch.md`「`subagent_model`」都改为：绝不自行把子代理换到用户没点名的另一个
provider 的模型上。起因是主代理照技能示例自选「轻量」模型，把子代理送去了另一张账单。目录无
`current` 条目时保持旧的「唯一就取、多个即 ambiguous」。全称仍能跨 provider，所以权限补上一道：
`AmendWorkflow` 的 resolveInput 最后一步（绑定表落定之后）算出 `predecessor.introduces_providers`——
这次将用的 provider（归一化后的 `subagent_model` 与 `model_bindings`）减去会话模型与前驱 `run-launched`
上用过的 provider，非空才在场；契约谓词 `isAmendWorkflowOwnedPredecessor` 见它在场即不给本会话 run
免确认，权限服务照常 ask（`tool.alwaysAsk`），Deny 不动前驱。同 provider 换模型、沿用前驱的选择仍免
确认；只改并发的就地调整与 `not_live` 落回不引入模型，不受影响。CreateWorkflow 本来就总开窗，不变。
schema 只多这个回填键（模型面 JSON schema 不列，带 `predecessor` 的调用照旧在校验被拒）；事件与
UI 不变，桌面只从前驱块读 `status` / `name`，旧客户端不受新键影响。

## 插件使用归属

ToolEntry 的 MCP pluginId 在执行准入时捕获，沿工具成功/失败事件、V4 tool.lifecycle、既有 agent_step 传递。保持 Skill 原字段兼容；普通 MCP 和未知归属留空，不从名字解析、不复制执行事件。仅增加可选 metadata，不改变工具执行、权限、存储和 continuous/replayable 交付。

## UI 插件后台首次创建

成功 MCP UI 工具结果沿现有 V4 投影提交后，以 `v4/plugin-ui/tool-result` 通知本地桌面宿主，
不依赖 conversation 订阅或工具卡片挂载。复用已校验的 display.ui 和投影输入；失败、取消、
MCP isError 和历史 hydration 不触发创建。工具执行、权限、原始结果和持久化不变；
手机 replayable 不消费创建副作用。测试覆盖无订阅实时结果、重复事件、历史恢复、后台建页与返回复用。
宿主执行/保留规则见根目录 `docs/plugin-ui-background-execution.md`。

### 文档插件多窗口视图修复（2026-10-16）

MCP app-only report_view 增加可选 viewId，release_view 释放指定窗口；模型 get_view 可选 viewId，缺省且存在多个上报窗口时返回歧义与清单。状态唯一归属 DocumentOwner，不由页面决定其他窗口的视图；旧客户端缺省 viewId 仍走 legacy 槽。show_in_viewer 保持专用 surface 路由并明确工具描述。导入仍为 app-only workspace 副作用；串行 admission、10 分钟未活动过期与部分文件清扫归 importer，完成副本不清理。覆盖 schema 到真实 MCP/AppBridge 的多窗口回归。

## Session 整体关闭（2026-10-28）

单任务 stop/restart → App.close → 各所属 runner 关闭准入、取消并等待真实执行与清理 → 释放资源。
Agent/SendMessage/旧 Workflow/动态 workflow 均保留工具 schema、权限与历史展示，后台仅脱离 turn。
取消结果沿既有工具/任务事件与持久化链返回；不能用 registry terminal 替代资源释放完成。
详见 ../session-runtime-lifecycle.md「所属工作整体关闭」；桌面与手机复用同一后端事实，无 schema 迁移。

### Session 关闭的执行与资源边界

Agent / Workflow 的执行结果不被浏览器等释放异常覆盖。所属 owner 持有未释放的 child，
正常后台工作结束后自动释放，主动关闭取消并等待；最终关闭依据当前资源释放结果，不重放模型执行。
MCP 调用取消归 session，物理共享连接归 pool；详见 [生命周期](../session-runtime-lifecycle.md#关闭契约收口review-修订)。

### 浏览器关闭路由修复（2026-10-29）

Browser js → BrowserControlPort → protocol broker 登记已校验路由 → Host/Main 执行。
关闭/轮尾/取消使用原控制资源路由，不再依赖活动 session；关闭等待真实结果并传播失败。
保持工具 schema、权限、会话身份、主标签页保留和子会话临时标签页策略；无协议和持久化迁移。

## Browser control scope 生命周期

node_repl browser-client → protocol broker → 已有 browserExecute 反向协议 → Host → Main owner。
声明 controlScopes 能力的后端首次使用前建立实例级作用域，内部 openScope/releaseScope 不暴露为模型工具。
业务命令与模型结果格式不变；作用域的准入、关闭屏障和重试契约见根 docs/session-task-restart.md。

Browser control scope 的 admission 失败可由下一次业务请求用原 ID 重试；未知结果保留释放责任，
只清除失败 flight。关闭优先于新 admission，不自动重放业务命令。Host ambient 无实例 ID 的
只读 list 汇总同一会话路由的受控页面；模型 execute、取消、释放仍严格隔离实例。

### 草稿 MCP UI 会话清理

V4 `deleteSession` 复用 `closeSessionRuntime` 的统一生命周期 owner：先通知删除并摘除运行实例，再取消该 session 的 UI 工具调用、撤销实例凭证和 App tool 注册，等待 session 前缀的资源退订完成后关闭 App。按实例发起的异步退订不能代替这个等待，否则多 server 退订会与 pool lease 释放竞争。不能依赖共享 MCP 连接退出清理；其他 session 可继续持有同一连接。回归在 `v4-cold-resume.test.ts` 覆盖删除中的调用和共享连接隔离。

### Agent workspace 身份回归（2026-10-26）

Bash 返回 resolvedCwd → 父 runtime 更新执行 cwd → Agent 创建 child 时分别继承稳定 workspace 身份与当前执行 cwd → SQLite 保留同 workspace 父子链 → 重启后目录 owner 校验及 V4 冷订阅。验证真实 cd、旧 child 错误 cwd、跨 workspace 拒绝；不改变 Bash 的 cd 语义或工具 schema。

## MCP 启动失败诊断（2026-10-30）

stdio stderr → adapter 有界缓冲与脱敏 → 已有 `McpServerStatus.error` → `mcp/list` → 设置详情。
连接失败在传输错误后附带最近 stderr，去除 ANSI；HTTP/SSE 不附带 stdio 信息。
界面处理建议只按已有 `failureKind` 国际化，不按错误文本分流；`tools/call`、工具结果、
权限、重试和错误分类不变。展示契约见根 `docs/settings-mcp-list.md`，CLI 回归在
`packages/adapters/tests/mcp.test.ts`，App 使用候选 E2E，不恢复业务单测。
