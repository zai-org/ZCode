import { genUiModelContextSchema, type GenUiModelContext } from "@zcode/shared/gen-ui";
import { attachGenUiContext, normalizeGenUiInput } from "./message-history.js";
import { ModelCallWrapperSchema } from "@zcode/contracts";
import {
  hydrateToolSearchContent,
  hydrateCompactDiscovery,
  hydrateToolSearchAnnouncement,
} from "./tool-search-hydration.js";
import { parseToolSearchHiddenNames } from "../tool/search/history.js";
import { parseAgentListingDelta } from "./agent-listing-metadata.js";
import { parseEnvironmentAnnouncement } from "../context/sections/env-info.js";
import { parseInstructionAnnouncement } from "../context/sections/instruction-files.js";
import { runtimeInputMetadata } from "./runtime-input-presentation.js";
// ============================================================
// Session History Hydration - rebuild provider-visible context
// ============================================================

import {
  STREAM_RECOVERY_DISCARDED_ERROR_NAME,
  hasOrderedAssistantBlocks,
  isBrowserTurnScreenshotPart,
  modelMessageContentToText,
  selectActiveConversationBranch,
} from "@zcode/contracts";
import type {
  Logger,
  MessagePart,
  MessageWithParts,
  ModelMessageContentBlock,
  ModelReasoningContentBlock,
  MessageId,
  ToolArtifactStorePort,
  ToolPart,
} from "@zcode/contracts";
import {
  getSystemReminderDescriptor,
  wrapSystemReminderForSource,
  type SystemReminderSource,
} from "../system-reminder/source.js";
import { persistedTokenUsageBaseline } from "./message-history-usage.js";
import {
  isProviderExecutedToolPartMetadata,
  withCompactGroupKey,
} from "../runtime/provider-tool-rounds/contract.js";
import {
  buildAssistantEntries,
  createRuntimeAssistantEntry,
  createRuntimeToolResultEntry,
  INTERRUPT_MARKER_SOURCE,
  isKnownSystemReminderSource,
  legacySyntheticRuntimeMetadata,
  realUserRuntimeMetadata,
  buildUserMessageEntries,
  type UserMessageAttachment,
  systemReminderAttachmentEntry,
  systemReminderRuntimeMetadata,
  todoReminderRuntimeMetadata,
  withSignedReasoningReset,
  type MessageHistory,
  type RuntimeMessageEntry,
  type RuntimeMessageMetadata,
  type RuntimeMessageSource,
  type AssistantHistoryBlock,
  type ToolCallInput,
} from "./message-history.js";
import { compactActiveSessionMessages, isActiveCompactionBoundaryPart } from "./compact-session.js";
import { filePartToContentBlock, projectPersistedToolMediaContent } from "./file-part-hydration.js";
import { selectToolPartsForHistory } from "./tool-part-order.js";

const INTERRUPTED_TOOL_RESULT = "[Tool execution was interrupted before resume]";

export interface SessionHistoryHydrationResult {
  appliedMessageCount: number;
  interruptedToolCount: number;
  messageCount: number;
  partCount: number;
}

