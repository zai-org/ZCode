# MCP 状态批量查询控制面

## 背景

MCP 设置页需要展示当前配置中各 server 的状态。旧方案在设置页初次加载时逐个执行真实连接检查，容易让 UI 刷新触发大量 control-plane 请求，也会把“配置状态展示”和“主动健康检查”混在一起。

## 目标

- 设置页初次加载使用一次批量状态查询，避免按 server 数量触发自动检查。
- 批量状态查询走独立的 `mcp-status` lane control-plane CLI 进程，与 plugin 管理命令（`plugins/*`）隔离进程；两者共用同一个内部 cwd（数据目录下的 `.zcode/plugin-workspace`，即 `getDataBaseDir()/.zcode/plugin-workspace`，默认等于 `~/.zcode/plugin-workspace`；E2E 隔离 HOME 或自定义 data dir 时不在 `~` 下），但不共用 stdio 连接。
- 保留单 server 主动检查能力，但只在用户手动检查或启用后检查时触发。
- 不把 MCP 状态下沉到 desktop main、relay 或 mobile remote 链路。

## 协议语义

- `mcp/list`：返回当前配置的 MCP server 状态快照。请求发往独立的 `mcp-status` lane control-plane CLI 进程；该进程持有独立的 `McpPort`，会用 runtime 同款 MCP adapter 刷新可信配置的连接状态，再返回 `status()` 的本地快照。project MCP 在未信任前仍只返回 `untrusted`，不会被连接。
- 进程生命周期：mcp-status lane 进程在首次 `mcp/list` 时惰性拉起，每个 host 最多一个（进程 key 是固定的内部 cwd）。它通过进程级连接池真正连上可信 MCP server 且完成后不断开，因此进程本身约 45 MB 之外还挂着 MCP 子进程；为避免这部分常驻，manager 对该 lane 启用 `idleTimeoutMs`（默认 5 分钟）：连接上没有请求在飞满 5 分钟即主动回收整棵进程树（`terminationKind=expected`、`terminationReason=idle-timeout`），下一次 `mcp/list` 透明地重新拉起（实测冷启动约 1 s）。chat / plugin lane 不启用空闲回收。
- 进程可观测性：spawn/ready/exit/error 事件经 `processLifecycleReporter` 上报 host → main → ARMS，payload 带 `lane`（`mcp-status`），与共用同一 cwd 和 command 的 plugin lane 进程可区分。
- 为什么要独立进程：CLI 的 ZCode Protocol transport 对同一条 stdio 连接上的请求严格串行（FIFO，只有 `session/stop` 可越队）。connect 模式的 `mcp/list` 会真正连接全部 MCP server，任一 server 握手不完成就吃满 30s 超时；此前它与 `plugins/uninstall` 等命令共用 plugin 管理进程，卸载被排在 30s 探测后面，UI 在 5 分钟请求超时内没有任何反馈（2026-09-03 线上复现：`uninstallPlugin` 等待 37s 直到用户强退，`mcp/list` 出现 60.5s = 两个 30s 首尾相接）。拆到独立 lane 后探测再慢也不阻塞插件管理，探测超时触发的进程回收也不再连坐在途的安装/卸载。
- `mcp/list` 可以带 `mcpServers` 显式输入。桌面设置页已经由 desktop main 解析 `~/.zcode/cli/config.json` 与 `.agents/mcp.json` fallback，并在真实 session create/resume 时把 enabled MCP 下发为 `params.mcpServers`；状态查询必须复用同一批 UI-resolved MCP，避免 control-plane agent 自己 `createConfig()` 读不到 `.agents` fallback 时把实际可用 server 标红。
- `mcp/probe`：保留为单 server 主动检查语义。只有用户显式检查或启用后检查时使用，结果可以和 `mcp/list` 不同。

因此 UI 不应把 `mcp/list` 结果解释成真实健康检查成功；绿色 connected 只表示快照来源报告为 connected。

## 数据流

