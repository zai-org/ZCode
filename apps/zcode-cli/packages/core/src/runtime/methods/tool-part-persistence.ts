import type {
  CompletedToolPartMetadata,
  MessageId,
  Model,
  PartId,
  ToolCall,
  TraceContext,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { requireRuntimeToolCallName } from "../helpers/index.js";

const EMPTY_TOOL_NAME_PLACEHOLDER = "empty_tool_name";
const PROVIDER_TOOL_NAME_METADATA_KEY = "providerToolName";

interface NonEmptyToolNameProjection {
  metadata?: Record<string, unknown>;
  toolName: string;
}

export function projectToolNameForNonEmptyBoundary(toolName: string): NonEmptyToolNameProjection {
  if (toolName.trim().length > 0) {
    return { toolName };
  }
  return {
    metadata: { [PROVIDER_TOOL_NAME_METADATA_KEY]: toolName },
    toolName: EMPTY_TOOL_NAME_PLACEHOLDER,
  };
}

export async function persistPendingToolPart(
  runtime: AgentRuntimeInternal,
  options: {
    assistantMessageId: MessageId;
    input: Record<string, unknown>;
    partID: PartId;
    toolCall: ToolCall;
    traceContext: TraceContext;
    metadata?: CompletedToolPartMetadata;
    model: Model;
  },
): Promise<void> {
  const projected =
    typeof options.toolCall.name === "string" && options.toolCall.name.trim().length === 0
      ? projectToolNameForNonEmptyBoundary(options.toolCall.name)
      : {
          toolName: requireRuntimeToolCallName(options.toolCall, {
            logger: runtime.logger,
            model: options.model,
            source: "persistPendingToolPart",
            traceContext: options.traceContext,
          }),
        };
  await runtime.persistPart(
    {
      id: options.partID,
      sessionID: runtime.sessionId,
      messageID: options.assistantMessageId,
      type: "tool",
      callID: options.toolCall.id,
      // savePart 遇到冲突时整体替换 data，每次写入 tool part 都要带 blockIndex。
      ...(options.toolCall.blockIndex !== undefined
        ? { blockIndex: options.toolCall.blockIndex }
        : {}),
      tool: projected.toolName,
      metadata: {
        ...projected.metadata,
        ...options.metadata,
        ...(options.toolCall.modelCallWrapper
          ? { modelCallWrapper: options.toolCall.modelCallWrapper }
          : {}),
      },
      state: {
        status: "pending",
        input: options.input,
        raw: JSON.stringify({
          tool: projected.toolName,
          input: options.toolCall.input,
        }),
      },
    },
    options.traceContext,
  );
}