export async function hydrateMessageHistoryFromSession(input: {
  logger?: Logger;
  artifactStore?: ToolArtifactStorePort;
  branchCutAfterMessageId?: MessageId;
  history: MessageHistory;
  messages: MessageWithParts[];
  rewindCreatedMessageId?: MessageId;
  rewindKeptMessageIds?: readonly MessageId[];
  rewindTargetMessageId?: MessageId;
}): Promise<SessionHistoryHydrationResult> {
  const activeMessages = activeSessionMessages(input.messages, {
    branchCutAfterMessageId: input.branchCutAfterMessageId,
    rewindCreatedMessageId: input.rewindCreatedMessageId,
    rewindKeptMessageIds: input.rewindKeptMessageIds,
    rewindTargetMessageId: input.rewindTargetMessageId,
  });
  let appliedMessageCount = 0,
    interruptedToolCount = 0,
    partCount = 0;

  for (const message of activeMessages) {
    // 旧话题背景已由可查看文本附件替代；保留存储记录，但恢复时不能重新隐藏注入。
    if (
      message.info.role === "user" &&
      message.info.synthetic &&
      message.info.source === "bot_topic_context"
    )
      continue;
    const parts = dedupeParts(message.parts).filter(
      (part) =>
        !(
          part.type === "text" &&
          part.synthetic &&
          metadataFromSyntheticTextPart(part).source === "bot_topic_context"
        ),
    );
    partCount += parts.length;

    if (message.info.role === "user") {
      const sharedContextStatus =
        message.info.source === "shared_context" &&
        message.info.metadata &&
        typeof message.info.metadata === "object"
          ? (message.info.metadata as Record<string, unknown>).sharedContextStatus
          : undefined;
      if (
        message.info.source === "shared_context" &&
        sharedContextStatus !== undefined &&
        sharedContextStatus !== "attached"
      ) {
        // Share handover 的 pending/reserved context 只是本地候选，不能在用户首次
        // 发送前偷偷进入 provider history；attach 后由 runtime 显式注入一次。
        continue;
      }
      // session 持久化的是 raw synthetic notice，hydrate 阶段若提前包成
      // user <system-reminder>，后续 mid-conversation system projection 会失去 attachment source。
      const syntheticAttachment = syntheticSystemReminderAttachmentFromParts(parts);
      if (syntheticAttachment) {
        input.history.addEntries([syntheticAttachment]);
        appliedMessageCount++;
        continue;
      }

      const intent =
        message.info.metadata?.conversationInputIntent ?? message.info.metadata?.inputIntent;
      const context = genUiModelContextSchema.safeParse(
        intent && typeof intent === "object"
          ? (intent as Record<string, unknown>).genUiContext
          : undefined,
      );
      const presentation = runtimeInputMetadata(
        (message.info.metadata as Record<string, unknown> | undefined)?.inputPresentation,
      );
      const entries = await userEntriesFromParts(
        parts,
        input.artifactStore,
        context.success ? context.data : undefined,
        // 空闲整批的每条通知是一个文本 part，按块读回，与 live 写入的 content 相同。
        presentation?.inputPresentation === "task_notification",
      );
      if (entries.length === 0) continue;
      const boundaryPart = parts.find(isActiveCompactionBoundaryPart);
      const compactBoundary =
        boundaryPart?.type === "compaction"
          ? hydrateCompactDiscovery(boundaryPart.compactBoundary)
          : undefined;
      if (compactBoundary && entries[0]) {
        entries[0] = {
          ...entries[0],
          metadata: {
            ...legacySyntheticRuntimeMetadata(),
            ...entries[0].metadata,
            compactBoundary,
          },
        };
      }
      input.history.addEntries(
        presentation
          ? entries.map((entry) =>
              entry.kind === "attachment"
                ? entry
                : { ...entry, metadata: { ...entry.metadata, ...presentation } },
            )
          : entries,
      );
      appliedMessageCount++;
      continue;
    }

    // 断流重试 / 执行模型回退作废的 attempt：正文、思考和服务端内置工具轮次从不进入 live history
    // （服务端轮次在流中提前落盘），冷恢复必须同样剔除；退回前已结算的本地工具调用与结果
    // 已提交到 live history，继续保留。不能靠「作废消息恰好没有这些 part」的隐式前提。
    // 浏览器轮尾截图 part 只用于展示，live 从不把它放进模型历史。以前冷恢复会把它变成一个
    // 工具调用加结果，导致冷恢复请求和 live 不同；这里跳过它，UI 仍然从原始 parts 显示。
    const assistantParts = (
      message.info.error?.name === STREAM_RECOVERY_DISCARDED_ERROR_NAME
        ? parts.filter(
            (part) =>
              part.type !== "text" &&
              part.type !== "reasoning" &&
              !(isToolPart(part) && isProviderExecutedToolPartMetadata(part.metadata)),
          )
        : parts
    ).filter((part) => !isBrowserTurnScreenshotPart(part));

    const assistantModel =
      message.info.modelId && message.info.providerId
        ? { modelId: message.info.modelId, providerId: message.info.providerId }
        : undefined;

    // 签名修复后成功的那一步：标记回到这条消息拆出的第一条 assistant，与 live 提交时一致。
    const markRepaired = (entries: RuntimeMessageEntry[]) =>
      message.info.metadata?.signedReasoningReset === true
        ? withSignedReasoningReset(entries)
        : entries;

    if (hasOrderedAssistantBlocks(assistantParts)) {
      // 有序消息与 live 共用 buildAssistantEntries（docs/design/v2/model/assistant-block-order.md）。
      const toolParts = selectToolPartsForHistory(
        assistantParts.filter(
          (part): part is ToolPart =>
            isToolPart(part) && !isProviderExecutedToolPartMetadata(part.metadata),
        ),
      );
      const entries = buildAssistantEntries({
        blocks: [
          ...orderedContentBlocksFromParts(assistantParts),
          ...assistantParts.filter(isToolPart).flatMap((part): AssistantHistoryBlock[] =>
            isProviderExecutedToolPartMetadata(part.metadata)
              ? [
                  {
                    kind: "provider_tool",
                    call: {
                      id: part.callID,
                      input: part.state.input,
                      name: part.tool,
                      blockIndex: part.blockIndex,
                    },
                    result: providerToolResultFromPart(part),
                  },
                ]
              : [],
          ),
          ...toolParts.map(
            (part): AssistantHistoryBlock => ({
              kind: "tool",
              call: { ...toolCallInputFromPart(part), blockIndex: part.blockIndex },
            }),
          ),
        ],
        model: assistantModel,
        tokens: message.info.tokens,
        groupKey: message.info.id,
        keepEmptyFinal: persistedTokenUsageBaseline(message.info.tokens) !== undefined,
      });
      if (entries.length === 0) continue;
      input.history.addEntries(markRepaired(entries));
      appliedMessageCount++;
      interruptedToolCount += await addToolResultsFromParts(input, toolParts);
      continue;
    }
    // 服务端内置工具在流中按顺序落盘：工具 part 之前的 reasoning/text 属于同一轮。
    // 与 live history 一致，每轮回放为 assistant(text, [工具]) + tool(结果)，剩下的走原逻辑。
    const { rounds: providerRounds, remainingParts } = splitProviderToolRoundParts(assistantParts);
    // 这条消息拆出的所有 assistant entry 共用分组键：compact 按数据库消息定持久化边界，两边组数才一致。
    const compactGroupKey = providerRounds.length > 0 ? message.info.id : undefined;
    input.history.addEntries(
      markRepaired(
        withCompactGroupKey(
          providerRounds.flatMap((round) => {
            const toolPart = round.toolPart;
            return [
              createRuntimeAssistantEntry(
                assistantTextFromParts(round.parts),
                [{ id: toolPart.callID, input: toolPart.state.input, name: toolPart.tool }],
                assistantReasoningFromParts(round.parts),
                assistantModel,
              ),
              createRuntimeToolResultEntry(
                toolPart.callID,
                toolPart.tool,
                providerToolResultFromPart(toolPart).output,
                providerToolResultFromPart(toolPart).isError,
              ),
            ];
          }),
          compactGroupKey,
        ),
      ),
    );

    const text = assistantTextFromParts(remainingParts);
    const reasoning = assistantReasoningFromParts(remainingParts);
    const toolParts = selectToolPartsForHistory(remainingParts.filter(isToolPart));
    // 有服务端内置工具轮次时，持久化 usage 是服务端多轮请求的合计，不能当上下文估算锚点；
    // 与 live 一致不挂 tokens，也不为它保留空 assistant。
    const contextUsage = compactGroupKey ? undefined : message.info.tokens;
    // live history 会保留带合法 provider usage 的空 assistant 作为估算锚点，
    // 旧 hydration 却无条件丢弃它，导致重启前后的 context estimate 不一致。
    if (
      text.trim().length === 0 &&
      reasoning.length === 0 &&
      toolParts.length === 0 &&
      !persistedTokenUsageBaseline(contextUsage)
    ) {
      if (providerRounds.length > 0) appliedMessageCount++;
      continue;
    }

    const finalToolCalls = toolParts.map(toolCallInputFromPart);
    const finalEntries = withCompactGroupKey(
      [createRuntimeAssistantEntry(text, finalToolCalls, reasoning, assistantModel, contextUsage)],
      compactGroupKey,
    );
    input.history.addEntries(providerRounds.length > 0 ? finalEntries : markRepaired(finalEntries));
    appliedMessageCount++;

    interruptedToolCount += await addToolResultsFromParts(input, toolParts);
  }

  return {
    appliedMessageCount,
    interruptedToolCount,
    messageCount: activeMessages.length,
    partCount,
  };
}