1. UI MCP 设置页加载本地配置后，请求 `zcodeAgentService.listMcpServerStatuses(...)`，并传入当前 workspace 下 enabled 的 ZCode Agent MCP 列表。
2. service 通过 `getMcpStatusClient()` 使用 `mcpStatusProcessManager`（`lane: "mcp-status"`，独立于 plugin 管理的 `pluginProcessManager`）客户端发送 `mcp/list`。新版 agent 接收 `mcpServers`；旧版 strict agent 若拒绝该可选字段，service 会去掉字段重试一次。
3. control-plane CLI 进程内按请求 workspace 读取 plugin 配置；若请求携带 `mcpServers`，本地 ZCode Agent MCP 状态以这批显式输入为准，否则回退到 agent 自己 `createConfig()` 读取的 `mcp.servers`。
4. CLI handler 对可信配置调用进程内 `mcpPort.connectConfiguredServers(...)` 刷新本地 records；project untrusted MCP 从连接输入中剔除。显式 `mcpServers` 与 session create/resume 使用同一个 protocol-to-runtime 转换 helper，保持 timeout/env/header 等字段一致。
5. CLI handler 包装现有 `listMcpServerStatuses(...)` 返回 status snapshot；`status()` 本身只读本地 records，不再额外连接。
6. UI store 按当前本地 ZCode Agent MCP 行合并状态；plugin-managed 只读列表继续由 plugin 管理数据驱动，避免同名 server 串状态。

### 官方 MCP 的反向授权路由

Host 在每次 `mcp/list` 发出前，通过现有 client 工作区登记表记录实际探测目标，重试时也重新
登记。`mcp-status` CLI 的内部 cwd 只决定进程载体，不替代目标工作区身份。

```text
设置页 → Host 登记探测目标 → mcp-status CLI 的 mcp/list
                           → 官方 MCP 反向授权 → 校验登记归属与 Origin → 当前凭证
聊天 CLI → 原有 active runtime 归属校验（独立于探测 lane）
```

只有 Host 已确认的 `mcp-status` lane、合法的 `interaction/requestOfficialMcpAuthHeaders`
请求且 `consumer=mcp-server`（含缺省值）使用登记表路由，不要求与该项目的聊天 client 相同。
禁止将探测 client 写成聊天 owner，禁止在反向请求中补登记；其他请求、通知和旧聊天 client
继续执行原来的归属检查。未登记工作区、不同 identity、非法参数、其他 consumer 与不可信
Origin 不得通过该路径读取凭证。登记随 client 退出清理；切换项目不改写已登记目标的身份，
连接切换、OAuth 取消与 UI 迟到结果丢弃继续由现有 owner/epoch 规则控制。

Host 的路由拒绝日志只保留 lane、阶段、错误码和请求关联信息；不增加凭证缓存、计时器或重试。

2026-10-30 回归：候选 `settings/manual-review/pending/mcp-official-auth-routing.test.ts`
在 `official-mcp-auth-final` 中 3/3 通过，覆盖桌面、390px 手机、真实控制面进程的项目切换、
重建与五类恶意反向请求。精确覆盖边界见[覆盖矩阵](../testing/conversation-session-e2e-coverage-matrix.md)。

## UI 合并规则

