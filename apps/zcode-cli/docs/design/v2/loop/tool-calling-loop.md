# Tool Calling Loop 实现计划

> 模型异常兜底和 tool call 计数策略见 [`model-anomaly-fallbacks.md`](./model-anomaly-fallbacks.md)。ZCode 面向长程任务，tool call 数量不设硬停止条件；context/token limit 触发 auto compact，provider context overflow 触发 reactive compact。

## 核心循环

> 运行中继续输入的 steering 语义见 [`turn-steering.md`](./turn-steering.md)。pending input 只能在 tool results 已注入后的下一次 model request 边界 drain，不能插入 assistant tool calls 和对应 tool results 中间。

```
┌─────────────────────────────────────────────────────────────────┐
│                        Tool Calling Loop                          │
│                                                                  │
│   ┌──────────────┐                                               │
│   │  User Input  │                                               │
│   └──────┬───────┘                                               │
│          │                                                        │
│          ▼                                                        │
│   ┌──────────────┐     ┌──────────────┐                          │
│   │  Call Model  │────▶│ Has Tool     │                          │
│   │  (messages)  │     │   Calls?     │                          │
│   └──────────────┘     └──────┬───────┘                          │
│          ▲                     │                                 │
│          │                     No                                  │
│          │                     │                                   │
│          │                     ▼                                   │
│          │              ┌──────────────┐                          │
│          │              │   Return     │                          │
│          │              │   Response   │                          │
│          │              └──────────────┘                          │
│          │                                                        │
│          │                     Yes                                │
│          │                     ▼                                  │
│          │            ┌──────────────┐                           │
│          │            │   Schedule   │                            │
│          │            └──────┬───────┘                            │
│          │                  │                                     │
│          │                  ▼                                     │
│          │          ┌──────────────┐                            │
│          │          │   Execute    │                             │
│          │          │   Tools      │                             │
│          │          └──────┬───────┘                             │
│          │                 │                                     │
│          │                 ▼                                     │
│          │          ┌──────────────┐                             │
│          │          │ Inject Tool  │                            │
│          │          │  Results     │                             │
│          │          │  (messages)  │                             │
│          │          └──────┬───────┘                             │
│          │                 │                                     │
│          │                 ▼                                     │
│          │          ┌──────────────┐     ┌──────────────┐        │
│          │          │ Call Model   │────▶│ Has Tool     │        │
│          │          │ (continue)   │     │   Calls?     │        │
│          │          └──────────────┘     └──────────────┘        │
└─────────────────────────────────────────────────────────────────┘
```

---

## 一、关键组件职责

| 阶段 | 组件 | 职责 |
|------|------|------|
| Call Model | `AgentRuntime` | 维护 messages，调用 model adapter |
| ~~Permission Check~~ | ~~暂跳过，后续实现~~ | |
| Schedule | `ToolScheduler` | 拓扑排序，确定并行组 |
| Execute | `ToolExecutor` | 执行工具，返回结果 |
| Inject Results | `MessageHistory` | 将 tool results 追加到 messages |
| Drain Pending Input | `AgentRuntime` | 将 active turn queue 中的用户输入追加为 user messages |
| Continue | Loop | 无 tool calls 时退出 |

执行器可以因为权限拒绝、取消或高风险失败停止后续批次，但 provider-visible 历史仍必须为本轮 assistant 返回的每个 tool call 注入一个 tool result。若后续批次未实际执行，执行器返回合成的 skipped/error result，避免下一次模型请求出现 dangling tool call。

---

## 二、实现文件

### 2.1 MessageHistory (新增)

**文件**: `packages/core/src/agent/message-history.ts`