async function addToolResultsFromParts(
  input: { artifactStore?: ToolArtifactStorePort; history: MessageHistory; logger?: Logger },
  toolParts: readonly ToolPart[],
): Promise<number> {
  let interruptedToolCount = 0;
  for (const part of toolParts) {
    const toolName = historyToolNameFromPart(part);
    const modelCallWrapper = modelCallWrapperFromPart(part);
    if (part.state.status === "completed") {
      // live tool result 使用结构化媒体，但旧恢复只读取 output 摘要，
      // 导致模型切换或冷恢复后丢失 Read/MCP 产生的真实媒体。
      const attachmentBlocks = part.state.attachments
        ? await Promise.all(
            part.state.attachments.map((attachment) =>
              filePartToContentBlock(attachment, input.artifactStore),
            ),
          )
        : [];
      // 旧 completed part 也可能有 attachments；只有完整有效的 layout 才能证明
      // 它们属于新的 provider-visible 媒体内容，缺失或损坏时必须保留 legacy output。
      const projectedMediaContent =
        attachmentBlocks.length > 0
          ? projectPersistedToolMediaContent(
              part.state.metadata?.modelContentLayout,
              attachmentBlocks,
            )
          : undefined;
      const content =
        hydrateToolSearchContent(part.state.metadata?.modelContent, input.logger) ??
        projectedMediaContent ??
        part.state.output;
      input.history.addToolResult(part.callID, toolName, content, true, false, modelCallWrapper);
      continue;
    }

    if (part.state.status === "error") {
      const persistedModelContent = part.state.metadata?.modelContent;
      // 实时链路使用 ToolExecutionResult.modelContent，但旧恢复逻辑只重放
      // 面向 UI / 日志的 state.error；优先使用持久化字符串并兼容旧 session。
      input.history.addToolResult(
        part.callID,
        toolName,
        typeof persistedModelContent === "string" ? persistedModelContent : part.state.error,
        false,
        true,
        modelCallWrapper,
      );
      continue;
    }

    interruptedToolCount++;
    input.history.addToolResult(
      part.callID,
      toolName,
      INTERRUPTED_TOOL_RESULT,
      false,
      true,
      modelCallWrapper,
    );
  }
  return interruptedToolCount;
}

