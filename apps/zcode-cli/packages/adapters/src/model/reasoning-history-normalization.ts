import type {
  ModelInputMessage,
  ModelMessageContentBlock,
  ModelReasoningContentBlock,
  ModelId,
  ModelProviderId,
} from "@zcode/contracts";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { getStatusCode, unwrapRetryError } from "./failure-inspection.js";
import { orderedAssistantItems, type OrderedAssistantItem } from "./transform.js";

const EMPTY_ASSISTANT_CONTENT_FALLBACK = "(no content)";
const REJECTED_REASONING_FALLBACK = "[Thinking removed]";
// 签名拒绝重试日志里 provider 报错原文的最大字符数：留下定位原因所需的内容，不把整段响应体写进日志。
const REJECTION_PROVIDER_MESSAGE_MAX_CHARS = 2000;
// provider 在 thinking 前缀不一致时返回的响应头，写明出错块的位置；只用于日志诊断。
const THINKING_PREFIX_MISMATCH_HEADER = "anthropic-thinking-prefix-mismatch";

// 旧历史保留 builtin 身份，当前选型已迁到 account 身份；Individual/Team
// 也会使用不同 ID。只在 reasoning 回放时识别同服务的这些明确身份，不改变选型或鉴权。
// 不能复用套餐展示分组：Start/Off-Peak/API 接入不在这份签名兼容范围内。
const REASONING_PROVIDER_GROUPS: readonly (readonly string[])[] = [
  [
    "builtin:zai-coding-plan",
    BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan,
  ],
  [
    "builtin:bigmodel-coding-plan",
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
  ],
];

// 这里只过滤、移动或补齐消息里的块，不删除、不合并消息。没有可见内容（只有思考和空白文字）的回复由 core
// 投影的第一步删除（requestCapabilities.dropReasoningOnlyOrBlankAssistants）。
// 修复原因：这里原来也删除这类回复，晚于 core 的 MCS 落点；被删回复前面的 system 直接接上 user，
// provider 返回 400（role 'system' must precede an 'assistant' message）。
export function normalizeReasoningHistory(
  messages: ModelInputMessage[],
  targetModel?: { modelId: ModelId; providerId: ModelProviderId },
): ModelInputMessage[] {
  const compatibleHistory = removeCrossModelReasoning(messages, targetModel);
  // 有序条目的规则在跨模型过滤之后计算，见 docs/design/v2/model/assistant-block-order.md。
  const orderedHistory = mapMessages(compatibleHistory, applyOrderedAssistantRules);
  const withoutTrailingReasoning = removeTrailingReasoning(orderedHistory);
  return removeReasoningBeforeRepairMarker(repairEmptyAssistantContent(withoutTrailingReasoning));
}

/**
 * 签名修复后成功的请求会在产出的 assistant 上记 signedReasoningReset。
 * 修复原因：修复原来只改那一次请求的副本，历史里被拒的签名块下个请求又发出去，
 * 服务端同样拒绝，于是之后每个请求都先 400 再修一次；块放回后，它缺席期间生成的
 * thinking 也会失效。这里把最后一个标记之前的消息按修复那次的同一规则处理，
 * 放在结构 passes 之后（与修复重试的顺序相同），前缀和修复那次发出的逐字节一致。
 */
function removeReasoningBeforeRepairMarker(messages: ModelInputMessage[]): ModelInputMessage[] {
  const markerIndex = messages.findLastIndex(
    (message) => message.role === "assistant" && message.signedReasoningReset === true,
  );
  if (markerIndex <= 0) return messages;
  const before = messages.slice(0, markerIndex);
  const repaired = removeRejectedReasoning(before);
  return repaired === before ? messages : [...repaired, ...messages.slice(markerIndex)];
}

