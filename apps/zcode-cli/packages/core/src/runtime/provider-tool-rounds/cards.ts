// Provider 内置工具的实时卡片与持久化：客户端不执行这类工具，但要像普通工具一样
// 在界面上显示调用和返回结果，并按流里的顺序落盘（冷恢复按 part 顺序切轮回放）。
// 事件序列与 browser-turn-screenshot 的合成工具一致：Scheduled → Started → Result。
import {
  SessionEventType,
  createPartId,
  type MessageId,
  type ModelToolCall,
  type SessionEvent,
  type ToolCallId,
  type TraceContext,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { PROVIDER_EXECUTED_TOOL_PART_METADATA_KEY, type ProviderToolRound } from "./rounds.js";
import { hasAssistantReasoningContent } from "../methods/turn-output-token-continuation.js";
import { persistTextBlockParts } from "../methods/message-persistence.js";

/** 卡片走 MCP 渲染器：服务端本身就是以 MCP 执行这些内置工具。 */
const PROVIDER_TOOL_DISPLAY_SERVER_NAME = "server";

/** 结果到达前流就结束、失败或被取消时写入的结果；语义与本地工具的中断结果一致。 */
export const PROVIDER_TOOL_INTERRUPTED_RESULT =
  "[Server-side tool execution was interrupted before its result arrived]";

interface ProviderToolCardContext {
  assistantMessageId: MessageId;
  events: SessionEvent[];
  traceContext: TraceContext;
}

/**
 * 把还没有结果的轮次按中断收口：卡片补 Result 终态、tool part 落盘（冷恢复据此切轮），
 * 实时回放与冷恢复都得到 tool_use + 错误结果。返回是否有轮次被收口。
 */
export async function settleUnfinishedProviderToolCards(
  runtime: AgentRuntimeInternal,
  context: ProviderToolCardContext,
  rounds: readonly ProviderToolRound[],
  startedAtByCallId: ReadonlyMap<string, number>,
): Promise<boolean> {
  let settled = false;
  for (const round of rounds) {
    if (round.result) continue;
    const result = { output: PROVIDER_TOOL_INTERRUPTED_RESULT, isError: true };
    round.result = result;
    settled = true;
    await finishProviderToolCard(
      runtime,
      context,
      { ...round, result },
      startedAtByCallId.get(round.toolCall.id) ?? Date.now(),
    );
  }
  return settled;
}

export async function persistProviderToolRoundContent(
  runtime: AgentRuntimeInternal,
  context: ProviderToolCardContext,
  round: ProviderToolRound,
  startedAt: number,
): Promise<void> {
  const endedAt = Date.now();
  for (const reasoning of round.reasoning) {
    if (!hasAssistantReasoningContent(reasoning)) continue;
    await runtime.persistPart(
      {
        id: createPartId(),
        sessionID: runtime.sessionId,
        messageID: context.assistantMessageId,
        type: "reasoning",
        text: reasoning.text,
        ...(reasoning.blockIndex !== undefined ? { blockIndex: reasoning.blockIndex } : {}),
        metadata: reasoning.providerOptions,
        time: { start: startedAt, end: endedAt },
      },
      context.traceContext,
    );
  }
  await persistTextBlockParts(
    runtime,
    {
      messageId: context.assistantMessageId,
      textBlocks: round.textBlocks,
      text: round.text,
      time: { start: startedAt, end: endedAt },
    },
    context.traceContext,
  );
}

export async function startProviderToolCard(
  runtime: AgentRuntimeInternal,
  context: ProviderToolCardContext,
  toolCall: ModelToolCall,
  startedAt: number,
): Promise<void> {
  const toolCallId = toolCall.id as ToolCallId;
  const display = providerToolDisplay(toolCall.name);
  await appendEvent(runtime, context, SessionEventType.ToolCallScheduled, {
    toolCallId,
    assistantMessageId: context.assistantMessageId,
    toolName: toolCall.name,
    input: toolCall.input,
    dependencies: [],
    canRunParallel: false,
    display,
    schedule: { parallelGroups: [[toolCallId]], executionOrder: [toolCallId] },
  });
  await appendEvent(runtime, context, SessionEventType.ToolCallStarted, {
    toolCallId,
    toolName: toolCall.name,
    startedAt: new Date(startedAt),
    display,
  });
}

export async function finishProviderToolCard(
  runtime: AgentRuntimeInternal,
  context: ProviderToolCardContext,
  round: ProviderToolRound & { result: NonNullable<ProviderToolRound["result"]> },
  startedAt: number,
): Promise<void> {
  const { toolCall, result } = round;
  const toolCallId = toolCall.id as ToolCallId;
  const endedAt = Date.now();
  const display = providerToolDisplay(toolCall.name);
  const input = toRecord(toolCall.input);
  await runtime.persistPart(
    {
      id: createPartId(),
      sessionID: runtime.sessionId,
      messageID: context.assistantMessageId,
      type: "tool",
      callID: toolCall.id,
      ...(toolCall.blockIndex !== undefined ? { blockIndex: toolCall.blockIndex } : {}),
      tool: toolCall.name,
      metadata: { [PROVIDER_EXECUTED_TOOL_PART_METADATA_KEY]: true },
      state: result.isError
        ? {
            status: "error",
            input,
            error: result.output,
            metadata: { schemaVersion: 1, display },
            time: { start: startedAt, end: endedAt },
          }
        : {
            status: "completed",
            input,
            output: result.output,
            title: toolCall.name,
            metadata: { schemaVersion: 1, display },
            time: { start: startedAt, end: endedAt },
          },
    },
    context.traceContext,
  );
  await appendEvent(runtime, context, SessionEventType.ToolCallResult, {
    toolCallId,
    result: result.isError
      ? {
          success: false,
          content: result.output,
          display,
          error: { type: "provider_tool_error", message: result.output },
        }
      : { success: true, content: result.output, display },
    duration: endedAt - startedAt,
  });
}

function providerToolDisplay(toolName: string) {
  return { kind: "mcp_tool" as const, serverName: PROVIDER_TOOL_DISPLAY_SERVER_NAME, toolName };
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function appendEvent(
  runtime: AgentRuntimeInternal,
  context: ProviderToolCardContext,
  type: SessionEventType,
  payload: unknown,
): Promise<void> {
  const event = runtime.createEvent(type, payload, context.traceContext);
  await runtime.appendEvent(event, context.traceContext);
  context.events.push(event);
}