function toolCallInputFromPart(part: ToolPart): ToolCallInput {
  return {
    id: part.callID,
    input: part.state.input,
    modelCallWrapper: modelCallWrapperFromPart(part),
    name: historyToolNameFromPart(part),
  };
}

function providerToolResultFromPart(part: ToolPart): { output: string; isError: boolean } {
  return {
    output:
      part.state.status === "completed"
        ? part.state.output
        : part.state.status === "error"
          ? part.state.error
          : INTERRUPTED_TOOL_RESULT,
    isError: part.state.status === "error",
  };
}

function orderedContentBlocksFromParts(parts: MessagePart[]): AssistantHistoryBlock[] {
  const blocks: AssistantHistoryBlock[] = [];
  for (const part of parts) {
    if (part.type === "reasoning") {
      blocks.push({
        kind: "content",
        block: {
          type: "reasoning",
          text: part.text,
          providerOptions: part.metadata ? { ...part.metadata } : undefined,
          blockIndex: part.blockIndex,
        },
      });
    } else if (part.type === "text" && !part.ignored) {
      blocks.push({
        kind: "content",
        block: { type: "text", text: part.text, blockIndex: part.blockIndex },
      });
    }
  }
  return blocks;
}

export function activeSessionMessages(
  messages: MessageWithParts[],
  options: {
    branchCutAfterMessageId?: MessageId;
    includeCompactPreservedSegment?: boolean;
    rewindCreatedMessageId?: MessageId;
    rewindKeptMessageIds?: readonly MessageId[];
    rewindTargetMessageId?: MessageId;
  } = {},
): MessageWithParts[] {
  if (!options.branchCutAfterMessageId) {
    // 旧数据没有 branch cut，继续使用 compact-first/createdMessageID 兼容语义；不能把
    // 历史上非法的 compact 前 kept IDs 解释成新式 branch，从而改变既有冷恢复结果。
    let legacyCompactIndex = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index]!.parts.some(isActiveCompactionBoundaryPart)) {
        legacyCompactIndex = index;
        break;
      }
    }
    const compactActiveMessages =
      legacyCompactIndex >= 0
        ? compactActiveSessionMessages(
            messages,
            legacyCompactIndex,
            options.includeCompactPreservedSegment !== false,
          )
        : messages;
    if (options.rewindKeptMessageIds && legacyCompactIndex >= 0) {
      const postCompactIds = new Set(
        messages.slice(legacyCompactIndex).map((message) => message.info.id),
      );
      if (!options.rewindKeptMessageIds.some((messageId) => postCompactIds.has(messageId))) {
        return compactActiveMessages;
      }
    }
    return selectActiveConversationBranch(compactActiveMessages, options);
  }

  // 最后一个 compact boundary。顺序相反会让 compact 前 kept prefix 永远无法恢复。
  const branchActiveMessages = selectActiveConversationBranch(messages, options);
  let lastCompactionIndex = -1;
  for (let index = branchActiveMessages.length - 1; index >= 0; index--) {
    if (branchActiveMessages[index]!.parts.some(isActiveCompactionBoundaryPart)) {
      lastCompactionIndex = index;
      break;
    }
  }
  return lastCompactionIndex >= 0
    ? compactActiveSessionMessages(
        branchActiveMessages,
        lastCompactionIndex,
        options.includeCompactPreservedSegment !== false,
      )
    : branchActiveMessages;
}

