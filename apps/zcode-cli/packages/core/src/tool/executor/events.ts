import {
  SessionEventType,
  createRootTraceContext,
  traceContextToLogContext,
  type PermissionBrokerResult,
  type PermissionOptionsPolicy,
  type PermissionUpdate,
  type ToolResultDisplayPayload,
  type ToolSideEffectScope,
  type ToolExecutionTelemetry,
  type SkillTelemetryMetadata,
  type TraceContext,
  type TurnId,
} from "@zcode/contracts";
import type { PermissionContext } from "../../permission/service.js";
import type { ExecutableToolCall, ToolExecutionResult, ToolResultSerialization } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";
import { summarizeInput } from "./utils.js";

export async function emitToolCallStarted(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  traceContext: TraceContext,
  turnId: TurnId | undefined,
  startTime: number,
  display?: ToolResultDisplayPayload,
  // 解析后的副作用能力（与权限判定同源）：订阅者据此在工具动手前知道「要写了」。
  capability?: { readOnly?: boolean; sideEffectScope?: ToolSideEffectScope },
): Promise<void> {
  await deps.emitEvent({
    id: crypto.randomUUID() as any,
    sessionId: deps.sessionId,
    turnId,
    type: SessionEventType.ToolCallStarted,
    timestamp: new Date(),
    traceId: traceContext.traceId,
    sequenceNumber: 0,
    payload: {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      startedAt: new Date(startTime),
      display,
      ...(capability?.readOnly === undefined ? {} : { readOnly: capability.readOnly }),
      ...(capability?.sideEffectScope === undefined
        ? {}
        : { sideEffectScope: capability.sideEffectScope }),
    },
  });
}

export async function emitToolCallResult(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  traceContext: TraceContext,
  turnId: TurnId | undefined,
  serialization: ToolResultSerialization,
  durationMs: number,
  display: ToolResultDisplayPayload | undefined,
  perf: ToolExecutionTelemetry | undefined,
  skillMetadata: SkillTelemetryMetadata | undefined,
  pluginId?: string,
): Promise<void> {
  await deps.emitEvent({
    id: crypto.randomUUID() as any,
    sessionId: deps.sessionId,
    turnId,
    type: SessionEventType.ToolCallResult,
    timestamp: new Date(),
    traceId: traceContext.traceId,
    sequenceNumber: 0,
    payload: {
      toolCallId: toolCall.id,
      ...(skillMetadata ? { skillMetadata } : {}),
      ...(pluginId ? { pluginId } : {}),
      result: {
        success: true,
        content: serialization.content,
        display,
        perf,
        truncated: serialization.truncated,
        originalBytes: serialization.originalBytes,
        returnedBytes: serialization.returnedBytes,
        budgetStrategy: serialization.budgetStrategy,
        artifactPath: serialization.artifactPath,
      },
      duration: durationMs,
    },
  });
}

export async function emitToolCallError(
  deps: ToolExecutorDeps,
  toolCallId: string,
  traceContext: TraceContext,
  turnId: TurnId | undefined,
  error: ToolExecutionResult["error"],
  skillMetadata?: SkillTelemetryMetadata,
  pluginId?: string,
): Promise<void> {
  await deps.emitEvent({
    id: crypto.randomUUID() as any,
    sessionId: deps.sessionId,
    turnId,
    type: SessionEventType.ToolCallError,
    timestamp: new Date(),
    traceId: traceContext.traceId,
    sequenceNumber: 0,
    payload: {
      toolCallId,
      error,
      ...(skillMetadata ? { skillMetadata } : {}),
      ...(pluginId ? { pluginId } : {}),
    },
  });
}

export async function emitSkippedToolError(
  deps: ToolExecutorDeps,
  result: ToolExecutionResult,
  traceContext?: TraceContext,
): Promise<void> {
  const eventTraceContext =
    traceContext ??
    deps.traceContext ??
    createRootTraceContext({ sessionId: deps.sessionId, turnId: deps.turnId });
  const turnId = eventTraceContext.turnId ?? deps.turnId;

  await emitToolCallError(deps, result.toolCallId, eventTraceContext, turnId, result.error);

  deps.logger?.warn("Tool call skipped after blocking failure", {
    ...traceContextToLogContext(eventTraceContext),
    event: "tool.call.skipped",
    module: "core.tool.executor",
    status: "failed",
    toolCallId: result.toolCallId,
    toolName: result.toolName,
  });
}

export async function emitPermissionRequested(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  input: unknown,
  requestId: string,
  riskLevel: PermissionContext["riskLevel"],
  reason: string | undefined,
  suggestedPermissionUpdates: PermissionUpdate[],
  traceContext: TraceContext,
  approval?: {
    approvalMode?: "user-once";
    display?: ToolResultDisplayPayload;
    optionsPolicy?: PermissionOptionsPolicy;
  },
): Promise<void> {
  await deps.emitEvent({
    id: crypto.randomUUID() as any,
    sessionId: deps.sessionId,
    turnId: traceContext.turnId ?? deps.turnId,
    type: SessionEventType.PermissionRequested,
    timestamp: new Date(),
    traceId: traceContext.traceId,
    sequenceNumber: 0,
    payload: {
      requestId,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      riskLevel,
      reason: reason ?? `Tool ${toolCall.name} requires approval`,
      input,
      suggestedPermissionUpdates,
      ...(approval?.approvalMode ? { approvalMode: approval.approvalMode } : {}),
      ...(approval?.display ? { display: approval.display } : {}),
      ...(approval?.optionsPolicy ? { optionsPolicy: approval.optionsPolicy } : {}),
      ...(deps.sessionModePort?.supportsPermissionFullAccess?.()
        ? { fullAccessSupported: true }
        : {}),
    },
  });
}

export async function emitPermissionResolved(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  requestId: string,
  decision: PermissionBrokerResult,
  traceContext: TraceContext,
): Promise<void> {
  await deps.emitEvent({
    id: crypto.randomUUID() as any,
    sessionId: deps.sessionId,
    turnId: traceContext.turnId ?? deps.turnId,
    type: SessionEventType.PermissionResolved,
    timestamp: new Date(),
    traceId: traceContext.traceId,
    sequenceNumber: 0,
    payload: {
      requestId,
      toolCallId: toolCall.id,
      decision: decision.decision,
      reason: decision.reason,
      modifiedInput: decision.modifiedInput,
    },
  });
}

export async function emitPermissionDenied(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  reason: string | undefined,
  traceContext: TraceContext,
): Promise<void> {
  await deps.emitEvent({
    id: crypto.randomUUID() as any,
    sessionId: deps.sessionId,
    turnId: traceContext.turnId ?? deps.turnId,
    type: SessionEventType.PermissionDenied,
    timestamp: new Date(),
    traceId: traceContext.traceId,
    sequenceNumber: 0,
    payload: {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      reason: reason ?? `Permission denied for ${toolCall.name}`,
      inputSummary: summarizeInput(toolCall.input),
    },
  });
}
