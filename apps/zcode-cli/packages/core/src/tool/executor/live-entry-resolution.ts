import {
  CoreErrorType,
  createCoreError,
  traceContextToLogContext,
  type ToolExecutionSpanWriter,
  type TraceContext,
} from "@zcode/contracts";
import type { ExecutableToolCall, ToolEntry, ToolExecutionResult } from "../types.js";
import { createErrorResult } from "./errors.js";
import { emitToolCallError } from "./events.js";
import type { ToolExecuteOptions, ToolExecutorDeps } from "./types.js";

/** 空名不查表，走 registry-miss 生命周期；查表与报错共用这一个判定。 */
export function isEmptyToolName(toolName: string): boolean {
  return toolName.trim().length === 0;
}

export type LiveEntryResolution =
  | { status: "ready"; entry: ToolEntry }
  | { status: "failed"; error: Error; cancelled: boolean; cause?: unknown };

/**
 * 本 step registry 的 entry；没有时交给 runtime 晚到解析（MCP server 在 step 之后连上，或仍在首次连接）。
 * 等待被取消时给出取消结果；解析出错只记日志，按未注册工具处理，不中断整批调用。
 */
export async function lookupToolEntry(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  options: ToolExecuteOptions | undefined,
  traceContext: TraceContext,
  telemetry: ToolExecutionSpanWriter | undefined,
): Promise<{ entry?: ToolEntry; cancelled?: ToolExecutionResult }> {
  if (isEmptyToolName(toolCall.name)) return {};
  const registered = deps.registry.get(toolCall.name);
  if (registered || !deps.resolveUnregisteredTool) return { entry: registered };
  try {
    const { signal, responseId } = options ?? {};
    return { entry: await deps.resolveUnregisteredTool(toolCall.name, { signal, responseId }) };
  } catch (error) {
    if (!options?.signal?.aborted) {
      deps.logger?.warn("Unregistered tool resolution failed", {
        ...traceContextToLogContext(traceContext),
        event: "tool.call.late_resolution_failed",
        module: "core.tool.executor",
        error: error instanceof Error ? error.message : String(error),
        toolCallId: toolCall.id,
        toolName: toolCall.name,
      });
      return {};
    }
    const result = createErrorResult(
      toolCall,
      createCoreError(CoreErrorType.ToolCancelled, "Tool execution cancelled"),
    );
    const turnId = traceContext.turnId ?? deps.turnId;
    await emitToolCallError(deps, toolCall.id, traceContext, turnId, result.error);
    telemetry?.finishCancelled("abort_signal");
    return { cancelled: result };
  }
}

/**
 * 缓存 advertisement entry 执行前换成 live entry；不可用/异常统一收敛为可重试的工具错误。
 * 调用方负责对返回的 live entry 重新套用本轮模型契约投影。
 */
export async function resolveLiveToolEntry(
  resolveForExecution: NonNullable<ToolEntry["resolveForExecution"]>,
  toolCall: ExecutableToolCall,
  signal: AbortSignal | undefined,
): Promise<LiveEntryResolution> {
  try {
    const resolution = await resolveForExecution({ signal });
    if (resolution.status === "ready") return resolution;
    return {
      status: "failed",
      cancelled: false,
      error: createLiveEntryUnavailableError(toolCall, resolution.message),
    };
  } catch (error) {
    const cancelled = signal?.aborted === true;
    return {
      status: "failed",
      cancelled,
      cause: error,
      error: cancelled
        ? createCoreError(CoreErrorType.ToolCancelled, "Tool execution cancelled")
        : createLiveEntryUnavailableError(toolCall, "Tool is not available", error),
    };
  }
}

function createLiveEntryUnavailableError(
  toolCall: ExecutableToolCall,
  message: string,
  cause?: unknown,
): Error {
  return createCoreError(CoreErrorType.ToolExecutionFailed, message, {
    ...(cause === undefined
      ? {}
      : { cause: cause instanceof Error ? cause : new Error(String(cause)) }),
    context: { toolCallId: toolCall.id, toolName: toolCall.name },
    recoverable: true,
    retryable: true,
  });
}