function dedupeParts(parts: MessagePart[]): MessagePart[] {
  const byId = new Map<string, MessagePart>();
  for (const part of parts) {
    byId.set(part.id, part);
  }
  return [...byId.values()];
}

async function userEntriesFromParts(
  parts: MessagePart[],
  artifactStore: ToolArtifactStorePort | undefined,
  genUiContext?: GenUiModelContext,
  keepTextBlocks = false,
): Promise<RuntimeMessageEntry[]> {
  const attachments: UserMessageAttachment[] = [];
  const promptBlocks: ModelMessageContentBlock[] = [];
  const syntheticAttachmentEntries: RuntimeMessageEntry[] = [];

  for (const part of parts) {
    if (part.type === "text" && !part.ignored) {
      const syntheticAttachment = syntheticSystemReminderAttachmentFromTextPart(part);
      if (syntheticAttachment) {
        syntheticAttachmentEntries.push(syntheticAttachment);
        continue;
      }
      const input = part.synthetic
        ? { text: textPartToProviderText(part) }
        : normalizeGenUiInput(part.text, genUiContext);
      if (input.genUiContext !== undefined) genUiContext = input.genUiContext;
      promptBlocks.push({ type: "text", text: input.text });
      continue;
    }

    if (part.type === "file") {
      attachments.push({
        ...part,
        contentBlock: await filePartToContentBlock(part, artifactStore),
      });
      continue;
    }

    if (part.type === "agent") {
      promptBlocks.push({ type: "text", text: `[Selected agent: ${part.name}]` });
    }
  }

  const prompt =
    attachments.length > 0 || (keepTextBlocks && promptBlocks.length > 1)
      ? promptBlocks
      : promptBlocks
          .map((block) => (block.type === "text" ? block.text : ""))
          .filter(Boolean)
          .join("\n\n");
  const [userEntry, ...promptAttachmentEntries] = buildUserMessageEntries(prompt, attachments);
  const content = userEntry.message.content;
  const hasUserContent = modelMessageContentToText(content).trim().length > 0;
  const userMetadata = metadataFromUserParts(parts);
  // 文本附件从原始 file part 恢复为 prompt_attachment 后，空正文的
  // real_user envelope 曾被 trim 判空丢弃，导致 live 与 resume 的 provider history 不一致。
  // 这里只恢复 Agent 内存锚点；bare-empty 和纯 synthetic/meta user 仍不生成空消息。
  const shouldRestoreRealUserEnvelope =
    hasUserContent || (userMetadata.source === "real_user" && promptAttachmentEntries.length > 0);
  if (
    !shouldRestoreRealUserEnvelope &&
    syntheticAttachmentEntries.length === 0 &&
    promptAttachmentEntries.length === 0
  ) {
    return [];
  }
  // 页面状态挂回所属输入，与热态同形；输入本身没有恢复时，状态也不发出。
  return [
    ...(shouldRestoreRealUserEnvelope
      ? [
          attachGenUiContext(
            { message: { role: "user" as const, content }, metadata: userMetadata },
            genUiContext,
          ),
        ]
      : []),
    ...syntheticAttachmentEntries,
    ...promptAttachmentEntries,
  ];
}