- 合并仅作用于 `source === "zcodeagentmcp"` 的本地 MCP 行。
- 合并使用当前行的 `name`，但不得用 name 覆盖 plugin-managed 只读行。
- 设置页发往 `mcp/list` 的 `mcpServers` 来自当前 UI store 的 enabled ZCode Agent MCP，必须带 workspaceIdentity/workspacePath 的当前输入一起发送，不能复用其他 workspace 的缓存。
- 请求必须带 epoch 或等价版本保护，迟到的批量结果不能覆盖用户在请求期间编辑产生的 `changed`，也不能覆盖更新的手动检查结果。
- UI 仅为交互反馈写入的展示态（例如启用后立刻显示 `connecting`、禁用后显示 `unknown`）不得作废当前批量请求；只有配置、启停、workspace 身份这类会改变 agent 读取输入的操作才能推进 epoch。
- 设置页同一时间只允许一个 `mcp/list` 在飞；如果在飞期间又触发刷新，只合并成完成后的下一轮，避免多次点击开关把整批 MCP 连接排队到十几秒。
- runtime 状态映射到 UI 状态时，`failed` 映射为 `error`；`connected`、`connecting`、`disconnected` 保持可展示语义；`disabled`、`untrusted` 显示为非成功配置态并带安全说明。
- status snapshot 可选携带稳定 `failureKind` 与 `serverRequestId`。`error` 继续保存原始详情，UI 不直接把它当用户主文案。
- stdio 启动失败的 `error` 合并传输错误和已脱敏、去 ANSI、限长的最近 stderr；分类和连接
  生命周期保持不变。详情 Popover 按稳定 `failureKind` 展示下一步建议，具体规则见
  [设置 MCP 列表](../settings-mcp-list.md)。不增加协议字段或第二份诊断状态。
- 可信官方 HTTP MCP 只读取响应头 `X-Request-Id`；连接、initialize、`tools/list` 的诊断可进入设置页，`tools/call` 的 request id 只进入对应工具结果。无 HTTP response 的 stdio、DNS、timeout 不伪造 id。
- ZCode envelope `3001`、`1000`，JSON-RPC `error.code=1006/3101`，HTTP 429/5xx 与其他 JSON-RPC error 分别映射为 `server_not_found`、`server_unavailable`、`not_authenticated`、`coding_plan_required`、`rate_limited`、`server_internal_error`、`protocol_error`；无法细分时使用 `connection_failed`。

## 验证

2026-09-06 合并恢复：此前插件 UI 已恢复，但服务层的独立 lane 被遗漏。本次按原控制面边界
接回 manager、请求归零事件与空闲回收，不恢复旧 Provider Store。子进程隔离专项 4/4、
完整 `zcodeAgentService` 单测 45/45 通过；这不是设置页真实交互验收的替代。

- 初次打开 MCP 设置页只触发一次 `mcp/list`，不在 UI 层逐个自动检查。
- `mcp/list` 会在 `mcp-status` lane CLI 进程内刷新可信 MCP 的 live status，配置正确但不可达应显示 failed/error，可连接应显示 connected 和工具数。
- `mcp/list` 在飞（例如某个 MCP server 30s 握手超时）期间，`plugins/uninstall`、`plugins/list` 必须立刻返回，不得排在其后（services 单测 `plugins/uninstall 不会排在挂起的 mcp/list 后面`）。
- 只有 `.agents/mcp.json` fallback 的 server 在设置页展示时，也会随 `mcpServers` 进入 `mcp/list` 并返回 snapshot，不再出现 `MCP server status was not returned by agent` 假红。
- 手动检查或启用单个 server 时才触发主动检查。
- 同名 local/plugin MCP 不串状态。
- 失败摘要中英文可切换且使用普通次要文字颜色；原始英文错误只在点击信息按钮后通过 Popover 显示，服务端 Request ID 作为详情文本的紧凑后缀出现，不再独立重复展示。成功刷新会清除旧诊断。
- 批量结果迟到时不会覆盖用户编辑或更新的手动检查结果。
- 重复点击开关或 React dev 重复触发 effect 时，不会产生重叠的 `mcp/list` 队列；最多在当前请求完成后补跑一轮最新输入。
- 桌面端通过 CDP 验证 Settings → MCP Servers 无重复刷新循环、console 无错误、状态正常渲染。

## 工作区 MCP 手动信任（2026-10-23）

设置 `mode=status` 只复用当前工作区已有的设置连接；没有匹配连接时按配置返回状态，不接管共享连接、取消 OAuth 或清理其他工作区。只有 default/connect 请求可以切换设置连接的所属工作区。

本轮仅处理工作区直接 MCP（`.zcode/config.json` 和已有 `.agents/mcp.json` fallback）。
插件贡献的 MCP、用户级普通 MCP 保持现有行为。复用 Hooks 的目标 Host、workspaceIdentity、
逐条带外审核和用户域持久记录；Hook 与 MCP 的批准互不继承。

