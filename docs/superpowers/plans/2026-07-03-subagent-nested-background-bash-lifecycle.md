# Subagent Nested Background Bash Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收敛 BG06：background subagent 内部启动 background Bash 后，Bash completion 归属于 child runtime 的 cleanup lifecycle，不复活已完成的 child model loop，也不补发 parent Agent result。

**Architecture:** 不引入全局 `agentId -> task` owner routing。ZCode 已经通过 main/child `AgentRuntime` 隔离解决了 runtime 串线问题；本计划只在 child runtime 内增加 terminal/sealed background notification policy、subagent-scope Bash 最大运行时长和取消清理。parent/main background Agent、parent Bash、goal defer/wake 主链路保持现状。

**Tech Stack:** TypeScript, `AgentRuntime`, `ToolExecutor`, `RuntimeTaskRegistry`, `ExecutionPort`, Vitest, desktop conversation E2E replay.

## Global Constraints

- 先更新 spec / matrix，再实现代码；BG06 语义必须先从 `deferred` 改成新 accepted boundary。
- 不引入任何外部产品命名的环境变量、标识符、注释或 provider-visible 文案。
- 不实现全局 owner graph，不给 Bash 为了 routing 增加 parent/main 可见 owner 字段；runtime 隔离是 routing 边界。
- 不把 nested Bash result 回写已完成的 parent Agent output。
- 不给 main 发第二条 Agent notification。
- 不改变 parent-level background Agent / Bash / Workflow 的 notification wake 行为。
- 不改 Bash 单一 `output-file` provider surface；stdout/stderr 收敛是独立需求。
- 不改手机 `web-remote-replayable` 语义；本计划只覆盖 desktop continuous / core runtime。
- 不自动提交；只有用户明确要求提交时才 `git commit`。

---

## Current Facts

- child runtime 是独立 `AgentRuntime`，在 `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts` 中创建。
- Bash background tracking 由 `apps/zcode-cli/packages/core/src/tool/executor/background-tasks.ts` 负责；terminal 后会尝试 enqueue `<task-notification>`。
- runtime command queue 在 `apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-queue.ts` 中消费 `task-notification`，当前会直接执行一轮 `executeTurnCommand(...)`。
- `RuntimeTaskRegistry` 已可记录 `local_bash` / `local_agent` / `local_workflow`，但没有 owner lifecycle 状态。
- 当前 BG06 文档仍是 `deferred`，且文字里还保留旧误解：“child runtime 消费 Bash notification 后再形成最终 Agent result”。本计划先修正文档语义。

## Target Semantics

### Expected

- background subagent 首轮 child turn 结束后，parent Agent 可以完成并向 main 发唯一一条 Agent `<task-notification>`。
- child runtime 内如果还有 background Bash 运行，它继续由 child runtime / execution adapter 追踪。
- child runtime sealed 后，nested Bash terminal 只做：
  - 更新 child `RuntimeTaskRegistry` terminal 状态；
  - 写 output artifact；
  - 发 child/parent mirrored UI session event，如果现有 event mirror 支持；
  - 清理 tracker / timer / process state。
- child runtime sealed 后，nested Bash terminal 不做：
  - 不 enqueue provider-visible child `<task-notification>` model turn；
  - 不驱动 child `executeTurnCommand(...)`；
  - 不补发 parent Agent result；
  - 不让 main goal 等待 nested Bash。
- subagent-scope background Bash 有最大运行时长；默认 `3_600_000ms`，超时后 kill/cancel 并落 terminal cleanup。
- 如果 subagent owner 被显式取消/kill，child runtime 内仍 running 的 background Bash 应被取消。

### Non-goals

- 不让 subagent 等 nested Bash 完成后再返回 main。
- 不让 nested Bash result 出现在 parent Agent output 中。
- 不为 unsupported terminal resume / manual background controls 扩大范围。
- 不把 Workflow 纳入 BG06；Workflow 已有 background registry 接入，但完整 output artifact 是独立收敛项。

---

## File Map

### Documentation

- Modify: `docs/conversation-session-case-catalog.md`
  - 更新 BG06 从 `deferred` 到新 accepted/pruned wording。
- Modify: `docs/testing/conversation-session-background-e2e-coverage-matrix.md`
  - 更新 Nested background boundary 和 BG06 accepted case。
- Modify: `docs/testing/conversation-session-e2e-coverage-matrix.md`
  - 更新 BG06 覆盖状态。
