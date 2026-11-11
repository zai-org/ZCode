# Background Subagent 第一版实施规划（历史）

> **文档状态（2026-07-10）**：本文保留 background subagent 第一版的实施边界和演进背景，
> 不再作为当前完整行为契约。当前实现以 [Subagent Tool](./07-subagent.md) 为总览；main 与 child
> 的双向消息契约以
> [Subagent RespondToCoordinator](../../../../../../docs/subagent-respond-to-coordinator.md) 为准。
> 本文中“第一版不支持 `SendMessage`”等表述只描述原始阶段，不应覆盖后续已落地能力。

## 目标

在现有同步 one-shot `Agent(Explore)` 基础上，增加第一版 background subagent：

- 模型可以通过 `Agent({ run_in_background: true, ... })` 启动后台 `Explore`。
- `Agent` tool 立即返回后台任务引用，不阻塞父 turn。
- 子 agent 在同一进程内继续运行，状态、进度、最终结果写入 session event store。
- 完成、失败或取消后，以模型可见的 task notification 重新进入父会话。
- 第一版只做 background，不做用户可见的 `SendMessage`/resume；但 task/transcript 契约必须为
  后续 resume 留口。当前实现已经在该契约上增加 `SendMessage` 和 child 的
  `RespondToCoordinator` 回复通道。

非目标：

- 不引入 worktree、fork、remote、teammate/team、MCP、hooks、agent skills。
- 不开放写入型子工具；后台 `Explore` 仍只允许 `Read`、`Glob`、`Grep`。
- 不让后台子 agent 直接询问用户，也不让它递归调用 `Agent`。

## 设计要点

后台 lifecycle 与通知：

- `run_in_background` 或 agent definition `background: true` 会走 async path。
- async path 先注册后台 task，再 fire-and-forget 消费 child 消息流。
- tool 结果返回 `async_launched`，包含 `agentId`、`description`、`prompt`、`outputFile`。
- 后台 lifecycle 持续维护 progress，终态先更新 task state，再做较慢的收尾清理。
- 完成后通过 `<task-notification>` 注入父会话，而不是把结果同步塞回原 tool call。
- foreground agent 转 background（先关闭当前 iterator，再以同 task id 重新后台运行）、worktree、handoff 复核和 `SendMessage` 第一版暂不实现。
- resume 依赖持久化的 child history + metadata，而不是内存 task map。

独立 child session：

- 每个 subagent 创建独立 child session；task id 可以恢复同一个 child session 继续执行。
- 子 agent 权限从 parent ruleset 派生，并显式禁用不允许的递归与写入工具。
- tool part 的 running/completed/error 状态落在 session message parts 中。
- 采用“subagent 是独立 session”的模型，但不采用同步阻塞。

控制面：

- 共享控制面负责 spawn、send input、resume、wait、close。
- 每个 subagent 继承父 turn 的 runtime config、cwd、approval、sandbox、环境选择。
- spawn 立即返回 id；wait 通过 status subscription 等待终态。
- registry 维护 agent tree、名称、spawn limit 和 last task message。
- ZCode 第一版在 `SubagentPort.run()` 之外新增后台任务 API，而不是让 tool executor 自己轮询内部 Promise。

## 第一版契约

### Agent 输入

在 `AgentInputSchema` 增加：

```ts
run_in_background?: boolean
```

规则：

- 仅 `true` 触发 background；省略或 `false` 保持同步 one-shot。
- 第一版仅允许 `subagent_type: "Explore"`。
- background tool call 仍要求 `description` 和 `prompt`。
- 后台任务不绑定父 `AbortSignal`；父 turn 取消不应杀掉已经 background 的 child。显式 stop/kill API 以后再加。

### Agent 输出

`AgentOutput` 扩展为 union：

```ts
type AgentOutput = AgentCompletedOutput | AgentBackgroundedOutput;

interface AgentBackgroundedOutput {
  status: "backgrounded";
  agentId: string;
  agentType: "Explore";
  description: string;
  prompt: string;
  childSessionId: SessionId;
  backgroundTaskId: string;
}
```

模型可见文案：

- 启动成功：`Agent <agentId> is running in the background. You will receive a task notification when it completes.`
- 不暴露完整 prompt 以外的内部 event 内容。

### SubagentPort

不要把 background 塞进现有 `run()` 的 Promise 语义里。扩展为显式控制面：

```ts
interface SubagentPort {
  run(request: SubagentRunRequest, options?: SubagentRunOptions): Promise<AgentOutput>;
  start?(
    request: SubagentStartRequest,
    options?: SubagentStartOptions,
  ): Promise<AgentBackgroundedOutput>;
  getTask?(agentId: string): Promise<SubagentTaskSnapshot | undefined>;
}
```

第一版 runtime 实现 `start()` 和内存态 `getTask()`；`ToolExecutor` 通过 `getTask()` 把 `Agent` 后台任务投影成通用 `background_task_*` 事件，CLI/TUI 面板和后续 `wait`/`resume` 继续复用该接口。

### 事件

复用并扩展现有 session event，而不是新增平行状态库：

- `subagent_spawned`：增加 `background: true`、`childSessionId`、`allowedTools`、`status: "running"`。
- `SessionEventType.SubagentMessage`（event type 为 `subagent_message`）：可选，第一版只记录
  progress summary，不把 child 全量 transcript 灌回父 session。它是 lifecycle/progress event，
  不是后续 `RespondToCoordinator` 使用的 synthetic user message source。
