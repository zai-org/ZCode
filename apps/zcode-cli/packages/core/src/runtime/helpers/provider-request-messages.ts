import {
  ProviderEntryOrigins,
  isMidTurnInput,
  isPresentedInput,
  isReminderMessage,
  isUserInputMessage,
  isUserTurnInput,
  projectIncomingMessageEntries,
} from "./provider-entry-origins.js";
import {
  projectMidConversationSystemEntries,
  moveLegacySystemRemindersAfterToolResultRun,
  isToolResultUserMessage,
  type ProjectedRuntimeMessageEntry,
} from "./provider-mid-conversation-system.js";
import type { ModelMessageContent, ModelMessageContentBlock } from "@zcode/contracts";
import type { ModelInputMessage, RuntimeMessageEntry } from "../../agent/message-history.js";
import {
  cloneModelInputMessage,
  toModelToolCall,
  cloneModelMessageContent,
  isKnownSystemReminderSource,
  isRuntimeAttachmentEntry,
  systemReminderAttachmentEntry,
} from "../../agent/message-history.js";
import {
  getSystemReminderDescriptor,
  isMidConversationSystemSource,
  wrapSystemReminderForSource,
  type SystemReminderSource,
} from "../../system-reminder/source.js";

export interface ProviderRequestMessageProjectionResult {
  messages: ModelInputMessage[];
  /** 仅用于内部归属；runtime metadata 不会进入 `messages`。 */
  sourceEntries: Array<RuntimeMessageEntry | undefined>;
  /**
   * 仅用于 context 组成统计：与 `messages` 同索引，列出组成该消息的全部来源条目（含 attachment）。
   * `sourceEntries` 只给一条代表条目，且纯 attachment 消息没有代表条目；MCS 合并、并入 tool result
   * 的提醒只能从这里归因。派生消息（Tool loaded.）为空数组。
   */
  originEntries: Array<readonly RuntimeMessageEntry[]>;
  diagnostics: {
    bubbledAttachmentEntryCount: number;
    latestRealUserMessageIndex?: number;
    strippedRuntimeMetaCount: number;
    cacheControlIndex?: number;
  };
}

// 相邻 user 合并是 Anthropic provider 的协议序列化责任；
// MCS/provider projection 保持 provider-neutral，避免影响 OpenAI-compatible 请求形态。
const ENABLE_MCS_ADJACENT_USER_MERGE = false;
const TOOL_SEARCH_LOADED_MESSAGE = "Tool loaded.";
// adapter 给空回复补的占位文字；模型也可能照着历史回出这段文字，按空白处理。
const EMPTY_ASSISTANT_CONTENT_PLACEHOLDER = "(no content)";

// State changes must keep their causal position relative to older target continuations.
const NON_BUBBLING_ATTACHMENT_SOURCES: ReadonlySet<SystemReminderSource> = new Set([
  "goal_state_change",
]);

