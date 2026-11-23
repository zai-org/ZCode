// ============================================================
// Vercel AI SDK protocol transforms
// ============================================================

import { type ModelMessage as AiSdkModelMessage, type ToolResultPart } from "ai";
import {
  ModelErrorCode,
  isBlockIndex,
  modelMessageContentToText,
  type ModelCacheControl,
  type ModelInputMessage,
  type ModelInputFormat,
  type ModelMessageContent,
  type ModelMessageContentBlock,
} from "@zcode/contracts";
import { AiSdkModelAdapterError } from "./errors.js";
import { providerOptionsForReasoningBlock } from "./anthropic-reasoning-metadata.js";
import {
  shouldTextifyStructuredToolResults,
  toStructuredToolResultText,
  undeliverableFrameReferenceText,
  toToolResultMediaUserParts,
  toolResultHasVideoMedia,
} from "./tool-result-media-projection.js";
import { dataUrlToDataContent, unsupportedInputMediaText } from "./media-transform-policy.js";
import { normalizeOpenAiCompatibleSystemMessages } from "./system-message-compat.js";

export interface AiSdkMessageTransformOptions {
  toolSearchEnabled?: boolean;
  apiFormat?: string;
  providerOptions?: Record<string, unknown>;
  providerKind?: "openai" | "anthropic" | "openai-compatible" | "gateway" | "custom";
  stripMedia?: boolean;
  inputFormat?: ModelInputFormat;
}

type AiSdkAssistantMessage = Extract<AiSdkModelMessage, { role: "assistant" }>;
type AiSdkAssistantContent = AiSdkAssistantMessage["content"];
type AiSdkAssistantContentPart = Extract<AiSdkAssistantContent, unknown[]>[number];
type AiSdkToolResultOutput = ToolResultPart["output"];
type AiSdkProviderOptions = NonNullable<
  Extract<AiSdkModelMessage, { role: "system" }>["providerOptions"]
>;

export function toAiSdkMessages(
  messages: ModelInputMessage[],
  options: AiSdkMessageTransformOptions = {},
): AiSdkModelMessage[] {
  const normalizedMessages =
    options.providerKind === "openai-compatible"
      ? normalizeOpenAiCompatibleSystemMessages(messages)
      : messages;
  const isOpenAiResponsesStatelessReplay = isOpenAiResponsesStatelessReplayBoundary(options);

  const transformedMessages: AiSdkModelMessage[] = [];
  let pendingToolMediaParts: Extract<AiSdkUserContent, unknown[]> = [];
  const textifyStructuredToolResults = shouldTextifyStructuredToolResults(options);
  const flushPendingToolMedia = () => {
    if (pendingToolMediaParts.length === 0) return;
    transformedMessages.push({ role: "user", content: pendingToolMediaParts });
    pendingToolMediaParts = [];
  };

  for (const message of normalizedMessages) {
    if (message.role !== "tool") {
      flushPendingToolMedia();
    }

    switch (message.role) {
      case "system":
        transformedMessages.push({
          role: "system",
          content: modelMessageContentToText(message.content),
          ...providerOptionsForCacheControl(message.cacheControl),
        });
        break;

      case "user":
        transformedMessages.push({
          role: "user",
          content: toAiSdkUserContent(message.content, options),
          ...providerOptionsForCacheControl(message.cacheControl),
        });
        break;

      case "assistant": {
        const content = toAiSdkAssistantContent(message.content, message.toolCalls, options);
        transformedMessages.push({
          role: "assistant",
          content: isOpenAiResponsesStatelessReplay
            ? toOpenAiResponsesReplayContent(content, options)
            : content,
          ...providerOptionsForCacheControl(message.cacheControl),
        });
        break;
      }

      case "tool": {
        if (!message.toolCallId || message.toolName === undefined) {
          throw new AiSdkModelAdapterError(
            ModelErrorCode.InvalidModelRequest,
            "Tool model messages require toolCallId and toolName",
            { context: { role: message.role } },
          );
        }
        const toolName = projectToolNameForProvider(message.toolName, options);
        // 含 video 的 tool result 在所有 provider kind 上都强制 textify + 后置投影：
        // AI SDK tool result part 无 video 变体，anthropic 内嵌路径同样会丢失视频内容。
        const messageTextifyToolResult =
          textifyStructuredToolResults || toolResultHasVideoMedia(message.content);

        // 通用 fail-closed：帧引用结果在媒体不可投递时整体错误化（约束：
        // 引用文本不得与"媒体不可用"占位符同现，否则 actionable frame_id 会诱导
        // 模型对未见过画面的坐标产生动作）。
        const frameReferenceFailure = undeliverableFrameReferenceText(message.content, options);

        const toolMediaParts =
          frameReferenceFailure === undefined &&
          messageTextifyToolResult &&
          message.isError !== true
            ? toToolResultMediaUserParts(message.content, {
                ...options,
                toolName,
              })
            : [];
        transformedMessages.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: message.toolCallId,
              toolName,
              // SDK 合并连续 tool message 时只保留首条的 providerOptions；
              // 缓存标记必须跟随具体结果块，避免批次末尾标记丢失或被移到其他结果。
              ...providerOptionsForCacheControl(message.cacheControl),
              output: frameReferenceFailure
                ? { type: "error-text", value: frameReferenceFailure }
                : toAiSdkToolResultOutput(
                    message.content,
                    options,
                    message.isError === true,
                    messageTextifyToolResult,
                  ),
            },
          ],
        });
        pendingToolMediaParts.push(...toolMediaParts);
        break;
      }
    }
  }

  flushPendingToolMedia();
  return transformedMessages;
}

