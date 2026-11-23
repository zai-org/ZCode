import {
  COMPACT_PROMPT_TOO_LONG_USER_MESSAGE,
  CoreErrorType,
  createCoreError,
  formatCompactSummary,
  hasCompactSummaryBlock,
  selectCompactSummaryText,
  traceContextToLogContext,
} from "../deps.js";
import type {
  CompactTimelinePayload,
  CompactTrigger,
  SessionEvent,
  SessionEventType,
  TraceContext,
} from "../deps.js";
import {
  createModelContextExceededFinishError,
  isContextExceededFinishReason,
  readRawFinishReason,
} from "../helpers/index.js";
import type { RuntimeModelTextResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { isOutputTokenLimitFinishReason } from "./turn-output-token-continuation.js";

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

/**
 * 摘要成功但以输出上限结束时记 warn，摘要仍按原逻辑落库。
 * 修复原因：有正文的 length 曾被当作普通成功，未闭合的 <summary> 原样落库且没有任何日志，
 * 线上只能靠抓包发现。判定与 Output-limit Continue 相同（normalized length 或 raw max_tokens 等）。
 */
export function warnCompactSummaryOutputLimit(
  runtime: AgentRuntimeInternal,
  result: RuntimeModelTextResult,
  context: { maxOutputTokens: number; traceContext: TraceContext; trigger: CompactTrigger },
): void {
  const rawFinishReason = readRawFinishReason(result.providerMetadata);
  if (!isOutputTokenLimitFinishReason(result.finishReason, rawFinishReason)) return;

  runtime.logger?.warn("Compact summary hit the output limit; the summary may be truncated", {
    ...traceContextToLogContext(context.traceContext),
    event: "compact.summary.output_limit",
    finishReason: result.finishReason,
    module: "core.runtime",
    // 日志脱敏按键名匹配 token；这些数量不是凭据，用不含 token 的键名，线上才能判断预算是否够用。
    outputBudget: {
      limit: context.maxOutputTokens,
      output: result.usage.outputTokens,
      reasoning: result.usage.reasoningTokens,
    },
    rawFinishReason,
    textLength: result.text.length,
    trigger: context.trigger,
  });
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

/**
 * 摘要回复的工具调用不执行，按选出的文本块生成摘要；没有可用文本时失败（可重试）。
 * 修复原因：原来回复里只要有工具调用就整次失败；手动压缩报错，reactive 重新出现超窗错误，
 * 回复里已有的摘要文本也被丢掉。规则见 docs/design/v2/compact/README.md「摘要文本的选取」。
 */
export function formatCompactSummaryOrThrow(
  runtime: AgentRuntimeInternal,
  result: RuntimeModelTextResult,
  traceContext?: TraceContext,
): string {
  const compactToolCalls = runtime.extractToolCallsFromResult(result);
  if (compactToolCalls.length > 0) {
    runtime.logger?.info("Compact summary reply called tools; ignoring them", {
      ...(traceContext ? traceContextToLogContext(traceContext) : {}),
      event: "compact.summary.tool_calls_ignored",
      module: "core.runtime",
      toolNames: compactToolCalls.map((toolCall) => toolCall.name),
    });
  }

  const text = selectCompactSummaryText(result);
  // 带工具调用时，选出的块里没有摘要就不用它（例如调用工具前的开场白），按没有摘要失败。
  const usable = compactToolCalls.length === 0 || hasCompactSummaryBlock(text);
  const summary = usable ? formatCompactSummary(text) : "";
  if (!summary) {
    throw createCoreError(CoreErrorType.ModelError, "Failed to generate compact summary", {
      recoverable: true,
      retryable: true,
    });
  }
  return summary;
}
