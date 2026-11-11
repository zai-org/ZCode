import {
  CoreErrorType,
  SEND_MESSAGE_TOOL_NAME,
  SendMessageInputJsonSchema,
  SendMessageOutputSchema,
  SendMessageRuntimeInputSchema,
  createCoreError,
  type SendMessageInput,
  type SendMessageOutput,
  type TraceContext,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler, ToolInputValidationResult } from "../types.js";

const MAX_SEND_MESSAGE_MODEL_BYTES = 4096;
const SEND_MESSAGE_INVALID_INPUT_ERROR_CODE = 9;

const SEND_MESSAGE_PROVIDER_DESCRIPTION = [
  "# SendMessage",
  "",
  "Send a message to another agent.",
  "",
  "```json",
  '{"to": "agent_<uuid>", "summary": "assign task 1", "message": "start on task #1"}',
  "```",
  "",
  "Your plain text output is NOT visible to other agents — to communicate, you MUST call this tool. Messages from agents are delivered automatically; you don't check an inbox. Refer to local agents by the `agentId` returned in the Agent spawn result. To resume a completed agent, use its `agentId`; it resumes in the background and you'll be notified when it finishes.",
].join("\n");

const SEND_MESSAGE_TOOL_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
  },
  required: ["success", "message"],
  additionalProperties: false,
};

const sendMessageHandler: ToolHandler = async (input, context) => {
  const parsed = SendMessageRuntimeInputSchema.parse(input) as SendMessageInput;

  if (!context.subagentPort?.sendMessage) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Subagent port is not configured for SendMessage",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: SEND_MESSAGE_TOOL_NAME,
        },
        recoverable: false,
      },
    );
  }

  return context.subagentPort.sendMessage(
    {
      sessionId: context.sessionId,
      turnId: context.turnId,
      parentToolCallId: context.toolCallId,
      to: parsed.to,
      summary: parsed.summary,
      message: parsed.message,
      workingDirectory: context.workingDirectory,
      workspaceRoot: context.workspaceRoot,
      trace: resolveToolTraceContext(context),
    },
    {
      signal: context.abortSignal,
      model: context.model,
      modelOverride: context.subagentModelOverride,
    },
  ) satisfies Promise<SendMessageOutput>;
};

export const sendMessageToolEntry: ToolEntry = {
  capability: "Send a short message to a local agent",
  metadata: {
    shouldDefer: true,
    name: SEND_MESSAGE_TOOL_NAME,
    searchHint: "send messages to agent teammates",
    description: SEND_MESSAGE_PROVIDER_DESCRIPTION,
    // 修复原因（ZCT-2119028473032097792）：曾声明为非只读，Plan 闸门直接拒绝，父会话在 Plan 下
    // 无法唤醒已结束的子代理补发报告；Agent 已是只读。子代理的工具由子会话自己的权限模式判定，
    // 恢复时与新开用同一规则按父会话当前状态重算，所以这里与 Agent 一致声明只读。
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 10000,
    maxOutputBytes: MAX_SEND_MESSAGE_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: sendMessageHandler,
  validateInput: validateSendMessageInput,
  formatModelContent: formatSendMessageModelContent,
  inputSchema: SendMessageInputJsonSchema,
  outputSchema: SEND_MESSAGE_TOOL_OUTPUT_SCHEMA,
  runtimeInputSchema: SendMessageRuntimeInputSchema,
  runtimeOutputSchema: SendMessageOutputSchema,
  permission: {
    permission: "agent.message.send",
    reason: "SendMessage writes a message to a local agent queue",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_SEND_MESSAGE_MODEL_BYTES,
    maxModelBytes: MAX_SEND_MESSAGE_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_SEND_MESSAGE_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 10000,
    maxMs: 10000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "SendMessage was cancelled before delivery status returned",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

/**
 * 修复原因：只有空白的 message 能通过 provider JSON Schema（minLength 1），runtime schema 的拒绝
 * 要到 handler 才生效——Hook、权限都已跑过，模型收到的是原始 ZodError JSON。这里在 Hook 之前
 * 用同一份 runtime schema 判定，按工具输入错误返回。
 */
function validateSendMessageInput(input: unknown): ToolInputValidationResult {
  const parsed = SendMessageRuntimeInputSchema.safeParse(input);
  if (parsed.success) return { result: true };
  return {
    result: false,
    errorCode: SEND_MESSAGE_INVALID_INPUT_ERROR_CODE,
    message: parsed.error.issues.map((issue) => issue.message).join("; "),
  };
}

function formatSendMessageModelContent(output: unknown): string {
  const result = SendMessageOutputSchema.parse(output);
  if (result.message) return result.message;
  if (result.status === "success") {
    if (result.delivery) {
      return `Message ${result.messageId} was ${result.delivery} for local agent ${result.agentId ?? result.taskId ?? "unknown"}.`;
    }
    return `Message ${result.messageId} was queued for local agent ${result.agentId ?? result.taskId ?? "unknown"}.`;
  }
  return `Message ${result.messageId} failed to send to local agent ${result.agentId ?? result.taskId ?? "unknown"}: ${result.error ?? "unknown error"}.`;
}

function resolveToolTraceContext(context: Parameters<ToolHandler>[1]): TraceContext {
  return (
    context.traceContext ?? {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      sessionId: context.sessionId,
      turnId: context.turnId,
    }
  );
}
