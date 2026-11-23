# ZCode CLI 架构设计 v2

## 文档定位

`architecture-v2` 是架构边界文档，不是接口实现文档。

它保留 `architecture-v1` 中有价值的模块划分、依赖方向、状态原则和演进顺序，但刻意删除所有过早的代码细节。本文可以保留候选变量名、模块名、接口名和事件概念，但不定义字段列表、方法签名、枚举全集、协议载荷、类实现、示例代码或数据库结构。

原因很简单：Coding Agent CLI 的模块边界必须经过一线实现者、测试者和真实用户流程反复反馈之后才能稳定。架构师此时应该先定义方向、约束、验证问题和反馈闭环，而不是提前把每个 port、schema、tool contract、provider capability 和 storage record 写死。

本文的目标：

- 明确系统分层和依赖方向。
- 明确哪些能力必须收敛到基础设施边界。
- 明确 core 能依赖什么、不能依赖什么。
- 明确哪些接口只是候选名，尚未进入稳定 contract。
- 明确实现阶段中需要由执行反馈推动的详细设计。

本文不做的事：

- 不写 TypeScript 伪代码。
- 不写具体字段、方法和参数。
- 不写完整 RPC 方法表。
- 不写 provider、tool、storage、sandbox 的最终 schema。
- 不把示例实现当成架构决策。

---

## 一、总体架构

ZCode CLI 按四层组织：

- `app/bootstrap`
- `application/core`
- `adapters/infra`
- `contracts/`

### 1.1 分层职责

`contracts/` 是所有跨边界交互的契约层。它只承载稳定 schema、port 名称、capability 描述、event 语义、错误类型和权限元信息。它不依赖业务实现、adapter、UI、provider SDK、文件系统、网络或进程环境。

`core/` 是业务状态机和调度层。它负责 session、turn、agent loop、tool lifecycle、permission、compact、rewind、subagent、mailbox、memory、hooks、mode 等领域逻辑。core 只表达意图，不直接触碰外部世界。

`adapters/` 是外部 I/O 实现层。它负责文件系统、子进程、网络、SQLite、artifact、provider、MCP、ZCode app-server、config loader、logger、metrics、sandbox 等具体副作用。所有 adapter 都必须通过 contracts 暴露能力。

`bootstrap/` 是组合层和入口层。它负责 CLI、TUI、server、SDK 等入口的启动、依赖装配、渲染、退出码和进程边界。它是唯一允许把 core 和 adapter 组装到一起的地方。

### 1.2 分层职责详细说明

#### contracts/

**职责**：
- 定义所有跨边界交互的 port 接口
- 定义 session event 类型和语义
- 定义错误类型和错误码
- 定义 provider/tool 的 capability 描述
- 不承载任何业务逻辑或实现细节

**内部结构**：
```
contracts/src/
├── interfaces/         # Port 接口定义
├── events/           # Event 类型和语义
├── errors/           # 错误类型和错误码
└── capabilities/    # Capability 描述
```

#### core/

**职责**：
- 业务状态机实现
- agent loop 驱动
- turn 调度和状态转移
- session 管理
- tool、provider、permission 的编排
- 不直接调用外部 I/O

**内部结构**：
```
core/
├── src/
│   ├── agent/        # AgentRuntime - 核心调度器
│   ├── session/      # Session 管理
│   ├── tool/        # ToolSystem
│   ├── permission/  # PermissionService
│   ├── provider/    # Provider 编排
│   ├── hooks/       # HookRunner
│   ├── subagent/    # SubagentRuntime + Mailbox
│   ├── state/       # Compact + Rewind
│   ├── memory/      # MemoryPipeline
│   └── sandbox/    # SandboxPort
```

#### adapters/

**职责**：
- 实现 contracts 定义的 port 接口
- 处理所有外部 I/O 副作用
- 文件系统、子进程、HTTP、SQLite 等具体实现
- provider SDK 适配

**内部结构**：
```
adapters/
├── storage/   # SQLite、File 等存储实现
├── fs/       # 文件系统
├── exec/     # 子进程执行
├── http/     # HTTP 客户端
└── provider/ # 模型适配器
```

#### bootstrap/

**职责**：
- composition root
- 依赖注入配置
- 各层装配
- 应用启动和退出

