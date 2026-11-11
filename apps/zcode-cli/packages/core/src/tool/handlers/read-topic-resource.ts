import { CoreErrorType, createCoreError, type SessionId } from "@zcode/contracts";
import {
  READ_TOPIC_RESOURCE_TOOL_NAME,
  ReadTopicResourceInputJsonSchema,
  ReadTopicResourceInputSchema,
  ReadTopicResourceOutputJsonSchema,
  ReadTopicResourceOutputSchema,
} from "../topic-resource/contract.js";
import { readTopicResourceFromSession } from "../topic-resource/reader.js";
import type { ToolEntry, ToolHandler } from "../types.js";

// 经 Host 从飞书下载一个资源；沿用原 ReadSessionContext(topic, attachment) 的 5 分钟上限，不随拆分缩短。
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_MODEL_BYTES = 4_096;

export const readTopicResourceHandler: ToolHandler = async (input, context) => {
  const parsed = ReadTopicResourceInputSchema.parse(input);
  if (!context.sessionStore) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "SessionStorePort is not configured for ReadTopicResource",
      {
        context: { toolCallId: context.toolCallId, toolName: READ_TOPIC_RESOURCE_TOOL_NAME },
        recoverable: false,
      },
    );
  }
  // 授权只从当前会话的可信输入意图读取，模型不能指定其他会话。
  const messages = await context.sessionStore.messages({
    sessionID: context.sessionId as SessionId,
  });
  return readTopicResourceFromSession(messages, parsed, context);
};

/** 会话工具设计 0.8：只在注入 topicResourcePort 的运行时注册（见 registerBuiltInTools）。 */
export const readTopicResourceToolEntry: ToolEntry = {
  capability: "Materialize an authorized resource from the current task's archived topic",
  metadata: {
    shouldDefer: true,
    name: READ_TOPIC_RESOURCE_TOOL_NAME,
    description:
      "Download a file or image listed in the current task's topic history resource index to a managed local file.",
    modelInstructions: [
      "Use only for a resource listed in the topic history file resource index (A1, A2…). Pass its inputId, messageId and index.",
      "The result gives a managed local file path. Read that file with an appropriate tool.",
      "The tool reads only the current task's admitted topic. Missing host capability or authorization is an error, not permission to fetch another URL.",
    ],
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxOutputBytes: MAX_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: readTopicResourceHandler,
  inputSchema: ReadTopicResourceInputJsonSchema,
  outputSchema: ReadTopicResourceOutputJsonSchema,
  runtimeInputSchema: ReadTopicResourceInputSchema,
  runtimeOutputSchema: ReadTopicResourceOutputSchema,
  permission: {
    permission: "session.topic_resource.read",
    reason: "Download an authorized resource from the current task's topic",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_MODEL_BYTES,
    maxModelBytes: MAX_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_MODEL_BYTES, direction: "head" },
  },
  timeout: {
    defaultMs: DEFAULT_TIMEOUT_MS,
    maxMs: DEFAULT_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "ReadTopicResource was cancelled before the resource was saved",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