export function buildProviderRequestMessages(input: {
  entries: readonly RuntimeMessageEntry[];
  applyCacheControl?: boolean;
  skipCacheWrite?: boolean;
  useMidConversationSystem?: boolean;
  /** 由模型请求能力决定；不传时不折叠、不补换行（OpenAI 兼容协议、估算与 microcompact）。 */
  foldRemindersIntoToolResults?: boolean;
  /** 由模型请求能力决定；不传时保留没有可见内容的回复（OpenAI 兼容协议、估算与 microcompact）。 */
  dropReasoningOnlyOrBlankAssistants?: boolean;
  loadedToolCallIds?: ReadonlySet<string>;
}): ProviderRequestMessageProjectionResult {
  const useMidConversationSystem = input.useMidConversationSystem !== false;
  const origins = new ProviderEntryOrigins();
  // 删除是投影的第一步：冒泡、MCS 落点、提醒并入和补换行都按这条回复不存在处理。
  const presentEntries =
    input.dropReasoningOnlyOrBlankAssistants === true
      ? input.entries.filter((entry) => !isReasoningOnlyOrBlankAssistant(entry))
      : input.entries;
  const reorderResult = reorderAttachmentLikeEntries(
    projectIncomingMessageEntries(presentEntries, origins),
  );
  const midSystemProjection = useMidConversationSystem
    ? projectMidConversationSystemEntries(reorderResult.entries, origins)
    : { entries: reorderResult.entries };
  const projectedEntries = deriveGenUiStates(
    moveLegacySystemRemindersAfterToolResultRun(midSystemProjection.entries),
    origins,
  );
  // media-budget 在 provider-clean messages 上运行，必须在剥离 metadata 前记录
  // latest real user 的 projection 后索引，避免用户 literal system-reminder 被误当成 meta。
  const latestRealUserMessageIndex = origins.latestRealUserIndex(projectedEntries, input.entries);
  const renderedMessages = projectedEntries.map(renderProjectedEntryToModelMessage);
  // Tool loaded. 在并入和补换行之前插入：紧跟搜索批次的提醒排在它之后，不并入 tool result；
  // 后面的 user 输入前照常补换行。
  const appended = appendToolSearchSuccessMessages(renderedMessages, input.loadedToolCallIds);
  const appendedEntries = representativeEntries(appended.indexMap, projectedEntries);
  // 并入 tool result 与补换行来自同一个协议事实：相邻 user 内容会合成一条消息。
  const mergesAdjacentUserContent = input.foldRemindersIntoToolResults === true;
  const folded = mergesAdjacentUserContent
    ? foldRemindersIntoToolResults(appended.messages, appendedEntries)
    : identityMergeResult(appended.messages);
  // 换行在并入之后判断，上一块是 tool_result 时不补：先补再并入会把 "\n" 留在
  // 数组形态的 tool result 里。
  // 修复原因：补换行模拟的是合并相邻 user 内容时的分隔。OpenAI 兼容协议不合并 user，
  // 补了只会改写上一次请求的最后一块，读不到前缀缓存；所以只在合并的协议上补。
  const foldResult = composeIndexMap(appended.indexMap, {
    messages: mergesAdjacentUserContent
      ? separateUserTextBeforeUserInput(
          folded.messages,
          representativeEntries(folded.indexMap, appendedEntries),
        )
      : folded.messages,
    indexMap: folded.indexMap,
  });
  const mergeResult = ENABLE_MCS_ADJACENT_USER_MERGE
    ? composeIndexMap(foldResult.indexMap, mergeAdjacentUserMessages(foldResult.messages))
    : foldResult;
  const messages = mergeResult.messages;
  const sourceEntries: Array<RuntimeMessageEntry | undefined> = Array.from({
    length: messages.length,
  });
  const originEntries: RuntimeMessageEntry[][] = Array.from({ length: messages.length }, () => []);
  for (const [projectedIndex, mergedIndex] of mergeResult.indexMap.entries()) {
    const entry = projectedEntries[projectedIndex];
    if (entry) originEntries[mergedIndex]!.push(...origins.get(entry));
    if (sourceEntries[mergedIndex] !== undefined) continue;
    if (entry) sourceEntries[mergedIndex] = origins.representative(entry);
  }
  const mappedLatestRealUserMessageIndex =
    latestRealUserMessageIndex >= 0 ? (mergeResult.indexMap[latestRealUserMessageIndex] ?? -1) : -1;
  // 纯文本 steer 并入 tool result 后不再是独立的用户消息；指向 tool 消息会让媒体预算
  // 把工具图片当作当前用户附件保护。steer 本身没有媒体，取 -1 与并入前的保护范围相同。
  const finalLatestRealUserMessageIndex =
    messages[mappedLatestRealUserMessageIndex]?.role === "tool"
      ? -1
      : mappedLatestRealUserMessageIndex;
  const cacheControlIndex =
    input.applyCacheControl === true
      ? finalizeLatestNonSystemMessageCacheControl(messages, {
          skipCacheWrite: input.skipCacheWrite === true,
        })
      : undefined;

  return {
    messages,
    sourceEntries,
    originEntries,
    diagnostics: {
      bubbledAttachmentEntryCount: reorderResult.bubbledAttachmentEntryCount,
      // 新标记能证明“没有真实用户”；省略索引会让媒体预算按 user role 重新猜来源。
      ...(finalLatestRealUserMessageIndex >= 0 ||
      input.entries.some(isPresentedInput) ||
      input.loadedToolCallIds?.size
        ? { latestRealUserMessageIndex: finalLatestRealUserMessageIndex }
        : {}),
      strippedRuntimeMetaCount: input.entries.filter((entry) => entry.metadata).length,
      ...(cacheControlIndex !== undefined ? { cacheControlIndex } : {}),
    },
  };
}