export function removeRejectedReasoning(messages: ModelInputMessage[]): ModelInputMessage[] {
  const filtered = filterReasoningBlocks(messages, isSignedOrRedactedReasoning);
  if (filtered === messages) return messages;

  const result = filtered.slice();
  for (let index = 0; index < filtered.length; index += 1) {
    if (filtered[index] === messages[index]) continue;

    const message = filtered[index]!;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;

    let content = message.content.filter(
      (block) => block.type !== "text" || block.text.trim().length > 0,
    );
    if (!hasToolCalls(message) && content.every((block) => block.type === "reasoning")) {
      // 按改写前的消息判断：思考块删光后空内容也会被当成有序。
      const original = messages[index]!;
      const ordered = orderedMessageItems(original) !== undefined;
      content = [
        ...content,
        {
          type: "text",
          text: REJECTED_REASONING_FALLBACK,
          // 有序条目的占位块排在最后，条目仍然有序，下面的规则才会重新执行。
          ...(ordered ? { blockIndex: maxBlockIndex(original) + 1 } : {}),
        },
      ];
    }
    result[index] = applyOrderedAssistantRules({ ...message, content });
  }
  return result;
}

export function repairReasoningHistoryAfterSignatureRejection(
  projectedMessages: ModelInputMessage[],
  error: unknown,
): ModelInputMessage[] | undefined {
  if (!isThinkingSignatureRejection(error)) return undefined;

  // 调用方传入的已经是逻辑请求入口完成结构归一化后的副本。这里仅执行签名拒绝清理，
  // 不再次运行结构 passes（规格：结构归一化每个逻辑请求只做一次）。
  const repaired = removeRejectedReasoning(projectedMessages);
  return repaired === projectedMessages ? undefined : repaired;
}

export function isThinkingSignatureRejection(error: unknown): boolean {
  const unwrapped = unwrapRetryError(error);
  if (getStatusCode(unwrapped) !== 400) return false;

  // Provider 没有为该 400 提供独立错误码；这里只匹配已确认的窄化文案，
  // 避免把其他 invalid_request 误当成可修改历史并重试。
  // 修复原因：网关转发的原文是 "Invalid `signature` in `thinking` block … bound to a different
  // conversation"，反引号把 "invalid signature" 隔开，原来的子串匹配认不出，剥离重试没有触发，
  // 会话之后的每个请求都失败。现在原文和去掉反引号的文本都检查（`thinking` 这种写法要用原文判断），
  // 并认出 thinking block 绑定到其他对话的两种说法。
  const message = errorMessage(unwrapped).toLowerCase();
  const plain = message.replaceAll("`", "");
  if (plain.includes("signature in thinking block")) return true;
  if (
    message.includes("bound to a different conversation") ||
    message.includes("not created in this conversation")
  )
    return true;

  const namesThinkingBlock =
    plain.includes("thinking block") ||
    message.includes("`thinking`") ||
    message.includes("redacted_thinking");
  const namesSignatureFailure =
    plain.includes("cannot be modified") || plain.includes("invalid signature");
  return namesThinkingBlock && namesSignatureFailure;
}

/** 签名拒绝重试日志的诊断字段：provider 原文（截断）与 prefix 不一致响应头。 */
export function thinkingSignatureRejectionEvidence(
  error: unknown,
  responseHeaders: Record<string, string> | undefined,
): { providerMessage: string; thinkingPrefixMismatch?: string } {
  const prefixMismatch = Object.entries(responseHeaders ?? {}).find(
    ([name]) => name.toLowerCase() === THINKING_PREFIX_MISMATCH_HEADER,
  )?.[1];
  return {
    providerMessage: errorMessage(unwrapRetryError(error)).slice(
      0,
      REJECTION_PROVIDER_MESSAGE_MAX_CHARS,
    ),
    ...(prefixMismatch ? { thinkingPrefixMismatch: prefixMismatch } : {}),
  };
}

function removeCrossModelReasoning(
  messages: ModelInputMessage[],
  targetModel: { modelId: ModelId; providerId: ModelProviderId } | undefined,
): ModelInputMessage[] {
  if (!targetModel) return messages;

  return filterReasoningBlocks(messages, (block, message) => {
    if (!message.providerId || !message.modelId) return false;
    if (
      message.modelId === targetModel.modelId &&
      areReasoningProvidersCompatible(message.providerId, targetModel.providerId)
    ) {
      return false;
    }
    return isSignedOrRedactedReasoning(block);
  });
}

function areReasoningProvidersCompatible(
  source: ModelProviderId,
  target: ModelProviderId,
): boolean {
  return (
    source === target ||
    REASONING_PROVIDER_GROUPS.some((group) => group.includes(source) && group.includes(target))
  );
}