```typescript
export interface MessageHistory {
  messages: ModelMessage[];

  // 初始化（可选：加载历史消息）
  init(systemPrompt?: string): void;

  // 追加用户消息
  addUser(content: string): void;

  // 追加必要的 runtime context；不得用于 tool call 数量硬停
  addSystem(content: string): void;

  // 追加助手消息（可能包含 tool_calls）
  addAssistant(content: string, toolCalls?: ToolCall[]): void;

  // 追加工具结果
  addToolResult(toolCallId: string, toolName: string, content: string, success: boolean): void;

  // 转为模型格式
  toModelMessages(): ModelInputMessage[];

  // 获取当前消息数
  getMessageCount(): number;

  // 获取可缓存的消息（用于缓存优化）
  getCacheableMessages(): ModelMessage[];
}

export class MessageHistoryImpl implements MessageHistory {
  private messages: ModelMessage[] = [];

  addAssistant(content: string, toolCalls?: ToolCall[]): void {
    this.messages.push({
      role: 'assistant',
      content,
      toolCalls: toolCalls?.map(tc => ({
        id: tc.id,
        name: tc.name,
        input: tc.input,
      })),
    });
  }

  addToolResult(toolCallId: string, toolName: string, content: string, success: boolean): void {
    this.messages.push({
      role: 'tool',
      content: success ? content : JSON.stringify({ error: content }),
      toolCallId,
      toolName,
    });
  }
}
```

### 2.2 Runtime.executeTurn (核心循环)

**文件**: `packages/core/src/runtime.ts`

```typescript
async executeTurn(input: string, attachments?: TurnAttachment[]): Promise<TurnResult> {
  const turnId = createTurnId();
  const traceId = createTraceId();
  const events: SessionEvent[] = [];
  let turnMachine = TurnMachineImpl.create(this.sessionId, this.turnNumber, input, traceId);
  turnMachine = new TurnMachineImpl(turnMachine.start());

  // 复用 session 级消息历史；同一个 runtime 内多轮对话会累积 user/assistant/tool 消息
  const history = this.messageHistory;

  // 记录 turn_started
  const turnStartedEvent = this.createEvent('turn_started', { turnNumber: this.turnNumber, input }, { turnId, traceId });
  events.push(turnStartedEvent);
  await this.eventStore.append(turnStartedEvent);

  try {
    // Step 1: 添加本轮用户输入到 session 消息历史
    history.addUser(input);

    // Step 2: Tool Calling 循环
    // toolCallCount is telemetry only. Long-running tasks are bounded by
    // cancellation, permissions, tool contracts, provider retry limits, and
    // context/token compaction rather than by a global tool-call count.
    let toolCallCount = 0;

    while (true) {
      // ===== 调用模型 =====
      const tools = this.getTools();  // 缓存的工具列表

      let modelResponse: string;
      let toolCalls: ToolCall[] = [];

      turnMachine = new TurnMachineImpl(
        turnMachine.startModelRequest('claude', history.toModelMessages())
      );

      if (this.modelAdapter) {
        const result = await this.modelAdapter.generateText({
          model: this.defaultModelRef,
          messages: history.toModelMessages(),
          tools,
          abortSignal,
        });
        modelResponse = result.text;
        toolCalls = this.extractToolCalls(result);

        // 记录 usage（用于缓存分析）
        this.recordUsage(result.usage);
      }

      // ===== 循环退出条件：无 tool calls =====
      if (toolCalls.length === 0) {
        history.addAssistant(modelResponse);
        turnMachine = new TurnMachineImpl(turnMachine.complete(modelResponse));

        const completeEvent = this.createEvent('turn_complete', {
          response: modelResponse,
          tokenCount: 0,
          toolCallCount,
          duration: Date.now() - turnMachine.state.startedAt.getTime(),
          resultType: 'success',
        }, { turnId, traceId });

        events.push(completeEvent);
        await this.eventStore.append(completeEvent);

        this.turnNumber++;
        const projection = await this.rebuildProjection();

        return {
          response: modelResponse,
          turnId,
          events,
          projection,
        };
      }

      // ===== 记录 tool call 计数 =====
      toolCallCount += toolCalls.length;
      await this.recordToolCallTelemetry({ toolCallCount });

      // ===== 记录 assistant 消息（含 tool_calls）=====
      history.addAssistant(modelResponse, toolCalls);

      // ===== ~~权限检查~~ 暂跳过 =====

      // ===== 调度工具 =====
      const schedule = await this.scheduleTools(toolCalls);
      turnMachine = new TurnMachineImpl(
        turnMachine.scheduleTools(toolCalls, this.toScheduleState(schedule))
      );
      for (const item of schedule.items) {
        await this.emitToolCallScheduled(item, schedule);
      }

      // ===== 按 schedule 执行工具 =====
      turnMachine = new TurnMachineImpl(turnMachine.startToolExecution());
      const results = await this.executeTools(toolCalls, schedule, { abortSignal });
      for (const result of results) {
        turnMachine = new TurnMachineImpl(
          turnMachine.completeTool(result.toolCallId, {
            success: result.success,
            content: stringifyToolOutput(result),
          })
        );
      }
      turnMachine = new TurnMachineImpl(turnMachine.aggregateResults());

      // ===== 注入 Tool Results 到消息 =====
      for (const result of results) {
        history.addToolResult(
          result.toolCallId,
          result.toolName,
          typeof result.output === 'string' ? result.output : JSON.stringify(result.output),
          result.success
        );
      }

      // ===== 继续循环 =====
    }
  } catch (error) {
    // 错误处理...
    throw error;
  }
}
```

