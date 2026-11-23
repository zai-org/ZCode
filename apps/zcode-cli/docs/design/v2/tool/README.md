# ZCode CLI Tool 设计 v2

## 文档定位

本目录记录 ZCode v2 的 tool 契约和实现核对清单。当前公共 tool contract 已从早期 `L1 Candidate Contract` 推进到运行时消费阶段：字段、行为、权限边界和失败路径仍以本文为设计基准，但已存在稳定的共享 TypeScript 契约、内置 tool 声明、registry 投影和 executor/scheduler 消费闭环。

文档顺序按当前优先级排列：

1. [Read](01-read.md)
2. [Write](02-write.md)
3. [Edit](03-edit.md)
4. [Bash](04-bash.md)
5. [Glob](08-glob.md)
6. [Grep](09-grep.md)
7. [WebFetch](05-webfetch.md)
8. [AskUserQuestion](06-ask-user-question.md)
9. [Subagent](07-subagent.md)
   - [Background Subagent 第一版实施规划（历史）](07-subagent-background-plan.md)
   - [RespondToCoordinator 当前契约](../../../../../../docs/subagent-respond-to-coordinator.md)
10. [TodoRead / TodoWrite](10-todo.md)
11. [Tool Input Normalization](12-input-normalization.md)
12. [WebSearch](13-websearch.md)
13. [Workflow](15-workflow.md)
14. [EnterPlanMode / ExitPlanMode](16-plan-mode.md)
15. [ToolSearch](19-tool-search.md)
16. [node_repl 调用账本：结果里的可信事实](20-node-repl-call-ledger.md)

## 公共 tool 形态

每个 tool 都是一个带 runtime schema 和生命周期钩子的对象，核心字段包括：

- `name`、`searchHint`、`description`、`prompt`
- `inputSchema`、`outputSchema`
- `validateInput`
- `checkPermissions`
- `call`
- `mapToolResultToToolResultBlockParam`
- `isReadOnly`、`isConcurrencySafe`、`isDestructive`
- `requiresUserInteraction`
- `maxResultSizeChars`
- `getPath`、`preparePermissionMatcher`
- UI 渲染相关的 summary、activity、result、rejected、error hooks

UI 细节不属于 tool 契约；tool 层需要有稳定 schema、权限元信息、副作用声明、取消语义、输出预算、结果落盘策略、可观测事件和对模型可见结果的序列化策略。

权限 `ask` 的异步客户端协商见 [Permission Broker](../permission-broker.md)。tool 层只产生权限意图和可展示上下文，是否允许继续由 broker 等待客户端结果后决定。

## 统一生命周期

ZCode v2 tool runtime 应按以下顺序调度：

1. `parseInput`：用 runtime schema 校验并标准化输入。
2. `backfillObservableInput`：仅对观测、hook、权限判断可见的输入补齐派生字段，不能修改发给模型的原始输入。
3. `validateInput`：在 `PreToolUse` hook 之前执行不需要用户授权或低风险的
   tool-specific 输入校验，失败时返回结构化错误码和可操作提示，不再运行
   `PreToolUse`、权限判断、handler 或 `PostToolUseFailure`。
4. `checkPermissions`：结合 tool 声明、permission mode、allow/deny/ask 规则、工作区和路径安全策略决定 allow、ask、deny；`ask` 必须进入 permission broker 等待客户端回复，不能被当作立即拒绝。
5. `call`：执行 tool。业务层只表达意图，实际文件、进程、网络 I/O 必须走 adapter。
6. `recordState`：更新 read cache、file history、task state、trace span、artifact 引用等一等状态。
7. `serializeResult`：把内部输出转换为模型可见的 tool result，大结果进入 artifact/storage，只返回预览和引用。
8. `renderProjection`：UI 从 projection 或事件流渲染，不读取 tool 内部状态。