function filterReasoningBlocks(
  messages: ModelInputMessage[],
  shouldRemove: (block: ModelReasoningContentBlock, message: ModelInputMessage) => boolean,
): ModelInputMessage[] {
  let result: ModelInputMessage[] | undefined;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;

    const content = message.content.filter(
      (block) => block.type !== "reasoning" || !shouldRemove(block, message),
    );
    if (content.length === message.content.length) continue;

    result ??= messages.slice();
    // 此处只过滤 reasoning block，保留消息顺序与结构；结构修复由独立阶段处理。
    result[index] = { ...message, content };
  }

  return result ?? messages;
}

function removeTrailingReasoning(messages: ModelInputMessage[]): ModelInputMessage[] {
  const last = messages.at(-1);
  if (last?.role !== "assistant" || !Array.isArray(last.content)) return messages;

  const items = orderedMessageItems(last);
  if (items) {
    // 有序条目按请求顺序删掉末尾连续的思考块，不重新执行逐块合并。
    let end = items.length;
    while (end > 0 && isReasoningItem(items[end - 1])) end -= 1;
    if (end === items.length) return messages;
    const result = messages.slice();
    result[result.length - 1] = withOrderedItems(last, items.slice(0, end));
    return result;
  }

  let end = last.content.length;
  while (end > 0 && last.content[end - 1]?.type === "reasoning") {
    end -= 1;
  }
  if (end === last.content.length) return messages;

  const result = messages.slice();
  result[result.length - 1] = {
    ...last,
    content: last.content.slice(0, end),
  };
  return result;
}

/** 有序 assistant 条目按请求顺序排列的块（和 transform 用同一个函数），否则 undefined。 */
function orderedMessageItems(message: ModelInputMessage): OrderedAssistantItem[] | undefined {
  return message.role === "assistant" && Array.isArray(message.content)
    ? orderedAssistantItems(message.content, message.toolCalls)
    : undefined;
}

/** 只删除或移动块，不合并块。没有变化时返回原对象，调用方据此判断是否改写了请求。 */
function applyOrderedAssistantRules(message: ModelInputMessage): ModelInputMessage {
  const items = orderedMessageItems(message);
  if (!items) return message;
  const next = foldOrderedItems(items);
  return next.length === items.length && next.every((item, index) => item === items[index])
    ? message
    : withOrderedItems(message, next);
}

// 按到达顺序逐块加入，每加入一块对"已有结果 + 新块"执行规则 a、b。
// 修复原因：对整个条目各执行一次时，最后才出现的思考块会把前面本该后移的工具留在原位，
// 末尾空白也会因为后面补上的思考块而保留，与逐块合并的结果不同（E2E I76 形态 P 1 A 2 B、P A W B 1）。
function foldOrderedItems(items: OrderedAssistantItem[]): OrderedAssistantItem[] {
  let result: OrderedAssistantItem[] = [];
  for (const item of items) {
    result =
      result.length === 0 ? [item] : moveToolUsesToEnd(filterWhitespaceText([...result, item]));
  }
  return result;
}

// 规则 a：去掉纯空白文字块，前后两个块都是思考块时保留；过滤后只剩思考块时放弃这次过滤。
function filterWhitespaceText(items: OrderedAssistantItem[]): OrderedAssistantItem[] {
  const filtered = items.filter((item, index) => {
    if (item.kind !== "content" || item.block.type !== "text") return true;
    if (item.block.text.length === 0 || item.block.text.trim() !== "") return true;
    return isReasoningItem(items[index - 1]) && isReasoningItem(items[index + 1]);
  });
  return filtered.some((item) => !isReasoningItem(item)) ? filtered : items;
}