---

### 1.3 依赖方向

允许的编译依赖方向：

- `bootstrap` 可以依赖 `contracts`、`core`、`adapters`、`cli`、`tui`。
- `core` 只依赖 `contracts`。
- `adapters` 只依赖 `contracts`。
- `contracts` 不依赖任何上层。

禁止的依赖方向：

- core 依赖 adapters。
- core 依赖 provider SDK。
- core 依赖 SQLite、文件系统、网络、子进程、`process.env`。
- adapters 依赖 core。
- contracts 依赖 core、adapters 或 bootstrap。

运行时可以通过依赖注入反向调用 adapter 能力，但编译依赖必须保持单向。

### 1.4 启动原则

启动流程只保留架构顺序，不固定实现细节：

1. 入口层解析最小启动信息，并创建顶层执行上下文。
2. 配置系统按明确优先级合并默认值、用户配置、项目配置、环境变量和 CLI 参数。skill 与命令的启停开关（`skillOverrides`、`commandOverrides`）按路径合并：用户和项目各停用一个 skill，两个都停用。其他嵌套对象的合并规则见[配置合并存量问题](../../../../../docs/issues/config-merge-legacy/01-nested-fields-replaced-by-higher-layer.md)。
3. 所有项目自有环境变量使用 `ZCODE_` 前缀。
4. bootstrap 创建基础 adapter，并把它们注入 core。
5. storage 执行必要初始化和迁移。
6. core 恢复或创建 session，并通过事件重放生成 projection。
7. UI、CLI、SDK 或 server 订阅状态变化。
8. 每一轮用户输入都通过 session event 推进，而不是靠隐式内存状态推进。

### 1.5 CLI/TUI 默认入口契约

面向人工交互时，`zcode` 不带命令和参数应默认进入本地 TUI，而不是打印 help。`zcode tui` 是同一入口的显式别名；`zcode --prompt <text>` 继续作为脚本友好的单轮非交互入口。

TUI 默认占用整个终端屏幕，底部保留输入框，回车提交当前问题；上方按时间顺序展示用户消息和 agent 回复。TUI 只负责输入采集、布局渲染、状态提示和退出清理，不直接持有 provider、tool、permission 或 event store 的内部实现。

TUI 模式下入口层必须在加载 bootstrap、provider、storage 等可能产生进程级诊断输出的模块之前接管 raw `process.stderr`。正常 TUI 会话期间 raw `stderr` 不得直接写入终端，避免 Node runtime warning、adapter warning 或后台诊断破坏全屏界面；这些输出应先进入 TUI 诊断缓冲或受控日志。入口层、参数解析和 TUI 启动失败等受控错误可以通过显式 passthrough 写回终端，避免真实错误静默，但不得把启动期 raw warning 直接刷回用户界面。非 TUI 的 CLI 模式继续保持 Unix 风格 I/O 契约：结果写 `stdout`，诊断和错误写 `stderr`；入口层只能过滤已经明确归因、不会改变用户操作结果的 Node runtime warning，例如 Node 24+ 加载 `node:sqlite` 时打印的实验性 SQLite 提示，不能把全量 `stderr` 静默。

TUI 提交问题时通过入口层注入的受限回调进入 bootstrap/core。该回调负责创建或复用 session、传递同一个 trace 链、执行 turn，并把最终回复返回给 TUI 渲染；同一个 runtime 内的后续提交必须复用 session 级 message history，而不是每轮重新构造上下文。这样可以保证连续多轮的本地 agent CLI 交互体验，同时仍保持 UI 与业务状态机的边界清晰。

---

## 二、仓库结构

```
packages/
├── contracts/          # 协议层 - port、event、error、capability 定义
│   ├── src/
│   │   ├── interfaces/
│   │   ├── events/
│   │   ├── errors/
│   │   └── capabilities/
│   └── package.json
│
├── core/              # 核心业务层 - agent runtime、session、tool 等
│   ├── src/
│   │   ├── agent/
│   │   ├── session/
│   │   ├── tool/
│   │   ├── permission/
│   │   └── ...
│   └── package.json
│
├── adapters/          # 适配器层 - 外部 I/O 实现
│   ├── src/
│   │   ├── storage/
│   │   ├── fs/
│   │   ├── exec/
│   │   ├── http/
│   │   └── provider/
│   └── package.json
│
├── bootstrap/         # 组合层 - 依赖装配和启动
│   ├── src/
│   └── package.json
│
├── cli/               # CLI 入口
├── tui/               # TUI 入口
├── shared-types/      # 共享类型
└── swift-bridge/     # Swift 桥接（不动）
```