// 页面状态挂在所属输入上，排序全部结束后才在输入旁派生，不参与冒泡和 MCS 合并。
// 修复原因：状态曾是紧跟输入的独立附件，中途消息冒泡时状态留在原位，和所属 guide 被隔开。
// 输入并入 MCS system 时状态留在 user 侧、排在这条 system 之前（[状态][system]），其余为 [输入][状态]。
function deriveGenUiStates(
  entries: readonly ProjectedRuntimeMessageEntry[],
  origins: ProviderEntryOrigins,
): ProjectedRuntimeMessageEntry[] {
  return entries.flatMap((entry) => {
    const states = origins.get(entry).flatMap((origin) => {
      const body = origin.metadata?.genUiState;
      return body ? [systemReminderAttachmentEntry("gen_ui_state", body)] : [];
    });
    if (states.length === 0) return [entry];
    return !isRuntimeAttachmentEntry(entry) && entry.message.role === "system"
      ? [...states, entry]
      : [entry, ...states];
  });
}

// 派生消息（Tool loaded.）没有对应 entry，对应位置为 undefined。
function representativeEntries(
  indexMap: readonly number[],
  entries: readonly (ProjectedRuntimeMessageEntry | undefined)[],
): Array<ProjectedRuntimeMessageEntry | undefined> {
  const result: Array<ProjectedRuntimeMessageEntry | undefined> = [];
  for (const [index, mergedIndex] of indexMap.entries()) result[mergedIndex] ??= entries[index];
  return result;
}

function identityMergeResult(messages: ModelInputMessage[]): MessageMergeResult {
  return { messages, indexMap: messages.map((_, index) => index) };
}

// 没有工具调用、没有可见内容（每个块都是思考或空白文字）的回复：在思考中被打断（send now、停止）、
// 思考后流失败、只回了思考和空白。
// 修复原因：删除原在 adapter 的请求归一化里，晚于这里的 MCS 落点。MCS system 按「后面是 assistant」
// 放在这条回复前面，回复随后被删，请求变成 system 直接接 user，provider 返回 400，之后会话的每个请求都失败。
// 现在删除只在这里做，并且是投影的第一步。字符串和空数组不删：完全没有输出的回复存成空字符串，带 usage，
// 留作估算锚点；空数组的 every 恒为真，单独排除（见 docs/design/v2/model/assistant-block-order.md「没有可见内容的回复」）。
function isReasoningOnlyOrBlankAssistant(entry: RuntimeMessageEntry): boolean {
  if (isRuntimeAttachmentEntry(entry)) return false;
  const { role, content, toolCalls } = entry.message;
  if (role !== "assistant" || (toolCalls?.length ?? 0) > 0) return false;
  if (typeof content === "string" || content.length === 0) return false;
  return content.every(
    (block) =>
      block.type === "reasoning" ||
      (block.type === "text" &&
        (block.text.trim().length === 0 ||
          block.text.trim() === EMPTY_ASSISTANT_CONTENT_PLACEHOLDER)),
  );
}

interface AttachmentReorderResult {
  entries: RuntimeMessageEntry[];
  bubbledAttachmentEntryCount: number;
}

function reorderAttachmentLikeEntries(
  entries: readonly RuntimeMessageEntry[],
): AttachmentReorderResult {
  const result: RuntimeMessageEntry[] = [];
  const pending: RuntimeMessageEntry[] = [];
  let bubbledAttachmentEntryCount = 0;

  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (isAttachmentLikeUserEntry(entry)) {
      pending.push(entry);
      continue;
    }

    // 停止点是 assistant / system / tool result；普通 user 输入不是停止点（中途消息例外，见下）。
    if (!isRuntimeAttachmentEntry(entry) && isBubbleStop(entry.message) && pending.length > 0) {
      result.push(...pending);
      bubbledAttachmentEntryCount += pending.length;
      pending.length = 0;
    }
    // 中途消息不越过普通 user 输入：它和之后生成的 attachment 留在输入之后，之前生成的继续冒泡。
    // 修复原因：send-now 在被抢占轮次没有任何输出时开新一轮，user_steer 冒泡到被抢占的 prompt
    // 之前，模型最后读到的是已被取代的旧指令。pending 是倒序，最后一条中途消息生成得最早。
    if (isUserTurnInput(entry)) {
      const staying = pending.splice(0, pending.findLastIndex(isMidTurnInput) + 1);
      result.push(...staying);
      bubbledAttachmentEntryCount += staying.length;
    }
    result.push(entry);
  }

  if (pending.length > 0) {
    result.push(...pending);
    bubbledAttachmentEntryCount += pending.length;
  }

  result.reverse();
  return { entries: result, bubbledAttachmentEntryCount };
}

