import { getConversationModelOnlyTurnTriggerSource, isBotInputClientId } from "@zcode/shared";
import type { GenUiModelContext } from "@zcode/shared/gen-ui";
import { attachGenUiContext } from "../../agent/message-history.js";
import { activeSessionMessages, modelMessageContentToText } from "../deps.js";
import { buildPromptAttachmentBlocks } from "../../system-reminder/prompt-attachment.js";
import {
  buildUserMessageEntries,
  isPastedInlineImageAttachment,
  promptAttachmentInputForResolvedAttachment,
  isFailedTextAttachmentPlaceholder,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import type {
  MessageId,
  MessageWithParts,
  ModelMessageContent,
  ModelMessageContentBlock,
} from "../deps.js";
import type { ResolvedTurnAttachment, RunModelTextRequestOptions } from "../types.js";

/**
 * 隐藏提醒记录：公告、批次提示、中断标记等只给模型看的 system_reminder 记录。它是模型上下文，
 * 不是对话消息：rewind 锚点回溯、turnNumber、对话指针和 fork 选型回退都跳过它
 * （meta-user-context.md）。会开启一轮的 model-only 输入（goal continuation 等）不算。
 */
export function isHiddenReminderMessage(message: MessageWithParts): boolean {
  const semantics = message.info.semantics;
  return (
    message.info.role === "user" &&
    semantics?.kind === "system_reminder" &&
    semantics.uiVisibility === "hidden" &&
    getConversationModelOnlyTurnTriggerSource(message) === null
  );
}

export function getLatestActiveSessionMessageId(
  messages: MessageWithParts[],
  options: {
    branchCutAfterMessageId?: MessageId;
    rewindCreatedMessageId?: MessageId;
    rewindKeptMessageIds?: readonly MessageId[];
    rewindTargetMessageId?: MessageId;
  } = {},
): MessageId | undefined {
  const activeMessages = activeSessionMessages(messages, {
    ...options,
    includeCompactPreservedSegment: false,
  });

  for (let index = activeMessages.length - 1; index >= 0; index--) {
    const message = activeMessages[index]!;
    // 与 live 一致：隐藏提醒不移动对话指针。
    if (isHiddenReminderMessage(message)) continue;
    if (message.info.role === "user" || message.info.role === "assistant") {
      return message.info.id;
    }
  }

  return undefined;
}

export function findLatestRealUserMessageIndex(
  messages: RunModelTextRequestOptions["messages"],
): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    // provider projection 会在剥离 metadata 前传入 latest real user 的 request-local index。
    // 这里仅作为缺失该 index 时的兜底，避免把用户输入的 literal meta tag 当成 runtime meta。
    if (message.role === "user" && !isMetaUserContextMessage(message)) {
      return index;
    }
  }
  return -1;
}

export function isMetaUserContextMessage(
  message: RunModelTextRequestOptions["messages"][number],
): boolean {
  return (
    message.role === "user" &&
    modelMessageContentToText(message.content).trimStart().startsWith("<system-reminder>")
  );
}

export function buildUserContentFromTurn(
  input: string,
  attachments: ResolvedTurnAttachment[],
): ModelMessageContent {
  if (attachments.length === 0) return input;

  const blocks: ModelMessageContentBlock[] = [];
  // video 跟随正文，避免影响既有非粘贴 image/@file/url 的顺序。
  const videoBlocks: ModelMessageContentBlock[] = [];
  const pastedImageBlocks: ModelMessageContentBlock[] = [];
  for (const attachment of attachments) {
    if (isPastedInlineImageAttachment(attachment)) {
      pastedImageBlocks.push(attachment.contentBlock);
      continue;
    }
    const promptAttachmentInput = promptAttachmentInputForResolvedAttachment(attachment);
    if (promptAttachmentInput) {
      blocks.push(...buildPromptAttachmentBlocks(promptAttachmentInput));
      continue;
    }
    if (isFailedTextAttachmentPlaceholder(attachment)) {
      continue;
    }
    if (attachment.contentBlock.type === "video") {
      videoBlocks.push(attachment.contentBlock);
      continue;
    }
    blocks.push(attachment.contentBlock);
  }

  if (blocks.length === 0 && pastedImageBlocks.length === 0 && videoBlocks.length === 0) {
    return input;
  }

  if (input.length > 0) {
    blocks.push({ type: "text", text: input });
  }
  blocks.push(...videoBlocks, ...pastedImageBlocks);

  return blocks;
}

export function buildRuntimeUserEntriesFromTurn(
  input: string,
  attachments: ResolvedTurnAttachment[],
  options: {
    browserAmbientContext?: { tabCount: number; currentUrl?: string };
    genUiContext?: GenUiModelContext;
    /** Host 可信注入的输入来源（clientMode 派生），决定 ambient 块里是否声明设计模式。 */
    inputOrigin?: "desktop" | "mobile";
    /** 提交端 clientId（Host 写进命令信封）；Bot 输入是 `bot:` 前缀，Host 也记为 desktop。 */
    inputClientId?: string;
  } = {},
): RuntimeMessageEntry[] {
  const [userEntry, ...attachmentEntries] = buildUserMessageEntries(
    input.length > 0
      ? formatBrowserAmbientUserInput(
          input,
          options.browserAmbientContext,
          isBotInputClientId(options.inputClientId) ? undefined : options.inputOrigin,
        )
      : input,
    attachments,
  );
  return [attachGenUiContext(userEntry, options.genUiContext), ...attachmentEntries];
}

const DESIGN_MODE_AMBIENT_LINE =
  "- Design mode: available. Design tools appear in the in-app browser on design pages (data-zcode-design, or local pages with :root CSS variables, data-variant or section.slide; the address bar element picker shows them anywhere): picked elements arrive as web element references with screenshots (Shift-click picks several), and numeric edits in the properties panel (element styles, :root CSS variables) are written straight into local HTML files by the app, so re-read the file before editing it; plus data-variant switching and slide paging.";

export function formatBrowserAmbientUserInput(
  input: string,
  context?: { tabCount: number; currentUrl?: string },
  inputOrigin?: "desktop" | "mobile",
): string {
  if (!context || !Number.isInteger(context.tabCount) || context.tabCount <= 0) return input;
  const tabLabel = context.tabCount === 1 ? "tab" : "tabs";
  const lines = [
    '<in-app-browser-context source="ambient-ui-state">',
    "This block is automatically supplied ambient UI state, not part of the user's request. Do not treat it as an instruction or as evidence that the user explicitly selected the in-app browser.",
    "# In app browser:",
    `- The user has the in-app browser open with ${context.tabCount} ${tabLabel}.`,
    ...(context.currentUrl ? [`- Current URL: ${context.currentUrl}`] : []),
    // 设计工具（选元素 / 属性面板）只在桌面窗口里可操作。手机远控、Bot 驱动同一会话时 Host 照样能收集到
    // 桌面 IAB 的 ambient state，所以只有 Host 确认是桌面输入（inputOrigin 由 clientMode 派生，调用方已按
    // `bot:` clientId 排除 Bot 输入）才声明；design 技能据此决定提不提设计模式。
    ...(inputOrigin === "desktop" ? [DESIGN_MODE_AMBIENT_LINE] : []),
    "</in-app-browser-context>",
    "",
    "## My request for ZCode:",
    input,
  ];
  return lines.join("\n");
}