```text
工作区 MCP 当前有效配置 → 不可变声明摘要 → 设置逐行审核
Desktop / Mobile → 同一目标 Host 重读并核对摘要 → 用户域记录
会话 / 设置 / subagent / 后台 UI → MCP port 准入 → 连接池 → stdio/HTTP/SSE
新一轮连接准入遇到未信任 / 已修改 / 已撤销 → untrusted，不建立连接，普通聊天继续
```

记录绑定 workspaceIdentity + server name + 来源路径 + 有效配置。command/args/cwd/env、
URL/headers/oauth/auth、协议版本等均进入固定版本 SHA-256 摘要；enabled 与信任正交。
env、header、OAuth 的值只参与摘要，不保存进记录；审核 UI 只显示这些字段的名称，
并过滤命令中的常见密钥参数、URL query 和用户信息。UI 同时显示配置来源。
用户域 `security/workspace-mcp-trust-v1.json` 复用跨进程锁与私有原子写；项目不能指定其位置。
连接准入遇到损坏、未知版本或读取失败时默认拒绝。授权只接受当前 server name 与精确摘要，重读后不符即拒绝。

连接准入未通过时禁止 spawn、HTTP/SSE、OAuth discovery 和凭据发送。新建、冷恢复或重启会话时，外层 gate 的
连接准入会重读当前声明与授权；显式重新配置连接及连接池 lease 接入也必须经过准入。正在检查的工作区声明默认拒绝使用。连接内的工具/资源请求、状态、
工具列表与 ping 只检查 gate 已有的内存准入结果，不重复读配置或信任文件。

2026-10-26 确认接受延迟生效：撤销信任、外部修改/删除/禁用配置、授权文件损坏，不中断已批准
会话的后续调用。会话内的底层断线重连、OAuth 恢复沿用这次准入的配置与授权，不重读授权文件；
新建或重启会话时重新检查。提示可提前反映当前持久状态，但不修改运行中会话的授权。
显式断开、关闭或 workspace gate 失效仍立即禁止使用；已有连接按原生命周期释放，不回滚已提交副作用。
这里的“重启会话”指重新创建 Agent runtime/gate，切换会话页面、继续发送消息或底层自动重连均不算重启。
不增加 watcher、计时器或第二套授权缓存，复用 gate 的配置与 blocked 状态。

```text
连接准入 → 读取当前配置与授权 → 固定该连接的准入结果
会话内调用 / 列表 / 状态 / 自动重连 → 沿用本次 gate 准入
持久授权或配置改变 → 提示刷新；新建或重启会话时重新读取
```

已跳过连接不自动重放；手动信任后由用户刷新/检查或下一次会话启动触发连接。
配置变更后的声明没有匹配授权记录时必须重新审核；同名 server 不跨 workspaceIdentity 继承。旧客户端没有入口时继续拒绝。
信任只覆盖声明，不覆盖脚本、二进制、依赖包或远端服务的完整供应链。

验收：真实无害 stdio 标记与最小握手、HTTP 请求计数；首次打开/创建/恢复/刷新零未授权
副作用；授权、声明变化、撤销、跨 workspace、并发写入、损坏存储及用户/插件 MCP 兼容；
桌面和手机设置逐行信任、撤销 E2E；陈旧目标和过期摘要的单元回归。

子代理具名 MCP 引用保留父级来源，内联声明不得携带 Host 专属 source/official 字段。
已捕获的子代理工具描述不重写；其调用仍通过父 MCP gate，沿用同一连接准入结果和失效边界。

边界回归约束：