---

## 三、接口成熟度

v2 引入接口成熟度，而不是一次性定义所有接口。

### 3.1 成熟度分层

`L0 Concept`：只确认领域概念和边界。例如 `ToolRuntime`、`ProviderAdapter`、`SessionEventStore`。

`L1 Candidate Contract`：出现候选接口名、职责和约束，但不承诺字段、方法和错误形态稳定。

`L2 Executable Contract`：经过首轮实现验证，补齐 runtime schema、错误类型、权限元信息、超时和取消语义。

`L3 Stable Contract`：经过真实工具、provider、session 恢复、跨平台测试和失败路径验证后，进入稳定 API。

### 3.2 反馈闭环

每个关键 contract 的落地必须经历：

1. 架构提出边界和不变量。
2. 执行者做最小实现或 spike。
3. 记录实现中被迫泄漏的细节、重复的适配逻辑和难以测试的路径。
4. 架构根据反馈调整 contract。
5. 补齐 schema、错误类型、测试和观测点。
6. 再决定是否提升成熟度。

### 3.3 不能提前稳定的接口

以下 contract 不能在 v2 里写死细节：

- `Tool`
- `ToolRegistry`
- `ToolRuntime`
- `ProviderAdapter`
- `ProviderCapabilities`
- `ModelCapabilities`
- `FileSystemPort`
- `FileWriteAdapter`
- `ExecutionPort`
- `HttpClient`
- `SandboxPort`
- `PermissionPort`
- `SessionEventStore`
- `ArtifactStore`
- `MemoryPort`
- `Transport`
- `McpAdapter`
- `AppServerTransport`

这些名称可以作为候选边界出现，但字段、方法、schema 和错误形态必须在单独设计和实现反馈后确认。

---

## 四、应用层通信架构

核心逻辑和交互层之间需要有明确协议边界，支持本地直连和远程代理两类形态。

### 4.1 本地模式

CLI 和 TUI 在本地模式下可以和 core 运行在同一进程。交互层不直接读写 core 的内部对象，而是通过统一传输边界提交命令、订阅事件和读取 projection。

候选命名：

- `Transport`
- `LocalTransport`
- `AgentCore`
- `ServerNotification`

这些名称只代表方向，不代表最终接口签名。

### 4.2 远程模式

远程模式服务于 SDK 集成、远程 TUI、后台 server 或多进程场景。远程协议需要支持请求响应、服务端推送、取消、错误归一化、trace 传播和权限交互。

候选命名：

- `WebSocketTransport`
- `JsonRpcServer`
- `RpcRequest`
- `RpcResponse`

v2 不定义具体 RPC 方法表。RPC 方法必须从真实 CLI/TUI/SDK 操作流中沉淀，而不是从架构文档里一次性枚举。

### 4.3 通信原则

- UI 订阅的是事件流或 projection，不订阅 core 内部对象。
- 远程协议携带 trace 上下文。
- 大体积内容不直接塞进协议消息，应进入 artifact/storage 后返回引用。
- 协议错误必须可被 UI、日志和自动化测试稳定识别。
- 本地和远程模式尽量复用同一组领域命令和事件语义。

---

## 五、横向能力

横向能力必须优先设计边界，因为它们会贯穿所有模块。

### 5.1 Logger 与 Trace

日志和 trace 是一等基础能力。每个 session、turn、message、tool call、provider request、permission、subagent、storage 操作和外部 I/O 都应归属到同一个顶层 `traceId` 之下。

详细契约见 [logging.md](./logging.md)。

候选命名：

- `Logger`
- `TraceContext`
- `ExecutionContext`

设计约束：

- trace 必须能跨异步任务传播。
- trace 必须能跨进程或远程协议传播。
- 日志不得默认泄露密钥、token、隐私数据或完整用户内容。
- adapter 和 core service 都必须接收上下文，而不是临时生成不相关的 trace。