handler 在既有执行位置发现可预期的 tool-specific 失败时，返回内部
`{ result: false, errorCode, message }`；成功输出及正常生命周期不受影响。错误码和裸
message 由具体 tool module 维护，executor 只负责统一组装结构化 error 和
provider-visible `<tool_use_error>`，不得按 tool name 分支或解析英文 message。I/O、取消、
竞态及其他不可预期异常继续走通用异常路径。

需要在 hook 之前拒绝的稳定语义错误由 `ToolEntry.validateInput` 返回同一
`{ result: false, errorCode, message }` 形状。依赖可变运行态的 handler 仍需在实际执行
位置重新检查，处理校验后状态变化或 hook 修改输入的竞态。

## 公共契约要求

每个 ZCode tool 都必须声明：

- `inputSchema`：运行时可校验，跨 LLM、SDK、MCP、session 存储边界时不得只依赖 TypeScript 类型。
- `outputSchema`：描述成功结果的结构。失败路径使用稳定错误类型，不混进普通字符串。
- `capability`：一句话说明能力，用于 tool search 和权限解释。
- `readOnly`：是否只读。动态只读工具必须按输入计算。
- `destructive`：是否可能删除、覆盖、发送或产生不可逆副作用。
- `sideEffectScope`：至少区分 `none`、`workspace`、`git`、`network`、`system`、`session`、`userInteraction`。
- `concurrencySafe`：能否与其他 tool 并发运行。
- `timeout`：默认超时、最大超时和是否支持调用方覆盖。
- `cancellation`：取消后外部副作用如何停止、清理或标记。
- `permission`：权限规则匹配内容、建议规则、deny 优先级和用户可见理由。
- `resultBudget`：内联结果大小、落盘策略和预览策略。
- `trace`：所有 validate、permission、adapter I/O、state update 和 result serialization 都必须携带同一个 `traceId`。

### 实现核对（2026-05-07）

本轮核对确认公共 tool contract 的 L0-L3 主线已经落地，后续不要再把这些能力当作纯计划项重复实现：

- 共享契约位于 `packages/contracts/src/tools/contract.ts`，覆盖 `capability`、`inputSchema`、`outputSchema`、`permission`、`resultBudget`、`timeout`、`cancellation` 和 `trace`。
- core 入口类型位于 `packages/core/src/tool/types.ts`，`ToolEntry` 继承共享契约并补充 handler、runtime schema 和 metadata。
- 内置 tool 在 `packages/core/src/tool/handlers/` 中声明完整公共契约，并同时挂载 `runtimeInputSchema` / `runtimeOutputSchema` 作为 JSON Schema 的唯一 Zod 来源；`packages/core/tests/tool-contracts.test.ts` 覆盖声明完整性、runtime schema presence、provider-compatible JSON Schema 和 registry 投影。
- `packages/core/src/tool/registry.ts` 的 `toContracts()` 已向模型契约投影 `outputSchema`、权限、预算和运行时元数据。
- `packages/core/src/runtime/methods/tools.ts` 和 `packages/core/src/tool/scheduler.ts` 已优先使用 `permission.sideEffectScope` 与并发元数据调度 tool，避免只靠旧的 tool-name read-only 表。
- `packages/core/src/tool/executor.ts` 已消费 `timeout`、`cancellation`、`resultBudget`、`outputSchema` 与 artifact store，失败路径回到结构化 tool error，不把非法 output 注入模型上下文。
- `packages/core/tests/tool-executor-trace.test.ts` 覆盖 resultBudget 截断、artifact 写入和 outputSchema fail-closed；`packages/adapters/tests/tool-artifact-store.test.ts` 覆盖 Node artifact store。

### L0/L1 落地约束（已实现，仍作为新增 tool 门禁）

当前实现已落地 L0/L1：公共契约类型和内置 tool 的声明完整性。后续新增 tool 不允许只注册 `handler` 和 `inputSchema`，必须同时补齐下面三类声明：

