import {
  COMPACT_PROMPT_TOO_LONG_USER_MESSAGE,
  CoreErrorType,
  createCoreError,
  formatCompactSummary,
} from "../deps.js";
import type { CompactTimelinePayload, SessionEvent, SessionEventType, TraceContext } from "../deps.js";
import {
  buildProviderRequestMessages,
  createModelContextExceededFinishError,
  isContextExceededFinishReason,
  readRawFinishReason,
} from "../helpers/index.js";
import type { RuntimeModelTextResult, RunModelTextRequestOptions } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";

export const COMPACT_TOOL_USE_DENIAL_MESSAGE = "Tool use is not allowed during compaction";
export const COMPACT_TOOL_USE_DENIAL_REASON =
  "compaction agent should only produce text summary";

export function createCompactPromptTooLongError(options: {
  attempt: number;
  cause?: unknown;
  preCompactTokenCount: number;
}): Error {
  return createCoreError(
    CoreErrorType.ModelContextExceeded,
    COMPACT_PROMPT_TOO_LONG_USER_MESSAGE,
    {
      cause: options.cause instanceof Error ? options.cause : undefined,
      context: {
        compactPromptTooLongAttempts: options.attempt,
        preCompactTokenCount: options.preCompactTokenCount,
      },
      recoverable: true,
      // 修复原因：compact 内部已经完成最多 3 次旧轮次截断重试；
      // 最终仍超窗时不能再被 auto compact 外层重试放大成 3x3。
      retryable: false,
    },
  );
}

export function createCompactContextExceededFinishError(
  result: RuntimeModelTextResult,
): Error | undefined {
  const rawFinishReason = readRawFinishReason(result.providerMetadata);
  if (
    !isContextExceededFinishReason(result.finishReason, rawFinishReason) &&
    !isCompactEmptyLengthFinish(result)
  ) {
    return undefined;
  }

  return createModelContextExceededFinishError({
    finishReason: result.finishReason,
    rawFinishReason,
  });
}

function isCompactEmptyLengthFinish(result: RuntimeModelTextResult): boolean {
  // GLM/Z.AI compact 可能以 length + 空文本完成，真实含义是没有可保存的 summary；
  // 仅在 compact 路径把它归类为超窗压力，复用已有 prompt-too-long 降输入重试。
  return result.finishReason.trim().toLowerCase() === "length" && result.text.trim().length === 0;
}

export async function persistCompactTimelineEvent(
  runtime: AgentRuntimeInternal,
  type: SessionEventType,
  payload: CompactTimelinePayload,
  traceContext: TraceContext,
  events: SessionEvent[],
): Promise<void> {
  await runtime.persistCompactTimeline(payload, traceContext);
  const event = runtime.createEvent(type, payload, traceContext);
  await runtime.appendEvent(event, traceContext);
  events.push(event);
}

export function buildCompactSummaryRequestMessages(
  entriesForSummary: readonly RuntimeMessageEntry[],
  compactPrompt: string,
  options: {
    useMidConversationSystem?: boolean;
    foldRemindersIntoToolResults?: boolean;
    dropReasoningOnlyOrBlankAssistants?: boolean;
    loadedToolCallIds?: ReadonlySet<string>;
  } = {},
): RunModelTextRequestOptions["messages"] {
  return buildProviderRequestMessages({
    entries: [
      ...entriesForSummary,
      { message: { role: "user" as const, content: compactPrompt } },
    ],
    applyCacheControl: true,
    skipCacheWrite: true,
    useMidConversationSystem: options.useMidConversationSystem,
    foldRemindersIntoToolResults: options.foldRemindersIntoToolResults,
    dropReasoningOnlyOrBlankAssistants: options.dropReasoningOnlyOrBlankAssistants,
    loadedToolCallIds: options.loadedToolCallIds,
  }).messages;
}

export function formatCompactSummaryOrThrow(
  runtime: AgentRuntimeInternal,
  result: RuntimeModelTextResult,
): string {
  const compactToolCalls = runtime.extractToolCallsFromResult(result);
  if (compactToolCalls.length > 0) {
    throw createCoreError(CoreErrorType.ModelError, COMPACT_TOOL_USE_DENIAL_MESSAGE, {
      context: {
        behavior: "deny",
        decisionReason: {
          reason: COMPACT_TOOL_USE_DENIAL_REASON,
          type: "other",
        },
        toolNames: compactToolCalls.map((toolCall) => toolCall.name),
      },
      recoverable: true,
      retryable: false,
    });
  }

  const summary = formatCompactSummary(result.text);
  if (!summary) {
    throw createCoreError(CoreErrorType.ModelError, "Failed to generate compact summary", {
      recoverable: true,
      retryable: true,
    });
  }
  return summary;
}