- Create later: `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-background-nested-bash.test.ts`
  - 只在 Phase 5 写入；前置 core behavior 稳定前不转正。

### Runtime / Tool Executor

- Modify: `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts`
  - 增加 runtime-local sealed state。
  - 给 `createToolExecutor(...)` 传入 notification policy 和 subagent Bash timeout config。
- Modify: `apps/zcode-cli/packages/core/src/runtime/internal.ts`
  - 扩展 `AgentRuntimeInternal` 字段/方法类型。
- Modify: `apps/zcode-cli/packages/core/src/runtime/types.ts`
  - 增加内部 runtime config：`subagents.backgroundBashMaxMs?: number`。
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/background-notifications.ts`
  - 增加 `sealBackgroundTaskNotifications(...)` 和 policy 判断 helper。
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`
  - child `executeTurn(...)` 结束后 seal child runtime。
  - child turn 被 abort/cancel 时，取消 child runtime 内 running background Bash。
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/index.ts`
  - 安装新增 runtime method。
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/types.ts`
  - 增加 `shouldEnqueueBackgroundTaskNotification` 与 `subagentBackgroundBashMaxMs` deps。
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/impl.ts`
  - 传递新增 deps。
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/background-tasks.ts`
  - terminal 前检查 notification policy；sealed child Bash 只 terminal cleanup，不 mark notified。
  - 为 subagent-scope Bash background task 安装最大运行时长 timer。
  - clear timer in `stopTracking()`.

### Tests

- Modify: `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`
  - core runtime policy tests。
- Modify: `apps/zcode-cli/packages/core/tests/subagent-background.test.ts`
  - subagent child runtime wiring tests，如现有 harness 合适。
- Modify or add: `packages/desktop/test/e2e/conversation-session/background/conversation-session-background.test.ts`
  - 只有 manual review 通过后再纳入正式 spec 或现有 BG spec。

---

## Phase 0: Spec and Matrix First

**Files:**
- Modify: `docs/conversation-session-case-catalog.md`
- Modify: `docs/testing/conversation-session-background-e2e-coverage-matrix.md`
- Modify: `docs/testing/conversation-session-e2e-coverage-matrix.md`

**Interfaces:**
- Consumes: 当前 BG06 deferred 文档。
- Produces: 新 BG06 accepted semantic contract，供后续 tests 和实现使用。

- [x] **Step 1: Update BG06 catalog wording**

Replace BG06 expectation with:

```markdown
| BG06 | background 子 agent 内部启动 background Bash | 子 Bash 在 child runtime sealed 后完成 | subagentRuntimeBackgroundTaskCleanup | background subagent 首轮 child turn 结束后可以完成并通知 parent；child 内部 background Bash completion 只更新 child runtime task/artifact/event cleanup，不再驱动 child model turn，不回写 parent Agent output，也不补发 parent notification | accepted |
```

- [x] **Step 2: Update background coverage matrix boundary**

Change `Nested background` decision to:

```markdown
| Nested background | accepted as cleanup-only child lifecycle | child runtime 内 background Bash terminal cleanup、timeout、cancel cleanup | nested Bash result 回写 parent Agent output；main/goal 等待 nested Bash | runtime-local queue 设计 + owner-scoped lifecycle 语义 |
```

- [x] **Step 3: Update BG06 accepted case**

Use this BG06 row:

```markdown
| BG06 | background subagent 内启动 background Bash；subagent 首轮 child turn 已完成 | 子 Bash 完成或超时 | parent 只收到一次 Agent completion notification；child Bash terminal 不再触发 child provider request；child registry/event/artifact terminal cleanup 完成；UI 不出现 parent fake-running | core runtime tests + manual/replay E2E parent surface | planned |
```

- [x] **Step 4: Run docs sanity check**

Run:

```bash
rg -n "BG06|Nested background|subagentRuntimeBackgroundTaskCleanup|deferred" docs/conversation-session-case-catalog.md docs/testing/conversation-session-background-e2e-coverage-matrix.md docs/testing/conversation-session-e2e-coverage-matrix.md
```

Expected:

- BG06 不再描述“等待 child Bash 后回写最终 Agent result”。
- BG06 可以仍是 `planned`，但不能继续是旧 `deferred` 语义。

**Phase 0 exit criteria:**

- BG06 产品语义清楚表达为 cleanup-only child lifecycle。
- 没有 code change。

---