function textPartToProviderText(part: Extract<MessagePart, { type: "text" }>): string {
  if (!part.synthetic) {
    return part.text;
  }
  if (isProviderWrappedSystemReminderText(part.text)) {
    return part.text;
  }

  const runtimeMetadata = runtimeMessageMetadataFromPartMetadata(part.metadata);
  if (runtimeMetadata?.source === "task_status" && part.metadata?.source !== "background_task") {
    return wrapSystemReminderForSource("task_status", part.text);
  }
  if (
    runtimeMetadata?.source === "queued_system_notification" ||
    part.metadata?.source === "subagent"
  ) {
    // subagent notification 同样只在 provider history 恢复时包外层，避免改动 session/UI raw transcript。
    return wrapSystemReminderForSource("queued_system_notification", part.text);
  }
  return part.text;
}

type SyntheticSystemReminderAttachment = ReturnType<typeof systemReminderAttachmentEntry>;

function syntheticSystemReminderAttachmentFromParts(
  parts: MessagePart[],
): SyntheticSystemReminderAttachment | undefined {
  const visibleParts = parts.filter((part) => !(part.type === "text" && part.ignored));
  if (visibleParts.length !== 1) return undefined;

  const part = visibleParts[0]!;
  if (part.type !== "text" || !part.synthetic) return undefined;
  return syntheticSystemReminderAttachmentFromTextPart(part);
}