- `subagent_stopped`：记录 `status: "completed" | "failed" | "cancelled"`、duration、tool count、token usage、error。
- `background_task_started/updated/completed`：可以继续作为 UI projection 的通用任务事件，payload `toolName: "Agent"`、`description`、`taskId: agentId`。
- `user_message` 或专用 notification event：后台完成后要生成父模型可见 task notification，下一次 model request 前注入。
- 后续 `RespondToCoordinator` 回复不复用上述 progress event。它通过 `mode: "subagent-message"`
  的 runtime command 投递，并以 user-like synthetic message 写入 parent model history 和 parent
  session store；source 同样是 `subagent_message`，但 visibility 为 `model-only`，完整保存经过 XML
  转义的 `summary` 和 `message`。

原则：

- child runtime 的 tool/model/turn 事件写入 child session。
- parent session 的 subagent lifecycle projection 只存 spawn/progress/stop/notification 摘要，不批量
  复制 child transcript。
- `RespondToCoordinator` 是明确的后续例外：response command 被 parent drain 后，parent session
  保存完整 coordinator response carrier，用于当前投递、hydrate/resume 和后续父模型上下文连续性。
  它不会进入顶层用户消息列表、session title 或 `ReadSession` 的读取结果，但读取原始 session store
  的导出、诊断和存储预算必须按可能包含完整内容处理；compact 也可能把其语义吸收到摘要中。
- 所有事件继承同一个 `traceId`，并记录 parent `sessionId`、`turnId`、`toolCallId`、child `sessionId`、`agentId`。

## 实施分阶段

### M0: Spec 和测试骨架

- 更新 `docs/design/v2/tool/07-subagent.md` 和本规划。
- 更新 `packages/contracts/src/tools/agent.ts`：input/output schema 加 background union。
- 更新 `packages/contracts/src/interfaces/subagent.port.ts`：增加 `start`、task snapshot 类型。
- 补 contract tests，证明 JSON schema、registry projection 和 output schema 覆盖 background。

### M1: 后台任务控制面

- 新增 `SubagentTaskService` 或在 `core/src/subagent` 下实现 `startExploreSubagentTask()`。
- start 流程：
  1. 创建稳定 `agentId` 和 `childSessionId`。
  2. 写 parent `subagent_spawned`，并让 tool executor 通过 `getTask()` 写 `background_task_started`。
  3. fire-and-forget 运行 child `AgentRuntime`。
  4. 运行期间维护最小 progress：tool call count、last tool、token usage。
  5. 终态写 `subagent_stopped`，并让 tool executor 轮询写 `background_task_completed`。
  6. enqueue 父会话 task notification。
- 后台 task 的 `AbortController` 独立于父 turn；进程 shutdown 时 best-effort cancel。

### M2: Agent tool 接入

- `agentHandler` 检测 `run_in_background === true`。
- 若 `context.subagentPort.start` 不存在，返回结构化 configuration error。
- `Agent` entry 的 `outputSchema` 允许 completed/backgrounded union。
- background path 立即返回 `status: "backgrounded"`，不等待 child runtime。
- executor 的 result serialization 对 `backgrounded` 不应等待 artifact。

### M3: Notification 注入

- 为 `AgentRuntime` 增加 session pending notification 队列，或复用现有 turn steering/notification 机制。
- 后台完成后生成结构化父消息，例如：

```xml
<task-notification>
  <task-id>agent_xxx</task-id>
  <tool-use-id>tool_xxx</tool-use-id>
  <status>completed</status>
  <summary>Agent "..." completed</summary>
  <result>...</result>
</task-notification>
```

- 下一次 parent model request 前 drain notification；不能插入 assistant tool call 和对应 tool result 中间。
- 失败/取消也要通知，失败结果包含可操作错误摘要。

### M4: 持久化和 resume 预备

第一版不开放模型调用 resume，但必须落盘这些状态：

- child session events 已经可通过 child `sessionId` 回放。
- parent event 记录 `agentId -> childSessionId`。
- task snapshot 记录 `agentType`、`description`、`prompt`、`status`、`createdAt`、`completedAt`、`resultSummary`、`error`。
- process restart 后 running background task 标记为 `lost` 或 `interrupted`，不要伪装继续运行。

后续 resume 再实现：

- `resumeAgent(agentId)` 从 parent event 找 child session。
- 过滤未配对 tool calls。
- 追加新 user prompt 后重新运行 child runtime。

### M5: UI / CLI projection

- TUI 不直接读 task service；只消费 session projection。
- projection 将 `background_task_*` 和 `subagent_*` 聚合为任务列表。
- CLI headless 模式只输出 `Agent ... running in background`，最终通知由后续 turn 处理。

## 测试计划

最低测试：

- `Agent` contract exposes `run_in_background` and background output union.
- background Agent call returns immediately without waiting for child runtime.
- parent cancel after background start does not cancel child task.
- child completion emits `subagent_stopped` and `background_task_completed`.
- child failure emits failed status and a notification.
- child runtime only receives `Read`、`Glob`、`Grep`; no `Agent`、`Bash`、`Write`、`Edit`、`AskUserQuestion`。
- notification is injected before the next model request and not between assistant tool call/result pairs.
- trace propagation includes parent and child ids.
- resume/restart with running task marks it `lost` or `interrupted`.

## 风险和取舍

- Node 进程内 fire-and-forget 任务在进程退出后无法继续运行；第一版必须诚实标记 `lost`。
- 后台任务完成后主动“唤醒”父 turn 会改变当前 runtime loop，第一版只入队 notification，由下一次 turn drain。
- 第一版不做 `SendMessage` 会限制后台 agent 的交互性，但可以显著降低一致性风险；该取舍已经被
  后续 `SendMessage` / `RespondToCoordinator` 契约替代。
- 仍然不把 child 全量 transcript 注入父会话，避免上下文爆炸。父会话接收 lifecycle/完成摘要，
  以及 child 通过 `RespondToCoordinator` 明确寻址发送的完整单条回复；后者不是 transcript 镜像。