### 5.2 Config

配置是显式层级系统，不是散落的环境变量读取。

配置优先级应保持清晰，至少覆盖：

- system default
- user config
- project config
- session config
- environment
- CLI arguments

设计约束：

- 自有环境变量统一使用 `ZCODE_` 前缀。
- 安全相关配置需要能追踪来源。
- core 不直接读取环境变量。
- provider、model、tool、sandbox 等差异不应全部塞进基础配置。
- 配置订阅应是 scoped 的，不应变成全局广播。

候选命名：

- `ConfigPort`
- `RuntimeConfig`
- `ConfigStorage`

### 5.3 Storage

存储需要区分事实、视图和大体积内容。

存储分层：

- `EventStore`：session truth，append-only。
- `Projection`：可重建查询视图。
- `ArtifactStore`：大体积结果、附件、模型流片段、工具输出引用。
- `ConfigStorage`：配置持久化。
- `MemoryStore`：跨 session 的长期记忆。

设计约束：

- session event 是事实来源。
- projection 损坏后可以丢弃重建。
- 大体积 tool result 不直接回灌模型上下文。
- storage adapter 必须处理迁移、并发、损坏恢复和结构化错误。
- 具体数据库表结构不在 v2 定义。

候选命名：

- `SessionEventStore`
- `ProjectionStorage`
- `ArtifactStore`
- `MemoryStore`

### 5.4 Feature Gate

默认使用本地 feature gate。远程 feature flag 只能是可选 adapter，不能成为 P0 启动路径。

设计约束：

- 网络不可用时 CLI 仍可启动。
- 远程 gate 必须有本地 fallback 和 kill switch。
- feature 判断需要可测试、可追踪。
- 远程服务、代理、自定义证书等细节收敛到网络 adapter。

候选命名：

- `FeatureGate`

### 5.5 i18n

i18n 用于 UI 文案、错误提示和用户可见消息。它不应把业务错误变成普通字符串。

设计约束：

- 错误类型和错误码先稳定，再做本地化。
- core 可以依赖消息 key，但不能依赖 UI 渲染。
- 至少支持中文和英文。
- fallback 规则必须明确。

候选命名：

- `I18n`
- `MessageKey`
- `Locale`

### 5.6 Network

所有网络访问收敛到统一网络边界，不能在业务模块里直接调用底层网络 API。

设计约束：

- 支持超时、取消、重试、退避、代理、自定义证书和错误归一化。
- trace 上下文必须传播。
- provider、MCP、远程 feature gate、web fetch 等都走同一类网络 adapter。
- 网络错误不能只靠文本判断。

候选命名：

- `HttpClient`
- `RequestOptions`

---

## 六、Core 层模块

core 是业务状态机。它只依赖 contracts，不直接做外部 I/O。

### 6.1 Agent Runtime

Agent Runtime 是核心调度器，负责接收输入、推进 turn、调用 provider、调度工具、处理取消、恢复 session 和生成事件。它不承载具体业务逻辑，而是编排各子系统。

设计约束：

- 任何状态推进都先形成 session event。
- 内存状态只是 projection 或运行时缓存，不是 truth。
- 模型流、工具调用、权限请求、错误和取消都要事件化。
- crash recovery 依靠事件重放。
- rewind 不删除历史，而是追加新的状态变化。

候选命名：

- `AgentRuntime`
- `SessionService`
- `EventReducer`
- `SessionProjection`
- `ConversationView`
- `ToolCallView`
- `PendingPermissionView`

### 6.2 Session Event

Session Event 是系统的事实来源，但 v2 不定义具体事件字段和完整事件枚举。

事件语义需要覆盖：

- session 生命周期
- turn 生命周期
- message 生命周期
- model request 和 streaming
- tool call 生命周期
- permission request 和 resolution
- checkpoint、snapshot、compact、rewind
- artifact 生命周期
- subagent 和 mailbox
- error、cancel、interrupt

设计约束：

- 事件必须带有可传播上下文。
- 事件必须可持久化、可重放、可迁移。
- 事件 payload 需要 runtime schema。
- 事件版本升级需要兼容策略。

候选命名：