- 设置 lane 切换 workspace 时，先使旧 gate 失效，再串行释放旧连接；旧 OAuth/握手迟到后不得启动旧 workspace 的后续连接。关闭旧 gate 不关闭进程共享的 raw lease。
- 审核摘要与 Host DTO 采用相同的 stdio 命令归一化；Windows `cmd /c` 包装与 `environment -> env` 不得造成“已信任但拒绝连接”。`isolation` 按现有执行字段校验并参与摘要。
- fallback 逐条校验；无效条目保持拒绝，不拖垮其它 MCP 的列表与连接。项目配置无法读取时不提供可批准声明，用户级 MCP 的来源仍由配置装配层标明。
- `.zcode` 的 MCP map 为空时允许 `.agents/mcp.json` fallback；已有项目条目（包括无效条目）不能因校验失败而被 fallback 替换。
- 按 subscriber 清理订阅属于生命周期释放，不需要重新授权；其它 server 未信任或当前 server 已撤销均不得阻止清理。

### 会话内引导与状态语义

沿用 Hooks 的输入框权限控件旁图标弹层：首次 MCP 初始化及后续真实用户输入被消费时读取当前工作区准入，只有已启用且
尚未信任的直接 MCP 计入待审核数量；普通聊天继续。Agent 发布 `WorkspaceMcpAdmissionUpdated`，
投影到可选的 `snapshot.workspaceMcpAdmission`，Desktop continuous 与 Mobile replayable 共用
同一 Host 的事件和快照。状态包含 `pendingCount`、声明集合的 `bundleDigest` 与 `workspaceIdentity`，
不携带命令或凭据。集合摘要只用于提示去重，不能用于授予 MCP 执行权限。

```text
当前声明与授权 → MCP gate 重读 → 会话事件 / 快照 → 输入框权限旁 MCP 图标 / 点击弹层
设置逐条信任 / 撤销 → 同 workspace 活跃会话重读 ─────────────┘
```

提示刷新不再挂在每个模型步：普通 prompt、排队输入实际消费及用户 guide/steer 各刷新一次；
用户显式启动的 `workflow_launch` 也按真实输入处理；带附件时仍以原始输入来源判断。
首输入复用 MCP 初始化的读取。模型续步、工具往返、重试及 goal/后台/协调者注入不额外刷新。
外部配置编辑在下一条真实用户输入被消费后反映到提示；初始化、恢复和显式授权/撤销通知保留。
不增加 watcher、计时器或读取器重构；现有同步配置读取在这些低频边界仍保留。
提示刷新不授予或撤销现有连接的执行权限；连接准入仍是执行授权边界。

MCP 与 Hook 使用独立图标。首次待审核声明显示未读点，点击图标打开弹层并标为已读；
再次点击、点击外部或按 Escape 关闭弹层，仍保留图标。弹层显示待信任数量及原有生效说明，
提供「去审核」和「忽略」。已读/忽略只在 renderer 内按提醒类型、workspace、session 和声明摘要隔离，
同会话多 pane 共享状态；新声明或页面重载重新显示未读点，切换声明时不继承展开状态。
桌面和手机使用同一组件，支持键盘、触摸、中英文及深浅主题；不新增配置读取或授权请求。

「去审核」使用现有设置导航意图打开 MCP 分区并选择当前工作区；不自动信任或连接。
设置页首次打开和已挂载时均消费目标 scope；确认文案说明已跳过的会话工具需要在新会话加载，
设置页刷新只检查连接，不向当前会话补注入工具。
「忽略」仅在本次 renderer 生命周期隐藏当前 session + workspace + 声明集合；声明变化或
页面重载后重新提示。pending 清零时提示消失；冷恢复先清理旧运行态的提示，再以当前声明重算。
准入重读与事件发布串行，旧读取结果不能覆盖较新的授权状态；已关闭 gate 不再发布。
准入提示事件属于配置投影，不是用户活动；冷恢复及信任/撤销后的提示刷新均保留原会话活动时间和列表排序。
设置写入成功后通知同工作区活跃会话，失败只记录刷新告警，不把已成功的授权写入误报为失败。

设置行保留独立 `untrusted` 状态，显示「当前声明待信任」及警示状态点，不使用
`status_unavailable` 或旧的「显式连接」错误文案。缺少 `workspaceTrust` 时仍说明未授权，
但信任按钮保持禁用；只有 Host 提供当前可审核声明后才允许提交。未知连接状态仍用 `unknown`。
