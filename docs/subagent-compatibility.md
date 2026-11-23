# Subagent Claude Code 兼容规范

## 2026-09-14 Agent 目录承载更新

当前目录承载合同见 [Agent listing attachment](subagent-listing-attachment.md)：目录
从工具 description 迁移到 `agent_listing_delta` attachment（按能力和位置投影为 MCS 或 user reminder），compact 后按保留历史补齐。
通过只读 definitions 入口预留未来增删；现有加载、覆盖优先级和执行快照保持原合同。

> **当前状态**：runtime alias 规则仍有效；UI 历史兼容已迁移到 V4 tool row 适配与统一 ToolCall renderer。

## 背景

ZCode 的子智能体调度工具名是 `Agent`，Claude Code 插件生态里的子智能体调度工具名是 `Task`。Superpowers 等 `.claude-plugin` 的 skill 文档会直接要求模型调用 `Task`；如果只在 `SessionStart` 追加一段提示词映射，模型、hook matcher、后台任务恢复和 UI 投影仍会各自有一套不一致的解释。

因此 ZCode 的兼容目标是把 `Task` 作为结构化 runtime 别名接入，而不是对单个插件做文本补丁。面向 first-party 模型的 provider-visible `tools[]` 仍只暴露 canonical `Agent`；`Task` 只用于历史调用、hook matcher 和内部兼容。

## 兼容原则

- `Agent` 是 ZCode canonical subagent 工具。
- `Task` 是 Claude Code 兼容 runtime alias，底层委托 `Agent` 的 handler，但默认不进入 provider-visible `tools[]`。
- 两者共享输入/输出 schema、权限能力、结果预算、timeout、cancellation 和 trace 策略。
- 兼容层不能改变实际工具调用轨迹：模型调用 `Agent` 时 hook input 仍是 `Agent`，模型调用 `Task` 时 hook input 仍是 `Task`。
- 不通过 Superpowers 专用 additional context 注入工具映射；所有 Claude Code 插件复用同一套 runtime 兼容。

## 工具注册

`Task` 作为独立 `ToolEntry` 注册，但复用 `agentToolEntry` 的 handler 和运行时声明；`ToolRegistry.toContracts()` 会过滤 `providerVisible: false` 的 alias。注册边界与 `Agent` 完全一致：

- 父 runtime 只有在存在 `subagentPort` 时才注册 `Agent` / `Task` runtime entry。
- 没有 subagent 能力时两个 runtime entry 都不注册，避免历史/内部调用走到不可执行工具。
- provider-visible `tools[]` 只包含 `Agent`，不包含 `Task`。
- allowlist 仍按实际工具名过滤；显式 allowlist 未包含 `Task` 时不会额外放行 `Task`。

核心实现位置：

- `apps/zcode-cli/packages/core/src/tool/handlers/agent.ts`
- `apps/zcode-cli/packages/core/src/tool/handlers/index.ts`
- `apps/zcode-cli/packages/core/src/tool/compat.ts`

## 子 Runtime 防递归

子 agent runtime 当前禁止继续递归创建 subagent。过去只过滤 `Agent`，加入 `Task` 后必须把二者视为同一类 subagent dispatch 工具。

规则：

- `allowedTools: ["*"]` 时，从父工具列表继承可用工具，但过滤 `Agent` / `Task`。
- `disallowedTools` 存在时，仍先过滤 subagent dispatch 工具，再应用 disallow。
- 显式 `allowedTools` 不额外扩展 alias；子 runtime 本身不会注册 `Agent` / `Task`，所以即使 profile 误写也不会可用。
- 子 runtime 不暴露 `EnterPlanMode` / `ExitPlanMode`。原因是 subagent 没有可靠的用户审批恢复面；一旦子模型进入 plan mode，`ExitPlanMode` 会请求用户确认并可能让父 turn 永久等待。该限制必须在 child provider-visible tool list 层统一执行，覆盖内置 `general-purpose`、`Explore`、自定义 profile 的 `tools: ["*"]` 和显式 `tools`。

核心实现位置：

- `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`
- `apps/zcode-cli/packages/core/src/tool/compat.ts`

## Hook Matcher 兼容

Claude Code 插件 hook 可能写 `matcher: "Task"`，而 ZCode 原生调用可能仍是 `Agent`。ZCode hook runner 支持一个实际 `matchValue` 加一组兼容 `matchValues`：

- `Agent` 调用匹配 `Agent` 和 `Task` matcher。
- `Task` 调用匹配 `Task` 和 `Agent` matcher。
- hook stdin 中的 `toolName` 始终保留实际发生的工具名。
- 其它 hook event 不受影响；没有 alias 时仍按单个 matcher 匹配。

核心实现位置：