- `SessionEvent`
- `SessionEventType`

### 6.3 Tool System

Tool System 负责把模型意图变成可审批、可审计、可取消、可恢复的外部动作。

v2 只保留工具边界，不定义工具接口细节。

设计约束：

- 每个 tool 必须声明输入 schema、输出 schema、只读性、破坏性、并发安全、超时、取消语义、权限需求、最大输出大小和副作用范围。
- 有副作用的 tool 需要尽量声明幂等性和恢复策略。
- 工具输出过大时进入 artifact/storage，只返回摘要和引用。
- tool runtime 不应绕过 permission、trace、audit 和 adapter contract。
- MCP、plugin、subagent 暴露的工具也必须经过统一 capability 和 schema 校验。

候选命名：

- `Tool`
- `ToolRegistry`
- `ToolRuntime`
- `ToolResult`
- `ToolContext`

首批工具方向：

- 文件读取与检索
- 文件写入与编辑
- 子进程执行
- web 搜索与抓取
- todo / task 类内部工具

具体工具 contract 另开设计。

### 6.4 Provider

Provider 是 capability-first 的模型适配边界。core 不读取具体供应商 SDK、私有 HTTP 字段或模型分支。

设计约束：

- provider/model 能力需要显式探测或声明。
- 工具调用、结构化输出、streaming、reasoning、cache、parallel tool、token 限制和重试策略都属于 capability 设计。
- model config 只负责选择和用户覆盖，不承载全部行为分支。
- provider 错误需要归一化，同时保留原始 cause。
- provider adapter 必须支持 trace、取消、超时和审计。

候选命名：

- `ProviderAdapter`
- `ProviderCapabilities`
- `ModelCapabilities`
- `ModelPort`

当前基础模型能力 contract 已在 `model/README.md` 拆出并落地为 `ModelCapability` / catalog
查询接口、adapter 默认策略和 core runtime 消费路径。完整 `ProviderCapabilities` 稳定 schema
仍待继续收口，尤其是 network、cache、parallel tool、retry budget 等 provider 级能力。

### 6.5 Permission 与 Mode

Permission 负责 collaboration mode、approval policy、risk policy 和 audit policy。它不直接实现文件系统、网络或子进程隔离。

设计约束：

- 权限判断必须事件化。
- 自动批准不能绕过 schema 校验、adapter contract、审计事件或高风险规则。
- Plan、Build、Yolo、Auto 等模式是权限策略输入，不是到处散落的 if 分支。
- tool catalog 不随 mode 变化；mode 只影响 tool call 到达 permission gate 后的判定，避免 tools schema 变化破坏 provider cache。
- sandbox 是独立边界，可以被 permission 组合使用，但不能混成同一个概念。

当前 P0 mode 语义：

| Mode | Permission 行为 |
| --- | --- |
| `plan` | 允许 `readOnly=true` 且 `destructive=false` 的工具；拒绝 workspace/git/system/network 写入和其他非只读工具。 |
| `build` | 默认模式；只读工具直接允许，有副作用、破坏性或高风险工具进入 `ask`，等待后续 UI/SDK 审批链路接管。 |
| `yolo` | 跳过 permission prompts，直接 `allow`；仍不跳过 tool registry、schema/adapter contract、trace 和审计。 |
| `auto` | 保留模式，暂不实现；如果被配置到 runtime，permission 明确拒绝并写入可调试原因。 |

Permission decision 必须携带 `mode`、`toolName`、`riskLevel`、`sideEffectScope`、`decision`、`ruleId` 和用户可读 `reason`，并在 tool executor 处记录结构化 debug 日志。日志只记录输入摘要；需要审批的 `permission_requested` event 可携带原始 input 供 UI 展示。

候选命名：

- `PermissionPort`
- `PermissionService`
- `PermissionResult`
- `CollaborationMode`
- `ApprovalPolicy`
- `RiskPolicy`

### 6.6 Hooks

Hooks 是扩展点，不是隐藏的全局事件总线。

设计约束：

- hooks 必须有明确 phase、输入、输出、超时、取消和错误策略。
- hooks 的副作用必须走 adapter。
- hooks 不能隐式修改 core 内部状态。
- hooks 结果需要可观测。

候选命名：