这里的“声明”不是一整段发给模型的提示文本，而是一份结构化契约。provider adapter 只把模型需要的部分投影出去，例如 `name`、`description`、`capability`、`inputSchema`、`outputSchema`；`permission`、`resultBudget`、`timeout`、`cancellation`、`trace` 主要由 ZCode runtime、executor、permission、scheduler、artifact/storage 和观测链路消费。

1. 模型可见投影：
   - `name`
   - `description`
   - `capability`
   - `inputSchema`
   - `outputSchema`（即使当前 provider 不消费，也必须在 ZCode 契约中存在）

2. runtime 可消费声明：
   - `runtimeInputSchema`
   - `runtimeOutputSchema`
   - `readOnly`
   - `destructive`
   - `sideEffectScope`
   - `concurrentSafe`
   - `timeout`
   - `cancellation`
   - `resultBudget`
   - `trace`

3. 权限声明：
   - `permission.permission`
   - `permission.reason`
   - `permission.riskLevel`
   - `permission.sideEffectScope`
   - `permission.needsApproval`
   - `permission.patternSources`
   - `permission.denyPriority`

`inputSchema` 和 `outputSchema` 是 provider-neutral JSON Schema，不是 Zod 对象；但内置 tool 的 JSON Schema 不应再手写维护。内置 tool 必须以 Zod runtime schema 作为唯一源，通过 `packages/contracts/src/tools/json-schema.ts` 的统一转换入口派生 provider-neutral JSON Schema。这样可以避免 `enum` 缺少 `type`、optional 字段 required 漂移、嵌套 object 约束不一致等问题。

外部 tool（例如 MCP、dynamic tool）可以携带原生 JSON Schema，但进入 registry 或 provider adapter 前必须经过同一类 schema normalization：补齐 object `properties`、为 `enum` / `const` 推断显式 `type`、移除 provider 不消费的 `$schema` / `$ref` / `definitions` 等生成细节。provider adapter 只能消费归一化后的 JSON Schema，不直接透传未知来源 schema。

Zod、Effect Schema 或其他 runtime schema 可以作为 `runtimeInputSchema` / `runtimeOutputSchema` 保留给 executor 后续校验使用；当前内置 tool 先统一使用 Zod。禁止为同一个内置 tool 长期并行维护一份手写 JSON Schema 和一份 Zod schema。

### L2 Runtime 消费约束（已实现，继续扩展覆盖面）

L2 已经使公共契约不只用于登记和展示，runtime 会实际读取这些声明。后续改动必须保持以下闭环：

- executor 使用 `timeout.defaultMs`、`timeout.maxMs` 和 `timeout.allowCallOverride` 计算每次 tool 调用的外层超时。
- executor 为每次 tool 调用创建子 `AbortSignal`，超时和用户取消都必须传播给 handler 以及后续 adapter I/O。
- executor 使用 `resultBudget` 生成模型可见的 `modelContent`；完整 `output` 可以留给内部状态、UI 或 artifact，但不得直接回灌模型消息历史。
- scheduler 优先使用 `permission.sideEffectScope` 判断并发安全边界，避免 metadata 和权限声明分叉后继续按旧信息调度。
- tool result event 应包含截断状态、原始大小、返回大小、预算策略和可用 artifact 引用，方便后续 UI、审计和恢复链路接管。
- handler 的失败返回不是成功 output，不得进入 output schema 校验、成功序列化、
  `PostToolUse` 或后台任务追踪；应沿用现有 `PostToolUseFailure`、`ToolCallError` 和失败日志链路。
- handler 正常返回、但结果是错误结果时（`isToolOutputError`，与 tool_result 的 `is_error` 同一判定，
  例如 Bash 非零退出、MCP `isError: true`），结果照常校验、序列化和发出 `ToolCallResult`，
  Hook 改为运行 `PostToolUseFailure`，不运行 `PostToolUse`（`hooks.md`「失败的定义」）。

