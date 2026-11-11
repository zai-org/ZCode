import { z } from "zod";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import type { MessageWithParts } from "@zcode/contracts";
import type { ToolExecutionContext } from "../types.js";
import {
  READ_TOPIC_RESOURCE_TOOL_NAME,
  type ReadTopicResourceInput,
  type ReadTopicResourceOutput,
} from "./contract.js";

const identitySchema = z.object({
  sourceCommandId: z.string().min(1),
  botGroupSource: z.object({
    botId: z.string().min(1),
    chatId: z.string().min(1),
    threadId: z.string().min(1),
    authorizationId: z.string().min(1),
    topicHistory: z
      .object({
        resourceMessages: z.array(
          z.object({ messageId: z.string(), count: z.number().int().positive() }),
        ),
      })
      .optional(),
    topicContext: z
      .object({
        messages: z.array(
          z.object({ id: z.string(), attachments: z.array(z.unknown()).optional() }),
        ),
      })
      .optional(),
  }),
});
const dataUrlPattern = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/;
const extensionPattern = /\.([a-zA-Z0-9]{1,12})$/;

/** 只读当前会话：授权来自最近一条带 botGroupSource 的可信用户输入，不接受模型自报的会话。 */
export async function readTopicResourceFromSession(
  messages: MessageWithParts[],
  input: ReadTopicResourceInput,
  context: ToolExecutionContext,
): Promise<ReadTopicResourceOutput> {
  context.abortSignal.throwIfAborted();
  // canonical 来源存在时不得回退 legacy 字段，否则旧授权可覆盖新的可信输入事实。
  const candidates = messages.filter(({ info }) => info.role === "user" && !info.synthetic);
  let identity: z.infer<typeof identitySchema> | undefined;
  for (const { info } of candidates.toReversed()) {
    const metadata = info.metadata;
    const intent =
      metadata && Object.hasOwn(metadata, "conversationInputIntent")
        ? metadata.conversationInputIntent
        : metadata?.inputIntent;
    if (intent === undefined) continue;
    const parsed = identitySchema.safeParse(intent);
    if (parsed.success) {
      if (input.inputId && parsed.data.sourceCommandId !== input.inputId) continue;
      identity = parsed.data;
      break;
    }
    if (intent && typeof intent === "object" && Reflect.has(intent, "botGroupSource")) break;
    if (metadata && Object.hasOwn(metadata, "conversationInputIntent") && metadata.inputIntent)
      break;
  }
  if (!identity) throw new Error("No admitted topic authorization is available for this input");
  const index = input.index ?? 0;
  if (input.inputId) {
    // A1 只属于所选快照，不允许把另一轮的消息或资源序号拼到当前文件索引上。
    const source = identity.botGroupSource;
    const indexed = source.topicHistory
      ? source.topicHistory.resourceMessages.some(
          (record) => record.messageId === input.messageId && index < record.count,
        )
      : !!source.topicContext?.messages.find((record) => record.id === input.messageId)
          ?.attachments?.[index];
    if (!indexed) throw new Error("Resource is not indexed in the selected history snapshot");
  }
  const port = context.topicResourcePort;
  const store = context.artifactStore;
  if (!port || !store?.writeToolResultBinaryArtifact)
    throw new Error("Topic attachment retrieval is unavailable on this runtime");
  const options = { signal: context.abortSignal, trace: context.traceContext };
  const attachment = await port.read(
    {
      taskId: context.sessionId,
      inputId: identity.sourceCommandId,
      authorizationId: identity.botGroupSource.authorizationId,
      messageId: input.messageId,
      resourceIndex: index,
    },
    options,
  );
  context.abortSignal.throwIfAborted();
  if (
    !Number.isSafeInteger(attachment.bytes) ||
    attachment.bytes < 0 ||
    attachment.bytes > PROTOCOL_V4_LIMITS.attachmentMaxBytes
  )
    throw new Error("Invalid topic attachment size");
  const artifact = await store.readToolResultArtifact(
    { uri: attachment.ref, trace: options.trace },
    options,
  );
  const encoded = dataUrlPattern.exec(artifact.content);
  if (
    !encoded ||
    encoded[1] !== attachment.mime ||
    encoded[2]!.length > Math.ceil(PROTOCOL_V4_LIMITS.attachmentMaxBytes / 3) * 4
  )
    throw new Error("Invalid topic attachment artifact");
  const bytes = Buffer.from(encoded[2]!, "base64");
  if (bytes.length !== attachment.bytes || bytes.toString("base64") !== encoded[2])
    throw new Error("Topic attachment size or encoding mismatch");
  context.abortSignal.throwIfAborted();
  const result = await store.writeToolResultBinaryArtifact(
    {
      sessionId: context.sessionId,
      toolCallId: context.toolCallId,
      toolName: READ_TOPIC_RESOURCE_TOOL_NAME,
      content: bytes,
      contentType: attachment.mime,
      retention: "session",
      trace: options.trace,
      extension: extensionPattern.exec(attachment.fileName)?.[1]?.toLowerCase() ?? "bin",
    },
    options,
  );
  context.abortSignal.throwIfAborted();
  if (!result.path) throw new Error("Topic attachment could not be materialized");
  return {
    status: "success",
    path: result.path,
    fileName: attachment.fileName,
    mime: attachment.mime,
    bytes: attachment.bytes,
    messageId: input.messageId,
    index,
  };
}