// 规则 b：第一个 tool_use 后面还有非工具块时，把 tool_use 移到末尾并保持相对顺序；
// 条目里出现"思考 → tool_use(s) → 思考"时保持原顺序。只移动 tool_use 不影响思考签名。
function moveToolUsesToEnd(items: OrderedAssistantItem[]): OrderedAssistantItem[] {
  let seenTool = false;
  let nonToolAfterTool = false;
  let previousContentIsReasoning = false;
  let toolSincePreviousContent = false;
  for (const item of items) {
    if (item.kind === "tool") {
      seenTool = true;
      toolSincePreviousContent = true;
      continue;
    }
    if (seenTool) nonToolAfterTool = true;
    const reasoning = isReasoningItem(item);
    if (reasoning && previousContentIsReasoning && toolSincePreviousContent) return items;
    previousContentIsReasoning = reasoning;
    toolSincePreviousContent = false;
  }
  if (!nonToolAfterTool) return items;
  return [
    ...items.filter((item) => item.kind !== "tool"),
    ...items.filter((item) => item.kind === "tool"),
  ];
}

// 按新顺序重新编号，transform 排列后得到同样的顺序。只改请求副本，不改 canonical history。
function withOrderedItems(
  message: ModelInputMessage,
  items: OrderedAssistantItem[],
): ModelInputMessage {
  const content: ModelMessageContentBlock[] = [];
  const toolCalls: NonNullable<ModelInputMessage["toolCalls"]> = [];
  items.forEach((item, blockIndex) => {
    if (item.kind === "content")
      content.push({ ...item.block, blockIndex } as ModelMessageContentBlock);
    else toolCalls.push({ ...item.call, blockIndex });
  });
  return {
    ...message,
    content,
    ...(message.toolCalls ? { toolCalls } : {}),
  };
}

function isReasoningItem(item: OrderedAssistantItem | undefined): boolean {
  return item?.kind === "content" && item.block.type === "reasoning";
}

function maxBlockIndex(message: ModelInputMessage): number {
  const contentIndices = Array.isArray(message.content)
    ? message.content.map((block) => ("blockIndex" in block ? (block.blockIndex ?? -1) : -1))
    : [];
  const toolIndices = (message.toolCalls ?? []).map((call) => call.blockIndex ?? -1);
  return Math.max(-1, ...contentIndices, ...toolIndices);
}

function mapMessages(
  messages: ModelInputMessage[],
  map: (message: ModelInputMessage) => ModelInputMessage,
): ModelInputMessage[] {
  let result: ModelInputMessage[] | undefined;
  messages.forEach((message, index) => {
    const next = map(message);
    if (next === message) return;
    result ??= messages.slice();
    result[index] = next;
  });
  return result ?? messages;
}

// 非末尾、没有工具调用、内容为空或只剩空白文字的回复补 `(no content)`，不删除这条回复。
// core 投影的请求一般走不到这里：没有可见内容的回复已被删除，留作估算锚点的空回复存成空字符串，
// 这里只处理数组。主要是调用方自己拼的消息（MCP Apps sampling）有这种内容。
function repairEmptyAssistantContent(messages: ModelInputMessage[]): ModelInputMessage[] {
  let result: ModelInputMessage[] | undefined;

  for (let index = 0; index < messages.length - 1; index += 1) {
    const message = messages[index]!;
    if (
      message.role !== "assistant" ||
      !Array.isArray(message.content) ||
      !message.content.every((block) => block.type === "text" && block.text.trim().length === 0) ||
      hasToolCalls(message)
    ) {
      continue;
    }

    result ??= messages.slice();
    result[index] = {
      ...message,
      content: [{ type: "text", text: EMPTY_ASSISTANT_CONTENT_FALLBACK }],
    };
  }

  return result ?? messages;
}

function isSignedOrRedactedReasoning(block: ModelReasoningContentBlock): boolean {
  const anthropic = anthropicOptions(block.providerOptions);
  return (
    (typeof anthropic.signature === "string" && anthropic.signature.length > 0) ||
    typeof anthropic.redactedData === "string"
  );
}

function hasToolCalls(message: ModelInputMessage): boolean {
  return (message.toolCalls?.length ?? 0) > 0;
}

function anthropicOptions(providerOptions: unknown): Record<string, unknown> {
  if (!providerOptions || typeof providerOptions !== "object" || Array.isArray(providerOptions)) {
    return {};
  }
  const anthropic = (providerOptions as Record<string, unknown>).anthropic;
  return anthropic && typeof anthropic === "object" && !Array.isArray(anthropic)
    ? (anthropic as Record<string, unknown>)
    : {};
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return String(error ?? "");
}