function syntheticSystemReminderAttachmentFromTextPart(
  part: Extract<MessagePart, { type: "text" }>,
): SyntheticSystemReminderAttachment | undefined {
  if (!part.synthetic) return undefined;
  if (part.text.trim().length === 0) return undefined;
  const metadata = metadataFromSyntheticTextPart(part);
  // 只凭已校验的公告身份适配旧包装，不从普通用户正文推断提醒来源。
  const announcement = metadata.toolSearchAnnouncement;
  const wrapped = isProviderWrappedSystemReminderText(part.text);
  if (wrapped && !announcement) return undefined;
  if (!isRestorableSystemReminderAttachmentSource(metadata.source)) return undefined;

  return {
    ...systemReminderAttachmentEntry(
      metadata.source,
      wrapped && announcement
        ? part.text
            .trim()
            .replace(/^<system-reminder>\s*/, "")
            .replace(/\s*<\/system-reminder>$/, "")
        : part.text,
    ),
    metadata,
  };
}

function isRestorableSystemReminderAttachmentSource(
  source: RuntimeMessageSource,
): source is SystemReminderSource {
  if (!isKnownSystemReminderSource(source)) return false;
  const descriptor = getSystemReminderDescriptor(source);
  return (
    descriptor.isMeta &&
    descriptor.providerVisibility === "provider_visible" &&
    descriptor.channel !== "real_user" &&
    descriptor.channel !== "tool_result"
  );
}

function isProviderWrappedSystemReminderText(text: string): boolean {
  return text.trimStart().startsWith("<system-reminder");
}

function metadataFromUserParts(parts: MessagePart[]): RuntimeMessageMetadata {
  const visibleTextParts = parts.filter(
    (part): part is Extract<MessagePart, { type: "text" }> => part.type === "text" && !part.ignored,
  );
  const hasRealUserText = visibleTextParts.some((part) => !part.synthetic);
  const hasStructuredUserPart = parts.some((part) => part.type === "file" || part.type === "agent");
  if (hasRealUserText || hasStructuredUserPart) {
    return realUserRuntimeMetadata();
  }

  const syntheticTextPart = visibleTextParts.find((part) => part.synthetic);
  if (!syntheticTextPart) {
    return realUserRuntimeMetadata();
  }

  return metadataFromSyntheticTextPart(syntheticTextPart);
}

function metadataFromSyntheticTextPart(
  part: Extract<MessagePart, { type: "text" }>,
): RuntimeMessageMetadata {
  const source = part.metadata?.source;
  if (source === "background_task" || source === "subagent_message") {
    // runtime command carrier 对齐直接 user-like 注入；即使旧持久化里带过
    // system reminder metadata，恢复时也不能把后台完成或 child 回复重新包成 reminder。
    return legacySyntheticRuntimeMetadata();
  }

  const persistedRuntimeMetadata = runtimeMessageMetadataFromPartMetadata(part.metadata);
  if (persistedRuntimeMetadata) {
    return persistedRuntimeMetadata;
  }

  if (source === "subagent") {
    return systemReminderRuntimeMetadata("queued_system_notification");
  }
  if (source === "todo_reminder") {
    return todoReminderRuntimeMetadata();
  }
  if (source === "goal-continuation") {
    return systemReminderRuntimeMetadata("target_continuation");
  }
  if (source === "rewind" || source === "fork") {
    return systemReminderRuntimeMetadata("rewind_notice");
  }
  if (isKnownSystemReminderSource(source)) {
    return systemReminderRuntimeMetadata(source);
  }

  return legacySyntheticRuntimeMetadata();
}