function isAttachmentLikeUserEntry(entry: RuntimeMessageEntry): boolean {
  // 中途消息按 attachment 处理，随其他 attachment 冒泡并保持生成顺序；
  // 输入不作为停止点，后来的公告也不会越过它。
  if (isMidTurnInput(entry)) return true;
  if (isPresentedInput(entry)) return false;
  if (isRuntimeAttachmentEntry(entry)) {
    const source = entry.metadata.source;
    if (!isKnownSystemReminderSource(source)) return false;
    if (NON_BUBBLING_ATTACHMENT_SOURCES.has(source)) return false;
    const descriptor = getSystemReminderDescriptor(source);
    if (descriptor.channel === "history_continuity") return false;
    return (
      descriptor.isMeta &&
      descriptor.providerVisibility === "provider_visible" &&
      descriptor.channel !== "tool_result" &&
      descriptor.channel !== "real_user"
    );
  }

  if (entry.message.role !== "user") return false;
  if (isToolResultUserMessage(entry.message)) return false;
  const source = entry.metadata?.source;
  if (!source || source === "real_user") return false;
  if (source === "legacy_synthetic") return true;
  if (!isKnownSystemReminderSource(source)) return false;
  if (isMidConversationSystemSource(source)) return false;

  const descriptor = getSystemReminderDescriptor(source);
  if (descriptor.channel === "history_continuity") return false;
  return (
    descriptor.isMeta &&
    descriptor.providerVisibility === "provider_visible" &&
    descriptor.channel !== "tool_result" &&
    descriptor.channel !== "real_user"
  );
}

function isBubbleStop(message: ModelInputMessage): boolean {
  return (
    message.role === "system" ||
    message.role === "assistant" ||
    message.role === "tool" ||
    isToolResultUserMessage(message)
  );
}

function renderProjectedEntryToModelMessage(
  entry: ProjectedRuntimeMessageEntry,
): ModelInputMessage {
  if (isRuntimeAttachmentEntry(entry)) {
    const source = entry.metadata.source;
    if (!isKnownSystemReminderSource(source)) {
      throw new Error(`Attachment source ${source} is not a system reminder source`);
    }
    const message: ModelInputMessage = {
      role: "user",
      // incoming 载荷也可能含关闭标签；统一在 provider 包装时转义，canonical 原文不变。
      content: wrapSystemReminderForSource(source, entry.content),
    };
    if (entry.cacheControl) {
      message.cacheControl = { ...entry.cacheControl };
    }
    return message;
  }
  const message = cloneModelInputMessage(entry.message);
  // 内部历史使用目标身份；只在现有 provider render 中恢复真实模型包装。
  for (let index = 0; index < (message.toolCalls?.length ?? 0); index++) {
    message.toolCalls![index] = toModelToolCall(message.toolCalls![index]!);
  }
  if (message.modelCallWrapper) {
    message.toolName = message.modelCallWrapper;
    delete message.modelCallWrapper;
  }
  return message;
}

// 相邻 user 消息合并规则：user 输入消息和 Continue 提示前紧挨的 user 文本以换行结尾；
// attachment 并入前一条时不补。按位置补换行，与前一块的来源无关；tool result 不是文本，不补。
// 已以换行结尾时不再补，保持投影对自身输出幂等。
function separateUserTextBeforeUserInput(
  messages: ModelInputMessage[],
  entries: readonly (ProjectedRuntimeMessageEntry | undefined)[],
): ModelInputMessage[] {
  for (let index = 1; index < messages.length; index++) {
    const previous = messages[index - 1]!;
    const entry = entries[index];
    if (!entry || !startsWithText(messages[index]!.content)) continue;
    if (!isUserInputMessage(entry) && !isOutputTokenContinuation(entry)) continue;
    if (previous.role !== "user" || isToolResultUserMessage(previous)) continue;
    messages[index - 1] = { ...previous, content: appendNewlineToLastText(previous.content) };
  }
  return messages;
}