type AiSdkUserContent = Extract<AiSdkModelMessage, { role: "user" }>["content"];

function toAiSdkToolResultOutput(
  content: ModelMessageContent,
  options: AiSdkMessageTransformOptions,
  isError = false,
  textifyStructuredContent = false,
): AiSdkToolResultOutput {
  if (isError) {
    return { type: "error-text", value: modelMessageContentToText(content) };
  }

  if (typeof content === "string") return { type: "text", value: content };

  const hasToolReferences = content.some((block) => block.type === "tool_reference");
  if (textifyStructuredContent && !hasToolReferences) {
    return { type: "text", value: toStructuredToolResultText(content, options) };
  }

  if (options.stripMedia && !hasToolReferences) {
    return { type: "text", value: modelMessageContentToText(content) };
  }

  // 工具引用不是媒体：媒体降级不能把引用变成名字文本，否则服务端无法展开定义。
  const value = content.flatMap((block) => {
    if (block.type !== "tool_reference" && (textifyStructuredContent || options.stripMedia)) {
      const text = textifyStructuredContent
        ? toStructuredToolResultText([block], options)
        : modelMessageContentToText([block]);
      return text ? [{ type: "text" as const, text }] : [];
    }
    return contentBlockToAiSdkToolResultParts(block, options);
  });
  return value.length > 0
    ? { type: "content", value }
    : { type: "text", value: modelMessageContentToText(content) };
}

function contentBlockToAiSdkToolResultParts(
  block: ModelMessageContentBlock,
  options: AiSdkMessageTransformOptions,
): Extract<AiSdkToolResultOutput, { type: "content" }>["value"] {
  switch (block.type) {
    case "text":
      return block.text.length > 0 ? [{ type: "text", text: block.text }] : [];

    case "tool_reference":
      if (options.providerKind !== "anthropic" || !options.toolSearchEnabled) {
        throw new AiSdkModelAdapterError(
          ModelErrorCode.InvalidModelRequest,
          "Tool references require active Anthropic ToolSearch",
        );
      }
      return [
        {
          type: "custom",
          providerOptions: { anthropic: { type: "tool-reference", toolName: block.toolName } },
        },
      ];

    case "reasoning":
      return [];

    case "image": {
      const unsupportedText = unsupportedInputMediaText(block, options.inputFormat);
      if (unsupportedText) {
        return [
          {
            type: "text",
            text: unsupportedText,
          },
        ];
      }
      const data = dataUrlToDataContent(block.dataUrl);
      if (!data) {
        return [
          { type: "text", text: "ERROR: Image file is empty or corrupted. Inform the user." },
        ];
      }
      return [{ type: "image-data", data: data.data, mediaType: block.mediaType }];
    }

    case "video": {
      const unsupportedText = unsupportedInputMediaText(block, options.inputFormat);
      if (unsupportedText) {
        return [
          {
            type: "text",
            text: unsupportedText,
          },
        ];
      }
      // AI SDK tool result part 无 video 变体：视频媒体统一由 tool-result-media-projection
      // 拆成后置 user part（toolResultHasVideoMedia 对含 video 的 tool result 在所有
      // provider kind 上强制 textify），这里不产出内嵌 part。
      return [];
    }

    case "file": {
      if (block.text !== undefined && block.text.length > 0) {
        return [{ type: "text", text: block.text }];
      }
      const unsupportedText = unsupportedInputMediaText(block, options.inputFormat);
      if (unsupportedText) {
        return [
          {
            type: "text",
            text: unsupportedText,
          },
        ];
      }
      const data = block.dataUrl ? dataUrlToDataContent(block.dataUrl) : undefined;
      if (data) {
        return [
          {
            type: "file-data",
            data: data.data,
            mediaType: block.mediaType,
            ...(block.name ? { filename: block.name } : {}),
          },
        ];
      }
      return [{ type: "text", text: modelMessageContentToText([block]) }];
    }

    case "resource_link":
      return [{ type: "text", text: modelMessageContentToText([block]) }];
  }
}