- `Hook`
- `HookRunner`
- `HookPhase`

### 6.7 Subagent 与 Mailbox

Subagent 和 Mailbox 是 durable lifecycle，不是内存 Map。

设计约束：

- spawn、状态变化、消息投递、ack、失败、取消和恢复都必须事件化。
- mailbox 是点对点通信，不引入全局 Event Bus。
- 消息需要容量限制、过期策略、重复投递防护和失败传播。
- 子 agent 继承父 agent 的 trace、workspace scope 和权限策略，但权限请求仍需显式事件化。
- spawn guard 必须防止递归失控。

候选命名：

- `SubagentRuntime`
- `SubagentRecord`
- `SubagentPolicy`
- `Mailbox`
- `InterAgentMessage`

具体 lifecycle、backpressure 和恢复策略另开设计。

### 6.8 Compact 与 Rewind

Compact 管理当前 session 上下文压缩。Rewind 管理回退语义。两者共享 session state，但不等同。

设计约束：

- compact boundary 是可审计状态，不是纯内存标记。
- rewind 不能物理删除历史。
- prompt 构建需要能理解 compact 后的上下文边界。
- compact、snapshot 和 rewind 必须与 event store、projection、artifact 协同。

候选命名：

- `CompactBoundary`
- `RewindPoint`
- `SessionStateManager`

具体 boundary 字段和恢复策略另开设计。

### 6.9 Memory

Memory 是跨 session 的长期记忆系统。它不同于 Compact。

设计约束：

- Compact 是单 session 上下文压缩。
- Memory 是跨 session 知识提取、检索、合并和过期。
- memory 提取必须可关闭、可观测、可追踪来源。
- memory 不能默认泄露隐私或敏感内容。
- memory 注入 prompt 需要有明确优先级和 token 预算。

候选命名：

- `MemoryPort`
- `MemoryPipeline`
- `MemoryEntry`
- `MemorySource`

具体提取策略、置信度、过期策略和合并策略另开设计。

### 6.10 Skill

Skill 是 core 可理解的领域概念，但加载来源属于 adapter。

实现级规划见 [Skill Integration Plan](./skill.md)。

设计约束：

- skill 的触发、指令和依赖需要 schema。
- skill 加载不能直接把文件系统细节带入 core。
- skill 与 tool、MCP、plugin 的关系需要通过 capability 声明收口。

候选命名：

- `Skill`
- `SkillLoader`
- `SkillTrigger`

### 6.11 Sandbox

Sandbox 是独立 port，不和 Permission 合并。

设计约束：

- sandbox 提供执行隔离或策略增强。
- permission 决定是否允许，sandbox 决定如何隔离或约束。
- sandbox 错误需要结构化，并保留底层 cause。
- sandbox 能力可能随平台差异变化，必须可探测。

候选命名：

- `SandboxPort`
- `SandboxPolicy`

### 6.12 File Watcher

File Watcher 是提示机制，不是正确性机制。

设计约束：

- watcher 用于提醒 session 用户或外部进程修改了文件。
- watcher 事件不能替代写前校验。
- 文件写入正确性由 file write adapter 的重读、revision/hash、锁和结构化错误负责。
- watcher 的跨平台差异由 adapter 处理。

候选命名：

- `FileWatcher`
- `FileChangeEvent`
- `FileReadState`

---

## 七、外部 I/O 边界

所有外部副作用必须收敛到 adapter，不能散落在业务模块中。

### 7.1 文件系统

文件系统能力必须通过统一 port 和 adapter 暴露。

设计约束：

- 路径处理使用 Node 标准跨平台能力。
- 不手写路径分隔符、绝对路径前缀、临时目录或换行符。
- 写入前必须处理 stale write。
- 原子写入、权限错误、符号链接、大小写敏感、BOM、换行和 Windows rename 行为必须纳入 adapter contract。

候选命名：

- `FileSystemPort`
- `FileWriteAdapter`

### 7.2 子进程

子进程执行必须通过统一 execution adapter。

设计约束：

- 优先使用参数数组形式。
- 避免 shell 字符串拼接。
- 考虑 Windows `.cmd`、`.exe`、空格路径、环境变量大小写和 shell 差异。
- 支持超时、取消、输出截断、流式输出、退出码归一化和权限审计。