### L3 Artifact 与 Output 校验约束（已实现，按 schema 需求增量加强）

L3 已经补齐两个运行时闭环：

- 成功 tool output 必须经过 `outputSchema` 校验。校验失败属于 tool contract 违约，按结构化 `tool_execution_failed` 返回，不把非法结果注入模型上下文。
- JSON Schema 校验第一版覆盖当前 tool contract 使用的子集：`type`、`anyOf`、`oneOf`、`const`、`enum`、`required`、`properties`、`additionalProperties`、`items`、`minItems`、`maxItems`、`minimum`、`maximum`、`minLength`、`maxLength`。`anyOf` 至少匹配一个分支、`oneOf` 恰好匹配一个分支，不满足时都报 `invalid_union`；同一节点两个都写时各查一次，都要满足；同一节点的其他关键字照常检查（2026-11-14 补 `anyOf`：工具 schema 的 union 与 nullable 改用 `anyOf`；2026-11-16 修正两者并存时跳过 `oneOf`，见根目录 `docs/model-tool-call-validation.md`）。后续 schema 若使用更多关键字，必须先扩展 validator 和测试。
- `resultBudget.strategy: "artifact"` 且 `artifact.enabled: true` 时，超出模型预算的完整序列化结果必须通过 `ToolArtifactStorePort` 写入 artifact/storage。executor 只能依赖 port，不能直接调用文件系统或 session sqlite。
- artifact 写入必须携带 `sessionId`、`turnId`、`toolCallId`、`toolName` 和 `trace`，返回的 `uri` 或 `path` 进入 tool result event 与截断提示。
- 如果未配置 artifact store，executor 仍会按 `resultBudget` 截断模型内容，但不会伪造 artifact 引用。

### 新增 Tool Checklist

新增 tool 时按以下顺序落地：

1. 先在 `docs/design/v2/tool/` 写清能力、输入、输出、权限、失败路径、副作用范围、取消语义、结果预算和 trace 传播。
2. 在 `packages/contracts/src/tools/` 定义 Zod runtime input/output schema 和 TypeScript 类型；`*InputJsonSchema` / `*OutputJsonSchema` 必须由统一 helper 从 Zod schema 派生，除外部 tool schema normalization 外不要手写。
3. 在 `packages/core/src/tool/handlers/` 注册 `ToolEntry`，必须包含 `capability`、`inputSchema`、`outputSchema`、`runtimeInputSchema`、`runtimeOutputSchema`、`permission`、`resultBudget`、`timeout`、`cancellation`、`trace`。
4. handler 内所有文件、子进程、网络、skill、storage I/O 必须走 adapter/port，并继续传递 `traceId`。
5. 有副作用的 tool 必须声明 `needsApproval: true` 或给出明确的只读证明；写入类 tool 默认 `sideEffectScope: "workspace"`，子进程默认至少 `"system"`。
6. 大结果不得无条件塞回模型上下文；必须通过 `resultBudget` 明确 inline 上限、预览策略和 artifact 策略。
7. 新增或修改 tool 后必须补测试，至少覆盖契约声明完整性、registry `toContracts()` 投影、关键成功路径和关键失败路径。

## 工具矩阵