function toAiSdkAssistantContent(
  content: ModelMessageContent,
  toolCalls: ModelInputMessage["toolCalls"],
  options: AiSdkMessageTransformOptions,
): AiSdkAssistantContent {
  if (typeof content === "string" && !toolCalls?.length) {
    return content;
  }
  const toToolCallPart = (toolCall: ModelInputToolCall): AiSdkAssistantContentPart => ({
    type: "tool-call",
    toolCallId: toolCall.id,
    toolName: projectToolNameForProvider(toolCall.name, options),
    input: toolCall.input,
  });

  const ordered =
    typeof content === "string" ? undefined : orderedAssistantItems(content, toolCalls);
  if (ordered) {
    // 有序条目（docs/design/v2/model/assistant-block-order.md）：按 orderedAssistantItems 的顺序
    // 输出内容块与工具调用。只改变顺序，不合并块；blockIndex 不进入请求。
    return ordered.flatMap((item) =>
      item.kind === "content"
        ? contentBlockToAiSdkAssistantParts(item.block, options)
        : [toToolCallPart(item.call)],
    );
  }

  const toolCallParts = toolCalls?.map(toToolCallPart) ?? [];
  const contentParts =
    typeof content === "string"
      ? content.length > 0
        ? [{ type: "text" as const, text: content }]
        : []
      : content.flatMap((block) => contentBlockToAiSdkAssistantParts(block, options));

  return [...contentParts, ...toolCallParts];
}

type ModelInputToolCall = NonNullable<ModelInputMessage["toolCalls"]>[number];

/** 有序条目里的一个块：内容块或工具调用，带它的 blockIndex。 */
export type OrderedAssistantItem =
  | { kind: "content"; block: ModelMessageContentBlock; blockIndex: number }
  | { kind: "tool"; call: ModelInputToolCall; blockIndex: number };

/**
 * 有序条目（docs/design/v2/model/assistant-block-order.md）：内容块与工具调用的 blockIndex 都合法时，
 * 返回按 blockIndex 稳定排序的块，序号相同时内容块在前；否则返回 undefined。
 * 请求排列和 Anthropic 规则（reasoning-history-normalization.ts）都用它，两边的判定和顺序因此一致。
 */
export function orderedAssistantItems(
  content: readonly ModelMessageContentBlock[],
  toolCalls: ModelInputMessage["toolCalls"],
): OrderedAssistantItem[] | undefined {
  const items: OrderedAssistantItem[] = [];
  for (const block of content) {
    const blockIndex = "blockIndex" in block ? block.blockIndex : undefined;
    if (!isBlockIndex(blockIndex)) return undefined;
    items.push({ kind: "content", block, blockIndex });
  }
  for (const call of toolCalls ?? []) {
    if (!isBlockIndex(call.blockIndex)) return undefined;
    items.push({ kind: "tool", call, blockIndex: call.blockIndex });
  }
  return items.sort((left, right) => left.blockIndex - right.blockIndex);
}

function contentBlockToAiSdkAssistantParts(
  block: ModelMessageContentBlock,
  options: AiSdkMessageTransformOptions,
): AiSdkAssistantContentPart[] {
  switch (block.type) {
    case "tool_reference":
      throw new AiSdkModelAdapterError(
        ModelErrorCode.InvalidModelRequest,
        "Tool references must appear inside tool results",
      );
    case "text":
      return block.text.length > 0 ? [{ type: "text", text: block.text }] : [];

    case "reasoning": {
      // 没有正文和 provider 元数据的流式 reasoning 空壳会在历史回放时被
      // Anthropic metadata 补全误认为有效 thinking；只在请求投影边界移除精确空壳。
      if (block.text.length === 0 && Object.keys(block.providerOptions ?? {}).length === 0) {
        return [];
      }
      const providerOptions = providerOptionsForReasoningBlock(block, options);

      return [
        {
          type: "reasoning",
          text: block.text,
          ...providerOptions,
        } as AiSdkAssistantContentPart,
      ];
    }

    case "image":
    case "video":
    case "file":
    case "resource_link": {
      const text = modelMessageContentToText([block]);
      return text.length > 0 ? [{ type: "text", text }] : [];
    }
  }
}