- `apps/zcode-cli/packages/core/src/hooks/types.ts`
- `apps/zcode-cli/packages/core/src/hooks/runner.ts`
- `apps/zcode-cli/packages/core/src/tool/executor/hook-flow.ts`
- `apps/zcode-cli/packages/core/src/tool/compat.ts`

## 后台任务与权限

`Agent` / `Task` 在「子智能体总在后台运行」开关（runtime `subagents.alwaysBackground`）开启（缺省）时总在后台运行，启动时返回 `async_launched`；关闭时 `run_in_background` 请求后台时返回 `async_launched`。后台任务跟踪需要把 `Task` 视为同一类 subagent task：

- `Task` 的 async launch 通过 `subagentPort.getTask` 恢复 snapshot。
- `Task` 不走普通 execution background cancel；和 `Agent` 一样由 subagent 生命周期管理。
- permission service / scheduler 将 `Task` 归为 read-only、low-risk session-scope subagent 工具，权限声明仍来自共享的 `agentToolEntry.permission`。
- 开关开启（2026-11-18）：模型可见输入没有 `run_in_background`；插件指令或模型仍传入时，runtime schema 丢掉这个字段，不报错。每次调用直接返回 `async_launched` 并进入 background snapshot 生命周期；禁止后台的执行（`modelOverride.background: "deny"`）改为前台运行，不报错。
- 开关关闭：`run_in_background` 是 `Agent` / `Task` 的固定能力：请求后台执行时直接返回 `async_launched` 并进入 background snapshot 生命周期；前台执行可通过 `subagents.autoBackgroundMs` 在超时后自动切入同一套后台路径；用户在前台执行中立即发送时，前台等待中的执行也切入同一套后台路径；启动阶段、收尾阶段（child 已完成、失败或闲置超时）和禁止后台的执行照旧取消（2026-10-29，见 `apps/zcode-cli/docs/design/v2/loop/turn-steering.md` 前台子代理转后台）。
- 开关规则见 `apps/zcode-cli/docs/design/v2/tool/07-subagent.md`「ZCode 当前实现」。

核心实现位置：

- `apps/zcode-cli/packages/core/src/tool/executor/background-tasks.ts`
- `apps/zcode-cli/packages/core/src/permission/service.ts`
- `apps/zcode-cli/packages/core/src/tool/scheduler.ts`

## UI 与历史数据

App/UI 层需要同时识别现役 `Task` 和历史 ZCode Agent 投影：

- `packages/shared/src/tool-identity.ts` 将 `Task` 归为 `agent` family。
- 服务层和 UI 消息归一在解析 agent activity result 时接受 `Task`。
- `packages/ui/src/lib/toolIdentity.ts` 保留 legacy fallback：历史数据里 `kind: "think"` + `title: "Task"` 仍是 legacy agent identity，不能因为 `Task` 成为现役工具名就误升级为非 legacy。

核心实现位置：

- `packages/shared/src/tool-identity.ts`
- `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts`
- `packages/ui/src/v4/toolCallRowAdapter.ts`
- `packages/ui/src/ToolCallBlocks.tsx`
- `packages/ui/src/lib/toolIdentity.ts`

## 测试矩阵

关键回归覆盖：

- `apps/zcode-cli/packages/core/tests/tool-contracts.test.ts`：`Agent` / `Task` 只在 subagent port 可用时注册，且共享 handler/schema/permission；provider-visible contracts 只包含 `Agent`。
- `apps/zcode-cli/packages/core/tests/tool-hook-context.test.ts`：`Agent` / `Task` hook matcher alias 双向匹配，hook input 不被改写。
- `apps/zcode-cli/packages/core/tests/main-tool-pool.test.ts`：父 runtime 具备 `Agent` runtime 能力，`Task` 仅作为非 provider-visible alias 保留。
- `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts`：子 runtime 不暴露 `Agent` / `Task`。
- `apps/zcode-cli/packages/core/tests/tool-executor-trace.test.ts`：Superpowers `SessionStart` 不再追加专用工具映射。
- `packages/ui/test/toolIdentity.test.ts`：现役 `Task` 与历史 `title: "Task"` legacy 投影边界不串。

## 扩展规则

新增 Claude Code 工具兼容 alias 时必须同时检查：

- 工具注册是否应该暴露为真实 provider-visible tool，还是仅作为 runtime alias。
- hook matcher 是否需要 alias，但 hook input 是否仍应保持实际工具名。
- 子 runtime allowlist / disallowlist 是否需要过滤递归或危险能力。
- 后台任务、permission、scheduler 是否按同一工具 family 处理。
- shared/UI identity 是否会误伤历史投影数据。
- 是否需要更新 `docs/plugin-hooks-compat.md` 和具体插件 spec。