### 2.3 extractToolCalls 适配

**文件**: `packages/adapters/src/model/transform.ts`

```typescript
import type { ToolCall } from '@zcode/core';

export function extractToolCalls(result: GenerateTextResult): ToolCall[] {
  const calls: ToolCall[] = [];

  for (const response of result.responses ?? []) {
    if (response.role === 'assistant' && response.toolCalls) {
      for (const tc of response.toolCalls) {
        calls.push({
          id: tc.id,
          name: tc.name,
          input: tc.input,
        });
      }
    }
  }

  return calls;
}
```

### 2.4 工具缓存

**文件**: `packages/core/src/runtime.ts`

```typescript
export class AgentRuntime {
  private cachedTools: ModelToolContract[] | null = null;

  private getTools(): ModelToolContract[] {
    if (this.cachedTools === null) {
      this.cachedTools = this.registry.toContracts();
    }
    return this.cachedTools;
  }

  getToolRegistry(): ToolRegistry {
    return this.registry;
  }

  // 工具注册变更时 invalidate
  registerTool(entry: ToolEntry): void {
    this.registry.register(entry);
    this.cachedTools = null;
  }
}
```

---

## 三、权限检查集成

```typescript
private async checkPermissions(toolCalls: ToolCall[]): Promise<Map<ToolCallId, PermissionDecisionResult>> {
  const results = new Map<ToolCallId, PermissionDecisionResult>();

  for (const tc of toolCalls) {
    const entry = this.registry.get(tc.name);
    if (!entry) {
      results.set(tc.id, { allowed: false, reason: 'Tool not found' });
      continue;
    }

    const context: PermissionContext = {
      toolName: tc.name,
      input: tc.input,
      riskLevel: entry.metadata.riskLevel,
      mode: this.config.mode ?? 'auto',
    };

    const decision = this.permissionService.checkPermission(context, {
      riskLevel: entry.metadata.riskLevel,
    });

    if (decision.allowed) {
      results.set(tc.id, decision);
    } else {
      // 记录权限请求事件
      await this.emitPermissionRequest(tc.id, tc.name, entry.metadata.riskLevel);
      results.set(tc.id, decision);
    }
  }

  return results;
}
```

---

## 四、调度与执行

调度结果是 runtime 的执行契约，不是日志或提示信息。runtime 必须把 `ToolSchedule.parallelGroups`
交给 executor 的 `executeSchedule()` 消费；不得在拿到 schedule 后退回 `executeBatch()` 把所有 tool call
一次性并行执行。这样才能保证只读工具并行、有副作用工具串行、依赖顺序、权限阻塞和失败短路在同一条状态机路径里被观测。