function isOpenAiResponsesStatelessReplayBoundary(options: AiSdkMessageTransformOptions): boolean {
  if (options.providerKind !== "openai") return false;
  if (resolveApiFormat(options) !== "openai-responses") return false;
  const openaiOptions = objectRecord(options.providerOptions?.openai);
  if (typeof openaiOptions.previousResponseId === "string") return false;
  if (typeof openaiOptions.conversation === "string") return false;
  return true;
}

/**
 * Responses 无状态回放的 reasoning 规则，在已排好请求顺序的 parts 上一次做完。
 * 1. 按 itemId 保留：同一个 reasoning item 可拆成多段摘要，流式时只有最后一段带密文；本条 assistant
 *    里任一段有非空密文，这个 item 的所有段都保留，SDK 会把它们合并成一个 reasoning。没有密文的
 *    item 删掉：SDK 也会删 null 密文，但每个请求都产生一条 warn 级 SDK warning（旧历史、不返回密文的
 *    端点会让它和消息流同量）；空串密文 SDK 不删，会原样发出。
 *    store 与 SDK 读同一个 providerOptions.openai.store：不是 false 时 SDK 会把带 itemId 的 reasoning
 *    发成 item_reference，部分兼容端点无 previousResponseId 时会 5xx，所以全部删掉。
 * 2. 修复原因：只有 reasoning 的 partial（输出 token 在推理阶段用完后续写保留的回复）或推理完成后
 *    停止的回复，会让 reasoning 后面没有输出项；Responses 会以 "provided without its required
 *    following item" 返回 400，且不是密文被拒，修复重试不处理，会话之后每个请求都失败。这些推理
 *    没有依赖它的输出，删掉末尾的 reasoning；规则确定，前缀稳定。
 */
function toOpenAiResponsesReplayContent(
  content: AiSdkAssistantContent,
  options: AiSdkMessageTransformOptions,
): AiSdkAssistantContent {
  if (typeof content === "string") return content;
  const replayableItemIds = new Set<string>();
  if (objectRecord(options.providerOptions?.openai).store === false) {
    for (const part of content) {
      if (part.type !== "reasoning" || !hasOpenAiEncryptedReasoning(part)) continue;
      const itemId = openAiReasoningItemId(part.providerOptions);
      if (itemId !== undefined) replayableItemIds.add(itemId);
    }
  }
  const kept = content.filter((part) => {
    if (part.type !== "reasoning") return true;
    const itemId = openAiReasoningItemId(part.providerOptions);
    return itemId === undefined || replayableItemIds.has(itemId);
  });
  let end = kept.length;
  while (end > 0 && kept[end - 1]?.type === "reasoning") end -= 1;
  return kept.slice(0, end);
}

/**
 * 这一块带有可回放的 OpenAI 加密推理。空串不算：SDK 只删 null 密文，空串会原样发出并被上游拒绝。
 * 回放过滤、跨模型删除和密文被拒的修复共用这一个判断；历史块和请求 part 都用它。
 */
export function hasOpenAiEncryptedReasoning(block: { providerOptions?: unknown }): boolean {
  const encrypted = objectRecord(
    objectRecord(block.providerOptions).openai,
  ).reasoningEncryptedContent;
  return typeof encrypted === "string" && encrypted.length > 0;
}

function resolveApiFormat(options: AiSdkMessageTransformOptions): string | undefined {
  if (typeof options.apiFormat === "string") return options.apiFormat;
  const apiFormat = options.providerOptions?.apiFormat;
  return typeof apiFormat === "string" ? apiFormat : undefined;
}

function projectToolNameForProvider(
  toolName: unknown,
  options: AiSdkMessageTransformOptions,
): string {
  if (typeof toolName !== "string") {
    throw new AiSdkModelAdapterError(
      ModelErrorCode.InvalidModelRequest,
      "Tool model messages require toolCallId and toolName",
    );
  }
  if (toolName.trim().length > 0) return toolName;

  const apiFormat = resolveApiFormat(options);
  if (apiFormat !== undefined) {
    return apiFormat === "anthropic-messages" ? toolName : "empty_tool_name";
  }

  // OpenAI-compatible wire 不可靠接受空 function name，但历史中的原始
  // 名称仍需保留给 Anthropic 回放；占位值只在 provider 投影边界生成。
  return options.providerKind === "anthropic" ? toolName : "empty_tool_name";
}