// 输出达到上限后追加的 Continue 提示不算用户输入，但它也会直接接在 user 文本后面：前一条回复只有思考、
// 被删除；零输出截断没有留下 assistant；提醒冒泡到它前面。
// 修复原因：删除挪到投影第一步后，这里原来不给它补换行，两段文字合成一条消息时连在一起
// （「原文Output token limit hit…」）；删除原在 adapter 时，它合并 user 会补换行。
function isOutputTokenContinuation(entry: ProjectedRuntimeMessageEntry): boolean {
  return !isRuntimeAttachmentEntry(entry) && entry.queryScope === "output_token_continuation";
}

function startsWithText(content: ModelMessageContent): boolean {
  return typeof content === "string" || content[0]?.type === "text";
}

function appendNewlineToLastText(content: ModelMessageContent): ModelMessageContent {
  if (typeof content === "string") return content.endsWith("\n") ? content : `${content}\n`;
  const last = content.at(-1);
  if (last?.type !== "text" || last.text.endsWith("\n")) return content;
  return [...content.slice(0, -1), { ...last, text: `${last.text}\n` }];
}

interface MessageMergeResult {
  messages: ModelInputMessage[];
  indexMap: number[];
}

function composeIndexMap(first: readonly number[], second: MessageMergeResult): MessageMergeResult {
  return { messages: second.messages, indexMap: first.map((index) => second.indexMap[index]!) };
}

// 紧跟 tool result 的 user 侧提醒并入这组最后一个 tool result 的内容。
// MCS 只决定哪些提醒留在 user 侧，不改变这条规则。遇到第一条不折叠的消息即停止。
function foldRemindersIntoToolResults(
  messages: readonly ModelInputMessage[],
  entries: readonly (ProjectedRuntimeMessageEntry | undefined)[],
): MessageMergeResult {
  const result: ModelInputMessage[] = [];
  const indexMap: number[] = [];
  for (const [index, message] of messages.entries()) {
    const previous = result.at(-1);
    const entry = entries[index];
    const content =
      previous?.role === "tool" && entry && isFoldableReminder(entry, message)
        ? foldIntoToolResultContent(previous.content, message.content)
        : undefined;
    if (previous && content) {
      const cacheControl = message.cacheControl ?? previous.cacheControl;
      result[result.length - 1] = {
        ...previous,
        content,
        ...(cacheControl ? { cacheControl: { ...cacheControl } } : {}),
      };
      indexMap.push(result.length - 1);
      continue;
    }
    indexMap.push(result.length);
    result.push(message);
  }
  return { messages: result, indexMap };
}

// 中途消息按 attachment 处理，同样并入；带媒体的中途消息不并入。
// MCS 降级块不经过折叠；legacy_synthetic 还承载旧后台通知与 compact 摘要，同样不折叠。
function isFoldableReminder(
  entry: ProjectedRuntimeMessageEntry,
  message: ModelInputMessage,
): boolean {
  if (message.role !== "user" || isToolResultUserMessage(message)) return false;
  if (typeof message.content !== "string" && message.content.some((b) => b.type !== "text")) {
    return false;
  }
  if (isRuntimeAttachmentEntry(entry)) return true;
  if (isPresentedInput(entry)) return false;
  return isReminderMessage(entry);
}

function foldIntoToolResultContent(
  toolContent: ModelMessageContent,
  reminder: ModelMessageContent,
): ModelMessageContent | undefined {
  const reminderBlocks = modelContentToMergeBlocks(reminder);
  if (typeof toolContent === "string") {
    return [
      toolContent,
      ...reminderBlocks.map((block) => (block.type === "text" ? block.text : "")),
    ]
      .map((text) => text.trim())
      .filter(Boolean)
      .join("\n\n");
  }
  if (toolContent.some((block) => block.type === "tool_reference")) return undefined;
  return [...appendNewlineToLastTextBlock(toolContent), ...reminderBlocks];
}

function appendNewlineToLastTextBlock(
  content: ModelMessageContentBlock[],
): ModelMessageContentBlock[] {
  const last = content.at(-1);
  if (last?.type !== "text") return content;
  return [...content.slice(0, -1), { ...last, text: `${last.text}\n` }];
}