| Tool | 模型可见名称 | 模型可见范围 | 主要副作用 | 默认只读 | 并发安全 | 结果预算 |
| --- | --- | --- | --- | --- | --- | --- |
| Read | `Read` | 主智能体、Explore | 文件读取、read cache 更新、可附加图片/PDF meta message | 是 | 是 | 不落盘，内部自限 |
| Write | `Write` | 主智能体 | 创建或完整覆盖文件、更新 read cache、file history、LSP/IDE 通知 | 否 | 否 | 100000 chars |
| Edit | `Edit` | 主智能体 | 精确字符串替换、更新 read cache、file history、LSP/IDE 通知 | 否 | 否 | 100000 chars |
| Bash | `Bash` | 主智能体 | 子进程、sandbox、cwd、背景任务、可能读写网络和系统 | 按命令动态判断 | 只读命令才安全 | 30000 chars |
| Glob | `Glob` | 主智能体、Explore（临时） | 文件名和路径模式匹配 | 是 | 是 | 100000 chars |
| Grep | `Grep` | 主智能体、Explore（临时） | 文件内容正则搜索 | 是 | 是 | 100000 chars |
| WebFetch | `WebFetch` | 主智能体 | 网络 GET、二级模型处理、二进制落盘 | 是 | 是 | 100000 chars |
| WebSearch | `WebSearch` / 内部 `web_search` | 主智能体、Explore | 内部模型请求触发 provider 侧 server-side web search | 是 | 是 | 100000 chars |
| AskUserQuestion | `AskUserQuestion` | 主智能体 | 用户交互，权限 UI 收集答案 | 是 | 是 | 100000 chars |
| Subagent | `Agent` / `Task` | 主智能体 | agent runtime、后台任务、worktree、transcript、被委托工具的副作用 | 编排层是，只读性需按子工具动态计算 | 编排层是，写入冲突由子工具和 task runtime 管 | 100000 chars |
| Workflow | `Workflow` | 主智能体（仅显式用户 opt-in 后调用） | workflow run、子 session、后台 runner、session-scoped 脚本副本、被编排 agent 的 workspace 副作用 | 否 | 否 | 小结果，状态走 workflow tables |
| EnterPlanMode | `EnterPlanMode` | 主智能体 | 请求用户同意并切换 session mode 到 plan | 否 | 否 | 100000 chars |
| ExitPlanMode | `ExitPlanMode` | 主智能体 | 提交计划、请求用户同意并退出 plan mode | 否 | 否 | 100000 chars |
| TodoRead | `TodoRead` | 主智能体 | session todo 状态读取 | 是 | 是 | 100000 chars |
| TodoWrite | `TodoWrite` | 主智能体 | session todo 状态替换 | 是，session-only | 否 | 100000 chars |

## ZCode 的实现取向

这些文档只定义 tool 层的语义，不要求一次实现全部能力。落地时优先实现稳定契约和测试：

- 文件工具先实现 `Read -> Edit/Write` 的读前写入约束和 mtime/content 防并发修改。
- 搜索工具保留 `Glob/Grep` 两个 direct tool 实现。当前默认采用
  embedded search 分支：主智能体和 `Explore` 子智能体 tool pool 都隐藏 direct `Glob/Grep`，
  仓库搜索通过 Bash `find` / `grep` function 接管。Windows CMD 或 legacy shell fallback
  无法注入 Bash function 时，才回到 non-embedded/direct 分支并暴露 `Glob/Grep`。
- Bash 先实现参数数组、跨平台 shell adapter、权限声明、超时、取消、输出截断和 sandbox 接口，再逐步补复杂解析。
- WebFetch 先实现显式网络 adapter、域名权限、redirect 安全策略、缓存和大内容预算。
- WebSearch 当前采用 client tool wrapper：主请求只暴露普通 `WebSearch` client tool，handler 内部再发起只包含 provider-native `web_search` 的模型请求；adapter 只负责内部 native helper 映射，不恢复 HTML 抓取。
- AskUserQuestion 先实现非阻塞会话状态、可恢复 pending prompt 和 SDK/TUI 统一输出。
- Subagent 先实现 agent definition registry、tool pool resolver、隔离执行上下文、background task、transcript/resume 和 trace 传播，再考虑 fork、worktree、remote 与 teammate。
- Todo 已实现 session store 持久化、工具契约、TUI/ZCode app-server 计划投影、resume 上下文注入和 compact summary 附带 todo 状态；后续改动应保持这些投影只消费 runtime/session event，不直接读取 storage。