function openAiReasoningItemId(providerOptions: unknown): string | undefined {
  const openaiOptions = objectRecord(objectRecord(providerOptions).openai);
  return typeof openaiOptions.itemId === "string" && openaiOptions.itemId.length > 0
    ? openaiOptions.itemId
    : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const EMPTY_USER_CONTENT_FALLBACK = "(no content)";

function toAiSdkUserContent(
  content: ModelMessageContent,
  options: AiSdkMessageTransformOptions,
): AiSdkUserContent {
  // 附件-only query 拆出 prompt attachment 后可能留下空 user
  // content，空白占位又可能被 provider trim 后视为缺失 prompt。只在 wire
  // 序列化边界使用固定 fallback，避免改写 session 事实、UI 可见 query 和标题种子。
  if (typeof content === "string") return content || EMPTY_USER_CONTENT_FALLBACK;

  const parts = content.flatMap((block) => contentBlockToAiSdkUserParts(block, options));
  return parts.length > 0 ? parts : EMPTY_USER_CONTENT_FALLBACK;
}

function contentBlockToAiSdkUserParts(
  block: ModelMessageContentBlock,
  options: AiSdkMessageTransformOptions,
): Extract<AiSdkUserContent, unknown[]> {
  switch (block.type) {
    case "tool_reference":
      throw new AiSdkModelAdapterError(
        ModelErrorCode.InvalidModelRequest,
        "Tool references must appear inside tool results",
      );
    case "text":
      return block.text.length > 0 ? [{ type: "text", text: block.text }] : [];

    case "reasoning":
      return block.text.length > 0 ? [{ type: "text", text: block.text }] : [];

    case "image": {
      if (options.stripMedia) {
        return [{ type: "text", text: modelMessageContentToText([block]) }];
      }
      const unsupportedText = unsupportedInputMediaText(block, options.inputFormat);
      if (unsupportedText) {
        return [
          {
            type: "text",
            text: unsupportedText,
          },
        ];
      }
      const data = dataUrlToDataContent(block.dataUrl);
      if (!data) {
        return [
          {
            type: "text",
            text: "ERROR: Image file is empty or corrupted. Inform the user.",
          },
        ];
      }
      return [{ type: "image", image: data.data, mediaType: block.mediaType }];
    }

    case "video": {
      if (options.stripMedia) {
        return [{ type: "text", text: modelMessageContentToText([block]) }];
      }
      const unsupportedText = unsupportedInputMediaText(block, options.inputFormat);
      if (unsupportedText) {
        return [
          {
            type: "text",
            text: unsupportedText,
          },
        ];
      }
      const data = dataUrlToDataContent(block.dataUrl);
      if (!data) {
        return [
          {
            type: "text",
            text: "ERROR: Video file is empty or corrupted. Inform the user.",
          },
        ];
      }
      // AI SDK 无 video part 类型；mediaType 为自由 string，video/* file part 由
      // patch 后的 @ai-sdk/openai-compatible / @ai-sdk/anthropic 转成 video_url / video block。
      return [{ type: "file", data: data.data, mediaType: block.mediaType }];
    }

    case "file": {
      if (block.text !== undefined && block.text.length > 0) {
        return [{ type: "text", text: block.text }];
      }
      if (options.stripMedia) {
        return [{ type: "text", text: modelMessageContentToText([block]) }];
      }
      const unsupportedText = unsupportedInputMediaText(block, options.inputFormat);
      if (unsupportedText) {
        return [
          {
            type: "text",
            text: unsupportedText,
          },
        ];
      }
      const data = block.dataUrl ? dataUrlToDataContent(block.dataUrl) : undefined;
      if (data) {
        return [
          {
            type: "file",
            data: data.data,
            filename: block.name,
            mediaType: block.mediaType,
          },
        ];
      }
      return [{ type: "text", text: modelMessageContentToText([block]) }];
    }

    case "resource_link":
      return [{ type: "text", text: modelMessageContentToText([block]) }];
  }
}

function providerOptionsForCacheControl(
  cacheControl: ModelCacheControl | undefined,
): { providerOptions: AiSdkProviderOptions } | Record<string, never> {
  if (!cacheControl) {
    return {};
  }

  return {
    providerOptions: {
      anthropic: {
        cacheControl: { ...cacheControl },
      },
    },
  };
}