function mergeAdjacentUserMessages(messages: readonly ModelInputMessage[]): MessageMergeResult {
  const merged: ModelInputMessage[] = [];
  const indexMap: number[] = [];

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    const previous = merged.at(-1);
    if (previous && canMergeAdjacentUserMessages(previous, message)) {
      const mergedIndex = merged.length - 1;
      merged[mergedIndex] = mergeUserMessages(previous, message);
      indexMap[index] = mergedIndex;
      continue;
    }

    indexMap[index] = merged.length;
    merged.push(message);
  }

  return { messages: merged, indexMap };
}

function appendToolSearchSuccessMessages(
  messages: readonly ModelInputMessage[],
  loadedToolCallIds?: ReadonlySet<string>,
): MessageMergeResult {
  if (!loadedToolCallIds?.size)
    return { messages: [...messages], indexMap: messages.map((_, index) => index) };
  const result: ModelInputMessage[] = [];
  const indexMap: number[] = [];
  let pendingLoaded = 0;
  for (const [index, message] of messages.entries()) {
    indexMap.push(result.length);
    result.push(message);
    if (message.role === "tool" && message.toolCallId && loadedToolCallIds.has(message.toolCallId))
      pendingLoaded++;
    // 成功提示只在最终投影中派生；整批 tool result 必须连续，不能被提示拆开。
    if (messages[index + 1]?.role !== "tool") {
      while (pendingLoaded > 0) {
        result.push({ role: "user", content: TOOL_SEARCH_LOADED_MESSAGE });
        pendingLoaded--;
      }
    }
  }
  return { messages: result, indexMap };
}

function canMergeAdjacentUserMessages(
  previous: ModelInputMessage,
  next: ModelInputMessage,
): boolean {
  if (previous.role !== "user" || next.role !== "user") return false;
  return !isToolResultUserMessage(previous) && !isToolResultUserMessage(next);
}

function mergeUserMessages(
  previous: ModelInputMessage,
  next: ModelInputMessage,
): ModelInputMessage {
  const merged: ModelInputMessage = {
    role: "user",
    content: mergeUserContent(previous.content, next.content),
  };
  const cacheControl = next.cacheControl ?? previous.cacheControl;
  if (cacheControl) merged.cacheControl = { ...cacheControl };
  return merged;
}

function mergeUserContent(
  previous: ModelMessageContent,
  next: ModelMessageContent,
): ModelMessageContentBlock[] {
  const previousBlocks = modelContentToMergeBlocks(previous);
  const nextBlocks = modelContentToMergeBlocks(next);
  const previousLast = previousBlocks.at(-1);
  const nextFirst = nextBlocks[0];

  if (previousLast?.type === "text" && nextFirst?.type === "text") {
    previousBlocks[previousBlocks.length - 1] = {
      ...previousLast,
      text: `${previousLast.text}\n`,
    };
  }

  return [...previousBlocks, ...nextBlocks];
}

function modelContentToMergeBlocks(content: ModelMessageContent): ModelMessageContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return cloneModelMessageContent(content) as ModelMessageContentBlock[];
}

function finalizeLatestNonSystemMessageCacheControl(
  messages: ModelInputMessage[],
  options: { skipCacheWrite?: boolean } = {},
): number | undefined {
  clearNonSystemMessageCacheControl(messages);

  const latestIndex = findPreviousNonSystemMessageIndex(messages, messages.length - 1);
  if (latestIndex === undefined) return undefined;

  // 但不作为 cache write breakpoint，marker 应前移到 compact prompt 前的真实上下文。
  const cacheControlIndex =
    options.skipCacheWrite === true
      ? findPreviousNonSystemMessageIndex(messages, latestIndex - 1)
      : latestIndex;
  if (cacheControlIndex === undefined) return undefined;

  const message = messages[cacheControlIndex]!;
  messages[cacheControlIndex] = {
    ...message,
    cacheControl: { type: "ephemeral" },
  };
  return cacheControlIndex;
}

function findPreviousNonSystemMessageIndex(
  messages: readonly ModelInputMessage[],
  startIndex: number,
): number | undefined {
  for (let index = Math.min(startIndex, messages.length - 1); index >= 0; index--) {
    if (messages[index]?.role !== "system") return index;
  }
  return undefined;
}

function clearNonSystemMessageCacheControl(messages: ModelInputMessage[]): void {
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === "system" || !message.cacheControl) continue;
    const { cacheControl: _cacheControl, ...messageWithoutCacheControl } = message;
    messages[index] = messageWithoutCacheControl;
  }
}