## Phase 1: Runtime-local Sealed Notification Policy

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/internal.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/background-notifications.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/index.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/types.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/impl.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/background-tasks.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`

**Interfaces:**
- Produces:
  - `AgentRuntime.sealBackgroundTaskNotifications(input: { reason: "subagent_terminal" | "subagent_cancelled"; traceContext?: TraceContext }): void`
  - `ToolExecutorOptions.shouldEnqueueBackgroundTaskNotification?: (input: BackgroundTaskNotificationPolicyInput) => boolean`
  - `BackgroundTaskNotificationPolicyInput = { taskId: string; toolName: string; status: string; runtimeScope: ToolRuntimeScope; traceContext: TraceContext }`
- Consumes:
  - Existing `RuntimeTaskRegistry` terminal update.
  - Existing `enqueueBackgroundTaskNotification` sync command enqueue.

- [x] **Step 1: Write failing test for sealed subagent runtime**

Add a focused test in `runtime-tool-loop.test.ts`:

```ts
it("does not wake a sealed subagent runtime for background Bash completion", async () => {
  const sessionId = createSessionId("sealed-subagent-background-bash");
  const eventStore = createTestSessionEventStore();
  const sessionStore = new RecordingSessionStore();
  const startedAt = new Date(0);
  const completedAt = new Date(1);
  let modelCallCount = 0;
  let backgroundCompleted = false;

  const executionPort: ExecutionPort = {
    async run() {
      throw new Error("run should not be called for explicit background Bash");
    },
    async start() {
      return {
        taskId: "child_bash_bg",
        status: "running",
        startedAt,
        outputPath: "/tmp/child-bash.log",
      };
    },
    async getBackgroundTask(taskId) {
      if (!backgroundCompleted) {
        return { taskId, status: "running", startedAt, outputPath: "/tmp/child-bash.log" };
      }
      return {
        taskId,
        status: "completed",
        startedAt,
        completedAt,
        outputPath: "/tmp/child-bash.log",
        result: {
          status: "completed",
          exitCode: 0,
          stdout: { text: "done", bytes: 4, truncated: false },
          stderr: { text: "", bytes: 0, truncated: false },
          durationMs: 1,
          timedOut: false,
          cancelled: false,
          startedAt,
          completedAt,
        },
      };
    },
  };

  const runtime = new AgentRuntime(
    sessionId,
    {
      mode: "yolo",
      taskType: "subagent_child",
      workingDirectory: "/tmp/zcode-sealed-subagent-bg-bash",
    },
    {
      ...mcsCapableModelConnectionDeps(),
      eventStore,
      executionPort,
      modelAdapter: {
        async generateText(request: any) {
          modelCallCount += 1;
          if (modelCallCount === 1) {
            return {
              finishReason: "tool-calls",
              model: request.model,
              providerMetadata: undefined,
              text: "",
              toolCalls: [
                {
                  id: "bash-bg",
                  name: "Bash",
                  input: {
                    command: "node long-running.js",
                    description: "child long task",
                    run_in_background: true,
                  },
                },
              ],
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          }
          return {
            finishReason: "stop",
            model: request.model,
            providerMetadata: undefined,
            text: "child launched background bash",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      } as never,
      sessionStore,
    },
  );

  await runtime.executeTurn("start child background bash");
  runtime.sealBackgroundTaskNotifications({ reason: "subagent_terminal" });

  backgroundCompleted = true;
  await waitForCondition(async () => {
    const projection = await runtime.getProjection();
    return projection.backgroundTasks.some(
      (task) => task.taskId === "child_bash_bg" && task.status === "completed",
    );
  });

  expect(modelCallCount).toBe(2);
  const persisted = await sessionStore.messages({ sessionID: sessionId });
  expect(JSON.stringify(persisted)).not.toContain("<task-notification>");
});
```

Expected before implementation: fails because sealed method does not exist and/or notification still wakes model.

- [x] **Step 2: Add runtime sealed state**

Add private state to `AgentRuntime`:

```ts
private backgroundTaskNotificationsSealed = false;
private backgroundTaskNotificationSealReason?: "subagent_terminal" | "subagent_cancelled";
```

Add corresponding fields to `AgentRuntimeInternal`.

- [x] **Step 3: Add seal method in background-notifications**

In `runtime/methods/background-notifications.ts`, add:

```ts
export function sealBackgroundTaskNotifications(
  this: AgentRuntimeInternal,
  input: {
    reason: "subagent_terminal" | "subagent_cancelled";
    traceContext?: TraceContext;
  },
): void {
  if (this.config.taskType !== "subagent_child") return;
  this.backgroundTaskNotificationsSealed = true;
  this.backgroundTaskNotificationSealReason = input.reason;
  this.logger?.info?.("Subagent runtime background task notifications sealed", {
    ...traceContextToLogContext(input.traceContext ?? this.rootTraceContext),
    event: "runtime.background_task_notifications.sealed",
    module: "core.runtime",
    reason: input.reason,
  });
}
```

- [x] **Step 4: Add notification policy input**

In `tool/executor/types.ts`, add:

```ts
export interface BackgroundTaskNotificationPolicyInput {
  runtimeScope: ToolRuntimeScope;
  status: string;
  taskId: string;
  toolName: string;
  traceContext: TraceContext;
}

export type ShouldEnqueueBackgroundTaskNotification = (
  input: BackgroundTaskNotificationPolicyInput,
) => boolean;
```

Add `shouldEnqueueBackgroundTaskNotification?: ShouldEnqueueBackgroundTaskNotification` to options and deps.

- [x] **Step 5: Wire runtime policy into ToolExecutor**

In `agent-runtime.ts`, pass:

```ts
shouldEnqueueBackgroundTaskNotification: (input) => {
  if (this.config.taskType !== "subagent_child") return true;
  if (!this.backgroundTaskNotificationsSealed) return true;
  if (input.toolName !== "Bash") return true;
  this.logger?.info?.("Suppressed sealed subagent background Bash notification", {
    ...traceContextToLogContext(input.traceContext),
    event: "runtime.background_task_notification.suppressed",
    module: "core.runtime",
    reason: this.backgroundTaskNotificationSealReason,
    taskId: input.taskId,
    taskStatus: input.status,
    toolName: input.toolName,
  });
  return false;
},
```

- [x] **Step 6: Check policy before enqueue**

In `BackgroundTaskTracker.maybeEnqueueBackgroundTaskNotification(...)`, before formatting/enqueue:

```ts
if (
  this.deps.shouldEnqueueBackgroundTaskNotification?.({
    runtimeScope: this.deps.runtimeScope,
    status,
    taskId,
    toolName: toolCall.name,
    traceContext,
  }) === false
) {
  this.deps.logger?.info?.("Background task notification suppressed by runtime policy", {
    ...traceContextToLogContext(traceContext),
    event: "background_task.notification.suppressed",
    module: "core.tool.executor",
    taskId,
    taskStatus: status,
    toolName: toolCall.name,
  });
  return;
}
```

Do not call `markRuntimeBackgroundTaskNotified(...)` when policy suppresses notification.

- [x] **Step 7: Install method**

In `runtime/methods/index.ts`, install:

```ts
proto.sealBackgroundTaskNotifications = sealBackgroundTaskNotifications;
```

Add the method to the public `AgentRuntime` interface if TypeScript requires `childRuntime.sealBackgroundTaskNotifications(...)` later.

- [x] **Step 8: Run focused test**

Run:

```bash
../../node_modules/.bin/vitest run packages/core/tests/runtime-tool-loop.test.ts -t "sealed subagent runtime|background Bash"
```

Expected:

- New sealed test passes.
- Existing parent background Bash wake tests still pass.

**Phase 1 exit criteria:**

- Sealed subagent runtime suppresses nested Bash provider/model notification.
- Parent/main runtime still wakes for normal background Bash.
- Terminal registry/event cleanup still happens for nested Bash.

---

## Phase 2: Seal Child Runtime When Subagent Turn Ends

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`
- Test: `apps/zcode-cli/packages/core/tests/subagent-background.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`

**Interfaces:**
- Consumes: `AgentRuntime.sealBackgroundTaskNotifications(...)` from Phase 1.
- Produces: child runtime is sealed after the initial subagent turn returns or throws.

- [x] **Step 1: Write failing subagent integration test**

Add a test that uses a real `createDefaultSubagentPort` path when practical:

```ts
it("seals child runtime after subagent turn completion", async () => {
  // Arrange a parent runtime whose Agent tool starts a child runtime.
  // Child model: first request starts Bash(run_in_background=true), then stops.
  // Background Bash completion occurs after child stop.
  // Assert parent receives only the Agent completion notification and child does not issue a later model request.
});
```

If existing harness cannot easily expose child model call counts, keep this as a `runtime-tool-loop.test.ts` child-runtime unit and add the direct wiring test in Phase 5 E2E.

- [x] **Step 2: Wrap child executeTurn with finally**

In `createDefaultSubagentPort(...).runExploreAgent`, replace direct return:

```ts
return childRuntime.executeTurn(request.prompt, undefined, {
  abortSignal: options?.signal,
  traceContext: request.traceContext,
});
```

with:

```ts
try {
  return await childRuntime.executeTurn(request.prompt, undefined, {
    abortSignal: options?.signal,
    traceContext: request.traceContext,
  });
} finally {
  childRuntime.sealBackgroundTaskNotifications({
    reason: options?.signal?.aborted ? "subagent_cancelled" : "subagent_terminal",
    traceContext: request.traceContext,
  });
}
```

- [x] **Step 3: Keep parent notification unchanged**

Verify no change to:

- `finalizeBackgroundCompletion(...)`
- `finalizeBackgroundFailure(...)`
- `enqueueParentTaskNotification(...)`

Parent Agent completion remains the only parent-level notification.

- [x] **Step 4: Run focused tests**

Run:

```bash
../../node_modules/.bin/vitest run packages/core/tests/subagent-background.test.ts packages/core/tests/runtime-tool-loop.test.ts -t "background|sealed|subagent"
```

Expected:

- Existing background subagent tests pass.
- Existing parent notification tests pass.
- New sealed child behavior passes.

**Phase 2 exit criteria:**

- A completed child runtime cannot be reawakened into a model turn by later nested Bash completion.
- Parent/main Agent output and notification behavior are unchanged.

---

## Phase 3: Subagent-scope Background Bash Max Runtime

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/runtime/types.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/types.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/impl.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/background-tasks.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`

**Interfaces:**
- Produces:
  - `AgentRuntimeConfig.subagents?.backgroundBashMaxMs?: number`
  - `ToolExecutorDeps.subagentBackgroundBashMaxMs?: number`
- Consumes:
  - `ExecutionPort.cancelBackgroundTask(taskId)`.

- [x] **Step 1: Write failing timeout test**

Add:

```ts
it("cancels subagent background Bash after the subagent max runtime", async () => {
  vi.useFakeTimers();
  try {
    const sessionId = createSessionId("subagent-background-bash-timeout");
    const eventStore = createTestSessionEventStore();
    const sessionStore = new RecordingSessionStore();
    const startedAt = new Date(0);
    const cancelled: string[] = [];

    const executionPort: ExecutionPort = {
      async run() {
        throw new Error("run should not be called");
      },
      async start() {
        return { taskId: "child_bash_timeout", status: "running", startedAt };
      },
      async getBackgroundTask(taskId) {
        return { taskId, status: "running", startedAt };
      },
      async cancelBackgroundTask(taskId) {
        cancelled.push(taskId);
        return {
          taskId,
          status: "cancelled",
          startedAt,
          completedAt: new Date(10),
        };
      },
    };

    const runtime = new AgentRuntime(
      sessionId,
      {
        mode: "yolo",
        taskType: "subagent_child",
        subagents: { backgroundBashMaxMs: 10 },
        workingDirectory: "/tmp/zcode-subagent-bash-timeout",
      },
      {
        ...mcsCapableModelConnectionDeps(),
        eventStore,
        executionPort,
        modelAdapter: {
          async generateText(request: any) {
            modelCallCount += 1;
            if (modelCallCount === 1) {
              return {
                finishReason: "tool-calls",
                model: request.model,
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  {
                    id: "bash-bg",
                    name: "Bash",
                    input: {
                      command: "node long-running.js",
                      description: "child long task",
                      run_in_background: true,
                    },
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            return {
              finishReason: "stop",
              model: request.model,
              providerMetadata: undefined,
              text: "child launched background bash",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never,
        sessionStore,
      },
    );

    await runtime.executeTurn("launch child bash");
    await vi.advanceTimersByTimeAsync(10);

    expect(cancelled).toEqual(["child_bash_timeout"]);
  } finally {
    vi.useRealTimers();
  }
});
```

- [x] **Step 2: Add config**

In `AgentRuntimeConfig.subagents`, add:

```ts
backgroundBashMaxMs?: number;
```

Do not expose CLI/user config in this phase unless existing runtime config plumbing requires it for tests.

- [x] **Step 3: Pass config into child runtime**

In `subagent.ts`, when constructing child runtime:

```ts
subagents: {
  enabled: false,
  backgroundBashMaxMs: this.config.subagents?.backgroundBashMaxMs,
},
```

If undefined, child runtime uses default.

- [x] **Step 4: Pass timeout into ToolExecutor deps**

In `agent-runtime.ts`:

```ts
subagentBackgroundBashMaxMs:
  this.config.taskType === "subagent_child"
    ? normalizeSubagentBackgroundBashMaxMs(this.config.subagents?.backgroundBashMaxMs)
    : undefined,
```

Add helper:

```ts
const DEFAULT_SUBAGENT_BACKGROUND_BASH_MAX_MS = 3_600_000;

function normalizeSubagentBackgroundBashMaxMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_SUBAGENT_BACKGROUND_BASH_MAX_MS;
  }
  return Math.trunc(value);
}
```

- [x] **Step 5: Start timeout in BackgroundTaskTracker**

In `trackBackgroundTask(...)`, after background task registration and before poll/wait:

```ts
let maxRuntimeTimer: ReturnType<typeof setTimeout> | undefined;

if (
  toolCall.name === "Bash" &&
  this.deps.runtimeScope === "subagent" &&
  this.deps.subagentBackgroundBashMaxMs !== undefined
) {
  maxRuntimeTimer = setTimeout(() => {
    this.deps.logger?.warn("Subagent background Bash exceeded max runtime; cancelling", {
      ...traceContextToLogContext(traceContext),
      event: "background_task.subagent_bash.max_runtime_exceeded",
      module: "core.tool.executor",
      taskId,
      toolName: toolCall.name,
    });
    void this.deps.executionPort?.cancelBackgroundTask?.(taskId);
  }, this.deps.subagentBackgroundBashMaxMs);
  maxRuntimeTimer.unref?.();
}
```

In `stopTracking()`:

```ts
if (maxRuntimeTimer) clearTimeout(maxRuntimeTimer);
maxRuntimeTimer = undefined;
```

- [x] **Step 6: Run focused timeout tests**

Run:

```bash
../../node_modules/.bin/vitest run packages/core/tests/runtime-tool-loop.test.ts -t "subagent background Bash|max runtime|background Bash"
```

Expected:

- Timeout test passes.
- Existing background Bash tests still pass.

**Phase 3 exit criteria:**

- subagent-scope background Bash cannot run forever by default.
- Main runtime background Bash does not get the subagent max-runtime timer.
- No external-product keyword introduced.

---

## Phase 4: Cancel Running Child Background Bash on Subagent Cancellation

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/background.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/index.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/internal.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`

**Interfaces:**
- Produces:
  - `AgentRuntime.cancelRunningRuntimeBackgroundTasks(input: { reason: "subagent_cancelled"; traceContext?: TraceContext }): Promise<void>`
- Consumes:
  - `runtimeTaskRegistry.all()`
  - `executionPort.cancelBackgroundTask(taskId)`

- [x] **Step 1: Write failing cancellation test**

Add:

```ts
it("cancels running subagent background Bash tasks when the subagent turn is cancelled", async () => {
  const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
  const cancelled: string[] = [];
  const runtime = new AgentRuntime(
    createSessionId("subagent-background-bash-cancel-cleanup"),
    { mode: "yolo", taskType: "subagent_child", workingDirectory: "/tmp/zcode-child-cancel" },
    {
      ...mcsCapableModelConnectionDeps(),
      eventStore: createTestSessionEventStore(),
      executionPort: {
        async run() {
          throw new Error("not used");
        },
        async cancelBackgroundTask(taskId) {
          cancelled.push(taskId);
          return { taskId, status: "cancelled", startedAt: new Date(0), completedAt: new Date(1) };
        },
      },
      modelAdapter: {
        async generateText(request: any) {
          return {
            finishReason: "stop",
            model: request.model,
            providerMetadata: undefined,
            text: "done",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      } as never,
      runtimeTaskRegistry,
      sessionStore: new RecordingSessionStore(),
    },
  );

  runtimeTaskRegistry.register({
    agentId: "child_bash_cancel",
    agentType: "local_bash",
    description: "child bash",
    isBackgrounded: true,
    startedAt: new Date(0),
    status: "running",
    taskId: "child_bash_cancel",
    taskType: "local_bash",
    type: "local_bash",
  });

  await runtime.cancelRunningRuntimeBackgroundTasks({
    reason: "subagent_cancelled",
  });

  expect(cancelled).toEqual(["child_bash_cancel"]);
});
```

- [x] **Step 2: Implement runtime cancellation helper**

In `runtime/methods/background.ts`, add:

```ts
export async function cancelRunningRuntimeBackgroundTasks(
  this: AgentRuntimeInternal,
  input: { reason: "subagent_cancelled"; traceContext?: TraceContext },
): Promise<void> {
  if (this.config.taskType !== "subagent_child") return;
  const traceContext = input.traceContext ?? this.rootTraceContext;
  const tasks = Object.values(this.runtimeTaskRegistry.all()).filter(
    (task) =>
      task.type === "local_bash" &&
      task.isBackgrounded === true &&
      task.status === "running",
  );

  for (const task of tasks) {
    this.logger?.info?.("Cancelling subagent background task during runtime cleanup", {
      ...traceContextToLogContext(traceContext),
      event: "runtime.background_task.cleanup_cancel",
      module: "core.runtime",
      reason: input.reason,
      taskId: task.taskId,
    });
    await this.cancelBackgroundTask(task.taskId, { traceContext });
  }
}
```

- [x] **Step 3: Wire cancellation on aborted child turn**

In `subagent.ts`, extend the `finally` from Phase 2:

```ts
const cancelled = options?.signal?.aborted === true;
try {
  return await childRuntime.executeTurn(...);
} finally {
  childRuntime.sealBackgroundTaskNotifications({
    reason: cancelled ? "subagent_cancelled" : "subagent_terminal",
    traceContext: request.traceContext,
  });
  if (cancelled) {
    await childRuntime.cancelRunningRuntimeBackgroundTasks({
      reason: "subagent_cancelled",
      traceContext: request.traceContext,
    });
  }
}
```

- [x] **Step 4: Run focused cancellation tests**

Run:

```bash
../../node_modules/.bin/vitest run packages/core/tests/runtime-tool-loop.test.ts packages/core/tests/subagent-background.test.ts -t "cancel|background Bash|subagent"
```

Expected:

- Cancellation helper cancels running child background Bash.
- Normal completed child runtime does not cancel nested Bash; it relies on terminal cleanup/timeout.

**Phase 4 exit criteria:**

- Explicit subagent cancellation does not leave detached child Bash orphaned.
- Completed subagent still allows child Bash to finish cleanup-only.

---

## Phase 5: BG06 E2E Manual Review and Promotion

**Files:**
- Modify: `packages/desktop/test/e2e/conversation-session/background/conversation-session-background.test.ts`
- Modify: `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-background.json`
- Modify: `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-background.json`
- Modify after promotion: `docs/testing/conversation-session-background-e2e-coverage-matrix.md`
- Modify after promotion: `docs/testing/conversation-session-e2e-coverage-matrix.md`

**Interfaces:**
- Consumes: core runtime behavior from Phases 1-4.
- Produces: replayable BG06 parent-surface proof.

- [x] **Step 1: Write replay E2E spec**

Spec should drive:

```text
E2E_BACKGROUND_NESTED_BASH:
1. main launches Agent(run_in_background=true)
2. child Agent starts Bash(run_in_background=true)
3. child Agent ends its first turn
4. parent receives exactly one Agent completion notification
5. child Bash later completes
  6. parent does not receive a second Agent notification and does not show fake-running
```

Assertions:

- parent model request contains Agent launch result.
- parent later model request contains exactly one Agent `<task-notification>`.
- no later parent request contains nested Bash `<task-notification>`.
- UI visible user messages do not include `<task-notification>`.
- session returns idle after parent Agent notification.
- child model-io does not contain nested Bash `<task-notification>` after child runtime is sealed.

- [x] **Step 2: Run fixture validation**

Run:

```bash
python -m json.tool packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-background.json >/dev/null
python -m json.tool packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-background.json >/dev/null
pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/background/conversation-session-background.test.ts
```

Expected:

- Fixture JSON is valid.
- Fixture contract includes the new BG06 requests.

- [x] **Step 3: Reuse existing background suite instead of promotion**

BG06 is part of the same accepted background surface as BG01-BG03/BG07, so it was added directly to the existing formal background replay suite instead of creating and promoting a separate manual-review spec.

- [x] **Step 4: Fill fixture contract**

Classify requests:

```text
main: Agent launch request
main: parent Agent completion notification request
ignore: title generation
ignore or synthetic: child-internal provider requests if the spec only asserts parent surface
```

Case-specific responses were added only to the existing background case-local fixture.

- [x] **Step 5: Verify fixture and replay**

Run:

```bash
pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/background/conversation-session-background.test.ts

E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-background.json \
  pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/background/conversation-session-background.test.ts'

pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/background/conversation-session-background.test.ts'
```

Expected:

- Fixture check passes.
- Replay passes with only common + case-local fixture.
- Default replay passes.

**Phase 5 exit criteria:**

- BG06 is covered by replayable E2E or remains documented as manual-reviewed pending with explicit reason.
- Coverage matrix reflects actual status.

---

## Phase 6: Regression Verification

**Files:**
- No new implementation files.
- Update docs only if verification uncovers an intentional scope note.

- [x] **Step 1: Run core focused tests**

Run:

```bash
../../node_modules/.bin/vitest run packages/core/tests/runtime-tool-loop.test.ts packages/core/tests/subagent-background.test.ts packages/core/tests/bash-handler.test.ts
```

Expected:

- All focused core tests pass.

- [x] **Step 2: Run existing background E2E fixture checks**

Run:

```bash
pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/background/conversation-session-background.test.ts
```

Expected:

- Existing BG01-BG05/BG07 fixture check remains green.

- [x] **Step 3: Run typecheck/lint**

Run:

```bash
pnpm --filter @zcode/desktop typecheck:e2e
pnpm typecheck
pnpm lint
```

Expected:

- Typecheck passes; lint exits successfully with existing warnings only.
- If unrelated existing failures appear, record exact failing command and first relevant error.

- [x] **Step 4: Provider-visible keyword scan**

Run:

```bash
python - <<'PY'
from pathlib import Path
import subprocess
import sys

paths = subprocess.check_output(
    [
        "git",
        "diff",
        "--name-only",
        "--",
        "apps/zcode-cli/packages/core/src",
        "apps/zcode-cli/packages/adapters/src",
        "packages/desktop/test/e2e",
        "docs/conversation-session-case-catalog.md",
        "docs/testing/conversation-session-background-e2e-coverage-matrix.md",
        "docs/testing/conversation-session-e2e-coverage-matrix.md",
    ],
    text=True,
).splitlines()

# 用 char code 构造禁用词，避免本计划文件自身包含禁用字面量。
terms = [
    "".join(map(chr, [67, 76, 65, 85, 68, 69])),
    "".join(map(chr, [67, 108, 97, 117, 100, 101])),
    "".join(map(chr, [99, 108, 97, 117, 100, 101])),
]

matches = []
for item in paths:
    path = Path(item)
    if not path.is_file():
        continue
    text = path.read_text(errors="ignore")
    for line_number, line in enumerate(text.splitlines(), 1):
        if any(term in line for term in terms):
            matches.append(f"{item}:{line_number}:{line}")

if matches:
    print("\n".join(matches))
    sys.exit(1)
PY
```

Expected:

- No new provider/runtime identifiers or docs text introduced by this work that anchors behavior to external product names.
- Existing vendor docs are not part of this scan.

**Phase 6 exit criteria:**

- Core tests green.
- Existing background behavior not regressed.
- BG06 new semantics verified or explicitly left as manual-reviewed pending.
- No unintended provider-visible surface change.

---

## Review Checklist

- [x] BG06 wording no longer says nested Bash should update parent Agent output.
- [x] Runtime isolation remains the routing boundary.
- [x] Sealed child runtime suppresses only child Bash model notification, not parent Bash or parent Agent notifications.
- [x] Suppressed notification does not mark task `notified: true`.
- [x] BackgroundTaskCompleted / registry terminal state still happens for nested Bash.
- [x] Subagent background Bash max runtime applies only to `runtimeScope === "subagent"` and Bash.
- [x] Explicit child cancellation cancels running child background Bash.
- [x] No external-product keyword added.
- [x] No mobile replayable behavior changed.
- [x] No commit made without explicit user request.

## Implementation Notes

- Prefer small runtime-local helpers over a global owner graph.
- If a test needs to observe child runtime requests, prefer a core unit test over an E2E timing assertion.
- If E2E cannot reliably capture child-internal provider traffic, assert parent-visible invariants and leave child behavior to core tests.
- Do not broaden this into Workflow output artifact or Bash single output-file work.
