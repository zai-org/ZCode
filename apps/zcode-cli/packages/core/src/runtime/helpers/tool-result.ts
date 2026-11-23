import type { ModelCallWrapper } from "@zcode/contracts";
import { modelMessageContentToText } from "../deps.js";
import { isToolOutputError } from "../../tool/executor/errors.js";
import {
  createRuntimeToolResultEntry,
  systemReminderAttachmentEntry,
  type RuntimeAttachmentEntry,
  type RuntimeMessageMessageEntry,
} from "../../agent/message-history.js";
import type {
  ModelMessageContent,
  ToolCallId,
  ToolRegistry,
  ToolSchedule,
  ToolExecutionResult,
} from "../deps.js";

export function emptyTokenUsageInfo(): ReturnType<typeof toTokenUsageInfo> {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: {
      read: 0,
      write: 0,
    },
  };
}

export function toTokenUsageInfo(usage?: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): {
  total?: number;
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
} {
  return {
    total: usage?.totalTokens,
    input: usage?.inputTokens ?? 0,
    output: usage?.outputTokens ?? 0,
    reasoning: usage?.reasoningTokens ?? 0,
    cache: {
      read: usage?.cacheReadTokens ?? 0,
      write: usage?.cacheWriteTokens ?? 0,
    },
  };
}

export function toRecordInput(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return { value: input };
}

export function stringifyToolResultOutput(result: ToolExecutionResult): string {
  if (result.modelContent !== undefined) {
    return typeof result.modelContent === "string"
      ? result.modelContent
      : modelMessageContentToText(result.modelContent);
  }
  if (!result.success && result.error?.message) return result.error.message;
  if (typeof result.output === "string") return result.output;
  if (result.output === undefined) return "";
  return JSON.stringify(result.output) ?? "";
}

export function modelContentForToolResult(result: ToolExecutionResult): ModelMessageContent {
  if (result.modelContent !== undefined) return result.modelContent;
  return stringifyToolResultOutput(result);
}

export function isErrorForToolResult(result: ToolExecutionResult): boolean {
  return !result.success || isToolOutputError(result.toolName, result.output);
}

/**
 * 一批工具结果交给模型的 entries：每个结果一条 tool result，之后是这批的附件。
 * 附件先按结果顺序放工具 Hook 上下文，再放工具声明的批次提示（例如 Read 部分视图提示）。
 * Main 结算与 Memory Agent 循环共用这一个函数（00-tool-change-chain.md）。
 */
export function toolBatchModelEntries(
  results: readonly ToolExecutionResult[],
  options: {
    registry: Pick<ToolRegistry, "get">;
    modelCallWrapperOf?: (toolCallId: string) => ModelCallWrapper | undefined;
  },
): { toolResults: RuntimeMessageMessageEntry[]; attachments: RuntimeAttachmentEntry[] } {
  const toolResults = results.map((result) =>
    createRuntimeToolResultEntry(
      result.toolCallId,
      result.toolName,
      modelContentForToolResult(result),
      isErrorForToolResult(result),
      options.modelCallWrapperOf?.(result.toolCallId),
    ),
  );
  const hookContexts = results.flatMap((result) =>
    (result.hookAdditionalContexts ?? []).map((content) =>
      systemReminderAttachmentEntry("tool_hook_context", content),
    ),
  );
  const batchNotices = results.flatMap((result) => {
    const notice = result.success
      ? options.registry.get(result.toolName)?.formatBatchNotice?.(result.output)
      : undefined;
    return notice ? [systemReminderAttachmentEntry(notice.source, notice.content)] : [];
  });
  return { toolResults, attachments: [...hookContexts, ...batchNotices] };
}

export function stringifyForEstimation(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

export function parseMcpToolName(
  name: string,
): { serverName: string; toolName: string } | undefined {
  if (!name.startsWith("mcp__")) {
    return undefined;
  }
  const [, serverName, ...toolParts] = name.split("__");
  if (!serverName || toolParts.length === 0) {
    return undefined;
  }
  return {
    serverName,
    toolName: toolParts.join("__"),
  };
}

export function findParallelGroupIndex(schedule: ToolSchedule, toolCallId: ToolCallId): number {
  return schedule.parallelGroups.findIndex((group) => group.includes(toolCallId));
}