候选命名：

- `ExecutionPort`

### 7.3 网络

网络能力统一进入 `HttpClient` 类边界。provider、MCP、web fetch、remote config 和 telemetry 不各自发明网络行为。

### 7.4 Artifact

artifact 用于承载大体积结果、附件、下载文件、模型流片段、工具输出和可追踪引用。

设计约束：

- 模型上下文只接收摘要和引用。
- artifact 需要 hash、来源、权限范围和生命周期。
- artifact storage 的物理结构不在 v2 定义。

---

## 八、多 Session 并行执行

ZCode CLI 需要把 session、message、tool call、permission、checkpoint、队列和 pending 状态视为一等对象。

### 8.1 Session 隔离

每个 session 有独立 event stream、projection、file read baseline、pending permission 和 runtime 状态。

设计约束：

- session 之间不共享内存 truth。
- session 间通信只传递 hint 或请求。
- 共享资源访问必须通过 adapter 或 manager 协调。
- fork、resume、rollback 和并发 session 都必须保留 trace。

候选命名：

- `SessionManager`
- `SharedStateHandle`
- `SessionMailbox`

### 8.2 写入冲突

写入冲突是 P0/P1 级问题，不能等到后期再补。

设计约束：

- 默认拒绝 stale write，不自动三方合并。
- Read 记录足够的文件基线；截断读取不能授权完整文件写入。
- Edit、Write、Patch 写入前重读当前文件并校验。
- per-path lock 只解决本进程内交错，不是跨进程正确性依据。
- 用户、IDE、格式化器和其他进程的修改必须通过写前重读发现。

### 8.3 Watcher 与并发

watcher 只提供上下文提示。真正的并发安全由 file write adapter 和 session event 状态共同承担。

---

## 九、错误处理与可观测性

错误是一等设计对象。

设计约束：

- 低层默认向上抛出结构化错误。
- 只有能恢复、重试、降级、补充上下文或在 CLI 边界格式化时才捕获。
- 包装错误必须保留原始 cause。
- 不依赖错误文本做流程判断。
- CLI 入口层统一输出用户提示并设置退出码。
- 测试必须覆盖关键失败路径。

可观测性从第一版保留入口：

- model request
- context composition
- token/cost
- tool call
- permission
- external I/O
- queue/backpressure
- retry
- compact/rewind
- provider capability
- session recovery

---

## 十、实现顺序

实现阶段只定义审查顺序，不把接口细节写死。

### Phase 0：Protocol Baseline

目标：建立最小 contracts 包、执行上下文、错误模型、事件语义和 adapter port 占位。

关键输出：

- `contracts/` 初版。
- `TraceContext` 和执行上下文边界。
- 错误类型和错误码方向。
- session event 语义范围。
- 基础 port 名称和职责说明。

### Phase 1：Bootstrap 与基础 I/O

目标：让 CLI 可以在统一装配路径下启动，并把外部 I/O 收敛到 adapter。

关键输出：

- `bootstrap` composition root。
- config 加载路径。
- logger 和 trace 传播。
- event store 最小实现。
- file system、execution、http、artifact adapter 的最小可用版本。

### Phase 2：Session 与 Agent Runtime

目标：建立可恢复、可事件化的 turn loop。

关键输出：

- session create/resume/fork 的最小闭环。
- event reducer 和 projection。
- model streaming 事件化。
- tool call lifecycle 事件化。
- interrupt、cancel 和 crash recovery。

### Phase 3：Tool / Provider / File Contract 深化

目标：把最容易泄漏细节的边界拉出来单独设计。

关键输出：

- Tool Contract 详细设计。
- Provider / Model Capability 详细设计；模型能力 catalog 主线已落地，provider 级稳定 schema
  继续收口。
- FileWriteAdapter 详细设计。
- Read / Edit / Write / Bash 首批工具验证。
- 跨平台文件与子进程失败路径测试。

### Phase 4：权限、模式与安全边界

目标：把用户授权、自动模式、风险策略、sandbox 和 audit 接到统一流程里。

关键输出：

- permission event lifecycle。
- collaboration mode。
- approval policy。
- sandbox port spike。
- 高风险工具策略。

