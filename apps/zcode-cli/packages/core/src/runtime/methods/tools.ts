import {
  RewindScope,
  SessionEventType,
  getCurrentTraceContext,
  traceContextToLogContext,
} from "../deps.js";
import type {
  MessageId,
  PermissionBrokerResult,
  SessionEvent,
  ToolCallId,
  TraceContext,
  ToolCall,
  ToolDependency,
  ToolSchedule,
  ExecutableToolCall,
  ToolExecutionResult,
} from "../deps.js";
import {
  isResolvablePermissionBroker,
  getFileMutationCheckpointCandidate,
  WORKSPACE_CHECKPOINT_CONTENT_TYPE,
  stringifyWorkspaceCheckpointArtifact,
  throwIfTurnAborted,
  createTurnCancelledError,
  isTurnCancellationError,
  findParallelGroupIndex,
  recordTurnFileChange,
} from "../helpers/index.js";
import type {
  PermissionDecisionResult,
  ExecuteToolsOptions,
  ExecuteToolsResult,
} from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { createMcpToolDisplay } from "../../tool/executor/result-display.js";

export async function scheduleTools(
  this: AgentRuntimeInternal,
  toolCalls: ToolCall[],
): Promise<ToolSchedule> {
  const dependencies: ToolDependency[] = toolCalls.map((tc) => {
    const entry = this.registry.get(tc.name);
    const metadata = entry?.metadata;
    const sideEffectScope = entry?.permission?.sideEffectScope ?? metadata?.sideEffectScope;
    return {
      toolCallId: tc.id as ToolCallId,
      toolName: tc.name,
      dependsOn: [],
      readOnly:
        metadata?.readOnly === undefined
          ? undefined
          : metadata.readOnly && sideEffectScope === "none",
      destructive: metadata?.destructive,
      concurrentSafe: metadata?.concurrentSafe,
      sideEffectScope,
    };
  });

  return this.toolScheduler.schedule(dependencies);
}

export async function executeTools(
  this: AgentRuntimeInternal,
  toolCalls: ToolCall[],
  schedule: ToolSchedule,
  options?: ExecuteToolsOptions,
): Promise<ExecuteToolsResult> {
  const executableCalls: ExecutableToolCall[] = toolCalls.map((tc) => ({
    id: tc.id,
    name: tc.name,
    input: tc.input,
    modelCallWrapper: tc.modelCallWrapper,
  }));
  const traceContext = options?.traceContext ?? getCurrentTraceContext() ?? this.rootTraceContext;
  const events: SessionEvent[] = [];

  this.logger?.debug("executeTools: executing schedule", {
    toolCalls: executableCalls.length,
    parallelGroups: schedule.parallelGroups.length,
  });

  const generator = this.executor.executeSchedule(executableCalls, schedule, {
    pluginDiscoveryUi: options?.pluginDiscoveryUi,
    automationTurn: options?.automationTurn,
    automationId: options?.automationId,
    offPeakTurn: options?.offPeakTurn,
    signal: options?.signal,
    traceContext,
    subagentModelOverride: options?.subagentModelOverride,
    model: options?.model,
    toolSearch: options?.toolSearch,
  });
  let results: ToolExecutionResult[] = [];

  while (true) {
    const next = await generator.next();
    if (next.done) {
      results = next.value;
      break;
    }

    if (next.value.type === "batch_start") {
      await options?.onBatchStart?.(next.value.toolCallIds);
      continue;
    }

    if (next.value.type === "batch_complete") {
      const batchResults = next.value.results;
      const batchCompleteEvent = this.createEvent(
        SessionEventType.ToolBatchComplete,
        {
          toolCallIds: batchResults.map((result) => result.toolCallId as ToolCallId),
          successCount: batchResults.filter((result) => result.success).length,
          errorCount: batchResults.filter((result) => !result.success).length,
        },
        traceContext,
      );
      await this.appendEvent(batchCompleteEvent, traceContext);
      events.push(batchCompleteEvent);
    }
  }

  this.logger?.debug("executeTools: completed", { resultCount: results.length });
  return { results, events };
}

export async function emitToolScheduledEvents(
  this: AgentRuntimeInternal,
  toolCalls: ToolCall[],
  schedule: ToolSchedule,
  assistantMessageId: MessageId,
  traceContext: TraceContext,
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  const toolCallById = new Map(toolCalls.map((toolCall) => [toolCall.id, toolCall]));

  for (const item of schedule.items) {
    const toolCall = toolCallById.get(item.toolCallId as string);
    if (!toolCall) continue;
    if (toolCall.name.trim().length === 0) {
      // 把空名投影成普通字符串再发 scheduled 事件，会与合法同名工具发生身份碰撞。
      // 空名只需要 registry-miss result 完成模型恢复，不建立产品工具生命周期。
      continue;
    }
    const event = this.createEvent(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: item.toolCallId,
        assistantMessageId,
        toolName: toolCall.name,
        input: toolCall.input,
        dependencies: item.dependencies,
        parallelGroupIndex: findParallelGroupIndex(schedule, item.toolCallId),
        canRunParallel: item.canRunParallel,
        // MCP 名称来自 registry discovery，而不是合成的 provider tool name。
        // 在 scheduled 阶段携带，保证 pending/permission/running/stop 全生命周期可展示。
        display: createMcpToolDisplay(this.registry.getMetadata(toolCall.name)?.mcpPresentation),
        schedule: {
          parallelGroups: schedule.parallelGroups,
          executionOrder: schedule.executionOrder,
        },
      },
      traceContext,
    );
    await this.appendEvent(event, traceContext);
    events.push(event);
  }

  return events;
}