function runtimeMessageMetadataFromPartMetadata(
  metadata: Record<string, unknown> | undefined,
): RuntimeMessageMetadata | undefined {
  const runtimeMessage = metadata?.runtimeMessage;
  if (!isRecord(runtimeMessage)) return undefined;

  const presentation = runtimeInputMetadata(runtimeMessage.inputPresentation);
  if (presentation) return presentation;
  const source = runtimeMessage.source;
  if (source === "environment") {
    const environment = parseEnvironmentAnnouncement(runtimeMessage.environment);
    return { source, ...(environment ? { environment } : {}) };
  }
  if (source === "agent_listing_delta") {
    const delta = parseAgentListingDelta(runtimeMessage.agentListingDelta);
    return { source, ...(delta ? { agentListingDelta: delta } : {}) };
  }
  if (source === "context_prefix") {
    const instructions = parseInstructionAnnouncement(runtimeMessage.instructions);
    return { source, ...(instructions ? { instructions } : {}) };
  }
  if (source === "real_user") {
    return realUserRuntimeMetadata();
  }
  if (source === INTERRUPT_MARKER_SOURCE) return { source };
  if (source === "legacy_synthetic" || source === "tool_search_announcement") {
    const announcement = hydrateToolSearchAnnouncement(runtimeMessage.toolSearchAnnouncement);
    const hiddenNames =
      announcement &&
      parseToolSearchHiddenNames(runtimeMessage.toolSearchHiddenNames, announcement);
    return {
      ...legacySyntheticRuntimeMetadata(),
      ...(announcement
        ? { source: "tool_search_announcement" as const, toolSearchAnnouncement: announcement }
        : {}),
      ...(hiddenNames ? { toolSearchHiddenNames: hiddenNames } : {}),
    };
  }
  if (source === "todo_reminder") {
    return todoReminderRuntimeMetadata();
  }
  if (isKnownSystemReminderSource(source)) {
    return systemReminderRuntimeMetadata(source);
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assistantTextFromParts(parts: MessagePart[]): string {
  const chunks: string[] = [];

  for (const part of parts) {
    if (part.type === "text" && !part.ignored) {
      chunks.push(part.text);
    }
  }

  return chunks.join("\n\n");
}

function assistantReasoningFromParts(parts: MessagePart[]): ModelReasoningContentBlock[] {
  const blocks: ModelReasoningContentBlock[] = [];

  for (const part of parts) {
    if (part.type === "reasoning") {
      blocks.push({
        type: "reasoning",
        text: part.text,
        providerOptions: part.metadata ? { ...part.metadata } : undefined,
      });
    }
  }

  return blocks;
}

function isToolPart(part: MessagePart): part is ToolPart {
  return part.type === "tool";
}

function splitProviderToolRoundParts(parts: MessagePart[]): {
  rounds: Array<{ parts: MessagePart[]; toolPart: ToolPart }>;
  remainingParts: MessagePart[];
} {
  if (
    !parts.some((part) => isToolPart(part) && isProviderExecutedToolPartMetadata(part.metadata))
  ) {
    return { rounds: [], remainingParts: parts };
  }
  const rounds: Array<{ parts: MessagePart[]; toolPart: ToolPart }> = [];
  const remainingParts: MessagePart[] = [];
  let pending: MessagePart[] = [];
  for (const part of parts) {
    if (isToolPart(part) && isProviderExecutedToolPartMetadata(part.metadata)) {
      rounds.push({ parts: pending, toolPart: part });
      pending = [];
    } else if (part.type === "text" || part.type === "reasoning") {
      pending.push(part);
    } else {
      remainingParts.push(part);
    }
  }
  return { rounds, remainingParts: [...remainingParts, ...pending] };
}

function modelCallWrapperFromPart(part: ToolPart) {
  const parsed = ModelCallWrapperSchema.safeParse(part.metadata?.modelCallWrapper);
  return parsed.success ? parsed.data : undefined;
}

function historyToolNameFromPart(part: ToolPart): string {
  const providerToolName = part.metadata?.providerToolName;
  // 空字符串在 cold hydration 中曾只能依赖 non-empty ToolPart.tool；
  // 必须按字段存在性恢复原值，不能用 truthy 判断把空名重新覆盖成占位值。
  return providerToolName !== undefined && typeof providerToolName === "string"
    ? providerToolName
    : part.tool;
}