### Phase 5：高级状态与并发

目标：完善复杂 agent 场景。

关键输出：

- subagent lifecycle。
- durable mailbox。
- compact boundary。
- rewind。
- multi-session。
- file watcher。

### Phase 6：扩展与生态

目标：接入外部扩展，同时保持能力和权限收口。

关键输出：

- hooks。
- skills。
- MCP / ZCode app-server。
- plugin capability。
- metrics 和 telemetry。
- memory pipeline。

---

## 十一、关键设计决策

### 11.1 Core 不依赖 Infra

core 必须可单独测试。provider、MCP、SQLite、文件系统、网络和子进程不应泄漏进业务状态机。

### 11.2 Session Event 是 Truth

resume、fork、rollback、pending permission、streaming part、tool lifecycle 和 crash recovery 都依赖事件事实。projection 可以重建，内存对象不能作为事实来源。

### 11.3 不用全局 Event Bus

全局 bus 会隐藏依赖、顺序和失败传播。跨 agent 或跨 session 通信使用明确 mailbox、command 或 projection hint。

### 11.4 Provider Capability First

provider 差异不只是模型名称。工具调用、结构化输出、streaming、reasoning、cache、parallel tool、token 限制和错误形态都需要 capability 化。

### 11.5 Tool Contract 必须审计友好

tool 不只是函数调用。它是权限、审计、取消、恢复、输出管理和副作用边界的组合。

### 11.6 File Watcher 不是锁

watcher 只能提示文件变化。写入正确性必须由写前重读、revision/hash、锁和结构化错误保证。

### 11.7 架构先定义约束，不提前定义所有接口

v2 故意不把字段和方法写死。接口应由实现反馈、失败路径、跨平台验证和真实工具接入共同塑形。

---

## 十二、待拆分详细设计

以下内容必须拆成独立设计文档或 implementation RFC。已完成的 RFC 保留在本节，避免后续自动化把同一能力重复当作缺口实现。

已拆分并落地：

- Tool Contract：见 `tool/README.md` 和 `tool/*.md`。2026-05-07 核对时，公共契约、内置 tool 声明、registry 投影、executor/scheduler 消费、output schema 校验和 artifact result budget 已有代码与测试闭环。
- Provider / Model Capability：见 `model/README.md`。2026-05-07 核对时，`ModelRef`、provider-neutral request/result、`ModelCapability` catalog、adapter default policy、config override 投影、AI SDK registry/runner 和 core runtime model loop 已有代码与测试闭环；provider 级 network/cache/parallel-tool/retry budget 仍未晋升为稳定 capability schema。

仍待拆分：

- Provider Capability stable schema（network / cache / parallel tool / retry budget）
- FileSystem / FileWriteAdapter
- Execution Adapter
- Session Event schema
- EventStore storage schema
- Projection rebuild strategy
- Permission / Mode / Risk Policy
- Sandbox Port
- Subagent / Mailbox lifecycle
- Compact / Rewind
- Memory Pipeline
- Config schema and subscription
- Transport / RPC Protocol
- MCP / ZCode app-server integration
- Metrics / Observability

每个详细设计都必须包含：

- 目标和非目标。
- 候选 contract 名称。
- runtime schema。
- 错误类型。
- 权限和副作用范围。
- 超时、取消、重试语义。
- 跨平台注意事项。
- 最小实现计划。
- 执行反馈记录。
- 晋升到稳定 contract 的条件。

---

## 十三、当前 TODO

- [x] 建立 repo 结构（packages/contracts、adapters、bootstrap）
- [x] 确认各层职责写入 design
- [x] Agent Loop 子模块设计（见 `loop/architecture.md`）
- [x] Agent Loop 实现计划（见 `loop/plan.md`）
- [x] M1: 基础数据结构（contracts/interfaces, contracts/events）
- [x] M2: Event 和 EventReducer
- [x] M3: Turn 状态机
- [x] M4: Tool Scheduler
- [x] M5: Agent Runtime 骨架
- [x] Tool Contract RFC（见 `tool/README.md` 的实现核对）
- [x] Provider / Model Capability RFC 基础实现（见 `model/README.md` 的实现核对）
- [ ] Provider Capability stable schema（network/cache/parallel tool/retry budget）