export async function emitFileMutationCheckpoint(
  this: AgentRuntimeInternal,
  options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    messageId: MessageId;
    result: ToolExecutionResult;
    toolMessageId?: MessageId;
    traceContext: TraceContext;
  },
): Promise<void> {
  if (!this.artifactStore || !options.result.success) return;

  const candidate = getFileMutationCheckpointCandidate(options.result.output);
  if (!candidate) return;

  try {
    throwIfTurnAborted(options.abortSignal);
    const artifact = await this.artifactStore.writeToolResultArtifact(
      {
        sessionId: this.sessionId,
        turnId: options.traceContext.turnId,
        toolCallId: options.result.toolCallId,
        toolName: options.result.toolName,
        content: stringifyWorkspaceCheckpointArtifact(candidate, options.result),
        contentType: WORKSPACE_CHECKPOINT_CONTENT_TYPE,
        retention: "session",
        trace: options.traceContext,
      },
      { signal: options.abortSignal },
    );
    throwIfTurnAborted(options.abortSignal);

    const event = this.createEvent(
      SessionEventType.CheckpointCreated,
      {
        checkpointId: `checkpoint_${crypto.randomUUID()}`,
        messageId: options.messageId,
        targetMessageId: options.messageId,
        toolMessageId: options.toolMessageId,
        scope: RewindScope.Workspace,
        snapshotRef: artifact.uri,
        diffRef: artifact.uri,
        fileCount: 1,
      },
      options.traceContext,
    );
    await this.appendEvent(event, options.traceContext);
    options.events.push(event);
    recordTurnFileChange(this.currentTurnFileChanges, {
      afterContent: candidate.content,
      beforeContent: candidate.originalFile,
      path: candidate.filePath,
      structuredPatch: candidate.structuredPatch,
      toolName: options.result.toolName,
    });

    this.logger?.debug("Workspace checkpoint created", {
      ...traceContextToLogContext(options.traceContext),
      event: "checkpoint.created",
      fileCount: 1,
      module: "core.runtime",
      status: "completed",
      toolCallId: options.result.toolCallId,
      toolName: options.result.toolName,
    });
  } catch (error) {
    if (isTurnCancellationError(error, options.abortSignal)) {
      throw createTurnCancelledError(error);
    }

    this.logger?.warn("Workspace checkpoint creation failed", {
      ...traceContextToLogContext(options.traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "checkpoint.create.failed",
      filePath: candidate.filePath,
      module: "core.runtime",
      status: "failed",
      toolCallId: options.result.toolCallId,
      toolName: options.result.toolName,
    });
  }
}

export async function emitPermissionRequest(
  this: AgentRuntimeInternal,
  toolCallId: ToolCallId,
  toolName: string,
  riskLevel: string,
): Promise<void> {
  const traceContext = getCurrentTraceContext() ?? this.rootTraceContext;
  const event = this.createEvent(
    SessionEventType.PermissionRequested,
    {
      toolCallId,
      toolName,
      riskLevel: riskLevel as "low" | "medium" | "high" | "critical",
      reason: `Tool ${toolName} requires approval`,
      input: {},
    },
    traceContext,
  );
  await this.appendEvent(event, traceContext);
}

export async function resolvePermission(
  this: AgentRuntimeInternal,
  toolCallId: ToolCallId,
  decision: PermissionDecisionResult,
): Promise<void> {
  const brokerResult: PermissionBrokerResult = {
    decision: decision.allowed ? "allow" : "deny",
    reason: decision.reason,
    modifiedInput: decision.modifiedInput,
    permissionUpdates: decision.permissionUpdates,
    resolvedAt: new Date(),
  };

  if (isResolvablePermissionBroker(this.permissionBroker)) {
    const resolved = this.permissionBroker.resolvePermission(toolCallId, brokerResult);
    if (resolved) return;
  }

  const traceContext = getCurrentTraceContext() ?? this.rootTraceContext;
  const event = this.createEvent(
    SessionEventType.PermissionResolved,
    {
      toolCallId,
      decision: brokerResult.decision,
      reason: brokerResult.reason,
      modifiedInput: brokerResult.modifiedInput,
    },
    traceContext,
  );
  await this.appendEvent(event, traceContext);
}