```typescript
private async scheduleTools(toolCalls: ToolCall[]): Promise<ToolSchedule> {
  const dependencies: ToolDependency[] = toolCalls.map((tc) => ({
    toolCallId: tc.id,
    toolName: tc.name,
    dependsOn: [],
    ...this.registry.getMetadata(tc.name),
  }));

  return this.toolScheduler.schedule(dependencies, READ_ONLY_TOOLS);
}

private toScheduleState(schedule: ToolSchedule): ToolScheduleState {
  return {
    items: schedule.items.map(item => ({
      toolCallId: item.toolCallId,
      dependencies: item.dependencies,
      canRunParallel: item.canRunParallel,
    })),
    parallelGroups: schedule.parallelGroups,
    executionOrder: schedule.executionOrder,
  };
}
```

执行阶段必须满足以下事件和取消契约：

1. 每个被调度的 tool call 在执行前写入 `tool_call_scheduled`，payload 至少包含 `toolCallId`、`toolName`、`input`、`dependencies`、`parallelGroupIndex`、`canRunParallel` 和完整 schedule 摘要。
2. 每个 parallel group 开始时只把该组对应的持久化 tool part 标记为 running；组完成后写入 `tool_batch_complete`。
3. `TurnMachine` phase 真实驱动 loop：`ProcessingInput -> AwaitingModelResponse -> Streaming -> SchedulingTools -> ExecutingTools -> AggregatingResults -> AwaitingModelResponse/Completing`。
4. `executeTurn(..., { abortSignal })` 必须把同一个 signal 传给 model adapter、tool executor 和每个 `ToolExecutionContext`；任何一层取消都应向上归属到同一 `traceId`。
5. 中断标记：轮次被停止（`TurnCancelled`），或被宿主外部故障中止（例如投影超限，本轮记为 TurnError）后，在已提交的 assistant / tool result 之后追加一条普通 user 文本，下一次请求的模型可以看到。
   - 工具批次结算时已停止（包括结算中 checkpoint 被取消）：`[Request interrupted by user for tool use]`；其他时候（模型请求、等待首 token、流式输出中）：`[Request interrupted by user]`。
   - send-now 抢占（`preserveQueueAutoDrainOnCancel`）是为了交付下一条输入，不加标记；轮次循环开始前取消（例如排队中的 prompt 被取消）也不加。
   - 标记是 runtime source `interrupt_marker` 的 message entry：不冒泡、MCS 下不转 system；附件冒泡越过它；按用户输入参与相邻 user 的换行规则（只在 Anthropic 协议上：前一条 user 文本补 `\n`，后面接用户输入时标记自身补 `\n`）。
   - 与其他动态公告一样按隐藏提醒持久化：model-only synthetic user 消息，不写顶层 `source`（App 按封闭列表校验这个字段，新值会让旧版本拒绝整个会话），类型记在 `runtimeMessage.source = "interrupt_marker"`；冷恢复还原同一条 entry，旧版本不认识这个类型时也不报错。写入失败只记 warn，不替换取消结果。
   - 冷恢复的轮次结果以标记为准：本轮有标记时按 cancelled 收口（已有持久化错误时仍显示该错误）。场景：最终文本已完整输出后再停止，assistant 记录是 `finish=stop`、没有 error；live 显示 cancelled，冷恢复也必须是 cancelled。
   - 工具取消结果的文字：被停止或被宿主故障中止的批次里，被取消的工具（`ToolCancelled`：未开始、执行中、等待权限）给模型的 tool_result 统一为 `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.`，`is_error: true`。只换 `modelContent`（冷恢复从 part metadata 重放）；`error.message` 不变，工具卡片仍显示各工具自己的取消原因。停止前已完成的结果、超时等其他错误不变。send-now 抢占的取消结果不换。
   - send-now 抢占时，前台等待中（child 运行中）的前台 Agent 转入后台，结果是成功的 `async_launched`，child 完成后经 task-notification 送回；启动阶段、收尾阶段（child 已完成、失败或闲置超时）、禁止后台的执行和已结束的任务照旧取消。其他工具照旧取消。规则见 [turn-steering 前台子代理转后台](turn-steering.md#前台子代理转后台2026-10-29)。

---

## 五、缓存感知

### 5.1 消息历史与缓存

```typescript
export interface MessageHistory {
  // 获取当前缓存前缀大小（用于判断 cache hit）
  getCachedMessageCount(): number;

  // 标记已缓存的消息数
  setCachedMessageCount(count: number): void;
}

export class MessageHistoryImpl implements MessageHistory {
  private cachedMessageCount = 0;

  setCachedMessageCount(count: number): void {
    this.cachedMessageCount = count;
  }
}
```

### 5.2 缓存命中检测

```typescript
private recordUsage(usage: ModelUsage): void {
  if (usage.cacheReadTokens && usage.cacheReadTokens > 0) {
    // Provider 报告了 cache hit
    // 可以更新缓存统计
    this.lastCacheHit = true;
    this.lastCacheTokens = usage.cacheReadTokens;
  }
}
```

---

## 六、完整循环时序

```
Turn Start
    │
    ▼
┌────────────────────────────────────────┐
│ Add User Message to History           │
└────────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────────┐
│ LOOP: Call Model                       │
│   - messages = history.toModelMessages│
│   - tools = registry.toContracts()     │
│   - result = model.generate()         │
└────────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────────┐
│ Check Tool Calls                       │
│   - If empty: BREAK, return response  │
│   - If has calls: CONTINUE            │
└────────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────────┐
│ Add Assistant Message (with calls)     │
│   history.addAssistant(text, calls)    │
└────────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────────┐
│ Permission Check                       │
│   - permissionService.check()         │
│   - emit permission_requested event  │
│   - filter denied tool calls          │
└────────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────────┐
│ Schedule Tools                         │
│   - scheduler.schedule()              │
│   - emit tool_call_scheduled event    │
└────────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────────┐
│ Execute Tools (sequential)             │
│   - executor.executeSchedule()        │
│   - emit tool_call_started/complete    │
└────────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────────┐
│ Inject Tool Results                    │
│   - history.addToolResult()           │
│   - one message per tool result       │
└────────────────────────────────────────┘
    │
    ▼
         LOOP BACK TO Call Model
```

---

## 七、任务清单

| # | Task | File | 依赖 |
|---|------|------|------|
| 1 | MessageHistory 类 | `agent/message-history.ts` | 无 |
| 2 | extractToolCalls | `adapters/model/transform.ts` | 无 |
| 3 | Runtime Tool Loop | `runtime.ts` | 1, 2 |
| 4 | 工具缓存 | `runtime.ts` | 3 |
| 5 | 权限检查集成 | `runtime.ts` | 3 |
| 6 | 缓存感知统计 | `agent/cache-aware.ts` | 1 |
| 7 | 单元测试 | `runtime.test.ts` | 1-5 |

---

## 八、验证用例

```
Case 1: 无 Tool Call
  Input: "Hello"
  Model: "Hi!"
  Output: "Hi!"

Case 2: 单次 Tool Call
  Input: "Read package.json"
  Model: (calls Read tool)
  Execute: Read package.json
  Result: "{ name: "test" }"
  Model: "The package.json contains..."
  Output: "The package.json contains..."

Case 3: 多次 Tool Calls
  Input: "Read all config files"
  Model: (calls Read x3)
  Execute: Read file1, file2, file3
  Result: content1, content2, content3
  Model: "Here are the configs..."
  Output: "Here are the configs..."

Case 4: 长程 Tool Calls
  Input: (triggers many tool calls)
  Count > 100
  Event: telemetry/log records toolCallCount
  No hard stop; tools remain available
  Context/token limit may compact before the next model request

Case 5: 工具执行失败
  Input: "Do something"
  Model: (calls Tool X)
  Execute: FAIL
  Result: { error: "..." }
  Model: "The operation failed because..."
  Output: "The operation failed..."
```
